import { rm } from "node:fs/promises";
import {
  buildChatExport,
  CHAT_EXPORT_TOO_LARGE,
  canonicalJson,
  DATA_EXPORT_ERROR_CODES,
  type DataExportError,
  SEALED_FILE,
  sha256Hex,
  unsealJson,
  verifyChatExport,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { seedThread } from "./chat-export-fixture.ts";
import {
  openSide,
  SECRET_API_KEY,
  SECRET_BANK_CARD,
  SECRET_PASSWORD,
  SECRETS,
  type Side,
} from "./data-export-fixture.ts";

const NOW = "2026-11-12T00:00:00.000Z";
const PASSPHRASE = "测试口令-correct horse battery staple";
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

function exportOf(s: Side, sealPassphrase?: string) {
  return buildChatExport({
    database: s.database,
    scope: { ownerId: s.ownerId, agentId: s.agentId },
    migrationSequence: s.migrationSequence,
    protector: s.protector,
    policy,
    now: () => NOW,
    ...(sealPassphrase === undefined ? {} : { sealPassphrase }),
  });
}

interface MessageRow {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly status: string;
  readonly text: string;
  readonly withheld?: boolean;
  readonly attachments: { name: string; bytes: number; kind: string; truncated: boolean }[];
}

interface ThreadRow {
  readonly id: string;
  readonly title: { text: string; withheld?: boolean } | null;
  readonly status: string;
  readonly file: string;
  readonly messages: MessageRow[];
}

function jsonl(files: Map<string, Uint8Array>): ThreadRow[] {
  return decoder
    .decode(files.get("data/threads.jsonl"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function everyText(files: Map<string, Uint8Array>): string {
  return [...files.entries()]
    .filter(([path]) => path !== "sealed/sealed.enc")
    .map(([, bytes]) => decoder.decode(bytes))
    .join("\n");
}

function rebuilt(files: Map<string, Uint8Array>, path: string, change: (text: string) => string) {
  const copy = new Map(files);
  const next = encoder.encode(change(decoder.decode(files.get(path))));
  copy.set(path, next);
  return copy;
}

describe("chat export", () => {
  it("[多人7] exports threads and messages one-to-one with the database", async () => {
    const s = await side("a");
    await seedThread(s, "t-1", {
      title: "周末骑行计划",
      created: "2026-11-01T08:00:00.000Z",
      pinned: true,
      messages: [
        { text: "周末想骑车去海边" },
        { text: "好的，我帮你查路线" },
        { text: "只写了一半", role: "agent", status: "partial" },
        { text: "后台任务结束", role: "system" },
      ],
    });
    await seedThread(s, "t-2", {
      title: "回收站里的对话",
      status: "trashed",
      created: "2026-11-02T08:00:00.000Z",
      messages: [{ text: "这条在回收站" }],
    });
    await seedThread(s, "t-3", { title: null, messages: [{ text: "没有标题的对话" }] });
    const { files, manifest } = await exportOf(s);
    const threads = jsonl(files);
    expect(manifest.counts).toMatchObject({ threads: 3, messages: 6, markdownThreads: 3 });
    expect(threads.map((thread) => thread.id)).toEqual(["t-3", "t-1", "t-2"]);
    const first = threads.find((thread) => thread.id === "t-1") as ThreadRow;
    expect(first).toMatchObject({
      title: { text: "周末骑行计划" },
      status: "open",
      pinned: true,
      answerLocale: "zh-CN",
    });
    expect(
      first.messages.map((message) => [
        message.sequence,
        message.role,
        message.status,
        message.text,
      ]),
    ).toEqual([
      [1, "owner", "committed", "周末想骑车去海边"],
      [2, "agent", "committed", "好的，我帮你查路线"],
      [3, "agent", "partial", "只写了一半"],
      [4, "system", "committed", "后台任务结束"],
    ]);
    expect(threads.find((thread) => thread.id === "t-2")?.status).toBe("trashed");
    expect(threads.find((thread) => thread.id === "t-3")?.title).toBeNull();
    const markdown = decoder.decode(files.get(first.file));
    expect(markdown).toContain("周末骑行计划");
    expect(markdown).toContain("```\n周末想骑车去海边");
    expect(markdown).toContain("回答没有写完");
    expect(decoder.decode(files.get("CHATS.md"))).toContain("共 3 个对话、6 条消息");
    expect(verifyChatExport(files, s.migrationSequence).counts.messages).toBe(6);
  });

  it("[多人7] an empty database gives a valid archive with zero threads (negative case)", async () => {
    const s = await side("empty");
    const { files, manifest } = await exportOf(s);
    expect(manifest.counts).toMatchObject({ threads: 0, messages: 0 });
    expect(jsonl(files)).toEqual([]);
    expect(verifyChatExport(files, s.migrationSequence).counts.threads).toBe(0);
  });

  it("[多人7] threads being deleted or already deleted, and restricted messages, are not exported", async () => {
    const s = await side("deleted");
    await seedThread(s, "t-keep", {
      messages: [{ text: "保留" }, { text: "受限的消息", classification: "restricted" }],
    });
    await seedThread(s, "t-pending", {
      status: "deletion_pending",
      messages: [{ text: "正在删除的内容" }],
    });
    await seedThread(s, "t-gone", {
      status: "deleted_verified",
      messages: [{ text: "已删除的内容" }],
    });
    const { files, manifest } = await exportOf(s);
    const text = everyText(files);
    expect(text).not.toContain("正在删除的内容");
    expect(text).not.toContain("已删除的内容");
    expect(text).not.toContain("受限的消息");
    expect(jsonl(files).map((thread) => thread.id)).toEqual(["t-keep"]);
    const omitted = (what: string) =>
      manifest.omitted.find((entry) => entry.what.includes(what))?.count;
    expect(omitted("正在删除或已删除的对话")).toBe(2);
    expect(omitted("受限")).toBe(1);
  });

  it("threads Himawari opened to think something over are not exported, and are counted", async () => {
    const s = await side("think");
    await seedThread(s, "t-owner", { messages: [{ text: "我自己的对话" }] });
    await seedThread(s, "thread:think:client", { messages: [{ text: "编号像想一想的普通对话" }] });
    await seedThread(s, "t-think", { messages: [{ text: "外部内容的摘要" }] });
    s.database.prepare("UPDATE threads SET origin = 'think' WHERE id = 't-think'").run();
    const { files, manifest } = await exportOf(s);
    const text = everyText(files);
    expect(text).not.toContain("外部内容的摘要");
    expect(text).toContain("编号像想一想的普通对话");
    expect(
      jsonl(files)
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(["t-owner", "thread:think:client"]);
    expect(manifest.omitted.find((entry) => entry.what.includes("想一想"))?.count).toBe(1);
    expect(decoder.decode(files.get("CHATS.md"))).toContain(
      "共 2 个对话、2 条消息（进行中、已归档和回收站里的对话都在；正在删除和已删除的、Himawari 自己想一想时开的不在）",
    );
    expect(verifyChatExport(files, s.migrationSequence).counts.threads).toBe(2);
  });

  it("[多人7] a message whose text was erased by the deletion flow is skipped and counted", async () => {
    const s = await side("erased");
    await seedThread(s, "t-1", { messages: [{ text: "留着" }, { text: "被清除" }] });
    s.database
      .prepare("UPDATE payloads SET lifecycle_state = 'deleted_verified' WHERE ref = ?")
      .run("msg-t-1-2");
    const { files, manifest } = await exportOf(s);
    expect(jsonl(files)[0]?.messages.map((message) => message.text)).toEqual(["留着"]);
    expect(manifest.omitted.find((entry) => entry.what.includes("原文已被删除"))?.count).toBe(1);
  });

  it("[多人7] secrets never appear in the readable files, and the sealed file keeps the originals (negative case)", async () => {
    const s = await side("secret");
    await seedThread(s, "t-1", {
      title: "普通标题",
      messages: [
        { text: `我的银行卡号是 ${SECRET_BANK_CARD}` },
        { text: "收到" },
        { text: `密码：${SECRET_PASSWORD}，别告诉别人` },
        { text: `接口密钥 ${SECRET_API_KEY}` },
      ],
    });
    const unsealed = await exportOf(s);
    for (const secret of SECRETS) expect(everyText(unsealed.files)).not.toContain(secret);
    expect(unsealed.files.has(SEALED_FILE)).toBe(false);
    expect(unsealed.manifest.withheld.messages).toBe(3);
    expect(unsealed.manifest.withheld.threads).toBe(1);
    expect(jsonl(unsealed.files)[0]?.messages[1]).not.toHaveProperty("withheld");
    expect(jsonl(unsealed.files)[0]?.messages[0]?.withheld).toBe(true);
    const sealed = await exportOf(s, PASSPHRASE);
    for (const secret of SECRETS) expect(everyText(sealed.files)).not.toContain(secret);
    const bytes = sealed.files.get("sealed/sealed.enc") as Uint8Array;
    expect(decoder.decode(bytes)).not.toContain(SECRET_PASSWORD);
    const opened = (await unsealJson(PASSPHRASE, bytes)) as { originals: Record<string, string> };
    expect(opened.originals["thread/t-1/message/t-1-m1"]).toContain(SECRET_BANK_CARD);
    expect(opened.originals["thread/t-1/message/t-1-m3"]).toContain(SECRET_PASSWORD);
    expect(Object.keys(opened.originals)).toHaveLength(3);
    expect(sealed.manifest.counts.sealedOriginals).toBe(3);
  });

  it("[多人7] a secret in the title is masked too", async () => {
    const s = await side("title");
    await seedThread(s, "t-1", { title: `密钥 ${SECRET_API_KEY}`, messages: [{ text: "你好" }] });
    const { files } = await exportOf(s);
    expect(everyText(files)).not.toContain(SECRET_API_KEY);
    expect(jsonl(files)[0]?.title?.withheld).toBe(true);
  });

  it("[多人7] attachment tags become a list of name, size and kind, with no payload reference", async () => {
    const s = await side("attach");
    await seedThread(s, "t-1", {
      messages: [
        {
          text: '看看这个\n<file name="报告.pdf" ref="ref-secret-123" bytes="2048" kind="pdf"/>\n<file name="大文件.txt" ref="ref-456" bytes="99" kind="text" truncated="1"/>',
        },
        { text: `<file name="${SECRET_API_KEY}.txt" ref="ref-789" bytes="5" kind="text"/>` },
      ],
    });
    const { files, manifest } = await exportOf(s);
    const [thread] = jsonl(files) as [ThreadRow];
    expect(thread.messages[0]?.text).toBe("看看这个");
    expect(thread.messages[0]?.attachments).toEqual([
      { name: "报告.pdf", bytes: 2048, kind: "pdf", truncated: false },
      { name: "大文件.txt", bytes: 99, kind: "text", truncated: true },
    ]);
    expect(manifest.counts.attachments).toBe(3);
    expect(everyText(files)).not.toContain("ref-secret-123");
    expect(everyText(files)).not.toContain(SECRET_API_KEY);
    expect(thread.messages[1]?.attachments[0]?.name).toMatch(/^\[已扣留:1\]$/);
  });

  it("[多人7] old and extra-attribute attachment tags are also turned into a list, never left in the text", async () => {
    const s = await side("legacy-tags");
    await seedThread(s, "t-1", {
      messages: [
        {
          text: '旧消息\n\n<file name="old.md" ref="payload-attachment-old" bytes="9"/>\n<file name="x.png" ref="r2" kind="image" extra="1"/>\n<file name="n.txt" ref="r3"/>',
        },
      ],
    });
    const { files, manifest } = await exportOf(s);
    const [thread] = jsonl(files) as [ThreadRow];
    expect(thread.messages[0]?.text).toBe("旧消息");
    expect(thread.messages[0]?.attachments).toEqual([
      { name: "old.md", bytes: 9, kind: "other", truncated: false },
      { name: "x.png", bytes: 0, kind: "image", truncated: false },
      { name: "n.txt", bytes: 0, kind: "other", truncated: false },
    ]);
    expect(manifest.counts.attachments).toBe(3);
    for (const ref of ["payload-attachment-old", 'ref="r2"', 'ref="r3"'])
      expect(everyText(files)).not.toContain(ref);
  });

  it("[多人7] an attachment name over 1024 characters is shortened and the export still verifies", async () => {
    const s = await side("long-attachment-name");
    await seedThread(s, "t-1", {
      messages: [
        { text: `看这个\n\n<file name="${"长".repeat(3000)}" ref="r1" bytes="5" kind="text"/>` },
      ],
    });
    const { files } = await exportOf(s);
    const [thread] = jsonl(files) as [ThreadRow];
    expect(thread.messages[0]?.attachments[0]?.name.length).toBeLessThanOrEqual(1000);
    expect(verifyChatExport(files, s.migrationSequence).counts.attachments).toBe(1);
  });

  it("[多人7] message text is fenced so links, images and html are never rendered by a Markdown reader (negative case)", async () => {
    const s = await side("markdown-fence");
    const hostile =
      "看 ![x](https://evil.example/p.png) 和 <img src=x onerror=1> 还有 ```` 四个反引号";
    await seedThread(s, "t-1", {
      title: "标题 ![y](https://evil.example/t.png) <b>",
      messages: [
        {
          text: `${hostile}\n\n<file name="![x](https://evil.example/a.png) \`" ref="r1" bytes="5" kind="text"/>`,
        },
      ],
    });
    const { files } = await exportOf(s);
    const [thread] = jsonl(files) as [ThreadRow];
    const markdown = decoder.decode(files.get(thread.file));
    expect(markdown).toContain(`\`\`\`\`\`\n${hostile}\n\`\`\`\`\``);
    const attachmentLine = markdown.split("\n").find((line) => line.startsWith("- 附件：")) ?? "";
    expect(attachmentLine).toContain("a.png");
    expect(attachmentLine).not.toMatch(/[[\]<>`]/u);
    const head = markdown.split("\n")[0] ?? "";
    expect(head).not.toMatch(/[[\]<>`]/u);
    const index = decoder.decode(files.get("CHATS.md"));
    expect(index).toContain(thread.file);
    expect(index).not.toContain("![");
    expect(index).not.toMatch(/<b>|`/u);
    expect(verifyChatExport(files, s.migrationSequence).counts.threads).toBe(1);
  });

  it("[多人7] a message with hundreds of thousands of backtick runs still exports (negative case)", async () => {
    const s = await side("many-backticks");
    await seedThread(s, "t-1", { messages: [{ text: "` ".repeat(300_000) }] });
    const { files } = await exportOf(s);
    expect(verifyChatExport(files, s.migrationSequence).counts.messages).toBe(1);
  });

  it("[多人7] a very long title still produces an export that verifies", async () => {
    const s = await side("long-title");
    await seedThread(s, "t-1", { title: "长".repeat(6000), messages: [{ text: "x" }] });
    const { files } = await exportOf(s);
    expect(verifyChatExport(files, s.migrationSequence).counts.threads).toBe(1);
  });

  it("[多人7] an export larger than the limit is refused before anything is decrypted (negative case)", async () => {
    const s = await side("too-large");
    await seedThread(s, "t-1", { messages: [{ text: "x".repeat(5000) }] });
    await expect(
      buildChatExport({
        database: s.database,
        scope: { ownerId: s.ownerId, agentId: s.agentId },
        migrationSequence: s.migrationSequence,
        protector: s.protector,
        policy,
        now: () => NOW,
        maximumBytes: 1000,
      }),
    ).rejects.toThrow(CHAT_EXPORT_TOO_LARGE);
    const ok = await buildChatExport({
      database: s.database,
      scope: { ownerId: s.ownerId, agentId: s.agentId },
      migrationSequence: s.migrationSequence,
      protector: s.protector,
      policy,
      now: () => NOW,
      maximumBytes: 1_000_000,
    });
    expect(ok.manifest.counts.messages).toBe(1);
  });

  it("[多人7] a thread with an odd created_at cannot put a strange path into the archive", async () => {
    const s = await side("odd-date");
    await seedThread(s, "t-1", { created: "../../etc/passwd/../../x", messages: [{ text: "x" }] });
    const { files } = await exportOf(s);
    expect(jsonl(files)[0]?.file).toMatch(
      /^chats\/0000-00\/0000-00-00-untitled-[0-9a-f]{10}\.md$/u,
    );
  });

  it("[多人7] export is deterministic for the same data", async () => {
    const s = await side("same");
    await seedThread(s, "t-1", { title: "A", messages: [{ text: "x" }, { text: "y" }] });
    const first = await exportOf(s);
    const second = await exportOf(s);
    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    for (const [path, bytes] of first.files)
      expect(sha256Hex(bytes)).toBe(sha256Hex(second.files.get(path) as Uint8Array));
  });

  it("[多人7] two threads with the same day and title get different files", async () => {
    const s = await side("dup");
    await seedThread(s, "t-1", { title: "同名", messages: [{ text: "a" }] });
    await seedThread(s, "t-2", { title: "同名", messages: [{ text: "b" }] });
    const { files } = await exportOf(s);
    const paths = jsonl(files).map((thread) => thread.file);
    expect(new Set(paths).size).toBe(2);
    for (const path of paths)
      expect(path).toMatch(/^chats\/2026-11\/2026-11-01-同名-[0-9a-f]{10}(-\d+)?\.md$/u);
  });

  it("[多人7] only the owner's own threads are exported (negative case)", async () => {
    const mine = await side("mine");
    await seedThread(mine, "t-mine", { messages: [{ text: "我的" }] });
    mine.database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-other', 0)").run();
    mine.database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-other', 'owner-other', 0)",
      )
      .run();
    await seedThread(
      { ...mine, ownerId: "owner-other" as never, agentId: "agent-other" as never },
      "t-other",
      { messages: [{ text: "别人的内容" }] },
    );
    const { files } = await exportOf(mine);
    expect(jsonl(files).map((thread) => thread.id)).toEqual(["t-mine"]);
    expect(everyText(files)).not.toContain("别人的内容");
  });

  describe("verification", () => {
    async function good() {
      const s = await side("verify");
      await seedThread(s, "t-1", { title: "T", messages: [{ text: "a" }, { text: "b" }] });
      return { s, files: (await exportOf(s)).files };
    }
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as DataExportError).code;
      }
      return "NO_ERROR";
    };

    it("[多人7] a changed byte in any file is rejected", async () => {
      const { s, files } = await good();
      for (const path of [...files.keys()].filter((p) => p !== "manifest.json")) {
        const copy = new Map(files);
        const bytes = new Uint8Array(files.get(path) as Uint8Array);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        copy.set(path, bytes);
        expect(
          code(() => verifyChatExport(copy, s.migrationSequence)),
          path,
        ).toBe(DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH);
      }
    });

    it("[多人7] a missing or extra file is rejected", async () => {
      const { s, files } = await good();
      const missing = new Map(files);
      missing.delete("CHATS.md");
      expect(code(() => verifyChatExport(missing, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
      );
      const extra = new Map(files);
      extra.set("extra.txt", encoder.encode("x"));
      expect(code(() => verifyChatExport(extra, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
      );
    });

    it("[多人7] a memory export is not accepted as a chat export", async () => {
      const { s, files } = await good();
      const wrong = rebuilt(files, "manifest.json", (text) =>
        text.replace("himawari.chat-export.v1", "himawari.data-export.v2"),
      );
      expect(code(() => verifyChatExport(wrong, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
      );
    });

    it("[多人7] a manifest that disagrees with the data is rejected even when hashes are fixed up", async () => {
      const { s, files } = await good();
      const manifest = JSON.parse(decoder.decode(files.get("manifest.json")));
      manifest.counts.messages = 99;
      const copy = new Map(files);
      copy.set("manifest.json", encoder.encode(canonicalJson(manifest)));
      expect(code(() => verifyChatExport(copy, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
      );
    });

    function fixedUp(
      files: Map<string, Uint8Array>,
      change: (manifest: {
        files: { path: string; bytes: number; sha256: string }[];
        counts: Record<string, number>;
        withheld: Record<string, number>;
      }) => void,
      data?: string | Uint8Array,
    ) {
      const copy = new Map(files);
      const manifest = JSON.parse(decoder.decode(files.get("manifest.json"))) as Parameters<
        typeof change
      >[0];
      change(manifest);
      if (data !== undefined) {
        const content = typeof data === "string" ? encoder.encode(data) : data;
        copy.set("data/threads.jsonl", content);
        const entry = manifest.files.find((file) => file.path === "data/threads.jsonl");
        if (!entry) throw new Error("missing entry");
        entry.bytes = content.byteLength;
        entry.sha256 = sha256Hex(content);
      }
      copy.set("manifest.json", encoder.encode(canonicalJson(manifest)));
      return copy;
    }

    it("[多人7] a data file that is not valid UTF-8 is a stable error, not a raw exception (negative case)", async () => {
      const { s, files } = await good();
      const broken = fixedUp(files, () => {}, new Uint8Array([0xff, 0xfe, 0x0a]));
      expect(code(() => verifyChatExport(broken, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
      );
    });

    it("[多人7] a manifest that hides a required file, or counts withheld texts wrongly, is rejected", async () => {
      const { s, files } = await good();
      const hidden = new Map(files);
      hidden.delete("CHATS.md");
      expect(
        code(() =>
          verifyChatExport(
            fixedUp(hidden, (manifest) => {
              manifest.files = manifest.files.filter(
                (file: { path: string }) => file.path !== "CHATS.md",
              );
            }),
            s.migrationSequence,
          ),
        ),
      ).toBe(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH);
      for (const field of ["texts", "threads"]) {
        expect(
          code(() =>
            verifyChatExport(
              fixedUp(files, (manifest) => {
                manifest.withheld[field] = 7;
              }),
              s.migrationSequence,
            ),
          ),
          field,
        ).toBe(DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH);
      }
      expect(
        code(() =>
          verifyChatExport(
            fixedUp(files, (manifest) => {
              manifest.counts["sealedOriginals"] = 3;
            }),
            s.migrationSequence,
          ),
        ),
      ).toBe(DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH);
    });

    it("[多人7] a thread whose file points at a data or sealed file is rejected", async () => {
      const { s, files } = await good();
      const rows = jsonl(files);
      const [row] = rows as [ThreadRow];
      const data = `${canonicalJson({ ...row, file: "data/threads.jsonl" } as never)}\n`;
      expect(
        code(() =>
          verifyChatExport(
            fixedUp(files, () => undefined, data),
            s.migrationSequence,
          ),
        ),
      ).toBe(DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN);
    });

    it("[多人7] duplicate messages and out-of-order sequences are rejected", async () => {
      const { s, files } = await good();
      const tampered = new Map(files);
      const rows = jsonl(files);
      const [row] = rows as [ThreadRow];
      const broken = { ...row, messages: row.messages.map((m) => ({ ...m, sequence: 1 })) };
      const content = encoder.encode(`${canonicalJson(broken as never)}\n`);
      tampered.set("data/threads.jsonl", content);
      const manifest = JSON.parse(decoder.decode(files.get("manifest.json")));
      const entry = manifest.files.find(
        (file: { path: string }) => file.path === "data/threads.jsonl",
      );
      entry.bytes = content.byteLength;
      entry.sha256 = sha256Hex(content);
      tampered.set("manifest.json", encoder.encode(canonicalJson(manifest)));
      expect(code(() => verifyChatExport(tampered, s.migrationSequence))).toBe(
        DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN,
      );
    });
  });
});
