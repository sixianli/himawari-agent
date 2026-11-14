import { lstat, mkdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import {
  finalJobHostObservation,
  type JobHostControlBinding,
  type JobHostControlEvidenceName,
  type JobHostControlObservation,
  type JobHostStartObservation,
  queryJobHostControl,
  readJobHostFinalEvidence,
  readJobHostStartEvidence,
  startedJobHostObservation,
  validateJobHostControlQuery,
  verifyJobHostControlEnvelope,
} from "./job-host-control.ts";
import { readGatewayFrames, writeGatewayFrame } from "./job-host-gateway-frames.ts";
import {
  blockedLaunchDecision,
  blockJobHostLaunch,
  claimJobHostLaunch,
  type JobHostLaunchContext,
  type JobHostLaunchEvidence,
  type JobHostLaunchOutcome,
  launchBlocked,
  launchClaimed,
  readJobHostLaunchDecision,
  verifyJobHostLaunchEvidence,
} from "./job-host-launch-decision.ts";

export interface JobHostControlDirectory {
  readonly directory: string;
  readonly device: string;
  readonly inode: string;
}

export interface JobHostControlDirectoryState {
  readonly canonical: boolean;
  readonly directory: boolean;
  readonly private: boolean;
  readonly device: string;
  readonly inode: string;
}

export interface JobHostControlAccess {
  prepareDirectory(name: string): Promise<JobHostControlDirectory>;
  describeDirectory(directory: string): Promise<JobHostControlDirectoryState>;
  query(
    binding: JobHostControlBinding,
    command: "inspect" | "stop",
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<JobHostControlObservation>;
  readFinalEvidence(binding: JobHostControlBinding): Promise<JobHostControlObservation>;
  readStartEvidence(binding: JobHostControlBinding): Promise<JobHostStartObservation>;
  readLaunchDecision(context: JobHostLaunchContext): Promise<JobHostLaunchEvidence | undefined>;
  claimLaunch(context: JobHostLaunchContext): Promise<boolean>;
  blockLaunch(context: JobHostLaunchContext, stopRequestedAt: string): Promise<boolean>;
}

export type JobHostRiskControl = Pick<
  JobHostControlAccess,
  | "describeDirectory"
  | "query"
  | "readFinalEvidence"
  | "readStartEvidence"
  | "readLaunchDecision"
  | "blockLaunch"
>;

function riskControl(access: JobHostControlAccess): JobHostRiskControl {
  return Object.freeze({
    describeDirectory: access.describeDirectory,
    query: access.query,
    readFinalEvidence: access.readFinalEvidence,
    readStartEvidence: access.readStartEvidence,
    readLaunchDecision: access.readLaunchDecision,
    blockLaunch: access.blockLaunch,
  });
}

export const localJobHostRiskControl = (): JobHostRiskControl =>
  riskControl(localJobHostControlAccess(null));

export const gatewayJobHostRiskControl = (socketPath: string): JobHostRiskControl =>
  riskControl(gatewayJobHostControlAccess(socketPath));

export const JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS = 10_000;

export function validateJobHostControlDirectoryName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^control-[a-f0-9]{20}$/.test(name))
    throw new Error("JOB_HOST_CONTROL_DIRECTORY_NAME_INVALID");
}

export async function prepareJobHostControlDirectory(
  root: string,
  name: string,
): Promise<JobHostControlDirectory> {
  validateJobHostControlDirectoryName(name);
  const directory = path.join(root, name);
  await mkdir(directory, { mode: 0o700 });
  const metadata = await lstat(directory);
  return Object.freeze({
    directory,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  });
}

export async function describeJobHostControlDirectory(
  directory: string,
): Promise<JobHostControlDirectoryState> {
  const metadata = await lstat(directory);
  const canonical = await realpath(directory).then(
    (resolved) => resolved === directory,
    () => false,
  );
  return Object.freeze({
    canonical,
    directory: metadata.isDirectory() && !metadata.isSymbolicLink(),
    private:
      (metadata.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || metadata.uid === process.getuid()),
    device: String(metadata.dev),
    inode: String(metadata.ino),
  });
}

export function localJobHostControlAccess(root: string | null): JobHostControlAccess {
  return Object.freeze({
    prepareDirectory: (name: string) => {
      if (root === null) throw new Error("JOB_HOST_CONTROL_ROOT_UNSET");
      return prepareJobHostControlDirectory(root, name);
    },
    describeDirectory: describeJobHostControlDirectory,
    query: queryJobHostControl,
    readFinalEvidence: readJobHostFinalEvidence,
    readStartEvidence: readJobHostStartEvidence,
    readLaunchDecision: readJobHostLaunchDecision,
    claimLaunch: claimJobHostLaunch,
    blockLaunch: blockJobHostLaunch,
  });
}

function gatewayError(frame: Record<string, unknown>): Error {
  const code = frame["error"];
  const systemCode = frame["systemCode"];
  const error = new Error(
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
      ? code
      : "JOB_HOST_GATEWAY_CONTROL_FAILED",
  );
  if (typeof systemCode === "string" && /^E[A-Z0-9]{1,20}$/.test(systemCode))
    Object.assign(error, { code: systemCode });
  return error;
}

