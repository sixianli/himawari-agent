排序逻辑会不会改变「无待确认记忆」时原有返回顺序，取决于 provider 的 `search` 原本按什么顺序返回。我去查 provider 实现。
# 代码复核报告：PA-2 聊天检索返回待确认记忆（3a34099）

## 读代码证实的结论

### 逐条核对作者的说法

| 说法 | 结论 |
|---|---|
| 打开 `includeTentative` | ✅ production-memory-recall.ts:171 |
| 返回待确认记忆并标 `tentative: true` | ✅ production-memory-recall.ts:208,217 |
| 附固定说明 `tool-result.recall-tentative` | ✅ production-memory-recall.ts:250；提示词在 packages/prompt-catalog/src/background.ts:94-101，已登记 manifest（prompt-manifest.json:431-435） |
| 同分时正式记忆在前 | ✅ production-memory-recall.ts:190-192（`Number(isTentative(left)) - Number(isTentative(right))`，0 在 1 前） |
| 待确认最多占一半，limit 1 时 0 条 | ✅ production-memory-recall.ts:196 `Math.floor(input.limit / 2)`，limit 1 → 0 |
| 只改工具返回值，不改工具定义和系统提示 | ✅ diff 只含 recall 实现、测试、ADR、manifest、background.ts；`memoryRecallDescriptor`（production-memory-recall.ts:29-48）未动，golden 测试引用它也无需更新 |
| 没有待确认记忆时返回值逐字节相同 | ✅ 见下方分析 |

## 发现的问题（按严重度从高到低）

**1.（中）apps/agent-service/src/production-memory-recall.ts:169,196-209 — 检索候选窗口不补偿，小 limit 时可能把本来命中的正式记忆整批挤掉，还回「没有找到」**
- 证据：第 169 行 `limit: input.limit * 3` 向 provider 要 `limit*3` 个候选；打开 `includeTentative` 后，待确认记忆会占用这 `limit*3` 个名额（hybrid-memory-provider.ts:167-114 的 `fuseCandidates(...).slice(0, input.limit)`，fusion.ts:113-114 按 score 排序后截断）。名额封顶在 production-memory-recall.ts:209 用 `continue` 跳过多余待确认记忆，但被挤出窗口的正式记忆根本进不了 `hits`。
- 例：`limit=1`（窗口 3 条）且前三名都是待确认记忆时，`tentativeLimit=0` 把三条全跳过，`memories` 为空；此时若窗口外有相关正式记忆，第 247-248 行会返回 `TOOL_RESULT_RECALL_EMPTY.text`（「没有找到相关的记忆或对话摘要」），模型被告知没有记录——以前同一查询会返回那条正式记忆。`limit=2` 时同理最多返回 1 条。
- 建议：窗口不够时补一次不带 `includeTentative` 的检索（或把窗口扩大到能容纳名额上限），至少在 `memories.length === 0` 但存在被名额挤掉的待确认记忆时不要回「没有找到」。

**2.（低）apps/agent-service/test/production-memory-recall.unit.test.ts:166-172 — 「与原来逐字节相同」只有结构性断言，没有逐字节对照**
- 证据：`[PA-2] REVERSE: confirmed memories look exactly as before` 只断言 `not.toHaveProperty("tentative")` 和没有 `tentativeNote`（166-172 行），没有把整个返回对象与改动前的固定样本逐字节比对（键序、note 文字都不在断言里）。我读代码证实了键序和顺序都不变（`...(tentative ? {...} : {})` 在 false 时不加键，production-memory-recall.ts:217；新排序在无待确认记录时退化为「score 降序、平分按原 index」，而 provider 本来就按 score 降序、平分按 `memoryId.localeCompare` 固定排序——fusion.ts:113），但这条「逐字节相同」的承诺没有自动化检查钉住。
- 建议：给该 REVERSE 用例加一个完整对象深比对（`toEqual` 全量），把键序也固定下来。

**3.（低，推测）apps/agent-service/src/production-memory-recall.ts:184-185 — 敏感类待确认记忆参与排序但被过滤，行为正确但无测试**
- 证据：`isTentative` 在排序阶段不管 dataClassification；敏感类待确认记忆（`allowed` 不含）会在第 205 行被滤掉，输出不受影响。但没有用例覆盖「待确认 + 高于本次 run 分类」的组合（旧用例 production-memory-recall.unit.test.ts:82-98 只用正式记忆测分类过滤）。推测无实际风险，属覆盖缺口。

