import { rm } from "node:fs/promises";
import {
  buildPortableExport,
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  importPortableExport,
  MANIFEST_FILE,
  type PortableFiles,
  SEALED_FILE,
  sealJson,
  sha256Hex,
  unsealJson,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSide,
  ownerRuleParameters,
  RULE_SECRET_PHRASE,
  type Side,
  seedEverything,
  seedMemory,
  writeRuleVersion,
} from "./data-export-fixture.ts";

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
  const source = await side("rules-source");
  await seedEverything(source);
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

function ruleRows(from: Side) {
  return {
    rules: from.database
      .prepare(
        `SELECT rule_id, revision, parameters, status, source, source_memory_id, updated_at
        FROM rule_book_rules ORDER BY rule_id`,
      )
      .all(),
    history: from.database
      .prepare(
        `SELECT rule_id, revision, parameters, status, source, source_memory_id, change_reason,
          changed_at
        FROM rule_book_history ORDER BY rule_id, revision`,
      )
      .all(),
  };
}

function readable(files: PortableFiles): string {
  return [...files]
    .filter(([path]) => path !== SEALED_FILE)
    .map(([, bytes]) => decoder.decode(bytes))
    .join("\n");
}

function rehash(
  files: PortableFiles,
  mutate: (path: string, text: string) => string,
): PortableFiles {
  const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
    files: { path: string; bytes: number; lines: number; sha256: string; role: string }[];
  };
  const next: PortableFiles = new Map();
  for (const [path, bytes] of files)
    next.set(
      path,
      path === MANIFEST_FILE || path === SEALED_FILE
        ? bytes
        : encoder.encode(mutate(path, decoder.decode(bytes))),
    );
  for (const entry of manifest.files) {
    const bytes = next.get(entry.path) ?? new Uint8Array();
    entry.bytes = bytes.byteLength;
    entry.sha256 = sha256Hex(bytes);
    if (entry.role === "data") entry.lines = [...bytes].filter((byte) => byte === 0x0a).length;
  }
  next.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
  return next;
}

function editRuleLine(
  files: PortableFiles,
  ruleId: string,
  edit: (rule: Record<string, unknown>) => void,
): PortableFiles {
  return rehash(files, (path, text) => {
    if (path !== "data/rules.jsonl") return text;
    return text
      .split("\n")
      .map((line) => {
        if (line === "") return line;
        const rule = JSON.parse(line) as Record<string, unknown>;
        if (rule["ruleId"] !== ruleId) return line;
        edit(rule);
        return JSON.stringify(rule);
      })
      .join("\n");
  });
}