function request(
  socketPath: string,
  operation: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(new Error("JOB_HOST_CONTROL_ABORTED"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      action();
    };
    const fail = (code: string) => settle(() => reject(new Error(code)));
    const abort = () => fail("JOB_HOST_CONTROL_ABORTED");
    const timer = setTimeout(() => fail("JOB_HOST_GATEWAY_CONTROL_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => writeGatewayFrame(socket, { type: "control", ...operation }));
    readGatewayFrames(
      socket,
      (frame) => {
        if (frame["type"] !== "result") return fail("JOB_HOST_GATEWAY_PROTOCOL_INVALID");
        if (frame["ok"] === true) return settle(() => resolve(frame));
        const error = gatewayError(frame);
        settle(() => reject(error));
      },
      () => fail("JOB_HOST_GATEWAY_PROTOCOL_INVALID"),
    );
    socket.on("error", () => fail("JOB_HOST_GATEWAY_UNAVAILABLE"));
    socket.on("close", () => fail("JOB_HOST_GATEWAY_UNAVAILABLE"));
  });
}

function text(frame: Record<string, unknown>, key: string): string {
  const value = frame[key];
  if (typeof value !== "string") throw new Error("JOB_HOST_GATEWAY_PROTOCOL_INVALID");
  return value;
}

export function gatewayJobHostControlAccess(socketPath: string): JobHostControlAccess {
  const evidence = async (binding: JobHostControlBinding, name: JobHostControlEvidenceName) =>
    verifyJobHostControlEnvelope(
      binding,
      text(
        await request(
          socketPath,
          { op: "evidence", binding, name },
          JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
        ),
        "encoded",
      ),
    );
  const decide = async (
    context: JobHostLaunchContext,
    op: "claim" | "block",
    stopRequestedAt?: string,
  ): Promise<JobHostLaunchOutcome> => {
    const frame = await request(
      socketPath,
      { op: "launch", action: op, context, ...(stopRequestedAt ? { stopRequestedAt } : {}) },
      JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
    );
    if (typeof frame["published"] !== "boolean")
      throw new Error("JOB_HOST_GATEWAY_PROTOCOL_INVALID");
    return {
      published: frame["published"],
      evidence: verifyJobHostLaunchEvidence(context, frame["evidence"]),
    };
  };
  return Object.freeze({
    async prepareDirectory(name: string) {
      validateJobHostControlDirectoryName(name);
      const frame = await request(
        socketPath,
        { op: "prepare", name },
        JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
      );
      const directory = text(frame, "directory");
      const device = text(frame, "device");
      const inode = text(frame, "inode");
      if (
        !path.isAbsolute(directory) ||
        path.basename(directory) !== name ||
        !/^\d+$/.test(device) ||
        !/^\d+$/.test(inode)
      )
        throw new Error("JOB_HOST_GATEWAY_PROTOCOL_INVALID");
      return Object.freeze({ directory, device, inode });
    },
    async describeDirectory(directory: string) {
      const frame = await request(
        socketPath,
        { op: "describe", directory },
        JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
      );
      const device = text(frame, "device");
      const inode = text(frame, "inode");
      if (
        [frame["canonical"], frame["directory"], frame["private"]].some(
          (flag) => typeof flag !== "boolean",
        ) ||
        !/^\d+$/.test(device) ||
        !/^\d+$/.test(inode)
      )
        throw new Error("JOB_HOST_GATEWAY_PROTOCOL_INVALID");
      return Object.freeze({
        canonical: frame["canonical"] as boolean,
        directory: frame["directory"] as boolean,
        private: frame["private"] as boolean,
        device,
        inode,
      });
    },
    async query(
      binding: JobHostControlBinding,
      command: "inspect" | "stop",
      timeoutMs = 1000,
      signal?: AbortSignal,
    ) {
      validateJobHostControlQuery(command, timeoutMs);
      const frame = await request(
        socketPath,
        { op: "query", binding, command, timeoutMs },
        timeoutMs + JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
        signal,
      );
      return verifyJobHostControlEnvelope(binding, text(frame, "encoded"));
    },
    readFinalEvidence: async (binding: JobHostControlBinding) =>
      finalJobHostObservation(await evidence(binding, "final.json")),
    readStartEvidence: async (binding: JobHostControlBinding) =>
      startedJobHostObservation(await evidence(binding, "started.json")),
    async readLaunchDecision(context: JobHostLaunchContext) {
      const frame = await request(
        socketPath,
        { op: "launch", action: "read", context },
        JOB_HOST_GATEWAY_CONTROL_TIMEOUT_MS,
      );
      return frame["evidence"] === null
        ? undefined
        : verifyJobHostLaunchEvidence(context, frame["evidence"]);
    },
    claimLaunch: async (context: JobHostLaunchContext) =>
      launchClaimed(await decide(context, "claim")),
    async blockLaunch(context: JobHostLaunchContext, stopRequestedAt: string) {
      blockedLaunchDecision(stopRequestedAt);
      return launchBlocked(await decide(context, "block", stopRequestedAt), stopRequestedAt);
    },
  });
}
