import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GovernedActionIntent,
  type ProductConfiguration,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = "owner-workspace-auto" as GovernedActionIntent["ownerId"];
const AGENT_ID = "agent-workspace-auto" as GovernedActionIntent["agentId"];
const THREAD_ID = "thread-workspace-auto";
const LEASE_ID = "lease-workspace-auto";
const DEPLOYMENT_ID = "deployment-workspace-auto" as ProductConfiguration["deploymentId"];
const INPUT_REF = "payload-workspace-auto-input";
const WALL_NOW = Date.now();
const NOW = new Date(WALL_NOW + 30_000).toISOString();
const PRODUCT_AUTHORITY = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
} as const;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-workspace-auto-"));
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  applyMigrations(database, migrations);
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
         fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'holder-workspace-auto', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database.close();

  const repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
  cleanups.push(async () => {
    await repository.close();
    await rm(stateRoot, { recursive: true });
  });

  await repository.payloadStore(OWNER_ID, AGENT_ID).put(
    await new EnvelopePayloadProtector({
      keys: new InMemoryDevelopmentSecretSource({ "workspace-kek@v1": new Uint8Array(32).fill(7) }),
      activeKey: { keyRef: "workspace-kek", kekVersion: "v1", dekVersion: "dek-v1" },
    }).protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref: INPUT_REF,
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("workspace auto fixture input"),
      createdAt: NOW,
    }),
  );
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock: { now: () => NOW },
    authority: () => PRODUCT_AUTHORITY,
  });
  const thread = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID as NonNullable<Parameters<ThreadCommandService["create"]>[0]["threadId"]>,
    idempotencyKey: "workspace-auto-thread",
    resultRef: INPUT_REF,
  });
  return { commands, thread };
}

const submit = (
  commands: ThreadCommandService,
  threadId: NonNullable<Parameters<ThreadCommandService["create"]>[0]["threadId"]>,
  expectedThreadRevision: number,
  suffix: string,
) =>
  commands.admitOwnerMessage({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId,
    expectedThreadRevision,
    sessionId: `session-${suffix}` as Parameters<
      ThreadCommandService["admitOwnerMessage"]
    >[0]["sessionId"],
    runId: `run-${suffix}` as NonNullable<
      Parameters<ThreadCommandService["admitOwnerMessage"]>[0]["runId"]
    >,
    idempotencyKey: `message-${suffix}`,
    contentRef: INPUT_REF as Parameters<ThreadCommandService["admitOwnerMessage"]>[0]["contentRef"],
    sourceProofRef: "fixture-owner",
    dataClassification: "private",
    resultRef: INPUT_REF as Parameters<ThreadCommandService["admitOwnerMessage"]>[0]["resultRef"],
  });

describe("owner message admission ignores the client's thread revision", () => {
  it("accepts a message sent with an older revision than the thread now has", async () => {
    const { commands, thread } = await fixture();
    const first = await submit(commands, thread.thread.id, thread.thread.revision, "first");
    expect(first.thread.revision).toBeGreaterThan(thread.thread.revision);
    const second = await submit(commands, thread.thread.id, thread.thread.revision, "second");
    expect(second.thread.revision).toBeGreaterThan(first.thread.revision);
  });
});
