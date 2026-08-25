import type {
  CapabilityDescriptor,
  CapabilityInvocationEvent,
  CapabilityInvocationRequest,
  CapabilityPort,
  IdGeneratorPort,
  SecretHandle,
  SecretHandleRequest,
  SecretPort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class ScriptedCapabilityPort implements CapabilityPort {
  private readonly descriptors: readonly CapabilityDescriptor[];
  private readonly events: readonly CapabilityInvocationEvent[];

  constructor(
    descriptors: readonly CapabilityDescriptor[] = [],
    events: readonly CapabilityInvocationEvent[] = [],
  ) {
    this.descriptors = frozenCopy([...descriptors]);
    this.events = frozenCopy([...events]);
  }

  async list(): Promise<readonly CapabilityDescriptor[]> {
    return frozenCopy([...this.descriptors]);
  }

  async *invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent> {
    const descriptor = this.descriptors.find(({ ref }) => ref === request.capabilityRef);
    if (!descriptor || descriptor.lifecycle !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Active capability ${request.capabilityRef} not found`,
        { capabilityRef: request.capabilityRef },
      );
    }
    for (const event of this.events) yield frozenCopy(event);
  }
}

export class InMemorySecretPort implements SecretPort {
  private readonly handles = new Map<string, SecretHandle>();
  private readonly ids: IdGeneratorPort;
  private readonly failures: FailureScheduler;

  constructor(ids: IdGeneratorPort, failures: FailureScheduler = NO_FAILURES) {
    this.ids = ids;
    this.failures = failures;
  }

  async issueHandle(request: SecretHandleRequest): Promise<SecretHandle> {
    this.failures.checkpoint("secret.issueHandle");
    const handle = frozenCopy({
      ref: this.ids.next("secret-handle"),
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
    this.handles.set(handle.ref, handle);
    return frozenCopy(handle);
  }

  async inspectHandle(handleRef: string): Promise<SecretHandle | undefined> {
    const handle = this.handles.get(handleRef);
    return handle ? frozenCopy(handle) : undefined;
  }

  async revokeHandle(handleRef: string, revokedAt: string): Promise<SecretHandle> {
    this.failures.checkpoint("secret.revokeHandle");
    const current = this.handles.get(handleRef);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Secret handle ${handleRef} not found`,
        { handleRef },
      );
    }
    const revoked = frozenCopy({ ...current, revokedAt });
    this.handles.set(handleRef, revoked);
    return frozenCopy(revoked);
  }
}
