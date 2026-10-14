import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { migratedDatabaseTemplate } from "../fixtures/sqlite-migrated-template.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const PHASES = [
  "context_formation",
  "model_stream",
  "approval_wait",
  "worker_result",
  "outbox",
  "thread_checkpoint",
  "memory_projection",
  "delivery",
] as const;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const childFixture = path.join(repositoryRoot, "test/fixtures/durable-phase-child.mjs");
let runtimeRoot = path.join(repositoryRoot, "dist/node-runtime");
let installation: string | undefined;
let phaseTemplate = "";
function warmRuntime(runtime: string): void {
  const packages = ["domain", "persistence-sqlite"].map((name) =>
    pathToFileURL(path.join(runtime, "node_modules", "@himawari-agent", name, "dist", "index.js")),
  );
  spawnSync(
    process.execPath,
    [
      "--no-global-search-paths",
      "-e",
      `Promise.all([${packages.map((url) => `import(${JSON.stringify(url.href)})`).join(", ")}]).then(() => {}, () => {});`,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
}
beforeAll(async () => {
  phaseTemplate = await migratedDatabaseTemplate();
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  if (!artifact && !context) {
    warmRuntime(runtimeRoot);
    return;
  }
  if (!artifact || !context) throw new Error("DURABLE_PHASE_ARTIFACT_CONTEXT_REQUIRED");
  installation = await mkdtemp(path.join(testTemporaryRoot(), "durable-phase-install-"));
  const installed = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      installation,
      "--artifact",
      artifact,
      "--context",
      context,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  if (installed.status !== 0) throw new Error(`DURABLE_PHASE_INSTALL_FAILED:${installed.stderr}`);
  runtimeRoot = path.join(installation, "lib/himawari-agent");
  warmRuntime(runtimeRoot);
}, 240_000);
afterAll(async () => {
  if (installation) await rm(installation, { recursive: true, force: true });
});
const cleanupRoots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all([...children].map((child) => kill(child)));
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function start(stateRoot: string, phase: (typeof PHASES)[number], mode: "seed" | "inspect") {
  const child = spawn(process.execPath, ["--no-global-search-paths", childFixture], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HIMAWARI_TEST_RUNTIME_ROOT: runtimeRoot,
      HIMAWARI_PHASE_TEMPLATE: phaseTemplate,
      HIMAWARI_PHASE_STATE_ROOT: stateRoot,
      HIMAWARI_PHASE_NAME: phase,
      HIMAWARI_PHASE_MODE: mode,
      NODE_PATH: "",
      NODE_OPTIONS: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function phaseOutput(
  child: ChildProcessWithoutNullStreams,
  options: {
    readonly expectExit: boolean;
    readonly phase: (typeof PHASES)[number];
    readonly mode: "seed" | "inspect";
  },
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: string | undefined;
    let readyObserved = false;
    const startedAt = Date.now();
    const timeline: Array<{
      readonly event: string;
      readonly at: string;
      readonly elapsedMs: number;
      readonly code?: number | null;
      readonly signal?: NodeJS.Signals | null;
    }> = [];
    const observe = (
      event: string,
      details: { readonly code?: number | null; readonly signal?: NodeJS.Signals | null } = {},
    ) => {
      timeline.push({
        event,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...details,
      });
    };
    const diagnostic = () => ({
      phase: options.phase,
      mode: options.mode,
      pid: child.pid ?? null,
      failure,
      stdout,
      stderr,
      timeline,
    });
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      failure = reason;
      clearTimeout(timeout);
      reject(new Error(`${reason}\n${JSON.stringify(diagnostic(), null, 2)}`));
    };
    const timeout = setTimeout(() => {
      observe("timeout");
      fail("Durable phase child timed out");
    }, 15_000);
    const finish = (record: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(record);
    };
    child.once("spawn", () => observe("spawn"));
    child.once("error", (error) => {
      observe("error");
      fail(`Durable phase child error: ${error.message}`);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("HIMAWARI_PHASE "));
      if (line && !readyObserved) {
        readyObserved = true;
        observe("ready_marker");
      }
      if (line && !options.expectExit) {
        try {
          finish(JSON.parse(line.slice("HIMAWARI_PHASE ".length)) as Record<string, unknown>);
        } catch (error) {
          fail(`Durable phase child evidence invalid: ${String(error)}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      observe("exit", { code, signal });
      children.delete(child);
      if (!options.expectExit || code !== 0) {
        fail(`Durable phase child exited ${code ?? signal}`);
        return;
      }
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("HIMAWARI_PHASE "));
      if (!line) {
        fail("Durable phase child emitted no evidence");
        return;
      }
      try {
        finish(JSON.parse(line.slice("HIMAWARI_PHASE ".length)) as Record<string, unknown>);
      } catch (error) {
        fail(`Durable phase child evidence invalid: ${String(error)}`);
      }
    });
    child.once("close", (code, signal) => {
      observe("close", { code, signal });
      if (failure)
        process.stdout.write(`HIMAWARI_PHASE_CHILD_DIAGNOSTIC ${JSON.stringify(diagnostic())}\n`);
    });
  });
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  children.delete(child);
}

describe("durable business phase real-process recovery", () => {
  it("[R2-T7] preserves stable identity through SIGKILL and process restart at all eight phases", async () => {
    const recovered: string[] = [];
    for (const phase of PHASES) {
      const stateRoot = await mkdtemp(path.join(tmpdir(), `himawari-phase-${phase}-`));
      cleanupRoots.push(stateRoot);
      const seed = start(stateRoot, phase, "seed");
      const beforeKill = await phaseOutput(seed, { expectExit: false, phase, mode: "seed" });
      expect(beforeKill).toMatchObject({ ready: true, phase });
      await kill(seed);

      const inspector = start(stateRoot, phase, "inspect");
      const afterRestart = await phaseOutput(inspector, {
        expectExit: true,
        phase,
        mode: "inspect",
      });
      expect(afterRestart).toMatchObject({
        ready: true,
        phase,
        identity: `${phase}:stable-identity`,
        markerIdentity: `${phase}:stable-identity`,
        recovered: true,
      });
      recovered.push(phase);
    }
    expect(recovered).toEqual(PHASES);
  }, 120_000);
});
