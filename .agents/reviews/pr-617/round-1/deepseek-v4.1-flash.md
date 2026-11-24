### 1. 高 — 旧有安静时段规则不会默认管住「她的话」，作者说法与生产写库路径不一致

文件:行：`packages/application/src/rules/rule-types.ts:54-59`、`:276-289`；`apps/agent-service/src/production-owner-rules.ts:857-861`；`test/integration/production-web-push.test.ts:284-313`、`:666-670`、`:833-845`

问题：作者说「安静时段规则默认受管类别加 her_words；已明写 classes 的旧规则不自动加」。但生产写规则时保存的是解析后的参数，`classes` 已经被默认值固化，因此旧规则的「删掉 classes 时用新默认」这条路根本不可能发生：所有旧规则都会被当成「明写了 classes」。

证据：
```ts
export const PUSH_QUIET_DEFAULT_CLASSES: readonly PushQuietClass[] = Object.freeze([
  "mail_reminder",
  "run_result",
  "her_words",
]);
...
let classes: readonly PushQuietClass[] = PUSH_QUIET_DEFAULT_CLASSES;
if (rawClasses !== undefined) {
  ...
  classes = Object.freeze(
    PUSH_QUIET_CLASSES.filter((candidate) => (rawClasses as unknown[]).includes(candidate)),
  );
}
```
```ts
parameters: { type: parsed.type, params: parsed.params, summary: parsed.summary },
```
基准提交里的旧默认是 `["mail_reminder", "run_result"]`（见 diff），所以旧规则库里存的 `classes` 已是不含 `her_words` 的显式数组；升级后重新解析时 `rawClasses !== undefined`，永远不会再走新默认。结果是旧用户夜里的「她的话」仍会响，和「默认管住它」的目标相反。

测试也没有覆盖生产写路径：`NIGHT_JST` 本身没有 `classes`，但测试的 `rules.write` 直接把原始 JSON 写进 `rule_book_rules`，绕过了 `#activate` 的 `JSON.stringify(parsed.params)`，所以测试看到新默认、生产旧规则看不到。

建议：如确实要让旧规则补上 `her_words`，需要一个明确的迁移或读取时的兼容规则（注意旧数据无法区分「没写 classes」和「明写旧默认」，需要 Andy 定）；同时加一条测试：先用旧版写入路径造一条规则，再用新版读取并在静默时段断言 `her_words` 是否被延后。

### 2. 高 — 「她的话」推送完全无视消息的数据分级，sensitive/restricted 原话会直接上锁屏

文件:行：`apps/agent-service/src/production-web-push.ts:856-869`、`:899-920`；`apps/agent-service/src/service-main.ts:3027-3040`；`packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:770-802`

问题：新的 `her_words` 分支只检查角色是 `agent`、文本非空，就把消息原文推出去；没有读取 `thread_messages.classification`，也没有像提醒推送那样对 sensitive/restricted 做遮盖。运行回答的分级来自答案 payload，代码允许它是 `sensitive`/`restricted`，所以「敏感回答原文上锁屏」是可发生的。

