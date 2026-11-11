## 一、发现（按严重度）

### 1. 中 — 被保留下来的真实连接，仍会被示范读取器改写 `status` 和 `cursor`

**文件：** `apps/agent-service/src/production-proactive.ts:237-244`、`apps/agent-service/src/service-main.ts:1716-1718`、`packages/application/src/services/proactive-mail-check-service.ts:710-715,797-798,1543-1548`

**问题：** `seedDemoInbox` 现在确实不会替换可读出的真实令牌，但启动流程仍会继续 `tick()`；而读取器是按配置选的，不是按令牌选的。只要 `demoInbox` 配置存在，就用示范读取器去读真实令牌，得到 `unauthorized`，随后 `#needsOwner` 会把这条真实连接改成 `needs_reconnect` 并清空 `cursor`。ADR 0236 第 5 条写的“已有的不是示范令牌的连接……一律不碰”并不成立：令牌和账号没换，但状态和游标被写掉了。

**证据（读代码证实）：**
- `production-proactive.ts:241`：`} else if (!isDemoMailboxToken(token)) return;` —— 真实令牌在这里提前返回。
- `production-proactive.ts:226-228`：`void this.seedDemoInbox().catch(...).then(() => this.tick());` —— 返回后照样检查。
- `service-main.ts:1716-1718`：`reader: demoInbox ? createDemoMailReader(...) : createGmailReader(...)` —— 读取器只由配置决定。
- `demo-mailbox.ts:115-116`：非示范令牌返回 `{ kind: "unauthorized" }`。
- `proactive-mail-check-service.ts:797-798`：`unauthorized` 进入 `#needsOwner`。
- `proactive-mail-check-service.ts:1543-1548`：`markConnection({ status: "needs_reconnect", cursor: null })`。

**推测（有条件）：** 需要实例原来连过真实 Gmail、`proactive_settings.enabled = 1`，后来配置改成 `demoInbox`。ADR 0236 明确提到“实例原来连过真实 Gmail”，所以这是设计上考虑过的状态。

**建议：** 让 `seedDemoInbox` 返回“当前是否有可用的示范连接”，只有确实存在示范令牌时才 `tick()`；或在示范模式下发现连接令牌不是示范令牌时，跳过检查并不要对这条连接调用 `markConnection`。同时补一条测试：真实令牌 + `enabled = true` + `tick()`，断言令牌、`status`、`cursor` 都不变，而不是只测 `seedDemoInbox` 本身。

---

### 2. 中 — 示范模式下断开被保留的真实连接，会删除令牌但不向 Google 撤销，界面却声称已撤销

**文件：** `apps/agent-service/src/production-proactive.ts:683-689`、`apps/agent-service/src/service-main.ts:1618-1619`、`packages/platform-node/src/demo-mailbox.ts:143-145`、`apps/control-center/src/i18n/resources/zh-CN.ts:1145`

**问题：** 在 `demoInbox` 配置下，`oauth` 是 `createDemoGoogleOAuth()`，它的 `revoke()` 对任何令牌都直接返回 `true`，不发请求。若数据库里保留着真实刷新令牌，用户点“断开”时：`oauth.revoke(token)` 空转成功 → `removeSource` 删除连接 → `seal.release` 删除密封内容。结果是本地不可逆丢失真实令牌，但 Google 那边的刷新令牌仍然有效，界面还提示“已断开，并在 Google 撤销了授权”。

**证据（读代码证实）：**
- `production-proactive.ts:683-689`：读出 `token` 后调用 `this.#options.oauth.revoke(token)`，之后 `removeSource` 并释放引用。
- `service-main.ts:1618-1619`：`demoInbox` 为真时固定构造 `createDemoGoogleOAuth()`。
- `demo-mailbox.ts:143-145`：`async revoke() { return true; }`。
- `zh-CN.ts:1145`：`"已断开，并在 Google 撤销了授权。"`

**建议：** 断开前先判断令牌是不是示范令牌；不是示范令牌时，要么用真实 OAuth 凭据执行撤销，要么拒绝删除并提示无法在体验配置下撤销，至少不能显示“已在 Google 撤销”。这条路径也应加测试。

---

### 3. 低 — `demoMailboxTokenLocale` 只看前缀和语言，不校验完整示范令牌

**文件：** `packages/platform-node/src/demo-mailbox-token.ts:3-5`、`packages/platform-node/src/demo-mailbox.ts:25-35`、`apps/agent-service/src/production-proactive.ts:241-243`

**问题：** `demoMailboxTokenLocale("demo-inbox:v1:ja")` 也会返回 `"ja"`。如果这种缺少 anchor 的损坏令牌恰好 `status === "connected"` 且语言匹配，`seedDemoInbox` 会认为它是可用示范连接而直接返回。真正的读取器 `parseToken` 会因 `separator < 0` 判定为无效并返回 `unauthorized`，连接随后才会被改成 `needs_reconnect`，下次启动才可能修复。也就是说，损坏但语言匹配的令牌不会在启动或点连接时立即被替换。

