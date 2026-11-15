import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import {
  buildPortableExport,
  canonicalJson,
  checkMarkdownMapping,
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  importPortableExport,
  MANIFEST_FILE,
  type PortableFiles,
  parsePortable,
  readPortableDirectory,
  SEAL_ERROR_CODES,
  SEALED_FILE,
  sha256Hex,
  unsealJson,
  writePortableDirectory,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryConversationReviewOperations } from "../../packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts";
import {
  openSide,
  SECRET_API_KEY,
  SECRET_BANK_CARD,
  SECRET_MAIL_BODY,
  SECRET_PASSWORD,
  SECRETS,
  putPayload,
  type Side,
  seedEverything,
  seedMemory,
} from "./data-export-fixture.ts";

const OTHER_API_KEY = `sk-proj-${"ZyXwVu9876543210"}TsRqPoNm`;
const PASSPHRASE = "测试口令-correct horse battery staple";
const NOW = "2026-11-10T00:00:00.000Z";
const policy = createDataExportTextPolicy();
const sides: Side[] = [];
const decoder = new TextDecoder();
const encoder = new TextEncoder();

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

async function seeded(): Promise<Side> {
  const source = await side("source");
  await seedEverything(source);
  return source;
}

function exportOf(
  from: Side,
  options: {
    seal?: boolean;
    evidence?: boolean;
    textPolicy?: typeof policy;
  } = {},
) {
  return buildPortableExport({
    database: from.database,
    scope: { ownerId: from.ownerId, agentId: from.agentId },
    migrationSequence: from.migrationSequence,
    protector: from.protector,
    policy: options.textPolicy ?? policy,
    now: () => NOW,
    ...(options.seal === false ? {} : { sealPassphrase: PASSPHRASE }),
    withEvidence: options.evidence ?? false,
  });
}

