import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnvironmentLocator } from "@himawari-agent/execution-contracts";
import { containerRunnerDigest } from "@himawari-agent/runtime-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContainerQualification,
  dockerHost,
  grant,
  type QualificationBackend,
  type QualificationTarget,
  runnerImageId,
  stopAndProve,
} from "./container-qualification-support.ts";

const enabled = process.env["HIMAWARI_CONTAINER_RUNNER_QUALIFICATION"] === "1";
const runtimeRoot = process.env["HIMAWARI_CONTAINER_RUNTIME_ROOT"] ?? "";
const runtimeDigest = process.env["HIMAWARI_CONTAINER_RUNTIME_DIGEST"] ?? "";
const runnerDescribe = enabled ? describe : describe.skip;
const qualification = new ContainerQualification();
const RUNNER =
  "/opt/himawari/node_modules/@himawari-agent/agent-service/dist/capability-programs/container-pi-main.js";

async function approvedDirectory(canonicalRootId: string, files: Record<string, string>) {
  const directory = await mkdtemp(path.join(qualification.hostRoot, `${canonicalRootId}-`));
  await chmod(directory, 0o755);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  const info = await lstat(directory);
  qualification.approved.set(canonicalRootId, {
    canonicalPath: directory,
    device: String(info.dev),
    inode: String(info.ino),
  });
  return directory;
}

function runnerBackend() {
  return qualification.backend(dockerHost, {
    image: { reference: "himawari/runner", digest: runnerImageId, pin: "image-id" },
    runtime: { source: runtimeRoot, digest: runtimeDigest },
  });
}

async function openEnvironment(canonicalRootId: string, access: "read" | "write") {
  const subject = runnerBackend();
  const target = qualification.environment(900, [grant(canonicalRootId, access)]);
  const locator = await subject.create({
    ...target.create,
    imageDigest: runnerImageId,
    runnerDigest: containerRunnerDigest(runtimeDigest),
  });
  return { subject, target, locator };
}