**证据（读代码证实）：**
- `demo-mailbox-token.ts:3-5`：只做 `startsWith` 和 `slice(...).split(":", 1)[0]`。
- `demo-mailbox.ts:29-34`：完整解析要求有分隔符、合法 locale 和可解析的 anchor。
- `production-proactive.ts:241-243`：只比较 `demoMailboxTokenLocale(token) === demoInbox`。

**建议：** 从 `demo-mailbox.ts` 导出一个完整的示范令牌校验/解析函数，`seedDemoInbox` 用它判断“可用的示范连接”，而不是只比较语言。

---

### 4. 低 — 第二次 `seal.seal` 失败时，第一次封装的 `accountRef` 会泄漏

**文件：** `apps/agent-service/src/production-proactive.ts:246-268`

**问题：** 新代码先 `seal` 账号，再 `seal` 令牌；失败释放逻辑只包住 `saveConnection`。如果 `tokenRef` 的 `seal` 抛错，`accountRef` 已经被写入 payload 存储，但没有被释放，也没有被任何连接引用。

**证据（读代码证实）：**
- `production-proactive.ts:246-251`：两个独立的 `await seal.seal(...)`。
- `production-proactive.ts:252-268`：`.catch(...)` 挂在 `store.saveConnection` 上，只释放 `accountRef`/`tokenRef` 当保存失败时；之前的 seal 失败不会进入这里。

**建议：** 把两次 `seal` 和 `saveConnection` 一起放进 `try`，任一步失败都释放已经创建的引用。补一条“第二次 seal 失败”或“saveConnection 失败”的测试；目前保存失败释放路径也没有测试。

---

### 5. 低 — 新增的“真实 OAuth 撤销示范令牌时直接返回”没有测试

**文件：** `packages/platform-node/src/gmail-source.ts:145-146`、`packages/platform-node/test/gmail-source.unit.test.ts:145-173`

**问题：** 本轮新增了 `createGoogleOAuth.revoke` 对示范令牌的短路，但现有测试只验证了真实令牌会发 `/revoke`；`test/integration/demo-data.test.ts:307` 测的是 `createDemoGoogleOAuth().revoke("token")`，不是真实 `createGoogleOAuth` 遇到示范令牌的情况。反向用例缺失。

**证据（读代码证实）：**
- `gmail-source.ts:145-146`：`async revoke(value) { if (isDemoMailboxToken(value)) return true; ... }`。
- `gmail-source.unit.test.ts:171-172`：只测 `client.revoke("refresh-new")` 并核对真实 `/revoke` 请求。

**建议：** 加一条单测：用 `fetch` spy 构造真实 `createGoogleOAuth`，调用 `revoke(demoMailboxToken("ja", ...))`，断言返回 `true` 且 `fetch` 未被调用。

---

## 二、作者说法核对

- “已有连接的令牌若是真实令牌则永不触碰”：**基本成立但不绝对。** 对可读出的非示范令牌，`production-proactive.ts:241` 确实会返回；但 `seal.open` 返回 `undefined` 时，点“连接 Gmail”（`restore: true`）会替换它（`production-proactive.ts:238-240`）。ADR 也明确允许“令牌读不出来也换掉”，所以这是设计选择；作者的说法需要加“可读出”这一限定。
- “示范令牌且语言与配置一致且已连接则不动”：**与代码一致**（`production-proactive.ts:241-243`），但没有校验完整令牌，见发现 3。
- “没有连接时，仅当设置从未写过（`updatedAt` 为空）或 `restore` 时写入”：**与代码一致**（`production-proactive.ts:244`）。
- “保存失败会释放新密封内容，替换成功后释放旧的”：**基本一致**，但“保存失败”仅指 `saveConnection` 失败；seal 阶段失败会漏 `accountRef`，见发现 4。
- “真实 Gmail 的 revoke 遇示范令牌直接返回 true，不发请求”：**与代码一致**（`gmail-source.ts:145-146`）。
- “ADR 0236 第 4、5 条重写；新增两个测试”：**属实。** 两个新测试按旧代码逐行推演都会失败：旧代码会替换可读真实令牌，且对“已连接但语言不符的示范令牌”提前返回、不会替换。
- “本改动不涉及模型请求”：**属实。** 增量没有改 `proactivePrompt`、系统提示、工具定义、遮盖或历史组装。新增的示范邮件数据只作为主动检查的数据源。

## 三、侧重检查

