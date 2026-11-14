import {
  createAgentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  ACTION_RULE_IDS,
  actionGateFacts,
  actionIntentFingerprint,
  assertRuleExamples,
  BUILT_IN_ACTION_RULES,
  computeActionRisk,
  decideActionRules,
  type DeterministicPolicyFact,
  type GovernedActionIntent,
  POLICY_FACT_CODES,
  POLICY_FACT_REGISTRY,
  RULE_GATES,
  type RuleRecord,
  RuleJudge,
  runtimePolicyFacts,
  sortPolicyFacts,
  ToolActionRegistry,
  ToolActionRegistryError,
  type ToolActionRow,
  validateGovernedActionIntent,
} from "../src/index.js";

function intent(facts: readonly DeterministicPolicyFact[]): GovernedActionIntent {
  const unrated: Omit<GovernedActionIntent, "finalRisk"> = {
    contractVersion: "authorization.v2",
    id: "owner-scope:test",
    ownerId: createOwnerId("owner:test"),
    agentId: createAgentId("agent:test"),
    runId: createRunId("run:test"),
    threadId: "thread:test",
    capabilityRef: "reminder.set",
    capabilityVersion: "1.0.0",
    operation: "set",
    resourceRef: "owner-scope:test",
    resourceRefs: ["owner-scope:test"],
    targets: [{ type: "tool", ref: "reminder_set" }],
    dataClassification: "private",
    sideEffect: "reversible",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: createIdempotencyKey("owner-scope:test"),
    reversible: true,
    requestedAt: "2026-11-12T00:00:00.000Z",
    expiresAt: "2026-11-12T00:10:00.000Z",
    actionKind: "CREATE_OR_UPDATE",
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    modelClassification: {
      actionKind: "CREATE_OR_UPDATE",
      suggestedRisk: "MEDIUM",
      reasonCode: "product_owner_scope",
    },
    deterministicFacts: facts,
  };
  return { ...unrated, finalRisk: computeActionRisk({ ...unrated, finalRisk: "LOW" }) };
}

