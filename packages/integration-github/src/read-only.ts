import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  AttentionCandidate,
  AttentionDecision,
  AttentionPort,
  AttentionStatePort,
  DataClassification,
  GitHubCoverageGapRecord,
  GitHubIntegrationStatePort,
  GitHubRepositoryMonitor,
  ModelDescriptor,
} from "@himawari-agent/application";
import type { AgentId, JobId, OwnerId } from "@himawari-agent/domain";
import { createCoverageGapId } from "@himawari-agent/domain";
import type { PayloadRef } from "@himawari-agent/application";

export const GITHUB_READ_ONLY_OPERATIONS = Object.freeze([
  "repository.metadata",
  "repository.default_branch",
  "pull_request.summary",
  "release.published",
  "workflow.failure",
] as const);

export const GITHUB_FORBIDDEN_OPERATIONS = Object.freeze([
  "git.push",
  "pull_request.comment",
  "pull_request.merge",
  "workflow.dispatch",
  "deployment.create",
  "credential.read",
] as const);

export interface GitHubReadOnlyCapabilityDescriptor {
  readonly capability: "github.read_only";
  readonly canRead: true;
  readonly canPush: false;
  readonly canComment: false;
  readonly canMerge: false;
  readonly canDispatchWorkflow: false;
  readonly canCreateDeployment: false;
  readonly canAccessGitCredential: false;
  readonly operations: readonly string[];
}

export const GITHUB_READ_ONLY_CAPABILITY: GitHubReadOnlyCapabilityDescriptor = Object.freeze({
  capability: "github.read_only",
  canRead: true,
  canPush: false,
  canComment: false,
  canMerge: false,
  canDispatchWorkflow: false,
  canCreateDeployment: false,
  canAccessGitCredential: false,
  operations: GITHUB_READ_ONLY_OPERATIONS,
});

export class GitHubCapabilityError extends Error {
  readonly code: "GITHUB_WRITE_CAPABILITY_DENIED" | "GITHUB_READ_OPERATION_DENIED";

  constructor(code: GitHubCapabilityError["code"], message: string) {
    super(message);
    this.name = "GitHubCapabilityError";
    this.code = code;
  }
}

export class GitHubReadOnlyWorker {
  private readonly readPort: {
    read(input: {
      readonly monitor: GitHubRepositoryMonitor;
      readonly operation: string;
      readonly requestRef: PayloadRef;
      readonly authorizationRef: string;
    }): Promise<{ readonly resultRef: PayloadRef; readonly providerRequestId: string }>;
  };

  constructor(input: {
    readonly readPort: GitHubReadOnlyWorker["readPort"];
    readonly capability?: GitHubReadOnlyCapabilityDescriptor;
  }) {
    this.readPort = input.readPort;
    this.capability = input.capability ?? GITHUB_READ_ONLY_CAPABILITY;
  }

  private readonly capability: GitHubReadOnlyCapabilityDescriptor;

  async read(input: {
    readonly monitor: GitHubRepositoryMonitor;
    readonly operation: string;
    readonly requestRef: PayloadRef;
    readonly authorizationRef: string;
  }): Promise<{ readonly resultRef: PayloadRef; readonly providerRequestId: string }> {
    if (!this.capability.operations.includes(input.operation)) {
      throw new GitHubCapabilityError(
        "GITHUB_READ_OPERATION_DENIED",
        `GitHub operation ${input.operation} is not in the read-only capability`,
      );
    }
    return this.readPort.read(input);
  }
}

export interface ProtectedMirrorRecord {
  readonly monitorId: JobId;
  readonly repositoryRef: string;
  readonly contentDigest: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentType: string;
}

