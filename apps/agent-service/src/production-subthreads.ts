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
  SubthreadRecord,
  SubthreadStorePort,
  ThreadCommandService,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import { highestClassification } from "@himawari-agent/application";
import {
  renderPrompt,
  SUBTHREAD_BRIEF,
  SUBTHREAD_EVENT,
  SUBTHREAD_MESSAGES_PREFACE,
  TOOL_OPEN_SUBTHREAD,
  TOOL_RETURN_RESULT,
  TOOL_SEND_TO_SUBTHREAD,
  TOOL_STOP_SUBTHREAD,
  TOOL_TELL_MAIN,
  TOOL_VIEW_SUBTHREAD,
} from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import type { ContextExternalContent } from "./context-external-content.js";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";
import type { ProductionMainThread } from "./production-main-thread.js";
import {
  type ConversationKind,
  type ProductionThreadTasks,
  SubthreadToolError,
} from "./production-thread-tasks.js";

type Create = Parameters<ThreadCommandService["create"]>[0];
type MessagesQuery = Parameters<ThreadRepositoryPort["readCommittedMessagesByIds"]>[0];

export const SUBTHREAD_CAPABILITY_PREFIX = "owner.subthread.";
export const MAIN_SUBTHREAD_TOOLS = [
  "open_subthread",
  "send_to_subthread",
  "stop_subthread",
  "view_subthread",
] as const;
export const SUBTHREAD_SIDE_TOOLS = ["tell_main", "return_result"] as const;
export const SUBTHREAD_EVENT_KIND = "subthread";
export const MAIN_NOTE_EVENT_KIND = "main_note";

const FIELD_LIMIT = 4000;
const RESULT_LIMIT = 8000;
const MATTER_LIMIT = 64;
const OWNER_MESSAGES_LIMIT = 20;
const LIST_LIMIT = 30;
const ITEMS_LIMIT = 30;
const HISTORY_LIMIT = 100;
const TELL_KINDS = ["progress", "question", "stuck"] as const;

const digest = (value: unknown, length = 32) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);

const field = (maxLength: number) => ({ type: "string", minLength: 1, maxLength }) as const;
const subthreadId = { type: "string", minLength: 1, maxLength: 256 } as const;

function descriptor(
  name: string,
  description: string,
  parameters: RuntimeCustomToolDescriptor["parameters"],
  keep = false,
): RuntimeToolDescriptor {
  return {
    name,
    capabilityRef: `${SUBTHREAD_CAPABILITY_PREFIX}${name}`,
    capabilityHandleRef: null,
    description,
    parameters,
    ...(keep ? { contextRetention: "keep" as const } : {}),
  };
}

export function mainSubthreadDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    descriptor("open_subthread", TOOL_OPEN_SUBTHREAD.text, {
      type: "object",
      properties: {
        objective: field(FIELD_LIMIT),
        background: field(FIELD_LIMIT),
        done_when: field(FIELD_LIMIT),
        avoid: field(FIELD_LIMIT),
        deliver: field(FIELD_LIMIT),
        owner_messages: {
          type: "array",
          items: field(256),
          minItems: 1,
          maxItems: OWNER_MESSAGES_LIMIT,
          uniqueItems: true,
        },
        matter: field(MATTER_LIMIT),
      },
      required: [
        "objective",
        "background",
        "done_when",
        "avoid",
        "deliver",
        "owner_messages",
        "matter",
      ],
      additionalProperties: false,
    }),
    descriptor("send_to_subthread", TOOL_SEND_TO_SUBTHREAD.text, {
      type: "object",
      properties: { subthread: subthreadId, text: field(FIELD_LIMIT) },
      required: ["subthread", "text"],
      additionalProperties: false,
    }),
    descriptor("stop_subthread", TOOL_STOP_SUBTHREAD.text, {
      type: "object",
      properties: { subthread: subthreadId, reason: field(1000) },
      required: ["subthread", "reason"],
      additionalProperties: false,
    }),
    descriptor(
      "view_subthread",
      TOOL_VIEW_SUBTHREAD.text,
      {
        type: "object",
        properties: { subthread: subthreadId, history: { type: "boolean" } },
        additionalProperties: false,
      },
      true,
    ),
  ];
}

