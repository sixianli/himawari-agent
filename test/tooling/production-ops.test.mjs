import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function mirrorOfMain(directory) {
  const mirror = path.join(directory, "mirror");
  const repository = path.resolve(operations, "../..");
  for (const part of [
    "scripts/operations/heartbeat",
    "scripts/delivery-mode/instances/andy-production.json",
  ])
    cpSync(path.join(repository, part), path.join(mirror, part), {
      recursive: true,
    });
  const git = (...args) =>
    expect(
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", mirror, ...args]).status,
    ).toBe(0);
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "--quiet", "-m", "main");
  rmSync(path.join(mirror, "scripts"), { recursive: true });
  return mirror;
}

function run(action, directory, extra = {}, input = "") {
  const { bin } = fakes(directory);
  const { publicKey, privateKey } = keys(directory);
  const child = spawnSync("bash", [script, action], {
    encoding: "utf8",
    input,
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
    const opened = spawnSync("bash", [opener, log, privateKey], {
      encoding: "utf8",
    });
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
    const opened = spawnSync("bash", [opener, log, privateKey], {
      encoding: "utf8",
    });
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
        {
          ref: "search",
          role: "primary",
          allowedDataClassifications: ["public"],
        },
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

  it("installs the heartbeat from main with the ping address read from standard input and never prints it", () => {
    const directory = temporary();
    const root = path.join(directory, "root");
    const address = "https://hc-ping.com/0f4c2a6e-91d7-4b5e-a3c8-7d2e1f9b6a40";
    const { child } = run(
      "heartbeat-install",
      directory,
      { HIMAWARI_OPS_MIRROR: mirrorOfMain(directory), HEARTBEAT_ROOT: root },
      `${address}\n`,
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^OPS_HEARTBEAT_INSTALLED timer=active$/m);
    expect(child.stdout).not.toContain(address);
    expect(readFileSync(path.join(root, "etc/himawari-heartbeat/healthcheck-url"), "utf8")).toBe(
      `${address}\n`,
    );
    expect(existsSync(path.join(root, "etc/systemd/system/himawari-outage-push.path"))).toBe(true);
    expect(readFileSync(path.join(directory, "calls"), "utf8")).toContain(
      "systemctl enable --now himawari-heartbeat.timer",
    );
  });

  it("refuses a ping address that is not a Healthchecks ping and does not echo it", () => {
    const directory = temporary();
    const root = path.join(directory, "root");
    const address = "https://example.com/not-a-ping";
    const { child } = run(
      "heartbeat-install",
      directory,
      { HIMAWARI_OPS_MIRROR: mirrorOfMain(directory), HEARTBEAT_ROOT: root },
      `${address}\n`,
    );
    expect(child.status).toBe(70);
    expect(child.stderr).toContain("HEARTBEAT_URL_INVALID");
    expect(child.stderr).toContain("OPS_REFUSED HEARTBEAT_INSTALL_FAILED");
    expect(`${child.stdout}${child.stderr}`).not.toContain(address);
    expect(existsSync(path.join(root, "etc/himawari-heartbeat/healthcheck-url"))).toBe(false);
  });

  it("reports the per-user computers in the clear without container names", () => {
    const directory = temporary();
    const bin = path.join(directory, "computer-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/bash\ncase "$1" in\n  info) echo '{"io.containerd.runc.v2":{"path":"runc"},"runsc":{"path":"/usr/local/bin/runsc"}}' ;;\n  ps) echo running; echo exited; echo running ;;\nesac\n`,
    );
    writeFileSync(
      path.join(bin, "runsc"),
      "#!/bin/bash\necho 'runsc version release-20261123.1'\n",
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    chmodSync(path.join(bin, "runsc"), 0o755);
    const config = path.join(directory, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        capabilityDeployment: { secret: "deployment-secret" },
        runPolicy: {
          coding: { grant: "/var/lib/himawari/workspace" },
          userComputers: { socketPath: "/run/himawari-computers/computers.sock" },
          browser: { maxOutputBytes: 8388608, maxTextChars: 20000, responseReserveMs: 5000 },
        },
      }),
    );
    const computersConfig = path.join(directory, "computers.json");
    writeFileSync(
      computersConfig,
      JSON.stringify({
        schemaVersion: "user-computers.v1",
        runtime: "runsc",
        image: { reference: null, digest: `sha256:${"a".repeat(64)}` },
        disk: { kind: "loop", bytes: 10737418240 },
        idle: { stopAfterMs: 900000 },
      }),
    );
    const { child } = run("computers", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_CONFIG: config,
      HIMAWARI_OPS_COMPUTERS_CONFIG: computersConfig,
      HIMAWARI_OPS_COMPUTERS_SOCKET: path.join(directory, "no-socket"),
      HIMAWARI_OPS_DOCKER: path.join(bin, "docker"),
      HIMAWARI_OPS_RUNSC: path.join(bin, "runsc"),
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("OPS_SERVICE himawari-computers.service ActiveState=active");
    expect(child.stdout).toContain("OPS_COMPUTERS_SOCKET missing");
    expect(child.stdout).toContain("OPS_COMPUTERS_RUNSC runsc version release-20261123.1");
    expect(child.stdout).toMatch(/OPS_COMPUTERS_DOCKER_RUNTIMES .*runsc/);
    expect(child.stdout).toContain("OPS_COMPUTERS_CONTAINERS exited=1 running=2");
    expect(child.stdout).toContain('"capabilityDeployment":true');
    expect(child.stdout).toContain(
      '"userComputers":{"socketPath":"/run/himawari-computers/computers.sock"}',
    );
    expect(child.stdout).toContain('"maxTextChars":20000');
    expect(child.stdout).toContain(`"digest":"sha256:${"a".repeat(64)}"`);
    expect(child.stdout).not.toContain("deployment-secret");
    expect(child.stdout).not.toContain("OPS_SEALED_BEGIN");
    expect(child.stdout).toContain("OPS_DONE");
  });

  it("says plainly when the computers were never installed", () => {
    const directory = temporary();
    const config = path.join(directory, "config.json");
    writeFileSync(config, JSON.stringify({ runPolicy: { coding: {} } }));
    const { child } = run("computers", directory, {
      HIMAWARI_OPS_NODE: process.execPath,
      HIMAWARI_OPS_CONFIG: config,
      HIMAWARI_OPS_COMPUTERS_CONFIG: path.join(directory, "absent.json"),
      HIMAWARI_OPS_COMPUTERS_SOCKET: path.join(directory, "no-socket"),
      HIMAWARI_OPS_DOCKER: path.join(directory, "no-docker"),
      HIMAWARI_OPS_RUNSC: path.join(directory, "no-runsc"),
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("OPS_COMPUTERS_SOCKET missing");
    expect(child.stdout).toContain('"capabilityDeployment":false');
    expect(child.stdout).toContain('"userComputers":null');
    expect(child.stdout).toContain('"browser":null');
    expect(child.stdout).toContain('OPS_COMPUTERS_CONFIG {"error":"ENOENT"}');
    expect(child.stdout).toContain("OPS_COMPUTERS_RUNSC unavailable");
    expect(child.stdout).toContain("OPS_COMPUTERS_DOCKER_RUNTIMES unavailable");
    expect(child.stdout).toContain("OPS_COMPUTERS_CONTAINERS unavailable");
  });

  it("refuses anything but its own actions", () => {
    const directory = temporary();
    const { child } = run("stop", directory);
    expect(child.status).toBe(64);
    expect(child.stderr).toContain("OPS_REFUSED ACTION_INVALID");
  });
});
