// biome-ignore-all lint/complexity/useLiteralKeys: untrusted authority JSON stays index-signature typed until validated
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { DeploymentAuthorityState } from "@himawari-agent/domain";
import {
  activateDeployment,
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createTransferId,
  retireDeployment,
} from "@himawari-agent/domain";

export const STATE_ROOT_ERROR_CODES = Object.freeze({
  PATH_UNSAFE: "STATE_ROOT_PATH_UNSAFE",
  PERMISSIONS_UNSAFE: "STATE_ROOT_PERMISSIONS_UNSAFE",
  AUTHORITY_INVALID: "STATE_ROOT_AUTHORITY_INVALID",
  AUTHORITY_WRITE_FAILED: "STATE_ROOT_AUTHORITY_WRITE_FAILED",
} as const);

export type StateRootErrorCode =
  (typeof STATE_ROOT_ERROR_CODES)[keyof typeof STATE_ROOT_ERROR_CODES];

export class StateRootLifecycleError extends Error {
  readonly code: StateRootErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: StateRootErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "StateRootLifecycleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface StateRootLayout {
  readonly root: string;
  readonly data: string;
  readonly runtime: string;
  readonly cache: string;
  readonly payloadCiphertext: string;
  readonly authorityFile: string;
}

const AUTHORITY_FIELDS = Object.freeze([
  "schemaVersion",
  "id",
  "ownerId",
  "agentId",
  "revision",
  "status",
  "authorityEpoch",
  "fencingToken",
  "transferId",
]);

async function ensureRestrictedDirectory(directory: string, resource: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.PERMISSIONS_UNSAFE,
      "State-root directory permissions are unsafe",
      { resource },
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.PERMISSIONS_UNSAFE,
      "State-root directory is not owned by the service account",
      { resource },
    );
  }
}

export async function initializeStateRoot(stateRoot: string): Promise<StateRootLayout> {
  if (!path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.PATH_UNSAFE,
      "State root must be a normalized absolute path",
    );
  }
  const layout = Object.freeze({
    root: stateRoot,
    data: path.join(stateRoot, "data"),
    runtime: path.join(stateRoot, "runtime"),
    cache: path.join(stateRoot, "cache"),
    payloadCiphertext: path.join(stateRoot, "data", "payload-ciphertext"),
    authorityFile: path.join(stateRoot, "authority.json"),
  });
  await ensureRestrictedDirectory(layout.root, "state-root");
  await ensureRestrictedDirectory(layout.data, "data-partition");
  await ensureRestrictedDirectory(layout.runtime, "runtime-partition");
  await ensureRestrictedDirectory(layout.cache, "cache-partition");
  await ensureRestrictedDirectory(layout.payloadCiphertext, "payload-ciphertext");
  return layout;
}

function authorityJson(authority: DeploymentAuthorityState): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    id: authority.id,
    ownerId: authority.ownerId,
    agentId: authority.agentId,
    revision: authority.revision,
    status: authority.status,
    authorityEpoch: authority.authorityEpoch,
    fencingToken: authority.fencingToken,
    transferId: authority.transferId,
  })}\n`;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Authority record is invalid",
      { field },
    );
  }
  return value as number;
}

export async function writeAuthorityFile(
  layout: StateRootLayout,
  authority: DeploymentAuthorityState,
): Promise<void> {
  const temporary = path.join(layout.root, `.authority-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(authorityJson(authority));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, layout.authorityFile);
    await chmod(layout.authorityFile, 0o600);
    const directory = await open(layout.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_WRITE_FAILED,
      "Authority record could not be atomically committed",
    );
  }
}

