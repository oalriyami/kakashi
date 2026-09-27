# Changelog

All notable changes to Kakashi are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

**Name detection, phase 1: read the structure first.** Names were found only
when written in Title Case (Latin) or as any run of Arabic words, so names in
capitals, lower case or on their own were missed, while places, products and
headings were masked. On a new benchmark of 16 names in 7 contexts, recall
goes from 54/112 to 108/112 and false alarms on 27 person-free texts from 19
to 3.

### Added

- **Person fields** ([src/engine/person-fields.js](src/engine/person-fields.js)).
  A value under a person-like key is a name whatever its case, script or
  length: JSON / JS / Python keys (`"full_name": "…"`), label and YAML lines
  (`Name: …`), assignments (`customerName = "…"`), and header columns in CSV,
  TSV, Markdown tables and spreadsheets. Strong keys (`full_name`,
  `surname`, `employee_name`, `الاسم الكامل`) accept any name-shaped value;
  weak keys (`name`, `owner`, `الاسم`) need a value that looks like a person on
  its own, unless most of that key's values do. Thing keys (`company_name`,
  `file_name`, `host_name`) are ignored. Findings use the `full_name` id and
  `[FULL_NAME_n]` tokens, so the Guardian's classes are unchanged.
- **Name benchmark in CI** ([tests/names.test.js](tests/names.test.js)).
  Recall and false alarms are asserted against floors that may only rise.