function importInto(
  target: Side,
  files: PortableFiles,
  options: { passphrase?: string; dryRun?: boolean } = {},
) {
  return importPortableExport(files, {
    database: target.database,
    scope: { ownerId: target.ownerId, agentId: target.agentId },
    migrationSequence: target.migrationSequence,
    protector: target.protector,
    now: () => NOW,
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
}

function dataFiles(files: PortableFiles): [string, Uint8Array][] {
  return [...files]
    .filter(([path]) => path !== MANIFEST_FILE && path !== SEALED_FILE)
    .sort(([a], [b]) => a.localeCompare(b));
}

function counts(target: Side): Record<string, number> {
  const one = (table: string): number =>
    target.database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  return {
    memories: one("memory_records"),
    history: one("memory_history_events"),
    decisions: one("decision_ledger"),
    signals: one("decision_signals"),
    people: one("memory_people"),
    batches: one("memory_import_batches"),
    runs: one("memory_consolidation_runs"),
    payloads: one("payloads"),
    prereviews: one("decision_prereviews"),
  };
}

function rehash(
  files: PortableFiles,
  mutate: (path: string, bytes: Uint8Array) => Uint8Array,
): PortableFiles {
  const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
    files: {
      path: string;
      bytes: number;
      lines: number;
      sha256: string;
      role: string;
    }[];
  };
  const next: PortableFiles = new Map();
  for (const [path, bytes] of files)
    next.set(path, path === MANIFEST_FILE ? bytes : mutate(path, bytes));
  for (const entry of manifest.files) {
    const bytes = next.get(entry.path) ?? new Uint8Array();
    entry.bytes = bytes.byteLength;
    entry.sha256 = sha256Hex(bytes);
    if (entry.role === "data") entry.lines = [...bytes].filter((byte) => byte === 0x0a).length;
  }
  next.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
  return next;
}

describe("data export: round trip", () => {
  it("[P1-6] exports, imports into an empty database and exports again with identical data", async () => {
    const source = await seeded();
    const first = await exportOf(source, { evidence: true });
    const target = await side("target");
    const report = await importInto(target, first.files, { passphrase: PASSPHRASE });
    expect(report.skipped).toEqual({
      memoriesWithoutOriginal: 0,
      historyEventsWithoutOriginal: 0,
      decisionTextsWithoutOriginal: 0,
      rulesWithoutOriginal: 0,
      externalProposalsWithoutOriginal: 0,
      ownerProposalsWithoutOriginal: 0,
      evidenceNotImported: false,
    });
    const second = await exportOf(target, { evidence: true });
    const left = dataFiles(first.files);
    const right = dataFiles(second.files);
    expect(right.map(([path]) => path)).toEqual(left.map(([path]) => path));
    for (const [index, [path, bytes]] of left.entries())
      expect(decoder.decode(right[index]?.[1]), path).toBe(decoder.decode(bytes));
    const sealedA = await unsealJson(PASSPHRASE, first.files.get(SEALED_FILE) ?? new Uint8Array());
    const sealedB = await unsealJson(PASSPHRASE, second.files.get(SEALED_FILE) ?? new Uint8Array());
    expect(canonicalJson(sealedB)).toBe(canonicalJson(sealedA));
    expect(first.manifest.counts.memories).toBe(8);
    expect(first.manifest.counts.decisions).toBe(7);
    expect(first.manifest.counts.sealedEvidenceRows).toBeGreaterThan(0);
  });

  it("[DREAM][P1-6] carries conversation reviews and their changes, without conversation ids", async () => {
    const source = await seeded();
    const first = await exportOf(source);
    expect(first.manifest.counts.conversationReviews).toBe(2);
    expect(first.manifest.counts.conversationReviewChanges).toBe(3);
    const lines = decoder.decode(first.files.get("data/conversation-reviews.jsonl"));
    expect(lines).not.toMatch(/episode-1|message-1|thread-review|payload-review-output/u);
    expect(lines).not.toContain("m-pending");
    const target = await side("reviews");
    const report = await importInto(target, first.files, { passphrase: PASSPHRASE });
    expect(report.imported.conversationReviews).toBe(2);
    expect(report.imported.conversationReviewChanges).toBe(3);
    const rows = target.database
      .prepare(
        `SELECT r.id, r.status, r.attempts, r.output_ref, t.archived_at IS NOT NULL AS archived,
          (SELECT COUNT(*) FROM memory_conversation_review_changes c WHERE c.review_id = r.id) AS changes
        FROM memory_conversation_reviews r JOIN threads t ON t.id = r.thread_id ORDER BY r.id`,
      )
      .all();
    expect(rows).toEqual([
      {
        id: "review-1",
        status: "completed",
        attempts: 1,
        output_ref: null,
        archived: 1,
        changes: 3,
      },
      { id: "review-2", status: "gave_up", attempts: 3, output_ref: null, archived: 1, changes: 0 },
    ]);
    expect(
      target.database
        .prepare(
          "SELECT memory_id, undone_revision FROM memory_conversation_review_changes WHERE undone_revision IS NOT NULL",
        )
        .all(),
    ).toEqual([{ memory_id: "m-archived", undone_revision: 2 }]);
    const reviews = new SqliteMemoryConversationReviewOperations(
      target.database,
      (code: string, message: string) => {
        throw new Error(`${code}: ${message}`);
      },
      () => {},
    );
    expect(
      reviews.execute("memoryConversationReview.position", {
        ownerId: target.ownerId,
        agentId: target.agentId,
      }),
    ).toBeNull();
  });

  it("[P3-1] the search index and its vectors stay out of the export, sealed part included", async () => {
    const source = await seeded();
    const memoryId = source.database
      .prepare("SELECT id FROM memory_records WHERE status = 'active' ORDER BY id LIMIT 1")
      .pluck()
      .get() as string;
    const vector = Buffer.alloc(16);
    for (const [index, value] of [0.123456, -0.654321, 0.987654, -0.246813].entries())
      vector.writeFloatLE(value, index * 4);
    const indexed = source.database
      .prepare(
        `INSERT INTO memory_search_index (memory_id, owner_id, agent_id, memory_revision,
           embedding_model, embedding_dimensions, embedding, indexed_at)
         SELECT id, owner_id, agent_id, revision, 'jina-fixture#1', 4, ?, ? FROM memory_records WHERE id = ?`,
      )
      .run(vector, NOW, memoryId);
    source.database
      .prepare("INSERT INTO memory_search_terms (rowid, terms) VALUES (?, 'zebrapluto')")
      .run(indexed.lastInsertRowid);
    expect(indexed.changes).toBe(1);
    expect(
      source.database
        .prepare(
          `SELECT embedding FROM memory_search_index WHERE rowid = ?
             AND rowid IN (SELECT rowid FROM memory_search_terms WHERE memory_search_terms MATCH 'zebrapluto')`,
        )
        .pluck()
        .get(indexed.lastInsertRowid),
    ).toEqual(vector);
    const exported = await exportOf(source, { evidence: true });
    const sealed = canonicalJson(
      await unsealJson(PASSPHRASE, exported.files.get(SEALED_FILE) ?? new Uint8Array()),
    );
    const everything = Buffer.concat([
      ...[...exported.files.values()].map((bytes) => Buffer.from(bytes)),
      Buffer.from(sealed),
    ]);
    for (const form of [
      vector,
      Buffer.from(vector.toString("base64")),
      Buffer.from(vector.toString("hex")),
    ])
      expect(everything.includes(form)).toBe(false);
    expect(everything.includes(Buffer.from("zebrapluto"))).toBe(false);
    expect(everything.includes(Buffer.from("jina-fixture#1"))).toBe(false);
  });

  it("[P1-6] keeps every version of a memory, the owner's rating and the signals", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const target = await side("target-detail");
    await importInto(target, files, { passphrase: PASSPHRASE });
    const memory = parsePortable(files, source.migrationSequence).memories.find(
      ({ id }) => id === "m-plain",
    );
    expect(memory?.history.map(({ kind, content }) => [kind, content.text])).toEqual([
      ["created", "喜欢喝咖啡"],
      ["updated", "喜欢喝美式咖啡"],
      ["reaffirmed", "喜欢喝无糖美式咖啡"],
    ]);
    expect(
      target.database
        .prepare("SELECT owner_rating, rated_at FROM decision_ledger WHERE id = 'd-proactive'")
        .get(),
    ).toEqual({ owner_rating: "useful", rated_at: "2026-11-03T00:00:00.000Z" });
    expect(counts(target)["signals"]).toBe(1);
    expect(counts(target)["history"]).toBeGreaterThanOrEqual(3);
  });

  it("[P4-8] carries model pre-ratings through export and import without touching the owner's rating", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const target = await side("target-prereview");
    await importInto(target, files, { passphrase: PASSPHRASE });
    const read = (from: Side) =>
      from.database
        .prepare(
          `SELECT id, decision_id, message_id, calibration_group, status, rating,
            confidence_permille, history_conflict, failure_code, cost_micros, text_digest
          FROM decision_prereviews ORDER BY id`,
        )
        .all();
    expect(read(target)).toEqual(read(source));
    expect(read(target)).toHaveLength(3);
    expect(
      target.database
        .prepare("SELECT owner_rating FROM decision_ledger WHERE id = 'd-candidate'")
        .pluck()
        .get(),
    ).toBeNull();
  });

  it("[P4-8][reverse] pre-ratings are not imported without the passphrase", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const target = await side("target-prereview-nopass");
    await importInto(target, files);
    expect(counts(target)["prereviews"]).toBe(0);
  });

  it("[P1-6][reverse] a changed rating, a deleted line or a changed text makes the comparison fail", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const target = await side("target-reverse");
    await importInto(target, files, { passphrase: PASSPHRASE });
    target.database
      .prepare("UPDATE decision_ledger SET owner_rating = 'unneeded' WHERE id = 'd-proactive'")
      .run();
    const changed = await exportOf(target, { evidence: true });
    const original = decoder.decode(files.get("data/decisions.jsonl"));
    expect(decoder.decode(changed.files.get("data/decisions.jsonl"))).not.toBe(original);
    target.database
      .prepare(
        "DELETE FROM memory_history_events WHERE rowid = (SELECT MIN(rowid) FROM memory_history_events)",
      )
      .run();
    const fewer = await exportOf(target, { evidence: true });
    expect(decoder.decode(fewer.files.get("data/memories.jsonl"))).not.toBe(
      decoder.decode(files.get("data/memories.jsonl")),
    );
  });

  it("[P1-6] importing without the passphrase skips withheld memories and reports the count", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source, { evidence: true });
    expect(manifest.withheld.memories).toBe(3);
    const target = await side("target-nopass");
    const report = await importInto(target, files);
    expect(report.skipped.memoriesWithoutOriginal).toBe(3);
    expect(report.skipped.evidenceNotImported).toBe(true);
    expect(counts(target)["memories"]).toBe(5);
    expect(
      target.database.prepare("SELECT COUNT(*) FROM decision_ledger_payloads").pluck().get(),
    ).toBe(0);
  });

  it("[P1-6] dry run writes nothing and a non-empty target is refused", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("target-dry");
    const before = counts(target);
    const dry = await importInto(target, files, { passphrase: PASSPHRASE, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(counts(target)).toEqual(before);
    await importInto(target, files, { passphrase: PASSPHRASE });
    await expect(importInto(target, files, { passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
    });
  });

  it("[P1-6] a wrong passphrase is refused before anything is written", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("target-wrong");
    await expect(importInto(target, files, { passphrase: "不对的口令" })).rejects.toMatchObject({
      code: SEAL_ERROR_CODES.AUTHENTICATION_FAILED,
    });
    expect(counts(target)["memories"]).toBe(0);
  });
});

