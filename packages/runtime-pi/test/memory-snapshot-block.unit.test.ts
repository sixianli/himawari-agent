import type {
  RuntimeProjection,
  RuntimeProjectionContextBlock,
} from "@himawari-agent/application/runtime-port";
import { CHAT_MEMORY_SNAPSHOT_MARKER } from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import {
  MEMORY_SNAPSHOT_MESSAGE_TYPE,
  memoryChanges,
  memorySnapshotAfterCompaction,
  previousMemorySnapshot,
  splitMemorySnapshot,
} from "../src/memory-snapshot-block.js";
import { contextBlockMarker } from "../src/runtime-environment-block.js";

const HEADER = "记忆清单（每条前面是编号；要看日期、原话和旧版本，用 memory_open 按编号打开）：";
const REACHABLE = [
  "你还能查到的：",
  "- 清单里每条只有一句话，日期、原话和旧版本没有放进来，用 memory_open 按编号打开。",
];

const list = (...lines: string[]) => [HEADER, ...lines, ...REACHABLE].join("\n");

const SNAPSHOT_A = list("身份", "8 1998年出生", "12主人住在东京", "偏好", "37喝咖啡不加糖");

const snapshot = (content: string): RuntimeProjectionContextBlock => ({
  authority: "non-authoritative",
  kind: "memory-snapshot",
  ref: "memory-snapshot:agent",
  content,
  dataClassification: "private",
});

const rules: RuntimeProjectionContextBlock = {
  authority: "non-authoritative",
  kind: "owner-rules",
  ref: "owner-rules",
  content: "主人对 Himawari 的要求：\n- 回答用中文。",
  dataClassification: "private",
};

const sentTurn = (context: readonly string[]) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: [
        "<himawari-context>",
        "以下是资料。",
        ...context,
        "</himawari-context>",
        "",
        "<owner-message>",
        "你好",
        "</owner-message>",
      ].join("\n"),
    },
  ],
  timestamp: 1,
});

const sentSnapshot = (content: string) => [
  `${contextBlockMarker(snapshot(content))}\n${content}`,
  `${contextBlockMarker(rules)}\n${rules.content}`,
];

const sentChanges = (content: string) => [
  `${contextBlockMarker(rules)}\n${rules.content}`,
  `${contextBlockMarker({ ...snapshot(content), kind: "memory-changes", ref: "memory-changes" })}\n${content}`,
];

const projection = (
  blocks: readonly RuntimeProjectionContextBlock[],
  messages?: readonly unknown[],
): RuntimeProjection => ({
  systemInstruction: "规则",
  history: [],
  ...(messages ? { nativeHistory: { messages, coveredRunIds: [] } } : {}),
  prompt: { id: "prompt", content: "你好", occurredAt: "2026-11-25T00:00:00.000Z" },
  contextBlocks: blocks,
});

