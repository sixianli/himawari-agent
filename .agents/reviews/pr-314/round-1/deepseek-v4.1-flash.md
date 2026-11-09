# PR 314 复核报告

先说明：我**没有运行测试**（工具限制），下列「已证实」均来自实际读到的代码；作者声称测试通过一事未核实。仓库为 sparse checkout，个别未列出的文件可能不存在，已标「未核实」。

## 一、读代码证实的（按严重度）

### 中-1 案例编号并不稳定：重新给 Muse 条目打分后同一案例会换 id
- 文件:行：`apps/agent-service/src/production-gap-cases.ts:34-35`、`apps/agent-service/src/production-muse-intake-control.ts:153-160`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:488-512`
- 问题：`gapCaseId` 把 `entryId` 纳入哈希；但每次 `muse.item.rate` 都先生成新的 `entryId = this.#ids.next("muse-reference-entry")`，再在事务里 `DELETE` 旧行、`INSERT` 新行。也就是说，只要 Andy 事后改了某条 Muse 的时机/内容评价，同一个 Gmail 邮件对应的 `gap_...` 编号就变了。
- 与说法冲突：ADR 0187 第 4 条写“同一案例跨周、跨次生成不变”。跨周确实不变，但“重新评价后不变”不成立。
- 后果：已加入 Backlog 的旧标记仍在 `gap_case_marks`/导出里（旧 id），周报里同一条案例变成未标记的新 id，用户再点一次会生成第二条 Backlog，且无法通过旧行取消新案例。
- 建议：用稳定的 intake key（`kind:naturalKey`）或 `pairedMessageId + museAt` 生成编号；或把 `muse.item.rate` 改成 `UPDATE` 保留 entry id。另加“改评分后编号不变”的反向测试。

### 中-2 「清除 Muse 数据」不会清掉已标记案例快照里的 Muse 文字
- 文件:行：`apps/agent-service/src/production-observation.ts:326-329`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:517-536`、`apps/control-center/src/i18n/resources/zh-CN.ts:1059-1061`
- 问题：标记时 `#markGapCase` 把整个 `GapCaseSnapshot`（含 `museTitle`、`museText`、`himawariReason`）seal 成新 payload。`muse.data.clear` 只删除 `muse_intake_items`、`muse_reference_entries` 并释放 intake 的 title/text ref，不碰 `gap_case_marks` 及其快照。界面文案承诺“删除自动收到的 Muse 条目和你对它们的评价”。
- 后果：Andy 执行清除后，已标记案例的 Muse 文字仍留在快照里，并继续从导出接口返回。属于数据保留/隐私预期不一致（也可能是有意的“已标记案例保留到取消”，但文档没写这一例外）。
- 建议：在 `clearAll` 时一并取消标记并释放快照，或在 ADR/界面明确“已加入 Backlog 的案例不会被清除”，并给出单独删除入口。需要产品确认。

