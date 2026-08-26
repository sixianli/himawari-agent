import type {
  DependencyHealth,
  DeploymentHealthSnapshot,
  DeploymentId,
  HealthSnapshotId,
} from "@himawari-agent/domain";

export interface HealthObservation {
  readonly deploymentId: DeploymentId;
  readonly snapshotId: HealthSnapshotId;
  readonly live: boolean;
  readonly authorityActive: boolean;
  readonly dependencies: readonly DependencyHealth[];
  readonly observedAt: string;
}

export interface HealthStatePort {
  observe(input: HealthObservation): Promise<DeploymentHealthSnapshot>;
  current(deploymentId: DeploymentId): Promise<DeploymentHealthSnapshot | undefined>;
}
