import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "../../apps/control-center/src/app/control-center-inventory.ts";

const KNOWN_GAP = "尚无验收场景（已知缺口）";

const WALKTHROUGH_COVERAGE = {
  threads: [
    "accept-homepage",
    "accept-news-search",
    "accept-long-answer",
    "accept-model-switch",
    "accept-conversation-search",
    "accept-phone-send",
  ],
  approvals: ["accept-search-approval", "accept-run-command"],
  memory: ["accept-memory-page", "accept-unrelated-no-memory", "accept-slow-memory-search"],
  settings: ["accept-search-toggle", "accept-phone-layout"],
  tasks: KNOWN_GAP,
  "inbox-digest": KNOWN_GAP,
  "capabilities-adapters": KNOWN_GAP,
  "authorizations-grants": KNOWN_GAP,
  "host-workspaces": KNOWN_GAP,
  suggestions: KNOWN_GAP,
  reflection: KNOWN_GAP,
  workers: KNOWN_GAP,
  improvements: KNOWN_GAP,
  trace: KNOWN_GAP,
  "sessions-devices": KNOWN_GAP,
  "health-deployment": KNOWN_GAP,
};

function releaseScenarios() {
  const source = readFileSync(
    path.join(import.meta.dirname, "../integration/product-path-browser.test.ts"),
    "utf8",
  );
  const block = /const RELEASE_ACCEPTANCE_SCENARIOS = \[([\s\S]*?)\] as const;/u.exec(source)?.[1];
  if (block === undefined) throw new Error("RELEASE_ACCEPTANCE_SCENARIOS_MOVED");
  return [...block.matchAll(/"(accept-[a-z-]+)"/gu)].map((match) => match[1]);
}

function gateScenarios() {
  const source = readFileSync(
    path.join(import.meta.dirname, "../../scripts/delivery-mode/browser-acceptance-gate.py"),
    "utf8",
  );
  const block = /REQUIRED_SCENARIOS = \(([\s\S]*?)\)/u.exec(source)?.[1];
  if (block === undefined) throw new Error("REQUIRED_SCENARIOS_MOVED");
  return [...block.matchAll(/'(accept-[a-z-]+)'/gu)].map((match) => match[1]);
}

function coverageProblems(surfaceIds, coverage, scenarios) {
  const problems = [];
  for (const id of surfaceIds) {
    const entry = coverage[id];
    if (entry === undefined) problems.push(`${id}: 入口清单里有，覆盖表里没有`);
    else if (typeof entry === "string") {
      if (entry !== KNOWN_GAP) problems.push(`${id}: 豁免理由必须是固定的已知缺口说明`);
    } else if (entry.length === 0) problems.push(`${id}: 没有列出任何场景`);
    else
      for (const name of entry)
        if (!scenarios.includes(name)) problems.push(`${id}: 场景 ${name} 不在发布验收清单里`);
  }
  for (const id of Object.keys(coverage))
    if (!surfaceIds.includes(id)) problems.push(`${id}: 覆盖表里有，入口清单里已经没有`);
  return problems;
}

describe("release walkthrough covers every control center entry or says why not", () => {
  const surfaceIds = CONTROL_CENTER_SURFACE_INVENTORY.map(({ id }) => id);

  it("accounts for every entry in the inventory", () => {
    expect(coverageProblems(surfaceIds, WALKTHROUGH_COVERAGE, releaseScenarios())).toEqual([]);
  });

  it("runs exactly the scenarios the release gate demands", () => {
    const gate = gateScenarios();
    const walkthrough = releaseScenarios();
    expect(new Set(gate).size).toBe(gate.length);
    expect([...gate].sort()).toEqual([...walkthrough].sort());
  });

  it("fails on an entry nobody accounted for, an unknown scenario and a stale row", () => {
    const scenarios = releaseScenarios();
    expect(
      coverageProblems([...surfaceIds, "brand-new-entry"], WALKTHROUGH_COVERAGE, scenarios),
    ).toEqual(["brand-new-entry: 入口清单里有，覆盖表里没有"]);
    expect(
      coverageProblems(
        surfaceIds,
        { ...WALKTHROUGH_COVERAGE, approvals: ["accept-nope"] },
        scenarios,
      ),
    ).toEqual(["approvals: 场景 accept-nope 不在发布验收清单里"]);
    expect(
      coverageProblems(surfaceIds, { ...WALKTHROUGH_COVERAGE, removed: KNOWN_GAP }, scenarios),
    ).toEqual(["removed: 覆盖表里有，入口清单里已经没有"]);
    expect(
      coverageProblems(surfaceIds, { ...WALKTHROUGH_COVERAGE, tasks: "随便写的理由" }, scenarios),
    ).toEqual(["tasks: 豁免理由必须是固定的已知缺口说明"]);
  });
});