describe("data export: the rule book travels with the memories", () => {
  it("[P1-6] exports every stored rule with its full history and imports it byte for byte", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    expect(manifest.format).toBe("himawari.data-export.v3");
    expect(manifest.counts.rules).toBe(5);
    expect(manifest.counts.ruleHistoryVersions).toBe(7);
    const target = await side("rules-target");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.rules).toBe(5);
    expect(report.skipped.rulesWithoutOriginal).toBe(0);
    const before = ruleRows(source);
    const after = ruleRows(target);
    const linkKept = (rows: readonly unknown[]) =>
      rows.map((row) => {
        const value = row as Record<string, unknown>;
        return value["source_memory_id"] === "m-verified"
          ? { ...value, source_memory_id: null }
          : value;
      });
    expect(after.rules).toEqual(linkKept(before.rules));
    expect(after.history).toEqual(linkKept(before.history));
    const again = await exportOf(target);
    expect(decoder.decode(again.files.get("data/rules.jsonl"))).toBe(
      decoder.decode(files.get("data/rules.jsonl")),
    );
    expect(decoder.decode(again.files.get("RULES.md"))).toBe(decoder.decode(files.get("RULES.md")));
  });

  it("[HR-4] a push_quiet_hours rule is exported with its wording and imported byte for byte", async () => {
    const source = await seeded();
    writeRuleVersion(source, {
      ruleId: "owner:night-push",
      parameters: {
        type: "push_quiet_hours",
        summary: "夜里别推任务结果",
        params: {
          periods: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
          classes: ["run_result"],
        },
      },
      source: "ADR 0244；主人在对话里说的一句话",
      reason: "owner_sentence",
      at: "2026-11-04T05:00:00.000Z",
    });
    const { files, manifest } = await exportOf(source);
    expect(manifest.counts.rules).toBe(6);
    const markdown = decoder.decode(files.get("RULES.md"));
    const line = markdown.split("\n").find((text) => text.includes("〔r:owner:night-push〕"));
    expect(line).toContain("静默延后");
    expect(line).toContain("夜里别推任务结果");
    const target = await side("push-rule-target");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.rules).toBe(6);
    expect(ruleRows(target).rules).toEqual(
      ruleRows(source).rules.map((row) =>
        (row as Record<string, unknown>)["source_memory_id"] === "m-verified"
          ? { ...(row as Record<string, unknown>), source_memory_id: null }
          : row,
      ),
    );
  });

  it("[P1-6] RULES.md lists each stored rule once with its wording, state and source memory", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const markdown = decoder.decode(files.get("RULES.md"));
    const ids = [...markdown.matchAll(/^- 〔r:([^〕]+)〕 /gmu)].map((match) => match[1]);
    expect(ids.sort()).toEqual([
      "floor_important_sender",
      "owner:build-key",
      "owner:refund-thread",
      "owner:subscription",
      "quiet_hours",
    ]);
    const line = (id: string) => markdown.split("\n").find((text) => text.includes(`〔r:${id}〕`));
    expect(line("owner:refund-thread")).toContain("涉及退款的邮件先读完整个邮件串");
    expect(line("owner:refund-thread")).toContain("〔m:m-plain〕");
    expect(line("owner:subscription")).toContain("已撤销");
    expect(line("floor_important_sender")).toContain("boss@example.com");
    expect(line("floor_important_sender")).toContain("第 2 版");
    expect(line("quiet_hours")).toContain("23:00–07:00");
    expect(markdown).toContain("共 5 条存下来的规则，其中 4 条正在执行");
    expect(markdown).toContain("内置 floor_public_domain");
  });

  it("[P1-6] a rule whose source memory was not exported keeps the rule and drops the link", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    const line = decoder
      .decode(files.get("data/rules.jsonl"))
      .split("\n")
      .find((text) => text.includes('"owner:subscription"'));
    expect(JSON.parse(line ?? "{}").sourceMemoryId).toBeNull();
    expect(
      manifest.omitted.find(({ what }) => what === "规则出处里指向未导出记忆的链接")?.count,
    ).toBe(3);
  });

  it("[P1-6] a secret inside a rule is masked, kept in the sealed file and restored with the passphrase", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    expect(readable(files)).not.toContain(RULE_SECRET_PHRASE);
    expect(manifest.withheld.rules).toBe(1);
    const sealed = (await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array())) as {
      originals: Record<string, string>;
    };
    expect(sealed.originals["rule/owner:build-key/parameters"]).toContain(RULE_SECRET_PHRASE);
    const target = await side("rules-secret");
    await importInto(target, files, PASSPHRASE);
    const stored = target.database
      .prepare("SELECT parameters FROM rule_book_rules WHERE rule_id = 'owner:build-key'")
      .pluck()
      .get() as string;
    expect(stored).toBe(
      source.database
        .prepare("SELECT parameters FROM rule_book_rules WHERE rule_id = 'owner:build-key'")
        .pluck()
        .get(),
    );
    expect(JSON.parse(stored).params.phrases).toEqual([RULE_SECRET_PHRASE]);
  });

  it("[P1-6] without the passphrase the withheld rule is skipped and counted, the others are imported", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("rules-nopass");
    const report = await importInto(target, files);
    expect(report.skipped.rulesWithoutOriginal).toBe(1);
    expect(report.imported.rules).toBe(4);
    expect(
      target.database
        .prepare("SELECT COUNT(*) FROM rule_book_rules WHERE rule_id = 'owner:build-key'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("[P1-6] a rule put on review by its memory keeps that state and reason after the round trip", async () => {
    const source = await side("rules-review");
    await seedMemory(source, {
      id: "m-rule-visa",
      text: "入管局的邮件以后必须通知我",
      category: "rule",
    });
    writeRuleVersion(source, {
      ruleId: "owner:immigration",
      parameters: ownerRuleParameters(
        "mail_must_notify",
        { senderDomains: ["moj.go.jp"] },
        "入管局的邮件一定提醒",
      ),
      source: "ADR 0213；主人在对话里说的一句话",
      sourceMemoryId: "m-rule-visa",
      reason: "owner_sentence",
      at: "2026-11-03T04:00:00.000Z",
    });
    source.database
      .prepare("UPDATE memory_records SET status = 'archived', updated_at = ? WHERE id = ?")
      .run("2026-11-04T00:00:00.000Z", "m-rule-visa");
    const { files } = await exportOf(source);
    const target = await side("rules-review-target");
    await importInto(target, files, PASSPHRASE);
    expect(ruleRows(target)).toEqual(ruleRows(source));
    expect(
      target.database
        .prepare("SELECT status, revision FROM rule_book_rules WHERE rule_id = 'owner:immigration'")
        .get(),
    ).toEqual({ status: "needs_review", revision: 2 });
    expect(
      target.database
        .prepare(
          "SELECT change_reason FROM rule_book_history WHERE rule_id = 'owner:immigration' AND revision = 2",
        )
        .pluck()
        .get(),
    ).toBe("memory_removed");
  });

  it("[P4-1] a paused rule and the owner's review clicks survive the round trip, the suggestion and open review marks stay behind", async () => {
    const source = await side("rules-suspended");
    await seedMemory(source, {
      id: "m-rule-visa",
      text: "入管局的邮件以后必须通知我",
      category: "rule",
    });
    await seedMemory(source, { id: "m-visa-plan", text: "Andy 每周一看入管局的邮件" });
    writeRuleVersion(source, {
      ruleId: "owner:immigration",
      parameters: ownerRuleParameters(
        "mail_must_notify",
        { senderDomains: ["moj.go.jp"] },
        "入管局的邮件一定提醒",
      ),
      source: "ADR 0213；主人在对话里说的一句话",
      sourceMemoryId: "m-rule-visa",
      reason: "owner_sentence",
      at: "2026-11-03T04:00:00.000Z",
    });
    const db = source.database;
    db.prepare(
      `UPDATE rule_book_rules SET status = 'suspended', suspend_reason = 'parameters_changed',
         suggestion = ?, revision = revision + 1, updated_at = ?
       WHERE rule_id = 'owner:immigration'`,
    ).run(
      JSON.stringify(
        ownerRuleParameters(
          "mail_must_notify",
          { senderDomains: ["moj.go.jp", "isa.go.jp"] },
          "入管局和出入国在留管理厅的邮件一定提醒",
        ),
      ),
      "2026-11-04T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO rule_book_history (
        owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
        change_reason, changed_at
      ) SELECT owner_id, agent_id, rule_id, revision, parameters, status, source,
        source_memory_id, 'rule_review_suspended', updated_at
      FROM rule_book_rules WHERE rule_id = 'owner:immigration'`,
    ).run();
    db.prepare(
      `INSERT INTO memory_review_items (
        owner_id, agent_id, memory_id, upstream_memory_id, via_memory_id, reason, depth,
        expanded, status, flagged_at
      ) VALUES (?, ?, 'm-visa-plan', 'm-rule-visa', NULL, 'owner_reported', 1, 1, 'open', ?)`,
    ).run(source.ownerId, source.agentId, "2026-11-04T00:00:00.000Z");
    db.prepare(
      `INSERT INTO decision_ledger (
        id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, subject_ref,
        inputs, cost_micros, duration_ms
      ) VALUES ('memory-review-missed-1', ?, ?, 'memory_review', ?, '{}',
        'owner_reported_missed', 'owner_reported', 'm-visa-plan', ?, 0, 0)`,
    ).run(
      source.ownerId,
      source.agentId,
      "2026-11-04T00:00:00.000Z",
      JSON.stringify({
        memoryIds: ["m-rule-visa"],
        ruleIds: [],
        batchId: null,
        resultMemoryIds: ["m-visa-plan"],
      }),
    );
    const { files, manifest } = await exportOf(source);
    const exportedRule = decoder
      .decode(files.get("data/rules.jsonl"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(({ ruleId }) => ruleId === "owner:immigration");
    expect(exportedRule?.["status"]).toBe("suspended");
    expect(exportedRule?.["suspendReason"]).toBe("parameters_changed");
    expect(readable(files)).not.toContain("isa.go.jp");
    const notExported = new Map(
      (manifest.omitted as readonly { what: string; count: number | null }[]).map(
        ({ what, count }) => [what, count],
      ),
    );
    expect(notExported.get("规则暂停时系统算出的建议值")).toBe(1);
    expect(notExported.get("等你确认的待重审记忆标记")).toBe(1);
    const target = await side("rules-suspended-target");
    await importInto(target, files, PASSPHRASE);
    expect(
      target.database
        .prepare(
          `SELECT status, suspend_reason AS suspendReason, suggestion, review_after AS reviewAfter
           FROM rule_book_rules WHERE rule_id = 'owner:immigration'`,
        )
        .get(),
    ).toEqual({
      status: "suspended",
      suspendReason: "parameters_changed",
      suggestion: null,
      reviewAfter: null,
    });
    expect(
      target.database
        .prepare(
          "SELECT kind, outcome, subject_ref FROM decision_ledger WHERE kind = 'memory_review'",
        )
        .all(),
    ).toEqual([
      { kind: "memory_review", outcome: "owner_reported_missed", subject_ref: "m-visa-plan" },
    ]);
    expect(target.database.prepare("SELECT COUNT(*) FROM memory_review_items").pluck().get()).toBe(
      0,
    );
  });

  it("[P1-6] an instance without any stored rule still exports and imports, with zero rules", async () => {
    const source = await side("rules-empty");
    await seedMemory(source, { id: "m-only", text: "喜欢喝茶" });
    const { files, manifest } = await exportOf(source);
    expect(manifest.counts.rules).toBe(0);
    expect(decoder.decode(files.get("data/rules.jsonl"))).toBe("");
    expect(decoder.decode(files.get("RULES.md"))).toContain("共 0 条存下来的规则");
    const target = await side("rules-empty-target");
    const report = await importInto(target, files, PASSPHRASE);
    expect(report.imported.rules).toBe(0);
  });

  it("[P1-6] the largest important-sender list the settings accept still round-trips byte for byte", async () => {
    const source = await side("rules-large");
    await seedMemory(source, { id: "m-only", text: "喜欢喝茶" });
    const senders = Array.from(
      { length: 200 },
      (_, index) =>
        `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.sender${index}.example.com`,
    );
    writeRuleVersion(source, {
      ruleId: "floor_important_sender",
      parameters: { senders },
      source: "ADR 0106；主人的设置“重要发件人”",
      at: "2026-11-01T00:00:00.000Z",
    });
    const stored = source.database
      .prepare("SELECT parameters FROM rule_book_rules WHERE rule_id = 'floor_important_sender'")
      .pluck()
      .get() as string;
    expect(stored.length).toBeGreaterThan(40_000);
    const { files } = await exportOf(source);
    const target = await side("rules-large-target");
    await importInto(target, files, PASSPHRASE);
    expect(ruleRows(target)).toEqual(ruleRows(source));
  });

  it("[P1-6] stored parameters that are not in the writers' own JSON form travel only in the sealed file", async () => {
    const source = await side("rules-uneven");
    await seedMemory(source, { id: "m-only", text: "喜欢喝茶" });
    writeRuleVersion(source, {
      ruleId: "floor_important_sender",
      parameters: { senders: ["bank.example"] },
      source: "ADR 0106；主人的设置“重要发件人”",
      at: "2026-11-01T00:00:00.000Z",
    });
    const uneven = '{"senders":["hidden.example"],"senders":["bank.example"]}';
    source.database.exec("DROP TRIGGER rule_book_history_no_update");
    source.database.prepare("UPDATE rule_book_rules SET parameters = ?").run(uneven);
    source.database.prepare("UPDATE rule_book_history SET parameters = ?").run(uneven);
    const { files, manifest } = await exportOf(source);
    expect(manifest.withheld.rules).toBe(1);
    expect(decoder.decode(files.get("data/rules.jsonl"))).not.toContain("hidden.example");
    const target = await side("rules-uneven-target");
    await importInto(target, files, PASSPHRASE);
    expect(ruleRows(target)).toEqual(ruleRows(source));
  });
});

describe("data export: a tampered rule book is refused before anything is written", () => {
  const cases: [string, (files: PortableFiles) => PortableFiles, string][] = [
    [
      "rule parameters the rule type does not accept",
      (files) =>
        editRuleLine(files, "owner:refund-thread", (rule) => {
          const parameters = JSON.parse(String(rule["parameters"])) as {
            params: { phrases: string[] };
          };
          parameters.params.phrases = ["退"];
          rule["parameters"] = JSON.stringify(parameters);
          const history = rule["history"] as { parameters: unknown }[];
          const last = history.at(-1);
          if (last) last.parameters = rule["parameters"];
        }),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a history without the current version",
      (files) =>
        editRuleLine(files, "floor_important_sender", (rule) => {
          (rule["history"] as unknown[]).pop();
        }),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a source memory that is not in the export",
      (files) =>
        editRuleLine(files, "owner:refund-thread", (rule) => {
          rule["sourceMemoryId"] = "m-missing";
          const history = rule["history"] as { sourceMemoryId: unknown }[];
          const last = history.at(-1);
          if (last) last.sourceMemoryId = "m-missing";
        }),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a built-in rule smuggled into the data",
      (files) =>
        editRuleLine(files, "quiet_hours", (rule) => {
          rule["ruleId"] = "floor_public_domain";
        }),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a RULES.md that is missing a rule",
      (files) =>
        rehash(files, (path, text) =>
          path === "RULES.md"
            ? text
                .split("\n")
                .filter((line) => !line.includes("〔r:quiet_hours〕"))
                .join("\n")
            : text,
        ),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "a RULES.md that points a rule at another source memory",
      (files) =>
        rehash(files, (path, text) =>
          path === "RULES.md" ? text.replace("〔m:m-plain〕", "〔m:m-other〕") : text,
        ),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
    [
      "rule parameters that are not in the form the writers produce",
      (files) =>
        editRuleLine(files, "quiet_hours", (rule) => {
          rule["parameters"] = ` ${String(rule["parameters"])}`;
          const history = rule["history"] as { parameters: unknown }[];
          const last = history.at(-1);
          if (last) last.parameters = rule["parameters"];
        }),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "rule parameters that are not JSON",
      (files) =>
        editRuleLine(files, "quiet_hours", (rule) => {
          rule["parameters"] = "{not json";
          const history = rule["history"] as { parameters: unknown }[];
          const last = history.at(-1);
          if (last) last.parameters = rule["parameters"];
        }),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a rule id with characters that would break the sealed keys",
      (files) =>
        editRuleLine(files, "quiet_hours", (rule) => {
          rule["ruleId"] = "quiet_hours/history/1";
        }),
      DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    ],
    [
      "a source memory id with brackets",
      (files) =>
        editRuleLine(files, "owner:refund-thread", (rule) => {
          rule["sourceMemoryId"] = "m-〔x〕";
          const history = rule["history"] as { sourceMemoryId: unknown }[];
          const last = history.at(-1);
          if (last) last.sourceMemoryId = "m-〔x〕";
        }),
      DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    ],
  ];
  for (const [name, mutate, code] of cases) {
    it(`[P1-6][reverse] refuses ${name} and writes nothing`, async () => {
      const source = await seeded();
      const { files } = await exportOf(source);
      const target = await side(`rules-tamper-${code}`);
      await expect(importInto(target, mutate(files), PASSPHRASE)).rejects.toMatchObject({ code });
      expect(target.database.prepare("SELECT COUNT(*) FROM rule_book_rules").pluck().get()).toBe(0);
      expect(target.database.prepare("SELECT COUNT(*) FROM memory_records").pluck().get()).toBe(0);
    });
  }

  it("[P1-6] RULES.md wording from another version is accepted as long as the markers match", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const reworded = rehash(files, (path, text) =>
      path === "RULES.md"
        ? text
            .replace("共 5 条存下来的规则", "一共存了 5 条规则")
            .replace("静默时段：这段时间不推送，结束后合并成一条", "静默时段")
        : text,
    );
    const target = await side("rules-reworded");
    const report = await importInto(target, reworded, PASSPHRASE);
    expect(report.imported.rules).toBe(5);
  });

  it("[P1-6] a rule whose own words contain a memory marker still exports and imports", async () => {
    const source = await side("rules-marker-text");
    await seedMemory(source, { id: "m-plain", text: "退款的邮件都要提醒我" });
    writeRuleVersion(source, {
      ruleId: "owner:marker-linked",
      parameters: ownerRuleParameters(
        "mail_must_notify",
        { phrases: ["退款"] },
        "写着〔m:m-other〕的退款邮件一定提醒",
      ),
      source: "mcp:〔m:m-elsewhere〕",
      sourceMemoryId: "m-plain",
      at: "2026-11-01T00:00:00.000Z",
    });
    writeRuleVersion(source, {
      ruleId: "owner:marker-alone",
      parameters: ownerRuleParameters(
        "mail_must_notify",
        { phrases: ["发票"] },
        "〔r:x〕〔m:y〕发票",
      ),
      source: "ADR 0213；主人在对话里说的一句话",
      at: "2026-11-01T00:00:00.000Z",
    });
    const { files } = await exportOf(source);
    const target = await side("rules-marker-text-target");
    await importInto(target, files, PASSPHRASE);
    expect(ruleRows(target)).toEqual(ruleRows(source));
  });

  it("[P1-6][reverse] a sealed original that is not text is refused", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const sealed = (await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array())) as {
      originals: Record<string, unknown>;
    };
    const memoryKey = Object.keys(sealed.originals).find((key) => key.startsWith("memory/"));
    sealed.originals[memoryKey ?? ""] = 7;
    const resealed = await sealJson(PASSPHRASE, sealed as never);
    const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
      files: { path: string; bytes: number; sha256: string }[];
    };
    for (const entry of manifest.files)
      if (entry.path === SEALED_FILE) {
        entry.bytes = resealed.byteLength;
        entry.sha256 = sha256Hex(resealed);
      }
    const tampered: PortableFiles = new Map(files);
    tampered.set(SEALED_FILE, resealed);
    tampered.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
    const target = await side("rules-reseal-number");
    await expect(importInto(target, tampered, PASSPHRASE)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
    });
  });

  it("[P1-6][reverse] a stored rule id the import would refuse stops the export", async () => {
    const source = await side("rules-bad-id");
    await seedMemory(source, { id: "m-only", text: "喜欢喝茶" });
    writeRuleVersion(source, {
      ruleId: "quiet_hours/history/1",
      parameters: { periods: [] },
      source: "ADR 0106；主人的设置“静默时段”",
      at: "2026-11-01T00:00:00.000Z",
    });
    await expect(exportOf(source)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    });
  });

  it("[P1-6][reverse] parameters longer than the export limit stop the export", async () => {
    const source = await side("rules-too-long");
    await seedMemory(source, { id: "m-only", text: "喜欢喝茶" });
    writeRuleVersion(source, {
      ruleId: "floor_important_sender",
      parameters: {
        senders: Array.from({ length: 1100 }, (_, index) => `${"a".repeat(230)}${index}.example`),
      },
      source: "ADR 0106；主人的设置“重要发件人”",
      at: "2026-11-01T00:00:00.000Z",
    });
    await expect(exportOf(source)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.LINE_INVALID,
    });
  });

  it("[P1-6][reverse] a sealed original that no longer matches the rule's history is refused", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const sealed = (await unsealJson(PASSPHRASE, files.get(SEALED_FILE) ?? new Uint8Array())) as {
      originals: Record<string, string>;
    };
    sealed.originals["rule/owner:build-key/parameters"] = JSON.stringify(
      ownerRuleParameters("mail_must_notify", { phrases: ["发票"] }, "发票一定提醒"),
    );
    const resealed = await sealJson(PASSPHRASE, sealed);
    const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
      files: { path: string; bytes: number; sha256: string }[];
    };
    for (const entry of manifest.files)
      if (entry.path === SEALED_FILE) {
        entry.bytes = resealed.byteLength;
        entry.sha256 = sha256Hex(resealed);
      }
    const tampered: PortableFiles = new Map(files);
    tampered.set(SEALED_FILE, resealed);
    tampered.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
    const target = await side("rules-reseal");
    await expect(importInto(target, tampered, PASSPHRASE)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
    });
    expect(target.database.prepare("SELECT COUNT(*) FROM rule_book_rules").pluck().get()).toBe(0);
  });

  it("[P1-6][reverse] a target with leftover rule history is not empty", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("rules-leftover-history");
    target.database
      .prepare(
        `INSERT INTO rule_book_history (owner_id, agent_id, rule_id, revision, parameters, status,
          source, changed_at) VALUES (?, ?, 'quiet_hours', 1, '{"periods":[]}', 'active', 'x', ?)`,
      )
      .run(target.ownerId, target.agentId, NOW);
    await expect(importInto(target, files, PASSPHRASE)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
      detail: "rule_book_history",
    });
  });

  it("[P1-6][reverse] a target that already has a rule is not empty", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("rules-not-empty");
    writeRuleVersion(target, {
      ruleId: "quiet_hours",
      parameters: { periods: [] },
      source: "ADR 0106；主人的设置“静默时段”",
      at: "2026-11-01T00:00:00.000Z",
    });
    const failure = await importInto(target, files, PASSPHRASE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DataExportError);
    expect(failure).toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
      detail: "rule_book_rules",
    });
  });
});
