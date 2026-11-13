import { expect, it, vi } from "vitest";
import {
  externalContentSourceRefs,
  markRecalledExternalRecords,
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
