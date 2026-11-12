## 读代码证实的问题

### 1. 中：示范模式下断开遗留的真实 Gmail 连接，会本地删除令牌但不向 Google 撤销，界面却仍声称“已撤销”

- 文件:行：`apps/agent-service/src/production-proactive.ts:696-703`、`packages/platform-node/src/demo-mailbox.ts:143-145`、`apps/control-center/src/components/proactive-settings.tsx:269`、`apps/control-center/src/i18n/resources/zh-CN.ts:1145`
- 问题：`proactive.source.manage` 的断开路径不区分示范令牌与真实令牌。示范配置下 `oauth` 是 `createDemoGoogleOAuth()`，它的 `revoke()` 直接返回 `true` 且不联网；随后 `removeSource()` 删除连接并释放（删除）密封令牌。于是遗留的真实 refresh token 在本地被永久删除，Google 侧却仍然有效。
- 证据：

```ts
// production-proactive.ts:696-703
const connection = await store.readConnection({ ...scope, source: "gmail" });
if (connection) {
  const token = await seal.open({ ...scope, ref: connection.tokenRef });
  if (token) await this.#options.oauth.revoke(token).catch(() => false);
}
const released = await store.removeSource({ ...scope, source: "gmail" });
if (released.length > 0) await seal.release({ ...scope, refs: released });
```

```ts
// demo-mailbox.ts:143-145
async revoke() {
  return true;
},
```

```ts
// proactive-settings.tsx:269 / zh-CN.ts:1145
<output className="proactive-outcome">{message("proactive.apps.disconnected")}</output>
"proactive.apps.disconnected": "已断开，并在 Google 撤销了授权。",
```

- 影响：这是不可撤销的凭据处置错误。真实 refresh token 仍可在 Google 侧使用，本实例失去撤销能力；同时 UI 明确声称已撤销，属于文档/界面与代码不一致。
- 建议：在示范模式下，如果连接里是真实令牌（`isDemoMailboxToken(token) === false`），断开应拒绝或直接不做任何删除，保持连接原样（与 seeding 的“不碰真实连接”一致）；或者至少保留本地令牌并显示准确文案。该判断所需函数 `isDemoMailboxToken` 已在 `production-proactive.ts:44/311` 可用。
- 说法核对：作者说“要修需在示范配置里保留真实 OAuth 凭据，违背二选一”，这个理由不成立。不需要保留 OAuth 凭据，只需在示范模式下对非示范令牌的断开操作返回错误/空操作即可。

### 2. 低：`#checkable()` 在检查 `settings.enabled` 之前读取并解密连接令牌，关闭主动提醒时仍会解密，坏令牌会周期性报错

- 文件:行：`apps/agent-service/src/production-proactive.ts:292-312`、`packages/application/src/services/proactive-mail-check-service.ts:710-715`
- 问题：旧的 `tick()` 先进入 `service.run()`，`run()` 第一步是 `readSettings` + `if (!settings.enabled) return`。现在 `#checkable()` 在 `run()` 之前执行，且不检查 `enabled`；示范模式下即使主动提醒被关闭，每个 tick 也会 `readConnection` + `seal.open`。若令牌 payload 损坏（`unprotect` 抛错），`#checkable` 抛出后走 `onFailure`，关闭状态下也会每 15 分钟报一次错。
- 证据：

```ts
// production-proactive.ts:305-311
async #checkable(): Promise<boolean> {
  if (!this.#options.configuration.demoInbox) return true;
  const { scope, store, seal } = this.#options;
  const connection = await store.readConnection({ ...scope, source: "gmail" });
  if (!connection) return true;
  const token = await seal.open({ ...scope, ref: connection.tokenRef });
```

```ts
// proactive-mail-check-service.ts:712-715
const settings = await store.readSettings(scope);
if (!settings.enabled) return undefined;
const connection = await store.readConnection({ ...scope, source: reader.source });
```

- 建议：在 `#checkable()` 开头先读 `settings` 并遵循 `enabled`；或把“是否可检查”的判断下移到 `run()` 内、在 `enabled` 之后。
- 严重度说明：只影响示范模式，且多数情况下只是多一次解密和一次失败日志，故列为低。

