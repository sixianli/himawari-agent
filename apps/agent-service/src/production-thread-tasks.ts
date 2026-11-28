import { createHash } from "node:crypto";
import type {
  ClockPort,
  DataClassification,
  OwnerRuleScope,
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeCustomToolDescriptor,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  SubthreadStorePort,
  ThreadTaskRecord,
  ThreadTaskStatus,
  ThreadTaskWrite,
} from "@himawari-agent/application";
import { highestClassification, THREAD_TASK_STATUSES } from "@himawari-agent/application";
import {
  TOOL_TASK_CREATE,
  TOOL_TASK_GET,
  TOOL_TASK_LIST,
  TOOL_TASK_UPDATE,
} from "@himawari-agent/prompt-catalog";

export const THREAD_TASK_CAPABILITY_PREFIX = "owner.plan.";
export const THREAD_TASK_TOOLS = ["task_create", "task_update", "task_list", "task_get"] as const;
export type ThreadTaskTool = (typeof THREAD_TASK_TOOLS)[number];

const SUBJECT_LIMIT = 200;
const DESCRIPTION_LIMIT = 4000;
const ACTIVE_FORM_LIMIT = 200;
const CHANGE_ATTEMPTS = 3;

export type ConversationKind = "main" | "subthread" | "other";

export class SubthreadToolError extends Error {
  readonly code:
    | "INPUT_INVALID"
    | "NOT_HERE"
    | "UNKNOWN_SUBTHREAD"
    | "SUBTHREAD_CLOSED"
    | "OVER_BUDGET"
    | "BUDGET_TOO_LOW"
    | "UNKNOWN_TASK"
    | "TASK_CHANGED"
    | "TASK_CYCLE"
    | "TASKS_OPEN"
    | "UNKNOWN_RESULT"
    | "OTHER_MATTER"
    | "WAIT_CYCLE"
    | "RESULT_LIMIT";

  constructor(code: SubthreadToolError["code"]) {
    super(code);
    this.name = "SubthreadToolError";
    this.code = code;
  }
}

interface TaskContent {
  readonly subject: string;
  readonly description: string;
  readonly activeForm: string;
  readonly status: ThreadTaskStatus;
  readonly blockedBy: readonly number[];
  readonly assignee: string | null;
}

const number = { type: "integer", minimum: 1 } as const;
const numbers = { type: "array", items: number, uniqueItems: true, maxItems: 50 } as const;

