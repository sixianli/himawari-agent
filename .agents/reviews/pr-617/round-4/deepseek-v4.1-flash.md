## 结论与范围

本轮只比较了 `e34abd903..8fb470ae`（并回溯到 PR 617 的基准 `d42a3a0a`）用于区分哪些行属于 PR 617。净增量里属于 PR 617 的代码只有 `production-owner-rules.ts` 的 `ruleSource` 截短逻辑，另有 `ci/operations-pending.json` 两条、规格文档若干行；其余 90 来个文件是从 `origin/main` 合并进来的别的改动（ADR 0285 的工具结果清理、设备动作授权、提示词等），不是这个 PR 自己的行。因此下面意见以 PR 617 为主，对合并进来的改动只做了直接使用端的高层核对（`readUntrustedContent`、`untrustedOriginAllowed` 已无任何引用；`tool_result_recall` 已在 Pi 适配器里接上）。

读代码证实的与推测的已在每条里分开标注。

---

### 1. 中低 — 参数损坏的 active 安静时段规则仍显示“已开启”且通知页改不了，并让整套推送闸门 fail-open（上一轮意见 3 只修了 suspended 一半）

文件: `apps/agent-service/src/production-owner-rules.ts:1217-1249`、`:1278-1279`；`apps/agent-service/src/service-main.ts:3059-3061`；`packages/application/src/services/web-push-gate.ts:142-143`

问题（读代码证实）：`quietHours()` 只用 `ruleIsEnforced` 过滤挂起规则；参数解析失败时 `params` 变 `undefined`、`periods` 为空，`single` 为 false，于是返回 `editable:false, enabled:true`。页面看到“已开启”但改不了；`setQuietHours` 还会抛出误导性的“现在有不止一段安静时段”。同一时刻 `readPushRules` 会对任何“受管类别但解析失败”的推送规则整体抛错，`PushGate` 捕获后返回 `DELIVER_FAILED`，所有类别都直接放行——安静时段实际完全失效。

证据:
```ts
// production-owner-rules.ts:1232-1245
const params = quietParams(only.parameters);
const periods = params?.periods ?? [];
const single = enforced.length === 1 && periods.length === 1 && ...;
state: Object.freeze({ editable: single, enabled: true, ... })
// :1278-1279
if (!current.editable)
  throw new OwnerRuleError("RULE_UNAVAILABLE", "现在有不止一段安静时段，只能在聊天里改");
// service-main.ts:3059-3061
if (unreadablePushRule(row)) throw new Error("PUSH_RULE_UNREADABLE");
const rule = enforceableOwnerRule(row);
// web-push-gate.ts:142-143
} catch {
  return DELIVER_FAILED;
```
建议：把“受管类别且解析失败”单独做成一种状态（例如 `enabled:false`、`editable:true`、带“需修复”标记），让页面能关掉或重写；`readPushRules` 对坏行只跳过该行并记诊断，而不是整批抛错导致 fail-open。加反向测试：写一条参数损坏的 active 安静规则，页面能关掉，且闸门不因此对所有类别放行。

### 2. 低 — `settled()` 里读内容没有 try/catch，一条读不出的“她的话”会让通知结算接口整体失败（上一轮意见 2 只修了投递循环）

文件: `apps/agent-service/src/production-web-push.ts:671-688`、`:875-883`；`packages/platform-node/src/device-api-routes.ts:918-923`

问题（读代码证实）：投递循环已按条 `try/catch`，但 `settled(ids)` 对每条命中 id 直接调 `this.#content(...)`。`#content` 的 her-words 分支会 `await message.readText()`，内容损坏/解密失败会抛错；路由没有捕获，整个 `POST /notifications/settled` 会 500，影响这一批里所有 id，而不只是读不出的那条。

证据:
```ts
// production-web-push.ts:683-685
const expired =
  Date.parse(now) >= Date.parse(item.expiresAt) ||
  (await this.#content(item, approvals, now)).expired;
// :882
const text = hidden ? undefined : (await message.readText())?.trim();
// device-api-routes.ts:918-923
return options.sendJson(reply, 200, {
  settledIds: await notifications.settled({ ... }),
});
```
建议：`settled()` 逐条 `try/catch`，读不出的条目按“未结算/跳过”处理并记诊断，不要中断整批；补一条反向测试。

