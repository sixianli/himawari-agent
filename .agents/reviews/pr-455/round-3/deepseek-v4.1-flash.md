## 读代码证实的问题（按严重度）

### 1. 【中】`proactive.source.manage` 的 `clear_records` 校验了 `source`，但实际把该 owner/agent 的所有来源记录都删掉

- 文件：`apps/agent-service/src/production-proactive.ts:938-948`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:716-742`
- 证据：
  ```ts
  // production-proactive.ts:938-948
  case "proactive.source.manage": {
    const managed = this.#registry.get(command.payload.source);
    ...
    if (command.payload.action === "clear_records") {
      const released = await store.clearRecords(scope);
  ```
  ```ts
  // sqlite-proactive-operations.ts:716-727
  private clearRecords(scope: ProactiveScope): readonly string[] {
    ...
    for (const table of [
      "source_insights",
      "proactive_processed_messages",
      "proactive_pushes",
      "proactive_push_backoff",
    ])
      this.database
        .prepare(`DELETE FROM ${table} WHERE owner_id = ? AND agent_id = ?`)
  ```
- 问题：PR 把 `proactive.source.manage` 的 `source` 从只允许 `"gmail"` 放宽成任意已登记来源，但 `clear_records` 分支完全不使用 `managed.name`，仍然删除整个 owner/agent 的主动提醒数据，包括 `decision_ledger` 中所有 `kind='proactive'` 的行。注册第二个来源后，对 A 来源执行“清除记录”会不可逆地删掉 B 来源的提醒、已处理邮件、推送和决策记录。
- 同一处还有两个相关的 Gmail 专用分支：
  - `production-proactive.ts:950-959`：只有 `managed.name === GMAIL_SOURCE.name` 时才撤销 OAuth token。新增的 OAuth 来源断开时不会调用 `oauth.revoke`。
  - `sqlite-proactive-operations.ts:685-687`：`removeSource` 删除的是整个 owner/agent 的 `proactive_push_backoff`，断开一个来源会清掉其他来源的降频状态（这是原有实现，但多来源后副作用被放大）。
- 建议：让 `clearRecords` 接受 `source` 并按来源过滤（或另加 `clearSourceRecords`），给 `proactive.source.manage` 加“两个来源只清一个”的反向测试；`removeSource` 的 backoff 清理也需要按来源区分或明确记录为全局操作。当前生产只登记 `gmail`，所以这条现在不会触发，但一旦按设计注册第二个来源就是跨来源数据丢失。

### 2. 【中（潜在）】程序入口写入的 `link` 没有做 URL scheme 校验，网页直接把它当 `href`

- 文件：`packages/application/src/services/proactive-source-runtime.ts:156-163`、`apps/control-center/src/components/proactive-reminders.tsx:168-170`
- 证据：
  ```ts
  // proactive-source-runtime.ts:156-159
  typeof entry.reason !== "string" ||
  entry.reason.length > PROGRAM_ENTRY_TEXT_LIMIT ||
  typeof entry.link !== "string" ||
  entry.link.length > PROGRAM_ENTRY_TEXT_LIMIT ||
  ```
  ```tsx
  // proactive-reminders.tsx:168-170
  {insight.link ? (
    <a href={insight.link} target="_blank" rel="noopener noreferrer">
  ```
  对比 Gmail 路径的链接是代码写死的安全地址：`gmail-source.ts:215`。
- 问题：`recordProactiveProgramEntry` 接受任意 2000 字以内的字符串作为 `link`，存进加密内容后由 `readProactiveOverview` 原样映射到 `insight.link`（`proactive-overview.ts:167,183`），网页直接作为 `href`。如果未来日历/短信/屏幕等来源把外部内容带进 `link`，`javascript:`/`data:` 或钓鱼链接会进入主人界面。当前没有生产写入方，属于潜在风险。
- 建议：在 `recordProactiveProgramEntry` 里用 `new URL` 校验，只允许 `https:`（必要时 `http:`），否则返回 `entry_invalid`；补一条 `javascript:`/`data:` 的反向测试。也可以把链接构造收回到各来源定义里，而不是让调用方随意传。

### 3. 【低】观察结果的交接超时直接复用 `perCheckMs`，sink 一直不答复会把检查拖到最长约 3 分钟

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:1817-1824`
- 证据：
  ```ts
  await Promise.race([
    Promise.resolve().then(() => sink.receive(observations)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#options.limits.perCheckMs);
    }),
  ])
  ```
- 问题：作者说“同步抛错、异步拒绝、一直不答复，都不影响这次检查”。同步抛错和异步拒绝确实被吞掉；但“一直不答复”时 `run()` 仍会等到 `perCheckMs`（生产默认 180000ms，见 `packages/platform-node/src/strict-configuration.ts:1145`）才返回。决策已经落库，所以不算数据丢失，但 `ProductionProactive.tick()` 会在这里停住，后续来源和 prereview 都被推迟。测试用 `perCheckMs: 50` 掩盖了这个时长。
- 建议：给观察交接一个独立、较短的上限（或直接不 await、只记录失败），不要让一个可选 sink 占用整轮检查的时限；补一条断言不会接近默认 `perCheckMs` 的用例。

### 4. 【低】`proactive_source_settings` 标记“never exported”，与设计里“每个来源的设置”要导出不一致

- 文件：`packages/persistence-sqlite/src/schema-catalog.ts:946-952`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:630`
- 证据：
  ```ts
  entry(
    "proactive_source_settings",
    ...
    "one row per registered proactive source the owner has changed: ... never exported",
  ```
  设计文档同一节写的是：“导出：……上限和用量、每个来源的设置。”
- 问题：如果这里的“每个来源的设置”指的正是 `proactive_source_settings`，那么代码与设计相反；备份恢复后主人设置的 `perDay`/`perCheck` 会被静默重置为默认值。当前 `packages/persistence-sqlite/src/data-export/snapshot.ts` 确实没有导出这张表，也没有反向测试。
- 建议：确认设计的指代；若应当导出，就在 snapshot/schema/import 中补上并加“恢复后上限保留”的测试。若刻意不导出，就改设计和 schema-catalog 的措辞，明确恢复后使用默认上限。

### 5. 【低（检查缺口）】第 4 条“存储层在同一事务里读当前设置”没有能区分新旧实现的测试

- 文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:901-927`、`test/integration/proactive-sources.test.ts:779-822`
- 证据：
  ```ts
  const perDay = this.listSourceSettings(input).find(
    ({ source }) => source === guard.source,
  )?.perDay;
  if (
    perDay !== undefined &&
    this.processedSince({ ...input, source: guard.source, since: guard.since }) +
      input.processed.length > perDay
  )
    return { ... refused: "daily_limit" as const };
  ```
  现有“two writers racing on one entry, or on the last slot of the day”测试在三次并发调用前就把 `perDay` 设成 2；旧实现也是在自己的事务内用调用方传入的 `perDay` 做同一计数，因此这个用例即使没有第 3 轮的改动也会通过。
- 问题：第 3 轮删掉了 `onlyIfNew.perDay`，改为存储层在事务里读当前设置，但没有任何测试证明“调用方预检期间设置变化后，存储层会以最新设置为准”，也没有测试证明调用方伪造一个很大的 `perDay` 会被忽略。反向用例覆盖不足。
- 建议：加一个测试，在 `recordProactiveProgramEntry` 读完设置后、`record` 提交前改写 `proactive_source_settings.perDay`（或用可控 store 包装），断言最终按新值拒绝；再加一个直接调用 `record`、在 `onlyIfNew` 里塞造 `perDay` 的用例，证明字段已不被信任。

### 6. 【低】`recordProactiveProgramEntry` 对 `entry` 本身没有对象检查，`dueAt`/`deliverAt` 也没有长度上限

- 文件：`packages/application/src/services/proactive-source-runtime.ts:138-163`
- 证据：
  ```ts
  const definition = (options.registry ?? PROACTIVE_SOURCES).get(entry.source);
  ...
  !isoTimeOrNull(entry.dueAt) ||
  !isoTimeOrNull(entry.deliverAt)
  ```
- 问题：如果运行时传入 `null`/`undefined`/非对象，`entry.source` 会先抛 `TypeError`，而不是按作者描述返回 `entry_invalid`。`dueAt`/`deliverAt` 在进入 `Date.parse` 前没有长度限制，未来若有外部来源把超长字符串带进来，会比其它文本字段多一条无上限的解析路径。
- 建议：在函数开头加 `typeof entry !== "object" || entry === null` 的守卫，并给 `dueAt`/`deliverAt` 加合理长度上限（例如 64）。

## 推测/未核实

- **两个来源登记表需要人工保持一致（I-73 类风险）**：应用侧 `PROACTIVE_SOURCES`（`packages/application/src/ports/proactive-sources.ts:176`）和持久层的 `registeredSqliteProactiveSources()`/`proactiveSources` 配置（`sqlite-proactive-operations.ts`、`product-state-repository.ts:133`）是两处独立输入；导入默认又用 `PROACTIVE_SOURCE_NAMES`（`data-export/import.ts:118`）。当前生产没有传自定义 registry，所以没出事；但以后只改一处会出现“应用认得、数据库不认”或“导出能写、导入拒绝”。建议在启动时断言两套来源集合一致，或从同一个 registry 派生。
- **设计/计划说第 7 批“接上日程、位置等新来源”，但代码里 `PROACTIVE_SOURCES` 仍只有 `gmail`**（`proactive-sources.ts:176`）。无法从当前工作区读到 `.agents/reviews/pr-455/briefs/...`（sparse checkout 没有这些文件），所以无法确认这是本 PR 的既定范围还是后续批次，标为未核实。
- **设计要求每个来源登记“提示词编号/读取器”**（`docs/execution/specs/2026-11-11-apple-device-body-design.md:426,438`），但 `ProactiveSourceDefinition` 没有 prompt 字段，reader 由 `ProductionProactive` 的 `runners` 单独提供；`check:proactive-sources` 也只校验固定测试名，并没有真正检查“每个来源都有提示词”。是否为后续批次待确认。
- **PR451 的内部提交未复核**（按指示）；只核对了它们与本 PR 的接口：新增的 `told` 结果值在应用类型、0095/0097 约束和决策链 schema 中都能接受；合并带来的工具结果文字改动只追加在工具结果层，没有改系统提示或工具定义。
- **未运行测试/检查**（只允许读文件和 git），所以“反向用例会失败”的结论来自阅读测试与旧实现，不是实际执行结果。

## 侧重检查

- **错误路径**：观察交接的同步抛错/异步拒绝/永不答复；`store.record` 失败时释放 `contentRef`；`writeSourceSettings` 设置与决策记录同事务回滚；`clear_records`/`disconnect` 的破坏性路径；未登记来源的拒绝。发现观察交接的长超时和 `clear_records` 跨来源删除。
- **不合规范/不可信输入**：来源名两侧正则一致；`dueAt`/`deliverAt` 的规范 ISO 校验；程序入口文本长度；`entry` 非对象未防；`link` 无 scheme 校验。发现链接风险和 `entry` 守卫缺失。
- **安全**：来源名 SQL 均为绑定参数或代码常量；新增 gateway 字段没有注入路径；OAuth 撤销仍写死 Gmail（潜在）；链接直接进 `href`（潜在）。
- **资源耗尽**：`PROACTIVE_ITEMS_PER_CHECK_MAXIMUM`/`MAX_INPUT_IDS` 把每次检查上限和输入 id 数限制在 500；`Date.parse` 前的 `dueAt`/`deliverAt` 无长度上限；观察交接占用 `perCheckMs`。合并进来的感知读取 `scanLimit`（PR451）看起来正确限制了扫描量。
- **不可撤销操作**：`clear_records`、`removeSource`；前者跨来源删除，已列为第 1 条。
- **规则/文档与代码一致**：`prompt-prefix` 规则下本 PR 没有改系统提示/工具定义；`proactive_source_settings` 的导出说明与设计不一致；设计里“每个来源的提示词/读取器”与当前类型/检查脚本不完全对应（未核实范围）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会（就 PR455 自身的改动而言）。主动提醒的判断请求是每次重新拼的：`MAIL_JUDGMENT.text` → 条目 → 末尾的 `now/timeZone/today`（`proactive-mail-check-service.ts:468-495`），会变的值都在最后。`[iOS-7] sends the model the same Gmail judging request, byte for byte, as before sources were registered`（`test/integration/proactive-production.test.ts:464-488`）用 golden 文件校验了整段 prompt 不变。合并进来的 PR451 只改了工具结果文字并新增一个工具结果提示词，工具结果是追加在对话末尾的，不会插到更早的消息、系统提示或工具定义里。因此“发给模型的内容仍然只在末尾追加、每轮变化的值在最后”成立。注意：主动提醒请求本身不是对话历史复用，这里说的是它的固定前缀稳定。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

没有发现模型可见文本会因这次改动而变成不同字节。来源登记表是冻结数组，`sources` 快照按 `registry.definitions` 固定顺序生成（`production-proactive.ts:622-646`）；prompt 里没有把来源集合、时钟等插到前面。新增的 `proactive.sources.snapshot.payload.generatedAt`、`perDay.used`、`resetsAt` 确实每次不同，但它们是客户端读模型，不是模型输入；`decision.inputs.observations` 对同一次检查是确定的。遮盖逻辑没有改，现有的“遮盖不改 prompt”测试仍覆盖。潜在风险只在未来自定义来源：设计要求的“按发生时间+编号排序”需要各来源自己实现，当前机制不强制。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有：`check:proactive-sources` 已接入 `check:steps`，会在 `npm run check` 中运行，并列出必须通过的具体测试名。它覆盖了 perCheck 超过 500、非规范 `dueAt/deliverAt`、观察 sink 同步抛错/拒绝/不答复、未登记来源、daily limit 并发、缺少 reader runner、迁移 schema/行/触发器，以及 Gmail prompt golden。迁移契约测试会比较 0097 重建前后的每张表和 SQL；0097 少写 `told` 会失败，这点已核对属真。

但反向覆盖不完整：

- sink 的“异步拒绝”和“永不答复”在加 `Promise.resolve().then` 之前也已经会被 `.catch`/计时器接住，真正会因这次改动变红的是新增的“同步抛错”用例；另外两个用例不能独立证明第 3 轮的包装必要。
- 第 4 条 `onlyIfNew` 的改动没有能区分新旧实现的测试（见第 5 条）。
- 多来源下 `clear_records` 会误删其他来源，这个破坏性路径没有反向测试。
- 迁移契约测试只覆盖 `TABLES` 里的 9 张表；新增的 `proactive_source_settings` 不在比较范围内（它是新表，不是重建表，这点合理）。

**4. 每个产生/修改的值，所有使用方都能接受吗？**

逐项核对结果：

- **`PROACTIVE_ITEMS_PER_CHECK_MAXIMUM = 500`**：登记校验（`proactive-sources.ts:123-133`）、Gmail 的 perCheck 默认值和最大值（`:86-93`）、存储层 `MAX_INPUT_IDS`（`sqlite-proactive-operations.ts:63`）、`proactiveSourceLimitsValid`、gateway `integer(1)`、snapshot `maximum` 都能接受 500，两端一致。局限：如果绕过 `defineProactiveSources` 手工构造 registry，或持久层直接传入未校验的 `proactiveSources`，500 的上界不会被这些工厂之外的地方再次检查。
- **`dueAt`/`deliverAt` 规范 ISO**：生产方 `recordProactiveProgramEntry` 用 `Date.parse` + `toISOString` 相等校验；使用方 `record` 的 `time(insight.dueAt)`、`push.readyAt` 以及 `deliverAt > now` 的字符串比较都能接受规范 UTC 形式，且字符串比较因格式统一而安全。
- **`told`**：应用侧 `DECISION_OUTCOMES.proposal`（`decision-ledger.ts:65-77`）、0095/0097 的 `decision_ledger` CHECK、`consolidation-hold` 契约测试、决策链 snapshot 的 `boundedString(64)`、导出 schema 的 `text(1,64)` 都能接受。
- **来源名**：应用正则、gateway `proactiveSourceName`、导出 schema 的 pattern 完全一致；数据库 GLOB 等价；导入时会用允许列表再校验一次。当前 `gmail` 两端一致；自定义来源需要同时在应用 registry、持久层 sources、导入允许列表三处出现（见“推测/未核实”第 1 条）。
- **新增 gateway 操作名**：`proactive.sources.read`、`proactive.source.settings.set`、`proactive.source.switch_off` 在 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_PROACTIVE_OPERATIONS` 和 `ci/operations-pending.json` 中对得上；`proactive.sources.snapshot` 是响应类型，不要求进 pending。
- **`observations.handedOff/sink`**：应用侧产生，sqlite `validateInputs` 校验（`handedOff` 为 0..500、`sink` 只能是 `not_connected`/`port`），数据库存 JSON，测试读取；两端一致。
- **`clear_records` 的 `source`**：gateway 会产生并校验，但后端消费时忽略，正是第 1 条的问题；这是本轮 Q4 最明显的“一个值只在一端认”。
