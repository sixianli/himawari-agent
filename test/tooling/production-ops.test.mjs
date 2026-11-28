import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const operations = path.resolve(import.meta.dirname, "../../scripts/operations");
const script = path.join(operations, "production-ops.sh");
const opener = path.join(operations, "open-ops-diagnostics.sh");
const directories = [];

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "production-ops-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function keys(directory) {
  const privateKey = path.join(directory, "private.pem");
  const publicKey = path.join(directory, "public.pem");
  expect(
    spawnSync("openssl", [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      privateKey,
    ]).status,
  ).toBe(0);
  expect(
    spawnSync("openssl", ["pkey", "-in", privateKey, "-pubout", "-out", publicKey]).status,
  ).toBe(0);
  return { privateKey, publicKey };
}

function fakes(directory) {
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(directory, "calls");
  writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/bash\necho "systemctl $*" >> ${JSON.stringify(log)}\ncase "$1" in\n  show) echo "ActiveState=active"; echo "SubState=running" ;;\n  is-active) echo active ;;\n  restart) ;;\nesac\n`,
  );
  writeFileSync(
    path.join(bin, "journalctl"),
    `#!/bin/bash\necho 'owner said: my secret dinner plans {"event":"device.stream_opened","lastDrop":"silent"}'\necho '{"event":"device.stream_closed","code":"RUN_STUCK"}'\n`,
  );
  chmodSync(path.join(bin, "systemctl"), 0o755);
  chmodSync(path.join(bin, "journalctl"), 0o755);
  return { bin, log };
}

function run(action, directory, extra = {}) {
  const { bin } = fakes(directory);
  const { publicKey, privateKey } = keys(directory);
  const child = spawnSync("bash", [script, action], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HIMAWARI_OPS_PUBLIC_KEY: publicKey,
      HIMAWARI_OPS_SYSTEMCTL: path.join(bin, "systemctl"),
      HIMAWARI_OPS_JOURNALCTL: path.join(bin, "journalctl"),
      HIMAWARI_OPS_NODE: path.join(directory, "no-node"),
      HIMAWARI_OPS_START_WAIT: "4",
      ...extra,
    },
  });
  return { child, privateKey };
}

