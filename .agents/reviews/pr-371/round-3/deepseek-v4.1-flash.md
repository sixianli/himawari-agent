## 发现（按严重度）

### 中：多段拼接后的 `text` 仍可能超过合约 200 个 UTF-16 单元，整页打分会解析失败

- 文件：`packages/application/src/services/daily-review.ts:319-327`（拼接）、`packages/application/src/services/daily-review.ts:198-211`（`clipTo`）、`apps/agent-service/src/production-proactive.ts:341-343`、`:76-78`（出口 `clean`）、`packages/gateway-contracts/src/contracts-v2.ts:553,564`、`packages/gateway-contracts/src/validation.ts:92-95`
- 问题：本轮把 `clipTo` 改成按 UTF-16 长度截断，单个字段确实和 `boundedString` 一致；但整理记忆的多段文本是**先按每段 80 截断、再拼接**，拼接后的最终值没有再按 UTF-16 截断。`clean` 仍按码点截断，无法兜底。
- 证据：
  ```ts
  // daily-review.ts:319-327
  const clipped = (memory: DailyMemoryText) =>
    clipTo(memory.text, shown.length > 1 ? PART_LIMIT : TEXT_LIMIT);
  const oldText = olds.flatMap(...).join(" + ");
  text = next === undefined ? oldText : ... `${oldText} → ${clipped(next)}`;
  ```
  ```ts
  // production-proactive.ts:76-78
  return [...text.replace(/\p{Cc}+/gu, " ").trim()].slice(0, limit).join("");
  ```
  ```ts
  // validation.ts:92-95
  ... input.length > maximum ...
  ```
  三段各 80 个 UTF-16 单元（约 40 个 emoji）拼成 `80 + 3 + 80 + 3 + 80 = 246` 个单元、约 126 个码点；`clean(...,200)` 按码点只数到 126，不会截断，随后客户端 `gatewayV2MessageSchema.parse` 会因 `text` 长度 246 > 200 抛错。`apps/control-center/src/gateway-client.ts:268-271` 解析快照，`apps/control-center/src/proactive.ts:141-143` 捕获后把整个 `review` 置空，整块每天打分消失。
- 建议：拼接完成后再用同一个 UTF-16 安全截断器裁剪最终 `text`，或把 `clean` 改成按 UTF-16 长度截断；补一个“3 段 astral 字符 → 通过 gateway snapshot schema”的测试。该问题不是本轮引入，但本轮声称“和合约口径一致”时没有覆盖拼接后的最终值。

### 低：`AggregateError` 不是 `ApplicationPortError`，网关只回 500 通用错误码，虽不泄露文字但丢失错误语义

- 文件：`packages/application/src/services/memory-checkup.ts:292-293`、`packages/platform-node/src/http-gateway-server.ts:895-909`
- 问题：`AggregateError` 会被当成未知异常，返回 500 和通用 `HTTP_GATEWAY_REQUEST_INVALID`，而不是可识别的业务错误码；`MEMORY_CHECKUP_RESTORE_FAILED` 这个机器码没有任何消费方。
- 证据：
  ```ts
  // memory-checkup.ts:292-293
  if (restored !== undefined)
    throw new AggregateError([error, restored], "MEMORY_CHECKUP_RESTORE_FAILED");
  ```
  ```ts
  // http-gateway-server.ts:895-909
  const statusCode = ... ? 413 : 500;
  sendJson(reply, statusCode, {
    error: { code: ... HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID },
  });
  ```
  网页端只从响应体读 `error.code`（`gateway-client.ts:322-326`），不会看到内部错误文字。结论是**不会泄露内部文字**，但用户只看到通用失败，服务端也无法按稳定错误码检索这次“退回也失败”。
- 建议：用 `ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_CHECKUP_RESTORE_FAILED")` 并附加 `cause`/内部错误，或显式在网关映射该错误；这样既不泄露文字，又能返回 409 且可观测。

### 低：本轮新增逻辑没有已提交的自动测试，新增 `clipTo` 用例对“切开代理对”没有鉴别力

- 文件：`packages/application/test/daily-review.unit.test.ts:276-291`
- 问题：本仓库已提交的测试里，本轮只有这一个新增用例。`recordAction` 清空 `undone_at`、`recordUndo` 磁盘余量、`AggregateError`、合并撤销的“留下那条单独恢复”都没有对应测试；而现有用例只测纯 emoji，无法证明没有切开代理对。
- 证据：
  ```ts
  it("[P4-6] keeps text with characters outside the basic plane within the contract length", ...)
    readMemory: async () => ({ text: "😀".repeat(300), hidden: false }),
    ...
    expect(review.items[0]?.text).toBe("😀".repeat(100));
  ```
  300 个 emoji 用错误实现 `cleaned.slice(0, 200)` 也正好得到 100 个 emoji，因此该用例仍会通过；它只能证明“按 UTF-16 限制”，不能证明边界没有切半。旧实现会返回 200 个 emoji 而失败，所以它作为本轮回归用例是有效的，但覆盖不完整。
- 建议：补 `"a" + "😀".repeat(200)` 这类混排边界用例，断言结果不以孤立代理项结尾；同时补 `recordAction`/`recordUndo`/`AggregateError`/合并撤销重试的端口级单测。

## 推测 / 未核实

