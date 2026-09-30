import { appendFileSync } from "node:fs";

export function markMcpStartup(stage) {
  const target = process.env["HIMAWARI_MCP_TEST_TIMING_PATH"];
  if (target)
    appendFileSync(
      target,
      `${JSON.stringify({ stage, pid: process.pid, at: Date.now(), uptimeMs: process.uptime() * 1000 })}\n`,
      { mode: 0o600 },
    );
}

markMcpStartup("preload_entered");

const delayMs = Number(process.env["HIMAWARI_MCP_TEST_STARTUP_DELAY_MS"] ?? 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
