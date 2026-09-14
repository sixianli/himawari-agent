import { createHash } from "node:crypto";
import type { RunPayloadArtifactPort, SandboxExecutionRecord } from "@himawari-agent/application";
import {
  type SandboxOutputChunk,
  type SandboxResourceOutputQuery,
  sandboxOutputChunkSchema,
  sandboxResourceOutputPageSchema,
  sandboxResourceOutputQuerySchema,
} from "@himawari-agent/execution-contracts";
import type { createProductionSandboxOutput } from "./production-sandbox-output.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (value: unknown) => hash(Buffer.from(JSON.stringify(value)));
/** Immutable, contiguous protected chunks. Polling an issued cursor performs only
 * artifact reads; neither process liveness nor execution authority comes from it. */
export function createProductionSandboxStream(
  options: Parameters<typeof createProductionSandboxOutput>[0],
) {
  const scope = (record: SandboxExecutionRecord) => ({
    runId: record.plan.identity.runId as Parameters<RunPayloadArtifactPort["lookup"]>[0]["runId"],
    binding: key([record.plan.identity, record.plan.semanticFingerprint, record.facts.environment]),
  });
  const read = async (record: SandboxExecutionRecord, operationKey: string) => {
    const artifact = await options.artifacts().lookup({
      runId: scope(record).runId,
      purpose: "trace",
      operationKey,
    });
    if (!artifact) return undefined;
    const payload = await options.payloads.get(artifact.payloadRef);
    if (
      !payload ||
      payload.dataClassification !== "restricted" ||
      payload.contentType !== "application/json" ||
      payload.ciphertext.byteLength > 65536
    )
      throw new Error("SANDBOX_STREAM_ARTIFACT_INVALID");
    const bytes = await options.protector.unprotect({
      ownerId: options.ownerId,
      agentId: options.agentId,
      payload,
    });
    if (bytes.byteLength > 49152 || `sha256:${hash(bytes)}` !== artifact.contentDigest)
      throw new Error("SANDBOX_STREAM_ARTIFACT_CHANGED");
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown;
  };
  const save = async (record: SandboxExecutionRecord, operationKey: string, value: unknown) => {
    const payload = await options.protector.protect({
      ownerId: options.ownerId,
      agentId: options.agentId,
      ref: options.ids.next("sandbox-stream"),
      dataClassification: "restricted",
      contentType: "application/json",
      plaintext: Buffer.from(JSON.stringify(value)),
      createdAt: options.clock.now(),
    });
    await options
      .artifacts()
      .commit({ runId: scope(record).runId, purpose: "trace", operationKey, payload });
    if (JSON.stringify(await read(record, operationKey)) !== JSON.stringify(value))
      throw new Error("SANDBOX_STREAM_REPLAY_CHANGED");
  };
  const chunkKey = (record: SandboxExecutionRecord, index: number) =>
    `sandbox-stream-chunk:${key([scope(record).binding, index])}`;
  const loadChunk = async (record: SandboxExecutionRecord, index: number) => {
    const saved = await read(record, chunkKey(record, index));
    return saved === undefined ? undefined : sandboxOutputChunkSchema.parse(saved);
  };
  const terminalKey = (record: SandboxExecutionRecord) =>
    `sandbox-stream-end:${scope(record).binding}`;
  return {
    async termination(record: SandboxExecutionRecord) {
      const saved = await read(record, terminalKey(record));
      return saved === undefined
        ? null
        : (sandboxOutputChunkSchema.parse(saved).termination ?? null);
    },
    async append(record: SandboxExecutionRecord, input: SandboxOutputChunk) {
      if (record.plan.mode === "foreground") throw new Error("SANDBOX_STREAM_MODE_INVALID");
      const chunk = sandboxOutputChunkSchema.parse(input);
      const bytes = Buffer.from(chunk.bytesBase64, "base64");
      if (
        bytes.toString("base64") !== chunk.bytesBase64 ||
        bytes.length > 32768 ||
        (!chunk.end && bytes.length === 0) ||
        chunk.index > record.plan.resourceCeiling.maxOutputBytes ||
        chunk.offset + bytes.length > record.plan.resourceCeiling.maxOutputBytes
      )
        throw new Error("SANDBOX_STREAM_LIMIT_INVALID");
      if (chunk.index === 0) {
        if (chunk.offset !== 0) throw new Error("SANDBOX_STREAM_OFFSET_INVALID");
      } else {
        const previous = await loadChunk(record, chunk.index - 1);
        if (
          !previous ||
          previous.end ||
          previous.offset + Buffer.from(previous.bytesBase64, "base64").length !== chunk.offset
        )
          throw new Error("SANDBOX_STREAM_SEQUENCE_INVALID");
      }
      await save(record, chunkKey(record, chunk.index), chunk);
      if (chunk.end) await save(record, terminalKey(record), chunk);
    },
    async output(record: SandboxExecutionRecord, input: SandboxResourceOutputQuery) {
      const query = sandboxResourceOutputQuerySchema.parse(input);
      if (query.resourceRef !== record.facts.environment.resourceRef)
        throw new Error("SANDBOX_STREAM_RESOURCE_CHANGED");
      const binding = scope(record).binding;
      const cursorKey = (index: number, offset: number) =>
        `sandbox-stream-cursor:${key([binding, index, offset])}`;
      let index = 0;
      let offset = 0;
      if (query.cursor !== null) {
        if (!/^sandbox-stream-cursor:[a-f0-9]{64}$/.test(query.cursor))
          throw new Error("SANDBOX_STREAM_CURSOR_INVALID");
        const saved = (await read(record, query.cursor)) as
          | { binding?: unknown; index?: unknown; offset?: unknown }
          | undefined;
        if (
          !saved ||
          saved.binding !== binding ||
          typeof saved.index !== "number" ||
          typeof saved.offset !== "number" ||
          !Number.isSafeInteger(saved.index) ||
          saved.index < 0 ||
          !Number.isSafeInteger(saved.offset) ||
          saved.offset < 0 ||
          query.cursor !== cursorKey(saved.index, saved.offset)
        )
          throw new Error("SANDBOX_STREAM_CURSOR_CHANGED");
        index = saved.index;
        offset = saved.offset;
      }
      const chunk = await loadChunk(record, index);
      const bytes = chunk ? Buffer.from(chunk.bytesBase64, "base64") : Buffer.alloc(0);
      if (offset > bytes.length) throw new Error("SANDBOX_STREAM_CURSOR_CHANGED");
      const page = bytes.subarray(offset, offset + query.limit);
      const consumed = offset + page.length === bytes.length;
      const end = chunk?.end === true && consumed;
      const nextIndex = chunk && consumed && !end ? index + 1 : index;
      const nextOffset = nextIndex === index ? offset + page.length : 0;
      const nextCursor = end ? null : cursorKey(nextIndex, nextOffset);
      if (nextCursor)
        await save(record, nextCursor, { binding, index: nextIndex, offset: nextOffset });
      const payload = await options.protector.protect({
        ownerId: options.ownerId,
        agentId: options.agentId,
        ref: options.ids.next("sandbox-stream-page"),
        dataClassification: "restricted",
        contentType: "application/octet-stream",
        plaintext: page,
        createdAt: options.clock.now(),
      });
      const saved = await options.artifacts().commit({
        runId: scope(record).runId,
        purpose: "trace",
        operationKey: `sandbox-stream-page:${key([binding, index, offset, query.limit, hash(page), end])}`,
        payload,
      });
      return sandboxResourceOutputPageSchema.parse({
        resourceRef: query.resourceRef,
        cursor: query.cursor,
        nextCursor,
        output: { ref: saved.ref, digest: hash(page), byteLength: page.length },
        truncated: false,
        end,
        ...(end && chunk?.termination ? { termination: chunk.termination } : {}),
      });
    },
  };
}
