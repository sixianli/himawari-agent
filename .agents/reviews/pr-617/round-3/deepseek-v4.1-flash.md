**这一轮查过的范围**：`git diff 3ebb8a9..e34abd` 的全部增量（`production-owner-rules.ts`、`production-web-push.ts`、`rule-types.ts`、`data-export/rules.ts`、两份集成测试、规格第 347 行），并顺着证据追到：`production-http-composition.ts` 与 `service-main.ts` 的写入器装配、`sqlite-web-push-operations.ts` 的 `listDue`/`listFinishedRuns`、`web-push-gate.ts` 的 `pushClassOf`/`herWordsPushKey`、`prompt-catalog` 的 `rule_set` 说明与清单、相关迁移的 `CHECK`、以及第 2 轮六个意见对应的测试。没有重读整个 PR 的旧代码；下面标「未核实」的除外。

---

### 1. 中高 — 并发保护只覆盖通知页的两个请求；聊天立规则与通知页同时写仍可留下两条生效规则，且生产里两个写入器不是同一个实例

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:1249-1261`、`:1269-1273`、`:1298-1300`、`:1377-1388`；`apps/agent-service/src/service-main.ts:1600-1621`、`:1714-1717`、`:3168`、`:3419`；`apps/agent-service/src/production-http-composition.ts:1326-1343`、`:1660-1666`。

**问题**：第 2 轮意见 3 只修好了「两个通知页请求并发」：`setQuietHours` 把页面写串行化了。但：
- 聊天里的 `rule_set` 走 `ProductionOwnerRuleTools.run` → `writer.create`，不经过 `#quietHoursWrites` 队列；
- 生产装配里，运行工具用的是 `service-main.ts:1600` 新建的写入器，通知页控制用的是 `production-http-composition.ts:1326` 另建的写入器，两者不是同一实例。

因此版本检查不是跨路径的原子操作。页面先读到版本 V，聊天随后新建一条安静时段规则，页面再 `#activate` 自己的规则并只撤销读取时的 `current.rules` 快照，聊天那条会留下来；`quietHours()` 随后看到两条 `enforced` 规则，返回 `enabled: true, editable: false, classes: []`，页面既显示已开启又改不了。这正是意见 3 描述的失败模式，只是发生在页面与聊天之间。

**证据**：
```ts
// production-owner-rules.ts:1255
const run = this.#quietHoursWrites.then(() => this.#writeQuietHours(input));
// production-owner-rules.ts:1269
const { state: current, params } = await this.#quietHoursState();
// production-owner-rules.ts:1298-1300
for (const { ruleId } of current.rules)
  if (ruleId !== receipt.ruleId) await this.undo(ruleId);
} else for (const { ruleId } of current.rules) await this.undo(ruleId);
// production-owner-rules.ts:1377
return this.#writer.create({
```
```ts
// service-main.ts:1600 / 1621 / 1717 / 3419
const ownerRuleWriter = new ProductionOwnerRuleWriter({
const ownerRuleTools = new ProductionOwnerRuleTools(ownerRuleWriter);
ownerRules: ownerRuleTools,
tools,
```
```ts
// production-http-composition.ts:1326 / 1662-1664
const ownerRuleWriter = options.memory
  ? new ProductionOwnerRuleWriter({
quietHoursControl: new ProductionQuietHoursControl({
  configuration,
  rules: ownerRuleWriter,
```

**建议**：让通知页和 `rule_set` 共用同一个写入器，并把「读版本 → 检查 → 写入 → 撤销旧规则」放进同一个串行区/事务；`#writeQuietHours` 在 `#activate` 前重新读一次版本，撤销时也要覆盖读取快照之后新出现的安静时段规则。补一条反向测试：`ruleTools.run(rule.set)` 与 `quiet_hours.set` 并发，断言最终只有一条生效规则。

**证据类型**：读代码证实（生产装配与调用路径均来自代码；竞态是逻辑推论，未实际并发跑）。

---

### 2. 中低 — 内容读取的任何异常都被当成“永久不可读”丢弃，影响所有推送类别，而不只是她的话

