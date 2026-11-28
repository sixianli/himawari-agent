import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appleRoot, "../..");

export const TABLE_PATH = "clients/apple/information-architecture.json";
export const ENTRY_PATH = "clients/apple/Sources/HimawariManage/HerEntry.swift";
export const PAGE_PATH = "clients/apple/Sources/HimawariManage/HerPage.swift";
const OWN_SOURCES = [/github\.com\/sixianli\//iu, /himawari/iu, /localhost/iu, /127\.0\.0\.1/u];
const ALLOWED_LINKS = ["NavigationLink(value: Page.approvals)", "NavigationLink(value: page)"];

function enumBody(source, name) {
  const start = source.search(new RegExp(`enum\\s+${name}\\s*:[^{]*\\{`, "u"));
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  return undefined;
}

function plainCases(body) {
  return [...body.matchAll(/^ {4}case +([\w ,]+)$/gmu)].flatMap((match) =>
    match[1].split(",").map((name) => name.trim()),
  );
}

export function entriesInCode(source) {
  const groupBody = enumBody(source, "HerEntryGroup");
  const entryBody = enumBody(source, "HerEntry");
  if (!groupBody || !entryBody)
    return {
      error: `IA_CODE_UNREADABLE no HerEntryGroup or HerEntry enum in ${ENTRY_PATH}`,
    };
  const groups = plainCases(groupBody);
  const entries = plainCases(entryBody);
  const groupSwitch = entryBody.match(/var\s+group\s*:\s*HerEntryGroup\s*\{([\s\S]*?)\n\s{4}\}/u);
  const groupOf = new Map();
  if (groupSwitch) {
    for (const match of groupSwitch[1].matchAll(/case +([.\w ,]+): *\.(\w+)/gu)) {
      for (const name of match[1].split(","))
        groupOf.set(name.trim().replace(/^\./u, ""), match[2]);
    }
  }
  return { groups, entries, groupOf };
}

export function handWrittenRows(pageSource) {
  return [...pageSource.matchAll(/NavigationLink\s*\([^)]*\)/gu)]
    .map((match) => match[0].replace(/\s+/gu, " "))
    .filter((link) => !ALLOWED_LINKS.includes(link));
}

function externalSource(url) {
  return (
    typeof url === "string" &&
    /^https:\/\/[^\s/]+\.[^\s/]+/u.test(url) &&
    !OWN_SOURCES.some((own) => own.test(url))
  );
}

export function checkTable({ table, code, pageSource }) {
  if (code.error) return [code.error];
  const errors = [];
  const goals = new Set((table.goals ?? []).map((goal) => goal.id));
  const tableGroups = new Map((table.groups ?? []).map((group) => [group.id, group]));
  const tableEntries = new Map((table.entries ?? []).map((entry) => [entry.id, entry]));
  for (const goal of table.goals ?? []) {
    if (!goal.text?.trim()) errors.push(`IA_GOAL_WITHOUT_TEXT ${goal.id}`);
  }
  for (const group of code.groups) {
    if (!tableGroups.has(group))
      errors.push(
        `IA_GROUP_NOT_IN_TABLE ${group}: add it to ${TABLE_PATH} with why its entries belong together`,
      );
    else if (!tableGroups.get(group).why?.trim()) errors.push(`IA_GROUP_WITHOUT_WHY ${group}`);
  }
  for (const group of tableGroups.keys()) {
    if (!code.groups.includes(group))
      errors.push(`IA_GROUP_GONE ${group}: it is no longer a HerEntryGroup case`);
  }
  for (const entry of code.entries) {
    const row = tableEntries.get(entry);
    if (!row) {
      errors.push(
        `IA_ENTRY_NOT_IN_TABLE ${entry}: add it to ${TABLE_PATH} with the user goal, why it sits in its group, and a first-party benchmark`,
      );
      continue;
    }
    const group = code.groupOf.get(entry);
    if (!group) errors.push(`IA_ENTRY_WITHOUT_GROUP ${entry}: HerEntry.group has no case for it`);
    else if (row.group !== group)
      errors.push(
        `IA_GROUP_MISMATCH ${entry}: code puts it in ${group}, the table says ${row.group}`,
      );
    if (!row.goal || !goals.has(row.goal))
      errors.push(`IA_GOAL_MISSING ${entry}: goal ${row.goal ?? "(none)"} is not in the goal list`);
    if (!row.why?.trim()) errors.push(`IA_WHY_MISSING ${entry}`);
    const links = Array.isArray(row.benchmark) ? row.benchmark : [];
    if (!links.some(externalSource))
      errors.push(`IA_BENCHMARK_MISSING ${entry}: name a first-party source outside this project`);
    for (const link of links) {
      if (!externalSource(link))
        errors.push(
          `IA_BENCHMARK_OWN_SOURCE ${entry}: ${link} is not an outside first-party source`,
        );
    }
  }
  for (const entry of tableEntries.keys()) {
    if (!code.entries.includes(entry))
      errors.push(`IA_ENTRY_GONE ${entry}: it is no longer a HerEntry case`);
  }
  for (const link of handWrittenRows(pageSource)) {
    errors.push(`IA_HAND_WRITTEN_ROW ${PAGE_PATH}: ${link}; Himawari page rows come from HerEntry`);
  }
  return errors;
}

function read(relative) {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

export function checkRepository() {
  return checkTable({
    table: JSON.parse(read(TABLE_PATH)),
    code: entriesInCode(read(ENTRY_PATH)),
    pageSource: read(PAGE_PATH).split(/\n\s*private func destination/u)[0],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkRepository();
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`IA_FAILED ${errors.length}`);
    process.exit(1);
  }
  const table = JSON.parse(read(TABLE_PATH));
  console.log(`IA_PASSED entries=${table.entries.length} groups=${table.groups.length}`);
}
