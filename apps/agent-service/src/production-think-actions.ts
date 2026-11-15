import {
  THINK_ACTION_REMINDER_CREATE,
  THINK_ACTION_REMINDER_RESCHEDULE,
  THINK_ACTION_TASK_RUN,
} from "@himawari-agent/prompt-catalog";
import type { ProductionProposalBox } from "./production-proposals.js";
import {
  proposeReminderCreate,
  proposeReminderReschedule,
  REMINDER_CREATE_PROPOSAL_TYPE,
  REMINDER_RESCHEDULE_PROPOSAL_TYPE,
  type ReminderProposalContext,
} from "./production-reminder-proposals.js";
import { proposeTaskRun, TASK_RUN_PROPOSAL_TYPE } from "./production-task-proposals.js";
import { type ThinkActionContext, ThinkActionRegistry } from "./production-think-runner.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function common(context: ThinkActionContext) {
  return {
    origin: context.entry.externalContent ? ("external_content" as const) : ("inferred" as const),
    threadId: context.threadId,
    externalContentSeen: true,
    source: {
      ref: `${context.entry.sourceKind}:${context.entry.sourceRef}`,
      version: context.entry.sourceVersion || null,
    },
    reason: context.reason,
  };
}

export function thinkActions(options: {
  readonly box: Pick<ProductionProposalBox, "propose">;
  readonly writer?: ReminderProposalContext["writer"];
  readonly timeZone: string;
}): ThinkActionRegistry {
  const registry = new ThinkActionRegistry();
  const { box, writer, timeZone } = options;
  registry.register({
    type: TASK_RUN_PROPOSAL_TYPE,
    describe: THINK_ACTION_TASK_RUN.text,
    propose: async (fields, context) => {
      const task = text(fields["text"]);
      if (!task || Object.keys(fields).some((key) => key !== "text"))
        return { refused: "TASK_FIELDS_INVALID" };
      return proposeTaskRun(
        { box, ...common(context) },
        {
          text: task,
          basis: [
            { kind: "think_source", ref: `${context.entry.sourceKind}:${context.entry.sourceRef}` },
          ],
        },
      );
    },
  });
  if (writer) {
    registry.register({
      type: REMINDER_CREATE_PROPOSAL_TYPE,
      describe: THINK_ACTION_REMINDER_CREATE.text,
      propose: async (fields, context) => {
        const reminder = text(fields["text"]);
        const due = text(fields["due"]);
        const repeat = fields["repeat"] ?? "none";
        if (
          !reminder ||
          !due ||
          (repeat !== "none" && repeat !== "yearly") ||
          Object.keys(fields).some((key) => !["text", "due", "repeat"].includes(key))
        )
          return { refused: "REMINDER_FIELDS_INVALID" };
        return proposeReminderCreate(
          { box, writer, timeZone, ...common(context) },
          { text: reminder, due, repeat },
        );
      },
    });
    registry.register({
      type: REMINDER_RESCHEDULE_PROPOSAL_TYPE,
      describe: THINK_ACTION_REMINDER_RESCHEDULE.text,
      propose: async (fields, context) => {
        const reminderId = text(fields["reminderId"]);
        const due = text(fields["due"]);
        if (
          !reminderId ||
          !due ||
          Object.keys(fields).some((key) => !["reminderId", "due"].includes(key))
        )
          return { refused: "REMINDER_FIELDS_INVALID" };
        return proposeReminderReschedule(
          { box, writer, timeZone, ...common(context) },
          { reminderId, due },
        );
      },
    });
  }
  return registry;
}
