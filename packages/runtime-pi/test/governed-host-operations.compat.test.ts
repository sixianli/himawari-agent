import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import { describe, expect, it } from "vitest";
import {
  createGovernedPiCodingTools,
  createPiOperationsFromGovernedHostPort,
} from "../src/index.js";

describe("governed Pi host operations", () => {
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
