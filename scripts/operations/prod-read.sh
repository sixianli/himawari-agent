#!/bin/bash
set -euo pipefail

PROD_TARGET="root@84.247.157.41"
PROD_UNIT="himawari-prod.service"
PROD_NODE="/opt/himawari/node/bin/node"
PROD_DATABASE="/var/lib/himawari/state/data/product.sqlite"
PROD_CONFIGURATION="/etc/himawari/config.json"
PROD_SERVICE_UID="999"

usage() {
  cat >&2 <<'TEXT'
usage: prod-read.sh <query>
  status                      systemctl show of the production service
  journal <pattern> [lines]   service journal lines containing <pattern> (lines 1-200, default 40)
  mounts                      findmnt of the production host
  disk                        df -h of the production host
  runs-summary                number of runs per status
  runs-open                   runs whose status is not completed, failed or cancelled
  run <run-id>                the runs row of one run
  tables                      table names of the product database
  columns <table>            column names of one table
  rows <table> <run-id>       rows of one table whose run_id or id column equals <run-id>
  rule-memories               metadata (no text) of the rule-category memories, all statuses, newest 500
  gmail-decisions             metadata (no text) of the newest 100 Gmail decision records: outcome, rating, rule and memory counts, paired Muse entries
  capabilities                metadata (no declaration body) of the registered capabilities, first 200 by id, with the count of all handles (any status)
  system-instruction          the runPolicy.systemInstruction text of the production configuration
TEXT
  exit 64
}

refuse() {
  echo "PROD_READ_REFUSED: $1" >&2
  exit 65
}

require_match() {
  local value="$1" pattern="$2" what="$3"
  [[ "$value" =~ $pattern ]] || refuse "$what is not allowed: $(printf '%q' "$value")"
}

remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$PROD_TARGET" "$1"
}

database_query() {
  local mode="$1" first="${2:-}" second="${3:-}"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$PROD_TARGET" \
    "cd /tmp && $PROD_NODE --no-warnings - $mode $first $second" <<JS
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync("$PROD_DATABASE", { readOnly: true });
const [mode, first, second] = process.argv.slice(2);
const hiddenColumn = /^(auth|p256dh|endpoint|ciphertext|embedding|secret|password|password_hash|account_json|challenge_json)$/i;
const shortenValue = (key, value) => {
  if (hiddenColumn.test(key)) return "[hidden]";
  if (typeof value === "string") return value.length > 160 ? value.slice(0, 160) + "..." : value;
  if (value !== null && typeof value === "object") return "[binary " + value.byteLength + " bytes]";
  return value;
};
const shorten = (row) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, shortenValue(key, value)]));
const tableNames = () =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
const requireTable = (name) => {
  if (!tableNames().includes(name)) throw new Error("PROD_READ_UNKNOWN_TABLE " + name);
};
const columnNames = (table) =>
  database.prepare("PRAGMA table_info(" + JSON.stringify(table) + ")").all().map((row) => row.name);
let result;
if (mode === "summary") {
  result = database.prepare("SELECT status, count(*) AS count FROM runs GROUP BY status").all();
} else if (mode === "open") {
  result = database
    .prepare(
      "SELECT id, thread_id, status, revision, created_at, updated_at FROM runs WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at",
    )
    .all();
} else if (mode === "run") {
  result = database.prepare("SELECT * FROM runs WHERE id = ?").all(first).map(shorten);
} else if (mode === "tables") {
  result = tableNames();
} else if (mode === "columns") {
  requireTable(first);
  result = columnNames(first);
} else if (mode === "rule-memories") {
  result = database
    .prepare(
      "SELECT id, status, tentative, classification, importance_permille, confidence_permille, inference, recorded_at, updated_at, valid_to, superseded_by, use_count FROM memory_records WHERE category = 'rule' ORDER BY recorded_at DESC, id LIMIT 500",
    )
    .all()
    .map(shorten);
} else if (mode === "capabilities") {
  result = database
    .prepare(
      "SELECT c.id, c.status, c.revision, c.version, " +
        "(SELECT count(*) FROM capability_handles h WHERE h.capability_id = c.id) AS handle_count " +
        "FROM capability_declarations c ORDER BY c.id LIMIT 200",
    )
    .all()
    .map(shorten);
} else if (mode === "gmail-decisions") {
  result = database
    .prepare(
      "SELECT p.message_id, p.decision_id, p.outcome, p.skip_reason, p.owner_rating, p.processed_at, " +
        "COALESCE((SELECT json_array_length(j.value) FROM json_each(d.inputs, '$.floorHits') j WHERE j.key = p.message_id), 0) AS rule_count, " +
        "COALESCE((SELECT json_array_length(j.value) FROM json_each(d.inputs, '$.memoryByMail') j WHERE j.key = p.message_id), 0) AS memory_count, " +
        "COALESCE((SELECT json_array_length(j.value) FROM json_each(d.inputs, '$.relatedByMail') j WHERE j.key = p.message_id), 0) AS related_count, " +
        "(SELECT count(*) FROM muse_reference_entries e WHERE e.owner_id = p.owner_id AND e.agent_id = p.agent_id AND e.paired_message_id = p.message_id) AS muse_entries, " +
        "(SELECT max(e.muse_reminded) FROM muse_reference_entries e WHERE e.owner_id = p.owner_id AND e.agent_id = p.agent_id AND e.paired_message_id = p.message_id) AS muse_reminded " +
        "FROM proactive_processed_messages p JOIN decision_ledger d ON d.id = p.decision_id " +
        "WHERE p.source = 'gmail' ORDER BY p.processed_at DESC, p.message_id LIMIT 100",
    )
    .all()
    .map(shorten);
} else if (mode === "rows") {
  requireTable(first);
  const columns = columnNames(first);
  const key = columns.includes("run_id") ? "run_id" : columns.includes("id") ? "id" : null;
  if (!key) throw new Error("PROD_READ_NO_RUN_COLUMN " + first);
  result = database
    .prepare("SELECT * FROM " + JSON.stringify(first) + " WHERE " + key + " = ? LIMIT 50")
    .all(second)
    .map(shorten);
} else {
  throw new Error("PROD_READ_UNKNOWN_MODE " + mode);
}
console.log(JSON.stringify(result, null, 1));
JS
}

