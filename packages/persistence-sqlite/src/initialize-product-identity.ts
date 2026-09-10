import { randomUUID } from "node:crypto";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  type DeploymentAuthorityState,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";

/** Offline first installation only, while the caller holds the state-root lock.
 * No existing identity is adopted and no capability or action grant is created. */
export function initializeProductIdentity(
  database: Database.Database,
  input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly deploymentId: string;
    readonly now: string;
  },
): DeploymentAuthorityState {
  const authority: DeploymentAuthorityState = {
    id: createDeploymentId(input.deploymentId),
    ownerId: createOwnerId(input.ownerId),
    agentId: createAgentId(input.agentId),
    revision: 1,
    status: "active",
    authorityEpoch: 1,
    fencingToken: 1,
    transferId: null,
  };
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("INITIALIZATION_TIME_INVALID");
  database
    .transaction(() => {
      for (const table of ["owners", "agents", "deployments"] as const) {
        if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
          throw new Error("INITIALIZATION_IDENTITY_EXISTS");
      }
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(authority.ownerId);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(authority.agentId, authority.ownerId);
      database
        .prepare(
          "INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token, transfer_id) VALUES (?, ?, ?, 1, 'active', 1, 1, NULL)",
        )
        .run(authority.id, authority.ownerId, authority.agentId);
      database
        .prepare(
          "INSERT INTO audit_records (id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at) VALUES (?, ?, ?, 'installation.initialized', ?, 'completed', NULL, ?)",
        )
        .run(
          `audit-init-${randomUUID()}`,
          authority.ownerId,
          authority.agentId,
          authority.id,
          input.now,
        );
    })
    .immediate();
  return Object.freeze(authority);
}