describe("data export: manifest and files are checked before anything is written", () => {
  const cases: readonly [string, (files: PortableFiles) => PortableFiles, string][] = [
    [
      "a changed byte in a data file",
      (files) => {
        const next = new Map(files);
        const bytes = new Uint8Array(files.get("data/memories.jsonl") ?? []);
        bytes[bytes.length - 3] = bytes[bytes.length - 3] === 0x61 ? 0x62 : 0x61;
        next.set("data/memories.jsonl", bytes);
        return next;
      },
      DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH,
    ],
    [
      "a truncated data file",
      (files) => {
        const next = new Map(files);
        next.set(
          "data/decisions.jsonl",
          (files.get("data/decisions.jsonl") ?? new Uint8Array()).slice(0, 100),
        );
        return next;
      },
      DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH,
    ],
    [
      "a count that is one too many",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.counts.memories += 1;
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
    ],
    [
      "a line count in the file list that is one too many",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        const entry = manifest.files.find(
          (file: { path: string }) => file.path === "data/memories.jsonl",
        );
        entry.lines += 1;
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
    ],
    [
      "a hash in the file list that was changed",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.files[0].sha256 = "0".repeat(64);
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH,
    ],
    [
      "a file that the manifest does not list",
      (files) => new Map(files).set("data/extra.jsonl", encoder.encode("{}\n")),
      DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
    ],
    [
      "a listed file that is missing",
      (files) => {
        const next = new Map(files);
        next.delete("data/people.jsonl");
        return next;
      },
      DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
    ],
    [
      "a path that leaves the directory",
      (files) => new Map(files).set("../escape.jsonl", encoder.encode("{}\n")),
      DATA_EXPORT_ERROR_CODES.PATH_UNSAFE,
    ],
    [
      "an unknown format version",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.format = "himawari.data-export.v5";
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
    ],
    [
      "an export in the old v1 format, which had no rule book",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.format = "himawari.data-export.v1";
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
    ],
    [
      "an export in the old v2 format, which had no proposals from other agents",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.format = "himawari.data-export.v2";
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
    ],
    [
      "an export in the old v3 format, which had no owner proposals",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.format = "himawari.data-export.v3";
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
    ],
    [
      "a different migration number",
      (files) => {
        const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE)));
        manifest.migrationSequence += 1;
        return new Map(files).set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
      },
      DATA_EXPORT_ERROR_CODES.MIGRATION_MISMATCH,
    ],
    [
      "a data line with a status the database does not have (hashes recomputed)",
      (files) =>
        rehash(files, (path, bytes) =>
          path === "data/memories.jsonl"
            ? encoder.encode(
                decoder.decode(bytes).replace('"status":"active"', '"status":"exploded"'),
              )
            : bytes,
        ),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a reference to a memory that is not in the file (hashes recomputed)",
      (files) =>
        rehash(files, (path, bytes) =>
          path === "data/consolidations.jsonl"
            ? encoder.encode(
                decoder.decode(bytes).replace('"memoryId":"m-archived"', '"memoryId":"m-ghost"'),
              )
            : bytes,
        ),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a conversation review change on a memory that is not in the file (hashes recomputed)",
      (files) =>
        rehash(files, (path, bytes) =>
          path === "data/conversation-reviews.jsonl"
            ? encoder.encode(
                decoder.decode(bytes).replace('"memoryId":"m-plain"', '"memoryId":"m-ghost"'),
              )
            : bytes,
        ),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
  ];
  for (const [name, mutate, code] of cases) {
    it(`[P1-6][reverse] refuses ${name} and writes nothing`, async () => {
      const source = await seeded();
      const { files } = await exportOf(source);
      const good = await side(`good-${code}`);
      await importInto(good, files, { passphrase: PASSPHRASE });
      const target = await side(`bad-${code}`);
      const before = counts(target);
      await expect(
        importInto(target, mutate(files), { passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({ code });
      expect(counts(target)).toEqual(before);
    });
  }

  it("[P1-6][reverse] a proactive decision without a scenario is rejected by the database and rolled back", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const broken = rehash(files, (path, bytes) =>
      path === "data/decisions.jsonl"
        ? encoder.encode(decoder.decode(bytes).replace('"scenario":"gmail"', '"scenario":null'))
        : bytes,
    );
    const target = await side("target-constraint");
    const before = counts(target);
    await expect(importInto(target, broken, { passphrase: PASSPHRASE })).rejects.toThrow();
    expect(counts(target)).toEqual(before);
  });
});