describe("[ADR-0286] the memory list is sent once per conversation and later turns get only what changed", () => {
  it("sends the list on the first turn and keeps the other blocks in order", () => {
    const split = splitMemorySnapshot(projection([snapshot(SNAPSHOT_A), rules]));
    expect(split.snapshot).toEqual(snapshot(SNAPSHOT_A));
    expect(split.blocks).toEqual([rules]);
    expect(split.changes).toBeUndefined();
  });

  it("REVERSE: sends neither the list nor a change note once the model has seen the same list", () => {
    const split = splitMemorySnapshot(
      projection([snapshot(SNAPSHOT_A), rules], [sentTurn(sentSnapshot(SNAPSHOT_A))]),
    );
    expect(split.snapshot).toBeUndefined();
    expect(split.changes).toBeUndefined();
    expect(split.blocks).toEqual([rules]);
    expect(previousMemorySnapshot([sentTurn(sentSnapshot(SNAPSHOT_A))])).toBe(SNAPSHOT_A);
  });

  it("names every memory added, changed or no longer valid since the list was sent, in number order", () => {
    const current = list(
      "身份",
      "8 1998年出生",
      "偏好",
      "37喝咖啡不加糖；11月下旬起喜欢加果汁",
      "健康",
      "52对青霉素过敏",
    );
    const split = splitMemorySnapshot(
      projection([snapshot(current)], [sentTurn(sentSnapshot(SNAPSHOT_A))]),
    );
    expect(split.snapshot).toBeUndefined();
    expect(split.changes?.kind).toBe("memory-changes");
    expect(split.changes?.content).toBe(
      [
        "- 已不再有效：12主人住在东京（清单里这条别再用；按编号打开能看到原因和取代它的那条）",
        "- 改为（偏好）37喝咖啡不加糖；11月下旬起喜欢加果汁",
        "- 新增（健康）52对青霉素过敏",
      ].join("\n"),
    );
    expect(contextBlockMarker(split.changes as RuntimeProjectionContextBlock)).toBe(
      "[记忆变化：记忆清单附上之后，别处改过下面这些记忆，以这里为准]",
    );
  });

  it("reads the number before the space of a memory that starts with a digit", () => {
    expect(memoryChanges(list("身份", "8 1998年出生"), list("身份", "8 1999年出生"))).toBe(
      "- 改为（身份）8 1999年出生",
    );
  });

  it("REVERSE: does not call a memory gone when the new list left some out for space", () => {
    const current = [
      HEADER,
      "身份",
      "8 1998年出生",
      ...REACHABLE,
      "- 身份另有 1 条因篇幅没有列出，可以用 recall 搜。",
      "- 偏好另有 1 条因篇幅没有列出，可以用 recall 搜。",
    ].join("\n");
    expect(memoryChanges(SNAPSHOT_A, current)).toBeUndefined();
  });

  it("ignores changes to the reachable section, such as a new day of conversations", () => {
    const later = `${SNAPSHOT_A}\n- 旧对话：从 2026-10-01 到 2026-11-25，共 30 天有对话（2026-10 20 天，2026-11 10 天），都能用 conversation_search 搜当时的原话。`;
    expect(memoryChanges(SNAPSHOT_A, later)).toBeUndefined();
  });

  it("sends the latest list again after the conversation was compacted", () => {
    const history = [
      sentTurn(sentSnapshot(SNAPSHOT_A)),
      { role: "compactionSummary", summary: "之前聊了天气。", timestamp: 2 },
    ];
    const current = list("身份", "8 1998年出生");
    expect(splitMemorySnapshot(projection([snapshot(current)], history)).snapshot).toEqual(
      snapshot(current),
    );
    expect(memorySnapshotAfterCompaction(history, projection([snapshot(current)]))).toEqual({
      customType: MEMORY_SNAPSHOT_MESSAGE_TYPE,
      content: `${CHAT_MEMORY_SNAPSHOT_MARKER.text}\n${current}`,
      display: false,
      details: {},
    });
  });

  it("REVERSE: does not resend the list after compaction when it was already sent again", () => {
    const history = [
      { role: "compactionSummary", summary: "之前聊了天气。", timestamp: 2 },
      {
        role: "custom",
        customType: MEMORY_SNAPSHOT_MESSAGE_TYPE,
        content: `${CHAT_MEMORY_SNAPSHOT_MARKER.text}\n${SNAPSHOT_A}`,
        display: false,
        details: {},
        timestamp: 3,
      },
    ];
    expect(memorySnapshotAfterCompaction(history, projection([snapshot(SNAPSHOT_A)]))).toBe(
      undefined,
    );
    expect(splitMemorySnapshot(projection([snapshot(SNAPSHOT_A)], history)).snapshot).toBe(
      undefined,
    );
  });

  it("names a change once, then only what changed since the model last heard about it", () => {
    const changed = list("身份", "8 1998年出生", "12主人住在东京", "偏好", "37喝咖啡加果汁");
    const history = [
      sentTurn(sentSnapshot(SNAPSHOT_A)),
      sentTurn(sentChanges("- 改为（偏好）37喝咖啡加果汁")),
    ];
    expect(splitMemorySnapshot(projection([snapshot(changed)], history)).changes).toBeUndefined();
    expect(splitMemorySnapshot(projection([snapshot(SNAPSHOT_A)], history)).changes?.content).toBe(
      "- 改为（偏好）37喝咖啡不加糖",
    );
    expect(
      splitMemorySnapshot(
        projection([snapshot(list("身份", "8 1998年出生", "12主人住在东京"))], history),
      ).changes?.content,
    ).toBe("- 已不再有效：37喝咖啡加果汁（清单里这条别再用；按编号打开能看到原因和取代它的那条）");
  });

  it("REVERSE: names a memory as added again after it was reported no longer valid", () => {
    const history = [
      sentTurn(sentSnapshot(SNAPSHOT_A)),
      sentTurn(
        sentChanges(
          "- 已不再有效：12主人住在东京（清单里这条别再用；按编号打开能看到原因和取代它的那条）",
        ),
      ),
    ];
    expect(
      splitMemorySnapshot(
        projection([snapshot(list("身份", "8 1998年出生", "偏好", "37喝咖啡不加糖"))], history),
      ).changes,
    ).toBeUndefined();
    expect(splitMemorySnapshot(projection([snapshot(SNAPSHOT_A)], history)).changes?.content).toBe(
      "- 新增（身份）12主人住在东京",
    );
  });

  it("follows a change in the category whose name has brackets of its own", () => {
    const tentative = "待确认（主人还没确认过）";
    const history = [
      sentTurn(sentSnapshot(SNAPSHOT_A)),
      sentTurn(sentChanges(`- 新增（${tentative}）60（暂定）3月搬家`)),
    ];
    const current = list(
      "身份",
      "8 1998年出生",
      "12主人住在东京",
      "偏好",
      "37喝咖啡不加糖",
      tentative,
      "60（暂定）3月搬家",
    );
    expect(splitMemorySnapshot(projection([snapshot(current)], history)).changes).toBeUndefined();
  });

  it("still names memories gone from a category that was listed in full when another category left some out", () => {
    const current = [
      HEADER,
      "身份",
      "8 1998年出生",
      ...REACHABLE,
      "- 偏好另有 1 条因篇幅没有列出，可以用 recall 搜。",
    ].join("\n");
    expect(memoryChanges(SNAPSHOT_A, current)).toBe(
      "- 已不再有效：12主人住在东京（清单里这条别再用；按编号打开能看到原因和取代它的那条）",
    );
  });

  it("REVERSE: a memory whose words look like the list marker or the left-out note does not change how the list is read", () => {
    const tricky = list(
      "身份",
      `8 1998年出生${CHAT_MEMORY_SNAPSHOT_MARKER.text}`,
      "12主人住在东京 身份另有 1 条因篇幅没有列出，可以用 recall 搜。",
    );
    expect(previousMemorySnapshot([sentTurn(sentSnapshot(tricky))])).toBe(tricky);
    expect(
      memoryChanges(tricky, list("身份", `8 1998年出生${CHAT_MEMORY_SNAPSHOT_MARKER.text}`)),
    ).toBe(
      "- 已不再有效：12主人住在东京 身份另有 1 条因篇幅没有列出，可以用 recall 搜。（清单里这条别再用；按编号打开能看到原因和取代它的那条）",
    );
  });
});