- **错误路径：** 检查了 `seal.open` 返回 `undefined`、`saveConnection` 失败、`seal` 第二步失败、`writeSettings` 失败。发现 4 是 seal 阶段的泄漏；保存失败释放新引用的路径代码存在但没有测试。
- **不合规范/不可信输入：** `demoInbox` 配置由 `isDemoLocale` 严格校验且与 `gmail` 二选一（`strict-configuration.ts:1040-1044`）；示范令牌的完整解析在读取器里严格，但 `demoMailboxTokenLocale` 只做浅校验（发现 3）。示范邮件地址均用 `.example`，未发现向外部发请求的代码。
- **安全：** 真实 `createGoogleOAuth` 的 `accessToken`/`revoke` 都会跳过示范令牌，不会把示范令牌发给 Google；示范读取器也不联网。残留问题是示范模式下断开真实连接不执行远程撤销（发现 2）。
- **资源耗尽：** 每次 seed 最多创建两个密封引用；`saveConnection` 失败会释放新引用，成功会释放旧引用；但 seal 失败会泄漏一个引用（发现 4）。示范脚本固定 13 封邮件，没有无界循环。
- **不可撤销操作：** `removeSource` + `seal.release` 会永久删除连接和密封令牌；在示范模式下可能删除真实令牌而不撤销（发现 2）。
- **规则/文档与代码一致：** ADR 0236 第 5 条“真实连接一律不碰”与 `tick()` 会改写 `status`/`cursor` 不一致（发现 1）；“第一次启动时写入”实际条件是 `settings.updatedAt` 为空，属于用设置是否写过代替“是否开通过示范收件箱”。这两点建议在 ADR 或代码里明确。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加？

**不会。** 本增量只改 `seedDemoInbox`、示范令牌语言解析、真实 OAuth 的 revoke 短路、ADR 和测试；没有改系统提示、工具定义、历史消息、遮盖或上下文组装。主动检查的提示词仍是固定指令在前、本次数据在中、当前时间在最后（`proactive-mail-check-service.ts:453-480`，`renderPrompt(MAIL_JUDGMENT_NOW, ...)` 是最后一个元素），示范邮件数据落入本次数据部分，不会改写已经发出的内容。未实际运行 `npm run check:prompt-prefix`，本次 diff 也没有改这条检查。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**模型请求方面没有发现新增的非确定性。** 示范令牌把 anchor 存在令牌里，邮件日期按 `anchor + offset` 和固定时区计算；`fetch` 按 `receivedAt` 排序，相关邮件排序还有 `messageId` 作为并列时的次序，未见无序集合直接进入提示词。需要注意：修复示范连接时会重新生成 anchor，同一个示范 messageId 的 `receivedAt` 和正文日期会变化；这是“新连接/新数据”，不是改写已经发给模型的历史，但如果关心后台调用之间的缓存复用，应知道这一点。示范数据包的导出对同一个 `now` 是确定性的（测试也这样断言）。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有新增两个反向用例：真实令牌不被替换、语言不符的示范令牌被替换。按旧代码逐行推演，这两个用例在旧代码上都会失败。未实际运行测试（本次只能用 git/read/grep），所以这是推演结论。

覆盖缺口：
- 没有“真实令牌 + `needs_reconnect`”用例；当前代码会保留这类连接，但没有测试锁定。
- 没有“真实令牌 + `enabled = true` + `tick()`”用例；这正是发现 1 的状态改写路径，现有测试因为没写设置、`enabled` 为 false，`tick()` 直接返回，所以测不到。
- 没有保存失败/第二次 seal 失败释放引用的测试。
- 没有真实 `createGoogleOAuth.revoke(示范令牌)` 不发请求的测试。

### 4. 改动产生或修改的每个值，使用两端都能接受吗？

- **`demoInbox` 配置键：** 产生于 `strict-configuration.ts:1040-1044,1098`，使用于 `service-main.ts:1598,1612,1617-1619,1716` 和 `production-proactive.ts:222,233-249,274`。类型为可选 `DemoLocale`，所有使用处都先判空；`runPolicy.proactive` 的 secret 校验也已用 `if (proactive.gmail)` 保护，未发现无保护解引用。通过。
- **示范令牌语言值：** 由 `demoMailboxToken` 产生（`demo-mailbox.ts:21-23`），由 `demoMailboxTokenLocale` 解析，供 `seedDemoInbox` 比较。格式一致；但浅校验问题见发现 3。
- **连接状态 `"connected"`：** seed 写入，`sqlite-proactive-operations.ts:396` 只接受 `connected`/`needs_reconnect`，overview 也接受，通过。
- **`GmailOutcome = "demo"`：** 由 `DEMO_MAILBOX_SETTINGS_RETURN` 产生，`readLaunchIntent` 接受（`proactive.ts:351`），UI 语气（`proactive-settings.tsx:263`）和三种语言的 `proactive.apps.outcome` 都有 `demo` 分支，通过。
- **revoke 返回值：** 调用方只等待、不依赖具体布尔值（`production-proactive.ts:686`），通过。
- **示范数据包 id/清单项：** 本次增量未新增，但相关生产/消费点（`demoMemoryId`、`demoPersonId`、`supersededBy`、`personIds`）在 `demo-pack.ts` 内部一致，集成测试会走 `parsePortable` + `importPortableExport`；未实际运行，标为未核实实测。

**结论：** 第 2 轮指出的“直接替换可读真实令牌”已修复；但“真实连接一律不碰”还没有完全做到——示范模式下的检查会改写其状态和游标，断开时还会在未撤销 Google 授权的情况下删除本地令牌。这两条是本轮最值得继续处理的问题。
