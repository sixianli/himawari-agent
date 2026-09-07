import {
  ApplicationPortError,
  HOST_FILE_ERROR_CODES,
  PORT_ERROR_CODES,
  type HostFileDisclosurePort,
  type HostFilePlatformPort,
  type HostFileStatePort,
  type HostDirectoryGrant,
  type ResolvedHostFileReadTarget,
  type PayloadRef,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import { scanMachineSecrets } from "./machine-secret-exclusion.js";
import { normalizeRelativePath } from "./file-operation-service.js";

export class HostFileReadService {
  readonly #state: HostFileStatePort;
  readonly #platform: HostFilePlatformPort;
  readonly #disclosure: HostFileDisclosurePort;
  readonly #clock: ClockPort;
  readonly #hostId: string;

  constructor(input: {
    readonly state: HostFileStatePort;
    readonly platform: HostFilePlatformPort;
    readonly disclosure: HostFileDisclosurePort;
    readonly clock: ClockPort;
    readonly hostId: string;
  }) {
    this.#state = input.state;
    this.#platform = input.platform;
    this.#disclosure = input.disclosure;
    this.#clock = input.clock;
    this.#hostId = input.hostId;
  }

  /** Run on the selected host. grantId and maximumBytes come from product policy. */
  async resolveTarget(input: {
    readonly hostId: string;
    readonly grantId: string;
    readonly path: string;
    readonly maximumBytes: number;
  }): Promise<ResolvedHostFileReadTarget> {
    if (input.hostId !== this.#hostId || !this.#hostId.trim()) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "File target host does not match this host",
      );
    }
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Host file read limit is invalid",
      );
    }
    const grant = await this.#state.readGrant(input.grantId);
    this.#assertReadableGrant(grant, input.grantId);
    // Do not normalize away traversal, expand ~, or consult another host's filesystem.
    const root = grant.displayPath.replace(/\/+$/, "") || "/";
    if (
      !grant.displayPath.startsWith("/") ||
      !input.path ||
      input.path.includes("\\") ||
      Array.from(input.path).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      input.path.startsWith("~") ||
      input.path.startsWith("@")
    ) {
      throw new Error(HOST_FILE_ERROR_CODES.PATH_UNSAFE);
    }
    const prefix = root === "/" ? "/" : `${root}/`;
    if (input.path.startsWith("/") && !input.path.startsWith(prefix)) {
      throw new Error(HOST_FILE_ERROR_CODES.PATH_ESCAPE_BLOCKED);
    }
    let relativePath: string;
    try {
      relativePath = normalizeRelativePath(
        input.path.startsWith("/") ? input.path.slice(prefix.length) : input.path,
      );
    } catch {
      throw new Error(HOST_FILE_ERROR_CODES.PATH_UNSAFE);
    }
    const identity = await this.#platform.inspect(grant, relativePath);
    if (!identity) throw new Error(HOST_FILE_ERROR_CODES.TARGET_MISSING);
    if ((identity.mode & 0o170000) !== 0o100000)
      throw new Error(HOST_FILE_ERROR_CODES.TARGET_NOT_REGULAR);
    if (
      !Number.isSafeInteger(identity.sizeBytes) ||
      identity.sizeBytes < 0 ||
      identity.sizeBytes > input.maximumBytes
    ) {
      throw new Error(HOST_FILE_ERROR_CODES.READ_LIMIT_EXCEEDED);
    }
    // Inspection may yield to a revocation, expiry or grant replacement.
    const current = await this.#state.readGrant(input.grantId);
    this.#assertReadableGrant(current, input.grantId);
    if (
      current.revision !== grant.revision ||
      current.canonicalRootId !== grant.canonicalRootId ||
      current.displayPath !== grant.displayPath ||
      current.authorizationRef !== grant.authorizationRef
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Directory grant changed during file target resolution",
      );
    }
    return Object.freeze({
      hostId: this.#hostId,
      grantId: grant.id,
      grantRevision: grant.revision,
      authorizationRef: grant.authorizationRef,
      canonicalRootId: grant.canonicalRootId,
      requestedPath: input.path,
      relativePath,
      identity: Object.freeze({ ...identity }),
      maximumBytes: input.maximumBytes,
      observedAt: this.#clock.now(),
    });
  }

  #assertReadableGrant(
    grant: HostDirectoryGrant | undefined,
    expectedId: string,
  ): asserts grant is HostDirectoryGrant {
    if (
      !grant ||
      grant.id !== expectedId ||
      !Number.isSafeInteger(grant.revision) ||
      grant.revision < 1 ||
      grant.hostId !== this.#hostId ||
      grant.revokedAt !== null ||
      !grant.operations.includes("read") ||
      grant.pathPolicy !== "same_filesystem_no_links" ||
      grant.mountPolicy !== "fixed_device" ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      !Number.isFinite(Date.parse(this.#clock.now())) ||
      Date.parse(grant.expiresAt) <= Date.parse(this.#clock.now())
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Directory grant is not readable on this host",
      );
    }
  }

  async readProtected(input: {
    readonly grantId: string;
    readonly relativePath: string;
    readonly destination: "model" | "worker" | "external_approved";
    readonly maximumBytes: number;
  }): Promise<PayloadRef> {
    const grant = await this.#state.readGrant(input.grantId);
    if (
      !grant ||
      grant.hostId !== this.#hostId ||
      grant.revokedAt ||
      grant.expiresAt <= this.#clock.now() ||
      !grant.operations.includes("read") ||
      grant.disclosure === "none" ||
      (input.destination === "external_approved" && grant.disclosure !== "external_approved") ||
      (input.destination === "worker" &&
        !["worker", "external_approved"].includes(grant.disclosure))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Host file read is outside the approved directory and disclosure scope",
        { grantId: input.grantId },
      );
    }
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Host file read limit is invalid",
      );
    const bytes = await this.#platform.read(grant, input.relativePath, input.maximumBytes);
    const findings = scanMachineSecrets(new TextDecoder().decode(bytes));
    if (findings.length > 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Host file contains machine-secret material and cannot cross this disclosure boundary",
        { ruleIds: findings.map(({ ruleId }) => ruleId).join(",") },
      );
    return this.#disclosure.protect({
      grantId: grant.id,
      relativePath: input.relativePath,
      destination: input.destination,
      dataClassification: grant.dataClassification,
      bytes,
    });
  }
}