describe("production-ops", () => {
  it("prints only content-free names and counts in the clear and seals the journal for the key holder", () => {
    const directory = temporary();
    const { child, privateKey } = run("diagnose", directory);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("OPS_SERVICE himawari-prod.service ActiveState=active");
    expect(child.stdout).toContain('"event":"device.stream_opened"=1');
    expect(child.stdout).toContain('"code":"RUN_STUCK"=1');
    expect(child.stdout).not.toContain("secret dinner");
    expect(child.stdout).toContain("OPS_DONE");
    const log = path.join(directory, "ops.log");
    writeFileSync(log, child.stdout);
    const opened = spawnSync("bash", [opener, log, privateKey], { encoding: "utf8" });
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain("owner said: my secret dinner plans");
  });

  it("names which model each recent call used and what the configured models allow, without their secrets", () => {
    const directory = temporary();
    const database = path.join(directory, "product.sqlite");
    const seeded = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE runs (id TEXT, thread_id TEXT, status TEXT, created_at TEXT, updated_at TEXT)");
db.exec("CREATE TABLE owner_preferences (model_ref TEXT, thinking_level TEXT, updated_at TEXT)");
db.exec("CREATE TABLE model_invocation_identities (model_ref TEXT, data_classification TEXT, source TEXT, status TEXT, reserved_at TEXT)");
db.prepare("INSERT INTO owner_preferences VALUES (?, ?, ?)").run("kimi-chat", "medium", new Date().toISOString());
db.prepare("INSERT INTO model_invocation_identities VALUES (?, ?, ?, ?, ?)").run("kimi-chat", "private", "agent-stream", "settled", new Date().toISOString());`,
        database,
      ],
      { encoding: "utf8" },
    );
    expect(seeded.status).toBe(0);
    const config = path.join(directory, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        modelDescriptors: [
          {
            ref: "kimi-chat",
            role: "primary",
            provider: "magpie",
            model: "kimi",
            allowedDataClassifications: ["public", "private"],
            secretRef: "magpie-token-value-should-not-print",
          },
        ],
        runPolicy: {
          publicSearch: {
            providers: ["exa-public"],
            providerSecrets: { deepseek: "web-secret-should-not-print" },
          },
        },
      }),
    );
    const { child } = run("diagnose", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_DATABASE: database,
      HIMAWARI_OPS_CONFIG: config,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('OPS_OWNER_MODEL [{"model_ref":"kimi-chat"');
    expect(child.stdout).toContain('"model_ref":"kimi-chat","data_classification":"private"');
    expect(child.stdout).toContain(
      'OPS_MODEL_DESCRIPTORS [{"ref":"kimi-chat","role":"primary","provider":"magpie","model":"kimi","allowedDataClassifications":["public","private"]}]',
    );
    expect(child.stdout).not.toContain("magpie-token-value-should-not-print");
    expect(child.stdout).toContain(
      'OPS_WEB_ROUTES {"publicSearch":{"providers":["exa-public"]},"publicFetch":null}',
    );
    expect(child.stdout).not.toContain("web-secret-should-not-print");
  });

  it("counts each device's sense records by day and kind, sealed, without their content", () => {
    const directory = temporary();
    const database = path.join(directory, "product.sqlite");
    const seeded = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE paired_devices (id TEXT, kind TEXT, status TEXT, last_seen_at TEXT)");
db.exec("CREATE TABLE perception_settings (revision INTEGER, disabled_senses TEXT, paused_from TEXT, paused_until TEXT, limit_overrides TEXT, updated_at TEXT)");
db.exec("CREATE TABLE perception_records (device_id TEXT, type TEXT, capture_source TEXT, occurred_at_ms INTEGER, received_at_ms INTEGER, local_day TEXT, evidence TEXT, status TEXT)");
db.prepare("INSERT INTO paired_devices VALUES (?, ?, ?, ?)").run("dev_phone", "iphone", "active", new Date().toISOString());
db.prepare("INSERT INTO perception_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("dev_phone", "health.sample", "sensor", Date.now(), Date.now(), "2026-11-28", JSON.stringify({ subtype: "sleep", value: 420, note: "slept badly after the party" }), "active");`,
        database,
      ],
      { encoding: "utf8" },
    );
    expect(seeded.status).toBe(0);
    const { child, privateKey } = run("senses", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_DATABASE: database,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).not.toContain("health.sample");
    expect(child.stdout).not.toContain("secret dinner");
    const log = path.join(directory, "ops.log");
    writeFileSync(log, child.stdout);
    const opened = spawnSync("bash", [opener, log, privateKey], { encoding: "utf8" });
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain('"type":"health.sample","subtype":"sleep"');
    expect(opened.stdout).toContain('SENSES_DEVICES [{"id":"dev_phone","kind":"iphone"');
    expect(opened.stdout).not.toContain("slept badly");
  });

  it("collects before it restarts and confirms the service came back", () => {
    const directory = temporary();
    const { child } = run("restart", directory, {
      HIMAWARI_OPS_LOCK: path.join(directory, "deploy.lock"),
    });
    expect(child.status).toBe(0);
    const calls = readFileSync(path.join(directory, "calls"), "utf8");
    expect(calls).toContain("systemctl restart himawari-prod.service");
    expect(child.stdout.indexOf("OPS_SEALED_BEGIN")).toBeLessThan(
      child.stdout.indexOf("OPS_RESTARTED"),
    );
  });

  it("does not restart while a deploy holds the lock", async () => {
    const directory = temporary();
    const lock = path.join(directory, "deploy.lock");
    const ready = path.join(directory, "ready");
    const holder = spawn(
      "bash",
      [
        "-c",
        `exec 9> ${JSON.stringify(lock)}; flock -n 9; touch ${JSON.stringify(ready)}; exec sleep 30`,
      ],
      { stdio: "ignore" },
    );
    try {
      const until = Date.now() + 5000;
      while (Date.now() < until && spawnSync("test", ["-e", ready]).status !== 0)
        spawnSync("sleep", ["0.1"]);
      const { child } = run("restart", directory, { HIMAWARI_OPS_LOCK: lock });
      expect(child.status).toBe(75);
      expect(child.stderr).toContain("OPS_REFUSED BUSY");
      expect(spawnSync("test", ["-e", path.join(directory, "calls")]).status).not.toBe(0);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("backs up the config, lets every model, embedding included, see sensitive content, then restarts", () => {
    const directory = temporary();
    const config = path.join(directory, "config.json");
    const original = {
      ownerId: "owner:one",
      modelDescriptors: [
        {
          ref: "magpie-primary",
          role: "primary",
          allowedDataClassifications: ["public", "private"],
        },
        { ref: "search", role: "primary", allowedDataClassifications: ["public"] },
        {
          ref: "local-embedding",
          role: "embedding",
          allowedDataClassifications: ["public", "private"],
        },
      ],
    };
    writeFileSync(config, JSON.stringify(original));
    const { child } = run("allow-sensitive", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_CONFIG: config,
      HIMAWARI_OPS_LOCK: path.join(directory, "deploy.lock"),
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(
      "OPS_CONFIG_CHANGED allow sensitive for: magpie-primary local-embedding",
    );
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.modelDescriptors.map((entry) => entry.allowedDataClassifications)).toEqual([
      ["public", "private", "sensitive"],
      ["public"],
      ["public", "private", "sensitive"],
    ]);
    const backup = child.stdout.match(/OPS_CONFIG_BACKUP (\S+)/)?.[1];
    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(original);
    expect(readFileSync(path.join(directory, "calls"), "utf8")).toContain(
      "systemctl restart himawari-prod.service",
    );
    expect(child.stdout).toContain("OPS_RESTARTED");

    const again = run("allow-sensitive", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_CONFIG: config,
    }).child;
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("OPS_CONFIG_UNCHANGED");
    expect(again.stdout).not.toContain("OPS_RESTARTED");
  });

  it("refuses anything but its own actions", () => {
    const directory = temporary();
    const { child } = run("stop", directory);
    expect(child.status).toBe(64);
    expect(child.stderr).toContain("OPS_REFUSED ACTION_INVALID");
  });
});
