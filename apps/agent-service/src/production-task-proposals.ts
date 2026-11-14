import { createHash } from "node:crypto";
import type {
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  ThreadCommandService,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import {
  type ProductionProposalBox,
  type ProposalActionHandler,
  ProposalError,
  type ProposalPremises,
  type ProposalSource,
} from "./production-proposals.js";
import { localTimeText } from "./production-reminder-writer.js";

type Admission = Parameters<ThreadCommandService["admitOwnerMessage"]>[0];
type OwnerId = Admission["ownerId"];
type AgentId = Admission["agentId"];
type ThreadId = Admission["threadId"];
type MessageId = NonNullable<Admission["messageId"]>;
type TurnId = NonNullable<Admission["turnId"]>;
type RunId = NonNullable<Admission["runId"]>;
type SessionId = Admission["sessionId"];

export const TASK_RUN_PROPOSAL_TYPE = "task.run";

const SHOWN_TEXT_LENGTH = 60;
const FULL_READ_TEXT_LENGTH = 120;
const MAXIMUM_TASK_LENGTH = 2000;
const BASIS_LIMIT = 8;
const EVIDENCE_CHUNK_LENGTH = 500;
const TASK_OPEN = "<<<已同意的任务>>>";
const TASK_CLOSE = "<<<已同意的任务结束>>>";

interface TaskData {
  readonly text: string;
  readonly basis: readonly { readonly kind: string; readonly ref: string }[];
}

interface TaskOriginal {
  readonly threadId: string;
  readonly runId: string;
  readonly contentRef: string;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function taskData(value: unknown): TaskData | undefined {
  const { text, basis } = (value ?? {}) as Record<string, unknown>;
  if (!isText(text) || [...text].length > MAXIMUM_TASK_LENGTH) return undefined;
  if (!Array.isArray(basis) || basis.length === 0 || basis.length > BASIS_LIMIT) return undefined;
  const parsed: { kind: string; ref: string }[] = [];
  for (const entry of basis) {
    const { kind, ref } = (entry ?? {}) as Record<string, unknown>;
    if (!isText(kind) || !isText(ref)) return undefined;
    parsed.push({ kind, ref });
  }
  return { text, basis: parsed };
}

function taskOriginal(value: unknown): TaskOriginal | undefined {
  const { threadId, runId, contentRef } = (value ?? {}) as Record<string, unknown>;
  return isText(threadId) && isText(runId) && isText(contentRef)
    ? { threadId, runId, contentRef }
    : undefined;
}

function digest(proposalId: string): string {
  return createHash("sha256").update(proposalId).digest("hex").slice(0, 32);
}

function neutralized(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}

export function taskRunMessage(input: {
  readonly proposalId: string;
  readonly text: string;
  readonly decidedAt: string;
  readonly timeZone: string;
}): string {
  return [
    `这是主人在 ${localTimeText(input.decidedAt, input.timeZone)}（${input.timeZone}）同意的一条提议，提议编号 ${input.proposalId}。下面块里是主人看过并同意的任务说明，原样执行；它不替主人预先批准任何对外发送、花钱或删除。`,
    TASK_OPEN,
    neutralized(input.text),
    TASK_CLOSE,
  ].join("\n");
}

export function registerTaskProposalHandler(options: {
  readonly box: Pick<ProductionProposalBox, "register">;
  readonly configuration: { readonly ownerId: string; readonly agentId: string };
  readonly commands: Pick<ThreadCommandService, "create" | "admitOwnerMessage">;
  readonly threads: Pick<ThreadRepositoryPort, "readDetailSnapshot">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly timeZone: string;
}): void {
  const { box, configuration, commands, threads, payloads, protector, clock, timeZone } = options;
  const ownerId = configuration.ownerId as OwnerId;
  const agentId = configuration.agentId as AgentId;
  const ids = (proposalId: string) => {
    const key = digest(proposalId);
    return {
      threadId: `thread:proposal:${key}` as ThreadId,
      messageId: `message:proposal:${key}` as MessageId,
      turnId: `turn:proposal:${key}` as TurnId,
      runId: `run:proposal:${key}` as RunId,
      contentRef: `proposal-task:${key}`,
    };
  };
  const handler: ProposalActionHandler = {
    kind: "action",
    async verify({ data, session }): Promise<ProposalPremises> {
      if (!taskData(data)) return { ok: false, reason: "TASK_DATA_INVALID" };
      if (!session) throw new ProposalError("PROPOSAL_INVALID", "TASK_SESSION_REQUIRED");
      return { ok: true };
    },
    async execute({ proposalId, data, session }) {
      const parsed = taskData(data);
      if (!parsed) throw new ProposalError("PROPOSAL_INVALID", "TASK_DATA_INVALID");
      if (!session) throw new ProposalError("PROPOSAL_INVALID", "TASK_SESSION_REQUIRED");
      const id = ids(proposalId);
      const now = clock.now();
      const classification = classificationWithIdentifiers(parsed.text, "private");
      if (!(await payloads.get(id.contentRef))) {
        await payloads.put(
          await protector.protect({
            ownerId,
            agentId,
            ref: id.contentRef,
            contentType: "text/plain",
            dataClassification: classification,
            plaintext: new TextEncoder().encode(
              taskRunMessage({ proposalId, text: parsed.text, decidedAt: now, timeZone }),
            ),
            createdAt: now,
          }),
        );
      }
      const created = await commands.create({
        ownerId,
        agentId,
        threadId: id.threadId,
        idempotencyKey: `proposal-task-thread:${proposalId}`,
        resultRef: id.contentRef,
      });
      await commands.admitOwnerMessage({
        triggerSource: "external_event",
        ownerId,
        agentId,
        threadId: id.threadId,
        expectedThreadRevision: created.thread.revision,
        sessionId: session.sessionId as SessionId,
        idempotencyKey: `proposal-task-run:${proposalId}`,
        contentRef: id.contentRef,
        sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
        dataClassification: classification,
        resultRef: id.contentRef,
        messageId: id.messageId,
        turnId: id.turnId,
        runId: id.runId,
        occurredAt: now,
      });
      return {
        original: { threadId: id.threadId, runId: id.runId, contentRef: id.contentRef },
        detail: id.threadId,
      };
    },
    async readBack({ original }) {
      const made = taskOriginal(original);
      if (!made) return "differs";
      const snapshot = await threads.readDetailSnapshot({
        ownerId,
        agentId,
        threadId: made.threadId as ThreadId,
        afterSequence: 0,
        limit: 5,
      });
      const hasRun = snapshot?.runs.some((run) => run.runId === made.runId) === true;
      const hasMessage = snapshot?.messages.some((item) => item.contentRef === made.contentRef);
      return hasRun && hasMessage ? "matches" : "differs";
    },
    async undo() {
      throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
    },
  };
  box.register(TASK_RUN_PROPOSAL_TYPE, handler);
}

function chunks(text: string, size: number): string[] {
  const characters = [...text];
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += size)
    parts.push(characters.slice(start, start + size).join(""));
  return parts;
}

function clip(text: string, maximum: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum).join("")}…`;
}

export interface TaskProposalContext {
  readonly box: Pick<ProductionProposalBox, "propose">;
  readonly origin: "owner_said" | "inferred" | "external_agent" | "external_content";
  readonly threadId: string | null;
  readonly externalContentSeen?: boolean;
  readonly source?: ProposalSource;
  readonly reason: string;
}

export async function proposeTaskRun(
  context: TaskProposalContext,
  input: {
    readonly text: string;
    readonly basis: readonly { readonly kind: string; readonly ref: string }[];
  },
): Promise<{ readonly proposalId: string } | { readonly refused: string }> {
  const text = input.text.trim();
  if (text.length === 0 || [...text].length > MAXIMUM_TASK_LENGTH)
    return { refused: "TASK_TEXT_INVALID" };
  if (!taskData({ text, basis: input.basis })) return { refused: "TASK_BASIS_REQUIRED" };
  const basis = input.basis
    .map(({ kind, ref }) => ({ kind, ref }))
    .sort((a, b) =>
      a.kind === b.kind ? a.ref.localeCompare(b.ref) : a.kind.localeCompare(b.kind),
    );
  const proposalId = `task:${createHash("sha256")
    .update(JSON.stringify([text, basis.map(({ kind, ref }) => [kind, ref])]))
    .digest("hex")
    .slice(0, 32)}`;
  const long = [...text].length > FULL_READ_TEXT_LENGTH;
  await context.box.propose({
    proposalId,
    type: TASK_RUN_PROPOSAL_TYPE,
    summary: `交给我去办：${clip(text, SHOWN_TEXT_LENGTH)}`,
    effect:
      "新开一个对话，把这段任务说明原样交给我去办；这次运行在后台，需要写入、发送、花钱、删除的动作会被直接拒绝",
    origin: context.origin,
    threadId: context.threadId,
    evidence: [
      {
        kind: "detail",
        text: [...context.reason].slice(0, EVIDENCE_CHUNK_LENGTH).join(""),
        sources: basis,
        figures: [],
      },
      ...chunks(text, EVIDENCE_CHUNK_LENGTH).map((part) => ({
        kind: "task_text",
        text: part,
        sources: [],
        figures: [],
      })),
    ],
    data: { text, basis },
    requiresFullRead:
      long || context.externalContentSeen === true || context.origin === "external_content",
    ...(context.source ? { source: context.source } : {}),
    ...(context.externalContentSeen === true ? { externalContentSeen: true } : {}),
  });
  return { proposalId };
}
