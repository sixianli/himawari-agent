#!/usr/bin/env bash

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CB_BIN="${CB_BIN:-codebuddy}"
DEFAULT_MODEL="deepseek-v4.1-flash"
CB_MODEL="${CB_MODEL:-$DEFAULT_MODEL}"
CB_HOME="${CB_HOME:-$HOME/.cache/cb-delegate}"
CB_TIMEOUT="${CB_TIMEOUT:-1800}"
CB_MAX_TURNS="${CB_MAX_TURNS:-60}"
CB_MAX_ROUNDS="${CB_MAX_ROUNDS:-2}"

BASE_ALLOWED=(Read Glob "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git grep:*)" "Bash(ls:*)")
WRITE_TOOLS=(Edit MultiEdit Write)
BASE_DENIED=("Bash(git commit:*)" "Bash(git push:*)" "Bash(git reset:*)" "Bash(git checkout:*)" "Bash(git switch:*)"
             "Bash(git restore:*)" "Bash(git rebase:*)" "Bash(git merge:*)" "Bash(git stash:*)" "Bash(git worktree:*)"
             "Bash(git clean:*)" "Bash(git branch:*)" "Bash(git tag:*)" "Bash(rm:*)" "Bash(sudo:*)" "Bash(curl:*)"
             "Bash(wget:*)" "Bash(ssh:*)" "Bash(scp:*)" "Bash(git grep --no-index:*)" "Bash(git diff --no-index:*)"
             Grep DeferExecuteTool WebFetch WebSearch)
SECRET_PATHS=("~/.ssh/**" "~/.aws/**" "~/.azure/**" "~/.gnupg/**" "~/.config/**" "~/.docker/**" "~/.kube/**"
              "~/.password-store/**" "~/Library/Keychains/**" "~/.codebuddy/**" "~/.claude/**" "~/.codex/**"
              "~/.netrc" "~/.npmrc" "~/.pypirc" "~/.git-credentials")

usage() {
  cat <<'USAGE'
cb-delegate.sh: delegate a scoped coding task to CodeBuddy Code in a detached git worktree.

Usage:
  cb-delegate.sh doctor
  cb-delegate.sh start  <id> <brief.md> [--review] [--allow '<Tool rule>']... [--deny '<Tool rule>']...
  cb-delegate.sh resume <id> <feedback.md>
  cb-delegate.sh status <id>
  cb-delegate.sh check  <id>
  cb-delegate.sh land   <id>
  cb-delegate.sh clean  <id> [--discard]
  cb-delegate.sh list

Requires git, jq and codebuddy.

start and resume exit with the worker's exit code when it is not 0 (124 after a
timeout), and with 3 when the worker exited 0 without returning a result, for
example after hitting CB_MAX_TURNS.

CB_MODEL must be listed in the file CB_ALLOWED_MODELS names, or else in
$CB_HOME/allowed-models.txt (one model id per line, # lines ignored). Without
either file only the default model runs.
USAGE
}

die()  { echo "cb-delegate: error: $*" >&2; exit 1; }
warn() { echo "cb-delegate: warning: $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
valid_json() { [ -s "$1" ] && jq -e 'type == "object"' "$1" >/dev/null 2>&1; }
has_conversation() { [ -f "$1" ] && jq -e 'type == "array"' "$1" >/dev/null 2>&1; }
extract_result() {
  jq -c 'if type == "array" then map(select(type == "object" and .type == "result")) | last else . end
         | select(type == "object")' "$1" >"$2" 2>/dev/null || : >"$2"
}

check_model() {
  local list="${CB_ALLOWED_MODELS:-}"
  if [ -n "$list" ] && [ ! -f "$list" ]; then
    echo "MODEL_LIST_MISSING: CB_ALLOWED_MODELS names $list, which does not exist" >&2; exit 2
  fi
  [ -n "$list" ] || [ ! -f "$CB_HOME/allowed-models.txt" ] || list="$CB_HOME/allowed-models.txt"
  if [ -n "$list" ]; then
    awk -v m="$CB_MODEL" '{ sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") } $0 == m { found = 1 } END { exit !found }' "$list" \
      && return 0
    echo "MODEL_NOT_ALLOWED: $CB_MODEL is not listed in $list" >&2; exit 2
  fi
  [ "$CB_MODEL" = "$DEFAULT_MODEL" ] && return 0
  echo "MODEL_NOT_ALLOWED: $CB_MODEL is not the default model $DEFAULT_MODEL; list it in $CB_HOME/allowed-models.txt or CB_ALLOWED_MODELS only after confirming it is free" >&2
  exit 2
}

repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "not inside a git repository"; }

