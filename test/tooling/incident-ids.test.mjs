import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkIncidentGates,
  checkIncidentHistory,
  GENERATED_INCIDENT_ID,
  HAND_PICKED_MARK,
  INCIDENT_LIST,
  RULE_FILE,
} from "../../scripts/check-incident-gates.mjs";
import { addIncident, insertIncidentRow, nextIncidentId } from "../../scripts/new-incident.mjs";

const NEW_INCIDENT = "scripts/new-incident.mjs";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const header = `| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |`;
const row = (id) => `| ${id} | 2026-11-28 | 现象 | 根因 | 1 | 无 | 缺门槛 |`;
const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
const git = (root, args) =>
  execFileSync("git", [...identity, ...args], { cwd: root, encoding: "utf8" });

function writeList(root, ids) {
  writeFileSync(
    join(root, INCIDENT_LIST),
    `# 清单\n\n${header}\n${ids.map(row).join("\n")}\n\n后文\n`,
  );
}

function commit(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
}

function repository(ids) {
  const root = mkdtempSync(join(tmpdir(), "incident-ids-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeList(root, ids);
  git(root, ["init", "-q", "-b", "main"]);
  commit(root, "list before the id rule\n\nIncident: none");
  return root;
}

function addRule(root) {
  copyFileSync(RULE_FILE, join(root, RULE_FILE));
  copyFileSync(NEW_INCIDENT, join(root, NEW_INCIDENT));
  commit(root, "add the id rule\n\nIncident: none");
}

function appendRow(root, id) {
  const file = join(root, INCIDENT_LIST);
  writeFileSync(file, insertIncidentRow(readFileSync(file, "utf8"), row(id)));
}

const history = (root) =>
  checkIncidentHistory({ root, incidents: checkIncidentGates({ root }).incidents });
const picked = (root) => history(root).filter((error) => error.startsWith(HAND_PICKED_MARK));

describe("incident:new hands out ids no other thread can pick", () => {
  it("makes a dated id with a random suffix and skips one already taken", () => {
    const now = new Date("2026-11-27T16:30:00Z");
    const picks = [0, 0, 0, 0, 1, 2, 3, 4];
    const pick = () => picks.shift();
    const id = nextIncidentId(new Set(["I-261128-aaaa"]), { now, pick });
    expect(id).toBe("I-261128-bcde");
    expect(GENERATED_INCIDENT_ID.test(id)).toBe(true);
  });

  it("adds an open row at the end of the table and refuses text that would break the table", () => {
    const root = repository(["I-01"]);
    const id = addIncident("上线停在 S6", { root, now: new Date("2026-11-28T03:00:00Z") });
    const text = readFileSync(join(root, INCIDENT_LIST), "utf8");
    expect(text).toContain(`| I-01 |`);
    expect(text).toContain(
      `| ${id} | 2026-11-28 | 上线停在 S6 | 待查 | 1 | 待定 | 缺门槛 |\n\n后文`,
    );
    expect(checkIncidentGates({ root }).errors).toEqual([]);
    expect(() => addIncident("a | b", { root })).toThrow("INCIDENT_NEW_SYMPTOM_INVALID");
    expect(() => addIncident("  ", { root })).toThrow("INCIDENT_NEW_SYMPTOM_INVALID");
  });

  it("runs as a command and prints the id it wrote", () => {
    const root = repository(["I-01"]);
    addRule(root);
    const result = spawnSync("node", [join(root, NEW_INCIDENT), "Mac", "出包超时"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const id = result.stdout.trim();
    expect(GENERATED_INCIDENT_ID.test(id)).toBe(true);
    expect(readFileSync(join(root, INCIDENT_LIST), "utf8")).toContain(`| ${id} |`);
    const refused = spawnSync("node", [join(root, NEW_INCIDENT)], { cwd: root, encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("INCIDENT_NEW_SYMPTOM_INVALID");
  });
});

describe("a number picked by hand cannot enter the list once the id rule is in", () => {
  it("replays I-129: two threads that both took the next number are refused, incident:new ids pass", () => {
    const root = repository(["I-127", "I-128"]);
    addRule(root);
    for (const branch of ["iphone", "other"]) {
      git(root, ["checkout", "-q", "-b", branch, "main"]);
      appendRow(root, "I-129");
      commit(root, `record I-129 on ${branch}\n\nIncident: I-129`);
    }
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "other"]);
    expect(picked(root)).toEqual([expect.stringMatching(/^INCIDENT_ID_HAND_PICKED I-129 /)]);

    git(root, ["reset", "-q", "--hard", "HEAD~1"]);
    const ids = [];
    for (const branch of ["iphone-new", "other-new"]) {
      git(root, ["checkout", "-q", "-b", branch, "main"]);
      const id = addIncident("现象", { root });
      ids.push(id);
      commit(root, `record ${id}\n\nIncident: ${id}`);
    }
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "iphone-new"]);
    spawnSync("git", [...identity, "merge", "-q", "--no-ff", "--no-edit", "other-new"], {
      cwd: root,
    });
    writeList(root, ["I-127", "I-128", ...ids]);
    commit(root, "Merge other-new, keeping both rows");
    expect(new Set(ids).size).toBe(2);
    expect(history(root)).toEqual([]);
  });

  it("keeps old numbers and a numbered row a branch added before the rule", () => {
    const root = repository(["I-01"]);
    git(root, ["checkout", "-q", "-b", "older"]);
    appendRow(root, "I-02");
    commit(root, "record I-02 before the rule\n\nIncident: none");
    git(root, ["checkout", "-q", "main"]);
    addRule(root);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "older"]);
    expect(picked(root)).toEqual([]);
  });

  it("keeps a numbered row written while resolving a merge on a branch from before the rule", () => {
    const root = repository(["I-01"]);
    git(root, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(root, "side.txt"), "side\n");
    commit(root, "side work\n\nIncident: none");
    git(root, ["checkout", "-q", "-b", "older", "main"]);
    writeFileSync(join(root, "older.txt"), "older\n");
    commit(root, "older work\n\nIncident: none");
    git(root, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    appendRow(root, "I-02");
    commit(root, "Merge side, recording I-02 while resolving");
    git(root, ["checkout", "-q", "main"]);
    addRule(root);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "older"]);
    expect(picked(root)).toEqual([]);
  });

  it("refuses a hand-picked row in the commit hook before it is committed", () => {
    const root = repository(["I-01"]);
    addRule(root);
    appendRow(root, "I-02");
    const message = join(root, "message.txt");
    writeFileSync(message, "record\n\nIncident: none\n");
    const refused = spawnSync("node", [join(root, RULE_FILE), "--commit-msg", message], {
      cwd: root,
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${HAND_PICKED_MARK} I-02`);
    writeList(root, ["I-01"]);
    addIncident("现象", { root });
    const accepted = spawnSync("node", [join(root, RULE_FILE), "--commit-msg", message], {
      cwd: root,
      encoding: "utf8",
    });
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
  });
});