**文件:行**：`apps/agent-service/src/production-web-push.ts:616-623`、`:1080-1099`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:340-363`。

**问题**：新增的 `try/catch` 包住 `contentOf(item)`，把任何异常都记成 `failed` 且 `nextAttemptAt: null`；`listDue` 只重试 `pending`，所以这条推送对该订阅永久不再发。它不只作用于 `her_words`：`#content` 里的 `museChannel.listActive`、`readyProposals`、`readMessage/readText`、`proactive.content`、`reminders.read` 任何一处瞬时数据库/解密错误，都会让到点提醒、邮件、提议、Muse 告警等永久丢失。改动前这类错误会让整个 tick 失败、下一轮重试。新增测试只覆盖了「她的话」解密失败。

**证据**：
```ts
// production-web-push.ts:617-623
try {
  content = await contentOf(item);
} catch (error) {
  this.#options.onFailure(error);
  await this.#record(entry, now, "failed", "WEB_PUSH_CONTENT_UNREADABLE");
  continue;
}
```
```ts
// production-web-push.ts:1095
nextAttemptAt: retry ? new Date(Date.parse(now) + retry.delayMs).toISOString() : null,
```
```sql
-- sqlite-web-push-operations.ts:361-362
AND (a.status IS NULL OR (a.status = 'pending'
  AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)))
```

**建议**：区分「确定不可读/解密失败」与「瞬时读取失败」。前者可以记 `failed` 永久丢弃；后者应记 `pending` 并退避重试。若只想让她的话不阻塞整批，可把永久丢弃限定在 `pushClassOf(item) === "her_words"`，其余仍按原重试语义。补一条非 `her_words` 的瞬时读取失败反向测试。

**证据类型**：读代码证实。

---

### 3. 低 — 挂起的规则已不算开启，但参数损坏的 active 规则仍显示“已开启”且页面改不了（第 2 轮意见 7 只修了一半）

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:1211-1246`、`:1269-1273`；`packages/application/src/rules/rule-types.ts:457-466`。

**问题**：`enforced` 只按 `ruleIsEnforced(row.status)` 过滤，不检查参数能否解析。一个 `status = active` 但参数损坏的安静时段规则会进入 `enforced`，`quietParams` 返回 `undefined`，于是 `periods = []`、`single = false`、`enabled: true`、`editable: false`、`classes: []`。而推送闸门用的是 `enforceableOwnerRule`，它会把这条规则跳过，所以实际不生效。页面显示「已开启」，用户却因为 `!current.editable` 连关都关不掉（抛 `RULE_UNAVAILABLE`）。第 2 轮意见 7 的「挂起」部分已修，「损坏」部分仍在。

**证据**：
```ts
// production-owner-rules.ts:1211
const enforced = rows.filter((row) => ruleIsEnforced(row.status));
// production-owner-rules.ts:1226-1233
const params = quietParams(only.parameters);
const periods = params?.periods ?? [];
const [period] = periods;
const single =
  enforced.length === 1 &&
  periods.length === 1 &&
  period !== undefined &&
  everyDay(period.days);
// production-owner-rules.ts:1272-1273
if (!current.editable)
  throw new OwnerRuleError("RULE_UNAVAILABLE", "现在有不止一段安静时段，只能在聊天里改");
