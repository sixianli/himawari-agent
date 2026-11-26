import type { RuleRecord } from "../rules/rule-book.js";
import type { RuleFacts } from "../rules/rule-expression.js";
import { RuleJudge } from "../rules/rule-judge.js";
import { ruleRef } from "../rules/rule-ref.js";
import { zonedParts } from "./proactive-rules.js";

export const PUSH_CLASSES = [
  "scheduled_reminder",
  "approval",
  "run_result",
  "mail_reminder",
  "proposal",
  "her_words",
  "unknown",
] as const;
export type PushClass = (typeof PUSH_CLASSES)[number];

export const PUSH_RULE_PROTECTED_CLASSES: readonly PushClass[] = Object.freeze([
  "approval",
  "proposal",
  "unknown",
]);

export const HER_WORDS_PUSH_PREFIX = "said:";
const PUSH_SOURCE_KEY_LIMIT = 256;
const HER_WORDS_DIGEST_HEX = 32;

export interface HerWordsPushSource {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
}

export async function herWordsPushKey(input: {
  readonly messageId: string;
  readonly source?: HerWordsPushSource;
}): Promise<string> {
  const source = input.source ?? { kind: "message", id: input.messageId, version: "1" };
  for (const part of [source.kind, source.id, source.version])
    if (part.length === 0) throw new Error("HER_WORDS_PUSH_SOURCE_EMPTY");
  const key = `${HER_WORDS_PUSH_PREFIX}${[source.kind, source.id, source.version]
    .map((part) => `${part.length}:${part}`)
    .join("")}`;
  if (key.length <= PUSH_SOURCE_KEY_LIMIT) return key;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, HER_WORDS_DIGEST_HEX);
  return `${key.slice(0, PUSH_SOURCE_KEY_LIMIT - HER_WORDS_DIGEST_HEX - 1)}~${digest}`;
}

export const PUSH_DEFER_CAP_MS = 24 * 3_600_000;
const MINUTE_MS = 60_000;

export function pushClassOf(input: {
  readonly kind: string;
  readonly sourceKey: string;
}): PushClass {
  if (input.kind === "approval" && input.sourceKey.startsWith("approval:")) return "approval";
  if (input.kind === "run" && input.sourceKey.startsWith("run:")) return "run_result";
  if (input.kind === "reminder") {
    if (input.sourceKey.startsWith("proactive:")) return "mail_reminder";
    if (input.sourceKey.startsWith("proposal:")) return "proposal";
    if (input.sourceKey.startsWith("reminder:")) return "scheduled_reminder";
    if (input.sourceKey.startsWith(HER_WORDS_PUSH_PREFIX)) return "her_words";
  }
  return "unknown";
}

export function pushDeliveryFacts(pushClass: PushClass, at: string, timeZone: string): RuleFacts {
  const local = zonedParts(at, timeZone);
  return Object.freeze({
    push_class: pushClass,
    local_minutes: local.hour * 60 + local.minute,
    local_weekday: local.weekday,
    local_previous_weekday: (local.weekday + 6) % 7,
  });
}

export type PushGateDecision =
  | { readonly action: "deliver"; readonly failed: boolean }
  | {
      readonly action: "defer";
      readonly until: string;
      readonly capped: boolean;
      readonly ruleRefs: readonly string[];
    };

const DELIVER: PushGateDecision = Object.freeze({ action: "deliver", failed: false });
const DELIVER_FAILED: PushGateDecision = Object.freeze({ action: "deliver", failed: true });

export class PushGate {
  readonly #judge: RuleJudge;

  constructor(judge: RuleJudge = new RuleJudge()) {
    this.#judge = judge;
  }

  decide(input: {
    readonly pushClass: PushClass;
    readonly now: string;
    readonly timeZone: string;
    readonly rules: readonly RuleRecord[];
  }): PushGateDecision {
    if (PUSH_RULE_PROTECTED_CLASSES.includes(input.pushClass)) return DELIVER;
    try {
      const hitsAt = (at: string) =>
        this.#judge
          .decide(
            "push_delivery",
            pushDeliveryFacts(input.pushClass, at, input.timeZone),
            input.rules,
          )
          .hits.filter(({ outcome }) => outcome === "defer_to_quiet_hours");
      const first = hitsAt(input.now);
      if (first.length === 0) return DELIVER;
      const base = Math.floor(Date.parse(input.now) / MINUTE_MS) * MINUTE_MS;
      const limit = Date.parse(input.now) + PUSH_DEFER_CAP_MS;
      let until: string | null = null;
      const refSet = new Set(first.map(({ id, revision }) => ruleRef(id, revision)));
      for (let at = base + MINUTE_MS; at <= limit; at += MINUTE_MS) {
        const candidate = new Date(at).toISOString();
        const hits = hitsAt(candidate);
        if (hits.length === 0) {
          until = candidate;
          break;
        }
        for (const { id, revision } of hits) refSet.add(ruleRef(id, revision));
      }
      const refs = [...refSet].sort().slice(0, 16);
      return Object.freeze({
        action: "defer",
        until: until ?? new Date(limit).toISOString(),
        capped: until === null,
        ruleRefs: Object.freeze(refs),
      });
    } catch {
      return DELIVER_FAILED;
    }
  }
}