### 中-3 同一封 Gmail 邮件可能生成多条重复案例，差距线却按邮件去重
- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:499-509`、`apps/agent-service/src/production-gap-cases.ts:43-53`、`packages/calibration/src/index.ts:311-323`
- 问题：`readGapCandidates` 以 `muse_reference_entries` 每条为单位返回候选，没有按 `paired_message_id` 去重；`buildGapCases` 也只过滤后切片。`muse_reference_entries` 的唯一约束只是 `intake_item_key`（`0069_decision_ledger.sql:151-153`），同一邮件允许多条 Muse 条目。另一方面 `summarizeGap` 用 `pairEntriesByMail` 按邮件只算一次。
- 后果：同一封邮件在“案例清单”出现多次（不同 id），在差距线里只算一封；用户可能重复加入 Backlog。
- 建议：在 `readGapCandidates` 或 `buildGapCases` 按 `pairedMessageId` 去重（保留一条，规则与 `pairEntriesByMail` 一致），并加“同邮件多条目只出一个案例”的测试。

## 二、读代码证实的（低）

### 低-1 导出 Backlog 的 origin 周范围多算一天
- 文件:行：`apps/agent-service/src/production-gap-export.ts:35-36、59`；`packages/calibration/src/index.ts:249-255`
- 问题：`resolveWindow` 的 `end` 是**排他**边界，报告人类可读区间用 `jstDate(endMs - 1)`；`gapBacklogPrefill` 却直接 `jstDay(snapshot.weekEnd)`，把结束日印成结束边界当天。
- 例：窗口实际是 JST 10-27 至 11-02，`origin` 会写成“10-27 至 11-03”。
- 建议：`origin` 用 `jstDay(Date.parse(snapshot.weekEnd) - 1)`，或快照里另存 `weekEndDate`。

### 低-2 导出路由缺少错误处理，单条坏快照会让整个导出 500
- 文件:行：`apps/agent-service/src/production-gap-export.ts:131-152` 对比 `apps/agent-service/src/production-muse-intake.ts:520-532`
- 问题：`export()` 里直接 `JSON.parse(text)`，没有校验，也没有像 Muse intake 那样 `scope.setErrorHandler`。快照损坏/旧格式时 `JSON.parse` 抛错，Fastify 默认 500；解析错误信息可能带出载荷片段，且 500 响应没有显式 `cache-control: no-store`。一条坏标记阻塞全部案例导出。
- 建议：给导出插件加与 Muse intake 同样的错误处理器；对单条快照 catch 后跳过并记日志，不阻断其它案例。

### 低-3 `clean` 按 Unicode 码点截断，合约却按 UTF-16 长度校验
- 文件:行：`apps/agent-service/src/production-gap-cases.ts:30-31`；`packages/gateway-contracts/src/validation.ts` 中 `boundedString`
- 问题：`clean` 用 `[...text].slice(0, limit)`（码点），`boundedString` 用 `input.length > maximum`（UTF-16 码元）。含 emoji 的 Muse 标题 160 个 emoji 就会被截成 160 码点、但 `.length`=320，超过 `proactiveTextSchema(300)`，导致整份周报快照 `parse` 失败。
- 说明：`production-muse-intake-control.ts:30-32` 已有同样写法，属于继承的既有隐患；但本 PR 新路径再次引入。
- 建议：按码元截断（`...[].slice` 之后再做 `text.slice(0, limit)` 保护），或统一合约按码点计数。

### 低-4 UI 没有显示每侧 Wilson 区间，只有差值区间
- 文件:行：`apps/control-center/src/components/weekly-report.tsx` 新增 `weekly.gap.rates` 渲染处；ADR 0187 第 1 条
- 问题：`line.muse`/`line.himawari` 的 `low/high` 已在快照里，但 UI 只用 `.value`，每侧 Wilson 区间只出现在 Markdown 报告里。ADR 写“每个比例带 95% Wilson 区间”，界面没有。
- 建议：要么在 UI 显示每侧区间，要么把 ADR/作者说法改成“差值带区间”。

### 低-5 归因的 relatedRead/memoryRecall 是“一次检查”级，不是“每封邮件”级
- 文件:行：`packages/application/src/ports/proactive-checks.ts:212-215`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:532-535`
- 问题：`memoryByMail`/`relatedByMail` 是按邮件，但 `memoryRecall`/`relatedRead` 是整次 proactive 检查的字段。`attributeGap` 用后者判定每封邮件的“没读全/没取到”，一次检查里多封邮件会得到同一归因。界面 `weekly.cases.note` 却写“按这封邮件当时的读取记录判定”。
- 建议：改为按邮件取读取记录，或把文案改成“按这次检查的读取记录判定”。

### 低-6 测试的实际覆盖有缺口
- 文件:行：`apps/control-center/test/weekly-report.unit.test.ts` 新增 `[PA-4] [negative] shows no cases...`；`test/integration/gap-cases.test.ts`
- 问题：
  - 该“nothing qualifies”反例设置的是 `complete: true, gap: null`，断言“本周尚未结束”，实际走的是 `gap === null` 分支，**没有覆盖 `weekly.gap.empty`（两条线 mails=0）分支**。
  - 没有测试“重新打分后案例 id 不变”“同一邮件多条 Muse 条目不重复出案例”。
  - 导出只测了 401，没有测 429/限流；也没有测 `GAP_MARKS_UNAVAILABLE`（无 seal 时标记被拒）。
  - 作者自认“真实网页验收尚未做”；按 `.claude/rules/owner-standing-rules.md:34`，判断类功能的真实网页正向/反向验收还没完成。现有 `weekly-report.unit.test.ts` 是 jsdom，不是真实浏览器。
