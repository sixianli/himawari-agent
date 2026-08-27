import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type GatewayCommandResult,
  type GatewayV2CommandExecution,
  type GatewayV2ControlPlanePort,
  type DataClassification,
  type GitHubIntegrationStatePort,
  type GitHubMonitorHistoryPolicyPort,
  type GitHubMonitorMirrorPort,
  type GitHubRepositoryMonitor,
  type SchedulerPort,
} from "@himawari-agent/application";
import type { JobId } from "@himawari-agent/domain";
import type { GatewayV2Command } from "@himawari-agent/gateway-contracts";

type GitHubMonitorStateCommand = Extract<
  GatewayV2Command,
  { readonly type: "github.monitor.set_state" }
>;

export interface GitHubMonitorControlServiceOptions {
  readonly state: GitHubIntegrationStatePort;
  readonly mirror: GitHubMonitorMirrorPort;
  readonly history: GitHubMonitorHistoryPolicyPort;
  readonly scheduler?: SchedulerPort;
  readonly primaryModelRef: string;
  readonly allowedRepositoryRefs: readonly string[];
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly now: () => string;
}

/**
 * Handles the product-owned GitHub monitor lifecycle behind Gateway v2.
 * Provider credentials and repository reads remain in the GitHub worker; this
 * service only changes the durable monitor state and invokes cleanup ports.
 */
export class GitHubMonitorControlService {
  private readonly state: GitHubIntegrationStatePort;
  private readonly mirror: GitHubMonitorMirrorPort;
  private readonly history: GitHubMonitorHistoryPolicyPort;
  private readonly scheduler: SchedulerPort | undefined;
  private readonly primaryModelRef: string;
  private readonly allowedRepositoryRefs: readonly string[];
  private readonly allowedDataClassifications: readonly string[];
  private readonly now: () => string;

  constructor(options: GitHubMonitorControlServiceOptions) {
    if (options.primaryModelRef.length === 0) {
      throw new RangeError("GitHub monitor control requires a primary model reference");
    }
    this.state = options.state;
    this.mirror = options.mirror;
    this.history = options.history;
    this.scheduler = options.scheduler;
    this.primaryModelRef = options.primaryModelRef;
    this.allowedRepositoryRefs = Object.freeze([...options.allowedRepositoryRefs]);
    this.allowedDataClassifications = Object.freeze([...options.allowedDataClassifications]);
    this.now = options.now;
  }

