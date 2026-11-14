import { rm } from "node:fs/promises";
import {
  buildPortableExport,
  DATA_EXPORT_ERROR_CODES,
  importPortableExport,
  type PortableFiles,
  SEALED_FILE,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { openSide, putPayload, SECRET_BANK_CARD, type Side } from "./data-export-fixture.ts";

const PASSPHRASE = "测试口令-correct horse battery staple";
const NOW = "2026-11-12T00:00:00.000Z";
const FILE = "data/owner-proposals.jsonl";
const policy = createDataExportTextPolicy();
const sides: Side[] = [];
const decoder = new TextDecoder();
const SECRET_TEXT = `主人的银行卡号是 ${SECRET_BANK_CARD}`;

afterEach(async () => {
  for (const side of sides.splice(0)) {
    side.database.close();
    await rm(side.directory, { recursive: true, force: true });
  }
});

async function side(suffix: string): Promise<Side> {
  const created = await openSide(suffix);
  sides.push(created);
  return created;
}

interface Seed {
  readonly id: string;
  readonly status?: string;
  readonly execStatus?: string;
  readonly basis?: string | null;
  readonly execution?: string | null;
  readonly lease?: boolean;
  readonly requiresFullRead?: boolean;
  readonly requiresPresence?: boolean;
}

async function seed(target: Side, item: Seed): Promise<void> {
  const status = item.status ?? "pending";
  const basisRef =
    item.basis === undefined || item.basis === null
      ? null
      : await putPayload(
          target,
          `payload-owner-proposal-basis-${item.id}`,
          item.basis,
          "sensitive",
        );
  const executionRef =
    item.execution === undefined || item.execution === null
      ? null
      : await putPayload(
          target,
          `payload-owner-proposal-execution-${item.id}`,
          item.execution,
          "sensitive",
        );
  target.database
    .prepare(
      `INSERT INTO owner_proposals (
        id, owner_id, agent_id, type, summary, effect, origin, thread_id, source_ref,
        source_version, version, fingerprint, evidence_ref, status, proposed_at, expires_at,
        decided_at, proposed_count, reject_count, last_rejected_at, exec_status, lease_id,
        lease_expires_at, attempts, requires_full_read, requires_presence, executed_at,
        execution_ref
      ) VALUES (?, ?, ?, 'action', ?, ?, 'inferred', NULL, 'reminder:r1', 'v1', 2, ?, ?, ?,
        '2026-11-10T01:00:00.000Z', '2026-11-20T01:00:00.000Z', ?, 1, 0, NULL, ?, ?, ?, 1, ?, ?,
        ?, ?)`,
    )
    .run(
      item.id,
      target.ownerId,
      target.agentId,
      `把提醒 ${item.id} 改到明早`,
      "提醒时间变成明早九点",
      "a".repeat(64),
      basisRef,
      status,
      status === "pending" ? null : "2026-11-11T01:00:00.000Z",
      item.execStatus ?? "not_started",
      item.lease === true ? "lease-1" : null,
      item.lease === true ? "2026-11-11T01:05:00.000Z" : null,
      item.requiresFullRead === true ? 1 : 0,
      item.requiresPresence === true ? 1 : 0,
      item.execStatus === "succeeded" ? "2026-11-11T01:00:05.000Z" : null,
      executionRef,
    );
}

async function seeded(): Promise<Side> {
  const source = await side("owner-proposals-source");
  await seed(source, { id: "p-pending", basis: "依据：主人说过早上才看提醒" });
  await seed(source, {
    id: "p-done",
    status: "accepted",
    execStatus: "succeeded",
    execution: '{"original":"2026-11-12T00:00:00.000Z"}',
    requiresPresence: true,
  });
  await seed(source, {
    id: "p-running",
    status: "accepted",
    execStatus: "running",
    lease: true,
    requiresFullRead: true,
  });
  await seed(source, { id: "p-secret", basis: SECRET_TEXT });
  return source;
}

function exportOf(from: Side) {
  return buildPortableExport({
    database: from.database,
    scope: { ownerId: from.ownerId, agentId: from.agentId },
    migrationSequence: from.migrationSequence,
    protector: from.protector,
    policy,
    now: () => NOW,
    sealPassphrase: PASSPHRASE,
  });
}

function importInto(target: Side, files: PortableFiles, passphrase?: string) {
  return importPortableExport(files, {
    database: target.database,
    scope: { ownerId: target.ownerId, agentId: target.agentId },
    migrationSequence: target.migrationSequence,
    protector: target.protector,
    now: () => NOW,
    ...(passphrase === undefined ? {} : { passphrase }),
  });
}

function rows(from: Side) {
  return from.database
    .prepare(
      `SELECT id, type, summary, effect, origin, thread_id, source_ref, source_version, version,
        fingerprint, evidence_ref IS NOT NULL AS has_basis, status, proposed_at, expires_at,
        decided_at, proposed_count, reject_count, exec_status, lease_id, attempts,
        requires_full_read, requires_presence, executed_at, execution_ref IS NOT NULL AS has_execution
      FROM owner_proposals ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
}

describe("[owner-proposals] the owner's proposal box travels with the data export", () => {
  it("round-trips rows, keeps basis and execution payloads, and turns an in-flight run into unknown", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    expect(manifest.counts.ownerProposals).toBe(4);
    expect(files.has("schema/owner-proposals.schema.json")).toBe(true);
    const target = await side("owner-proposals-target");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.ownerProposals).toBe(4);
    expect(report.skipped.ownerProposalsWithoutOriginal).toBe(0);
    const expected = rows(source).map((row) =>
      row["id"] === "p-running" ? { ...row, exec_status: "unknown", lease_id: null } : row,
    );
    expect(rows(target)).toEqual(expected);
    const again = await exportOf(target);
    const lines = decoder.decode(again.files.get(FILE)).split("\n");
    expect(lines.some((line) => line.includes('"execStatus":"unknown"'))).toBe(true);
  });

  it("keeps secret-looking basis text out of plain files and skips that proposal without the passphrase", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    for (const [path, bytes] of files)
      if (path !== SEALED_FILE) expect(decoder.decode(bytes)).not.toContain(SECRET_BANK_CARD);
    const line = decoder
      .decode(files.get(FILE))
      .split("\n")
      .find((entry) => entry.includes("p-secret"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ basis: { withheld: true } });
    const target = await side("owner-proposals-no-passphrase");
    const report = await importInto(target, files);
    expect(report.imported.ownerProposals).toBe(3);
    expect(report.skipped.ownerProposalsWithoutOriginal).toBe(1);
    expect(rows(target).map((row) => row["id"])).not.toContain("p-secret");
  });

  it("[reverse] refuses to import into a target that already has proposals", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("owner-proposals-busy");
    await seed(target, { id: "p-existing" });
    await expect(importInto(target, files, PASSPHRASE)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
    });
  });
});
