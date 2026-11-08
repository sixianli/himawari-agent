# 方案审核结论

## 证实的（按严重度从高到低）

**1.【高】退出登录的验收断言在当前验收环境里不可能成立，方案没有写出必需的 harness 改造。**
证据：`test/fixtures/product-path-harness.ts:868-878` — front 代理对**每一个**浏览器请求都现签一个新的 `cf-access-jwt-assertion` 注入上游，无任何登录状态；`apps/control-center/src/browser-entry.ts:54-58` — 401 时 Access 模式会走 `createBrowserSession` 静默换会话（ADR 0095）。所以“跳 `/cdn-cgi/access/logout` 清 cookie、断言退出后再进页面需要重新登录、API 401”不成立：模拟发行方在自己的 origin 上清 cookie，既不清应用 origin 的 `himawari_session`，也拦不住 front 继续注入新 assertion，页面会静默重新登录。
建议：方案必须写明 harness 要加“已登出”状态位——logout 后 front 停止注入 assertion（或返回模拟 Access 登录页的 302），重进需先模拟重新认证；退出后再访问才能断言 401/重新登录。

**2.【高】Access 模式退出缺服务器端会话撤销，只跳 Cloudflare 登出达不到退出的业界语义。**
证据：`apps/agent-service/src/production-http-composition.ts:737-767` — `/api/identity/v1/logout`（撤销会话，`packages/platform-node/src/built-in-identity-routes.ts:140-146`）只在 `identity.kind === "built-in"` 时注册；Access 模式同样创建产品会话（`packages/platform-node/src/identity-gateway.ts:1042`）且静默交换会**复用**旧会话（`identity-gateway.ts:622` `findSessionByAuthenticationRef`）。方案只“跳 /cdn-cgi/access/logout 并先清本地私密视图”，`himawari_session` 仍有效，重新登录后沿用旧会话——退出没有撤销任何东西。业界要求 logout 必须使服务器端会话失效：OWASP Session Management Cheat Sheet，https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#logout-web-app 。对比：Cloudflare 官方确认 `/cdn-cgi/access/logout` 是应用域名的正式登出端点（https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ ），方案选的跳转地址本身没问题。
建议：先调服务器端撤销产品会话（为 Access 会话注册 logout 路由，复用 `SessionDeviceStatePort.revokeSession`），再清本地私密视图，再跳 `/cdn-cgi/access/logout`。

**3.【中】第 4 条“门槛”只列了两处同步点，实际要同步四到五处，漏一处就全挂。**
证据：新增场景名需要出现在 ① `scripts/delivery-mode/browser-acceptance-gate.py:5-24` REQUIRED_SCENARIOS；② `test/integration/product-path-browser.test.ts:5477-5496` RELEASE_ACCEPTANCE_SCENARIOS + `await scenario("...")` 用例体；③ `test/tooling/release-walkthrough-coverage.test.mjs:8-32` WALKTHROUGH_COVERAGE（settings 行要加退出场景，memory 行加增改删）；④ `scripts/delivery-mode/test_deploy.py:17` 的独立 SCENARIOS 列表——它生成 deploy 测试的假 walkthrough.json，漏改则所有 deploy 测试因 `BROWSER_ACCEPTANCE_NOT_PASSED` 失败；⑤ 若内置变体场景进门槛，还要改 `product-path-browser.test.ts:5718-5719` 的 walkthrough.json 结果过滤。
建议：方案里把同步点逐个列出。

**4.【中】推翻 ADR 0105 的决定却没有提出更新它，文档会与代码不一致。**
证据：`docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md:77` “数据页放‘这台设备 · 退出登录’。没做：……网页里没有可以退出的会话，放按钮也不会生效”。这个理由在 ADR 0095（Access 静默换会话）之后已不成立，方案正是要推翻它，但没提更新 ADR 0105、README（`README.md:283`）和 runbook（`docs/runbooks/production-web-entry-runbook.md:69` 已在用 `/cdn-cgi/access/logout`，一致）。
建议：方案加一条“更新 ADR 0105 / 新 ADR，说明 Access 会话确实存在、退出撤销它”。

