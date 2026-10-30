import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const TAG = "REAL_ADMISSION_TESTS";
const SOURCE_ROOTS = ["apps", "packages"];
const ADMISSION_TYPES = /\bModelInvocationAdmission(?:Resolver|Port)\b/;
const ADMISSION_BEGIN = /\.begin\(/;

const REAL_ADMISSION_TESTS = {
  "apps/agent-service/src/production-run-memory.ts": {
    test: "test/integration/sqlite-model-budget-operations.test.ts",
    imports: "apps/agent-service/src/production-run-memory.ts",
    uses: ["createProductionRunMemory(", "new ModelInvocationAdmissionService("],
  },
  "apps/agent-service/src/production-run-composition.ts": {
    test: "test/integration/sqlite-sandbox-execution-v2.test.ts",
    imports: "apps/agent-service/src/production-run-composition.ts",
    uses: ["createProductionRunComposition("],
  },
  "packages/runtime-pi/src/pi-runtime-adapter.ts": {
    test: "test/integration/sqlite-sandbox-execution-v2.test.ts",
    imports: "apps/agent-service/src/production-run-composition.ts",
    uses: ["createProductionRunComposition("],
  },
  "packages/application/src/services/model-invocation-admission-service.ts": {
    test: "test/integration/sqlite-model-budget-operations.test.ts",
    imports: "@himawari-agent/application",
    uses: ["new ModelInvocationAdmissionService("],
  },
  "packages/platform-node/src/trusted-model-provider.ts": {
    test: "test/integration/automatic-action-review.test.ts",
    imports: "@himawari-agent/platform-node",
    uses: ["new TrustedModelProviderAdapter(", "new ModelInvocationAdmissionService("],
  },
};

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "test") return [];
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function admissionCallers(root) {
  return SOURCE_ROOTS.flatMap((top) => sourceFiles(path.join(root, top)))
    .filter((file) => file.includes(`${path.sep}src${path.sep}`))
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return ADMISSION_TYPES.test(text) && ADMISSION_BEGIN.test(text);
    })
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

function importsModule(testText, testFile, target) {
  const specifiers = [...testText.matchAll(/from\s+"([^"]+)"|import\(\s*"([^"]+)"/g)].map(
    (match) => match[1] ?? match[2],
  );
  if (!target.includes("/src/")) return specifiers.includes(target);
  const wanted = target.replace(/\.(ts|js)$/, "");
  return specifiers.some((specifier) => {
    if (!specifier.startsWith(".")) return false;
    const resolved = path
      .normalize(path.join(path.dirname(testFile), specifier))
      .split(path.sep)
      .join("/")
      .replace(/\.(ts|js)$/, "");
    return resolved === wanted;
  });
}

export function checkRealAdmissionTests(root) {
  const errors = [];
  for (const caller of admissionCallers(root)) {
    const entry = REAL_ADMISSION_TESTS[caller];
    if (!entry) {
      errors.push(
        `${caller}: calls model admission but has no real-admission integration test registered in scripts/check-real-admission-tests.mjs`,
      );
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(root, entry.test), "utf8");
    } catch {
      errors.push(`${caller}: ${entry.test} does not exist`);
      continue;
    }
    if (!text.includes("SqliteProductStateRepository"))
      errors.push(`${caller}: ${entry.test} does not open a real SQLite product state`);
    if (!importsModule(text, entry.test, entry.imports))
      errors.push(`${caller}: ${entry.test} does not import ${entry.imports}`);
    for (const use of entry.uses)
      if (!text.includes(use)) errors.push(`${caller}: ${entry.test} does not call ${use}`);
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = checkRealAdmissionTests(process.cwd());
  if (errors.length > 0) {
    for (const error of errors) console.error(`${TAG} ${error}`);
    console.error(
      `${TAG} failed: a fake admission that always says "fresh" cannot see the budget and replay locks, so every caller needs one test through the real SQLite admission (I-37).`,
    );
    process.exit(1);
  }
  console.log(`${TAG} passed callers=${Object.keys(REAL_ADMISSION_TESTS).length}`);
}