### 3. 低：本轮两处修复没有会在回退后失败的自动检查

- 文件:行：`packages/platform-node/src/demo-mailbox-token.ts:5-13`、`apps/agent-service/src/production-proactive.ts:246-274`
- 问题一：示范令牌新增的“时间戳必须可解析”校验没有测试。现有 `proactive-production.test.ts:1115-1141` 只测了语言不匹配；把 `demoMailboxTokenLocale` 的时间戳判断删掉，该用例仍然通过。全仓测试中出现的 `demo-inbox:v1:` 字符串只有 4 处（`demo-data.test.ts:248`、`proactive-production.test.ts:1139`、`gmail-source.unit.test.ts:178`、源码），没有“语言对但时间戳非法”的用例。
- 问题二：`seedDemoInbox` 的两次 `seal` 与 `saveConnection` 统一释放没有故障注入测试。现有测试没有让第二次 `seal` 或 `saveConnection` 失败并断言已生成的 accountRef 被释放；把这段 try/catch 回退，测试仍会通过。
- 证据：

```ts
// demo-mailbox-token.ts:10-12
const locale = rest.slice(0, separator);
if (!isDemoLocale(locale) || !Number.isFinite(Date.parse(rest.slice(separator + 1))))
  return undefined;
```

```ts
// production-proactive.ts:248-272
try {
  const accountRef = await seal.seal({ ...scope, text: DEMO_MAILBOX_ACCOUNT, at: now });
  sealed.push(accountRef);
  ...
} catch (error) {
  await seal.release({ ...scope, refs: sealed }).catch(() => undefined);
  throw error;
}
```

- 建议：加一条用例：封入 `demo-inbox:v1:ja:not-a-date` 且 status=connected，调用 `seedDemoInbox()` 后应被替换；再加一条通过 stub 让第二次 `seal` 或 `saveConnection` 抛错，断言已封装的 accountRef 被 `release`。
- 对比：`#checkable` 有真正的反向用例（`proactive-production.test.ts:1072-1113`，去掉 `#checkable` 后 `service.run()` 会把真实连接标成 `needs_reconnect`，见 `proactive-mail-check-service.ts:1538-1549`）；真实 OAuth 的 `revoke` 守卫也有反向用例（`gmail-source.unit.test.ts:175-182`，去掉守卫后 `fake.calls` 非空）。

### 4. 低：示范配置下遗留真实连接时，主动检查静默停止，界面仍显示“已连接”

- 文件:行：`apps/agent-service/src/production-proactive.ts:292-312`
- 问题：`#checkable()` 对非示范令牌返回 `false`，`tick()` 直接结束，不产生 decision、不记录原因；而 `overview()` 仍按连接状态显示 connected。体验者/管理员会看到“Gmail 已连接”，但主动提醒永远不会运行，也没有提示。
- 证据：

```ts
// production-proactive.ts:293-294
this.#running ??= this.#checkable()
  .then((checkable) => (checkable ? this.#service.run() : undefined))
```

```ts
// production-proactive.ts:311
return token === undefined || isDemoMailboxToken(token);
```

- 建议：这是可接受设计（不碰真实连接）的可观测性缺口；至少应在 overview/设置页说明“当前为体验版，真实连接不会被检查”，或让 `#checkable` 返回一个可记录的原因。
- 说明：这是代码证实的现行行为；“是否算问题”取决于产品取舍，故列为低。

## 推测 / 未核实

- 未运行测试、类型检查和 lint（工具限制），因此 `let released: readonly string[]` 的跨 try/catch 明确赋值、以及测试是否全部通过，均未核实。
- 未核查主对话的完整记忆注入路径（`thread-prompt-bundle-service` 等）；只核对了主动邮件检查的提示词组装 `proactivePrompt`。因此“demo 记忆不会进入请求开头”这一结论只对主动检查有逐行依据，对主对话属于沿用现有设计。
- 未核实 ADR 0236 中“13 封邮件分布在连接后 5 天内”的 5 天部分；13 封已通过 `MAIL_SPECS` 的 key 计数核对（3 个人物 + 16 条记忆 + 13 封邮件）。
- 未检查 `.agents/reviews/pr-396/round-3` 的内容，工作区是 sparse checkout，这些文件不在当前目录。

