#!/usr/bin/env bash
# Clones (or updates) the demo site, checks Anynotate and starts the demo server.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: setup.sh [--dry-run] [--no-server] [demo-dir]

  demo-dir      where the demo lives (default: $ANYNOTATE_DEMO_DIR or ~/anynotate-demo)
  --dry-run     print what would happen, change nothing
  --no-server   do not start the demo server
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

command -v git >/dev/null 2>&1 || die "git is required."
command -v bun >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || die "install bun (recommended) or python3 to serve the demo."
command -v bun >/dev/null 2>&1 || warn "bun not found: the demo will be served by python3 without live reload."

if [[ -e "$dir" ]]; then
  require_demo_clone "$dir"
  say "Updating the demo clone in $dir"
  run git -C "$dir" fetch --quiet origin main || warn "could not fetch origin (offline?)."
  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
    warn "the demo has local changes; run scripts/reset.sh to start from a clean page."
  elif [[ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" == main ]]; then
    run git -C "$dir" merge --ff-only --quiet origin/main || warn "could not fast-forward main; run scripts/reset.sh."
  fi
else
  say "Cloning $DEMO_REPO_URL into $dir"
  run git clone --quiet --branch main "$DEMO_REPO_URL" "$dir"
fi
[[ "$DRY_RUN" == 1 && ! -e "$dir" ]] || dir="$(cd "$dir" && pwd -P)"

if command -v anynotate >/dev/null 2>&1; then
  say "Running anynotate doctor"
  anynotate doctor || warn "anynotate doctor reported a problem; fix it before recording."
else
  warn "anynotate is not on PATH; install it first (see https://github.com/genexk/anynotate)."
fi

if [[ "$server" == 1 ]]; then
  if [[ -f "$dir/.serve.pid" ]] && pid_is_demo_server "$(tr -dc '0-9' <"$dir/.serve.pid")" && server_up; then
    say "Demo server already running at $DEMO_URL/."
  elif server_up; then
    warn "something else is answering on $DEMO_URL; stop it or set ANYNOTATE_DEMO_PORT."
  else
    start_server "$dir"
  fi
fi

cat <<EOF

Ready.
  Page:          $DEMO_URL/
  Agent folder:  $dir
  Start agent:   cd "$dir" && claude      (or codex, or a herdr pane in that folder)
  Pre-flight:    $script_dir/check.sh
  Between takes: $script_dir/reset.sh
EOF
