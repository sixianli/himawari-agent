import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import type { MessageId } from "../i18n/message-ids.js";

type Message = (id: MessageId, values?: Record<string, string>) => string;
type McpConnectionItem = Extract<
  GatewayV2Snapshot,
  { type: "mcp.connections.snapshot" }
>["payload"]["connections"][number];

export function McpUsageLines({
  usage,
  message,
}: {
  usage: McpConnectionItem["usage"];
  message: Message;
}) {
  const n = (value: number) => String(value);
  return (
    <ul className="mcp-usage">
      <li>
        {message("agents.stat.reads", { n: n(usage.reads) })}
        {usage.reads > 0
          ? ` (${usage.readsByTool
              .filter(({ calls }) => calls > 0)
              .map(({ tool, calls }) => message("agents.stat.byTool", { tool, n: n(calls) }))
              .join(" · ")})`
          : ""}
      </li>
      <li>{message("agents.stat.delivered", { n: n(usage.delivered) })}</li>
      <li>{message("agents.stat.empty", { n: n(usage.empty) })}</li>
      <li>
        {message("agents.stat.auto", {
          n: n(usage.autoReads),
          delivered: n(usage.autoDelivered),
        })}
      </li>
      <li>{message("agents.stat.model", { n: n(usage.modelReads) })}</li>
      <li>{message("agents.stat.pushes", { n: n(usage.memoryPushes) })}</li>
      <li>
        {message("agents.stat.rules", {
          n: n(usage.ruleProposals),
          limited: n(usage.ruleProposalsRateLimited),
        })}
      </li>
      <li>{message("agents.stat.failed", { n: n(usage.failed) })}</li>
      <li>{message("agents.stat.limited", { n: n(usage.rateLimited) })}</li>
    </ul>
  );
}