```
```ts
// rule-types.ts:461-465
if (!ruleIsEnforced(row.status)) return undefined;
try {
  return ownerRuleRecord(row, registry);
} catch (error) {
  if (error instanceof RuleTypeError) return undefined;
```

**建议**：`enforced` 改为同时要求 `quietParams(row.parameters) !== undefined`（或 `enforceableOwnerRule(row) !== undefined`），让损坏规则不算开启；或给页面一个「规则读不出来」的明确状态，并允许关闭/替换。补一条参数损坏的反向测试。

**证据类型**：代码行为读代码证实；「生产库里是否真的会出现损坏的 active 行」未核实（正常写入会校验，导入是否可能绕过未查）。

---

### 4. 低 — 作者材料“已明写 classes 的旧规则不自动加 her_words”与代码/更新后的规格相反；规格里“旧规则都带着当时的默认类别”也不准确

**文件:行**：`packages/application/src/rules/rule-types.ts:72-79`、`:294-295`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:347`。

**问题**：
- 代码 `pushQuietClassesOf` 明确：只要明写 `classes` 里含 `run_result` 且不含 `her_words`，就自动补 `her_words`。作者材料「目标和约束」仍写「已明写 classes 的旧规则不自动加」，与代码相反；规格第 347 行已改成「写了任务完成的同时管她的话」，所以现在是材料与规格/代码不一致。
- 规格第 347 行还说「以前经立规则工具存进库的规则都带着当时的默认类别（任务完成、邮件提醒）」。这不准确：`parsePushQuiet` 在 `classes === undefined` 时返回 `{ periods }`，不写 `classes`；旧版 `rule_set` 说明还明确让模型「主人没点名就不写 classes」。因此大量旧规则其实没有明写默认类别，只是读的时候走新的默认清单（其中已含 `her_words`）。这不影响最终效果，但迁移理由写错了。

**证据**：
```ts
// rule-types.ts:72-79
export function pushQuietClassesOf(parameters: PushQuietParameters): readonly PushQuietClass[] {
  const named = parameters.classes;
  if (!named) return PUSH_QUIET_DEFAULT_CLASSES;
  if (!named.includes("run_result") || named.includes("her_words")) return named;
  return PUSH_QUIET_CLASSES.filter((pushClass) =>
    pushClass === "her_words" ? true : named.includes(pushClass),
  );
}
```
```ts
// rule-types.ts:294-295
const rawClasses = record["classes"];
if (rawClasses === undefined) return Object.freeze({ periods: sortedPeriods });
```

**建议**：统一说法：明写含 `run_result` 的旧规则自动管她的话；没写 `classes` 的旧规则走新默认清单（也含她的话）；明写但不含 `run_result` 的不变。删掉「旧规则都带着当时的默认类别」这一句或改成「部分旧规则明写了当时的默认类别」。

**证据类型**：读代码证实。

---

### 5. 低 — 从关闭状态重新打开通知页会写入四类（含 scheduled_reminder），与聊天的默认三类不同

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:1277-1289`；`test/integration/production-memory-capture.test.ts:2354-2358`。

**问题**：当没有生效规则时（例如用户刚关掉安静时段），`params` 为 `undefined`，`named = PUSH_QUIET_CLASSES`（四类，含 `scheduled_reminder`），页面重新打开会写一条显式四类规则，连带静默主人自己定的到点提醒。第 2 轮意见 4 的修复只覆盖「已有规则只静默部分类别」的路径；从关闭状态重新打开仍是四类。提交 `517ba2ef5` 的说明写「页面上设的规则管除‘要你同意的事’以外的全部推送类别」，所以这可能是页面有意为之；但作者材料「默认受管类别加 her_words」通常理解为三类默认，二者不一致，且测试把四类固定成了预期。

**证据**：
```ts
// production-owner-rules.ts:1277-1289
const named = params ? params.classes : PUSH_QUIET_CLASSES;
const covered = pushQuietClassesOf({ periods: [], ...(named ? { classes: named } : {}) });
...
params: {
  periods: [{ days: [...QUIET_HOURS_DAYS], start: input.start, end: input.end }],
  ...(named ? { classes: [...named] } : {}),
},
```
```ts
// production-memory-capture.test.ts:2355-2358
expect(await read()).toMatchObject({
  enabled: true,
  start: "23:30",
  classes: ["scheduled_reminder", "run_result", "mail_reminder", "her_words"],
});
```

**建议**：如果页面重新打开应使用默认三类，改成 `PUSH_QUIET_DEFAULT_CLASSES`；如果页面确实要管全部四类，在规格/材料里写明「页面新建的规则含到点提醒，聊天默认不含」，并让测试注释说明这是产品决定。

**证据类型**：读代码证实；「页面是否有意管四类」依据提交说明，未在规格正文核实。

---

### 6. 低 — `rule_set` 工具说明没有写“点名 run_result 会连带管她的话”，模型可能只承诺静默任务完成

**文件:行**：`packages/prompt-catalog/src/tools.ts:243`；`packages/application/src/rules/rule-types.ts:72-79`。

**问题**：当前工具说明写「主人没点名就不写 classes（默认管任务完成、邮件提醒和你的话）」，并列出四类选项，但没有说「明写 `run_result` 时程序会自动把 `her_words` 也算进去」。模型如果写 `classes: ["run_result"]`，程序会同时静默她的回话，而模型可能只告诉主人「任务完成不推送」。这是模型可见说明与实际执行规则的不一致。清单 `tools.rule-set` 的 `sha256`/`changedIn`/`reason` 已因四类更新过，但这条自动补类别的规则没有写进去。

**证据**：
```ts
// prompt-catalog/src/tools.ts:243（节选）
classes 可选 run_result（任务完成或失败）、mail_reminder（邮件提醒）、her_words（你写给主人、推到手机上的话）、scheduled_reminder（主人自己定的到点提醒），主人没点名就不写 classes（默认管任务完成、邮件提醒和你的话），主人明说连到点提醒也别响才加上 scheduled_reminder，这时把要管的类别都写上；
```
```ts
// rule-types.ts:75-78
if (!named.includes("run_result") || named.includes("her_words")) return named;
return PUSH_QUIET_CLASSES.filter((pushClass) =>
  pushClass === "her_words" ? true : named.includes(pushClass),
);
```

**建议**：在 `rule_set` 说明里加一句「只要写了 run_result，程序也会管 her_words；要区分请在 summary 里说清」；改完更新 `prompt-manifest.json` 的 `sha256`、`changedIn`、`reason` 并跑 `npm run check:prompt-catalog`。或者取消新规则的自动补类别，只在读取旧规则时兼容。

**证据类型**：读代码证实（说明文字与代码路径都读到）。

---

### 7. 低 — “主人消息叫起的运行跑完推她的回话”只对 `completed` 成立；`failed` 且有已提交回话时仍推“没有完成”

**文件:行**：`apps/agent-service/src/production-web-push.ts:448-462`。

**问题**：作者材料说「主人消息叫起的运行跑完推她的回话」。代码的条件是 `run.startedBy === "user_message" && run.status === "completed" && run.replyMessageId`。如果运行是 `failed` 但已经有她解释失败原因的已提交 agent 消息，会落到后面的 `run:` 推送，手机上显示「没有完成」而不是她的原话。如果「跑完」包括失败，这与说法和规格「跑完不再推已完成，改成推她回你的那句话」不一致。

**证据**：
```ts
// production-web-push.ts:450-462
if (run.startedBy === "external_event") continue;
if (run.startedBy === "user_message" && run.status === "completed" && run.replyMessageId) {
  items.push({
    ...
    sourceKey: await herWordsPushKey({ messageId: run.replyMessageId }),
    ...
  });
  continue;
}
items.push({
  ...
  sourceKey: `run:${run.runId}:${run.status}...`,
```

**建议**：确认产品意图。如果失败运行也该推她的回话，去掉 `status === "completed"`，只要求 `replyMessageId` 存在；如果失败要保留「没有完成」通知，就在规格/材料里把「跑完」改成「成功完成」。

**证据类型**：读代码证实；「跑完是否包含失败」属于产品措辞，未核实。

---

**读代码证实的 / 推测分开说明**
- 读代码证实：意见 1 的装配与调用路径、意见 2 的 `failed` 永久丢弃语义、意见 3 的 `enabled/editable` 计算、意见 4 的自动补类别与解析行为、意见 5 的重新打开写四类、意见 6 的工具说明、意见 7 的 `status === "completed"` 条件。
- 推测/未核实：
  - 意见 1 的并发交错未实际跑；结论来自代码路径和 Promise 队列的作用域。
  - 意见 3 的「生产库里存在损坏的 active 安静时段行」未核实；正常写入会校验，导入是否可能绕过未查。
  - iOS/网页通知页是否认识 `her_words` 未核实：仓库里只有网关契约，`quiet_hours.snapshot` 的 `classes` 是 `array(machineString)`，服务端不拒；客户端 UI 不在本仓库。
  - `tools.rule-set` 的清单 `sha256` 是否与当前 `tools.ts` 逐字匹配未核实（不能运行 `check:prompt-catalog`，也不能用 sha256 命令）。
  - `herWordsPushKey` 在超长且含非 BMP 字符时用 `key.slice(0, 256-32-1)` 按 UTF-16 截断，理论上可能切出孤立代理项；这是旧代码，未实际验证 SQLite 绑定行为，仅作提示。

---

**上一轮（第 2 轮）六条意见逐条核对**
- 意见 2（明写 classes 含 run_result 自动加 her_words，与规格/作者说法相反）：代码确实自动加，规格第 347 行已改成与代码一致；但作者材料「目标和约束」仍写不自动加。**部分改好（文档仍不一致）**，见意见 4。
- 意见 3（版本号防并发不是原子的）：通知页两个 `set` 已通过 `#quietHoursWrites` 串行化，反向测试覆盖；聊天 `rule_set` 与页面之间仍未串行化，生产还是两个写入器实例。**部分改好**，见意见 1。
- 意见 4（通知页保存把部分类别扩成四类、额外静默到点提醒）：已有规则现在保留原 `classes`，测试覆盖；从关闭状态重新打开仍写四类。**主要路径改好，重新打开路径仍是四类**，见意见 5。
- 意见 7（挂起/损坏规则显示已开启但不生效）：挂起规则已排除；损坏的 active 规则仍会显示开启且页面改不了。**部分改好**，见意见 3。
- 意见 1（一条她的话读取失败拖垮整个 tick）：已按条目捕获、记 `failed` 后继续，测试会让旧代码失败。**改好**；但带来了意见 2 的永久丢弃面过宽问题。
- 意见 5（导出的规则文字漏报 her_words）：`data-export/rules.ts` 已改用 `pushQuietClassesOf`，测试断言「任务完成、她的话」。**改好**。

**作者四条说法核对**
1. `pushClassOf` 对 `kind=reminder` 且 `sourceKey` 以 `said:` 开头返回 `her_words`：**属实**（`web-push-gate.ts:65-70`）。
2. `listFinishedRuns` 的 `startedBy`、`replyMessageId`：SQL 从 `triggers.source_type` 取 `startedBy`，与 `triggers` 的 `CHECK` 三种值一致；`replyMessageId` 取该 run、该 thread、`role='agent'`、`message_status='committed'` 中 `sequence` 最大的一条。按代码看**属实**；未实际执行 SQLite。
3. `herWordsPushKey` 不同事件不产生相同编号：编号按「长度:内容」拼三段，超 256 用 128 位摘要截短；分隔符碰撞已避免，超长碰撞只剩摘要碰撞。**基本属实**；非 BMP 截断的边界见「未核实」。
4. `web_push_feedback` 收 `kind=reminder`：迁移 `20261114154943_apple_push.sql:93` 的 `CHECK` 确实包含 `reminder`，`tag` 是 32 字符的 `webPushTopic`，`source_key`/`source_ref` 上限 256，`herWordsPushKey` 不超 256。**属实**。

---

**必答问题回答**

1. **会不会改变模型已经见过的请求开头？**
   本轮增量本身不会：它只改服务端安静时段控制、推送内容读取失败处理、数据导出文字和测试，没有碰系统提示、工具定义、历史、遮盖或提示词目录。PR 整体在更早的提交里改了 `rule_set` 的工具说明和 `classes` 参数结构；按 `prompt-prefix.md` 第 6 条，这会让老对话在下一轮运行开始时换新一次，这是规则允许的例外，不是「在开头改历史」。规格也说第 1 步上线时旧对话全删。发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里；通知页状态和数据导出不是模型输入，生成的规则 summary 只会在 `rule_list` 的工具结果里出现（末尾追加）。清单里 `tools.rule-set` 的 `sha256`/`changedIn`/`reason` 已读到更新记录，但未能运行 `check:prompt-catalog` 核对哈希。

2. **同一段文字会不会在不同请求里变成不同字节？**
   本轮增量没有引入这种变化。新生成的 summary 由固定标签表、固定类别顺序和用户输入的起止时间拼成；`classes` 经过 `parsePushQuiet` 按 `PUSH_QUIET_CLASSES` 顺序归一化；版本哈希对按 `ruleId` 排序的行计算；数据导出的类别也走同一函数。没有依赖前后文的遮盖、时间字段或无序集合进入模型请求。`her_words` 的推送内容取决于消息原文和分类，这是业务内容，不是序列化不确定性。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，且新增的反向用例确实能打中旧行为：
   - 她的话读取失败：旧代码会让 `push.tick()` 拒绝，新测试会失败；现在测试断言只推后面那条。
   - 两个通知页 `set` 并发：旧代码两个都会 fulfilled，新测试断言一个 `PORT_CONFLICT`，会失败。
   - 保留部分类别：旧代码写四类，新测试断言只保留 `mail_reminder`，会失败。
   - 挂起规则不算开启：旧代码 `enabled: true`，新测试断言 `false`，会失败。
   - 导出文字含她的话：旧导出只写「任务完成」，新断言会失败。

   未覆盖的缺口：聊天 `rule_set` 与页面 `quiet_hours.set` 的跨路径并发（意见 1）、非 `her_words` 的瞬时读取失败（意见 2）、参数损坏的 active 规则（意见 3）、`rule_set` 说明中的自动补类别（意见 6）。

4. **每个产生或修改的值的直接使用端能不能接受？**
   - `PUSH_QUIET_CLASS_LABELS`：只有 `production-owner-rules.ts:1282` 和 `data-export/rules.ts:182` 使用，键都是 `PushQuietClass`，类型上完整，**可以**。
   - `QuietHoursState.classes`（现在排除挂起、并按实际生效补 `her_words`）：`production-quiet-hours-control.ts:46` 原样放进 `quiet_hours.snapshot`；网关契约 `contracts-v2.ts:617` 是 `array(machineString)`，服务端**可以**；iOS 通知页是否认识 `her_words` **未核实**。
   - 新 source key（多带 `:classes`）：`#activate` 用 `hash(proposal.key).slice(0,24)` 生成 ruleId，`#writeMemory` 生成 `memory:rule:${key}`；按当前最长四类 key 约 86 字符，memory id 约 98 < `rule_book_rules.source_memory_id` 的 128 上限，**可以**。
   - `WEB_PUSH_CONTENT_UNREADABLE`：写入 `web_push_attempts.last_code`，`CHECK` 是 1 到 64 字符，长度 26，**可以**。
   - `startedBy`/`replyMessageId`：`startedBy` 来自 `triggers.source_type`，其 `CHECK` 正好是 `user_message`/`schedule`/`external_event`，与 `WebPushFinishedRun` 类型一致；`replyMessageId` 用作 `sourceRef`（上限 256）和 `readMessage` 的消息编号，**按代码可以**（未实际跑真实 SQLite）。
   - `her_words` 类别：`rule_set` 的 enum、`parsePushQuiet`、`PUSH_QUIET_CLASSES`、网关契约、字段目录都已包含，**可以**。

**侧重检查**
- **错误路径**：内容读取失败现在按条目丢弃（意见 2 指出面过宽）；`#record` 的 `failed` 会让 `listDue` 不再返回该订阅；页面 `start/end` 有 `CLOCK` 和相等校验；版本冲突映射为 `PORT_CONFLICT`。敏感回话的 `hidden` 分支不调用 `readText`，不会把密文/原文读出来（`production-web-push.ts:880-888`），这一点是安全的。
- **不合规范/不可信输入**：通知页命令不接受 `classes`，只接受 `enabled/start/end/expectedVersion`；`start/end` 有正则和相等校验；summary 由固定标签生成，不拼接用户可控文本。`herWordsPushKey` 的 source id/version 可来自外来事件，但做了长度前缀和 256 上限；非 BMP 截断见「未核实」。
- **安全**：`onFailure(error)` 记录的是错误对象，生产实现取 `stableErrorCode`，未见把正文写进日志；`webPushTopic` 对长 source key 做 SHA-256 截断，反馈表 `tag` 固定 32 字符，符合 `CHECK`。
- **资源耗尽**：`#quietHoursWrites` 是进程内无限增长的 Promise 链；大量并发页面写会排队，且一次挂起会让后续全部等待。没有上限或超时。严重度低（只有主人自己会触发），但可作为后续加固点。
- **不可撤销**：内容读取失败会永久丢弃推送（意见 2）；页面关闭会 `undo` 规则并归档来源记忆（可恢复，属于旧行为）；页面改时间会新建规则并退休旧规则，`ruleId` 改变（旧行为，测试已固定）。
- **规则文件/说明/代码一致性**：意见 4、6、7 分别对应材料与代码、工具说明与自动补类别、规格「跑完」与 `completed` 条件的不一致。
