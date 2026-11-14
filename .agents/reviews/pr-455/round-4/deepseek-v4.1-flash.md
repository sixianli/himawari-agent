本轮范围：核对了第 3 轮后的三个 PR 提交 `2c86f90aa`、`92a330138`、`7756764a9`，以及合入 main 的合并提交 `b3f2f0049`／`b93bbe3e6` 中落在本 PR 文件上的结果；重点读了主动检查存储、迁移与契约测试、来源 API、控制中心清除入口、观测判读和网关清单。main 自己带进来的大块改动没有逐行复核（未核实其内部实现），只核对了本 PR 是否与它们对接得上。

**侧重检查**

- 不可信输入：`recordProactiveProgramEntry` 现在先判断非对象，再校验 `entryId`／`summary`／`reason` 长度、`result`／`priority` 枚举、链接协议和时间格式（`proactive-source-runtime.ts:155-176`）；来源名在存储层由登记表校验（`sqlite-proactive-operations.ts:258-262`），数据库侧也改成名字格式检查。结论：本轮没有发现新的注入或越权路径。
- 安全：程序条目的链接现在只接受空串或 https（`proactive-source-runtime.ts:133-141`），且控制中心把它渲染成 `<a href>`（`proactive-reminders.tsx:168-169`），挡住 `javascript:`／`data:`；迁移把 `source`／`scenario`／`mail_source` 从 `IN ('gmail')` 放宽为格式检查，范围仍限制为 `[a-z][a-z0-9_]{0,63}`。结论：来源名和链接两端的校验一致。
- 不可撤销操作：清除和断开现在只删点名来源的提醒、已处理条目、降频、判断记录和模型输入输出，并在测试里核对另一来源不变。UI 文案仍有问题（见意见 3）。
- 资源耗尽：降频状态仍受 `ignored_count <= 1000`、`LIMIT 500`、`perDay`／`perCheck` 上限约束；清除在单个事务里执行；程序条目入口仍检查每日上限。未发现新增的无界循环或写放大。
- 规则／文档与代码一致：迁移 `.meta.json` 的 6 张表与 `removes: ["gmail"]` 和迁移内容相符；`schema-catalog.ts` 已改成“按来源清除”；但观测运行手册仍把 `proactive_records_cleared` 写成 Gmail 专有（见意见 2）。

**上一轮 4 条低意见的核对**

- 链接：已改为 `httpsLinkOrEmpty`，`javascript:`／`data:`／`http:`／非链接都返回 `entry_invalid`，空串和 https 可记录；测试覆盖（`proactive-sources.test.ts:761-780`）。
- 一直不答复：`sink.receive` 改为 `void Promise.resolve().then(...)`，不再 `await`，测试把 `perCheckMs` 调到 `600_000`（`proactive-sources.test.ts:564`），反向用例能证明不阻塞。
- 预检后上限被调低：存储层 `record` 在事务里重新读 `listSourceSettings` 并重新计算当日用量（`sqlite-proactive-operations.ts:952-961`），测试用 `loweredMidway` 把上限从 50 改到 2 后期望 `daily_limit`（`proactive-sources.test.ts:782-798`）。
- 非对象输入：`typeof entry !== "object" || entry === null` 先返回 `entry_invalid`（`proactive-source-runtime.ts:155-156`），测试覆盖 `null`。

### 1 低 — 按来源的降频状态在总览和恢复操作里没有带上来源

文件:行：`packages/persistence-sqlite/src/proactive-push-backoff.ts:194-226`；`packages/application/src/services/proactive-overview.ts:302-313`

问题：降频表新增 `source` 后，同一个 `class_key` 可以同时属于多个来源，但 `listBackoff` 不返回 `source`，`restoreBackoff` 的 WHERE 也不带来源。

证据（读代码证实）：

```ts
// proactive-push-backoff.ts:201-206
SELECT class_key AS classKey, stage, since_at AS sinceAt, last_push_at AS lastPushAt,
  ...
FROM proactive_push_backoff
WHERE owner_id = ? AND agent_id = ?
ORDER BY class_key, source LIMIT 500

// proactive-push-backoff.ts:222-224
UPDATE proactive_push_backoff SET stage = 0, ...
WHERE owner_id = ? AND agent_id = ? AND stage > 0 AND (? IS NULL OR class_key = ?)
```

而 `readProactiveOverview` 只传 owner/agent：

```ts
// proactive-overview.ts:302-304
backoff: Object.freeze(
  (await store.listBackoff(scope))
    .filter(({ stage }) => stage > 0)
```

