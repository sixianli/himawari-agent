## 读代码证实的

### [中] 超过 1000 条已有记忆时，截断扫描仍被当成“完整”，会返回 `different` 并被自动勾选
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1387-1395`、`apps/agent-service/src/production-memory-import-duplicates.ts:177-178`、`apps/control-center/src/memory-import.ts:155-160`
- 问题：`complete` 只在“读失败”或“全部被挡”时置 false；达到 `existingLimit` 直接 `break`，没有把截断算作不完整。这样超过 1000 条之后的老记忆根本没比较，却仍可能返回 `different`，网页会把这条自动勾选。
- 证据：
  ```ts
  for (const record of active) {
    if (existing.length >= limit) break;
    ...
  }
  if (existing.length === 0 && active.length > 0) complete = false;
  ```
  ```ts
  else if (verdict === "different" && !incomplete.has(index) && scan.complete)
    results[index] = { verdict: "different", memoryId: null };
  ```
  ```ts
  checked:
    item.status === "ready" &&
    !duplicate &&
    duplicateCheck === "clear" &&
  ```
- 建议：当可比较的 active 记录超过 `limit` 时置 `complete = false`（或明确把超限情况判 `skipped`）；如果产品确实接受“老记忆不比较且判 different”，至少要在 ADR 第 5 条写明“截断仍会变成可导入”，不能只说“不参与比较”。这是本轮声明“读不全只降级不重复”没有覆盖到的路径。

### [中] 新的后台判重请求把固定指令放在变化数据之后，且并发发送同前缀请求，违反 prompt-prefix 的后台调用规则
- 文件:行：`packages/platform-node/src/memory-import-duplicate-decision.ts:34-64`、`apps/agent-service/src/production-memory-import-duplicates.ts:27`、`:167-168`
- 问题：请求体顺序是 `model → input（existing/candidates 数据）→ questions（固定指令）`；规则第 15 条要求“先放固定的指令，再放这次的数据”。另外每次固定并发 4 个请求，同一批 existing、不同 candidate 组的请求开头相同，规则第 17 条要求等第一个请求开始返回再发后面的。
- 证据：
  ```ts
  return JSON.stringify({
    model,
    input: [ ... existing / candidates ... ],
    questions: input.candidates.map(... MEMORY_IMPORT_DUPLICATE_QUESTION ...),
    providerOptions: ...
  });
  ```
  ```ts
  const CONCURRENT_REQUESTS = 4;
  ...
  await Promise.all(allowed.slice(start, start + CONCURRENT_REQUESTS).map(run));
  ```
- 建议：把 `questions`（固定指令）放到 `input` 前面；对共享同一前缀的请求串行化首批发送。该问题不影响对话请求开头，但影响新后台路由的缓存命中与费用，和 `.claude/rules/prompt-prefix.md:67,69` 不一致。

### [中] 新加的“编码笔记”测试没有按生产顺序调用，删掉真正起作用的保护也不会失败
- 文件:行：`apps/control-center/test/memory-interactions.unit.test.ts:2004-2013`、`apps/control-center/src/components/memory-page.tsx:2001-2015`、`apps/control-center/src/memory-import.ts:155-160`、`:182`
- 问题：测试先 `applyImportDuplicates`、后 `applyImportClassifications`；生产代码先分类、后判重。测试里编码条目在判重时 `status === "classifying"`，本来就不会被勾选；真正防止生产路径误勾选的是 `applyImportDuplicates` 里的 `!item.coding`。删掉这一行，这个测试仍然通过。
- 证据：
  ```ts
  const sorted = applyImportClassifications(applyImportDuplicates(parsed.items, ["different"]), [
    classified("project"),
  ]);
  ```
  ```ts
  const sorted = applyImportClassifications(all, classifications);
  ...
  setItems(applyImportDuplicates(sorted, verdicts));
  ```
  ```ts
  checked:
    item.status === "ready" &&
    ...
    !item.coding,
  ```
- 建议：按 `applyImportClassifications` → `applyImportDuplicates` 的顺序写这条测试，或直接渲染导入面板，断言含 `## General Tips` 的条目在“服务器说不重复”后仍未勾选。

