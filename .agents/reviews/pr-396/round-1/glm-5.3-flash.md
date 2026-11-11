# 复核报告：PR 396（示范记忆包 + 假收件箱）

## 侧重检查（走过的流程与结论）

我按「体验者从启动到收到提醒」的普通流程走了一遍：

1. **配置进入**：`strict-configuration.ts` 的 `parseProactive`（1013-1102 行）校验 `demoInbox`（`isDemoLocale`、与 `gmail` 恰好二选一）→ `parseProductConfiguration`（1516-1526 行）对 demo 模式跳过 Gmail 密钥引用校验。结论：校验闭合，未知键仍被拒绝（`demoInbox` 已加入允许键清单，1016 行）。
2. **服务组装**：`service-main.ts:1596-1628` 按/demoInbox 选择 demo OAuth 与 demo reader → `production-proactive.ts:217-228` `start()` 播种 → `seedDemoInbox`（230-253 行）写 sealed 连接并打开开关。
3. **一次检查**：`proactive-mail-check-service.ts:782-796` 用 `seal.open` 取令牌 → `reader.fetch` → `demo-mailbox.ts` 的 `arrived`/`fetch`（相对 anchor 的到达时间过滤、cursor 语义）→ `related` 走 `findRelatedMail` + 内存 transport（接口与 `gmail-related.ts:72-76` 一致）→ 进模型。**这条主链路有集成测试覆盖**（proactive-production.test.ts [P6-demo] 两例）。
4. **设置页流程**：`/google/start` → `authorizationRedirect`（255-262 行）→ 303 到 `/?settings=apps&gmail=demo` → 控制中心 `readLaunchIntent`（proactive.ts:350）→ i18n 三语消息 + data-tone。
5. **断开/重连**：`production-proactive.ts:659-672` 断开走 `oauth.revoke`（demo 返回 true，不联网）→ 重连走 `authorizationRedirect` 重新播种。有反向测试。

**无测试覆盖的路径**：
- `service-main.ts:1596-1628、1714-1720` 的 demoInbox 组装分支——没有任何测试用 demoInbox 配置真正跑过 `runAgentService`；两处集成测试都是直接 `new ProductionProactive(...)` 手工拼装（proactive-production.test.ts:225、291-292），绕过了 service-main。如果组装写错（例如 reader 仍选了 `createGmailReader`），现有测试全绿。
- `production-proactive.ts:221-227` `start()` 里的播种分支——测试只直接调 `seedDemoInbox()`，没经过 `start()`。
- `seedDemoInbox` 失败路径（seal 失败后 tick 仍会跑）。

## 发现的问题（按严重度从高到低）

**1.【中】service-main.ts:1714-1720 — demo 组装路径零测试覆盖**
证据：grep 全仓库 `demoInbox`，测试只出现在 `proactive-production.test.ts`（直接构造 ProductionProactive）、`startup-configuration.unit.test.ts`、`demo-data.test.ts`、控制中心单测；没有用例从 `runAgentService` 入口带 demoInbox 配置走完。
建议：加一条端到端用例（可仿照 `production-http-composition-process.test.ts` 的做法），用含 `demoInbox` 的配置启动真实服务，断言不产生任何对外 fetch。

**2.【中】service-main.ts:1618-1620 — demo OAuth 的兜底条件方向危险且冗余**
证据：
```ts
const oauth =
  demoInbox || !proactiveGmail || !proactiveSecret
    ? createDemoGoogleOAuth()
    : createGoogleOAuth({...});
```
`!proactiveGmail || !proactiveSecret` 这两个分支在严格配置下不可达（strict-configuration.ts:1043-1044 强制二选一；1519-1526 行保证 gmail 存在时密钥引用已校验），但它们的存在意味着：将来若校验放松或字段改名，生产实例会**静默**换成 demo OAuth（“连接 Gmail”永远只回示范收件箱），而不是启动报错。
建议：改成只按 `demoInbox` 分叉，gmail 分支缺件时抛错。

**3.【低】production-proactive.ts:235-250 — seedDemoInbox 丢弃 `saveConnection` 返回的 released refs，且有并发竞态**
证据：`seedDemoInbox` 先 `readConnection` 判空再 `saveConnection`，返回值被忽略；对比 `completeAuthorization`（359 行）会 `seal.release(released)`。`start()` 播种与用户点击“连接 Gmail”（`authorizationRedirect` → 257 行再次 `seedDemoInbox`）并发时，两次都通过判空会导致一条 sealed 密文泄漏不释放（不泄密，只是垃圾）。另外 `start()` 播种失败（226 行 catch 后仍 `then(() => this.tick())`）会带着无连接状态进入周期检查。
建议：播种也 release 返回值；播种失败时跳过首次 tick 或记日志。

**4.【低】ADR 0236 与代码数字不符**
证据：docs/adr/0236 第 48 行说“包里是 17 条记忆”，第 72 行说“只有 7 天内的 12 封”。实际 `MEMORY_SPECS` 有 16 条（demo-persona.ts:126-321 的 key：job、home、cat、coffee、materials、night、sister、lead、studio、project、review、marathon、mugs、gym-old、gym、music），`MAIL_SPECS` 有 13 封（338-547 行，offset 全部在 ±5 天内）。两个数字都差 1，疑为按草稿写的。
建议：改成 16 条、13 封，或写“以代码为准”。

