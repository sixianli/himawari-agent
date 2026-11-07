source "$HERE/runners.sh"

REPO=${HIMAWARI_REPO:-sixianli/himawari-agent}
LABEL=$RUNNER_LABEL
CI_VPS=${CI_VPS_SSH:-ubuntu@158.69.191.249}
REMOTE=${CI_RUNNER_DIR:-/home/ubuntu/ci-runner}
LOCK=${RUNNER_LOCK_DIR:-.ci-output/ci-runner-pause.lock}
POLL=${RUNNER_POLL_SECONDS:-30}
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

take_lock() {
  mkdir -p "${LOCK%/*}" && mkdir "$LOCK" 2> /dev/null || {
    echo "RUNNER_LOCKED another pause or resume is running ($LOCK); wait for it or remove the directory if it died"
    exit 75
  }
  trap 'rmdir "$LOCK" 2> /dev/null' EXIT
}

vps() {
  ssh "${SSH_OPTIONS[@]}" "$CI_VPS" "[ \"\$(hostname)\" = $RUNNER_HOST ] || { echo \"not $RUNNER_HOST\" >&2; exit 68; }; $1"
}

upload_runner_scripts() {
  local name
  vps "mkdir -p $REMOTE" || {
    echo "could not create $REMOTE on $RUNNER_HOST"
    return 1
  }
  for name in runners.sh runner-pause.sh runner-resume.sh; do
    scp -q "${SSH_OPTIONS[@]}" "$HERE/$name" "$CI_VPS:$REMOTE/$name" > /dev/null || {
      echo "upload of $name to $REMOTE failed"
      return 1
    }
  done
}

github_runners() {
  gh api "repos/$REPO/actions/runners" --paginate \
    --jq '.runners[] | [.id, .name, .status, .busy, ([.labels[].name] | join(","))] | @tsv'
}

runner_field() {
  printf '%s\n' "$1" | awk -F'\t' -v name="$2" -v column="$3" '$2 == name { print $column }'
}

has_label() {
  case ",$1," in
    *",$LABEL,"*) return 0 ;;
  esac
  return 1
}

reconcile_runners() {
  local names=$1 table=$2 name id count
  [ -n "$names" ] || { echo "$RUNNER_HOST reports no installed runner"; return 1; }
  for name in $names; do
    count=$(runner_field "$table" "$name" 1 | grep -c .)
    [ "$count" = 1 ] || { echo "GitHub has $count runners named $name, $RUNNER_HOST has one installed"; return 1; }
  done
  while IFS=$'\t' read -r id name _ _ labels; do
    [ -n "$id" ] || continue
    has_label "$labels" || continue
    case " $(echo $names) " in
      *" $name "*) ;;
      *) echo "GitHub runner $name carries $LABEL but is not installed on $RUNNER_HOST"; return 1 ;;
    esac
  done <<< "$table"
}

label_states() {
  local names=$1 table=$2 name count states=""
  for name in $names; do
    count=$(runner_field "$table" "$name" 1 | grep -c .)
    if [ "$count" != 1 ]; then
      states="$states $name=unread"
    elif has_label "$(runner_field "$table" "$name" 5)"; then
      states="$states $name=on"
    else
      states="$states $name=off"
    fi
  done
  echo $states
}

add_label() {
  gh api -X POST "repos/$REPO/actions/runners/$1/labels" -f "labels[]=$LABEL" > /dev/null
}

remove_label() {
  gh api -X DELETE "repos/$REPO/actions/runners/$1/labels/$LABEL" > /dev/null
}

service_states() {
  local states
  states=$(vps "bash $REMOTE/runner-pause.sh --status") || { echo unknown; return; }
  echo $states
}

longest_job_seconds() {
  local minutes
  minutes=$(grep -o '"timeoutMinutes": *[0-9]*' "$HERE/../../../ci/policy.json" | grep -o '[0-9]*$' | sort -n | tail -1)
  [ -n "$minutes" ] || return 1
  echo $((minutes * 60))
}