export function subthreadSideDescriptors(): readonly RuntimeToolDescriptor[] {
  const items = { type: "array", items: field(1000), maxItems: ITEMS_LIMIT } as const;
  return [
    descriptor("tell_main", TOOL_TELL_MAIN.text, {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...TELL_KINDS] },
        text: field(FIELD_LIMIT),
        wake: { type: "boolean" },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    }),
    descriptor(
      "return_result",
      TOOL_RETURN_RESULT.text,
      {
        type: "object",
        properties: {
          conclusion: field(RESULT_LIMIT),
          criteria: { ...items, minItems: 1 },
          outputs: items,
          open_issues: items,
        },
        required: ["conclusion", "criteria"],
        additionalProperties: false,
      },
      true,
    ),
  ];
}

function textArgument(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum)
    throw new SubthreadToolError("INPUT_INVALID");
  return value.trim();
}

function listArgument(value: unknown, required: boolean): readonly string[] {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > ITEMS_LIMIT ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  )
    throw new SubthreadToolError("INPUT_INVALID");
  return value.map((item: string) => textArgument(item, 1000));
}

function onlyArguments(args: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  if (Object.keys(args).some((name) => !allowed.includes(name)))
    throw new SubthreadToolError("INPUT_INVALID");
}

export interface SubthreadInboxAttachment {
  readonly inbox: Pick<ProductionInbox, "submit">;
  readonly cancelThreadRuns?: (threadId: string) => Promise<void>;
}

export interface ProductionSubthreadsOptions {
  readonly ownerId: OwnerRuleScope["ownerId"];
  readonly agentId: OwnerRuleScope["agentId"];
  readonly mainThread: Pick<ProductionMainThread, "read">;
  readonly threads: Pick<ThreadRepositoryPort, "readCommittedMessagesByIds">;
  readonly commands: Pick<ThreadCommandService, "create">;
  readonly store: SubthreadStorePort;
  readonly tasks: Pick<ProductionThreadTasks, "tasks" | "content">;
  readonly externalContent: Pick<ContextExternalContent, "readThread" | "markThread">;
  readonly threadOf: (runId: string) => Promise<string | null | undefined>;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

type Result = { readonly value: unknown; readonly contentClassification?: DataClassification };

export class ProductionSubthreads {
  readonly #options: ProductionSubthreadsOptions;
  #attached: SubthreadInboxAttachment | undefined;

  constructor(options: ProductionSubthreadsOptions) {
    this.#options = options;
  }

  get #scope() {
    return { ownerId: this.#options.ownerId, agentId: this.#options.agentId };
  }

  attach(attachment: SubthreadInboxAttachment): void {
    this.#attached = attachment;
  }

  registerSources(registry: InboxSourceRegistry): void {
    registry.register({
      kind: SUBTHREAD_EVENT_KIND,
      describe: "子线程",
      externalContent: false,
      fromOwner: false,
      priority: 4,
      verbatim: true,
    });
    registry.register({
      kind: MAIN_NOTE_EVENT_KIND,
      describe: "主对话",
      externalContent: false,
      fromOwner: false,
      priority: 3,
      verbatim: true,
    });
  }

