## 一、证实的

### 【高】Access 模式下的“退出登录”只退 Cloudflare，不撤销 Himawari 自己的会话；方案却断言“API 401”

**问题**：方案说“跳 `/cdn-cgi/access/logout` 并先清本地私密视图”，并断言“退出后再进页面需要重新登录、API 401”。但代码里 Access 模式每次请求同时要求 Cloudflare assertion 和 Himawari 会话 cookie；Access 退出只清 Cloudflare 的授权 cookie，数据库里的 `himawari_session` 仍然有效。清“本地私密视图”只是清 React 状态，不是撤销会话。

**证据**：
- `packages/platform-node/src/identity-gateway.ts:613`：
  ```ts
  if (!input.accessAssertion || !input.sessionToken) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID);
  }
  ```
  之后 `:625-633` 只检查 `session.status === "active"`，没有任何“Access 退出就作废会话”的逻辑。
- Access 模式只注册了 `registerIdentityAuthenticationRoutes`（`apps/agent-service/src/production-http-composition.ts:828-835`），它只有 `/bootstrap` 和 `/api/identity/v1/sessions`（`identity-gateway.ts:1019-1067`），**没有 logout 路由**。
- 有 logout 的是内置模式（`production-http-composition.ts:737-766` → `packages/platform-node/src/built-in-identity-routes.ts:140-149`），它才会 `revokeSession`。
- Cloudflare 官方原话：“To log out of Access, the end user can visit … `/cdn-cgi/access/logout` … This action revokes the user's session across all applications. Access will immediately clear the authorization cookie from the user's browser, and all previously issued tokens will stop being accepted in 20-30 seconds.”（https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/）——这是 Access 层，不是 Himawari 会话层。
- OWASP Session Management Cheat Sheet：“the web application must invalidate the session at least on server side”“Web applications must provide a visible and easily accessible logout … button”。（https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html）
- OWASP WSTG：“A common mistake in session termination is that the client-side session token is set to a new value while the server-side state remains active and can be reused … This should be avoided.”（https://wstg.owasp.org/latest/4-Web_Application_Security_Testing/06-Session_Management/06-Logout_Functionality/）

**建议**：在 Access 模式也注册一个服务端会话撤销接口（POST、同源、CSRF，和内置 logout 同一套语义），按钮先调用它，再跳 `/cdn-cgi/access/logout`；验收必须验证“旧 `himawari_session` + 新的 Access assertion 仍被拒绝”。如果决定只依赖 Access，就必须在方案里明确接受“服务端会话不撤销”的风险，不能写“API 401”。

---

### 【高】验收环境不处理 `/cdn-cgi/access/logout`，且前端代理无条件注入新 assertion；方案描述的反向用例根本不会失败

**问题**：方案说“验收环境的模拟 Access 发行方实现 `/cdn-cgi/access/logout` 清 cookie，断言退出后再进页面需要重新登录、API 401”。但浏览器访问的是验收 harness 的 **front HTTPS 代理**，不是 provider；代理对每个请求都重新签一个有效的 `cf-access-jwt-assertion`。即使 Access 退出坏了，页面也会自动换到新会话，测试照样通过。

**证据**：
- `test/fixtures/product-path-harness.ts:619-630` 的 provider 只实现 `/cdn-cgi/access/certs` 和 `/cdn-cgi/access/get-identity`，没有 `/cdn-cgi/access/logout`。
- `test/fixtures/product-path-harness.ts:868-896` 的 front 代理：
  ```ts
  const front = createHttpsServer(..., (request, response) => {
    void signAssertion().then((assertion) => {
      const upstream = requestHttp({ ..., headers: { ...request.headers, "cf-access-jwt-assertion": assertion } }, ...);
  ```
  每个请求都注入新的 assertion。
- 浏览器入口在 401 时会自动交换会话并刷新：`apps/control-center/test/browser-entry.unit.test.ts:21-37`（`/api/identity/v1/sessions` 成功后返回 `reload`）。
- 方案把“清 cookie”放在 provider，但浏览器根本不和 provider 通信；`/cdn-cgi/access/logout` 会被 front 转给应用，应用没有这个路由，结果是 404。

