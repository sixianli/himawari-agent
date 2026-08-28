import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = path.join(repositoryRoot, "test/fixtures/v0.2/s2-journey-map.json");

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

const requiredClaims = Object.freeze({
  J01: [
    "owner_identity_and_mfa_assertion",
    "conversation_identity",
    "sse_cursor_resume",
    "normal_restart_readback",
    "trace_and_inbox_causality",
  ],
  J02: [
    "ui_and_answer_locale_independence",
    "search_and_fork_snapshot",
    "compaction_provenance_and_watermark",
    "source_and_task_retention",
    "pi_session_rebuild",
  ],
  J03: [
    "automatic_and_sensitive_memory",
    "per_item_approval",
    "cross_thread_minimal_retrieval",
    "correction_delete_no_resurrection",
  ],
  J13: [
    "active_task_resolution",
    "trash_immediate_invisibility",
    "cascade_and_minimal_tombstone",
    "restart_no_resurrection",
    "retention_deadline_purge",
  ],
});

async function readManifest(): Promise<JourneyManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as JourneyManifest;
}

describe("S2 to S0 canonical journey mapping", () => {
  it("maps every S2-owned J01-J03 and J13 claim to executable source and qualification evidence", async () => {
    const manifest = await readManifest();
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourcePlan: "docs/execution/plans/2026-08-26-owner-thread-conversation-plan.md",
      scopeTask: "S2-T12",
    });
    expect(manifest.journeys.map(({ id }) => id)).toEqual(Object.keys(requiredClaims));

    for (const journey of manifest.journeys) {
      const expectedClaims = requiredClaims[journey.id as keyof typeof requiredClaims];
      expect(expectedClaims, `${journey.id} must be a governed S2 journey`).toBeDefined();
      expect(journey.claims).toEqual(expectedClaims);
      expect(new Set(journey.claims).size).toBe(journey.claims.length);
      expect(journey.acceptanceIds.every((id) => /^S2-A0[1-5]$/.test(id))).toBe(true);
      expect(journey).toMatchObject({
        status: "s2_local_complete",
        globalStatus: "partial",
      });
      expect(journey.testSources.length).toBeGreaterThan(0);
      expect(journey.qualificationEvidence.length).toBeGreaterThan(0);
      expect(journey.remainingGlobalQualification.length).toBeGreaterThan(0);

      for (const source of journey.testSources) {
        const content = await readFile(path.join(repositoryRoot, source), "utf8");
        expect(source).toMatch(/\.(?:test|compat\.test)\.ts$/);
        expect(content).toMatch(/\b(?:describe|it)\s*\(/);
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
        if (evidence.status !== undefined) expect(evidence.status).toBe("local_complete");
        expect(evidence.commands?.some(({ exitStatus }) => exitStatus === 0)).toBe(true);
      }
    }
  });
});