- 建议：补上述用例；真实网页补一次“标记→刷新显示已标记→取消”的正反验收。

### 低-7 unmark 先删行再释放快照，失败会留下孤儿 payload
- 文件:行：`apps/agent-service/src/production-observation.ts:317-320`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:461-477`
- 问题：`unmark` 事务删除行并返回 ref，随后 `seal.release` 才删 payload。若 release 抛错，行已删但 payload 残留；命令返回失败，用户重试时 `unmark` 返回 null，不再释放，孤儿 payload 永久留下。
- 建议：先确认/标记，再释放，或把 payload 删除纳入可重试清理任务。

## 三、推测（未证实，需统计/产品确认）

### 推测-1 配对差区间的 phi 修正不对称
- 文件:行：`packages/calibration/src/index.ts:424-427`
- 证据：`const corrected = e > n / 2 ? e - n / 2 : e >= 0 ? 0 : e;`
- 说明：正相关时对 `e` 做 `-n/2` 截断，负相关时不做；阈值 `n/2` 也看不出与 Newcombe 方法 10 的对应关系。若 `a=d` 完全一致时原始 phi=1、区间会退化为 0 宽，做修正是合理的；但“只在 `e>n/2` 修正”会造成同一强度的正/负关联得到不同宽度，可能影响 `decided` 判定。建议对照 Newcombe 1998 原文或换用成熟实现，并补边界用例。
- 我未拿到原论文，无法确认这是有意为之。

## 四、侧重检查

- 错误路径：标记不存在的案例由 `#markGapCase` 的 `GAP_CASE_NOT_FOUND` 拒绝（已证实）；取消不存在的案例返回 `replayed: true`，无副作用（已证实）；导出无/错令牌 401，限流 429（已证实）；坏快照未隔离（低-2）。
- 不可信输入：`caseId`/`endDay` 由 gateway 合约校验；`endDay` 只校验“真实日期”，没有范围限制。认证 owner 可传任意合法日期，触发 `readGapCandidates` + 最多 50 次 `seal.open`，命令路径没有单独限流（资源放大，低风险）。`unmark` 对任意 `caseId` 只做 SELECT，无副作用（已证实）。
- 安全：`BearerGate` 用 sha256 + `timingSafeEqual`；导出令牌用途单独为 `gap-export`，配置层拒绝指向 `muse-intake` 的引用（已证实）。导出只响应预填字段，`museText` 本身不导出，且预填文字经 `redactForEgress`（已证实）。残留风险见中-2（清除数据后快照仍在）和低-2（500 可能带解析信息）。
- 资源耗尽：`readGapCandidates` 无 LIMIT，按周返回全部候选；周报快照每次查询都会 `Promise.all` 打开最多 50 个 payload；导出列出全部历史标记，无上限。当前规模下影响有限，但建议给候选/导出加硬上限。
- 不可撤销操作：标记是可撤销的；取消标记会删除快照，属不可恢复（但用户主动操作）。未发现会误删其它数据的路径。
- 规则/文档一致性：ADR 0187 与代码在路径、401、限流、独立令牌用途、标记/取消语义上基本一致；不一致处是“稳定编号”（中-1）、“每个比例带 Wilson 区间”（低-4）、“按这封邮件的读取记录”（低-5），以及 origin 周范围（低-1）。AGENTS/规则未要求本 PR 改提示词，第 1 条已确认未触及。

## 五、必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本 PR 没有修改任何 prompt 组装：`git diff --stat` 不涉及 `packages/prompt-catalog`、`packages/runtime-pi`、`packages/application/src/services/model-egress.ts` 或 thread prompt 相关文件；新增的唯一发送文本路径是周报 UI、Markdown 报告和 `GET /api/gap-cases/v1/export`，都不是模型请求。因此“发给模型的内容只在末尾追加”“每轮变化的值只在最后一条消息”这两点没有被破坏——它们没有被动过。ADR 0187 第 8 条的说法与代码一致。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**模型请求层面无新增文字，不存在这个问题。** 新增的输出里，`gapCaseId` 对固定的 `entryId + pairedMessageId` 是确定性的（sha256）；导出的案例顺序由 `list` 的 `ORDER BY marked_at, case_id` 固定；周报案例顺序由 `ORDER BY e.muse_at, e.id` 加 `Promise.all` 的保序固定；标记集合只用于成员判断，不参与输出排序。**唯一的时间性变化**是：重新给 Muse 打分会换 `entryId`，从而换案例 id（中-1），这不是“同一请求内不同字节”，而是同一案例在不同时间点换了标识。

