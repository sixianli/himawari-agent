import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSourceModeImports } from "../../scripts/check-source-mode-imports.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "source-mode-imports-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const entries = ["src/main.ts"];

describe("source-mode import check", () => {
  it("passes when every runtime import names a file that exists", () => {
    const root = fixture({
      "src/main.ts": 'import { a } from "./a.ts";\n',
      "src/a.ts": 'export const a = 1;\nimport "./b.ts";\n',
      "src/b.ts": "export {};\n",
    });
    expect(checkSourceModeImports({ root, entries })).toMatchObject({ passed: true, checked: 3 });
  });

  it("fails on a .js import that only exists as .ts, which Node does not map in source mode", () => {
    const root = fixture({
      "src/main.ts": 'import { a } from "./a.js";\n',
      "src/a.ts": "export const a = 1;\n",
    });
    const result = checkSourceModeImports({ root, entries });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([
      { file: "src/main.ts", specifier: "./a.js", reason: "not-found-in-source-mode" },
    ]);
  });

  it("follows imports of imports and multi-line export-from", () => {
    const root = fixture({
      "src/main.ts": 'export {\n  a,\n} from "./a.ts";\n',
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
    });
    const result = checkSourceModeImports({ root, entries });
    expect(result.problems.map((problem) => problem.specifier)).toEqual(["./b.js"]);
  });

  it("ignores type-only imports, which are erased before Node runs the file", () => {
    const root = fixture({
      "src/main.ts": 'import type { A } from "./gone.js";\nexport type { B } from "./gone.js";\n',
    });
    expect(checkSourceModeImports({ root, entries }).passed).toBe(true);
  });

  it("ignores bare package specifiers and node builtins", () => {
    const root = fixture({
      "src/main.ts": 'import { x } from "@scope/pkg";\nimport fs from "node:fs";\n',
    });
    expect(checkSourceModeImports({ root, entries }).passed).toBe(true);
  });

  it("reports an entry file that does not exist", () => {
    const root = fixture({ "src/other.ts": "" });
    expect(checkSourceModeImports({ root, entries }).problems).toEqual([
      { file: "src/main.ts", specifier: null, reason: "missing" },
    ]);
  });

  it("holds for the real repository: the files Node runs straight from source import real paths", () => {
    expect(checkSourceModeImports().problems).toEqual([]);
  });
});
