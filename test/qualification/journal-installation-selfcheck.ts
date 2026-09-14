import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import {
  type CapabilityInvocationAuthority,
  type GovernedCapabilityExecutionHandle,
  recoverSandboxExecutionsAtStartup,
  type SandboxExecutionJournalPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  initializeProductIdentity,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";

/** Fixed installation diagnostic in an exclusively created, separate database.
 * Synthetic initial rows are not user approvals, model output or host qualification.
 * Every admission, start CAS and recovery below uses the production SQLite ports. */
export async function qualifySandboxJournal(evidenceRoot: string) {
  const root = await mkdtemp(path.join(evidenceRoot, "journal-"));
  const databasePath = path.join(root, "product.sqlite");
  const ownerId = createOwnerId("qualification-owner");
  const agentId = createAgentId("qualification-agent");
  const deploymentId = createDeploymentId("qualification-deployment");
  const runId = createRunId("qualification-run");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 300000).toISOString();
  const digest = createHash("sha256").update("installation-journal-self-check").digest("hex");
  const authority: CapabilityInvocationAuthority = {
    product: { deploymentId, authorityEpoch: 1, fencingToken: 1 },
    lease: { leaseId: createAuthorityLeaseId("qualification-lease"), fencingToken: 1 },
    agentServiceInstanceId: "qualification-agent-service",
    agentServiceBootId: "qualification-agent-boot",
    workerInstanceId: "qualification-worker",
    workerBootId: "qualification-worker-boot",
  };
  const db = openQualifiedDatabase(databasePath);
  try {
    applyMigrations(db, await loadBundledMigrations());
    initializeProductIdentity(db, { ownerId, agentId, deploymentId, now });
    db.prepare(
      "INSERT INTO authority_leases (id,owner_id,agent_id,deployment_id,holder_id,authority_epoch,fencing_token,acquired_at,expires_at) VALUES (?,?,?,?,?,1,1,?,?)",
    ).run(
      authority.lease.leaseId,
      ownerId,
      agentId,
      deploymentId,
      "qualification-holder",
      now,
      expires,
    );
    db.prepare(
      "INSERT INTO threads (id,owner_id,agent_id,revision,status,created_at,updated_at) VALUES ('qualification-thread',?,?,0,'open',?,?)",
    ).run(ownerId, agentId, now, now);
    db.prepare(
      "INSERT INTO payloads (ref,owner_id,agent_id,classification,storage_kind,ciphertext,content_digest,encryption_algorithm,key_ref,lifecycle_state,created_at,content_type) VALUES ('qualification-input',?,?,'public','sqlite_blob',X'00',?,NULL,NULL,'active',?,'application/octet-stream')",
    ).run(ownerId, agentId, `sha256:${digest}`, now);
    db.prepare(
      "INSERT INTO triggers (id,owner_id,agent_id,thread_id,idempotency_key,source_type,source_id,payload_ref,source_proof_ref,occurred_at) VALUES ('qualification-trigger',?,?,'qualification-thread','qualification-trigger','external_event','installation-self-check','qualification-input','qualification-admin',?)",
    ).run(ownerId, agentId, now);
    db.prepare(
      "INSERT INTO runs (id,owner_id,agent_id,thread_id,session_id,trigger_id,revision,status,created_at,updated_at) VALUES (?,?,?,'qualification-thread','qualification-session','qualification-trigger',0,'running',?,?)",
    ).run(runId, ownerId, agentId, now, now);
    db.prepare(
      "INSERT INTO run_execution_leases (owner_id,agent_id,run_id,revision,authority_lease_id,deployment_id,authority_epoch,fencing_token,consumer_id,execution_lease_id,claimed_at,initial_expires_at,expires_at) VALUES (?,?,?,1,?,?,1,1,'qualification-consumer','qualification-execution-lease',?,?,?)",
    ).run(ownerId, agentId, runId, authority.lease.leaseId, deploymentId, now, expires, expires);
  } finally {
    db.close();
  }
  let repository = await SqliteProductStateRepository.open({ stateRoot: root, databasePath });
  try {
    const capabilities = repository.capabilityStore(ownerId, agentId);
    await capabilities.create({
      ref: "qualification-capability",
      revision: 1,
      lifecycle: "active",
      declaration: {
        ref: "qualification-capability",
        displayName: "安装时持久化自检",
        version: "1.0.0",
        source: { type: "builtin", locator: "installation:journal-self-check" },
        integrity: `sha256:${digest}`,
        operations: ["read"],
        permissionRefs: [],
        isolation: "worker",
      },
      pendingDeclaration: null,
      permissionExpansion: false,
      runtimeQualification: null,
      pendingUpdateAssessment: null,
      rollbackDeclaration: null,
      rollbackQualification: null,
      lastVersionTransition: null,
      approvalRefs: [],
      discoveredAt: now,
      updatedAt: now,
    });
    const handle: GovernedCapabilityExecutionHandle = {
      handleVersion: "capability-handle.v2",
      ref: "qualification-handle",
      revision: 1,
      ownerId,
      agentId,
      runId,
      authorityFence: 1,
      capabilityRef: "qualification-capability",
      capabilityVersion: "1.0.0",
      authorization: { type: "policy", ref: "installation-fixed-self-check" },
      authorizationRef: "installation-fixed-self-check",
      operations: ["read"],
      operation: "read",
      inputRefs: ["qualification-input"],
      delegatedContextRefs: [],
      secretRefs: [],
      maxDataClassification: "public",
      maxUses: 2,
      uses: 0,
      maxTotalCostMicros: 0,
      spentCostMicros: 0,
      idempotencyKeys: [],
      issuedAt: now,
      expiresAt: expires,
      revokedAt: null,
      workerEndedAt: null,
    };
    await capabilities.createExecutionHandle(handle);
    const resourceCeiling = {
      maxWallTimeMs: 10000,
      maxCpuTimeMs: 1000,
      maxMemoryBytes: 268435456,
      maxOutputBytes: 4096,
      maxProgressEvents: 10,
    };
    const invocation = {
      receiptRef: "qualification-receipt",
      handleRef: "qualification-handle",
      invocationId: "qualification-invocation",
      requestScope: {
        ...authority.product,
        ownerId,
        agentId,
        runId,
        workerRunId: "qualification-worker-run",
      },
      capabilityRef: "qualification-capability",
      capabilityVersion: "1.0.0",
      authorizationRef: "installation-fixed-self-check",
      idempotencyKey: "qualification-invocation",
      operation: "read",
      inputRef: "qualification-input",
      delegatedContextRefs: [],
      secretRefs: [],
      dataClassification: "public" as const,
      resourceCeiling,
      requestedAt: now,
      deadlineAt: expires,
      authority,
      consumedAt: now,
    };
    const identity = {
      jobId: "qualification-job",
      attemptId: "qualification-attempt",
      receiptRef: invocation.receiptRef,
      invocationId: invocation.invocationId,
      ownerId,
      agentId,
      runId,
      threadId: "qualification-thread",
      hostId: "qualification-host",
      toolCallId: "qualification-tool",
    };
    const plan = sandboxExecutionPlanCandidateV2Schema.parse({
      schemaVersion: "sandbox-execution.v2",
      identity,
      handleRef: invocation.handleRef,
      inputRef: invocation.inputRef,
      operation: "read",
      capabilityRef: invocation.capabilityRef,
      capabilityVersion: "1.0.0",
      authorizationRef: invocation.authorizationRef,
      modelRef: "installation-self-check-no-model",
      requestedAt: now,
      originalDeadlineAt: expires,
      effectiveDeadlineAt: expires,
      resourceCeiling,
      executionLease: {
        executionLeaseId: "qualification-execution-lease",
        expectedLeaseRevision: 1,
        authorityLeaseId: authority.lease.leaseId,
        authorityFencingToken: 1,
        ...authority.product,
        consumerId: "qualification-consumer",
      },
      binding: {
        scopeRef: "qualification-scope",
        scopeDigest: digest,
        profileRef: "qualification-profile",
        runtimeDigest: digest,
        runnerDigest: digest,
        qualificationRef: "not-issued-component-check",
        requiredGuarantees: ["durable_start_admission"],
      },
      mode: "foreground",
      environmentId: "qualification-environment",
      backendRef: "srt",
      operationContract: { ref: "fixed-read", version: "1", kind: "fixed_read" },
    });
    const environment = {
      schemaVersion: "sandbox-execution.v2",
      kind: "local",
      environmentId: plan.environmentId,
      resourceRef: null,
      creator: identity,
      mode: plan.mode,
      backendRef: plan.backendRef,
      authorizationRef: plan.authorizationRef,
      scopeDigest: digest,
      policyDigest: digest,
      deadlineAt: expires,
      supervisor: {
        supervisorId: "qualification-supervisor",
        bootId: "qualification-boot",
        epoch: 1,
      },
      workspaceConflictRefs: ["qualification-workspace"],
      privateDirectoryRef: "qualification-private",
      privateDirectoryOwnerRef: "qualification-host",
    };
    const facts = sandboxExecutionFactsSchema.parse({
      schemaVersion: "sandbox-execution.v2",
      environment,
      result: null,
      effect: { kind: "unknown", reasonCode: "self-check-pending" },
      resource: {
        schemaVersion: "sandbox-execution.v2",
        environmentId: plan.environmentId,
        creator: identity,
        policyDigest: digest,
        scopeDigest: digest,
        sequence: 1,
        occurredAt: now,
        supervisor: environment.supervisor,
        resourceRef: null,
        status: { kind: "foreground" },
        metrics: null,
        supervision: "initializing",
        cleanup: "pending",
      },
    });
    const metadata = await stat(root);
    const admission: Parameters<SandboxExecutionJournalPort["admit"]>[0] = {
      invocation,
      plan,
      facts,
      workspaces: [
        {
          ref: "qualification-workspace",
          hostId: identity.hostId,
          canonicalRootId: "qualification-root",
          access: "write",
          lineage: [{ device: String(metadata.dev), inode: String(metadata.ino) }],
        },
      ],
    };
    let journal = repository.sandboxExecutionJournal(ownerId, agentId);
    assert.equal((await journal.admit(admission)).applied, true);
    const start = { identity, expectedSequence: 1, policyDigest: digest, authority, now };
    const concurrent = await Promise.all([journal.start(start), journal.start(start)]);
    assert.equal(concurrent.filter((x) => x.applied).length, 1);
    await repository.close();
    repository = await SqliteProductStateRepository.open({ stateRoot: root, databasePath });
    journal = repository.sandboxExecutionJournal(ownerId, agentId);
    assert.equal((await journal.start(start)).applied, false);
    const recovered = await recoverSandboxExecutionsAtStartup({
      journal,
      authority: () => authority,
      now: () => new Date().toISOString(),
    });
    assert.equal(recovered.quarantined, 1);
    const record = await journal.read(identity);
    assert.equal(record?.facts.resource.supervision, "lost");
    assert.equal(record?.facts.resource.cleanup, "unknown");
    assert.equal((await journal.start(start)).applied, false);
    const replacementIdentity = {
      ...identity,
      jobId: "qualification-conflict",
      attemptId: "qualification-conflict",
      receiptRef: "qualification-conflict",
      invocationId: "qualification-conflict",
    };
    const replacementEnvironment = {
      ...environment,
      creator: replacementIdentity,
      environmentId: "qualification-conflict",
    };
    await assert.rejects(
      journal.admit({
        ...admission,
        invocation: {
          ...invocation,
          receiptRef: replacementIdentity.receiptRef,
          invocationId: replacementIdentity.invocationId,
          idempotencyKey: "qualification-conflict",
        },
        plan: {
          ...plan,
          identity: replacementIdentity,
          environmentId: replacementEnvironment.environmentId,
        },
        facts: sandboxExecutionFactsSchema.parse({
          ...facts,
          environment: replacementEnvironment,
          resource: {
            ...facts.resource,
            creator: replacementIdentity,
            environmentId: replacementEnvironment.environmentId,
          },
        }),
      }),
    );
    return {
      scope: "isolated production SQLite port self-check",
      databasePath,
      concurrentStarts: 1,
      restartDoesNotRelaunch: true,
      unknownRemainsQuarantined: true,
      conflictingWorkspaceRejected: true,
      syntheticSetup: true,
      modelCalls: 0,
    };
  } finally {
    await repository.close();
  }
}
