import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProposalControl } from "../../apps/agent-service/src/production-proposal-control.ts";
import {
  ProductionProposalBox,
  type ProposalActionHandler,
  ProposalError,
  type ProposalHandler,
} from "../../apps/agent-service/src/production-proposals.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-proposal-execution");
const AGENT_ID = createAgentId("agent-proposal-execution");
const START = "2026-11-14T00:00:00.000Z";
const ID = (name: string) => `${name}:${"a".repeat(32)}`;
const evidence = [{ kind: "owner_words", text: "原话", sources: [], figures: [] }];

class Handlers {
  executed = 0;
  undone = 0;
  adopted = 0;
  premises: { ok: true } | { ok: false; reason: string } = { ok: true };
  readBack: "matches" | "differs" | "throws" = "matches";
  failure: Error | undefined;
  undoFailure: Error | undefined;
  undoDelay = 0;
  executeDelay = 0;
  presence = false;
  readonly action: ProposalActionHandler = {
    kind: "action",
    requiresPresence: false,
    verify: async () => this.premises,
    execute: async () => {
      this.executed += 1;
      if (this.executeDelay > 0)
        await new Promise((resolve) => setTimeout(resolve, this.executeDelay));
      if (this.failure) throw this.failure;
      return { original: { time: "9:00" }, detail: "9:00 → 9:40" };
    },
    readBack: async () => {
      if (this.readBack === "throws") throw new Error("read-back unavailable");
      return this.readBack;
    },
    undo: async () => {
      if (this.undoDelay > 0) await new Promise((resolve) => setTimeout(resolve, this.undoDelay));
      if (this.undoFailure) throw this.undoFailure;
      this.undone += 1;
    },
  };
  readonly task: ProposalHandler = {
    adopt: async () => {
      this.adopted += 1;
      return { resultRef: "run-1" };
    },
  };
  askForPresence(): void {
    Object.assign(this.action, { requiresPresence: true });
  }
}

