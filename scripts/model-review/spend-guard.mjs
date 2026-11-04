import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const GUARD_ENV = "HIMAWARI_SPEND_GUARD";
export const GUARD_STOP_PREFIX = "REVIEW_SPEND_GUARD_STOP";
export const UNGUARDED_AGENTS = ["title"];

export function guardDecision(limits, state, now = Date.now()) {
  if (state.cost > limits.totalUsd) return "cost-limit";
  if (limits.stopAtUsd !== undefined && state.allowed > 0 && state.cost >= limits.stopAtUsd)
    return "wrap-up-cost";
  if (limits.deadlineAt !== undefined && now >= limits.deadlineAt) return "timeout";
  if (limits.wrapUpAt !== undefined && now >= limits.wrapUpAt) return "wrap-up-time";
  if (limits.stopAfterRequests !== undefined && state.allowed >= limits.stopAfterRequests)
    return "request-limit";
  return null;
}

export function ledgerTotal(ledger) {
  let total = 0;
  for (const entry of ledger.values()) total += entry.cost;
  return total;
}

export function completedCount(ledger) {
  let count = 0;
  for (const entry of ledger.values()) if (entry.done) count += 1;
  return count;
}

export function noteCost(ledger, info) {
  if (info?.role !== "assistant" || typeof info.id !== "string") return;
  if (!Number.isFinite(info.cost) || info.cost < 0) return;
  const entry = ledger.get(info.id) ?? { cost: 0, done: false };
  ledger.set(info.id, {
    cost: Math.max(entry.cost, info.cost),
    done: entry.done || Boolean(info.time?.completed),
  });
}

function writeMarker(path, marker) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(marker));
  renameSync(temporary, path);
}

export const SpendGuard = async () => {
  const limitsPath = process.env[GUARD_ENV];
  if (!limitsPath) return {};
  const limits = JSON.parse(readFileSync(limitsPath, "utf8"));
  const ledger = new Map();
  const state = { cost: 0, allowed: 0, reason: null };
  const publish = () =>
    writeMarker(limits.markerPath, {
      loaded: true,
      reason: state.reason,
      totalCostUsd: state.cost,
      allowed: state.allowed,
      completed: completedCount(ledger),
      at: Date.now(),
    });
  publish();
  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      noteCost(ledger, event.properties?.info);
      if (state.allowed > 0) {
        state.cost = ledgerTotal(ledger);
        publish();
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of output.messages) noteCost(ledger, message.info);
    },
    "chat.params": async (input) => {
      if (UNGUARDED_AGENTS.includes(input.agent)) return;
      state.cost = ledgerTotal(ledger);
      const reason = guardDecision(limits, state);
      if (reason) {
        state.reason = reason;
        publish();
        throw new Error(`${GUARD_STOP_PREFIX} ${reason}`);
      }
      state.allowed += 1;
      publish();
    },
  };
};

export default { id: "himawari-spend-guard", server: SpendGuard };