async function tool(
  environment: {
    subject: QualificationBackend;
    target: QualificationTarget;
    locator: ExecutionEnvironmentLocator;
  },
  canonicalRootId: string,
  access: "read" | "write",
  name: string,
  parameters: Record<string, unknown>,
) {
  const ref = `arguments-${randomUUID()}`;
  const input = {
    schemaVersion: "pi-container-runner.v1",
    tool: name,
    toolCallId: `call-${randomUUID()}`,
    hostId: "host-q",
    canonicalRootId,
    workspace: `/workspaces/${canonicalRootId}`,
    grantRef: `grant-${canonicalRootId}`,
    grantRevision: 1,
    authorizationRef: `authorization-${canonicalRootId}`,
    access,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxOutputBytes: 65536,
    parametersJson: JSON.stringify(parameters),
  };
  qualification.argumentsByRef.set(ref, { argv: ["node", RUNNER, JSON.stringify(input)] });
  const { outputRef } = await environment.subject.execute({
    ...environment.target,
    locator: environment.locator,
    stopFence: 0,
    invocationId: `invocation-${randomUUID()}`,
    argumentsRef: ref,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    authorizationRef: input.authorizationRef,
  });
  const output = await environment.subject.readOutput(outputRef);
  const result = output.stdout.startsWith("{") ? JSON.parse(output.stdout) : null;
  const text = result?.content?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
  return { exitCode: output.exitCode, stderr: output.stderr, result, text };
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

runnerDescribe("the Pi tool runner inside a container environment", () => {
  beforeAll(async () => {
    await qualification.setup();
  });
  afterAll(async () => {
    if (enabled) await qualification.cleanup();
  });

  it(
    "runs every Pi tool on the mounted directory and the host reads back each change",
    { timeout: 5 * 60_000 },
    async () => {
      expect(runnerImageId, "HIMAWARI_CONTAINER_RUNNER_IMAGE_ID").toMatch(/^[a-f0-9]{64}$/);
      expect(runtimeDigest, "HIMAWARI_CONTAINER_RUNTIME_DIGEST").toMatch(/^[a-f0-9]{64}$/);
      const directory = await approvedDirectory("pi-write", {
        "src/app.ts": "export const value = 1;\n",
        "notes/todo.md": "needle in notes\n",
        ".git/config": "[core]\n\tprotected-marker = git\n",
        ".himawari-state.txt": "protected-marker himawari\n",
      });
      const environment = await openEnvironment("pi-write", "write");
      const run = (name: string, parameters: Record<string, unknown>) =>
        tool(environment, "pi-write", "write", name, parameters);

      const write = await run("write", {
        path: "src/new.ts",
        content: "export const created = 2;\n",
      });
      expect(write.exitCode, write.stderr).toBe(0);
      const written = await readFile(path.join(directory, "src/new.ts"));
      expect(written.toString()).toBe("export const created = 2;\n");
      expect(write.result.verifiedWrite).toMatchObject({
        contentDigest: sha256(written),
        byteLength: written.length,
      });

      const edit = await run("edit", {
        path: "src/app.ts",
        edits: [{ oldText: "value = 1", newText: "value = 3" }],
      });
      expect(edit.exitCode, edit.stderr).toBe(0);
      const edited = await readFile(path.join(directory, "src/app.ts"));
      expect(edited.toString()).toBe("export const value = 3;\n");
      expect(edit.result.verifiedWrite.contentDigest).toBe(sha256(edited));

      const read = await run("read", { path: "src/app.ts" });
      expect(read.text).toContain("export const value = 3;");
      const grep = await run("grep", { pattern: "needle" });
      expect(grep.text).toContain("notes/todo.md");
      const find = await run("find", { pattern: "*.ts" });
      expect(find.text).toContain("src/new.ts");
      const ls = await run("ls", { path: "src" });
      expect(ls.text).toContain("app.ts");

      const bash = await run("bash", {
        command: "node --version && printf built > dist.txt && git --version | cut -d' ' -f1",
      });
      expect(bash.exitCode, bash.stderr).toBe(0);
      expect(bash.text).toContain("v22.22.3");
      expect(bash.text).toContain("git");
      expect(await readFile(path.join(directory, "dist.txt"), "utf8")).toBe("built");
      const failing = await run("bash", { command: "exit 7" });
      expect(failing.exitCode).toBe(7);
      expect(failing.result.commandExitCode).toBe(7);

      for (const blocked of [".git/config", ".himawari-state.txt", ".env"]) {
        const refused = await run("read", { path: blocked });
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain("PI_RUNNER_EXECUTION_FAILED");
        expect(`${refused.text}${refused.stderr}`).not.toContain("protected-marker");
      }
      expect(
        (await stopAndProve(environment.subject, environment.target, environment.locator)).basis,
      ).toBe("verified_stopped");

      const readOnlyDirectory = await approvedDirectory("pi-read", { "data.txt": "original\n" });
      const readOnly = await openEnvironment("pi-read", "read");
      const refusedWrite = await tool(readOnly, "pi-read", "read", "write", {
        path: "data.txt",
        content: "changed\n",
      });
      expect(refusedWrite.exitCode).toBe(1);
      const shellWrite = await tool(readOnly, "pi-read", "read", "bash", {
        command: "printf changed > data.txt",
      });
      expect(shellWrite.exitCode).not.toBe(0);
      expect(await readFile(path.join(readOnlyDirectory, "data.txt"), "utf8")).toBe("original\n");
      expect((await stopAndProve(readOnly.subject, readOnly.target, readOnly.locator)).basis).toBe(
        "verified_stopped",
      );

      qualification.observations["piRunner"] = {
        runtimeDigest,
        write: write.result.verifiedWrite,
        edit: edit.result.verifiedWrite,
        read: read.text.slice(0, 200),
        grep: grep.text,
        find: find.text,
        ls: ls.text,
        bash: bash.text,
        failingExitCode: failing.exitCode,
        readOnlyShellExitCode: shellWrite.exitCode,
      };
    },
  );
});
