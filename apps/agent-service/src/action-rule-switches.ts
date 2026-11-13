import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type AuthorityFence,
  BUILT_IN_ACTION_RULES,
  type ClockPort,
  type IdempotentAgentCommand,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RuleRecord,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { isConflict } from "./context-external-content.js";
import { actionRuleAuthorizationKey } from "./owner-scope-authorization.js";

export interface BuiltInActionRuleView {
  readonly ruleId: string;
  readonly revision: number;
  readonly outcome: "allow_preauthorized" | "ask_owner" | "refuse";
  readonly examplesHit: number;
  readonly examplesMiss: number;
  readonly askFirst: boolean | null;
}

const SWITCH_ATTEMPTS = 3;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class BuiltInActionRuleSwitches {
  readonly #configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly #state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly #authority: () => AuthorityFence;
  readonly #clock: ClockPort;
  readonly #rules: readonly RuleRecord[];

  constructor(options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
    readonly authority: () => AuthorityFence;
    readonly clock: ClockPort;
    readonly rules?: readonly RuleRecord[];
  }) {
    this.#configuration = options.configuration;
    this.#state = options.state;
    this.#authority = options.authority;
    this.#clock = options.clock;
    this.#rules = (options.rules ?? BUILT_IN_ACTION_RULES).filter(
      (rule) => rule.gate === "action" && rule.status === "active",
    );
  }

  #read(ruleId: string) {
    const { ownerId, agentId } = this.#configuration;
    return this.#state.readScopedState(ownerId, agentId, actionRuleAuthorizationKey(ruleId));
  }

  async list(): Promise<readonly BuiltInActionRuleView[]> {
    return Promise.all(
      this.#rules.map(async (rule) => {
        const outcome = rule.outcome as BuiltInActionRuleView["outcome"];
        const record = outcome === "allow_preauthorized" ? await this.#read(rule.id) : undefined;
        return Object.freeze({
          ruleId: rule.id,
          revision: rule.revision,
          outcome,
          examplesHit: rule.examples.filter(({ hit }) => hit).length,
          examplesMiss: rule.examples.filter(({ hit }) => !hit).length,
          askFirst:
            outcome === "allow_preauthorized"
              ? record !== undefined && record.value["enabled"] !== true
              : null,
        });
      }),
    );
  }

  async setAskFirst(ruleId: string, askFirst: boolean): Promise<void> {
    const rule = this.#rules.find(({ id }) => id === ruleId);
    if (!rule) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "ACTION_RULE_NOT_FOUND");
    if (rule.outcome !== "allow_preauthorized")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "ACTION_RULE_HAS_NO_SWITCH",
      );
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#write(rule, askFirst);
        return;
      } catch (error) {
        if (!isConflict(error) || attempt >= SWITCH_ATTEMPTS - 1) throw error;
      }
    }
  }

  async #write(rule: RuleRecord, askFirst: boolean): Promise<void> {
    const ruleId = rule.id;
    const { ownerId, agentId } = this.#configuration;
    const key = actionRuleAuthorizationKey(ruleId);
    const record = await this.#read(ruleId);
    if (record && (record.value["enabled"] !== true) === askFirst) return;
    const value = { enabled: !askFirst, ruleRevision: rule.revision, actorId: ownerId };
    await this.#state.commitStateAndEvents({
      command: {
        ownerId,
        agentId,
        commandType: "authorization.action_rule.set",
        idempotencyKey:
          `${key}:owner:${record?.revision ?? 0}:${askFirst}` as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest([record?.revision ?? 0, value]),
        authority: this.#authority(),
      },
      state: { key, expectedRevision: record?.revision ?? null, value },
      events: [],
      resultRef: key,
      committedAt: this.#clock.now(),
    });
  }
}
