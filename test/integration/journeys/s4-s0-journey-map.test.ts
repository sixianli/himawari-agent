import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = path.join(repositoryRoot, "test/fixtures/v0.2/s4-journey-map.json");

interface JourneyMapping {
  readonly id: string;
  readonly acceptanceIds: readonly string[];
  readonly status: string;
  readonly globalStatus: string;
  readonly claims: readonly string[];
  readonly testSources: readonly string[];
  readonly qualificationEvidence: readonly string[];
  readonly remainingGlobalQualification: readonly string[];
}

interface JourneyManifest {
  readonly schemaVersion: number;
  readonly sourcePlan: string;
  readonly scopeTask: string;
  readonly journeys: readonly JourneyMapping[];
}

const REQUIRED_JOURNEYS = ["J04", "J05", "J06", "J07", "J08", "J09", "J11", "J12"];

describe("S4 to S0 canonical journey mapping", () => {
  it("maps S4 common authorization invariants without claiming unfinished global journeys", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JourneyManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourcePlan: "docs/execution/plans/2026-08-26-authorization-capability-governance-plan.md",
      scopeTask: "S4-T12",
    });
    expect(manifest.journeys.map(({ id }) => id)).toEqual(REQUIRED_JOURNEYS);

    for (const journey of manifest.journeys) {
      expect(journey).toMatchObject({
        status: "s4_common_contract_complete",
        globalStatus: "partial",
      });
      expect(journey.acceptanceIds.every((id) => /^S4-A0[1-4]$/.test(id))).toBe(true);
      expect(journey.claims.length).toBeGreaterThan(0);
      expect(new Set(journey.claims).size).toBe(journey.claims.length);
      expect(journey.testSources.length).toBeGreaterThan(0);
      expect(journey.qualificationEvidence.length).toBeGreaterThan(0);
      expect(journey.remainingGlobalQualification.length).toBeGreaterThan(0);

      for (const sourcePath of journey.testSources) {
        const source = await readFile(path.join(repositoryRoot, sourcePath), "utf8");
        expect(sourcePath).toMatch(/\.test\.ts$/);
        expect(source).toMatch(/\b(?:describe|it)\s*\(/);
      }
      for (const evidencePath of journey.qualificationEvidence) {
        const evidence = JSON.parse(
          await readFile(path.join(repositoryRoot, evidencePath), "utf8"),
        ) as {
          readonly schemaVersion?: number;
          readonly status?: string;
          readonly commands?: readonly { readonly exitStatus?: number }[];
        };
        expect(evidence.schemaVersion).toBe(1);
        expect(evidence.status).toBe("local_complete");
        expect(evidence.commands?.some(({ exitStatus }) => exitStatus === 0)).toBe(true);
      }
    }
  });
});
