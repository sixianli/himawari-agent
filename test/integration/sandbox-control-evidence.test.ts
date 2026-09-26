import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { SandboxExecutionRecord } from "@himawari-agent/application";
import type {
  SandboxHostBinding,
  SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { afterEach, expect, it } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import {
  type JobHostControlObservation,
  openJobHostControl,
} from "../../packages/runtime-sandbox/src/job-host-control.ts";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import { openSandboxJournal } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A real authenticated socket and durable journal exercise the product verifier.
// The supervisor and qualification facts here are synthetic, not platform qualification.
async function fixture(options: { qualified?: boolean; completed?: boolean } = {}) {
  let clockOffset = 0;
  let hostElapsed = 0;
  const order: string[] = [];
  const now = () => new Date(Date.now() + clockOffset).toISOString();
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const root = await realpath(await mkdtemp("/tmp/r4-evidence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "control");
  await mkdir(directory, { mode: 0o700 });
  const record = (await sandboxV2Call(f, "admit", sandboxV2Admission(f)))
    .record as SandboxExecutionRecord;
  const binding = {
    directory,
    token: "a".repeat(64),
    sessionId: randomUUID(),
    jobId: record.plan.identity.jobId,
    attemptId: record.plan.identity.attemptId,
  };
  let observation: JobHostControlObservation = {
    sessionId: binding.sessionId,
    jobId: binding.jobId,
    attemptId: binding.attemptId,
    bootId: randomUUID(),
    processIdentityRef: `job-host-process:${randomUUID()}`,
    processId: process.pid,
    processStartedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    sequence: 1,
    phase: "ready",
    policyDigest: record.facts.environment.policyDigest,
    privateDirectoryRef: `sandbox-private:${"a".repeat(64)}`,
    linuxNamespace: null,
    taskStarted: false,
    taskProcessExited: false,
    stdioClosed: false,
    srtReset: false,
    resources: null,
  };
  let sequence = 0;
  const server = await openJobHostControl(
    binding,
    () => ({
      ...observation,
      observedAt: now(),
      sequence: ++sequence,
    }),
    () => {
      order.push("stop");
      observation = { ...observation, phase: "stopping" };
    },
  );
  let controlFinished = false;
  const finishControl = async () => {
    if (controlFinished) return;
    observation = { ...observation, phase: "finished" };
    await server.finish();
    controlFinished = true;
  };
  cleanups.push(finishControl);
  const stored = new Map<string, { ref: string; digest: string; value: unknown }>();
  let platform = "darwin";
  const verifiedHost = async () => ({
    binding: {
      privateRoot: root,
      runtimeRoot: "/runtime",
      readOnlyToolchainPaths: [],
      roots: [],
    } as unknown as SandboxHostBinding,
    qualification: {
      platform,
      guarantees: options.qualified ? ["fixed-file-terminal-no-writer.v1"] : [],
      terminationMode: "best_effort",
    } as unknown as SandboxRuntimeQualification,
  });
  let hostChecks = 0;
  let hostFailure: Error | undefined;
  let admissionChecks = 0;
  const control = createProductionSandboxControl({
    fixedFileCompleted: async () => options.completed === true,
    now,
    read: async (_plan, key) => structuredClone(stored.get(key)),
    write: async (_plan, key, value) => {
      const artifact = {
        ref: `evidence-${stored.size}`,
        digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        value: structuredClone(value),
      };
      if (stored.has(key)) throw new Error("duplicate evidence");
      stored.set(key, artifact);
      return artifact;
    },
    host: async () => {
      order.push("verify-host");
      hostChecks++;
      if (hostFailure) throw hostFailure;
      clockOffset += hostElapsed;
      return verifiedHost();
    },
    admit: async () => {
      admissionChecks++;
      return verifiedHost();
    },
  });
  await control.register(record.plan, binding);
  const facts = {
    ...record.facts,
    environment: {
      ...record.facts.environment,
      privateDirectoryOwnerRef: record.plan.identity.hostId,
      privateDirectoryRef: observation.privateDirectoryRef,
      supervisor: { supervisorId: binding.sessionId, bootId: observation.bootId, epoch: 1 },
    },
  };
  const bound = {
    ...record,
    plan: { ...record.plan, effectiveDeadlineAt: new Date(Date.now() + 30000).toISOString() },
    facts: { ...facts, resource: { ...facts.resource, supervisor: facts.environment.supervisor } },
  };
  return {
    control,
    finishControl,
    order,
    counts: () => ({ hostChecks, admissionChecks }),
    failHost: (error: Error) => {
      hostFailure = error;
    },
    setHostElapsed: (milliseconds: number) => {
      hostElapsed = milliseconds;
    },
    record: bound,
    binding,
    stored,
    directory,
    setPlatform: (value: string) => {
      platform = value;
    },
    set: (value: Partial<JobHostControlObservation>) => {
      observation = { ...observation, ...value };
    },
  };
}
it("binds preparation to the original ready host and rejects replacement", async () => {
  const f = await fixture();
  expect(f.counts()).toEqual({ hostChecks: 0, admissionChecks: 1 });
  await expect(f.control.verifyPreparation(f.record.plan, f.record.facts)).resolves.toBeUndefined();
  expect(await f.control.register(f.record.plan, f.binding)).toBe(false);
  expect(f.counts()).toEqual({ hostChecks: 0, admissionChecks: 2 });
  await expect(
    f.control.register(f.record.plan, { ...f.binding, token: "b".repeat(64) }),
  ).rejects.toThrow();
  f.set({ phase: "running", taskStarted: true });
  await expect(f.control.verifyPreparation(f.record.plan, f.record.facts)).rejects.toThrow();
});
it("returns observation proof from one host verification without caching later observations", async () => {
  const f = await fixture();
  f.set({
    phase: "running",
    taskStarted: true,
    resources: { samples: 1, observedCpuTimeMs: 1, peakObservedMemoryBytes: 1024 },
  });
  const first = await f.control.refreshEvidence(f.record);
  expect(first.resource.supervision).toBe("controlled");
  expect(first.evidence).toHaveLength(1);
  expect(f.counts().hostChecks).toBe(1);
  f.setPlatform("linux");
  const second = await f.control.refreshEvidence({
    ...f.record,
    facts: { ...f.record.facts, resource: first.resource },
  });
  expect(second.resource.supervision).toBe("lost");
  expect(second.evidence).toEqual([]);
  expect(f.counts().hostChecks).toBe(2);
});
it("samples live process state after slow host verification instead of aging the sample", async () => {
  const f = await fixture();
  f.setHostElapsed(2000);
  f.set({
    phase: "running",
    taskStarted: true,
    resources: { samples: 1, observedCpuTimeMs: 1, peakObservedMemoryBytes: 1024 },
  });
  const checked = await f.control.refreshEvidence(f.record);
  expect(checked.resource.supervision).toBe("controlled");
  expect(checked.evidence).toHaveLength(1);
  expect(f.counts().hostChecks).toBe(1);
});
it("delivers stop before expensive host verification and still requires cleanup evidence", async () => {
  const f = await fixture();
  f.setHostElapsed(2000);
  const resource = await f.control.backend.stop(f.record, new AbortController().signal);
  expect(f.order).toEqual(["stop", "verify-host"]);
  expect(resource.supervision).toBe("lost");
  expect(resource.cleanup).toBe("unknown");
});
it("keeps the authenticated control timeout when no final proof exists", async () => {
  const f = await fixture();
  await f.finishControl();
  await rm(path.join(f.directory, "final.json"));
  const connections = new Set<Socket>();
  const stalled = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.resume();
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    stalled.once("error", reject);
    stalled.listen(path.join(f.directory, "control.sock"), resolve);
  });
  cleanups.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      stalled.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await expect(f.control.backend.inspect(f.record, new AbortController().signal)).rejects.toThrow(
    "JOB_HOST_CONTROL_TIMEOUT",
  );
  const diagnostics = [...f.stored.entries()].filter(([key]) => key.includes(":diagnostic:"));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.[1].value).toMatchObject({ reasonCode: "SANDBOX_CONTROL_TIMED_OUT" });
});