system_instruction_query() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$PROD_TARGET" \
    "cd /tmp && $PROD_NODE --no-warnings - $PROD_CONFIGURATION $PROD_SERVICE_UID" <<'JS'
const { openSync, fstatSync, lstatSync, readFileSync, closeSync, constants } = require("node:fs");
const path = require("node:path");
const fail = (code) => {
  console.error(code);
  process.exit(1);
};
let descriptor;
try {
  descriptor = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
} catch (error) {
  fail(error.code === "ELOOP" ? "PROD_READ_CONFIG_UNSAFE" : "PROD_READ_CONFIG_UNREADABLE");
}
const stat = fstatSync(descriptor);
const owners = [0, Number(process.argv[3])];
const parent = lstatSync(path.dirname(process.argv[2]));
if (
  !stat.isFile() ||
  stat.nlink !== 1 ||
  (stat.mode & 0o077) !== 0 ||
  !owners.includes(stat.uid) ||
  !parent.isDirectory() ||
  (parent.mode & 0o002) !== 0 ||
  !owners.includes(parent.uid)
)
  fail("PROD_READ_CONFIG_UNSAFE");
let configuration;
try {
  configuration = JSON.parse(readFileSync(descriptor, "utf8"));
} catch {
  fail("PROD_READ_CONFIG_UNREADABLE");
}
closeSync(descriptor);
const text = configuration?.runPolicy?.systemInstruction;
if (typeof text !== "string") fail("PROD_READ_NO_SYSTEM_INSTRUCTION");
console.log(text);
JS
}

[ "$#" -ge 1 ] || usage
query="$1"
shift

case "$query" in
  status)
    [ "$#" -eq 0 ] || usage
    remote "/usr/bin/systemctl show $PROD_UNIT -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp"
    ;;
  journal)
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
    require_match "$1" '^[A-Za-z0-9:._-]{3,80}$' "journal pattern"
    lines="${2:-40}"
    require_match "$lines" '^[0-9]{1,3}$' "journal line count"
    [ "$lines" -ge 1 ] && [ "$lines" -le 200 ] || refuse "journal line count must be 1-200"
    remote "/usr/bin/journalctl -u $PROD_UNIT --no-pager -g '$1' -n $lines"
    ;;
  mounts)
    [ "$#" -eq 0 ] || usage
    remote "/usr/bin/findmnt"
    ;;
  disk)
    [ "$#" -eq 0 ] || usage
    remote "/usr/bin/df -h"
    ;;
  runs-summary)
    [ "$#" -eq 0 ] || usage
    database_query summary
    ;;
  runs-open)
    [ "$#" -eq 0 ] || usage
    database_query open
    ;;
  run)
    [ "$#" -eq 1 ] || usage
    require_match "$1" '^run:[A-Za-z0-9._:-]{1,120}$' "run id"
    database_query run "$1"
    ;;
  tables)
    [ "$#" -eq 0 ] || usage
    database_query tables
    ;;
  columns)
    [ "$#" -eq 1 ] || usage
    require_match "$1" '^[a-z][a-z0-9_]{0,63}$' "table name"
    database_query columns "$1"
    ;;
  rows)
    [ "$#" -eq 2 ] || usage
    require_match "$1" '^[a-z][a-z0-9_]{0,63}$' "table name"
    require_match "$2" '^[A-Za-z0-9:._-]{3,80}$' "run id"
    database_query rows "$1" "$2"
    ;;
  rule-memories)
    [ "$#" -eq 0 ] || usage
    database_query rule-memories
    ;;
  gmail-decisions)
    [ "$#" -eq 0 ] || usage
    database_query gmail-decisions
    ;;
  capabilities)
    [ "$#" -eq 0 ] || usage
    database_query capabilities
    ;;
  system-instruction)
    [ "$#" -eq 0 ] || usage
    system_instruction_query
    ;;
  *)
    usage
    ;;
esac
