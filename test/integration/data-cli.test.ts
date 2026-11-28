import { chmod, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  LATEST_MIGRATION_SEQUENCE,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  CONFIGURATION_SCHEMA_VERSION,
  EnvelopePayloadProtector,
  initializeStateRoot,
  RestrictedSecretFileSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../../apps/admin-cli/src/index.ts";
import { seedThread } from "./chat-export-fixture.ts";
import { SECRET_PASSWORD, type Side, seedMemory } from "./data-export-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

const OWNER = "owner-data-cli";
const AGENT = "agent-data-cli";

function configuration(stateRoot: string) {
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-data-cli",
    ownerId: OWNER,
    agentId: AGENT,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "provider-local",
        model: "model-a",
        version: "snapshot-1",
        priority: 1,
        name: "Primary fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "provider-local",
        model: "embed-a",
        version: "snapshot-1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1536,
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
    ],
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

async function prepare(name: string, seed: boolean, seedChats = false) {
  const root = await mkdtemp(path.join(tmpdir(), `himawari-data-cli-${name}-`));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const layout = await initializeStateRoot(stateRoot);
  const secretDirectory = path.join(root, "secrets");
  await mkdir(secretDirectory, { mode: 0o700 });
  await writeFile(path.join(secretDirectory, "payload-kek.v1"), "11".repeat(32), { mode: 0o600 });
  const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  if (seed) {
    const side: Side = {
      database,
      ownerId: createOwnerId(OWNER),
      agentId: createAgentId(AGENT),
      protector: new EnvelopePayloadProtector({
        keys: new RestrictedSecretFileSource(secretDirectory),
        activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
      }),
      migrationSequence: LATEST_MIGRATION_SEQUENCE,
      directory: root,
    };
    if (seedChats)
      await seedThread(side, "thread-cli", {
        title: "咖啡",
        messages: [{ text: "早上好" }, { text: `网银密码是 ${SECRET_PASSWORD}` }],
      });
    await seedMemory(side, { id: "memory-plain", text: "Andy 喜欢早上喝黑咖啡" });
    await seedMemory(side, {
      id: "memory-secret",
      text: `Andy 的网银密码是 ${SECRET_PASSWORD}`,
    });
  }
  database.close();
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(configurationPath, `${JSON.stringify(configuration(stateRoot))}\n`, {
    mode: 0o600,
  });
  const passphraseFile = path.join(root, "passphrase");
  await writeFile(passphraseFile, "correct horse battery staple\n", { mode: 0o600 });
  return { root, configurationPath, secretDirectory, passphraseFile };
}

async function run(arguments_: string[]) {
  const output = sink();
  const code = await runAdminCli(arguments_, output.stream);
  return { code, lines: output.value().trim().split("\n") };
}

describe("data admin CLI", () => {
  it("[P1-6] exports, inspects and imports into an empty deployment", async () => {
    const source = await prepare("source", true);
    const out = path.join(source.root, "export");
    const exported = await run([
      "data",
      "export",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--passphrase-file",
      source.passphraseFile,
      "--operator",
      "andy",
    ]);
    expect(exported.code).toBe(0);
    const exportedResult = JSON.parse(exported.lines.at(-1) ?? "{}");
    expect(exportedResult.counts.memories).toBe(2);
    expect(exportedResult.sealed).toBe(true);
    expect((await readdir(out)).sort()).toContain("manifest.json");

    const inspected = await run(["data", "inspect", "--from", out]);
    expect(JSON.parse(inspected.lines.at(-1) ?? "{}").counts.memories).toBe(2);

    const target = await prepare("target", false);
    const refused = await run([
      "data",
      "import",
      "--config",
      target.configurationPath,
      "--secret-dir",
      target.secretDirectory,
      "--from",
      out,
      "--passphrase-file",
      target.passphraseFile,
      "--operator",
      "andy",
    ]);
    expect(refused.code).not.toBe(0);
    const imported = await run([
      "data",
      "import",
      "--config",
      target.configurationPath,
      "--secret-dir",
      target.secretDirectory,
      "--from",
      out,
      "--passphrase-file",
      target.passphraseFile,
      "--confirm",
      `IMPORT_DATA_${AGENT}`,
      "--operator",
      "andy",
    ]);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.lines.at(-1) ?? "{}").imported.memories).toBe(2);
  });

  it("[P1-6][reverse] refuses an unsealed export that would lose withheld text, and an unsafe passphrase file", async () => {
    const source = await prepare("unsealed", true);
    const out = path.join(source.root, "export");
    const base = [
      "data",
      "export",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--operator",
      "andy",
    ];
    expect((await run(base)).code).not.toBe(0);
    await expect(readdir(out)).rejects.toThrow();
    await chmod(source.passphraseFile, 0o644);
    expect((await run([...base, "--passphrase-file", source.passphraseFile])).code).not.toBe(0);
    await expect(readdir(out)).rejects.toThrow();
    expect((await run([...base, "--allow-unsealed"])).code).toBe(0);
  });

  it("[P1-6][reverse] import needs the confirmation phrase and inspect rejects a tampered export", async () => {
    const source = await prepare("tamper", true);
    const out = path.join(source.root, "export");
    await run([
      "data",
      "export",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--allow-unsealed",
      "--operator",
      "andy",
    ]);
    const target = await prepare("noconfirm", false);
    const withoutConfirm = await run([
      "data",
      "import",
      "--config",
      target.configurationPath,
      "--secret-dir",
      target.secretDirectory,
      "--from",
      out,
      "--operator",
      "andy",
    ]);
    expect(withoutConfirm.code).not.toBe(0);
    await writeFile(path.join(out, "data", "memories.jsonl"), "{}\n");
    const inspected = await run(["data", "inspect", "--from", out]);
    expect(inspected.code).not.toBe(0);
  });
  it("[P1-6] --dry-run validates an import without writing and a too-short passphrase is refused", async () => {
    const source = await prepare("dry-source", true);
    const out = path.join(source.root, "export");
    await run([
      "data",
      "export",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--passphrase-file",
      source.passphraseFile,
      "--operator",
      "andy",
    ]);
    const target = await prepare("dry-target", false);
    const dry = await run([
      "data",
      "import",
      "--config",
      target.configurationPath,
      "--secret-dir",
      target.secretDirectory,
      "--from",
      out,
      "--passphrase-file",
      target.passphraseFile,
      "--dry-run",
      "--operator",
      "andy",
    ]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.lines.at(-1) ?? "{}").dryRun).toBe(true);
    const database = openQualifiedDatabase(
      path.join(target.root, "state", "data", "product.sqlite"),
    );
    try {
      expect(database.prepare("SELECT COUNT(*) FROM memory_records").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
    await chmod(target.passphraseFile, 0o700);
    expect(
      (
        await run([
          "data",
          "import",
          "--config",
          target.configurationPath,
          "--secret-dir",
          target.secretDirectory,
          "--from",
          out,
          "--passphrase-file",
          target.passphraseFile,
          "--dry-run",
          "--operator",
          "andy",
        ])
      ).code,
    ).not.toBe(0);
    await chmod(target.passphraseFile, 0o600);
    await writeFile(target.passphraseFile, "short\n");
    const refused = await run([
      "data",
      "import",
      "--config",
      target.configurationPath,
      "--secret-dir",
      target.secretDirectory,
      "--from",
      out,
      "--passphrase-file",
      target.passphraseFile,
      "--dry-run",
      "--operator",
      "andy",
    ]);
    expect(refused.code).not.toBe(0);
  });

  it("[多人7] export-chats writes a verifiable chat export, seals the originals, and inspect reads it", async () => {
    const source = await prepare("chats", true, true);
    const out = path.join(source.root, "chats-export");
    const base = [
      "data",
      "export-chats",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--operator",
      "andy",
    ];
    expect((await run(base)).code).not.toBe(0);
    await expect(readdir(out)).rejects.toThrow();
    const exported = await run([...base, "--passphrase-file", source.passphraseFile]);
    expect(exported.code).toBe(0);
    const result = JSON.parse(exported.lines.at(-1) ?? "{}");
    expect(result).toMatchObject({
      command: "data.export-chats",
      counts: { threads: 1, messages: 2, sealedOriginals: 1 },
      withheld: { messages: 1 },
      sealed: true,
    });
    const inspected = await run(["data", "inspect", "--from", out]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.lines.at(-1) ?? "{}")).toMatchObject({
      format: "himawari.chat-export.v1",
      counts: { threads: 1, messages: 2 },
    });
    const files = await readdir(out, { recursive: true });
    expect(files).toContain("CHATS.md");
    expect(files).toContain("sealed/sealed.enc");
  });

  it("[多人7][reverse] export-chats on a database without chats gives an empty export and needs no passphrase", async () => {
    const source = await prepare("nochats", true);
    const out = path.join(source.root, "chats-export");
    const exported = await run([
      "data",
      "export-chats",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--operator",
      "andy",
    ]);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.lines.at(-1) ?? "{}").counts).toMatchObject({
      threads: 0,
      messages: 0,
    });
  });

  it("[多人7][reverse] inspect reports a broken manifest with the manifest error code, not a raw exception", async () => {
    const source = await prepare("badmanifest", true, true);
    const out = path.join(source.root, "chats-export");
    await run([
      "data",
      "export-chats",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--allow-unsealed",
      "--operator",
      "andy",
    ]);
    await writeFile(path.join(out, "manifest.json"), "{not json", { mode: 0o600 });
    const errors = sink();
    const code = await runAdminCli(
      ["data", "inspect", "--from", out],
      sink().stream,
      errors.stream,
    );
    expect(code).not.toBe(0);
    expect(errors.value()).toContain("DATA_IMPORT_MANIFEST_INVALID");
  });

  it("[多人7][reverse] inspect refuses a manifest that is a symbolic link before reading it", async () => {
    const source = await prepare("linkmanifest", true, true);
    const out = path.join(source.root, "chats-export");
    await run([
      "data",
      "export-chats",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--allow-unsealed",
      "--operator",
      "andy",
    ]);
    await unlink(path.join(out, "manifest.json"));
    await symlink("/dev/zero", path.join(out, "manifest.json"));
    const errors = sink();
    const code = await runAdminCli(
      ["data", "inspect", "--from", out],
      sink().stream,
      errors.stream,
    );
    expect(code).not.toBe(0);
    expect(errors.value()).toContain("DATA_IMPORT_PATH_UNSAFE");
  });

  it("[多人7] inspect accepts a chat export with more than 4096 files", async () => {
    const source = await prepare("manyfiles", true);
    const side: Side = await (async () => {
      const database = openQualifiedDatabase(
        path.join(source.root, "state", "data", "product.sqlite"),
      );
      return {
        database,
        ownerId: createOwnerId(OWNER),
        agentId: createAgentId(AGENT),
        protector: new EnvelopePayloadProtector({
          keys: new RestrictedSecretFileSource(source.secretDirectory),
          activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
        }),
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        directory: source.root,
      };
    })();
    for (let index = 0; index < 4100; index += 1)
      await seedThread(side, `thread-many-${index}`, {
        created: `2026-11-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        messages: [{ text: `消息 ${index}` }],
      });
    side.database.close();
    const out = path.join(source.root, "chats-export");
    const exported = await run([
      "data",
      "export-chats",
      "--config",
      source.configurationPath,
      "--secret-dir",
      source.secretDirectory,
      "--out",
      out,
      "--operator",
      "andy",
    ]);
    expect(exported.code).toBe(0);
    const inspected = await run(["data", "inspect", "--from", out]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.lines.at(-1) ?? "{}").counts.threads).toBe(4100);
  }, 60_000);
});
