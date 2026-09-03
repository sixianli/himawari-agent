import type { AgentId, OwnerId } from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Event,
  type GatewayV2Query,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type GatewayCommandResult,
  type GatewayV2CommandExecution,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type GovernanceMutationReceipt,
  type GovernanceMutationReceiptStorePort,
  type HostDirectoryProjectionRecord,
  type HostFileStatePort,
  type HostWorkspaceGatewayPayloadPort,
  type HostWorkspaceProjectionPort,
  type HostWorkspaceProjectionRecord,
  type WorkspaceStatePort,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import type { CommitGateService } from "./commit-gate-service.js";
import type { FileOperationService } from "./file-operation-service.js";
import type { HostFileReadService } from "./host-file-read-service.js";
import { threadCommandFingerprint } from "./thread-command-service.js";
import type { WorkspaceService } from "./workspace-service.js";

type HostCommand = Extract<
  GatewayV2Command,
  {
    readonly type:
      | "host.file.prepare"
      | "host.file.execute"
      | "workspace.stage"
      | "workspace.commit";
  }
>;
type HostQuery = Extract<
  GatewayV2Query,
  { readonly type: "host.directory.detail" | "workspace.detail" | "workspace.list" }
>;

const COMMANDS = new Set<GatewayV2Command["type"]>([
  "host.file.prepare",
  "host.file.execute",
  "workspace.stage",
  "workspace.commit",
]);
const QUERIES = new Set<GatewayV2Query["type"]>([
  "host.directory.detail",
  "workspace.detail",
  "workspace.list",
]);

interface HostWorkspaceControlDependencies {
  readonly delegate: GatewayV2ControlPlanePort;
  readonly files: FileOperationService;
  readonly reads: HostFileReadService;
  readonly workspaces: WorkspaceService;
  readonly commits: CommitGateService;
  readonly hostState: HostFileStatePort;
  readonly workspaceState: WorkspaceStatePort;
  readonly projections: HostWorkspaceProjectionPort;
  readonly payloads: HostWorkspaceGatewayPayloadPort;
  readonly receipts: GovernanceMutationReceiptStorePort;
  readonly clock: ClockPort;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

interface HostWorkspaceReadDependencies {
  readonly delegate: GatewayV2ReadModelPort;
  readonly hostState: HostFileStatePort;
  readonly workspaceState: WorkspaceStatePort;
  readonly projections: HostWorkspaceProjectionPort;
  readonly clock: ClockPort;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

function parseSnapshot(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
  if (parsed.kind !== "snapshot")
    throw new TypeError("Host workspace projection is not a snapshot");
  return parsed;
}

export class HostWorkspaceGatewayV2ControlPlane implements GatewayV2ControlPlanePort {
  readonly #dependencies: HostWorkspaceControlDependencies;

  constructor(dependencies: HostWorkspaceControlDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(input: GatewayV2CommandExecution): Promise<GatewayCommandResult> {
    if (!COMMANDS.has(input.command.type)) return this.#dependencies.delegate.execute(input);
    const command = input.command as HostCommand;
    this.#assertOwner(input.authentication, command);
    const attempt = await this.#begin(command);
    if (attempt.completed) return attempt.completed;
    const resultRef = await this.#mutate(input.authentication, command, attempt.recovering);
    const completed = await this.#dependencies.receipts.complete(
      {
        ...attempt.receipt,
        revision: attempt.receipt.revision + 1,
        phase: "completed",
        resultRef,
        committedAt: this.#dependencies.clock.now(),
      },
      attempt.receipt.revision,
    );
    return Object.freeze({
      resultRef: completed.resultRef as string,
      replayed: attempt.recovering,
    });
  }

  async #mutate(
    authentication: GatewayAuthenticationContext,
    command: HostCommand,
    recovering: boolean,
  ): Promise<string> {
    if (command.type === "host.file.prepare") return this.#prepareFile(command);
    if (command.type === "host.file.execute")
      return this.#executeFile(authentication, command, recovering);
    if (command.type === "workspace.stage") return this.#stageWorkspace(command);
    return this.#commitWorkspace(authentication, command);
  }

