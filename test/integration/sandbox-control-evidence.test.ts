import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
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
async function fixture() {
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
  cleanups.push(async () => {
    observation = { ...observation, phase: "finished" };
    await server.finish();
  });
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
      terminationMode: "best_effort",
    } as unknown as SandboxRuntimeQualification,
  });
  let hostChecks = 0;
  let admissionChecks = 0;
  const control = createProductionSandboxControl({
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
    order,
    counts: () => ({ hostChecks, admissionChecks }),
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
