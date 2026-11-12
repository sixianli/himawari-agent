import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  HostDirectoryGrant,
  IdempotentAgentCommand,
  ThreadArtifactRegistration,
  ThreadArtifactSource,
} from "@himawari-agent/application";
import { createAgentId, createAuthorityLeaseId, createOwnerId } from "@himawari-agent/domain";
import { type GatewayV2Query, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionThreadArtifacts,
  THREAD_ARTIFACT_SKIPPED_DIRECTORIES,
  THREAD_ARTIFACTS_PER_CALL,
} from "../../apps/agent-service/src/production-thread-artifacts.ts";
import { createWorkspaceChangeMarks } from "../../apps/agent-service/src/production-workspace-change-marks.ts";
import {
  ProductionWorkspaceChangesControl,
  WORKSPACE_FOLDER_LIST_LIMIT,
  WORKSPACE_FOLDER_SCAN_PAGES,
} from "../../apps/agent-service/src/production-workspace-changes-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-workspace-changes");
const AGENT_ID = createAgentId("agent-workspace-changes");
const LEASE = { leaseId: createAuthorityLeaseId("lease-workspace-changes"), fencingToken: 1 };
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const GRANT = "grant-coding";
const T0 = "2026-11-12T05:00:00.000Z";
const at = (minute: number) => `2026-11-12T05:${String(minute).padStart(2, "0")}:00.000Z`;

let counter = 0;
function artifact(
  path: string,
  overrides: Partial<ThreadArtifactRegistration> = {},
): ThreadArtifactRegistration {
  counter += 1;
  return {
    id: `a${counter}`,
    threadId: "thread-1",
    runId: "run-1",
    toolCallId: `call-${counter}`,
    source: "bash",
    path,
    kind: "code",
    mediaType: "text/plain",
    sizeBytes: 10,
    sha256: String(counter % 10).repeat(64),
    copyRef: null,
    overlapped: false,
    createdAt: T0,
    ...overrides,
  };
}

function query(payload: {
  grantId?: string;
  threadId?: string | null;
  afterPath?: string | null;
  limit?: number;
}): Extract<GatewayV2Query, { type: "workspace.changes.read" }> {
  return {
    schemaVersion: "gateway.v2",
    kind: "query",
    type: "workspace.changes.read",
    messageId: "m1",
    correlationId: "c1",
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: { deploymentId: "deployment-wc", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: "owner" },
    payload: {
      grantId: GRANT,
      threadId: null,
      afterPath: null,
      limit: 50,
      ...payload,
    },
  } as Extract<GatewayV2Query, { type: "workspace.changes.read" }>;
}