## 侧重检查

- 错误路径：
  - `#checkable()` 内 `seal.open` 抛错会进入 `tick` 的 `.catch(onFailure)`，不会静默吞掉；但会在 `settings.enabled === false` 时也发生（见问题 2）。
  - `seedDemoInbox` 第二次 `seal` 或 `saveConnection` 失败时，已封装的 accountRef 会被释放；逻辑正确，但无测试（见问题 3）。
  - `saveConnection` 成功后的旧 refs 释放、`writeSettings` 失败仍无补偿；这是既有行为，不是本轮引入。
- 不可信输入：
  - `demoMailboxTokenLocale` 先检查分隔符再解析，非法 locale/时间戳返回 `undefined`；令牌最终会被替换，不会被误认为合法示范连接。
  - `demo-mailbox.ts` 的 `parseToken` 对非示范令牌、非法 locale、非法时间戳都返回 `undefined`，`fetch` 回 `unauthorized`。
  - `buildDemoPack` 在任何写入前校验 locale；`data demo-pack` 要求严格两个参数且无 flag；`writePortableDirectory` 拒绝非空目标目录，测试覆盖。
- 安全：
  - 真实 Gmail 的 `accessToken`/`revoke` 遇到示范令牌都不发请求，有单测和集成测试（`gmail-source.ts:131/146`）。
  - 示范数据内容不含真实域名（测试检查 `.example`）和机密模式（`createDataExportTextPolicy` 检查）。
  - 主要问题是问题 1：真实 refresh token 本地删除但未撤销，且 UI 声称已撤销。
- 资源耗尽：
  - 示范包大小固定、邮件脚本固定 13 封，没有用户可控的大输入。
  - `demoMailboxTokenLocale` 的 `Date.parse` 只处理本地生成的短字符串。
  - `#checkable` 每个 tick 多一次连接读取和令牌解密，量级很小。
- 不可撤销操作：
  - `removeSource` + `seal.release` 会永久删除令牌 refs；在示范配置 + 真实连接时不可逆且未撤销（问题 1）。
  - `seedDemoInbox({restore:true})` 对“令牌读不出来”的连接也会替换并释放旧 refs；ADR 0236 已明确写入此行为，但无法区分真实令牌，属于同一类风险。
