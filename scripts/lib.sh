# shellcheck shell=bash
# Shared helpers for setup.sh, reset.sh and check.sh. Sourced, not run.
# shellcheck disable=SC2034  # read by the scripts that source this file

DEMO_REPO_URL="${ANYNOTATE_DEMO_REPO:-https://github.com/genexk/anynotate-demo.git}"
DEMO_PORT="${ANYNOTATE_DEMO_PORT:-5173}"
DEMO_URL="http://localhost:${DEMO_PORT}"
DEMO_MARKER=".anynotate-demo"
BUNDLE_ID_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}-[a-z0-9-]+$'
DRY_RUN="${DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

default_demo_dir() {
  printf '%s\n' "${ANYNOTATE_DEMO_DIR:-$HOME/anynotate-demo}"
}

# Same rule as the bridge: a blank or relative ANYNOTATE_HOME is ignored.
anynotate_home() {
  local h="${ANYNOTATE_HOME:-}"
  h="${h#"${h%%[![:space:]]*}"}"
  h="${h%"${h##*[![:space:]]}"}"
  if [[ -n "$h" && "$h" == /* ]]; then
    printf '%s\n' "$h"
  else
    printf '%s\n' "$HOME/.anynotate"
  fi
}

# Succeeds only for the top of a git clone of anynotate-demo: the committed marker file
# says so and the origin remote is named anynotate-demo.
is_demo_clone() {
  local dir="$1" top url marker
  [[ -d "$dir" ]] || return 1
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$(cd "$top" && pwd -P)" == "$(cd "$dir" && pwd -P)" ]] || return 1
  marker="$(git -C "$dir" show "HEAD:${DEMO_MARKER}" 2>/dev/null)" || return 1
  [[ "$marker" == "anynotate-demo" ]] || return 1
  url="$(git -C "$dir" remote get-url origin 2>/dev/null)" || return 1
  [[ "$url" =~ anynotate-demo(\.git)?/?$ ]]
}

require_demo_clone() {
  local dir="$1"
  is_demo_clone "$dir" || die "$dir is not a clone of anynotate-demo (needs the committed $DEMO_MARKER marker and an origin remote ending in anynotate-demo). Nothing was changed."
}

server_up() {
  curl -fsS -o /dev/null --max-time 2 "$DEMO_URL/" 2>/dev/null
}

wait_for_server() {
  local i
  for ((i = 0; i < 50; i++)); do
    server_up && return 0
    sleep 0.2
  done
  return 1
}

pid_is_demo_server() {
  local pid="$1" cmd
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$cmd" == *serve.ts* || "$cmd" == *http.server* ]]
}

stop_server() {
  local dir="$1" pidfile pid i
  pidfile="$dir/.serve.pid"
  if [[ -f "$pidfile" ]]; then
    pid="$(tr -dc '0-9' <"$pidfile")"
    if [[ -n "$pid" ]] && pid_is_demo_server "$pid"; then
      say "Stopping the demo server (pid $pid)."
      run kill "$pid"
      if [[ "$DRY_RUN" != 1 ]]; then
        for ((i = 0; i < 25; i++)); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.2
        done
      fi
    fi
    run rm -f "$pidfile"
  fi
  if [[ "$DRY_RUN" != 1 ]] && server_up; then
    warn "something else is still answering on $DEMO_URL; it was not started by these scripts, so it was left alone."
    return 1
  fi
  return 0
}

start_server() {
  local dir="$1"
  if [[ "$DRY_RUN" == 1 ]]; then
    say "[dry-run] start ./serve in $dir on port $DEMO_PORT (log: .serve.log)"
    return 0
  fi
  (cd "$dir" && PORT="$DEMO_PORT" exec nohup ./serve >.serve.log 2>&1) &
  printf '%s\n' "$!" >"$dir/.serve.pid"
  disown "$!" 2>/dev/null || true
  if wait_for_server; then
    say "Demo server running at $DEMO_URL/ (pid $(cat "$dir/.serve.pid"), log: $dir/.serve.log)."
  else
    warn "the server did not answer on $DEMO_URL; see $dir/.serve.log"
    return 1
  fi
}

bundle_url() {
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.url // empty' "$file" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("url", ""))' "$file" 2>/dev/null
  else
    return 2
  fi
}

is_demo_url() {
  local url="$1"
  [[ "$url" == "$DEMO_URL" || "$url" == "$DEMO_URL"/* || "$url" == "$DEMO_URL"\?* || "$url" == "$DEMO_URL"#* ]]
}

# Prints "<inbox|archive> <id>" for every bundle whose page URL is on the demo server.
# Only real bundle folders directly inside inbox/ or archive/ are considered; links are skipped.
demo_bundles() {
  local home sub root dir id url rc
  home="$(anynotate_home)"
  for sub in inbox archive; do
    root="$home/$sub"
    [[ -d "$root" && ! -L "$root" ]] || continue
    for dir in "$root"/*; do
      [[ -e "$dir" ]] || continue
      id="${dir##*/}"
      [[ "$id" =~ $BUNDLE_ID_RE ]] || continue
      [[ -d "$dir" && ! -L "$dir" && -f "$dir/annotations.json" ]] || continue
      rc=0
      url="$(bundle_url "$dir/annotations.json")" || rc=$?
      if [[ "$rc" == 2 ]]; then
        warn "install jq or python3 to find demo notes in the inbox; skipped."
        return 0
      fi
      is_demo_url "$url" || continue
      printf '%s %s\n' "$sub" "$id"
    done
  done
}

newest_inbox_bundle() {
  local inbox="$1" dir id newest=""
  for dir in "$inbox"/*; do
    id="${dir##*/}"
    [[ "$id" =~ $BUNDLE_ID_RE && -d "$dir" && ! -L "$dir" && -f "$dir/annotations.json" ]] || continue
    [[ -z "$newest" || "$id" > "$newest" ]] && newest="$id"
  done
  printf '%s\n' "$newest"
}

# Repoints inbox/latest and inbox/latest-id when they named a removed bundle.
repoint_latest() {
  local inbox="$1" current="" newest
  shift
  if [[ -f "$inbox/latest-id" ]]; then
    current="$(tr -d '[:space:]' <"$inbox/latest-id")"
  elif [[ -L "$inbox/latest" ]]; then
    current="$(basename "$(readlink "$inbox/latest")")"
  fi
  [[ -n "$current" ]] || return 0
  local removed hit=0
  for removed in "$@"; do
    [[ "$removed" == "$current" ]] && hit=1
  done
  [[ "$hit" == 1 ]] || return 0
  newest="$(newest_inbox_bundle "$inbox")"
  if [[ -n "$newest" ]]; then
    say "Pointing inbox/latest at $newest."
    if [[ "$DRY_RUN" == 1 ]]; then
      run ln -sfn "$newest" "$inbox/latest"
    else
      printf '%s\n' "$newest" >"$inbox/latest-id.tmp-$$"
      mv -f "$inbox/latest-id.tmp-$$" "$inbox/latest-id"
      ln -sfn "$newest" "$inbox/latest"
    fi
  else
    run rm -f "$inbox/latest" "$inbox/latest-id"
  fi
}

remove_demo_bundles() {
  local home sub id dir count=0
  local -a removed=()
  home="$(anynotate_home)"
  while read -r sub id; do
    [[ -n "$id" ]] || continue
    dir="$home/$sub/$id"
    if compgen -G "$dir/status.json.claim-*" >/dev/null; then
      warn "$sub/$id is being delivered right now; left alone. Run reset again in a moment."
      continue
    fi
    say "Removing demo notes $sub/$id"
    run rm -rf -- "$dir"
    [[ "$sub" == inbox ]] && removed+=("$id")
    count=$((count + 1))
  done < <(demo_bundles)
  if [[ "$count" == 0 ]]; then
    say "No notes for $DEMO_URL in $home (inbox or archive)."
  elif [[ "${#removed[@]}" -gt 0 ]]; then
    repoint_latest "$home/inbox" "${removed[@]}"
  fi
}

print_clear_reminder() {
  cat <<EOF

One thing the scripts cannot do: notes you saved but did not send live in the browser.
In Chrome, open Anynotate's Options and click "Clear all unsent notes"
(or delete the notes for $DEMO_URL in the dock).
EOF
}
