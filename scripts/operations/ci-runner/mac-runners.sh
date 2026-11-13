source "$HERE/runners.sh"

REPO=${HIMAWARI_REPO:-sixianli/himawari-agent}
CI_VPS=${CI_VPS_SSH:-ubuntu@158.69.191.249}
REMOTE=${CI_RUNNER_DIR:-/home/ubuntu/ci-runner}
LOCK=${RUNNER_LOCK_DIR:-.ci-output/ci-runner-pause.lock}
SITE_EXPORT=""
if [ "$RUNNER_SITE" = arm ]; then
  CI_VPS=${CI_ARM_SSH:-ubuntu@138.2.31.252}
  LOCK=${RUNNER_LOCK_DIR:-.ci-output/ci-runner-pause-arm.lock}
  SITE_EXPORT="export RUNNER_SITE=arm; "
fi
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
  ssh "${SSH_OPTIONS[@]}" "$CI_VPS" "$SITE_EXPORT$(runner_host_test) || { echo \"not $RUNNER_HOST\" >&2; exit 68; }; $1"
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
    *",$2,"*) return 0 ;;
  esac
  return 1
}

managed_labels_on() {
  local label found=""
  for label in $RUNNER_LABELS; do
    has_label "$1" "$label" && found="$found $label"
  done
  echo $found
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
    [ -n "$(managed_labels_on "$labels")" ] || continue
    case " $(echo $names) " in
      *" $name "*) ;;
      *) echo "GitHub runner $name carries $(managed_labels_on "$labels") but is not installed on $RUNNER_HOST"; return 1 ;;
    esac
  done <<< "$table"
}

own_label() {
  runner_label_for_name "$1" || { echo "no label is defined for runner $1" >&2; return 1; }
}

label_states() {
  local names=$1 table=$2 name count labels own fallback states=""
  fallback=""
  if [ "$RUNNER_SITE" = vps ]; then
    runner_select 1
    fallback=$RUNNER_NAME
  fi
  for name in $names; do
    count=$(runner_field "$table" "$name" 1 | grep -c .)
    labels=$(runner_field "$table" "$name" 5)
    own=$(own_label "$name" 2> /dev/null)
    if [ "$count" != 1 ] || [ -z "$own" ]; then
      states="$states $name=unread"
    elif [ "$(managed_labels_on "$labels")" = "$own" ]; then
      states="$states $name=on"
    elif [ -z "$(managed_labels_on "$labels")" ]; then
      states="$states $name=off"
    elif [ "$name" = "$fallback" ] && [ "$(managed_labels_on "$labels")" = "$RUNNER_CHECK_LABEL $RUNNER_GATE_LABEL" ]; then
      states="$states $name=extra"
    elif has_label "$labels" "$own"; then
      states="$states $name=mixed"
    else
      states="$states $name=foreign"
    fi
  done
  echo $states
}

add_label() {
  gh api -X POST "repos/$REPO/actions/runners/$1/labels" -f "labels[]=$2" > /dev/null
}

remove_label() {
  gh api -X DELETE "repos/$REPO/actions/runners/$1/labels/$2" > /dev/null
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
