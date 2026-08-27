import { createHmac } from "node:crypto";
import type {
  AttentionCandidate,
  AttentionDecision,
  AttentionDecisionCommitResult,
  AttentionPort,
  AttentionPolicyState,
  AttentionStatePort,
  GitHubCoverageGapRecord,
  GitHubInstallationRecord,
  GitHubIntegrationStatePort,
  GitHubRepositoryMonitor,
  GitHubWebhookReceiptRecord,
} from "@himawari-agent/application";
import type { BackgroundOccurrence, OccurrenceId } from "@himawari-agent/domain";
import {
  createAgentId,
  createJobId,
  createOccurrenceId,
  createOwnerId,
  createRunId,
  createSessionId,
} from "@himawari-agent/domain";
import {
  DEFAULT_GITHUB_EVENT_KEYS,
  GITHUB_FORBIDDEN_OPERATIONS,
  GITHUB_READ_ONLY_APP_PERMISSIONS,
  GITHUB_READ_ONLY_CAPABILITY,
  GitHubAppCredentialError,
  GitHubAttentionIngestionService,
  GitHubCapabilityError,
  GitHubCoverageGapTracker,
  GitHubInstallationTokenAdapter,
  GitHubMirrorStore,
  GitHubReadOnlyWorker,
  GitHubWebhookAdmissionService,
  GitHubWebhookRateLimiter,
  createGitHubDisclosurePreview,
  type GitHubAppPrivateKeySource,
  type GitHubInstallationTokenIssuer,
  type GitHubWebhookAdmissionInput,
  type ProtectedWebhookPayloadSink,
} from "../src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-github");
const AGENT_ID = createAgentId("agent-github");
const MONITOR_ID = createJobId("monitor-github");
const RUN_ID = createRunId("run-github");
const SESSION_ID = createSessionId("session-github");
const INSTALLATION_REF = "installation-github";
const PROVIDER_INSTALLATION_ID = "12345";
const REPOSITORY_REF = "98765";
const SECRET = "webhook-secret-fixture";
const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:00:01.000Z";

const installation: GitHubInstallationRecord = {
  id: INSTALLATION_REF,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  providerInstallationId: PROVIDER_INSTALLATION_ID,
  secretRef: "secret:github:webhook",
  status: "active",
  createdAt: T0,
};

const monitor: GitHubRepositoryMonitor = {
  id: MONITOR_ID,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  revision: 1,
  installationRef: INSTALLATION_REF,
  repositoryRef: REPOSITORY_REF,
  enabledEventRefs: DEFAULT_GITHUB_EVENT_KEYS,
  authorizationRef: "authorization:github-read",
  status: "active",
};

class MemoryGitHubState implements GitHubIntegrationStatePort {
  readonly installations = new Map<string, GitHubInstallationRecord>([
    [installation.id, installation],
  ]);
  readonly monitors = new Map<string, GitHubRepositoryMonitor>([[monitor.id, monitor]]);
  readonly receipts = new Map<string, GitHubWebhookReceiptRecord>();
  readonly occurrences = new Map<OccurrenceId, BackgroundOccurrence>();
  readonly gaps = new Map<string, GitHubCoverageGapRecord>();

  async readInstallation(ref: string) {
    return this.installations.get(ref);
  }
  async saveInstallation(record: GitHubInstallationRecord) {
    this.installations.set(record.id, record);
    return record;
  }
  async readMonitor(id: typeof MONITOR_ID) {
    return this.monitors.get(id);
  }
  async saveMonitor(record: GitHubRepositoryMonitor) {
    this.monitors.set(record.id, record);
    return record;
  }
  async recordReceipt(receipt: GitHubWebhookReceiptRecord) {
    const existing = this.receipts.get(receipt.providerDeliveryId);
    if (existing) return existing;
    this.receipts.set(receipt.providerDeliveryId, receipt);
    return receipt;
  }
  async findReceipt(deliveryId: string) {
    return this.receipts.get(deliveryId);
  }
  async readOccurrence(id: OccurrenceId) {
    return this.occurrences.get(id);
  }
  async admitWebhook(input: {
    receipt: GitHubWebhookReceiptRecord;
    occurrence: BackgroundOccurrence;
  }) {
    const existing = this.receipts.get(input.receipt.providerDeliveryId);
    if (existing?.occurrenceId) {
      const occurrence = this.occurrences.get(existing.occurrenceId);
      if (!occurrence) throw new Error("missing occurrence");
      return { receipt: existing, occurrence, replayed: true };
    }
    const receipt = {
      ...(existing ?? input.receipt),
      status: "normalized" as const,
      occurrenceId: input.occurrence.id,
    };
    this.receipts.set(receipt.providerDeliveryId, receipt);
    this.occurrences.set(input.occurrence.id, input.occurrence);
    return { receipt, occurrence: input.occurrence, replayed: existing !== undefined };
  }
  async saveCoverageGap(gap: GitHubCoverageGapRecord) {
    this.gaps.set(gap.id, gap);
    return gap;
  }
  async listCoverageGaps(monitorId: typeof MONITOR_ID) {
    return [...this.gaps.values()].filter((gap) => gap.monitorId === monitorId);
  }
}