/** Bounded, content-addressed ciphertext cache. It never invokes git or stores tokens. */
export class GitHubMirrorStore {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(input: { readonly root: string; readonly maxBytes?: number }) {
    this.root = path.resolve(input.root);
    this.maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError("GitHub mirror maxBytes must be positive");
    }
  }

  async put(input: {
    readonly monitorId: JobId;
    readonly repositoryRef: string;
    readonly ciphertext: Uint8Array;
    readonly contentType: string;
  }): Promise<ProtectedMirrorRecord> {
    if (input.ciphertext.byteLength > this.maxBytes) {
      throw new RangeError(`GitHub mirror entry exceeds ${this.maxBytes} bytes`);
    }
    assertPathPart(input.monitorId, "monitorId");
    const digest = createHash("sha256").update(input.ciphertext).digest("hex");
    const directory = path.join(this.root, input.monitorId);
    const file = path.join(directory, `${digest}.ciphertext`);
    await ensureDirectory(directory, this.root);
    await ensureNoSymlink(directory, this.root);
    try {
      const existing = await readFile(file);
      if (!Buffer.from(existing).equals(Buffer.from(input.ciphertext))) {
        throw new Error("GitHub mirror digest collision");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(file, input.ciphertext, { flag: "wx", mode: 0o600 });
    }
    const relativePath = path.relative(this.root, file);
    return Object.freeze({
      monitorId: input.monitorId,
      repositoryRef: input.repositoryRef,
      contentDigest: `sha256:${digest}`,
      relativePath,
      byteLength: input.ciphertext.byteLength,
      contentType: input.contentType,
    });
  }

  async get(relativePath: string): Promise<Uint8Array | undefined> {
    const file = safeChildPath(this.root, relativePath);
    try {
      await ensureNoSymlink(file, this.root);
      return new Uint8Array(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async revokeMonitor(monitorId: JobId): Promise<void> {
    assertPathPart(monitorId, "monitorId");
    const directory = path.join(this.root, monitorId);
    await ensureNoSymlink(directory, this.root);
    await rm(directory, { recursive: true, force: true });
  }

  async byteCount(monitorId: JobId): Promise<number> {
    assertPathPart(monitorId, "monitorId");
    const directory = path.join(this.root, monitorId);
    try {
      await ensureNoSymlink(directory, this.root);
      const entries = await stat(directory);
      return entries.isDirectory() ? entries.size : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}

export class GitHubCoverageGapTracker {
  private readonly state: GitHubIntegrationStatePort;
  private readonly now: () => string;

  constructor(input: { readonly state: GitHubIntegrationStatePort; readonly now: () => string }) {
    this.state = input.state;
    this.now = input.now;
  }

  async markOffline(input: {
    readonly monitor: GitHubRepositoryMonitor;
    readonly reasonCode: string;
  }): Promise<GitHubCoverageGapRecord> {
    const startedAt = this.now();
    const id = createCoverageGapId(
      `github-gap-${createHash("sha256")
        .update(`${input.monitor.id}:${startedAt}:${input.reasonCode}`)
        .digest("hex")
        .slice(0, 40)}`,
    );
    return this.state.saveCoverageGap({
      id,
      monitorId: input.monitor.id,
      ownerId: input.monitor.ownerId,
      agentId: input.monitor.agentId,
      status: "open",
      reasonCode: input.reasonCode,
      startedAt,
      endedAt: null,
    });
  }

  async markOnline(monitorId: JobId): Promise<GitHubCoverageGapRecord | undefined> {
    const open = (await this.state.listCoverageGaps(monitorId)).find(
      (gap) => gap.status === "open",
    );
    if (!open) return undefined;
    return this.state.saveCoverageGap({ ...open, status: "closed", endedAt: this.now() });
  }
}

export interface GitHubEventRelevancePort {
  evaluate(input: {
    readonly eventName: string;
    readonly action: string | null;
    readonly payloadRef: PayloadRef;
    readonly modelContextRefs: readonly PayloadRef[];
  }): Promise<{ readonly urgency: number; readonly confidence: number }>;
}

export interface GitHubBudgetBlockSink {
  record(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly eventRef: string;
    readonly reasonCode: "BUDGET_BLOCKED";
    readonly occurredAt: string;
  }): Promise<void>;
}

/** Sends every admitted event through model relevance and then the shared Attention state. */
export class GitHubAttentionIngestionService {
  private readonly relevance: GitHubEventRelevancePort;
  private readonly attention: AttentionPort;
  private readonly state: AttentionStatePort;
  private readonly blocked: GitHubBudgetBlockSink;
  private readonly now: () => string;

  constructor(input: {
    readonly relevance: GitHubEventRelevancePort;
    readonly attention: AttentionPort;
    readonly state: AttentionStatePort;
    readonly blocked: GitHubBudgetBlockSink;
    readonly now: () => string;
  }) {
    this.relevance = input.relevance;
    this.attention = input.attention;
    this.state = input.state;
    this.blocked = input.blocked;
    this.now = input.now;
  }

  async process(input: {
    readonly candidate: Omit<AttentionCandidate, "urgency" | "confidence">;
    readonly eventName: string;
    readonly action: string | null;
    readonly modelContextRefs: readonly PayloadRef[];
    readonly expectedPolicyRevision: number;
    readonly candidateFingerprint: string;
    readonly budgetAllowed: boolean;
  }): Promise<{
    readonly status: "inbox" | "budget_blocked" | "silent";
    readonly decision?: AttentionDecision;
  }> {
    const score = await this.relevance.evaluate({
      eventName: input.eventName,
      action: input.action,
      payloadRef: input.candidate.resultRef,
      modelContextRefs: input.modelContextRefs,
    });
    const candidate: AttentionCandidate = Object.freeze({
      ...input.candidate,
      urgency: score.urgency,
      confidence: score.confidence,
    });
    const decision = await this.attention.evaluate(candidate);
    if (!input.budgetAllowed) {
      await this.blocked.record({
        ownerId: candidate.ownerId,
        agentId: candidate.agentId,
        eventRef: candidate.resultRef,
        reasonCode: "BUDGET_BLOCKED",
        occurredAt: this.now(),
      });
      return { status: "budget_blocked", decision };
    }
    if (decision.level === "SILENT") return { status: "silent", decision };
    const delivery = {
      id: `delivery:github:${candidate.id}`,
      candidateId: candidate.id,
      ownerId: candidate.ownerId,
      agentId: candidate.agentId,
      runId: candidate.runId,
      resultRef: candidate.resultRef,
      dataClassification: candidate.dataClassification,
      level: decision.level,
      status: "pending" as const,
      assignedClientId: null,
      attempts: 0,
      acknowledgementRef: null,
      lastErrorCode: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.state.commitDecision({
      ownerId: candidate.ownerId,
      agentId: candidate.agentId,
      expectedRevision: input.expectedPolicyRevision,
      record: {
        candidateId: candidate.id,
        candidateFingerprint: input.candidateFingerprint,
        ownerId: candidate.ownerId,
        agentId: candidate.agentId,
        runId: candidate.runId,
        duplicateKey: candidate.duplicateKey,
        decision,
        deliveryRequestId: delivery.id,
        decidedAt: this.now(),
      },
      delivery,
    });
    return { status: "inbox", decision };
  }
}

export interface GitHubDisclosurePreview {
  readonly primary: {
    readonly provider: string;
    readonly model: string;
    readonly version: string;
  } | null;
  readonly repositoryScope: readonly string[];
  readonly disclosedClasses: readonly DataClassification[];
  readonly excluded: readonly ["machine_secrets"];
  readonly confirmationText: string;
}

export function createGitHubDisclosurePreview(input: {
  readonly descriptors: readonly ModelDescriptor[];
  readonly repositoryScope: readonly string[];
  readonly disclosedClasses: readonly DataClassification[];
}): GitHubDisclosurePreview {
  const primary = input.descriptors
    .filter((descriptor) => descriptor.routingClass === "primary")
    .sort((left, right) => left.priority - right.priority || left.ref.localeCompare(right.ref))[0];
  return Object.freeze({
    primary: primary
      ? Object.freeze({
          provider: primary.provider,
          model: primary.model,
          version: primary.version,
        })
      : null,
    repositoryScope: Object.freeze([...input.repositoryScope]),
    disclosedClasses: Object.freeze([...input.disclosedClasses]),
    excluded: ["machine_secrets"] as const,
    confirmationText:
      "确认后仅向所选 GitHub 仓库披露列出的数据分类；机器秘密、App 私钥、安装令牌和 Git 凭据永不披露。",
  });
}

function assertPathPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new RangeError(`${field} is not a safe path component`);
  }
}

function safeChildPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new RangeError("Mirror path must be relative");
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new RangeError("Mirror path escapes its root");
  }
  return candidate;
}

async function ensureDirectory(directory: string, root: string): Promise<void> {
  const safe = safeChildPath(root, path.relative(root, directory));
  await mkdir(safe, { recursive: true, mode: 0o700 });
}

async function ensureNoSymlink(target: string, root: string): Promise<void> {
  const safe = safeChildPath(root, path.relative(root, target));
  let current = safe;
  while (current !== root) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error("GitHub mirror refuses symlinked paths");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}
