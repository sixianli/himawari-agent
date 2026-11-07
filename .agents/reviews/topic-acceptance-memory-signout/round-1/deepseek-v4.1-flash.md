## 结论

记忆的增、改、删应在现有的 **Cloudflare Access 验收环境**里做，不需要为它单独起内置账号环境。退出登录也应该在 Access 环境里做，但**生产设置里现在没有入口，应该补一个指向 `/cdn-cgi/access/logout` 的入口**；补上后，用现有的 Access 假边缘模拟“退出后不再放行”，才能验收。内置账号的浏览器级退出登录本次不建议加进发布门槛：生产不用它、已有接口级测试、单独起环境要建真账号和 TOTP，属于 Andy 需要拍板的大改动。

---

## 一、方案依赖的前提

### 已读代码或来源证实的

1. **生产登录方式是 Access，内置账号是退路。**
   - `docs/runbooks/production-web-entry-runbook.md:63`：“生产配置：`publicOrigin` 是 `https://himawari.siyi.win`，`publicMode` 是 `true`，`identity.kind` 是 `cloudflare-access`”。
   - 同文件 `:148`：“退回自带登录（Access 本身坏了、短期修不好时）：旧配置的 … `identity.kind` 是 `built-in`”。

2. **现有验收环境模拟的就是 Access。**
   - `test/fixtures/product-path-configuration.ts:98-115` 配了 `issuer`、`jwksUrl`、`audience`，没有写 `identity.kind`；`packages/platform-node/src/strict-configuration.ts:672-705` 只在 `kind` 显式且不是 `cloudflare-access` 时拒绝，省略时按外部 Access 处理。
   - `test/fixtures/product-path-harness.ts:855-865` 生成 Access JWT，`:867-895` 的前端代理对每个请求重新签名并注入：
     ```ts
     headers: { ...request.headers, "cf-access-jwt-assertion": assertion }
     ```
   - 这意味着：**当前假环境里不存在“Access 会话已退出”的状态**，每个请求都会被重新注入有效 JWT。只点一个链接、断言跳转，并不能证明退出。

3. **现有发布验收的内存场景只打开页面、看计数，没有增改删。**
   - `test/integration/product-path-browser.test.ts:5914-5923` 的 `accept-memory-page` 只做：点“记忆”、等 `memoryCount`、断言无 `pageError`、再新建对话。
   - 发布门槛要求场景状态恰好是 `['passed']`：`scripts/delivery-mode/browser-acceptance-gate.py:48-50`；`deploy.sh:64-65` 会读这个门槛。

4. **内存页的“添加”在学到第一条记忆前是禁用的。**
   - `apps/agent-service/src/production-memory-control.ts:518`：“`const manualAddReady = (await this.options.book.latestGeneration(scope)) !== undefined;`”
   - `apps/control-center/src/components/memory-page.tsx:1443-1452`：添加按钮 `disabled={!addReady}`。
   - 页面提示原文见 `apps/control-center/src/i18n/resources/zh-CN.ts:649-650`：“要先从对话里记下第一条记忆，才能手动添加和导入。”
   - 所以验收不能凭空点“添加”；必须先用真实对话和脚本化模型走一次记忆整理，或者直接往数据库塞数据。后者会绕开真实链路，不建议。

5. **内存增改删走的是真实网关命令，不是前端假数据。**
   - `apps/control-center/src/memory.ts:135-169`：更正发 `memory.mutate`/`correct`，删除/恢复发 `memory.mutate`/`delete`/`recover`，新增发 `memory.create`。
   - `apps/agent-service/src/production-memory-control.ts:597-614`（创建）、`:846-880`（删除、恢复、更正）。
   - 契约：`packages/gateway-contracts/src/contracts-v2.ts:1063-1071`、`:1215-1248`。
   - 后端还会拒绝空文本：`production-memory-control.ts:164-170` 的 `assertStorable` 在 `text.trim().length === 0` 时抛 `MEMORY_TEXT_REFUSED`。

6. **生产 Access 设置里没有退出登录，内置账号才有。**
   - `apps/control-center/src/app.tsx:559-563`：
     ```tsx
     settingsAccount={
       configuration && identityMethod === "built-in" ? (
         <SignOutSetting ... />
       ) : undefined
     }
     ```
   - `apps/control-center/src/components/sign-out-setting.tsx:16-22` 调 `accountRequest("logout", …)`。
   - Access 唯一的退出相关入口在周报确认里：`apps/control-center/src/components/weekly-report.tsx:1085`：
     ```tsx
     onClick={() => window.location.assign("/cdn-cgi/access/logout")}
     ```

