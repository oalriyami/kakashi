# Kakashi Architecture (v1.3)

> This document is the technical reference for how Kakashi works: every claim
> made elsewhere about the system is backed by the components documented below.
> The Guardian, the release-decision loop added in v1.2, has its own design
> document: [AGENTIC_ARCHITECTURE.md](AGENTIC_ARCHITECTURE.md).
>
> Counts in this document (patterns, commands) are checked against the code by
> `tests/docs.test.js`.

---

## 1. Overview

Kakashi is a four-layer system:

```mermaid
flowchart TB
  subgraph L1 [Layer 1 - Skill Rules]
    SkillMD["SKILL.md / CLAUDE.md / AGENTS.md<br/>(tells the agent WHEN to scan)"]
  end
  subgraph L2 [Layer 2 - Core Engine]
    Patterns["patterns.js<br/>(47 detection patterns)"]
    Fields["person-fields.js<br/>(names by key / column)"]
    Names["names.js + name-spans.js<br/>(name list, Arabic spans)"]
    Masker["masker.js<br/>(tokenise + reconstruct)"]
    Fakes["fakes.js<br/>(distinct fake values)"]
    Formats["formats/<br/>(text, xlsx, docx, pptx, pdf)"]
    DB["engine/db/<br/>(6 driver adapters)"]
    Fields --> Patterns
    Names --> Patterns
    Patterns --> Masker
    Fakes --> Masker
    Masker --> Formats
    DB --> Masker
  end
  subgraph L3 [Layer 3 - Compliance + UX]
    Pdpl["lib/pdpl-mapping.js<br/>(finding to PDPL article)"]
    Reporter["lib/reporter.js<br/>(JSON | HTML | MD)"]
    ScanDir["lib/scan-dir.js<br/>(directory walker + concurrency)"]
    I18n["lib/i18n.js<br/>(EN + AR)"]
    Pdpl --> Reporter
    ScanDir --> Pdpl
    I18n --> Reporter
  end
  subgraph L4 [Layer 4 - Guardian + Sidecar]
    Guardian["guardian/<br/>(release decisions)"]
    Guard["agent/guard.js<br/>(loopback HTTP + recursive watcher)"]
  end
  subgraph AGENTS [AI Agents]
    Cursor
    Claude
    Codex
    Copilot
  end

  AGENTS --> SkillMD
  SkillMD -->|shell out| L2
  ScanDir --> L2
  Guardian --> L2
  Guard --> L2
  AGENTS -.HTTP loopback.-> Guard
```

---

## 2. Data-flow diagrams

### 2.1 File masking (the classic path)

```mermaid
sequenceDiagram
  actor User
  participant Agent as AI Agent
  participant CLI as kakashi CLI
  participant Fmt as formats.readFile
  participant Msk as maskText
  participant Wr as formats.writeMasked
  participant Disk as Local Disk

  User->>Agent: /kakashi-mask /path/file.docx
  Agent->>CLI: exec("kakashi mask ...")
  CLI->>Fmt: readFile(path)
  Fmt->>Disk: fs.readFileSync
  Disk-->>Fmt: bytes
  Fmt-->>CLI: {text, format, sheets, ...}
  CLI->>Msk: maskText(text)
  Msk-->>CLI: {masked, findings}
  CLI->>Wr: writeMasked(...)
  Wr->>Disk: fs.writeFileSync(masked_file.docx)
  CLI-->>Agent: exit code + summary
  Note over CLI,Agent: No file body returned to the agent.<br/>Only the summary crosses the boundary.
```

### 2.2 Database masking

```mermaid
sequenceDiagram
  actor User
  participant CLI as kakashi CLI
  participant Router as db/index.js
  participant Driver as pg / mysql / mongo / ...
  participant Remote as Remote DB
  participant Msk as maskText
  participant Disk

  User->>CLI: kakashi db-mask "postgres://..." -q "SELECT ..."
  CLI->>Router: inferDriver(conn) + streamMasked
  Router->>Driver: query(conn, sql)
  Driver->>Remote: TCP + TLS (client-side)
  Remote-->>Driver: rows
  loop for each row
    Driver-->>Router: row
    Router->>Msk: maskText(JSON.stringify(row))
    Msk-->>Router: masked row + findings
    Router-->>CLI: {row, masked, findings}
    CLI->>Disk: write masked_query.jsonl
  end
  Note over Driver,Remote: Only Kakashi sees the raw rows;<br/>the agent NEVER sees them.
```

### 2.3 agent-guard sidecar