it.each([
  [undefined, "SANDBOX_HOST_UNAVAILABLE"],
  ["EACCES", "SANDBOX_RECONCILIATION_PERMISSION_DENIED"],
])("retains protected host diagnostics with safe reason for %s", async (code, reasonCode) => {
  const f = await fixture();
  const diagnostic = "private host path must stay in protected artifact";
  f.failHost(Object.assign(new Error(diagnostic), { code }));
  const resource = await f.control.backend.stop(f.record, new AbortController().signal);
  expect(f.order[0]).toBe("stop");
  expect(resource).toMatchObject({ supervision: "lost", cleanup: "unknown", reasonCode });
  expect(JSON.stringify(resource)).not.toContain(diagnostic);
  const saved = [...f.stored.entries()].filter(([key]) => key.includes(":diagnostic:"));
  expect(saved).toHaveLength(1);
  expect(saved[0]?.[1].value).toMatchObject({
    identity: f.record.plan.identity,
    environmentId: f.record.plan.environmentId,
    command: "stop",
    stage: "host",
    diagnostic: { message: diagnostic },
  });
  const observation = [...f.stored.entries()].find(([key]) => key.includes(":observation:"));
  expect(observation).toBeDefined();
});
it("requires stored exact evidence and never promotes a Linux sample to tree proof", async () => {
  const f = await fixture();
  f.set({
    phase: "running",
    taskStarted: true,
    resources: { samples: 1, observedCpuTimeMs: 1, peakObservedMemoryBytes: 1024 },
  });
  const resource = await f.control.observe(f.record);
  expect(resource.supervision).toBe("controlled");
  expect(await f.control.evidence(f.record.plan, { ...f.record.facts, resource })).toHaveLength(1);
  const artifact = [...f.stored.values()].at(-1);
  if (!artifact) throw new Error("missing fixture artifact");
  artifact.digest = "0".repeat(64);
  await expect(
    f.control.evidence(f.record.plan, { ...f.record.facts, resource }),
  ).rejects.toThrow();
  f.setPlatform("linux");
  const next = await f.control.observe({ ...f.record, facts: { ...f.record.facts, resource } });
  expect(next.supervision).toBe("lost");
  expect(next.cleanup).toBe("unknown");
});
it("does not release a finished environment while its host is alive", async () => {
  const f = await fixture();
  f.set({ phase: "finished", srtReset: true });
  const resource = await f.control.observe(f.record);
  expect(resource.supervision).toBe("lost");
  expect(resource.cleanup).toBe("unknown");
});
it("rejects directory inode replacement and changed supervisor identity", async () => {
  const f = await fixture();
  f.set({ bootId: randomUUID() });
  await expect(f.control.observe(f.record)).rejects.toThrow();
  await rename(f.directory, `${f.directory}-old`);
  await mkdir(f.directory, { mode: 0o700 });
  await expect(f.control.observe(f.record)).rejects.toThrow("DIRECTORY_CHANGED");
  await rm(f.directory, { recursive: true });
  await rename(`${f.directory}-old`, f.directory);
});

