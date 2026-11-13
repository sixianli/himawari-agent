import { describe, expect, it } from "vitest";
import { ProductionFilesControl } from "../src/production-files-control.ts";

describe("ProductionFilesControl", () => {
  it("cuts a long file name to 256 and a long media type to 128 characters", async () => {
    const file = { id: "f1", threadId: "t1", path: `n/${"n".repeat(300)}`, kind: "document" };
    const control = new ProductionFilesControl({
      configuration: { ownerId: "o1", agentId: "a1" } as never,
      store: {
        list: async () => ({
          items: [{ ...file, source: "bash", mediaType: `t/${"x".repeat(200)}`, sizeBytes: 1 }],
          nextCursor: null,
        }),
      } as never,
      clock: { now: () => "2026-11-13T00:00:00.000Z" },
    });
    const snapshot = await control.query(
      { type: "files.list.read", scope: { ownerId: "o1", agentId: "a1" }, payload: {} } as never,
      { authentication: { ownerId: "o1" } } as never,
    );
    if (snapshot.type !== "files.list.snapshot") throw new Error(snapshot.type);
    const [entry] = snapshot.payload.files;
    expect([entry?.name.length, entry?.mediaType.length]).toEqual([256, 128]);
  });
});