export function threadTaskDescriptors(): readonly RuntimeToolDescriptor[] {
  const descriptor = (
    name: ThreadTaskTool,
    description: string,
    parameters: RuntimeCustomToolDescriptor["parameters"],
  ): RuntimeToolDescriptor => ({
    name,
    capabilityRef: `${THREAD_TASK_CAPABILITY_PREFIX}${name}`,
    capabilityHandleRef: null,
    description,
    parameters,
    contextRetention: "keep",
  });
  return [
    descriptor("task_create", TOOL_TASK_CREATE.text, {
      type: "object",
      properties: {
        subject: { type: "string", minLength: 1, maxLength: SUBJECT_LIMIT },
        description: { type: "string", minLength: 1, maxLength: DESCRIPTION_LIMIT },
        active_form: { type: "string", minLength: 1, maxLength: ACTIVE_FORM_LIMIT },
        blocked_by: numbers,
      },
      required: ["subject", "description", "active_form"],
      additionalProperties: false,
    }),
    descriptor("task_update", TOOL_TASK_UPDATE.text, {
      type: "object",
      properties: {
        task: number,
        status: { type: "string", enum: [...THREAD_TASK_STATUSES] },
        subject: { type: "string", minLength: 1, maxLength: SUBJECT_LIMIT },
        description: { type: "string", minLength: 1, maxLength: DESCRIPTION_LIMIT },
        active_form: { type: "string", minLength: 1, maxLength: ACTIVE_FORM_LIMIT },
        add_blocked_by: numbers,
        add_blocks: numbers,
        assignee: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["task"],
      additionalProperties: false,
    }),
    descriptor("task_list", TOOL_TASK_LIST.text, {
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    descriptor("task_get", TOOL_TASK_GET.text, {
      type: "object",
      properties: { task: number },
      required: ["task"],
      additionalProperties: false,
    }),
  ];
}

function textArgument(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum)
    throw new SubthreadToolError("INPUT_INVALID");
  return value.trim();
}

function numbersArgument(value: unknown): readonly number[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((item) => Number.isSafeInteger(item) && item >= 1) ||
    new Set(value).size !== value.length
  )
    throw new SubthreadToolError("INPUT_INVALID");
  return value as number[];
}

function onlyArguments(args: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  if (Object.keys(args).some((name) => !allowed.includes(name)))
    throw new SubthreadToolError("INPUT_INVALID");
}

export interface ProductionThreadTasksOptions {
  readonly ownerId: OwnerRuleScope["ownerId"];
  readonly agentId: OwnerRuleScope["agentId"];
  readonly store: Pick<SubthreadStorePort, "createTask" | "updateTask" | "listTasks" | "read">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly conversation: (
    runId: string,
  ) => Promise<{ readonly threadId: string; readonly kind: ConversationKind } | undefined>;
}

export class ProductionThreadTasks {
  readonly #options: ProductionThreadTasksOptions;

  constructor(options: ProductionThreadTasksOptions) {
    this.#options = options;
  }

  get #scope() {
    return { ownerId: this.#options.ownerId, agentId: this.#options.agentId };
  }

  async run(
    invocation: RuntimeToolInvocation,
  ): Promise<{ readonly value: unknown; readonly contentClassification?: DataClassification }> {
    const tool = invocation.capabilityRef.slice(THREAD_TASK_CAPABILITY_PREFIX.length);
    const conversation = await this.#options.conversation(invocation.runId);
    if (!conversation || conversation.kind === "other") throw new SubthreadToolError("NOT_HERE");
    const args = invocation.arguments;
    if (tool === "task_create") return this.#create(invocation, conversation, args);
    if (tool === "task_update") return this.#update(invocation, conversation, args);
    if (tool === "task_list") {
      onlyArguments(args, []);
      return this.#list(conversation.threadId);
    }
    if (tool === "task_get") {
      onlyArguments(args, ["task"]);
      return this.#get(conversation.threadId, args["task"]);
    }
    throw new SubthreadToolError("INPUT_INVALID");
  }

  async tasks(threadId: string): Promise<readonly ThreadTaskRecord[]> {
    return this.#options.store.listTasks({ ...this.#scope, threadId });
  }

  async content(task: Pick<ThreadTaskRecord, "contentRef">): Promise<TaskContent | undefined> {
    const payload = await this.#options.payloads.get(task.contentRef as never);
    if (!payload) return undefined;
    const plaintext = await this.#options.protector.unprotect({
      ...this.#scope,
      payload,
    });
    return JSON.parse(new TextDecoder().decode(plaintext)) as TaskContent;
  }

  async #write(invocation: RuntimeToolInvocation, attempt: number, content: TaskContent) {
    const ref = `thread-task:${createHash("sha256")
      .update(JSON.stringify([invocation.runId, invocation.toolCallId, attempt]))
      .digest("hex")
      .slice(0, 32)}`;
    const body = JSON.stringify(content);
    const classification: DataClassification = "private";
    if (!(await this.#options.payloads.get(ref as never)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope,
          ref,
          contentType: "application/json",
          dataClassification: classification,
          plaintext: new TextEncoder().encode(body),
          createdAt: this.#options.clock.now(),
        }),
      );
    return { ref, classification };
  }

  async #assignee(
    conversation: { readonly threadId: string; readonly kind: ConversationKind },
    value: unknown,
  ): Promise<string | null | undefined> {
    if (value === undefined) return undefined;
    if (conversation.kind !== "main" || typeof value !== "string")
      throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.#options.store.read({ ...this.#scope, threadId: value });
    if (!subthread || subthread.parentThreadId !== conversation.threadId)
      throw new SubthreadToolError("UNKNOWN_SUBTHREAD");
    return value;
  }

  #failure(outcome: string): never {
    if (outcome === "missing" || outcome === "unknown_dependency")
      throw new SubthreadToolError("UNKNOWN_TASK");
    if (outcome === "cycle") throw new SubthreadToolError("TASK_CYCLE");
    throw new SubthreadToolError("TASK_CHANGED");
  }

  async #create(
    invocation: RuntimeToolInvocation,
    conversation: { readonly threadId: string; readonly kind: ConversationKind },
    args: Readonly<Record<string, unknown>>,
  ) {
    onlyArguments(args, ["subject", "description", "active_form", "blocked_by"]);
    const subject = textArgument(args["subject"], SUBJECT_LIMIT);
    const description = textArgument(args["description"], DESCRIPTION_LIMIT);
    const activeForm = textArgument(args["active_form"], ACTIVE_FORM_LIMIT);
    if (!subject || !description || !activeForm) throw new SubthreadToolError("INPUT_INVALID");
    const blockedBy = numbersArgument(args["blocked_by"]);
    const content: TaskContent = {
      subject,
      description,
      activeForm,
      status: "pending",
      blockedBy,
      assignee: null,
    };
    const { ref, classification } = await this.#write(invocation, 0, content);
    const outcome = await this.#options.store.createTask({
      ...this.#scope,
      threadId: conversation.threadId,
      task: {
        status: "pending",
        blockedBy,
        assigneeThreadId: null,
        contentRef: ref,
        classification,
      },
      runId: invocation.runId,
      now: this.#options.clock.now(),
    });
    if (outcome.outcome !== "changed") this.#failure(outcome.outcome);
    return {
      value: { task: outcome.task.number, subject, status: "pending", blocked_by: blockedBy },
      contentClassification: classification,
    };
  }

  async #update(
    invocation: RuntimeToolInvocation,
    conversation: { readonly threadId: string; readonly kind: ConversationKind },
    args: Readonly<Record<string, unknown>>,
  ) {
    onlyArguments(args, [
      "task",
      "status",
      "subject",
      "description",
      "active_form",
      "add_blocked_by",
      "add_blocks",
      "assignee",
    ]);
    const target = args["task"];
    if (!Number.isSafeInteger(target) || (target as number) < 1)
      throw new SubthreadToolError("INPUT_INVALID");
    const status = args["status"];
    if (status !== undefined && !(THREAD_TASK_STATUSES as readonly unknown[]).includes(status))
      throw new SubthreadToolError("INPUT_INVALID");
    const subject = textArgument(args["subject"], SUBJECT_LIMIT);
    const description = textArgument(args["description"], DESCRIPTION_LIMIT);
    const activeForm = textArgument(args["active_form"], ACTIVE_FORM_LIMIT);
    const addBlockedBy = numbersArgument(args["add_blocked_by"]);
    const blocks = numbersArgument(args["add_blocks"]);
    const assignee = await this.#assignee(conversation, args["assignee"]);
    for (let attempt = 0; attempt < CHANGE_ATTEMPTS; attempt += 1) {
      const tasks = await this.tasks(conversation.threadId);
      const current = tasks.find((task) => task.number === target);
      if (!current) throw new SubthreadToolError("UNKNOWN_TASK");
      const before = await this.content(current);
      if (!before) throw new SubthreadToolError("UNKNOWN_TASK");
      const blockedBy = [
        ...current.blockedBy,
        ...addBlockedBy.filter((item) => !current.blockedBy.includes(item)),
      ];
      const content: TaskContent = {
        subject: subject ?? before.subject,
        description: description ?? before.description,
        activeForm: activeForm ?? before.activeForm,
        status: (status as ThreadTaskStatus | undefined) ?? current.status,
        blockedBy,
        assignee: assignee === undefined ? current.assigneeThreadId : assignee,
      };
      const { ref, classification } = await this.#write(invocation, attempt, content);
      const task: ThreadTaskWrite = {
        status: content.status,
        blockedBy,
        assigneeThreadId: content.assignee,
        contentRef: ref,
        classification,
      };
      const outcome = await this.#options.store.updateTask({
        ...this.#scope,
        threadId: conversation.threadId,
        number: current.number,
        expectedRevision: current.revision,
        task,
        blocks,
        runId: invocation.runId,
        now: this.#options.clock.now(),
      });
      if (outcome.outcome === "stale") continue;
      if (outcome.outcome !== "changed") this.#failure(outcome.outcome);
      return {
        value: {
          task: outcome.task.number,
          status: outcome.task.status,
          revision: outcome.task.revision,
        },
        contentClassification: classification,
      };
    }
    throw new SubthreadToolError("TASK_CHANGED");
  }

  async #list(threadId: string) {
    const tasks = await this.tasks(threadId);
    const rows = [];
    const classification = highestClassification(
      "private",
      tasks
        .filter((task) => task.status !== "deleted")
        .map((task) => task.classification as DataClassification),
    );
    for (const task of tasks) {
      if (task.status === "deleted") continue;
      const content = await this.content(task);
      rows.push({
        task: task.number,
        subject: content?.subject ?? null,
        status: task.status,
        blocked_by: task.blockedBy.filter(
          (blocker) => tasks.find((item) => item.number === blocker)?.status !== "completed",
        ),
        ...(task.assigneeThreadId ? { assignee: task.assigneeThreadId } : {}),
      });
    }
    return { value: { tasks: rows }, contentClassification: classification };
  }

  async #get(threadId: string, target: unknown) {
    if (!Number.isSafeInteger(target) || (target as number) < 1)
      throw new SubthreadToolError("INPUT_INVALID");
    const tasks = await this.tasks(threadId);
    const task = tasks.find((item) => item.number === target);
    const content = task ? await this.content(task) : undefined;
    if (!task || !content) throw new SubthreadToolError("UNKNOWN_TASK");
    return {
      value: {
        task: task.number,
        subject: content.subject,
        description: content.description,
        active_form: content.activeForm,
        status: task.status,
        blocked_by: task.blockedBy,
        blocks: tasks.filter((item) => item.blockedBy.includes(task.number)).map((i) => i.number),
        ...(task.assigneeThreadId ? { assignee: task.assigneeThreadId } : {}),
        revision: task.revision,
      },
      contentClassification: task.classification as DataClassification,
    };
  }
}
