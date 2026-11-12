# PR-371 第 2 轮复核（af0f116，增量 36ee0d2..af0f116）

## 高

### 1. 合并撤销在“恢复旧条成功、恢复留下那条失败”后，第二次撤销会漏掉留下那条
- 文件:行：`packages/application/src/services/memory-checkup.ts:320-340`
- 问题：撤销是否恢复“留下那条”的 `tentative` 被 `merged` 绑死；而 `merged` 只看“被归档的那条是否仍处于被本次取代的样子”。第一次撤销已经把旧条恢复成 active 后，如果这时恢复留下那条失败，第二次撤销会看到 `merged === false`，于是完全不恢复留下那条，却照常 `recordUndo` 清空整行并返回成功。
- 证据：
  ```ts
  const merged =
    keepId !== null && drop?.status === "archived" && drop.attributes?.supersededBy === keepId;
  ...
  if (merged && before.keepTentative && live(keep) && keep.attributes?.tentative !== true)
  ```
  以及 `packages/persistence-sqlite/src/sqlite-memory-checkup-operations.ts:215-217`：
  ```sql
  UPDATE memory_checkup_items SET action = NULL, kept_memory_id = NULL,
    before_state = NULL, handled_at = NULL, undone_at = ?
  ```
- 后果：留下那条永久停在“已转正”，但 UI/API 显示已撤销；与 ADR 0218 第 54 行“撤销中途出错后再点一次能接着做完”直接矛盾。第一轮新增的“撤销跳过逻辑”只覆盖了正常单次撤销，没有覆盖“部分完成后的重试”。
- 建议：把留下那条的恢复与 `merged` 解耦（例如只要 `before.keepTentative && live(keep) && keep.tentative !== true` 就恢复；若担心误恢复别处改动，则在 `before_state` 里持久化“已恢复到哪一步”或存处理后 revision），并补一条“旧条恢复成功、留下那条恢复失败 → 再次撤销”的用例。

## 中

### 2. 先占行再改记忆：退回也失败时，行会停在“已处理”，退回错误被吞掉
- 文件:行：`packages/application/src/services/memory-checkup.ts:276-290`
- 问题：`recordAction` 成功后若 `apply()` 抛错，代码调用 `this.#restore(item.id).catch(() => undefined)`，退回失败完全不记录、不告警。此时行仍是 `action`/`handled_at`/`before_state` 齐全，`act` 重试会命中 `MEMORY_CHECKUP_ALREADY_HANDLED`（第 231 行），只能靠 undo 收拾。
- 证据：
  ```ts
  try {
    await apply();
  } catch (error) {
    await this.#restore(item.id).catch(() => undefined);
    throw error;
  }
  ```
- 具体后果（读代码可确认；触发需退回本身失败）：
  - 合并的 `revise(drop)` 已成功、`confirm(keep)` 失败、退回 drop 又被拒（revision 冲突/磁盘错误）时，drop 保持 archived，接口却只返回原错误，且行显示“已处理”。
  - `action = "confirm"` 时，`listConfirmedSince` 只看 `action='confirm' AND handled_at >= ?`（`sqlite-memory-checkup-operations.ts:223-234`），会把一次实际没转正的失败操作算进 84 天“已确认”安静集。
  - 作者说法“改记忆失败时这一行仍未处理且记忆不变”只在退回成功时成立，退回失败/进程在占行后崩溃时不成立。
- 建议：退回失败要上报（`onFailure` 或至少日志）；把行进入一个可识别的“退回未完成”状态而不是普通已处理；或者为 confirm 的安静集增加“真正应用成功”的条件；补“apply 成功一部分 + restore 失败 + 重试/undo”的用例。

### 3. 核心服务逻辑没有已提交的自动检查，反向用例覆盖不足
- 文件:行：无对应测试文件（`glob **/*checkup*` 只命中 `ports/memory-checkup.ts`、`services/memory-checkup.ts`、`sqlite-memory-checkup-operations.ts`）
- 问题：本轮最关键的“先占行、失败退回、撤销跳过”逻辑没有任何已提交测试；作者说明里提到的 `test/integration/memory-checkup.test.ts` 和迁移契约测试不在仓库里。ADR 0218 第 79-82 行把它们列为“门槛（会自动拦下的测试）”，第 83 行才说另存补丁，文档与代码树不一致。
- 已提交的反向用例里，`daily-review.unit.test.ts:513` 的 `[negative] does not add pending items beyond today's slots` 在旧代码上也会通过（旧代码本来就只取 `selection.shown`），它不是本改动的真正反向用例；真正会失败的是“yesterday 仍在 items”那条。
- 建议：把 `memory-checkup.test.ts` 连同真表迁移一起提交，或至少用假的 store/state 写单元测试覆盖：并发两次 act、apply 失败退回成功/失败、合并部分撤销后重试、confirm 失败误入安静集。否则无法验证“三条在第 1 轮代码上会失败”的说法。

