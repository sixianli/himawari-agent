import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import type { LinuxNamespaceIdentity } from "./linux-namespace.ts";

/** Private per-environment control credential. It is never task input, a Worker
 * boot credential, or permission to execute. Persist only through protected storage. */
export interface JobHostControlBinding {
  readonly directory: string;
  readonly token: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly attemptId: string;
}
export interface JobHostControlObservation {
  readonly sessionId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly bootId: string;
  readonly processIdentityRef: string;
  readonly processId: number;
  readonly processStartedAt: string;
  readonly resources: {
    readonly samples: number;
    readonly observedCpuTimeMs: number;
    readonly peakObservedMemoryBytes: number;
  } | null;
  readonly observedAt: string;
  readonly sequence: number;
  readonly phase: "waiting" | "preparing" | "ready" | "running" | "stopping" | "finished";
  readonly policyDigest: string;
  readonly privateDirectoryRef: string;
  readonly linuxNamespace: LinuxNamespaceIdentity | null;
  readonly readiness?: {
    readonly ref: string;
    readonly digest: string;
    readonly readyAt: string | null;
  };
  readonly taskStarted: boolean;
  readonly taskProcessExited: boolean;
  readonly stdioClosed: boolean;
  readonly srtReset: boolean;
}
const maximumBytes = 16384;
const signature = (token: string, body: string) =>
  createHmac("sha256", token).update(body).digest("hex");
function equal(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export async function validateJobHostControlBinding(binding: JobHostControlBinding): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(binding.token) ||
    !/^[a-f0-9-]{36}$/.test(binding.sessionId) ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(binding.jobId) ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(binding.attemptId) ||
    !path.isAbsolute(binding.directory) ||
    (await realpath(binding.directory)) !== binding.directory
  )
    throw new Error("JOB_HOST_CONTROL_BINDING_INVALID");
  const metadata = await lstat(binding.directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  )
    throw new Error("JOB_HOST_CONTROL_DIRECTORY_INVALID");
  if (Buffer.byteLength(path.join(binding.directory, "control.sock")) > 100)
    throw new Error("JOB_HOST_CONTROL_PATH_TOO_LONG");
}
function verify(binding: JobHostControlBinding, encoded: string): JobHostControlObservation {
  if (Buffer.byteLength(encoded) > maximumBytes) throw new Error("JOB_HOST_CONTROL_TOO_LARGE");
  const envelope = JSON.parse(encoded) as { body?: unknown; signature?: unknown };
  if (
    typeof envelope.body !== "string" ||
    typeof envelope.signature !== "string" ||
    !equal(envelope.signature, signature(binding.token, envelope.body))
  )
    throw new Error("JOB_HOST_CONTROL_EVIDENCE_INVALID");
  const value = JSON.parse(envelope.body) as JobHostControlObservation;
  if (
    value.sessionId !== binding.sessionId ||
    value.jobId !== binding.jobId ||
    value.attemptId !== binding.attemptId ||
    !Number.isSafeInteger(value.processId) ||
    value.processId <= 1 ||
    typeof value.processStartedAt !== "string" ||
    !Number.isFinite(Date.parse(value.processStartedAt)) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !/^[a-f0-9]{64}$/.test(value.policyDigest) ||
    !/^sandbox-private:[a-f0-9]{64}$/.test(value.privateDirectoryRef) ||
    (value.linuxNamespace !== null &&
      (!value.linuxNamespace ||
        !/^pid:\[\d+\]$/.test(value.linuxNamespace.namespaceId) ||
        !Number.isSafeInteger(value.linuxNamespace.initPid) ||
        value.linuxNamespace.initPid <= 1 ||
        !/^\d+$/.test(value.linuxNamespace.initStartTicks))) ||
    !/^[a-f0-9-]{36}$/.test(value.bootId) ||
    !/^job-host-process:[a-f0-9-]{36}$/.test(value.processIdentityRef) ||
    !["waiting", "preparing", "ready", "running", "stopping", "finished"].includes(value.phase) ||
    (value.resources !== null &&
      (!value.resources ||
        [
          value.resources.samples,
          value.resources.observedCpuTimeMs,
          value.resources.peakObservedMemoryBytes,
        ].some((n) => !Number.isSafeInteger(n) || n < 0))) ||
    (value.readiness !== undefined &&
      (!value.readiness ||
        typeof value.readiness.ref !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.readiness.digest) ||
        (value.readiness.readyAt !== null &&
          (typeof value.readiness.readyAt !== "string" ||
            !Number.isFinite(Date.parse(value.readiness.readyAt)) ||
            value.readiness.readyAt > value.observedAt)))) ||
    [value.taskStarted, value.taskProcessExited, value.stdioClosed, value.srtReset].some(
      (flag) => typeof flag !== "boolean",
    )
  )
    throw new Error("JOB_HOST_CONTROL_EVIDENCE_INVALID");
  return Object.freeze(value);
}

