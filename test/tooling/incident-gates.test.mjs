import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkIncidentGates,
  INCIDENT_LIST,
  openIncidentLines,
} from "../../scripts/check-incident-gates.mjs";

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

  it("refuses incident rows left outside the incident table", () => {
    const root = mkdtempSync(join(tmpdir(), "incident-gates-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/gate.mjs"), "");
    writeFileSync(
      join(root, INCIDENT_LIST),
      `# 清单\n\n${header}\n${row({})}\n\n## 另一节\n\n说明\n${row({ id: "I-02", gate: "`scripts/gone.mjs`" })}\n`,
    );
    expect(checkIncidentGates({ root }).errors).toEqual(["INCIDENT_ROW_OUTSIDE_TABLE I-02"]);
    writeFileSync(
      join(root, INCIDENT_LIST),
      `# 清单\n\n${row({ id: "I-03" })}\n\n${header}\n${row({})}\n\n说明\n  ${row({ id: "I-04" })}\n`,
    );
    expect(checkIncidentGates({ root }).errors).toEqual([
      "INCIDENT_ROW_OUTSIDE_TABLE I-03",
      "INCIDENT_ROW_OUTSIDE_TABLE I-04",
    ]);
  });

  it("reads indented rows inside the table as part of the table", () => {
    const root = fixture([row({}), `  ${row({ id: "I-02" })}`, row({ id: "I-03" })]);
    expect(checkIncidentGates({ root })).toMatchObject({ errors: [] });
    expect(checkIncidentGates({ root }).incidents.map((incident) => incident.id)).toEqual([
      "I-01",
      "I-02",
      "I-03",
    ]);
  });

  it("lists only incidents that still lack a gate or wait on Andy, one short line each", () => {
    const longSymptom = `${"很长的现象".repeat(40)}。第二句不显示`;
    const root = fixture([
      row({}),
      row({ id: "I-02", state: "缺门槛", gate: "无", symptom: "第一句。第二句" }),
      row({ id: "I-03", state: "仓库外", gate: "替代做法" }),
      row({ id: "I-04", state: "等 Andy", gate: "待定", symptom: longSymptom }),
    ]);
    const lines = openIncidentLines(checkIncidentGates({ root }).incidents);
    expect(lines[0]).toBe("I-02 | 缺门槛 | 2026-10-28 | 第一句。");
    expect(lines[1].startsWith("I-04 | 等 Andy | 2026-10-28 | 很长的现象")).toBe(true);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines[1]).not.toContain("第二句");
    expect(lines).toHaveLength(2);
  });

  it("prints the repository's open incidents from the command line", () => {
    const output = execFileSync("node", ["scripts/check-incident-gates.mjs", "--open"], {
      encoding: "utf8",
    });
    const { incidents } = checkIncidentGates();
    const open = incidents.filter((incident) => ["缺门槛", "等 Andy"].includes(incident.state));
    const rows = output.split("\n").filter((line) => /^I-\d/.test(line));
    expect(rows.map((line) => line.split(" | ")[0])).toEqual(open.map((incident) => incident.id));
    expect(output).toContain(`INCIDENT_OPEN count=${open.length} total=${incidents.length}`);
  });

  it("checks the repository's own list", () => {
    expect(checkIncidentGates().errors).toEqual([]);
  });
});
