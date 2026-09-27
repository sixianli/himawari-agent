import type { RunPolicyConfiguration } from "@himawari-agent/application";
import type { ThreadExecutionEnvironment } from "@himawari-agent/gateway-contracts";

type UnavailableTool = ThreadExecutionEnvironment["unavailableTools"][number];
interface SandboxTool {
  readonly toolName: string;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly operations: readonly string[];
}

function configuredSandboxTools(runPolicy: RunPolicyConfiguration | undefined): SandboxTool[] {
  const tools: SandboxTool[] = [];
  const coding = runPolicy?.coding;
  if (runPolicy?.fileRead && !coding?.enabledTools.includes("read"))
    tools.push({
      toolName: "read",
      capabilityRef: runPolicy.fileRead.capabilityRef,
      capabilityVersion: runPolicy.fileRead.capabilityVersion,
      operations: ["inspect", "read"],
    });
  if (coding)
    for (const toolName of coding.enabledTools)
      tools.push({
        toolName,
        capabilityRef: coding.capabilityRef,
        capabilityVersion: coding.capabilityVersion,
        operations: [toolName],
      });
  if (runPolicy?.publicSearch)
    tools.push({
      toolName: "web_search",
      capabilityRef: runPolicy.publicSearch.capabilityRef,
      capabilityVersion: runPolicy.publicSearch.capabilityVersion,
      operations: ["web_search"],
    });
  return tools;
}

export async function strictModeUnavailableTools(input: {
  readonly runPolicy: RunPolicyConfiguration | undefined;
  readonly refusal: (operation: {
    readonly capabilityRef: string;
    readonly capabilityVersion: string;
    readonly operation: string;
  }) => Promise<UnavailableTool["reasonCode"] | null>;
}): Promise<UnavailableTool[]> {
  const unavailable: UnavailableTool[] = [];
  for (const tool of configuredSandboxTools(input.runPolicy))
    for (const operation of tool.operations) {
      const reasonCode = await input.refusal({
        capabilityRef: tool.capabilityRef,
        capabilityVersion: tool.capabilityVersion,
        operation,
      });
      if (reasonCode) {
        unavailable.push({ toolName: tool.toolName, reasonCode });
        break;
      }
    }
  return unavailable;
}