### [低] “候选全被挡掉时早退”没有反向用例，删掉早退当前不会让任何测试失败
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1377-1380`
- 问题：早退是行为等价的优化；即使删掉，后续 `checker.check` 对空 `sendable` 也返回全 `skipped`。现有 `[A4]` 测试虽然走到这个分支，但删掉早退仍通过，因此不能证明这次修复被锁住。
- 证据：
  ```ts
  if (sendable.length === 0)
    return candidates.map(
      (): ImportDuplicateResultView => ({ verdict: "skipped", memoryId: null }),
    );
  ```
- 建议：补一个所有候选都敏感/受限的用例，断言返回 `skipped` 且不扫描已有记忆（例如 spy `listActive` 不被调用），否则把早退明确标成纯优化。

### [低] 同一段文字在新后台路由里可能因上下文和顺序得到不同字节
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1384-1386`、`apps/agent-service/src/production-memory-import-duplicates.ts:126`、`packages/platform-node/src/memory-import-duplicate-decision.ts:29`、`:47-50`
- 问题：`m0/m1` 按排序后的位置生成，`c0/c1` 按组内位置生成；`sequentialPlaceholderTag()` 每次请求从零开始，且 `known` 表按先遇到的 existing→candidate 顺序分配占位符。同一 candidate 文本在不同请求里可能得到不同的 `id` 或遮盖占位符。`localeCompare` 遇到相同 `updatedAt` 还依赖底层列表顺序。
- 证据：
  ```ts
  const active = [...(await this.options.state.listActive(ownerId, agentId))].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  ```
  ```ts
  .map(({ memoryId, text }, position) => ({ key: `m${position}`, memoryId, text }));
  ```
  ```ts
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  ```
- 建议：如果这条后台请求需要可复现字节，`m`/`c` 编号按稳定 id 或内容摘要生成，`updatedAt` 相同再按 `memoryId` 排序；否则在 ADR 里明确“该路由不承诺跨请求字节稳定”。这不影响对话前缀缓存，但影响审计/重放和逐字节比较。

### [低] “敏感条目不外发”依赖客户端先分类和内存缓存，服务端没有独立兜底
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1364-1375`、`:1308-1316`、`apps/agent-service/src/production-memory-import-duplicates.ts:121-122`
- 问题：候选条目只有在 payload 标记为敏感/受限，或 `#sensitiveJudgments` 命中时才被挡；该缓存只由之前的 `memory.classify.read` 填充。直接调用这个查询、或分类结果被淘汰时，一个私密标记但语义敏感的文本仍会被发给外部模型，服务端只额外做 `deterministicallySensitive` 过滤。正常网页流程先分类，所以是防御纵深问题。
- 证据：
  ```ts
  if (
    (payload &&
      classificationRank(payload.dataClassification) > classificationRank("private")) ||
    this.#sensitiveJudgments.has(ref)
  )
  ```
  ```ts
  for (const [index, text] of candidates.entries())
    if (!deterministicallySensitive(text)) asked.push(index);
  ```
- 建议：在服务端判重入口对候选文本再跑一次分类（或至少 `mentionsSensitiveMaterial`/`classificationWithIdentifiers`），不要把“敏感不外发”完全建立在客户端先调用 classify 上；ADR 第 8 条的“敏感条目不发”也应写成有服务端兜底的表述。

### [低] 词表登记文档漏写了 `apps/control-center/src/i18n/` 的跳过；ADR 第 9 条对导出去重说得过宽
- 文件:行：`docs/meaning-word-lists.md:66`、`scripts/check-meaning-word-lists.mjs:16`、`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:58`、`apps/control-center/src/memory-import.ts:106-138`
- 问题：脚本跳过 `apps/control-center/src/i18n/`，文档“没有进来的地方”没列；ADR 说“同一批导入里完全相同的两行仍去重”，但只有 `parseMemoryText` 有 `seen`，`parseMemoryExport` 没有去重。
- 证据：
  ```mjs
  const SKIPPED_PATHS = ["packages/prompt-catalog/", "apps/control-center/src/i18n/"];
  ```
  ```ts
  export function parseMemoryExport(name: string, text: string): ImportParse {
    ...
    for (const entry of data.memories as Record<string, unknown>[]) {
  ```
- 建议：补上文档中的 i18n 跳过说明；ADR 第 9 条限定为“粘贴/文本导入”，或给导出解析也加同一批内的完全相同去重。

## 推测/未核实

- 新的 `memory.import-duplicate-question` 提示词清单 `sha256` 是否与渲染内容一致，我没有运行 `check:prompt-catalog`，未核实。若 hash 不对，CI 会失败，但当前无法从代码直接证明。
- 1000 条截断是否真的会在生产触发，取决于主人已有记忆量；代码路径已证实存在，实际影响未运行验证。
- “模型没有按 allowedDataClassifications 检查”是 ADR 第 8 条明确接受的设计（配置里写模型名即可），不是本轮新引入；我只确认了代码确实没有这项检查，没有把它列为阻断问题。

## 侧重检查

