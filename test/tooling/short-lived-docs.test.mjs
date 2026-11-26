import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkShortLivedDocs } from "../../scripts/check-short-lived-docs.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "short-lived-docs-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const doc = (fields) =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: "${value}"`)
    .join("\n")}\n---\n\n# 标题\n`;

const ADR = "docs/adr/0300-a.md";
const BACKLOG = "docs/backlog/BL-1-a.md";
const SPEC = "docs/execution/specs/2026-11-26-a.md";

describe("check-short-lived-docs", () => {
  it("passes a spec whose ADR is still being implemented", () => {
    const root = repository({
      [ADR]: doc({ status: "active", implementation: "in_progress" }),
      [SPEC]: doc({ document_type: "spec", implements: ADR }),
    });
    expect(checkShortLivedDocs(root)).toEqual({ errors: [], specs: 1 });
  });

  it("passes a spec whose backlog item is still open", () => {
    const root = repository({
      [BACKLOG]: doc({ record_state: "in_progress" }),
      [SPEC]: doc({ document_type: "spec", implements: BACKLOG }),
    });
    expect(checkShortLivedDocs(root).errors).toEqual([]);
  });

  it("fails once the ADR no longer says the code is in progress", () => {
    const root = repository({
      [ADR]: doc({ status: "active" }),
      [SPEC]: doc({ document_type: "spec", implements: ADR }),
    });
    expect(checkShortLivedDocs(root).errors).toEqual([
      expect.stringMatching(
        /^SHORT_LIVED_DOC_WORK_CLOSED docs\/execution\/specs\/2026-11-26-a\.md -> docs\/adr\/0300-a\.md /,
      ),
    ]);
  });

  it("fails once the tracked ADR or backlog item is deleted or closed", () => {
    const root = repository({
      [BACKLOG]: doc({ record_state: "done" }),
      [SPEC]: doc({ document_type: "spec", implements: BACKLOG }),
      "docs/execution/specs/2026-11-26-b.md": doc({
        document_type: "spec",
        implements: "docs/adr/0999-gone.md",
      }),
    });
    const { errors } = checkShortLivedDocs(root);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toMatch(/^SHORT_LIVED_DOC_WORK_CLOSED /);
  });

  it("fails a spec that names no tracked work or names something else", () => {
    const root = repository({
      [SPEC]: doc({ document_type: "spec" }),
      "docs/execution/specs/2026-11-26-b.md": doc({
        document_type: "spec",
        implements: "README.md",
      }),
    });
    const { errors } = checkShortLivedDocs(root);
    expect(errors[0]).toMatch(
      /^SHORT_LIVED_DOC_UNTRACKED docs\/execution\/specs\/2026-11-26-a\.md /,
    );
    expect(errors[1]).toMatch(
      /^SHORT_LIVED_DOC_TRACKER_INVALID docs\/execution\/specs\/2026-11-26-b\.md /,
    );
  });

  it("fails any plan file and any spec kept outside the specs folder", () => {
    const root = repository({
      [ADR]: doc({ implementation: "in_progress" }),
      "docs/execution/plans/2026-11-26-a.md": doc({ document_type: "plan", implements: ADR }),
      "docs/notes.md": doc({ document_type: "spec", implements: ADR }),
      "docs/assets/control-center/baseline.md": doc({ document_type: "spec" }),
      "docs/execution/plans/.gitkeep": "\n",
    });
    const { errors } = checkShortLivedDocs(root);
    expect(errors).toEqual([
      expect.stringMatching(/^SHORT_LIVED_DOC_PLAN docs\/execution\/plans\/2026-11-26-a\.md /),
      expect.stringMatching(/^SHORT_LIVED_DOC_MISPLACED docs\/notes\.md /),
    ]);
  });

  it("passes when there are no specs at all", () => {
    expect(checkShortLivedDocs(repository({ "docs/README.md": "# 文档\n" }))).toEqual({
      errors: [],
      specs: 0,
    });
  });
});
