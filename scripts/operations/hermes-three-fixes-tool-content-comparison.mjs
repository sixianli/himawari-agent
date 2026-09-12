import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decodePayload, summarize } from "./hermes-three-fixes-model-diagnostic.mjs";
const root = "/data/hermes/himawari";
const runtime = `${root}/releases/2026-09-11-control-center/lib/himawari-agent`;
const out = `${root}/qualifications/2026-09-12-three-fixes-tool-content-comparison`;
const runId = "run:cb547c58-80ea-42e6-8b90-4cfac81dcdf2";
const modelId = "deepseek/deepseek-v4-flash-0731";
const hash = (value) => createHash("sha256").update(value).digest("hex");
import {
  providerComparisonInputs,
  estimateProviderMaximumMicros,
} from "./hermes-three-fixes-provider-comparison.mjs";
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
  assert.deepEqual(process.argv.slice(2), ["--compare"]);
  assert.equal(
    hash(await readFile(new URL("./hermes-three-fixes-model-diagnostic.mjs", import.meta.url))),
    "977c5291adc22f4b165e530ee60a8ac676012627d2a9d9ad510080ed530f970d",
  );
  assert.equal(
    hash(await readFile(new URL("./hermes-three-fixes-provider-comparison.mjs", import.meta.url))),
    "63f193a363de43fd3b4a26456a9e509f903d77136a42d36886437bae7e93d799",
  );
  const require = createRequire(`${runtime}/package.json`);
  const { EnvelopePayloadProtector } = require("@himawari-agent/platform-node");
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
      [
        "run:cb547c58-80ea-42e6-8b90-4cfac81dcdf2",
        "thread-fork:dbd3edc2-bda1-49cb-b1f9-3e0a0428acfe",
      ],
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
      assert.equal(original.messages.length, 61);
      assert.equal(original.messages[55].role, "user");
      assert.deepEqual(
        original.messages.slice(57).map((m) => m.tool_call_id),
        [
          "chatcmpl-tool-9490c6b5116dad78",
          "chatcmpl-tool-8573d0a20637982f",
          "chatcmpl-tool-953ff9eb635563fd",
          "chatcmpl-tool-97c7e57f54bb83d9",
        ],
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
  const inputs = sources.flatMap((source) =>
    providerComparisonInputs(source.original)
      .filter((input) => input.provider === "OpenInference")
      .map((input) => ({ ...input, sourceRunId: source.id })),
  );
  const catalog = await boundedJson(
    await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    }),
    1000000,
  );
  const maximumCostMicros = estimateProviderMaximumMicros(inputs, catalog.data.endpoints);
  assert(maximumCostMicros <= 500000, "COMPARISON_COST_LIMIT_EXCEEDED");
  assert.equal(inputs.length, 2);
  const interruptedComparison = JSON.parse(
    await readFile(
      `${root}/qualifications/2026-09-12-three-fixes-provider-comparison/summary.json`,
      "utf8",
    ),
  );
  assert.equal(interruptedComparison.status, "stopped");
  assert.equal(interruptedComparison.errorType, "TimeoutError");
  assert.equal(interruptedComparison.results.length, 2);
  const interruptedComparisonReserveMicros = interruptedComparison.maximumCostMicros;
  assert(
    Number.isSafeInteger(interruptedComparisonReserveMicros) &&
      interruptedComparisonReserveMicros > 0 &&
      interruptedComparisonReserveMicros <= 500000,
  );
  const searchReserveMicros = 250000;
  assert(
    productCostMicros +
      priorComparisonCostMicros +
      interruptedComparisonReserveMicros +
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
    maximumCalls: 4,
    costPreflight: {
      productCostMicros,
      priorComparisonCostMicros,
      interruptedComparisonReserveMicros,
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
  try {
    for (let repetition = 0; repetition < 2; repetition++)
      for (const input of inputs) {
        const result = {
          repetition,
          sourceRunId: input.sourceRunId,
          variant: input.variant,
          requestedProvider: input.provider,
          requestSha256: hash(JSON.stringify(input.request)),
          status: "started",
          observedAt: new Date().toISOString(),
        };
        report.results.push(result);
        await save();
        const response = await boundedJson(
          await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(90000),
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-OpenRouter-Title": "Himawari bounded tool content comparison",
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
        result.content = summarize(message.content);
        result.toolStatusMentions = ["ls", "find", "grep", "bash"].filter((name) =>
          new RegExp(`\\b${name}\\b`).test(message.content ?? ""),
        );
        result.successMentioned = /成功|succeeded|success/i.test(message.content ?? "");
        result.weatherMentioned = /天気|天气|気温|气温|℃|摄氏/.test(message.content ?? "");
        result.oldWriteMentioned = /acceptance-morning|晨光计划验收|执行结果尚未确认/.test(
          message.content ?? "",
        );
        result.toolsRequested = (message.tool_calls ?? []).map((c) => ({
          name: c.function?.name,
          arguments: summarize(c.function?.arguments),
        }));
        result.usage = {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          cost: response.usage?.cost,
        };
        await save();
        assert.equal(result.provider, input.provider, "UNEXPECTED_PROVIDER");
        assert(
          Number.isFinite(result.usage.cost) && result.usage.cost >= 0,
          "ACTUAL_COST_UNAVAILABLE",
        );
        assert(
          report.results.reduce((total, r) => total + (r.usage?.cost ?? 0), 0) * 1e6 <=
            maximumCostMicros,
          "ACTUAL_COST_EXCEEDED_ESTIMATE",
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
  console.log("Tool content comparison written: " + out + "/summary.json");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
