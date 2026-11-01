import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findEgressViolations,
  REQUIRED_REDACTION_CALLS,
} from "../../scripts/check-egress-redaction.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "egress-"));
  roots.push(root);
  const files = Object.fromEntries(REQUIRED_REDACTION_CALLS.map((c) => [c.file, c.required]));
  for (const [file, text] of Object.entries({ ...files, ...overrides })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, "apps"), { recursive: true });
  return root;
}

describe("egress redaction check", () => {
  it("passes when every registered egress point redacts", () => {
    expect(findEgressViolations(fixture())).toEqual([]);
  });

  it("fails when a registered egress point stops redacting", () => {
    const root = fixture({ "packages/memory-engine/src/embedding.ts": "embed(text)" });
    expect(findEgressViolations(root).join("\n")).toContain("embedding.ts");
  });

  it("fails on a new unregistered path to the model or an embedding provider", () => {
    const root = fixture({
      "packages/application/src/services/new-caller.ts":
        'await fetch(base + "/embeddings", { body });',
    });
    expect(findEgressViolations(root).join("\n")).toContain("new-caller.ts");
  });
});