abs_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s/%s' "$PWD" "$1" ;;
  esac
}

repo_key() {
  local root="$1" h
  h="$(printf '%s' "$root" | (shasum 2>/dev/null || sha1sum) | cut -c1-8)"
  printf '%s-%s' "$(basename "$root")" "$h"
}

main_root() {
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || die "not inside a git repository"
  common="$(cd "$common" && pwd -P)"
  if [ "$(basename "$common")" = ".git" ]; then
    git -C "$(dirname "$common")" rev-parse --show-toplevel
  else
    printf '%s' "$common"
  fi
}

valid_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{0,40}$ ]] || die "invalid task id '$1' (use [a-z0-9._-], max 41 chars)"; }

state_dir() { printf '%s/%s/%s' "$CB_HOME" "$(repo_key "$(main_root)")" "$1"; }

task_mode() {
  local m=""
  [ -f "$1/mode" ] && m="$(cat "$1/mode")"
  if [ "$m" = review ]; then printf 'review'; else printf 'change'; fi
}

run_with_timeout() {
  local secs="$1" in="$2"; shift 2
  local impl="${CB_TIMEOUT_IMPL:-auto}"
  if [ "$impl" = auto ] && command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=30 "$secs" "$@" <"$in"; return $?
  fi
  if [ "$impl" = auto ] && command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=30 "$secs" "$@" <"$in"; return $?
  fi
  set -m
  "$@" <"$in" &
  local pid=$!
  set +m
  ( sleep "$secs"; kill -TERM -- "-$pid" 2>/dev/null; sleep 30; kill -KILL -- "-$pid" 2>/dev/null ) &
  local watchdog=$! rc=0
  wait "$pid" || rc=$?
  pkill -P "$watchdog" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then rc=124; fi
  return "$rc"
}

ledger() {
  mkdir -p "$CB_HOME"
  printf '%s\n' "$1" >>"$CB_HOME/ledger.jsonl"
}

run_worker() {
  local sd="$1" round="$2" prompt="$3" session="${4:-}"
  local raw="$sd/run-$round.out" out="$sd/run-$round.json" err="$sd/run-$round.err"
  local -a allowed denied args
  local rule mode schema rules missing m
  mode="$(task_mode "$sd")"
  schema="$SKILL_DIR/templates/report.schema.json"
  rules="$SKILL_DIR/templates/worker-rules.md"
  if [ "$mode" = review ]; then
    schema="$SKILL_DIR/templates/review.schema.json"
    rules="$SKILL_DIR/templates/review-rules.md"
  fi
  while IFS= read -r rule; do [ -n "$rule" ] && allowed+=("$rule"); done <"$sd/allowed"
  denied=("${BASE_DENIED[@]}")
  for rule in "${SECRET_PATHS[@]}"; do denied+=("Read($rule)"); done
  while IFS= read -r rule; do [ -n "$rule" ] && denied+=("$rule"); done <"$sd/denied"
  args=(-p
        --output-format json
        --json-schema "$(cat "$schema")"
        --model "$CB_MODEL"
        --permission-mode dontAsk
        --allowedTools "${allowed[@]}"
        --disallowedTools "${denied[@]}"
        --max-turns "$CB_MAX_TURNS"
        --append-system-prompt "$(cat "$rules")")
  if [ -n "$session" ]; then args+=(--resume "$session"); fi

  local started rc=0
  started="$(date +%s)"
  (
    cd "$sd/wt"
    export CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1 CODEBUDDY_CODE_DISABLE_AUTO_MEMORY=1 CODEBUDDY_DISABLE_AUTO_MEMORY=1
    run_with_timeout "$CB_TIMEOUT" "$prompt" "$CB_BIN" "${args[@]}"
  ) >"$raw" 2>"$err" || rc=$?
  local secs=$(( $(date +%s) - started ))
  extract_result "$raw" "$out"

  local sid=""
  if valid_json "$out"; then
    sid="$(jq -r '.session_id // empty' "$out")"
  fi
  if [ -n "$sid" ]; then printf '%s' "$sid" >"$sd/session_id"; fi
  printf '%s' "$round" >"$sd/round"
  printf '%s' "$rc" >"$sd/last_rc"
  printf 'ran' >"$sd/status"

  local cost=null
  if valid_json "$out"; then
    cost="$(jq -c '.total_cost_usd // null' "$out")"
  fi
  local auto=false
  [ -f "$sd/rerun-$round.md" ] && auto=true
  ledger "$(jq -cn --arg id "$(basename "$sd")" --arg repo "$(basename "$(dirname "$sd")")" \
    --arg model "$CB_MODEL" --argjson round "$round" --argjson rc "$rc" --argjson secs "$secs" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson cost "$cost" --arg mode "$mode" --argjson auto "$auto" \
    '{ts:$ts,event:"run",repo:$repo,id:$id,model:$model,mode:$mode,round:$round,exit_code:$rc,seconds:$secs,cost_usd:$cost,auto:$auto}')"

  report "$sd"
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  valid_json "$out" || return 3
  if [ "$mode" = change ] && has_conversation "$raw" && [ -n "$sid" ] && [ ! -f "$sd/rerun-$round.md" ]; then
    missing="$(missing_acceptance "$sd" "$round")"
    if [ -n "$missing" ]; then
      local next="$((round + 1))"
      {
        printf 'In the last round you did not run these acceptance commands from the brief exactly as written:\n'
        while IFS= read -r m; do if [ -n "$m" ]; then printf -- '- %s\n' "$m"; fi; done <<<"$missing"
        printf '\n'
        printf 'Run each of them now, exactly as written, each as its own Bash call from your working directory: no `cd`, no `2>&1` or other redirection, no pipes, no `&&` or `;`. Permission rules match the whole command from its first word, so a rewritten command is denied; such a denial means only that the rewritten form is not allowed, and the Bash tool still works. Then return your report again, based on these runs.\n'
      } >"$sd/rerun-$next.md"
      echo "-- automatic rerun: acceptance commands were not run exactly as written; resuming the same session once (round $next)"
      run_worker "$sd" "$next" "$sd/rerun-$next.md" "$sid"
      return $?
    fi
  fi
  return 0
}

