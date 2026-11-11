import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProactiveSourceItem } from "@himawari-agent/application";
import {
  EGRESS_PLACEHOLDER_LEGEND,
  EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE,
  proactivePrompt,
} from "@himawari-agent/application";
import { consolidationPrompt, episodeSummaryPrompt } from "@himawari-agent/memory-engine";
import { MEMORY_EMBEDDING_QUERY_INSTRUCTION } from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import { managedTaskDescriptors } from "../src/production-managed-tasks.js";
import { memoryCapturePrompt } from "../src/production-memory-capture.js";
import { memoryRecallDescriptor } from "../src/production-memory-recall.js";
import { reminderToolDescriptors } from "../src/production-reminder-writer.js";
import {
  ANSWER_LANGUAGE_RULE,
  HIMAWARI_IDENTITY,
  runCapabilityNotice,
  runtimeEnvironmentNotice,
} from "../src/production-run-policy.js";

const GOLDEN_DIRECTORY = fileURLToPath(new URL("./__prompt_golden__/", import.meta.url));

const GOLDEN_NAMES = [
  "chat.answer-language",
  "chat.capabilities.coding",
  "chat.capabilities.plain",
  "chat.egress-legend",
  "chat.egress-legend-with-restore",
  "chat.identity",
  "chat.runtime-environment.coding-full",
  "chat.runtime-environment.coding-without-workspace",
  "chat.runtime-environment.plain",
  "chat.runtime-environment.search",
  "mail.judgment",
  "memory.capture",
  "memory.consolidation",
  "memory.embedding-query-instruction",
  "memory.episode-summary",
  "tools.definitions",
];

const golden = (name: string) => {
  const path = `${GOLDEN_DIRECTORY}${name}.txt`;
  if (!existsSync(path)) throw new Error(`PROMPT_GOLDEN_MISSING ${name}`);
  return path;
};

const memory = (validFrom: string) =>
  ({
    attributes: { validFrom },
    recordedAt: validFrom,
    updatedAt: validFrom,
  }) as unknown as Parameters<typeof consolidationPrompt>[1][number]["memory"];

const mail = (id: string): ProactiveSourceItem => ({
  source: "gmail",
  messageId: `message-${id}`,
  threadId: `thread-${id}`,
  from: "東京ガス",
  fromAddress: "info@example.com",
  subject: `11 月のご請求 ${id}`,
  snippet: "お支払い期限は 11 月 20 日です。",
  link: `https://mail.example.com/${id}`,
  receivedAt: "2026-11-04T00:10:00.000Z",
  categories: ["CATEGORY_UPDATES"],
  sentByOwner: false,
  body: "お支払い期限は 11 月 20 日です。",
  bodyTruncated: false,
  bodyUnavailable: false,
  attachments: [],
});

const SANDBOX = {
  available: ["bash", "node", "rg", "python3"],
  unavailable: ["git", "curl"],
};

