import { createHash } from "node:crypto";
import type {
  AuthorityFence,
  ClockPort,
  IdempotentAgentCommand,
  JsonObject,
  StateRecord,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

export function workspaceIncompleteFolderPrefix(grantId: string): string {
  return `workspace-ledger-incomplete:${grantId.length}:${grantId}:`;
}

export function workspaceIncompleteThreadKey(grantId: string, threadId: string): string {
  return `${workspaceIncompleteFolderPrefix(grantId)}${threadId}`;
}

export interface WorkspaceChangeMarks {
  markIncomplete(input: {
    readonly grantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly toolCallId: string;
  }): Promise<void>;
}

export function createWorkspaceChangeMarks(options: {
  readonly ownerId: IdempotentAgentCommand["ownerId"];
  readonly agentId: IdempotentAgentCommand["agentId"];
  readonly repository: Pick<
    SqliteProductStateRepository,
    "readScopedState" | "commitStateAndEvents"
  >;
  readonly authority: () => AuthorityFence;
  readonly clock: ClockPort;
}): WorkspaceChangeMarks {
  const { ownerId, agentId, repository, clock } = options;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const read = (key: string): Promise<StateRecord | undefined> =>
    repository.readScopedState(ownerId, agentId, key);
  const write = async (key: string, value: JsonObject, commandKey: string) => {
    if (await read(key)) return;
    try {
      await repository.commitStateAndEvents({
        command: {
          ownerId,
          agentId,
          idempotencyKey:
            `workspace-incomplete:${hash(commandKey)}` as IdempotentAgentCommand["idempotencyKey"],
          commandType: "workspace.ledger.incomplete",
          commandFingerprint: hash(commandKey),
          authority: options.authority(),
        },
        state: { key, expectedRevision: null, value },
        events: [],
        resultRef: key,
        committedAt: clock.now(),
      });
    } catch (error) {
      if (!(await read(key))) throw error;
    }
  };
  return {
    async markIncomplete(input) {
      const value: JsonObject = {
        grantId: input.grantId,
        threadId: input.threadId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        at: clock.now(),
      };
      await write(
        workspaceIncompleteThreadKey(input.grantId, input.threadId),
        value,
        `${input.runId}:${input.toolCallId}`,
      );
    },
  };
}
