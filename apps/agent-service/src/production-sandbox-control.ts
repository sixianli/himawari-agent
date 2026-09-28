import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type SandboxCleanupPending,
  type SandboxExecutionEvidencePort,
  type SandboxExecutionFacts,
  type SandboxExecutionRecord,
  type SandboxReservationReleaseVerification,
  sandboxReconciliationFailureReason,
} from "@himawari-agent/application";
import {
  FIXED_FILE_COMPLETION_GUARANTEE,
  PI_COPY_SAVE_CONTRACT,
  PI_DIRECTORY_MOVE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxJobControlBinding,
  type SandboxPreparationDiagnostic,
  type SandboxResourceObservation,
  type SandboxRuntimeQualification,
  sandboxJobControlBindingSchema,
  sandboxPreparationDiagnosticSchema,
  sandboxResourceObservationSchema,
} from "@himawari-agent/execution-contracts";
import {
  type JobHostControlObservation,
  processGroupPresent,
  queryJobHostControl,
  readJobHostFinalEvidence,
  readJobHostStartEvidence,
  readLinuxNamespaceState,
  readProcessStartToken,
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
  readonly machineBootId?: string;
}
interface StoredPreparationControl {
  readonly version: "sandbox-preparation-control.v1";
  readonly identity: SandboxExecutionPlanV2["identity"];
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly control: SandboxJobControlBinding;
  readonly directoryDevice: string;
  readonly directoryInode: string;
  readonly policyDigest: string;
  readonly machineBootId: string;
  readonly executionLease: SandboxExecutionPlanV2["executionLease"];
}
interface StoredObservation {
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly resourceSequence: number;
  readonly observation: JobHostControlObservation;
}
interface StoredRestart {
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly resourceSequence: number;
  readonly restart: {
    readonly recordedMachineBootId: string;
    readonly currentMachineBootId: string;
  };
}
interface StoredCrash {
  readonly fingerprint: string;
  readonly environmentId: string;
  readonly resourceSequence: number;
  readonly crash: {
    readonly start: JobHostControlObservation;
    readonly checkedAt: string;
    readonly host: "absent" | "replaced";
    readonly processGroup: "absent" | "leader_replaced";
  };
}
interface Options {
  readonly now: () => string;
  readonly machineBootId: () => Promise<string>;
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
  /** Verify the protected terminal proof of the qualified, closed fixed-file
   * program. Never supplied by the model, and never used for arbitrary commands. */
  readonly fixedFileCompleted?: (record: SandboxExecutionRecord) => Promise<boolean>;
  /** Admission checks current scope/Grant and host bytes together before registration. */
  readonly admit: (
    plan: SandboxExecutionPlanV2,
  ) => Promise<{ binding: SandboxHostBinding; qualification: SandboxRuntimeQualification }>;
}
const key = (plan: SandboxExecutionPlanV2) =>
  `sandbox-control:${createHash("sha256").update(JSON.stringify(plan.identity)).digest("hex")}`;
const observationKey = (plan: SandboxExecutionPlanV2, sequence: number) =>
  `${key(plan)}:observation:${sequence}`;
class UnreachableHost {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}
const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;
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
type ControlState =
  | "controlled"
  | "released"
  | "process_group_gone"
  | "exit_cleanup_pending"
  | "lost";
const resourceState = (state: ControlState) =>
  ({
    controlled: { supervision: "controlled", cleanup: "pending" },
    released: { supervision: "released", cleanup: "confirmed" },
    process_group_gone: { supervision: "released", cleanup: "process_group_gone" },
    lost: { supervision: "lost", cleanup: "unknown" },
    exit_cleanup_pending: null,
  })[state];
function neverStartedReleased(
  raw: JobHostControlObservation,
  namespace: "alive" | "released" | "unknown",
): boolean {
  return (
    raw.phase === "finished" &&
    !raw.taskStarted &&
    raw.srtReset &&
    (raw.linuxNamespace === null || namespace === "released") &&
    processAbsent(raw.processId)
  );
}

/** Uses the existing protected Run artifacts for control bindings and raw facts.
 * It never installs a backend, consumes a Grant, executes user code, or signals a
 * numeric PID. A live stop goes to the original authenticated Job Host only.
 */
