#!/usr/bin/env bash
set -euo pipefail

show_usage() {
  cat <<'EOF'
Usage:
  bash scripts/package-macos-installer.sh
  bash scripts/package-macos-installer.sh --skip-build

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

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The macOS installer script must be run on macOS." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$REPO_ROOT/release"

cd "$REPO_ROOT"

chmod +x "$REPO_ROOT/build/cli/mac/tasi" "$REPO_ROOT/build/cli/mac/tasi-harness"

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  echo
  echo "==> Building app"
  npm run build
fi

echo
echo "==> Clearing release directory before packaging"
rm -rf "$RELEASE_DIR"

echo
echo "==> Packaging macOS DMG installer"
npm exec electron-builder -- --publish never --mac dmg

echo
echo "Packaging completed."
echo "Artifacts directory: $RELEASE_DIR"
if [[ -d "$RELEASE_DIR" ]]; then
  echo "Top-level release entries:"
  ls -1 "$RELEASE_DIR" | sed 's/^/- /'
fi