tool_calls() {
  local raw="$1" wt="$2" wtr="$3" mode="$4"
  jq -e 'type == "array"' "$raw" >/dev/null 2>&1 || return 0
  jq -r --arg wt "$wt" --arg wtr "$wtr" --arg mode "$mode" '
    def inside($root): . == $root or startswith($root + "/");
    def outside: startswith("~") or test("(^|/)[.][.](/|$)")
                 or (startswith("/") and (inside($wt) | not) and (inside($wtr) | not));
    (map(select(type == "object" and .type == "function_call_result") | {(.callId // ""): .status}) | add // {}) as $status
    | .[] | select(type == "object" and .type == "function_call")
    | (.arguments | if type == "string" then (fromjson? // {}) else (. // {}) end) as $a
    | (if $status[.callId // ""] == "completed" then "ok      " else "failed  " end) as $label
    | if $mode == "shell" then
        select(.name == "Bash") | $label + (($a.command // "") | gsub("\n"; " ") | .[0:200])
      else
        (if (.name | IN("Read", "Write", "Edit", "MultiEdit", "NotebookEdit")) then $a.file_path
         elif (.name | IN("Glob", "Grep", "LS")) then ($a.path // $a.pattern)
         else null end) as $path
        | select(($path | type) == "string" and ($path | outside))
        | $label + .name + " " + $path
      end' "$raw"
}

acceptance_commands() {
  awk '
    /^## /{ f = ($0 ~ /^## +[Aa]cceptance/); next }
    f && /^[-*] +/ {
      line = $0
      sub(/^[-*] +/, "", line)
      if (line ~ /^`.*`$/) { sub(/^`/, "", line); sub(/`$/, "", line) }
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line != "") print line
    }
  ' "$1/brief.md"
}

missing_acceptance() {
  local sd="$1" round="$2" raw="$sd/run-$round.out" prev="$sd/run-$((round - 1)).out"
  local prev_ids=""
  if has_conversation "$prev"; then
    prev_ids="$(jq -r '.[] | select(type == "object") | .callId // empty' "$prev" 2>/dev/null)"
  fi
  local this_cmds=""
  if has_conversation "$raw"; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      local cid="${line%%$'\t'*}" cmd="${line#*$'\t'}"
      if [ -n "$prev_ids" ] && [ -n "$cid" ] && printf '%s\n' "$prev_ids" | grep -qxF "$cid"; then
        continue
      fi
      this_cmds="$this_cmds$cmd"$'\n'
    done < <(jq -r '.[] | select(type == "object" and .type == "function_call" and .name == "Bash") | (.callId // "") + "\t" + (((.arguments | if type == "string" then (fromjson? // {}) else (. // {}) end).command // "") | gsub("\n"; " "))' "$raw" 2>/dev/null)
  fi
  acceptance_commands "$sd" | while IFS= read -r acmd; do
    [ -n "$acmd" ] || continue
    local found=0
    while IFS= read -r c; do
      c="$(printf '%s' "$c" | awk '{ sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") } 1')"
      if [ "$c" = "$acmd" ]; then found=1; break; fi
    done <<<"$this_cmds"
    if [ "$found" -eq 0 ]; then printf '%s\n' "$acmd"; fi
  done
}

report() {
  local sd="$1" round rc out wt raw err wtr m
  round="$(cat "$sd/round" 2>/dev/null || echo 0)"
  rc="$(cat "$sd/last_rc" 2>/dev/null || echo '?')"
  out="$sd/run-$round.json"; wt="$sd/wt"
  raw="$sd/run-$round.out"; err="$sd/run-$round.err"; wtr="$wt"

  if [ "$(task_mode "$sd")" = review ]; then
    echo "== cb-delegate report: $(basename "$sd") (review task, round $round, exit $rc) =="
  elif [ -f "$sd/rerun-$round.md" ]; then
    echo "== cb-delegate report: $(basename "$sd") (round $round, automatic rerun, exit $rc) =="
  else
    echo "== cb-delegate report: $(basename "$sd") (round $round, exit $rc) =="
  fi
  [ "$rc" = 124 ] && echo "!! worker TIMED OUT after ${CB_TIMEOUT}s"
  if ! has_conversation "$raw"; then
    local last="none"
    if [ -f "$err" ]; then
      last="$(awk 'NF { l = $0 } END { if (l != "") print l }' "$err")"
      [ -n "$last" ] || last="none"
    fi
    echo "!! tool-call and command records are missing: the worker's output holds no conversation, so the files it read and the commands it ran are unknown (last stderr line: $last)"
  fi
  if [ "$(task_mode "$sd")" = change ] && has_conversation "$raw"; then
    while IFS= read -r m; do
      if [ -n "$m" ]; then echo "!! acceptance command not run exactly as written in this round: $m"; fi
    done < <(missing_acceptance "$sd" "$round")
  fi
  if valid_json "$out"; then
    jq '{
      session_id: (.session_id // null),
      cost_usd:   (.total_cost_usd // null),
      num_turns:  (.num_turns // null),
      is_error:   (if has("is_error") then .is_error else null end),
      report:     (.structured_output // null),
      result_excerpt: (if .structured_output == null then ((.result // "") | tostring | .[0:1500]) else null end)
    }' "$out"
  else
    echo "-- worker produced no valid JSON. stderr tail:"
    tail -n 25 "$sd/run-$round.err" 2>/dev/null || true
  fi
  [ -d "$wt" ] && wtr="$(cd "$wt" && pwd -P)"
  if has_conversation "$raw"; then
    echo "-- tool calls outside the worktree:"
    tool_calls "$raw" "$wt" "$wtr" outside
    echo "-- shell commands:"
    tool_calls "$raw" "$wt" "$wtr" shell | head -n 40
  fi
  if [ -d "$wt" ]; then
    echo "-- worktree changes (git status, incl. untracked):"
    git -C "$wt" status --porcelain=v1 -uall | head -n 60
    echo "-- diff stat vs base:"
    git -C "$wt" diff --stat "$(cat "$sd/base")" | tail -n 30
  fi
  echo "-- worktree: $wt"
}

cmd_doctor() {
  need git; need jq
  command -v "$CB_BIN" >/dev/null 2>&1 || die "'$CB_BIN' not found. Install: npm install -g @tencent-ai/codebuddy-code, then run 'codebuddy' once interactively to log in."
  check_model
  echo "codebuddy: $(command -v "$CB_BIN")  version: $("$CB_BIN" --version 2>/dev/null | head -n1)"
  echo "model:     $CB_MODEL   (override with CB_MODEL)"
  echo "timeout:   $( (command -v gtimeout || command -v timeout) 2>/dev/null || echo 'builtin watchdog')"
  echo "-- model ids mentioned in 'codebuddy --help':"
  "$CB_BIN" --help 2>&1 | grep -ioE '(deepseek|hy3|glm|kimi|minimax|step)[a-z0-9._-]*' | sort -u | tr '\n' ' ' || true
  echo
  local tmp="$CB_HOME/doctor"
  rm -rf "$tmp"; mkdir -p "$tmp"
  printf 'Reply with status "done", summary "pong", and empty arrays. Do not use any tools.\n' >"$tmp/prompt"
  echo "-- smoke test (1 turn, structured output) ..."
  local rc=0
  ( cd "$tmp" && export CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1 CODEBUDDY_CODE_DISABLE_AUTO_MEMORY=1 CODEBUDDY_DISABLE_AUTO_MEMORY=1 \
      && run_with_timeout 180 "$tmp/prompt" \
      "$CB_BIN" -p --output-format json --model "$CB_MODEL" --permission-mode dontAsk --max-turns 2 \
      --json-schema "$(cat "$SKILL_DIR/templates/report.schema.json")" ) >"$tmp/raw" 2>"$tmp/err" || rc=$?
  extract_result "$tmp/raw" "$tmp/out.json"
  echo "exit: $rc"
  if valid_json "$tmp/out.json"; then
    echo "result keys: $(jq -c 'keys' "$tmp/out.json")"
    jq '{model: (.model // .modelId // null), session_id, total_cost_usd, usage, structured_output}' "$tmp/out.json"
  else
    echo "no JSON output. stderr:"; tail -n 20 "$tmp/err"
  fi
  echo "raw output: $tmp/raw"
  echo
  echo "NEXT: compare the credit balance of the account codebuddy is logged in to, before/after this smoke test."
  echo "      If credits dropped, the model is not free for this account — set CB_MODEL or stop."
}

cmd_start() {
  [ $# -ge 2 ] || die "usage: start <id> <brief.md> [--review] [--allow '<rule>']..."
  local id="$1" brief="$2"; shift 2
  valid_id "$id"; need git; need jq
  command -v "$CB_BIN" >/dev/null 2>&1 || die "'$CB_BIN' not found (run doctor)"
  [ -f "$brief" ] || die "brief not found: $brief (looked for $(abs_path "$brief"))"
  check_model

  local extra="" extra_deny="" mode=change
  while [ $# -gt 0 ]; do
    case "$1" in
      --review) mode=review; shift ;;
      --allow) [ $# -ge 2 ] || die "--allow needs a value"; extra="$extra$2"$'\n'; shift 2 ;;
      --deny)  [ $# -ge 2 ] || die "--deny needs a value"; extra_deny="$extra_deny$2"$'\n'; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  if [ "$mode" = review ]; then
    if grep -qiE '^## +Allowed paths' "$brief"; then
      warn "review task: the brief's '## Allowed paths' section is ignored; the worker gets no write tools"
    fi
  else
    grep -qiE '^## +Allowed paths' "$brief" || die "brief has no '## Allowed paths' section"
  fi

  local root sd base
  root="$(repo_root)"; sd="$(state_dir "$id")"
  [ -e "$sd" ] && die "task '$id' already exists at $sd (use resume/status/clean)"
  base="$(git -C "$root" rev-parse HEAD)"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    warn "main worktree has uncommitted changes; the worker starts from HEAD ${base:0:10} and will NOT see them"
  fi

  mkdir -p "$sd"
  cp "$brief" "$sd/brief.md"
  printf '%s' "$root" >"$sd/root"
  printf '%s' "$base" >"$sd/base"
  printf '%s' "$CB_MODEL" >"$sd/model"
  printf '%s' "$mode" >"$sd/mode"
  git -C "$root" worktree add --detach -q "$sd/wt" "$base"
  local wt_real tool; wt_real="$(cd "$sd/wt" && pwd -P)"
  {
    printf '%s\n' "${BASE_ALLOWED[@]}"
    if [ "$mode" = change ]; then
      for tool in "${WRITE_TOOLS[@]}"; do printf '%s(%s/**)\n' "$tool" "$wt_real"; done
    fi
    printf '%s' "$extra"
  } >"$sd/allowed"
  printf '%s' "$extra_deny" >"$sd/denied"
  if [ "$mode" = review ]; then
    printf '%s\n' Edit MultiEdit Write NotebookEdit >>"$sd/denied"
  fi

  check_references "$sd/wt" "$sd/brief.md"
  run_worker "$sd" 0 "$sd/brief.md"
}

cmd_resume() {
  [ $# -eq 2 ] || die "usage: resume <id> <feedback.md> (no other options: the allow, deny and review settings from start are reused)"
  local id="$1" fb="$2" sd round sid
  valid_id "$id"; sd="$(state_dir "$id")"
  [ -d "$sd/wt" ] || die "no active task '$id'"
  [ -f "$fb" ] || die "feedback file not found: $fb (looked for $(abs_path "$fb"))"
  check_model
  sid="$(cat "$sd/session_id" 2>/dev/null || true)"
  [ -n "$sid" ] || die "no session_id recorded for '$id'; start a fresh task instead"
  round="$(cat "$sd/round")"
  local n=0
  for f in "$sd"/rerun-*.md; do [ -f "$f" ] && n=$((n + 1)); done
  [ "$((round - n))" -lt "$CB_MAX_ROUNDS" ] || die "resume limit reached ($CB_MAX_ROUNDS). Take the task back or discard it."
  round=$((round + 1))
  cp "$fb" "$sd/feedback-$round.md"
  run_worker "$sd" "$round" "$sd/feedback-$round.md" "$sid"
}

cmd_status() {
  [ $# -eq 1 ] || die "usage: status <id>"
  valid_id "$1"; local sd; sd="$(state_dir "$1")"
  [ -d "$sd" ] || die "no task '$1'"
  echo "state: $(cat "$sd/status" 2>/dev/null)"
  report "$sd"
}

allowed_globs() {
  awk '
    /^## /{ f = ($0 ~ /^## +[Aa]llowed paths/) ; next }
    f && /^[-*] +/ { sub(/^[-*] +/, ""); gsub(/`/, ""); sub(/[ \t]+#.*$/, ""); sub(/[ \t]+$/, ""); if ($0 != "") print }
  ' "$1"
}

reference_paths() {
  awk '
    /^## /{ f = ($0 ~ /^## +[Rr]eferences/) ; next }
    f && /^[-*] +/ { sub(/^[-*] +/, ""); gsub(/`/, ""); sub(/[ \t]+$/, ""); if ($0 != "") print }
  ' "$1"
}

check_references() {
  local wt="$1" brief="$2" line word
  while IFS= read -r line; do
    word="${line%%[[:space:]]*}"
    case "$word" in
      *:[0-9]*-[0-9]*|*:[0-9]*) word="${word%:*}" ;;
    esac
    case "$word" in
      /*|~*|'<'*|'$'*|*://*|*\**) continue ;;
    esac
    case "$word" in
      */*|*.*) ;;
      *) continue ;;
    esac
    [ -e "$wt/$word" ] || warn "References path '$word' is not in the worker's worktree (uncommitted or ignored by git); list it by absolute path"
  done < <(reference_paths "$brief")
}

changed_paths() {
  local wt="$1" rec xy
  git -C "$wt" status --porcelain=v1 -z -uall | {
    while IFS= read -r -d '' rec; do
      xy="${rec:0:2}"; printf '%s\n' "${rec:3}"
      case "$xy" in R*|C*) IFS= read -r -d '' rec; printf '%s\n' "$rec" ;; esac
    done
  }
}

cmd_check() {
  [ $# -eq 1 ] || die "usage: check <id>"
  valid_id "$1"; local sd; sd="$(state_dir "$1")"
  [ -d "$sd/wt" ] || die "no active task '$1'"
  local wt="$sd/wt" base fail=0 n=0 p g ok mode
  base="$(cat "$sd/base")"; mode="$(task_mode "$sd")"

  if [ "$(git -C "$wt" rev-parse HEAD)" != "$base" ]; then
    echo "FAIL  worker moved HEAD (created commits or checked out something)"; fail=1
  fi

  if [ "$mode" = review ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      echo "OUT   $p"; fail=1
    done < <(changed_paths "$wt")
    if [ "$fail" -eq 0 ]; then echo "SCOPE PASS (review task, no changes)"; else echo "SCOPE FAIL"; fi
    return "$fail"
  fi

  local globs; globs="$(allowed_globs "$sd/brief.md")"
  [ -n "$globs" ] || { echo "FAIL  brief lists no allowed paths"; return 1; }

  while IFS= read -r p; do
    [ -n "$p" ] || continue
    n=$((n + 1)); ok=0
    while IFS= read -r g; do
      if [[ "$p" == $g ]]; then ok=1; break; fi
    done <<<"$globs"
    if [ "$ok" -eq 1 ]; then echo "ok    $p"; else echo "OUT   $p"; fail=1; fi
  done < <(changed_paths "$wt")

  [ "$n" -gt 0 ] || { echo "FAIL  no changes in worktree"; fail=1; }
  if [ "$fail" -eq 0 ]; then echo "SCOPE PASS ($n paths)"; else echo "SCOPE FAIL"; fi
  return "$fail"
}

cmd_land() {
  [ $# -eq 1 ] || die "usage: land <id>"
  valid_id "$1"; local sd; sd="$(state_dir "$1")"
  if [ "$(task_mode "$sd")" = review ]; then
    die "task '$1' is a review task and has nothing to land; read its report with 'status $1', then remove it with 'clean $1'"
  fi
  [ -d "$sd/wt" ] || die "no active task '$1'"
  local root; root="$(cat "$sd/root")"
  [ -d "$root" ] || die "the worktree task '$1' was started from no longer exists: $root; land applies the changes there. Take them from $sd/wt by hand, or discard the task with 'clean $1 --discard'"
  cmd_check "$1" >/dev/null || die "scope check fails; run 'check $1' and resolve before landing"
  local wt="$sd/wt" base patch
  base="$(cat "$sd/base")"; patch="$sd/changes.patch"

  git -C "$wt" add -A
  git -C "$wt" diff --cached --binary "$base" >"$patch"
  git -C "$wt" reset -q

  [ "$(git -C "$root" rev-parse HEAD)" = "$base" ] || warn "main HEAD moved since delegation (base ${base:0:10}); applying anyway"
  git -C "$root" apply --check "$patch" 2>"$sd/apply.err" || {
    cat "$sd/apply.err" >&2
    die "patch does not apply cleanly to the main worktree; patch kept at $patch"
  }
  git -C "$root" apply "$patch"
  printf 'landed' >"$sd/status"
  ledger "$(jq -cn --arg id "$1" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson rounds "$(cat "$sd/round")" '{ts:$ts,event:"landed",id:$id,rounds:$rounds}')"
  echo "landed into $root (UNSTAGED). Files:"
  git -C "$root" apply --numstat "$patch"
}

cmd_clean() {
  [ $# -ge 1 ] || die "usage: clean <id> [--discard]"
  valid_id "$1"; local sd st mode; sd="$(state_dir "$1")"
  [ -d "$sd" ] || die "no task '$1'"
  st="$(cat "$sd/status" 2>/dev/null || echo unknown)"
  mode="$(task_mode "$sd")"
  if [ "$mode" != review ] && [ "$st" != landed ] && [ "${2:-}" != --discard ]; then
    die "task '$1' is '$st', not landed. Use 'clean $1 --discard' to throw the worker's changes away."
  fi
  if [ -d "$sd/wt" ]; then
    git worktree remove --force "$sd/wt"
  fi
  if [ "$mode" = review ] || [ "$st" = landed ]; then
    printf 'cleaned' >"$sd/status"
  else
    printf 'discarded' >"$sd/status"
    ledger "$(jq -cn --arg id "$1" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson rounds "$(cat "$sd/round" 2>/dev/null || echo 0)" '{ts:$ts,event:"discarded",id:$id,rounds:$rounds}')"
  fi
  echo "worktree removed; logs kept in $sd"
}

cmd_list() {
  local base; base="$CB_HOME/$(repo_key "$(main_root)")"
  [ -d "$base" ] || { echo "(no tasks for this repo)"; return 0; }
  local d
  for d in "$base"/*/; do
    [ -d "$d" ] || continue
    printf '%-28s %-10s round=%s\n' "$(basename "$d")" "$(cat "$d/status" 2>/dev/null)" "$(cat "$d/round" 2>/dev/null || echo -)"
  done
}

main() {
  [ $# -ge 1 ] || { usage; exit 2; }
  local cmd="$1"; shift
  case "$cmd" in
    doctor) cmd_doctor "$@" ;;
    start)  cmd_start "$@" ;;
    resume) cmd_resume "$@" ;;
    status) cmd_status "$@" ;;
    check)  cmd_check "$@" ;;
    land)   cmd_land "$@" ;;
    clean)  cmd_clean "$@" ;;
    list)   cmd_list "$@" ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