function payload(action: string | undefined = undefined, extra: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      installation: { id: Number(PROVIDER_INSTALLATION_ID) },
      repository: { id: Number(REPOSITORY_REF) },
      ...(action === undefined ? {} : { action }),
      ...extra,
    }),
  );
}

function request(body: Uint8Array, overrides: Partial<GitHubWebhookAdmissionInput> = {}) {
  return {
    monitorId: MONITOR_ID,
    installationRef: INSTALLATION_REF,
    providerDeliveryId: "delivery-001",
    eventName: "push",
    contentType: "application/json",
    rawBody: body,
    rateKey: "127.0.0.1",
    signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    ...overrides,
  } satisfies GitHubWebhookAdmissionInput;
}

function occurrence(input: {
  payloadRef: string;
  providerDeliveryId: string;
  eventName: string;
  action: string | null;
}): BackgroundOccurrence {
  return {
    id: createOccurrenceId(`occurrence:${input.providerDeliveryId}`),
    jobId: MONITOR_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    stableKey: `github:${INSTALLATION_REF}:${input.providerDeliveryId}`,
    status: "queued",
    authority: {
      deploymentId: "deployment:github" as never,
      authorityEpoch: 1,
      fencingToken: 1,
    },
    category: "github",
    dataClassification: "private",
    foreground: false,
    parallelSafe: true,
    estimatedCostMicros: 100,
    reservedCostMicros: 0,
    spentCostMicros: 0,
    attemptCount: 0,
    nextRetryAt: null,
    deadlineAt: T1,
    runId: null,
    workLease: null,
    lastErrorCode: null,
  };
}

function admission(
  state: MemoryGitHubState,
  options: Partial<ConstructorParameters<typeof GitHubWebhookAdmissionService>[0]> = {},
) {
  const sink: ProtectedWebhookPayloadSink = {
    put: async () => undefined,
  };
  return new GitHubWebhookAdmissionService({
    state,
    secrets: { resolve: async () => SECRET },
    payloads: sink,
    now: () => T0,
    nowMs: () => 0,
    createOccurrence: (input) =>
      occurrence({
        payloadRef: input.payloadRef,
        providerDeliveryId: input.providerDeliveryId,
        eventName: input.eventName,
        action: input.action,
      }),
    ...options,
  });
}