  async execute(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly command: GitHubMonitorStateCommand;
  }): Promise<GatewayCommandResult> {
    const { authentication, command } = input;
    this.assertOwnerCommand(authentication, command);

    const monitor = await this.state.readMonitor(command.payload.monitorId as JobId);
    if (!monitor) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `GitHub monitor ${command.payload.monitorId} not found`,
        { monitorId: command.payload.monitorId },
      );
    }
    this.assertMonitorScope(authentication, command, monitor);
    if (monitor.revision !== command.payload.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `GitHub monitor ${monitor.id} revision conflict`,
        {
          monitorId: monitor.id,
          expectedRevision: String(command.payload.expectedRevision),
          actualRevision: String(monitor.revision),
        },
      );
    }

    const installation = await this.state.readInstallation(monitor.installationRef);
    if (
      !installation ||
      installation.ownerId !== monitor.ownerId ||
      installation.agentId !== monitor.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `GitHub installation ${monitor.installationRef} is outside monitor scope`,
        { monitorId: monitor.id },
      );
    }

    this.assertTransition(command, monitor, installation.status);
    const policy = command.payload.action === "revoke" ? command.payload.historyPolicy : null;
    if (command.payload.action === "revoke" && policy === null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "GitHub monitor revocation requires an explicit history policy",
        { monitorId: monitor.id },
      );
    }
    const nextStatus =
      command.payload.action === "enable"
        ? "active"
        : command.payload.action === "pause"
          ? "paused"
          : "revoked";
    const updated: GitHubRepositoryMonitor = Object.freeze({
      ...monitor,
      revision: monitor.revision + 1,
      status: nextStatus,
    });

    // Revoke is deliberately persisted before cleanup: a cleanup failure must
    // fail closed by stopping future webhook admission and reads first.
    await this.state.saveMonitor(updated, command.payload.expectedRevision);
    await this.syncScheduledJob(updated, command.payload.action);
    if (command.payload.action === "revoke" && policy !== null) {
      await this.cleanupRevokedMonitor(updated, policy, authentication.subjectId);
    }

    return Object.freeze({
      resultRef: `github-monitor:${monitor.id}:revision-${updated.revision}`,
      replayed: false,
    });
  }

  private async syncScheduledJob(
    monitor: GitHubRepositoryMonitor,
    action: "enable" | "pause" | "revoke",
  ): Promise<void> {
    if (!this.scheduler) return;
    const job = await this.scheduler.read(monitor.id);
    if (!job) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Scheduled GitHub monitor job ${monitor.id} not found`,
        { monitorId: monitor.id },
      );
    }
    if (
      job.ownerId !== monitor.ownerId ||
      job.agentId !== monitor.agentId ||
      job.operation !== "repository.monitor" ||
      job.resourceRef !== monitor.repositoryRef
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Scheduled GitHub monitor job ${monitor.id} is outside monitor scope`,
        { monitorId: monitor.id },
      );
    }
    if (action === "revoke") {
      if (job.status !== "cancelled") await this.scheduler.cancel(job.id, job.revision);
      return;
    }
    const status = action === "enable" ? "active" : "paused";
    if (job.status === status) return;
    if (job.status === "cancelled") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Scheduled GitHub monitor job ${monitor.id} cannot leave cancelled state`,
        { monitorId: monitor.id },
      );
    }
    const { revision: _revision, ...write } = job;
    await this.scheduler.upsert({ ...write, status }, job.revision);
  }

  private assertOwnerCommand(
    authentication: GatewayAuthenticationContext,
    command: GitHubMonitorStateCommand,
  ): void {
    if (
      command.actor.actorType !== "owner" ||
      authentication.ownerId !== command.scope.ownerId ||
      authentication.subjectId !== command.actor.actorId ||
      command.authorizationRef === null
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "GitHub monitor lifecycle requires an authenticated Owner authorization",
      );
    }
  }

  private assertMonitorScope(
    authentication: GatewayAuthenticationContext,
    command: GitHubMonitorStateCommand,
    monitor: GitHubRepositoryMonitor,
  ): void {
    if (
      monitor.ownerId !== authentication.ownerId ||
      monitor.ownerId !== command.scope.ownerId ||
      monitor.agentId !== command.scope.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "GitHub monitor is outside authenticated Owner scope",
        { monitorId: monitor.id },
      );
    }
  }

  private assertTransition(
    command: GitHubMonitorStateCommand,
    monitor: GitHubRepositoryMonitor,
    installationStatus: "active" | "revoked",
  ): void {
    if (command.payload.action === "enable") {
      if (monitor.status !== "paused") {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `GitHub monitor ${monitor.id} can only be enabled from paused state`,
          { monitorId: monitor.id, status: monitor.status },
        );
      }
      if (installationStatus !== "active") {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.HANDLE_REVOKED,
          `GitHub installation ${monitor.installationRef} is revoked`,
          { monitorId: monitor.id },
        );
      }
      const disclosure = command.payload.disclosure;
      if (
        disclosure === null ||
        disclosure.primaryModelRef !== this.primaryModelRef ||
        !this.allowedRepositoryRefs.includes(monitor.repositoryRef) ||
        disclosure.repositoryRef !== monitor.repositoryRef ||
        disclosure.machineSecretsExcluded !== true ||
        disclosure.disclosedDataClassifications.some(
          (classification) => !this.allowedDataClassifications.includes(classification),
        )
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "GitHub monitor disclosure does not match the approved server configuration",
          { monitorId: monitor.id },
        );
      }
      return;
    }

    if (command.payload.action === "pause" && monitor.status !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `GitHub monitor ${monitor.id} can only be paused from active state`,
        { monitorId: monitor.id, status: monitor.status },
      );
    }
    if (command.payload.action === "revoke" && monitor.status === "revoked") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `GitHub monitor ${monitor.id} is already revoked`,
        { monitorId: monitor.id },
      );
    }
  }

  private async cleanupRevokedMonitor(
    monitor: GitHubRepositoryMonitor,
    policy: "retain" | "delete",
    requestedBy: string,
  ): Promise<void> {
    try {
      await this.mirror.revokeMonitor(monitor.id);
      await this.history.apply({ monitor, policy, requestedBy, occurredAt: this.now() });
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "GitHub monitor was revoked but cleanup requires retry",
        { monitorId: monitor.id, historyPolicy: policy },
      );
    }
  }
}

/** Decorates the existing v2 control plane without granting GitHub write APIs. */
export class GitHubMonitorGatewayV2ControlPlane implements GatewayV2ControlPlanePort {
  private readonly delegate: GatewayV2ControlPlanePort;
  private readonly monitor: GitHubMonitorControlService;

  constructor(input: {
    readonly delegate: GatewayV2ControlPlanePort;
    readonly monitor: GitHubMonitorControlService;
  }) {
    this.delegate = input.delegate;
    this.monitor = input.monitor;
  }

  execute(input: GatewayV2CommandExecution): Promise<GatewayCommandResult> {
    if (input.command.type === "github.monitor.set_state") {
      return this.monitor.execute({ authentication: input.authentication, command: input.command });
    }
    return this.delegate.execute(input);
  }
}
