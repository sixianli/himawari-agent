import type {
  GovernanceMutationReceipt,
  GovernanceMutationReceiptStorePort,
} from "@himawari-agent/application";
import { ApplicationPortError, PORT_ERROR_CODES } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { frozenCopy } from "./helpers.js";

function receiptKey(ownerId: OwnerId, agentId: AgentId, idempotencyKey: string): string {
  return `${ownerId}\u0000${agentId}\u0000${idempotencyKey}`;
}

export class InMemoryGovernanceMutationReceiptStore implements GovernanceMutationReceiptStorePort {
  private readonly records = new Map<string, GovernanceMutationReceipt>();

  async get(
    ownerId: OwnerId,
    agentId: AgentId,
    idempotencyKey: string,
  ): Promise<GovernanceMutationReceipt | undefined> {
    const record = this.records.get(receiptKey(ownerId, agentId, idempotencyKey));
    return record ? frozenCopy(record) : undefined;
  }

  async create(receipt: GovernanceMutationReceipt): Promise<GovernanceMutationReceipt> {
    const key = receiptKey(receipt.ownerId, receipt.agentId, receipt.idempotencyKey);
    if (this.records.has(key)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Governance receipt ${receipt.idempotencyKey} already exists`,
        { idempotencyKey: receipt.idempotencyKey },
      );
    }
    if (
      receipt.revision !== 1 ||
      receipt.phase !== "executing" ||
      receipt.resultRef !== null ||
      receipt.committedAt !== null
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Governance receipt must begin in the executing phase",
      );
    }
    this.records.set(key, frozenCopy(receipt));
    return frozenCopy(receipt);
  }

  async complete(
    receipt: GovernanceMutationReceipt,
    expectedRevision: number,
  ): Promise<GovernanceMutationReceipt> {
    const key = receiptKey(receipt.ownerId, receipt.agentId, receipt.idempotencyKey);
    const current = this.records.get(key);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governance receipt not found");
    }
    if (
      current.revision !== expectedRevision ||
      current.phase !== "executing" ||
      receipt.revision !== current.revision + 1 ||
      receipt.phase !== "completed" ||
      receipt.resultRef === null ||
      receipt.committedAt === null ||
      current.commandType !== receipt.commandType ||
      current.semanticFingerprint !== receipt.semanticFingerprint
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Governance receipt ${receipt.idempotencyKey} cannot be completed`,
        { idempotencyKey: receipt.idempotencyKey },
      );
    }
    this.records.set(key, frozenCopy(receipt));
    return frozenCopy(receipt);
  }
}
