import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  type AutonomyScope,
  type CandidateWorkspacePort,
  type CommandProfile,
  candidatePathsWithinScopes,
  candidateSecurityAttentionKey,
  type HostFileDigestPort,
  type ImprovementCandidate,
  type ImprovementSecurityAttentionPort,
  type ImprovementStatePort,
  type JsonObject,
  normalizeCandidateScopes,
  type PayloadRef,
  PORT_ERROR_CODES,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const PROTECTED_ROOT_PATTERNS = Object.freeze([
  /(^|\/)(identity|authorization|secrets?|audit|trust-root)(\/|$)/i,
  /(^|\/)(model-disclosure|upgrade|capabilities?)(\/|$)/i,
]);

const SELF_ACTIVATION_ACTIONS = Object.freeze([
  "apply",
  "commit",
  "push",
  "merge",
  "deploy",
  "restart",
  "install",
  "activate",
  "switch-version",
]);

export class ImprovementCandidateService {
  readonly #dependencies: {
    readonly state: ImprovementStatePort;
    readonly workspace: CandidateWorkspacePort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
    readonly attention: ImprovementSecurityAttentionPort;
  };

  constructor(dependencies: {
    readonly state: ImprovementStatePort;
    readonly workspace: CandidateWorkspacePort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
    readonly attention: ImprovementSecurityAttentionPort;
  }) {
    this.#dependencies = dependencies;
  }

  async propose(input: {
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
    readonly reasonRef: PayloadRef;
    readonly risk: "low" | "medium" | "high" | "critical";
    readonly expiresAt: string;
    readonly spaceBudgetBytes: number;
  }): Promise<ImprovementCandidate> {
    const allowedPaths = normalizeCandidateScopes(input.allowedPaths);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(input.baseDigest) ||
      input.allowedPaths.length === 0 ||
      input.invariantRefs.length === 0 ||
      input.expiresAt <= this.#dependencies.clock.now() ||
      input.spaceBudgetBytes < 1 ||
      !Number.isSafeInteger(input.spaceBudgetBytes)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Improvement proposal does not freeze a safe base, scope, expiry, and space budget",
      );
    const qualification = await this.#dependencies.workspace.qualify();
    if (!qualification.qualified)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Candidate workspace isolation is not qualified",
        { reasonCodes: qualification.reasonCodes.join(",") },
      );
    const id = this.#dependencies.ids.next("improvement");
    const workspaceRef = await this.#dependencies.workspace.create({
      candidateId: id,
      baseRevision: input.baseRevision,
      baseDigest: input.baseDigest,
      allowedPaths,
      spaceBudgetBytes: input.spaceBudgetBytes,
    });
    const protectedRootFacts = allowedPaths
      .filter((path) => PROTECTED_ROOT_PATTERNS.some((pattern) => pattern.test(path)))
      .map((path) => `protected-path:${path}`);
    const now = this.#dependencies.clock.now();
    return this.#dependencies.state.create(
      Object.freeze({
        id,
        revision: 1,
        ownerId: input.ownerId,
        agentId: input.agentId,
        generationRunId: input.generationRunId,
        traceRef: input.traceRef,
        observableProblemRef: input.observableProblemRef,
        goalRef: input.goalRef,
        invariantRefs: Object.freeze([...input.invariantRefs]),
        baseRevision: input.baseRevision,
        baseDigest: input.baseDigest,
        allowedPaths,
        workspaceRef,
        cleanup: { status: "not_requested" as const },
        securityResponse: { status: "not_requested" as const },
        patchRef: null,
        patchDigest: null,
        reasonRef: input.reasonRef,
        risk: protectedRootFacts.length > 0 ? "critical" : input.risk,
        protectedRootFacts: Object.freeze(protectedRootFacts),
        validation: Object.freeze([]),
        comparison: null,
        artifactRef: null,
        artifactDigest: null,
        status: "proposed",
        reviewRequired: true,
        expiresAt: input.expiresAt,
        spaceBudgetBytes: input.spaceBudgetBytes,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async patchValidateCompare(input: {
    readonly scope: AutonomyScope;
    readonly candidateId: string;
    readonly patchRef: PayloadRef;
    readonly profiles: readonly CommandProfile[];
    readonly inputSetDigest: string;
    readonly comparisonDefinition: JsonObject;
  }): Promise<ImprovementCandidate> {
    const candidate = await this.#required(input.scope, input.candidateId);
    if (candidate.status !== "proposed" && candidate.status !== "rejected_by_validation")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Candidate cannot be patched in its current state",
      );
    try {
      this.#assertProfiles(candidate, input.profiles);
    } catch {
      return this.#securityFailure(candidate, "CANDIDATE_VALIDATION_SCOPE_ESCALATION");
    }
    const patching = await this.#save(candidate, { status: "patching", patchRef: input.patchRef });
    try {
      const patch = await this.#dependencies.workspace.patch({
        workspaceRef: patching.workspaceRef,
        patchRef: input.patchRef,
        expectedBaseDigest: patching.baseDigest,
        allowedPaths: patching.allowedPaths,
      });
      if (!candidatePathsWithinScopes(patch.changedPaths, patching.allowedPaths))
        return this.#securityFailure(patching, "CANDIDATE_SCOPE_ESCAPE");
      const validating = await this.#save(patching, {
        status: "validating",
        patchDigest: patch.patchDigest,
      });
      const validation = await this.#dependencies.workspace.validate({
        workspaceRef: validating.workspaceRef,
        profiles: input.profiles,
      });
      if (validation.some(({ outcome }) => outcome !== "passed"))
        return this.#save(validating, {
          status: "rejected_by_validation",
          validation: Object.freeze([...validation]),
        });
      const comparison = await this.#dependencies.workspace.compare({
        workspaceRef: validating.workspaceRef,
        inputSetDigest: input.inputSetDigest,
        comparisonDefinition: input.comparisonDefinition,
      });
      if (comparison.inputSetDigest !== input.inputSetDigest)
        return this.#securityFailure(validating, "COMPARISON_INPUT_CHANGED");
      const artifact = await this.#dependencies.workspace.packageArtifact({
        workspaceRef: validating.workspaceRef,
        expiresAt: validating.expiresAt,
        spaceBudgetBytes: validating.spaceBudgetBytes,
      });
      if (!/^sha256:[a-f0-9]{64}$/.test(artifact.artifactDigest))
        return this.#securityFailure(validating, "CANDIDATE_ARTIFACT_INVALID");
      return this.#save(validating, {
        status: "review_required",
        validation: Object.freeze([...validation]),
        comparison: Object.freeze({ ...comparison }),
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.artifactDigest,
      });
    } catch (error) {
      const latest = (await this.#dependencies.state.read(patching, patching.id)) ?? patching;
      return this.#securityFailure(
        latest,
        error instanceof ApplicationPortError ? error.code : "CANDIDATE_EXECUTION_FAILED",
      );
    }
  }

  async review(input: {
    readonly scope: AutonomyScope;
    readonly expectedRevision: number;
    readonly candidateId: string;
    readonly decision: "reject" | "request_revision";
  }): Promise<ImprovementCandidate> {
    const candidate = await this.#required(input.scope, input.candidateId);
    if (candidate.revision !== input.expectedRevision || candidate.status !== "review_required")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Only the Owner can review a completed candidate",
      );
    return this.#save(candidate, {
      status: input.decision === "reject" ? "rejected" : "revision_requested",
    });
  }

  async rejectSelfActivation(
    scope: AutonomyScope,
    candidateId: string,
    requestedAction: string,
  ): Promise<never> {
    const candidate = await this.#required(scope, candidateId);
    if (SELF_ACTIVATION_ACTIONS.includes(requestedAction))
      await this.#securityFailure(candidate, `SELF_ACTIVATION_${requestedAction.toUpperCase()}`);
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "Improvement candidates cannot apply, commit, deploy, or activate themselves",
    );
  }

  async expire(ownerId: OwnerId, agentId: AgentId, now = this.#dependencies.clock.now()) {
    const candidates = await this.#dependencies.state.list(ownerId, agentId);
    const expired: ImprovementCandidate[] = [];
    for (const observation of candidates) {
      const observed = await this.#dependencies.state.read({ ownerId, agentId }, observation.id);
      if (!observed) continue;
      // Security response recovery is independent of the artifact's expiry and cleanup status.
      const candidate = await this.#resumeSecurityResponse(observed);
      if (
        candidate.cleanup?.status === "completed" ||
        (candidate.expiresAt > now && candidate.cleanup?.status !== "pending")
      )
        continue;
      const saved =
        candidate.cleanup?.status === "pending"
          ? candidate
          : await this.#save(candidate, {
              status: candidate.status === "security_failure" ? "security_failure" : "expired",
              cleanup: { status: "pending", requestedAt: now, lastErrorCode: null },
            });
      try {
        await this.#dependencies.workspace.dispose(saved.workspaceRef);
      } catch (error) {
        const latest = await this.#dependencies.state.read({ ownerId, agentId }, saved.id);
        if (latest?.cleanup.status === "pending")
          await this.#save(latest, {
            cleanup: { ...latest.cleanup, lastErrorCode: "CANDIDATE_DISPOSAL_FAILED" },
          });
        throw error;
      }
      const latest = await this.#dependencies.state.read({ ownerId, agentId }, saved.id);
      if (!latest)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          "Candidate disappeared during cleanup",
        );
      expired.push(
        latest.cleanup.status === "pending"
          ? await this.#save(latest, {
              cleanup: {
                status: "completed",
                requestedAt: latest.cleanup.requestedAt,
                completedAt: now,
              },
            })
          : latest,
      );
    }
    return Object.freeze(expired);
  }

  async #required(scope: AutonomyScope, candidateId: string): Promise<ImprovementCandidate> {
    const candidate = await this.#dependencies.state.read(scope, candidateId);
    if (!candidate)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Improvement candidate not found");
    if (candidate.expiresAt <= this.#dependencies.clock.now())
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Candidate has expired");
    return candidate;
  }

  async #securityFailure(
    candidate: ImprovementCandidate,
    reasonCode: string,
  ): Promise<ImprovementCandidate> {
    if (
      ["expired", "security_failure", "rejected", "revision_requested"].includes(candidate.status)
    )
      return this.#resumeSecurityResponse(candidate);
    const failed = await this.#save(candidate, {
      status: "security_failure",
      securityResponse: {
        status: "quarantine_pending",
        reasonCode,
        requestedAt: this.#dependencies.clock.now(),
        attentionIdempotencyKey: candidateSecurityAttentionKey(candidate),
      },
      protectedRootFacts: Object.freeze([
        ...candidate.protectedRootFacts,
        `security-failure:${reasonCode}`,
      ]),
      risk: "critical",
    });
    return this.#resumeSecurityResponse(failed);
  }

  async #resumeSecurityResponse(candidate: ImprovementCandidate): Promise<ImprovementCandidate> {
    let current = candidate;
    if (current.securityResponse.status === "quarantine_pending") {
      await this.#dependencies.workspace.quarantine(
        current.workspaceRef,
        current.securityResponse.reasonCode,
      );
      current = await this.#save(current, {
        securityResponse: { ...current.securityResponse, status: "attention_pending" },
      });
    }
    if (current.securityResponse.status === "attention_pending") {
      await this.#dependencies.attention.raise({
        idempotencyKey: current.securityResponse.attentionIdempotencyKey,
        ownerId: current.ownerId,
        agentId: current.agentId,
        candidateId: current.id,
        traceRef: current.traceRef,
        reasonCode: current.securityResponse.reasonCode,
        risk: "critical",
      });
      current = await this.#save(current, {
        securityResponse: { ...current.securityResponse, status: "completed" },
      });
    }
    return current;
  }

  async #save(
    candidate: ImprovementCandidate,
    updates: Partial<Omit<ImprovementCandidate, "id" | "revision" | "ownerId" | "agentId">>,
  ): Promise<ImprovementCandidate> {
    return this.#dependencies.state.save(
      Object.freeze({
        ...candidate,
        ...updates,
        revision: candidate.revision + 1,
        reviewRequired: true,
        updatedAt: this.#dependencies.clock.now(),
      }),
      candidate.revision,
    );
  }

  #assertProfiles(candidate: ImprovementCandidate, profiles: readonly CommandProfile[]): void {
    if (
      profiles.length === 0 ||
      profiles.some(
        (profile) =>
          profile.network !== "none" ||
          profile.environmentNames.length > 0 ||
          profile.workspaceId !== candidate.workspaceRef ||
          !profile.workdir.startsWith("/") ||
          profile.workdir !== candidate.workspaceRef ||
          profile.fileScopes.length !== 1 ||
          profile.fileScopes[0] !== candidate.workspaceRef ||
          profile.sandboxTier !== "isolated-high-risk" ||
          profile.revokedAt !== null ||
          profile.expiresAt <= this.#dependencies.clock.now(),
      )
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Candidate validation profiles require network, secrets, expired authority, or wider files",
      );
  }
}
