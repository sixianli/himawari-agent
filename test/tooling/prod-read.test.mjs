import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/operations/prod-read.sh");
const migrations = path.resolve(
  import.meta.dirname,
  "../../packages/persistence-sqlite/src/migrations",
);
const runId = "run:9f2c41d07ab3e5681c0d4b7a2e9f5603";
const directories = [];

function readConfig(input, file, serviceUid = String(process.getuid())) {
  return spawnSync(process.execPath, ["--no-warnings", "-", file, serviceUid], {
    input,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function migratedDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-db-"));
  directories.push(directory);
  const file = path.join(directory, "product.sqlite");
  const database = new DatabaseSync(file);
  database.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY");
  for (const name of readdirSync(migrations)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    database.exec(readFileSync(path.join(migrations, name), "utf8"));
  database.exec("PRAGMA foreign_keys = OFF");
  return { file, database };
}

function runWith(environment, ...args) {
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
    env: { PATH: `${directory}:/usr/bin:/bin`, ...environment },
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

function run(...args) {
  return runWith({ HIMAWARI_PROD_HOST: "198.51.100.9" }, ...args);
}

describe("prod-read.sh", () => {
  it("refuses to connect when no production host is given", () => {
    const result = runWith({}, "status");
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("PROD_READ_REFUSED");
    expect(result.calls).toBe("");
  });

  it("refuses an unsafe production host before any connection", () => {
    const result = runWith({ HIMAWARI_PROD_HOST: "a;id" }, "status");
    expect(result.code).toBe(65);
    expect(result.calls).toBe("");
  });

  it("takes the production host from HIMAWARI_PACKET_HOST when HIMAWARI_PROD_HOST is not set", () => {
    const result = runWith({ HIMAWARI_PACKET_HOST: "203.0.113.5" }, "status");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("root@203.0.113.5 ");
  });

  it("reads the service state with one fixed remote command", () => {
    const result = run("status");
    expect(result.code).toBe(0);
    expect(result.calls).toBe(
      "-o BatchMode=yes -o ConnectTimeout=20 root@198.51.100.9 /usr/bin/systemctl show himawari-prod.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp\n",
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
      `-o BatchMode=yes -o ConnectTimeout=20 root@198.51.100.9 cd /tmp && /opt/himawari/node/bin/node --no-warnings - rows runs ${runId}\n`,
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
    expect(result.calls).toContain("--no-warnings - rule-memories");
    expect(result.input).not.toContain("content_ref");
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).toMatch(/LIMIT 500\b/);
    expect(result.input).toContain("ORDER BY recorded_at DESC, id");
    const { file, database } = migratedDatabase();
    const insert = database.prepare(
      "INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref, classification, inference, confidence_permille, policy_version, updated_at, category, importance_permille, recorded_at, tentative, use_count) VALUES (?, 'o', 'a', 1, ?, ?, 'private', 0, 900, 'p', ?, ?, 900, ?, 0, 2)",
    );
    insert.run("m1", "active", "secret-ref", "2026-11-01", "rule", "2026-11-01");
    insert.run("m2", "active", "other-ref", "2026-11-02", "preference", "2026-11-02");
    database.exec("BEGIN");
    for (let index = 0; index < 501; index += 1) {
      const stamp = "2026-12-" + String(index).padStart(4, "0");
      insert.run("bulk" + index, "active", "r", stamp, "rule", stamp);
    }
    database.exec("COMMIT");
    database.close();
    const script = result.input.replace("/var/lib/himawari/state/data/product.sqlite", file);
    const child = spawnSync(process.execPath, ["--no-warnings", "-", "rule-memories"], {
      input: script,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const rows = JSON.parse(child.stdout);
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe("bulk500");
    expect(rows.map((row) => row.id)).not.toContain("m1");
    expect(child.stdout).not.toContain("secret-ref");
  });

  it("lists Gmail decision records as metadata only, running the script read-only", () => {
    const result = run("gmail-decisions");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-warnings - gmail-decisions");
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).toMatch(/LIMIT 100\b/);
    const { file, database } = migratedDatabase();
    const inputs = JSON.stringify({
      floorHits: { "mail-a_1": ["rule-1", "rule-2"] },
      memoryByMail: { "mail-a_1": ["m1"] },
      relatedByMail: {},
    });
    database
      .prepare(
        "INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code, inputs, cost_micros, duration_ms) VALUES (?, 'o', 'a', 'proactive', 'gmail', '2026-11-01T00:00:00.000Z', '{}', 'pushed', 'fixture', ?, 0, 0)",
      )
      .run("d1", inputs);
    database
      .prepare(
        "INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, processed_at, owner_rating) VALUES ('o', 'a', 'gmail', ?, 't', 'd1', 'act', NULL, '2026-11-01T00:00:00.000Z', 'useful')",
      )
      .run("mail-a_1");
    database
      .prepare(
        "INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code, inputs, cost_micros, duration_ms) VALUES ('d2', 'o', 'a', 'proactive', 'gmail', '2026-11-02T00:00:00.000Z', '{}', 'pushed', 'fixture', ?, 0, 0)",
      )
      .run(
        JSON.stringify({ floorHits: { 'q"x': ["rule-1"] }, memoryByMail: {}, relatedByMail: {} }),
      );
    database
      .prepare(
        "INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, processed_at, owner_rating) VALUES ('o', 'a', 'gmail', 'q\"x', 't', 'd2', 'know', NULL, '2026-11-02T00:00:00.000Z', NULL)",
      )
      .run();
    database.close();
    const script = result.input.replace("/var/lib/himawari/state/data/product.sqlite", file);
    const child = spawnSync(process.execPath, ["--no-warnings", "-", "gmail-decisions"], {
      input: script,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const rows = JSON.parse(child.stdout);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.message_id === 'q"x')).toMatchObject({ rule_count: 1 });
    expect(rows.find((row) => row.message_id === "mail-a_1")).toMatchObject({
      message_id: "mail-a_1",
      outcome: "act",
      owner_rating: "useful",
      rule_count: 2,
      memory_count: 1,
      related_count: 0,
      muse_entries: 0,
    });
  });

  it("prints only the system instruction text of the production configuration", () => {
    const result = run("system-instruction");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-warnings - /etc/himawari/config.json $(id -u himawari-prod)");
    const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-cfg-"));
    directories.push(directory);
    const file = path.join(directory, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        runPolicy: { systemInstruction: "hello" },
        secretReferences: { a: "token-value" },
      }),
      { mode: 0o600 },
    );
    const child = readConfig(result.input, file);
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("hello\n");
    writeFileSync(file, JSON.stringify({ runPolicy: {} }));
    const missing = readConfig(result.input, file);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    writeFileSync(
      file,
      JSON.stringify({ configuration: { runPolicy: { systemInstruction: "nested" } } }),
    );
    const nested = readConfig(result.input, file);
    expect(nested.status).not.toBe(0);
    expect(nested.stdout).toBe("");
    writeFileSync(file, "{ not json token-value");
    const broken = readConfig(result.input, file);
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain("PROD_READ_CONFIG_UNREADABLE");
    expect(broken.stderr).not.toContain("token-value");
    writeFileSync(file, JSON.stringify({ runPolicy: { systemInstruction: "hello" } }));
    const link = path.join(directory, "link.json");
    symlinkSync(file, link);
    const linked = readConfig(result.input, link);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    expect(linked.stdout).toBe("");
    chmodSync(file, 0o666);
    const writable = readConfig(result.input, file);
    expect(writable.stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    chmodSync(file, 0o644);
    expect(readConfig(result.input, file).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    chmodSync(file, 0o600);
    const twin = path.join(directory, "twin.json");
    linkSync(file, twin);
    expect(readConfig(result.input, file).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    rmSync(twin);
    expect(readConfig(result.input, file).stdout).toBe("hello\n");
    chmodSync(directory, 0o777);
    expect(readConfig(result.input, file).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    chmodSync(directory, 0o770);
    expect(readConfig(result.input, file).stdout).toBe("hello\n");
    chmodSync(directory, 0o700);
    const absent = readConfig(result.input, path.join(directory, "absent.json"));
    expect(absent.stderr.trim()).toBe("PROD_READ_CONFIG_UNREADABLE");
  });

  it("accepts only root or the service account as the owner of the configuration file", () => {
    const result = run("system-instruction");
    const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-owner-"));
    directories.push(directory);
    const file = path.join(directory, "config.json");
    writeFileSync(file, JSON.stringify({ runPolicy: { systemInstruction: "hello" } }), {
      mode: 0o600,
    });
    if (process.getuid() === 0) {
      chownSync(file, 12345, 12345);
      expect(readConfig(result.input, file, "999").stderr).toContain("PROD_READ_CONFIG_UNSAFE");
      chownSync(file, 999, 999);
      expect(readConfig(result.input, file, "999").stdout).toBe("hello\n");
    } else {
      const foreign = String(process.getuid() + 1);
      expect(readConfig(result.input, file, foreign).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
    }
  });

  it("lists capabilities as metadata only, running the script read-only", () => {
    const result = run("capabilities");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-warnings - capabilities");
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).not.toContain("record_json");
    const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-db-"));
    directories.push(directory);
    const file = path.join(directory, "product.sqlite");
    const database = new DatabaseSync(file);
    for (const name of readdirSync(migrations)
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      database.exec(readFileSync(path.join(migrations, name), "utf8"));
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        "INSERT INTO capability_declarations (id, owner_id, agent_id, revision, version, integrity, status, declaration_ref, record_json) VALUES ('cap-1', 'o', 'a', 3, '1.0.0', 'sha', 'active', 'ref', '{\"secret\":\"body\"}')",
      )
      .run();
    database.close();
    const script = result.input.replace("/var/lib/himawari/state/data/product.sqlite", file);
    const child = spawnSync(process.execPath, ["--no-warnings", "-", "capabilities"], {
      input: script,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const rows = JSON.parse(child.stdout);
    expect(rows).toEqual([
      { id: "cap-1", status: "active", revision: 3, version: "1.0.0", handle_count: 0 },
    ]);
    expect(child.stdout).not.toContain("secret");
  });

  it("refuses arguments for the two new queries", () => {
    for (const query of [
      "rule-memories",
      "system-instruction",
      "gmail-decisions",
      "capabilities",
    ]) {
      const result = run(query, "extra");
      expect(result.code).toBe(64);
      expect(result.calls).toBe("");
    }
  });
});
