import "../fixtures/r2t10-live-sandbox-probe.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { installTestNodeRuntime } from "../fixtures/node-runtime.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";
import {
  SERVICE_AUTHORITY,
  serviceRequest,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

vi.setConfig({ testTimeout: 180000 });
const launch = vi.hoisted(() => ({ hook: "", stderr: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (file: string, args: string[], options: import("node:child_process").ForkOptions) => {
      const child = actual.fork(file, args, {
        ...options,
        execArgv: [...(options?.execArgv ?? []), ...(launch.hook ? ["--import", launch.hook] : [])],
      });
      child.stderr?.on("data", (bytes: Buffer) => {
        launch.stderr += bytes.toString();
      });
      return child;
    },
  };
});

let runtimeRoot = path.resolve("dist/node-runtime");
let installation: Awaited<ReturnType<typeof installTestNodeRuntime>> | undefined;
beforeAll(async () => {
  installation = await installTestNodeRuntime();
  runtimeRoot = installation.runtimeRoot;
}, 240_000);
afterAll(async () => {
  await installation?.close();
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  launch.stderr = "";
});

it("[R2-T10] a launch that never releases the command becomes a bounded failure", async () => {
  const root = await mkdtemp(`${testTemporaryRoot()}/r2t10-inject-`);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const loader = path.join(root, "loader.mjs");
  launch.hook = path.join(root, "hook.mjs");
  await writeFile(
    loader,
    `export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/sandbox/sandbox-manager.js")) return loaded;
  return { ...loaded, source: loaded.source.toString() + ${JSON.stringify(
    '\nconst himawariFixtureWrap = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);\nSandboxManager.wrapWithSandboxArgv = (command, shell) => himawariFixtureWrap("/usr/bin/sleep 3600", shell);\n',
  )} };
}
`,
  );
  await writeFile(
    launch.hook,
    `import { register } from "node:module";
import threads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
const SdkWorker = threads.Worker;
threads.Worker = class extends SdkWorker {
  constructor(filename, options) {
    super(filename, /\\/sandbox-sdk-worker\\.(js|ts)$/.test(String(filename))
      ? { ...options, execArgv: [...(options?.execArgv ?? []), "--import", import.meta.url] }
      : options);
  }
};
syncBuiltinESMExports();
register(${JSON.stringify(pathToFileURL(loader).href)});
`,
  );
  const stderrFile = path.join(root, "job-host-stderr.txt");
  try {
    const f = await productionSandboxScope(
      {
        operation: "bash",
        mode: "foreground",
        contract: { ref: "pi-coding-tool", version: "1", kind: "command" },
        backendRef: "srt",
        scopeSource: "grant_targets",
        directoryOperations: ["read"],
        network: "disabled",
      },
      undefined,
      {
        realFileIdentity: true,
        piRuntimeRoot: runtimeRoot,
        directoryOperations: ["read"],
        resourceCeiling: {
          maxWallTimeMs: 60000,
          maxCpuTimeMs: 10000,
          maxMemoryBytes: 268435456,
          maxOutputBytes: 4096,
          maxProgressEvents: 10,
        },
        piParameters: { command: "printf 'r2t10'" },
      },
    );
    cleanups.push(f.close);
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("missing preparation");
    await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
    const live = await queuedLiveWorker(f, SERVICE_AUTHORITY);
    cleanups.push(live.close);
    const plan = prepared.plan;
    const base = serviceRequest();
    const result = await live.sandbox.execute({
      ...base,
      messageId: plan.identity.invocationId,
      authorizationRef: plan.authorizationRef,
      scope: f.input.requestScope,
      payload: {
        ...base.payload,
        capabilityId: plan.capabilityRef,
        capabilityVersion: plan.capabilityVersion,
        capabilityHandleRef: plan.handleRef,
        inputRef: plan.inputRef,
        operation: plan.operation,
        requestedAt: f.input.requestedAt,
        deadlineAt: plan.effectiveDeadlineAt,
        resourceCeiling: plan.resourceCeiling,
        delegatedContextRefs: f.input.delegatedContextRefs,
        secretRefs: f.input.secretRefs,
        sandboxExecution: {
          schemaVersion: "sandbox-execution.v2",
          mode: plan.mode,
          environmentId: plan.environmentId,
          identity: plan.identity,
        },
      },
    });
    const admission = await f.services.brokerV2.preparations.readAdmission(plan.identity);
    if (admission?.phase !== "bound")
      throw new Error(`missing execution facts: ${JSON.stringify({ result, admission })}`);
    const facts = admission.record.facts;
    console.info(
      JSON.stringify({
        event: "r2t10-worker-facts",
        result: facts.result,
        effect: facts.effect,
        resource: {
          supervision: facts.resource.supervision,
          cleanup: facts.resource.cleanup,
          sequence: facts.resource.sequence,
        },
      }),
    );
    expect(facts.result).toMatchObject({
      kind: "error",
      reasonCode: "SANDBOX_TOOL_NOT_STARTED",
      termination: { type: "failure" },
    });
    expect(facts.effect).toMatchObject({ kind: "unknown", reasonCode: "SANDBOX_NOT_STARTED" });
    expect(facts.resource.supervision).toBe("released");
    expect(facts.resource.cleanup).toBe("confirmed");
    const delivery = await f.services.completeToolResult(
      { runId: plan.identity.runId, invocationId: plan.identity.invocationId },
      { assertDisclosure: async () => {}, saveReceipt: async () => {} },
    );
    console.info(JSON.stringify({ event: "r2t10-delivery", delivery }));
    expect(delivery).toMatchObject({
      outcome: "failed",
      outputRef: null,
      errorCode: "SANDBOX_TOOL_NOT_STARTED",
    });
  } catch (error) {
    await writeFile(stderrFile, launch.stderr, { flag: "w" }).catch(() => {});
    console.error(`R2T10_JOB_HOST_STDERR:\n${launch.stderr}`);
    throw error;
  }
});
