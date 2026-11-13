import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import { expect, it } from "vitest";
import { executeSandboxedPiCodingTool } from "../src/sandboxed-coding-executor.js";

it("reports the UTF-8 byte length of an actual governed write", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "himawari-write-bytes-"));
  try {
    const result = await executeSandboxedPiCodingTool({
      name: "write",
      toolCallId: "fixture:write",
      cwd,
      parameters: { path: "note.txt", content: "青柠灯塔72" },
      operations: {
        access: async (path) => access(path),
        readFile: async (path) => readFile(path),
        writeFile: async (path, content) => writeFile(path, content),
        makeDirectory: async (path) => {
          await mkdir(path, { recursive: true });
        },
        executeCommand: async () => {
          throw new Error("UNEXPECTED_COMMAND");
        },
      },
    });
    expect((await readFile(join(cwd, "note.txt"))).byteLength).toBe(14);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Successfully wrote 14 bytes to note.txt" },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function commandOperations(
  executeCommand: GovernedCodingOperationsPort["executeCommand"],
): GovernedCodingOperationsPort {
  const unused = async (): Promise<never> => {
    throw new Error("UNEXPECTED_FILE_OPERATION");
  };
  return {
    access: unused,
    readFile: unused,
    writeFile: unused,
    makeDirectory: unused,
    executeCommand,
  };
}

async function nativePiBashFailureText(
  output: string,
  failure: string,
  parameters: { readonly command: string; readonly timeout?: number },
): Promise<string> {
  const bash = createBashTool("/workspace", {
    operations: {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from(output, "utf8"));
        throw new Error(failure);
      },
    },
  });
  try {
    await bash.execute("reference:native-pi", parameters);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("NATIVE_PI_BASH_DID_NOT_FAIL");
}

it("reports a nonzero command exit as a failed tool result, as Pi's bash tool does", async () => {
  const run = (exitCode: number) =>
    executeSandboxedPiCodingTool({
      name: "bash",
      toolCallId: `fixture:exit-${exitCode}`,
      cwd: "/workspace",
      parameters: { command: "npm test" },
      operations: commandOperations(async ({ onData }) => {
        onData(new TextEncoder().encode("not ok 4 - rounds totals\n"));
        return { exitCode };
      }),
    });
  const failed = await run(3);
  expect(failed.isError).toBe(true);
  const [part] = failed.content;
  const text = part?.type === "text" ? part.text : "";
  expect(text).toContain("not ok 4 - rounds totals");
  expect(text.endsWith("Command exited with code 3")).toBe(true);
  const passed = await run(0);
  expect(passed.isError).toBe(false);
});

it("[R2-T14] keeps the output before a command timeout in Pi's timeout result", async () => {
  const output = "R2T14-BEFORE-TIMEOUT\n";
  const parameters = { command: "sleep 30", timeout: 2 };
  const result = await executeSandboxedPiCodingTool({
    name: "bash",
    toolCallId: "fixture:timeout",
    cwd: "/workspace",
    parameters,
    operations: commandOperations(async ({ onData }) => {
      onData(new TextEncoder().encode(output));
      throw new Error("PI_COMMAND_TIMEOUT");
    }),
  });
  const nativeText = await nativePiBashFailureText(output, "timeout:2", parameters);
  expect(nativeText).toContain("R2T14-BEFORE-TIMEOUT");
  expect(nativeText.endsWith("Command timed out after 2 seconds")).toBe(true);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: nativeText }]);
});

it("[R2-T14] keeps the output tail when the command output ceiling stops a command", async () => {
  const result = await executeSandboxedPiCodingTool({
    name: "bash",
    toolCallId: "fixture:output-limit",
    cwd: "/workspace",
    parameters: { command: "seq 1 400000" },
    operations: commandOperations(async ({ onData }) => {
      for (let line = 1; line <= 3; line++)
        onData(new TextEncoder().encode(`R2T14-LINE-${line}\n`));
      throw new Error("PI_COMMAND_OUTPUT_LIMIT");
    }),
  });
  expect(result.isError).toBe(true);
  const [part] = result.content;
  expect(part).toMatchObject({ type: "text" });
  const text = part?.type === "text" ? part.text : "";
  expect(text).toMatch(/^R2T14-LINE-1\nR2T14-LINE-2\nR2T14-LINE-3\n/);
  expect(text).toContain("命令输出上限");
  expect(text).not.toContain("PI_COMMAND_OUTPUT_LIMIT");
});

it("[R2-T14] explains the output ceiling even when the command printed nothing it kept", async () => {
  const result = await executeSandboxedPiCodingTool({
    name: "bash",
    toolCallId: "fixture:output-limit-empty",
    cwd: "/workspace",
    parameters: { command: "yes" },
    operations: commandOperations(async () => {
      throw new Error("PI_COMMAND_OUTPUT_LIMIT");
    }),
  });
  expect(result.isError).toBe(true);
  const [part] = result.content;
  const text = part?.type === "text" ? part.text : "";
  expect(text.startsWith("输出超过命令输出上限")).toBe(true);
});

it("[ADR-0198] refuses tool arguments that are not plain JSON before Pi runs the tool", async () => {
  const commands: string[] = [];
  for (const extra of [undefined, 1n, new Map()])
    await expect(
      executeSandboxedPiCodingTool({
        name: "bash",
        toolCallId: "fixture:not-json",
        cwd: "/workspace",
        parameters: { command: "echo hi", extra },
        operations: commandOperations(async ({ command }) => {
          commands.push(command);
          return { exitCode: 0 };
        }),
      }),
    ).rejects.toThrow("PI_TOOL_ARGUMENTS_INVALID");
  expect(commands).toEqual([]);
});