**5.【低】demo-mailbox.ts:15 与 demo-persona.ts:5 — 同一常量重复定义**
证据：`DEMO_MAILBOX_ACCOUNT = "demo@himawari.example"` 与 domain 包的 `DEMO_OWNER_ADDRESS = "demo@himawari.example"` 值相同但各自定义，改一处不改另一处会造成人设与账户不一致。
建议：platform-node 从 domain 引入，或加一条测试断言两者相等。

## 读代码证实的（作者说法核对）

- 「不改表」：属实，diff 中无 migration 文件。
- 「示范令牌存在 sealed 连接里，只由 demo reader 解析」：属实（production-proactive.ts:240-244 加密；解析只在 demo-mailbox.ts:23-33；反向用例验证非 demo 令牌返回 `unauthorized`）。
- 「邮件按相对连接时刻的分钟数到达，连接前的邮件只作相关旧邮件」：属实（demo-mailbox.ts:92-97 `arrived` 全池含负 offset；`fetch` 的 111-113 行把 `receivedMs < anchorMs` 的排除在推送外，只留给 `related` 查询）。
- 「同一 now 同字节（有测试）」：属实（demo-data.test.ts:159-164），且 `demoMailScript` 的 `{day+N}` 用 `Intl` + 固定 IANA 时区（demo-persona.ts:613-622）计算，确定。
- 「demoInbox 由 isDemoLocale 校验、与 gmail 二选一」：属实（strict-configuration.ts:1040-1044），反向用例（同时写、都不写、`zh-CN`、`""`、`true`）都指向真实的 throw 路径。
- 「假登录换不出令牌、断开不联网」：属实——demo 模式下 `authorizationRedirect` 不注册 state，`completeAuthorization` 在查 pending 时就失败，走不到 `oauth.exchange`/`readAccount`（真实网络调用只在 completeAuthorization:341，demo 下不可达）；demo OAuth 的 exchange 抛错、revoke 不联网（demo-mailbox.ts:133-143），且有 fetch spy 反向用例（demo-data.test.ts:299-307）。
- 「示范包能被现有导入接受、二次导入被拒、坏 locale 被拒」：属实，均由 `demo-data.test.ts` 对真实 `importPortableExport`/CLI 验证，`policyVersion: "demo-pack-v1"` 只受 `text(1,512)` 约束（schemas.ts:82），无需登记。

## 推测（未核实）

- 各测试实际能否通过（我只能读不能跑）；但反向用例的断言我都对照到了产生失败的真实校验代码。
- `Intl` 在不同 ICU 版本下 `{day+N}` 渲染是否逐字节一致（同机部署内确定，跨环境理论上有差异，未见相关测试）。

## 必答问题

1. **请求开头**：不会变。diff 未触及任何提示词组装、工具定义、历史存储或遮盖代码；示范邮件与真实邮件走同一个 `ProactiveSourceReader` → `proactive-mail-check-service` 管线，作为本次检查的数据进入后台调用末段（符合 prompt-prefix 规则第 15 条）；示范记忆经普通导入成为普通记忆，仍按既有规则放最后一条消息。集成测试断言了提示词包含示范内容且不包含被过滤的促销邮件（proactive-production.test.ts:989-993）。发给模型的内容仍只追加。
2. **字节确定性**：是确定的。示范包同一 `now` 同字节（有测试）；邮件日期由令牌里固定的 anchor + 每语言固定时区推出；邮件按 receivedAt 字符串排序、offset 互不相同，顺序固定；`demoMailScript` 用 `Intl` 格式化，属环境级确定。同一连接内同一段文字每次序列化字节相同。
3. **自动检查**：有，且我逐条核对了反向用例指向的校验代码（配置二选一、locale 白名单、二次导入 `TARGET_NOT_EMPTY`、非 demo 令牌 `unauthorized`、fetch spy 断言零网络请求、伪造回调 state 失败）。但见问题 1、2：`service-main` 组装路径和 `start()` 播种分支没有测试——反向用例对“改错组装”不会失败。
4. **每个新值的两端核对**：
   - `demoInbox`（配置键）：strict-configuration 产生并校验 → service-main、ProductionProactive 消费，类型 `ProactiveConfiguration.demoInbox?`，文档已更新（specs 299 行）。✅
   - 示范令牌 `demo-inbox:v1:<locale>:<anchor>`：seedDemoInbox 产生并 seal → 检查服务 seal.open → 仅 demo reader 解析；anchor 含冒号但 `indexOf` 取第一个冒号，拆分正确。✅
   - `DEMO_MAILBOX_ACCOUNT`：产生（demo-mailbox.ts:15）→ seal 存为 accountRef → overview 展示（有测试断言）。✅（但与 `DEMO_OWNER_ADDRESS` 重复定义，见问题 5）
   - `DEMO_MAILBOX_SETTINGS_RETURN` = `gmail=demo`：产生（demo-mailbox.ts:16）→ HTTP 303 → `readLaunchIntent`（已加 `demo` 分支）→ i18n 三语 `proactive.apps.outcome` + `data-tone`（已改）。✅
   - `demo-<locale>-memory|person-<key>` id：产生（demo-pack.ts:41-47）→ 真实导入通过（含 `supersededBy` 交叉引用、personIds 外键，有 DB 断言）。✅
   - `policyVersion: "demo-pack-v1"`：仅受 `text(1,512)` 约束，无枚举校验，导入通过。✅
   - CLI `data demo-pack --locale --out`：参数解析（恰好两个值、无 flag）有反向用例。✅
