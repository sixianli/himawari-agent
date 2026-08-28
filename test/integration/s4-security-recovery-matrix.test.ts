import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const matrixPath = path.join(repositoryRoot, "test/fixtures/v0.2/s4-security-recovery-matrix.json");

interface MatrixAssertion {
  readonly source: string;
  readonly selector: string;
}

interface MatrixCase {
  readonly id: string;
  readonly assertions: readonly MatrixAssertion[];
}

interface SecurityRecoveryMatrix {
  readonly schemaVersion: number;
  readonly sourcePlan: string;
  readonly scopeTask: string;
  readonly cases: readonly MatrixCase[];
}

const REQUIRED_CASE_IDS = [
  "authorization_store_outage",
  "manifest_tamper",
  "signature_failure",
  "source_permission_expansion",
  "stale_handle",
  "grant_budget_race",
  "worker_crash",
  "unknown_result",
  "pi_tool_allowlist",
  "worker_registry_revalidation",
  "program_mcp_isolation",
  "secret_exclusion",
  "trace_causality",
] as const;

describe("S4 Task 12 security and recovery matrix", () => {
  it("binds every required failure and enforcement boundary to an executable assertion", async () => {
    const matrix = JSON.parse(await readFile(matrixPath, "utf8")) as SecurityRecoveryMatrix;
    expect(matrix).toMatchObject({
      schemaVersion: 1,
      sourcePlan: "docs/execution/plans/2026-08-26-authorization-capability-governance-plan.md",
      scopeTask: "S4-T12",
    });
    expect(matrix.cases.map(({ id }) => id)).toEqual(REQUIRED_CASE_IDS);
    expect(new Set(matrix.cases.map(({ id }) => id)).size).toBe(REQUIRED_CASE_IDS.length);

    for (const entry of matrix.cases) {
      expect(entry.assertions.length, `${entry.id} must have executable evidence`).toBeGreaterThan(
        0,
      );
      for (const assertion of entry.assertions) {
        expect(assertion.source).not.toContain("qualification/evidence");
        const source = await readFile(path.join(repositoryRoot, assertion.source), "utf8");
        expect(
          source.includes(assertion.selector),
          `${entry.id} selector is stale: ${assertion.source} :: ${assertion.selector}`,
        ).toBe(true);
      }
    }
  });
});