推测（基于以上代码）：一旦有第二个来源产生同 `class_key` 的降频，Gmail 总览会把另一来源的条目当成 Gmail 条目显示（`proactive-reminders.tsx:291-306` 还用 `entry.classKey` 做 key，会重复），点“恢复”会把这个 class 在所有来源上的 stage 都清零。生产目前只登记了 Gmail，所以暂时不显形；但本 PR 的目标正是支持多来源。

建议：给 `ProactiveBackoffClass` 和 select 加上 `source`，`readProactiveOverview` 按 `options.source` 过滤；`restoreBackoff` 也带来源，或明确保留“恢复全部”并在契约和 UI 里说清楚。

### 2 低 — 清除事件带 source，但观测检查忽略 source，非 Gmail 清除会被当成 Gmail 记录已清

文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:771-777`；`packages/application/src/services/ledger-observation.ts:200-208、296-299`

问题：`clearRecords` 现在写入 `{ source, rows }`，但 `proactive_writing` 观测项仍把任何 `proactive_records_cleared` 都当成“Gmail 记录已清”。

证据（读代码证实）：

```ts
// sqlite-proactive-operations.ts:771-776
if (cleared > 0)
  insertObservationEvent(this.database, {
    ownerId: input.ownerId,
    agentId: input.agentId,
    kind: "proactive_records_cleared",
    detail: { source, rows: cleared },
  });
```

```ts
// ledger-observation.ts:200-208
const clearedAt = facts.events
  .filter(
    (event) => event.kind === "proactive_records_cleared" && event.occurredAt >= window.start,
  )
  ...
  return item("proactive_writing", "pass", "records_cleared", { clearedAt });
```

`rows_kept` 也按事件的 `rows` 抵扣丢失的 proactive 行，不看 `detail.source`（`ledger-observation.ts:296-299`）。运行手册仍写“清除过 Gmail 记录”（`docs/runbooks/decision-record-observation-runbook.md:159`）。

推测：清除 `test_notes` 等非 Gmail 来源时，Gmail 观测会误判为 `records_cleared` 通过，`rows_kept` 还会用非 Gmail 的 `rows` 去解释 Gmail 记录减少，掩盖真实缺口。生产现在只有 Gmail，暂不触发。

建议：观测侧按 `event.detail.source === "gmail"` 过滤（或把观测项按来源参数化），并同步改运行手册。

### 3 低 — 控制中心“全部删除”文案与按来源清除的行为不一致

文件:行：`apps/control-center/src/proactive.ts:255-257`；`apps/control-center/src/i18n/resources/zh-CN.ts:1244-1247`；`apps/control-center/src/i18n/resources/en.ts:1327-1330`

问题：后端现在只清点名来源，控制中心仍把动作说成“所有”。

证据（读代码证实）：

```ts
// apps/control-center/src/proactive.ts:255-257
disconnect: () => send("proactive.source.manage", { source: "gmail", action: "disconnect" }),
clearRecords: () =>
  send("proactive.source.manage", { source: "gmail", action: "clear_records" }),
```

```ts
// zh-CN.ts:1244-1247
"proactive.data.delete": "全部删除",
"proactive.data.confirm":
  "会删掉所有提醒检查记录、邮件提炼结果和你对没提醒的邮件做过的评价，Gmail 仍保持连接。确定删除？",
"proactive.data.cleared": "已全部删除。",
```

推测：用户会以为其他来源也被清掉；反过来也无法从网页清除非 Gmail 来源。当前生产只有 Gmail，影响有限。

建议：文案改成“删除 Gmail 的提醒记录”，或按来源提供删除入口；确认文案写明只删点名来源。

**作者说法的核对**

- 说法 1（迁移 9 张表、`.meta.json` 6 张表和 `removes: ["gmail"]`）：读代码证实迁移确实重建 8 张 `*_keep` 表加 `proactive_connections`，共 9 张；`meta.json` 列出 `decision_ledger`、`decision_prereviews`、`proactive_connections`、`proactive_processed_messages`、`proactive_push_backoff`、`source_insights` 和 `removes: ["gmail"]`。`check:migration-conflicts` 是否实际通过未运行（未核实）。
- 说法 2（迁移契约测试从 `decision_ledger_outcomes` 读每对种类和结果值）：读代码证实 `insertEveryAcceptedOutcome` 从 `decision_ledger_outcomes` 读，迁移后逐行核对，并另测 `memory_review/flagged`、`rule_review/cleared`、`rule_review/owner_restored` 可写、`memory_review/owner_forgot` 被拒（`proactive-source-registry-migration.contract.test.ts:60-65、254-278`）。
- 说法 3（Gmail 判断请求逐字节相同）：只看到测试名和 golden 文件存在；没有运行测试，也未逐行重读 prompt 渲染（未核实）。
- 说法 4（先 `reviewRules` 再按来源 `#runSources`，关掉的来源跳过）：读代码证实 `tick()` 先 `await this.reviewRules()` 再 `await this.#runSources()`（`production-proactive.ts:389-404`），`#runSources` 用 `listSourceSettings` 的 `enabled` 过滤（`:406-414`）。
- 说法 5（分支把 `references` 加进 `ProactiveMailReader.related`）：读代码证实最终 `ProactiveMailReader.related` 有 `references`，Gmail 读取器和演示邮箱都转发（`proactive-checks.ts:505-515`、`gmail-source.ts:252-273`、`demo-mailbox.ts:88-100`）。该字段在 main 的 T3 改动中也出现，谁先加未进一步考证（未核实）。
- 说法 6（三个新操作登记进客户端能力表，Swift 清单重新生成）：读代码证实 `CLIENT_CAPABILITY_TABLE` 有 `query("v2","proactive.sources.read")`、`change("v2","proactive.source.settings.set")`、`tighten("v2","proactive.source.switch_off")`，Swift 清单三行一致。
- 说法 7（清一个来源或断开一个来源不影响另一个）：读代码证实测试 `clearing the records of one source, or disconnecting it, leaves the other source alone` 覆盖 insights／processed／backoff／decisions／connections／pushes；`clearRecords`、`removeSource` 的 SQL 都带 `source = ?`（`sqlite-proactive-operations.ts:671-780`）。