describe("data export: Markdown maps back to the machine-readable data", () => {
  it("[P1-6] every Markdown item is found by id with the same text", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    const parsed = parsePortable(files, source.migrationSequence);
    expect(checkMarkdownMapping(files, parsed.memories)).toEqual([]);
    expect(manifest.counts.markdownMemories).toBe(
      parsed.memories.filter(({ status, tentative }) => status === "active" && !tentative).length,
    );
    const markdown = [...files]
      .filter(([path]) => path.startsWith("memory/"))
      .map(([, bytes]) => decoder.decode(bytes))
      .join("\n");
    expect(markdown).toContain("〔m:m-plain〕");
    expect(markdown).not.toContain("m-tentative");
    expect(markdown).not.toContain("m-archived");
    const index = decoder.decode(files.get("MEMORY.md"));
    expect(index).toContain("不是指令");
  });

  it("[P1-6][reverse] a line missing from the data, or a changed text, is reported", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const parsed = parsePortable(files, source.migrationSequence);
    const withoutOne = parsed.memories.filter(({ id }) => id !== "m-plain");
    expect(checkMarkdownMapping(files, withoutOne).join("\n")).toContain("m-plain");
    const changed = parsed.memories.map((memory) =>
      memory.id === "m-plain"
        ? { ...memory, content: { ...memory.content, text: "别的文字" } }
        : memory,
    );
    expect(checkMarkdownMapping(files, changed).join("\n")).toContain("不一致");
  });

  it("[P1-6] folds line breaks so one memory is one line", async () => {
    const source = await side("multiline");
    const { seedMemory } = await import("./data-export-fixture.ts");
    await seedMemory(source, { id: "m-multi", text: "第一行\n第二行\n\n第三行" });
    const { files } = await exportOf(source);
    const markdown = decoder.decode(files.get("memory/preference.md"));
    expect(markdown).toContain("- > 第一行 第二行 第三行 〔m:m-multi〕");
  });
});