### 3. 有没有对应自动检查，反向用例真的会失败吗？
有：`packages/calibration/test/gap-lines.unit.test.ts`、`apps/control-center/test/weekly-report.unit.test.ts`、`test/integration/gap-cases.test.ts`、`packages/platform-node/test/startup-configuration.unit.test.ts`、三处迁移契约测试。
- 会失败的反例：样本不足不下结论、区间跨 0 不下结论、无/错令牌 401、标记不存在案例被拒、导出密码被遮盖、命令行报告不出现“追平/落后”、配置指向 Muse 令牌/不存在引用被拒——这些断言与实现一一对应，破坏实现应当失败（已读测试源码确认）。
- **不够强的反例**：`[PA-4] [negative] shows no cases and no verdict when nothing qualifies` 实际用 `gap: null` 测“本周尚未结束”，没有覆盖 `weekly.gap.empty`；没有重新打分 id 稳定性、同邮件去重、429、无 seal 标记等用例（低-6）。真实网页正反验收尚未做（作者已承认）。

### 4. 每个新值的产生处和使用处两端校验
已逐个核对：
- `gapCaseId`（`production-gap-cases.ts:34-35`）：产出 `gap_` + 20 hex = 24 字符；使用处包括迁移 CHECK（`0082_gap_case_marks.sql:4`，`GLOB 'gap_*' AND length=24`）、gateway `machineString`（允许 `_`）、UI `data-case-id`、`#markGapCase` 的 `.find`、导出 `id`——**两端都接受**。
- `proactive.gapcase.mark`：已加入 `GATEWAY_V2_MESSAGE_TYPES`（`contracts-v2.ts:52`）、`schemasByType`（`:2357`）、`PRODUCTION_OBSERVATION_OPERATIONS`（`production-observation.ts:43`）、审批路由（`production-approval-gateway.ts:219-220`）、UI 发送（`proactive.ts:171-179`）——**链路完整**。
- `endDay`：合约 `jstDaySchema`（`contracts-v2.ts:939`）与 `resolveWindow({end})` 的 `jstDayStart` 语义一致；UI 传 `report.endDay` 能复现同一窗口（已核对 `resolveWindow` 与 `observation.query` 的 `window.endDate`）。
- `gapExportSecretRef`：`parseMuseIntake` 接受并 `assertIdentitySecretReference(..., GAP_EXPORT_SECRET_PURPOSE)`（`strict-configuration.ts:1064-1075、1421-1426`），`service-main.ts:1688-1711` 按 ref+purpose 查找并构造——**两端一致**。
- `snapshotRef`：`seal.seal` 写入 `payloads`（主键 `ref`），迁移外键 `REFERENCES payloads(ref)`（`0001...:58`）——**合法**。
- `marked_at`：时钟返回 canonical ISO，迁移 CHECK 格式匹配——**合法**（CHECK 用 GLOB，约束偏宽松但不影响写入）。
- `gap`/`gapCases` 快照：字段名、枚举、nullable、整数范围与 `proactiveWeeklySnapshotSchema`（`contracts-v2.ts:870-930`）逐项对应；**唯一例外**是标题/正文含大量 emoji 时 `clean` 的码点截断可能超过合约的 UTF-16 长度（低-3）。
- `attribution`：`GAP_ATTRIBUTIONS`、`GAP_ATTRIBUTION_LABELS`、gateway enum、`GAP_ATTRIBUTION_TEXT` 四处一致——**一致**。

唯一一处「两端校验不完全对齐」是低-3（`clean` 码点截断 vs `boundedString` 码元长度），其余已核实通过。

## 六、未核实
- 测试是否实际全绿（未运行）。
- 真实浏览器/生产环境上的正向、反向验收。
- 仓库外的“每周定时开发会话”如何使用导出 JSON、是否接受 `week.end` 的排他语义。
- Cloudflare Access `gap-export` 服务令牌的实际配置（不在仓库内）。
