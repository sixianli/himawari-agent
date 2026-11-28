#!/bin/bash
set -uo pipefail
umask 077

action="${1:-}"
unit="${HIMAWARI_OPS_UNIT:-himawari-prod.service}"
side_units="${HIMAWARI_OPS_SIDE_UNITS:-magpie.service}"
node_bin="${HIMAWARI_OPS_NODE:-/opt/himawari/node/bin/node}"
database="${HIMAWARI_OPS_DATABASE:-/var/lib/himawari/state/data/product.sqlite}"
config="${HIMAWARI_OPS_CONFIG:-/etc/himawari/config.json}"
public_key="${HIMAWARI_OPS_PUBLIC_KEY:-}"
lock_file="${HIMAWARI_OPS_LOCK:-}"
systemctl_bin="${HIMAWARI_OPS_SYSTEMCTL:-systemctl}"
journalctl_bin="${HIMAWARI_OPS_JOURNALCTL:-journalctl}"
window="${HIMAWARI_OPS_WINDOW:-3 hours ago}"
start_wait="${HIMAWARI_OPS_START_WAIT:-120}"
mirror="${HIMAWARI_OPS_MIRROR:-/var/lib/himawari-deploy/ops-mirror.git}"
instance="${HIMAWARI_OPS_INSTANCE:-andy-production}"

refuse() {
  echo "OPS_REFUSED $1: $2" >&2
  exit "${3:-64}"
}

[[ "$action" == diagnose || "$action" == restart || "$action" == allow-sensitive || "$action" == senses || "$action" == heartbeat-install ]] || refuse ACTION_INVALID "only diagnose, restart, allow-sensitive, senses or heartbeat-install"
[[ -n "$public_key" && -s "$public_key" ]] || refuse KEY_MISSING "HIMAWARI_OPS_PUBLIC_KEY must name the public key that seals the full diagnostics" 70

service_line() {
  echo "OPS_SERVICE $1 $("$systemctl_bin" show "$1" --no-pager -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts -p MainPID -p MemoryCurrent -p TasksCurrent 2>&1 | tr '\n' ' ')"
}

summary() {
  service_line "$unit"
  for side in $side_units; do service_line "$side"; done
  echo "OPS_HOST load=$(cut -d' ' -f1-3 /proc/loadavg) memory_available_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) root_free=$(df -h --output=avail / | tail -1 | tr -d ' ')"
  local errors warnings
  errors="$("$journalctl_bin" -u "$unit" --since "$window" --no-pager -q -p err 2>/dev/null | wc -l)"
  warnings="$("$journalctl_bin" -u "$unit" --since "$window" --no-pager -q -p warning 2>/dev/null | wc -l)"
  echo "OPS_JOURNAL_COUNTS since=\"$window\" err=$errors warning_or_worse=$warnings"
  local events
  events="$("$journalctl_bin" -u "$unit" --since "$window" --no-pager -q -o cat 2>/dev/null | grep -oE '"event":"[a-z_.]+"|"code":"[A-Z0-9_]+"|"reasonCode":"[A-Z0-9_]+"|"lastDrop":"[A-Za-z]+"' | sort | uniq -c | sort -rn | head -40 | awk '{print $2 "=" $1}' | tr '\n' ' ')"
  echo "OPS_JOURNAL_NAMES ${events:-none}"
  if [[ -x "$node_bin" && -f "$database" ]]; then
    (cd /tmp && "$node_bin" --no-warnings - "$database" "$config" <<'JS'
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const all = (sql, ...values) => {
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    return `ERROR ${error.message}`;
  }
};
const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
const terminal = ["completed", "failed", "cancelled"];
console.log(`OPS_RUNS_BY_STATUS ${JSON.stringify(all("SELECT status, count(*) AS n FROM runs GROUP BY status ORDER BY status"))}`);
console.log(`OPS_RUNS_OPEN ${JSON.stringify(all("SELECT id, thread_id, status, created_at, updated_at FROM runs WHERE status NOT IN (?, ?, ?) ORDER BY created_at", ...terminal))}`);
console.log(`OPS_RUNS_RECENT ${JSON.stringify(all("SELECT id, thread_id, status, created_at, updated_at FROM runs WHERE created_at > ? ORDER BY created_at", since))}`);
console.log(`OPS_OWNER_MODEL ${JSON.stringify(all("SELECT model_ref, thinking_level, updated_at FROM owner_preferences"))}`);
console.log(`OPS_MODEL_INVOCATIONS ${JSON.stringify(all("SELECT model_ref, data_classification, source, status, count(*) AS n, max(reserved_at) AS last FROM model_invocation_identities WHERE reserved_at > ? GROUP BY model_ref, data_classification, source, status ORDER BY last", since))}`);
let descriptors;
try {
  descriptors = (JSON.parse(readFileSync(process.argv[3], "utf8")).modelDescriptors ?? []).map(
    ({ ref, role, provider, model, routingClass, allowedDataClassifications }) => ({ ref, role, provider, model, routingClass, allowedDataClassifications }),
  );
} catch (error) {
  descriptors = `ERROR ${error.message}`;
}
console.log(`OPS_MODEL_DESCRIPTORS ${JSON.stringify(descriptors)}`);
let web;
try {
  const policy = JSON.parse(readFileSync(process.argv[3], "utf8")).runPolicy ?? {};
  web = Object.fromEntries(["publicSearch", "publicFetch"].map((key) => [key, policy[key] ? { providers: policy[key].providers ?? null } : null]));
} catch (error) {
  web = `ERROR ${error.message}`;
}
console.log(`OPS_WEB_ROUTES ${JSON.stringify(web)}`);
JS
    ) 2>&1 | cut -c1-6000
  else
    echo "OPS_RUNS unavailable node=$node_bin database=$database"
  fi
}