describe("data export: no plaintext secrets outside the sealed file", () => {
  async function everythingExceptSeal(files: PortableFiles): Promise<string> {
    return [...files]
      .filter(([path]) => path !== SEALED_FILE)
      .map(([, bytes]) => decoder.decode(bytes))
      .join("\n");
  }

  it("[P1-6] literal secrets and third-party mail text appear nowhere in the readable files", async () => {
    const source = await seeded();
    for (const withSeal of [true, false]) {
      const { files } = await exportOf(source, { seal: withSeal, evidence: withSeal });
      const text = await everythingExceptSeal(files);
      for (const secret of SECRETS) expect(text.includes(secret), secret).toBe(false);
      expect(text.includes(SECRET_MAIL_BODY)).toBe(false);
      expect(text).not.toContain("stranger@example.org");
      expect(text).not.toContain("m-restricted");
      expect(text).not.toContain("受限内容-唯一标记-Q3");
      expect(text).not.toContain("待删内容-唯一标记-Q1");
      expect(text).not.toContain("已删内容-唯一标记-Q2");
    }
  });

  it("[P1-6] topic-type sensitive memories stay readable while credentials are masked", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const memories = decoder.decode(files.get("data/memories.jsonl"));
    expect(memories).toContain("最近在看牙科，下周复诊");
    const parsed = parsePortable(files, source.migrationSequence);
    const card = parsed.memories.find(({ id }) => id === "m-card");
    expect(card?.content.withheld).toBe(true);
    expect(card?.content.text).not.toContain(SECRET_BANK_CARD);
    const passwordMemory = parsed.memories.find(({ id }) => id === "m-pass");
    expect(passwordMemory?.content.text).not.toContain(SECRET_PASSWORD);
  });

  it("[P1-6] the sealed file holds the originals and is unreadable without the passphrase", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const sealed = files.get(SEALED_FILE) ?? new Uint8Array();
    expect(decoder.decode(sealed)).not.toContain(SECRET_PASSWORD);
    const opened = JSON.stringify(await unsealJson(PASSPHRASE, sealed));
    expect(opened).toContain(SECRET_PASSWORD);
    expect(opened).toContain(SECRET_MAIL_BODY);
    await expect(unsealJson("错误口令", sealed)).rejects.toMatchObject({
      code: SEAL_ERROR_CODES.AUTHENTICATION_FAILED,
    });
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 0xff;
    await expect(unsealJson(PASSPHRASE, tampered)).rejects.toMatchObject({
      code: SEAL_ERROR_CODES.AUTHENTICATION_FAILED,
    });
  });

  it("[P1-6][reverse] if masking is switched off the literal search finds the secrets", async () => {
    const source = await seeded();
    const passthrough = { rulesetVersion: 0, hasSecret: () => false, mask: (text: string) => text };
    const { files } = await exportOf(source, { textPolicy: passthrough });
    const text = await everythingExceptSeal(files);
    expect(SECRETS.some((secret) => text.includes(secret))).toBe(true);
  });

  it("[P1-6] evidence cannot be exported without the seal", async () => {
    const source = await seeded();
    await expect(exportOf(source, { seal: false, evidence: true })).rejects.toBeInstanceOf(
      DataExportError,
    );
  });
});

