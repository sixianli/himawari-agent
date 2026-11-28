import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PENDING_FILE = "ci/classification-gates-pending.json";
const SOURCE_ROOTS = ["apps", "packages"];
const SKIPPED = new Set(["node_modules", "dist", "build", "coverage", "test", "tests", "Tests"]);
const LEVEL = String.raw`"(?:public|private|sensitive)"`;

export const GATE_PATTERNS = Object.freeze([
  {
    code: "DESCRIPTOR_CLASSIFICATION_GATE",
    pattern: /allowedDataClassifications\s*\??\.\s*(?:includes|some|every|indexOf|find)\s*\(/g,
  },
  {
    code: "CLASSIFICATION_LEVEL_COMPARED",
    pattern: new RegExp(
      String.raw`[cC]lassification\??\s*[!=]==\s*${LEVEL}|${LEVEL}\s*[!=]==\s*[\w?.]*[cC]lassification\b`,
      "g",
    ),
  },
  {
    code: "CLASSIFICATION_ALLOW_LIST",
    pattern: /\[\s*"public"\s*,\s*"private"\s*\]/g,
  },
]);

function sourceFiles(relative, files) {
  const absolute = path.join(repositoryRoot, relative);
  if (!existsSync(absolute)) return files;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) sourceFiles(child, files);
    } else if (
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
    )
      files.push(child);
  }
  return files;
}

export function findGates(text) {
  const found = [];
  for (const { code, pattern } of GATE_PATTERNS)
    for (const match of text.matchAll(pattern))
      found.push({ code, line: text.slice(0, match.index).split("\n").length });
  return found;
}

export function checkClassificationGates({
  files = SOURCE_ROOTS.flatMap((root) => sourceFiles(root, [])),
  read = (file) => readFileSync(path.join(repositoryRoot, file), "utf8"),
  pending = JSON.parse(readFileSync(path.join(repositoryRoot, PENDING_FILE), "utf8")),
} = {}) {
  const allowed = new Map(pending.files.map((entry) => [entry.path, entry]));
  const errors = [];
  const seen = new Set();
  for (const file of files) {
    const gates = findGates(read(file));
    if (gates.length === 0) continue;
    seen.add(file);
    const entry = allowed.get(file);
    if (!entry)
      for (const gate of gates)
        errors.push(
          `${gate.code} ${file}:${gate.line} only passwords and keys may be kept from a model; remove the classification check (Andy 2026-11-28)`,
        );
    else if (gates.length > entry.count)
      errors.push(
        `CLASSIFICATION_GATE_ADDED ${file} has ${gates.length} classification checks, ${PENDING_FILE} allows ${entry.count}`,
      );
  }
  for (const entry of pending.files)
    if (!seen.has(entry.path))
      errors.push(
        `CLASSIFICATION_PENDING_STALE ${entry.path} no longer has classification checks; remove it from ${PENDING_FILE}`,
      );
    else if (findGates(read(entry.path)).length < entry.count)
      errors.push(
        `CLASSIFICATION_PENDING_STALE ${entry.path} has fewer checks than ${PENDING_FILE} allows; lower its count`,
      );
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkClassificationGates();
  for (const error of errors) console.error(error);
  if (errors.length > 0) {
    console.error(`CLASSIFICATION_GATES failed errors=${errors.length}`);
    process.exit(1);
  }
  console.log("CLASSIFICATION_GATES passed");
}