**建议**：改 front 代理而不是 provider：拦截 `/cdn-cgi/access/logout`，进入“已退出”状态，之后不再注入 assertion（对应用请求返回 401 或重定向到 Access 登录页），并让 `/api/identity/v1/method` 的 `redirect: manual` 探测拿到重定向。这样“再进页面需要重新登录、API 401”才是真反向用例。还要断言旧 `himawari_session` 被服务端拒绝（见上一条）。

---

### 【高】验收环境里记忆页的“添加”按钮是禁用的，方案的“添加一条”跑不起来

**问题**：方案要在记忆页“添加一条、编辑、删除、恢复”。但手动添加要求已经有 memory generation；验收 harness 的模型脚本对记忆抽取提示返回普通文本，抽取解析失败，不会产生 generation，于是 `manualAddReady=false`，添加按钮被禁用，服务端 `memory.create` 也会抛 `MEMORY_GENERATION_MISSING`。

**证据**：
- `apps/agent-service/src/production-memory-control.ts:518`：
  ```ts
  const manualAddReady = (await this.options.book.latestGeneration(scope)) !== undefined;
  ```
- `apps/agent-service/src/production-memory-control.ts:593`：`#createMemory` 调用 `await this.#generationFor(null)`；`:187-191` 没有 generation 就抛 `MEMORY_GENERATION_MISSING`。
- `apps/control-center/src/components/memory-page.tsx:1446`：`disabled={!addReady}`；`:2207`：`addReady={ready}`，`ready = overview?.manualAddReady ?? false`。
- generation 只由记忆抽取产生：`apps/agent-service/src/production-memory-capture.ts:716`；解析要求模型输出含 `memories` 数组的 JSON（`:241-245`）。
- 验收模型脚本 `test/integration/product-path-browser.test.ts:5525-5551` 对未知提示返回固定文本或工具调用，不会返回记忆 JSON。
- 现有 `accept-memory-page` 只检查标签文字：`test/integration/product-path-browser.test.ts:5914-5923`；`UI.memoryCount` 是 `/^记忆\s*\d+$/`（`apps/control-center/test/release-walkthrough-ui.ts:56`），零条记忆也能匹配“记忆 0”。

**建议**：先让验收能产生第一条记忆。两条路：
1. 扩展 `releaseAcceptanceScript`：识别记忆抽取提示（含 `ownerMessage`/`existingMemories`）时返回合法 JSON，等 generation/记忆出现后再操作；
2. 或在启动浏览器前用测试夹具/管理命令种一个 generation。
然后才谈“添加、编辑、删除、恢复”。另外，`accept-unrelated-no-memory`（`:5793-5805`）断言没有记忆步骤，记忆增改删场景必须排在它之后（当前 `accept-memory-page` 在它之后，位置正确），并在 `accept-after-restart`（`:5992`）前清理测试记忆，避免影响后续检索。

---

### 【中】新增场景名要同步四处，方案只说了两处；`test_deploy.py` 的场景清单不同步会让门槛测试直接红

**问题**：方案说“`REQUIRED_SCENARIOS` 加新场景；覆盖检查加入口”。实际至少还有 `test_deploy.py` 的硬编码 `SCENARIOS`，以及 jsdom 走查和定位器检查。只改两处，`test_deploy.py` 里“全部通过”的用例会因为 gate 要求了 fixture 里没有的场景而失败。

**证据**：
- `test/integration/product-path-browser.test.ts:5477-5496`：`RELEASE_ACCEPTANCE_SCENARIOS`
- `scripts/delivery-mode/browser-acceptance-gate.py:5-24`：`REQUIRED_SCENARIOS`
- `test/tooling/release-walkthrough-coverage.test.mjs:78-83`：强制两边排序后完全相等
- `scripts/delivery-mode/test_deploy.py:17`：`SCENARIOS = [...]` 是另一份硬编码清单，用来构造 `walkthrough()` fixture；gate 多要求一个场景，这个 fixture 就不完整
- `test/tooling/release-walkthrough-coverage.test.mjs:85-94`：要求每个场景有 `await scenario("name"` 字面量
- `apps/control-center/test/release-walkthrough.unit.test.ts` 是每次提交跑的 jsdom 走查；新增定位器若不加进去，`check:release-walkthrough` 不会验证它们

