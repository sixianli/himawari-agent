## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性逐项看过：

- `seedDemoInbox` 四个分支：已断开、已连接示范、`needs_reconnect`、真实连接。发现真实连接和 `needs_reconnect` 会在启动时被无条件替换并释放旧密文。
- 真实 `createGoogleOAuth` 的 `accessToken` / `revoke` 两条路径：`accessToken` 有示范令牌拦截，`revoke` 没有。
- 配置的 `demoInbox` / `gmail` 二选一校验、`runPolicy.timeZone` 校验、`data demo-pack` 的 locale 与输出目录校验：均有校验，未发现越权或路径注入。
- 示范令牌解析、日期计算、`Intl` 时区输入：配置层已校验 IANA 时区；无效 anchor 在 `parseToken` 被拒。
- 密文释放与失败回滚：`saveConnection` 失败时新封装的密文不会被释放，存在泄漏。
- 文档一致性：ADR 0236 第 4 条与第 5 条自相矛盾，且与代码、作者说明都不完全一致。

## 问题（按严重度）

### 1. 高 — 启动时会覆盖并删除真实连接 / 自动恢复 `needs_reconnect`，与作者说法相反

文件：`apps/agent-service/src/production-proactive.ts:234-258`

问题：`seedDemoInbox` 的早退条件只有“已连接且令牌是示范令牌”。只要现有连接是 `needs_reconnect`，或状态是 `connected` 但令牌不是示范令牌（真实 Gmail 连接），即使设置行已存在、且不是用户点“连接 Gmail”，启动时也会继续往下走，替换连接并释放旧 `accountRef` / `tokenRef`。作者说“启动时只在从没开通过才写入；点连接才恢复，并替换不可用的示范连接”，代码不是这样。

证据（亲自读到）：

```ts
// production-proactive.ts:234-240
const existing = await store.readConnection({ ...scope, source: "gmail" });
if (existing?.status === "connected") {
  const token = await seal.open({ ...scope, ref: existing.tokenRef });
  if (token !== undefined && isDemoMailboxToken(token)) return;
}
const settings = await store.readSettings(scope);
if (!existing && !options.restore && settings.updatedAt !== null) return;
```

```ts
// production-proactive.ts:257-259
});
if (released.length > 0) await seal.release({ ...scope, refs: released });
await store.writeSettings({ ...scope, ...settings, enabled: true, now });
```

`saveConnection` 会返回被换下的旧引用（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:430-434`），随后 `seal.release` 删除旧密文。若旧连接是真实 Gmail，这等于静默删除本地 refresh token，且没有调用 `oauth.revoke`，是不可撤销的数据丢失。测试本身也锁定了“直接调用 `seedDemoInbox` 就替换 needs_reconnect”的行为（`test/integration/proactive-production.test.ts:1055-1066`），并不是用户点连接才发生。

另一个后果：该分支无条件写 `enabled: true`，所以用户之前关掉主动提醒、连接又恰好是 `needs_reconnect` 时，重启会被重新打开。

建议：启动与恢复分开。启动路径只在 `!existing && settings.updatedAt === null` 时写入；`options.restore` 才允许替换。替换真实连接时应先确认，或至少撤销旧令牌并记录。把测试改成经 `authorizationRedirect`/HTTP start 触发替换，并新增“启动时不覆盖真实连接”的反向用例。

### 2. 低 — ADR 0236 第 4 条与第 5 条互相矛盾

文件：`docs/adr/0236-trial-users-get-demo-memories-and-a-fake-inbox.md:51-52`

问题：第 4 条仍写“服务启动时写入一条已连接的示范连接”，第 5 条又写“服务启动时只在从没开通过示范收件箱时写入”。第 5 条还说“连接时会被替换”，没有说明普通启动也会替换。

证据：

```md
51: 4. ... 开了之后：服务启动时写入一条已连接的示范连接（令牌里带连接时刻和语言）；...
52: 5. **示范连接的生命周期。** 服务启动时只在“从没开通过示范收件箱”时写入示范连接；...
   已有连接如果不是可用的示范连接（状态不是已连接、令牌不是示范令牌），连接时会被替换。