it.each([
  "supervisorId",
  "bootId",
  "epoch",
  "policyDigest",
  "privateDirectoryOwnerRef",
  "privateDirectoryRef",
])("rejects preparation with changed %s", async (field) => {
  const f = await fixture();
  const environment = structuredClone(f.record.facts.environment);
  const changed = ["supervisorId", "bootId", "epoch"].includes(field)
    ? {
        ...environment,
        supervisor: { ...environment.supervisor, [field]: field === "epoch" ? 2 : "changed" },
      }
    : { ...environment, [field]: "changed" };
  await expect(
    f.control.verifyPreparation(f.record.plan, { ...f.record.facts, environment: changed }),
  ).rejects.toThrow("SANDBOX_CONTROL_PREPARATION_CHANGED");
});
it.each(["missing", "fingerprint", "environmentId"])(
  "refuses missing or substituted stored control (%s)",
  async (field) => {
    const f = await fixture();
    if (field === "missing") f.stored.clear();
    else {
      const entry = [...f.stored.values()][0];
      if (!entry) throw new Error("Missing fixture control");
      (entry.value as Record<string, unknown>)[field] = "changed";
    }
    await expect(f.control.verifyPreparation(f.record.plan, f.record.facts)).rejects.toThrow(
      "SANDBOX_CONTROL_BINDING_UNAVAILABLE",
    );
  },
);
it.each(["jobId", "attemptId"])("refuses to register another %s", async (field) => {
  const f = await fixture();
  await expect(
    f.control.register(f.record.plan, { ...f.binding, [field]: "another" }),
  ).rejects.toThrow("SANDBOX_CONTROL_BINDING_CHANGED");
  expect(f.counts().admissionChecks).toBe(1);
});
it.each(["bootId", "processIdentityRef", "policyDigest"])(
  "refuses changed live process %s",
  async (field) => {
    const f = await fixture();
    f.set({ [field]: field === "policyDigest" ? "b".repeat(64) : "another" });
    await expect(f.control.observe(f.record)).rejects.toThrow();
  },
);
it.each([
  "ref",
  "digest",
  "fingerprint",
  "environmentId",
  "resourceSequence",
  "bootId",
  "processIdentityRef",
])("refuses substituted persisted observation %s", async (field) => {
  const f = await fixture();
  f.set({
    phase: "running",
    taskStarted: true,
    resources: { samples: 1, observedCpuTimeMs: 1, peakObservedMemoryBytes: 1024 },
  });
  const resource = await f.control.observe(f.record);
  const artifact = [...f.stored.values()].at(-1);
  if (!artifact) throw new Error("Missing observation");
  if (field === "ref" || field === "digest") artifact[field] = "changed";
  else {
    const value = artifact.value as Record<string, unknown>;
    if (field === "bootId" || field === "processIdentityRef")
      (value["observation"] as Record<string, unknown>)[field] = "changed";
    else value[field] = field === "resourceSequence" ? 999 : "changed";
  }
  await expect(f.control.evidence(f.record.plan, { ...f.record.facts, resource })).rejects.toThrow(
    "SANDBOX_CONTROL_EVIDENCE_CHANGED",
  );
});
it.each(["no-task", "exited", "no-samples", "expired", "supervisor-changed"])(
  "does not classify incomplete supervision as controlled (%s)",
  async (reason) => {
    const f = await fixture();
    f.set({
      phase: "running",
      taskStarted: reason !== "no-task",
      taskProcessExited: reason === "exited",
      resources: {
        samples: reason === "no-samples" ? 0 : 1,
        observedCpuTimeMs: 1,
        peakObservedMemoryBytes: 1024,
      },
    });
    const record =
      reason === "expired"
        ? {
            ...f.record,
            plan: { ...f.record.plan, effectiveDeadlineAt: "2000-01-01T00:00:00.000Z" },
          }
        : reason === "supervisor-changed"
          ? {
              ...f.record,
              facts: {
                ...f.record.facts,
                environment: {
                  ...f.record.facts.environment,
                  supervisor: { ...f.record.facts.environment.supervisor, supervisorId: "changed" },
                },
              },
            }
          : f.record;
    const resource = await f.control.observe(record);
    expect(resource.supervision).toBe("lost");
    expect(resource.cleanup).toBe("unknown");
    expect(await f.control.evidence(record.plan, { ...record.facts, resource })).toEqual([]);
  },
);

