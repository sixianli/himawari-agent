import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type CommitGateService,
  DurableHostWorkspaceProjectionAdapter,
  DurableHostWorkspaceStateAdapter,
  FileOperationService,
  type GovernanceMutationReceipt,
  type HostFileOperationKind,
  type HostFileReadService,
  HostWorkspaceGatewayV2ControlPlane,
  type PreparedFileOperation,
  type StateStorePort,
  WorkspaceCopyService,
  type WorkspaceService,
} from "@himawari-agent/application";
import { createAgentId, createIdempotencyKey, createOwnerId } from "@himawari-agent/domain";
import { type GatewayV2Command, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  ConstrainedHostFileSystem,
  QualifiedCandidateWorkspace,
  WorkspaceCopyStore,
} from "@himawari-agent/platform-node";
import { InMemoryStateStore } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  SERVICE_AUTHORITY,
  T0,
} from "../fixtures/sqlite-capability-invocation-fixture.js";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  git = false,
  operations: readonly HostFileOperationKind[] = ["read", "create", "update", "trash"],
  durableStore?: StateStorePort,
  platform = new ConstrainedHostFileSystem(),
  legacyCandidate = false,
) {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/himawari-copy-`));
  roots.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.txt"), "original");
  if (git) {
    const run = (args: string[]) => execFile("git", ["-C", source, ...args]);
    await run(["init", "-q"]);
    await run(["add", "a.txt"]);
    await run([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "base",
    ]);
  }
  await writeFile(path.join(source, "a.txt"), "owner dirty input");
  await writeFile(path.join(source, "b.txt"), "owner untracked input");
  await writeFile(path.join(source, "excluded.txt"), "not selected");
  const store = durableStore ?? new InMemoryStateStore();
  const state = new DurableHostWorkspaceStateAdapter(store);
  const digest = {
    digest: (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    digestCanonical: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  let now = "2026-09-21T00:00:00.000Z";
  const clock = { now: () => now };
  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}-${++sequence}` };
  const makeFiles = () =>
    new FileOperationService({
      state,
      platform,
      digest,
      clock,
      ids,
      hostId: "host-copy",
    });
  let files = makeFiles();
  const grant = await files.grant({
    hostId: "host-copy",
    displayPath: source,
    operations,
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authorization:copy",
    expiresAt: "2026-09-22T00:00:00.000Z",
    revokedAt: null,
  });
  const payloads = new Map<string, Uint8Array>();
  const readPayload = async (ref: string) => {
    const bytes = payloads.get(ref);
    if (!bytes) throw new Error("missing payload");
    return bytes;
  };
  let qualified = true;
  const legacy = new QualifiedCandidateWorkspace({
    baseRepository: source,
    candidateRoot: path.join(root, "copies"),
    qualification: async () => ({
      qualified,
      platform: "macos",
      runtimeIdentity: "fixture",
      evidenceRefs: ["fixture"],
      reasonCodes: [],
    }),
    sandbox: {
      execute: async () => {
        throw new Error("Command execution is outside this file-copy test");
      },
    },
    readPayload,
    protectPayload: async (bytes) => {
      const ref = `payload:${payloads.size}`;
      payloads.set(ref, bytes);
      return ref;
    },
    compareRunner: async () => {
      throw new Error("Comparison is outside this file-copy test");
    },
  });
  const candidate = legacyCandidate
    ? legacy
    : new WorkspaceCopyStore({
        candidateRoot: path.join(root, "copies"),
        protectPayload: async (bytes) => {
          const ref = `payload:${payloads.size}`;
          payloads.set(ref, bytes);
          return ref;
        },
      });
  const makeService = () =>
    new WorkspaceCopyService({
      hostId: "host-copy",
      state,
      platform,
      copies: candidate,
      files,
      digest,
      readPayload,
      clock,
      ids,
    });
  const create = () =>
    makeService().create({
      grantId: grant.id,
      expectedGrantRevision: grant.revision,
      inputPaths: ["a.txt", "b.txt", "new.txt"],
      allowedPaths: ["a.txt", "b.txt", "new.txt"],
      spaceBudgetBytes: 4096,
    });
  const execute = async (op: PreparedFileOperation) =>
    op.operation === "move"
      ? files.executeMove({ operationId: op.id, expectedHash: op.canonicalHash })
      : op.operation === "trash"
        ? files.executeTrash({ operationId: op.id, expectedHash: op.canonicalHash })
        : files.executeWrite({
            operationId: op.id,
            expectedHash: op.canonicalHash,
            candidateBytes: await readPayload(required(op.candidatePayloadRef)),
          });
  return {
    root,
    source,
    state,
    store,
    platform,
    grant,
    candidate,
    makeService,
    create,
    execute,
    files,
    clock,
    payloads,
    readPayload,
    disqualify: () => {
      qualified = false;
    },
    restartFiles: () => {
      files = makeFiles();
    },
    expire: () => {
      now = "2026-09-23T00:00:00.000Z";
    },
  };
}
const expiresAt = "2026-09-21T01:00:00.000Z";