senses_report() {
  if [[ -x "$node_bin" && -f "$database" ]]; then
    (cd /tmp && "$node_bin" --no-warnings - "$database" <<'JS'
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const all = (sql, ...values) => {
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    return `ERROR ${error.message}`;
  }
};
const since = Date.now() - 6 * 86400 * 1000;
const show = (name, value) => console.log(`${name} ${JSON.stringify(value)}`);
show("SENSES_DEVICES", all("SELECT id, kind, status, last_seen_at FROM paired_devices ORDER BY last_seen_at"));
show("SENSES_SETTINGS", all("SELECT revision, disabled_senses, paused_from, paused_until, limit_overrides, updated_at FROM perception_settings"));
show("SENSES_BY_DAY", all("SELECT local_day, device_id, type, json_extract(evidence, '$.subtype') AS subtype, capture_source, status, count(*) AS n, datetime(max(occurred_at_ms) / 1000, 'unixepoch') AS last_occurred, datetime(max(received_at_ms) / 1000, 'unixepoch') AS last_received FROM perception_records WHERE received_at_ms > ? OR occurred_at_ms > ? GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 3, 4", since, since));
show("SENSES_RECEIVED_BY_HOUR", all("SELECT strftime('%Y-%m-%dT%H', received_at_ms / 1000, 'unixepoch') AS hour, device_id, count(*) AS n FROM perception_records WHERE received_at_ms > ? GROUP BY 1, 2 ORDER BY 1", since));
show("SENSES_LAST_BY_TYPE", all("SELECT device_id, type, json_extract(evidence, '$.subtype') AS subtype, datetime(max(occurred_at_ms) / 1000, 'unixepoch') AS last_occurred, datetime(max(received_at_ms) / 1000, 'unixepoch') AS last_received, count(*) AS n FROM perception_records GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"));
JS
    ) 2>&1 | cut -c1-20000
  else
    echo "SENSES unavailable node=$node_bin database=$database"
  fi
  echo "== perception and device lines in the journal since 2 days ago"
  "$journalctl_bin" -u "$unit" --since "2 days ago" --no-pager -q -o cat 2>/dev/null | grep -E 'perception|device\.|health|mirror|track' | grep -oE '"event":"[a-z_.]+"|"code":"[A-Z0-9_]+"|"path":"[a-z/]+"|"status":[0-9]+' | sort | uniq -c | sort -rn | head -60
}

sealed() {
  local work
  work="$(mktemp -d)"
  {
    if [[ "${1:-}" == senses ]]; then senses_report; fi
    echo "== $unit since $window"
    "$journalctl_bin" -u "$unit" --since "$window" --no-pager -q 2>&1 | tail -4000
    for side in $side_units; do
      echo "== $side since $window"
      "$journalctl_bin" -u "$side" --since "$window" --no-pager -q 2>&1 | tail -400
    done
    echo "== processes"
    ps -eo pid,ppid,etimes,pcpu,pmem,stat,comm --sort=-pcpu 2>&1 | head -40
    echo "== established connections by process"
    ss -tnpH state established 2>&1 | grep -oE 'users:\(\("[^"]+"' | sort | uniq -c | sort -rn | head -20
  } > "$work/plain" 2>&1
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$work/key"
  if openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$work/key" -in "$work/plain" -out "$work/body" \
    && openssl pkeyutl -encrypt -pubin -inkey "$public_key" -pkeyopt rsa_padding_mode:oaep -in "$work/key" -out "$work/key.sealed"; then
    echo "OPS_SEALED_KEY $(base64 -w0 "$work/key.sealed")"
    echo "OPS_SEALED_BEGIN"
    gzip -c "$work/body" | base64 -w 76
    echo "OPS_SEALED_END bytes=$(wc -c < "$work/plain")"
  else
    echo "OPS_SEALED_FAILED openssl could not seal the diagnostics"
  fi
  rm -rf "$work"
}