**必答问题**

1. 会不会改变模型已经见过的请求开头？本增量本身不涉及：三个 PR 提交只改程序条目校验、观测交接、降频来源列和迁移，不碰系统提示、工具定义、历史消息或遮盖结果；程序条目入口不调用模型。合并 main 带来的提示词变化（单号抽取、涉钱地板）属于 main 的改动，本轮没有逐行重读其渲染（未核实）。就本 PR 的增量而言，没有新增“发给模型的内容不是只在末尾追加”的路径。依据的只追加规则本轮没有发现违反。

2. 会不会让同一段文字在不同请求里变成不同的字节？本增量不涉及：没有改遮盖逻辑，也没有把时间字段或无序列集插入提示词。新增的 `source`、`rows`、`resetsAt`、降频来源等值只进入数据库、快照或观测事件，不进入模型请求。合并 main 的引用抽取请求是否稳定，属于 main 的改动，未在本轮核实。

3. 有没有对应的自动检查，反向用例会不会真的失败？有：链接协议、非对象条目、不答复不阻塞、预检后调低上限、按来源清除、迁移保留所有种类结果、迁移后拒绝不存在的结果值，都有测试，并纳入 `check:proactive-sources` 的必过名单。反向性方面，作者声称做过反向验证；我读到的用例本身能区分行为（例如把 `perCheckMs` 设为 600 秒、把上限从 50 调到 2、用 `javascript:`／`http:` 链接）。本轮没有运行测试，所以“这些用例在当前提交上真的通过”未核实。上面意见 1、2、3 没有对应的自动检查。

4. 每个新值的使用端都能接受吗？逐点核对如下：
   - `clearRecords` 新增必填 `source`：生产调用、测试调用、乐观锁适配器都传了来源；控制中心走 `proactive.source.manage` 并传 `gmail`。可接受。
   - `previewBackoff`、`applyBackoffWrites`、`countIgnoredPushes` 新增 `source`：调用端分别传 `reader.source`、`decision.scenario`；`validateDecision` 会先把 `scenario` 校验为已登记来源。可接受。
   - `proactive_push_backoff.source`：迁移回填 `gmail`，读写 SQL 都带来源，唯一键和 CHECK 与代码一致；`listBackoff`／`restoreBackoff` 不消费该值，是意见 1 的缺口。
   - `proactive_source_settings`：迁移建表列名 `enabled/per_day/per_check` 与读写 SQL 一致；schema catalog 已写明不导出。
   - `decision_ledger` 的种类／结果改为参照表加触发器：迁移定义与 main 的参照表迁移一致（读代码对照了 `decision_ledger_known_kind_insert/update` 与新建表定义），迁移测试也从 `decision_ledger_outcomes` 反查，未发现本 PR 代码写死旧枚举的地方。
   - 三个新网关操作：契约 schema、能力表、Swift 清单、生产操作清单、`operations-pending.json` 都存在；`proactiveSourcesSnapshotSchema` 的 `source` 用 `proactiveSourceName`，与数据库名格式一致。
   - `proactive_records_cleared` 事件的 `source`：写入端加了，读取端没加，是意见 2 的缺口。

未核实项：没有运行 `npm run check`、`npm run check:migration-conflicts`、`check:proactive-sources` 或相关测试；没有逐行复核 main 自己带来的提示词、邮件单号抽取、涉钱规则和网关大改内部实现。
