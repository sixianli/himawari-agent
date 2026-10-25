import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  process: {
    ...process,
    stdin: undefined as unknown,
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    exitCode: undefined as number | undefined,
  },
  search: vi.fn(),
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("@himawari-agent/platform-node", async (original) => ({
  ...(await original<object>()),
  ExaPublicSearchAdapter: class {
    search = boundary.search;
  },
}));

async function run(value: unknown) {
  boundary.process.stdin = Readable.from([Buffer.from(JSON.stringify(value))]);
  await import("../src/capability-programs/web-search-main.ts");
}
function written(stream: { write: ReturnType<typeof vi.fn> }) {
  return stream.write.mock.calls.map(([value]) => String(value)).join("");
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.process.exitCode = undefined;
});

describe("[R2-T13] installed public search program output", () => {
  it("hands the model a fixed rate-limit explanation and keeps the code on stderr", async () => {
    boundary.search.mockRejectedValue(new Error("WEB_SEARCH_RATE_LIMITED"));
    await run({ query: "Tokyo weather", limit: 3 });
    expect(boundary.search).toHaveBeenCalledWith({
      query: "Tokyo weather",
      limit: 3,
      signal: expect.any(AbortSignal),
    });
    expect(boundary.process.exitCode).toBe(1);
    expect(JSON.parse(written(boundary.process.stdout))).toEqual({
      error: "WEB_SEARCH_RATE_LIMITED",
      message: "公开搜索服务正在限流，请稍等片刻再搜索。",
    });
    expect(written(boundary.process.stderr)).toBe("WEB_SEARCH_RATE_LIMITED\n");
  });
  it("hides provider and proxy details behind the generic failure", async () => {
    boundary.search.mockRejectedValue(
      new Error("connect http://fixture:secret@127.0.0.1:4321 failed"),
    );
    await run({ query: "Tokyo weather" });
    expect(boundary.process.exitCode).toBe(1);
    const output = written(boundary.process.stdout) + written(boundary.process.stderr);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("127.0.0.1");
    expect(JSON.parse(written(boundary.process.stdout))).toEqual({
      error: "WEB_SEARCH_FAILED",
      message: "公开网页搜索失败。",
    });
    expect(written(boundary.process.stderr)).toBe("WEB_SEARCH_FAILED\n");
  });
  it("keeps the successful result shape and writes nothing to stderr", async () => {
    boundary.search.mockResolvedValue([
      {
        url: "https://example.org/weather",
        title: "Forecast",
        summary: "Title: Forecast",
        resultRank: 1,
        openedResourceId: null,
      },
    ]);
    await run({ query: "Tokyo weather" });
    expect(boundary.search).toHaveBeenCalledWith({
      query: "Tokyo weather",
      limit: 5,
      signal: expect.any(AbortSignal),
    });
    expect(boundary.process.exitCode).toBeUndefined();
    expect(JSON.parse(written(boundary.process.stdout))).toMatchObject({
      source: "Exa public web search",
      contentKind: "search_excerpts",
      pagesOpened: false,
      results: [{ url: "https://example.org/weather", openedResourceId: null }],
    });
    expect(boundary.process.stderr.write).not.toHaveBeenCalled();
  });
});