describe("[PROMPT-GOLDEN] rendered prompts stay byte-identical while text moves into the catalog", () => {
  it("keeps exactly the golden files rendered from the code before the move", () => {
    expect(
      readdirSync(GOLDEN_DIRECTORY)
        .map((file) => file.replace(/\.txt$/u, ""))
        .sort(),
    ).toEqual([...GOLDEN_NAMES].sort());
  });

  it("REVERSE: fails on a missing golden file instead of writing a new one", () => {
    expect(() => golden("chat.identity-removed")).toThrow(
      "PROMPT_GOLDEN_MISSING chat.identity-removed",
    );
  });

  it("keeps the conversation system prompt pieces", async () => {
    await expect(HIMAWARI_IDENTITY).toMatchFileSnapshot(golden("chat.identity"));
    await expect(ANSWER_LANGUAGE_RULE).toMatchFileSnapshot(golden("chat.answer-language"));
    await expect(EGRESS_PLACEHOLDER_LEGEND).toMatchFileSnapshot(golden("chat.egress-legend"));
    await expect(EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE).toMatchFileSnapshot(
      golden("chat.egress-legend-with-restore"),
    );
  });

  it("keeps every capability notice variant", async () => {
    await expect(runCapabilityNotice({ coding: false })).toMatchFileSnapshot(
      golden("chat.capabilities.plain"),
    );
    await expect(runCapabilityNotice({ coding: true })).toMatchFileSnapshot(
      golden("chat.capabilities.coding"),
    );
  });

  it("keeps every runtime environment variant", async () => {
    await expect(
      runtimeEnvironmentNotice({ coding: false, workspaceRoot: null }),
    ).toMatchFileSnapshot(golden("chat.runtime-environment.plain"));
    await expect(
      runtimeEnvironmentNotice({
        coding: false,
        workspaceRoot: null,
        publicSearch: { providers: ["exa-public", "deepseek"] },
        publicFetch: { providers: ["exa-public"], maximumBytes: 512 * 1024 },
      }),
    ).toMatchFileSnapshot(golden("chat.runtime-environment.search"));
    await expect(
      runtimeEnvironmentNotice({
        coding: true,
        workspaceRoot: null,
        documentSkillDirectory: "/opt/himawari/document-skill/",
        sandboxCommands: SANDBOX,
      }),
    ).toMatchFileSnapshot(golden("chat.runtime-environment.coding-without-workspace"));
    await expect(
      runtimeEnvironmentNotice({
        coding: true,
        workspaceRoot: "/home/andy/projects/demo",
        documentSkillDirectory: "/opt/himawari/document-skill/",
        sandboxCommands: SANDBOX,
      }),
    ).toMatchFileSnapshot(golden("chat.runtime-environment.coding-full"));
  });

  it("keeps the tool definitions the model sees", async () => {
    const tools = [
      ...reminderToolDescriptors(),
      memoryRecallDescriptor(),
      ...managedTaskDescriptors(),
    ];
    await expect(JSON.stringify(tools, null, 2)).toMatchFileSnapshot(golden("tools.definitions"));
  });

  it("keeps the background prompts with their data in place", async () => {
    await expect(
      memoryCapturePrompt(
        "我下周三要去大阪出差，记得提醒我前一天订酒店。",
        [
          {
            id: "memory-1" as Parameters<typeof memoryCapturePrompt>[1][number]["id"],
            text: "主人住在东京都北区。",
            stance: null,
          },
        ],
        "好的，我会尽量记住。",
        "2026-11-04T00:40:00.000Z",
        "Asia/Tokyo",
        { subCategories: { work: ["出差"] }, people: [] },
      ),
    ).toMatchFileSnapshot(golden("memory.capture"));
    await expect(
      consolidationPrompt(
        [
          {
            label: "A",
            fresh: { label: "A1", memory: memory("2026-11-03"), text: "主人喜欢喝乌龙茶。" },
            neighbours: [
              {
                label: "A2",
                memory: memory("2026-10-01"),
                text: "主人爱喝乌龙茶。",
                quote: "我最近只喝乌龙茶",
              },
            ],
          },
        ],
        [{ label: "N1", memory: memory("2026-11-04"), text: "主人周末常去爬山。" }],
      ),
    ).toMatchFileSnapshot(golden("memory.consolidation"));
    await expect(
      episodeSummaryPrompt({
        ownerId: "owner-1",
        agentId: "agent-1",
        threadId: "thread-1",
        day: "2026-11-04",
        firstSequence: 1,
        lastSequence: 2,
        startedAt: "2026-11-04T00:40:00.000Z",
        endedAt: "2026-11-04T00:41:00.000Z",
        lines: [
          { role: "owner", text: "明天要带伞吗？", committedAt: "2026-11-04T00:40:00.000Z" },
          {
            role: "agent",
            text: "明天下午有雨，建议带伞。",
            committedAt: "2026-11-04T00:41:00.000Z",
          },
        ],
      } as unknown as Parameters<typeof episodeSummaryPrompt>[0]),
    ).toMatchFileSnapshot(golden("memory.episode-summary"));
    await expect(
      proactivePrompt([mail("a"), mail("b")], "2026-11-04T01:00:00.000Z", "Asia/Tokyo", [
        {
          mailId: "message-a",
          id: "memory-7",
          text: "主人用东京燃气，每月自动扣款。",
          dataClassification: "private",
        },
      ]),
    ).toMatchFileSnapshot(golden("mail.judgment"));
    await expect(MEMORY_EMBEDDING_QUERY_INSTRUCTION.text).toMatchFileSnapshot(
      golden("memory.embedding-query-instruction"),
    );
  });
});