## 侧重检查（走过的一条普通流程）

流程：聊天请求 → 模型调用 recall 工具 → production-runtime-tools.ts:1054 分发到 `#recall`（:597）→ `#ownerScoped`（:635，意图指纹 :643-653、结果缓存 :654-660、`modelContent: JSON.stringify(value)` :671）→ `ProductionMemoryRecall.recall`（production-memory-recall.ts:130）→ `HybridMemoryProvider.search`（hybrid-memory-provider.ts:122-179，透传 `includeTentative` :165）→ `fuseCandidates`（fusion.ts:68-114）→ 结果经 `modelContent` 变成工具结果消息。

- 新增字段的recall 内部逻辑有单元测试覆盖（含 3 个反向用例）；但 `#ownerScoped` → `modelContent` 这段序列化路径对新增字段没有测试（只有通用的 JSON.stringify，无断言聊天层工具结果里真出现 `tentativeNote`）。属覆盖缺口，不是 bug。
- test/integration/memory-consolidation.test.ts:599「keeps a tentative rule out of recall until it is seen again」不受影响：它直接调引擎 `searchable(...)`（:631-639），不走聊天 recall，且不传 `includeTentative`，sqlite 层默认仍排除待确认（sqlite-memory-operations.ts:242）。
- 文档一致：ADR 0179 决定 3 的新文字（docs/adr/0179:56）与代码逐条对得上，包括「档案块、提醒、记忆整理都不变」——我核实了 owner-profile、提醒路径没有改动、SQL 默认仍排除。

## 必答问题逐条回答

1. **请求开头是否改变？** 不会。工具定义（production-memory-recall.ts:29-48）和系统提示未动；`includeTentative` 只传给内部 provider，不发给模型。工具结果只在产生的那一刻经 `modelContent` 追加到对话末尾（production-runtime-tools.ts:671），历史里存的是当时发出去的字节；旧对话、旧工具结果不受影响。每轮会变的新值（`tentative` 标记、`tentativeNote`）都只出现在本轮最后追加的工具结果消息里。符合 prompt-prefix.md 第 4、5 条。
2. **同一段文字会不会变字节？** 不会。`tentativeNote` 是目录里的固定文字；`tentative` 字段位置固定（键序确定：text→tentative→current→…，production-memory-recall.ts:215-223）；新排序完全确定（score → tentative → 原 index，且 provider 平分时按 `memoryId.localeCompare` 固定，fusion.ts:113）。没有引入时间、无序集合或依赖前后文的值。
3. **自动检查与反向用例？** 有。`[PA-2]` 首个用例对旧代码会失败（`expect(search).toHaveBeenCalledWith(objectContaining({includeTentative: true}))`，测试 ：157——旧代码不传该参数）；名额上限用例在去掉封顶时会失败（3 条待确认 ≠ 2，:182；limit 1 时返回 g1 ≠ 0，:184-185）。「逐字节相同」缺全量对照（见问题 2）。manifest sha256 有自动检查钉住（prompt-catalog.unit.test.ts:187 `PROMPT_MANIFEST_STALE`），哈希值本身我未重算（未核实），但该检查会在不一致时失败。
4. **每个产生值的两端核对：**
   - `includeTentative: true`：端口类型有此字段（memory-projection.ts:201）；实际 provider `HybridMemoryProvider.search` 接受并透传（hybrid-memory-provider.ts:129,165）；DurableMemoryService 也透传（durable-memory-service.ts:367,379）；SQL 端生效（sqlite-memory-operations.ts:242,1079）。✅
   - `tentative: true` / `tentativeNote`：唯一消费方是模型（`modelContent` 原样 JSON.stringify，production-runtime-tools.ts:671，无结果 schema 校验会拒绝新键）。✅
   - manifest 条目 `tool-result.recall-tentative`：`changedIn: "ADR 0179"`、reason 非空，且目录导出链完整（index.ts:1 重导出 background.ts，recall 正常导入）。✅（sha 数值本身未逐字重算，由测试覆盖）

**总体**：作者的说法与代码一致，未发现说错的地方；需要处理的主要是问题 1 的候选窗口挤占（小 limit 时可能误报「没有找到」）。
