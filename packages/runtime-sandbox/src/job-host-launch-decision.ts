import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_PREPARATION_LAUNCH_PROTOCOL,
  type SandboxExecutionPlanV2,
  sandboxExecutionPlanV2Schema,
} from "@himawari-agent/execution-contracts";
import { type JobHostControlBinding, validateJobHostControlBinding } from "./job-host-control.ts";

export interface JobHostLaunchContext {
  readonly plan: SandboxExecutionPlanV2;
  readonly control: JobHostControlBinding;
  readonly policyDigest: string;
  readonly directoryDevice: string;
  readonly directoryInode: string;
}
export type JobHostLaunchDecision =
  | { readonly kind: "launch" }
  | { readonly kind: "blocked"; readonly stopRequestedAt: string };
export interface JobHostLaunchEvidence {
  readonly version: "sandbox-launch-decision.v1";
  readonly bindingDigest: string;
  readonly decision: JobHostLaunchDecision;
  readonly signature: string;
}
const maximumBytes = 4096;
const filename = (context: JobHostLaunchContext) =>
  path.join(context.control.directory, "launch-decision.json");
const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

async function validateContext(context: JobHostLaunchContext): Promise<void> {
  const plan = sandboxExecutionPlanV2Schema.parse(context.plan);
  if (
    plan.backendRef !== "srt" ||
    plan.preparationProtocol !== SANDBOX_PREPARATION_LAUNCH_PROTOCOL ||
    plan.identity.jobId !== context.control.jobId ||
    plan.identity.attemptId !== context.control.attemptId ||
    !/^[a-f0-9]{64}$/.test(context.policyDigest)
  )
    throw new Error("SANDBOX_PREPARATION_LAUNCH_BINDING_INVALID");
  await validateJobHostControlBinding(context.control);
  const directory = await lstat(context.control.directory);
  if (
    String(directory.dev) !== context.directoryDevice ||
    String(directory.ino) !== context.directoryInode
  )
    throw new Error("SANDBOX_CONTROL_DIRECTORY_CHANGED");
}
function bindingDigest(context: JobHostLaunchContext): string {
  const plan = sandboxExecutionPlanV2Schema.parse(context.plan);
  const control = context.control;
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: plan.preparationProtocol,
        identity: plan.identity,
        semanticFingerprint: plan.semanticFingerprint,
        environmentId: plan.environmentId,
        executionLease: plan.executionLease,
        policyDigest: context.policyDigest,
        control: {
          directory: control.directory,
          sessionId: control.sessionId,
          jobId: control.jobId,
          attemptId: control.attemptId,
        },
        directoryDevice: context.directoryDevice,
        directoryInode: context.directoryInode,
      }),
    )
    .digest("hex");
}
function signed(
  context: JobHostLaunchContext,
  decision: JobHostLaunchDecision,
): JobHostLaunchEvidence {
  const body = {
    version: "sandbox-launch-decision.v1" as const,
    bindingDigest: bindingDigest(context),
    decision,
  };
  return {
    ...body,
    signature: createHmac("sha256", context.control.token)
      .update(JSON.stringify(body))
      .digest("hex"),
  };
}
function verify(context: JobHostLaunchContext, value: unknown): JobHostLaunchEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
  const raw = value as Record<string, unknown>;
  const decision = raw["decision"] as Record<string, unknown> | undefined;
  if (
    Object.keys(raw).sort().join(",") !== "bindingDigest,decision,signature,version" ||
    raw["version"] !== "sandbox-launch-decision.v1" ||
    raw["bindingDigest"] !== bindingDigest(context) ||
    typeof raw["signature"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw["signature"]) ||
    !decision ||
    typeof decision !== "object" ||
    Array.isArray(decision) ||
    !(
      (decision["kind"] === "launch" && Object.keys(decision).length === 1) ||
      (decision["kind"] === "blocked" &&
        Object.keys(decision).length === 2 &&
        instant(decision["stopRequestedAt"]))
    )
  )
    throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
  const normalized: JobHostLaunchDecision =
    decision["kind"] === "launch"
      ? { kind: "launch" }
      : { kind: "blocked", stopRequestedAt: decision["stopRequestedAt"] as string };
  const expected = signed(context, Object.freeze(normalized));
  if (!timingSafeEqual(Buffer.from(raw["signature"]), Buffer.from(expected.signature)))
    throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
  return Object.freeze(expected);
}
export async function readJobHostLaunchDecision(
  context: JobHostLaunchContext,
): Promise<JobHostLaunchEvidence | undefined> {
  await validateContext(context);
  let handle: FileHandle;
  try {
    handle = await open(
      filename(context),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    await validateContext(context);
    return undefined;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maximumBytes ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    )
      throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const current = await lstat(filename(context));
    if (
      bytesRead > maximumBytes ||
      bytesRead !== metadata.size ||
      current.isSymbolicLink() ||
      metadata.dev !== current.dev ||
      metadata.ino !== current.ino ||
      metadata.size !== after.size ||
      metadata.mtimeMs !== after.mtimeMs ||
      metadata.mode !== current.mode ||
      metadata.uid !== current.uid ||
      metadata.size !== current.size ||
      metadata.mtimeMs !== current.mtimeMs
    )
      throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
    const result = verify(context, JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    await validateContext(context);
    return result;
  } finally {
    await handle.close();
  }
}
async function syncDirectory(context: JobHostLaunchContext): Promise<void> {
  await validateContext(context);
  const directory = await open(
    context.control.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await directory.stat();
    if (
      String(metadata.dev) !== context.directoryDevice ||
      String(metadata.ino) !== context.directoryInode
    )
      throw new Error("SANDBOX_CONTROL_DIRECTORY_CHANGED");
    await directory.sync();
  } finally {
    await directory.close();
  }
  await validateContext(context);
}
async function decide(
  context: JobHostLaunchContext,
  decision: JobHostLaunchDecision,
): Promise<{ published: boolean; evidence: JobHostLaunchEvidence }> {
  await validateContext(context);
  const existing = await readJobHostLaunchDecision(context);
  if (existing) {
    await syncDirectory(context);
    const evidence = await readJobHostLaunchDecision(context);
    if (!evidence) throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
    return { published: false, evidence };
  }
  const temporary = path.join(context.control.directory, `launch-${randomUUID()}.pending`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  let temporaryRemoved = false;
  try {
    try {
      await handle.writeFile(JSON.stringify(signed(context, decision)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validateContext(context);
    try {
      await link(temporary, filename(context));
      published = true;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    await unlink(temporary);
    temporaryRemoved = true;
    await syncDirectory(context);
    const evidence = await readJobHostLaunchDecision(context);
    if (!evidence) throw new Error("SANDBOX_PREPARATION_LAUNCH_EVIDENCE_INVALID");
    return { published, evidence };
  } finally {
    if (!temporaryRemoved) await unlink(temporary);
  }
}
export async function claimJobHostLaunch(context: JobHostLaunchContext): Promise<boolean> {
  const result = await decide(context, { kind: "launch" });
  return result.published && result.evidence.decision.kind === "launch";
}
export async function blockJobHostLaunch(
  context: JobHostLaunchContext,
  stopRequestedAt: string,
): Promise<boolean> {
  if (!instant(stopRequestedAt)) throw new Error("SANDBOX_RESERVATION_STOP_FENCE_INVALID");
  const result = await decide(context, { kind: "blocked", stopRequestedAt });
  if (result.evidence.decision.kind === "launch") return false;
  if (result.evidence.decision.stopRequestedAt !== stopRequestedAt)
    throw new Error("SANDBOX_RESERVATION_STOP_FENCE_INVALID");
  return true;
}