describe("GitHub App credentials and webhook admission", () => {
  it("verifies raw-byte HMAC, repository scope, protected payload and one occurrence on replay", async () => {
    const state = new MemoryGitHubState();
    const service = admission(state);
    const startedAt = performance.now();
    const first = await service.admit(request(payload()));
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    const second = await service.admit(request(payload(), { providerDeliveryId: "delivery-001" }));
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("replayed");
    expect(state.receipts.size).toBe(1);
    expect(state.occurrences.size).toBe(1);
    expect(first.receipt.occurrenceId).toBe(first.occurrence.id);
  });

  it.each([
    ["bad signature", { signature: "sha256=00" }, "GITHUB_SIGNATURE_REJECTED"],
    ["wrong installation", {}, "GITHUB_INSTALLATION_REJECTED"],
    ["wrong repository", {}, "GITHUB_REPOSITORY_REJECTED"],
  ] as const)("rejects %s before admission", async (label, overrides, code) => {
    const state = new MemoryGitHubState();
    const service = admission(state);
    const body =
      label === "wrong installation"
        ? payload(undefined, { installation: { id: 999 } })
        : label === "wrong repository"
          ? payload(undefined, { repository: { id: 999 } })
          : payload();
    await expect(service.admit(request(body, overrides))).rejects.toMatchObject({ code });
    expect(state.receipts.size).toBe(0);
  });

  it("rejects unknown/disabled events, oversized bodies and rate bursts", async () => {
    const state = new MemoryGitHubState();
    const service = admission(state, {
      maxBodyBytes: 32,
      rateLimiter: new GitHubWebhookRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    await expect(service.admit(request(payload()))).rejects.toMatchObject({
      code: "GITHUB_BODY_TOO_LARGE",
    });
    const normal = admission(state, {
      rateLimiter: new GitHubWebhookRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const unknownBody = payload("created");
    await expect(normal.admit(request(unknownBody, { eventName: "issues" }))).rejects.toMatchObject(
      {
        code: "GITHUB_EVENT_REJECTED",
      },
    );
    await expect(
      normal.admit(
        request(payload(), { providerDeliveryId: "delivery-002", rateKey: "127.0.0.2" }),
      ),
    ).resolves.toMatchObject({
      outcome: "accepted",
    });
    await expect(
      normal.admit(
        request(payload(), { providerDeliveryId: "delivery-003", rateKey: "127.0.0.2" }),
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED",
    });
  });

  it("fails closed for revoked installations and accepts only configured App permissions", async () => {
    const state = new MemoryGitHubState();
    state.installations.set(INSTALLATION_REF, { ...installation, status: "revoked" });
    await expect(admission(state).admit(request(payload()))).rejects.toMatchObject({
      code: "GITHUB_CREDENTIAL_REVOKED",
    });
    expect(GITHUB_READ_ONLY_APP_PERMISSIONS.contents).toBe("read");
    expect(GITHUB_READ_ONLY_APP_PERMISSIONS.deployments).toBe("none");
    expect(GITHUB_FORBIDDEN_OPERATIONS).toContain("git.push");
  });
});

describe("GitHub token, mirror, coverage and attention boundaries", () => {
  it("refreshes short-lived installation tokens without persisting private keys", async () => {
    let now = T0;
    let calls = 0;
    const source: GitHubAppPrivateKeySource = { resolve: async () => "private-key-material" };
    const issuer: GitHubInstallationTokenIssuer = {
      issue: async () => {
        calls += 1;
        return {
          token: `token-${calls}`,
          expiresAt: calls === 1 ? "2026-08-27T00:05:00.000Z" : "2026-08-27T01:00:00.000Z",
        };
      },
    };
    const adapter = new GitHubInstallationTokenAdapter({ source, issuer, now: () => now });
    const first = await adapter.get(installation, [REPOSITORY_REF]);
    const cached = await adapter.get(installation, [REPOSITORY_REF]);
    expect(first.value).toBe("token-1");
    expect(cached.value).toBe("token-1");
    now = "2026-08-27T00:04:30.000Z";
    expect((await adapter.get(installation, [REPOSITORY_REF])).value).toBe("token-2");
    expect(adapter.cacheSize()).toBe(1);
    await expect(adapter.get(installation, [])).rejects.toBeInstanceOf(GitHubAppCredentialError);
  });

  it("keeps the mirror bounded/content-addressed and rejects write capabilities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-github-mirror-"));
    try {
      const mirror = new GitHubMirrorStore({ root, maxBytes: 64 });
      const stored = await mirror.put({
        monitorId: MONITOR_ID,
        repositoryRef: REPOSITORY_REF,
        ciphertext: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream",
      });
      expect(await mirror.get(stored.relativePath)).toEqual(new Uint8Array([1, 2, 3]));
      expect(GITHUB_READ_ONLY_CAPABILITY.canPush).toBe(false);
      await expect(
        new GitHubReadOnlyWorker({
          readPort: { read: async () => ({ resultRef: "payload:read", providerRequestId: "req" }) },
        }).read({
          monitor,
          operation: "git.push",
          requestRef: "payload:request",
          authorizationRef: monitor.authorizationRef,
        }),
      ).rejects.toBeInstanceOf(GitHubCapabilityError);
      await mirror.revokeMonitor(MONITOR_ID);
      expect(await mirror.get(stored.relativePath)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records offline coverage gaps and closes them without polling or history scans", async () => {
    const state = new MemoryGitHubState();
    const tracker = new GitHubCoverageGapTracker({ state, now: () => T0 });
    const open = await tracker.markOffline({ monitor, reasonCode: "worker_unavailable" });
    expect(open.status).toBe("open");
    const closed = await new GitHubCoverageGapTracker({ state, now: () => T1 }).markOnline(
      MONITOR_ID,
    );
    expect(closed).toMatchObject({ status: "closed", endedAt: T1 });
  });

  it("sends every accepted event through relevance and Attention, or records BUDGET_BLOCKED", async () => {
    const calls: string[] = [];
    const decision: AttentionDecision = {
      candidateId: "candidate-github",
      level: "INBOX",
      reasonCode: "relevant",
      interruptAuthorizationRef: null,
    };
    const attention: AttentionPort = {
      evaluate: async (candidate: AttentionCandidate) => {
        calls.push(candidate.resultRef);
        return decision;
      },
    };
    const committed: AttentionDecisionCommitResult[] = [];
    const attentionState: AttentionStatePort = {
      readPolicyState: async () => ({ revision: 0, decisions: [] }) satisfies AttentionPolicyState,
      commitDecision: async (input) => {
        const result = {
          state: { revision: 1, decisions: [input.record] },
          record: input.record,
          delivery: input.delivery ? { ...input.delivery, revision: 0 } : null,
        };
        committed.push(result);
        return result;
      },
      readDelivery: async () => undefined,
      claimDelivery: async () => {
        throw new Error("unused");
      },
      settleDelivery: async () => {
        throw new Error("unused");
      },
    };
    const blocked: string[] = [];
    const service = new GitHubAttentionIngestionService({
      relevance: {
        evaluate: async (input) => {
          calls.push(input.eventName);
          return { urgency: 700, confidence: 900 };
        },
      },
      attention,
      state: attentionState,
      blocked: {
        record: async ({ reasonCode }) => {
          blocked.push(reasonCode);
        },
      },
      now: () => T0,
    });
    const candidate = {
      id: "candidate-github",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      threadId: null,
      resultRef: "payload:event",
      dataClassification: "private" as const,
      duplicateKey: "github:delivery-001",
      generatedAt: T0,
      deviceState: "available" as const,
      interruptAuthorizationRef: null,
    };
    await expect(
      service.process({
        candidate,
        eventName: "push",
        action: null,
        modelContextRefs: [],
        expectedPolicyRevision: 0,
        candidateFingerprint: "sha256:fingerprint",
        budgetAllowed: true,
      }),
    ).resolves.toMatchObject({ status: "inbox" });
    await expect(
      service.process({
        candidate,
        eventName: "push",
        action: null,
        modelContextRefs: [],
        expectedPolicyRevision: 1,
        candidateFingerprint: "sha256:fingerprint-2",
        budgetAllowed: false,
      }),
    ).resolves.toMatchObject({ status: "budget_blocked" });
    expect(calls).toEqual(["push", "payload:event", "push", "payload:event"]);
    expect(committed).toHaveLength(1);
    expect(blocked).toEqual(["BUDGET_BLOCKED"]);
  });

  it("shows the primary model and repository disclosure while excluding machine secrets", () => {
    const preview = createGitHubDisclosurePreview({
      descriptors: [
        {
          ref: "primary",
          provider: "fixture",
          model: "fixture-model",
          version: "1",
          routingClass: "primary",
          priority: 1,
          disclosure: "trusted_remote",
          capabilities: ["text"],
          allowedDataClassifications: ["private"],
          secretRequirement: {
            secretRef: "secret:provider",
            secretVersion: "v1",
            purpose: "model",
          },
        },
      ],
      repositoryScope: ["owner/repository"],
      disclosedClasses: ["private"],
    });
    expect(preview.primary).toEqual({ provider: "fixture", model: "fixture-model", version: "1" });
    expect(preview.excluded).toEqual(["machine_secrets"]);
    expect(JSON.stringify(preview)).not.toContain("secret:provider");
  });
});