describe.each(["worker", "direct"] as const)("proposal execution through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(
    options: { readonly leaseSeconds?: number; readonly failExecutionPayload?: boolean } = {},
  ) {
    const { failExecutionPayload, ...boxOptions } = options;
    const handlers = new Handlers();
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-proposal-execution-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = { value: START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    closers.push(() => repository.close());
    const sql = <T>(run: (handle: ReturnType<typeof openQualifiedDatabase>) => T): T => {
      const handle = openQualifiedDatabase(file);
      try {
        return run(handle);
      } finally {
        handle.close();
      }
    };
    const box = new ProductionProposalBox({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      store: repository.ownerProposals(),
      payloads: failExecutionPayload
        ? {
            ...repository.payloadStore(OWNER_ID, AGENT_ID),
            put: async (payload: { readonly ref: string }) => {
              if (payload.ref.includes(":x")) throw new Error("payload store is full");
              return repository.payloadStore(OWNER_ID, AGENT_ID).put(payload as never);
            },
          }
        : repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: createReferenceAdapterSet().payloadProtector,
      clock: { now: () => clock.value },
      ...boxOptions,
    });
    box.register("reminder_time", handlers.action);
    box.register("do_a_thing", handlers.task);
    const row = (proposalId: string) =>
      sql(
        (handle) =>
          handle
            .prepare(
              `SELECT status, exec_status AS exec, origin, attempts, lease_id AS lease,
                 requires_full_read AS fullRead, requires_presence AS presence
               FROM owner_proposals WHERE id = ?`,
            )
            .get(proposalId) as Record<string, unknown>,
      );
    const count = () =>
      sql(
        (handle) =>
          (handle.prepare("SELECT COUNT(*) AS n FROM owner_proposals").get() as { n: number }).n,
      );
    const propose = (
      proposalId: string,
      extra: Record<string, unknown> = {},
      type = "reminder_time",
    ) =>
      box.propose({
        proposalId,
        type,
        summary: "把洗衣服提醒推迟到 9:40",
        effect: "提醒改到 9:40",
        origin: "inferred",
        threadId: null,
        evidence,
        data: { target: "reminder-1", time: "9:40" },
        ...extra,
      });
    const seen = async (proposalId: string) => {
      const listed = await box.list();
      const found = listed.proposals.find((item) => item.proposalId === proposalId);
      if (!found) throw new Error("proposal not listed");
      return { version: found.version, fingerprint: found.fingerprint };
    };
    return { box, clock, repository, row, count, propose, seen, sql, handlers };
  }

  async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error instanceof ProposalError ? error.code : String(error);
    }
  }

  it("adopts a fixed action once, reads it back, and undoing it is final", async () => {
    const { box, row, count, propose, seen, handlers } = await fixture();
    const id = ID("act");
    await propose(id);
    expect(row(id)).toMatchObject({ status: "pending", exec: "not_started", attempts: 0 });
    const outcome = await box.adopt(id, await seen(id));
    expect(outcome).toMatchObject({ resultRef: id, execution: "succeeded", detail: "9:00 → 9:40" });
    expect(handlers.executed).toBe(1);
    expect(row(id)).toMatchObject({
      status: "accepted",
      exec: "succeeded",
      attempts: 1,
      lease: null,
    });
    expect(await failureOf(box.adopt(id))).toBe("PROPOSAL_ACCEPTED");
    expect(handlers.executed).toBe(1);

    expect(await box.undo(id)).toEqual({ replayed: false });
    expect(handlers.undone).toBe(1);
    expect(row(id)).toMatchObject({ status: "accepted", exec: "undone" });
    expect(await box.undo(id)).toEqual({ replayed: true });
    expect(handlers.undone).toBe(1);

    await propose(id);
    expect(row(id)).toMatchObject({ status: "accepted", exec: "undone" });
    expect(count()).toBe(1);
    expect((await box.list()).proposals).toHaveLength(0);
    expect(await failureOf(box.adopt(id))).toBe("PROPOSAL_ACCEPTED");
  });

  it("refuses undo before success and keeps the state when the handler cannot undo", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    const id = ID("act");
    await propose(id);
    expect(await failureOf(box.undo(id))).toBe("PROPOSAL_NOT_UNDOABLE");
    await box.adopt(id, await seen(id));
    handlers.undoFailure = new Error("target changed");
    expect(await failureOf(box.undo(id))).toBe("Error: target changed");
    expect(row(id)).toMatchObject({ exec: "succeeded" });
    expect(await failureOf(box.undo(id, { version: 99, fingerprint: "0".repeat(64) }))).toBe(
      "PROPOSAL_CHANGED",
    );
  });

  it("marks a proposal superseded and runs nothing when its premises no longer hold", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    const id = ID("act");
    await propose(id);
    handlers.premises = { ok: false, reason: "目标被改过" };
    expect(await failureOf(box.adopt(id, await seen(id)))).toBe("PROPOSAL_SUPERSEDED");
    expect(handlers.executed).toBe(0);
    expect(row(id)).toMatchObject({ status: "superseded", exec: "not_started", attempts: 0 });
    expect(await failureOf(box.adopt(id))).toBe("PROPOSAL_SUPERSEDED");
    expect(await failureOf(box.reject(id))).toBe("PROPOSAL_SUPERSEDED");
  });

  it("records the execution result separately from the owner's decision", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    const differs = ID("differs");
    await propose(differs);
    handlers.readBack = "differs";
    expect(await box.adopt(differs, await seen(differs))).toMatchObject({ execution: "failed" });
    expect(row(differs)).toMatchObject({ status: "accepted", exec: "failed" });

    const unknown = ID("unknown");
    await propose(unknown);
    handlers.readBack = "throws";
    expect(await box.adopt(unknown, await seen(unknown))).toMatchObject({ execution: "unknown" });
    expect(row(unknown)).toMatchObject({ status: "accepted", exec: "unknown" });

    const broken = ID("broken");
    await propose(broken);
    handlers.failure = new Error("store offline");
    expect(await failureOf(box.adopt(broken, await seen(broken)))).toBe(
      "PROPOSAL_EXECUTION_FAILED",
    );
    expect(row(broken)).toMatchObject({ status: "accepted", exec: "failed", lease: null });
    expect(await failureOf(box.adopt(broken))).toBe("PROPOSAL_ACCEPTED");
  });

  it("lets only one of two simultaneous taps execute", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    const id = ID("act");
    await propose(id);
    const expected = await seen(id);
    const results = await Promise.all([
      failureOf(box.adopt(id, expected)),
      failureOf(box.adopt(id, expected)),
    ]);
    expect(handlers.executed).toBe(1);
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(row(id)).toMatchObject({ exec: "succeeded", attempts: 1 });
  });

  it("verifies an expired lease by reading back instead of running it again", async () => {
    const { box, clock, row, propose, seen, repository, handlers } = await fixture({
      leaseSeconds: 60,
    });
    const claim = async (id: string) =>
      repository.ownerProposals().claim({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        proposalId: id,
        expected: await seen(id),
        leaseId: `lease-${id.slice(0, 4)}`,
        leaseExpiresAt: new Date(Date.parse(START) + 60_000).toISOString(),
        now: START,
      });
    const stuck = ID("stuck");
    await propose(stuck);
    await claim(stuck);
    expect(row(stuck)).toMatchObject({ status: "accepted", exec: "running", attempts: 1 });
    expect(await failureOf(box.adopt(stuck))).toBe("PROPOSAL_EXECUTING");

    clock.value = new Date(Date.parse(START) + 61_000).toISOString();
    handlers.readBack = "matches";
    await box.list();
    expect(row(stuck)).toMatchObject({ exec: "unknown", lease: null });
    expect(handlers.executed).toBe(0);

    const missing = ID("missing");
    clock.value = START;
    await propose(missing);
    await claim(missing);
    clock.value = new Date(Date.parse(START) + 61_000).toISOString();
    handlers.readBack = "differs";
    await box.list();
    expect(row(missing)).toMatchObject({ exec: "failed" });

    const unreadable = ID("unreadable");
    clock.value = START;
    await propose(unreadable);
    await claim(unreadable);
    clock.value = new Date(Date.parse(START) + 61_000).toISOString();
    handlers.readBack = "throws";
    await box.list();
    expect(row(unreadable)).toMatchObject({ exec: "unknown" });
    expect(handlers.executed).toBe(0);
  });

  it("leaves an execution that outlives its lease to the process that is still running it", async () => {
    const { box, clock, row, propose, seen, handlers } = await fixture({ leaseSeconds: 60 });
    handlers.executeDelay = 80;
    const id = ID("slow");
    await propose(id);
    const adopting = box.adopt(id, await seen(id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.value = new Date(Date.parse(START) + 61_000).toISOString();
    handlers.readBack = "differs";
    await box.list();
    expect(row(id)).toMatchObject({ exec: "running" });
    expect(await adopting).toMatchObject({ execution: "failed" });
  });

  it("demands proof that the owner is present only for actions that ask for it", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    handlers.askForPresence();
    const id = ID("act");
    await propose(id);
    expect(row(id)).toMatchObject({ presence: 1 });
    expect(await failureOf(box.adopt(id, await seen(id)))).toBe("PROPOSAL_PRESENCE_REQUIRED");
    expect(
      await failureOf(
        box.adopt(id, await seen(id), {
          assertPresence: async () => {
            throw new Error("RECENT_AUTH_REQUIRED");
          },
        }),
      ),
    ).toBe("Error: RECENT_AUTH_REQUIRED");
    expect(row(id)).toMatchObject({ status: "pending", exec: "not_started", attempts: 0 });
    expect(handlers.executed).toBe(0);
    let checked = 0;
    await box.adopt(id, await seen(id), {
      assertPresence: async () => {
        checked += 1;
      },
    });
    expect(checked).toBe(1);
    expect(row(id)).toMatchObject({ exec: "succeeded" });
  });

  it("does not ask for presence from an action that did not register for it", async () => {
    const { box, row, propose, seen } = await fixture();
    const plain = ID("plain");
    await propose(plain);
    expect(row(plain)).toMatchObject({ presence: 0 });
    await box.adopt(plain, await seen(plain));
    expect(row(plain)).toMatchObject({ exec: "succeeded" });
  });

  it("marks outside-content proposals on the server and makes a task need the full text read", async () => {
    const { box, clock, row, propose, seen, handlers } = await fixture();
    const task = ID("task");
    await propose(task, { externalContentSeen: true, origin: "owner_said" }, "do_a_thing");
    expect(row(task)).toMatchObject({ origin: "external_content", fullRead: 1 });
    const listed = (await box.list()).proposals.find((item) => item.proposalId === task);
    expect(listed).toMatchObject({ origin: "external_content", requiresFullRead: true });
    const expected = await seen(task);

    expect(await failureOf(box.adopt(task, expected))).toBe("PROPOSAL_FULL_READ_REQUIRED");
    expect(await failureOf(box.adopt(task, expected, { fullReadToken: "made-up" }))).toBe(
      "PROPOSAL_FULL_READ_REQUIRED",
    );
    expect(
      await failureOf(
        box.openFull(task, { version: expected.version, fingerprint: "0".repeat(64) }),
      ),
    ).toBe("PROPOSAL_CHANGED");

    const stale = await box.openFull(task, expected);
    clock.value = new Date(Date.parse(START) + 11 * 60_000).toISOString();
    expect(await failureOf(box.adopt(task, expected, { fullReadToken: stale.fullReadToken }))).toBe(
      "PROPOSAL_FULL_READ_REQUIRED",
    );
    expect(handlers.adopted).toBe(0);

    const opened = await box.openFull(task, expected);
    await box.adopt(task, expected, { fullReadToken: opened.fullReadToken });
    expect(handlers.adopted).toBe(1);
  });

  it("leaves a fixed action and the owner's own tasks free of the full-text rule", async () => {
    const { box, row, propose, seen } = await fixture();
    const act = ID("act");
    await propose(act, { externalContentSeen: true });
    expect(row(act)).toMatchObject({ origin: "external_content", fullRead: 0 });
    await box.adopt(act, await seen(act));
    expect(row(act)).toMatchObject({ exec: "succeeded" });

    const mine = ID("mine");
    await propose(mine, {}, "do_a_thing");
    expect(row(mine)).toMatchObject({ origin: "inferred", fullRead: 0 });
    await box.adopt(mine, await seen(mine));
  });

  it("does not accept a token that was opened for another version of the proposal", async () => {
    const { box, propose, seen, handlers } = await fixture();
    const task = ID("task");
    await propose(task, { externalContentSeen: true }, "do_a_thing");
    const opened = await box.openFull(task, await seen(task));
    await propose(task, { externalContentSeen: true, data: { changed: true } }, "do_a_thing");
    const latest = await seen(task);
    expect(await failureOf(box.adopt(task, latest, { fullReadToken: opened.fullReadToken }))).toBe(
      "PROPOSAL_FULL_READ_REQUIRED",
    );
    expect(handlers.adopted).toBe(0);
  });

  it("takes the recent-authentication proof and the full-text token from the command", async () => {
    const { box, propose, seen, handlers } = await fixture();
    handlers.askForPresence();
    const id = ID("act");
    await propose(id);
    const expected = await seen(id);
    const calls: unknown[] = [];
    const control = new ProductionProposalControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      box,
      clock: { now: () => START },
      recentAuthentication: {
        assertRecentAuthentication: async (input) => {
          calls.push(input.expectedAuthenticationRef);
          return {} as never;
        },
      },
    });
    const command = (action: string) =>
      ({
        kind: "command",
        type: "proposal.respond",
        actor: { actorType: "owner", actorId: "owner" },
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        payload: {
          proposalId: id,
          action,
          expectedVersion: expected.version,
          fingerprint: expected.fingerprint,
          recentAuthenticationRef: "auth-1",
          fullReadToken: null,
        },
      }) as never;
    const authentication = { subjectId: "owner" } as never;
    expect(await control.execute(authentication, command("adopt"))).toEqual({
      resultRef: id,
      replayed: false,
    });
    expect(calls).toEqual(["auth-1"]);
    expect(await control.execute(authentication, command("undo"))).toEqual({
      resultRef: id,
      replayed: false,
    });
    expect(handlers.undone).toBe(1);
  });

  it("never records a success it cannot undo when the original-state payload could not be stored", async () => {
    const { box, row, propose, seen, handlers } = await fixture({ failExecutionPayload: true });
    const id = ID("nopayload");
    await propose(id);
    expect(await box.adopt(id, await seen(id))).toMatchObject({ execution: "unknown" });
    expect(row(id)).toMatchObject({ exec: "unknown" });
    expect(handlers.executed).toBe(1);
  });

  it("runs the undo once when two undo requests arrive together", async () => {
    const { box, row, propose, seen, handlers } = await fixture();
    const id = ID("twice");
    await propose(id);
    const expected = await seen(id);
    await box.adopt(id, expected);
    handlers.undoDelay = 20;
    const results = await Promise.all([box.undo(id, expected), box.undo(id, expected)]);
    expect(handlers.undone).toBe(1);
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(row(id)).toMatchObject({ exec: "undone" });
  });

  it("does not let the proposer lower the full-read requirement of outside content", async () => {
    const { row, propose } = await fixture();
    const task = ID("lowered");
    await propose(
      task,
      { externalContentSeen: true, origin: "owner_said", requiresFullRead: false },
      "do_a_thing",
    );
    expect(row(task)).toMatchObject({ fullRead: 1 });
  });
});