export function createProductionSandboxControl(options: Options) {
  const saveDiagnostic = async (
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    stage: "control" | "host" | "classification",
    error: unknown,
  ) => {
    // The production writer encrypts these as restricted trace artifacts. Never
    // include diagnostic text in resource facts, public reasons, or tool output.
    await options.write(plan, `${key(plan)}:diagnostic:${randomUUID()}`, {
      identity: plan.identity,
      environmentId: plan.environmentId,
      observedAt: options.now(),
      command,
      stage,
      reasonCode: sandboxReconciliationFailureReason(error),
      diagnostic:
        error instanceof Error
          ? { name: error.name.slice(0, 128), message: error.message.slice(0, 4096) }
          : { name: "UnknownError", message: String(error).slice(0, 4096) },
    });
  };
  const withDiagnostic = async <T>(
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    action: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      await saveDiagnostic(plan, command, "control", error);
      throw error;
    }
  };
  const readStoredControl = async (plan: SandboxExecutionPlanV2): Promise<StoredControl> => {
    const stored = await options.read(plan, key(plan));
    const value = stored?.value as StoredControl | undefined;
    if (
      !value ||
      value.fingerprint !== plan.semanticFingerprint ||
      value.environmentId !== plan.environmentId
    )
      throw new Error("SANDBOX_CONTROL_BINDING_UNAVAILABLE");
    sandboxJobControlBindingSchema.parse(value.control);
    return value;
  };
  const restartedSince = async (control: StoredControl) => {
    if (control.machineBootId === undefined) return undefined;
    const current = await options.machineBootId();
    return current === control.machineBootId
      ? undefined
      : { recordedMachineBootId: control.machineBootId, currentMachineBootId: current };
  };
  const readControl = async (plan: SandboxExecutionPlanV2): Promise<StoredControl> => {
    const value = await readStoredControl(plan);
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
  const readPreparationControl = async (plan: SandboxExecutionPlanV2) => {
    const artifact = await options.read(plan, `${key(plan)}:preparation`);
    const value = artifact?.value as StoredPreparationControl | undefined;
    if (
      !value ||
      value.version !== "sandbox-preparation-control.v1" ||
      !same(value.identity, plan.identity) ||
      value.fingerprint !== plan.semanticFingerprint ||
      value.environmentId !== plan.environmentId ||
      !same(value.executionLease, plan.executionLease)
    )
      throw new Error("SANDBOX_CONTROL_BINDING_UNAVAILABLE");
    sandboxJobControlBindingSchema.parse(value.control);
    const directory = await lstat(value.control.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      String(directory.dev) !== value.directoryDevice ||
      String(directory.ino) !== value.directoryInode ||
      (directory.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && directory.uid !== process.getuid())
    )
      throw new Error("SANDBOX_CONTROL_DIRECTORY_CHANGED");
    if (value.machineBootId !== (await options.machineBootId()))
      throw new Error("SANDBOX_PREPARATION_MACHINE_CHANGED");
    return value;
  };
  const inspectPreparation = async (
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ) => {
    if (await options.read(plan, key(plan))) return inspect(plan, command, signal);
    const stored = await readPreparationControl(plan);
    let observation: JobHostControlObservation;
    try {
      observation = await queryJobHostControl(stored.control, command, 1000, signal);
    } catch (error) {
      try {
        observation = await readJobHostFinalEvidence(stored.control);
      } catch (proofError) {
        if (errorCode(proofError) === "ENOENT") throw error;
        throw proofError;
      }
    }
    if (signal?.aborted) throw new Error("SANDBOX_CONTROL_ABORTED");
    if (observation.policyDigest !== stored.policyDigest || observation.observedAt > options.now())
      throw new Error("SANDBOX_CONTROL_IDENTITY_CHANGED");
    await readPreparationControl(plan);
    return observation;
  };
  const attempt = async (
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ): Promise<JobHostControlObservation | UnreachableHost> => {
    const stored = await readControl(plan);
    let observation: JobHostControlObservation;
    try {
      observation = await queryJobHostControl(stored.control, command, 1000, signal);
    } catch (requestError) {
      try {
        observation = await readJobHostFinalEvidence(stored.control);
      } catch (proofError) {
        // An absent final file is not the cause of a failed live request. Keep
        // its timeout/permission/connection reason; invalid final proof still wins.
        if (errorCode(proofError) === "ENOENT") return new UnreachableHost(requestError);
        throw proofError;
      }
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
  const inspect = async (
    plan: SandboxExecutionPlanV2,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ) => {
    const observation = await attempt(plan, command, signal);
    if (observation instanceof UnreachableHost) throw observation.error;
    return observation;
  };
  const crashedWithinBoot = async (
    record: SandboxExecutionRecord,
  ): Promise<StoredCrash["crash"] | undefined> => {
    const stored = await readControl(record.plan);
    let start: Awaited<ReturnType<typeof readJobHostStartEvidence>>;
    try {
      start = await readJobHostStartEvidence(stored.control);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (
      start.bootId !== stored.bootId ||
      start.processIdentityRef !== stored.processIdentityRef ||
      start.policyDigest !== stored.policyDigest ||
      start.observedAt > options.now()
    )
      throw new Error("SANDBOX_CONTROL_IDENTITY_CHANGED");
    if (
      start.bootId !== record.facts.environment.supervisor.bootId ||
      start.sessionId !== record.facts.environment.supervisor.supervisorId ||
      start.policyDigest !== record.facts.environment.policyDigest
    )
      return undefined;
    const hostToken = await readProcessStartToken(start.processId);
    if (hostToken === start.processStartToken) return undefined;
    if (
      start.linuxNamespace &&
      (await readLinuxNamespaceState(start.linuxNamespace)) !== "released"
    )
      return undefined;
    const { processGroupId, startToken } = start.taskProcessGroup;
    let processGroup: StoredCrash["crash"]["processGroup"] = "absent";
    if (processGroupPresent(processGroupId)) {
      const leaderToken = await readProcessStartToken(processGroupId);
      if (leaderToken === null || leaderToken === startToken) return undefined;
      processGroup = "leader_replaced";
    }
    return {
      start,
      checkedAt: options.now(),
      host: hostToken === null ? "absent" : "replaced",
      processGroup,
    };
  };
  const classify = async (
    record: SandboxExecutionRecord,
    raw: JobHostControlObservation,
    qualification: SandboxRuntimeQualification,
  ): Promise<ControlState> => {
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
    // This qualification concerns a closed program, not arbitrary process-tree
    // termination. Its only shared publisher has returned; its native helper is
    // awaited and cannot fork. Interrupted/unverified programs remain unknown.
    if (
      qualification.guarantees?.includes(FIXED_FILE_COMPLETION_GUARANTEE) &&
      record.plan.operationContract.ref === PI_PREPARED_FILE_CONTRACT.ref &&
      [
        PI_PREPARED_FILE_CONTRACT.version,
        PI_DIRECTORY_MOVE_CONTRACT.version,
        PI_COPY_SAVE_CONTRACT.version,
      ].some((version) => version === record.plan.operationContract.version) &&
      record.plan.mode === "foreground" &&
      raw.taskStarted &&
      raw.phase === "finished" &&
      raw.taskProcessExited &&
      raw.stdioClosed &&
      raw.srtReset &&
      processAbsent(raw.processId) &&
      (await options.fixedFileCompleted?.(record))
    )
      return "released";
    // A finished, never-started environment can be released only after the
    // original host PID is absent. PID reuse/permission errors remain unknown.
    if (neverStartedReleased(raw, namespace)) return "released";
    if (
      raw.taskStarted &&
      raw.phase === "finished" &&
      raw.taskProcessExited &&
      raw.srtReset &&
      raw.taskProcessGroupGone === true &&
      processAbsent(raw.processId)
    )
      return "process_group_gone";
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
    if (
      (raw.phase === "stopping" ||
        (raw.taskStarted &&
          raw.taskProcessExited &&
          (raw.phase === "running" || (raw.phase === "finished" && raw.srtReset)))) &&
      !processAbsent(raw.processId) &&
      Date.parse(options.now()) - Date.parse(raw.observedAt) <= 1500
    )
      return "exit_cleanup_pending";
    return "lost";
  };
  const observeGone = async (
    record: SandboxExecutionRecord,
    control: StoredControl,
    fact: Pick<StoredRestart, "restart"> | Pick<StoredCrash, "crash">,
  ): Promise<SandboxResourceObservation> => {
    await options.host(record.plan);
    const old = record.facts.resource;
    const sequence = old.sequence + 1;
    const stored = await options.write(record.plan, observationKey(record.plan, sequence), {
      fingerprint: record.plan.semanticFingerprint,
      environmentId: record.plan.environmentId,
      resourceSequence: sequence,
      ...fact,
    } satisfies StoredRestart | StoredCrash);
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
        old.status.kind === "task"
          ? { kind: "task", state: "exited" }
          : old.status.kind === "service"
            ? { kind: "service", readiness: "unavailable" }
            : old.status,
      metrics: old.metrics,
      ...resourceState("process_group_gone"),
      evidence: {
        ref: stored.ref,
        digest: stored.digest,
        profileRef: record.plan.binding.profileRef,
        qualificationRef: record.plan.binding.qualificationRef,
        validUntil: new Date(Date.parse(now) + 1000).toISOString(),
        subject: { kind: "local_process", processIdentityRef: control.processIdentityRef },
      },
    });
  };
  const observeUnchecked = async (
    record: SandboxExecutionRecord,
    command: "inspect" | "stop",
    signal?: AbortSignal,
  ): Promise<SandboxResourceObservation | SandboxCleanupPending> => {
    const control = await readStoredControl(record.plan);
    const restart = await restartedSince(control);
    if (restart) return observeGone(record, control, { restart });
    const afterCrash = async (unreachable: UnreachableHost) => {
      const crash = await crashedWithinBoot(record);
      if (!crash) throw unreachable.error;
      return observeGone(record, control, { crash });
    };
    // Stop the authenticated original host promptly, then verify its resulting
    // state. File verification must never delay delivery of a stop request.
    if (command === "stop") {
      const stopped = await attempt(record.plan, "stop", signal);
      if (stopped instanceof UnreachableHost) return afterCrash(stopped);
    }
    // Read installed bytes before sampling a live process. A slow disk must not
    // consume the observation's freshness window before classification begins.
    let host: Awaited<ReturnType<Options["host"]>> | undefined;
    let reasonCode = "SANDBOX_CONTROL_UNCONFIRMED";
    try {
      host = await options.host(record.plan);
    } catch (error) {
      // Still retain the process observation; unqualified cleanup remains lost.
      await saveDiagnostic(record.plan, command, "host", error);
      const classified = sandboxReconciliationFailureReason(error);
      reasonCode =
        classified === "SANDBOX_RECONCILIATION_UNCONFIRMED"
          ? "SANDBOX_HOST_UNAVAILABLE"
          : classified;
    }
    const raw = await attempt(record.plan, "inspect", signal);
    if (raw instanceof UnreachableHost) return afterCrash(raw);
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
    let state: ControlState = "lost";
    try {
      if (host) state = await classify(record, raw, host.qualification);
    } catch (error) {
      await saveDiagnostic(record.plan, command, "classification", error);
      reasonCode = sandboxReconciliationFailureReason(error);
    }
    if (
      host &&
      state === "lost" &&
      raw.phase === "finished" &&
      raw.taskStarted &&
      raw.taskProcessExited &&
      raw.srtReset &&
      raw.taskProcessGroupGone === false
    ) {
      const crash = await crashedWithinBoot(record);
      if (crash) return observeGone(record, control, { crash });
    }
    if (state === "exit_cleanup_pending")
      return {
        kind: "cleanup_pending",
        identity: record.plan.identity,
        environmentId: record.plan.environmentId,
        resourceSequence: record.facts.resource.sequence,
        observedAt: raw.observedAt,
      };
    if (command === "stop" && state === "controlled") state = "lost";
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
                state:
                  raw.taskProcessExited || state === "released" || state === "process_group_gone"
                    ? "exited"
                    : "unknown",
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
      ...resourceState(state),
      ...(state === "lost"
        ? { reasonCode }
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
  const observe = async (
    record: SandboxExecutionRecord,
    command: "inspect" | "stop" = "inspect",
    signal?: AbortSignal,
  ) => {
    return withDiagnostic(record.plan, command, () => observeUnchecked(record, command, signal));
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
    async hasExitedTask(record: SandboxExecutionRecord): Promise<boolean> {
      if (record.facts.environment.kind !== "local") return false;
      const stored = await readControl(record.plan);
      let observation: JobHostControlObservation;
      try {
        observation = await readJobHostFinalEvidence(stored.control);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
      if (
        observation.bootId !== stored.bootId ||
        observation.processIdentityRef !== stored.processIdentityRef ||
        observation.policyDigest !== stored.policyDigest ||
        observation.observedAt > options.now() ||
        observation.privateDirectoryRef !== record.facts.environment.privateDirectoryRef
      )
        throw new Error("SANDBOX_CONTROL_IDENTITY_CHANGED");
      await readControl(record.plan);
      return observation.taskStarted && observation.taskProcessExited;
    },
    async recordPreparationDiagnostic(
      plan: SandboxExecutionPlanV2,
      input: SandboxPreparationDiagnostic,
    ) {
      const diagnostic = sandboxPreparationDiagnosticSchema.parse(input);
      const operationKey = `${key(plan)}:diagnostic:preparation-failure`;
      if (await options.read(plan, operationKey)) return;
      await options.write(plan, operationKey, {
        identity: plan.identity,
        environmentId: plan.environmentId,
        observedAt: options.now(),
        command: "prepare",
        ...diagnostic,
      });
    },
    async registerPreparation(
      plan: SandboxExecutionPlanV2,
      input: SandboxJobControlBinding,
      policyDigest: string,
    ): Promise<boolean> {
      const control = sandboxJobControlBindingSchema.parse(input);
      if (
        control.jobId !== plan.identity.jobId ||
        control.attemptId !== plan.identity.attemptId ||
        !/^[a-f0-9]{64}$/.test(policyDigest)
      )
        throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
      const { binding } = await options.admit(plan);
      if (
        (await realpath(control.directory)) !== control.directory ||
        !within(binding.privateRoot, control.directory) ||
        [
          binding.runtimeRoot,
          ...binding.readOnlyToolchainPaths,
          ...binding.roots.map((root) => root.canonicalPath),
        ].some(
          (root) =>
            root === control.directory ||
            within(root, control.directory) ||
            within(control.directory, root),
        )
      )
        throw new Error("SANDBOX_CONTROL_SCOPE_INVALID");
      const existing = await options.read(plan, `${key(plan)}:preparation`);
      if (existing) {
        const saved = await readPreparationControl(plan);
        if (!same(saved.control, control) || saved.policyDigest !== policyDigest)
          throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
        return false;
      }
      if (await options.read(plan, key(plan)))
        throw new Error("SANDBOX_CONTROL_ALREADY_REGISTERED");
      const metadata = await lstat(control.directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      )
        throw new Error("SANDBOX_CONTROL_DIRECTORY_CHANGED");
      await options.write(plan, `${key(plan)}:preparation`, {
        version: "sandbox-preparation-control.v1",
        identity: plan.identity,
        fingerprint: plan.semanticFingerprint,
        environmentId: plan.environmentId,
        control,
        policyDigest,
        directoryDevice: String(metadata.dev),
        directoryInode: String(metadata.ino),
        machineBootId: await options.machineBootId(),
        executionLease: plan.executionLease,
      } satisfies StoredPreparationControl);
      return true;
    },
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
      if (await options.read(plan, `${key(plan)}:preparation`)) {
        const prepared = await readPreparationControl(plan);
        if (!same(prepared.control, control) || prepared.policyDigest !== observation.policyDigest)
          throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
      }
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
        machineBootId: await options.machineBootId(),
      } satisfies StoredControl);
      return true;
    },
    async stopPreparation(plan: SandboxExecutionPlanV2, signal?: AbortSignal) {
      return withDiagnostic(plan, "stop", async () => {
        const observation = await inspectPreparation(plan, "stop", signal);
        // This is a cleanup request receipt, never an environment release proof.
        // A stopped reservation remains protected until independent verification.
        await options.write(plan, `${key(plan)}:preparation-stop:${observation.sequence}`, {
          fingerprint: plan.semanticFingerprint,
          environmentId: plan.environmentId,
          observation,
        });
      });
    },
    async verifyReservationRelease(
      plan: SandboxExecutionPlanV2,
      stopRequestedAt: string,
      signal?: AbortSignal,
    ): Promise<SandboxReservationReleaseVerification | undefined> {
      return withDiagnostic(plan, "inspect", async () => {
        if (
          !Number.isFinite(Date.parse(stopRequestedAt)) ||
          new Date(stopRequestedAt).toISOString() !== stopRequestedAt ||
          stopRequestedAt > options.now()
        )
          throw new Error("SANDBOX_RESERVATION_STOP_FENCE_INVALID");
        // Recheck installed host identity, never the expired operation Grant.
        await options.host(plan);
        const raw = await inspectPreparation(plan, "inspect", signal);
        const namespace = raw.linuxNamespace
          ? await readLinuxNamespaceState(raw.linuxNamespace)
          : "unknown";
        if (!neverStartedReleased(raw, namespace)) return undefined;
        if (signal?.aborted) throw new Error("SANDBOX_RECONCILIATION_INTERRUPTED");
        const checkedAt = options.now();
        const validUntil = new Date(Date.parse(checkedAt) + 1000).toISOString();
        const evidence = await options.write(
          plan,
          `${key(plan)}:reservation-release:${raw.sequence}:${checkedAt}`,
          {
            schemaVersion: "sandbox-reservation-release.v1",
            identity: plan.identity,
            environmentId: plan.environmentId,
            fingerprint: plan.semanticFingerprint,
            stopRequestedAt,
            checkedAt,
            observation: raw,
          },
        );
        if (options.now() >= validUntil) return undefined;
        return {
          schemaVersion: "sandbox-reservation-release.v1",
          basis: "host_never_started",
          identity: plan.identity,
          environmentId: plan.environmentId,
          semanticFingerprint: plan.semanticFingerprint,
          stopRequestedAt,
          checkedAt,
          validUntil,
          processIdentityRef: raw.processIdentityRef,
          controlSessionId: raw.sessionId,
          evidence,
        };
      });
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
    observe,
    // Carry proof produced by this same host/process verification. Do not repeat
    // the expensive installed-byte check after issuing a one-second proof.
    async refreshEvidence(
      record: SandboxExecutionRecord,
      command: "inspect" | "stop" = "inspect",
      signal?: AbortSignal,
    ) {
      const resource = await observe(record, command, signal);
      if ("kind" in resource) return resource;
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
    async evidence(
      plan: SandboxExecutionPlanV2,
      facts: SandboxExecutionFacts,
    ): Promise<Awaited<ReturnType<SandboxExecutionEvidencePort["verify"]>>["evidence"]> {
      const resource = facts.resource;
      if (resource.supervision !== "controlled" && resource.supervision !== "released") return [];
      const artifact = await options.read(plan, observationKey(plan, resource.sequence));
      const crashed = artifact?.value as StoredCrash | undefined;
      if (artifact && crashed && "crash" in crashed) {
        const control = await readStoredControl(plan);
        if (
          artifact.ref !== resource.evidence.ref ||
          artifact.digest !== resource.evidence.digest ||
          crashed.fingerprint !== plan.semanticFingerprint ||
          crashed.environmentId !== plan.environmentId ||
          crashed.resourceSequence !== resource.sequence ||
          crashed.crash.start.bootId !== control.bootId ||
          crashed.crash.start.processIdentityRef !== control.processIdentityRef ||
          !same(resourceState("process_group_gone"), {
            supervision: resource.supervision,
            cleanup: resource.cleanup,
          }) ||
          resource.evidence.subject.kind !== "local_process" ||
          resource.evidence.subject.processIdentityRef !== control.processIdentityRef
        )
          throw new Error("SANDBOX_CONTROL_EVIDENCE_CHANGED");
        return [{ ref: artifact.ref, digest: artifact.digest }];
      }
      const restarted = artifact?.value as StoredRestart | undefined;
      if (restarted && "restart" in restarted) {
        const control = await readStoredControl(plan);
        const restart = await restartedSince(control);
        if (
          !artifact ||
          !restart ||
          artifact.ref !== resource.evidence.ref ||
          artifact.digest !== resource.evidence.digest ||
          restarted.fingerprint !== plan.semanticFingerprint ||
          restarted.environmentId !== plan.environmentId ||
          restarted.resourceSequence !== resource.sequence ||
          restarted.restart.recordedMachineBootId !== restart.recordedMachineBootId ||
          !same(resourceState("process_group_gone"), {
            supervision: resource.supervision,
            cleanup: resource.cleanup,
          }) ||
          resource.evidence.subject.kind !== "local_process" ||
          resource.evidence.subject.processIdentityRef !== control.processIdentityRef
        )
          throw new Error("SANDBOX_CONTROL_EVIDENCE_CHANGED");
        return [{ ref: artifact.ref, digest: artifact.digest }];
      }
      const control = await readControl(plan);
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
        !same(
          resourceState(
            await classify(
              { plan, facts, workspaces: [], startedAt: null, operationRevision: 0 },
              value.observation,
              (await options.host(plan)).qualification,
            ),
          ),
          { supervision: resource.supervision, cleanup: resource.cleanup },
        )
      )
        throw new Error("SANDBOX_CONTROL_EVIDENCE_CHANGED");
      const proofs = [{ ref: artifact.ref, digest: artifact.digest }];
      proofs.push(...(await readinessEvidence(plan, facts)));
      return proofs;
    },
  };
}
