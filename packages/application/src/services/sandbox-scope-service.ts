import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type ResolvedSandboxScope,
  type SandboxExecutionPlanCandidate,
  type SandboxScope,
  sandboxExecutionPlanCandidateSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import type { AuthorizationStorePort } from "../ports/authorization.js";
import type { HostFileStatePort } from "../ports/host-files.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import { resolveSandboxNetworkAuthorization } from "./sandbox-network-authorization.js";

export interface SandboxScopeServiceOptions {
  /** Owner/Agent scoped store; the protector independently authenticates that scope. */
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: Pick<PayloadProtectorPort, "unprotect">;
  /** Current Owner/Agent scoped directory state for this trusted host. */
  readonly files: Pick<HostFileStatePort, "readGrant">;
  readonly hostId: string;
  readonly network?: {
    readonly authorizations: Pick<AuthorizationStorePort, "listGrants" | "getApproval">;
    readonly maximumDomains: readonly string[];
  };
  readonly verifyParent?: (
    scope: SandboxScope,
    plan: SandboxExecutionPlanCandidate,
  ) => Promise<void>;
  readonly now: () => string;
  /** Trusted SHA-256 over exact bytes, returning lowercase hex. */
  readonly digest: (bytes: Uint8Array) => string;
}

/** Resolves protected scope and current directory/network authority. It does not
 * certify host isolation. Re-run at start; physical root identity,
 * operation semantics, disclosure and TOCTOU checks remain mandatory. */
export class SandboxScopeService {
  readonly #options: SandboxScopeServiceOptions;
  constructor(options: SandboxScopeServiceOptions) {
    this.#options = options;
  }

  async read(
    input: SandboxExecutionPlanCandidate,
    parentRequestId: string | null,
  ): Promise<SandboxScope> {
    return (await this.resolve(input, parentRequestId)).scope;
  }

  async resolve(
    input: SandboxExecutionPlanCandidate,
    parentRequestId: string | null,
  ): Promise<ResolvedSandboxScope> {
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
      if (scope.parentRequestId !== parentRequestId) throw new Error("parent request mismatch");
      const current = await this.#options.files.readGrant(scope.directoryGrant.ref);
      const now = this.#options.now();
      if (
        !current ||
        scope.hostId !== this.#options.hostId ||
        current.hostId !== this.#options.hostId ||
        current.id !== scope.directoryGrant.ref ||
        current.revision !== scope.directoryGrant.revision ||
        current.canonicalRootId !== scope.directoryGrant.canonicalRootId ||
        current.authorizationRef !== scope.directoryGrant.authorizationRef ||
        current.revokedAt !== null ||
        current.pathPolicy !== "same_filesystem_no_links" ||
        current.mountPolicy !== "fixed_device" ||
        !Number.isFinite(Date.parse(current.expiresAt)) ||
        Date.parse(current.expiresAt) <= Date.parse(now) ||
        Date.parse(current.expiresAt) < Date.parse(plan.effectiveDeadlineAt) ||
        scope.directoryGrant.operations.length === 0 ||
        new Set(scope.directoryGrant.operations).size !== scope.directoryGrant.operations.length ||
        scope.directoryGrant.operations.some((operation) => !current.operations.includes(operation))
      )
        throw new Error("directory authority changed");
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
      if (this.#options.verifyParent) await this.#options.verifyParent(scope, plan);
      if (scope.networkAuthorizationRef !== null && !this.#options.network)
        throw new Error("network authority missing");
      const allowedDomains = this.#options.network
        ? await resolveSandboxNetworkAuthorization({
            plan,
            scope,
            ...this.#options.network,
            now: this.#options.now,
          })
        : [];
      if (this.#options.now() >= plan.effectiveDeadlineAt) throw new Error("scope expired");
      return { scope, allowedDomains };
    } catch {
      // Scope contents and protector errors may contain private host metadata.
      throw new Error("SANDBOX_SCOPE_UNAVAILABLE");
    }
  }
}