  async kindOfThread(threadId: string): Promise<ConversationKind> {
    if ((await this.#options.mainThread.read()) === threadId) return "main";
    return (await this.#options.store.read({ ...this.#scope, threadId })) ? "subthread" : "other";
  }

  async conversation(
    runId: string,
  ): Promise<{ readonly threadId: string; readonly kind: ConversationKind } | undefined> {
    const threadId = await this.#options.threadOf(runId);
    if (!threadId) return undefined;
    return { threadId, kind: await this.kindOfThread(threadId) };
  }

  async open(threadId: string): Promise<SubthreadRecord | undefined> {
    const subthread = await this.#options.store.read({ ...this.#scope, threadId });
    return subthread?.status === "open" ? subthread : undefined;
  }

  subthreadMessage(events: readonly { readonly sourceRef: string; readonly text: string }[]) {
    const notes = events.filter((event) => !event.sourceRef.startsWith("brief:"));
    return [
      ...events.filter((event) => event.sourceRef.startsWith("brief:")).map((event) => event.text),
      ...(notes.length > 0 ? [SUBTHREAD_MESSAGES_PREFACE.text] : []),
      ...notes.map((event) => event.text),
    ].join("\n\n");
  }

  async run(invocation: RuntimeToolInvocation): Promise<Result> {
    const tool = invocation.capabilityRef.slice(SUBTHREAD_CAPABILITY_PREFIX.length);
    const conversation = await this.conversation(invocation.runId);
    const main = (MAIN_SUBTHREAD_TOOLS as readonly string[]).includes(tool);
    const side = (SUBTHREAD_SIDE_TOOLS as readonly string[]).includes(tool);
    if (!conversation || (main && conversation.kind !== "main"))
      throw new SubthreadToolError("NOT_HERE");
    if (side && conversation.kind !== "subthread") throw new SubthreadToolError("NOT_HERE");
    const args = invocation.arguments;
    switch (tool) {
      case "open_subthread":
        return this.#open(invocation, conversation.threadId, args);
      case "send_to_subthread":
        return this.#send(invocation, conversation.threadId, args);
      case "stop_subthread":
        return this.#stop(conversation.threadId, args);
      case "view_subthread":
        return this.#view(conversation.threadId, args);
      case "tell_main":
        return this.#tellMain(invocation, conversation.threadId, args);
      case "return_result":
        return this.#return(invocation, conversation.threadId, args);
      default:
        throw new SubthreadToolError("INPUT_INVALID");
    }
  }

  async #text(ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref as never);
    if (!payload) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ...this.#scope, payload }),
    );
  }

  async #put(ref: string, text: string, floor: DataClassification = "private") {
    const dataClassification = highestClassification(floor, [
      classificationWithIdentifiers(text, "private"),
    ]);
    if (!(await this.#options.payloads.get(ref as never)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope,
          ref,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: this.#options.clock.now(),
        }),
      );
    return dataClassification;
  }

