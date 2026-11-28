import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCommitMessage,
  checkIncidentGates,
  checkIncidentHistory,
  INCIDENT_LIST,
  openIncidentLines,
  PREMISE_MARK,
  RULE_FILE,
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

  it("refuses a second occurrence that still has no hard gate, and lets a first one wait", () => {
    const root = fixture([row({ count: "2", state: "缺门槛", gate: "只写了文档" })]);
    expect(checkIncidentGates({ root }).errors).toEqual([
      "INCIDENT_REPEAT_WITHOUT_HARD_GATE I-01 count=2",
    ]);
    const first = fixture([row({ count: "1", state: "缺门槛", gate: "只写了文档" })]);
    expect(checkIncidentGates({ root: first }).errors).toEqual([]);
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

  it("lists every incident that is not closed by a gate, one short line each", () => {
    const longSymptom = `${"很长的现象".repeat(40)}。第二句不显示`;
    const root = fixture([
      row({}),
      row({ id: "I-02", state: "缺门槛", gate: "无", symptom: "第一句。第二句" }),
      row({ id: "I-03", state: "仓库外", gate: "替代做法", symptom: "仓库外的现象" }),
      row({ id: "I-04", state: "等 Andy", gate: "待定", symptom: longSymptom }),
    ]);
    const lines = openIncidentLines(checkIncidentGates({ root }).incidents);
    expect(lines[0]).toBe("I-02 | 缺门槛 | 2026-10-28 | 第一句。");
    expect(lines[1]).toBe("I-03 | 仓库外 | 2026-10-28 | 仓库外的现象");
    expect(lines[2].startsWith("I-04 | 等 Andy | 2026-10-28 | 很长的现象")).toBe(true);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(lines[2]).not.toContain("第二句");
    expect(lines).toHaveLength(3);
  });

  it("cuts a long symptom after 80 characters without splitting a character in two", () => {
    const exactly80 = "字".repeat(80);
    const emojiAtTheCut = `${"字".repeat(79)}😀😀尾巴`;
    const root = fixture([
      row({ id: "I-01", state: "缺门槛", gate: "无", symptom: exactly80 }),
      row({ id: "I-02", state: "缺门槛", gate: "无", symptom: emojiAtTheCut }),
    ]);
    const lines = openIncidentLines(checkIncidentGates({ root }).incidents);
    expect(lines[0]).toBe(`I-01 | 缺门槛 | 2026-10-28 | ${exactly80}`);
    expect(lines[1]).toBe(`I-02 | 缺门槛 | 2026-10-28 | ${"字".repeat(79)}😀…`);
    expect(lines[1].isWellFormed()).toBe(true);
  });

  it("prints the repository's open incidents from the command line", () => {
    const output = execFileSync("node", ["scripts/check-incident-gates.mjs", "--open"], {
      encoding: "utf8",
    });
    const { incidents } = checkIncidentGates();
    const open = incidents.filter((incident) => incident.state !== "已落门槛");
    const outputLines = output.trimEnd().split("\n");
    const rows = outputLines.filter((line) => /^I-\d/.test(line));
    expect(rows.map((line) => line.split(" | ")[0])).toEqual(open.map((incident) => incident.id));
    expect(outputLines.slice(-2)).toEqual([
      `INCIDENT_OPEN count=${open.length} total=${incidents.length}`,
      `INCIDENT_GATES passed incidents=${incidents.length} errors=0`,
    ]);
  });

  it("says the open list is unavailable instead of printing a zero count when the list cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "incident-gates-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(
      "scripts/check-incident-gates.mjs",
      join(root, "scripts/check-incident-gates.mjs"),
    );
    const run = () =>
      spawnSync("node", [join(root, "scripts/check-incident-gates.mjs"), "--open"], {
        encoding: "utf8",
      });
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("INCIDENT_OPEN unavailable errors=1");
    expect(missing.stdout).not.toContain("count=0");
    writeFileSync(join(root, INCIDENT_LIST), "# 清单\n\n没有表格\n");
    const noTable = run();
    expect(noTable.status).toBe(1);
    expect(noTable.stdout).toContain("INCIDENT_OPEN unavailable");
    expect(noTable.stdout).not.toContain("count=0");
  });

  it("reports a list path that is a directory instead of crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "incident-gates-"));
    roots.push(root);
    mkdirSync(join(root, INCIDENT_LIST), { recursive: true });
    expect(checkIncidentGates({ root })).toEqual({
      incidents: [],
      errors: [`INCIDENT_LIST_UNREADABLE ${INCIDENT_LIST}`],
    });
  });

  it("refuses an argument it does not know instead of ignoring it", () => {
    const result = spawnSync("node", ["scripts/check-incident-gates.mjs", "--Open"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INCIDENT_ARGUMENT_UNKNOWN --Open");
    expect(result.stdout).toBe("");
  });

  it("withholds the open list when the list can be read but fails a check", () => {
    const root = fixture([
      row({}),
      row({ id: "I-02", state: "缺门槛", gate: "无", symptom: "未结的现象" }),
      row({ id: "I-03", state: "已落门槛", gate: "`scripts/missing-gate.mjs`" }),
    ]);
    copyFileSync(
      "scripts/check-incident-gates.mjs",
      join(root, "scripts/check-incident-gates.mjs"),
    );
    const result = spawnSync("node", [join(root, "scripts/check-incident-gates.mjs"), "--open"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INCIDENT_GATE_PATH_MISSING I-03 scripts/missing-gate.mjs");
    expect(result.stdout).toContain("INCIDENT_OPEN unavailable errors=1");
    expect(result.stdout).not.toContain("I-02");
    expect(result.stdout).not.toContain("count=");
  });

  it("checks the repository's own list", () => {
    expect(checkIncidentGates().errors).toEqual([]);
  });
});

describe("a repeat needs a gate that runs by itself", () => {
  it("refuses a closed repeat whose named gate nothing runs", () => {
    const root = fixture([row({ count: "2" })]);
    expect(checkIncidentGates({ root }).errors).toEqual(["INCIDENT_GATE_NOT_AUTOMATIC I-01"]);
  });

  it("accepts a test file, or a script that package.json, a hook or a workflow runs", () => {
    const test = fixture([row({ count: "2", gate: "`scripts/gate.test.mjs`" })], {
      files: ["scripts/gate.test.mjs"],
    });
    expect(checkIncidentGates({ root: test }).errors).toEqual([]);
    const wired = fixture([row({ count: "5" })]);
    writeFileSync(
      join(wired, "package.json"),
      JSON.stringify({ scripts: { check: "node scripts/gate.mjs" } }),
    );
    expect(checkIncidentGates({ root: wired }).errors).toEqual([]);
    const hooked = fixture([row({ count: "3" })]);
    mkdirSync(join(hooked, "scripts/git-hooks"), { recursive: true });
    writeFileSync(join(hooked, "scripts/git-hooks/pre-push"), "node scripts/gate.mjs\n");
    expect(checkIncidentGates({ root: hooked }).errors).toEqual([]);
  });
});

describe("commit messages say which incident they are about", () => {
  const known = new Map([
    ["I-01", "1"],
    ["I-02", "2"],
  ]);

  it("refuses a message without an Incident line, a malformed value or an unknown incident", () => {
    expect(checkCommitMessage("fix: something\n", known)).toEqual([
      "INCIDENT_TRAILER_MISSING commit-msg",
    ]);
    expect(checkCommitMessage("fix: x\n\n# Incident: none\n", known)).toEqual([
      "INCIDENT_TRAILER_MISSING commit-msg",
    ]);
    expect(checkCommitMessage("fix: x\n\nIncident: 第三次\n", known)).toEqual([
      "INCIDENT_TRAILER_INVALID commit-msg 第三次",
    ]);
    expect(checkCommitMessage("fix: x\n\nIncident: I-09\n", known)).toEqual([
      "INCIDENT_TRAILER_UNKNOWN commit-msg I-09",
    ]);
  });

  it("accepts none, a known incident or a follow-up", () => {
    expect(checkCommitMessage("feat: x\n\nIncident: none\n", known)).toEqual([]);
    expect(checkCommitMessage("fix: x\n\nIncident: I-01\n", known)).toEqual([]);
    expect(checkCommitMessage("fix: x\n\nIncident-follow-up: I-01\n", known)).toEqual([]);
  });

  it("asks a fix for the second occurrence of an incident to name the assumption that was wrong", () => {
    expect(checkCommitMessage("fix: x\n\nIncident: I-02\n", known)).toEqual([
      "INCIDENT_PREMISE_MISSING commit-msg I-02",
    ]);
    expect(checkCommitMessage("fix: x\n\nIncident: I-02\nPremise:\n", known)).toEqual([
      "INCIDENT_PREMISE_MISSING commit-msg I-02",
    ]);
    expect(
      checkCommitMessage("fix: x\n\nIncident: I-02\nPremise: 以为重试会读到新配置\n", known),
    ).toEqual([]);
    expect(checkCommitMessage("fix: x\n\nIncident-follow-up: I-02\n", known)).toEqual([]);
  });

  it("the repository's commit-msg hook runs this check", () => {
    expect(readFileSync("scripts/git-hooks/commit-msg", "utf8")).toContain(
      'node "$root/scripts/check-incident-gates.mjs" --commit-msg "$1" || exit 1',
    );
  });

  it("the command refuses a message file without an Incident line and accepts one with it", () => {
    const root = historyFixture();
    const message = join(root, "message.txt");
    writeFileSync(message, "fix: x\n");
    const refused = spawnSync("node", [join(root, RULE_FILE), "--commit-msg", message], {
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("INCIDENT_TRAILER_MISSING commit-msg");
    expect(refused.stderr).toContain("INCIDENT_TRAILER_HELP");
    writeFileSync(message, "fix: x\n\nIncident: I-01\n");
    const accepted = spawnSync("node", [join(root, RULE_FILE), "--commit-msg", message], {
      encoding: "utf8",
    });
    expect(accepted.status).toBe(0);
  });
});

const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
const git = (cwd, args, extra = []) =>
  execFileSync("git", [...identity, ...extra, ...args], { cwd, encoding: "utf8" });

function commit(root, message, { file = "work.txt", committer } = {}) {
  writeFileSync(join(root, file), `${message}\n${Math.random()}\n`);
  git(root, ["add", "-A"]);
  const env = committer
    ? { ...process.env, GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: committer }
    : process.env;
  execFileSync("git", [...identity, "commit", "-q", "--no-verify", "-m", message], {
    cwd: root,
    env,
  });
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function setList(root, rows) {
  writeFileSync(join(root, INCIDENT_LIST), `# 清单\n\n${header}\n${rows.join("\n")}\n`);
}

function historyFixture(rows = [row({})]) {
  const root = mkdtempSync(join(tmpdir(), "incident-history-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/gate.mjs"), "");
  setList(root, rows);
  git(root, ["init", "-q", "-b", "main"]);
  commit(root, "before the rule, no Incident line");
  copyFileSync(RULE_FILE, join(root, RULE_FILE));
  commit(root, "add the rule\n\nIncident: none");
  return root;
}

const history = (root) =>
  checkIncidentHistory({ root, incidents: checkIncidentGates({ root }).incidents });

describe("repeat counts come from the commit history", () => {
  it("passes when commits before the rule have no Incident line and later ones do", () => {
    const root = historyFixture();
    commit(root, "fix: one\n\nIncident: I-01");
    expect(history(root)).toEqual([]);
  });

  it("refuses a commit after the rule without an Incident line", () => {
    const root = historyFixture();
    const sha = commit(root, "fix: forgot");
    expect(history(root)).toEqual([`INCIDENT_TRAILER_MISSING ${sha.slice(0, 12)}`]);
  });

  it("does not ask commits GitHub made, or branch work older than the rule, for the line", () => {
    const root = historyFixture();
    git(root, ["checkout", "-q", "-b", "old", "HEAD~1"]);
    commit(root, "old branch work", { file: "old.txt" });
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "old"]);
    commit(root, "Squash made on GitHub", { committer: "noreply@github.com" });
    expect(history(root)).toEqual([]);
  });

  it("refuses a table count lower than the commits that name the incident, and a follow-up does not count", () => {
    const root = historyFixture();
    const first = commit(root, "fix: one\n\nIncident: I-01");
    const second = commit(root, "fix: two\n\nIncident: I-01\nIncident: I-01");
    commit(root, "fix: more of two\n\nIncident-follow-up: I-01");
    expect(history(root)).toEqual([
      `INCIDENT_COUNT_BELOW_HISTORY I-01 table=1 commits=2 ${second.slice(0, 12)},${first.slice(0, 12)}`,
    ]);
    setList(root, [row({ count: "2" })]);
    expect(history(root)).toEqual([]);
  });

  it("turns the second counted commit into the hard-gate refusal", () => {
    const root = historyFixture([row({ count: "2", state: "缺门槛", gate: "无" })]);
    for (const n of [1, 2]) commit(root, `fix: ${n}\n\nIncident: I-01`);
    const result = spawnSync("node", [join(root, RULE_FILE)], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INCIDENT_REPEAT_WITHOUT_HARD_GATE I-01 count=2");
  });

  it("moves a pushed commit's count to the new number when a later commit renumbers it after two branches took the same number", () => {
    const root = historyFixture([row({}), row({ id: "I-02" })]);
    const theirs = commit(root, "fix: theirs\n\nIncident: I-01");
    const mine = commit(root, "fix: mine\n\nIncident: I-01");
    expect(history(root)).toEqual([
      `INCIDENT_COUNT_BELOW_HISTORY I-01 table=1 commits=2 ${mine.slice(0, 12)},${theirs.slice(0, 12)}`,
    ]);
    commit(
      root,
      `docs: renumber\n\nIncident-follow-up: I-02\nIncident-renumbered: ${mine.slice(0, 12)} I-01 I-02`,
    );
    expect(history(root)).toEqual([]);
  });

  it("refuses a renumbering that names no commit counted under the old number", () => {
    const root = historyFixture([row({}), row({ id: "I-02" })]);
    const other = commit(root, "fix: other\n\nIncident: none");
    const sha = commit(
      root,
      `docs: renumber\n\nIncident: none\nIncident-renumbered: ${other.slice(0, 12)} I-01 I-02`,
    );
    commit(root, "docs: bad\n\nIncident: none\nIncident-renumbered: abc I-01");
    expect(history(root)).toEqual([
      expect.stringMatching(/^INCIDENT_TRAILER_INVALID [0-9a-f]{12} abc I-01$/),
      `INCIDENT_RENUMBER_UNMATCHED ${sha.slice(0, 12)} ${other.slice(0, 12)} I-01`,
    ]);
  });

  it("refuses a recorded second occurrence whose commit names no wrong assumption", () => {
    const root = historyFixture();
    commit(root, "fix: one\n\nIncident: I-01");
    setList(root, [row({ count: "2" })]);
    const missing = commit(root, "fix: two\n\nIncident: I-01");
    expect(history(root)).toEqual([`INCIDENT_PREMISE_MISSING ${missing.slice(0, 12)} I-01`]);
    setList(root, [row({ count: "3" })]);
    commit(root, "fix: three\n\nIncident: I-01\nPremise: 以为缓存每次都清空");
    expect(history(root)).toEqual([`INCIDENT_PREMISE_MISSING ${missing.slice(0, 12)} I-01`]);
  });

  it("does not ask commits from before the premise rule for a Premise line", () => {
    const root = mkdtempSync(join(tmpdir(), "incident-premise-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/gate.mjs"), "");
    setList(root, [row({ count: "2" })]);
    git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(
      join(root, RULE_FILE),
      readFileSync(RULE_FILE, "utf8").replaceAll(PREMISE_MARK, "PREMISE_RULE_NOT_YET"),
    );
    commit(root, "add the trailer rule only\n\nIncident: none");
    commit(root, "fix: two before the premise rule\n\nIncident: I-01");
    copyFileSync(RULE_FILE, join(root, RULE_FILE));
    commit(root, "add the premise rule\n\nIncident: none");
    expect(history(root)).toEqual([]);
  });

  it("replays PR 809: a missed Premise line is supplied by a later commit instead of a rewrite", () => {
    const root = historyFixture();
    commit(root, "fix: one\n\nIncident: I-01");
    setList(root, [row({ count: "2" })]);
    const missing = commit(root, "fix: two\n\nIncident: I-01");
    expect(history(root)).toEqual([`INCIDENT_PREMISE_MISSING ${missing.slice(0, 12)} I-01`]);
    commit(
      root,
      `docs: name the wrong assumption\n\nIncident-follow-up: I-01\nIncident-amend: ${missing.slice(0, 12)} Premise: 以为副本里的租约已经过期`,
    );
    expect(history(root)).toEqual([]);
  });

  it("replays I-129: a pushed commit naming the wrong incident is pointed at the right one later", () => {
    const root = historyFixture([row({}), row({ id: "I-02" })]);
    const wrong = commit(root, "fix: x\n\nIncident: I-77");
    expect(history(root)).toEqual([`INCIDENT_TRAILER_UNKNOWN ${wrong.slice(0, 12)} I-77`]);
    commit(
      root,
      `chore: right id\n\nIncident: none\nIncident-amend: ${wrong.slice(0, 7)} Incident: I-02`,
    );
    expect(history(root)).toEqual([]);
    const forgot = commit(root, "fix: forgot");
    commit(root, `chore: add the line\n\nIncident: none\nIncident-amend: ${forgot} Incident: none`);
    expect(history(root)).toEqual([]);
  });

  it("refuses an amendment that names no commit or is written wrong", () => {
    const root = historyFixture();
    const bad = commit(root, "chore: x\n\nIncident: none\nIncident-amend: abcdef1 Premise: 想错了");
    const odd = commit(root, "chore: y\n\nIncident: none\nIncident-amend: Premise: 没写提交");
    expect(history(root)).toEqual([
      `INCIDENT_AMEND_TARGET_UNKNOWN ${bad.slice(0, 12)} abcdef1`,
      `INCIDENT_TRAILER_INVALID ${odd.slice(0, 12)} Incident-amend: Premise: 没写提交`,
    ]);
    const message = join(root, "message.txt");
    writeFileSync(message, "chore\n\nIncident: none\nIncident-amend: abcdef1 Premise: 想错了\n");
    const refused = spawnSync("node", [join(root, RULE_FILE), "--commit-msg", message], {
      cwd: root,
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("INCIDENT_AMEND_TARGET_UNKNOWN commit-msg abcdef1");
  });

  it("refuses an Incident line naming an incident the list does not have", () => {
    const root = historyFixture();
    const sha = commit(root, "fix: x\n\nIncident: I-77");
    expect(history(root)).toEqual([`INCIDENT_TRAILER_UNKNOWN ${sha.slice(0, 12)} I-77`]);
  });

  it("refuses to judge from a shallow clone instead of counting too few", () => {
    const root = historyFixture();
    commit(root, "fix: one\n\nIncident: I-01");
    const shallow = mkdtempSync(join(tmpdir(), "incident-shallow-"));
    roots.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, shallow]);
    expect(history(shallow)[0]).toMatch(/^INCIDENT_HISTORY_SHALLOW /);
  });

  it("refuses outside a git checkout", () => {
    const root = fixture([row({})]);
    expect(history(root)[0]).toMatch(/^INCIDENT_HISTORY_UNAVAILABLE /);
  });

  it("the repository's own history agrees with the list", () => {
    expect(checkIncidentHistory({ incidents: checkIncidentGates().incidents })).toEqual([]);
  });
});
