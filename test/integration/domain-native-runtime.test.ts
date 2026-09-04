import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

async function exercise(specifier: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { transitionRun, createRunId, createOwnerId, createAgentId,
      createSessionId, createTriggerId } from ${JSON.stringify(specifier)};
    const result = transitionRun({ id: createRunId('run-native'),
      ownerId: createOwnerId('owner-native'), agentId: createAgentId('agent-native'),
      sessionId: createSessionId('session-native'), triggerId: createTriggerId('trigger-native'),
      status: 'building_context' }, 'running');
    process.stdout.write(result.status);
  `,
    ],
    { cwd: root },
  );
  expect(stdout).toBe("running");
}

it("loads the public domain source entry in native Node without a test loader", async () => {
  await exercise("@himawari-agent/domain");
});

it("rewrites domain imports to executable JavaScript when compiling production output", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "himawari-domain-build-"));
  try {
    await execute(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
        "--rewriteRelativeImportExtensions",
        "--outDir",
        output,
        path.join(root, "packages/domain/src/index.ts"),
      ],
      { cwd: root },
    );
    await exercise(pathToFileURL(path.join(output, "index.js")).href);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30_000);
