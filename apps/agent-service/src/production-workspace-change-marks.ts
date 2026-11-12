import { createHash } from "node:crypto";
import type {
  AuthorityFence,
  ClockPort,
  IdempotentAgentCommand,
  JsonObject,
  StateRecord,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

export function workspaceIncompleteFolderKey(grantId: string): string {
  return `workspace-ledger-incomplete:${grantId}`;
}

export function workspaceIncompleteThreadKey(grantId: string, threadId: string): string {
  return `workspace-ledger-incomplete:${grantId}:${threadId}`;
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
  const write = async (key: string, value: JsonObject, commandKey: string) => {
    const existing: StateRecord | undefined = await repository.readScopedState(
      ownerId,
      agentId,
      key,
    );
    const input = { key, expectedRevision: existing ? existing.revision : null, value };
    const fingerprint = hash(commandKey);
    await repository.commitStateAndEvents({
      command: {
        ownerId,
        agentId,
        idempotencyKey:
          `workspace-incomplete:${hash(commandKey)}` as IdempotentAgentCommand["idempotencyKey"],
        commandType: "workspace.ledger.incomplete",
        commandFingerprint: fingerprint,
        authority: options.authority(),
      },
      state: input,
      events: [],
      resultRef: key,
      committedAt: clock.now(),
    });
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
      const identity = `${input.runId}:${input.toolCallId}`;
      await write(
        workspaceIncompleteThreadKey(input.grantId, input.threadId),
        value,
        `thread:${identity}`,
      );
      await write(workspaceIncompleteFolderKey(input.grantId), value, `folder:${identity}`);
    },
  };
}