**建议**：四处一起改：`RELEASE_ACCEPTANCE_SCENARIOS`、`REQUIRED_SCENARIOS`、`test_deploy.py` 的 `SCENARIOS`、覆盖表/场景体；同时扩展 `release-walkthrough.unit.test.ts` 和 `release-walkthrough-locators.test.mjs`。

---

### 【中】方案与 ADR 0105 冲突：项目已经明确决定不做 Access 模式的退出登录

**问题**：方案把 Access 模式退出称为“产品缺口”，但没有提到项目已有相反决定。ADR 0105 明确说不做，理由是“网页里没有可以退出的会话，放按钮也不会生效”。现在代码确实在 Access 模式创建了 `himawari_session`，ADR 的前提已经过时，但必须显式改决策，不能当它不存在。

**证据**：`docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md:77`：
> **数据页放“这台设备 · 退出登录”。** 没做：生产环境的登录由 Cloudflare Access（网页前面的一道邮箱验证码）负责，网页里没有可以退出的会话，放按钮也不会生效。

**建议**：写一份取代/修订 ADR 0105 的决定，说明 Access 模式现在有服务端会话、退出如何撤销、影响哪些设备；按项目规则先让 Andy 同意再动代码。

---

### 【中】Cloudflare Access 的退出是“所有应用一起退”，不是像 ChatGPT/Claude 那样只退本应用

**问题**：方案用“对标 ChatGPT/Claude 都有退出”来论证，但 Cloudflare 的 `/cdn-cgi/access/logout` 会退出该用户在所有 Access 应用里的会话。把它说成“本应用的退出”会误导用户，也可能误伤其他应用。

**证据**：Cloudflare 官方原话：“This action revokes the user's session across all applications.”（https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/）文档还说明两个 URL 的区别只是删哪个域的 cookie，不能按应用单独退出：“At this time, end users cannot log themselves out on a per-application basis.”

**建议**：改掉“对标 ChatGPT/Claude”的理由；UI 文案或说明里写清“会退出所有 Cloudflare Access 应用”；如果要“只退 Himawari”，只能退 Himawari 自己的会话（见第一条），Access 退出作为可选项。

---

### 【中】内置账号变体无法直接进现有验收门槛：单次 vitest 只产出一个 `browser-acceptance.json`

**问题**：方案要“另起一个验收变体，配置 `identity.kind=built-in`，只跑少量场景”。但现有门槛只读一个 `browser-acceptance/walkthrough.json`，`run-release-walkthrough.sh` 只跑一个 describe 过滤器。另起变体会产生第二份结果，没有合并逻辑，门槛无法同时要求两套场景。

**证据**：
- `scripts/delivery-mode/hermes/run-release-walkthrough.sh:42-50`：只跑 `-t 'release acceptance in a real browser'`，只 `cp` 一个 `browser-acceptance.json`。
- `scripts/delivery-mode/make-packet.py:625-627`：只取一个 `walkthrough/browser-acceptance.json`。
- `scripts/delivery-mode/browser-acceptance-gate.py:29`：只读 `browser-acceptance/walkthrough.json`。
- 内置配置的字段和 Access 不同：`packages/platform-node/src/strict-configuration.ts:640-670` 要求 `sessionIdleMilliseconds`/`sessionAbsoluteMilliseconds`；现有 `test/fixtures/product-path-configuration.ts:98-115` 硬编码的是 Access 字段。
- `admin-cli account create` 需要服务停止（独占 state-root 锁）：`apps/admin-cli/src/account-command.ts:137-140`；输出文件含 `otpUri`/`recoveryCodes`（`:175-185`），测试可以用 `otpauth` 生成 TOTP（`test/integration/built-in-identity.test.ts:103`）。

