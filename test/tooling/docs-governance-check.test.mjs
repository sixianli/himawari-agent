import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocsGovernance } from "../../scripts/check-docs-governance.mjs";

const skillScripts = resolve("tools/document-governance-skill/scripts");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const requiredDirectories = [
  "docs/adr",
  "docs/execution/specs",
  "docs/execution/plans",
  "docs/runbooks",
  "docs/archive/specs",
  "docs/archive/plans",
  "docs/archive/runbooks",
];

const runbook = `---
status: active
document_type: runbook
execution_risk: standard
contract_sha256: "sha256:${"0".repeat(64)}"
supersedes: ""
superseded_by: ""
date: "2026-10-26"
---

# Fixture Runbook

<!-- runbook-contract:
- contract
-->

## Scope

Fixture only.

## Authoritative Sources

The contract directory.

## Safety and Preconditions

Fixture only; no external effects.

## Live-State Preflight

Confirm this is an isolated test directory.

## Procedure

1. Read the contract.

## Verification

Compare the contract.

## Evidence

Keep the validator output.

## Rollback

Nothing to roll back.

## Stop Conditions

Stop on any mismatch.

## Troubleshooting

Rerun the seal.
`;

function adr(fields) {
  return `---\n${fields.join("\n")}\n---\n\n# ADR 0001: fixture\n`;
}

const acceptedAdr = adr([
  "status: active",
  "document_type: adr",
  "decision_status: accepted",
  'supersedes: ""',
  'superseded_by: ""',
  'date: "2026-10-26"',
]);

function project(mode) {
  const root = mkdtempSync(join(tmpdir(), "himawari-docs-governance-"));
  roots.push(root);
  for (const directory of requiredDirectories)
    mkdirSync(join(root, directory), { recursive: true });
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "DELIVERY_MODE"), `${mode}\n`);
  writeFileSync(join(root, "docs/adr/0001-fixture.md"), acceptedAdr);
  writeFileSync(join(root, "contract/config.txt"), "original\n");
  writeFileSync(join(root, "docs/runbooks/fixture-runbook.md"), runbook);
  execFileSync(
    "python3",
    [
      "-E",
      "-s",
      "-B",
      join(skillScripts, "runbook.py"),
      "seal",
      root,
      "docs/runbooks/fixture-runbook.md",
      "--confirm-reconciled",
      "--apply",
    ],
    { stdio: "pipe" },
  );
  return root;
}

describe("documentation governance check", () => {
  it.each(["fast", "full"])("passes a clean governed tree in %s mode", (mode) => {
    const result = checkDocsGovernance({ root: project(mode) });
    expect(result).toEqual({ mode, blocking: [], deferred: [] });
  });

  it("defers a stale Runbook seal in fast mode and blocks it in full mode", () => {
    const fast = project("fast");
    writeFileSync(join(fast, "contract/config.txt"), "changed\n");
    const stale =
      "docs/runbooks/fixture-runbook.md: contract_sha256 does not match the current Runbook and contract sources";
    expect(checkDocsGovernance({ root: fast })).toEqual({
      mode: "fast",
      blocking: [],
      deferred: [stale],
    });

    const full = project("full");
    writeFileSync(join(full, "contract/config.txt"), "changed\n");
    expect(checkDocsGovernance({ root: full })).toEqual({
      mode: "full",
      blocking: [stale],
      deferred: [],
    });
  });

  it("defers a Runbook contract path removed by a fast-mode change", () => {
    const root = project("fast");
    rmSync(join(root, "contract"), { recursive: true });
    const result = checkDocsGovernance({ root });
    expect(result.blocking).toEqual([]);
    expect(result.deferred).toEqual([
      "docs/runbooks/fixture-runbook.md: contract path does not exist: contract",
    ]);
  });

  it("blocks a broken ADR in fast mode", () => {
    const root = project("fast");
    writeFileSync(
      join(root, "docs/adr/0002-broken.md"),
      adr(["status: active", "document_type: adr", 'date: "2026-10-26"']),
    );
    const result = checkDocsGovernance({ root });
    expect(result.deferred).toEqual([]);
    expect(result.blocking.length).toBeGreaterThan(0);
    expect(result.blocking.every((finding) => finding.startsWith("docs/adr/0002-broken.md"))).toBe(
      true,
    );
  });

  it("treats a missing DELIVERY_MODE file as full mode", () => {
    const root = project("fast");
    rmSync(join(root, "DELIVERY_MODE"));
    writeFileSync(join(root, "contract/config.txt"), "changed\n");
    const result = checkDocsGovernance({ root });
    expect(result.mode).toBe("full");
    expect(result.blocking).toHaveLength(1);
  });

  it("fails loudly when the validator cannot produce a report", () => {
    const root = project("fast");
    expect(() =>
      checkDocsGovernance({ root, validator: join(root, "missing-validator.py") }),
    ).toThrow(/DOCS_GOVERNANCE_VALIDATOR_FAILED/);
  });
});
