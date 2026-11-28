import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { INCIDENT_ID_SOURCE } from "./check-incident-gates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = "docs/agent-rulebook-inventory.md";
const SELF_TEST = "test/tooling/agent-rulebook-inventory.test.mjs";
const IGNORED = new Set(["node_modules", ".git", "dist", "coverage", ".ci-output"]);
const TEST_ID = /\b(?:PG|OM|SI|PA|NAME|MEM|W)-[A-Za-z0-9]+\b/g;
const INCIDENT_ID = new RegExp(`\\b${INCIDENT_ID_SOURCE}\\b`, "g");
const TEST_FILE = /`([^`\s]+\.(?:test|spec)\.[a-z]+)`/g;
const LINK = /\]\(([^)\s]+)\)/g;

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function isTestPath(relative) {
  return /(^|\/)(test|tests|__tests__)\//.test(relative) || /\.(test|spec)\.[a-z]+$/.test(relative);
}

function collectTestFiles(root) {
  const files = [];
  walk(root, (full) => {
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (isTestPath(relative) && !relative.startsWith("docs/") && relative !== SELF_TEST)
      files.push(relative);
  });
  return files;
}

function anchorsOf(text) {
  return new Set([...text.matchAll(/<a id="([^"]+)"/g)].map((match) => match[1]));
}

export function checkInventory(root) {
  const problems = [];
  const inventoryPath = path.join(root, INVENTORY);
  const text = readFileSync(inventoryPath, "utf8");
  const ownAnchors = anchorsOf(text);

  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const [filePart, anchor] = target.split("#");
    let targetText = text;
    if (filePart) {
      const resolved = path.resolve(path.dirname(inventoryPath), filePart);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        problems.push(`LINK_FILE_MISSING ${target}`);
        continue;
      }
      targetText = resolved.endsWith(".md") ? readFileSync(resolved, "utf8") : "";
    }
    if (anchor) {
      const anchors = filePart ? anchorsOf(targetText) : ownAnchors;
      if (!anchors.has(anchor)) problems.push(`LINK_ANCHOR_MISSING ${target}`);
    }
  }

  const testFiles = collectTestFiles(root);
  const testTexts = testFiles.map((file) => readFileSync(path.join(root, file), "utf8"));
  const baseNames = new Set(testFiles.map((file) => file.split("/").pop()));
  const fullNames = new Set(testFiles);

  for (const match of text.matchAll(TEST_FILE)) {
    const name = match[1];
    const found = name.includes("/") ? fullNames.has(name) : baseNames.has(name);
    if (!found) problems.push(`TEST_FILE_MISSING ${name}`);
  }

  const testIds = new Set(text.match(TEST_ID) ?? []);
  for (const id of testIds) {
    const exact = new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`);
    if (!testTexts.some((content) => exact.test(content))) problems.push(`TEST_ID_MISSING ${id}`);
  }

  const incidentsPath = path.join(root, "docs/incidents-and-gates.md");
  const incidents = existsSync(incidentsPath) ? readFileSync(incidentsPath, "utf8") : "";
  for (const id of new Set(text.match(INCIDENT_ID) ?? [])) {
    if (!new RegExp(`\\b${id}\\b`).test(incidents)) problems.push(`INCIDENT_ID_MISSING ${id}`);
  }

  return problems;
}

function main() {
  const problems = checkInventory(repositoryRoot);
  if (problems.length === 0) {
    console.log("AGENT_RULEBOOK_INVENTORY passed");
    return 0;
  }
  for (const problem of problems) console.error(problem);
  console.error(`AGENT_RULEBOOK_INVENTORY failed problems=${problems.length}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
