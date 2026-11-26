import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  buildPortableExport,
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  importPortableExport,
  MANIFEST_FILE,
  type PortableFiles,
  proposalTextDigest,
  SEALED_FILE,
  sealJson,
  sha256Hex,
  unsealJson,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSide,
  putPayload,
  SECRET_API_KEY,
  SECRET_BANK_CARD,
  type Side,
  seedMemory,
} from "./data-export-fixture.ts";

const PASSPHRASE = "测试口令-correct horse battery staple";
const NOW = "2026-11-12T00:00:00.000Z";
const PROPOSALS_FILE = "data/external-memory-proposals.jsonl";
const policy = createDataExportTextPolicy();
const sides: Side[] = [];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
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

interface ProposalSeed {
  readonly id: string;
  readonly text: string | null;
  readonly status: "pending" | "committed" | "rejected" | "superseded";
  readonly classification?: "private" | "sensitive";
  readonly client?: string;
  readonly sourceKey?: string | null;
  readonly batchId?: string | null;
  readonly memoryId?: string | null;
  readonly supersededBy?: string | null;
  readonly textSha256?: string;
}

async function seedProposal(target: Side, seed: ProposalSeed): Promise<void> {
  const classification = seed.classification ?? "private";
  const contentRef =
    seed.text === null
      ? null
      : await putPayload(target, `payload-proposal-${seed.id}`, seed.text, classification);
  target.database
    .prepare(
      `INSERT INTO external_memory_proposals (
        id, owner_id, agent_id, subject_ref, client, source_key, text_sha256, normalization,
        content_ref, category, classification, status, received_at, decided_at, batch_id,
        memory_id, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'nfc-space-v1', ?, 'preference', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      target.ownerId,
      target.agentId,
      `mcp-client:${seed.client ?? "Muse"}`,
      seed.client ?? "Muse",
      seed.sourceKey ?? null,
      seed.textSha256 ?? (seed.text === null ? digest(seed.id) : proposalTextDigest(seed.text)),
      contentRef,
      classification,
      seed.status,
      "2026-11-10T01:00:00.000Z",
      seed.status === "pending" ? null : "2026-11-11T01:00:00.000Z",
      seed.batchId ?? null,
      seed.memoryId ?? null,
      seed.supersededBy ?? null,
    );
}

async function seeded(): Promise<Side> {
  const source = await side("proposals-source");
  await seedMemory(source, { id: "memory-kept", text: "主人每天早上跑步" });
  await seedProposal(source, {
    id: "proposal-pending",
    text: "主人周末喜欢去镰仓",
    status: "pending",
    sourceKey: "muse-note-7",
  });
  await seedProposal(source, {
    id: "proposal-committed",
    text: "主人每天早上跑步",
    status: "committed",
    batchId: "batch-1",
    memoryId: "memory-kept",
  });
  await seedProposal(source, {
    id: "proposal-rejected",
    text: null,
    status: "rejected",
  });
  await seedProposal(source, {
    id: "proposal-superseded",
    text: null,
    status: "superseded",
    supersededBy: "proposal-pending",
  });
  await seedProposal(source, {
    id: "proposal-secret",
    text: SECRET_TEXT,
    status: "pending",
    classification: "sensitive",
    client: "Claude Code",
  });
  source.database
    .prepare(
      `INSERT INTO external_memory_proposal_keys (owner_id, agent_id, client, source_key, proposal_id)
      VALUES (?, ?, 'Muse', 'muse-note-7', 'proposal-pending')`,
    )
    .run(source.ownerId, source.agentId);
  source.database
    .prepare(
      `INSERT INTO external_memory_proposal_unkeyed (proposal_id, client) VALUES
      ('proposal-pending', 'Claude Code'), ('proposal-committed', 'Muse')`,
    )
    .run();
  return source;
}

function exportOf(from: Side, seal = true) {
  return buildPortableExport({
    database: from.database,
    scope: { ownerId: from.ownerId, agentId: from.agentId },
    migrationSequence: from.migrationSequence,
    protector: from.protector,
    policy,
    now: () => NOW,
    ...(seal ? { sealPassphrase: PASSPHRASE } : {}),
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

async function proposalRows(from: Side) {
  const rows = from.database
    .prepare(
      `SELECT id, subject_ref, client, source_key, text_sha256, normalization, content_ref,
        category, classification, status, received_at, decided_at, batch_id, memory_id,
        superseded_by
      FROM external_memory_proposals ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
  const texts: Record<string, string | null> = {};
  const read = from.database.prepare(
    "SELECT ref, classification, content_type, ciphertext, encryption_metadata_json, content_digest, created_at FROM payloads WHERE ref = ?",
  );
  for (const row of rows) {
    const ref = row["content_ref"];
    if (typeof ref !== "string") {
      texts[String(row["id"])] = null;
      continue;
    }
    const payload = read.get(ref) as Record<string, unknown>;
    texts[String(row["id"])] = decoder.decode(
      await from.protector.unprotect({
        ownerId: from.ownerId,
        agentId: from.agentId,
        payload: {
          ref,
          dataClassification: payload["classification"] as "private",
          contentType: String(payload["content_type"]),
          ciphertext: new Uint8Array(payload["ciphertext"] as Uint8Array),
          encryption: JSON.parse(String(payload["encryption_metadata_json"])),
          storage: { kind: "inline" },
          contentDigest: String(payload["content_digest"]),
          createdAt: String(payload["created_at"]),
        },
      }),
    );
  }
  return {
    rows: rows.map(
      (row): Record<string, unknown> => ({
        ...row,
        content_ref: undefined,
        hasContent: row["content_ref"] !== null,
      }),
    ),
    texts,
    keys: from.database
      .prepare(
        "SELECT client, source_key, proposal_id FROM external_memory_proposal_keys ORDER BY proposal_id",
      )
      .all(),
    unkeyed: from.database
      .prepare(
        "SELECT proposal_id, client FROM external_memory_proposal_unkeyed ORDER BY proposal_id, client",
      )
      .all(),
  };
}

function rehash(files: PortableFiles, mutate: (text: string) => string): PortableFiles {
  const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
    files: { path: string; bytes: number; lines: number; sha256: string; role: string }[];
  };
  const next: PortableFiles = new Map(files);
  next.set(PROPOSALS_FILE, encoder.encode(mutate(decoder.decode(files.get(PROPOSALS_FILE)))));
  for (const entry of manifest.files) {
    const bytes = next.get(entry.path) ?? new Uint8Array();
    entry.bytes = bytes.byteLength;
    entry.sha256 = sha256Hex(bytes);
    if (entry.role === "data") entry.lines = [...bytes].filter((byte) => byte === 0x0a).length;
  }
  next.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
  return next;
}

