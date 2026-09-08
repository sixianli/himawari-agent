import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type SandboxExecutionPlanCandidate,
  type SandboxScope,
  sandboxExecutionPlanCandidateSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";

export interface SandboxScopeServiceOptions {
  /** Owner/Agent scoped store; the protector independently authenticates that scope. */
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: Pick<PayloadProtectorPort, "unprotect">;
  readonly now: () => string;
  /** Trusted SHA-256 over exact bytes, returning lowercase hex. */
  readonly digest: (bytes: Uint8Array) => string;
}

/** Resolves protected scope integrity and call identity only. It does not grant
 * filesystem/network access or certify a host. Current grants, host identity,
 * qualification and TOCTOU checks remain mandatory at admission and start. */
export class SandboxScopeService {
  readonly #options: SandboxScopeServiceOptions;
  constructor(options: SandboxScopeServiceOptions) {
    this.#options = options;
  }

  async read(input: SandboxExecutionPlanCandidate): Promise<SandboxScope> {
    // Parse before awaiting, retaining an immutable snapshot of caller input.
    const plan = sandboxExecutionPlanCandidateSchema.parse(input);
    try {
      const payload = await this.#options.payloads.get(plan.binding.scopeRef);
      if (
        !payload ||
        payload.ref !== plan.binding.scopeRef ||
        payload.contentType !== "application/json" ||
        payload.dataClassification === "public" ||
        payload.ciphertext.byteLength > 131072
      )
        throw new Error("invalid payload");
      const bytes = await this.#options.protector.unprotect({
        ownerId: createOwnerId(plan.identity.ownerId),
        agentId: createAgentId(plan.identity.agentId),
        payload,
      });
      if (bytes.byteLength === 0 || bytes.byteLength > 65536) throw new Error("invalid size");
      const digest = this.#options.digest(bytes);
      if (
        !/^[a-f0-9]{64}$/.test(digest) ||
        digest !== plan.binding.scopeDigest ||
        payload.contentDigest !== `sha256:${digest}`
      )
        throw new Error("digest mismatch");
      const scope = sandboxScopeSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      for (const key of [
        "ownerId",
        "agentId",
        "threadId",
        "runId",
        "toolCallId",
        "hostId",
      ] as const)
        if (scope[key] !== plan.identity[key]) throw new Error("identity mismatch");
      for (const key of [
        "handleRef",
        "inputRef",
        "operation",
        "authorizationRef",
        "modelRef",
      ] as const)
        if (scope[key] !== plan[key]) throw new Error("plan mismatch");
      const now = this.#options.now();
      if (
        !Number.isFinite(Date.parse(now)) ||
        new Date(now).toISOString() !== now ||
        scope.profileRef !== plan.binding.profileRef ||
        scope.parentToolCallId === scope.toolCallId ||
        now >= scope.expiresAt ||
        now >= plan.effectiveDeadlineAt ||
        plan.effectiveDeadlineAt > scope.expiresAt
      )
        throw new Error("invalid scope window or binding");
      return scope;
    } catch {
      // Scope contents and protector errors may contain private host metadata.
      throw new Error("SANDBOX_SCOPE_UNAVAILABLE");
    }
  }
}