## 低

### 4. 删除/合并的撤销身份判断偏粗，可能回退“后来另一次操作”
- 文件:行：`packages/application/src/services/memory-checkup.ts:312-321`
- 问题：删除撤销只判断“现在是否 trashed”，合并只判断“现在是否 archived 且 supersededBy 等于 keep”。如果删除后主人又手动把它回收站恢复、再重新删除，checkup 的 undo 仍会恢复它，实际撤销了更晚的一次本人操作。ADR 第 54 行“删除的那条还在回收站才恢复”本身就是这个粗粒度规则，所以是设计残留风险，不是实现偏离文档。
- 建议：在 `before_state` 里补存处理后的 revision 或一次处理标记，用 revision/标记判断“还是本次处理后样子”；若不改，至少在 ADR 写明这一限制。

### 5. `relatedText` 的裁剪口径与网关契约不一致
- 文件:行：`packages/application/src/services/daily-review.ts:381-382`；`packages/gateway-contracts/src/contracts-v2.ts:318-321`；`packages/gateway-contracts/src/validation.ts:89-105`
- 问题：`clip()` 按 Unicode 码点截 200（`[...text].slice(0, limit)`），契约 `boundedString` 按 UTF-16 `.length > maximum` 拒绝。含星号平面字符（部分 emoji）时，200 个码点可达 400 个 UTF-16 单元，整个 review snapshot 会在契约校验处失败。`text` 原本就有此问题，本改动给体检新增的 `relatedText` 复制了同一风险。
- 建议：统一按 `.length` 截断，或把契约长度改成码点口径；给含 emoji 的记忆文本加契约用例。

### 6. `recordUndo` 没有磁盘余量检查
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-checkup-operations.ts:209-221`
- 问题：同文件的 `createWeek`、`recordAction` 都调用了 `assertDiskHeadroom()`，`recordUndo` 没有。虽然写入量很小，但撤销是“把系统从异常状态救回来”的关键路径，磁盘写失败会直接落入上面第 2 条的静默状态。
- 建议：补 `this.assertDiskHeadroom()`，与其它写操作一致。

### 7. 网页的合并只提供“用新的替换旧的”，与 ADR“主人选留哪条”不完全一致
- 文件:行：`apps/control-center/src/components/proactive-reminders.tsx:451`
- 问题：`onAct("merge", checkup.memoryId)` 固定保留 `item.memoryId`（新条），另一条（旧条）只能通过“确认/删掉新的”间接处理；ADR 第 48、51 行写的是“主人选留哪条”。网关契约和 service 都支持保留任意一条，只有 UI 少一个方向。
- 建议：补“用旧的替换新的”按钮，或在 ADR 明确只支持保留新条。

### 8. 重新处理时不清 `undone_at`
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-checkup-operations.ts:190-206` 与 `:215-217`
- 问题：`recordUndo` 写入 `undone_at`，下次 `recordAction` 只改 action/kept/before/handled，不把 `undone_at` 清空。当前没有消费者读体检行的 `undoneAt`，所以只是数据自相矛盾，暂不影响行为。
- 建议：`recordAction` 一并 `undone_at = NULL`，避免以后误用。

## 侧重检查

