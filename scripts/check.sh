#!/usr/bin/env bash
# Pre-flight before a demo or a recording. Changes nothing.
# Exits 1 when a required check fails; warnings do not fail.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: check.sh [demo-dir]

  demo-dir      the demo clone (default: $ANYNOTATE_DEMO_DIR or ~/anynotate-demo)
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *) dir="$1" ;;
  esac
  shift
done
dir="${dir:-$(default_demo_dir)}"

failed=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; failed=1; }
meh() { printf '  warn  %s\n' "$*"; }

say "Anynotate demo pre-flight"

if command -v git >/dev/null 2>&1; then ok "git"; else bad "git is not installed"; fi

if command -v bun >/dev/null 2>&1; then
  ok "bun (live reload)"
elif command -v python3 >/dev/null 2>&1; then
  meh "bun not found; python3 serves the page without live reload"
else
  bad "neither bun nor python3 is installed"
fi

if command -v jq >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
  ok "jq or python3 (reset can find demo notes)"
else
  meh "neither jq nor python3: reset cannot clean demo notes from the inbox"
fi

if command -v anynotate >/dev/null 2>&1; then
  if anynotate doctor >/dev/null 2>&1; then
    ok "anynotate doctor"
  else
    bad "anynotate doctor reports a problem (run it to see which)"
  fi
else
  bad "anynotate is not on PATH"
fi

if is_demo_clone "$dir"; then
  ok "demo clone at $dir"
  if [[ -z "$(git -C "$dir" status --porcelain)" ]]; then
    ok "demo files are untouched"
  else
    meh "demo files have changes; run reset.sh for a clean start"
  fi
else
  bad "no demo clone at $dir (run setup.sh)"
fi

if server_up; then
  if curl -fsS --max-time 2 "$DEMO_URL/" 2>/dev/null | grep -q "Tomato soup"; then
    ok "page served at $DEMO_URL/"
  else
    bad "$DEMO_URL/ answers but is not the demo page"
  fi
else
  bad "nothing is serving $DEMO_URL/ (run setup.sh)"
fi

pending="$(demo_bundles | wc -l | tr -d ' ')"
if [[ "$pending" == 0 ]]; then
  ok "no old demo notes in the inbox"
else
  meh "$pending old demo bundle(s) in the inbox; reset.sh removes them"
fi

agents=()
for a in claude codex herdr; do
  command -v "$a" >/dev/null 2>&1 && agents+=("$a")
done
if [[ "${#agents[@]}" -gt 0 ]]; then
  ok "agents found: ${agents[*]}"
else
  meh "no claude, codex or herdr on PATH; use the Inbox with any other agent"
fi

say ""
say "Also check by hand: Chrome window 1280x800, bookmarks bar hidden, zoom 100%, no unsent notes in the dock."

if [[ "$failed" == 1 ]]; then
  say "Some required checks failed."
  exit 1
fi
say "Ready to record."