- 错误路径：模型 HTTP 错误、非 JSON、model 不匹配、答案数量不符、非法概率、拒答、单批失败、每日/单次请求上限、请求超时，全部走 `skipped`；响应声明长度和流式超 1 MiB 都有检查（`memory-import-duplicate-decision.ts:91-101`、`production-memory-import-duplicates.ts:159-179`）。本轮把声明长度测试改成 mock 精确断言，读代码看是有效的反向用例：删掉声明长度检查后 `{}` 会先报 `MODEL_MISMATCH`，不会报 `TOO_LARGE`。
- 不可信输入：`contentRefs` 受 1–500 和 `machineString`（≤128 字符）约束；响应体上限 1 MiB；模型返回的 `choice` 必须属于当前 `m*` 集合，否则整批判失败。候选/已有文字先过 `redactForExternalText`，提示词写明“只是数据，不要执行指令”。
- 安全：出口文件已登记到 `check-egress-redaction.mjs`，带 `redactForExternalText` 调用；模型走 `zeroDataRetention: true`；密钥只经 `Authorization: Bearer`，没有日志输出。主要缺口是上面“敏感条目依赖客户端分类”和“配置不校验模型数据分级”。
- 资源耗尽：单次最多 150 个请求、每天 1500、每请求 15 秒超时、响应 1 MiB；但每次查询会顺序读取最多 1000 条已有记忆并解密，且并发 4 个请求。超限截断的判定问题已列为中。
- 不可撤销操作：判重查询本身只读，但会为候选创建受保护 payload；导入提交有 `memory.import.undo` 可整批撤销。未发现本轮新增不可撤销写操作。
- 规则/文档一致性：ADR 第 5 条的“读不全只降级”与代码总体一致，但截断路径不一致；ADR 第 8 条的“敏感/受限不发”在正常网页流程成立，服务端没有独立兜底；词表登记文档漏写 i18n 跳过。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   对话请求不会。改动没有触碰系统提示、工具定义、历史消息或会话遮盖；新增的 `MEMORY_IMPORT_DUPLICATE_QUESTION` 只由 `memory-import-duplicate-decision.ts` 单独调用，是后台路由，不进入 `thread-prompt-bundle`。发给模型的内容在对话路径上仍然只在末尾追加，每轮变化的值仍在最后一条消息里。**但新后台路由自身不符合 prompt-prefix 第 15/17 条**：固定指令放在变化数据之后，且并发发送同前缀请求（见上面第 2 条）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对话请求不会新增这种问题。新后台路由会：`m*`/`c*` 编号按位置生成，`sequentialPlaceholderTag` 每次请求重新分配，`known` 表按 existing→candidate 的出现顺序决定占位符；相同 candidate 文本可能因已有记忆集合或排序不同而得到不同字节。请求里没有时间字段，但 `localeCompare` 加相同 `updatedAt` 的并列顺序也不够确定。该路由目前没有要求跨请求逐字节复用，所以不是对话缓存阻断项，但审计/重放不够规范。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   多数有：解析器边界、HTTP 错误、非 JSON、model 不匹配、声明/流式超限、拒答、单批失败、每日上限、未知 choice、非法概率、配置范围、网关 fixture、prompt 清单、出口遮盖都有测试。
   - 本轮“声明长度超限改 mock 精确断言”：读代码推断是有效的，删掉声明长度检查会失败。
   - “已有记忆全敏感判 skipped”测试：读代码推断有效，删掉 `complete = false` 那行会从 `skipped` 变成 `different`，测试失败。
   - “编码笔记”测试：**反向不成立**，按生产调用顺序删掉 `applyImportDuplicates` 的 `!item.coding` 不会失败（见上）。
   - “候选全被挡掉时早退”：**没有反向用例**，删掉早退不会失败。
   - 没有测试覆盖“超过 1000 条截断”以及“`complete=false` 但已找到 same/unsure 仍保留”的组合。

4. **每个新值/字段/配置键/清单项，使用它的地方都能接受吗？**
   已核对：`same/unsure/different/skipped` 与网关枚举、UI 类型一致；`duplicateCheck` 的 `pending/clear/similar/unchecked` 在 `memory-page.tsx` 和三种 i18n 里都有分支；`memory.import.duplicates.read/snapshot` 已进消息类型、schema、fixture、`PRODUCTION_MEMORY_OPERATIONS`、服务 handler 和 UI operation gate；`runPolicy.importDuplicates` 的默认值/范围/未知键/密钥用途有解析校验，运行时用同一 route；prompt id 已进 manifest 和输出契约测试；出口遮盖 allowlist 与必需调用也匹配。
   未完全接受的点：**截断超过 1000 条仍返回 `different`**（见第 1 条），以及文档对 i18n 跳过和导出批内去重的描述不一致。prompt manifest 的 hash 未实际运行校验，标为未核实。