- **错误路径**：查了 `act` 的占行/apply/退回顺序、`#restore` 的三条分支、并发两次点击（`action IS NULL` 的 UPDATE 有 CAS 作用，正常）、并发 undo（第二次可能因 revision 冲突报错但不会破坏已完成部分）。发现第 1、2 条。
- **不合规范或不可信输入**：`proactiveReviewCheckupCommandSchema` 校验了 `action` 枚举和 `merge ⇔ keep != null`（`contracts-v2.ts:609-620`）；`MemoryCheckupService.act` 再校验 `keep` 必须属于这一对（`memory-checkup.ts:250-252`），`recordAction` 校验 action 和时间（`sqlite...:187-189`）。未发现越权写。长度口径问题见第 5 条。
- **安全**：`execute` 顶部强制 `actorType === "owner"` 且 scope 相等（`production-proactive.ts:440-448`）；记忆文本经 `readMemory` 对不可见等级返回 `hidden`，`daily-review` 只在 `!hidden` 时输出文本（`daily-review.ts:379-401`）；体检行的读写都带 owner/agent 条件。未发现跨租户或泄露隐藏文本的路径。
- **资源耗尽**：周清单只在“本周还没有行”时全量扫 active；空清单用 `#emptyWeek` 缓存，避免每次读都扫（`memory-checkup.ts:169-200`）。`createWeek` 上限是 `reviewCapacity`（配置上限 3600）。唯一缺口是 `recordUndo` 没有磁盘余量检查（第 6 条）。
- **不可撤销操作**：删除/归档都是软状态且有 undo；真正的问题是异常/崩溃窗口里“部分破坏已发生但接口报错”或“行显示已处理”（第 2 条）。
- **规则/文档与代码一致**：`service-main.ts:1589` 的 `pairs: async () => []` 与 ADR 0218 第 63 行“P3-8 合并之前矛盾对来源为空”一致，**不是缺陷**；ADR 第 53-56 行与 `MemoryCheckupService` 的顺序/跳过逻辑基本一致，但漏了第 1 条的重试缺口。ADR 第 79-82 行把未提交的测试写成门槛，见第 3 条。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 没有触碰任何 prompt 组装、系统提示、工具定义或历史消息；体检只经 `proactive.review.*` 网关快照和网页展示（`production-proactive.ts:336-361`），`readDailyReview` 也不在模型请求路径上。按规则，仍然只在末尾追加，每轮会变的值不会进入系统提示/工具定义（`.claude/rules/prompt-prefix.md` 第 28、33-36 行）。记忆属性变化只会影响后续轮的记忆内容，本次未改其注入位置。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   模型输入没有新增这类来源。体检快照确实会随处理动作和 `generatedAt` 变化，但那是网页快照，不是模型请求；`handledEarlier` 用 `listWeek` 的 `ORDER BY rowid` 顺序追加（`sqlite...:109-118`），同一 DB 状态下是确定的。唯一相关的新问题是 `relatedText` 的裁剪/契约长度口径不一致（第 5 条），那是“可能被拒绝”，不是“同一段内容遮成不同字节”。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   只有外围检查：`daily-review.unit.test.ts` 的 `[P4-6]`（其中“yesterday 仍显示”会在旧代码失败，`[negative]` 在旧代码也通过，不是有效反向用例）、三条网关契约拒绝用例（旧代码因命令不存在也会失败）、网页单元测试。核心的占行/退回/撤销重试用例完全没有提交（第 3 条），作者提到的 16 条集成测试不在仓库，无法核实“三条会失败”。

4. **改动产生或修改的每个值，每个使用方都能接受吗？**
   逐个核对：
   - 行动枚举 `confirm/delete/merge`：应用端口、SQLite `ACTIONS`、网关 `MEMORY_CHECKUP_ACTIONS`、网页按钮一致。
   - 原因枚举四类：应用端口、SQLite `REASONS`、网关 `MEMORY_CHECKUP_REASONS`、i18n reason 键一致。
   - `reviewKey("checkup", id)`：`KEY_PREFIXES`、`parseReviewKey`、网关 `source: "checkup"`、`reviewKey` 清理逻辑一致。
   - `memoryUnusedDays`：严格配置 7..3650、`ProactiveConfiguration`、快照 `integer(1)`、网页标签都能接受；`startup-configuration` 与 `proactive-production` 夹具已补。
   - `PRODUCTION_PROACTIVE_OPERATIONS` 已包含 `proactive.review.checkup`，网页已安装清单也补了。
   - `before_state`：JSON 由同一进程写读，键顺序固定。
   - `sourceRefs` 过滤 `<= MEMORY_SOURCE_REF_MAX_LENGTH` 与记忆页、`boundString` 上限一致。
   - 不一致项：`text`/`relatedText` 的码点裁剪 vs 契约 UTF-16 上限（第 5 条）；`undone_at` 在重新处理时残留（第 8 条）。其余未发现产生端/消费端校验不匹配。
