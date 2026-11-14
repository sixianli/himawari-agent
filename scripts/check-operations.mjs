import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_FILE = "packages/gateway-contracts/src/contracts-v2.ts";
export const PENDING_LEDGER = "ci/operations-pending.json";
export const REMOVED_LEDGER = "ci/operations-removed.json";
const FRONTEND_ROOT = "apps/control-center/src";
export const INVENTORY_FILE = `${FRONTEND_ROOT}/app/control-center-inventory.ts`;
const FRONTEND_EXCLUDED = [
  `${FRONTEND_ROOT}/app/control-center-inventory.ts`,
  `${FRONTEND_ROOT}/i18n/`,
];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs"];
const SWIFT_ROOT = "clients/apple/Sources";
const SWIFT_EXCLUDED_SEGMENTS = ["/Generated/", "/Demo", "Demo.swift"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const MINIMUM_REASON_LENGTH = 10;

function walk(root, relative, accept, extensions = SOURCE_EXTENSIONS) {
  const found = [];
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...walk(root, child, accept, extensions));
    } else if (
      extensions.some((extension) => entry.name.endsWith(extension)) &&
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
    if (!/(?<![.\w])message\(\s*$/.test(before) && !/\bmessageId\s*[:=]\s*$/.test(before))
      return true;
    from = at + literal.length;
  }
}