  async #prepareFile(
    command: Extract<HostCommand, { type: "host.file.prepare" }>,
  ): Promise<string> {
    const grant = await this.#dependencies.hostState.readGrant(command.payload.grantId);
    if (!grant || grant.revision !== command.payload.expectedGrantRevision)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Directory Grant revision changed");
    const relativePath = await this.#dependencies.payloads.readText(
      command.payload.relativePathRef,
    );
    let resultRef: string;
    if (command.payload.operation === "read") {
      if (grant.disclosure === "none")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Directory Grant forbids disclosure",
        );
      resultRef = await this.#dependencies.reads.readProtected({
        grantId: grant.id,
        relativePath,
        destination:
          grant.disclosure === "external_approved" ? "external_approved" : grant.disclosure,
        maximumBytes: 16 * 1024 * 1024,
      });
    } else if (command.payload.operation === "create" || command.payload.operation === "update") {
      const candidateRef = command.payload.candidatePayloadRef;
      if (!candidateRef)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Candidate payload missing",
        );
      const operation = await this.#dependencies.files.prepareWrite({
        operationId: command.idempotencyKey,
        grantId: grant.id,
        operation: command.payload.operation,
        relativePath,
        candidatePayloadRef: candidateRef,
        candidateBytes: await this.#dependencies.payloads.readBytes(candidateRef),
        redactedDiffRef: command.payload.redactedDiffRef,
        expiresAt: command.payload.expiresAt,
      });
      resultRef = operation.id;
    } else if (command.payload.operation === "move") {
      if (!command.payload.destinationPathRef)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Move destination missing",
        );
      const operation = await this.#dependencies.files.prepareMove({
        operationId: command.idempotencyKey,
        grantId: grant.id,
        sourceRelativePath: relativePath,
        destinationRelativePath: await this.#dependencies.payloads.readText(
          command.payload.destinationPathRef,
        ),
        expiresAt: command.payload.expiresAt,
      });
      resultRef = operation.id;
    } else if (command.payload.operation === "trash") {
      resultRef = (
        await this.#dependencies.files.prepareTrash({
          operationId: command.idempotencyKey,
          grantId: grant.id,
          relativePath,
          expiresAt: command.payload.expiresAt,
        })
      ).id;
    } else if (command.payload.operation === "restore") {
      resultRef = (
        await this.#dependencies.files.prepareRestore({
          operationId: command.idempotencyKey,
          trashId: relativePath,
          expiresAt: command.payload.expiresAt,
        })
      ).id;
    } else {
      if (!command.payload.irreversibleScopeRef)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Irreversible scope missing",
        );
      resultRef = (
        await this.#dependencies.files.preparePermanentDeletion({
          planId: command.idempotencyKey,
          grantId: grant.id,
          relativePath,
          irreversibleScope: await this.#dependencies.payloads.readText(
            command.payload.irreversibleScopeRef,
          ),
          expiresAt: command.payload.expiresAt,
        })
      ).id;
    }
    if (command.payload.operation !== "read") await this.#recordPrepared(command, resultRef);
    return resultRef;
  }

  async #executeFile(
    authentication: GatewayAuthenticationContext,
    command: Extract<HostCommand, { type: "host.file.execute" }>,
    recovering: boolean,
  ): Promise<string> {
    if (command.payload.operation === "read")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Read has no execute phase",
      );
    if (command.payload.operation === "permanent_delete") {
      const plan = await this.#dependencies.hostState.readDeletionPlan(
        command.payload.operationPlanRef,
      );
      if (
        !plan ||
        (plan.revision !== command.payload.expectedRevision &&
          !(recovering && plan.revision > command.payload.expectedRevision))
      )
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Deletion plan revision changed");
      this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
      const result = await this.#dependencies.files.executePermanentDeletion({
        planId: plan.id,
        expectedHash: command.payload.canonicalHash,
        recentAuthenticationRef: authentication.authenticationRef,
      });
      return `permanent-deletion:${result.id}:${result.revision}`;
    }
    const operation = await this.#dependencies.hostState.readPrepared(
      command.payload.operationPlanRef,
    );
    if (
      !operation ||
      (operation.revision !== command.payload.expectedRevision &&
        !(recovering && operation.revision > command.payload.expectedRevision)) ||
      operation.operation !== command.payload.operation
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "File operation revision changed");
    if (operation.operation === "create" || operation.operation === "update") {
      if (!operation.candidatePayloadRef)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Candidate payload missing",
        );
      const result = await this.#dependencies.files.executeWrite({
        operationId: operation.id,
        expectedHash: command.payload.canonicalHash,
        candidateBytes: await this.#dependencies.payloads.readBytes(operation.candidatePayloadRef),
      });
      return `file-operation:${result.id}:${result.revision}`;
    }
    if (operation.operation === "move") {
      const result = await this.#dependencies.files.executeMove({
        operationId: operation.id,
        expectedHash: command.payload.canonicalHash,
      });
      return `file-operation:${result.id}:${result.revision}`;
    }
    if (operation.operation === "trash") {
      const result = await this.#dependencies.files.executeTrash({
        operationId: operation.id,
        expectedHash: command.payload.canonicalHash,
      });
      await this.#recordTrash(operation.grantId, result.record.id);
      return `host-trash:${result.record.id}`;
    }
    const result = await this.#dependencies.files.executeRestore({
      operationId: operation.id,
      expectedHash: command.payload.canonicalHash,
    });
    return `host-restore:${result.record.id}`;
  }

  async #stageWorkspace(command: Extract<HostCommand, { type: "workspace.stage" }>) {
    const snapshot = await this.#dependencies.workspaceState.readSnapshot(
      command.payload.workspaceSnapshotId,
    );
    if (
      !snapshot ||
      snapshot.taskChangeSetRevision !== command.payload.expectedTaskChangeSetRevision
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Workspace snapshot revision changed",
      );
    const message = await this.#dependencies.payloads.readText(command.payload.commitMessageRef);
    const currentProjection = await this.#dependencies.projections.readWorkspace(
      snapshot.workspaceId,
    );
    const currentPreview = currentProjection?.commitPreviewRef
      ? await this.#dependencies.workspaceState.readCommitPreview(
          currentProjection.commitPreviewRef,
        )
      : undefined;
    if (
      currentPreview &&
      currentPreview.taskChangeSetRevision === snapshot.taskChangeSetRevision &&
      currentPreview.message === message &&
      currentPreview.validationResultRefs.join("\0") ===
        command.payload.validationResultRefs.join("\0")
    ) {
      return currentPreview.id;
    }
    const paths = await Promise.all(
      command.payload.taskPathRefs.map((ref) => this.#dependencies.payloads.readText(ref)),
    );
    const staged = await this.#dependencies.workspaces.stageTaskChanges({
      snapshotId: snapshot.id,
      paths,
    });
    const preview = await this.#dependencies.commits.prepare({
      workspaceId: snapshot.workspaceId,
      stagingRef: staged.stagingRef,
      taskChangeSetRevision: snapshot.taskChangeSetRevision,
      validationResultRefs: command.payload.validationResultRefs,
      message,
      expiresAt: command.payload.expiresAt,
    });
    await this.#recordWorkspace(snapshot.workspaceId, snapshot.id, preview.id);
    return preview.id;
  }

  async #commitWorkspace(
    authentication: GatewayAuthenticationContext,
    command: Extract<HostCommand, { type: "workspace.commit" }>,
  ) {
    const preview = await this.#dependencies.workspaceState.readCommitPreview(
      command.payload.commitPreviewId,
    );
    if (
      !preview ||
      preview.revision !== command.payload.expectedRevision ||
      preview.canonicalHash !== command.payload.semanticSnapshotHash
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Commit preview revision changed");
    this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
    const result = await this.#dependencies.commits.commit({
      handle: {
        ref: `commit-handle:${command.idempotencyKey}`,
        previewId: preview.id,
        previewHash: preview.canonicalHash,
        operationId: command.idempotencyKey,
        recentAuthenticationRef: authentication.authenticationRef,
        authorityFence: command.authority.fencingToken,
        expiresAt: preview.expiresAt,
        maxUses: 1,
      },
      authorityFence: command.authority.fencingToken,
    });
    return this.#dependencies.payloads.protectJson(result);
  }

  #assertOwner(authentication: GatewayAuthenticationContext, command: HostCommand) {
    if (
      command.scope.ownerId !== this.#dependencies.ownerId ||
      command.scope.agentId !== this.#dependencies.agentId ||
      authentication.ownerId !== this.#dependencies.ownerId ||
      authentication.subjectId !== command.actor.actorId ||
      command.actor.actorType !== "owner"
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Host commands require Owner scope",
      );
  }

  #assertRecentAuthentication(authentication: GatewayAuthenticationContext, ref: string | null) {
    if (!ref || ref !== authentication.authenticationRef)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Recent authentication does not match",
      );
  }

  async #recordPrepared(
    command: Extract<HostCommand, { type: "host.file.prepare" }>,
    resultRef: string,
  ) {
    const current = await this.#dependencies.projections.readDirectory(command.payload.grantId);
    const record: HostDirectoryProjectionRecord = Object.freeze({
      grantId: command.payload.grantId,
      ownerId: this.#dependencies.ownerId,
      agentId: this.#dependencies.agentId,
      preparedOperationRefs: Object.freeze([
        ...new Set([...(current?.preparedOperationRefs ?? []), resultRef]),
      ]),
      trashRecordRefs: current?.trashRecordRefs ?? Object.freeze([]),
      recoveryRefs: current?.recoveryRefs ?? Object.freeze([]),
      revision: (current?.revision ?? 0) + 1,
    });
    await this.#dependencies.projections.saveDirectory(record, current?.revision ?? null);
  }

  async #recordTrash(grantId: string, trashRef: string) {
    const current = await this.#dependencies.projections.readDirectory(grantId);
    if (!current) return;
    await this.#dependencies.projections.saveDirectory(
      Object.freeze({
        ...current,
        revision: current.revision + 1,
        trashRecordRefs: Object.freeze([...new Set([...current.trashRecordRefs, trashRef])]),
        recoveryRefs: Object.freeze([...new Set([...current.recoveryRefs, trashRef])]),
      }),
      current.revision,
    );
  }

  async #recordWorkspace(workspaceId: string, snapshotId: string, previewId: string) {
    const current = await this.#dependencies.projections.readWorkspace(workspaceId);
    const record: HostWorkspaceProjectionRecord = Object.freeze({
      workspaceId,
      ownerId: this.#dependencies.ownerId,
      agentId: this.#dependencies.agentId,
      latestSnapshotId: snapshotId,
      directoryGrantIds: current?.directoryGrantIds ?? Object.freeze([]),
      commandProfileRefs: current?.commandProfileRefs ?? Object.freeze([]),
      commandObservationRefs: current?.commandObservationRefs ?? Object.freeze([]),
      commitPreviewRef: previewId,
      recoveryRefs: current?.recoveryRefs ?? Object.freeze([]),
      revision: (current?.revision ?? 0) + 1,
    });
    await this.#dependencies.projections.saveWorkspace(record, current?.revision ?? null);
  }

  async #begin(command: HostCommand): Promise<{
    readonly receipt: GovernanceMutationReceipt;
    readonly recovering: boolean;
    readonly completed: GatewayCommandResult | null;
  }> {
    const fingerprint = threadCommandFingerprint({
      type: command.type,
      scope: command.scope,
      payload: command.payload,
    });
    let receipt = await this.#dependencies.receipts.get(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
      command.idempotencyKey,
    );
    let recovering = receipt !== undefined;
    if (!receipt) {
      try {
        receipt = await this.#dependencies.receipts.create({
          ownerId: this.#dependencies.ownerId,
          agentId: this.#dependencies.agentId,
          idempotencyKey: command.idempotencyKey,
          revision: 1,
          commandType: command.type,
          semanticFingerprint: fingerprint,
          phase: "executing",
          resultRef: null,
          startedAt: this.#dependencies.clock.now(),
          committedAt: null,
        });
      } catch (error) {
        if (
          !(error instanceof ApplicationPortError) ||
          (error.code !== PORT_ERROR_CODES.DUPLICATE && error.code !== PORT_ERROR_CODES.CONFLICT)
        ) {
          throw error;
        }
        receipt = await this.#dependencies.receipts.get(
          this.#dependencies.ownerId,
          this.#dependencies.agentId,
          command.idempotencyKey,
        );
        recovering = true;
      }
    }
    if (!receipt)
      throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, "Host receipt unavailable");
    if (receipt.commandType !== command.type || receipt.semanticFingerprint !== fingerprint)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Host idempotency key was reused");
    return Object.freeze({
      receipt,
      recovering,
      completed:
        receipt.phase === "completed"
          ? Object.freeze({ resultRef: receipt.resultRef as string, replayed: true })
          : null,
    });
  }
}