**建议**：二选一：
1. 把内置变体放进同一个 release describe，共用 `results` 数组和同一个 `afterAll` 写同一个 JSON；
2. 或扩展 schema/门槛支持按 identity 变体分开的多份 walkthrough，并同步改 `run-release-walkthrough.sh`、`make-packet.py`、`browser-acceptance-gate.py`。
另外补一个 built-in 的配置构造器、stop → `account create` → start 的夹具；TOTP 用 `otpUri` 生成。

---

### 【低/中】定位器集中检查有盲区：新 helper 里写死 locator 不会被发现

**问题**：方案说定位器集中在 `release-walkthrough-ui.ts`。但 `release-walkthrough-locators.test.mjs` 只扫描 describe 块和一份固定函数名清单；如果新加的 helper（如 `expectMemoryEdit`）写在清单外，写死 `getByRole`/`locator` 也不会被检查。

**证据**：`test/tooling/release-walkthrough-locators.test.mjs:17-34`：
```js
const parts = [
  block('productDescribe("product path: release acceptance in a real browser"', "\n});\n"),
  ...[
    "function composer(", "async function send(", ... "async function expectNewsSearchResults(",
  ].map((name) => block(name, "\n}\n")),
];
```
只覆盖固定名单。

**建议**：扫描整个 `product-path-browser.test.ts`（或自动收集 release 相关 helper 名），并把新定位器全部加到 `RELEASE_WALKTHROUGH_UI`。

---

### 【低】`[UI-S2]` 现有测试明确要求 Access 模式没有退出按钮，加按钮会打破它

**问题**：方案没提这条测试。加 Access 退出按钮后，`[UI-S2]` 会失败；同时 `app.tsx` 当前只在 built-in 时渲染 `SignOutSetting`。

**证据**：
- `apps/control-center/test/app-interactions.unit.test.ts:408-415`：“[UI-S2] offers no sign-out without a built-in account”。
- `apps/control-center/src/app.tsx:560-561`：`configuration && identityMethod === "built-in" ? (<SignOutSetting ... />)`。

**建议**：更新 `[UI-S2]` 为新行为，并新增 Access 模式用例（调用撤销接口、跳 `/cdn-cgi/access/logout`、清私密视图）。

---

## 二、推测 / 未核实

1. **“删除后检索不到”若通过对话的记忆步骤验证，可能不可靠（推测）**：验收 harness 的 embedding 桩返回固定 `0.1` 向量（`test/fixtures/product-path-harness.ts:659-663`），常量向量的余弦相似度相同；若记忆检索走这个桩，所有记忆都会被当成“相关”，用聊天过程区断言“删除后检索不到”区分度很低。需核实检索实际走的是不是这个桩。建议改为在记忆页搜索框里断言“删掉的文字搜不到”，这是确定性的。
2. **记忆抽取是异步的（未核实）**：即使模型脚本返回合法 JSON，记忆 generation 是否在打开记忆页前提交、`manualAddReady` 何时变 true，需要实际跑一次确认；否则会出现时序 flake。
3. **内置浏览器变体在 `publicMode` + 自签 HTTPS 下能否直接跑（未核实）**：从配置看可行，但需要实际验证登录表单、TOTP、cookie 的 Secure/SameSite 行为。
4. **`admin-cli account create` 在 harness 运行中的可行性（未核实）**：它要求独占 state-root 锁，必须先停服务；测试要显式 stop → create → start，方案没写这一步。

---

## 三、侧重检查