**5.【低】内置账号变体如果不进门槛，就没有任何自动检查守护，会腐烂。**
证据：walkthrough.json 只保留 `RELEASE_ACCEPTANCE_SCENARIOS` 内的场景结果（`product-path-browser.test.ts:5718`），gate 只查 REQUIRED_SCENARIOS。方案没说变体场景是否入门槛。
建议：至少把 `accept-builtin-login`（登录）入门槛；“只跑少量场景、不复制 18 个”是对的。`admin-cli account` 命令存在（`apps/admin-cli/src/account-command.ts`），建号方式可行；配置校验在 `packages/platform-node/src/strict-configuration.ts:640-673`，harness 需要新写一份 built-in 配置构造。

## 推测

- 生产上 Access 登出后重新访问，可能因 IdP（Gmail）会话仍在而静默重登（Cloudflare 文档：token 在 20-30 秒内停止接受；IdP 会话存活时通常是静默跳转）。验收断言和生产预期都应写成“重新经过 Access 认证”，不承诺“必须重输验证码”。
- “删除后检索不到”反向用例要经 `UI.memoryFoundStep`（先例 `product-path-browser.test.ts:5793-5803`），但验收配置 `maxSelectedMemories: 0`（`test/fixtures/product-path-configuration.ts:169`）——自动带上的记忆为 0，检索走哪条路径未核实，方案应写明用哪一步证明“检索不到”。

## 侧重检查

走的流程：打开首页 → 发消息 → 打开记忆页 → 添加 → 编辑 → 删除 → 从“最近删除”恢复（对照 `apps/control-center/src/components/memory-page.tsx` 与三语文案 `memory.page.add/editAction/deleteAction/recover/trashNote`，功能确认存在，7 天回收）。结论：
- UI 交互有单元测试（`apps/control-center/test/memory-interactions.unit.test.ts`）；发布验收只有 `accept-memory-page`“打开无错”（`product-path-browser.test.ts:5914-5923`），增改删删后检索无验收覆盖——方案第 1 条补的正是这条空缺，方向正确。
- 设置退出路径：`app.tsx:559-563` settingsAccount 只在 built-in 时渲染 `SignOutSetting`（确认“设置里只在内置账号显示退出”属实）；Access 分支不存在，方案新增；`accept-phone-layout` 遍历设置标签页会路过新按钮但只查布局。
- 文档与代码不一致的既有问题：`docs/lessons.md:715` 仍写“7 项检查”，实际 gate 已 18 项；方案加场景时应顺手修正，否则更不同步。

## 如果由我来定

1. 记忆增、改、删、恢复、删除后检索不到，照 `accept-unrelated-no-memory` 的先例加入发布验收；反向用例写明经 `memoryFoundStep` 断言；同步第 3 条列的全部 4-5 处。
2. Access 退出改为三步：服务器撤销产品会话 → 清本地私密视图（复用 `clearPrivateViewState`，`app.tsx:299-304`）→ 跳 `/cdn-cgi/access/logout`；harness 加登出状态位使反向断言真实成立。
3. 内置变体单独安装、跑登录/发消息/退出，`accept-builtin-login` 入门槛。
4. 更新 ADR 0105、README、lessons.md（含修正“7 项”旧数）。

必答问题：
1. **不会。** 改动只在验收测试、设置页渲染层和验收 harness，不触及请求组装（系统提示、工具定义、历史、遮盖）；记忆增删改发生在验收环境数据里，“每轮选中的记忆”本就允许每轮变化且只在最后一条消息里（规则第 2 条、ADR 0104）。发给模型的内容仍只在末尾追加。
2. **不会。** 新增值只有静态场景名、静态定位器和静态路径 `/cdn-cgi/access/logout`；walkthrough.json 里的时间戳不进模型请求。
3. **有，反向用例真会失败。** 覆盖表与 gate 集合强等、每入口必列（`release-walkthrough-coverage.test.mjs`，自带反例 96-114 行）；gate 拒绝缺场景由 `test_deploy.py:399/406` 反向验证。但反向检查护不住 `test_deploy.py:17` 和文档——漏改前者会让 deploy 测试全挂（也算失败，但报错远）；文档无检查。
4. 逐值：新场景名——四处使用点都有集合校验（见上）；`/cdn-cgi/access/logout`——Cloudflare 官方端点、runbook 已在用；设置按钮——复用现有 `account.signOut` 三语文案与 `identityMethod` 状态，无新校验面；若采纳服务器撤销——复用 `revokeSession`，审计事件名要与既有 `revokeSession` 调用方一致（I-73 的教训：新 id/键先对后端校验）。
