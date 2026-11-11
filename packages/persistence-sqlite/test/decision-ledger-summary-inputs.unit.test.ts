import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadBundledMigrations, openQualifiedDatabase } from "../src/index.ts";
import { insertLedgerRow } from "../src/sqlite-decision-ledger-operations.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const SUMMARY = {
  summaryInjected: true,
  summaryIds: ["episode-1"],
  summaryDays: ["2026-11-10"],
  summaryCharacters: 12,
  summaryRead: "ok" as const,
  summaryGenerated: 0,
};

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-ledger-summary-"));
  directories.push(directory);
  const opened = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  applyMigrations(opened, await loadBundledMigrations());
  opened.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
  opened.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
  return opened;
}

function write(
  id: string,
  kind: "external_read" | "consolidation",
  summary: Record<string, unknown> = SUMMARY,
) {
  return {
    id,
    ownerId: "o" as OwnerId,
    agentId: "a" as AgentId,
    kind,
    decidedAt: "2026-11-11T00:00:00.000Z",
    outcome: kind === "external_read" ? "read" : "merge",
    reasonCode: kind === "external_read" ? "today_context" : "merge",
    subjectRef: null,
    inputs: { memoryIds: [], ruleIds: [], ...summary },
    reasonRef: null,
    contentRef: null,
    costMicros: 0,
    durationMs: 0,
  };
}

describe("[P5-1] recent-summary inputs on the direct ledger insert", () => {
  it("stores them on an external read and refuses them on any other kind", async () => {
    const opened = await database();
    try {
      insertLedgerRow(opened, write("external", "external_read"));
      expect(() => insertLedgerRow(opened, write("consolidation", "consolidation"))).toThrow(
        "Decision ledger summary inputs are invalid",
      );
      expect(() =>
        insertLedgerRow(
          opened,
          write("consolidation-partial", "consolidation", {
            summaryIds: ["episode-1"],
            summaryDays: ["2026-11-10"],
          }),
        ),
      ).toThrow("Decision ledger summary inputs are invalid");
      expect(() =>
        insertLedgerRow(
          opened,
          write("external-partial", "external_read", { summaryIds: ["episode-1"] }),
        ),
      ).toThrow("Decision ledger summary inputs are invalid");
      const rows = opened.prepare("SELECT id, inputs FROM decision_ledger ORDER BY id").all() as {
        id: string;
        inputs: string;
      }[];
      expect(rows.map(({ id }) => id)).toEqual(["external"]);
      expect(JSON.parse(rows[0]?.inputs ?? "{}")).toMatchObject(SUMMARY);
    } finally {
      opened.close();
    }
  });
});