- **错误路径**：`/cdn-cgi/access/logout` 在验收 harness 会被 front 转给应用 → 404（已证实，见高 #2）。内置 `account create` 失败路径有 `ADMIN_ACCOUNT_INPUT_INVALID`、`ADMIN_CONFIRMATION_REQUIRED`；验收要处理文件已存在（`O_EXCL`）和私有目录权限（`account-command.ts:19-28, 86-99, 169-173`）。
- **不合规范/不可信输入**：记忆添加/编辑走 `client.protectText`，文本上限 500（`memory-page.tsx:2077`），服务端 `assertStorable`/分类检查（`production-memory-control.ts:554-559`）。验收新增的输入是固定测试文字，不引入新的不可信输入面。
- **安全**：最大的问题是 Access 退出不撤销服务端会话（已证实，见高 #1）。另外 `/cdn-cgi/access/logout` 是 GET 导航、无 CSRF；如果新增应用侧撤销接口，必须 POST + CSRF + 同源（内置 logout 已经是这样，`built-in-identity-routes.ts:72-88, 140-149`）。
- **资源耗尽**：记忆增改删不会无界增长；删除是 7 天软删除、可恢复（`memory-page.tsx:559-565, 580-595`），不是不可逆操作。验收每轮只加一条固定文本，风险低。
- **不可撤销操作**：Access 退出是全局退出所有 Access 应用（已证实，见中 #6）；应用侧会话撤销是可逆的（重新登录），但要确认退出后旧 cookie 不能复活。
- **规则/文档/代码一致性**：ADR 0105 与方案冲突（已证实）；`[UI-S2]` 与方案冲突（已证实）；`test_deploy.py` 场景清单是第三个消费者（已证实）；`release-walkthrough-locators.test.mjs` 的固定函数名清单有盲区（已证实）。

---

## 四、如果由我来定，我会怎样改这份方案

1. **拆成两个独立改动**：A. 记忆增改删的验收（不改产品代码）；B. Access 退出登录（改产品 + 改 ADR + 改验收 harness）。不要混在一个 PR 里。
2. **记忆增改删**：
   - 先解决“第一条记忆”：扩展验收模型脚本，对记忆抽取提示返回合法 JSON；或在启动浏览器前种一个 generation。等 `manualAddReady=true` 再进记忆页。
   - 一个场景完成：加一条唯一文本 → 记忆页搜索到 → 编辑 → 旧文字搜不到、新文字搜到 → 删除 → 活跃列表搜不到、最近删除里有 → 恢复 → 又能搜到 → 清理（删除或留在 trash，保证不影响 `accept-after-restart`）。
   - “删除后检索不到”只在记忆页搜索里断言，不通过模型记忆步骤。
   - 定位器加到 `release-walkthrough-ui.ts`；同步改 jsdom 走查和 `release-walkthrough-locators.test.mjs`（扫描整个文件）。
   - 场景名同步四处：`RELEASE_ACCEPTANCE_SCENARIOS`、`REQUIRED_SCENARIOS`、`test_deploy.py` 的 `SCENARIOS`、覆盖表/场景体。
3. **Access 退出登录**：
   - 先写取代 ADR 0105 的决定，拿 Andy 同意。
   - 在 Access 模式注册服务端会话撤销接口（POST + CSRF + 同源），按钮先撤销 Himawari 会话、清私密视图，再跳 `/cdn-cgi/access/logout`；文案写清“会退出所有 Cloudflare Access 应用”。
   - 验收 harness 改 front 代理：拦截 `/cdn-cgi/access/logout`，进入已退出状态，停止注入 assertion，后续请求返回 401/重定向；断言页面进入 Access 过期/登录状态、API 401、旧 `himawari_session` 被拒绝。这样反向用例才会失败。
   - 更新 `[UI-S2]` 和 `app.tsx` 的显示条件。
4. **内置账号变体**：
   - 核心登录/退出/401 已有 `test/integration/built-in-identity.test.ts` 覆盖；如果还要浏览器覆盖，建议做成单独的“应急退路资格测试”，不塞进每次发布门槛；或者扩展门槛 schema 支持多份 walkthrough 并同步脚本。
   - 若坚持进门槛：在同一 describe 内跑 built-in 变体并写同一个 `browser-acceptance.json`，补 built-in 配置、stop→`account create`→start、`otpUri` 生成 TOTP。
5. **门槛**：只加真正有反向能力的场景；对无法在验收环境里真实模拟的（Access 登录过期），先把 harness 改到能模拟，再加门槛。

---

