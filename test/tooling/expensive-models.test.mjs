import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findExpensiveModels } from "../../scripts/check-expensive-models.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "expensive-models-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe("expensive model check", () => {
  it("fails on the reasoning judge that billed 2026-10 Sonnet calls", () => {
    const root = fixture({
      "test/integration/jarvis-test/gateway-judges.ts": `export const REASONING_JUDGE_MODEL = {
  id: "anthropic/claude-sonnet-5.5",
  version: "claude-sonnet-5.5",
};
`,
    });
    expect(findExpensiveModels({ root }).findings).toEqual([
      {
        file: "test/integration/jarvis-test/gateway-judges.ts",
        line: 2,
        model: "anthropic/claude-sonnet-5.5",
      },
      {
        file: "test/integration/jarvis-test/gateway-judges.ts",
        line: 3,
        model: "claude-sonnet-5.5",
      },
    ]);
  });

  it("fails on subject switches, scripts, configuration and OpenAI models", () => {
    const root = fixture({
      "test/integration/jarvis-test/live-harness.ts":
        'const SUBJECT_ALTERNATIVES = ["anthropic/claude-haiku-5.5"] as const;\n',
      "scripts/compare.mjs": 'const model = "openai/gpt-6-astra";\n',
      "config/models.json": '{ "judge": "gpt-6-luna" }\n',
      "evals/demo/models.yaml": "judge: claude-opus-5.5\n",
    });
    expect(
      findExpensiveModels({ root })
        .findings.map(({ file, model }) => `${file} ${model}`)
        .sort(),
    ).toEqual([
      "config/models.json gpt-6-luna",
      "evals/demo/models.yaml claude-opus-5.5",
      "scripts/compare.mjs openai/gpt-6-astra",
      "test/integration/jarvis-test/live-harness.ts anthropic/claude-haiku-5.5",
    ]);
  });

  it("passes cheap models, source links, SDK names, documents and historical run records", () => {
    const root = fixture({
      "test/fixtures/jarvis-test/models.json":
        '{ "reasoningJudge": { "id": "alibaba/qwen3.8-flash" } }\n',
      "scripts/links.mjs":
        'const source = "https://github.com/openai/codex/blob/main/README.md";\nimport "@anthropic-ai/sdk";\n',
      "ci/security-exceptions.json": '{ "path": "examples/custom-provider-anthropic/index.ts" }\n',
      "docs/adr/0103.md": "第二层裁判原为 anthropic/claude-sonnet-5.5\n",
      "evals/jarvis-test/history.jsonl":
        '{"reasoningJudge":{"id":"anthropic/claude-sonnet-5.5"}}\n',
      "apps/web/node_modules/pkg/index.js": 'model = "openai/gpt-6-astra";\n',
    });
    expect(findExpensiveModels({ root }).findings).toEqual([]);
  });

  it("keeps the repository free of expensive models and the judge on another vendor", () => {
    expect(findExpensiveModels().findings).toEqual([]);
    const models = JSON.parse(
      readFileSync(new URL("../fixtures/jarvis-test/models.json", import.meta.url), "utf8"),
    );
    expect(models.reasoningJudge.id.split("/")[0]).not.toBe("deepseek");
  });
});
