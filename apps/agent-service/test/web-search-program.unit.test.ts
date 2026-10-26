import { Readable } from "node:stream";
import { SANDBOX_PROXY } from "@himawari-agent/platform-node";
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
  dispatchers: [] as unknown[],
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("@himawari-agent/platform-node", async (original) => {
  const actual = await original<typeof import("@himawari-agent/platform-node")>();
  const { WEB_PROVIDERS } = await import("@himawari-agent/application");
  return {
    ...actual,
    createWebProvider: (...input: Parameters<typeof actual.createWebProvider>) => {
      boundary.dispatchers.push(input[2]);
      return input[0] === "exa-public"
        ? { descriptor: WEB_PROVIDERS["exa-public"], search: boundary.search, fetch: vi.fn() }
        : actual.createWebProvider(...input);
    },
  };
});

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
  boundary.dispatchers.length = 0;
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
      message: "公开搜索服务正在限流，请等几秒再搜一次，不要连续重试。",
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
      error: "WEB_SEARCH_UNAVAILABLE",
      message: "搜索服务暂时不可用，马上重试大概率仍会失败，请稍后再试。",
    });
    expect(written(boundary.process.stderr)).toBe("WEB_SEARCH_UNAVAILABLE\n");
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
    expect(boundary.dispatchers).toEqual([SANDBOX_PROXY]);
    expect(boundary.process.stderr.write).not.toHaveBeenCalled();
  });
});