### 3. 低 — 内容读不出的推送仍被永久丢弃、不重试（上一轮意见 2 的另一半）

文件: `apps/agent-service/src/production-web-push.ts:617-622`、`:1080-1096`

问题（读代码证实）：捕获后记 `failed`，调用 `#record` 时没有传 `retry`，`nextAttemptAt` 被写成 `null`。`failed` 是终态，这条推送不再重试。对临时性错误（读盘失败、解密依赖瞬时不可用）会永久丢掉一条本来能成功的“她的话”；题目强调“同一件事不因程序重试响两次”，但这里走到了另一个极端。

证据:
```ts
} catch (error) {
  this.#options.onFailure(error);
  await this.#record(entry, now, "failed", "WEB_PUSH_CONTENT_UNREADABLE");
  continue;
}
// #record
nextAttemptAt: retry ? new Date(Date.parse(now) + retry.delayMs).toISOString() : null,
```
建议：区分可重试与永久错误；可重试的走 `pending` + `RETRY_DELAYS_MS`，超过次数再 `failed`；或至少不要对瞬时错误直接判死。补正反测试。

### 4. 低 — `rule_set` 工具说明仍没写“点名 run_result 会连带管她的话”（上一轮意见 6 未改）

文件: `packages/prompt-catalog/src/tools.ts:243`；`packages/application/src/rules/rule-types.ts:72-79`

问题（读代码证实）：说明文字只写了四种类别和“没点名时默认管任务完成、邮件提醒和你的话”，没有写“明写 run_result 会顺带把 her_words 也纳入”；而代码确实会加。模型可以只承诺“静默任务完成”，实际却连带静默她的话。

证据:
```ts
// rule-types.ts:75-78
if (!named.includes("run_result") || named.includes("her_words")) return named;
return PUSH_QUIET_CLASSES.filter((pushClass) =>
  pushClass === "her_words" ? true : named.includes(pushClass),
);
```
建议：在这句说明里补“写了 run_result 的规则也会管她的话”；改后同步更新 `prompt-manifest.json` 的 sha（否则 `check:prompt-catalog` 会失败）。本轮该文件相对 `e34abd` 没有变化，所以“已修改”的说法不成立。

### 5. 低 — 规格和作者材料对“旧规则 classes”的说法与代码相反（上一轮意见 4 未真正改好）

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:347`；`packages/application/src/rules/rule-types.ts:294-295`

问题（读代码证实）：
- 作者材料仍写“已明写 classes 的旧规则不自动加”，但代码对只写了 `run_result` 的旧规则会自动加上 `her_words`。
- 规格同一行写“以前经立规则工具存进库的规则都带着当时的默认类别（任务完成、邮件提醒），读回来和明写一样”。实际 `parsePushQuiet` 在模型不写 `classes` 时只存 `{periods}`，不存任何默认类别；这类旧规则读到的是“没写 classes”的当前默认，而不是当时的默认。通知页那条写入路径才总是写死类别。

证据:
```ts
// rule-types.ts:294-295
const rawClasses = record["classes"];
if (rawClasses === undefined) return Object.freeze({ periods: sortedPeriods });
// :75-78（同上，run_result 会补 her_words）
```
建议：规格改成“明写 run_result 的规则会自动加 her_words；没写 classes 的旧规则按当前默认（含 her_words）执行；其余明写类别不自动加”；并修正作者材料那句。行为本身不需要改。

### 6. 低 — 规格里“一封邮件引起的她的话推送”在当前代码里不会发生

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:350`；`apps/agent-service/src/production-web-push.ts:450-451`

问题（读代码证实）：规格的测试清单要求验证“一封邮件引起的‘她的话’推送在安静时段里同样延后”，但采集路径对 `startedBy === "external_event"` 直接 `continue`，只有 `user_message` 完成且 `replyMessageId` 存在时才生成 `said:` 推送。因此邮件叫起的运行根本不会产生“她的话”推送，这条测试场景无法由真实代码产生（只能手工往推送表塞一条来测）。