describe("optional workspace copies", () => {
  it("routes copy creation and preparation through Owner Gateway commands and original file execution", async () => {
    const f = await fixture();
    const ownerId = createOwnerId("copy-owner"),
      agentId = createAgentId("copy-agent");
    const receipts = new Map<string, GovernanceMutationReceipt>();
    const protectJson = async (value: unknown) => {
      const ref = `payload:gateway:${f.payloads.size}`;
      f.payloads.set(ref, Buffer.from(JSON.stringify(value)));
      return ref;
    };
    const readText = async (ref: string) => new TextDecoder().decode(await f.readPayload(ref));
    const gateway = new HostWorkspaceGatewayV2ControlPlane({
      ownerId,
      agentId,
      files: f.files,
      copies: f.makeService(),
      hostState: f.state,
      workspaceState: f.state,
      projections: new DurableHostWorkspaceProjectionAdapter(f.store),
      clock: f.clock,
      payloads: { readBytes: f.readPayload, readText, protectJson },
      receipts: {
        get: async (_o, _a, key) => receipts.get(key),
        create: async (receipt) => {
          receipts.set(receipt.idempotencyKey, receipt);
          return receipt;
        },
        complete: async (receipt, revision) => {
          expect(receipts.get(receipt.idempotencyKey)?.revision).toBe(revision);
          receipts.set(receipt.idempotencyKey, receipt);
          return receipt;
        },
      },
      delegate: {
        execute: async () => {
          throw new Error("unexpected delegation");
        },
      },
      // These original services are not called by the copy/file commands under test.
      reads: {} as HostFileReadService,
      workspaces: {} as WorkspaceService,
      commits: {} as CommitGateService,
    });
    const invoke = (type: GatewayV2Command["type"], payload: unknown, key: string) => {
      const command = gatewayV2MessageSchema.parse({
        schemaVersion: "gateway.v2",
        kind: "command",
        type,
        messageId: key,
        correlationId: "copy-flow",
        causationId: null,
        dataClassification: "private",
        risk: "high",
        authorizationRef: "authorization:copy",
        scope: { ownerId, agentId },
        authority: { deploymentId: "deployment-copy", authorityEpoch: 1, fencingToken: 1 },
        actor: { actorType: "owner", actorId: ownerId },
        idempotencyKey: key,
        payload,
      });
      if (command.kind !== "command") throw new Error("invalid command fixture");
      return gateway.execute({
        command,
        authentication: {
          ownerId,
          subjectId: ownerId,
          deviceId: "copy-device",
          authenticatedAt: f.clock.now(),
          authenticationRef: "authentication:copy",
        },
      });
    };
    f.payloads.set("payload:path-a", Buffer.from("a.txt"));
    const created = await invoke(
      "workspace.copy.create",
      {
        grantId: f.grant.id,
        expectedGrantRevision: f.grant.revision,
        inputPathRefs: ["payload:path-a"],
        allowedPathRefs: ["payload:path-a"],
        spaceBudgetBytes: 4096,
      },
      "copy-create",
    );
    const { workspaceRef } = JSON.parse(await readText(created.resultRef));
    await writeFile(path.join(workspaceRef, "a.txt"), "gateway candidate");
    const prepared = await invoke(
      "workspace.copy.prepare",
      { workspaceRef: created.resultRef, pathRefs: ["payload:path-a"], expiresAt },
      "copy-prepare",
    );
    const { operationRefs } = JSON.parse(await readText(prepared.resultRef));
    const op = await f.state.readPrepared(operationRefs[0]);
    if (!op) throw new Error("missing prepared result");
    const payload = {
      operationPlanRef: op.id,
      expectedRevision: op.revision,
      operation: op.operation,
      canonicalHash: op.canonicalHash,
      recentAuthenticationRef: null,
    };
    await invoke("host.file.execute", payload, "copy-save");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("gateway candidate");
    expect((await invoke("host.file.execute", payload, "copy-save")).replayed).toBe(true);
    expect((await f.state.readPrepared(op.id))?.status).toBe("verified");
  });
  it.each([false, true])(
    "uses current selected files and saves only selected differences (Git=%s)",
    async (git) => {
      const f = await fixture(git);
      const copy = await f.create();
      expect(await readFile(path.join(copy, "a.txt"), "utf8")).toBe("owner dirty input");
      expect(await readFile(path.join(copy, "b.txt"), "utf8")).toBe("owner untracked input");
      await expect(readFile(path.join(copy, "excluded.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(path.join(copy, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(copy, "a.txt"), "task a");
      await writeFile(path.join(copy, "new.txt"), "task new");
      const plans = await f
        .makeService()
        .prepare({ workspaceRef: copy, paths: ["a.txt", "new.txt"], expiresAt });
      expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
      for (const op of plans) {
        await f.execute(op);
        expect((await f.state.readPrepared(op.id))?.status).toBe("verified");
      }
      expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("task a");
      expect(await readFile(path.join(f.source, "new.txt"), "utf8")).toBe("task new");
      expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("owner untracked input");
      await writeFile(path.join(f.source, "a.txt"), "later owner edit");
      await f.execute(required(plans[0]));
      expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("later owner edit");
    },
  );
  it("rejects stale input before preparation and keeps the unique candidate", async () => {
    const f = await fixture();
    const copy = await f.create();
    await writeFile(path.join(copy, "a.txt"), "candidate");
    await writeFile(path.join(f.source, "b.txt"), "changed dependency");
    await expect(
      f.makeService().prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt }),
    ).rejects.toThrow("input changed");
    expect(await readFile(path.join(copy, "a.txt"), "utf8")).toBe("candidate");
  });
  it("rechecks target after preparation, preserves partial saves and never rolls them back", async () => {
    const f = await fixture();
    const copy = await f.create();
    await writeFile(path.join(copy, "a.txt"), "saved first");
    await writeFile(path.join(copy, "b.txt"), "candidate second");
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt", "b.txt"], expiresAt });
    await f.execute(required(plans[0]));
    await writeFile(path.join(f.source, "b.txt"), "owner concurrent edit");
    await expect(f.execute(required(plans[1]))).rejects.toThrow("changed");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("saved first");
    expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("owner concurrent edit");
  });
  it("rejects a dependency changed after prepare before writing any target", async () => {
    const f = await fixture();
    const copy = await f.create();
    await writeFile(path.join(copy, "a.txt"), "stale calculation");
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt });
    await writeFile(path.join(f.source, "b.txt"), "dependency changed after prepare");
    await expect(f.execute(required(plans[0]))).rejects.toThrow("dependency");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
  });
  it("rejects removal when the owner edits the target after preparation", async () => {
    const f = await fixture();
    const copy = await f.create();
    await rm(path.join(copy, "a.txt"));
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt });
    await writeFile(path.join(f.source, "a.txt"), "new owner data");
    await expect(f.execute(required(plans[0]))).rejects.toThrow("changed");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("new owner data");
  });
  it("does not require a legacy command backend to capture and prepare an authorized copy", async () => {
    const f = await fixture();
    f.disqualify();
    const copy = await f.create();
    await writeFile(path.join(copy, "a.txt"), "SRT task output");
    const operations = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt });
    expect(operations).toHaveLength(1);
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
  });
  it("keeps the legacy candidate qualification requirement", async () => {
    const f = await fixture(false, undefined, undefined, undefined, true);
    f.disqualify();
    await expect(f.create()).rejects.toThrow("ISOLATION_NOT_QUALIFIED");
    await expect(readFile(path.join(f.root, "copies"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
  });
  it("uses the verified move as the dependency of a later file save", async () => {
    const f = await fixture(false, ["read", "move", "update"]);
    const copy = await f.create();
    await rename(path.join(copy, "a.txt"), path.join(copy, "new.txt"));
    await writeFile(path.join(copy, "b.txt"), "after rename");
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt", "new.txt", "b.txt"], expiresAt });
    expect(plans.map((plan) => plan.operation)).toEqual(["move", "update"]);
    for (const plan of plans) await f.execute(plan);
    expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("after rename");
    expect(await readFile(path.join(f.source, "new.txt"), "utf8")).toBe("owner dirty input");
  });
  it("recovers an already completed removal after another input changes", async () => {
    class InterruptedTrash extends ConstrainedHostFileSystem {
      interrupted = false;
      override async trash(...input: Parameters<ConstrainedHostFileSystem["trash"]>) {
        const result = await super.trash(...input);
        if (!this.interrupted) {
          this.interrupted = true;
          throw new Error("interrupted after trash");
        }
        return result;
      }
    }
    const f = await fixture(false, ["read", "trash"], undefined, new InterruptedTrash());
    const copy = await f.create();
    await rm(path.join(copy, "a.txt"));
    const [plan] = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt });
    await expect(f.execute(required(plan))).rejects.toThrow("interrupted after trash");
    await writeFile(path.join(f.source, "b.txt"), "later owner edit");
    await f.execute(required(plan));
    expect((await f.state.readPrepared(required(plan).id))?.status).toBe("verified");
    expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("later owner edit");
    const record = required(await f.state.readTrash(required(plan).id));
    expect(await readFile(path.join(f.source, record.trashRelativePath), "utf8")).toBe(
      "owner dirty input",
    );
  });
  it("persists partial copy saves across SQLite restart and preserves subsequent edits", async () => {
    const resource = await openRepository();
    roots.push(resource.stateRoot);
    let repository = resource.repository;
    const durableStore: StateStorePort = {
      read: (key) => repository.readScopedState(OWNER_ID, AGENT_ID, key),
      compareAndSet: async (input) => {
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        return (
          await repository.commitStateAndEvents({
            command: {
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              idempotencyKey: createIdempotencyKey(`copy:${fingerprint}`),
              commandType: "workspace.copy",
              commandFingerprint: fingerprint,
              authority: SERVICE_AUTHORITY.lease,
            },
            state: input,
            events: [],
            resultRef: `copy:${fingerprint}`,
            committedAt: T0,
          })
        ).state;
      },
    };
    try {
      const f = await fixture(false, ["read", "update"], durableStore);
      const copy = await f.create();
      await writeFile(path.join(copy, "a.txt"), "first saved");
      await writeFile(path.join(copy, "b.txt"), "second candidate");
      const plans = await f
        .makeService()
        .prepare({ workspaceRef: copy, paths: ["a.txt", "b.txt"], expiresAt });
      const first = required(plans[0]),
        second = required(plans[1]);
      await f.execute(first);
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: resource.stateRoot,
        databasePath: path.join(resource.stateRoot, "product.sqlite"),
      });
      f.restartFiles();
      expect((await f.state.readPrepared(first.id))?.status).toBe("verified");
      expect((await f.state.readPrepared(second.id))?.copyDependencies).toEqual(
        second.copyDependencies,
      );
      await writeFile(path.join(f.source, "a.txt"), "owner later edit");
      await f.execute(first);
      await expect(f.execute(second)).rejects.toThrow("dependency");
      expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner later edit");
      expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("owner untracked input");
      expect(await readFile(path.join(copy, "b.txt"), "utf8")).toBe("second candidate");
    } finally {
      await repository.close();
    }
  });
  it("rejects a replaced directory grant after copy preparation", async () => {
    const f = await fixture();
    const copy = await f.create();
    await writeFile(path.join(copy, "a.txt"), "candidate");
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt });
    await f.state.saveGrant({ ...f.grant, revision: f.grant.revision + 1 }, f.grant.revision);
    await expect(f.execute(required(plans[0]))).rejects.toThrow("authority");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
  });
  it("does not treat Git shared metadata as ordinary copy files", async () => {
    const f = await fixture(true);
    await expect(
      f.makeService().create({
        grantId: f.grant.id,
        expectedGrantRevision: f.grant.revision,
        inputPaths: [".git/index"],
        allowedPaths: [".git/index"],
        spaceBudgetBytes: 4096,
      }),
    ).rejects.toThrow("METADATA");
  });
  it("saves an unambiguous rename with move authority and preserves the original inode", async () => {
    const f = await fixture(false, ["read", "move"]);
    const copy = await f.create();
    const original = await f.platform.inspect(f.grant, "a.txt");
    await rename(path.join(copy, "a.txt"), path.join(copy, "new.txt"));
    const plans = await f
      .makeService()
      .prepare({ workspaceRef: copy, paths: ["a.txt", "new.txt"], expiresAt });
    expect(plans.map((plan) => plan.operation)).toEqual(["move"]);
    await f.execute(required(plans[0]));
    expect((await f.platform.inspect(f.grant, "new.txt"))?.inode).toBe(original?.inode);
    await expect(readFile(path.join(f.source, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.source, "new.txt"), "utf8")).toBe("owner dirty input");
  });
  it("requires separate removal authority and keeps candidate files after expiry", async () => {
    const f = await fixture(false, ["read", "update"]);
    const copy = await f.create();
    await rm(path.join(copy, "a.txt"));
    await expect(
      f.makeService().prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt }),
    ).rejects.toThrow();
    f.expire();
    await expect(
      f.makeService().prepare({ workspaceRef: copy, paths: ["a.txt"], expiresAt }),
    ).rejects.toThrow("grant");
    expect(await readFile(path.join(copy, "b.txt"), "utf8")).toBe("owner untracked input");
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("owner dirty input");
  });
  it("rejects unobserved save targets and changes outside the selected scope", async () => {
    const f = await fixture();
    const copy = await f.create();
    await writeFile(path.join(copy, "other.txt"), "not authorized");
    await expect(f.candidate.readCopyChanges(copy)).rejects.toThrow("SCOPE_CHANGED");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture result is missing");
  return value;
}
