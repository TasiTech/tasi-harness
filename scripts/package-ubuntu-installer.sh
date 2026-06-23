#!/usr/bin/env bash
set -euo pipefail

show_usage() {
  cat <<'EOF'
Usage:
  bash scripts/package-ubuntu-installer.sh
  bash scripts/package-ubuntu-installer.sh --skip-build

Options:
  --skip-build   Skip `npm run build` before packaging.
  --help         Show this help message.
EOF
}

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      show_usage
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The Ubuntu installer script must be run on Linux/Ubuntu." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

ARGS=(scripts/package-installers.mjs --ubuntu-bin)
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  ARGS+=(--skip-build)
fi

node "${ARGS[@]}"