it("sends an unbound stop to the original authenticated host without reauthorizing execution", async () => {
  const f = await fixture();
  const before = f.counts();
  await f.control.stopPreparation(f.record.plan);
  expect(f.order).toEqual(["stop"]);
  expect(f.counts()).toEqual(before);
  const receipts = [...f.stored.entries()].filter(([key]) => key.includes(":preparation-stop:"));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.[1].value).toMatchObject({
    observation: { phase: "stopping", taskStarted: false },
  });
  await rename(f.directory, `${f.directory}-replaced`);
  await mkdir(f.directory, { mode: 0o700 });
  await expect(f.control.stopPreparation(f.record.plan)).rejects.toThrow("DIRECTORY_CHANGED");
  expect(f.order).toEqual(["stop"]);
});

it.each(["alive", "started", "cleanup-unknown", "verified"] as const)(
  "attests a never-started reservation only with independent host exit proof: %s",
  async (scenario) => {
    const f = await fixture();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const departedPid = child.pid;
    await once(child, "exit");
    if (!departedPid) throw new Error("child PID missing");
    // The socket is real; supervisor facts are controlled, as in the other
    // verifier tests. A reaped child supplies an actually absent PID.
    f.set({
      phase: "finished",
      taskStarted: scenario === "started",
      srtReset: scenario !== "cleanup-unknown",
      processId: scenario === "alive" ? process.pid : departedPid,
    });
    const before = f.counts();
    const stoppedAt = new Date(Date.now() - 1000).toISOString();
    const proof = await f.control.verifyReservationRelease(f.record.plan, stoppedAt);
    expect(f.counts().admissionChecks).toBe(before.admissionChecks);
    expect(f.counts().hostChecks).toBe(before.hostChecks + 1);
    if (scenario !== "verified") {
      expect(proof).toBeUndefined();
      return;
    }
    expect(proof).toMatchObject({
      schemaVersion: "sandbox-reservation-release.v1",
      basis: "host_never_started",
      identity: f.record.plan.identity,
      environmentId: f.record.plan.environmentId,
      semanticFingerprint: f.record.plan.semanticFingerprint,
      stopRequestedAt: stoppedAt,
    });
    expect(proof?.evidence.ref).toBeTruthy();
    expect([...f.stored.values()].some(({ ref }) => ref === proof?.evidence.ref)).toBe(true);
    await rename(f.directory, `${f.directory}-replaced`);
    await mkdir(f.directory, { mode: 0o700 });
    await expect(f.control.verifyReservationRelease(f.record.plan, stoppedAt)).rejects.toThrow(
      "DIRECTORY_CHANGED",
    );
  },
);

