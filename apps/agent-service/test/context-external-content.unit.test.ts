import { expect, it, vi } from "vitest";
import {
  ContextExternalContent,
  ExternalContentMarkNotWrittenError,
  externalContentKey,
  externalContentSourceRefs,
  markRecalledExternalRecords,
  runExternalOrigins,
  threadExternalOrigins,
} from "../src/context-external-content.js";

const scope = { ownerId: "owner" as never, agentId: "agent" as never, runId: "run-1" as never };

function stateWith(records: Record<string, readonly string[]>) {
  return {
    readMany: vi.fn(async ({ memoryIds }: { memoryIds: readonly string[] }) =>
      memoryIds.flatMap((id) => (records[id] ? [{ id, sourceRefs: records[id] } as never] : [])),
    ),
  };
}

it("[ADR-0257] marks the run when context formation shows a memory written with external content", async () => {
  const marker = { mark: vi.fn(async () => undefined) };
  const state = stateWith({
    "memory:a": ["memory-content:a"],
    "memory:b": ["memory-content:b", ...externalContentSourceRefs("memory:b", ["web_fetch"])],
  });
  expect(
    await markRecalledExternalRecords({
      ...scope,
      marker,
      state,
      memoryIds: ["memory:a", "memory:b"],
    }),
  ).toBe(true);
  expect(marker.mark).toHaveBeenCalledWith("run-1", "recalled_external_record");
});

it("[ADR-0257] REVERSE: leaves the run unmarked when no shown memory carries the mark, and reads nothing for an empty result", async () => {
  const marker = { mark: vi.fn(async () => undefined) };
  const state = stateWith({ "memory:a": ["memory-content:a"] });
  expect(
    await markRecalledExternalRecords({ ...scope, marker, state, memoryIds: ["memory:a"] }),
  ).toBe(false);
  expect(await markRecalledExternalRecords({ ...scope, marker, state, memoryIds: [] })).toBe(false);
  expect(state.readMany).toHaveBeenCalledTimes(1);
  expect(marker.mark).not.toHaveBeenCalled();
});

it("[ADR-0257] gives each record its own sorted, de-duplicated marks so same-source dedupe never joins two records through them", () => {
  expect(
    externalContentSourceRefs("memory:x", ["web_fetch", "execution_task_output", "web_fetch"]),
  ).toEqual([
    "external-content:memory:x|execution_task_output",
    "external-content:memory:x|web_fetch",
  ]);
  expect(externalContentSourceRefs("memory:y", ["web_fetch"])).not.toEqual(
    externalContentSourceRefs("memory:x", ["web_fetch"]),
  );
});

it("[ADR-0257] keeps the source name readable in a mark even when the record id is at the length limit", () => {
  const refs = externalContentSourceRefs("r".repeat(600), ["web_fetch", `long_${"o".repeat(400)}`]);
  expect(refs).toHaveLength(2);
  for (const ref of refs) expect(ref.length).toBeLessThanOrEqual(512);
  expect(refs.some((ref) => ref.endsWith("|web_fetch"))).toBe(true);
  expect(refs.every((ref) => ref.includes("|"))).toBe(true);
  const [a] = externalContentSourceRefs(`${"r".repeat(600)}a`, [`${"o".repeat(300)}a`]);
  const [b] = externalContentSourceRefs(`${"r".repeat(600)}b`, [`${"o".repeat(300)}b`]);
  expect(a).not.toBe(b);
  expect(a?.length).toBeLessThanOrEqual(512);
});

function content(
  marks: Record<string, readonly string[]>,
  threads: Record<string, string>,
  commit: () => Promise<never> = async () => {
    throw new Error("unexpected write");
  },
) {
  return new ContextExternalContent({
    configuration: { ownerId: "owner" as never, agentId: "agent" as never },
    state: {
      readScopedState: async (_owner: unknown, _agent: unknown, key: string) =>
        marks[key]
          ? ({
              revision: 1,
              value: {
                sources: marks[key].map((origin) => ({
                  origin,
                  firstRunId: "run-0",
                  firstSeenAt: "2026-11-13T00:00:00.000Z",
                })),
              },
            } as never)
          : undefined,
      commitStateAndEvents: commit as never,
    } as never,
    source: {
      read: async (runId: string) =>
        threads[runId] ? ({ runId, threadId: threads[runId] } as never) : undefined,
    } as never,
    authority: () => ({}) as never,
    clock: { now: () => "2026-11-13T00:00:00.000Z" },
  });
}

it("[ADR-0257] gives capture the run's conversation marks and review the conversation's own marks, never another conversation's", async () => {
  const store = content(
    {
      [externalContentKey({ threadId: "thread-a", runId: "" })]: ["web_fetch"],
      [externalContentKey({ threadId: "thread-b", runId: "" })]: ["execution_task_output"],
      [externalContentKey({ threadId: null, runId: "run-solo" })]: ["external_event"],
    },
    { "run-a": "thread-a" },
  );
  expect(await runExternalOrigins(store)("run-a" as never)).toEqual(["web_fetch"]);
  expect(await runExternalOrigins(store)("run-solo" as never)).toEqual(["external_event"]);
  expect(await threadExternalOrigins(store)("thread-a")).toEqual(["web_fetch"]);
  expect(await threadExternalOrigins(store)("thread-b")).toEqual(["execution_task_output"]);
  expect(await threadExternalOrigins(store)("thread-none")).toEqual([]);
  expect(await runExternalOrigins(undefined)("run-a" as never)).toEqual([]);
  expect(await threadExternalOrigins(undefined)("thread-a")).toEqual([]);
});

