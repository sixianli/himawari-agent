import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_FILE = "packages/gateway-contracts/src/contracts-v2.ts";
export const PENDING_LEDGER = "ci/operations-pending.json";
const FRONTEND_ROOT = "apps/control-center/src";
const FRONTEND_EXCLUDED = [
  `${FRONTEND_ROOT}/app/control-center-inventory.ts`,
  `${FRONTEND_ROOT}/i18n/`,
];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const MINIMUM_REASON_LENGTH = 10;

function walk(root, relative, accept) {
  const found = [];
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...walk(root, child, accept));
    } else if (
      SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
      accept(child)
    ) {
      found.push(child);
    }
  }
  return found;
}

function packageDirectories(root, group) {
  const absolute = path.join(root, group);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(group, entry.name));
}

export function readContractOperations(text) {
  const listed = /GATEWAY_V2_MESSAGE_TYPES = \[([\s\S]*?)\] as const/.exec(text);
  if (!listed) return { operations: [], errors: ["OPERATIONS_CONTRACT_LIST_MISSING"] };
  const names = [...listed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const kinds = new Map();
  for (const match of text.matchAll(
    /(envelope|commandEnvelope)\(\s*(?:"(query|command|snapshot|event)",\s*)?"([^"]+)"/g,
  )) {
    kinds.set(match[3], match[1] === "commandEnvelope" ? "command" : match[2]);
  }
  const errors = [];
  const operations = [];
  for (const name of names) {
    const kind = kinds.get(name);
    if (!kind) errors.push(`OPERATION_SCHEMA_MISSING ${name}`);
    else if (kind === "query" || kind === "command") operations.push({ name, kind });
  }
  return { operations, errors };
}

function installedLists(text) {
  const lists = [];
  for (const match of text.matchAll(
    /export const (PRODUCTION_[A-Z_]+_OPERATIONS)\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]/g,
  )) {
    lists.push({
      listName: match[1],
      raw: match[0],
      names: [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
    });
  }
  return lists;
}

function frontendSends(text, name) {
  const literal = `"${name}"`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(literal, from);
    if (at < 0) return false;
    const before = text.slice(Math.max(0, at - 24), at);
    if (!/\bmessage\(\s*$/.test(before) && !/\bmessageId\s*[:=]\s*$/.test(before)) return true;
    from = at + literal.length;
  }
}

export function checkOperations(root = repositoryRoot) {
  const errors = [];
  const contractPath = path.join(root, CONTRACT_FILE);
  if (!existsSync(contractPath)) return { operations: [], errors: ["OPERATIONS_CONTRACT_MISSING"] };
  const { operations, errors: contractErrors } = readContractOperations(
    readFileSync(contractPath, "utf8"),
  );
  errors.push(...contractErrors);
  const contractNames = new Set(operations.map(({ name }) => name));

  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const backendFiles = [
    ...packageDirectories(root, "apps").flatMap((directory) =>
      directory.endsWith("/control-center") ? [] : walk(root, `${directory}/src`, () => true),
    ),
    ...packageDirectories(root, "packages")
      .filter((directory) => directory !== "packages/gateway-contracts")
      .flatMap((directory) => walk(root, `${directory}/src`, () => true)),
  ];
  const lists = [];
  let backendTexts = backendFiles.map((file) => {
    let text = read(file);
    if (file.startsWith("apps/agent-service/")) {
      for (const list of installedLists(text)) {
        lists.push({ ...list, file });
        text = text.replace(list.raw, "");
      }
    }
    return text;
  });
  backendTexts = backendTexts.filter((text) => text.length > 0);

  const frontendTexts = [
    ...walk(
      root,
      FRONTEND_ROOT,
      (file) => !FRONTEND_EXCLUDED.some((skip) => file.startsWith(skip)),
    ),
    ...walk(root, "scripts", () => true),
    ...walk(root, "apps/admin-cli/src", () => true),
  ].map(read);

  const testFiles = [
    ...packageDirectories(root, "apps").flatMap((directory) =>
      walk(root, `${directory}/test`, () => true),
    ),
    ...packageDirectories(root, "packages")
      .filter((directory) => directory !== "packages/gateway-contracts")
      .flatMap((directory) => walk(root, `${directory}/test`, () => true)),
    ...walk(root, "test", () => true),
  ].filter(
    (file) =>
      /\.test\.(ts|tsx|mjs)$/.test(file) &&
      !file.includes("/fixtures/") &&
      !file.includes("/qualification/evidence/"),
  );
  const testTexts = testFiles.map(read);

  const ledgerPath = path.join(root, PENDING_LEDGER);
  let pending = {};
  if (existsSync(ledgerPath)) {
    try {
      pending = JSON.parse(readFileSync(ledgerPath, "utf8")).operations ?? {};
    } catch {
      errors.push("OPERATIONS_LEDGER_UNREADABLE");
    }
  } else {
    errors.push("OPERATIONS_LEDGER_MISSING");
  }

  const report = [];
  for (const { name, kind } of operations) {
    const literal = `"${name}"`;
    const missing = [];
    if (!backendTexts.some((text) => text.includes(literal))) missing.push("后端实现");
    if (!frontendTexts.some((text) => frontendSends(text, name))) missing.push("调用方");
    if (!testTexts.some((text) => text.includes(literal))) missing.push("测试");
    report.push({ name, kind, missing });
    const reason = pending[name];
    if (missing.length > 0 && reason === undefined)
      errors.push(`OPERATION_INCOMPLETE ${name} 缺：${missing.join("、")}`);
    if (missing.length === 0 && reason !== undefined)
      errors.push(`OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，从 ${PENDING_LEDGER} 移除`);
  }
  for (const [name, reason] of Object.entries(pending)) {
    if (!contractNames.has(name)) errors.push(`OPERATION_PENDING_NOT_IN_CONTRACT ${name}`);
    if (typeof reason !== "string" || reason.trim().length < MINIMUM_REASON_LENGTH)
      errors.push(`OPERATION_PENDING_REASON_MISSING ${name}`);
  }
  for (const list of lists) {
    for (const name of list.names) {
      if (!contractNames.has(name))
        errors.push(
          `OPERATION_INSTALLED_NOT_IN_CONTRACT ${name} (${list.listName} in ${list.file})`,
        );
    }
  }
  return { operations: report, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { operations, errors } = checkOperations();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `OPERATIONS ${errors.length === 0 ? "passed" : "failed"} operations=${operations.length} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