function editLine(
  files: PortableFiles,
  id: string,
  change: (line: Record<string, unknown>) => Record<string, unknown>,
): PortableFiles {
  return rehash(files, (text) =>
    text
      .split("\n")
      .map((line) => {
        if (line === "") return line;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed["id"] === id ? JSON.stringify(change(parsed)) : line;
      })
      .join("\n"),
  );
}

describe("[P1-6][P5-3] proposals from other agents travel with the data export", () => {
  it("exports every proposal, imports it into an empty database and keeps rows, texts, keys and unkeyed clients identical", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    expect(manifest.format).toBe("himawari.data-export.v6");
    expect(manifest.counts.externalProposals).toBe(5);
    expect(manifest.omitted.map(({ what }) => what).join("\n")).not.toContain("MCP");
    expect(files.has("schema/external-memory-proposals.schema.json")).toBe(true);
    const target = await side("proposals-target");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.externalProposals).toBe(5);
    expect(report.skipped.externalProposalsWithoutOriginal).toBe(0);
    const before = await proposalRows(source);
    expect(await proposalRows(target)).toEqual(before);
    expect(before.texts["proposal-secret"]).toBe(SECRET_TEXT);
    const again = await exportOf(target);
    expect(decoder.decode(again.files.get(PROPOSALS_FILE))).toBe(
      decoder.decode(files.get(PROPOSALS_FILE)),
    );
  });

  it("keeps a secret-looking proposal and its text digest out of the plain files, and skips it without the passphrase", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const secretDigest = source.database
      .prepare("SELECT text_sha256 FROM external_memory_proposals WHERE id = 'proposal-secret'")
      .pluck()
      .get() as string;
    for (const [path, bytes] of files)
      if (path !== SEALED_FILE) {
        expect(decoder.decode(bytes)).not.toContain(SECRET_BANK_CARD);
        expect(decoder.decode(bytes)).not.toContain(secretDigest);
      }
    const line = decoder
      .decode(files.get(PROPOSALS_FILE))
      .split("\n")
      .find((entry) => entry.includes("proposal-secret"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      textSha256: null,
      content: { withheld: true },
    });
    const target = await side("proposals-no-passphrase");
    const report = await importInto(target, files);
    expect(report.imported.externalProposals).toBe(4);
    expect(report.skipped.externalProposalsWithoutOriginal).toBe(1);
    const imported = await proposalRows(target);
    expect(imported.rows.map((row) => row["id"])).not.toContain("proposal-secret");
    expect(imported.texts["proposal-pending"]).toBe("主人周末喜欢去镰仓");
  });

  it("[reverse] leaves out every proposal whose text is a restricted memory's text, linked or not, in the plain files and the sealed file", async () => {
    const source = await seeded();
    const restricted = "受限的记忆正文";
    await seedMemory(source, {
      id: "memory-restricted",
      text: restricted,
      classification: "restricted",
      versions: [{ kind: "created", text: "受限记忆的旧版本", at: "2026-11-01T00:00:00.000Z" }],
    });
    await seedMemory(source, { id: "memory-broken", text: "坏掉的", classification: "restricted" });
    source.database
      .prepare("UPDATE payloads SET ciphertext = x'00' WHERE ref = 'payload-memory-broken'")
      .run();
    await seedProposal(source, {
      id: "proposal-restricted-old",
      text: "受限记忆的旧版本",
      status: "pending",
      textSha256: proposalTextDigest("受限记忆的旧版本"),
    });
    await seedProposal(source, {
      id: "proposal-restricted-link",
      text: "改过文字之前的原话",
      status: "committed",
      batchId: "batch-2",
      memoryId: "memory-restricted",
    });
    await seedProposal(source, {
      id: "proposal-restricted-pending",
      text: ` ${restricted}\u200b `,
      status: "pending",
      textSha256: proposalTextDigest(restricted),
    });
    await seedProposal(source, {
      id: "proposal-restricted-copy",
      text: null,
      status: "superseded",
      textSha256: proposalTextDigest(restricted),
    });
    const { files, manifest } = await exportOf(source);
    const hidden = [
      restricted,
      "改过文字之前的原话",
      proposalTextDigest(restricted),
      "proposal-restricted-link",
      "proposal-restricted-pending",
      "proposal-restricted-copy",
      "受限记忆的旧版本",
    ];
    for (const [path, bytes] of files)
      if (path !== SEALED_FILE)
        for (const value of hidden) expect(decoder.decode(bytes)).not.toContain(value);
    const sealed = await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array());
    for (const value of hidden) expect(JSON.stringify(sealed)).not.toContain(value);
    expect(manifest.counts.externalProposals).toBe(5);
    expect(
      manifest.omitted.find(({ what }) => what.includes("受限（restricted）记忆的其他 agent 提议"))
        ?.count,
    ).toBe(4);
    expect(manifest.omitted.find(({ what }) => what.includes("没法和提议比较"))?.count).toBe(1);
    const target = await side("proposals-restricted");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.externalProposals).toBe(5);
    expect(
      target.database
        .prepare(
          "SELECT COUNT(*) FROM external_memory_proposals WHERE id LIKE 'proposal-restricted%'",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("[reverse] leaves out a proposal whose text is a restricted memory's original words", async () => {
    const source = await seeded();
    await seedMemory(source, {
      id: "memory-restricted",
      text: "受限的记忆正文",
      classification: "restricted",
      versions: [{ kind: "created", text: "受限记忆的旧版本", at: "2026-11-01T00:00:00.000Z" }],
    });
    await seedProposal(source, {
      id: "proposal-restricted-quote",
      text: "主人原话：受限记忆的旧版本",
      status: "pending",
      textSha256: proposalTextDigest("主人原话：受限记忆的旧版本"),
    });
    const { files, manifest } = await exportOf(source);
    for (const [path, bytes] of files)
      if (path !== SEALED_FILE) expect(decoder.decode(bytes)).not.toContain("主人原话");
    const sealedQuote = await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array());
    expect(JSON.stringify(sealedQuote)).not.toContain("主人原话");
    expect(manifest.counts.externalProposals).toBe(5);
    expect(
      manifest.omitted.find(({ what }) => what.includes("受限（restricted）记忆的其他 agent 提议"))
        ?.count,
    ).toBe(1);
  });

  it("[reverse] writes no key, unkeyed client or replacement link of a left-out proposal, and numbers placeholders without it", async () => {
    const source = await seeded();
    await seedMemory(source, {
      id: "memory-restricted",
      text: "受限的记忆正文",
      classification: "restricted",
    });
    await seedProposal(source, {
      id: "proposal-restricted",
      text: "受限的记忆正文",
      status: "pending",
      client: "Hidden",
      sourceKey: "[已扣留:9]",
      textSha256: proposalTextDigest("受限的记忆正文"),
    });
    await seedProposal(source, {
      id: "proposal-replaced",
      text: null,
      status: "superseded",
      supersededBy: "proposal-restricted",
    });
    await seedProposal(source, {
      id: "proposal-secret-key",
      text: "编号像机密的提议",
      status: "pending",
      sourceKey: SECRET_API_KEY,
    });
    const insertKey = source.database.prepare(
      `INSERT INTO external_memory_proposal_keys (owner_id, agent_id, client, source_key, proposal_id)
      VALUES (?, ?, ?, ?, ?)`,
    );
    insertKey.run(source.ownerId, source.agentId, "Hidden", "[已扣留:9]", "proposal-restricted");
    insertKey.run(source.ownerId, source.agentId, "Muse", SECRET_API_KEY, "proposal-secret-key");
    source.database
      .prepare(
        "INSERT INTO external_memory_proposal_unkeyed (proposal_id, client) VALUES ('proposal-restricted', 'Hidden')",
      )
      .run();
    const { files } = await exportOf(source);
    const plain = decoder.decode(files.get(PROPOSALS_FILE));
    expect(plain).not.toContain("Hidden");
    expect(plain).not.toContain("proposal-restricted");
    const lines = plain
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find(({ id }) => id === "proposal-replaced")?.["supersededBy"]).toBeNull();
    expect(lines.find(({ id }) => id === "proposal-secret-key")?.["keys"]).toEqual([
      { client: "Muse", sourceKey: "[已扣留:1]" },
    ]);
  });

  it("keeps a proposal whose text only resembles a restricted memory", async () => {
    const source = await seeded();
    await seedMemory(source, {
      id: "memory-restricted",
      text: "受限的记忆正文",
      classification: "restricted",
    });
    await seedProposal(source, {
      id: "proposal-similar",
      text: "受限的记忆正文之外的另一句",
      status: "pending",
      textSha256: proposalTextDigest("受限的记忆正文之外的另一句"),
    });
    const { manifest } = await exportOf(source);
    expect(manifest.counts.externalProposals).toBe(6);
  });

  it("drops the batch of a saved proposal whose memory was already deleted, so the batch does not count it", async () => {
    const source = await seeded();
    await seedProposal(source, {
      id: "proposal-memory-gone",
      text: "记忆已经删掉的提议",
      status: "committed",
      batchId: "batch-1",
    });
    const { files } = await exportOf(source);
    const target = await side("proposals-memory-gone");
    await importInto(target, files, PASSPHRASE);
    expect(
      target.database
        .prepare(
          "SELECT status, memory_id, batch_id FROM external_memory_proposals WHERE id = 'proposal-memory-gone'",
        )
        .get(),
    ).toEqual({ status: "committed", memory_id: null, batch_id: null });
    expect(
      target.database
        .prepare("SELECT batch_id FROM external_memory_proposals WHERE id = 'proposal-committed'")
        .pluck()
        .all(),
    ).toEqual(["batch-1"]);
  });

  it("[reverse] drops the batch of a rejected proposal whose text is gone, on export and on import", async () => {
    const source = await seeded();
    await seedProposal(source, {
      id: "proposal-rejected-old",
      text: null,
      status: "rejected",
      batchId: "batch-1",
    });
    await seedProposal(source, {
      id: "proposal-rejected-kept",
      text: "主人不想记下的事",
      status: "rejected",
      batchId: "batch-1",
    });
    const { files } = await exportOf(source);
    const line = (from: PortableFiles) =>
      JSON.parse(
        decoder
          .decode(from.get(PROPOSALS_FILE))
          .split("\n")
          .find((entry) => entry.includes('"id":"proposal-rejected-old"')) ?? "{}",
      ) as { batchId: string | null };
    expect(line(files).batchId).toBeNull();
    const edited = editLine(files, "proposal-rejected-old", (entry) => ({
      ...entry,
      batchId: "batch-1",
    }));
    expect(line(edited).batchId).toBe("batch-1");
    const target = await side("proposals-rejected-old");
    await importInto(target, edited, PASSPHRASE);
    expect(
      target.database
        .prepare(
          "SELECT coalesce(batch_id, '-') FROM external_memory_proposals WHERE id LIKE 'proposal-rejected-%' ORDER BY id",
        )
        .pluck()
        .all(),
    ).toEqual(["batch-1", "-"]);
  });

  it("imports a replaced proposal and a waiting one that share the same text digest", async () => {
    const source = await seeded();
    const shared = source.database
      .prepare("SELECT text_sha256 FROM external_memory_proposals WHERE id = 'proposal-secret'")
      .pluck()
      .get() as string;
    await seedProposal(source, {
      id: "proposal-secret-copy",
      text: SECRET_TEXT,
      status: "superseded",
      classification: "sensitive",
      textSha256: shared,
    });
    const { files } = await exportOf(source);
    const target = await side("proposals-shared-digest");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.externalProposals).toBe(6);
    expect(
      target.database
        .prepare(
          "SELECT COUNT(*) FROM external_memory_proposals WHERE text_sha256 = ? AND status <> 'superseded'",
        )
        .pluck()
        .get(shared),
    ).toBe(1);
  });

  it("drops the link and the batch of a saved proposal whose memory is skipped without the passphrase", async () => {
    const source = await seeded();
    await seedMemory(source, { id: "memory-secret", text: SECRET_TEXT });
    await seedProposal(source, {
      id: "proposal-secret-link",
      text: "指向机密记忆的提议",
      status: "committed",
      batchId: "batch-3",
      memoryId: "memory-secret",
    });
    const { files } = await exportOf(source);
    const target = await side("proposals-skipped-link");
    await importInto(target, files);
    expect(
      target.database
        .prepare(
          "SELECT status, memory_id, batch_id FROM external_memory_proposals WHERE id = 'proposal-secret-link'",
        )
        .get(),
    ).toEqual({ status: "committed", memory_id: null, batch_id: null });
  });

  it("[reverse] refuses two live withheld proposals whose sealed digests match, before writing anything", async () => {
    const source = await seeded();
    const shared = source.database
      .prepare("SELECT text_sha256 FROM external_memory_proposals WHERE id = 'proposal-secret'")
      .pluck()
      .get() as string;
    await seedProposal(source, {
      id: "proposal-secret-copy",
      text: SECRET_TEXT,
      status: "superseded",
      classification: "sensitive",
      textSha256: shared,
    });
    const { files } = await exportOf(source);
    const tampered = editLine(files, "proposal-secret-copy", (line) => ({
      ...line,
      status: "rejected",
    }));
    const target = await side("proposals-sealed-duplicate");
    for (const dryRun of [true, false]) {
      const failure = await importPortableExport(tampered, {
        database: target.database,
        scope: { ownerId: target.ownerId, agentId: target.agentId },
        migrationSequence: target.migrationSequence,
        protector: target.protector,
        now: () => NOW,
        passphrase: PASSPHRASE,
        dryRun,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DataExportError);
      expect((failure as DataExportError).code).toBe(DATA_EXPORT_ERROR_CODES.LINE_INVALID);
    }
    expect(
      target.database.prepare("SELECT COUNT(*) FROM external_memory_proposals").pluck().get(),
    ).toBe(0);
  });

  it("numbers a new withheld key after placeholders already stored on proposals, so a re-export imports again", async () => {
    const source = await seeded();
    await seedProposal(source, {
      id: "proposal-old-placeholder",
      text: "导入过一次的提议",
      status: "pending",
      sourceKey: "[已扣留:1]",
    });
    await seedProposal(source, {
      id: "proposal-secret-key",
      text: "编号像机密的提议",
      status: "pending",
      sourceKey: SECRET_API_KEY,
    });
    const insertKey = source.database.prepare(
      `INSERT INTO external_memory_proposal_keys (owner_id, agent_id, client, source_key, proposal_id)
      VALUES (?, ?, 'Muse', ?, ?)`,
    );
    insertKey.run(source.ownerId, source.agentId, "[已扣留:1]", "proposal-old-placeholder");
    insertKey.run(source.ownerId, source.agentId, SECRET_API_KEY, "proposal-secret-key");
    const { files } = await exportOf(source);
    expect(decoder.decode(files.get(PROPOSALS_FILE))).not.toContain(SECRET_API_KEY);
    const target = await side("proposals-placeholders");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.externalProposals).toBe(7);
    const keys = target.database
      .prepare("SELECT source_key FROM external_memory_proposal_keys ORDER BY source_key")
      .pluck()
      .all();
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    [
      "a pending proposal with a decision time",
      (files: PortableFiles) =>
        editLine(files, "proposal-pending", (line) => ({ ...line, decidedAt: NOW })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a receive time without milliseconds",
      (files: PortableFiles) =>
        editLine(files, "proposal-pending", (line) => ({
          ...line,
          receivedAt: "2026-11-12T00:00:00Z",
        })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a text whose classification differs from its proposal",
      (files: PortableFiles) =>
        editLine(files, "proposal-pending", (line) => ({
          ...line,
          content: { ...(line["content"] as object), classification: "sensitive" },
        })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a pending proposal without text",
      (files: PortableFiles) =>
        editLine(files, "proposal-pending", (line) => ({ ...line, content: null })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a plain digest beside a withheld text",
      (files: PortableFiles) =>
        editLine(files, "proposal-secret", (line) => ({ ...line, textSha256: "a".repeat(64) })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "two proposals claiming the same client key",
      (files: PortableFiles) =>
        editLine(files, "proposal-committed", (line) => ({
          ...line,
          keys: [{ client: "Muse", sourceKey: "muse-note-7" }],
        })),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "two live proposals with the same text digest",
      (files: PortableFiles) => {
        const pending = JSON.parse(
          decoder
            .decode(files.get(PROPOSALS_FILE))
            .split("\n")
            .find((entry) => entry.includes('"id":"proposal-pending"')) ?? "{}",
        ) as { textSha256: string };
        return editLine(files, "proposal-rejected", (line) => ({
          ...line,
          textSha256: pending.textSha256,
        }));
      },
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a proposal whose text does not match its digest",
      (files: PortableFiles) =>
        editLine(files, "proposal-pending", (line) => ({ ...line, textSha256: "0".repeat(64) })),
      DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
    ],
    [
      "a proposal replaced by one that is not in the export",
      (files: PortableFiles) =>
        editLine(files, "proposal-superseded", (line) => ({ ...line, supersededBy: "missing" })),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a saved proposal pointing at a memory that is not in the export",
      (files: PortableFiles) =>
        editLine(files, "proposal-committed", (line) => ({ ...line, memoryId: "memory-missing" })),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a manifest that miscounts the proposals",
      (files: PortableFiles) => rehash(files, (text) => text.split("\n").slice(1).join("\n")),
      DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
    ],
  ])("[reverse] refuses %s and writes nothing", async (_name, tamper, code) => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("proposals-tampered");
    const failure = await importInto(target, tamper(files), PASSPHRASE).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DataExportError);
    expect((failure as DataExportError).code).toBe(code);
    expect(
      target.database.prepare("SELECT COUNT(*) FROM external_memory_proposals").pluck().get(),
    ).toBe(0);
  });

  it("[reverse] refuses a withheld proposal whose sealed digest does not match its text", async () => {
    const { files } = await exportOf(await seeded());
    const sealed = (await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array())) as {
      originals: Record<string, string>;
    };
    sealed.originals["externalProposal/proposal-secret/textSha256"] = "0".repeat(64);
    const next: PortableFiles = new Map(files).set(SEALED_FILE, await sealJson(PASSPHRASE, sealed));
    const failure = await importInto(
      await side("sealed"),
      rehash(next, (t) => t),
      PASSPHRASE,
    ).catch((e: unknown) => e);
    expect((failure as DataExportError).code).toBe(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH);
  });

  it("[reverse] refuses to import into a database that already holds proposals", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("proposals-not-empty");
    await seedProposal(target, { id: "proposal-existing", text: "已有的提议", status: "pending" });
    const failure = await importInto(target, files, PASSPHRASE).catch((error: unknown) => error);
    expect((failure as DataExportError).code).toBe(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY);
  });
});
