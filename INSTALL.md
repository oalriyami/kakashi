# Install Kakashi

One install. Works for every AI coding agent on your machine.

## One-liner

**macOS / Linux / WSL / Git Bash**

```bash
curl -fsSL https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.sh | bash
```

**Windows (PowerShell 5.1+)**

```powershell
irm https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.ps1 | iex
```

A piped script takes no options. To pass some (`--dry-run`, `--only cursor`,
`--uninstall`), run it as a script block:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.ps1))) --dry-run
```

With bash: `curl -fsSL …/install.sh | bash -s -- --dry-run`. `--dry-run` and
`--uninstall` never install the package; an unknown option stops the script
before it does anything.

**npm**

```bash
npm install -g @muhammadatef/kakashi
kakashi install          # the agent rules and slash commands (also: kakashi-install)
```

From a cloned repo:

```bash
git clone https://github.com/Muhammadatef/kakashi.git
cd kakashi
npm install
npm link
kakashi install --all --with-init      # or: node bin/install.js --all --with-init
```

## Upgrade

```bash
kakashi --version                              # what you have now
npm install -g @muhammadatef/kakashi@latest    # get the latest
```

Then re-run the installer so your agents pick up any new commands and rules —
the agent rules are written at install time, so an upgraded binary alone is not
enough:

```bash
kakashi install
```

Re-running the one-liner at the top of this file does both steps and is safe to
repeat. Upgrading is non-destructive: Kakashi only rewrites the block between
its `<!-- kakashi-begin -->` / `<!-- kakashi-end -->` markers (on every run;
`--force` is no longer needed), leaving the rest
of your `CLAUDE.md`, `AGENTS.md` and Cursor rules untouched. No config migration
is needed from 1.0 or 1.1.

## Per-agent install

| Agent | Command | Auto-activates? |
|---|---|:-:|
| **Claude Code** | `kakashi install --only claude` | Yes |
| **Cursor** | `kakashi install --only cursor` | Yes |
| **Codex CLI** | `kakashi install --only codex` | Yes |
| **Windsurf** | `kakashi install --only windsurf --with-init` | With `--with-init` |
| **Cline** | `kakashi install --only cline --with-init` | With `--with-init` |
| **GitHub Copilot** | `kakashi install --only copilot --with-init` | With `--with-init` |
| **Continue** | `kakashi install --only continue` | Yes (full rule in `systemMessage`) |

Install all detected:

```bash
kakashi install --all
```

## Flags

| Flag | What |
|---|---|
| `--all` | Install for every supported agent, detected or not (default: detected ones) |
| `--only <id>` | One agent (repeatable, or a comma-separated list). An unknown id is an error. |
| `--dry-run` | Preview only: nothing is installed or written |
| `--with-init` | Drop repo-level rules in `$PWD` |
| `--uninstall` | Remove Kakashi's rules and commands; scoped by `--only`, and by `--with-init` for repository files |
| `--list` | Agent detection matrix |
| `--force` | Accepted for old scripts; every run refreshes Kakashi's blocks |

Any other option is refused (exit 2).

## Verify

```bash
kakashi install --list
kakashi scan tests/fixtures/sample.txt
```

## Uninstall

```bash
kakashi uninstall                  # every agent
kakashi uninstall --only cursor    # one agent; the others are left alone
kakashi uninstall --with-init      # also the rules written into this repository
npm uninstall -g @muhammadatef/kakashi
```

## Privacy

No telemetry. Installer writes local config files only.