take_lock() {
  if [[ -n "$lock_file" ]]; then
    exec 9> "$lock_file"
    flock -n 9 || refuse BUSY "a deploy holds $lock_file; not changing the service in the middle of it" 75
  fi
}

restart_service() {
  "$systemctl_bin" restart "$unit" || refuse RESTART_FAILED "systemctl restart $unit failed" 70
  local deadline=$(( SECONDS + start_wait )) state=""
  while (( SECONDS < deadline )); do
    state="$("$systemctl_bin" is-active "$unit" 2>/dev/null || true)"
    [[ "$state" == active ]] && break
    sleep 2
  done
  [[ "$state" == active ]] || { service_line "$unit"; refuse NOT_ACTIVE "$unit is $state after restart" 70; }
  echo "OPS_RESTARTED $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  service_line "$unit"
}

allow_sensitive() {
  [[ -x "$node_bin" ]] || refuse NODE_MISSING "$node_bin" 70
  [[ -f "$config" ]] || refuse CONFIG_MISSING "$config" 70
  local backup="$config.before-allow-sensitive-$(date -u +%Y%m%dT%H%M%SZ)" next="$config.allow-sensitive-next"
  cp -p "$config" "$backup" || refuse BACKUP_FAILED "$backup" 70
  echo "OPS_CONFIG_BACKUP $backup"
  local changed
  changed="$("$node_bin" --no-warnings - "$config" "$next" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [source, target] = process.argv.slice(2);
const configuration = JSON.parse(readFileSync(source, "utf8"));
const changed = [];
for (const descriptor of configuration.modelDescriptors ?? []) {
  const allowed = descriptor.allowedDataClassifications;
  if (!Array.isArray(allowed)) continue;
  if (!allowed.includes("private") || allowed.includes("sensitive")) continue;
  descriptor.allowedDataClassifications = ["public", "private", "sensitive"].filter(
    (value) => value === "sensitive" || allowed.includes(value),
  );
  changed.push(descriptor.ref);
}
if (changed.length > 0) writeFileSync(target, `${JSON.stringify(configuration, null, 2)}\n`);
process.stdout.write(changed.join(" "));
JS
  )" || refuse CONFIG_UNREADABLE "$config" 70
  if [[ -z "$changed" ]]; then
    echo "OPS_CONFIG_UNCHANGED every model already allows sensitive"
    return 1
  fi
  chown --reference="$config" "$next" && chmod --reference="$config" "$next" && mv -f "$next" "$config" || refuse CONFIG_WRITE_FAILED "$config" 70
  echo "OPS_CONFIG_CHANGED allow sensitive for: $changed"
}

if [[ "$action" == restart ]]; then
  take_lock
  echo "OPS_BEFORE_RESTART"
  summary
  sealed
  restart_service
  exit 0
fi

if [[ "$action" == allow-sensitive ]]; then
  take_lock
  if allow_sensitive; then
    restart_service
    summary
  fi
  exit 0
fi

if [[ "$action" == heartbeat-install ]]; then
  heartbeat="$(mktemp -d)"
  trap 'rm -rf "$heartbeat"' EXIT
  git -C "$mirror" archive main scripts/operations/heartbeat "scripts/delivery-mode/instances/$instance.json" 2> /dev/null | tar -x -C "$heartbeat" 2> /dev/null || refuse HEARTBEAT_SCRIPT_MISSING "main in $mirror has no scripts/operations/heartbeat or instance $instance" 70
  HEARTBEAT_SYSTEMCTL="$systemctl_bin" bash "$heartbeat/scripts/operations/heartbeat/install-heartbeat.sh" install --instance "$heartbeat/scripts/delivery-mode/instances/$instance.json" > /dev/null || refuse HEARTBEAT_INSTALL_FAILED "the ping address read from standard input was refused or the units could not be installed; see the HEARTBEAT_ line above" 70
  echo "OPS_HEARTBEAT_INSTALLED timer=$("$systemctl_bin" is-active himawari-heartbeat.timer 2>&1)"
  echo "OPS_DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi

if [[ "$action" == senses ]]; then
  sealed senses
  echo "OPS_DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi

summary
sealed
echo "OPS_DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
