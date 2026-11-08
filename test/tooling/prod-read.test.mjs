import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/operations/prod-read.sh");
const runId = "run:9f2c41d07ab3e5681c0d4b7a2e9f5603";
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function run(...args) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-"));
  directories.push(directory);
  const calls = path.join(directory, "calls");
  const input = path.join(directory, "input");
  writeFileSync(
    path.join(directory, "ssh"),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${calls}\ncat > ${input}\n`,
  );
  chmodSync(path.join(directory, "ssh"), 0o755);
  const child = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${directory}:/usr/bin:/bin` },
  });
  const read = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return { code: child.status, stderr: child.stderr, calls: read(calls), input: read(input) };
}

describe("prod-read.sh", () => {
  it("reads the service state with one fixed remote command", () => {
    const result = run("status");
    expect(result.code).toBe(0);
    expect(result.calls).toBe(
      "-o BatchMode=yes -o ConnectTimeout=20 root@84.247.157.41 /usr/bin/systemctl show himawari-prod.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp\n",
    );
  });

  it("searches the journal of the production service only", () => {
    const result = run("journal", "17a4102d", "20");
    expect(result.code).toBe(0);
    expect(result.calls).toContain(
      "/usr/bin/journalctl -u himawari-prod.service --no-pager -g '17a4102d' -n 20",
    );
  });

  it.each([
    ["journal", "x'; rm -rf /; echo '"],
    ["journal", "a b"],
    ["journal", "$(id)"],
    ["journal", "ab"],
    ["journal", "valid-pattern", "0"],
    ["journal", "valid-pattern", "201"],
    ["journal", "valid-pattern", "5; id"],
    ["run", "run:1; id"],
    ["run", "run:"],
    ["run", `run:${"a".repeat(121)}`],
    ["journal", "bad\u001b[31mpattern"],
    ["run", "17a4102d-1cb7-4487-ba7d-97074306d1bc"],
    ["columns", "runs; DROP TABLE runs"],
    ["columns", "Runs"],
    ["rows", "runs", "x'; id; '"],
    ["rows", "runs;id", runId],
  ])("refuses %s with unsafe input before any connection", (...args) => {
    const result = run(...args);
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("PROD_READ_REFUSED");
    expect(result.calls).toBe("");
  });

  it.each([
    [[]],
    [["unknown"]],
    [["status", "extra"]],
    [["runs-open", "extra"]],
    [["run"]],
    [["mounts", "-x"]],
  ])("shows usage and does not connect for %j", (args) => {
    const result = run(...args);
    expect(result.code).toBe(64);
    expect(result.calls).toBe("");
  });

  it("sends a fixed read-only database script and passes only validated words", () => {
    const result = run("rows", "runs", runId);
    expect(result.code).toBe(0);
    expect(result.calls).toBe(
      `-o BatchMode=yes -o ConnectTimeout=20 root@84.247.157.41 cd /tmp && /opt/himawari/node/bin/node --no-warnings - rows runs ${runId}\n`,
    );
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).toContain("/var/lib/himawari/state/data/product.sqlite");
    expect(result.input).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/);
  });

  it("accepts the run id format that production writes (run: plus 32 hex digits)", () => {
    const result = run("run", runId);
    expect(result.code).toBe(0);
    expect(result.calls).toContain(`--no-warnings - run ${runId}`);
  });

  it("does not echo raw control characters of a refused value", () => {
    const result = run("journal", "bad\u001b[31mpattern");
    expect(result.code).toBe(65);
    expect(result.stderr).not.toContain("\u001b");
  });

  it("reads columns of one table and uses 40 journal lines by default", () => {
    const columns = run("columns", "runs");
    expect(columns.code).toBe(0);
    expect(columns.calls).toContain("--no-warnings - columns runs");
    const journal = run("journal", "17a4102d");
    expect(journal.calls).toContain("-g '17a4102d' -n 40");
  });

  it("answers the fixed queries without arguments", () => {
    for (const query of ["runs-summary", "runs-open", "tables"]) {
      const result = run(query);
      expect(result.code).toBe(0);
      expect(result.calls).toContain("--no-warnings - ");
    }
    for (const query of ["mounts", "disk"]) {
      const result = run(query);
      expect(result.code).toBe(0);
      expect(result.calls).toMatch(/\/usr\/bin\/(findmnt|df -h)\n$/);
    }
  });
});