## 五、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会。方案本身不改系统提示、工具定义、历史或遮盖；退出按钮也不碰模型请求。记忆增改删改变的是记忆数据，而携带记忆/档案是以 `<himawari-context>` 的形式放进**最后一条用户消息**（`packages/runtime-pi/src/pi-runtime-adapter.ts:601-611`），不是系统提示。`owner-profile-service.ts:104-114` 的排序也是确定的。因此符合 `prompt-prefix.md` 第 2、4 条：仍然只在末尾追加，会变的值在最后一条消息里。前提是不要把新记忆写进系统提示/工具定义；当前实现没有这样做。

**2. 会不会让同一段文字在不同请求里变成不同的字节（依赖前后文的遮盖、带时间的字段、无序集合）？**

不会。方案不改序列化、不改遮盖；记忆列表的排序有固定规则（`owner-profile-service.ts:104-114`：重要度降序，同分按 `id.localeCompare`；`PROFILE_SECTIONS` 顺序固定）。验收新增的记忆文字必须是固定字符串，不能用 `Date.now()`/随机数；也不要依赖数据库返回顺序。若要做到“同一段文字每次字节相同”，测试数据本身要确定。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

部分有：
- 记忆增改删：`apps/control-center/test/memory-interactions.unit.test.ts` 的 `[MP-8]` 已覆盖添加、编辑、删除、恢复（`:299-390`、`:1009-1045`）。新增的真实浏览器走查是额外覆盖；但“删除后检索不到”要放在记忆页搜索上，且要先解决 `manualAddReady`，否则场景跑不起来。
- 内置账号退出：`test/integration/built-in-identity.test.ts:259-275` 已断言退出后 devices 接口 401；`app-interactions.unit.test.ts:361-415` 覆盖 UI。
- Access 退出：**没有**真反向用例；按方案当前描述，harness 的 front 无条件注入 assertion，退出坏了测试也会过。必须改 harness（见高 #2）。
- 场景注册：新增场景要同步四处，否则 `test_deploy.py` 或覆盖检查会红。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？逐个核对两端。**

逐个核对后发现至少这些消费者不接受：
- **场景名**：产生于 `product-path-browser.test.ts:5477-5496` 和 `browser-acceptance-gate.py:5-24`；消费者还包括 `test_deploy.py:17` 的 `SCENARIOS`、`release-walkthrough-coverage.test.mjs:78-94`、jsdom 走查。只改两处不够。
- **定位器**：产生于 `release-walkthrough-ui.ts`；消费者是 `release-walkthrough-locators.test.mjs`（只扫固定函数名，盲区）和 `release-walkthrough.unit.test.ts`（fixture 只允许 `search.authorization.set`/`memory.page.viewed`，加 `memory.create`/`memory.mutate` 会走 `WALKTHROUGH_FIXTURE_UNAVAILABLE`，见 `:121-135`）。
- **`identity.kind=built-in`**：产生于新变体配置；消费者 `strict-configuration.ts:640-670` 要求 `sessionIdleMilliseconds`/`sessionAbsoluteMilliseconds`，现有 `product-path-configuration.ts:98-115` 是 Access 字段；`admin-cli account create` 要求服务停止（`account-command.ts:137-140`）并输出 `otpUri`（`:175-185`）。需要新配置构造器和 stop/create/start 步骤。
- **`/cdn-cgi/access/logout`**：产生于按钮；消费者是验收 front 代理（未实现，会把请求转给应用 → 404）和 Cloudflare 生产入口。验收 harness 必须新增处理。
- **walkthrough JSON**：产生于单次 vitest 的 `afterAll`；消费者 `run-release-walkthrough.sh:42-50`、`make-packet.py:625-627`、`browser-acceptance-gate.py:29` 都只认一个文件。内置变体要么合并进同一个 JSON，要么改门槛 schema 和脚本。
- **`[UI-S2]`**：现有测试断言 Access 模式没有退出按钮（`app-interactions.unit.test.ts:408-415`），与方案冲突；`app.tsx:560-561` 的显示条件也要改。

结论：方案目前至少有三处“产生方改了、使用方没改”的断裂：`test_deploy.py` 场景清单、验收 front 的 `/cdn-cgi/access/logout`、单文件 walkthrough 对内置变体的容纳。按 I-73 的教训，这些都要在方案里点名并逐个核对。
