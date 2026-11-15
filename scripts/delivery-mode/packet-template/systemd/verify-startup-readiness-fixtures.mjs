import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./S7-startup-readback.mjs", import.meta.url), "utf8");
const start = source.indexOf("function startupReadiness(");
const end = source.indexOf("\n}\n", start);
assert(start > 0 && end > start, "STARTUP_READINESS_FUNCTION_NOT_FOUND");
const budget = /^const startupReadyBudgetMs = ([0-9]+);$/m.exec(source);
assert(budget, "STARTUP_READY_BUDGET_NOT_RENDERED");
const budgetMs = Number(budget[1]);
assert(Number.isSafeInteger(budgetMs) && budgetMs > 0, "STARTUP_READY_BUDGET_INVALID");
const startupReadiness = new Function("assert", `${source.slice(start, end + 2)}\nreturn startupReadiness;`)(assert);
const journalFile = process.argv[2];
if (journalFile) {
  const rows = readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  process.stdout.write(`${JSON.stringify(startupReadiness(rows, budgetMs))}\n`);
  process.exit(0);
}

const base = 1_793_200_000_000_000;
function journal({ workerReadyMs, agentReadyMs, dropTimestamp = false, extraReady = false }) {
  const entry = (offsetMs, message) => ({
    __REALTIME_TIMESTAMP: dropTimestamp && message.event === "service.ready" ? undefined : String(base + offsetMs * 1000),
    MESSAGE: JSON.stringify(message),
  });
  const rows = [
    entry(0, { component: "pair-supervisor", event: "pair.child_spawned", name: "worker" }),
    entry(40, { component: "pair-supervisor", event: "pair.child_spawned", name: "agent" }),
    { __REALTIME_TIMESTAMP: String(base + 500_000), MESSAGE: "plain text line" },
    entry(agentReadyMs, { component: "agent-service", event: "service.ready" }),
    entry(workerReadyMs, { component: "execution-worker", event: "service.ready" }),
  ];
  if (extraReady) rows.push(entry(agentReadyMs + 10, { component: "agent-service", event: "service.ready" }));
  return rows;
}

const cases = [
  { name: "both ready well inside the budget", input: { workerReadyMs: Math.floor(budgetMs / 2), agentReadyMs: Math.floor(budgetMs / 2) - 100 }, expected: { startupReadyMs: Math.floor(budgetMs / 2) } },
  { name: "ready exactly at the budget", input: { workerReadyMs: budgetMs, agentReadyMs: budgetMs - 5 }, expected: { startupReadyMs: budgetMs } },
  { name: "agent ready long after the worker", input: { workerReadyMs: budgetMs + 20_050, agentReadyMs: budgetMs + 20_000 }, refused: `_STARTUP_READY_TOO_SLOW:${budgetMs + 20_050}` },
  { name: "one past the budget", input: { workerReadyMs: budgetMs + 1, agentReadyMs: 1_000 }, refused: `_STARTUP_READY_TOO_SLOW:${budgetMs + 1}` },
  { name: "ready line without a journal time", input: { workerReadyMs: 5_000, agentReadyMs: 5_000, dropTimestamp: true }, refused: "_STARTUP_READY_TIMES_MISSING" },
  { name: "agent reported ready twice", input: { workerReadyMs: 5_000, agentReadyMs: 5_000, extraReady: true }, refused: "_STARTUP_READY_TIMES_MISSING" },
];
for (const item of cases) {
  if (item.refused) {
    assert.throws(() => startupReadiness(journal(item.input), budgetMs), (error) => error.message.endsWith(item.refused), item.name);
  } else {
    assert.deepEqual(startupReadiness(journal(item.input), budgetMs), { ...item.expected, startupReadyBudgetMs: budgetMs }, item.name);
  }
  process.stdout.write(`STARTUP_READINESS_FIXTURE_PASSED ${item.name}\n`);
}
process.stdout.write(`STARTUP_READINESS_FIXTURES_PASSED ${cases.length} budgetMs=${budgetMs}\n`);

const failureStart = source.indexOf("function startupFailureEvents(");
const failureEnd = source.indexOf("\n}\n", failureStart);
assert(failureStart > 0 && failureEnd > failureStart, "STARTUP_FAILURE_EVENTS_FUNCTION_NOT_FOUND");
const startupFailureEvents = new Function(`${source.slice(failureStart, failureEnd + 2)}\nreturn startupFailureEvents;`)();
assert.deepEqual(startupFailureEvents([
  { component: "agent-service", event: "memory.embedding_catch_up_failed", code: "EMBEDDING_LOCAL_UNAVAILABLE", retryInMs: "30000" },
  { component: "agent-service", event: "memory.embedding_catch_up_failed", code: "EMBEDDING_LOCAL_UNAVAILABLE" },
  { component: "agent-service", event: "service.ready" },
]), [], "RETRYABLE_STARTUP_DIAGNOSTICS_MUST_NOT_FAIL_THE_SWITCH");
assert.deepEqual(startupFailureEvents([
  { component: "pair-supervisor", event: "pair.child_exit", name: "agent", code: 1 },
  { component: "agent-service", event: "sandbox_runtime.content_audit_retryable" },
  { component: "agent-service", event: "service.failed" },
  { component: "agent-service", event: "sandbox.srt_prewarm.failed" },
  { component: "agent-service", event: "authority.lost" },
  { component: "agent-service", event: "future.sync_failed", retryInMs: "1000" },
]), ["pair.child_exit", "sandbox_runtime.content_audit_retryable", "service.failed", "sandbox.srt_prewarm.failed", "authority.lost", "future.sync_failed"], "FATAL_STARTUP_EVENTS_MUST_STILL_FAIL_THE_SWITCH");
process.stdout.write("STARTUP_FAILURE_EVENT_FIXTURES_PASSED 2\n");