it.each([
  "verified",
  "unqualified",
  "unverified",
  "arbitrary",
  "interrupted",
  "alive",
  "cleanup-unknown",
] as const)("releases only a qualified fixed file terminal program: %s", async (scenario) => {
  const f = await fixture({
    qualified: scenario !== "unqualified",
    completed: scenario !== "unverified",
  });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  if (!pid) throw new Error("child PID missing");
  f.set({
    phase: scenario === "interrupted" ? "stopping" : "finished",
    taskStarted: true,
    taskProcessExited: true,
    stdioClosed: true,
    srtReset: scenario !== "cleanup-unknown",
    processId: scenario === "alive" ? process.pid : pid,
  });
  const record = {
    ...f.record,
    plan: {
      ...f.record.plan,
      mode: "foreground" as const,
      operationContract: {
        ...f.record.plan.operationContract,
        ref: "pi-coding-tool",
        version: scenario === "arbitrary" ? "1" : "3",
      },
    },
  };
  const result = await f.control.refreshEvidence(record);
  expect(result.resource.supervision).toBe(scenario === "verified" ? "released" : "lost");
});

it.each([
  ["darwin", "group-gone", "released"],
  ["linux", "group-gone", "released"],
  ["darwin", "group-present", "lost"],
  ["darwin", "flag-absent", "lost"],
  ["darwin", "host-alive", "lost"],
  ["darwin", "cleanup-unknown", "lost"],
  ["darwin", "interrupted", "lost"],
  ["darwin", "task-running", "lost"],
  ["darwin", "flag-invalid", "rejected"],
] as const)(
  "releases a finished SRT call on %s only once its task group is gone: %s",
  async (platform, scenario, supervision) => {
    const f = await fixture();
    f.setPlatform(platform);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const departedPid = child.pid;
    await once(child, "exit");
    if (!departedPid) throw new Error("child PID missing");
    f.set({
      phase: scenario === "interrupted" ? "stopping" : "finished",
      taskStarted: true,
      taskProcessExited: scenario !== "task-running",
      stdioClosed: false,
      srtReset: scenario !== "cleanup-unknown",
      processId: scenario === "host-alive" ? process.pid : departedPid,
      ...(scenario === "flag-absent"
        ? {}
        : {
            taskProcessGroupGone: (scenario === "flag-invalid"
              ? "yes"
              : scenario !== "group-present") as boolean,
          }),
    });
    if (supervision === "rejected") {
      await expect(f.control.refreshEvidence(f.record)).rejects.toThrow(
        "JOB_HOST_CONTROL_EVIDENCE_INVALID",
      );
      return;
    }
    const result = await f.control.refreshEvidence(f.record);
    expect(result.resource.supervision).toBe(supervision);
    if (supervision === "released") {
      expect(result.resource).toMatchObject({
        cleanup: "process_group_gone",
        evidence: { subject: { kind: "local_process" } },
      });
      expect(result.evidence).toHaveLength(1);
      const resource = result.resource as Extract<
        typeof result.resource,
        { supervision: "released" }
      >;
      const facts = { ...f.record.facts, resource };
      await expect(f.control.evidence(f.record.plan, facts)).resolves.toHaveLength(1);
      await expect(
        f.control.evidence(f.record.plan, {
          ...facts,
          resource: { ...resource, cleanup: "confirmed" },
        }),
      ).rejects.toThrow("SANDBOX_CONTROL_EVIDENCE_CHANGED");
    } else expect(result.resource.cleanup).toBe("unknown");
  },
);
