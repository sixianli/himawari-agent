import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkIncidentGates, INCIDENT_LIST } from "../../scripts/check-incident-gates.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const header = `| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |`;

function fixture(rows, { files = ["scripts/gate.mjs"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "incident-gates-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const file of files) writeFileSync(join(root, file), "");
  writeFileSync(join(root, INCIDENT_LIST), `# 清单\n\n${header}\n${rows.join("\n")}\n\n后文\n`);
  return root;
}

const row = (fields) =>
  `| ${[
    fields.id ?? "I-01",
    fields.date ?? "2026-10-28",
    fields.symptom ?? "现象",
    fields.cause ?? "根因",
    fields.count ?? "1",
    fields.gate ?? "`scripts/gate.mjs`",
    fields.state ?? "已落门槛",
  ].join(" | ")} |`;

describe("incident and gate list check", () => {
  it("passes a list whose gates exist", () => {
    const root = fixture([
      row({}),
      row({ id: "I-02", count: "4", state: "等 Andy", gate: "待 Andy 决定" }),
    ]);
    expect(checkIncidentGates({ root })).toMatchObject({ errors: [] });
  });

  it("refuses a third repeat that still has no hard gate", () => {
    const root = fixture([row({ count: "3", state: "缺门槛", gate: "只写了文档" })]);
    expect(checkIncidentGates({ root }).errors).toEqual([
      "INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE I-01 count=3",
    ]);
  });

  it("refuses a closed incident whose gate file does not exist or is not named", () => {
    const missing = fixture([row({ gate: "`scripts/gone.mjs`" })]);
    expect(checkIncidentGates({ root: missing }).errors).toEqual([
      "INCIDENT_GATE_PATH_MISSING I-01 scripts/gone.mjs",
    ]);
    const unnamed = fixture([row({ gate: "写进了案例库" })]);
    expect(checkIncidentGates({ root: unnamed }).errors).toEqual(["INCIDENT_GATE_NOT_NAMED I-01"]);
  });

  it("refuses unknown states, repeated ids and empty fields", () => {
    const root = fixture([row({ state: "已关闭" }), row({ cause: "" })]);
    expect(checkIncidentGates({ root }).errors).toEqual([
      "INCIDENT_STATE_INVALID I-01 已关闭",
      "INCIDENT_ID_REPEATED I-01",
      "INCIDENT_FIELD_EMPTY I-01 cause",
    ]);
  });

  it("checks the repository's own list", () => {
    expect(checkIncidentGates().errors).toEqual([]);
  });
});