describe("data export: determinism and the directory", () => {
  it("[P1-6] exporting the same database twice gives identical data files", async () => {
    const source = await seeded();
    const first = await exportOf(source);
    const second = await exportOf(source);
    for (const [path, bytes] of dataFiles(first.files))
      expect(decoder.decode(second.files.get(path))).toBe(decoder.decode(bytes));
  });

  it("[P1-6][reverse] a timestamp inside a record would break it", async () => {
    const source = await seeded();
    const first = await exportOf(source);
    source.database
      .prepare(
        "UPDATE memory_records SET updated_at = '2026-11-09T00:00:00.000Z' WHERE id = 'm-plain'",
      )
      .run();
    const second = await exportOf(source);
    expect(decoder.decode(second.files.get("data/memories.jsonl"))).not.toBe(
      decoder.decode(first.files.get("data/memories.jsonl")),
    );
  });

  it("[P1-6] writes an owner-only directory, reads it back, and refuses a non-empty output", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const directory = `${source.directory}/out`;
    await writePortableDirectory(directory, files);
    const read = await readPortableDirectory(directory);
    expect([...read.keys()].sort()).toEqual([...files.keys()].sort());
    const target = await side("target-dir");
    await importInto(target, read, { passphrase: PASSPHRASE });
    expect(counts(target)["memories"]).toBe(8);
    await expect(writePortableDirectory(directory, files)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
    });
  });
  it("[P1-6] masks secrets that sit in names, source ids and decision inputs, not only in memory text", async () => {
    const source = await seeded();
    const db = source.database;
    db.prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)").run(
      `密钥 ${SECRET_API_KEY}`,
    );
    db.prepare("INSERT INTO memory_person_aliases (person_id, alias) VALUES ('person-1', ?)").run(
      `别名 ${SECRET_API_KEY}`,
    );
    db.prepare(
      "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES ('m-plain', 'reference', ?, 0)",
    ).run(`id-${SECRET_API_KEY}`);
    db.prepare(
      "UPDATE decision_ledger SET inputs = ?, push_source_key = ? WHERE id = 'd-proactive'",
    ).run(JSON.stringify({ note: `带密钥 ${SECRET_API_KEY}` }), `key-${SECRET_API_KEY}`);
    const { files } = await exportOf(source, { seal: false });
    for (const [path, bytes] of files)
      expect(decoder.decode(bytes), path).not.toContain(SECRET_API_KEY);
  });

  it("[P1-6][reverse] import refuses an unregistered memory source type and marks perception sources as gone", async () => {
    const perceptionId = `perception:${"a".repeat(32)}`;
    const typed = await seeded();
    typed.database
      .prepare(
        "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES ('m-plain', 'perception', ?, 0)",
      )
      .run(perceptionId);
    const target = await side("target-perception-source");
    await importInto(target, (await exportOf(typed)).files, { passphrase: PASSPHRASE });
    expect(
      target.database
        .prepare(
          "SELECT source_deleted AS gone FROM memory_provenance WHERE source_type = 'perception' AND source_id = ?",
        )
        .all(perceptionId),
    ).toEqual([{ gone: 1 }]);
    for (const [type, id] of [
      ["telepathy", "anything"],
      ["perception", "not-a-record"],
    ]) {
      const bad = await side(`source-bad-${type}`);
      await seedEverything(bad);
      bad.database
        .prepare(
          "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES ('m-plain', ?, ?, 0)",
        )
        .run(type, id);
      const refused = await side(`target-bad-${type}`);
      await expect(
        importInto(refused, (await exportOf(bad)).files, {
          passphrase: PASSPHRASE,
          dryRun: true,
        }),
      ).rejects.toMatchObject({ code: DATA_EXPORT_ERROR_CODES.LINE_INVALID });
      await expect(
        importInto(refused, (await exportOf(bad)).files, { passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({ code: DATA_EXPORT_ERROR_CODES.LINE_INVALID });
      expect(counts(refused)["memories"]).toBe(0);
    }
  });

  it("[P1-6] keeps a withheld history event findable when an earlier event was dropped", async () => {
    const source = await side("history-key");
    await seedMemory(source, {
      id: "m-hist",
      text: "普通正文",
      versions: [
        { kind: "created", text: "第一版普通", at: "2026-11-01T01:00:00.000Z" },
        {
          kind: "updated",
          text: `第二版含密码 ${SECRET_PASSWORD}`,
          at: "2026-11-01T02:00:00.000Z",
        },
      ],
    });
    source.database
      .prepare(
        "UPDATE payloads SET lifecycle_state = 'deletion_pending' WHERE ref = 'payload-m-hist-h0'",
      )
      .run();
    const { files } = await exportOf(source);
    const target = await side("history-key-target");
    const report = await importInto(target, files, { passphrase: PASSPHRASE });
    expect(report.skipped.historyEventsWithoutOriginal).toBe(0);
    expect(counts(target)["history"]).toBe(2);
  });

  it("[P1-6] leaves the placeholder thread archived so it is not listed as an active conversation", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("thread-archived");
    await importInto(target, files, { passphrase: PASSPHRASE });
    const threads = target.database
      .prepare("SELECT status, archived_at FROM threads WHERE id LIKE 'data-import-thread-%'")
      .all() as { status: string; archived_at: string | null }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.archived_at).not.toBeNull();
  });

  it("[P1-6][reverse] a target with leftover muse rows is not empty", async () => {
    const source = await seeded();
    const { files } = await exportOf(source, { evidence: true });
    const target = await side("not-empty-evidence");
    target.database
      .prepare(
        "INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, recorded_at) VALUES ('muse-1', ?, ?, ?, 0, ?)",
      )
      .run(target.ownerId, target.agentId, NOW, NOW);
    await expect(importInto(target, files, { passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
    });
  });
  it("[P1-6] [P4-5] names the memory eval question bank as left out and still imports cleanly", async () => {
    const source = await seeded();
    const questionText = "评测题干：我早上一般喝什么咖啡？";
    await putPayload(source, "real-eval-question-1", questionText);
    source.database
      .prepare(
        `INSERT INTO real_eval_questions (
          id, owner_id, agent_id, memory_id, memory_revision, kind, question_ref,
          question_model, prompt_sha256, created_at
        ) VALUES ('q-1', ?, ?, 'm-plain', 1, 'preference', 'real-eval-question-1', 'eval-model', ?, ?)`,
      )
      .run(source.ownerId, source.agentId, "d".repeat(64), NOW);
    const { files, manifest } = await exportOf(source);
    expect(manifest.omitted.map(({ what }) => what)).toContain("记忆评测的题库和每次评测的分数");
    for (const [path, bytes] of files)
      expect(decoder.decode(bytes), path).not.toContain("我早上一般喝什么咖啡");
    const target = await side("eval-bank-left-out");
    await importInto(target, files, { passphrase: PASSPHRASE });
    expect(
      target.database.prepare("SELECT COUNT(*) AS count FROM real_eval_questions").get(),
    ).toEqual({ count: 0 });
  });
  it("[P1-6] two different secrets in names and source ids stay distinct and round-trip", async () => {
    const source = await seeded();
    const db = source.database;
    const insertEntity = db.prepare(
      "INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)",
    );
    insertEntity.run(`密钥甲 ${SECRET_API_KEY}`);
    insertEntity.run(`密钥甲 ${OTHER_API_KEY}`);
    const insertSource = db.prepare(
      "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES ('m-plain', 'reference', ?, 0)",
    );
    insertSource.run(`id-${SECRET_API_KEY}`);
    insertSource.run(`id-${OTHER_API_KEY}`);
    const { files, manifest } = await exportOf(source);
    expect(
      manifest.omitted.find(({ what }) => what.startsWith("含机密的实体名"))?.count,
    ).toBeGreaterThanOrEqual(4);
    for (const [path, bytes] of files)
      expect(decoder.decode(bytes), path).not.toContain(OTHER_API_KEY);
    const target = await side("distinct-secrets");
    await importInto(target, files, { passphrase: PASSPHRASE });
    const names = target.database
      .prepare(
        "SELECT name FROM memory_entities WHERE memory_id = 'm-plain' AND name LIKE '[已扣留:%'",
      )
      .all();
    expect(names).toHaveLength(2);
    for (const { name } of names as { name: string }[]) expect(name).toMatch(/^\[已扣留:\d+\]$/);
    expect(new Set((names as { name: string }[]).map(({ name }) => name)).size).toBe(2);
    const again = await exportOf(target);
    expect(decoder.decode(again.files.get("data/memories.jsonl"))).toBe(
      decoder.decode(files.get("data/memories.jsonl")),
    );
  });
  it("[P1-6][reverse] an output path that is a file or a symlink is refused and not changed", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const file = `${source.directory}/not-a-directory`;
    await writeFile(file, "x", { mode: 0o644 });
    await expect(writePortableDirectory(file, files)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.PATH_UNSAFE,
    });
    const link = `${source.directory}/link`;
    await mkdir(`${source.directory}/real`, { mode: 0o755 });
    await symlink(`${source.directory}/real`, link);
    await expect(writePortableDirectory(link, files)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.PATH_UNSAFE,
    });
    expect((await stat(`${source.directory}/real`)).mode & 0o777).toBe(0o755);
  });
  it("[P1-6] numbers new placeholders after the ones an imported database already holds", async () => {
    const source = await seeded();
    source.database
      .prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)")
      .run(`密钥 ${SECRET_API_KEY}`);
    const first = await exportOf(source);
    const target = await side("renumber");
    await importInto(target, first.files, { passphrase: PASSPHRASE });
    target.database
      .prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)")
      .run(`另一个密钥 ${OTHER_API_KEY}`);
    const second = await exportOf(target);
    const third = await side("renumber-again");
    await importInto(third, second.files, { passphrase: PASSPHRASE });
    const names = third.database
      .prepare("SELECT name FROM memory_entities WHERE name LIKE '[已扣留:%' ORDER BY name")
      .pluck()
      .all();
    expect(names).toEqual(["[已扣留:1]", "[已扣留:2]"]);
  });

  it("[P1-6] masks secrets in a signal detail and in the decision counts", async () => {
    const source = await seeded();
    source.database
      .prepare(
        `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
        VALUES ('sig-2', ?, ?, 'd-proactive', 'opened', '2026-11-01T00:06:00.000Z', 360000, ?, 'open-2', '2026-11-01T00:06:01.000Z')`,
      )
      .run(
        source.ownerId,
        source.agentId,
        JSON.stringify({ [`key-${SECRET_API_KEY}`]: `v-${SECRET_API_KEY}` }),
      );
    source.database
      .prepare("UPDATE decision_ledger SET counts = ? WHERE id = 'd-proactive'")
      .run(JSON.stringify({ [`k-${SECRET_API_KEY}`]: 1 }));
    const { files } = await exportOf(source, { seal: false });
    for (const [path, bytes] of files)
      expect(decoder.decode(bytes), path).not.toContain(SECRET_API_KEY);
  });
  it("[P1-6] ignores an absurdly long placeholder number when numbering new ones", async () => {
    const source = await seeded();
    source.database
      .prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)")
      .run(`[已扣留:${"9".repeat(40)}]`);
    source.database
      .prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)")
      .run(`密钥 ${SECRET_API_KEY}`);
    const { files } = await exportOf(source, { seal: false });
    const memories = decoder.decode(files.get("data/memories.jsonl"));
    expect(memories).toContain("[已扣留:1]");
    expect(() => parsePortable(files, source.migrationSequence)).not.toThrow();
  });
});

