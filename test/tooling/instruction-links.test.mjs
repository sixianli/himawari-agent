import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkInstructionLinks } from "../../scripts/check-instruction-links.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "instruction-links-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const vision = '<a id="principles"></a>\n## 原则\n';

describe("instruction link check", () => {
  it("passes when every linked file, anchor and named path exists", () => {
    const root = fixture({
      "AGENTS.md": "先读 [愿景](docs/product-vision.md#principles) 和 `docs/assets/v1/`。",
      ".claude/rules/rule.md":
        "见 [总指令](../../AGENTS.md)，[官网](https://example.com)，`docs/TODO.md` 不许建。",
      "docs/product-vision.md": vision,
      "docs/assets/v1/index.html": "",
    });
    expect(checkInstructionLinks({ root })).toEqual({ checked: 3, errors: [] });
  });

  it("fails when a linked document is renamed", () => {
    const root = fixture({
      "AGENTS.md": "先读 [愿景](docs/product-vision.md)。",
      "docs/product-vision-v2.md": vision,
    });
    expect(checkInstructionLinks({ root }).errors).toEqual([
      "INSTRUCTION_LINK_MISSING AGENTS.md -> docs/product-vision.md",
    ]);
  });

  it("fails when a linked section anchor disappears", () => {
    const root = fixture({
      ".agents/instructions/mode.md": "见 [原则](../../docs/product-vision.md#gone)。",
      "docs/product-vision.md": vision,
    });
    expect(checkInstructionLinks({ root }).errors).toEqual([
      "INSTRUCTION_ANCHOR_MISSING .agents/instructions/mode.md -> ../../docs/product-vision.md#gone",
    ]);
  });

  it("fails when a named repository path no longer exists", () => {
    const root = fixture({ "AGENTS.md": "原型在 `docs/assets/v9/`，脚本是 `scripts/gone.mjs`。" });
    expect(checkInstructionLinks({ root }).errors).toEqual([
      "INSTRUCTION_PATH_MISSING AGENTS.md -> docs/assets/v9/",
      "INSTRUCTION_PATH_MISSING AGENTS.md -> scripts/gone.mjs",
    ]);
  });
});
