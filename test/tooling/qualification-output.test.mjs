import { afterEach, expect, it, vi } from "vitest";

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createServer: vi.fn(async (config) => {
      // Reproduce Vite's cold-cache diagnostic without running sandbox I/O.
      const logger = config.customLogger ?? actual.createLogger();
      logger.info("Re-optimizing dependencies because vite config has changed");
      logger.warn("qualification diagnostic warning");
      return {
        ssrLoadModule: async () => ({
          qualifyProductionSandbox: async () => ({ probe: "controlled" }),
        }),
        close: vi.fn(),
      };
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps qualification stdout as one JSON value and preserves diagnostics on stderr", async () => {
  vi.stubEnv("HIMAWARI_LIVE_SANDBOX_PROBE", "1");
  vi.stubEnv("HIMAWARI_QUALIFY_INSTALLED_RUNTIME", "");
  const stdout = [];
  const stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  // Vitest redirects the global console; retain real stream behavior here.
  vi.spyOn(console, "log").mockImplementation((message) => process.stdout.write(`${message}\n`));
  vi.spyOn(console, "warn").mockImplementation((message) => process.stderr.write(`${message}\n`));
  await import("../../packages/runtime-sandbox/scripts/qualify-production.mjs");
  expect(JSON.parse(stdout.join(""))).toEqual({
    probe: "controlled",
    installedRuntime: null,
    installedModules: [],
  });
  expect(stderr.join("")).toContain("Re-optimizing dependencies");
  expect(stderr.join("")).toContain("qualification diagnostic warning");
});
