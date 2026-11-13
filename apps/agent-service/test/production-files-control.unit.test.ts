import { describe, expect, it } from "vitest";
import { ProductionFilesControl } from "../src/production-files-control.ts";

describe("ProductionFilesControl", () => {
  it("cuts a long file name to 256 and a long media type to 128 characters", async () => {
    const file = { id: "f1", threadId: "t1", path: `n/\u202E${"n".repeat(300)}`, kind: "document" };
    const control = new ProductionFilesControl({
      configuration: { ownerId: "o1", agentId: "a1" } as never,
      store: {
        list: async () => ({
          items: [{ ...file, source: "bash", mediaType: `t/${"x".repeat(200)}`, sizeBytes: 1 }],
          nextCursor: null,
        }),
      } as never,
      threadTitle: async () => `\u202E${"t".repeat(300)}`,
      clock: { now: () => "2026-11-13T00:00:00.000Z" },
    });
    const snapshot = await control.query(
      { type: "files.list.read", scope: { ownerId: "o1", agentId: "a1" }, payload: {} } as never,
      { authentication: { ownerId: "o1" } } as never,
    );
    if (snapshot.type !== "files.list.snapshot") throw new Error(snapshot.type);
    const [entry] = snapshot.payload.files;
    expect([entry?.name.length, entry?.mediaType.length, entry?.threadTitle?.length]).toEqual([
      256, 128, 256,
    ]);
    expect(entry?.threadTitle?.startsWith("\uFFFDt")).toBe(true);
    expect(entry?.name.startsWith("\uFFFDn")).toBe(true);
  });

  it("reads each conversation title once per page and shows null when one title cannot be read", async () => {
    const asked: string[] = [];
    const item = (id: string, threadId: string) => ({
      id,
      threadId,
      path: `n/${id}.md`,
      kind: "document",
      source: "bash",
      mediaType: "text/markdown",
      sizeBytes: 1,
    });
    const control = new ProductionFilesControl({
      configuration: { ownerId: "o1", agentId: "a1" } as never,
      store: {
        list: async () => ({
          items: [item("f1", "t-ok"), item("f2", "t-bad"), item("f3", "t-ok")],
          nextCursor: null,
        }),
      } as never,
      threadTitle: async (threadId: string) => {
        asked.push(threadId);
        if (threadId === "t-bad") throw new Error("PAYLOAD_UNREADABLE");
        return "周五去大阪";
      },
      clock: { now: () => "2026-11-13T00:00:00.000Z" },
    });
    const snapshot = await control.query(
      { type: "files.list.read", scope: { ownerId: "o1", agentId: "a1" }, payload: {} } as never,
      { authentication: { ownerId: "o1" } } as never,
    );
    if (snapshot.type !== "files.list.snapshot") throw new Error(snapshot.type);
    expect(snapshot.payload.files.map(({ threadTitle }) => threadTitle)).toEqual([
      "周五去大阪",
      null,
      "周五去大阪",
    ]);
    expect(asked).toEqual(["t-ok", "t-bad"]);
  });
});