it("[ADR-0257] reports a mark that could not be written apart from a mark state that could not be read", async () => {
  const failingWrite = content({}, { "run-a": "thread-a" }, async () => {
    throw new Error("DISK_DOWN");
  });
  await expect(failingWrite.mark("run-a" as never, "web_fetch")).rejects.toBeInstanceOf(
    ExternalContentMarkNotWrittenError,
  );
  let down = true;
  const recovering = content({}, { "run-a": "thread-a" }, async () => {
    if (down) throw new Error("DISK_DOWN");
    return undefined as never;
  });
  await expect(recovering.mark("run-a" as never, "web_fetch")).rejects.toThrow();
  down = false;
  await expect(recovering.mark("run-a" as never, "web_search")).resolves.toBeUndefined();
  const unreadable = new ContextExternalContent({
    configuration: { ownerId: "owner" as never, agentId: "agent" as never },
    state: {
      readScopedState: async () => {
        throw new Error("STATE_READ_DOWN");
      },
      commitStateAndEvents: async () => {
        throw new Error("unexpected write");
      },
    } as never,
    source: { read: async () => undefined } as never,
    authority: () => ({}) as never,
    clock: { now: () => "2026-11-13T00:00:00.000Z" },
  });
  const error = await unreadable.mark("run-a" as never, "web_fetch").catch((caught) => caught);
  expect(error).not.toBeInstanceOf(ExternalContentMarkNotWrittenError);
  expect(String(error)).toContain("STATE_READ_DOWN");
});

it("[ADR-0257] writes many different sources read at the same moment without running out of retries", async () => {
  let stored: { revision: number; value: unknown } | undefined;
  let commits = 0;
  const store = new ContextExternalContent({
    configuration: { ownerId: "owner" as never, agentId: "agent" as never },
    state: {
      readScopedState: async () => {
        await Promise.resolve();
        return stored as never;
      },
      commitStateAndEvents: async (input: {
        state: { expectedRevision: number | null; value: unknown };
      }) => {
        await Promise.resolve();
        commits += 1;
        if ((stored?.revision ?? null) !== input.state.expectedRevision)
          throw Object.assign(new Error("raced"), { code: "PORT_CONFLICT" });
        stored = { revision: (stored?.revision ?? 0) + 1, value: input.state.value };
      },
    } as never,
    source: { read: async () => ({ threadId: "thread-a" }) as never },
    authority: () => ({}) as never,
    clock: { now: () => "2026-11-13T00:00:00.000Z" },
  });
  const origins = Array.from({ length: 12 }, (_, index) => `source_${index}`);
  await Promise.all(origins.map((origin) => store.mark("run-a" as never, origin)));
  expect((await store.readThread("thread-a")).map(({ origin }) => origin).sort()).toEqual(
    [...origins].sort(),
  );
  expect(commits).toBe(12);
});

it("[ADR-0285] marks the conversation as soon as an outside event starts a run, so the next run in it knows even if nothing was called", async () => {
  const stored = new Map<string, { revision: number; value: unknown }>();
  const sources: Record<string, object> = {
    "run-mail": { threadId: "thread-main", sourceType: "external_event", sourceId: "mail:42" },
    "run-owner": { threadId: "thread-main", sourceType: "user_message", sourceId: "msg:1" },
    "run-task": {
      threadId: "thread-task",
      sourceType: "external_event",
      sourceId: "task:1",
      ownerApprovedTask: true,
    },
    "run-own": { threadId: "thread-own", sourceType: "user_message", sourceId: "msg:2" },
  };
  const store = new ContextExternalContent({
    configuration: { ownerId: "owner" as never, agentId: "agent" as never },
    state: {
      readScopedState: async (_owner: unknown, _agent: unknown, key: string) =>
        stored.get(key) as never,
      commitStateAndEvents: async (input: { state: { key: string; value: unknown } }) => {
        stored.set(input.state.key, {
          revision: (stored.get(input.state.key)?.revision ?? 0) + 1,
          value: input.state.value,
        });
      },
    } as never,
    source: { read: async (runId: string) => ({ runId, ...sources[runId] }) as never },
    authority: () => ({}) as never,
    clock: { now: () => "2026-11-24T00:00:00.000Z" },
  });
  expect(await store.markRunSource("run-mail" as never)).toEqual(["external_event:mail:42"]);
  expect((await store.read("run-owner" as never)).map(({ origin }) => origin)).toEqual([
    "external_event:mail:42",
  ]);
  expect(await store.markRunSource("run-owner" as never)).toEqual([]);
  expect(await store.markRunSource("run-task" as never)).toEqual([]);
  expect(await store.markRunSource("run-own" as never)).toEqual([]);
  expect(await store.readThread("thread-task")).toEqual([]);
  expect(await store.readThread("thread-own")).toEqual([]);
});
