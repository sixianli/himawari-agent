// biome-ignore-all lint/complexity/useLiteralKeys: untrusted provider records require index access

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  MacOsKeychainProviderSecretSource,
  parseProductConfiguration,
} from "@himawari-agent/platform-node";
import { ConfiguredPiModelBindingPort } from "@himawari-agent/runtime-pi";
import { expect } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../../../apps/agent-service/src/production-memory-composition.js";
import { resolveConfiguredModelDescriptorSet } from "../../../apps/agent-service/src/production-model-composition.js";
import { boundedOpenRouterFetch, record } from "./file-summary-network.js";

const fixture = new URL("./file-summary/", import.meta.url);
export async function qualifyFileSummary() {
  const raw = await readFile(new URL("configuration.json", fixture), "utf8");
  const configuration = parseProductConfiguration(JSON.parse(raw), new Date().toISOString());
  const stateRoot = await mkdtemp("/tmp/hma-p005-");
  const signal = AbortSignal.timeout(240_000);
  const priorReservationMicros = Number(
    process.env["HIMAWARI_FILE_SUMMARY_PRIOR_RESERVATION_MICROS"] ?? 0,
  );
  let embeddingFetch: typeof globalThis.fetch | undefined;
  const guard = boundedOpenRouterFetch(
    configuration,
    (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/embeddings") && embeddingFetch
        ? embeddingFetch(input, init)
        : globalThis.fetch(input, init);
    },
    signal,
    priorReservationMicros,
  );
  const source = new MacOsKeychainProviderSecretSource({
    servicePrefix: "himawari-provider",
    account: "himawari-agent",
  });
  const bindings = new ConfiguredPiModelBindingPort({
    descriptors: resolveConfiguredModelDescriptorSet(configuration).generation,
    secretSource: source,
  });
  const generations: Record<string, unknown>[] = [];
  const embeddings: Record<string, unknown>[] = [];
  let toolExecuted = false;
  let toolResultMatched = false;
  let summaryFactsMatched = false;
  let summary = "";
  let toolCall: { id: string; name: string; arguments: unknown } | null = null;
  let passed = false;
  let memory:
    | Awaited<ReturnType<typeof createProductionMemoryCompositionFromConfiguration>>
    | undefined;
  let credentialReads = 0;
  const startedAt = new Date().toISOString();
  const phase = process.env["HIMAWARI_FILE_SUMMARY_PHASE"] ?? "all";
  if (!["all", "generation", "embedding"].includes(phase)) throw new Error("PROBE_INVALID_PHASE");
  let content = "";
  let key = "";
  try {
    if (phase !== "embedding") {
      const primary = await bindings.resolve("model-primary");
      if (!primary.resolveSecret) throw new Error("PROBE_SECRET_RESOLVER_MISSING");
      key = await primary.resolveSecret();
      credentialReads++;
      const options = {
        apiKey: key,
        maxTokens: 2048,
        maxRetries: 0,
        timeoutMs: 120_000,
        signal,
        fetch: guard.fetch,
        temperature: 0,
      };
      type Context = Parameters<typeof primary.modelRuntime.completeSimple>[1];
      const context: Context = {
        systemPrompt: configuration.runPolicy?.systemInstruction ?? "请根据工具结果总结。",
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content:
              "请使用 read_public_fixture 读取 project-brief.txt，总结项目目标、已完成事项、待办事项和限制，保留项目代号和数字。",
          },
        ],
        tools: [
          {
            name: "read_public_fixture",
            description: "读取本次已授权的公开测试文件。",
            parameters: {
              type: "object",
              properties: { file: { type: "string", enum: ["project-brief.txt"] } },
              required: ["file"],
              additionalProperties: false,
            } as never,
          },
        ],
      };
      async function observe(
        message: Awaited<ReturnType<typeof primary.modelRuntime.completeSimple>>,
      ) {
        const observation: Record<string, unknown> = {
          model: message["model"],
          responseModel: message.responseModel ?? message["model"],
          responseId: message.responseId ?? null,
          stopReason: message.stopReason,
          usage: message.usage,
        };
        generations.push(observation);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          throw new Error(`PROBE_GENERATION_FAILED:${message.stopReason}`);
        }
        if (!message.responseId) throw new Error("PROBE_RESPONSE_ID_MISSING");
      }
      const first = await primary.modelRuntime.completeSimple(primary.model, context, options);
      await observe(first);
      expect(first.stopReason).toBe("toolUse");
      const calls = first.content.filter((content) => content.type === "toolCall");
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (!call) throw new Error("PROBE_TOOL_CALL_MISSING");
      expect(call.name).toBe("read_public_fixture");
      expect(call.arguments).toEqual({ file: "project-brief.txt" });
      toolCall = { id: call.id, name: call.name, arguments: call.arguments };
      // Test fixture access, deliberately not a claim of production Mac Worker execution.
      content = await readFile(new URL("project-brief.txt", fixture), "utf8");
      toolExecuted = true;
      const secondContext: Context = {
        ...context,
        messages: [
          ...context.messages,
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: content }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      };
      const second = await primary.modelRuntime.completeSimple(primary.model, secondContext, {
        ...options,
        onPayload: (payload) => {
          const messages = record(payload)["messages"];
          toolResultMatched =
            Array.isArray(messages) &&
            messages.some((item) => {
              const message = record(item);
              return (
                message["role"] === "tool" &&
                message["tool_call_id"] === call.id &&
                message["content"] === content
              );
            });
        },
      });
      await observe(second);
      expect(second.stopReason).toBe("stop");
      const answer = second.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      summaryFactsMatched = ["向日葵-海盐-4827", "37", "25", "12"].every((fact) =>
        answer.includes(fact),
      );
      expect(toolResultMatched).toBe(true);
      expect(summaryFactsMatched).toBe(true);
      summary = answer;

      const fallback = await bindings.resolve("model-fallback");
      const third = await fallback.modelRuntime.completeSimple(
        fallback.model,
        {
          messages: [
            { role: "user", content: "Reply with exactly HIMAWARI", timestamp: Date.now() },
          ],
        },
        options,
      );
      await observe(third);
      expect(third.stopReason).toBe("stop");
      expect(
        third.content.some((item) => item.type === "text" && item.text.includes("HIMAWARI")),
      ).toBe(true);
    }
    if (phase !== "generation") {
      if (!content) content = await readFile(new URL("project-brief.txt", fixture), "utf8");
      // Mem0 3.1.7 uses OpenAI v4 shims; install the same outbound guard before loading it.
      const shims = await import("openai/_shims/registry");
      const nodeRuntime = await import("openai/_shims/node-runtime");
      if (shims.kind !== undefined) throw new Error("PROBE_MEM0_SHIMS_ALREADY_LOADED");
      const sdkRuntime = nodeRuntime.getRuntime();
      embeddingFetch = sdkRuntime.fetch as typeof globalThis.fetch;
      shims.setShims({ ...sdkRuntime, fetch: guard.fetch }, { auto: false });
      memory = await createProductionMemoryCompositionFromConfiguration({
        configuration: {
          ...configuration,
          stateRoot,
          memory: { ...configuration.memory, storagePath: `${stateRoot}/data/memory` },
        },
        secretSource: source,
      });
      let embeddingOperation = "upsert";
      memory.projection.bindEmbeddingBoundary(async (request, send) => {
        const result = await send({ timeoutMs: 120_000, signal });
        const vectors = result["data"].map((item) => item.embedding);
        expect(vectors).toHaveLength(1);
        embeddings.push({
          operation: embeddingOperation,
          model: request["model"],
          requestedDimensions: request["dimensions"],
          dimensions: vectors.map((vector) => vector.length),
          finite: vectors.every((vector) => vector.every(Number.isFinite)),
          usage: {
            prompt_tokens: result.usage.prompt_tokens,
            total_tokens: result.usage.total_tokens,
            cost: record(result.usage)["cost"] ?? null,
          },
        });
        expect(
          vectors.every((vector) => vector.length === 4096 && vector.every(Number.isFinite)),
        ).toBe(true);
        return result;
      }, 120_000);
      const providerRecordId = await memory.projection.upsert({
        content,
        memory: {
          id: createMemoryId("memory-file-summary-p005"),
          ownerId: createOwnerId(configuration.ownerId),
          agentId: createAgentId(configuration.agentId),
          revision: 1,
          status: "active",
          contentRef: "payload-public-file-summary",
          dataClassification: "public",
          sourceThreadId: createThreadId("thread-file-summary-p005"),
          sourceRefs: ["public-fixture"],
          inference: false,
          confidencePermille: 1000,
          policyVersion: "file-summary-v1",
          providerRecordId: null,
          lastUsedAt: null,
          updatedAt: new Date().toISOString(),
        },
      });
      embeddingOperation = "search";
      const hits = await memory.projection.search({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        query: "图书角整理计划",
        limit: 5,
      });
      expect(hits.some((hit) => hit.providerRecordId === providerRecordId)).toBe(true);
      expect(embeddings.some((item) => item["operation"] === "upsert")).toBe(true);
      expect(embeddings.some((item) => item["operation"] === "search")).toBe(true);
      expect(embeddings.length).toBeGreaterThanOrEqual(2);
      expect(embeddings.length).toBeLessThanOrEqual(3);
      expect(guard.requests).toHaveLength(embeddings.length + generations.length);
      expect(guard.requests.every((request) => request.status === 200)).toBe(true);
      expect(
        guard.requests
          .filter((request) => request.kind === "embedding")
          .every((request) => request.responseModel?.toLowerCase() === "qwen/qwen3-embedding-8b"),
      ).toBe(true);
    }
    // Generation records may become queryable after the stream has completed.
    // Retry only these read-only lookups; never repeat an inference for missing metadata.
    for (const observation of generations) {
      let metadata: Response | undefined;
      const statuses: number[] = [];
      for (const waitMs of [0, 1000, 3000, 8000]) {
        if (waitMs) await delay(waitMs, undefined, { signal });
        metadata = await guard.fetch(
          `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(String(observation["responseId"]))}`,
          { headers: { Authorization: `Bearer ${key}` } },
        );
        statuses.push(metadata.status);
        if (metadata.status !== 404) break;
        await metadata.body?.cancel();
      }
      observation["metadataStatuses"] = statuses;
      if (!metadata?.ok) throw new Error(`PROBE_METADATA_HTTP_${metadata?.status}`);
      const data = record(record(await metadata.json())["data"]);
      observation["provider"] = data["provider_name"];
      observation["billedCostUsd"] = data["total_cost"];
      if (typeof data["total_cost"] !== "number" || data["total_cost"] < 0)
        throw new Error("PROBE_COST_MISSING");
    }
    if (phase !== "embedding") {
      expect(generations.slice(0, 2).every((item) => item["provider"] === "DeepInfra")).toBe(true);
      expect(generations[2]?.["provider"]).toBe("Z.AI");
      const total = generations.reduce((sum, item) => sum + Number(item["billedCostUsd"]), 0);
      if (total + priorReservationMicros / 1_000_000 > 1)
        throw new Error("PROBE_ACTUAL_BUDGET_EXCEEDED");
    }
    passed = true;
  } finally {
    await memory?.close();
    await bindings.close();
    const evidence = {
      schemaVersion: "himawari.p005.evidence.v1",
      startedAt,
      finishedAt: new Date().toISOString(),
      passed,
      phase,
      credentialSource: "macos-keychain",
      generationCredentialReads: credentialReads,
      configurationSha256: createHash("sha256").update(raw).digest("hex"),
      budgetLimitUsd: 1,
      priorReservationMicros,
      summary,
      toolCall,
      reservedCostMicros: guard.reservedCostMicros(),
      productionWorkerTested: false,
      browserTested: false,
      toolExecuted,
      toolResultMatched,
      summaryFactsMatched,
      requests: guard.requests,
      generations,
      embeddings,
    };
    const destination = process.env["HIMAWARI_FILE_SUMMARY_EVIDENCE_PATH"];
    if (destination)
      await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({
        passed,
        requests: guard.requests.length,
        generations: generations.length,
        embeddings: embeddings.length,
        toolExecuted,
        toolResultMatched,
      })}\n`,
    );
    await rm(stateRoot, { recursive: true, force: true });
  }
}
