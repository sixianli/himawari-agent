import type { ThreadExecutionEnvironment } from "@himawari-agent/gateway-contracts";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { SandboxExecutionPreparationPort } from "../ports/sandbox-execution-journal.js";

export async function readThreadExecutionEnvironment(input: {
  readonly programs: Pick<SandboxExecutionPreparationPort, "listRunningPrograms">;
  readonly mode: ThreadExecutionEnvironment["mode"];
  readonly unavailableTools: () => Promise<ThreadExecutionEnvironment["unavailableTools"]>;
  readonly pageSize?: number;
  readonly maximumPrograms?: number;
}): Promise<ThreadExecutionEnvironment> {
  const pageSize = input.pageSize ?? 100;
  const maximumPrograms = input.maximumPrograms ?? 1000;
  const programs: ThreadExecutionEnvironment["programs"][number][] = [];
  let afterJobId: string | null = null;
  for (;;) {
    const page = await input.programs.listRunningPrograms({ afterJobId, limit: pageSize });
    for (const record of page) {
      if (record.plan.mode === "foreground" || record.startedAt === null)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "THREAD_EXECUTION_ENVIRONMENT_RECORD_INVALID",
        );
      programs.push({
        threadId: record.plan.identity.threadId,
        kind: record.plan.mode,
        toolName: record.plan.operation,
        startedAt: record.startedAt,
      });
    }
    if (programs.length > maximumPrograms)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "THREAD_EXECUTION_ENVIRONMENT_LIMIT",
      );
    const last = page.at(-1);
    if (page.length < pageSize || !last) break;
    afterJobId = last.plan.identity.jobId;
  }
  return { mode: input.mode, programs, unavailableTools: await input.unavailableTools() };
}