7. **Cloudflare 官方明确支持应用内自定义退出链接。**
   - https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ 原文：
     > “To log out of Access, the end user can visit either of the following URLs: `<your-application-domain>/cdn-cgi/access/logout` … This action revokes the user's session across all applications. Access will immediately clear the authorization cookie from the user's browser, and all previously issued tokens will stop being accepted in 20-30 seconds.”
     > “You can use these URLs to create custom logout buttons or links directly within your application.”
   - 同一页面也说明这是**跨应用**退出，不只是 Himawari。

8. **Access 模式下，应用自己的会话 cookie 单独不够。**
   - `packages/platform-node/src/identity-gateway.ts:612-633` 的 `authenticate` 同时要求 `input.accessAssertion` 和 `input.sessionToken`；缺一个就抛 `SESSION_INVALID`。
   - 所以退出后即使浏览器还留着 `himawari_session`，只要 Cloudflare 边缘不再放行，应用也进不去。反过来说，如果假环境继续注入 JWT，测试就测不出退出。

9. **Playwright 官方对“改服务端状态的测试”建议不要把同一账号并行共用。**
   - https://playwright.dev/docs/auth 原文：
     > “This is the recommended approach for tests that modify server-side state. In Playwright, worker processes run in parallel. In this approach, each parallel worker is authenticated once. All tests ran by worker are reusing the same authentication state. We will need multiple testing accounts, one per each parallel worker.”
   - 本产品只有一个主人、一个 Access 绑定，发布验收本来就是单线程串行；**这次不并行化**，所以不需要多账号。如果以后拆并行 worker，每个 worker 需要独立主人/账号，不能用同一个 Access 主体。

10. **发布门槛和覆盖表是三处联动，漏一处会被现有检查抓住。**
    - `scripts/delivery-mode/browser-acceptance-gate.py:5-24` 的 `REQUIRED_SCENARIOS`；
    - `test/integration/product-path-browser.test.ts:5477-5496` 的 `RELEASE_ACCEPTANCE_SCENARIOS`；
    - `test/tooling/release-walkthrough-coverage.test.mjs:71-83` 要求“覆盖表里的每个入口都有场景”且“门槛场景与验收清单完全一致”；
    - 同文件 `:85-94` 要求每个清单名字都有 `await scenario("…")` 主体；
    - `test/tooling/release-walkthrough-locators.test.mjs:30-34` 禁止在场景函数体里内联 `getByRole`/`locator("…")`。

