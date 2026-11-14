import { createHash } from "node:crypto";
import {
  type ApprovalRequest,
  type ClockPort,
  type HomeAction,
  type HomeActionName,
  type HomeCandidate,
  type HomeFeedConfiguration,
  HomeFeedService,
  type HomeLocale,
  type HomeSource,
  type HomeSourceName,
  type RunLifecyclePort,
} from "@himawari-agent/application";
import {
  type GatewayV2Query,
  type GatewayV2Snapshot,
  HOME_KEY_MAXIMUM,
  machineString,
} from "@himawari-agent/gateway-contracts";
import {
  approvalCommand,
  decodeHomeBinding,
  encodeHomeBinding,
  externalCommand,
  type HomeCommand,
  insightCommand,
  memoryRequestCommand,
  reminderCommand,
  ruleCommand,
} from "./production-home-binding.js";
import type { ProductionMemoryControl } from "./production-memory-control.js";
import type { ProductionProactive } from "./production-proactive.js";

export type HomeActionResolution =
  | {
      readonly ok: true;
      readonly type: HomeCommand["type"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly ownerPresence: boolean;
      readonly dataClassification: HomeCandidate["dataClassification"];
    }
  | {
      readonly ok: false;
      readonly reason: "binding_invalid" | "item_gone" | "action_not_offered" | "binding_stale";
    };

export const PRODUCTION_HOME_OPERATIONS = Object.freeze(["home.read"] as const);

export const HOME_TEXT = {
  "zh-CN": {
    gmailReconnect: "Google 授权失效，Gmail 读不了；等你重新连接",
    ruleReview: "有一条规则的来源记忆改过，等你重新确认",
    reviewFirst: "看内容再定",
    actions: {
      done: "完成",
      mute: "不再提醒",
      dismiss: "知道了",
      snooze: "稍后再提醒",
      cancel: "取消这个提醒",
      approved: "同意",
      denied: "不同意",
      rejected: "不记",
      keep: "记下",
      reject: "不记",
      reconfirm: "仍然有效",
      undo: "撤掉这条规则",
      reconnect: "重新连接",
    },
    remember: "记下",
  },
  en: {
    gmailReconnect: "Google access expired, so Gmail can’t be read until you reconnect",
    ruleReview: "The source memory of one rule changed; it is waiting for you to confirm it again",
    reviewFirst: "Review first",
    actions: {
      done: "Done",
      mute: "Stop reminding",
      dismiss: "Got it",
      snooze: "Remind me later",
      cancel: "Cancel this reminder",
      approved: "Approve",
      denied: "Deny",
      rejected: "Don’t remember",
      keep: "Remember",
      reject: "Don’t remember",
      reconfirm: "Still valid",
      undo: "Remove this rule",
      reconnect: "Reconnect",
    },
    remember: "Remember",
  },
  ja: {
    gmailReconnect: "Google の許可が切れ、Gmail を読めません。再接続をお待ちしています",
    ruleReview: "ルールの元の記憶が変わりました。再確認をお待ちしています",
    reviewFirst: "内容を見て決める",
    actions: {
      done: "完了",
      mute: "今後は通知しない",
      dismiss: "わかりました",
      snooze: "あとで知らせる",
      cancel: "このリマインダーを取り消す",
      approved: "同意する",
      denied: "同意しない",
      rejected: "覚えない",
      keep: "覚える",
      reject: "覚えない",
      reconfirm: "引き続き有効",
      undo: "このルールを取り消す",
      reconnect: "再接続",
    },
    remember: "覚える",
  },
} as const satisfies Record<
  HomeLocale,
  { readonly actions: Record<HomeActionName, string> } & Record<string, unknown>
>;

function action(
  locale: HomeLocale,
  name: HomeActionName,
  polarity: HomeAction["polarity"],
  options: {
    readonly label?: string;
    readonly ownerPresence?: boolean;
    readonly command?: HomeCommand;
  } = {},
): HomeAction {
  const ownerPresence = options.ownerPresence ?? false;
  return {
    action: name,
    label: options.label ?? HOME_TEXT[locale].actions[name],
    labelBasis: "catalog",
    polarity,
    ownerPresence,
    reviewLabel: ownerPresence ? HOME_TEXT[locale].reviewFirst : null,
    binding: options.command ? encodeHomeBinding(options.command) : null,
  };
}

type MemorySources = Pick<
  ProductionMemoryControl,
  | "pendingRequests"
  | "dueReminderViews"
  | "externalProposalViews"
  | "rulesNeedingReview"
  | "tidyUpViews"
  | "conversationReviewViews"
  | "upcomingViews"
>;

export interface ProductionHomeOptions {
  readonly settings: HomeFeedConfiguration;
  readonly proactive?: Pick<ProductionProactive, "overview">;
  readonly memory?: MemorySources;
  readonly listApprovals: () => Promise<readonly ApprovalRequest[]>;
  readonly runThread: (runId: string) => Promise<string | null>;
  readonly runs?: Pick<RunLifecyclePort, "listUnattendedRuns">;
  readonly threadTitle: (threadId: string) => Promise<{ readonly title: string | null } | null>;
  readonly clock: ClockPort;
  readonly onSourceFailure: (source: HomeSourceName, error: unknown) => void;
}

function line(text: string | null | undefined, maximum: number): string | null {
  if (!text) return null;
  const cleaned = [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  if (!cleaned) return null;
  let clipped = "";
  for (const character of cleaned) {
    if (clipped.length + character.length > maximum) break;
    clipped += character;
  }
  return clipped || null;
}

const NO_SENTENCE = { sentence: null, sentenceBasis: "none" as const };
const recorded = (text: string | null) =>
  text ? { sentence: text, sentenceBasis: "recorded" as const } : NO_SENTENCE;

function mailSource(proactive: Pick<ProductionProactive, "overview">): HomeSource {
  return {
    name: "mail",
    awaitsOwner: true,
    async read({ locale }) {
      const { insights, insightsCapped, connection, source } = await proactive.overview();
      const items = insights
        .filter(({ status }) => status === "open")
        .map(
          (insight): HomeCandidate => ({
            key: `insight:${insight.id}`,
            kind: "heads_up",
            awaitsOwner: true,
            ...recorded(
              line(insight.summary, 2000) ??
                line(insight.subject, 2000) ??
                line(insight.from, 2000),
            ),
            target: {
              type: "mail",
              id: insight.id,
              threadId: null,
              link: insight.link && insight.link.length <= 512 ? line(insight.link, 512) : null,
            },
            source: {
              type: "mail",
              from: line(insight.from, 320),
              label: line(insight.subject, 500),
              threadId: null,
              decisionId: insight.decisionId,
              at: insight.updatedAt,
            },
            deadline: insight.dueAt,
            createdAt: insight.createdAt,
            actions: [
              action(locale, "done", "positive", {
                command: insightCommand(insight.id, "done"),
              }),
              action(locale, "mute", "negative", {
                command: insightCommand(insight.id, "mute"),
              }),
            ],
            ruleHit: insight.floorRaised,
            dataClassification: insight.dataClassification,
          }),
        );
      const since = connection.changedAt ?? connection.connectedAt;
      if (connection.status === "needs_reconnect" && since)
        items.push({
          key: `connection:${source}`,
          kind: "problem",
          awaitsOwner: true,
          sentence: HOME_TEXT[locale].gmailReconnect,
          sentenceBasis: "catalog",
          target: { type: "connection", id: source, threadId: null, link: null },
          source: {
            type: "connection",
            from: line(connection.account, 320),
            label: null,
            threadId: null,
            decisionId: null,
            at: since,
          },
          deadline: null,
          createdAt: since,
          actions: [action(locale, "reconnect", "positive")],
          ruleHit: false,
          dataClassification: "private",
        });
      return { items, unread: 0, incomplete: insightsCapped };
    },
  };
}

function memorySources(memory: MemorySources): HomeSource[] {
  return [
    {
      name: "reminders",
      awaitsOwner: true,
      async read({ limit, locale }) {
        const { items, unread } = await memory.dueReminderViews(limit);
        return {
          unread,
          items: items.map(
            (reminder): HomeCandidate => ({
              key: `reminder:${reminder.reminderId}`,
              kind: "heads_up",
              awaitsOwner: true,
              ...recorded(line(reminder.text, 2000)),
              target: {
                type: "memory",
                id: reminder.memoryId,
                threadId: reminder.sourceThreadId,
                link: null,
              },
              source: {
                type: "memory",
                from: null,
                label: null,
                threadId: reminder.sourceThreadId,
                decisionId: null,
                at: reminder.remindAt,
              },
              deadline: reminder.dueAt,
              createdAt: reminder.remindAt,
              actions: [
                action(locale, "dismiss", "positive", {
                  command: reminderCommand(reminder.reminderId, "dismiss"),
                }),
                action(locale, "snooze", "neutral", {
                  command: reminderCommand(reminder.reminderId, "snooze"),
                }),
                action(locale, "cancel", "negative", {
                  command: reminderCommand(reminder.reminderId, "cancel"),
                }),
              ],
              ruleHit: false,
              dataClassification: reminder.dataClassification,
            }),
          ),
        };
      },
    },
    {
      name: "memory_requests",
      awaitsOwner: true,
      async read({ locale }) {
        return {
          unread: 0,
          items: (await memory.pendingRequests()).map(
            (request): HomeCandidate => ({
              key: `memory_request:${request.requestId}`,
              kind: "memory_confirm",
              awaitsOwner: true,
              ...recorded(line(request.text, 2000)),
              target: {
                type: "memory_request",
                id: request.requestId,
                threadId: request.threadId,
                link: null,
              },
              source: {
                type: "conversation",
                from: null,
                label: null,
                threadId: request.threadId,
                decisionId: null,
                at: request.requestedAt,
              },
              deadline: null,
              createdAt: request.requestedAt,
              actions: [
                action(locale, "approved", "positive", {
                  label: HOME_TEXT[locale].remember,
                  command: memoryRequestCommand(request.requestId, "approved"),
                }),
                action(locale, "rejected", "negative", {
                  command: memoryRequestCommand(request.requestId, "rejected"),
                }),
              ],
              ruleHit: false,
              dataClassification: request.dataClassification,
            }),
          ),
        };
      },
    },
    {
      name: "external_proposals",
      awaitsOwner: true,
      async read({ limit, locale }) {
        const { items, total } = await memory.externalProposalViews(limit);
        return {
          unread: Math.max(0, total - items.length),
          items: items.map(
            (proposal): HomeCandidate => ({
              key: `external_proposal:${proposal.proposalId}`,
              kind: "memory_confirm",
              awaitsOwner: true,
              ...recorded(line(proposal.text, 2000)),
              target: {
                type: "external_proposal",
                id: proposal.proposalId,
                threadId: null,
                link: null,
              },
              source: {
                type: "agent",
                from: line(proposal.client, 320),
                label: null,
                threadId: null,
                decisionId: null,
                at: proposal.receivedAt,
              },
              deadline: null,
              createdAt: proposal.receivedAt,
              actions: [
                action(locale, "keep", "positive", {
                  command: externalCommand(proposal.proposalId, "keep"),
                }),
                action(locale, "reject", "negative", {
                  command: externalCommand(proposal.proposalId, "reject"),
                }),
              ],
              ruleHit: false,
              dataClassification: proposal.dataClassification,
            }),
          ),
        };
      },
    },
    {
      name: "rules",
      awaitsOwner: true,
      async read({ locale }) {
        return {
          unread: 0,
          items: (await memory.rulesNeedingReview()).map(
            (rule): HomeCandidate => ({
              key: `rule:${rule.ruleId}`,
              kind: "problem",
              awaitsOwner: true,
              sentence: HOME_TEXT[locale].ruleReview,
              sentenceBasis: "catalog",
              target: { type: "rule", id: rule.ruleId, threadId: null, link: null },
              source: {
                type: "rule",
                from: null,
                label: line(rule.summary, 500),
                threadId: null,
                decisionId: null,
                at: rule.updatedAt,
              },
              deadline: null,
              createdAt: rule.updatedAt,
              actions: [
                action(locale, "reconfirm", "positive", {
                  command: ruleCommand(rule.ruleId, "reconfirm"),
                }),
                action(locale, "undo", "negative", {
                  command: ruleCommand(rule.ruleId, "undo"),
                }),
              ],
              ruleHit: false,
              dataClassification: "private",
            }),
          ),
        };
      },
    },
    {
      name: "done",
      awaitsOwner: false,
      async read({ limit, recentSince }) {
        const done = (
          text: string,
          key: string,
          memoryId: string,
          at: string,
          dataClassification: HomeCandidate["dataClassification"],
        ): HomeCandidate => ({
          key,
          kind: "done",
          awaitsOwner: false,
          ...recorded(line(text, 2000)),
          target: { type: "memory", id: memoryId, threadId: null, link: null },
          source: {
            type: "memory",
            from: null,
            label: null,
            threadId: null,
            decisionId: null,
            at,
          },
          deadline: null,
          createdAt: at,
          actions: [],
          ruleHit: false,
          dataClassification,
        });
        const tidy = (await memory.tidyUpViews(limit))
          .filter(({ undone, createdAt }) => !undone && createdAt >= recentSince)
          .map((change) =>
            done(
              change.text,
              `tidy:${change.changeId}`,
              change.memoryId,
              change.createdAt,
              change.dataClassification,
            ),
          );
        const reviews = (await memory.conversationReviewViews(limit, { lead: true })).flatMap(
          (review) =>
            !review.lead || review.undone || review.finishedAt < recentSince
              ? []
              : [
                  done(
                    review.lead.text,
                    `review:${review.reviewId}`,
                    review.lead.memoryId,
                    review.finishedAt,
                    review.lead.dataClassification,
                  ),
                ],
        );
        return { unread: 0, items: [...tidy, ...reviews] };
      },
    },
  ];
}

function approvalSource(options: ProductionHomeOptions): HomeSource {
  return {
    name: "approvals",
    awaitsOwner: true,
    async read({ now, locale }) {
      const items: HomeCandidate[] = [];
      for (const approval of await options.listApprovals()) {
        if (approval.status !== "pending" || Date.parse(approval.expiresAt) <= Date.parse(now))
          continue;
        const threadId = await options.runThread(approval.runId);
        items.push({
          key: `approval:${approval.id}`,
          kind: "approval",
          awaitsOwner: true,
          ...NO_SENTENCE,
          target: { type: "approval", id: approval.id, threadId, link: null },
          source: {
            type: "conversation",
            from: null,
            label: null,
            threadId,
            decisionId: null,
            at: approval.requestedAt,
          },
          deadline: approval.expiresAt,
          createdAt: approval.requestedAt,
          actions: [
            action(locale, "approved", "positive", {
              ownerPresence:
                "recentAuthenticationRequired" in approval &&
                approval.recentAuthenticationRequired === true,
              command: approvalCommand(approval, "approved"),
            }),
            action(locale, "denied", "negative", {
              command: approvalCommand(approval, "denied"),
            }),
          ],
          ruleHit: false,
          dataClassification: approval.intentSnapshot.dataClassification,
        });
      }
      return { items, unread: 0 };
    },
  };
}

function runSource(
  options: ProductionHomeOptions,
  runs: Pick<RunLifecyclePort, "listUnattendedRuns">,
): HomeSource {
  return {
    name: "runs",
    awaitsOwner: false,
    async read({ limit, recentSince }) {
      const items: HomeCandidate[] = [];
      for (const run of (await runs.listUnattendedRuns?.({ failedSince: recentSince, limit })) ??
        []) {
        const thread = run.threadId ? await options.threadTitle(run.threadId) : null;
        if (run.threadId && !thread) continue;
        const at = run.state === "running" ? run.startedAt : run.updatedAt;
        items.push({
          key: `run:${run.runId}`,
          kind: run.state === "running" ? "running" : "problem",
          awaitsOwner: false,
          ...recorded(line(thread?.title, 2000)),
          target: { type: "thread", id: run.threadId, threadId: run.threadId, link: null },
          source: {
            type: "conversation",
            from: null,
            label: null,
            threadId: run.threadId,
            decisionId: null,
            at,
          },
          deadline: null,
          createdAt: at,
          actions: [],
          ruleHit: false,
          dataClassification: "private",
        });
      }
      return { items, unread: 0 };
    },
  };
}

function fitsMachineStrings(ids: readonly (string | null)[]): boolean {
  try {
    for (const id of ids) if (id !== null) machineString.parse(id);
    return true;
  } catch {
    return false;
  }
}

function fitsContract(item: HomeCandidate): boolean {
  return (
    item.key.length <= HOME_KEY_MAXIMUM &&
    fitsMachineStrings([
      item.target.id,
      item.target.threadId,
      item.source.threadId,
      item.source.decisionId,
    ])
  );
}

function notShowable(): Error {
  return Object.assign(new Error("HOME_ITEM_ID_NOT_SHOWABLE"), {
    name: "HOME_ITEM_ID_NOT_SHOWABLE",
  });
}

function showableOnly(
  source: HomeSource,
  onSourceFailure: ProductionHomeOptions["onSourceFailure"],
): HomeSource {
  return {
    name: source.name,
    awaitsOwner: source.awaitsOwner,
    async read(input) {
      const result = await source.read(input);
      const items = result.items.filter(fitsContract);
      if (items.length === result.items.length) return result;
      onSourceFailure(source.name, notShowable());
      return { ...result, items, incomplete: true };
    },
  };
}

export function createProductionHomeSources(options: ProductionHomeOptions): HomeSource[] {
  return [
    ...(options.proactive ? [mailSource(options.proactive)] : []),
    approvalSource(options),
    ...(options.memory ? memorySources(options.memory) : []),
    ...(options.runs ? [runSource(options, options.runs)] : []),
  ].map((source) => showableOnly(source, options.onSourceFailure));
}

export class ProductionHomeControl {
  readonly #service: HomeFeedService;

  constructor(options: ProductionHomeOptions) {
    const { memory, settings } = options;
    this.#service = new HomeFeedService({
      sources: createProductionHomeSources(options),
      ...(memory
        ? {
            upcoming: async ({ now, until, limit }) => {
              if (limit === 0) return { items: [], incomplete: false };
              const entries = await memory.upcomingViews({
                now,
                until,
                limit,
                exclude: new Set(),
                notYetDue: true,
              });
              const items = entries.filter((entry) =>
                fitsMachineStrings([entry.reminderId, entry.memoryId, entry.sourceThreadId]),
              );
              const incomplete = items.length < entries.length;
              if (incomplete) options.onSourceFailure("upcoming", notShowable());
              return { items, incomplete };
            },
          }
        : {}),
      settings,
      clock: options.clock,
      digest: (text) => createHash("sha256").update(text).digest("hex"),
      onSourceFailure: options.onSourceFailure,
    });
  }

  awaitingCount(): Promise<number | undefined> {
    return this.#service.awaitingCount();
  }

  async resolveAction(input: {
    readonly key: string;
    readonly action: string;
    readonly binding: string;
  }): Promise<HomeActionResolution> {
    const command = decodeHomeBinding(input.binding);
    if (!command) return { ok: false, reason: "binding_invalid" };
    const feed = await this.#service.read({ locale: "en" });
    const item = feed.items.find(({ key }) => key === input.key);
    if (!item) return { ok: false, reason: "item_gone" };
    const chosen = item.actions.find(({ action: name }) => name === input.action);
    if (!chosen) return { ok: false, reason: "action_not_offered" };
    if (chosen.binding !== input.binding) return { ok: false, reason: "binding_stale" };
    return {
      ok: true,
      type: command.type,
      payload: command.payload,
      ownerPresence: chosen.ownerPresence,
      dataClassification: item.dataClassification,
    };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "home.read") throw new Error("HOME_OPERATION_NOT_INSTALLED");
    const feed = await this.#service.read({ locale: query.payload.locale });
    return {
      ...query,
      kind: "snapshot",
      type: "home.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        items: feed.items.map((item) => ({
          key: item.key,
          kind: item.kind,
          awaitsOwner: item.awaitsOwner,
          sentence: item.sentence,
          sentenceBasis: item.sentenceBasis,
          target: { ...item.target },
          source: { ...item.source },
          deadline: item.deadline,
          createdAt: item.createdAt,
          actions: item.actions.map((entry) => ({ ...entry })),
          rank: item.rank,
          dataClassification: item.dataClassification,
        })),
        awaitingCount: feed.awaitingCount,
        awaitingTruncated: feed.awaitingTruncated,
        incompleteSources: [...feed.incompleteSources],
        upcoming: feed.upcoming.map((entry) => ({ ...entry })),
        revision: feed.revision,
        generatedAt: feed.generatedAt,
      },
    };
  }
}