function removedNameUsed(text, name) {
  for (const quote of ['"', "'", "`"]) {
    const literal = `${quote}${name}${quote}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at < 0) break;
      const before = text.slice(Math.max(0, at - 60), at);
      if (!/(?<![.\w])message\(\s*$/.test(before) && !/\bmeasure\([^,()]*,\s*$/.test(before))
        return true;
      from = at + literal.length;
    }
  }
  return false;
}

const GATEWAY_ARRAY_PATTERN = /(installedOperations|installedGatewayV2Operations)\s*[:=]\s*\[/g;

function balancedArray(text, openAt) {
  let depth = 0;
  for (let at = openAt; at < text.length; at += 1) {
    if (text[at] === "[") depth += 1;
    else if (text[at] === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(openAt + 1, at);
    }
  }
  return "";
}

export function readInstalledArrays(text) {
  const arrays = [];
  for (const match of text.matchAll(GATEWAY_ARRAY_PATTERN)) {
    const body = balancedArray(text, match.index + match[0].length - 1);
    const entries = [];
    for (const entry of body.matchAll(
      /\.\.\.\(\s*options\.(\w+)\s*\?\s*(PRODUCTION_[A-Z_]+_OPERATIONS)\s*:\s*\[\]\s*\)|\.\.\.\(\s*(\w+)\s*\?\s*(PRODUCTION_[A-Z_]+_OPERATIONS)\s*:\s*\[\]\s*\)|\.\.\.(PRODUCTION_[A-Z_]+_OPERATIONS)/g,
    )) {
      if (entry[2]) entries.push({ listName: entry[2], option: entry[1] });
      else if (entry[4]) entries.push({ listName: entry[4], option: null });
      else entries.push({ listName: entry[5], option: null });
    }
    arrays.push({ field: match[1], entries });
  }
  return arrays;
}

function withoutInstalledArrays(text) {
  let stripped = "";
  let from = 0;
  for (const match of text.matchAll(GATEWAY_ARRAY_PATTERN)) {
    const open = match.index + match[0].length;
    if (open < from) continue;
    stripped += text.slice(from, open);
    from = open + balancedArray(text, open - 1).length;
  }
  return stripped + text.slice(from);
}

export function readRouteBranches(text) {
  const events = [];
  for (const match of text.matchAll(
    /\b(query|command)\.type\s*(?:\.startsWith\(\s*"([^"]+)"\s*\)|===\s*"([^"]+)")|\boptions\.(\w+)/g,
  )) {
    if (match[4]) events.push({ option: match[4] });
    else
      events.push({
        kind: match[1] === "query" ? "query" : "command",
        literal: match[2] ?? match[3],
        prefix: match[2] !== undefined,
      });
  }
  const branches = [];
  let pending = [];
  for (const event of events) {
    if (event.option !== undefined) {
      if (pending.length > 0) branches.push({ option: event.option, predicates: pending });
      pending = [];
    } else pending.push(event);
  }
  return branches;
}

function routeMatches(predicate, kind, name) {
  return (
    predicate.kind === kind &&
    (predicate.prefix ? name.startsWith(predicate.literal) : name === predicate.literal)
  );
}

export function readInventoryOperations(text) {
  const exemptIds = new Set(
    [...text.matchAll(/surface\.id\s*===\s*"([^"]+)"/g)].map((match) => match[1]),
  );
  const declared = [];
  const parts = text.split(/(?<![\w.])id:\s*"/).slice(1);
  for (const part of parts) {
    const id = part.slice(0, part.indexOf('"'));
    if (exemptIds.has(id)) continue;
    for (const field of ["queries", "mutations"]) {
      const block = new RegExp(`\\b${field}:\\s*\\[([\\s\\S]*?)\\]`).exec(part);
      if (!block) continue;
      for (const item of block[1].matchAll(/"([^"]+)"/g)) declared.push({ id, name: item[1] });
    }
  }
  return declared;
}

function checkInstalledRouting({ root, files, lists, contractKinds, backendTexts }) {
  const errors = [];
  const cache = new Map();
  const readCached = (file) => {
    if (!cache.has(file)) cache.set(file, readFileSync(path.join(root, file), "utf8"));
    return cache.get(file);
  };
  const withField = (field) =>
    files
      .map((file) => ({ file, text: readCached(file) }))
      .filter(({ text }) => new RegExp(`${field}\\s*[:=]\\s*\\[`).test(text));
  const gateways = withField("installedOperations");
  if (gateways.length === 0) {
    if (lists.length > 0) errors.push("OPERATIONS_GATEWAY_MISSING");
    return { errors, installedNames: new Set() };
  }
  const installed = new Map();
  const optionList = new Map();
  for (const { file, text } of gateways) {
    for (const array of readInstalledArrays(text)) {
      if (array.field !== "installedOperations") continue;
      for (const entry of array.entries) {
        installed.set(entry.listName, file);
        if (entry.option) optionList.set(entry.option, entry.listName);
      }
    }
  }
  for (const list of lists) {
    if (!installed.has(list.listName))
      errors.push(`OPERATION_LIST_NOT_INSTALLED ${list.listName} in ${list.file}`);
  }
  const advertisedArrays = withField("installedGatewayV2Operations")
    .flatMap(({ text }) => readInstalledArrays(text))
    .filter((array) => array.field === "installedGatewayV2Operations");
  const advertised = advertisedArrays.flatMap((array) =>
    array.entries.map((entry) => entry.listName),
  );
  if (advertisedArrays.length === 0) errors.push("OPERATIONS_ADVERTISING_MISSING");
  else {
    for (const listName of installed.keys())
      if (!advertised.includes(listName)) errors.push(`OPERATION_LIST_NOT_ADVERTISED ${listName}`);
    for (const listName of advertised)
      if (!installed.has(listName)) errors.push(`OPERATION_LIST_NOT_IN_GATEWAY ${listName}`);
  }
  const handlerTexts = backendTexts.filter((text) => !/installedOperations\s*[:=]\s*\[/.test(text));
  const branches = gateways.flatMap(({ text }) => readRouteBranches(withoutInstalledArrays(text)));
  for (const list of lists) {
    if (!installed.has(list.listName)) continue;
    const option = [...optionList].find(([, listName]) => listName === list.listName)?.[0];
    const ownText = option ? readCached(list.file).replace(list.raw, "") : "";
    for (const name of list.names) {
      const kind = contractKinds.get(name);
      if (kind !== "query" && kind !== "command") continue;
      const branch = branches.find((candidate) =>
        candidate.predicates.some((predicate) => routeMatches(predicate, kind, name)),
      );
      if (option) {
        if (!branch) errors.push(`OPERATION_NOT_ROUTED ${name} (${list.listName}，${kind})`);
        else if (branch.option !== option)
          errors.push(
            `OPERATION_ROUTED_TO_OTHER_HANDLER ${name} 走到 ${branch.option}，应为 ${option}`,
          );
      } else if (branch) {
        errors.push(
          `OPERATION_ROUTED_TO_OTHER_HANDLER ${name} 走到 ${branch.option}，应由 ${list.listName} 的基础处理方接住`,
        );
      }
      const found =
        (option && ownText.includes(`"${name}"`)) ||
        handlerTexts.some((text) => text.includes(`"${name}"`));
      if (!found)
        errors.push(`OPERATION_HANDLER_MISSING ${name} (${list.file} 里没有处理它的代码)`);
    }
  }
  return {
    errors,
    installedNames: new Set(
      lists.filter((list) => installed.has(list.listName)).flatMap((list) => list.names),
    ),
  };
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
    ...walk(
      root,
      SWIFT_ROOT,
      (file) => !SWIFT_EXCLUDED_SEGMENTS.some((segment) => file.includes(segment)),
      [".swift"],
    ),
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
  let undeployed = {};
  if (existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      pending = ledger.operations ?? {};
      undeployed = ledger.notInstalled ?? {};
    } catch {
      errors.push("OPERATIONS_LEDGER_UNREADABLE");
    }
  } else {
    errors.push("OPERATIONS_LEDGER_MISSING");
  }

  const removedPath = path.join(root, REMOVED_LEDGER);
  let removed = [];
  if (!existsSync(removedPath)) errors.push("OPERATIONS_REMOVED_LEDGER_MISSING");
  else {
    try {
      removed = Object.keys(JSON.parse(readFileSync(removedPath, "utf8")).removed ?? {});
    } catch {
      errors.push("OPERATIONS_REMOVED_LEDGER_UNREADABLE");
    }
  }
  const contractText = readFileSync(contractPath, "utf8");
  const listedNames = /GATEWAY_V2_MESSAGE_TYPES = \[([\s\S]*?)\] as const/.exec(contractText);
  const allContractNames = new Set(
    listedNames ? [...listedNames[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [],
  );
  for (const name of removed) {
    if (allContractNames.has(name)) errors.push(`OPERATION_REMOVED_BUT_IN_CONTRACT ${name}`);
    const used = [...backendTexts, ...frontendTexts, ...testTexts, contractText].some((text) =>
      removedNameUsed(text, name),
    );
    if (used) errors.push(`OPERATION_REMOVED_STILL_USED ${name}`);
  }

  const contractKinds = new Map(operations.map(({ name, kind }) => [name, kind]));
  const routing = checkInstalledRouting({
    root,
    files: backendFiles,
    lists,
    contractKinds,
    backendTexts,
  });
  errors.push(...routing.errors);
  const notInstalled = new Set();
  const inventoryPath = path.join(root, INVENTORY_FILE);
  const declaredNames = new Set();
  if (lists.length > 0 && !existsSync(inventoryPath)) errors.push("OPERATIONS_INVENTORY_MISSING");
  else if (lists.length > 0) {
    const declared = readInventoryOperations(readFileSync(inventoryPath, "utf8"));
    if (declared.length === 0) errors.push("OPERATIONS_INVENTORY_UNPARSED");
    for (const { id, name } of declared) {
      declaredNames.add(name);
      if (routing.installedNames.has(name)) continue;
      notInstalled.add(name);
      if (!Object.hasOwn(pending, name) && !Object.hasOwn(undeployed, name))
        errors.push(`OPERATION_DECLARED_NOT_INSTALLED ${name} (${id})`);
    }
  }
  for (const name of Object.keys(undeployed)) {
    if (routing.installedNames.has(name))
      errors.push(
        `OPERATION_NOT_INSTALLED_BUT_INSTALLED ${name} 已安装，从 ${PENDING_LEDGER} 的 notInstalled 移除`,
      );
    else if (declaredNames.size > 0 && !declaredNames.has(name))
      errors.push(`OPERATION_NOT_INSTALLED_NOT_DECLARED ${name} 控制中心清单没有声明它`);
    if (Object.hasOwn(pending, name)) errors.push(`OPERATION_LEDGER_BOTH_SECTIONS ${name}`);
  }

  const report = [];
  for (const { name, kind } of operations) {
    const literal = `"${name}"`;
    const missing = [];
    if (!backendTexts.some((text) => text.includes(literal))) missing.push("后端实现");
    if (!frontendTexts.some((text) => frontendSends(text, name))) missing.push("调用方");
    if (!testTexts.some((text) => text.includes(literal))) missing.push("测试");
    report.push({ name, kind, missing });
    const reason = Object.hasOwn(pending, name) ? pending[name] : undefined;
    if (missing.length > 0 && reason === undefined)
      errors.push(`OPERATION_INCOMPLETE ${name} 缺：${missing.join("、")}`);
    if (missing.length === 0 && reason !== undefined)
      errors.push(
        `OPERATION_PENDING_BUT_COMPLETE ${name} 已齐全，${notInstalled.has(name) ? "改登记到 notInstalled" : "从 operations 移除"}（${PENDING_LEDGER}）`,
      );
  }
  for (const [name, reason] of [...Object.entries(pending), ...Object.entries(undeployed)]) {
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
