import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { AutonomyScope, JsonObject, PayloadRef } from "./common.js";
import type { CommandProfile } from "./workspaces.js";

export interface ImprovementValidation {
  readonly profileId: string;
  readonly commandObservationRef: string;
  readonly outcome: "passed" | "failed";
}

export interface ImprovementComparison {
  readonly inputSetDigest: string;
  readonly baseResultRef: PayloadRef;
  readonly candidateResultRef: PayloadRef;
  readonly qualityDeltaPermille: number;
  readonly performanceDeltaPermille: number;
  readonly resourceDeltaPermille: number;
  readonly regressionRefs: readonly string[];
}

export interface ImprovementCandidate {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly generationRunId: RunId;
  readonly traceRef: string;
  readonly observableProblemRef: PayloadRef;
  readonly goalRef: PayloadRef;
  readonly invariantRefs: readonly string[];
  readonly baseRevision: string;
  readonly baseDigest: string;
  readonly allowedPaths: readonly string[];
  readonly workspaceRef: string;
  readonly cleanup:
    | { readonly status: "not_requested" }
    | {
        readonly status: "pending";
        readonly requestedAt: string;
        readonly lastErrorCode: string | null;
      }
    | { readonly status: "completed"; readonly requestedAt: string; readonly completedAt: string };
  readonly securityResponse:
    | { readonly status: "not_requested" }
    | {
        readonly status: "quarantine_pending" | "attention_pending" | "completed";
        readonly reasonCode: string;
        readonly requestedAt: string;
        readonly attentionIdempotencyKey: string;
      };
  readonly patchRef: PayloadRef | null;
  readonly patchDigest: string | null;
  readonly reasonRef: PayloadRef;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly protectedRootFacts: readonly string[];
  readonly validation: readonly ImprovementValidation[];
  readonly comparison: ImprovementComparison | null;
  readonly artifactRef: PayloadRef | null;
  readonly artifactDigest: string | null;
  readonly status:
    | "proposed"
    | "patching"
    | "validating"
    | "rejected_by_validation"
    | "security_failure"
    | "review_required"
    | "rejected"
    | "revision_requested"
    | "expired";
  readonly reviewRequired: true;
  readonly expiresAt: string;
  readonly spaceBudgetBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Candidate scopes use repository-relative path segments, never host mount paths. */
export function normalizeCandidatePath(value: string): string {
  const normalized = value.replace(/\/$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[A-Za-z]:/.test(normalized)
  )
    throw new TypeError("CANDIDATE_PATH_SCOPE_INVALID");
  return normalized;
}

export function normalizeCandidateScopes(values: readonly string[]): readonly string[] {
  if (values.length === 0) throw new TypeError("CANDIDATE_PATH_SCOPE_EMPTY");
  return Object.freeze([...new Set(values.map(normalizeCandidatePath))].sort());
}

export function candidatePathsWithinScopes(
  paths: readonly string[],
  scopes: readonly string[],
): boolean {
  const allowed = normalizeCandidateScopes(scopes);
  return paths.every((value) => {
    const relative = normalizeCandidatePath(value);
    return allowed.some((scope) => relative === scope || relative.startsWith(`${scope}/`));
  });
}

export interface ImprovementStatePort {
  read(scope: AutonomyScope, candidateId: string): Promise<ImprovementCandidate | undefined>;
  list(ownerId: OwnerId, agentId: AgentId): Promise<readonly ImprovementCandidate[]>;
  create(candidate: ImprovementCandidate): Promise<ImprovementCandidate>;
  save(candidate: ImprovementCandidate, expectedRevision: number): Promise<ImprovementCandidate>;
}

export interface ImprovementSecurityAttentionPort {
  /** Persistently deduplicate the same key across retries, including uncertain delivery outcomes. */
  raise(input: {
    readonly idempotencyKey: string;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly candidateId: string;
    readonly traceRef: string;
    readonly reasonCode: string;
    readonly risk: "critical";
  }): Promise<void>;
}

export function candidateSecurityAttentionKey(
  candidate: Pick<ImprovementCandidate, "ownerId" | "agentId" | "id">,
): string {
  return JSON.stringify([
    "improvement.security",
    candidate.ownerId,
    candidate.agentId,
    candidate.id,
  ]);
}

export interface CandidateWorkspacePort {
  qualify(): Promise<{
    readonly qualified: boolean;
    readonly platform: "macos" | "linux";
    readonly runtimeIdentity: string;
    readonly evidenceRefs: readonly string[];
    readonly reasonCodes: readonly string[];
  }>;
  create(input: {
    readonly candidateId: string;
    readonly baseRevision: string;
    readonly baseDigest: string;
    readonly allowedPaths: readonly string[];
    readonly spaceBudgetBytes: number;
  }): Promise<string>;
  patch(input: {
    readonly workspaceRef: string;
    readonly patchRef: PayloadRef;
    readonly expectedBaseDigest: string;
    readonly allowedPaths: readonly string[];
  }): Promise<{ readonly patchDigest: string; readonly changedPaths: readonly string[] }>;
  validate(input: {
    readonly workspaceRef: string;
    readonly profiles: readonly CommandProfile[];
  }): Promise<readonly ImprovementValidation[]>;
  compare(input: {
    readonly workspaceRef: string;
    readonly inputSetDigest: string;
    readonly comparisonDefinition: JsonObject;
  }): Promise<ImprovementComparison>;
  packageArtifact(input: {
    readonly workspaceRef: string;
    readonly expiresAt: string;
    readonly spaceBudgetBytes: number;
  }): Promise<{ readonly artifactRef: PayloadRef; readonly artifactDigest: string }>;
  quarantine(workspaceRef: string, reasonCode: string): Promise<void>;
  dispose(workspaceRef: string): Promise<void>;
}
