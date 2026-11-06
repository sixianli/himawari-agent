import type { AgentId, OwnerId, RunId, ThreadId } from "@himawari-agent/domain";

export const SENSITIVE_INTERCEPTION_SOURCES = [
  "chat",
  "background",
  "embedding",
  "tool_result",
  "mail",
  "memory_capture",
] as const;

export const SENSITIVE_INTERCEPTION_PARTS = [
  "system",
  "owner_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "embedding_input",
  "file",
  "command_output",
  "web_page",
  "mail",
  "memory_candidate",
  "memory_source",
] as const;

export const SENSITIVE_INTERCEPTION_CATEGORIES = [
  "machine-secret",
  "password",
  "verification-code",
  "bank-card",
  "identity-number",
] as const;

export const SENSITIVE_INTERCEPTION_OUTCOMES = ["masked", "withheld", "not_saved"] as const;

export const SENSITIVE_INTERCEPTION_PAGE_LIMIT = 100;

export type SensitiveInterceptionSource = (typeof SENSITIVE_INTERCEPTION_SOURCES)[number];
export type SensitiveInterceptionPart = (typeof SENSITIVE_INTERCEPTION_PARTS)[number];
export type SensitiveInterceptionCategory = (typeof SENSITIVE_INTERCEPTION_CATEGORIES)[number];
export type SensitiveInterceptionOutcome = (typeof SENSITIVE_INTERCEPTION_OUTCOMES)[number];

export interface SensitiveInterceptionScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface SensitiveInterceptionObservation {
  readonly threadId: ThreadId | null;
  readonly source: SensitiveInterceptionSource;
  readonly purpose: string | null;
  readonly part: SensitiveInterceptionPart;
  readonly category: SensitiveInterceptionCategory;
  readonly ruleId: string;
  readonly fingerprint: string;
  readonly outcome: SensitiveInterceptionOutcome;
  readonly occurrences: number;
}

export interface SensitiveInterceptionRecordInput extends SensitiveInterceptionScope {
  readonly observations: readonly SensitiveInterceptionObservation[];
  readonly now: string;
}

export interface SensitiveInterceptionRunInput extends SensitiveInterceptionScope {
  readonly runId: RunId;
}

export interface SensitiveInterceptionRecordResult {
  readonly recorded: number;
  readonly skipped: number;
}

export interface SensitiveInterception {
  readonly id: string;
  readonly threadId: ThreadId | null;
  readonly source: SensitiveInterceptionSource;
  readonly purpose: string | null;
  readonly part: SensitiveInterceptionPart;
  readonly category: SensitiveInterceptionCategory;
  readonly ruleId: string;
  readonly outcome: SensitiveInterceptionOutcome;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
}

export interface SensitiveInterceptionCursor {
  readonly firstSeenAt: string;
  readonly id: string;
}

export interface SensitiveInterceptionListInput extends SensitiveInterceptionScope {
  readonly limit: number;
  readonly before: SensitiveInterceptionCursor | null;
}

export interface SensitiveInterceptionPage {
  readonly items: readonly SensitiveInterception[];
  readonly next: SensitiveInterceptionCursor | null;
}

export type SensitiveInterceptionSummary = Readonly<Record<SensitiveInterceptionOutcome, number>>;

export interface SensitiveInterceptionStorePort {
  record(input: SensitiveInterceptionRecordInput): Promise<SensitiveInterceptionRecordResult>;
  list(input: SensitiveInterceptionListInput): Promise<SensitiveInterceptionPage>;
  summarize(input: SensitiveInterceptionScope): Promise<SensitiveInterceptionSummary>;
  clear(input: SensitiveInterceptionScope): Promise<{ readonly cleared: number }>;
  threadOfRun(input: SensitiveInterceptionRunInput): Promise<ThreadId | null>;
}
