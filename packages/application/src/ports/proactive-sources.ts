export const PROACTIVE_SOURCE_TRUST = ["owner", "external"] as const;
export type ProactiveSourceTrust = (typeof PROACTIVE_SOURCE_TRUST)[number];

export const PROACTIVE_SOURCE_INTAKES = ["reader", "written_by_program"] as const;
export type ProactiveSourceIntake = (typeof PROACTIVE_SOURCE_INTAKES)[number];

export const PROACTIVE_ITEMS_PER_CHECK_MAXIMUM = 500;

export const PROACTIVE_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export interface ProactiveSourceItem<Extra = Readonly<Record<string, unknown>>> {
  readonly source: ProactiveSource;
  readonly id: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly summary: string;
  readonly extra: Extra;
}

export interface ProactiveSourceProvenance {
  readonly kind: string;
  readonly author: string | null;
  readonly occurredAt: string;
}

export interface ProactiveSafetyLimit {
  readonly defaultLimit: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface ProactiveSourceSafetyLimits {
  readonly perDay: ProactiveSafetyLimit;
  readonly perCheck: ProactiveSafetyLimit;
}

export interface ProactiveSourceEvaluation {
  readonly calibrationGroups: readonly string[];
}

export interface ProactiveSourceDefinition<Name extends string = string, Extra = never> {
  readonly name: Name;
  readonly intake: ProactiveSourceIntake;
  readonly trust: ProactiveSourceTrust;
  readonly dedupKey: (item: ProactiveSourceItem<Extra>) => string;
  readonly groupKey: (item: ProactiveSourceItem<Extra>) => string;
  readonly provenance: (item: ProactiveSourceItem<Extra>) => ProactiveSourceProvenance;
  readonly safetyLimits: ProactiveSourceSafetyLimits;
  readonly latestDeliveryMs: number | null;
  readonly evaluation: ProactiveSourceEvaluation;
}

export interface ProactiveMailAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface ProactiveMailExtra {
  readonly threadId: string;
  readonly from: string;
  readonly fromAddress: string;
  readonly link: string;
  readonly categories: readonly string[];
  readonly sentByOwner: boolean;
  readonly body: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyUnavailable: boolean;
  readonly attachments: readonly ProactiveMailAttachment[];
  readonly participants?: readonly string[];
}

export type ProactiveMailItem = ProactiveSourceItem<ProactiveMailExtra>;

export const GMAIL_SOURCE = Object.freeze({
  name: "gmail",
  intake: "reader",
  trust: "external",
  dedupKey: (item: ProactiveMailItem) => item.id,
  groupKey: (item: ProactiveMailItem) => item.extra.threadId,
  provenance: (item: ProactiveMailItem) => ({
    kind: "mail",
    author: item.extra.fromAddress || null,
    occurredAt: item.occurredAt,
  }),
  safetyLimits: Object.freeze({
    perDay: Object.freeze({ defaultLimit: 5_000, minimum: 1, maximum: 1_000_000 }),
    perCheck: Object.freeze({
      defaultLimit: PROACTIVE_ITEMS_PER_CHECK_MAXIMUM,
      minimum: 1,
      maximum: PROACTIVE_ITEMS_PER_CHECK_MAXIMUM,
    }),
  }),
  latestDeliveryMs: null,
  evaluation: Object.freeze({
    calibrationGroups: Object.freeze(["proactive_pushed", "proactive_silent"]),
  }),
} as const satisfies ProactiveSourceDefinition<"gmail", ProactiveMailExtra>);

export interface ProactiveSourceRegistry<Name extends string = string> {
  readonly names: readonly Name[];
  has(value: unknown): value is Name;
  get(name: string): ProactiveSourceDefinition<Name, never> | undefined;
  readonly definitions: readonly ProactiveSourceDefinition<Name, never>[];
}

export function proactiveSourceDefinitionProblems(definition: unknown): readonly string[] {
  const entry = (definition ?? {}) as Partial<
    Record<keyof ProactiveSourceDefinition, unknown> & {
      safetyLimits: Partial<Record<keyof ProactiveSourceSafetyLimits, unknown>>;
      evaluation: Partial<Record<keyof ProactiveSourceEvaluation, unknown>>;
    }
  >;
  const problems: string[] = [];
  if (typeof entry.name !== "string" || !PROACTIVE_SOURCE_NAME_PATTERN.test(entry.name))
    problems.push("name");
  if (!(PROACTIVE_SOURCE_INTAKES as readonly unknown[]).includes(entry.intake))
    problems.push("intake");
  if (!(PROACTIVE_SOURCE_TRUST as readonly unknown[]).includes(entry.trust)) problems.push("trust");
  if (typeof entry.dedupKey !== "function") problems.push("dedupKey");
  if (typeof entry.groupKey !== "function") problems.push("groupKey");
  if (typeof entry.provenance !== "function") problems.push("provenance");
  for (const key of ["perDay", "perCheck"] as const) {
    const limit = entry.safetyLimits?.[key] as Partial<ProactiveSafetyLimit> | undefined;
    const numbers = [limit?.minimum, limit?.defaultLimit, limit?.maximum];
    if (
      !numbers.every((value) => Number.isSafeInteger(value) && (value as number) >= 1) ||
      (limit?.minimum as number) > (limit?.defaultLimit as number) ||
      (limit?.defaultLimit as number) > (limit?.maximum as number) ||
      (key === "perCheck" && (limit?.maximum as number) > PROACTIVE_ITEMS_PER_CHECK_MAXIMUM)
    )
      problems.push(`safetyLimits.${key}`);
  }
  if (
    entry.latestDeliveryMs !== null &&
    !(Number.isSafeInteger(entry.latestDeliveryMs) && (entry.latestDeliveryMs as number) > 0)
  )
    problems.push("latestDeliveryMs");
  const groups = entry.evaluation?.calibrationGroups;
  if (
    !Array.isArray(groups) ||
    groups.length < 1 ||
    groups.some((group) => typeof group !== "string" || group.length < 1)
  )
    problems.push("evaluation");
  return problems;
}

export function defineProactiveSources<
  const Definitions extends readonly ProactiveSourceDefinition<string, never>[],
>(definitions: Definitions): ProactiveSourceRegistry<Definitions[number]["name"]> {
  const byName = new Map<string, ProactiveSourceDefinition<string, never>>();
  for (const definition of definitions) {
    const problems = proactiveSourceDefinitionProblems(definition);
    if (problems.length > 0)
      throw new Error(
        `PROACTIVE_SOURCE_INVALID ${String(definition?.name)}: ${problems.join(", ")}`,
      );
    if (byName.has(definition.name))
      throw new Error(`PROACTIVE_SOURCE_DUPLICATE ${definition.name}`);
    byName.set(definition.name, definition);
  }
  type Name = Definitions[number]["name"];
  const names = Object.freeze([...byName.keys()]) as readonly Name[];
  return Object.freeze({
    names,
    definitions: Object.freeze([...byName.values()]) as readonly ProactiveSourceDefinition<
      Name,
      never
    >[],
    has: (value: unknown): value is Name => typeof value === "string" && byName.has(value),
    get: (name: string) => byName.get(name) as ProactiveSourceDefinition<Name, never> | undefined,
  });
}

export const PROACTIVE_SOURCES = defineProactiveSources([GMAIL_SOURCE]);

export type ProactiveSource = (typeof PROACTIVE_SOURCES.names)[number];
export const PROACTIVE_SOURCE_NAMES: readonly ProactiveSource[] = PROACTIVE_SOURCES.names;

export interface ProactiveSourceSettings {
  readonly source: ProactiveSource;
  readonly enabled: boolean;
  readonly perDay: number;
  readonly perCheck: number;
  readonly updatedAt: string | null;
}

export function defaultProactiveSourceSettings(
  definition: Pick<ProactiveSourceDefinition, "name" | "safetyLimits">,
): ProactiveSourceSettings {
  return Object.freeze({
    source: definition.name as ProactiveSource,
    enabled: true,
    perDay: definition.safetyLimits.perDay.defaultLimit,
    perCheck: definition.safetyLimits.perCheck.defaultLimit,
    updatedAt: null,
  });
}

export const PROACTIVE_SOURCE_LIMIT_ON_REACH = Object.freeze({
  perDay: "hold_until_reset",
  perCheck: "hold_until_next_check",
} as const);

export function proactiveSourceLimitKey(source: string, limit: "perDay" | "perCheck"): string {
  return `proactive.source.${source}.${limit}`;
}

export function proactiveSourceLimitsValid(
  definition: Pick<ProactiveSourceDefinition, "safetyLimits">,
  limits: { readonly perDay: unknown; readonly perCheck: unknown },
): boolean {
  return (["perDay", "perCheck"] as const).every((key) => {
    const value = limits[key];
    const range = definition.safetyLimits[key];
    return (
      Number.isSafeInteger(value) &&
      (value as number) >= range.minimum &&
      (value as number) <= range.maximum
    );
  });
}

export interface ProactiveMail {
  readonly source: ProactiveSource;
  readonly messageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly snippet: string;
  readonly link: string;
  readonly receivedAt: string;
  readonly categories: readonly string[];
  readonly sentByOwner: boolean;
  readonly body: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyUnavailable: boolean;
  readonly attachments: readonly ProactiveMailAttachment[];
  readonly participants?: readonly string[];
}

export function mailItem(mail: ProactiveMail): ProactiveMailItem {
  return {
    source: mail.source,
    id: mail.messageId,
    occurredAt: mail.receivedAt,
    title: mail.subject,
    summary: mail.snippet,
    extra: {
      threadId: mail.threadId,
      from: mail.from,
      fromAddress: mail.fromAddress,
      link: mail.link,
      categories: mail.categories,
      sentByOwner: mail.sentByOwner,
      body: mail.body,
      bodyTruncated: mail.bodyTruncated,
      bodyUnavailable: mail.bodyUnavailable,
      attachments: mail.attachments,
      ...(mail.participants === undefined ? {} : { participants: mail.participants }),
    },
  };
}

export function mailOf(item: ProactiveMailItem): ProactiveMail {
  return {
    source: item.source,
    messageId: item.id,
    threadId: item.extra.threadId,
    from: item.extra.from,
    fromAddress: item.extra.fromAddress,
    subject: item.title,
    snippet: item.summary,
    link: item.extra.link,
    receivedAt: item.occurredAt,
    categories: item.extra.categories,
    sentByOwner: item.extra.sentByOwner,
    body: item.extra.body,
    bodyTruncated: item.extra.bodyTruncated,
    bodyUnavailable: item.extra.bodyUnavailable,
    attachments: item.extra.attachments,
    ...(item.extra.participants === undefined ? {} : { participants: item.extra.participants }),
  };
}
