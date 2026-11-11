import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/operations/mcp-write-acceptance.mjs",
);
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("[P5-2] MCP write acceptance server script", () => {
  it.each([
    [[]],
    [["serve", "--dir", "relative/dir", "--host", "127.0.0.1"]],
    [["serve", "--dir", "/tmp/x"]],
    [["report"]],
    [["serve", "--dir", "/tmp/x", "--host", "127.0.0.1", "--token", "leak"]],
  ])("refuses %j before touching anything", (args) => {
    const result = run(...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ARGUMENT_INVALID");
    expect(result.stdout).not.toContain("MCP_ACCEPTANCE_LISTENING");
  });
});
