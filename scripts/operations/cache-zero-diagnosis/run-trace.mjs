import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { EnvelopePayloadProtector, RestrictedSecretFileSource } from "@himawari-agent/platform-node";

const [configPath, secretDir, threadId, lastRuns = "2"] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const key = config.secretReferences.find((s) => s.purpose === "payload-encryption");
const protector = new EnvelopePayloadProtector({
  keys: new RestrictedSecretFileSource(secretDir),
  activeKey: { keyRef: key.ref, kekVersion: key.version, dekVersion: "dek-v1" },
});
const db = new BetterSqlite3(path.join(config.stateRoot, "data", "product.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
const owner = config.ownerId;
const agent = config.agentId;
const payloadRow = db.prepare(
  `SELECT ref, classification, content_type AS contentType, ciphertext,
     encryption_metadata_json AS meta, content_digest AS digest, created_at AS createdAt
   FROM payloads WHERE owner_id=? AND agent_id=? AND ref=?`,
);
async function read(ref) {
  if (typeof ref !== "string") return undefined;
  const row = payloadRow.get(owner, agent, ref);
  if (!row || !row.ciphertext) return undefined;
  const bytes = await protector.unprotect({
    ownerId: owner,
    agentId: agent,
    payload: {
      ref: row.ref,
      dataClassification: row.classification,
      contentType: row.contentType,
      ciphertext: new Uint8Array(row.ciphertext),
      encryption: JSON.parse(row.meta),
      contentDigest: row.digest,
      createdAt: row.createdAt,
    },
  });
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const clip = (value, n) => {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
};
const ends = (value, n) => {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > 2 * n ? { head: s.slice(0, n), tail: s.slice(-n), chars: s.length } : { all: s, chars: s.length };
};
const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const commonPrefix = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
};
const firstDiff = (prev, next) => {
  const pm = prev?.messages ?? [];
  const nm = next?.messages ?? [];
  for (let i = 0; i < Math.min(pm.length, nm.length); i += 1) {
    const a = JSON.stringify(pm[i]);
    const b = JSON.stringify(nm[i]);
    if (a !== b) {
      const at = commonPrefix(a, b);
      return { messageIndex: i, role: nm[i]?.role, prev: a.slice(Math.max(0, at - 80), at + 160), next: b.slice(Math.max(0, at - 80), at + 160) };
    }
  }
  return pm.length <= nm.length ? null : { messageIndex: nm.length, note: "next request has fewer messages" };
};
const runs = db
  .prepare(
    `SELECT id, status, created_at AS createdAt FROM runs
     WHERE owner_id=? AND agent_id=? AND thread_id=? ORDER BY created_at`,
  )
  .all(owner, agent, threadId);
const report = { threadId, runCount: runs.length, runs: [] };
for (const run of runs.slice(-Number(lastRuns))) {
  const events = db
    .prepare(
      `SELECT sequence, event_type AS type, payload_ref AS ref, occurred_at AS at
       FROM trace_events WHERE run_id=? ORDER BY sequence`,
    )
    .all(run.id);
  const out = {
    run: run.id,
    status: run.status,
    createdAt: run.createdAt,
    firstEventAt: events[0]?.at,
    lastEventAt: events.at(-1)?.at,
    eventTypes: {},
    prompt: null,
    context: null,
    timeline: [],
    requests: [],
  };
  let lastAt = run.createdAt;
  let prevRequest = null;
  let prevSerialized = "";
  let pendingRequest = null;
  for (const event of events) {
    out.eventTypes[event.type] = (out.eventTypes[event.type] ?? 0) + 1;
    const envelope = await read(event.ref).catch((e) => ({ error: String(e?.message ?? e) }));
    const row = { type: event.type, at: event.at, sinceStartMs: ms(run.createdAt, event.at), gapMs: ms(lastAt, event.at) };
    lastAt = event.at;
    if (event.type === "context.formed") {
      out.prompt = clip(await read(envelope?.trigger?.payloadRef).catch(() => null), 300);
      out.context = {
        keys: Object.keys(envelope ?? {}),
        selectedMemories: envelope?.selectedMemories?.length ?? null,
        historyItems: envelope?.threadHistory?.length ?? null,
      };
    }
    if (event.type === "runtime.provider_observation") {
      const value = await read(envelope?.payloadRef).catch((e) => ({ error: String(e?.message ?? e) }));
      if (envelope?.phase === "request") {
        const serialized = JSON.stringify({ tools: value?.tools, messages: value?.messages });
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        pendingRequest = {
          index: out.requests.length,
          requestAt: event.at,
          model: value?.model,
          reasoning: value?.reasoning ?? value?.reasoning_effort ?? null,
          providerOptions: value?.providerOptions ?? null,
          payloadKeys: Object.keys(value ?? {}),
          messageCount: messages.length,
          requestChars: serialized.length,
          toolCount: (value?.tools ?? []).length,
          sharedPrefixCharsWithPrevious: commonPrefix(prevSerialized, serialized),
          previousRequestChars: prevSerialized.length,
          previousIsStrictPrefix: prevRequest ? prevSerialized.slice(0, -2).length <= commonPrefix(prevSerialized, serialized) : null,
          firstDifference: prevRequest ? firstDiff(prevRequest, value) : null,
        };
        if (out.requests.length === 0) {
          pendingRequest.systemPromptHead = clip(messages[0]?.content, 400);
          pendingRequest.lastUserMessage = clip(messages.at(-1)?.content, 3000);
        }
        out.requests.push(pendingRequest);
        prevRequest = value;
        prevSerialized = serialized;
        row.note = `request #${pendingRequest.index}`;
      } else {
        if (pendingRequest) {
          pendingRequest.responseHeadersAt = event.at;
          pendingRequest.timeToHeadersMs = ms(pendingRequest.requestAt, event.at);
          pendingRequest.status = value?.status;
          const h = value?.headers ?? {};
          pendingRequest.headers = Object.fromEntries(
            Object.entries(h).filter(([k]) => /vercel|provider|ratelimit|x-request|server|date|cf-ray|openrouter|model/i.test(k)),
          );
        }
        row.note = "response headers";
      }
    }
    if (event.type === "runtime.message" && envelope?.role === "assistant" && envelope?.phase === "ended") {
      const message = await read(envelope.payloadRef);
      const content = Array.isArray(message?.content) ? message.content : [];
      const u = message?.usage ?? {};
      const step = {
        endedAt: event.at,
        provider: message?.provider,
        model: message?.model,
        responseModel: message?.responseModel ?? null,
        stopReason: message?.stopReason,
        usage: u,
        thinkingChars: content.filter((p) => p?.type === "thinking").reduce((n, p) => n + String(p.thinking ?? "").length, 0),
        textChars: content.filter((p) => p?.type === "text").reduce((n, p) => n + String(p.text ?? "").length, 0),
        thinking: ends(content.filter((p) => p?.type === "thinking").map((p) => p.thinking).join("\n"), 700),
        text: ends(content.filter((p) => p?.type === "text").map((p) => p.text).join(""), 1500),
        toolCalls: content
          .filter((p) => p?.type === "toolCall")
          .map((p) => ({ name: p.name, argumentChars: JSON.stringify(p.arguments ?? "").length, arguments: clip(p.arguments, 16000) })),
      };
      if (pendingRequest) {
        step.requestToEndMs = ms(pendingRequest.requestAt, event.at);
        step.streamMs = ms(pendingRequest.responseHeadersAt, event.at);
        pendingRequest.result = step;
      } else out.timeline.push({ orphanAssistant: step });
      row.note = `assistant ended (${step.toolCalls.map((c) => c.name).join(",") || "text"})`;
    }
    if (event.type === "runtime.tool_result") {
      const tool = await read(envelope?.payloadRef);
      const details = tool?.result?.details ?? {};
      const timing = details.executionTiming ?? {};
      const output = Array.isArray(tool?.result?.content)
        ? tool.result.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
      row.tool = {
        name: tool?.toolName,
        toolMs: ms(timing.startedAt, timing.endedAt),
        timing,
        outcome: details.productOutcome ?? (tool?.isError ? "error" : "ok"),
        errorCode: details.errorCode ?? null,
        detailKeys: Object.keys(details),
        output: ends(output, 1200),
      };
    }
    out.timeline.push(row);
  }
  const t = { modelCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, modelMs: 0, timeToHeadersMs: 0, toolMs: 0 };
  for (const r of out.requests) {
    const u = r.result?.usage ?? {};
    t.modelCalls += 1;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) t[k] += Number(u[k] ?? 0) || 0;
    t.costUsd += Number(u.cost?.total ?? 0) || 0;
    t.modelMs += r.result?.requestToEndMs ?? 0;
    t.timeToHeadersMs += r.timeToHeadersMs ?? 0;
    r.cacheHitRate = u.input || u.cacheRead ? Number(((u.cacheRead ?? 0) / ((u.input ?? 0) + (u.cacheRead ?? 0))).toFixed(3)) : null;
  }
  for (const row of out.timeline) t.toolMs += row.tool?.toolMs ?? 0;
  t.wallMs = ms(run.createdAt, out.lastEventAt);
  t.cacheHitRate = t.input + t.cacheRead ? Number((t.cacheRead / (t.input + t.cacheRead)).toFixed(3)) : null;
  out.totals = t;
  report.runs.push(out);
}
db.close();
console.log(JSON.stringify(report, null, 2));
