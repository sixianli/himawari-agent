import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CompareAndSetStateInput,
  type StateRecord,
  type StateStorePort,
} from "../src/index.js";

export class TestStateStore implements StateStorePort {
  readonly #records = new Map<string, StateRecord>();

  async read(key: string): Promise<StateRecord | undefined> {
    return structuredClone(this.#records.get(key));
  }

  async compareAndSet(input: CompareAndSetStateInput): Promise<StateRecord> {
    const current = this.#records.get(input.key);
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `State revision conflict for ${input.key}`,
      );
    }
    const record: StateRecord = {
      key: input.key,
      revision: (current?.revision ?? 0) + 1,
      value: structuredClone(input.value),
    };
    this.#records.set(input.key, record);
    return structuredClone(record);
  }
}

/** Stable test-only digest; production hashing remains platform-owned. */
export function testDigest(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(8, "0").repeat(8)}`;
}