describe("[WC-1] folder changes read", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function open(extraGrants: readonly (readonly [string, Record<string, unknown>])[] = []) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-workspace-changes-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
         VALUES ('deployment-wc', ?, ?, 0, 'active', 1, 1)`,
      )
      .run(OWNER_ID, AGENT_ID);
    database
      .prepare(
        `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id,
           authority_epoch, fencing_token, acquired_at, expires_at)
         VALUES (?, ?, ?, 'deployment-wc', 'holder-wc', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
      )
      .run(LEASE.leaseId, OWNER_ID, AGENT_ID, T0);
    for (const thread of ["thread-1", "thread-2"])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, T0, T0);
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-stranger', 0)").run();
    database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-stranger', 'owner-stranger', 0)",
      )
      .run();
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-sibling', ?, 0)")
      .run(OWNER_ID);
    const grantRow = database.prepare(
      `INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const grant = (id: string, overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        id,
        revision: 1,
        hostId: "host-production",
        canonicalRootId: `root-${id}`,
        displayPath: `/srv/${id}`,
        operations: ["read", "create", "update"],
        expiresAt: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        ...overrides,
      });
    for (const [id, owner, agent, overrides] of [
      ["grant-b", OWNER_ID, AGENT_ID, {}],
      ["grant-a", OWNER_ID, AGENT_ID, { operations: ["read"] }],
      ["grant-revoked", OWNER_ID, AGENT_ID, { revokedAt: T0 }],
      ["grant-expired", OWNER_ID, AGENT_ID, { expiresAt: T0 }],
      ["grant-stranger", "owner-stranger", "agent-stranger", {}],
      ["grant-sibling", OWNER_ID, "agent-sibling", {}],
    ] as const)
      grantRow.run(`host-workspace:directory-grant:${id}`, owner, agent, grant(id, overrides), T0);
    for (const [id, overrides] of extraGrants)
      grantRow.run(
        `host-workspace:directory-grant:${id}`,
        OWNER_ID,
        AGENT_ID,
        grant(id, overrides),
        T0,
      );
    grantRow.run(
      "host-workspace:directory-grant-other:grant-x",
      OWNER_ID,
      AGENT_ID,
      grant("grant-x"),
      T0,
    );
    database.pragma("foreign_keys = OFF");
    for (const [run, thread] of [
      ["run-1", "thread-1"],
      ["run-2", "thread-2"],
    ])
      database
        .prepare(
          `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
             status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'completed', ?, ?)`,
        )
        .run(run, OWNER_ID, AGENT_ID, thread, `session-${run}`, `trigger-${run}`, T0, T0);
    database.pragma("foreign_keys = ON");
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const store = repository.threadArtifacts();
    const warnings: Record<string, unknown>[] = [];
    const control = (grantId = GRANT, displayPath: string | null = "/var/lib/himawari/workspace") =>
      new ProductionWorkspaceChangesControl({
        configuration: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runPolicy: { coding: { grantId } },
        } as never,
        changes: store,
        readState: (key) => repository.readScopedState(OWNER_ID, AGENT_ID, key),
        listState: (prefix, limit, afterKey) =>
          repository.listScopedState(OWNER_ID, AGENT_ID, prefix, limit, afterKey),
        displayPath: async () => displayPath,
        clock: { now: () => at(59) },
        warn: (event) => warnings.push(event),
      });
    const marks = createWorkspaceChangeMarks({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      repository,
      authority: () => LEASE,
      clock: { now: () => at(30) },
    });
    return { repository, store, control, marks, warnings };
  }

  const read = async (
    control: ProductionWorkspaceChangesControl,
    payload: Parameters<typeof query>[0] = {},
  ) =>
    (await control.query(query(payload))).payload as unknown as {
      grantMatched: boolean;
      grantActive: boolean;
      displayPath: string | null;
      recording: string;
      fileCount: number;
      incomplete: boolean;
      skippedDirectories: string[];
      items: { path: string; state: string; source: string; threadId: string; versions: number }[];
      nextAfterPath: string | null;
    };

  it("[WC-1] returns 0 when nothing was changed, and reads the same bytes twice", async () => {
    const { repository, control } = await open();
    try {
      const first = await control().query(query({}));
      expect(first.payload).toMatchObject({
        fileCount: 0,
        items: [],
        incomplete: false,
        recording: "direct",
        grantMatched: true,
        grantActive: true,
      });
      expect(JSON.stringify(await control().query(query({})))).toBe(JSON.stringify(first));
    } finally {
      await repository.close();
    }
  });

  it("[WC-2] counts each changed path once, flags deletions, and ignores uploads", async () => {
    const { repository, store, control, warnings } = await open();
    try {
      await store.register({ ...scope, artifact: artifact("a.py", { createdAt: at(1) }) });
      await store.register({
        ...scope,
        artifact: artifact("a.py", { createdAt: at(2), source: "edit" }),
      });
      const back = artifact("b.py", { createdAt: at(3), sha256: "c".repeat(64) });
      await store.register({ ...scope, artifact: back });
      await store.register({
        ...scope,
        artifact: artifact("b.py", { createdAt: at(4), sha256: "c".repeat(64) }),
      });
      await store.register({
        ...scope,
        artifact: artifact("c.py", { createdAt: at(5), source: "write" }),
      });
      await store.markDeleted({
        ...scope,
        threadId: "thread-1",
        paths: ["c.py"],
        deletedAt: at(6),
      });
      await store.register({
        ...scope,
        artifact: artifact("report.docx", {
          createdAt: at(7),
          source: "upload" as ThreadArtifactSource,
        }),
      });
      const result = await read(control());
      expect(result.fileCount).toBe(3);
      expect(result.displayPath).toBe("/var/lib/himawari/workspace");
      expect(result.items.map((item) => [item.path, item.state, item.versions])).toEqual([
        ["a.py", "changed", 2],
        ["b.py", "changed", 1],
        ["c.py", "deleted", 1],
      ]);
      expect(result.items[0]).toMatchObject({ source: "edit", threadId: "thread-1" });
      expect(result.incomplete).toBe(false);
      await store.register({
        ...scope,
        artifact: artifact("b\nbroken.py", { createdAt: at(8) }),
      });
      const withBroken = await control().query(query({ limit: 2, afterPath: "a.py" }));
      expect(() => gatewayV2MessageSchema.parse(withBroken)).not.toThrow();
      expect(withBroken.payload).toMatchObject({
        fileCount: 4,
        incomplete: true,
        items: [{ path: "b.py" }],
        nextAfterPath: "b.py",
      });
      expect(warnings.map((event) => event["event"])).toEqual(["workspace.changes.item_skipped"]);
      const rest = await read(control(), { afterPath: "b.py" });
      expect(rest.items.map((item) => item.path)).toEqual(["c.py"]);
      for (const name of ["b\u0001x.py", "b\u0002x.py", "b\u0003x.py"])
        await store.register({ ...scope, artifact: artifact(name, { createdAt: at(9) }) });
      const walked: string[] = [];
      let after: string | null = null;
      let sawIncomplete = false;
      for (let step = 0; step < 10; step += 1) {
        const one = await control().query(query({ limit: 1, afterPath: after }));
        expect(() => gatewayV2MessageSchema.parse(one)).not.toThrow();
        const payload = one.payload as unknown as {
          items: { path: string }[];
          nextAfterPath: string | null;
          incomplete: boolean;
        };
        walked.push(...payload.items.map((item) => item.path));
        sawIncomplete ||= payload.incomplete;
        after = payload.nextAfterPath;
        if (after === null) break;
      }
      expect(walked).toEqual(["a.py", "b.py", "c.py"]);
      expect(sawIncomplete).toBe(true);
    } finally {
      await repository.close();
    }
  });

  it("[WC-3] pages by path and keeps threads and other grants apart", async () => {
    const { repository, store, control } = await open();
    try {
      for (const name of ["a", "b", "c", "d", "e"])
        await store.register({
          ...scope,
          artifact: artifact(`${name}.txt`, { createdAt: at(1) }),
        });
      await store.register({
        ...scope,
        artifact: artifact("other.txt", { threadId: "thread-2", runId: "run-2", createdAt: at(2) }),
      });
      const first = await read(control(), { limit: 2 });
      expect(first.items.map((item) => item.path)).toEqual(["a.txt", "b.txt"]);
      expect(first.fileCount).toBe(6);
      const second = await read(control(), { limit: 2, afterPath: first.nextAfterPath });
      expect(second.items.map((item) => item.path)).toEqual(["c.txt", "d.txt"]);
      const last = await read(control(), { limit: 2, afterPath: second.nextAfterPath });
      expect(last.items.map((item) => item.path)).toEqual(["e.txt", "other.txt"]);
      expect(last.nextAfterPath).toBeNull();
      const mine = await read(control(), { threadId: "thread-2" });
      expect(mine.items.map((item) => item.path)).toEqual(["other.txt"]);
      expect(mine.fileCount).toBe(1);
      const stranger = await read(control(), { grantId: "grant-other" });
      expect(stranger).toMatchObject({
        grantMatched: false,
        grantActive: false,
        fileCount: 0,
        items: [],
        displayPath: null,
        incomplete: false,
      });
      const revoked = await read(control(GRANT, null));
      expect(revoked).toMatchObject({
        grantMatched: true,
        grantActive: false,
        displayPath: null,
        fileCount: 6,
      });
    } finally {
      await repository.close();
    }
  });

  it("[WC-4] the incomplete mark is per thread and folder, per grant, and never clears", async () => {
    const { repository, control, marks } = await open();
    try {
      expect((await read(control(), { threadId: "thread-1" })).incomplete).toBe(false);
      await marks.markIncomplete({
        grantId: GRANT,
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-1",
      });
      await marks.markIncomplete({
        grantId: GRANT,
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-1",
      });
      await marks.markIncomplete({
        grantId: GRANT,
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-2",
      });
      expect((await read(control(), { threadId: "thread-1" })).incomplete).toBe(true);
      expect((await read(control(), { threadId: "thread-2" })).incomplete).toBe(false);
      expect((await read(control())).incomplete).toBe(true);
      expect((await read(control("grant-other"), { grantId: "grant-other" })).incomplete).toBe(
        false,
      );
    } finally {
      await repository.close();
    }
  });

  it("[WC-4] ids that contain colons never share a mark, and marks written at the same time both land", async () => {
    const { repository, control, marks } = await open();
    try {
      await marks.markIncomplete({
        grantId: `${GRANT}:thread-1`,
        threadId: "thread-9",
        runId: "run-1",
        toolCallId: "call-1",
      });
      expect((await read(control(), { threadId: "thread-1" })).incomplete).toBe(false);
      expect((await read(control(), { threadId: "thread-1:thread-9" })).incomplete).toBe(false);
      expect((await read(control())).incomplete).toBe(false);
      await Promise.all(
        ["call-2", "call-3", "call-4"].map((toolCallId) =>
          marks.markIncomplete({
            grantId: GRANT,
            threadId: "thread-2",
            runId: "run-2",
            toolCallId,
          }),
        ),
      );
      expect((await read(control(), { threadId: "thread-2" })).incomplete).toBe(true);
      expect((await read(control(), { threadId: "thread-1" })).incomplete).toBe(false);
      expect((await read(control())).incomplete).toBe(true);
    } finally {
      await repository.close();
    }
  });

  it("[WC-5] a thread that works in a copy reports copy recording", async () => {
    const { repository, control } = await open();
    try {
      await repository.commitStateAndEvents({
        command: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          authority: LEASE,
          idempotencyKey: "copy-select" as IdempotentAgentCommand["idempotencyKey"],
          commandType: "copy-test",
          commandFingerprint: "copy-select",
        },
        state: {
          key: "workspace-copy-selection:thread-1",
          expectedRevision: null,
          value: { workspaceRef: "copy-1" },
        },
        events: [],
        resultRef: "copy-selection",
        committedAt: T0,
      });
      expect((await read(control(), { threadId: "thread-1" })).recording).toBe("copy");
      expect((await read(control(), { threadId: "thread-2" })).recording).toBe("direct");
    } finally {
      await repository.close();
    }
  });

  it("[WC-9] lists the owner's live folders from storage, in a fixed order", async () => {
    const { repository, control } = await open();
    try {
      const request = { ...query({}), type: "workspace.folders.read", payload: {} } as never;
      const first = await control().query(request);
      expect(first.type).toBe("workspace.folders.snapshot");
      expect(first.payload).toEqual({
        folders: [
          {
            grantId: "grant-a",
            hostId: "host-production",
            displayPath: "/srv/grant-a",
            operations: ["read"],
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            grantId: "grant-b",
            hostId: "host-production",
            displayPath: "/srv/grant-b",
            operations: ["read", "create", "update"],
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
        truncated: false,
        generatedAt: at(59),
      });
      expect(JSON.stringify(await control("grant-other").query(request))).toBe(
        JSON.stringify(first),
      );
    } finally {
      await repository.close();
    }
  });

  it("[WC-9] one bad stored folder is skipped instead of failing the list, and live folders after 200 dead ones are still listed", async () => {
    const dead = Array.from(
      { length: 201 },
      (_, index) => [`dead-${String(index).padStart(3, "0")}`, { revokedAt: T0 }] as const,
    );
    const { repository, control, warnings } = await open([
      ...dead,
      ["grant-seconds", { expiresAt: "2027-01-01T00:00:00Z" }],
      ["grant-offset", { expiresAt: "2027-01-01T09:00:00+09:00" }],
      ["grant-not-a-date", { expiresAt: "someday" }],
      ["grant-wrong-id", { id: "not the key" }],
      ["grant-no-path", { displayPath: 7 }],
      ["grant-no-revoked", { revokedAt: undefined }],
    ]);
    try {
      const request = { ...query({}), type: "workspace.folders.read", payload: {} } as never;
      const payload = (await control().query(request)).payload as unknown as {
        folders: { grantId: string; expiresAt: string }[];
        truncated: boolean;
      };
      expect(payload.folders.map((folder) => [folder.grantId, folder.expiresAt])).toEqual([
        ["grant-a", "2027-01-01T00:00:00.000Z"],
        ["grant-b", "2027-01-01T00:00:00.000Z"],
        ["grant-offset", "2027-01-01T00:00:00.000Z"],
        ["grant-seconds", "2027-01-01T00:00:00.000Z"],
      ]);
      expect(payload.truncated).toBe(false);
      expect(warnings.map((event) => event["key"]).sort()).toEqual([
        "host-workspace:directory-grant:grant-no-path",
        "host-workspace:directory-grant:grant-no-revoked",
        "host-workspace:directory-grant:grant-not-a-date",
        "host-workspace:directory-grant:grant-wrong-id",
      ]);
    } finally {
      await repository.close();
    }
  });

  it("[WC-9] more than 200 live folders are cut at 200 and say so", async () => {
    const { repository, control } = await open(
      Array.from(
        { length: 200 },
        (_, index) => [`live-${String(index).padStart(3, "0")}`, {}] as const,
      ),
    );
    try {
      const request = { ...query({}), type: "workspace.folders.read", payload: {} } as never;
      const payload = (await control().query(request)).payload as unknown as {
        folders: { grantId: string }[];
        truncated: boolean;
      };
      expect(payload.folders).toHaveLength(200);
      expect(payload.folders[0]?.grantId).toBe("grant-a");
      expect(payload.truncated).toBe(true);
    } finally {
      await repository.close();
    }
  });

  it("[WC-9] stops reading after a fixed number of pages of dead folders and says the list is cut", async () => {
    const { repository, control } = await open(
      Array.from(
        { length: WORKSPACE_FOLDER_SCAN_PAGES * (WORKSPACE_FOLDER_LIST_LIMIT + 1) },
        (_, index) => [`dead-${String(index).padStart(5, "0")}`, { revokedAt: T0 }] as const,
      ),
    );
    try {
      const request = { ...query({}), type: "workspace.folders.read", payload: {} } as never;
      expect((await control().query(request)).payload).toMatchObject({
        folders: [],
        truncated: true,
      });
    } finally {
      await repository.close();
    }
  });

  it("[WC-6] files under skipped directories are not counted and the list is returned", async () => {
    const { repository, store, control } = await open();
    try {
      let reads = 0;
      let readable = false;
      const artifacts = new ProductionThreadArtifacts({
        store,
        files: {
          readFile: async (input: { relativePath: string }) => {
            reads += 1;
            if (readable) return new TextEncoder().encode(input.relativePath);
            throw new Error("must not read");
          },
          inspectEntry: async () => {
            throw new Error("must not inspect");
          },
        } as never,
        ids: { next: (prefix: string) => `${prefix}-${++counter}` } as never,
        now: () => at(10),
        warn: () => undefined,
      });
      let incomplete = 0;
      const recording = (paths: string[], extra = {}) => ({
        ...scope,
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-skip",
        source: "bash" as const,
        grant: { id: GRANT } as HostDirectoryGrant,
        candidates: paths.map((p) => ({ path: p })),
        overlapped: false,
        onIncomplete: () => {
          incomplete += 1;
        },
        saveCopy: async () => ({ ref: "copy" }),
        ...extra,
      });
      await artifacts.record(
        recording(THREAD_ARTIFACT_SKIPPED_DIRECTORIES.map((dir) => `${dir}/pkg/index.js`)),
      );
      const result = await read(control());
      expect(reads).toBe(0);
      expect(incomplete).toBe(0);
      expect(result.fileCount).toBe(0);
      expect(result.skippedDirectories).toEqual([...THREAD_ARTIFACT_SKIPPED_DIRECTORIES]);
      expect(result.skippedDirectories).toContain("node_modules");
      await artifacts.record(recording(["readme.md"]));
      expect(incomplete).toBe(1);
      readable = true;
      incomplete = 0;
      const readsBefore = reads;
      await artifacts.record(recording(["line\nbreak.txt"], { toolCallId: "call-control" }));
      expect(incomplete).toBe(1);
      expect(reads).toBe(readsBefore);
      expect((await read(control())).fileCount).toBe(0);
      incomplete = 0;
      await artifacts.record(
        recording(
          Array.from({ length: THREAD_ARTIFACTS_PER_CALL }, (_, i) => `f${i}.txt`),
          { toolCallId: "call-at-cap" },
        ),
      );
      expect(incomplete).toBe(0);
      await artifacts.record(
        recording(
          Array.from({ length: THREAD_ARTIFACTS_PER_CALL + 1 }, (_, i) => `g${i}.txt`),
          { toolCallId: "call-over-cap" },
        ),
      );
      expect(incomplete).toBe(1);
      expect((await read(control())).fileCount).toBe(THREAD_ARTIFACTS_PER_CALL * 2);
      expect(
        await artifacts.recordDeleted({
          ...scope,
          threadId: "thread-1",
          runId: "run-1",
          toolCallId: "call-deleted",
          paths: ["f0.txt"],
          grant: { id: GRANT } as HostDirectoryGrant,
          overlapped: false,
        }),
      ).toBe(false);
      expect(
        await artifacts.recordDeleted({
          ...scope,
          threadId: "thread-1",
          runId: "run-1",
          toolCallId: "call-deleted-control",
          paths: ["gone\nfile.txt"],
          grant: { id: GRANT } as HostDirectoryGrant,
          overlapped: false,
        }),
      ).toBe(true);
      expect(
        await artifacts.recordDeleted({
          ...scope,
          threadId: "thread-1",
          runId: "run-1",
          toolCallId: "call-deleted-overlap",
          paths: ["f1.txt"],
          grant: { id: GRANT } as HostDirectoryGrant,
          overlapped: true,
        }),
      ).toBe(true);
    } finally {
      await repository.close();
    }
  });
});
