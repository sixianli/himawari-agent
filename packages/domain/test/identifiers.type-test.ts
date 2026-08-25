import type { AgentId, OwnerId, RunId, ThreadId } from "../src/index.js";

declare const ownerId: OwnerId;
declare const agentId: AgentId;
declare const threadId: ThreadId;
declare const runId: RunId;

// @ts-expect-error An AgentId must not be assignable to an OwnerId.
const ownerFromAgent: OwnerId = agentId;
// @ts-expect-error A RunId must not be assignable to a ThreadId.
const threadFromRun: ThreadId = runId;

void ownerId;
void threadId;
void ownerFromAgent;
void threadFromRun;