- 规则/文档一致性：
  - ADR 0236 的“二选一启动就拒绝”、启动 seeding、断开不向 Google 发请求、真实读取/撤销路径拒绝示范令牌，均与代码一致。
  - 不一致：界面 `proactive.apps.disconnected` 声称“在 Google 撤销了授权”，示范模式下实际没有发任何请求；遗留真实连接被删除时这句话是假的。
  - 作者关于“修复需要保留真实 OAuth 凭据”的说法与代码能力不一致（见问题 1）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   没有。第 4 轮增量只改 `production-proactive.ts`（连接 seeding 与 tick 门控）、`demo-mailbox-token.ts`（令牌解析）、以及 `gmail-source.ts` 的令牌守卫和测试；这些文件都不参与系统提示、工具定义、历史消息或遮盖逻辑。整个 PR 中进入模型的是示范邮件数据和示范记忆：`proactivePrompt` 的顺序是固定指令 `MAIL_JUDGMENT.text` → 摘要/记忆/邮件数据 → 最后的 `MAIL_JUDGMENT_NOW`（`packages/application/src/services/proactive-mail-check-service.ts:453-480`），会变的值在末尾，符合“只追加、会变的值放最后”的规则。主对话的记忆注入路径本次未改，未逐行核实。
   结论：发给模型的内容仍然只在末尾追加；每轮变化的值（now/today、本批邮件、本轮记忆）都在数据块/最后一段，不在请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会因本轮改动引入新的不确定性：
   - 示范令牌的 anchor 在 seed 时用 `clock.now()` 固定并密封，邮件正文中的日期由 anchor + 配置时区计算（`demo-mailbox.ts:60-73`、`demo-persona.ts:627-651`）；同一连接、同一时区下每次读出的邮件字节相同。
   - 不同实例/不同连接时刻会产生不同字节，但这些内容只进入末尾的数据块，不影响固定前缀。
   - `fetch` 返回的 cursor 是每次 `now` 生成的（`demo-mailbox.ts:128`），但它写入数据库，不进入提示词。
   - `proactivePrompt` 用固定顺序的对象字面量做 `JSON.stringify`，相关邮件按 `receivedAt`/`messageId` 排序；遮盖函数未改。
   未核实：主对话记忆序列化的完整顺序、以及遮盖实现对 demo 数据的具体字节影响（本次未改这些代码）。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   - `#checkable`：有。`proactive-production.test.ts:1072-1113` 在真实令牌连接上 `await tick()` 后断言仍为 connected；去掉 `#checkable` 后 `service.run()` 会因示范 reader 回 `unauthorized` 而调用 `markConnection(needs_reconnect)`（`proactive-mail-check-service.ts:797-798/1538-1549`），用例会失败。
   - 真实 OAuth 拒绝示范令牌：有。`gmail-source.unit.test.ts:175-182` 对 `revoke` 做反向断言（守护去掉后 `fake.calls` 非空）；`demo-data.test.ts:313-325` 覆盖 `accessToken`。
   - 示范令牌“语言 + 时间戳”校验：**时间戳部分没有测试**，现有用例只覆盖语言不匹配（`proactive-production.test.ts:1115-1141`）。
   - `seedDemoInbox` 统一释放：**没有故障注入测试**，回退 try/catch 不会有测试失败。
   - 配置二选一：有，`startup-configuration.unit.test.ts:1473-1506` 覆盖同时写、非法 locale、空字符串、布尔值。
   - 结论：主要修复有真实反向用例；本轮附带的两个防御性修复缺少会失败的检查。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   逐个核对结果：
   - `demoInbox: "ja" | "en"`：产生于 `strict-configuration.ts:1040-1098`（`isDemoLocale` + 与 `gmail` 二选一校验）；使用于 `service-main.ts:1596-1718`、`production-proactive.ts:222-311`、`startup-configuration.unit.test.ts`。`ProactiveConfiguration.gmail` 改为可选后，全仓 `.gmail` 访问点只有 `service-main.ts:1580`/`strict-configuration.ts:1519` 两处，均已判空。接受。
   - 示范令牌字符串 `demo-inbox:v1:<locale>:<anchor>`：产生于 `demo-mailbox.ts:21-23`；使用于 `demo-mailbox.ts:25-36`（完整校验 locale + 时间戳）、`demo-mailbox-token.ts:5-13`（完整校验）、`gmail-source.ts:131/146`（仅前缀守卫）。三处都能接受，且真实 OAuth 路径不会把该令牌发到 Google。
   - 示范记忆/人物 ID `demo-<locale>-memory-<key>` / `demo-<locale>-person-<key>`：产生于 `demo-pack.ts:33-39`；使用于 `memory.id`、`supersededBy`、`personIds`。导入格式只要求 `text(1, 512)`（`schemas.ts:76/91/119/128`），且 `demo-data.test.ts:68-104` 用真实 SQLite 导入并校验 `superseded_by` 与人物关联。接受。
   - `GmailOutcome` 的 `"demo"`：产生于 `proactive.ts:326-350` 与后端重定向 `/?settings=apps&gmail=demo`；使用于 `app.tsx:640`、`proactive-settings.tsx:247-265`，三种语言的 ICU `select` 都加了 `demo` 分支，`proactive-interactions.unit.test.ts` 覆盖。接受。
   - `--locale` CLI 值：`data-command.ts` 要求恰好 `--locale` + `--out`，`buildDemoPack` 在任何写入前用 `isDemoLocale` 拒绝非法值，测试覆盖 `zh-CN`、空串、`JA`、`../ja`。接受。
   - 唯一不能接受的使用点是问题 1 的断开路径：真实令牌被当成普通断开对象删除，却没有走真实撤销。

**总体判断**：第 4 轮的两条中级修复方向正确，`#checkable` 的反向测试是有效的；本轮没有发现新的高严重度问题。需要处理的是示范模式下真实连接的断开语义（问题 1，作者“必须保留真实 OAuth 凭据”的理由不成立），以及两处缺少回退会失败测试的防御性修复（问题 3）。