证据:
```ts
if (run.startedBy === "external_event") continue;
if (run.startedBy === "user_message" && run.status === "completed" && run.replyMessageId) {
  ... sourceKey: await herWordsPushKey({ messageId: run.replyMessageId }) ...
```
建议：要么把规格这条改成“手工写入的 said 推送同样受安静时段管理”，要么说明未来由哪个路径产生“邮件引起的她的话”。不要留下与代码不符的验收项。

### 7. 低 — 新的 `ruleSource` 截短在“base 本身很长”时仍会截掉对话来源，且没有测试覆盖该分支

文件: `apps/agent-service/src/production-owner-rules.ts:626-632`

问题（读代码证实分支存在，触发条件未核实）：`room = 256 - 前缀 - tail`，当 `room <= 17` 时 `kept` 直接取完整 origins，最后整串再 `.slice(0,256)`，仍会把 `|<对话来源>` 截掉——这正是这次修复想保住的东西。新增的长来源测试只覆盖了 `room > 17` 的正常分支。

证据:
```ts
const kept =
  origins.length <= room || room <= RULE_SOURCE_DIGEST + 1
    ? origins
    : `${origins.slice(0, room - RULE_SOURCE_DIGEST - 1)}~${hash(origins).slice(0, RULE_SOURCE_DIGEST)}`;
return `${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${kept}${tail}`.slice(0, RULE_SOURCE_LIMIT);
```
建议：对 base 也做同样的“截短 + 哈希”，或明确规定优先级并补一条“base 超长”的测试；否则“保留对话来源”只对普通长度成立。

---

## 侧重检查

- 错误路径（读代码证实）：投递循环已按条捕获；`settled()`、`readPushRules`、`herWordsPushKey` 的空段抛错、`quietParams` 解析失败仍有未处理或误导性分支，见意见 1、2、3。
- 不可信/不合规范输入（读代码证实）：`rule_set` 的 `classes` 有 enum + `maxItems: PUSH_QUIET_CLASSES.length`（4），`periods` 上限 8 且格式校验；`herWordsPushKey` 对空段抛错，`sourceKey` ≤256；消息 id 来自数据库自生成，`sourceRef` ≤256。未发现新增可绕过点。
- 安全（读代码证实）：sensitive/restricted 的“她的话”正文替换成“你有一条私密消息”，测试断言锁屏不含原文；但 `navigate` 仍指向对话页，属预期。
- 不可撤销/重复（读代码证实）：推送表 `(owner_id,agent_id,source_key)` 主键去重，`herWordsPushKey` 确定性，测试手工重复入队返回 0。
- 资源耗尽：`listFinishedRuns` 有 `limit`，每个 run 一次 SHA-256；`herWordsPushKey` 只对超长串做一次哈希，未见放大。`PushGate` 每次最多扫描 24 小时逐分钟（1440 次）属旧行为，未改。
- 规则/说明/代码一致性（读代码证实）：意见 4、5、6；另有作者材料“已明写 classes 的旧规则不自动加”与代码不符。

## 对作者说法的核对

- 说法 1（`pushClassOf` 对 `kind=reminder` + `said:` 返回 `her_words`）：属实，`web-push-gate.ts:65-70`；`kind` 不是 reminder 时仍落 `unknown`，与说法一致。
- 说法 2（`startedBy`/`replyMessageId` 查询在真实 SQLite 上正确、取最后一条已提交 agent 消息）：属实，`sqlite-web-push-operations.ts:718-748`；且回话消息与 `runs.status='completed'` 在同一事务里提交，见 `sqlite-thread-operations.ts:1247-1275`，不存在“先完成再补消息”的空档。
- 说法 3（`herWordsPushKey` 不同事件不撞编号，含分隔符和超长）：属实，三段“长度:内容”+ 超 256 用 SHA-256 前 32 hex；测试 `her-words-push-key.unit.test.ts`。
- 说法 4（打开记录表收 `kind=reminder`）：属实，`20261114154943_apple_push.sql` 的 `web_push_feedback` CHECK 含 `reminder`，`sqlite-web-push-operations.ts:609-621` 从 outbox 抄 kind。
- 目标和约束里“已明写 classes 的旧规则不自动加”：不属实，见意见 5。
- “本 PR 让可见先于安静时段延后判断”：属实，`production-web-push.ts:581-585` 在 `#deferred` 之前 `if (visible) return false`。
- 规格里“旧规则都带着当时的默认类别”：不属实，见意见 5。

## 必答问题

1. **会不会改变模型已见过的请求开头？** PR 617 部分：会按规则换新一次，而不是纯追加——`rule_set` 的 `classes` enum 从 3 种变 4 种、`maxItems` 变更，属于 `prompt-prefix.md` 第 6 条“工具名或参数结构变了”的换新，老对话在下一轮开始换新一次；除此之外没有新增每轮变化的值，安静时段/推送内容都不进系统提示。增量里合并进来的 `chat.identity` 是纯提示词文字改动，按第 6 条只对新对话生效；`tool_result_recall` 新增工具名及旧工具结果清理会改写前缀，也都属于第 6 条/第 14 条的既有例外，且不属于 PR 617 本身的改动。
2. **同一段文字会不会变不同字节？** PR 617 不涉及。`ruleSource` 先对 origins 去重排序再 SHA-256、`herWordsPushKey` 用 SHA-256、安静时段 summary 按固定类别顺序拼，均确定；未发现依赖时间或前后文的字段。合并进来的工具结果清理按历史重放计算，设计上确定，但我未逐分支验证（未核实）。
3. **有没有自动检查、反向用例真的会失败？** 有。`production-web-push.test.ts` 的 `[SAID-1]/[SAID-2]/[SAID-3]` 覆盖：她的话只推一次、外部事件不推、定时照旧、已删回话不推、敏感内容不上锁屏、读不出只放弃一条、旧 `run_result` 规则管她的话、不含 `run_result` 的旧规则不管、可见时不弹；`production-memory-capture.test.ts` 覆盖通知页读写、并发保存、挂起规则、多时段只读、长来源截短。反向用例有真实断言（例如重复入队返回 0、读不出时失败数组只含该错误）。缺口：意见 1（参数损坏）、意见 4/6（说明与规格）没有对应测试，意见 7 的 `room<=17` 分支无测试。
4. **改动产生/修改的每个值，使用它的地方都能接受吗？** 逐项核对：
   - `said:` 编号：`web_push_outbox`/`web_push_feedback` 的 `source_key` 1..256、`source_ref` 1..256、`tag` 1..64 都能接受；`webPushTopic` 输出 32 位 base64url，符合 `NOTIFICATION_ID`；`pushClassOf` 认它，`#content` 有对应分支；`kind=reminder` 在两张表的 CHECK 里。
   - `her_words` 类别：`PUSH_QUIET_CLASSES`、`rule_set` enum/maxItems、字段目录、`prompt-manifest`、数据导出标签、`pushClassOf` 都接受。
   - `startedBy`/`replyMessageId`：SQL 返回 `triggers.source_type` 的三个值，与 `WebPushFinishedRun` 联合类型一致；回话消息 id 可作 `sourceRef`，读取端按 agent 消息过滤。
   - `ruleSource`：≤256，符合 `rule_book_rules.source` 的 CHECK；新加的 `~hash` 片段未发现解析它的地方（只作为来源展示）。
   - `quiet_hours.read/set`：契约、客户端能力表、控制类、`operations-pending` 键名一致；`service-main` 去掉 `externalContent` 后全仓库已无 `readUntrustedContent`/`untrustedOriginAllowed` 引用。
   - 未核实：`quiet_hours.*` 的真实 iPhone 调用方（材料称在 PR 615）。

**查过的范围**：`git diff --stat` 与 `git log`（确认增量里 PR 617 的净代码只有 `ruleSource`）；`production-owner-rules.ts`、`production-web-push.ts`、`rule-types.ts`、`web-push-gate.ts`、`service-main.ts`（`readPushRules`/`readMessage`/组合）、`sqlite-web-push-operations.ts`、`sqlite-thread-operations.ts`、`sqlite-run-lifecycle-operations.ts`、相关迁移、`prompt-catalog/src/tools.ts`、`production-memory-capture.test.ts`、`production-web-push.test.ts`、`push-channels`/`sqlite-web-push` 测试、规格文档。合并进来的设备动作授权、工具结果清理、提示词改动只做了直接使用端与悬空引用核对，未逐行复核。