  async #submit(input: {
    readonly kind: string;
    readonly sourceRef: string;
    readonly text: string;
    readonly threadId: string | null;
    readonly externalContent: boolean;
  }): Promise<void> {
    const inbox = this.#attached?.inbox;
    if (!inbox) throw new SubthreadToolError("NOT_HERE");
    const submitted = await inbox.submit({
      sourceKind: input.kind,
      sourceRef: input.sourceRef,
      sourceVersion: "1",
      summary: input.text,
      externalContent: input.externalContent,
      threadId: input.threadId,
    });
    if (!submitted.accepted) throw new SubthreadToolError("INPUT_INVALID");
  }

  async #marked(threadId: string): Promise<boolean> {
    return (await this.#options.externalContent.readThread(threadId)).length > 0;
  }

  async #child(parent: string, value: unknown): Promise<SubthreadRecord> {
    if (typeof value !== "string" || value.length === 0)
      throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.#options.store.read({ ...this.#scope, threadId: value });
    if (!subthread || subthread.parentThreadId !== parent)
      throw new SubthreadToolError("UNKNOWN_SUBTHREAD");
    return subthread;
  }

  async #ownerWords(main: string, ids: readonly string[]): Promise<string> {
    const messages = await this.#options.threads.readCommittedMessagesByIds({
      ...(this.#scope as Pick<MessagesQuery, "ownerId" | "agentId">),
      threadId: main as MessagesQuery["threadId"],
      messageIds: ids as MessagesQuery["messageIds"],
    });
    const owned = messages.filter((message) => message.role === "owner" && !message.internal);
    if (owned.length !== ids.length) throw new SubthreadToolError("INPUT_INVALID");
    const words: string[] = [];
    for (const message of [...owned].sort((a, b) => a.sequence - b.sequence)) {
      const text = await this.#text(message.contentRef);
      if (text === undefined) throw new SubthreadToolError("INPUT_INVALID");
      words.push(`- ${text.replace(/\s+/gu, " ").trim()}`);
    }
    return words.join("\n");
  }

  async #open(
    invocation: RuntimeToolInvocation,
    main: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, [
      "objective",
      "background",
      "done_when",
      "avoid",
      "deliver",
      "owner_messages",
      "matter",
    ]);
    const brief = {
      objective: textArgument(args["objective"], FIELD_LIMIT),
      background: textArgument(args["background"], FIELD_LIMIT),
      doneWhen: textArgument(args["done_when"], FIELD_LIMIT),
      avoid: textArgument(args["avoid"], FIELD_LIMIT),
      deliver: textArgument(args["deliver"], FIELD_LIMIT),
    };
    const matter = textArgument(args["matter"], MATTER_LIMIT).replace(/\s+/gu, " ");
    const ids = args["owner_messages"];
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > OWNER_MESSAGES_LIMIT ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
      new Set(ids).size !== ids.length
    )
      throw new SubthreadToolError("INPUT_INVALID");
    const openKey = digest([invocation.runId, invocation.toolCallId]);
    const existing = await this.#options.store.readByOpenKey({ ...this.#scope, openKey });
    if (existing) return { value: { subthread: existing.threadId, matter: existing.matter } };
    const ownerWords = await this.#ownerWords(main, ids as string[]);
    const threadId = `thread:subthread:${openKey}`;
    const briefRef = `subthread-brief:${openKey}`;
    const briefText = renderPrompt(SUBTHREAD_BRIEF, { ...brief, ownerWords });
    const classification = await this.#put(briefRef, briefText);
    await this.#options.commands.create({
      ownerId: this.#options.ownerId as Create["ownerId"],
      agentId: this.#options.agentId as Create["agentId"],
      threadId: threadId as NonNullable<Create["threadId"]>,
      idempotencyKey: `subthread:${openKey}`,
      origin: "think",
      resultRef: briefRef as Create["resultRef"],
    });
    for (const { origin } of await this.#options.externalContent.readThread(main))
      await this.#options.externalContent.markThread(threadId, invocation.runId, origin);
    const { subthread } = await this.#options.store.open({
      ...this.#scope,
      threadId,
      parentThreadId: main,
      matter,
      openKey,
      openedByRunId: invocation.runId,
      briefRef,
      classification,
      now: this.#options.clock.now(),
    });
    await this.#submit({
      kind: MAIN_NOTE_EVENT_KIND,
      sourceRef: `brief:${threadId}`,
      text: briefText,
      threadId,
      externalContent: await this.#marked(main),
    });
    return { value: { subthread: subthread.threadId, matter: subthread.matter } };
  }

  async #send(
    invocation: RuntimeToolInvocation,
    main: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["subthread", "text"]);
    const subthread = await this.#child(main, args["subthread"]);
    const text = textArgument(args["text"], FIELD_LIMIT);
    if (subthread.status !== "open") throw new SubthreadToolError("SUBTHREAD_CLOSED");
    await this.#submit({
      kind: MAIN_NOTE_EVENT_KIND,
      sourceRef: `relay:${digest([invocation.runId, invocation.toolCallId])}`,
      text,
      threadId: subthread.threadId,
      externalContent: await this.#marked(main),
    });
    return { value: { sent: true, subthread: subthread.threadId } };
  }

  async #stop(main: string, args: Readonly<Record<string, unknown>>): Promise<Result> {
    onlyArguments(args, ["subthread", "reason"]);
    const subthread = await this.#child(main, args["subthread"]);
    textArgument(args["reason"], 1000);
    if (subthread.status === "open")
      await this.#options.store.settle({
        ...this.#scope,
        threadId: subthread.threadId,
        to: "stopped",
        resultRef: null,
        now: this.#options.clock.now(),
      });
    await this.#attached?.cancelThreadRuns?.(subthread.threadId);
    return { value: { stopped: true, subthread: subthread.threadId } };
  }

  async #view(main: string, args: Readonly<Record<string, unknown>>): Promise<Result> {
    onlyArguments(args, ["subthread", "history"]);
    if (args["history"] !== undefined && typeof args["history"] !== "boolean")
      throw new SubthreadToolError("INPUT_INVALID");
    if (args["subthread"] === undefined) {
      const all = await this.#options.store.list({ ...this.#scope, parentThreadId: main });
      return {
        value: {
          subthreads: all.slice(-LIST_LIMIT).map((subthread) => ({
            subthread: subthread.threadId,
            matter: subthread.matter,
            status: subthread.status,
            opened_at: subthread.createdAt,
          })),
          ...(all.length > LIST_LIMIT ? { not_listed: all.length - LIST_LIMIT } : {}),
        },
      };
    }
    const subthread = await this.#child(main, args["subthread"]);
    const tasks = await this.#options.tasks.tasks(subthread.threadId);
    const rows = [];
    const classifications: DataClassification[] = [subthread.classification as DataClassification];
    for (const task of tasks) {
      const content = await this.#options.tasks.content(task);
      classifications.push(task.classification as DataClassification);
      rows.push({
        task: task.number,
        subject: content?.subject ?? null,
        active_form: content?.activeForm ?? null,
        status: task.status,
        blocked_by: task.blockedBy,
      });
    }
    const history =
      args["history"] === true
        ? await this.#history(subthread.threadId, classifications)
        : undefined;
    const result = subthread.resultRef ? await this.#text(subthread.resultRef) : undefined;
    return {
      value: {
        subthread: subthread.threadId,
        matter: subthread.matter,
        status: subthread.status,
        brief: (await this.#text(subthread.briefRef)) ?? null,
        tasks: rows,
        ...(result === undefined ? {} : { result }),
        ...(history ? { history } : {}),
      },
      contentClassification: highestClassification("private", classifications),
    };
  }

  async #history(threadId: string, classifications: DataClassification[]) {
    const changes = await this.#options.store.listTaskChanges({
      ...this.#scope,
      threadId,
      limit: HISTORY_LIMIT,
    });
    const rows = [];
    for (const change of changes) {
      const content = await this.#options.tasks.content(change);
      classifications.push(change.classification as DataClassification);
      rows.push({
        task: change.number,
        revision: change.revision,
        at: change.changedAt,
        ...(content
          ? { subject: content.subject, status: content.status, blocked_by: content.blockedBy }
          : {}),
      });
    }
    return rows;
  }

  #event(subthread: SubthreadRecord, kind: string, body: string): string {
    return renderPrompt(SUBTHREAD_EVENT, {
      subthread: subthread.threadId,
      matter: subthread.matter,
      kind,
      body,
    });
  }

  async #tellMain(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["kind", "text", "wake"]);
    const kind = args["kind"];
    if (!(TELL_KINDS as readonly unknown[]).includes(kind))
      throw new SubthreadToolError("INPUT_INVALID");
    const text = textArgument(args["text"], FIELD_LIMIT);
    if (args["wake"] !== undefined && typeof args["wake"] !== "boolean")
      throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.open(threadId);
    if (!subthread) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const wake = kind !== "progress" || args["wake"] === true;
    if (wake)
      await this.#submit({
        kind: SUBTHREAD_EVENT_KIND,
        sourceRef: `${kind as string}:${digest([invocation.runId, invocation.toolCallId])}`,
        text: this.#event(subthread, kind as string, text),
        threadId: null,
        externalContent: await this.#marked(threadId),
      });
    return { value: { told: true, woke_main: wake } };
  }

  async #return(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["conclusion", "criteria", "outputs", "open_issues"]);
    const conclusion = textArgument(args["conclusion"], RESULT_LIMIT);
    const criteria = listArgument(args["criteria"], true);
    const outputs = listArgument(args["outputs"], false);
    const issues = listArgument(args["open_issues"], false);
    const subthread = await this.open(threadId);
    if (!subthread) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const tasks = await this.#options.tasks.tasks(threadId);
    if (tasks.some((task) => task.status !== "completed" && task.status !== "deleted"))
      throw new SubthreadToolError("TASKS_OPEN");
    const body = JSON.stringify(
      {
        conclusion,
        criteria,
        ...(outputs.length > 0 ? { outputs } : {}),
        ...(issues.length > 0 ? { open_issues: issues } : {}),
      },
      null,
      2,
    );
    const resultRef = `subthread-result:${digest([invocation.runId, invocation.toolCallId])}`;
    await this.#put(resultRef, body);
    await this.#submit({
      kind: SUBTHREAD_EVENT_KIND,
      sourceRef: `result:${threadId}`,
      text: this.#event(subthread, "result", body),
      threadId: null,
      externalContent: await this.#marked(threadId),
    });
    await this.#options.store.settle({
      ...this.#scope,
      threadId,
      to: "returned",
      resultRef,
      now: this.#options.clock.now(),
    });
    return { value: { returned: true } };
  }
}