证据：
```ts
return message?.role === "agent" ? readPlain(message.contentRef) : undefined;
```
```ts
if (pushClassOf(item) === "her_words") {
  const text = item.threadId
    ? (await this.#options.readMessageText(item.threadId, item.sourceRef))?.trim()
    : undefined;
  if (!text) return { expired: true };
  ...
  body: text,
```
同一文件的提醒分支却明确做了保护：
```ts
const hidden =
  memory.dataClassification === "sensitive" || memory.dataClassification === "restricted";
...
body: hidden
  ? WEB_PUSH_TEXT[locale].privateReminder
  : `${text}\n${this.#formatTime(reminder.dueAt, locale)}`,
```
而 `commitAssistantMessage` 的分级来自答案 payload：
```ts
const answer = record(answerValue);
dataClassification = classification(answer["classification"]);
```
「必须遮盖」属于从提醒分支推出来的产品约束；代码事实是这条新路径没有任何分级检查（结论的后半句是推测）。

建议：把消息分级带出 `readMessageText`（或在查询里一起取 `classification`），对 sensitive/restricted 使用通用文案或直接不推，和提醒推送保持一致；并加一条真实数据库的用例：sensitive 的 agent 回答不能出现在 push body 里。

### 3. 中 — 新增的 `visible` 短路对所有推送类别生效，静默期内的定时提醒/任务结果会被永久丢弃，且与 ADR「由 App 决定不显示、服务器照常发」不一致

文件:行：`apps/agent-service/src/production-web-push.ts:552`、`:569-574`、`:610-613`、`:30`、`:127-134`；`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:40`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:357`

问题：`if (visible) return false;` 放在 `#deferred` 之前，于是「可见」优先于安静时段，所有 wake 类别都不再进入延后逻辑，而是在 `if (visible)` 分支被记成 `suppressed` 永久丢掉。作者的意图是「避免时段结束后补发主人已看过的话」，但实现没有限定 `her_words`，把 `scheduled_reminder`、`run_result`、`mail_reminder` 也一起改了：以前静默期到点的提醒会被延后，现在只要 45 秒内任意客户端有过心跳就被丢弃。

证据：
```ts
const gate = async (item: WebPushOutboxItem): Promise<boolean> => {
  if (this.#options.placement?.holds(webPushTopic(item.sourceKey))) return true;
  if (visible) return false;
  if (await this.#deferred(item, now, gated, decisions)) return true;
  return !visible && (await this.#place(item, contentOf, accountLocale));
};
```
```ts
if (await gate(entry.item)) continue;
if (visible) {
  await this.#record(entry, now, "suppressed", null);
  continue;
}
```
`visible` 是任意客户端的 45 秒心跳：
```ts
const PRESENCE_WINDOW_MS = 45_000;
...
anyVisible(now: string): boolean {
  const at = Date.parse(now);
  for (const [clientId, seen] of this.#seen) {
    if (at - seen <= PRESENCE_WINDOW_MS) return true;
```
而 ADR/规格写的是「Andy 正在 App 里看主对话时由 App 不弹出」「服务器照常发，App 在前台显示主对话时不弹出」。

建议：把「可见先于延后」限定在 `herWords`（或至少只对 `her_words` 生效），保留其它类别的静默延后语义；更贴合 ADR 的做法是服务器照常下发、由客户端在展示主对话时抑制。若坚持服务器抑制，也应把「任意页面可见」收窄为「正在看主对话」，并评估「离开 App 后不再补发」是否可接受。

### 4. 中 — 单条「她的话」内容读取失败会让整个推送 tick 反复失败，最长 24 小时阻塞其它推送

文件:行：`apps/agent-service/src/service-main.ts:2883-2893`；`apps/agent-service/src/production-web-push.ts:604`、`:315-321`、`:39-40`

问题：`readPlain` 里的 `unprotect` 或 `TextDecoder(..., { fatal: true })` 会抛异常；`#content` 和 `contentOf` 外层都没有针对单条的 try/catch，`#deliver` 直接 reject，只有 `tick()` 的全局 `onFailure` 接住。失败的那条 `web_push_outbox` 行仍然 due（`expiresAt = finishedAt + 24h`），于是每个 tick 都在同一条上抛错，导致其后的推送都发不出去。

证据：
```ts
const readPlain = async (ref: string) => {
  const payload = await consolidationPayloads.get(ref);
  if (!payload || payload.contentType !== "text/plain") return undefined;
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await episodeProtector.unprotect({ ... }),
  );
};
```
```ts
const content = await contentOf(item);
if (content.expired) {
  await this.#record(entry, now, "expired", null);
  continue;
}
```
```ts
tick(): Promise<void> {
  this.#running ??= this.#run()
    .catch(this.#options.onFailure)
```
这不是「不可信输入」导致的注入，而是错误路径的资源/可用性问题：坏一条会拖住整个投递循环。

建议：在 `#content`/`contentOf` 外围按 item 包一层 try/catch，失败时记录 `failed`/`expired` 并继续处理其它 item；`readMessageText` 也应把解密/解码失败转成 `undefined` 或一个可识别的失败，而不是让整轮 tick 抛出。

### 5. 低 — `replyMessageId` 的相关子查询没有 `run_id` 索引，长主对话上每个 tick 可能退化为 O(批次 × 线程消息数)

文件:行：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:719-725`；`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:80`；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:99`；`apps/agent-service/src/production-web-push.ts:49`、`:434`

问题：`replyMessageId` 子查询按 `run_id` 过滤、按 `sequence DESC` 取一条，但现有索引只有 `UNIQUE(thread_id, sequence)` 和 `(thread_id, turn_id, sequence)`，没有 `run_id`。主对话被设计成无限增长，SQLite 对每条 run 都可能从该线程最新消息开始倒着扫，直到碰到属于该 run 的消息；`FINISHED_RUN_BATCH = 100` 时最坏是 100 次长距离扫描。

证据：
```sql
(SELECT reply.id FROM thread_messages reply
  WHERE reply.run_id = runs.id AND reply.thread_id = runs.thread_id
    AND reply.role = 'agent' AND reply.message_status = 'committed'
  ORDER BY reply.sequence DESC LIMIT 1) AS replyMessageId,
```
```sql
CREATE INDEX thread_messages_turn_index ON thread_messages(thread_id, turn_id, sequence);
```
建议：加 `CREATE INDEX ... ON thread_messages(run_id, sequence)`（或 `(run_id, role, message_status, sequence)`），让「这次运行的最后一个回答」成为索引直查；上线前在主对话大数据量上量一次这个 tick 的耗时。

**侧重检查**

- 错误路径：查了 `readPlain`、`#content`、`tick`/`#deliver`；发现单条内容读取异常会整轮失败并反复重试（意见 4）。
- 不可信/外来输入：agent 回答可能由邮件/网页内容派生，代码会把原话直接推上锁屏且不看分级（意见 2）；`said:` 编号本身由服务端生成、消息编号受 `machineString`/导出 schema 约束。
- 安全：核对了编号长度和各表 CHECK：`web_push_outbox`、`web_push_feedback`、`decision_ledger` 的 `source_key`/`subject_ref` 都是 1–256；`herWordsPushKey` 截断后正好 ≤256，`sourceRef` 用消息编号（生成路径 ≤128，导入 schema ≤256），这一侧没发现拒收问题。`pushClassOf` 只对 `kind="reminder"` 认 `said:`，生产创建处都是 `reminder`。
- 资源耗尽/性能：body 大小由 `webPushPayload`/`applePushAlertPayload` 截断；意见 5 的子查询缺少 `run_id` 索引是新增的热路径风险。
- 不可撤销操作：推送本身不可撤销；意见 3 的 `visible` 抑制会把推送永久记成 `suppressed`，属于「丢掉就没了」。
- 规则、说明、代码一致性：`rule_set` 说明、`field-catalog` 说明、`data-export` 标签、`PUSH_QUIET_CLASSES`/工具 `maxItems` 已同步；但规格关于「旧规则只有明写 classes 才排除」的假设和生产的参数固化不符（意见 1），ADR 关于「由 App 不弹出、服务器照常发」也和本 PR 的服务器抑制不符（意见 3）。
- 未核实：`prompt-manifest.json` 的新 sha256 是否与实际文本一致（没有运行 sha256 命令）；完整测试套件是否全绿；当前提交还没有子线程（`threads.origin` 只有 `owner`/`think`），所以规格里的「排除子线程」这次既未实现也无法验证。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 会，一次性。推送代码本身不碰模型请求；但本 PR 把 `rule_set` 的 `classes` 从 3 种改成 4 种，并把 `maxItems` 从 3 改成 `PUSH_QUIET_CLASSES.length`。`schemaStructure` 保留 `enum` 和 `maxItems`，`toolSchemaChanged` 会在下一轮运行开始时把老对话判成 `tool_schema_changed` 并整体换新一次（`packages/application/src/services/thread-prompt-bundle-service.ts:120-157`、`:201-205`）。所以对老对话不是「只在末尾追加」，而是规则第 6 条允许的一次性换新；新对话从一开始就是新定义。除这次换新外，没有把每轮会变的值放进系统提示或工具定义，工具文字也没有时间/路径。`field-catalog` 的说明只用于字段名/类型注册和测试，不进入模型请求，不构成前缀变化。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会因为本 PR 新增每轮变化值。`herWordsPushKey` 是确定性的字符串 + 固定 SHA-256 摘要，不含时间/随机数；推送内容不进入模型请求。工具定义在换新后按对话冻结，字节稳定。唯一跨请求的变化是上面第 1 条的一次性 `tool_schema_changed` 换新，不是每次请求都变。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`her-words-push-key.unit.test.ts`、`rule-type-push-quiet-hours.unit.test.ts`、`production-web-push.test.ts` 的 `[SAID-1]`/`[SAID-2]`/`[SAID-3]`、`push-channels.test.ts`、`sqlite-web-push.test.ts`。碰撞、空段、旧类别不延后、外部事件不推、删除回话不推、可见时抑制这些反向用例在移除对应实现后都会失败（其中「删除回话」用例只是入队一条没有消息的记录，并没有真正先写后删）。缺口是：没有一条用例走生产写规则路径（`#activate` 固化 `classes`）来验证旧规则升级后的行为，所以意见 1 抓不到；没有 `her_words` 规则的导出/导入往返用例；`prompt-manifest` 的摘要是否匹配未运行核实。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `said:` 编号：`pushClassOf`（`kind="reminder"`）认得；`web_push_outbox.source_key`、`web_push_feedback.source_key`、`decision_ledger.subject_ref` 都是 1–256，截断后正好 ≤256；上游 `assertItem` 也按 256 校验。`source_ref` 用消息编号，生成的消息编号 ≤128、导入 schema ≤256，能过 1–256 的 CHECK。这一侧两端能对上。
   - `her_words` 类别：已加进 `PUSH_CLASSES`、`PUSH_QUIET_CLASSES`、工具 enum/`maxItems`、`data-export` 标签和字段说明；导出导入走 `parsePushQuiet`，没有发现硬编码的 3 类白名单。数据分级这一使用端不接受敏感内容的安全语义（意见 2）。
   - `startedBy`：取值与 `triggers.source_type` 的 CHECK 三种完全一致，`runs.trigger_id` NOT NULL，比较是运行时的字面值；没有发现拒收或漏配。
   - `replyMessageId`：可空已处理；用作消息编号、`sourceRef` 和 key 的默认 id 都受约束。但它可能指向 sensitive/restricted 回答（意见 2），且子查询性能有问题（意见 5）。
   - 规格里的「排除子线程」使用端还不存在（当前 `origin` 只有 `owner`/`think`），这次未核实、也未实现。