```

建议：把第 4 条改成“首次启动且从未开通过时”，并把第 5 条的“连接时”明确成“用户点连接时；或按最终决定改成启动时也替换”。

### 3. 低 — 配置 locale 与已存令牌 locale 可以不一致，且不会自动纠正

文件：`apps/agent-service/src/production-proactive.ts:235-237`、`packages/platform-node/src/demo-mailbox.ts:69`

问题：`seedDemoInbox` 只检查令牌“是不是示范令牌”，不检查令牌里的 locale 是否等于当前 `configuration.demoInbox`。而读取器实际从令牌里解析 locale：

```ts
// demo-mailbox.ts:69
items: demoMailScript(parsed.locale, parsed.anchor, timeZone)
```

所以把配置从 `demoInbox: "ja"` 改成 `"en"` 后，旧连接因 `isDemoMailboxToken` 命中而早退，收件箱继续发日语邮件，和配置不一致。作者“demoInbox 只从 configuration 读”的说法在 locale 这一项上不成立，locale 实际持久化在连接令牌里。

建议：解析令牌后比较 locale 与 `configuration.demoInbox`，不一致时按恢复路径重建；或把 locale 从令牌中派生改为从配置传入。至少加一条 locale 变更的测试。

### 4. 低 — 真实 OAuth 的 `revoke` 没有拦截示范令牌

文件：`packages/platform-node/src/gmail-source.ts:130-131`、`packages/platform-node/src/gmail-source.ts:145-152`

问题：`accessToken` 会拒绝示范令牌，但 `revoke` 没有。演示模式下用的是 `createDemoGoogleOAuth`，当前不会联网；但如果实例配置从 `demoInbox` 切到真实 `gmail`，而库里还留着示范连接，断开时 `production-proactive.ts:672-678` 会把 `demo-inbox:v1:...` 发到 Google 的 revoke 端点。这虽不是泄密，但和“示范令牌不会发给 Google”的目标不一致。

证据：

```ts
// gmail-source.ts:130-131
async accessToken(refreshToken, signal) {
  if (isDemoMailboxToken(refreshToken)) throw new GoogleUnauthorizedError();

// gmail-source.ts:145-152
async revoke(value) {
  const response = await send(GOOGLE_REVOKE_ENDPOINT, {
```

建议：`revoke` 同样先判断 `isDemoMailboxToken`，直接返回 `true`；或在 `proactive.source.manage` 里按令牌类型分派。

### 5. 低 — 新测试没有进入专用检查，且“用户重连”用例名不副实

文件：`scripts/check-data-export.mjs:8-15`、`test/integration/demo-data.test.ts:312`、`test/integration/proactive-production.test.ts:1042-1067`

问题：`check:data-export` 只跑固定四个文件并要求 `[P1-6]`，不包含 `test/integration/demo-data.test.ts`（该文件用 `[P6-demo]`）。因此 ADR 0236 所说“导出格式变化时 demo-data 测试会失败”只有在跑全量测试/覆盖率时才成立，单独跑数据导出门槛不会发现示范包格式回归。另外 `proactive-production.test.ts:1042` 的用例名说“when the user reconnects”，实际直接调用 `seedDemoInbox()`，验证的是启动式替换，正好没有覆盖用户点连接路径。

建议：把 demo 相关测试纳入专门的 `check:data-export` 或新增 `check:demo`；把重连用例改成走 `authorizationRedirect`/HTTP start。

### 6. 低 — `saveConnection` 失败时新封装的密文不会被释放

文件：`apps/agent-service/src/production-proactive.ts:246-251`

问题：两次 `seal.seal` 在 `store.saveConnection` 参数求值时就已写入荷载；若 `saveConnection` 或后续 `writeSettings` 抛错，`seedDemoInbox` 没有清理这些新引用。反复失败会留下无主密文，属资源泄漏。同样模式在 `completeAuthorization` 也存在，但本轮新增了启动/重连路径。

证据：

```ts
accountRef: await seal.seal({ ...scope, text: DEMO_MAILBOX_ACCOUNT, at: now }),
tokenRef: await seal.seal({
  ...scope,
  text: demoMailboxToken(demoInbox, now),
  at: now,
}),
```

建议：先记录新 ref，在 `catch` 里 `seal.release` 再抛出；或在 `saveConnection` 成功后才写第二个引用。

## 读代码证实的 / 推测

**读代码证实：**
- 启动替换 `needs_reconnect` 和非示范令牌连接的分支确实存在，且会释放旧密文、写 `enabled: true`。
- ADR 0236 第 4、5 条文字自相矛盾。
- 示范连接读取器从令牌解析 locale，不看配置。
- 真实 `revoke` 没有示范令牌拦截。
- `check:data-export` 不包含 `demo-data.test.ts`。
- 日期计算按传入时区取年月日，再用 UTC 做日历日加减；跨 DST 用例的期望值可由此得出。

**推测：**
- “真实 Gmail 连接在 demoInbox 实例里被覆盖”需要实例曾用真实 `gmail` 配置、之后切到 `demoInbox` 才会发生；该场景是否真实存在未知，但代码路径成立。
- `Intl` 时区数据库版本差异可能让不同运行时对同一时区算出不同结果，但同一部署内不会逐请求变化。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会新增或改写系统提示、工具定义、历史消息、遮盖结果。此改动只增加示范记忆包、示范收件箱和配置分支。主动提醒的 `proactivePrompt` 仍是固定指令在前、本轮资料在中、`now`/`today` 在最后（`packages/application/src/services/proactive-mail-check-service.ts:437-480`），示范邮件属于“本轮资料”，不是请求头。发给模型的内容没有因为本改动引入“改写历史”；主动提醒本身也不是追加式对话。**结论：没有改变已发前缀；每轮会变的时间和时区仍在最后。**

2. **同一段文字会不会在不同请求里变成不同字节？**
   同一连接、同一时区下，示范邮件正文和日期是确定的。会变的是：重连后 anchor 改变，示范邮件日期和 `receivedAt` 全变；配置的 `runPolicy.timeZone` 改变，日期也会变。这些属于“连接/配置变化后的新数据”，不是每次请求随机变化。没有引入无序集合：邮件按 `receivedAt` 排序，清单文件按路径排序，记忆和人物顺序固定。需要注意的是，令牌里的 locale 和配置 locale 可能不一致，导致“同一配置在不同历史连接下”生成不同语言的邮件。

3. **有没有自动检查，反向用例真的会失败吗？**
   有：`test/integration/demo-data.test.ts` 覆盖示范包导入、二次导入被拒、无真实域名/机密、假收件箱时序、不联网、真实 OAuth 拒示范令牌、跨 DST 日期；`test/integration/proactive-production.test.ts` 覆盖断开重启不自动恢复、`needs_reconnect` 替换、无 Google 调用。按旧实现推演，这些反向用例确实会失败（旧 `seedDemoInbox` 在无连接时会重新写入；旧 `localDate` 固定用 locale 时区，Kiritimati 会得到 Nov 6 而不是 Nov 7；无守卫时真实 OAuth 会调用 fetch）。
   缺口是：没有“启动时不覆盖真实连接”的反向用例；“用户重连”测试实际调用的是 `seedDemoInbox`；`check:data-export` 不包含 demo 测试文件。

4. **每个值的使用方都能接受吗？**
   - `demoInbox: "ja" | "en"`：严格配置校验了二选一和枚举，`service-main`、`production-proactive` 都按它分叉；通过。
   - `gmail?`：改为可选后，唯一读取处用 `requireValue`，配置保证非空；通过。
   - `DEMO_MAILBOX_TOKEN_PREFIX` / `demoMailboxToken`：生产、解析、真实 OAuth 拦截三处使用同一常量，格式一致；通过。
   - `DEMO_MAILBOX_ACCOUNT = "demo@himawari.example"`：写入密文后只用于展示和读取，没有后端格式校验；通过。
   - `DEMO_MAILBOX_SETTINGS_RETURN` 的 `gmail=demo`：控制台 `GmailOutcome` 和 `readLaunchIntent` 已接受 `demo`，通过。
   - demo-pack 的记忆/人物 id、`supersededBy`、`personIds`、manifest 计数：导入校验和集成测试确认可接受；通过。
   - **不一致的两处**：令牌 locale 与配置 locale 未互相校验；真实 OAuth `revoke` 未拒绝示范令牌。这两处是生成端与消费端校验不对齐的地方。
