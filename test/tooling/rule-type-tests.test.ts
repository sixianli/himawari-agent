import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRuleExamples,
  ownerRuleRecord,
  RULE_TYPES,
  type RuleTypeDefinition,
  writableRuleType,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_SCRIPT =
  (
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts["check:rule-registry"] ?? "";
const SAMPLE_PARAMETERS = {
  senderDomains: ["example.org"],
  senderAddresses: ["clerk@example.net"],
  phrases: ["sample phrase"],
  words: ["sample"],
  excludePhrases: ["ignore me"],
};

const PUSH_SAMPLE_PARAMETERS = {
  periods: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
  classes: ["run_result"],
};

function ruleTypeTestProblems(
  registry: readonly RuleTypeDefinition[],
  read: (file: string) => string | undefined,
  script: string,
): string[] {
  const problems: string[] = [];
  for (const type of registry) {
    if (type.tests === null) continue;
    const source = read(type.tests);
    if (source === undefined) {
      problems.push(`${type.id}: 测试文件 ${type.tests} 不存在`);
      continue;
    }
    if (!source.includes(`describe("[rule-type:${type.id}]"`))
      problems.push(`${type.id}: 测试文件里没有 describe("[rule-type:${type.id}]")`);
    if (
      /\b(?:describe|it|test)\.(?:skip|todo|only|skipIf|runIf)\b|\bx(?:it|describe)\(/u.test(source)
    )
      problems.push(`${type.id}: 测试文件里有跳过或只跑部分用例的写法`);
    if (!script.split(/\s+/u).some((entry) => entry.length > 0 && type.tests?.startsWith(entry)))
      problems.push(`${type.id}: check:rule-registry 不会运行 ${type.tests}`);
  }
  return problems;
}

const readRepoFile = (file: string) => {
  const absolute = path.join(ROOT, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
};

describe("[P2-3] rule types", () => {
  it("gives every registered rule type a test file that check:rule-registry runs, with no skipped cases", () => {
    expect(RULE_TYPES.length).toBeGreaterThan(0);
    expect(ruleTypeTestProblems(RULE_TYPES, readRepoFile, REGISTRY_SCRIPT)).toEqual([]);
  });

  it("builds a rule from every registered type whose own examples the judge reproduces", () => {
    for (const type of RULE_TYPES) {
      const rule = ownerRuleRecord({
        ruleId: `owner:${type.id}`,
        revision: 1,
        status: "active",
        source: "test",
        parameters: {
          type: type.id,
          summary: "示例",
          params: type.gate === "push_delivery" ? PUSH_SAMPLE_PARAMETERS : SAMPLE_PARAMETERS,
        },
      });
      expect(rule.outcome, type.id).toBe(type.outcome);
      if (type.gate === "mail_item") {
        expect(rule.examples.filter(({ hit }) => hit).length, type.id).toBe(4);
        expect(rule.examples.filter(({ hit }) => !hit).length, type.id).toBe(2);
      } else {
        expect(
          rule.examples.some(({ hit }) => hit),
          type.id,
        ).toBe(true);
        expect(
          rule.examples.some(({ hit }) => !hit),
          type.id,
        ).toBe(true);
      }
      assertRuleExamples(rule);
    }
  });

  it("REVERSE: reports a type whose test file is missing, untagged, skipped or not run, and refuses to write an untested type", () => {
    const [type] = RULE_TYPES as [RuleTypeDefinition];
    const tagged = `describe("[rule-type:${type.id}]", () => {});`;
    const files: Record<string, string> = { [type.tests ?? ""]: tagged };
    const read = (file: string) => files[file];
    expect(ruleTypeTestProblems([type], read, REGISTRY_SCRIPT)).toEqual([]);
    expect(ruleTypeTestProblems([type], () => undefined, REGISTRY_SCRIPT)).toHaveLength(1);
    expect(ruleTypeTestProblems([type], () => 'describe("x")', REGISTRY_SCRIPT)).toHaveLength(1);
    expect(
      ruleTypeTestProblems([type], () => `${tagged}\nit.skip("a", () => {});`, REGISTRY_SCRIPT),
    ).toHaveLength(1);
    expect(ruleTypeTestProblems([type], read, "vitest run other.test.ts")).toHaveLength(1);
    expect(() => writableRuleType(type.id, [{ ...type, tests: null }])).toThrow(
      expect.objectContaining({ code: "RULE_TYPE_UNTESTED" }),
    );
  });
});