- **Eight more credential formats** (#5). New patterns: `gitlab_token`
  (`glpat-` and the other GitLab prefixes), `google_api_key` (`AIza…`),
  `sendgrid_key` (`SG.….…`), `npm_token` (`npm_…`), `slack_webhook`
  (`https://hooks.slack.com/services/…`), `azure_storage_key` (only the key in
  `AccountKey=` / `SharedAccessKey=`, so the connection string stays readable),
  `basic_auth` (`Basic <base64>`, only when it decodes to `user:password`) and
  `aws_secret` (a 40-character secret access key, only near an access key id or
  an AWS / secret-access-key label, as in the console's credentials CSV).
  Existing patterns now also cover fine-grained GitHub tokens (`github_pat_`),
  Stripe restricted keys and webhook secrets (`rk_live_`, `whsec_`), encrypted
  PKCS#8, DSA and PGP private-key blocks (`ssh_key`, now labelled Private Key),
  and 32–39-character hex keys after a key word (`api_key: 5d41…`). There are
  now 44 patterns, all classified `CREDENTIAL` and cited under PDPL Art. 20
  and 21.
- **Name detection, phase 2: a local name list** (#12). On the name
  benchmark, which now has 11 contexts and 43 person-free texts, recall is
  176/176 and false alarms 0/43. Phase 1 gave 108/112 on its 7 contexts and
  3/27 false alarms.
  - [src/engine/names.js](src/engine/names.js) loads about 49,000 given and
    69,000 family names from Wikidata (CC0), built by `npm run names:build`
    into a 288 KB file. It also loads a regional supplement
    ([src/engine/data/names-supplement.json](src/engine/data/names-supplement.json))
    with Gulf, South Asian and Filipino names and Gulf family names.
  - Words are compared after normalisation: case, accents, `Al-` / `ال`, and
    the Arabic hamza, taa marbuta, alef maqsura, tatweel and diacritics.
  - Names that are also everyday words are marked ambiguous (`will`, `hope`,
    `price`; `أمل`, `نور`). The English ones are taken from subtitle word
    frequencies: a name counts as ambiguous when the word is written in lower
    case more often than not. Ambiguous names need other evidence.
  - **Arabic prose is no longer a name.** `non_latin_name` used to match any
    run of two Arabic words. A span must now start at a listed given name (or
    `عبد` / `أبو` / `أم` and a name), and it continues through listed names,
    `بن` / `بنت` / `آل`, and Gulf family names (`الكعبي`). On this
    repository's own Arabic docs, findings drop from 169 to 7, all of them
    names.
  - **Title Case names** may contain particles, hyphens and apostrophes
    (`Abdulla bin Rashid`, `Jose dela Cruz`, `Fatima Al-Kaabi`,
    `James O'Brien`). They no longer swallow a greeting or title
    (`Dear Customer` is not a name; in `Dr Kumar` only `Kumar` is masked) or a
    sentence opener (`Today Rajesh Kumar` → `Rajesh Kumar`). Hyphenated
    headings such as `Real-World Validation` are not names.
  - **Names without Title Case or a cue:** lower-case and ALL-CAPS names in
    text (`reassigned to priya nair`), a single name after a greeting or title
    (`Thanks, Fatima`, `Kind regards,\nAnil`, `Dr Kumar`, `السيد راشد`), and a
    first or last name that repeats a full name found elsewhere in the same
    text.
  - **Product catalogues:** a value under a weak key like `name` must contain
    a listed name, so `wireless mouse` and `USB CABLE` rows are not people.
  - **Confidence levels:** name findings carry `confidence`: `high` (a field
    or cue), `medium` (the name list) or `low` (Title Case only).
    `maskText({ minConfidence })` filters on it, and each Guardian destination
    can set `minNameConfidence`, which observe, execute and verify all apply.
    Every destination defaults to `low`, so today's behaviour is unchanged.
  - Masking a 620 KB prose file takes about 0.3 s instead of 0.1 s, while
    finding twice as many names in it. The list loads in about 50 ms, the
    first time it is used.
- **Phone numbers without separators** (#11). `phone` accepts E.164
  (`+447946095812`, `+966501234567`), the form databases and APIs store, and
  national numbers grouped 3-4-4 or 4-3-4 (`020 7946 0958`) after a phone label
  (`tel`, `phone`, `mobile`, `هاتف`, …). Timestamps and order numbers, which
  have no `+`, stay unflagged.

### Changed

- **Spreadsheets are read one row per line**, cells joined by ` | `, so the
  header row labels each column. No pattern can match across the separator,
  so every finding stays inside one cell.
- **Places and organisations are no longer names**: `Abu Dhabi`,
  `Sultan Bin Zayed Street`, `Gulf Logistics LLC`, `Visual Studio Code`,
  `Finance Department`, `شارع …`, `أبو ظبي`. The veto outranks a name cue.
- **Form headers are no longer names**: `Full Name`, `Place Of Birth`,
  `Residence Visa`.
- **A lighter repository** (#21). The tracked working tree drops from about
  8.5 MB to 1.3 MB; the npm package was never affected. The 5 MB demo video
  is no longer in the tree, and `og-card.png` (627 KB) and `logo.png` (993 KB)
  are now `docs/assets/og-card.jpg` (60 KB) and `docs/assets/logo.png`
  (170 KB, 512×512). Generated documents are no longer committed:
  `npm run docs:pdf` builds the technical implementation PDF (set `CHROME` to
  the browser binary), the new `npm run docs:deck` builds the briefing deck,
  and `.github/workflows/release-docs.yml` builds both and attaches them to
  every GitHub release. Working notes (`LINKEDIN.md`, `changes_23Sept.md`,
  `commands_to_run_to_test.md`) moved to `docs/notes/`.

### Fixed

- **No output is written through a symbolic link** (#33). Git stores
  symlinks, so a repository could ship `masked_config.env -> ~/.bashrc`, and
  `mask-dir -r` then wrote the masked copy of `config.env` into the user's
  shell start-up file. Every writer -- `mask`, `mask-dir`, `db-mask`,
  `scan-dir -o`, `impact --write`, agent-guard `--auto-mask` and Guardian's
  release copy, in every format -- now goes through
  [src/lib/safe-write.js](src/lib/safe-write.js): a destination that is a
  symbolic link or not a regular file is refused (exit 2, or `[fail]` for
  that file in `mask-dir`), and the data is written to a new temporary file
  in the same folder and renamed into place, so a link planted after the
  check is replaced rather than followed and no half-written file is ever
  visible. A replaced file keeps its permissions.
- **`db-scan` / `db-mask` cannot write to the database** (#34). `--limit 0`,
  `-5` or `abc` switched off the derived-table wrap that makes a `DELETE`,
  `UPDATE` or `DROP` a syntax error, so `db-scan "$PG" -q "DELETE FROM
  customers" --limit abc` deleted every row and reported "0 rows, clean".
  `--limit` now accepts only a whole number from 1 to 10,000,000 (exit 2
  otherwise), and the library refuses an unusable limit instead of skipping
  the cap. PostgreSQL queries run in a `READ ONLY` transaction through a
  server-side cursor (`DECLARE … CURSOR`, which accepts only a query, sent as
  a single prepared statement) and are fetched in batches up to the limit, so
  a second statement, a data-modifying `WITH` or a function that writes is
  refused by the server, and the caller's SQL is no longer rewritten. MySQL
  queries run in a `START TRANSACTION READ ONLY` that is rolled back. The
  wrap used by the other SQL drivers puts the statement on its own lines, so
  a trailing `-- comment` no longer breaks it.
- **The agent-guard API only serves local tools, inside the watched folder**
  (#32). Loopback is not a trust boundary: every web page the user opens can
  send requests to `127.0.0.1`, and so can every other process on the
  machine. `/mask` wrote a masked copy to any `output` path -- a cross-origin
  `text/plain` POST from a web page could overwrite a file outside the
  watched folder -- and `/scan` read any path. `/scan` and `/mask` now
  require, in order: a `Host` of `127.0.0.1`, `localhost` or `[::1]` (defeats
  DNS rebinding); no `Origin` header (no web page); `Content-Type:
  application/json` (no preflight-free cross-origin request); and
  `Authorization: Bearer <token>`, with a random token minted at start and
  written to `~/.kakashi/agent-guard-<port>.token` (mode 0600, removed on
  stop; `--token-file` to move it, `KAKASHI_GUARD_TOKEN` to set it). `path`
  resolves against the watched folder and must stay inside it after
  symlinks; an explicit `output` must be a new file there, the default
  `masked_<name>` may be refreshed, and neither may be a symlink or the
  input. `--auto-mask` follows the same output rule. A non-object or
  non-string body is a 400 instead of a crash. `/health` names the token
  file. **Clients must now send the token** (see
  [commands/kakashi-agent-guard.md](commands/kakashi-agent-guard.md)).
- **PDFs are read in full** (#31). Text items on a line are now separated by
  the gap between them (nothing, a space, or a tab for a column), so a table
  row no longer reads as `1Rajesh Kumar0501234567411111…` and its IDs, phones
  and cards are detected; items drawn over each other start a new line. Form
  field values, note text and authors, alternative text and the document's
  title, author, subject and keywords are read too. A page that paints an
  image but carries almost no text is reported as not checked: `scan` and
  `mask` say so, the masked extract's header names the page, and Guardian
  returns `REQUIRE_APPROVAL` (`UNSCANNED_CONTENT`) before an external
  release. PDFs under about 4 KB no longer fail with "bad XRef entry". The
  extract's header states how many values were replaced (or that none were)
  instead of always claiming values were replaced. pdf.js no longer prints
  warnings into `--json` output, and reading a PDF with embedded fonts no
  longer risks a crash from pdf.js trying to load them into a browser DOM.
- **Office files are read and masked in full** (#27). A `.docx`, `.pptx` or
  `.xlsx` was read only for its body text, so everything else was missing from
  both the scan and the masked copy, and Guardian released the unchanged
  original: footnotes and endnotes, tracked deletions, field codes
  (`HYPERLINK "mailto:…"`), alt text, comment and revision authors, slide
  masters and layouts, charts, SmartArt, cell comments, formulas, sheet and
  defined names, document and custom properties, `customXml` data, and the
  target of every external link. A coverage table per format
  ([src/engine/formats/package.js](src/engine/formats/package.js)) now drives
  reading, masking and verification, matched on each part's declared content
  type so off-convention part names (openpyxl's `xl/comments/comment1.xml`)
  are found too. Office files embedded in Office files, such as a chart's data
  workbook, are handled recursively. A sheet whose name holds a value is
  renamed to a legal name, and formulas that refer to it follow. The
  first-page thumbnail, which pictures the original text, is dropped from the
  masked copy. Prompt text in master and layout placeholders ("Click to edit
  Master title style") is not scanned, since it never renders.
- **Masked Office files are verified before they are written** (#27). The
  masked package is reloaded from its own bytes, and if any value the mask set
  out to replace is still present, `mask` exits 2 and writes nothing, where it
  used to print "1 replacement made". The check also reads the package the way
  the scanner does, so a value that runs from one part into another (body into
  footnote) cannot leave a fragment in each.
- **Values that span paragraphs are masked** (#29). A private key pasted one
  line per paragraph, or an address block, was found by the scanner in the
  joined text but matched paragraph by paragraph by the writer, which could
  never see it: `mask` reported it replaced while every line stayed in the
  file. Each part is now masked as the scanner reads it, so the value becomes
  one token in its first paragraph and the paragraphs after it are emptied.
  Masking is linear in the size of a part (20,000 replacements in one part:
  30 s to well under a second).
- **Every text output is read back before it is kept** (#29). Text and PDF
  extracts are re-read with the same decoder and removed, with exit 2, unless
  they hold exactly the masked text.
- **UTF-16 text files are read and masked** (#30). Every text file was read as
  UTF-8, so a UTF-16 file (Excel's "Unicode Text", Windows PowerShell 5's `>`)
  scanned as 0 findings and was masked into a mangled copy that still held
  every value. The encoding is now detected from the byte order mark, or from
  the NUL bytes of UTF-16 without one; the file is decoded, and the masked
  copy is written back in the same encoding with the same BOM. A truncated
  UTF-16 file, an invalid surrogate pair or UTF-32 text is refused with exit 2
  instead of being guessed at.
- **Embedded objects Kakashi cannot read are reported** (#27). OLE objects,
  ActiveX controls and macro projects are listed as unscanned: `scan` and
  `mask` say so, `guard --json` has `unscannedParts`, and Guardian returns
  `REQUIRE_APPROVAL` (`UNSCANNED_CONTENT`) before releasing such a file to an
  external destination. Approve with `--approve UNSCANNED_CONTENT`.
- **Line breaks and tabs in Word and PowerPoint separate text** (#28). Soft
  breaks (`<w:br/>`, `<a:br/>`), tabs and non-breaking hyphens are elements,
  not text, and were skipped, so a signature block read as one run-on line:
  the name, phone and part of a card number went undetected, and a token could
  swallow the label after a tab. They now count as read-only characters, so
  the text matches what a reader sees and the writer never removes them.
  Deleted and inserted text under Track Changes no longer fuse, and a text box
  no longer takes over the rest of the paragraph it is anchored in. Reading a
  large document is also linear now (80,000 paragraphs: 7.3 s to 1.8 s), and
  masked packages are compressed again.
- **Secrets under quoted keys are detected** (#3). `env_secret` now reads
  `{"password": "…"}` (JSON), `{'password': '…'}` (Python / JS), XML elements
  (`<password>…</password>`) and .NET-style attributes
  (`<add key="ApiKey" value="…"/>`), `$password = "…"` (PHP), `--password=…`
  (command-line flags) and keys in Markdown inline code. Only the value is
  replaced, so JSON and XML stay valid. Empty values, `null` / `true` /
  `false`, nested objects, and bare variable references after a quoted key
  (`{"X-Signature": HMAC_SECRET}`) are not flagged. An unquoted value now
  stops at a quote or backtick, so masking no longer swallows the closing
  quote of `echo "TOKEN=…"` or of inline code.
- **Commit hashes and checksums are no longer credentials** (#4).
  `hex_secret` skips 40-, 64- and 128-character hex strings in hash context:
  after a cue word (`commit`, `sha256`, `checksum`, …), as a `(sha)` changelog
  reference, in a commit URL or `@sha256:` digest, or at the start of a
  checksum or `git log` listing line. A secret-like word on the same line
  (`secret`, `token`, `api key`, …) keeps it flagged. A changelog citing a
  commit now gets `ALLOW` from the Guardian instead of `REQUIRE_APPROVAL`.
- **`guard --json` now has the fields the agent rules name** (#17). The
  installed rules tell agents to narrate from `plan.actions` and
  `verifications`, which the output didn't have. Both are added, value-free
  (classes, tools, reason codes, counts). A test parses the field list out of
  every rule file and fails if the output is missing any of them.
- **README examples restored** (#18). The v1.3.1 README had been run through
  the masker: commands read `kakashi db-scan "[DB_CONN_2]"`, the
  connection-string table was unreadable, and the "What Kakashi Catches" tables
  showed tokens on both sides of the arrow. The original example values are
  back (live-key shapes kept truncated). A docs test fails if a token or an
  `[…_EXAMPLE]` placeholder appears on the input side of an example again.
- **Agent support claims match the installer** (#19). The README listed 15
  agents ("20+") with `--only` commands, but the installer supports 7. The
  table now lists the 7, with the `--with-init` step Cline and Copilot need, and
  explains how other agents can use Kakashi. The installer rejects an unknown
  `--only` id, accepts a comma-separated list, and reports an agent it couldn't
  set up as skipped with the reason, instead of doing nothing (Cline and
  Copilot without `--with-init`) or printing `[ok]` without writing anything
  (Windsurf without `~/.windsurf`).
- **Credit cards need a Luhn check digit** (#6). The `cc` pattern accepted any
  13-19 digit number, so millisecond timestamps and order numbers were masked
  as cards (class `FINANCIAL`). It now requires a valid Luhn check digit, and a
  run of digits with no separators must also start with a card network's
  prefix. The README's "Luhn-verified" note is now true.
- **Emirates IDs are detected with spaces or no separators** (#10).
  `784 1990 1234567 1` was missed and `784199012345671` was detected only as a
  credit card, with the wrong class, PDPL articles and token. Both are now
  `national_id` when they pass the Emirates ID checksum or follow a label
  (`EID`, `Emirates ID`, `رقم الهوية`, ...). The dashed form stays lenient.
- **IBANs from every country** (#9). A new `iban` pattern (class `FINANCIAL`)
  covers Saudi, GCC, UK, EU and other IBANs; `uae_iban` keeps `AE`. Matches
  must pass mod-97 and have their country's registered length, which also
  stops a trailing word (`... 32 USD`) from being swallowed into the match.
  There are now 36 patterns.
- **`env_secret` no longer flags properties, references or placeholders**
  (#7). `max_tokens: 1024`, `token_type: bearer`, `PASSWORD_MIN_LENGTH=12` and
  `TOKEN_TTL=3600` describe a secret rather than hold one; `${DB_PASSWORD}`,
  `$API_KEY`, `{{ secrets.X }}`, `<your-password>`, `changeme` and truncated
  examples such as `sk-proj-...` stand in for one; and `DB_HOST=localhost` is
  not infrastructure worth hiding. Real values stay flagged, including numeric
  passwords, `password: password` and internal hostnames.
- **Noisy patterns need context** (#8). `passport` and `date` reject a match
  that follows a business-document label (invoice, order, due, …) unless a
  passport or birth label is there, and `passport` rejects codes whose digits
  read as a YYYYMMDD date; unlabelled values are still flagged, and so are
  document expiry and issue dates, which are personal data in HR files. `trade_lic` is
  case-sensitive and needs a digit (`cn-north-1` was a licence). `email`
  rejects file names such as `logo@2x.png` (only extensions that are not real
  TLDs). `intl_phone` no longer starts inside a longer number.
- **`mask-dir` tokens are consistent across files** (#14). Each file used to
  start its own token map, so `[EMAIL_1]` was a different person in every
  file of one run. One map is now shared across the run, as `db-mask` shares
  one across rows: the same value gets the same token (or fake) in every file.
- **Fake mode gives every distinct original its own fake** (#15). It cycled
  through each pattern's one or two `fakeValues`, so the third email became
  the first email's fake. The listed fakes are still used first; after that
  each pattern generates distinct, deterministic values in its own format
  (`src/engine/fakes.js`). Where the format allows, generated values can never
  be live: Emirates IDs with a wrong check digit, cards in the 411111 test
  range, IBANs on nonexistent banks, SSNs in the never-issued group 00, IPs in
  10.0.0.0/8 and emails on example.com.
- **agent-guard watches subfolders on Linux** (#16). It passed
  `recursive: false` to `fs.watch` on Linux, so a secret written to
  `./project/config/.env` was never passively scanned, and the polling
  fallback only listed the top level too. It now uses a recursive watch where
  the platform has one (Linux from Node 20), one watcher per directory
  otherwise (Linux on Node 18, adding watchers as folders appear and scanning
  files already inside them), and a recursive walk when polling.
  `node_modules`, `.git` and similar are skipped. `/health` adds
  `watchStrategy` (`native` | `tree` | `poll`) and `watchRecursive`, and
  `KAKASHI_GUARD_WATCH` forces a strategy.
- **Architecture docs describe the current release** (#20).
  `docs/ARCHITECTURE.md` still described v1.1 (35 patterns, six commands, 101
  tests). It now covers v1.3 and this release: 36 patterns, the 14 commands,
  the new engine modules and the version history. `README.ar.md` lists the 14
  commands and 7 agents, the pilot-kit FAQ and demo script no longer claim
  "20+ agents", and `docs/TECHNICAL_IMPLEMENTATION.md` is marked as a v1.1
  snapshot. A docs test checks every stated pattern and command count against
  the code.
- **Masking is linear in file size** (#13). `maskText()` recounted lines from
  the start of the text for every finding and rebuilt the whole string for
  every replacement, so 8,000 JSON lines took ~6 s with one pattern and a
  5,000-row CSV ~8 s with all patterns. Both now happen in one forward pass:
  16 ms and 123 ms respectively. Output is byte-for-byte identical, including
  line numbers; a test guards against a quadratic regression.
- **Masking a short name no longer corrupts longer words.** The xlsx, docx and
  pptx writers replaced every masked value as a plain substring, so masking
  `Ali` would have rewritten `Alignment`. Name-like values are now replaced as
  whole words; values containing digits or symbols (secrets) keep substring
  replacement.

## [1.3.1] — 2026-09-23

**Bug-fix release.** Closes the "`Unrecognized command '/Kakashi'`" gap on
Codex CLI (and, by extension, every agent that lacks a native slash-command
mechanism), and gives users a proper features brief the first time they
invoke Kakashi in any agent.

### Fixed

- **`/kakashi` (any case) now works in Codex CLI, GitHub Copilot, and
  Continue** — agents that do NOT read `~/.<agent>/commands/*.md` as
  user-invokable slash commands. The system-prompt rules
  ([AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md),
  [src/rules/kakashi-activate.md](src/rules/kakashi-activate.md)) now
  explicitly teach the LLM to recognise `kakashi`, `Kakashi`, `KAKASHI`,
  `/kakashi`, `/Kakashi`, `/KAKASHI`, `use kakashi`, `run kakashi`,
  `activate kakashi` — with or without the leading slash, in any case —
  and to dispatch normally. When the agent runtime replies
  `Unrecognized command '/Kakashi'`, the LLM has been taught this is the
  *start* of the interaction, not the end: the user's next plain-language
  kakashi mention is the real trigger.
- **Root `AGENTS.md` and `CLAUDE.md` now carry the full v1.3 orchestrator
  content.** Before this release those files still listed only 5 slash
  commands (`scan`/`mask`/`audit`/`stats`/`list`) and never mentioned
  `guard`, `scan-dir`, `db-*`, `agent-guard`, or `impact` — a Codex CLI
  user reading `~/.codex/AGENTS.md` saw pre-v1.3 content while a Cursor
  user with `~/.cursor/commands/*.md` saw the full 14. Now both surfaces
  are identical.
- **`package-lock.json` drift.** v1.3.0 shipped with the lockfile still
  pinned at 1.2.0 (bumped only via `chore(release)` on package.json, not
  via `npm version`). `tests/cli.test.js` caught this on the next run;
  v1.3.1 uses `npm version 1.3.1` which updates both files atomically.

### Added

- **Kakashi features brief.** Every rule file now opens with a short
  brief that shows the user what Kakashi is and what it can do for them
  in this session — displayed automatically when the user types the
  trigger with no additional intent (`/kakashi`, `kakashi`, `use kakashi`,
  etc). The brief lists the four capabilities (Check / Mask / Guardian /
  Standing sidecar), the coverage (35+ patterns, 50+ formats, 6 DB
  drivers), and offers 4-5 example prompts the user can send next.
- **Case-insensitive trigger contract** documented in all four rule files
  (`commands/kakashi.md`, `src/rules/kakashi-activate.md`, `AGENTS.md`,
  `CLAUDE.md`). Named specifically so the LLM does not require the exact
  lowercase spelling before recognising the orchestrator invocation.
- **Test-enforced parity across the four rule files.**
  [tests/orchestrator.test.js](tests/orchestrator.test.js) grew from 29
  assertions to 48 — including per-file assertions for the brief markers,
  the case-insensitive trigger markers, the "no slash-command mechanism"
  fallback (naming Codex CLI + the `Unrecognized` error explicitly), the
  full v1.3 slash-command catalogue in AGENTS.md + CLAUDE.md, and a
  byte-identical invariant between AGENTS.md and CLAUDE.md (the installer
  uses whichever exists via `loadActivateBlock`, so drift would silently
  fork Claude Code and Codex CLI onto different rules).

### Not changed

- No functional behaviour of any Kakashi subcommand.
- No changes to the Guardian loop, the pattern engine, the six DB drivers,
  or the installer matrix beyond the version bump.
- Fully backward-compatible with v1.3.0 tokens and workflows.

---

## [1.3.0] — 2026-09-23

The **orchestrator release**. Typing `/kakashi` (with or without a sentence
of intent) now picks the right Kakashi tool automatically — scan, scan-dir,
mask, mask-dir, guard, db-*, agent-guard — and narrates each decision.
Users no longer need to know that `/kakashi-guard` exists to get a
Guardian decision. Guardian's own render exposes the loop as
THINK → OBSERVE → ASSESS → PLAN → ACT → VERIFY → REACT.

### Added

- **`/kakashi` orchestrator** ([commands/kakashi.md](commands/kakashi.md)).
  A 12-row intent dispatch table routes every user ask to the correct
  subcommand. The award-defining scenario — "may Cursor send this file to
  an external model to average salary?" — deterministically routes to
  `guard`, not to a silent `mask`. Chain rules (scan → mask → re-scan;
  scan-dir → guard-per-file; db-scan → db-mask; scan → guard for release
  questions) are encoded in the same file. Locked by
  [tests/orchestrator.test.js](tests/orchestrator.test.js).
- **Always-on Cursor rule mirror**
  ([src/rules/kakashi-activate.md](src/rules/kakashi-activate.md)). Same
  intent-based dispatch fires even when the user never types `/kakashi`.
- **Eight new slash commands** in `commands/`, bringing the total from 6
  to 14: `kakashi-scan-dir`, `kakashi-mask-dir`, `kakashi-guard`,
  `kakashi-db-scan`, `kakashi-db-mask`, `kakashi-db-audit`,
  `kakashi-agent-guard`, `kakashi-impact`. Every human-only variant
  (`audit`, `db-audit`) opens with a warning that plaintext will enter
  the conversation.
- **Guardian human-terminal render now shows the whole loop**
  ([src/guardian/render.js](src/guardian/render.js)). New `THINK` section
  restates who is asking, for what, to send where. New `ACT` section
  reports what was written to the scratch artifact (with replacement
  counts, never values). Final `REACT` section replaces the plain
  `DECISION` header so a reader sees the loop labels in loop order.
  Locked by
  [tests/guardian-narrative.test.js](tests/guardian-narrative.test.js) —
  fixture secrets are proven absent from the rendered output.
- **`agent-guard` Windows fallback**
  ([src/agent/guard.js](src/agent/guard.js)). `fs.watch` throwing
  `UNKNOWN: unknown error, watch` on Windows mapped drives / network
  shares / WSL mounts no longer kills the daemon. The synchronous throw
  is caught, a `watch_failed` event fires, and the daemon degrades to a
  polling scanner. Setting `KAKASHI_GUARD_NO_WATCH=1` skips the watcher
  entirely (HTTP-only mode). `/health` now exposes
  `"watchMode": "watch" | "poll" | "off"`.
- **`kakashi impact` snapshot now reads the version from `package.json`**
  ([src/lib/stats.js](src/lib/stats.js)). Fixes the "kakashiVersion:
  1.1.0 while CLI is 1.2.0" drift the September 23 report flagged.
  Locked by [tests/impact.test.js](tests/impact.test.js).
- **Four new test suites**, +40 assertions on top of the existing 348:
  `orchestrator`, `guardian-narrative`, `guard-fallback`, `impact`.
  Full suite: **388 passed, 0 failed** in ~12 seconds.

### Changed

- **`bin/install.js` SLASH_CMDS array** grew from 6 to 14 entries.
  Documented as a two-step contract with the `commands/` folder; the
  orchestrator test asserts both lists stay in sync so a future addition
  cannot skip either half. Installer log lines now say
  `${SLASH_CMDS.length} slash commands` instead of a stale `"6"`.

### Community

- Credit **[@lauraabdul](https://github.com/lauraabdul)** for the
  [`sql_password`](https://github.com/Muhammadatef/kakashi/pull/1)
  detection pattern that landed on `main` between 1.2.0 and 1.3.0 —
  covers SQL auth clauses like `IDENTIFIED BY '...'` /
  `WITH PASSWORD '...'` / `ENCRYPTED BY '...'` that `env_secret`'s
  `[:=]` delimiter never sees. The v1.3.0 PDPL mapping now includes it
  under Art. 20 + Art. 21.

### Not changed

- The Guardian loop itself, the pattern engine, the installer's agent
  matrix, and every existing exit code / decision label — all unchanged.
  This is a UX + testability release; no functional behaviour was
  weakened.

---

## [1.2.0] — 2026-09-18

The **Guardian release**. Kakashi stops being a masker you invoke and becomes a
protection loop that holds a goal, understands what the data is wanted for, acts,
checks its own work and changes its mind when it was wrong.

### Added

- **The Guardian understands the task it is given** (`guardian/task.js`). `--task` used
  to be decoration — printed, logged, read by nothing. It is now a stage of the loop
  between OBSERVE and ASSESS: a stated purpose becomes a requirement per data class
  (values must stay *distinguishable*, must keep their *shape*, or are *not needed at
  all*), and the planner starts from the transform that purpose needs instead of
  discovering it by failing verification first. Six intents, English and Arabic, matched
  deterministically against a fixed vocabulary — no model, no network, no new dependency.
  An unrecognised purpose is reported as unrecognised and changes nothing.
  - *On the employees fixture to an external model: a blind run needs two iterations, a
    run that states "calculate average salary by age group" needs one — and
    "debug the failing export job" redacts the people outright, because debugging has no
    use for them.*
  - **The task string comes from the agent Kakashi is protecting data from, so it can
    only ever make protection stricter.** No intent can request plaintext; the strongest
    claim a purpose can make is "I need to tell values apart", which is answered with
    stable tokens. `assertNonWeakening()` is exported and run as a property test over
    every intent × class × permitted-tool subset (504 combinations), alongside an
    end-to-end test that fires injection-shaped task strings at a real run and asserts
    the released artifact is never less protected than the no-task baseline.
  - Not stating a purpose now costs risk points (`TASK_NOT_STATED` +5,
    `TASK_NOT_UNDERSTOOD` +3) — purpose limitation needs a purpose. Stating one never
    buys a discount, which is exactly what a crafted string would go shopping for.
- **Kakashi Guardian** (`kakashi guard <file>`) — an autonomous protection loop over the
  existing engine. Where `mask` applies a fixed pipeline once, `guard` holds a goal,
  observes the resource, assesses contextual risk (agent, destination, data class),
  plans the *minimum necessary* protection, validates that plan against policy, executes
  it, **re-scans its own output**, and replans with a stronger transform if the artifact
  is still unsafe. Decisions: `ALLOW`, `ALLOW_WITH_TRANSFORMATION`, `REQUIRE_APPROVAL`,
  `BLOCK`.
- Agent trust profiles (7 existing integrations + `local_model` + conservative `unknown`
  defaults) and destination-aware policy rules — Kakashi's first configuration layer.
- Nine sensitivity classes mapped from all 35 detection patterns, with a drift guard so
  a new pattern cannot ship unclassified.
- Value-free decision audit events (`~/.kakashi/guardian-audit.jsonl`), asserted by test
  to contain no raw secrets.
- 41 new Guardian tests and 17 TaskAnalyzer tests, plus 128 new detection- and
  coverage-correctness assertions (340 total, all passing), including new
  `tests/formats.test.js` and `tests/task.test.js`.

### Notes

- No new runtime dependencies. No daemon, no server, no separate install step — the
  Guardian ships inside the existing package and is reached through the existing CLI.
  A test locks this: it fails if a dependency is added or the installer registry changes.
- The Guardian itself changed nothing in the v1.1 engine, compliance or sidecar
  layers; all 110 pre-existing assertions still pass unchanged. The pattern fixes
  below are a separate, deliberate change to `engine/patterns.js` — see **Fixed**.

### Fixed

- **`--stdin` could not be used the way it was documented.** `kakashi mask --stdin` is
  described as "read from stdin, write to stdout", but the file argument was declared
  required, so the documented invocation failed with *"missing required argument 'file'"*
  and the only way through was a placeholder path (`/dev/stdin`) that `--stdin` then
  ignored. The argument is optional now, and required only when `--stdin` is absent.
- **Names silently survived masking in spreadsheets.** Eleven patterns separated their
  tokens with `\s`, which matches newlines. `engine/formats/xlsx.js` flattens every cell
  into one newline-joined string for detection and writes back per cell, so a match
  spanning cells (`"Dept\nAhmed Hassan"`) existed in no single cell and the write
  silently did nothing — `kakashi mask` reported success while the names remained.
  Separators are now `[ \t]`, so a match can never cross a line. This also removes the
  matching false positive in prose, where `"Notes\n\nNothing"` read as a person's name
  and masking replaced both non-sensitive words with one token. Affects `full_name`,
  `non_latin_name`, `cc`, `uae_iban`, `intl_phone`, `phone`, `pobox`, `bearer`,
  `dob`, `age` and `env_secret`. `ssh_key` is exempt — a PEM block is genuinely
  multi-line. A structural test now fails if any future pattern reintroduces `\s`.
- **A file literally named `.env` was unreadable.** `path.extname('.env')` returns `''`
  — a leading dot marks a hidden file, not an extension — so `kakashi scan .env` failed
  with *"Unsupported file format: .env"* while `demo.env` worked. The commonest secret
  file in existence, and the one this project's own README leads with, could not be
  scanned or masked. Dotfiles now resolve from the basename, covering `.env`,
  `.env.local`, `.env.production` and `.gitignore`.
- **Directory walks skipped most of the file types the engine supports.**
  `SUPPORTED_EXTS` was a hand-maintained list of 17 while the text engine understood
  101. The two drifted and the consequence was silent: `kakashi scan main.go` reported a
  leaked key, but `mask-dir` and `scan-dir` never opened Go, Terraform, Rust, Java or
  shell files — so a folder-level compliance report could read clean with live
  credentials in `main.tf`. `SUPPORTED_EXTS` is now derived from the engine's own list,
  with a test that fails if they diverge again. Directory walks also now match hidden
  files (`dot`) and extensionless names like `Dockerfile` (case-insensitively).
- **A compliance report could not be told apart from one that never looked.**
  `scan-dir` honours `.gitignore` by default, and `.env` is gitignored in most repos, so
  the report simply omitted it. The default is unchanged — it is deliberate, and
  `--no-gitignore` overrides it — but the report and the terminal summary now state how
  many files the ignore files excluded.
- **`mask-dir --ext <one-extension>` never matched anything.** `*.{py}` is not a brace
  expansion; glob reads it literally. A single extension is now emitted as `*.py`.
- **`mask-dir` descended into subdirectories without `-r`.** commander leaves
  `--recursive` undefined when the flag is absent, which reached a defaulted parameter.
- **Masked database rows lost referential integrity.** `db-mask` masks one row per
  `maskText()` call, and token state was per-call, so numbering restarted at `_1` on
  every row: five distinct customers all became `[FULL_NAME_1]`, and `--mode fake` gave
  every row the same synthetic person. Nothing leaked, but the output was useless for
  the thing masking is *for* — an agent asked "how many distinct customers?" would
  answer 1. `maskText` now accepts `valueMap`/`counters` so a caller can thread one
  token space through a whole result set; same value → same token, different value →
  different token. Callers that pass neither are unaffected.
- **`env_secret` destroyed the variable name and shadowed every specific credential
  pattern.** It matched `KEY=value` and replaced the whole span, so
  `OPENAI_API_KEY=sk-proj-...` masked to a bare `[ENV_SECRET_1]` — losing the one piece
  of context an agent needs to reason about the file. Because that wide match starts at
  the key, earlier than the value, it also won overlap resolution against `openai_key`,
  `stripe` and friends: the `[OPENAI_KEY_1]` token this README advertises could never
  actually be produced. Patterns may now declare `valueGroups`, the capture groups
  holding the secret itself; `env_secret` replaces only the value, quotes and key name
  intact, and a more specific pattern wins the narrowed overlap. The README's `.env`,
  Python and SQL before/after examples now reproduce byte-for-byte.
- **Masking is idempotent again.** Narrowing `env_secret` to the value meant its own
  output (`API_KEY=[OPENAI_KEY_1]`) still read as `KEY=value`, so a second pass "found"
  a secret and the Guardian — which re-scans its own artifact — escalated until it gave
  up and returned `BLOCK`. `env_secret` now refuses values that are already mask tokens.
- **`env_secret` missed the commonest `.env` forms.** The key prefix before the trigger
  word was mandatory, so `PASSWORD=`, `API_KEY=`, `TOKEN=` and `SECRET=` were all
  undetected while `DB_PASSWORD=` matched; the pattern's own `fakeValue`
  (`API_KEY=sk-fake123`) was itself undetectable. The prefix is now optional, with a
  narrow stoplist so `TOKENIZER=bpe` does not fire.
- **Four `--mode fake` substitutions scanned clean.** The `anthropic`, `hf_token`,
  `stripe` and `bearer` fake values were 18 characters where their own pattern
  requires 20+, so masking produced a key-shaped string that no longer detected as one —
  a re-scan (and the Guardian's verifier) would call such a file safe. A test now asserts
  every `fakeValues` entry is still detectable by the full detector. `env_secret` drops
  its `fakeValues` instead of lengthening it: any self-detecting `KEY=value` fake would
  re-trigger its own pattern on every re-scan, so it falls back to the generic
  `fake_env_secret`, which no pattern matches.

---

## [1.1.0] — 2026-09-16

The **sovereign-privacy release**. Ships everything needed to run Kakashi at
UAE national scale: native Emirates identifier detection, PDPL-mapped
compliance reports, client-side database masking, a local privacy daemon for
agentic AI, and full English + Arabic support.

Also merges the community-contributed [`sql_password`](https://github.com/Muhammadatef/kakashi/pull/1)
pattern from @lauraabdul that detects secrets in SQL `IDENTIFIED BY` /
`WITH PASSWORD` / `ENCRYPTED BY` clauses — thank you.

### Added

**Detection**
- 🇦🇪 **Emirates ID pattern** with Luhn checksum validator (`isValidEmiratesId`).
- 🇦🇪 **UAE IBAN pattern** with ISO 13616 mod-97 checksum validator (`isValidIban`).
- 🇦🇪 UAE mobile & landline coverage (`intl_phone` relabelled to "UAE Phone").
- 🇦🇪 Arabic-name detection (Unicode range `\u0600–\u06FF`) — first-class citizen.
- Every pattern gained an Arabic label (`labelAr`) for bilingual output.
- Exported checksum helpers `luhnCheck`, `isValidEmiratesId`, `isValidIban` for
  downstream compliance tooling.

**Database masking (new subsystem)**
- New subcommands: `kakashi db-scan`, `kakashi db-mask`, `kakashi db-audit`.
- Six lazy-loaded native drivers: PostgreSQL (`pg`), MySQL (`mysql2`),
  MongoDB (`mongodb`), Snowflake (`snowflake-sdk`), Databricks
  (`@databricks/sql`), SQLite (`better-sqlite3`).
- Client-side streaming — rows are masked on the user's machine before any
  AI agent sees them. Zero cloud, zero proxy.
- `mock:` driver for tests + demos; ships built-in.
- JSONL, JSON, and CSV output formats.

**Enterprise directory scanner (new subsystem)**
- New subcommand: `kakashi scan-dir <path>`.
- Async concurrency pool (default 8) for I/O-bound scans.
- Respects `.gitignore` and `.kakashiignore`.
- Compliance report renderer at `src/lib/reporter.js` — JSON, HTML, Markdown.
- HTML report is bilingual (`--lang ar`), print-optimised, RTL-aware, and
  citations PDPL articles per finding.

**PDPL compliance layer (new subsystem)**
- `src/lib/pdpl-mapping.js` — every detection pattern mapped to specific
  articles of UAE Federal Decree-Law No. 45 of 2021.
- 9 PDPL articles catalogued (Art. 1, 5, 6, 9, 15, 20, 21, 22, 25).
- Severity heuristic (critical / high / medium / low) driven by article
  citations.
- `enrich(finding)` and `summarize(findings)` public API.

**Bilingual English + Arabic**
- `src/lib/i18n.js` — full EN + AR string tables.
- Language resolution priority: `--lang` flag → `KAKASHI_LANG` → `LANG` env
  starting with `ar` → English fallback.
- Complete Arabic README at `README.ar.md`.
- Bilingual compliance report with `dir="auto"` for automatic RTL.

**agent-guard sidecar daemon (new subsystem)**
- New subcommand: `kakashi agent-guard --watch <dir>`.
- Loopback-only HTTP API (`127.0.0.1`) with three endpoints:
  `GET /health`, `POST /scan`, `POST /mask`.
- Passive `fs.watch` scanner with optional JSONL audit log.
- Explicit `req.socket.remoteAddress` hard-check refuses non-loopback origins
  with `403`.
- Optional `--auto-mask` writes a masked copy on every finding.

**Impact snapshot**
- New subcommand: `kakashi impact [--write path]`.
- Produces a privacy-preserving JSON snapshot (category counts + coarse
  month-bucket, no filenames or paths) that users can voluntarily contribute
  to the public adoption dashboard.

**CI / CD**
- `.github/workflows/ci.yml` — runs `npm test` on every push and pull
  request across Node 18, 20, and 22.
- `.github/workflows/publish.yml` — publishes to npm when a `v*` tag is
  pushed. Requires an `NPM_TOKEN` repository secret.
- `.github/workflows/pages.yml` — deploys the public adoption dashboard to
  GitHub Pages on any change under `docs/dashboard/`.

**Documentation**
- `docs/ARCHITECTURE.md` — comprehensive rewrite with mermaid data-flow
  diagrams, STRIDE threat model, trust-boundary diagram, agent integration
  protocol, and OECD + UAE ethical-AI alignment table.
- `docs/TECHNICAL_IMPLEMENTATION.pdf` — 16-page A4 technical brief for
  procurement / audit review. Regenerate with `npm run docs:pdf`.
- `docs/UAE_PILOT_KIT.md` — 30-minute pitch script, objection-handling
  table, and testimonial template for UAE outreach.
- `docs/DEMO_VIDEO_UAE.md` — bilingual 60-second video production kit.
- `docs/dashboard/index.html` — public GitHub Pages dashboard fetching live
  npm + GitHub stats client-side (no backend).

**Testing**
- Suite grew from **~65 tests → 101 tests across 8 files**:
  `patterns.test.js` (55), `masker.test.js` (6), `cli.test.js` (4),
  `pdpl.test.js` (6), `db.test.js` (10), `reporter.test.js` (6),
  `i18n.test.js` (8), `guard.test.js` (6).
- New `tests/fixtures/uae_sample.md` fixture covering all UAE patterns with
  synthetic identifiers.

### Changed

- `intl_phone` pattern label updated to "UAE Phone" for clarity (id stays
  stable so existing `[INTL_PHONE_n]` tokens remain valid).
- `national_id` pattern label updated to "Emirates ID" (id unchanged).
- CLI version reported by `--version` bumped to `1.1.0`.
- Package description updated to reflect the sovereign-privacy positioning.
- Package keywords broadened: added `uae`, `pdpl`, `emirates-id`, `arabic`,
  `database-masking`, `postgres`, `mongodb`, `sqlite`, `agentic-ai`, `mcp`,
  `compliance`, `dlp`, plus additional agent keywords.
- `README.md` corrected: pattern count is precisely **34** (previously the
  docs cited "35+"). The `env_secret` meta-pattern additionally covers
  15+ credential naming conventions.

### Security

- All new subsystems (`db/`, `scan-dir`, `agent-guard`, `reporter`,
  `pdpl-mapping`, `i18n`) added **zero** outbound network calls. The
  "nothing leaves your machine" guarantee holds across the entire v1.1
  surface.
- `agent-guard` loopback enforcement is belt-and-braces: binds to
  `127.0.0.1` AND rejects any request whose `remoteAddress` doesn't match
  `127.` / `::1` / `::ffff:127.`.

### Removed

- Nothing (fully backward-compatible).

### Contributors

- Mohamed Atef Fahmy — everything

---

## [1.0.0] — 2026-05

The initial public release.

### Added

- Pattern registry and `maskText()` core engine.
- Format-preserving masking for text, Excel, Word, PowerPoint, PDF (extract).
- Six CLI subcommands: `scan`, `mask`, `audit`, `mask-dir`, `stats`,
  `list-patterns`.
- Auto-installer for 20+ agentic AI platforms
  (Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Windsurf, Cline,
  Continue, Aider, JetBrains Junie, Roo Code, Kilo Code, OpenHands, Warp,
  Replit Agent, Augment Code, and more).
- Three masking modes: `typed` (default), `redact`, `fake`.
- Cumulative session stats.
