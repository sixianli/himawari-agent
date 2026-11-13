import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_RULE_IDS,
  BUILT_IN_ACTION_RULES,
  BUILT_IN_RULES,
  RULE_IDS,
} from "@himawari-agent/application";
import { expect, it } from "vitest";

const FROZEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "rule-ids.frozen.json");

function frozenIds(): readonly string[] {
  return JSON.parse(readFileSync(FROZEN_FILE, "utf8")) as readonly string[];
}

function currentIds(
  named: readonly Readonly<Record<string, string>>[],
  records: readonly { readonly id: string }[],
): readonly string[] {
  return [
    ...new Set([...named.flatMap((ids) => Object.values(ids)), ...records.map(({ id }) => id)]),
  ].sort();
}

function renamed(frozen: readonly string[], current: readonly string[]): string[] {
  return frozen.filter((id) => !current.includes(id));
}

function unfrozen(frozen: readonly string[], current: readonly string[]): string[] {
  return current.filter((id) => !frozen.includes(id));
}

const shipped = currentIds(
  [RULE_IDS, ACTION_RULE_IDS],
  [...BUILT_IN_RULES, ...BUILT_IN_ACTION_RULES],
);

it("[ADR-0257] keeps every built-in rule id that ever shipped: the owner's switches, refusals and decisions are stored under it", () => {
  expect(renamed(frozenIds(), shipped)).toEqual([]);
});

it("[ADR-0257] makes a new built-in rule id join the frozen list in the same change", () => {
  expect(unfrozen(frozenIds(), shipped)).toEqual([]);
});

it("[ADR-0257] REVERSE: reports a renamed action rule as both missing and unfrozen", () => {
  const changed = currentIds(
    [RULE_IDS, { ...ACTION_RULE_IDS, preauthorizeOwnerData: "action_preauthorize_owner_data_v2" }],
    [
      ...BUILT_IN_RULES,
      ...BUILT_IN_ACTION_RULES.filter(({ id }) => id !== ACTION_RULE_IDS.preauthorizeOwnerData),
    ],
  );
  expect(renamed(frozenIds(), changed)).toEqual(["action_preauthorize_owner_data"]);
  expect(unfrozen(frozenIds(), changed)).toEqual(["action_preauthorize_owner_data_v2"]);
});
