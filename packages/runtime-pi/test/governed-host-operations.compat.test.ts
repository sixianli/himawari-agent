import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import { describe, expect, it, vi } from "vitest";
import {
  createGovernedPiCodingTools,
  createPiOperationsFromGovernedHostPort,
} from "../src/index.js";

describe("governed Pi host operations", () => {
  it("converts Pi seconds to product milliseconds and rejects invalid limits before dispatch", async () => {
    const executeCommand = vi.fn(async () => ({ exitCode: 0 }));
    const unused = async () => {
      throw new Error("unexpected file operation");
    };
    const operations = createPiOperationsFromGovernedHostPort({
      access: unused,
      readFile: unused,
      writeFile: unused,
      makeDirectory: unused,
      executeCommand,
    });
    const onData = () => undefined;
    const signal = new AbortController().signal;
    await operations.bash?.exec("git push", "/workspace", { timeout: 2.5, onData, signal });
    expect(executeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 2500, signal }),
    );
    await operations.bash?.exec("git push", "/workspace", { onData });
    expect(executeCommand).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484]) {
      await expect(
        operations.bash?.exec("git push", "/workspace", { timeout, onData }),
      ).rejects.toThrow("PI_GOVERNED_INVALID_TIMEOUT_SECONDS");
    }
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("reuses Pi tool schemas and delegates every enabled operation to the governed port", async () => {
    const calls: string[] = [];
    const port: GovernedCodingOperationsPort = {
      async access(path, mode) {
        calls.push(`access:${mode}:${path}`);
      },
      async readFile(path) {
        calls.push(`read:${path}`);
        return new TextEncoder().encode("governed content");
      },
      async writeFile(path, content) {
        calls.push(`write:${path}:${content}`);
      },
      async makeDirectory(path) {
        calls.push(`mkdir:${path}`);
      },
      async executeCommand({ command, cwd, onData }) {
        calls.push(`command:${cwd}:${command}`);
        onData(new TextEncoder().encode("checked"));
        return { exitCode: 0 };
      },
    };
    const operations = createPiOperationsFromGovernedHostPort(port);
    const tools = createGovernedPiCodingTools({
      cwd: "/workspace",
      enabled: ["read", "write", "bash"],
      operations,
    });
    expect(tools.map(({ name }) => name)).toEqual(["read", "write", "bash"]);
    expect(tools.every(({ parameters }) => parameters !== undefined)).toBe(true);

    await operations.read?.access("/workspace/file.txt");
    await operations.read?.readFile("/workspace/file.txt");
    await operations.write?.writeFile("/workspace/new.txt", "new");
    await operations.bash?.exec("npm test", "/workspace", { onData: () => undefined });
    expect(calls).toContain("read:/workspace/file.txt");
    expect(calls).toContain("write:/workspace/new.txt:new");
    expect(calls).toContain("command:/workspace:npm test");
  });
});