11. **发给模型的内容只能追加，不能改开头。**
    - `.claude/rules/prompt-prefix.md:28`：“每轮都会变的内容只放在最后一条用户消息里。”
    - 同文件 `:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
    - 同文件 `:84`：“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。”

12. **I-73 的教训是：每个新值都要找到产生端和消费端。**
    - `docs/incidents-and-gates.md:112` 原话：“双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’。”

13. **内置账号退出登录已有接口级真测试，不经浏览器。**
    - `packages/platform-node/src/built-in-identity-routes.ts:140-149` 的 `/api/identity/v1/logout` 要求 CSRF 并撤销会话。
    - `test/integration/built-in-identity.test.ts:258-276`：不带 CSRF 的 logout 返回 401；带 CSRF 返回 200；之后访问 `/devices` 返回 401。

### 推测或未核实

1. **记忆整理在验收环境里多久能落库、投影 worker 多久把第一条记忆变成可添加状态**：未核实，必须在 Hermes 上实测；方案里要用轮询而不是固定等待。
2. **`MEMORY_CAPTURE.text` 是否就是模型收到的最后一条用户消息的开头**：从 `apps/agent-service/src/production-memory-capture.ts:124-148` 看是固定提示加 JSON，但实际传输层是否再包一层未跑过；落地时用真实请求验证一次。
3. **给 Access 设置增加“账号”页签后，手机布局场景是否仍通过**：未核实；`accept-phone-layout` 会遍历设置页签，新增页签可能影响布局，需要在 Hermes 上跑。
4. **假 Access 边缘用 cookie 维护“每个浏览器上下文一个会话”是否与现有 `storageState`、手机上下文完全兼容**：未核实；代码上可行，但需要实现后验证。
5. **真实 Cloudflare 的 20–30 秒令牌失效和跨应用退出**：本地假环境只能模拟“立即不放行”，不能证明 Cloudflare 的真实时序。

---

## 二、方案

### 1. 登录方式选择（设计问题 1）

| 验收内容 | 在哪种登录方式下验收 | 原因 |
|---|---|---|
| 记忆增、改、删 | 现有 `cloudflare-access` 环境 | 生产就是 Access；记忆 CRUD 是应用逻辑，与登录方式无关；现有验收环境已经是真服务、真 Chromium、真 SQLite，只缺剧本。 |
| 退出登录 | 现有 `cloudflare-access` 环境，**前提是先补 Access 设置入口** | 生产用户能操作的退出就是 Cloudflare 的 `/cdn-cgi/access/logout`；内置账号退出是退路，且已有接口级真测试。 |

**不建议额外起内置账号验收环境。** 理由：
- 生产不用内置账号，发布门槛增加一个非生产路径会拉长 Hermes 单线程时间；
- 内置账号需要 `identity.kind: "built-in"`、用 `admin-cli account create` 建真账号、通过私有文件传凭据、读 enrollment 文件算 TOTP（`apps/admin-cli/src/account-command.ts:30-60`、`:86-118`），属于“改登录方式”级别，按约束要 Andy 同意；
- 现有 `test/integration/built-in-identity.test.ts` 已经覆盖真密码、真 TOTP、会话过期和撤销。若 Andy 以后要求浏览器级兜底路径，再单独做 opt-in 套件，不要塞进当前发布门槛。

### 2. 记忆增、改、删的验收设计（设计问题 3）

建议新增三个场景，保留现有 `accept-memory-page` 做冒烟：

- `accept-memory-add`
- `accept-memory-edit`
- `accept-memory-delete`

#### 前置：先让“添加”可用

在 `releaseAcceptanceScript` 里加一个记忆整理分支，用**真实记忆整理调用**产生第一条记忆。不要直接写数据库，也不要 mock 网关。

做法：
- 测试生成一次性的 `MEMORY_MARKER`（例如 `randomUUID()`），不要写死文案。
- 发送一条新对话消息：`请记住：我的项目代号是${MEMORY_MARKER}`。
- 模型脚本检测到 `lastUserText` 以 `MEMORY_CAPTURE.text` 开头时，解析后面的 JSON，读取 `ownerMessage`；只有 `ownerMessage` 含本次 `MEMORY_MARKER` 才返回一条创建候选，否则返回 `{"memories":[]}`。
- 候选必须满足真实解析器的要求（`production-memory-capture.ts:204` 的 `parseMemoryCandidates`）：`kind`、`decision`、`text`、`classification`、`confidence`、`explicit`、`category`、`quote` 等字段齐全，`quote` 必须是主人消息的子串。
- 然后轮询内存页“添加”按钮变为可用（`manualAddReady`），而不是固定 `sleep`。

这样做的价值：
- 覆盖“第一条记忆必须从对话里学到”的真实产品规则；
- 顺带验证记忆整理链路；
- 不绕开 `check:real-admission` 的精神：模型是脚本化的假模型，但业务逻辑、数据库、接口都是真的。

#### `accept-memory-add`

**正向：**
1. 打开记忆页，断言“添加”此时是禁用的（因为还没有学到第一条记忆）。
2. 发送带 `MEMORY_MARKER` 的“请记住”消息，等待普通回答。
3. 打开记忆页，轮询“添加”变为可用。
4. 点“添加”，填入本次生成的 `memoryText = “验收备注-${randomUUID()}”`，点“保存”。
5. 用搜索框搜 `memoryText`，断言列表出现该行；断言记忆计数增加。
6. 刷新页面，再搜一次，断言仍存在（证明落库，不是前端乐观更新）。

**反向：**
- 再打开“添加”，只输入空格，断言“保存”是禁用的；关闭表单，断言计数不变、没有新行。
- 这同时有后端兜底：真实后端 `assertStorable` 也会拒绝空文本（`production-memory-control.ts:164-170`）。

#### `accept-memory-edit`

**正向：**
1. 打开记忆页，搜索 `memoryText`，点开该行。
2. 点“编辑”，把文本改成 `editedText = “${memoryText}-已编辑”`，保存。
3. 断言详情显示 `editedText`；关闭后搜索旧文本无结果，搜索新文本有结果。
4. 刷新页面，再搜新文本，断言仍存在。

**反向：**
- 再点“编辑”，不改文本，断言“保存”禁用；关闭，断言文本没变。
- 如果产品以后允许“保存未修改的编辑”，这个断言会失败，说明反向用例有效。

#### `accept-memory-delete`

**正向：**
1. 搜索 `editedText`，点开该行，点“删除”。
2. 断言出现 `memory.page.deleted` 的提示；活跃列表搜索旧文本为 0 行；计数减少。
3. 点“最近删除”链接，断言该行出现在 `data-status="trashed"` 的列表里。
4. 点开该行，断言详情里只有“恢复”，没有“删除/编辑”；点“恢复”。
5. 点“回到在用的记忆”，搜索 `editedText`，断言重新出现；刷新页面再确认一次。

**反向：**
- 删除后，活跃列表搜索该文本必须为空（这是“期望结果为空”）。
- 在“最近删除”的详情里断言“删除”按钮不存在（防止对已删除项再次删除）。
- 最后做清理：再次删除这条手动记忆；同时删除前面由 `MEMORY_MARKER` 学到的记忆，避免它影响后面的手机场景和重启场景。软删除后它不会进入 recall，活跃记忆数为 0。

#### 顺序与清理

- 三个记忆场景放在现有 `accept-memory-page` 之后、`accept-phone-layout` 之前。
- 必须在 `accept-unrelated-no-memory` 和 `accept-slow-memory-search` **之后**。原因：验收模型的 embedding 固定为全 0.1，任何新增活跃记忆都可能让“无关问题”也命中记忆；现有两个场景明确要求没有记忆步骤（`product-path-browser.test.ts:5793-5804`、`:5873-5887`）。
- 场景结束时把所有测试产生的活跃记忆软删除，避免影响后续手机和重启场景。

#### 不写死

- 地址：用 `installation.origin`，不写域名。
- 模型：继续用 `ACCEPTANCE_SELECTABLE_MODELS` 和现有脚本化模型，不新增真实模型名。
- 账号：Access 场景不需要输入账号；不要把 `subject-product-path` 写进剧本。
- 文案：新增定位统一放 `apps/control-center/test/release-walkthrough-ui.ts`；新条目的 `name` 从 `apps/control-center/src/i18n/resources/zh-CN.ts` 的 `messages[...]` 取，不复制中文。现有 `release-walkthrough.unit.test.ts:461-469` 已有“UI 名称必须等于 messages”的检查，新条目照这个模式加。
- 记忆文本：运行时生成随机 nonce，不写死。

需要新增的定位大致包括：
- `memoryAdd`：`button`，名称 `messages["memory.page.add"]`
- `memoryAddText`：`textbox`，名称 `messages["memory.page.addTitle"]`
- `memorySave`：`button`，名称 `messages["memory.save"]`
- `memorySearch`：`searchbox`，名称 `messages["memory.search"]`
- `memoryRow`：`.memory-row`（结构选择器）
- `memoryDetail`：`dialog`，名称 `messages["memory.page.detail"]`
- `memoryEdit`：`button`，名称 `messages["memory.editAction"]`
- `memoryDelete`：`button`，名称 `messages["memory.deleteAction"]`
- `memoryRecover`：`button`，名称 `messages["memory.page.recover"]`
- `memoryNotice`：`.memory-notice`（结构选择器）
- `memoryStatusLinks`：`.memory-status-links`（结构选择器；最近删除链接目前是第二个/最后一个按钮。若担心顺序变化，可给两个按钮加 `data-status`，这是很小的产品标记改动）

### 3. 退出登录：补产品缺口，再验收（设计问题 2）

**这是该补的产品缺口。** 理由：
- Cloudflare 官方明确说“You can use these URLs to create custom logout buttons or links directly within your application”；
- 生产用户在设置里找不到退出，只有周报确认里藏着一个“退出并重新登录”，不符合“上线后真实能操作的所有入口”；
- 补法很薄：不是自己实现退出，而是加一个指向 Cloudflare 退出地址的入口。

**产品实现建议：**
1. 新增一个共享常量，例如 `apps/control-center/src/access-logout.ts`：
   ```ts
   export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";
   ```
   周报（`weekly-report.tsx:1085`）和新的设置入口都用它，避免两处硬编码分叉。
2. 在 `app.tsx:559-563` 增加 Access 分支：
   - `identityMethod === "built-in"`：保持现有 `SignOutSetting`；
   - `identityMethod === "cloudflare-access"`：渲染一个真正的链接 `<a href={ACCESS_LOGOUT_PATH}>退出登录</a>`，标签用 `messages["account.signOut"]`。
   - 用链接而不是纯按钮的好处：无 JS 也能用，测试可以从 DOM 读 `href`，不需要在剧本里写死地址。
3. 建议在设置项旁说明这是“退出 Cloudflare Access（会影响同一账号下的其他应用）”。这是产品文案取舍，不影响验收逻辑。

**验收怎么测：**

现有假边缘必须从“每个请求都注入 JWT”改成能表达“Access 会话已退出”。建议在 `product-path-harness.ts` 的前端代理里做一个按 cookie 隔离的最小 Access 会话：

- 第一次请求时给浏览器种一个测试专用的 Access 会话 cookie，并把该会话记为有效；
- 有效会话：照旧注入 `cf-access-jwt-assertion`；
- 收到 `GET /cdn-cgi/access/logout`：把该会话标记失效、清 cookie，302 到测试的假 Access 登录页；
- 无效/没有会话：所有应用请求 302 到假登录页，不再注入 JWT；
- 假登录页只显示“Access 登录”，不自动放行。这样测试可以真实看到“退出后进不去”。
- 用 cookie 而不是全局布尔值，是为了让退出只影响当前浏览器上下文，未来即使把 `accept-logout` 移到中间也不会误伤其他上下文；如果确定永远放最后，简单全局布尔值也能工作，但扩展性差。

**`accept-logout` 正向：**
1. 在设置里打开账号页，断言“退出登录”可见。
2. 从 DOM 读链接的 `href`（不在剧本里写死路径）。
3. 点退出，等待页面离开应用，落到假 Access 登录页；断言对话输入框不存在。
4. 再访问 `installation.origin`，断言仍被带到假登录页，应用内容不出现。

**`accept-logout` 反向：**
1. 退出前先请求 `/api/control-center/v1/config`，断言返回 200 JSON（证明此时确实可用）。
2. 退出后再次请求同一路径，断言被 302 到假登录页、拿不到 JSON（证明权限真的被拦下，而不是“页面隐藏了但接口还通”）。
3. 这同时覆盖了“旧 `himawari_session` cookie 单独不够”的产品事实：`identity-gateway.ts:612-633` 要求同时有 Access assertion 和 session token。

**边界说明：**
- 这能证明：我们的入口指向正确的 Cloudflare 路径、退出后 Access 边缘不再放行、应用不能靠旧 cookie 继续用。
- 不能证明：真实 Cloudflare 在 20–30 秒后让所有旧令牌失效、跨所有应用退出。那是 Cloudflare 的行为，只能在生产做一次人工冒烟或依赖 Cloudflare 的契约。别把假环境的通过说成“真实退出已被证明”。

**如果 Andy 决定不补这个入口：**
- 那就不要假装在 Access 环境里验收“退出登录”；现有周报按钮不是通用退出入口。
- 可以选择：不把退出登录纳入发布门槛，明确记成产品缺口；或者批准一个单独的内置账号浏览器套件。两条路都比“点一个链接就算退出”诚实。

### 4. 门槛接线

新增场景后，必须同时改：
1. `scripts/delivery-mode/browser-acceptance-gate.py` 的 `REQUIRED_SCENARIOS`；
2. `test/integration/product-path-browser.test.ts` 的 `RELEASE_ACCEPTANCE_SCENARIOS`；
3. `test/tooling/release-walkthrough-coverage.test.mjs` 的 `WALKTHROUGH_COVERAGE`：`memory` 加三个记忆场景，`settings` 加 `accept-logout`；
4. `release-walkthrough-ui.ts` 的新定位；
5. 场景函数体。

现有检查会自动抓：
- 清单名字和门槛不一致 → coverage 测试失败；
- 清单有名字但没有 `await scenario("…")` → coverage 测试失败；
- 场景里内联定位 → locator 测试失败；
- 场景失败 → `walkthrough.json` 里状态不是 `['passed']` → `browser-acceptance-gate.py` 拦住 `deploy.sh`。

### 5. 自动检查与反向验证（必答问题 3）

现有自动检查：
- `release-walkthrough-coverage.test.mjs` 已有反向用例：未知场景、过时行、随便写的豁免理由都会失败（`:96-114`）。
- `release-walkthrough-locators.test.mjs` 会拒绝场景里内联定位（`:30-34`）。
- 发布门槛要求每个场景恰好 `passed`（`browser-acceptance-gate.py:48-50`）。

需要新增的反向验证：
1. **记忆添加反向**：空白文本时保存按钮必须禁用。如果以后有人删掉 `!text.trim()` 守卫，这个断言会失败。为证明它真的会失败，落地时做一次变异验证：临时删掉守卫，跑 `accept-memory-add`，必须变红。
2. **记忆删除反向**：删除后活跃列表搜索必须为空；最近删除详情不能出现“删除”。如果删除只改了前端状态或后端没落库，这个断言会失败。
3. **退出登录反向**：退出后配置接口必须被 302 到登录页。落地时临时让假边缘继续注入 JWT，`accept-logout` 必须变红；否则这个场景就是“点了个链接”的假测试。
4. **记忆整理候选校验**（I-73）：脚本返回的候选必须能过真实 `parseMemoryCandidates`。最好在 `test/integration/production-memory-capture.test.ts` 或一个小单元测试里直接用同一份候选跑解析器；否则“候选 JSON 少个字段”会拖到 Hermes 上才发现。
5. **退出路径一致性**：设置入口和周报必须用同一个 `ACCESS_LOGOUT_PATH`；加一个单元测试断言两处都引用这个常量，避免以后一处改路径、另一处没改。

---

## 三、考虑过但不选的做法

1. **给退出登录额外起一个内置账号验收环境。**
   - 不选原因：生产不用；需要真账号、密码、TOTP、私有文件、单独配置和额外服务时间；属于 Andy 要批准的大改动；接口级已有测试。若以后要浏览器级兜底，单独 opt-in，不进当前门槛。

2. **直接点现有周报的“退出并重新登录”来验收退出。**
   - 不选原因：它藏在“需要最近认证”的周报确认流程里，要等 5 分钟或改时间，且只覆盖“重新登录”场景，不是通用退出入口。

3. **只断言 Access 退出链接的 `href`。**
   - 不选原因：治标。当前假边缘每个请求都注入 JWT，链接写得再对，也证明不了退出后进不去。

4. **把记忆直接写进 SQLite 或 mock 网关来绕过“第一条记忆”限制。**
   - 不选原因：绕开真实业务逻辑，违反 `check:real-admission` 的精神；而且 `manualAddReady` 依赖记忆整理 generation，直接塞记忆不一定能让“添加”可用。

5. **用 `page.route` 拦截内存 API 返回假数据。**
   - 不选原因：发布验收要的是真服务、真数据库；内存增改删正是要看真实链路。

6. **把增、改、删合成一个场景。**
   - 不选原因：失败时只能看到一个 `accept-memory-crud` 失败，定位差。拆成三个场景，每个都有独立正向/反向断言；它们共享前面学到的记忆和手动添加的记忆，顺序固定。

7. **Playwright 官方建议的“每个并行 worker 一个账号”。**
   - 不选原因：本产品单主人、Access 单绑定，发布验收串行；多账号需要多个真实 Access 身份，不现实。我们明确不并行化。

8. **自己实现一个应用层“退出所有设备”接口来撤销 `product_sessions`。**
   - 这次不做。Cloudflare 负责 Access 会话，应用自己的 session 在没有 Access assertion 时已经不可用（`identity-gateway.ts:612-633`）。如果 Andy 要“退出后旧应用 session 也立刻作废”，那是另一个安全需求，需要单独设计。

---

## 四、风险和反例

1. **假 Access 不等于真 Cloudflare。**
   - 反例：Cloudflare 改了退出路径、或令牌失效时间与文档不符，假环境仍然通过。
   - 缓解：假边缘按官方文档实现；生产上线后做一次人工退出冒烟；文档路径变化时门槛要跟着改。

2. **Access 退出是跨应用的。**
   - 反例：用户在 Himawari 点退出，结果同一 Cloudflare 账号下的其他应用也退出，感到意外。
   - 缓解：设置项文案说明“退出 Cloudflare Access”；是否加确认弹窗由 Andy 拍板。

3. **新增记忆可能干扰“无关问题不该命中记忆”的现有场景。**
   - 反例：验收 embedding 全是 0.1，任何活跃记忆都可能被检索到；如果记忆场景排在前面，`accept-unrelated-no-memory` 可能失败。
   - 缓解：放在这两个场景之后；结束时软删除所有测试记忆。

4. **记忆整理是异步的。**
   - 反例：发送“请记住”后立刻打开记忆页，“添加”还没启用，测试误判失败。
   - 缓解：轮询 `manualAddReady`，设置合理超时；在 Hermes 上实测一次耗时。

5. **脚本化记忆整理候选和真实解析器漂移。**
   - 反例：解析器新增必填字段，候选 JSON 缺字段，记忆永远不落库。
   - 缓解：候选走真实解析器；最好加一个快速单元测试直接调用 `parseMemoryCandidates`，并遵循 I-73 的“两端都核对”。

6. **新增设置页签影响手机布局场景。**
   - 反例：Access 设置里多出“账号”页签，`accept-phone-layout` 遍历设置页签时布局检查失败。
   - 缓解：在 Hermes 上跑手机布局；新入口用简单链接/按钮，不引入宽内容。

7. **退出后旧的应用 session cookie 还在。**
   - 反例：有人以为退出后 cookie 立即消失。
   - 事实：应用要求 Access assertion + session cookie 两者（`identity-gateway.ts:612-633`），所以边缘挡住后旧 cookie 单独无效；但浏览器里确实还会留着这个 cookie。若 Andy 要求清掉它，需要额外的应用层清理设计，不能只靠 Cloudflare 退出。

8. **漏掉“记忆编辑后旧说法还能不能被检索/带到模型”的检查。**
   - 本次只覆盖用户可见的增改删和恢复；不覆盖记忆质量、编辑历史链、模型是否真的使用新记忆。若要覆盖“编辑后模型只看到新说法”，需要额外检查模型请求，且要注意 prompt-prefix 规则（新说法只能出现在新追加的消息里）。

---

## 五、需要 Andy 拍板的取舍

1. **是否补 Access 设置里的“退出登录”入口。**
   - 建议补：Cloudflare 官方支持自定义链接，用户也需要。补的话按上面的共享常量和链接实现。

2. **如果补，是否提示“会影响同一 Cloudflare 账号下的其他应用”。**
   - 建议提示，至少用一句说明，避免跨应用退出的意外。

3. **是否接受为了记忆“添加”先跑一次真实记忆整理。**
   - 建议接受。它会让验收多花一点时间，但这是唯一不绕开真实链路、又能让“添加”可用的办法。

4. **是否为“最近删除”链接加 `data-status` 标记。**
   - 建议加，定位更稳；如果不加，就用 `.memory-status-links` 的最后一项，接受一点结构耦合。

5. **是否现在就做内置账号的浏览器级退出验收。**
   - 建议不做，留作以后独立 opt-in 套件；本次不额外起环境。

6. **退出验收做到什么程度。**
   - 建议至少做到“退出后配置接口被 302 拦住”；如果只测跳转，就是治标。

---

## 六、必答问题逐条回答

### 必答 1：这个改动会不会改变模型已经见过的请求开头？

**不会。** 前提是严格执行下面的边界：

- 不改 `packages/runtime-pi` 的系统提示、工具定义、历史存储和出口遮盖；
- 不把记忆写进 `systemInstruction` 或工具定义；
- 不修改已经存下的历史消息；
- 测试新增的 `MEMORY_MARKER`、`memoryText` 只出现在**新追加的用户消息**里；
- 记忆整理是后台调用，固定提示在前、变化的 JSON 在后（`production-memory-capture.ts:132-148`）；
- 记忆召回走现有 `recall` 工具/上下文块，新增记忆只会出现在新的一轮请求的末尾，不改前面的字节。

因此：
- 发给模型的内容仍然只在末尾追加；
- 每轮会变的值（本轮记忆、时间、资料）仍然只放在最后一条消息/本轮上下文里；
- 退出登录完全不经过模型，不进入请求。

**需要注意的反例：** 如果实现时为了测试方便把记忆塞进系统提示，或者把学习到的记忆写进工具定义，那就违反 `.claude/rules/prompt-prefix.md:28/:35`，必须停下来重新出方案。按本方案不做这种事。

### 必答 2：会不会让同一段文字在不同请求里变成不同的字节？

**不会，按本方案不会。** 具体：

- 记忆文本在一次验收运行里只生成一次，之后一直复用同一串字节；
- 不在记忆文本里放当前时间、随机数、数据库行号；
- 出口遮盖不改；测试文本不含密码、验证码、银行卡号等会触发遮盖的内容；
- 记忆整理提示里的 `messageSentAt`、`ownerTimeZone` 在固定提示之后的 JSON 数据里，不在提示开头；而且它们是后台调用，不是主对话历史；
- Access JWT 的 `iat`/`exp` 每个请求都变，但它是 HTTP 头，不是发给模型的 `messages` 内容；不影响模型请求的字节；
- 假边缘的 cookie 会话标识会变，但也只是 HTTP 层，不进模型。

**反例：** 如果以后有人在记忆文本里加 `Date.now()`，或者让同一个记忆在每次请求里重新生成不同措辞，那就会变；本方案禁止。若产品将来把“本轮记忆”放回系统提示，也会破坏字节确定性，需要按 prompt-prefix 规则停止。

### 必答 3：有没有对应的自动检查，反向用例真的会失败吗？

有，但要分两层：

**已有的自动检查：**
- 发布门槛 `browser-acceptance-gate.py` 强制每个场景 `passed`；
- coverage 测试强制门槛清单、验收清单、入口覆盖表三者一致，并要求每个名字有场景主体；
- locator 测试禁止场景里内联页面定位；
- `deploy.sh` 在门槛失败时拒绝上线。

**需要新增并通过变异验证的反向用例：**
- 空白记忆文本保存必须被禁用；删掉守卫后 `accept-memory-add` 必须失败；
- 删除后活跃搜索必须为空、最近删除里不能再删除；删除没落库或状态没变时 `accept-memory-delete` 必须失败；
- 退出后配置接口必须 302 到假登录页；如果假边缘继续注入 JWT，`accept-logout` 必须失败；
- 记忆整理候选必须能过真实解析器；少字段/错分类时候选不得落库，添加按钮不得变为可用。

**诚实说明：** 这些反向检查现在还没有实现，必须落地时逐条做变异验证；不能只在文档里写“有反向用例”。如果只加了场景名字而没有上面的负向断言，I-73 的教训会重演：清单里的值能不能通过消费端校验，没人问。

### 必答 4：改动产生或修改的每个值，产生端和消费端都对上了吗？

按 I-73 的方式逐个核对：

| 新值 | 产生端 | 消费端/校验 | 当前是否对上 |
|---|---|---|---|
| `accept-memory-add` / `accept-memory-edit` / `accept-memory-delete` / `accept-logout` | `product-path-browser.test.ts` 的 `RELEASE_ACCEPTANCE_SCENARIOS` | `browser-acceptance-gate.py` 的 `REQUIRED_SCENARIOS`；`release-walkthrough-coverage.test.mjs` 的 `WALKTHROUGH_COVERAGE`；`afterAll` 按清单过滤结果 | 必须三处同时改；现有 coverage 测试会抓不一致 |
| 新定位键（`memoryAdd` 等） | `release-walkthrough-ui.ts` | 场景函数体；`release-walkthrough-locators.test.mjs`；`release-walkthrough.unit.test.ts` 的 messages 对照 | 必须保证名称与页面/消息目录一致 |
| `ACCESS_LOGOUT_PATH` | 新的共享常量 | 设置入口；周报；假 Access 边缘处理 `/cdn-cgi/access/logout` | 假边缘必须按官方路径实现；否则 `accept-logout` 失败 |
| `MEMORY_MARKER` / `memoryText` / `editedText` | 测试运行时生成 | 模型脚本的 `ownerMessage` 判断；UI 搜索/断言；后端 `assertStorable` | 必须非空、无敏感值、能通过 `assertStorable` |
| 记忆整理候选 JSON | `releaseAcceptanceScript` | `parseMemoryCandidates`；真实记忆生成/投影 | 必须字段齐全、`quote` 是主人消息子串、分类合法；建议加解析器单测 |
| 新场景的负向断言 | 场景函数体 | `scenario` 结果 → `walkthrough.json` → 发布门槛 | 必须做变异验证，确认删除守卫后会红 |

---

## 七、设计问题简答

1. **记忆增改删和退出登录分别在哪种登录方式下验收？**
   - 都在现有 `cloudflare-access` 环境。
   - 记忆 CRUD 与登录方式无关，生产是 Access。
   - 退出登录需要先补 Access 设置入口；补了就在同一环境用假边缘验收。
   - 不额外起内置账号验收环境；内置退出已有接口级真测试，浏览器级兜底留作以后独立套件。

2. **生产 Access 设置里没有退出登录，该不该补？**
   - 该补。Cloudflare 官方支持应用内自定义退出链接；补一个指向 `/cdn-cgi/access/logout` 的链接即可。
   - 验收要覆盖“链接可用 + 退出后边缘不放行”，不能只断言跳转。
   - 真实 Cloudflare 的跨应用撤销和 20–30 秒令牌失效只能在生产冒烟，不在发布验收里假称已验证。

3. **每个场景的正向/反向怎么设计，怎么不写死？**
   - 正向：添加→搜索可见→刷新仍在；编辑→旧文本消失/新文本出现→刷新仍在；删除→活跃为空→最近删除可恢复；退出→跳转假登录→配置接口被拦。
   - 反向：空白保存禁用；未修改保存禁用；删除后活跃搜索为空、最近删除不能再删除；退出前配置 200、退出后配置被 302。
   - 不写死：地址用 `installation.origin`；模型用现有脚本化模型；账号不在剧本里出现；文案从 `messages[...]` 取；记忆文本运行时生成随机 nonce；退出路径从 DOM 读取，假边缘按官方路径实现。

4. **治根还是治标？风险和漏掉的情况？**
   - 记忆 CRUD 是治根：真浏览器、真服务、真 SQLite、真网关命令。
   - 退出登录对我们的入口和“退出后不可访问”是治根；对 Cloudflare 的真实跨应用撤销只能算“外部契约 + 生产冒烟”，不是完全治根。
   - 主要漏掉：真实 Cloudflare 时序、跨应用退出提示、内置账号浏览器级退出、记忆质量和模型是否真的使用编辑后的记忆、旧应用 session cookie 的清理。
   - 最大反例：假边缘继续注入 JWT，导致退出测试永远通过但实际没退出；必须用变异验证和“退出后配置接口 302”来堵住。
