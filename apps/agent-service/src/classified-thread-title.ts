import type {
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  ThreadRepositoryPort,
} from "@himawari-agent/application";

const SHOWN_CLASSIFICATIONS: readonly string[] = ["public", "private"];

export function classifiedThreadTitleReader(options: {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly threads: Pick<ThreadRepositoryPort, "read">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: Pick<PayloadProtectorPort, "unprotect">;
}): (threadId: string) => Promise<string | null> {
  const { ownerId, agentId } = options.configuration;
  return async (threadId) => {
    const thread = await options.threads.read(
      ownerId,
      agentId,
      threadId as Parameters<ThreadRepositoryPort["read"]>[2],
    );
    if (!thread?.titleRef) return null;
    const payload = await options.payloads.get(thread.titleRef);
    if (
      !payload ||
      payload.contentType !== "text/plain" ||
      !SHOWN_CLASSIFICATIONS.includes(payload.dataClassification)
    )
      return null;
    const title = new TextDecoder("utf-8", { fatal: true }).decode(
      await options.protector.unprotect({ ownerId, agentId, payload }),
    );
    return title.trim() || null;
  };
}
