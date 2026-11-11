import type {
  ProactiveProcessedMessage,
  ProactiveScope,
  ProactiveSealPort,
  ProactiveStorePort,
} from "../ports/proactive-checks.js";
import type { ClockPort } from "../ports/system.js";
import { mailItemFacts, type RuleRecord } from "../rules/rule-book.js";
import { RuleJudge } from "../rules/rule-judge.js";

const OUTCOMES = ["ignore", "know", "check", "act"] as const;
const ADDRESS = /<([^<>\s]+@[^<>\s]+)>|([^\s<>"]+@[^\s<>"]+)/u;
const LISTED_CHANGES = 20;

export interface OwnerRuleReplayChange {
  readonly messageId: string;
  readonly decidedAt: string;
  readonly from: string;
  readonly subject: string;
  readonly before: ProactiveProcessedMessage["outcome"];
  readonly after: "check" | "whole_thread";
  readonly rating: ProactiveProcessedMessage["ownerRating"];
}

export interface OwnerRuleReplayResult {
  readonly days: number;
  readonly mailsChecked: number;
  readonly mailsHit: number;
  readonly changed: number;
  readonly usefulChanged: readonly OwnerRuleReplayChange[];
  readonly headersOnly: number;
  readonly truncated: boolean;
}

export interface OwnerRuleReplayOptions {
  readonly scope: ProactiveScope;
  readonly store: Pick<ProactiveStorePort, "listProcessed" | "readDecisionPayloads">;
  readonly seal: Pick<ProactiveSealPort, "open">;
  readonly readModelInput: (payloadRef: string) => Promise<string>;
  readonly clock: ClockPort;
  readonly days: number;
  readonly mailsPerOutcome: number;
}

interface ReplayMail {
  readonly from: string;
  readonly subject: string;
  readonly body: string | null;
}

function address(from: string): string {
  const match = ADDRESS.exec(from);
  return (match?.[1] ?? match?.[2] ?? from).trim();
}

function mailsInPrompt(text: string): ReadonlyMap<string, ReplayMail> {
  const found = new Map<string, ReplayMail>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("[{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["id"] !== "string" || typeof record["from"] !== "string") continue;
      const body =
        typeof record["body"] === "string"
          ? record["body"]
          : typeof record["snippet"] === "string"
            ? record["snippet"]
            : null;
      found.set(record["id"], {
        from: record["from"],
        subject: typeof record["subject"] === "string" ? record["subject"] : "",
        body,
      });
    }
  }
  return found;
}

export class OwnerRuleReplay {
  readonly #options: OwnerRuleReplayOptions;
  readonly #judge = new RuleJudge();

  constructor(options: OwnerRuleReplayOptions) {
    this.#options = options;
  }

  async #prompts(decisionId: string, cache: Map<string, ReadonlyMap<string, ReplayMail>>) {
    const cached = cache.get(decisionId);
    if (cached) return cached;
    const merged = new Map<string, ReplayMail>();
    const payloads = await this.#options.store.readDecisionPayloads({
      ...this.#options.scope,
      decisionId,
    });
    for (const payload of payloads) {
      if (payload.role !== "model_input") continue;
      const text = await this.#options.readModelInput(payload.ref).catch(() => "");
      for (const [id, mail] of mailsInPrompt(text)) merged.set(id, mail);
    }
    cache.set(decisionId, merged);
    return merged;
  }

  async #header(ref: string | null): Promise<ReplayMail | undefined> {
    if (ref === null) return undefined;
    const text = await this.#options.seal
      .open({ ...this.#options.scope, ref })
      .catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      return {
        from: typeof value["from"] === "string" ? value["from"] : "",
        subject: typeof value["subject"] === "string" ? value["subject"] : "",
        body: null,
      };
    } catch {
      return undefined;
    }
  }

  async replay(rule: RuleRecord): Promise<OwnerRuleReplayResult> {
    const since = new Date(
      Date.parse(this.#options.clock.now()) - this.#options.days * 86_400_000,
    ).toISOString();
    const prompts = new Map<string, ReadonlyMap<string, ReplayMail>>();
    let mailsChecked = 0;
    let mailsHit = 0;
    let changed = 0;
    let headersOnly = 0;
    let truncated = false;
    const usefulChanged: OwnerRuleReplayChange[] = [];
    for (const outcome of OUTCOMES) {
      const processed = await this.#options.store.listProcessed({
        ...this.#options.scope,
        since,
        outcome,
        limit: this.#options.mailsPerOutcome,
      });
      if (processed.length >= this.#options.mailsPerOutcome) truncated = true;
      for (const entry of processed) {
        const fromPrompt = (await this.#prompts(entry.decisionId, prompts)).get(entry.messageId);
        const mail = fromPrompt ?? (await this.#header(entry.headerRef));
        if (!mail) continue;
        if (!fromPrompt) headersOnly += 1;
        mailsChecked += 1;
        const facts = mailItemFacts({
          fromAddress: address(mail.from),
          subject: mail.subject,
          snippet: "",
          body: mail.body,
        });
        if (this.#judge.decide(rule.gate, facts, [rule]).hits.length === 0) continue;
        mailsHit += 1;
        if (outcome !== "ignore" && outcome !== "know") continue;
        changed += 1;
        if (entry.ownerRating !== "useful" || usefulChanged.length >= LISTED_CHANGES) continue;
        usefulChanged.push(
          Object.freeze({
            messageId: entry.messageId,
            decidedAt: entry.processedAt,
            from: mail.from,
            subject: mail.subject,
            before: outcome,
            after: rule.outcome === "require_whole_thread" ? "whole_thread" : "check",
            rating: entry.ownerRating,
          }),
        );
      }
    }
    return Object.freeze({
      days: this.#options.days,
      mailsChecked,
      mailsHit,
      changed,
      usefulChanged: Object.freeze(usefulChanged),
      headersOnly,
      truncated,
    });
  }
}
