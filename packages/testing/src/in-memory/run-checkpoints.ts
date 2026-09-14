import type { RunId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type RunCheckpointStore,
  type StoredRunCheckpoint,
  type CompareAndSetRunCheckpointInput,
} from "@himawari-agent/application";

export class InMemoryRunCheckpointStore implements RunCheckpointStore {
  private readonly records = new Map<RunId, StoredRunCheckpoint>();

  async read(runId: RunId): Promise<StoredRunCheckpoint | undefined> {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  async compareAndSet(input: CompareAndSetRunCheckpointInput): Promise<StoredRunCheckpoint> {
    const current = this.records.get(input.runId);
    if ((current?.revision ?? null) !== input.expectedRevision)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Run checkpoint revision conflict");
    const record = {
      runId: input.runId,
      revision: (current?.revision ?? 0) + 1,
      checkpoint: structuredClone(input.checkpoint),
    };
    this.records.set(input.runId, record);
    return structuredClone(record);
  }
}