export async function readAuthorityFile(
  layout: StateRootLayout,
): Promise<DeploymentAuthorityState> {
  const info = await lstat(layout.authorityFile).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Authority record is missing or unsafe",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(layout.authorityFile, "utf8"));
  } catch {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Authority record is not valid JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Authority record is invalid",
    );
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((field) => !AUTHORITY_FIELDS.includes(field));
  const status = input["status"];
  if (
    input["schemaVersion"] !== 1 ||
    unknown.length > 0 ||
    typeof input["id"] !== "string" ||
    typeof input["ownerId"] !== "string" ||
    typeof input["agentId"] !== "string" ||
    !(["inactive_ready", "active", "retired_pending_transfer", "retired"] as const).includes(
      status as never,
    ) ||
    (input["transferId"] !== null && typeof input["transferId"] !== "string")
  ) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Authority record fields are invalid",
    );
  }
  const authorityEpoch = parseNonNegativeInteger(input["authorityEpoch"], "authorityEpoch");
  const fencingToken = parseNonNegativeInteger(input["fencingToken"], "fencingToken");
  if (status === "active" && (authorityEpoch === 0 || fencingToken === 0)) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Active authority requires a positive epoch and fence",
    );
  }
  return Object.freeze({
    id: createDeploymentId(input["id"]),
    ownerId: createOwnerId(input["ownerId"]),
    agentId: createAgentId(input["agentId"]),
    revision: parseNonNegativeInteger(input["revision"], "revision"),
    status: status as DeploymentAuthorityState["status"],
    authorityEpoch,
    fencingToken,
    transferId:
      input["transferId"] === null ? null : createTransferId(input["transferId"] as string),
  });
}

export async function markAuthorityTransferPending(
  layout: StateRootLayout,
  input: { readonly deploymentId: string; readonly transferId: string },
): Promise<DeploymentAuthorityState> {
  const current = await readAuthorityFile(layout);
  if (
    current.id === input.deploymentId &&
    current.status === "retired_pending_transfer" &&
    current.transferId === input.transferId
  ) {
    return current;
  }
  if (current.id !== input.deploymentId || current.status !== "active") {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Only the current active deployment may enter transfer-pending state",
    );
  }
  const next = retireDeployment(
    Object.freeze({ ...current, transferId: createTransferId(input.transferId) }),
    "retired_pending_transfer",
  );
  await writeAuthorityFile(layout, next);
  return next;
}

export async function establishImportedAuthority(
  layout: StateRootLayout,
  input: {
    readonly deploymentId: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly sourceAuthorityEpoch: number;
    readonly transferId: string;
  },
): Promise<DeploymentAuthorityState> {
  if (!Number.isSafeInteger(input.sourceAuthorityEpoch) || input.sourceAuthorityEpoch < 1) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Imported authority requires a positive source authority epoch",
    );
  }
  if (await lstat(layout.authorityFile).catch(() => undefined)) {
    const current = await readAuthorityFile(layout);
    if (
      current.id === input.deploymentId &&
      current.ownerId === input.ownerId &&
      current.agentId === input.agentId &&
      current.status === "inactive_ready" &&
      current.authorityEpoch === 0 &&
      current.fencingToken === 0 &&
      current.transferId === input.transferId
    ) {
      return current;
    }
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Imported authority requires an empty target authority slot",
    );
  }
  const authority = Object.freeze({
    id: createDeploymentId(input.deploymentId),
    ownerId: createOwnerId(input.ownerId),
    agentId: createAgentId(input.agentId),
    revision: 0,
    status: "inactive_ready" as const,
    authorityEpoch: 0,
    fencingToken: 0,
    transferId: createTransferId(input.transferId),
  });
  await writeAuthorityFile(layout, authority);
  return authority;
}

export async function activateImportedAuthority(
  layout: StateRootLayout,
  input: {
    readonly deploymentId: string;
    readonly transferId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
  },
): Promise<DeploymentAuthorityState> {
  const current = await readAuthorityFile(layout);
  if (
    current.id === input.deploymentId &&
    current.status === "active" &&
    current.transferId === input.transferId &&
    current.authorityEpoch === input.authorityEpoch &&
    current.fencingToken === input.fencingToken
  ) {
    return current;
  }
  if (
    current.id !== input.deploymentId ||
    current.status !== "inactive_ready" ||
    current.transferId !== input.transferId
  ) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
      "Imported authority is not ready for this transfer activation",
    );
  }
  const active = activateDeployment(current, {
    authorityEpoch: input.authorityEpoch,
    fencingToken: input.fencingToken,
  });
  await writeAuthorityFile(layout, active);
  return active;
}