describe("policy fact registry", () => {
  it("[ADR-0257] gives every fact code a unique name and wording in three languages", () => {
    const codes = POLICY_FACT_REGISTRY.map(({ code }) => code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(Object.values(POLICY_FACT_CODES).sort());
    for (const { code, label } of POLICY_FACT_REGISTRY)
      for (const locale of ["zh", "en", "ja"] as const)
        expect(label[locale].length, `${code} ${locale}`).toBeGreaterThan(0);
  });

  it("[ADR-0257] refuses an action intent whose facts are unregistered, repeated or unsorted", () => {
    const external = { code: "context_external_content", minimumRisk: "LOW", source: "runtime" };
    const source = { code: "run_source_user_message", minimumRisk: "LOW", source: "runtime" };
    expect(() =>
      validateGovernedActionIntent(intent([external, source] as DeterministicPolicyFact[])),
    ).not.toThrow();
    for (const facts of [
      [{ ...external, code: "made_up_fact" }],
      [source, external],
      [external, external],
    ])
      expect(() =>
        validateGovernedActionIntent(intent(facts as DeterministicPolicyFact[])),
      ).toThrow(/policy facts/u);
  });

  it("[ADR-0257] gives the same fingerprint to the same facts written in a different order", () => {
    const forward = runtimePolicyFacts([
      POLICY_FACT_CODES.runSourceUserMessage,
      POLICY_FACT_CODES.contextExternalContent,
      POLICY_FACT_CODES.standingRuleChange,
    ]);
    const backward = sortPolicyFacts([...forward].reverse());
    expect(actionIntentFingerprint(intent(backward))).toBe(
      actionIntentFingerprint(intent(forward)),
    );
    expect(forward.every(({ minimumRisk }) => minimumRisk === "LOW")).toBe(true);
    expect(intent(forward).finalRisk).toBe("MEDIUM");
    expect(actionIntentFingerprint(intent(forward))).not.toBe(
      actionIntentFingerprint(intent(runtimePolicyFacts([POLICY_FACT_CODES.runSourceUserMessage]))),
    );
  });
});

describe("action gate", () => {
  const judge = new RuleJudge();
  const preauthorize = BUILT_IN_ACTION_RULES.find(
    ({ id }) => id === ACTION_RULE_IDS.preauthorizeOwnerData,
  ) as RuleRecord;

  it("[ADR-0257] keeps every built-in action rule on the action gate with examples that hit and do not hit", () => {
    expect(RULE_GATES).toContain("action");
    expect(new Set(BUILT_IN_ACTION_RULES.map(({ id }) => id)).size).toBe(
      BUILT_IN_ACTION_RULES.length,
    );
    for (const rule of BUILT_IN_ACTION_RULES) {
      expect(rule.gate, rule.id).toBe("action");
      expect(rule.source.length, rule.id).toBeGreaterThan(0);
      assertRuleExamples(rule);
      expect(
        rule.examples.some(({ hit }) => hit),
        rule.id,
      ).toBe(true);
      expect(
        rule.examples.some(({ hit }) => !hit),
        rule.id,
      ).toBe(true);
    }
  });

  it("[ADR-0257] fails when an example is flipped, the expression is replaced, or the outcome belongs to another gate", () => {
    expect(() =>
      assertRuleExamples({
        ...preauthorize,
        examples: preauthorize.examples.map((example) => ({ ...example, hit: !example.hit })),
      }),
    ).toThrow(/例子不符/u);
    expect(() => assertRuleExamples({ ...preauthorize, expression: "true" })).toThrow(/例子不符/u);
    expect(() => assertRuleExamples({ ...preauthorize, outcome: "raise_floor" })).toThrow(
      /不能用在闸门/u,
    );
    expect(() =>
      assertRuleExamples({ ...preauthorize, gate: "mail_item", expression: "true" }),
    ).toThrow(/不能用在闸门/u);
  });

  it("[ADR-0257] preauthorizes a reversible change to the owner's own data and nothing riskier", () => {
    const base = intent(runtimePolicyFacts([POLICY_FACT_CODES.runSourceUserMessage]));
    expect(decideActionRules(judge, actionGateFacts(base, "user_message"))).toMatchObject({
      outcome: "allow_preauthorized",
      hit: { id: ACTION_RULE_IDS.preauthorizeOwnerData, revision: 1 },
    });
    const withExternal = intent(
      runtimePolicyFacts([
        POLICY_FACT_CODES.runSourceUserMessage,
        POLICY_FACT_CODES.contextExternalContent,
      ]),
    );
    expect(decideActionRules(judge, actionGateFacts(withExternal, "user_message"))).toEqual({
      outcome: null,
      hit: null,
    });
    expect(
      decideActionRules(
        judge,
        actionGateFacts({ ...base, actionKind: "DELETE", finalRisk: "HIGH" }, "user_message"),
      ).outcome,
    ).toBeNull();
  });

  it("[ADR-0257] takes the strictest outcome when several action rules hit", () => {
    const facts = actionGateFacts(
      intent(runtimePolicyFacts([POLICY_FACT_CODES.runSourceSchedule])),
      "schedule",
    );
    const rule = (id: string, outcome: RuleRecord["outcome"]): RuleRecord => ({
      ...preauthorize,
      id,
      outcome,
      expression: 'run_source == "schedule"',
      examples: [],
    });
    expect(
      decideActionRules(judge, facts, [
        rule("ask", "ask_owner"),
        rule("refuse", "refuse"),
        preauthorize,
      ]).hit?.id,
    ).toBe("refuse");
    expect(decideActionRules(judge, facts, [preauthorize, rule("ask", "ask_owner")]).outcome).toBe(
      "ask_owner",
    );
  });
});

describe("tool action registry", () => {
  const row: ToolActionRow = {
    tool: "reminder_set",
    family: "builtin",
    capabilityRef: "reminder.set",
    operation: "set",
    actionKind: "CREATE_OR_UPDATE",
    reversible: true,
    sideEffect: "reversible",
    targetType: "owner-reminder",
    disclosure: "none",
    ownerPresenceRequired: false,
    standingRuleChange: false,
    resultOrigin: "owner_data",
    mayFollowExternalContent: true,
    authorization: "owner_scope",
    executor: "owner_scoped",
    deduplication: "run_and_tool_call",
    detail: () => "建提醒",
  };
  const device: ToolActionRow = {
    ...row,
    tool: "device_action:calendar.delete",
    family: "device_action",
    capabilityRef: "device.calendar.delete",
    operation: "calendar.delete",
    actionKind: "DELETE",
    ownerPresenceRequired: true,
    mayFollowExternalContent: false,
    executor: "device_pipeline",
    deduplication: "device_action_id",
    device: {
      schemaVersion: 1,
      deviceKinds: ["iphone"],
      parameters: { type: "object", additionalProperties: false },
      readBack: "event_absent",
      snapshotBefore: true,
    },
  };

  it("[ADR-0257] finds a row by tool name, by name prefix and by capability, and holds device actions in the same table", () => {
    const registry = new ToolActionRegistry([
      row,
      device,
      {
        ...row,
        tool: "authorized_",
        toolIsPrefix: true,
        capabilityRef: null,
        authorization: "governed_workflow",
      },
    ]);
    expect(registry.forTool("reminder_set")).toBe(row);
    expect(registry.forTool("authorized_abc")?.tool).toBe("authorized_");
    expect(registry.forTool("unknown_tool")).toBeUndefined();
    expect(registry.forCapability("device.calendar.delete")?.device?.snapshotBefore).toBe(true);
  });

  it("[ADR-0257] refuses a table with a repeated, incomplete or contradictory row", () => {
    for (const rows of [
      [row, row],
      [{ ...row, operation: "" }],
      [{ ...row, authorization: "read" }],
      [{ ...row, capabilityRef: null }],
      [{ ...row, sideEffect: "irreversible" }],
      [{ ...device, device: undefined }],
      [{ ...row, device: device.device }],
      [
        row,
        {
          ...row,
          tool: "reminder_",
          toolIsPrefix: true,
          capabilityRef: null,
          authorization: "governed_workflow",
        },
      ],
    ])
      expect(() => new ToolActionRegistry(rows as ToolActionRow[])).toThrow(
        ToolActionRegistryError,
      );
  });

  it("[ADR-0257] does not offer an unregistered tool or a parallel tool that has consequences", () => {
    const registry = new ToolActionRegistry([row]);
    const descriptor = {
      name: "reminder_set",
      capabilityRef: "reminder.set",
      capabilityHandleRef: null,
      description: "x",
      parameters: {},
    };
    expect(registry.offer([descriptor, { ...descriptor, name: "new_tool" }])).toEqual([descriptor]);
    expect(registry.offer([{ ...descriptor, executionMode: "parallel" }])).toEqual([]);
  });
});
