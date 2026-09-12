import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { priceProviderMatrix, recordedCostUpper } from "./hermes-three-fixes-provider-matrix.mjs";
import { decodePayload, summarize } from "./hermes-three-fixes-model-diagnostic.mjs";
const root = "/data/hermes/himawari";
const runtime = `${root}/releases/2026-09-11-control-center/lib/himawari-agent`;
const out = `${root}/qualifications/2026-09-13-harness-continuation-gate`;
const runId = "run:cb547c58-80ea-42e6-8b90-4cfac81dcdf2";
const modelId = "deepseek/deepseek-v4-flash-0731";
const hash = (value) => createHash("sha256").update(value).digest("hex");
// Experimental tool selection gate; never executes returned calls or alters product behavior.
export function continuationGateInputs(original) {
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = original.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser);
  const calls = original.messages[lastAssistant].tool_calls;
  const results = original.messages.slice(lastAssistant + 1);
  assert(Array.isArray(calls) && [1, 4].includes(calls.length) && results.length === calls.length);
  assert.deepEqual(
    calls.map((c) => c.function.name),
    calls.length === 1 ? ["ls"] : ["ls", "find", "grep", "bash"],
  );
  assert(new Set(calls.map((c) => c.id)).size === calls.length);
  assert(results.every((r, i) => r.role === "tool" && r.tool_call_id === calls[i].id));
  assert(original.tool_choice === undefined || original.tool_choice === "auto");
  assert(
    results.every((r) => {
      const value = JSON.parse(r.content);
      return value.schemaVersion === "pi-result.v1" && value.isError === false;
    }),
  );
  return ["original", "continuation_gate"].map((variant) => {
    const request = structuredClone(original);
    request.stream = false;
    delete request.stream_options;
    delete request.max_completion_tokens;
    request.max_tokens = 4096;
    if (variant === "continuation_gate") {
      const names = original.tools.map((t) => t.function.name);
      assert(!names.includes("continue_work"));
      request.tools = [
        {
          type: "function",
          function: {
            name: "continue_work",
            description:
              "The previous tool results are available. Answer the current user request directly if they are sufficient. Use this only when further tool work is necessary to complete that request. Identify the needed tools and explain the missing evidence or unfinished action. Do not repeat already completed work unless fresh results are necessary.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string" },
                toolNames: {
                  type: "array",
                  items: { type: "string", enum: names },
                  minItems: 1,
                  uniqueItems: true,
                },
              },
              required: ["reason", "toolNames"],
              additionalProperties: false,
            },
          },
        },
      ];
      delete request.tool_choice;
    }
    return { variant, request };
  });
}
// Positive control: a listing cannot answer a question about a file's contents.
// Keep the same authorized synthetic workspace, old history and actual ls result.
export function unfinishedReadInput(original) {
  const request = structuredClone(original);
  const lastUser = request.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = request.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser);
  const assistant = request.messages[lastAssistant];
  assert.equal(assistant.tool_calls[0].function.name, "ls");
  const result = request.messages[lastAssistant + 1];
  assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
  request.messages[lastUser].content =
    "先列出工作目录 /data/hermes/himawari/workspaces/default，然后读取 script.py 的完整内容，说明它的输入、输出和失败情况。不要仅凭文件名推断其行为。";
  // The retained ls call is a constructed first step, not a recorded full Run.
  delete assistant.reasoning;
  delete assistant.reasoning_content;
  delete assistant.reasoning_details;
  assistant.content = null;
  assistant.tool_calls = assistant.tool_calls.slice(0, 1);
  request.messages = request.messages.slice(0, lastAssistant + 1).concat([result]);
  return request;
}
async function boundedJson(response, maximumBytes) {
  assert(response.ok, `HTTP_STATUS_${response.status}`);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= maximumBytes, "RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function main() {
  assert.equal(process.getuid(), 0);
  assert.equal(hostname(), "hermes-home");
  assert(process.env.INVOCATION_ID, "SYSTEMD_INVOCATION_REQUIRED");
  assert.deepEqual(process.argv.slice(2), ["--compare"]);
  assert.equal(
    hash(await readFile(new URL("./hermes-three-fixes-model-diagnostic.mjs", import.meta.url))),
    "977c5291adc22f4b165e530ee60a8ac676012627d2a9d9ad510080ed530f970d",
  );
  assert.equal(
    hash(await readFile(new URL("./hermes-three-fixes-provider-matrix.mjs", import.meta.url))),
    "31c2ace4e17b6378cd84a7d3d488d146dbb36d5c8dbab5587b6fd533389d3ee6",
  );
  assert.equal(
    JSON.parse(await readFile("/etc/himawari/runtime.json", "utf8")).runtimeDigest,
    "0d269e653bba534e7fc14591e2dc2dddb0373aedbddbe1284da7eeb33b980861",
  );
  const require = createRequire(`${runtime}/package.json`);
  const { EnvelopePayloadProtector } = require("@himawari-agent/platform-node");
  const { redactMachineSecrets } = require("@himawari-agent/application/runtime-port");
  const Database = require("better-sqlite3");
  const config = JSON.parse(await readFile(`${root}/config/production.json`, "utf8"));
  assert.equal(config.ownerId, "owner-james-26b80231-cdeb-4ad9-bb02-850541005fff");
  assert.equal(config.agentId, "agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3");
  const keys = config.secretReferences.filter((x) => x.purpose === "payload-encryption");
  assert.equal(keys.length, 1);
  const key = keys[0];
  assert(/^[a-zA-Z0-9._-]+$/.test(key.ref) && /^[a-zA-Z0-9._-]+$/.test(key.version));
  const protector = new EnvelopePayloadProtector({
    keys: {
      resolve: async (ref, version) => {
        assert.equal(ref, key.ref);
        assert.equal(version, key.version);
        const raw = await readFile(`${root}/state/secrets/${ref}.${version}`);
        const text = raw.toString().trim();
        const bytes = /^[A-Za-z0-9+/]{43}=$/.test(text)
          ? Buffer.from(text, "base64")
          : /^[a-f0-9]{64}$/i.test(text)
            ? Buffer.from(text, "hex")
            : raw;
        assert.equal(bytes.length, 32);
        return bytes;
      },
    },
    activeKey: { keyRef: key.ref, kekVersion: key.version, dekVersion: "dek-v1" },
  });
  const db = new Database(`${root}/state/data/product.sqlite`, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  const scope = [config.ownerId, config.agentId];
  const payload = async (ref) => {
    const p = db
      .prepare(
        "SELECT * FROM payloads WHERE owner_id=? AND agent_id=? AND ref=? AND lifecycle_state='active'",
      )
      .get(...scope, ref);
    return decodePayload(p, protector, scope);
  };
  const sources = [];
  const allocations = db
    .prepare(
      "SELECT a.estimated_cost_micros,a.actual_cost_micros,a.status FROM model_budget_allocations a JOIN model_budget_accounts b ON b.owner_id=a.owner_id AND b.agent_id=a.agent_id AND b.account_id=a.account_id JOIN runs r ON r.owner_id=b.owner_id AND r.agent_id=b.agent_id AND r.id=b.run_id WHERE a.owner_id=? AND a.agent_id=? AND a.reserved_at>=? AND r.thread_id IN (?,?,?)",
    )
    .all(
      ...scope,
      "2026-09-12T11:20:03.000Z",
      "thread:67f83b5e-f5ab-4313-9efd-94f30e4d97b3",
      "thread:63599620-84b5-44d5-adc3-61c65cc83041",
      "thread-fork:dbd3edc2-bda1-49cb-b1f9-3e0a0428acfe",
    );
  assert(
    allocations.every((a) => a.status === "settled" || a.status === "released"),
    "PENDING_PRODUCT_MODEL_COST",
  );
  const productCostMicros = allocations.reduce(
    (sum, a) => sum + (a.status === "settled" ? a.actual_cost_micros : 0),
    0,
  );
  assert(Number.isFinite(productCostMicros) && productCostMicros >= 0);
  const priorComparison = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-input-comparison/summary.json`,
      "utf8",
    ),
  );
  assert.equal(priorComparison.status, "completed");
  assert.equal(priorComparison.results.length, 12);
  assert(priorComparison.results.every((r) => Number.isFinite(r.usage?.cost) && r.usage.cost >= 0));
  const priorComparisonCostMicros = Math.ceil(
    priorComparison.results.reduce((sum, r) => sum + r.usage.cost, 0) * 1e6,
  );
  try {
    for (const [id, threadId] of [
      [runId, "thread-fork:dbd3edc2-bda1-49cb-b1f9-3e0a0428acfe"],
      ["run:d1872f77-4434-405f-af8c-ecb3cfbb485c", "thread:63599620-84b5-44d5-adc3-61c65cc83041"],
    ]) {
      const run = db
        .prepare("SELECT thread_id FROM runs WHERE owner_id=? AND agent_id=? AND id=?")
        .get(...scope, id);
      assert.equal(run.thread_id, threadId);
      const refs = db
        .prepare(
          "SELECT payload_ref FROM run_payload_artifacts WHERE owner_id=? AND agent_id=? AND run_id=? AND purpose='trace' AND operation_key LIKE '%:provider_request:%' ORDER BY created_at",
        )
        .all(...scope, id);
      assert.equal(refs.length, 2);
      const original = await payload(refs[1].payload_ref);
      const jobs = db
        .prepare(
          "SELECT plan_json,facts_json FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND run_id=?",
        )
        .all(...scope, id);
      assert.equal(jobs.length, 4);
      assert.deepEqual(jobs.map((j) => JSON.parse(j.plan_json).operation).sort(), [
        "bash",
        "find",
        "grep",
        "ls",
      ]);
      assert(
        jobs.every((j) => {
          const f = JSON.parse(j.facts_json);
          return (
            f.resource?.cleanup === "confirmed" &&
            f.resource?.supervision === "released" &&
            f.result?.kind === "result"
          );
        }),
      );
      const lastUser = original.messages.findLastIndex((m) => m.role === "user");
      sources.push({
        id,
        original,
        messageStructure: original.messages.map((m, index) => ({
          index,
          role: m.role,
          toolCallId: m.tool_call_id ?? null,
          toolCalls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name })),
          content: summarize(m.content),
          reasoning: summarize(m.reasoning ?? m.reasoning_content ?? null),
        })),
        lastUser,
      });
    }
  } finally {
    db.close();
  }
  const derived = unfinishedReadInput(sources[1].original);
  sources.push({
    id: "synthetic:listing-before-script-read",
    derivedFrom: sources[1].id,
    original: derived,
    lastUser: derived.messages.findLastIndex((m) => m.role === "user"),
    messageStructure: derived.messages.map((m, index) => ({
      index,
      role: m.role,
      toolCallId: m.tool_call_id ?? null,
      toolCalls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name })),
      content: summarize(m.content),
    })),
  });
  const routeDescriptor = config.modelDescriptors.find((m) => m.ref === "model-fallback");
  assert.equal(routeDescriptor.model, modelId);
  assert.equal(routeDescriptor.providerRouting.allow_fallbacks, false);
  assert.equal(routeDescriptor.providerRouting.order.length, 1);
  const endpoint = routeDescriptor.providerRouting.order[0];
  for (const source of sources) assert.deepEqual(source.original.provider.order, [endpoint]);
  const catalog = await boundedJson(
    await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    }),
    1000000,
  );
  const selected = catalog.data.endpoints.find((e) => e.tag === endpoint && e.status === 0);
  assert(selected, "CONFIGURED_ENDPOINT_UNAVAILABLE");
  const unpriced = sources.flatMap((source) =>
    continuationGateInputs(source.original).map((input) => ({
      ...input,
      sourceRunId: source.id,
      provider: selected.provider_name,
      endpoint,
    })),
  );
  const inputs = priceProviderMatrix(unpriced, catalog.data.endpoints);
  assert.equal(inputs.length, 6);
  const maximumCostMicros = inputs.reduce((sum, input) => sum + input.maximumCostMicros, 0) * 2;
  assert(maximumCostMicros <= 500000, "COMPARISON_COST_LIMIT_EXCEEDED");
  const interrupted = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-provider-comparison/summary.json`,
      "utf8",
    ),
  );
  assert.equal(interrupted.status, "stopped");
  assert.equal(interrupted.errorType, "TimeoutError");
  const interruptedReserveMicros = interrupted.maximumCostMicros;
  assert(
    Number.isSafeInteger(interruptedReserveMicros) &&
      interruptedReserveMicros > 0 &&
      interruptedReserveMicros <= 500000,
  );
  const contentComparison = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-tool-content-comparison/summary.json`,
      "utf8",
    ),
  );
  assert.equal(contentComparison.status, "completed");
  assert.equal(contentComparison.results.length, 4);
  assert(
    contentComparison.results.every((r) => Number.isFinite(r.usage?.cost) && r.usage.cost >= 0),
  );
  const contentComparisonCostMicros = Math.ceil(
    contentComparison.results.reduce((sum, r) => sum + r.usage.cost, 0) * 1e6,
  );
  const matrix = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-provider-matrix/summary.json`,
      "utf8",
    ),
  );
  assert.equal(matrix.status, "completed");
  const matrixCostMicros = recordedCostUpper(matrix.results);
  const reminderComparison = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-task-context/summary.json`,
      "utf8",
    ),
  );
  assert.equal(reminderComparison.status, "completed");
  assert.equal(reminderComparison.results.length, 8);
  const reminderCostMicros = recordedCostUpper(reminderComparison.results);
  const priorFinalization = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-13-harness-finalization-comparison/summary.json`,
      "utf8",
    ),
  );
  assert.equal(priorFinalization.status, "completed");
  assert.equal(priorFinalization.results.length, 8);
  const priorFinalizationCostMicros = recordedCostUpper(priorFinalization.results);
  const searchReserveMicros = 250000;
  assert(
    productCostMicros +
      priorComparisonCostMicros +
      interruptedReserveMicros +
      contentComparisonCostMicros +
      matrixCostMicros +
      reminderCostMicros +
      priorFinalizationCostMicros +
      maximumCostMicros +
      searchReserveMicros <=
      2000000,
    "TOTAL_AUTHORIZED_COST_EXCEEDED",
  );
  const configured = config.modelDescriptors.filter(
    (m) => m.provider === "openrouter" && m.model === modelId,
  );
  assert.equal(configured.length, 1);
  const credentials = config.secretReferences.filter((s) => s.ref === configured[0].secretRef);
  assert.equal(credentials.length, 1);
  const credential = credentials[0];
  assert(/^[a-zA-Z0-9._-]+$/.test(credential.ref) && /^[a-zA-Z0-9._-]+$/.test(credential.version));
  const apiKey = (
    await readFile(`${root}/state/secrets/${credential.ref}.${credential.version}`, "utf8")
  ).trim();
  assert(apiKey.length > 20 && !apiKey.includes("\n"));
  // Exclusive directory is also the no-replay guard. An interrupted attempt is never retried automatically.
  await mkdir(out, { mode: 0o711 });
  const report = {
    startedAt: new Date().toISOString(),
    runId,
    model: modelId,
    maximumCostMicros,
    maximumCalls: 12,
    experiment: "explicit continuation gate with completed-task and unfinished-file-read controls",
    productionRouteChanged: false,
    configuredModel: {
      ref: configured[0].ref,
      model: configured[0].model,
      cost: configured[0].cost,
      maxTokens: configured[0].maxTokens,
      providerRouting: configured[0].providerRouting,
    },
    costPreflight: {
      productCostMicros,
      priorComparisonCostMicros,
      interruptedReserveMicros,
      contentComparisonCostMicros,
      matrixCostMicros,
      reminderCostMicros,
      priorFinalizationCostMicros,
      searchReserveMicros,
      authorizedMicros: 2000000,
    },
    sources: sources.map(({ original, ...metadata }) => ({
      ...metadata,
      requestSettings: {
        toolChoice: original.tool_choice ?? null,
        reasoning: original.reasoning ?? null,
        temperature: original.temperature ?? null,
        maxTokensRecorded: original.max_tokens ?? original.max_completion_tokens ?? null,
        providerRouting: original.provider ?? null,
      },
      historySha256: hash(JSON.stringify(original.messages)),
    })),
    productDatabaseReadOnly: true,
    executedTools: 0,
    results: [],
    status: "running",
  };
  const save = () =>
    writeFile(`${out}/summary.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o644 });
  await save();
  const unavailableProviders = new Set();
  try {
    for (let repetition = 0; repetition < 2; repetition++)
      for (const input of inputs) {
        const result = {
          repetition,
          sourceRunId: input.sourceRunId,
          variant: input.variant,
          maximumCostMicros: input.maximumCostMicros,
          requestedProvider: input.provider,
          requestedEndpoint: input.endpoint,
          requestSha256: hash(JSON.stringify(input.request)),
          status: "started",
          observedAt: new Date().toISOString(),
        };
        report.results.push(result);
        if (unavailableProviders.has(input.provider)) {
          result.status = "skipped_provider_failure";
          result.maximumCostMicros = 0;
          await save();
          continue;
        }
        await save();
        try {
          const response = await boundedJson(
            await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(240000),
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "X-OpenRouter-Title": "Himawari bounded finalization comparison",
              },
              body: JSON.stringify(input.request),
            }),
            1000000,
          );
          assert.equal(response.choices?.length, 1, "RESPONSE_CHOICE_INVALID");
          const choice = response.choices[0],
            message = choice.message;
          result.status = "completed";
          result.finishReason = choice.finish_reason;
          result.provider =
            typeof response.provider === "string" &&
            /^[a-zA-Z0-9 /_.-]{1,100}$/.test(response.provider)
              ? response.provider
              : null;
          result.responseModel =
            typeof response.model === "string" && /^[a-zA-Z0-9 /_.:-]{1,160}$/.test(response.model)
              ? response.model
              : null;
          result.content = summarize(message.content);
          result.answerPreview = redactMachineSecrets(
            typeof message.content === "string" ? message.content : "",
          ).slice(0, 2400);
          result.toolStatusMentions = ["ls", "find", "grep", "bash"].filter((name) =>
            new RegExp(`\\b${name}\\b`).test(message.content ?? ""),
          );
          result.successMentioned = /成功|succeeded|success/i.test(message.content ?? "");
          result.oldWriteMentioned = /acceptance-morning|晨光计划验收|执行结果尚未确认/.test(
            message.content ?? "",
          );
          result.toolsRequested = (message.tool_calls ?? []).map((c) => ({
            name: c.function?.name,
            arguments: summarize(c.function?.arguments),
          }));
          result.continuationRequests = (message.tool_calls ?? [])
            .filter((c) => c.function?.name === "continue_work")
            .map((c) => {
              try {
                const a = JSON.parse(c.function.arguments);
                return {
                  reason: redactMachineSecrets(typeof a.reason === "string" ? a.reason : "").slice(
                    0,
                    600,
                  ),
                  toolNames: Array.isArray(a.toolNames)
                    ? a.toolNames
                        .filter((n) => typeof n === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(n))
                        .slice(0, 20)
                    : [],
                };
              } catch {
                return { invalidArguments: true };
              }
            });
          result.usage = {
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            cost: response.usage?.cost,
          };
          await save();
          assert.equal(result.provider, input.provider, "UNEXPECTED_PROVIDER");
        } catch (error) {
          result.status = "request_failed";
          result.errorType = error?.name ?? "Error";
          unavailableProviders.add(input.provider);
          if (
            /^(?:HTTP_STATUS_\d{3}|RESPONSE_CHOICE_INVALID|RESPONSE_TOO_LARGE|UNEXPECTED_PROVIDER)$/.test(
              error?.message ?? "",
            )
          )
            result.errorCode = error.message;
          // Keep the complete preflight reserve when the response or its cost is unknown.
        }
        result.finishedAt = new Date().toISOString();
        report.costUpperBoundMicros = recordedCostUpper(report.results);
        await save();
        assert(report.costUpperBoundMicros <= maximumCostMicros, "ACTUAL_COST_EXCEEDED_ESTIMATE");
        assert(
          !["UNEXPECTED_PROVIDER", "HTTP_STATUS_401", "HTTP_STATUS_403"].includes(result.errorCode),
          "ROUTING_OR_AUTHENTICATION_REJECTED",
        );
      }
    report.status = "completed";
  } catch (error) {
    report.status = "stopped";
    report.errorType = error?.name ?? "Error";
    if (
      /^(?:HTTP_STATUS_\d{3}|ACTUAL_COST_UNAVAILABLE|ACTUAL_COST_EXCEEDED_ESTIMATE|RESPONSE_CHOICE_INVALID|RESPONSE_TOO_LARGE|UNEXPECTED_PROVIDER)$/.test(
        error?.message ?? "",
      )
    )
      report.errorCode = error.message;
    // Never export an HTTP response body, arbitrary exception text, or any credential.
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log("Continuation gate comparison written: " + out + "/summary.json");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
