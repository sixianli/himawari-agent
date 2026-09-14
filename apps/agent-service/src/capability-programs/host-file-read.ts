import {
  HostFileReadService,
  resolveHostFileReadPath,
  scanMachineSecrets,
  type ClockPort,
  type HostDirectoryGrant,
  type HostFilePlatformPort,
  type ResolvedHostFileReadTarget,
} from "@himawari-agent/application";
import { executeGovernedPiRead } from "@himawari-agent/runtime-pi";

/** Handler for the qualified program capability, after normal Worker Handle admission. */
export async function executeHostFileReadCapability(
  input: unknown,
  options: {
    readonly hostId: string;
    readonly workerInstanceId: string;
    readonly platform: HostFilePlatformPort;
    readonly clock: ClockPort;
    readonly signal?: AbortSignal;
  },
): Promise<string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("HOST_FILE_INPUT_INVALID");
  const value = input as Record<string, unknown>;
  const grant = value["grant"] as HostDirectoryGrant | undefined;
  const phase = value["phase"];
  if (
    value["version"] !== "host-file.v1" ||
    value["hostId"] !== options.hostId ||
    value["workerInstanceId"] !== options.workerInstanceId ||
    !grant ||
    grant.hostId !== options.hostId ||
    (phase !== "inspect" && phase !== "read")
  )
    throw new Error("HOST_FILE_BINDING_INVALID");
  const allowedKeys =
    phase === "inspect"
      ? ["version", "phase", "hostId", "workerInstanceId", "grant", "path", "maximumBytes"]
      : ["version", "phase", "hostId", "workerInstanceId", "grant", "target", "arguments"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
    throw new Error("HOST_FILE_INPUT_INVALID");
  const resolver = new HostFileReadService({
    hostId: options.hostId,
    platform: options.platform,
    clock: options.clock,
    state: { readGrant: async (id) => (id === grant.id ? grant : undefined) },
    disclosure: {
      protect: async () => {
        throw new Error("HOST_FILE_PAYLOAD_BROKER_REQUIRED");
      },
    },
  });
  options.signal?.throwIfAborted();
  if (phase === "inspect") {
    if (
      typeof value["path"] !== "string" ||
      typeof value["maximumBytes"] !== "number" ||
      value["maximumBytes"] > 48 * 1024
    )
      throw new Error("HOST_FILE_INPUT_INVALID");
    return JSON.stringify(
      await resolver.resolveTarget({
        hostId: options.hostId,
        grantId: grant.id,
        path: value["path"],
        maximumBytes: value["maximumBytes"],
      }),
    );
  }
  const target = value["target"] as ResolvedHostFileReadTarget | undefined;
  const args = value["arguments"] as Record<string, unknown> | undefined;
  if (
    !target ||
    !args ||
    args["path"] !== target.requestedPath ||
    Object.keys(args).some((key) => !["path", "offset", "limit"].includes(key)) ||
    [args["offset"], args["limit"]].some(
      (n) => n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1),
    ) ||
    target.maximumBytes > 48 * 1024 ||
    !["model", "external_approved"].includes(grant.disclosure)
  )
    throw new Error("HOST_FILE_INPUT_INVALID");
  const current = await resolver.resolveTarget({
    hostId: options.hostId,
    grantId: grant.id,
    path: target.requestedPath,
    maximumBytes: target.maximumBytes,
  });
  for (const field of [
    "hostId",
    "grantId",
    "grantRevision",
    "authorizationRef",
    "canonicalRootId",
    "requestedPath",
    "relativePath",
    "maximumBytes",
  ] as const)
    if (current[field] !== target[field]) throw new Error("HOST_FILE_BINDING_INVALID");
  for (const field of [
    "canonicalPath",
    "device",
    "inode",
    "mode",
    "linkCount",
    "sizeBytes",
    "modifiedAtMillis",
  ] as const)
    if (current.identity[field] !== target.identity?.[field])
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
  const assertPath = (absolutePath: string) => {
    options.signal?.throwIfAborted();
    if (
      absolutePath !== target.identity.canonicalPath ||
      Date.parse(options.clock.now()) >= Date.parse(grant.expiresAt)
    )
      throw new Error("HOST_FILE_BINDING_INVALID");
  };
  const forbidden = async (): Promise<never> => {
    throw new Error("HOST_FILE_OPERATION_FORBIDDEN");
  };
  const text = await executeGovernedPiRead({
    cwd: grant.displayPath,
    path: target.identity.canonicalPath,
    ...(typeof args["offset"] === "number" ? { offset: args["offset"] } : {}),
    ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    operations: {
      access: async (file, mode) => {
        assertPath(file);
        if (mode !== "read") await forbidden();
      },
      readFile: async (file) => {
        assertPath(file);
        const relativePath = resolveHostFileReadPath(grant, target.requestedPath);
        const bytes = await options.platform.read(
          grant,
          relativePath,
          target.maximumBytes,
          target.identity,
        );
        assertPath(file);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (decoded.includes("\0") || scanMachineSecrets(decoded).length > 0)
          throw new Error("HOST_FILE_CONTENT_REJECTED");
        return bytes;
      },
      writeFile: forbidden,
      makeDirectory: forbidden,
      executeCommand: forbidden,
    },
  });
  options.signal?.throwIfAborted();
  return text;
}
