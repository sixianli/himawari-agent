import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decodePayload, summarize } from "./hermes-three-fixes-model-diagnostic.mjs";
const root = "/data/hermes/himawari";
const runtime = `${root}/releases/2026-09-11-control-center/lib/himawari-agent`;
const out = `${root}/qualifications/2026-09-12-three-fixes-input-comparison`;
const runId = "run:a7f2c922-14bb-4516-9525-feaa6ad4354e";
const modelId = "deepseek/deepseek-v4-flash-0731";
const hash = (value) => createHash("sha256").update(value).digest("hex");
// Experimental copies only. Never rewrite stored history or execute returned tools.
export function comparisonInputs(original) {
  assert.equal(original.model, modelId);
  assert(Array.isArray(original.messages));
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  assert(lastUser > 0 && original.messages.at(-1).role === "tool");
  const copies = ["original", "without_prior_plaintext_reasoning", "current_turn_only"].map(
    (variant) => {
      const request = structuredClone(original);
      request.stream = false;
      delete request.stream_options;
      delete request.max_completion_tokens;
      request.max_tokens = 2048;
      if (variant === "without_prior_plaintext_reasoning") {
        for (const message of request.messages.slice(0, lastUser)) {
          if (message.role !== "assistant") continue;
          for (const field of ["reasoning", "reasoning_content", "reasoning_text"])
            delete message[field];
          // Do not alter encrypted or signed reasoning; this experiment is plaintext only.
          assert(!message.reasoning_details, "SIGNED_REASONING_NOT_ELIGIBLE");
        }
      }
      if (variant === "current_turn_only") {
        request.messages = [
          ...request.messages.filter((m) => m.role === "system"),
          ...request.messages.slice(lastUser),
        ];
      }
      return { variant, request };
    },
  );
  return copies;
}
export function estimateMaximumMicros(inputs, pricing) {
  const prompt = Number(pricing.prompt),
    completion = Number(pricing.completion);
  assert(Number.isFinite(prompt) && prompt > 0 && Number.isFinite(completion) && completion > 0);
  // Deliberately conservative byte-based input allowance, plus protocol overhead.
  return (
    inputs.reduce(
      (sum, { request }) =>
        sum +
        Math.ceil(
          ((Buffer.byteLength(JSON.stringify(request)) * 2 + 32768) * prompt + 2048 * completion) *
            1e6,
        ),
      0,
    ) * 2
  );
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
  assert.deepEqual(process.argv.slice(2), ["--compare"]);
  assert.equal(
    hash(await readFile(new URL("./hermes-three-fixes-model-diagnostic.mjs", import.meta.url))),
    "977c5291adc22f4b165e530ee60a8ac676012627d2a9d9ad510080ed530f970d",
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
  try {
    for (const [id, threadId] of [
      [runId, "thread:67f83b5e-f5ab-4313-9efd-94f30e4d97b3"],
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
      if (id === runId) {
        assert.equal(original.messages.length, 58);
        assert.equal(original.messages[55].role, "user");
        assert.equal(original.messages[57].tool_call_id, "chatcmpl-tool-9084fcb0341acf30");
        assert.equal(
          summarize(original.messages[57].content).textSha256,
          "aae8e6c7937563475c32e313955ac45ca9b9a8a1973fc10f7ceb7e94a8502b9a",
        );
      }
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
    comparisonInputs(source.original).map((input) => ({ ...input, sourceRunId: source.id })),
  );
  const catalog = await boundedJson(
    await fetch("https://openrouter.ai/api/v1/models", {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    }),
    12000000,
  );
  const descriptor = catalog.data.find((m) => m.id === modelId);
  assert(descriptor, "MODEL_NOT_IN_CURRENT_CATALOG");
  for (const { request } of inputs) {
    const previous = request.provider?.max_price ?? {};
    request.provider = {
      ...request.provider,
      max_price: {
        prompt: Math.min(
          Number(previous.prompt ?? Infinity),
          Number(descriptor.pricing.prompt) * 1e6,
        ),
        completion: Math.min(
          Number(previous.completion ?? Infinity),
          Number(descriptor.pricing.completion) * 1e6,
        ),
        request: 0,
      },
    };
  }
  const maximumCostMicros = estimateMaximumMicros(inputs, descriptor.pricing);
  assert(maximumCostMicros <= 500000, "COMPARISON_COST_LIMIT_EXCEEDED");
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
    sources: sources.map(({ original, ...metadata }) => metadata),
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
              "X-OpenRouter-Title": "Himawari bounded input comparison",
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
      /^(?:HTTP_STATUS_\d{3}|ACTUAL_COST_UNAVAILABLE|ACTUAL_COST_EXCEEDED_ESTIMATE|RESPONSE_CHOICE_INVALID|RESPONSE_TOO_LARGE)$/.test(
        error?.message ?? "",
      )
    )
      report.errorCode = error.message;
    // Never export an HTTP response body, arbitrary exception text, or any credential.
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log("Input comparison written: " + out + "/summary.json");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
