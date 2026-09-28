#!/usr/bin/env bash
# Kakashi installer for macOS, Linux, WSL and Git Bash.
#
#   curl -fsSL https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dry-run          # show, change nothing
#   curl -fsSL .../install.sh | bash -s -- --only cursor      # one agent
#   curl -fsSL .../install.sh | bash -s -- --uninstall        # remove the agent rules
#
# It installs the npm package globally, then runs its agent installer
# (bin/install.js, also `kakashi install`). Options are those of the installer;
# an unknown one stops here, before anything is installed.
#
# KAKASHI_PACKAGE chooses what npm installs (a version or a tarball path);
# CI uses it to test the package being built.
set -euo pipefail

PACKAGE="${KAKASHI_PACKAGE:-@muhammadatef/kakashi}"
PACKAGE_NAME="@muhammadatef/kakashi"
MIN_NODE=18

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  red "Node.js and npm are required (Node >= ${MIN_NODE}). Install from https://nodejs.org/"
  exit 1
fi
MAJOR="$(node -e "process.stdout.write(process.versions.node.split('.')[0])")"
if [ "$MAJOR" -lt "$MIN_NODE" ]; then
  red "Node.js >= ${MIN_NODE} required (found $(node -v))"
  exit 1
fi

# Check the options first: a mistyped `--dryrun` used to be ignored and the
# install went ahead for real.
DRY_RUN=0
UNINSTALL=0
ARGS=("$@")
i=0
while [ "$i" -lt "${#ARGS[@]}" ]; do
  a="${ARGS[$i]}"
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --all|--with-init|--minimal|--list|--force|--non-interactive|--help|-h) ;;
    --only|--config-dir)
      i=$((i + 1))
      if [ "$i" -ge "${#ARGS[@]}" ]; then red "$a needs a value"; exit 2; fi
      ;;
    *) red "Unknown option: $a (see: --help)"; exit 2 ;;
  esac
  i=$((i + 1))
done

cyan "Kakashi Installer"
echo ""

# Run the agent installer from a copy of the package that is not installed:
# for --dry-run and --uninstall, which must not install anything.
run_from_pack() {
  local tmp rc
  tmp="$(mktemp -d)"
  if ! (cd "$tmp" && npm pack "$PACKAGE" --silent >/dev/null 2>&1); then
    red "Could not download ${PACKAGE} to run the installer."
    rm -rf "$tmp"
    return 1
  fi
  tar xzf "$tmp"/*.tgz -C "$tmp"
  rc=0
  node "$tmp/package/bin/install.js" "$@" || rc=$?
  rm -rf "$tmp"
  return "$rc"
}

# 1. A clone: run its installer (bash install.sh from the repository root).
#    When piped, BASH_SOURCE is unset -- which used to abort the script.
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$(dirname "$SCRIPT_SOURCE")/bin/install.js" ]; then
  node "$(dirname "$SCRIPT_SOURCE")/bin/install.js" "$@"
  exit $?
fi

GLOBAL_INSTALLER="$(npm root -g)/${PACKAGE_NAME}/bin/install.js"

# 2. --dry-run and --uninstall: nothing is installed.
if [ "$DRY_RUN" = 1 ] || [ "$UNINSTALL" = 1 ]; then
  if [ -f "$GLOBAL_INSTALLER" ]; then
    node "$GLOBAL_INSTALLER" "$@"
  else
    run_from_pack "$@"
  fi
  if [ "$UNINSTALL" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    echo "To remove the package too: npm uninstall -g ${PACKAGE_NAME}"
  fi
  exit 0
fi

# 3. Install the package, then the agent rules. Each step's failure stops here.
if ! npm install -g "$PACKAGE" --no-audit --no-fund; then
  red "npm install -g ${PACKAGE} failed. If it is a permissions error, see"
  red "https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  exit 1
fi
green "Installed ${PACKAGE_NAME} $(kakashi --version 2>/dev/null || true)"

if [ ! -f "$GLOBAL_INSTALLER" ]; then
  red "The package installed, but its installer was not found at ${GLOBAL_INSTALLER}."
  exit 1
fi
node "$GLOBAL_INSTALLER" "$@"

green "Installation complete. Try: kakashi scan <file>"
