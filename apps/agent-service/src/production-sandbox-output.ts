import { createHash } from "node:crypto";
import type {
  ClockPort,
  IdGeneratorPort,
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  RunPayloadArtifactPort,
  SandboxExecutionRecord,
} from "@himawari-agent/application";
import {
  type SandboxResourceOutputQuery,
  sandboxResourceOutputPageSchema,
  sandboxResourceOutputQuerySchema,
} from "@himawari-agent/execution-contracts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (value: unknown) => digest(Buffer.from(JSON.stringify(value)));
/** Pages are immutable protected artifacts. A cursor names an issued position in
 * one result snapshot; it never denotes a host file, process, or execution right. */
export function createProductionSandboxOutput(options: {
  ownerId: ProductConfiguration["ownerId"];
  agentId: ProductConfiguration["agentId"];
  payloads: Pick<PayloadStorePort, "get">;
  protector: PayloadProtectorPort;
  artifacts: () => RunPayloadArtifactPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
}) {
  return async (record: SandboxExecutionRecord, input: SandboxResourceOutputQuery) => {
    const query = sandboxResourceOutputQuerySchema.parse(input);
    if (query.resourceRef !== record.facts.environment.resourceRef)
      throw new Error("SANDBOX_OUTPUT_RESOURCE_CHANGED");
    const result = record.facts.result;
    if (!result || result.kind === "unknown") {
      if (query.cursor !== null) throw new Error("SANDBOX_OUTPUT_CURSOR_UNAVAILABLE");
      return null;
    }
    const source = result.output;
    const payload = await options.payloads.get(source.ref);
    if (
      !payload ||
      payload.ciphertext.byteLength > record.plan.resourceCeiling.maxOutputBytes + 131072
    )
      throw new Error("SANDBOX_OUTPUT_UNAVAILABLE");
    const bytes = await options.protector.unprotect({
      ownerId: options.ownerId,
      agentId: options.agentId,
      payload,
    });
    if (
      bytes.byteLength > record.plan.resourceCeiling.maxOutputBytes ||
      bytes.byteLength !== source.byteLength ||
      digest(bytes) !== source.digest
    )
      throw new Error("SANDBOX_OUTPUT_CHANGED");
    const binding = key([
      record.plan.identity,
      record.plan.semanticFingerprint,
      query.resourceRef,
      source,
    ]);
    const runId = record.plan.identity.runId as Parameters<
      RunPayloadArtifactPort["lookup"]
    >[0]["runId"];
    let offset = 0;
    if (query.cursor !== null) {
      if (!/^sandbox-output-cursor:[a-f0-9]{64}$/.test(query.cursor))
        throw new Error("SANDBOX_OUTPUT_CURSOR_INVALID");
      const artifact = await options
        .artifacts()
        .lookup({ runId, purpose: "trace", operationKey: query.cursor });
      const saved = artifact && (await options.payloads.get(artifact.payloadRef));
      if (
        !saved ||
        saved.contentType !== "application/json" ||
        saved.dataClassification !== "restricted" ||
        saved.ciphertext.byteLength > 8192
      )
        throw new Error("SANDBOX_OUTPUT_CURSOR_UNAVAILABLE");
      const plaintext = await options.protector.unprotect({
        ownerId: options.ownerId,
        agentId: options.agentId,
        payload: saved,
      });
      if (plaintext.byteLength > 4096) throw new Error("SANDBOX_OUTPUT_CURSOR_INVALID");
      const cursor = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(plaintext)) as {
        binding?: unknown;
        offset?: unknown;
      };
      if (
        cursor.binding !== binding ||
        typeof cursor.offset !== "number" ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > bytes.byteLength ||
        query.cursor !== `sandbox-output-cursor:${key([binding, cursor.offset])}`
      )
        throw new Error("SANDBOX_OUTPUT_CURSOR_CHANGED");
      offset = cursor.offset;
    }
    const page = bytes.subarray(offset, offset + query.limit);
    const end = offset + page.byteLength === bytes.byteLength;
    const nextCursor = end
      ? null
      : `sandbox-output-cursor:${key([binding, offset + page.byteLength])}`;
    if (nextCursor) {
      const cursorPayload = await options.protector.protect({
        ownerId: options.ownerId,
        agentId: options.agentId,
        ref: options.ids.next("sandbox-output-cursor"),
        dataClassification: "restricted",
        contentType: "application/json",
        plaintext: Buffer.from(JSON.stringify({ binding, offset: offset + page.byteLength })),
        createdAt: options.clock.now(),
      });
      await options
        .artifacts()
        .commit({ runId, purpose: "trace", operationKey: nextCursor, payload: cursorPayload });
    }
    const pagePayload = await options.protector.protect({
      ownerId: options.ownerId,
      agentId: options.agentId,
      ref: options.ids.next("sandbox-output-page"),
      dataClassification: payload.dataClassification,
      contentType: "application/octet-stream",
      plaintext: page,
      createdAt: options.clock.now(),
    });
    const saved = await options.artifacts().commit({
      runId,
      purpose: "trace",
      operationKey: `sandbox-output-page:${key([binding, offset, query.limit])}`,
      payload: pagePayload,
    });
    return sandboxResourceOutputPageSchema.parse({
      resourceRef: query.resourceRef,
      cursor: query.cursor,
      nextCursor,
      output: { ref: saved.ref, digest: digest(page), byteLength: page.byteLength },
      truncated: false,
      end,
    });
  };
}
