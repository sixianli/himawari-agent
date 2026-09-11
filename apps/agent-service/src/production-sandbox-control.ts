import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  SandboxExecutionEvidencePort,
  SandboxExecutionFacts,
  SandboxExecutionRecord,
  SandboxReconciliationBackend,
} from "@himawari-agent/application";
import {
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxJobControlBinding,
  type SandboxResourceObservation,
  type SandboxRuntimeQualification,
  sandboxJobControlBindingSchema,
  sandboxResourceObservationSchema,
} from "@himawari-agent/execution-contracts";
import {
  type JobHostControlObservation,
  queryJobHostControl,
  readJobHostFinalEvidence,
  readLinuxNamespaceState,
} from "@himawari-agent/runtime-sandbox/control";

interface StoredControl {
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly control: SandboxJobControlBinding;
  readonly directoryDevice: string;
  readonly directoryInode: string;
  readonly bootId: string;
  readonly processIdentityRef: string;
  readonly policyDigest: string;
}
interface StoredObservation {
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly resourceSequence: number;
  readonly observation: JobHostControlObservation;
}
interface Options {
  readonly now: () => string;
  readonly read: (
    plan: SandboxExecutionPlanV2,
    key: string,
  ) => Promise<{ ref: string; digest: string; value: unknown } | undefined>;
  readonly write: (
    plan: SandboxExecutionPlanV2,
    key: string,
    value: unknown,
  ) => Promise<{ ref: string; digest: string }>;
  /** Installed host identity/bytes and mode qualification, independent of an expired Grant. */
  readonly host: (
    plan: SandboxExecutionPlanV2,
  ) => Promise<{ binding: SandboxHostBinding; qualification: SandboxRuntimeQualification }>;
  /** Admission checks current scope/Grant and host bytes together before registration. */
  readonly admit: (
    plan: SandboxExecutionPlanV2,
  ) => Promise<{ binding: SandboxHostBinding; qualification: SandboxRuntimeQualification }>;
}
const key = (plan: SandboxExecutionPlanV2) =>
  `sandbox-control:${createHash("sha256").update(JSON.stringify(plan.identity)).digest("hex")}`;
