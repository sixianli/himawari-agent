import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { expect, it } from "vitest";
import { qualifySandboxJournal } from "../qualification/journal-installation-selfcheck.js";

it("qualifies durable start and unknown recovery using the real SQLite ports", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "himawari-install-qualification-")),
  );
  try {
    const report = await qualifySandboxJournal(root);
    const db = openQualifiedDatabase(report.databasePath);
    try {
      const rows = db
        .prepare(
          "SELECT started_at AS startedAt,json_extract(facts_json,'$.resource.supervision') AS supervision,json_extract(facts_json,'$.resource.cleanup') AS cleanup FROM sandbox_execution_records",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        startedAt: expect.any(String),
        supervision: "lost",
        cleanup: "unknown",
      });
      expect(db.prepare("SELECT released_at FROM sandbox_workspace_occupancy").all()).toEqual([
        { released_at: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
