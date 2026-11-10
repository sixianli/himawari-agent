import type { RuleGate } from "./field-catalog.js";
import type { RuleOutcome, RuleRecord } from "./rule-book.js";
import {
  type CompiledRuleExpression,
  compileRuleExpression,
  type RuleFacts,
} from "./rule-expression.js";

export interface RuleHit {
  readonly id: string;
  readonly revision: number;
  readonly outcome: RuleOutcome;
}

export interface RuleDecision {
  readonly hits: readonly RuleHit[];
}

const CACHE_LIMIT = 256;

export class RuleJudge {
  readonly #compiled = new Map<string, CompiledRuleExpression>();

  decide(gate: RuleGate, facts: RuleFacts, rules: readonly RuleRecord[]): RuleDecision {
    const hits: RuleHit[] = [];
    for (const rule of rules) {
      if (rule.gate !== gate || rule.status !== "active") continue;
      if (this.#compile(rule).evaluate(facts))
        hits.push(Object.freeze({ id: rule.id, revision: rule.revision, outcome: rule.outcome }));
    }
    return Object.freeze({ hits: Object.freeze(hits) });
  }

  #compile(rule: RuleRecord): CompiledRuleExpression {
    const key = `${rule.gate}\n${rule.expression}`;
    const cached = this.#compiled.get(key);
    if (cached) return cached;
    const compiled = compileRuleExpression(rule.gate, rule.expression);
    if (this.#compiled.size >= CACHE_LIMIT) this.#compiled.clear();
    this.#compiled.set(key, compiled);
    return compiled;
  }
}