describe("data export: paired devices", () => {
  const devicePublicKey = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"D".repeat(86)}==`;
  const confirmPublicKey = `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"C".repeat(86)}==`;
  const codeHash = "e".repeat(64);
  const nonce = "nonce-for-export-test-0001";
  const deviceId = `dev_${"A".repeat(22)}`;

  async function withDevice(): Promise<Side> {
    const source = await seeded();
    source.database
      .prepare(
        `INSERT INTO paired_devices
           (id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
            confirm_public_key, status, supported_actions, paired_at, last_seen_at)
         VALUES (?, ?, ?, 0, 'iphone', 'Andy iPhone', 'testflight', ?, ?, 'pending', '[]', ?, ?)`,
      )
      .run(deviceId, source.ownerId, source.agentId, devicePublicKey, confirmPublicKey, NOW, NOW);
    source.database
      .prepare(
        `INSERT INTO device_pairing_codes
           (code_hash, owner_id, agent_id, session_id, created_at, expires_at, used_at, device_id)
         VALUES (?, ?, ?, 'session-export', ?, '2026-11-10T00:10:00.000Z', ?, ?)`,
      )
      .run(codeHash, source.ownerId, source.agentId, NOW, NOW, deviceId);
    source.database
      .prepare(
        "INSERT INTO device_request_nonces (device_id, nonce, expires_at) VALUES (?, ?, '2026-11-10T00:02:00.000Z')",
      )
      .run(deviceId, nonce);
    return source;
  }

  it("[P1-6] exports the name, kind and status of each paired device and lists credentials as left out", async () => {
    const source = await withDevice();
    const { files, manifest } = await exportOf(source);
    const lines = decoder
      .decode(files.get("data/paired-devices.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        id: deviceId,
        kind: "iphone",
        name: "Andy iPhone",
        releaseChannel: "testflight",
        status: "pending",
        pairedAt: NOW,
        confirmedAt: null,
        revokedAt: null,
        lastSeenAt: NOW,
      },
    ]);
    expect(manifest.counts.pairedDevices).toBe(1);
    expect(manifest.omitted.map(({ what }) => what)).toContain(
      "配对设备的公钥、配对码和请求随机值",
    );
    expect(parsePortable(files, source.migrationSequence).pairedDevices).toHaveLength(1);
  });

  it("[P1-6][reverse] public keys, pairing codes and request nonces appear in no exported file, and import restores no device", async () => {
    const source = await withDevice();
    const { files } = await exportOf(source);
    for (const [path, bytes] of files) {
      const text = decoder.decode(bytes);
      for (const credential of [devicePublicKey, confirmPublicKey, codeHash, nonce])
        expect(text, path).not.toContain(credential);
    }
    const target = await side("devices-not-restored");
    const result = await importInto(target, files, { passphrase: PASSPHRASE });
    expect(result.imported.pairedDevices).toBe(0);
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM paired_devices").get()).toEqual({
      count: 0,
    });
  });

  it("[P1-6][reverse] Apple push tokens and notification button credentials appear in no exported file", async () => {
    const source = await withDevice();
    const pushToken = "ab".repeat(32);
    const actionTokenHash = "c1".repeat(32);
    const snapshotHash = "snapshot-hash-for-export-test";
    source.database
      .prepare(
        `INSERT INTO apns_registrations
           (id, owner_id, agent_id, device_id, push_type, activity_ref, token, environment, topic,
            locale, status, failure_code, created_at, updated_at, last_delivered_at)
         VALUES (?, ?, ?, ?, 'alert', '', ?, 'production', 'win.siyi.himawari.exporttest', 'zh-CN',
           'active', NULL, ?, ?, NULL)`,
      )
      .run(`apn_${"B".repeat(22)}`, source.ownerId, source.agentId, deviceId, pushToken, NOW, NOW);
    source.database
      .prepare(
        `INSERT INTO notification_action_tokens
           (token_hash, owner_id, agent_id, device_id, source_key, action, owner_presence,
            approval_request_id, approval_revision, approval_snapshot_hash, created_at, expires_at,
            used_at)
         VALUES (?, ?, ?, ?, 'approval:export-test:1', 'approve', 1, 'approval-export-test', 1, ?,
           ?, '2026-11-11T00:00:00.000Z', NULL)`,
      )
      .run(actionTokenHash, source.ownerId, source.agentId, deviceId, snapshotHash, NOW);
    const { files, manifest } = await exportOf(source);
    for (const [path, bytes] of files) {
      const text = decoder.decode(bytes);
      for (const credential of [
        pushToken,
        actionTokenHash,
        snapshotHash,
        "win.siyi.himawari.exporttest",
        `apn_${"B".repeat(22)}`,
      ])
        expect(text, path).not.toContain(credential);
    }
    expect(manifest.omitted.map(({ what }) => what)).toContain("苹果推送令牌和通知按钮凭据");
    const target = await side("push-not-restored");
    await importInto(target, files, { passphrase: PASSPHRASE });
    for (const table of ["apns_registrations", "notification_action_tokens"])
      expect(target.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
  });

  it("[P1-6][reverse] a device line with a public key added is refused", async () => {
    const source = await withDevice();
    const { files } = await exportOf(source);
    const tampered = rehash(files, (path, bytes) =>
      path === "data/paired-devices.jsonl"
        ? encoder.encode(
            decoder
              .decode(bytes)
              .replace('"kind"', `"devicePublicKey":"${devicePublicKey}","kind"`),
          )
        : bytes,
    );
    expect(() => parsePortable(tampered, source.migrationSequence)).toThrow(DataExportError);
  });
});