const observationKey = (plan: SandboxExecutionPlanV2, sequence: number) =>
  `${key(plan)}:observation:${sequence}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ESRCH";
  }
}

/** Uses the existing protected Run artifacts for control bindings and raw facts.
 * It never installs a backend, consumes a Grant, executes user code, or signals a
 * numeric PID. A live stop goes to the original authenticated Job Host only.
 */
export function createProductionSandboxControl(options: Options) {
  const readControl = async (plan: SandboxExecutionPlanV2): Promise<StoredControl> => {
    const stored = await options.read(plan, key(plan));
    const value = stored?.value as StoredControl | undefined;
    if (
      !value ||
      value.fingerprint !== plan.semanticFingerprint ||
      value.environmentId !== plan.environmentId
    )
      throw new Error("SANDBOX_CONTROL_BINDING_UNAVAILABLE");
    sandboxJobControlBindingSchema.parse(value.control);
    const directory = await lstat(value.control.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      String(directory.dev) !== value.directoryDevice ||
      String(directory.ino) !== value.directoryInode
    )
      throw new Error("SANDBOX_CONTROL_DIRECTORY_CHANGED");
    return value;
  };
  const inspect = async (
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ) => {
    const stored = await readControl(plan);
    let observation: JobHostControlObservation;
    try {
      observation = await queryJobHostControl(stored.control, command, 1000, signal);
    } catch {
      observation = await readJobHostFinalEvidence(stored.control);
    }
    if (signal?.aborted) throw new Error("SANDBOX_CONTROL_ABORTED");
    if (
      observation.bootId !== stored.bootId ||
      observation.processIdentityRef !== stored.processIdentityRef ||
      observation.policyDigest !== stored.policyDigest ||
      observation.observedAt > options.now()
    )
      throw new Error("SANDBOX_CONTROL_IDENTITY_CHANGED");
    return observation;
  };
  const classify = async (
    record: SandboxExecutionRecord,
    raw: JobHostControlObservation,
    qualification: SandboxRuntimeQualification,
  ): Promise<"controlled" | "released" | "lost"> => {
    if (
      raw.bootId !== record.facts.environment.supervisor.bootId ||
      raw.sessionId !== record.facts.environment.supervisor.supervisorId ||
      raw.policyDigest !== record.facts.environment.policyDigest
    )
      return "lost";
    const namespace = raw.linuxNamespace
      ? await readLinuxNamespaceState(raw.linuxNamespace)
      : "unknown";
    if (
      qualification.platform === "linux" &&
      qualification.terminationMode === "verified_tree" &&
      raw.taskStarted &&
      raw.phase === "finished" &&
      raw.taskProcessExited &&
      raw.stdioClosed &&
      raw.srtReset &&
      namespace === "released" &&
      processAbsent(raw.processId)
    )
      return "released";
    // A finished, never-started environment can be released only after the
    // original host PID is absent. PID reuse/permission errors remain unknown.
    if (
      raw.phase === "finished" &&
      !raw.taskStarted &&
      raw.srtReset &&
      (raw.linuxNamespace === null || namespace === "released") &&
      processAbsent(raw.processId)
    )
      return "released";
    // Mac's accepted profile binds inherited SRT restrictions and sampled
    // supervision, not a promise of arbitrary descendant reclamation. Linux's
    // stronger tree requirement is not inferred from this Mac evidence.
    if (
      ((qualification.platform === "darwin" && qualification.terminationMode === "best_effort") ||
        (qualification.platform === "linux" &&
          qualification.terminationMode === "verified_tree" &&
          namespace === "alive")) &&
      raw.phase === "running" &&
      raw.taskStarted &&
      !raw.taskProcessExited &&
      raw.resources &&
      raw.resources.samples > 0 &&
      Date.parse(options.now()) - Date.parse(raw.observedAt) <= 1500 &&
      options.now() < record.plan.effectiveDeadlineAt
    )
      return "controlled";
    return "lost";
  };
  const observe = async (
    record: SandboxExecutionRecord,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ): Promise<SandboxResourceObservation> => {
    // Stop the authenticated original host promptly, then verify its resulting
    // state. File verification must never delay delivery of a stop request.
    if (command === "stop") await inspect(record.plan, "stop", signal);
    // Read installed bytes before sampling a live process. A slow disk must not
    // consume the observation's freshness window before classification begins.
    let host: Awaited<ReturnType<Options["host"]>> | undefined;
    try {
      host = await options.host(record.plan);
    } catch {
      // Still retain the process observation; unqualified cleanup remains lost.
    }
    const raw = await inspect(record.plan, "inspect", signal);
    if (record.plan.operationContract.kind === "service_start") {
      if (!host) throw new Error("SANDBOX_HOST_UNAVAILABLE");
      const { binding } = host;
      const ref = record.plan.operationContract.readinessProbeRef;
      const probe = binding.readinessProbes?.find((probe) => probe.ref === ref);
      if (
        !probe ||
        raw.readiness?.ref !== ref ||
        raw.readiness.digest !== createHash("sha256").update(JSON.stringify(probe)).digest("hex")
      )
        throw new Error("SANDBOX_READINESS_BINDING_CHANGED");
    }
    const sequence = record.facts.resource.sequence + 1;
    const stored = await options.write(record.plan, observationKey(record.plan, sequence), {
      fingerprint: record.plan.semanticFingerprint,
      environmentId: record.plan.environmentId,
      resourceSequence: sequence,
      observation: raw,
    } satisfies StoredObservation);
    if (raw.readiness?.readyAt) {
      const readinessKey = `sandbox-readiness:${record.plan.identity.jobId}`;
      if (!(await options.read(record.plan, readinessKey)))
        await options.write(record.plan, readinessKey, {
          ref: stored.ref,
          digest: stored.digest,
          observation: raw,
        });
    }
    let state: "controlled" | "released" | "lost" = "lost";
    try {
      if (host) state = await classify(record, raw, host.qualification);
    } catch {
      /* Qualification loss cannot turn a cleanup attempt into a launch. */
    }
    if (command === "stop" && state === "controlled") state = "lost";
    const old = record.facts.resource;
    const now = options.now();
    return sandboxResourceObservationSchema.parse({
      schemaVersion: old.schemaVersion,
      creator: old.creator,
      environmentId: old.environmentId,
      policyDigest: old.policyDigest,
      scopeDigest: old.scopeDigest,
      sequence,
      occurredAt: now,
      supervisor: old.supervisor,
      resourceRef: old.resourceRef,
      status:
        state === "controlled"
          ? old.status.kind === "task"
            ? { kind: "task", state: "running" }
            : old.status.kind === "service"
              ? { kind: "service", readiness: raw.readiness?.readyAt ? "ready" : "starting" }
              : old.status
          : old.status.kind === "task"
            ? {
                kind: "task",
                state: raw.taskProcessExited || state === "released" ? "exited" : "unknown",
              }
            : old.status.kind === "service"
              ? { kind: "service", readiness: "unavailable" }
              : old.status,
      metrics: raw.resources
        ? {
            samples: raw.resources.samples,
            cpuTimeMs: raw.resources.observedCpuTimeMs,
            peakMemoryBytes: raw.resources.peakObservedMemoryBytes,
          }
        : old.metrics,
      supervision: state,
      cleanup: state === "released" ? "confirmed" : state === "controlled" ? "pending" : "unknown",
      ...(state === "lost"
        ? { reasonCode: "SANDBOX_CONTROL_UNCONFIRMED" }
        : {
            evidence: {
              ref: stored.ref,
              digest: stored.digest,
              profileRef: record.plan.binding.profileRef,
              qualificationRef: record.plan.binding.qualificationRef,
              validUntil: new Date(Date.parse(now) + 1000).toISOString(),
              subject: { kind: "local_process", processIdentityRef: raw.processIdentityRef },
            },
          }),
    });
  };
  const readinessEvidence = async (plan: SandboxExecutionPlanV2, facts: SandboxExecutionFacts) => {
    if (facts.result?.kind === "started" && facts.result.handle.kind === "service") {
      const control = await readControl(plan);
      const saved = await options.read(plan, `sandbox-readiness:${plan.identity.jobId}`);
      const first = saved?.value as
        | { ref: string; digest: string; observation: JobHostControlObservation }
        | undefined;
      if (
        !first ||
        !first.observation.readiness?.readyAt ||
        first.ref !== facts.result.readinessEvidence?.ref ||
        first.digest !== facts.result.readinessEvidence.digest ||
        first.observation.bootId !== control.bootId ||
        first.observation.processIdentityRef !== control.processIdentityRef
      )
        throw new Error("SANDBOX_READINESS_EVIDENCE_CHANGED");
      return [{ ref: first.ref, digest: first.digest }];
    }
    return [];
  };
  return {
    async register(
      plan: SandboxExecutionPlanV2,
      input: SandboxJobControlBinding,
    ): Promise<boolean> {
      const control = sandboxJobControlBindingSchema.parse(input);
      if (control.jobId !== plan.identity.jobId || control.attemptId !== plan.identity.attemptId)
        throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
      const { binding } = await options.admit(plan);
      const existing = await options.read(plan, key(plan));
      if (existing) {
        const stored = await readControl(plan);
        if (!same(stored.control, control)) throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
        return false;
      }
      if (
        (await realpath(control.directory)) !== control.directory ||
        !within(binding.privateRoot, control.directory) ||
        [
          binding.runtimeRoot,
          ...binding.readOnlyToolchainPaths,
          ...binding.roots.map((root) => root.canonicalPath),
        ].some((root) => root === control.directory || within(root, control.directory))
      )
        throw new Error("SANDBOX_CONTROL_SCOPE_INVALID");
      const observation = await queryJobHostControl(control, "inspect");
      if (
        observation.phase !== "ready" ||
        observation.taskStarted ||
        Date.parse(options.now()) - Date.parse(observation.observedAt) > 1500 ||
        observation.observedAt > options.now()
      )
        throw new Error("SANDBOX_CONTROL_NOT_PREPARED");
      const metadata = await lstat(control.directory);
      await options.write(plan, key(plan), {
        fingerprint: plan.semanticFingerprint,
        environmentId: plan.environmentId,
        control,
        directoryDevice: String(metadata.dev),
        directoryInode: String(metadata.ino),
        bootId: observation.bootId,
        processIdentityRef: observation.processIdentityRef,
        policyDigest: observation.policyDigest,
      } satisfies StoredControl);
      return true;
    },
    async verifyPreparation(plan: SandboxExecutionPlanV2, facts: SandboxExecutionFacts) {
      const stored = await readControl(plan);
      const observed = await inspect(plan, "inspect");
      if (plan.operationContract.kind === "service_start") {
        const { binding } = await options.host(plan);
        const ref = plan.operationContract.readinessProbeRef;
        const probe = binding.readinessProbes?.find((item) => item.ref === ref);
        if (
          !probe ||
          observed.readiness?.ref !== ref ||
          observed.readiness.digest !==
            createHash("sha256").update(JSON.stringify(probe)).digest("hex") ||
          observed.readiness.readyAt !== null
        )
          throw new Error("SANDBOX_READINESS_BINDING_CHANGED");
      }
      if (
        observed.phase !== "ready" ||
        observed.taskStarted ||
        facts.environment.supervisor.supervisorId !== stored.control.sessionId ||
        facts.environment.supervisor.bootId !== stored.bootId ||
        facts.environment.supervisor.epoch !== 1 ||
        facts.environment.policyDigest !== stored.policyDigest ||
        facts.environment.kind !== "local" ||
        facts.environment.privateDirectoryOwnerRef !== plan.identity.hostId ||
        facts.environment.privateDirectoryRef !== observed.privateDirectoryRef ||
        Date.parse(options.now()) - Date.parse(observed.observedAt) > 1500
      )
        throw new Error("SANDBOX_CONTROL_PREPARATION_CHANGED");
    },
    observe: (record: SandboxExecutionRecord) => observe(record, "inspect"),
    // Carry proof produced by this same host/process verification. Do not repeat
    // the expensive installed-byte check after issuing a one-second proof.
    async refreshEvidence(record: SandboxExecutionRecord) {
      const resource = await observe(record, "inspect");
      return {
        resource,
        evidence:
          resource.supervision === "released" || resource.supervision === "controlled"
            ? [
                { ref: resource.evidence.ref, digest: resource.evidence.digest },
                ...(await readinessEvidence(record.plan, record.facts)),
              ]
            : [],
      };
    },
    backend: {
      inspect: (record, signal) => observe(record, "inspect", signal),
      stop: (record, signal) => observe(record, "stop", signal),
    } satisfies SandboxReconciliationBackend,
    async evidence(
      plan: SandboxExecutionPlanV2,
      facts: SandboxExecutionFacts,
    ): Promise<Awaited<ReturnType<SandboxExecutionEvidencePort["verify"]>>["evidence"]> {
      const resource = facts.resource;
      if (resource.supervision !== "controlled" && resource.supervision !== "released") return [];
      const control = await readControl(plan);
      const artifact = await options.read(plan, observationKey(plan, resource.sequence));
      const value = artifact?.value as StoredObservation | undefined;
      if (
        !artifact ||
        !value ||
        artifact.ref !== resource.evidence.ref ||
        artifact.digest !== resource.evidence.digest ||
        value.observation.bootId !== control.bootId ||
        value.observation.processIdentityRef !== control.processIdentityRef ||
        value.fingerprint !== plan.semanticFingerprint ||
        value.environmentId !== plan.environmentId ||
        value.resourceSequence !== resource.sequence ||
        resource.evidence.subject.kind !== "local_process" ||
        resource.evidence.subject.processIdentityRef !== value.observation.processIdentityRef ||
        (await classify(
          { plan, facts, workspaces: [], startedAt: null, operationRevision: 0 },
          value.observation,
          (
            await options.host(plan)
          ).qualification,
        )) !== resource.supervision
      )
        throw new Error("SANDBOX_CONTROL_EVIDENCE_CHANGED");
      const proofs = [{ ref: artifact.ref, digest: artifact.digest }];
      proofs.push(...(await readinessEvidence(plan, facts)));
      return proofs;
    },
  };
}
