import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

  it("accepts older run id shapes as well", () => {
    for (const id of ["run:dcf2075d-1237-4f10-9e81-b427e0a7368f", "run:bafb641b"]) {
      const result = run("run", id);
      expect(result.code).toBe(0);
      expect(result.calls).toContain(`--no-warnings - run ${id}`);
    }
  });

  it("masks credential-like columns and binary values in the database script", () => {
    const script = run("rows", "runs", runId).input;
    const start = script.indexOf("const hiddenColumn");
    const end = script.indexOf("const tableNames");
    const body = script.slice(start, end);
    const sandbox = new Function(`${body}; return shorten;`)();
    const row = sandbox({
      id: "a",
      auth: "secret-auth",
      p256dh: "key",
      endpoint: "https://example.test/x",
      embedding: new Uint8Array(4),
      payload: new Uint8Array(3),
      account_json: "{}",
      input_tokens: 12,
      fencing_token: 7,
      embedding_model: "m",
      note: "x".repeat(200),
    });
    expect(row.id).toBe("a");
    expect(row.auth).toBe("[hidden]");
    expect(row.p256dh).toBe("[hidden]");
    expect(row.endpoint).toBe("[hidden]");
    expect(row.embedding).toBe("[hidden]");
    expect(row.payload).toBe("[binary 3 bytes]");
    expect(row.account_json).toBe("[hidden]");
    expect(row.input_tokens).toBe(12);
    expect(row.fencing_token).toBe(7);
    expect(row.embedding_model).toBe("m");
    expect(row.note).toHaveLength(163);
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

  it("lists rule-category memories as metadata only, running the script read-only", () => {
    const result = run("rule-memories");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-warnings - rules");
    expect(result.input).not.toContain("content_ref");
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).toContain("LIMIT 500");
    const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-db-"));
    directories.push(directory);
    const file = path.join(directory, "product.sqlite");
    const database = new DatabaseSync(file);
    database.exec(
      "CREATE TABLE memory_records (id TEXT, status TEXT, tentative INTEGER, classification TEXT, importance_permille INTEGER, confidence_permille INTEGER, inference INTEGER, recorded_at TEXT, updated_at TEXT, valid_to TEXT, superseded_by TEXT, use_count INTEGER, category TEXT, content_ref TEXT)",
    );
    database.exec(
      "INSERT INTO memory_records VALUES ('m1','active',0,'private',900,950,0,'2026-11-01','2026-11-01',NULL,NULL,2,'rule','secret-ref'), ('m2','active',0,'private',500,900,0,'2026-11-02','2026-11-02',NULL,NULL,0,'preference','other-ref')",
    );
    database.close();
    const script = result.input.replace("/var/lib/himawari/state/data/product.sqlite", file);
    const child = spawnSync(process.execPath, ["--no-warnings", "-", "rules"], {
      input: script,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const rows = JSON.parse(child.stdout);
    expect(rows.map((row) => row.id)).toEqual(["m1"]);
    expect(child.stdout).not.toContain("secret-ref");
  });

  it("prints only the system instruction text of the production configuration", () => {
    const result = run("system-instruction");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-warnings - /etc/himawari/config.json");
    const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-cfg-"));
    directories.push(directory);
    const file = path.join(directory, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        runPolicy: { systemInstruction: "hello" },
        secretReferences: { a: "token-value" },
      }),
    );
    const child = spawnSync(process.execPath, ["--no-warnings", "-", file], {
      input: result.input,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("hello\n");
    writeFileSync(file, JSON.stringify({ runPolicy: {} }));
    const missing = spawnSync(process.execPath, ["--no-warnings", "-", file], {
      input: result.input,
      encoding: "utf8",
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    writeFileSync(file, JSON.stringify({ configuration: { runPolicy: { systemInstruction: "nested" } } }));
    const nested = spawnSync(process.execPath, ["--no-warnings", "-", file], {
      input: result.input,
      encoding: "utf8",
    });
    expect(nested.status).not.toBe(0);
    expect(nested.stdout).toBe("");
  });

  it("refuses arguments for the two new queries", () => {
    for (const query of ["rule-memories", "system-instruction"]) {
      const result = run(query, "extra");
      expect(result.code).toBe(64);
      expect(result.calls).toBe("");
    }
  });
});
