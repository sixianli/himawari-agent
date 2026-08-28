import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type JsonObject,
  type PreparedWebAction,
  type StateStorePort,
  type WebOperationRecord,
  type WebResourceRecord,
  type WebSessionRecord,
  type WebStatePort,
} from "../ports/index.js";

export class DurableWebStateAdapter implements WebStatePort {
  readonly #state: StateStorePort;

  constructor(state: StateStorePort) {
    this.#state = state;
  }

  async saveResource(resource: WebResourceRecord): Promise<WebResourceRecord> {
    await this.#state.compareAndSet({
      key: key("resource", resource.id),
      expectedRevision: null,
      value: json(resource),
    });
    return resource;
  }

  async readResource(resourceId: string): Promise<WebResourceRecord | undefined> {
    return this.#read<WebResourceRecord>(key("resource", resourceId));
  }

  async saveSession(
    session: WebSessionRecord,
    expectedRevision: number | null,
  ): Promise<WebSessionRecord> {
    await this.#state.compareAndSet({
      key: key("session", session.id),
      expectedRevision,
      value: json(session),
    });
    return session;
  }

  async readSession(sessionId: string): Promise<WebSessionRecord | undefined> {
    return this.#read<WebSessionRecord>(key("session", sessionId));
  }

  async savePreparedAction(
    action: PreparedWebAction,
    expectedRevision: number | null,
  ): Promise<PreparedWebAction> {
    await this.#state.compareAndSet({
      key: key("prepared-action", action.id),
      expectedRevision,
      value: json(action),
    });
    return action;
  }

  async readPreparedAction(actionId: string): Promise<PreparedWebAction | undefined> {
    return this.#read<PreparedWebAction>(key("prepared-action", actionId));
  }

  async createOperation(
    operation: WebOperationRecord,
  ): Promise<{ record: WebOperationRecord; replayed: boolean }> {
    const stateKey = key("operation", operation.id);
    const existing = await this.#read<WebOperationRecord>(stateKey);
    if (existing) return this.#replay(existing, operation);
    try {
      await this.#state.compareAndSet({
        key: stateKey,
        expectedRevision: null,
        value: json(operation),
      });
      return { record: operation, replayed: false };
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT) {
        throw error;
      }
      const raced = await this.#read<WebOperationRecord>(stateKey);
      if (!raced) throw error;
      return this.#replay(raced, operation);
    }
  }

  async saveOperation(operation: WebOperationRecord): Promise<WebOperationRecord> {
    const stateKey = key("operation", operation.id);
    const current = await this.#state.read(stateKey);
    if (!current)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Web operation missing");
    await this.#state.compareAndSet({
      key: stateKey,
      expectedRevision: current.revision,
      value: json(operation),
    });
    return operation;
  }

  async readOperation(operationId: string): Promise<WebOperationRecord | undefined> {
    return this.#read<WebOperationRecord>(key("operation", operationId));
  }

  async #read<TValue>(stateKey: string): Promise<TValue | undefined> {
    const record = await this.#state.read(stateKey);
    return record?.value as TValue | undefined;
  }

  #replay(
    existing: WebOperationRecord,
    requested: WebOperationRecord,
  ): { record: WebOperationRecord; replayed: boolean } {
    if (
      existing.idempotencyKey !== requested.idempotencyKey ||
      existing.preparedActionId !== requested.preparedActionId ||
      existing.kind !== requested.kind
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Web operation identity was reused with different input",
      );
    }
    return { record: existing, replayed: true };
  }
}

function key(kind: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Web record ID is unsafe");
  }
  return `web:${kind}:${id}`;
}

function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