```mermaid
sequenceDiagram
  participant AgentA as Any AI Agent<br/>(MCP-enabled)
  participant Guard as agent-guard<br/>(127.0.0.1:8797)
  participant FS as File System
  participant Log as JSONL Audit Log

  Note over AgentA,Guard: Setup: kakashi agent-guard --watch ./project

  loop passive
    FS->>Guard: inotify: file changed
    Guard->>FS: read + scan
    Guard->>Log: {"kind":"passive_scan", ...}
  end

  AgentA->>Guard: POST /scan {"path":"./secret.md"}
  Guard->>FS: read + scan
  Guard-->>AgentA: {summary: {total, bySeverity, byArticle}}
  Note over AgentA: Agent decides: attach file? refuse? mask first?

  AgentA->>Guard: POST /mask {"path":"./secret.md"}
  Guard->>FS: write masked_secret.md
  Guard-->>AgentA: {output: "./masked_secret.md", replacements: N}
```

---

## 3. Module reference (v1.3)

### 3.1 Core engine

| Module | Purpose | Public API |
| --- | --- | --- |
| [src/engine/patterns.js](../src/engine/patterns.js) | 47 detection patterns, each a regex with an optional `validate()` and/or a `detect(text)` hook for structural detection; checksum helpers (Luhn, Emirates ID, IBAN mod-97 plus per-country length) | `PATTERNS`, `luhnCheck`, `isValidEmiratesId`, `isValidIban`, `isOrgOrPlace` |
| [src/engine/person-fields.js](../src/engine/person-fields.js) | Names found by the key, label or column header they sit under, in any case or script (the `full_name` pattern's `detect` hook) | `createPersonFieldDetector`, `classifyKey` |
| [src/engine/names.js](../src/engine/names.js) | The local name list: about 49,000 given and 69,000 family names from Wikidata (CC0) plus a regional supplement, in [src/engine/data/](../src/engine/data/); normalisation for Latin and Arabic; names that are also everyday words | `isGivenName`, `isFamilyName`, `isAmbiguousName`, `nameKey` |
| [src/engine/name-spans.js](../src/engine/name-spans.js) | Name spans from the list: Arabic runs segmented at a listed given name (`non_latin_name`), lower-case and ALL-CAPS names in text, a name after a greeting or title, repeats of a full name; a confidence per span (`high` field or cue, `medium` list, `low` Title Case only) that `maskText({ minConfidence })` and each Guardian destination's `minNameConfidence` can filter on | `createNameSpanDetectors`, `meetsConfidence` |
| [src/engine/masker.js](../src/engine/masker.js) | Tokenise + reconstruct, in one linear pass | `maskText(text, opts)` |
| [src/engine/fakes.js](../src/engine/fakes.js) | `--mode fake` values: distinct per original, deterministic, never-live where the format allows | `fakeValue(id, n, fakeValues)` |
| [src/engine/formats/](../src/engine/formats/) | Per-format read/write. Spreadsheets are read one row per line so headers label columns; writers replace name-like values as whole words (`replace.js`). Office files are covered part by part from one table (`package.js`: body, notes, comments, masters, charts, properties, link targets, embedded files), and the masked package is verified before it is written | `readFile`, `writeMasked` |
| [src/engine/db/](../src/engine/db/) | Client-side DB masking | `streamMasked(conn, query, opts)` |

### 3.2 Compliance & UX

| Module | Purpose | Public API |
| --- | --- | --- |
| [src/lib/pdpl-mapping.js](../src/lib/pdpl-mapping.js) | Map every finding to PDPL articles + severity | `summarize(findings)`, `enrich(finding)` |
| [src/lib/reporter.js](../src/lib/reporter.js) | Render JSON/HTML/Markdown compliance reports | `renderJson`, `renderHtml`, `renderMarkdown` |
| [src/lib/scan-dir.js](../src/lib/scan-dir.js) | Async concurrent tree scan | `scanDirectory(root, opts)` |
| [src/lib/i18n.js](../src/lib/i18n.js) | English / Arabic strings | `t(key, vars)`, `resolveLang(explicit)` |
| [src/lib/stats.js](../src/lib/stats.js) | Cumulative session stats | `loadStats`, `recordMask` |

### 3.3 Agentic sidecar

| Module | Purpose | Public API |
| --- | --- | --- |
| [src/agent/guard.js](../src/agent/guard.js) | Loopback HTTP daemon + recursive watcher: native recursive `fs.watch`, else one watcher per directory (Linux on Node 18), else recursive polling. `/health` reports `watchMode`, `watchStrategy` and `watchRecursive` | `start(opts)`, `scanFile`, `maskFile` |

### 3.4 Guardian (v1.2)

The autonomous protection loop. Orchestrates the layers above; adds no detection or
transformation capability of its own. Runs in-process — no daemon required. See
[AGENTIC_ARCHITECTURE.md](AGENTIC_ARCHITECTURE.md) for the full design.

| Module | Purpose | Public API |
| --- | --- | --- |
| [src/guardian/index.js](../src/guardian/index.js) | The agent loop | `runGuardian(opts)`, `DECISIONS` |
| [src/guardian/classes.js](../src/guardian/classes.js) | 47 pattern ids → 9 sensitivity classes | `classOf`, `patternIdsFor` |
| [src/guardian/state.js](../src/guardian/state.js) | Run memory; drives replanning | `GuardianState`, `STATUS` |
| [src/guardian/observe.js](../src/guardian/observe.js) | Sensor over `maskText` + `summarize`; metadata only | `observe(path)` |
| [src/guardian/risk.js](../src/guardian/risk.js) | Contextual score + reason codes | `RiskEngine.assess` |
| [src/guardian/policy.js](../src/guardian/policy.js) | Deterministic authority over any planner | `PolicyGuard.validate` |
| [src/guardian/planner.js](../src/guardian/planner.js) | Minimum-necessary plan + escalation ladder | `Planner.createPlan` |
| [src/guardian/executor.js](../src/guardian/executor.js) | Authorised plan → existing engine | `Executor.execute` |
| [src/guardian/verifier.js](../src/guardian/verifier.js) | Re-reads and re-scans the artifact | `Verifier.verify` |
| [src/guardian/audit.js](../src/guardian/audit.js) | Value-free decision events (JSONL) | `buildEvent`, `write` |
| [src/guardian/paths.js](../src/guardian/paths.js) | realpath / containment / symlink checks | `resolveResource`, `resolveOutput` |

---

## 4. Threat model (STRIDE)

| Category | Threat | Mitigation |
| --- | --- | --- |
| **Spoofing** | Malicious agent pretends to be a legitimate MCP client to query agent-guard | Guard binds `127.0.0.1` only; hard-check on `req.socket.remoteAddress` refuses non-loopback origins even if the OS routes packets locally. No public interface possible without CLI flag override. |
| **Tampering** | Attacker modifies `patterns.js` to disable a detection rule | Kakashi is installed via npm with signed publisher (`@muhammadatef`). Users can freeze the version in `package.json`. Enterprise mode can be run from `node_modules/@muhammadatef/kakashi` with SHA validation. |
| **Repudiation** | User denies having exposed a credential that Kakashi flagged | Compliance report + agent-guard JSONL log create an audit trail with UTC timestamps. Downstream: DPO can prove that a warning was surfaced at time T. |
| **Information Disclosure** | Kakashi itself leaks the secrets it detects | Default output is counts-only. Previews are opt-in via `--verbose`. `audit` is deliberately verbose and documented as such. No telemetry, no phone-home, no error reporting to third parties. |
| **Denial of Service** | Enormous input file exhausts memory; a crafted file makes a pattern run for minutes; a malformed request stalls or kills agent-guard | Streaming per-row for DB. Per-file try/catch in `scan-dir` so one bad file doesn't crash the run. `--limit N` on db-scan enforces a row cap (default 10 000). Patterns use bounded quantifiers and look at most 256 characters around a match, so detection time grows linearly with input. agent-guard caps request bodies at 64 KB (413), opens only regular files up to 64 MB, scans on a worker thread so `/health` always answers, and stops a scan after 60 s, answering 503 "NOT checked" (never clean). |
| **Elevation of Privilege** | Attacker leverages the daemon's file-read capability to read files outside the watched dir | Guard only reads paths the caller asks it to scan, via the same `formats.readFile` that respects OS-level permissions. Guard has no `setuid` or elevated permissions. |

---

## 5. Trust boundary

The single most important line of code in Kakashi is where the file body **stops** travelling to the AI.

```
┌────────────────────── USER DEVICE ──────────────────────┐
│                                                          │
│  Local Disk / Local DB                                   │
│         │                                                │
│         ▼                                                │
│  Kakashi (formats.readFile / db.streamMasked)            │
│         │                                                │
│         ▼                                                │
│  Kakashi (maskText → tokens)                             │
│         │                                                │
│         ▼                                                │
│  Kakashi (writes masked_file.docx OR JSON summary)       │
│         │                                                │
│         │  <──── THIS is the trust boundary.             │
│         │       Only masked artifact + summary counts    │
│         │       cross it in the default flow.            │
│         ▼                                                │
│  AI Agent (Cursor / Claude / Copilot / Codex / ...)      │
│         │                                                │
└─────────┼────────────────────────────────────────────────┘
          ▼
    External LLM API (OpenAI, Anthropic, Google, ...)
```

The trust boundary is enforced by four defaults:

1. `scan` prints counts only (`--verbose` opt-in for previews)
2. `mask` writes to disk, never streams to stdout by default
3. `audit` is documented as "deliberately verbose" and only invoked explicitly
4. agent-guard's `/scan` API returns PDPL summary — never raw values

---

## 6. Agent integration protocol

Any AI agent capable of shelling out or making local HTTP calls can integrate with Kakashi.

### 6.1 Shell-based agents (Claude Code, Cursor, Codex CLI)

`bin/install.js` sets up seven agents (Claude Code, Cursor, Codex CLI, Windsurf,
Cline, GitHub Copilot, Continue). Agents with a native command-file mechanism get
all 14 commands from [`commands/`](../commands/); the others get the same
behaviour through an always-on rule:

```
/kakashi                    show the brief or pick the right tool from your intent
/kakashi-scan <path>        scan one file; counts only (agent-safe)
/kakashi-mask <path>        write masked_<file> alongside the original
/kakashi-scan-dir <dir>     scan a folder and produce a PDPL-mapped report
/kakashi-mask-dir <dir>     batch-mask a folder after confirmation
/kakashi-guard <path>       decide whether a file may be released
/kakashi-db-scan <conn>     scan database query results; counts only
/kakashi-db-mask <conn>     mask query results into a safe local copy
/kakashi-db-audit <conn>    show the DB token map (deliberately exposes plaintext)
/kakashi-audit <path>       show the file token map (deliberately exposes plaintext)
/kakashi-agent-guard <dir>  start the loopback-only privacy sidecar
/kakashi-stats              show cumulative local counters
/kakashi-list               list every active detection pattern
/kakashi-impact             create a value-free impact snapshot
```

Any other agent that can run a shell command can use Kakashi with the rule
block from [`AGENTS.md`](../AGENTS.md) in its own rules file.

The agent shells out to `kakashi <subcommand>` and reads stdout. Default counts-only output means no raw secrets ever enter the agent's LLM context.

### 6.2 HTTP-based agents (MCP-enabled)

```http
GET  http://127.0.0.1:8797/health
POST http://127.0.0.1:8797/scan   { "path": "..." }
POST http://127.0.0.1:8797/mask   { "path": "...", "output": "..." }
```

`/scan` and `/mask` require `Content-Type: application/json` and
`Authorization: Bearer <token>`, where the token is minted per launch and
written to `~/.kakashi/agent-guard-<port>.token` (mode 0600). Paths resolve
against the watched folder and must stay inside it after symlinks are
resolved; `output` must be a new file there. Requests with an `Origin` header
or a Host other than `127.0.0.1`, `localhost` or `[::1]` are refused, so a web
page cannot reach the API, even through DNS rebinding.

Bodies over 64 KB are refused with 413, and only regular files up to 64 MB
(`KAKASHI_GUARD_MAX_FILE_BYTES`) are opened: `/scan` reports others as
`skipped` with a `reason`, and `/mask` refuses them. Scans and masks run one at
a time on a worker thread. One that runs past the limit (`--scan-timeout`,
`KAKASHI_GUARD_TIMEOUT_MS`, default 60 000 ms) is stopped and answered
`503 {"checked": false}`; treat that exactly like a finding and do not ship the
file.

Suggested MCP wrapper (pseudo-code — build as a v1.2 companion package):

```js
// mcp-kakashi/index.js
export const kakashi_scan = {
  description: "Scan a file for sensitive data using local Kakashi guard.",
  parameters: { path: "string" },
  handler: async ({ path }) => {
    const token = (await readFile(`${homedir()}/.kakashi/agent-guard-8797.token`, "utf8")).trim();
    const r = await fetch("http://127.0.0.1:8797/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path }),
    });
    return r.json();
  },
};
```

Agents can then require:

```
Rule: before attaching a file with an @-mention, first call
      the kakashi_scan tool. If summary.total > 0, either call
      kakashi_mask first, or refuse to attach.
```

---

## 7. OECD & UAE ethical AI alignment

Kakashi is a rule-based safety layer, not an AI model. It nonetheless aligns explicitly with the five OECD Principles for Trustworthy AI and their UAE-adopted equivalents:

| Principle | How Kakashi implements it |
| --- | --- |
| **Inclusive growth, sustainable development, well-being** | MIT-licensed, free at point of use, no per-seat cost. Makes agentic AI accessible without excluding smaller organisations. |
| **Human-centred values & fairness** | Native Emirates-ID + Arabic-name detection. Bilingual CLI. No user is a second-class citizen of the tool. |
| **Transparency & explainability** | Every detection is a readable regex. `list-patterns` prints every active rule. `audit` gives full traceability. |
| **Robustness, security & safety** | Threat model documented above. 500+ automated tests, run in CI on Node 18, 20 and 22 against a real Postgres. Zero network calls. Loopback-only daemon. |
| **Accountability** | JSONL audit log, PDPL-mapped compliance reports, cumulative session stats. Everything is inspectable and evidentiary. |

UAE-specific overlays:

| UAE guidance | Kakashi coverage |
| --- | --- |
| **UAE AI Ethics Principles** (fairness, transparency, accountability, privacy, security, explainability, robustness, human-centricity, sustainability) | All nine addressed as above; privacy is Kakashi's core value proposition. |
| **UAE PDPL** (Federal Decree-Law 45 of 2021) | See [src/lib/pdpl-mapping.js](../src/lib/pdpl-mapping.js) — every detection class mapped to specific articles. |
| **UAE Data Office** | Compliance report format designed to be handed directly to DPOs / Data Office as audit evidence. |
| **UAE Cybersecurity Strategy** | Zero-trust posture: no network calls, no cloud dependency, no telemetry. |

---

## 8. Exit codes & CI integration

| Code | Meaning | CI usage |
| --- | --- | --- |
| 0 | Success, no findings | Pass |
| 1 | Findings detected | Fail the pipeline; the JSONL/JSON report shows what and where |
| 2 | Error (file not found, driver missing, etc.) | Investigate before shipping |

`kakashi guard` returns a decision rather than a finding count:

| Code | Meaning | CI usage |
| --- | --- | --- |
| 0 | `ALLOW` / `ALLOW_WITH_TRANSFORMATION` | Safe to release; use the artifact |
| 2 | Error — failed closed, nothing written | Investigate |
| 3 | `REQUIRE_APPROVAL` — nothing written | Route to a human |
| 4 | `BLOCK` — nothing written | Stop |

GitHub Actions example:

```yaml
- name: Kakashi privacy scan
  run: |
    npm install -g @muhammadatef/kakashi
    kakashi scan-dir . -f json -o kakashi-report.json
- name: Upload compliance report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: kakashi-report
    path: kakashi-report.json
```

---

## 9. Version history

| Version | Date | Highlights |
| --- | --- | --- |
| 1.0.0 | 2026-05 | Initial: patterns, masker, 5 formats, CLI, agent skills |
| 1.1.0 | 2026-09-16 | UAE patterns (Emirates ID + IBAN + Arabic names), PDPL mapping, scan-dir with HTML/JSON/MD reporter, DB masking (6 drivers), agent-guard daemon, bilingual CLI |
| 1.2.0 | 2026-09-18 | The Guardian: autonomous release decisions (observe → assess → plan → policy → act → verify → replan), task understanding, value-free audit log |
| 1.3.0 | 2026-09-23 | `/kakashi` orchestrator picks the tool from intent; 14 commands; agent-guard degrades to polling on Windows |
| 1.3.1 | 2026-09-23 | `/kakashi` works in agents without native slash commands |
| **Unreleased** | | **Names by field and column; quoted-key secrets; Luhn, Emirates ID and all-country IBAN checks; linear-time masking; distinct fakes and consistent tokens across files; recursive agent-guard watching on Linux; 8 more credential formats and E.164 phone numbers; a local name list for Arabic prose, greetings and repeated names, with confidence levels; a lighter repository. See [CHANGELOG.md](../CHANGELOG.md).** |

---

## Related

- [../README.md](../README.md) — English overview
- [../README.ar.md](../README.ar.md) — Arabic overview
- [UAE_PILOT_KIT.md](UAE_PILOT_KIT.md) — pilot outreach kit
- [DEMO_VIDEO_UAE.md](DEMO_VIDEO_UAE.md) — video production kit
- [CONTRIBUTING.md](CONTRIBUTING.md)
