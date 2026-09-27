---
description: Long-running local privacy daemon on loopback -- any MCP-enabled agent can consult /scan or /mask before shipping data
---

Start (or reason about) the Kakashi agent-guard sidecar for `$ARGUMENTS`.

## What agent-guard is

A local HTTP daemon on `127.0.0.1` (loopback only — never a public
interface) with three endpoints an IDE / MCP client can call synchronously:

- `GET  /health` — liveness + counters + which watch mode is active, and
  `tokenFile`, where the API token is
- `POST /scan  { "path": "..." }` — PDPL-enriched summary; no raw values
- `POST /mask  { "path": "..." }` — writes `masked_<name>` next to the file
  (an optional `"output"` must be a new file inside the watched folder)

`/scan` and `/mask` need `Content-Type: application/json` and
`Authorization: Bearer <token>`. The token is minted at start and written to
`~/.kakashi/agent-guard-<port>.token`, readable by the user only. Paths are
relative to the watched folder, and anything outside it — including through a
symlink — is refused with 403. Requests carrying an `Origin` header (web
pages) or a Host other than `127.0.0.1` / `localhost` are refused too.

Plus a passive filesystem watcher that scans anything that changes under the
watched directory and appends a JSONL audit line — useful as a canary a DPO
can review later.

## Steps

1. Parse `$ARGUMENTS` for the directory to watch. If missing, ask.
2. Recommend port `8797` unless the caller specifies otherwise (that keeps
   the local HTTP surface predictable for any agent wiring).
3. Start it in the shell (or tell the caller how to):
   ```
   kakashi agent-guard --watch "$ARGUMENTS" --port 8797 --auto-mask
   ```
   Fall back via `npx -y @muhammadatef/kakashi agent-guard ...`.
4. Explain the loopback contract: 127.0.0.1 only, remote-address hard-check
   inside the server, a per-launch token, paths confined to the watched
   folder, zero outbound sockets. The daemon does not phone home.
5. On Windows, `fs.watch` sometimes fails with `UNKNOWN` on network drives
   (G:), sandboxed paths, or WSL mounts. Kakashi degrades to polling in that
   case — the `/health` endpoint returns `"watchMode":"poll"` so the caller
   knows what happened. Setting `KAKASHI_GUARD_NO_WATCH=1` skips the watcher
   entirely and keeps only the HTTP surface.

## Quick health check the caller can run

```
curl -s http://127.0.0.1:8797/health
```

or PowerShell:

```
Invoke-WebRequest http://127.0.0.1:8797/health -UseBasicParsing
```

Expect `{"ok":true, "watching":"<dir>", "watchMode":"watch|poll|off", "tokenFile":"...", ...}`.

Scanning a file through the API:

```
TOKEN=$(cat ~/.kakashi/agent-guard-8797.token)
curl -s http://127.0.0.1:8797/scan \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"path":"notes/customer.md"}'
```

## Never do

- Never bind to `0.0.0.0` or a routable interface. The daemon refuses
  non-loopback origins with 403; do not try to route around that.
- Never expose the daemon's port through an SSH tunnel or reverse proxy.
  Its threat model is *local*: the trust boundary is the machine.
- Never print the token into the conversation or paste it into a file; read
  it from the token file at the moment you call the API.
- The `/scan` response is intentionally value-free. Do not call `audit`
  from an agent context to "enrich" it.