/** Only read the original signed exit fact. Absence/tampering is unknown, never
 * an instruction to relaunch or kill the PID found in an old receipt. */
export async function readJobHostFinalEvidence(
  binding: JobHostControlBinding,
): Promise<JobHostControlObservation> {
  await validateJobHostControlBinding(binding);
  const file = path.join(binding.directory, "final.json");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes || (metadata.mode & 0o077) !== 0)
      throw new Error("JOB_HOST_CONTROL_EVIDENCE_INVALID");
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) throw new Error("JOB_HOST_CONTROL_TOO_LARGE");
    const observation = verify(binding, buffer.subarray(0, bytesRead).toString("utf8"));
    if (observation.phase !== "finished") throw new Error("JOB_HOST_CONTROL_EVIDENCE_INVALID");
    return observation;
  } finally {
    await handle.close();
  }
}

export async function queryJobHostControl(
  binding: JobHostControlBinding,
  command: "inspect" | "stop",
  timeoutMs = 1000,
  signal?: AbortSignal,
): Promise<JobHostControlObservation> {
  await validateJobHostControlBinding(binding);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !["inspect", "stop"].includes(command)
  )
    throw new Error("JOB_HOST_CONTROL_REQUEST_INVALID");
  if (signal?.aborted) throw new Error("JOB_HOST_CONTROL_ABORTED");
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(binding.directory, "control.sock"));
    const abort = () => socket.destroy(new Error("JOB_HOST_CONTROL_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    let bytes = "";
    const timer = setTimeout(
      () => socket.destroy(new Error("JOB_HOST_CONTROL_TIMEOUT")),
      timeoutMs,
    );
    socket.on("connect", () =>
      socket.end(
        `${JSON.stringify({ command, token: binding.token, sessionId: binding.sessionId })}\n`,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > maximumBytes)
        socket.destroy(new Error("JOB_HOST_CONTROL_TOO_LARGE"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
    socket.on("end", () => {
      try {
        resolve(verify(binding, bytes));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** The server only observes or reduces risk in this already owned environment.
 * No argv, paths, PID, credentials for other jobs, or start command are accepted. */
export async function openJobHostControl(
  binding: JobHostControlBinding,
  observe: () => JobHostControlObservation,
  stop: () => void,
) {
  await validateJobHostControlBinding(binding);
  const encode = () => {
    const body = JSON.stringify(observe());
    return JSON.stringify({ body, signature: signature(binding.token, body) });
  };
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (sockets.size > 4) {
      socket.destroy();
      return;
    }
    let bytes = "";
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > 1024) socket.destroy();
    });
    socket.on("end", () => {
      try {
        const input = JSON.parse(bytes) as {
          token?: unknown;
          sessionId?: unknown;
          command?: unknown;
        };
        if (
          Object.keys(input).length !== 3 ||
          typeof input.token !== "string" ||
          !equal(input.token, binding.token) ||
          input.sessionId !== binding.sessionId ||
          !["inspect", "stop"].includes(String(input.command))
        )
          throw new Error("invalid");
        if (input.command === "stop") stop();
        socket.end(encode());
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(binding.directory, "control.sock"), resolve);
  });
  return {
    async finish() {
      const encoded = encode();
      const temporary = path.join(binding.directory, "final.pending");
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path.join(binding.directory, "final.json"));
      const directory = await open(binding.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
