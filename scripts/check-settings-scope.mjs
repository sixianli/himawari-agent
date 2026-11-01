import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/persistence-sqlite/src/migrations";
const BROWSER_STORAGE = "apps/control-center/src/browser-storage.ts";
const CONTROL_CENTER_SOURCE = "apps/control-center/src";

const DEVICE_IDENTITY_COLUMNS = new Set([
  "endpoint",
  "device_label",
  "client_id",
  "subscription_id",
]);
const SETTING_COLUMN = /^(notify_.+|.+_enabled|enabled|locale|theme|accent|kinds|preferences?)$/;

export const ALLOWED_DEVICE_SETTING_COLUMNS = Object.freeze({
  "web_push_subscriptions.locale":
    "语言只作这台设备推送订阅创建时的备用值；发送时以账号的语言偏好为准",
  "web_push_subscriptions.notify_reminder":
    "迁移 0071 之后不再读取，开关以 web_push_account_kinds 为准；这一列等后续迁移删除",
  "web_push_subscriptions.notify_approval":
    "迁移 0071 之后不再读取，开关以 web_push_account_kinds 为准；这一列等后续迁移删除",
  "web_push_subscriptions.notify_run":
    "迁移 0071 之后不再读取，开关以 web_push_account_kinds 为准；这一列等后续迁移删除",
});

export const BROWSER_STORAGE_KEYS = Object.freeze({
  draft: "device: 这台设备上还没发出的草稿",
  lastCursor: "device: 这台设备的事件流读到哪",
  threadLastCursor: "device: 这台设备的对话事件流读到哪",
  mutation: "device: 这台设备上一次还没确认的操作，用于重试",
  submission: "device: 这台设备上一次还没确认的发送，用于重试",
  governanceMutation: "device: 这台设备上一次还没确认的授权操作，用于重试",
  preferences: "account-cache: 账号偏好在这台设备上的副本，来源是服务器的 owner_preferences",
  preferencesRevision: "account-cache: 上面副本对应的服务器版本号",
  preferencesUnsynced: "account-cache: 上面副本里有还没传到服务器的改动",
  locale: "account-cache: 语言偏好在这台设备上的副本，来源是服务器的 owner_preferences",
});

function tableColumns(migrationsDirectory) {
  const tables = new Map();
  const add = (table, column) => {
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(column);
  };
  for (const name of readdirSync(migrationsDirectory).sort()) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(path.join(migrationsDirectory, name), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/g)) {
      for (const line of match[2].split("\n")) {
        const column = /^\s{2}([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB)\b/.exec(line);
        if (column) add(match[1], column[1]);
      }
    }
    for (const match of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g))
      add(match[1], match[2]);
  }
  return tables;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

export function browserStorageKeys({ root = repositoryRoot } = {}) {
  const source = readFileSync(path.join(root, BROWSER_STORAGE), "utf8");
  return [...new Set([...source.matchAll(/KEY_PREFIX\}\.(\w+)/g)].map((match) => match[1]))];
}

export function checkSettingsScope({ root = repositoryRoot } = {}) {
  const problems = [];
  for (const [table, columns] of tableColumns(path.join(root, MIGRATIONS))) {
    if (![...columns].some((column) => DEVICE_IDENTITY_COLUMNS.has(column))) continue;
    for (const column of columns) {
      if (!SETTING_COLUMN.test(column)) continue;
      if (`${table}.${column}` in ALLOWED_DEVICE_SETTING_COLUMNS) continue;
      problems.push(
        `SETTING_STORED_PER_DEVICE ${table}.${column}：这张表一行对应一台设备，设置不能存在这里。把它存进账号级的表（例如 owner_preferences 或 web_push_account_kinds），让每台设备读同一份`,
      );
    }
  }
  for (const key of browserStorageKeys({ root }))
    if (!(key in BROWSER_STORAGE_KEYS))
      problems.push(
        `BROWSER_KEY_UNDECLARED ${key}：浏览器本地存储里新增了键。只属于这台设备的（草稿、读到哪）在 scripts/check-settings-scope.mjs 的 BROWSER_STORAGE_KEYS 里登记为 device；用户设置必须存服务器，浏览器里只能是它的副本`,
      );
  for (const file of sourceFiles(path.join(root, CONTROL_CENTER_SOURCE))) {
    const relative = path.relative(root, file);
    if (relative === BROWSER_STORAGE) continue;
    const source = readFileSync(file, "utf8");
    if (
      /\b(localStorage|sessionStorage|indexedDB)\b/.test(source) &&
      relative !== `${CONTROL_CENTER_SOURCE}/app.tsx`
    )
      problems.push(
        `BROWSER_STORAGE_BYPASS ${relative}：网页代码只能通过 ControlCenterBrowserStorage 读写浏览器本地存储，这样新增的键才会被上面的检查看到`,
      );
  }
  return { problems, passed: problems.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSettingsScope();
  for (const problem of result.problems) process.stderr.write(`${problem}\n`);
  process.stdout.write(
    `SETTINGS_SCOPE ${result.passed ? "passed" : "failed"} problems=${result.problems.length}\n`,
  );
  process.exitCode = result.passed ? 0 : 1;
}