export class HostWorkspaceGatewayV2ReadModel implements GatewayV2ReadModelPort {
  readonly #dependencies: HostWorkspaceReadDependencies;

  constructor(dependencies: HostWorkspaceReadDependencies) {
    this.#dependencies = dependencies;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query);
    const hostQuery = query as HostQuery;
    this.#assertScope(hostQuery);
    if (hostQuery.type === "workspace.list") return this.#workspaceList(hostQuery);
    if (hostQuery.type === "workspace.detail") return this.#workspaceDetail(hostQuery);
    return this.#directoryDetail(hostQuery);
  }

  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly afterCursor: string | null;
  }): AsyncIterable<GatewayV2Event> {
    return this.#dependencies.delegate.subscribe(input);
  }

  async #workspaceList(query: Extract<HostQuery, { type: "workspace.list" }>) {
    const refs = (
      await this.#dependencies.projections.listWorkspaces(
        this.#dependencies.ownerId,
        this.#dependencies.agentId,
      )
    )
      .map(({ workspaceId }) => workspaceId)
      .sort();
    const start =
      query.payload.afterCursor === null ? 0 : refs.indexOf(query.payload.afterCursor) + 1;
    if (query.payload.afterCursor !== null && start === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Workspace cursor not found");
    const items = refs.slice(start, start + query.payload.limit);
    return parseSnapshot({
      ...this.#envelope(query, "collection.snapshot"),
      payload: {
        category: "workspaces",
        itemRefs: items,
        nextCursor: start + items.length < refs.length ? (items.at(-1) ?? null) : null,
        snapshotRef: `snapshot:workspaces:${query.messageId}`,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  async #workspaceDetail(query: Extract<HostQuery, { type: "workspace.detail" }>) {
    const projection = await this.#dependencies.projections.readWorkspace(
      query.payload.workspaceId,
    );
    if (
      !projection ||
      projection.ownerId !== this.#dependencies.ownerId ||
      projection.agentId !== this.#dependencies.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Workspace not found");
    const snapshot = await this.#dependencies.workspaceState.readSnapshot(
      projection.latestSnapshotId,
    );
    if (!snapshot)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Workspace snapshot not found");
    return parseSnapshot({
      ...this.#envelope(query, "workspace.snapshot"),
      payload: {
        workspaceId: snapshot.workspaceId,
        snapshotId: snapshot.id,
        revision: snapshot.revision,
        hostId: snapshot.hostId,
        repositoryKind: snapshot.repositoryKind,
        branch: snapshot.branch,
        head: snapshot.head,
        upstreamObservation: snapshot.upstreamObservation,
        detached: snapshot.detached,
        unborn: snapshot.unborn,
        taskChangeSetRevision: snapshot.taskChangeSetRevision,
        ownerPathRefs: snapshot.files
          .filter(({ owner }) => owner === "owner")
          .map(({ path }) => path),
        taskPathRefs: snapshot.files
          .filter(({ owner }) => owner === "task")
          .map(({ path }) => path),
        concurrentPathRefs: snapshot.files
          .filter(({ owner }) => owner === "concurrent_unowned")
          .map(({ path }) => path),
        commandProfileRefs: projection.commandProfileRefs,
        commandObservationRefs: projection.commandObservationRefs,
        commitPreviewRef: projection.commitPreviewRef,
        recoveryRefs: projection.recoveryRefs,
        directoryGrantRefs: projection.directoryGrantIds,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  async #directoryDetail(query: Extract<HostQuery, { type: "host.directory.detail" }>) {
    const grant = await this.#dependencies.hostState.readGrant(query.payload.grantId);
    const projection = await this.#dependencies.projections.readDirectory(query.payload.grantId);
    if (
      !grant ||
      !projection ||
      projection.ownerId !== this.#dependencies.ownerId ||
      projection.agentId !== this.#dependencies.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Directory Grant not found");
    return parseSnapshot({
      ...this.#envelope(query, "host.directory.snapshot"),
      payload: {
        grantId: grant.id,
        revision: grant.revision,
        hostId: grant.hostId,
        displayPath: grant.displayPath,
        operations: grant.operations,
        pathPolicy: grant.pathPolicy,
        mountPolicy: grant.mountPolicy,
        disclosure: grant.disclosure,
        expiresAt: grant.expiresAt,
        revokedAt: grant.revokedAt,
        preparedOperationRefs: projection.preparedOperationRefs,
        trashRecordRefs: projection.trashRecordRefs,
        recoveryRefs: projection.recoveryRefs,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  #envelope(query: HostQuery, type: GatewayV2Snapshot["type"]) {
    return {
      schemaVersion: query.schemaVersion,
      kind: "snapshot" as const,
      type,
      messageId: `snapshot:${query.messageId}`.slice(0, 128),
      correlationId: query.correlationId,
      causationId: query.messageId,
      dataClassification: "private" as const,
      risk: "low" as const,
      authorizationRef: query.authorizationRef,
      scope: query.scope,
      authority: query.authority,
      actor: { actorType: "system" as const, actorId: "host-workspace-gateway" },
    };
  }

  #assertScope(query: HostQuery) {
    if (
      query.scope.ownerId !== this.#dependencies.ownerId ||
      query.scope.agentId !== this.#dependencies.agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Host query is outside scope",
      );
  }
}