- 作者说“补丁里的集成测试本地 20 条全过”：未核实，仓库里也没有对应集成测试文件，无法运行确认。
- 数据表 `memory_checkup_items`、`undone_at` 列的实际约束未核实；按材料说明暂不提交迁移，因此不把“表不存在”作为问题。
- `findSourceMessageIds` 和每周全量扫描的规模上限未核实；代码上未看到条数上限，但这条路径在改动前已存在。
- `AggregateError.errors` 在服务端日志中的实际序列化内容未核实；已确认网页响应只含错误码。

## 侧重检查

- 错误路径：`act` 失败 → `#restore`；退回到位则重抛原错误，退回失败则 `AggregateError`，行保持已处理，用户仍可点“撤销”。HTTP 层对 `AggregateError` 只回通用 500，不泄露内部文字；`ApplicationPortError` 仍按 409/404/403 处理。`review({strict:true})` 会把生成周清单的错误原样报出，非 strict 路径记日志并返回空体检组。
- 不合规范/不可信输入：合同枚举限制 `reason`/`action`，命令 schema 限制 `keep` 只能和 `merge` 同时出现；`parseReviewKey` 只接受已知前缀；`MemoryCheckupStorePort` 的读取都带 owner/agent；合并的 `keep` 只能取本条的记忆或配对记忆。未发现 SQL 注入或越权路径。
- 安全与资源：`clipTo` 最多累加 `limit` 个 UTF-16 单元，不会遍历整段超长文本；`week()` 只在首次生成时全量扫描，空周有内存缓存。全量扫描本身没有上限，但属于既有设计。
- 不可撤销操作：删除是移到回收站，合并是归档，确认只改 `tentative`；撤销按状态恢复，且 `recordUndo` 的更新条件能保证重复撤销不会误清别的行。未发现永久删除路径。
- 文档与代码一致：ADR 0218 第 53、54 行关于“行保持已处理”“只看状态不看修订号”的说明与 `#restore` 代码一致；第 63 行“P3-8 合并前矛盾对来源为空”与 `pairs: async () => []` 一致；`reviewMemoryUnusedDays` 的 7–3650 范围和快照 `integer(1)`、网页使用也一致。
- 作者说法核对：撤销合并“留下那条单独判断”与 `memory-checkup.ts:339` 一致；`AggregateError` 与 `:292-293` 一致；`recordUndo` 磁盘检查、`recordAction` 清空 `undone_at` 与 SQLite 代码一致；ADR 限制已写明。唯一需要打折扣的是 `clipTo` 本身虽对齐 `boundedString`，拼接后的最终字段仍可能超限（见发现一）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本改动只影响 `proactive.review` 的网页快照、体检表行和记忆状态，没有改动系统提示、工具定义、历史消息或遮盖组装；`generatedAt`、`memoryUnusedDays`、`checkup`、`text` 都只出现在网页快照中，不进入模型请求。发给模型的内容仍然只由原有机制在末尾追加；本轮没有新增每轮变化值到请求头。未核实的部分只是“体检动作改变记忆后，后续轮次的记忆召回如何组装”，但该路径不在本 diff 内。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会（就模型请求而言）。`clipTo` 是纯函数，只依赖输入文本和 `limit`，不依赖前后文遮盖、时间或集合顺序；`AggregateError` 的消息是固定字符串；`pickMemoryCheckup`/`selectDailyReview` 有按 id/键的稳定排序。唯一随时间变化的是网页快照的 `generatedAt` 和数据库时间字段，它们本来就不进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，但不完整。新增的 `clipTo` 用例在旧实现下会失败，是有效的反向用例；但它无法发现“UTF-16 截断切开代理对”或“多段拼接后超过 200”的问题。`AggregateError`、`recordUndo` 磁盘余量、`recordAction` 清空 `undone_at`、合并撤销重试在本仓库没有已提交的自动测试；未提交的集成测试无法核实。

4. **每个产生/修改的值，两端都能接受吗？**
   - `clipTo` 产生的 `text`/`relatedText`：单条检查项输出 ≤200 个 UTF-16 单元，能被 `proactiveTextSchema(200)` 接受；但整理记忆多段拼接后的最终 `text` 可能超过 200，客户端 contract 会拒绝（发现一）。
   - `MEMORY_CHECKUP_RESTORE_FAILED`：只作为 `AggregateError` 消息，网页端没有消费方；网关按未知错误返回通用 500，不会回传该文字（发现二）。
   - `undone_at`：`recordAction` 清空、`recordUndo` 写入，`MemoryCheckupItem.undoneAt`/每日打分只按 `action` 判断是否已处理；已找到的使用处都能接受，实际数据表约束未核实。
   - `recordUndo` 的磁盘余量检查：失败时抛 `ApplicationPortError(PORT_CONFLICT)`，网关返回 409，网页端按失败处理；记忆可能已恢复但行仍未撤销，重试可继续，语义可接受。
   - 撤销合并时“留下那条”改为单独判断：`before.keepTentative` 保存于 `recordAction`，`#restore` 在 `live(keep)` 且尚未 `tentative` 时恢复；该转换写入的记忆状态是 `revise` 支持的字段，未发现消费端拒绝。
   - 配置/清单/契约字段：`reviewMemoryUnusedDays`（7–3650）、`checkup` 的 `reason`/`action` 枚举、`proactive.review.checkup` 命令、`memoryUnusedDays: integer(1)`、`source/kind: "checkup"` 在配置解析、网关合同、服务端、网页端和 fixture 两端一致，未发现取值不匹配。
