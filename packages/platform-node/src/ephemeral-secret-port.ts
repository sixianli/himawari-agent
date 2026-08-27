import type {
  ClockPort,
  IdGeneratorPort,
  SecretHandle,
  SecretHandleRequest,
  SecretPort,
} from "@himawari-agent/application";

export interface EphemeralSecretPortOptions {
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
}

/**
 * Holds only opaque handle metadata for the lifetime of one Agent Service
 * process. The credential value is never accepted by this port; trusted host
 * sources resolve it later inside the provider adapter. Handles are
 * intentionally volatile and invocation-scoped rather than another durable
 * secret store.
 */
export class EphemeralSecretPort implements SecretPort {
  readonly #ids: IdGeneratorPort;
  readonly #clock: ClockPort;
  readonly #handles = new Map<string, SecretHandle>();

  constructor(options: EphemeralSecretPortOptions) {
    this.#ids = options.ids;
    this.#clock = options.clock;
  }

  async issueHandle(request: SecretHandleRequest): Promise<SecretHandle> {
    const now = Date.parse(this.#clock.now());
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("SECRET_HANDLE_EXPIRED");
    }
    const handle = Object.freeze({
      ref: this.#ids.next("secret-handle"),
      ownerId: request.ownerId,
      agentId: request.agentId,
      runId: request.runId,
      secretRef: request.secretRef,
      secretVersion: request.secretVersion,
      purpose: request.purpose,
      scopeRef: request.scopeRef,
      expiresAt: request.expiresAt,
      revokedAt: null,
    });
    this.#handles.set(handle.ref, handle);
    return handle;
  }

  async inspectHandle(handleRef: string): Promise<SecretHandle | undefined> {
    return this.#handles.get(handleRef);
  }

  async revokeHandle(handleRef: string, revokedAt: string): Promise<SecretHandle> {
    const current = this.#handles.get(handleRef);
    if (!current) throw new Error("SECRET_HANDLE_NOT_FOUND");
    if (current.revokedAt !== null) return current;
    const revoked = Object.freeze({ ...current, revokedAt });
    this.#handles.set(handleRef, revoked);
    return revoked;
  }

  clear(): void {
    this.#handles.clear();
  }
}
