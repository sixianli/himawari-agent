import {
  ApplicationPortError,
  candidatePathsWithinScopes,
  type HostDirectoryGrant,
  type HostFileDigestPort,
  type HostFilePlatformPort,
  type HostFileStatePort,
  normalizeCandidateScopes,
  normalizeWorkspaceCopyPath,
  type PayloadRef,
  PORT_ERROR_CODES,
  type PreparedFileOperation,
  type WorkspaceCopyBaseline,
  type WorkspaceCopyPort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { FileOperationService } from "./file-operation-service.js";
import { scanMachineSecrets } from "./machine-secret-exclusion.js";

interface WorkspaceCopyDependencies {
  readonly hostId: string;
  readonly state: Pick<HostFileStatePort, "readGrant">;
  readonly platform: HostFilePlatformPort;
  readonly copies: WorkspaceCopyPort;
  readonly files: FileOperationService;
  readonly digest: HostFileDigestPort;
  readonly readPayload: (ref: PayloadRef) => Promise<Uint8Array>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

/** Explicit optional copies reuse the candidate manager and original per-file saving service.
 * This service never executes a command or applies a directory tree. Prepared operations
 * continue through the production save_copy Run/Worker path and durable recovery. */
export class WorkspaceCopyService {
  readonly #dependencies: WorkspaceCopyDependencies;
  constructor(dependencies: WorkspaceCopyDependencies) {
    this.#dependencies = dependencies;
  }

  async create(input: {
    readonly grantId: string;
    readonly expectedGrantRevision: number;
    readonly inputPaths: readonly string[];
    readonly allowedPaths: readonly string[];
    readonly spaceBudgetBytes: number;
  }): Promise<string> {
    const paths = [...new Set(input.inputPaths.map(normalizeWorkspaceCopyPath))].sort();
    const allowedPaths = normalizeCandidateScopes(input.allowedPaths);
    if (
      !paths.length ||
      paths.length > 1000 ||
      !Number.isSafeInteger(input.spaceBudgetBytes) ||
      input.spaceBudgetBytes < 1 ||
      input.spaceBudgetBytes > 64 * 1024 * 1024 ||
      !candidatePathsWithinScopes(allowedPaths, paths)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Copy requires explicit bounded input and save paths",
      );
    const grant = await this.#grant(input.grantId, input.expectedGrantRevision);
    const baselineFiles: WorkspaceCopyBaseline["files"][number][] = [];
    const files: { path: string; bytes: Uint8Array }[] = [];
    let remaining = input.spaceBudgetBytes;
    for (const relative of paths) {
      const identity = await this.#dependencies.platform.inspect(grant, relative);
      const bytes = identity
        ? await this.#dependencies.platform.read(grant, relative, Math.max(1, remaining), identity)
        : null;
      if (bytes) {
        remaining -= bytes.byteLength;
        if (remaining < 0) throw new Error("CANDIDATE_SPACE_BUDGET_EXCEEDED");
        if (scanMachineSecrets(new TextDecoder().decode(bytes)).length)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "Copy input contains protected machine secrets",
          );
        files.push({ path: relative, bytes });
      }
      baselineFiles.push({
        path: relative,
        identity: identity ?? null,
        digest: bytes ? this.#dependencies.digest.digest(bytes) : null,
      });
    }
    const baseline: WorkspaceCopyBaseline = {
      grantId: grant.id,
      grantRevision: grant.revision,
      canonicalRootId: grant.canonicalRootId,
      files: baselineFiles,
    };
    await this.#assertBaseline(baseline);
    return this.#dependencies.copies.createFromSnapshot({
      candidateId: this.#dependencies.ids.next("workspace-copy"),
      baseline,
      files,
      allowedPaths,
      spaceBudgetBytes: input.spaceBudgetBytes,
    });
  }

  async prepare(input: {
    readonly workspaceRef: string;
    readonly paths: readonly string[];
    readonly expiresAt: string;
  }) {
    const paths = [...new Set(input.paths.map(normalizeWorkspaceCopyPath))].sort();
    if (!paths.length)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "No copy changes selected",
      );
    const copy = await this.#dependencies.copies.readCopyChanges(input.workspaceRef);
    await this.#assertBaseline(copy.baseline);
    const selected = paths.map((relative) => {
      const change = copy.changes.find((entry) => entry.path === relative);
      if (!change)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Selected file is not a task change",
        );
      return change;
    });
    // A unique unchanged-content pair preserves move authority and file identity.
    // Ambiguous or edited pairs remain explicit create/remove operations.
    const moves = new Map<string, string>();
    const additions = selected.filter(
      (change) =>
        change.contentRef !== null &&
        copy.baseline.files.some((file) => file.path === change.path && file.identity === null),
    );
    const removals = selected.filter((change) => change.contentRef === null);
    for (const removed of removals) {
      const digest = copy.baseline.files.find((file) => file.path === removed.path)?.digest;
      const targets = additions.filter((change) => change.contentDigest === digest);
      const sources = removals.filter(
        (change) =>
          copy.baseline.files.find((file) => file.path === change.path)?.digest === digest,
      );
      if (digest && targets.length === 1 && sources.length === 1 && targets[0])
        moves.set(removed.path, targets[0].path);
    }
    const destinations = new Set(moves.values());
    const copyAuthority = {
      grantRevision: copy.baseline.grantRevision,
      canonicalRootId: copy.baseline.canonicalRootId,
    };
    const operations: PreparedFileOperation[] = [];
    for (const change of selected) {
      if (destinations.has(change.path)) continue;
      const destination = moves.get(change.path);
      const before = copy.baseline.files.find((entry) => entry.path === change.path);
      if (!before) throw new Error("CANDIDATE_TARGET_NOT_IN_BASELINE");
      const expectedBefore = { identity: before.identity, digest: before.digest };
      const copyDependencies = copy.baseline.files
        .filter((file) => file.path !== change.path && file.path !== destination)
        .map((file) => {
          const prior = operations.find(
            (operation) =>
              operation.relativePath === file.path ||
              operation.destinationRelativePath === file.path,
          );
          return { ...file, ...(prior ? { priorOperationRef: prior.id } : {}) };
        });
      if (destination)
        operations.push(
          await this.#dependencies.files.prepareMove({
            grantId: copy.baseline.grantId,
            sourceRelativePath: change.path,
            destinationRelativePath: destination,
            expectedBefore,
            copyDependencies,
            copyAuthority,
            expiresAt: input.expiresAt,
          }),
        );
      else if (change.contentRef === null)
        operations.push(
          await this.#dependencies.files.prepareTrash({
            grantId: copy.baseline.grantId,
            relativePath: change.path,
            expectedBefore,
            copyDependencies,
            copyAuthority,
            expiresAt: input.expiresAt,
          }),
        );
      else {
        const bytes = await this.#dependencies.readPayload(change.contentRef);
        if (this.#dependencies.digest.digest(bytes) !== change.contentDigest)
          throw new Error("CANDIDATE_CONTENT_CHANGED");
        operations.push(
          await this.#dependencies.files.prepareWrite({
            grantId: copy.baseline.grantId,
            operation: before.identity ? "update" : "create",
            relativePath: change.path,
            candidateBytes: bytes,
            candidatePayloadRef: change.contentRef,
            expectedBefore,
            copyDependencies,
            copyAuthority,
            redactedDiffRef: null,
            expiresAt: input.expiresAt,
          }),
        );
      }
    }
    await this.#assertBaseline(copy.baseline);
    return Object.freeze(operations);
  }

  async #grant(id: string, revision: number): Promise<HostDirectoryGrant> {
    const grant = await this.#dependencies.state.readGrant(id);
    if (
      !grant ||
      grant.hostId !== this.#dependencies.hostId ||
      grant.revision !== revision ||
      grant.revokedAt !== null ||
      grant.expiresAt <= this.#dependencies.clock.now() ||
      !grant.operations.includes("read") ||
      !["worker", "model", "external_approved"].includes(grant.disclosure)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Current directory grant does not permit a working copy",
      );
    return grant;
  }

  async #assertBaseline(baseline: WorkspaceCopyBaseline) {
    const grant = await this.#grant(baseline.grantId, baseline.grantRevision);
    if (grant.canonicalRootId !== baseline.canonicalRootId)
      throw new Error("CANDIDATE_ROOT_CHANGED");
    for (const file of baseline.files) {
      const current = await this.#dependencies.platform.inspect(grant, file.path);
      const bytes = current
        ? await this.#dependencies.platform.read(grant, file.path, 64 * 1024 * 1024, current)
        : null;
      if (
        JSON.stringify(current ?? null) !== JSON.stringify(file.identity) ||
        (bytes ? this.#dependencies.digest.digest(bytes) : null) !== file.digest
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Working copy input changed; regenerate before saving",
        );
    }
    await this.#grant(baseline.grantId, baseline.grantRevision);
  }
}
