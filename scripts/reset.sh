#!/usr/bin/env bash
# Puts the demo back to its starting state between takes:
#   1. stops the demo server,
#   2. git reset --hard origin/main and git clean -fd in the demo clone (and nowhere else),
#   3. starts the server again,
#   4. removes Anynotate bundles whose page URL is on http://localhost:5173 from the inbox and archive.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: reset.sh [--dry-run] [--no-server] [demo-dir]

  demo-dir      the demo clone (default: $ANYNOTATE_DEMO_DIR or ~/anynotate-demo)
  --dry-run     print what would happen; only a git fetch runs
  --no-server   do not stop or start the demo server
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

server=1
dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-server) server=0 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *) dir="$1" ;;
  esac
  shift
done
dir="${dir:-$(default_demo_dir)}"

require_demo_clone "$dir"
dir="$(cd "$dir" && pwd -P)"
say "Demo clone: $dir"
[[ "$DRY_RUN" == 1 ]] && say "Dry run: nothing will be changed (git fetch still runs)."

if [[ "$server" == 1 ]]; then
  stop_server "$dir" || die "free port $DEMO_PORT first, then run reset again."
fi

if ! git -C "$dir" fetch --quiet origin main; then
  warn "could not fetch origin (offline?); resetting to the last fetched origin/main."
fi
git -C "$dir" rev-parse --verify --quiet origin/main >/dev/null || die "origin/main not found in $dir."

if [[ "$DRY_RUN" == 1 ]]; then
  say "Would discard these changes:"
  git -C "$dir" status --short
  git -C "$dir" clean -nd
fi
run git -C "$dir" checkout --quiet main
run git -C "$dir" reset --hard --quiet origin/main
run git -C "$dir" clean -fd --quiet
[[ "$DRY_RUN" == 1 ]] || say "Demo files are back to origin/main ($(git -C "$dir" rev-parse --short origin/main))."

if [[ "$server" == 1 ]]; then
  start_server "$dir"
fi

remove_demo_bundles
print_clear_reminder
