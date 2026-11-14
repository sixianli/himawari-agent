import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { ProactiveSealPort } from "../ports/proactive-checks.js";
import type { IdGeneratorPort } from "../ports/system.js";

const CONTENT_TYPE = "application/vnd.himawari.proactive+json";

export function createProactiveSeal(options: {
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly ids: IdGeneratorPort;
}): ProactiveSealPort {
  return Object.freeze<ProactiveSealPort>({
    async seal({ ownerId, agentId, text, at, dataClassification = "private" }) {
      const ref = options.ids.next("proactive-payload");
      await options.payloads.put(
        await options.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification,
          contentType: CONTENT_TYPE,
          plaintext: new TextEncoder().encode(text),
          createdAt: at,
        }),
      );
      return ref;
    },
    async open({ ownerId, agentId, ref }) {
      const payload = await options.payloads.get(ref);
      if (!payload || payload.contentType !== CONTENT_TYPE) return undefined;
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await options.protector.unprotect({ ownerId, agentId, payload }),
      );
    },
    async classificationOf({ ref }) {
      const payload = await options.payloads.get(ref);
      return payload?.contentType === CONTENT_TYPE ? payload.dataClassification : undefined;
    },
    async release({ refs }) {
      for (const ref of refs) await options.payloads.delete(ref);
    },
  });
}
