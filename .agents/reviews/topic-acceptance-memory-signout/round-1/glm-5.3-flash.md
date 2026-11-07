# 方案设计：发布验收覆盖「记忆增改删 + 退出登录」

## 一、方案依赖的前提

### 读代码或一手来源证实的

1. 发布门槛的 18 个场景名单在 `scripts/delivery-mode/browser-acceptance-gate.py:5-24`（原文 `REQUIRED_SCENARIOS = (...)`），验收测试自己的名单在 `test/integration/product-path-browser.test.ts:5477-5496`，第三份名单在 `scripts/delivery-mode/test_deploy.py:17`。walkthrough 里每个场景必须 `['passed']` 才放行（browser-acceptance-gate.py:48-50）；`deploy.sh` 没有合法 walkthrough 会拒绝部署（`scripts/delivery-mode/deploy.sh:65`）。
2. 名单的“三处一致”有现成自动检查兜底：`test/tooling/release-walkthrough-coverage.test.mjs:54-81` 会解析测试文件里的 `RELEASE_ACCEPTANCE_SCENARIOS` 和门槛 py 里的 `REQUIRED_SCENARIOS`，逐表面核对覆盖表（`memory: ["accept-memory-page", …]` 在 8-32 行定义），名字对不上就挂。
3. 验收剧本所有定位只许出自 `apps/control-center/test/release-walkthrough-ui.ts`，`test/tooling/release-walkthrough-locators.test.mjs:17-34` 用字面检查强制：验收段里出现 `getByRole(`、`locator("字符串")`、`getByText("字面")` 即失败。同一份定位清单也被 jsdom 单测复用（`apps/control-center/test/release-walkthrough.unit.test.ts:425-437`）。
4. 记忆页增改删是真实浏览器路径：添加表单（memory-page.tsx:1443-1452、2043-2120，保存调 `memory.create`）、详情抽屉里「编辑」（456-468，调 `memory.correct`）和「删除」（580-595，调 `memory.remove`，成功后提示 `memory.page.deleted`「已删除，7 天内可在‘最近删除’里恢复」zh-CN.ts:704，删除恢复链接 257 行附近 `memory.recover`）。这些操作走网关 v2 命令（`apps/control-center/src/memory.ts:18-58` 接口名 create/correct/remove/recover），不是前端 stub。
5. 现有 `accept-memory-page` 只开页看计数（product-path-browser.test.ts:5914-5923 原文只 `UI.memoryCount` 可见 + 无 `pageError`）。
6. 退出登录入口只在 built-in 时渲染：`apps/control-center/src/app.tsx:559-563`（原文 `configuration && identityMethod === "built-in" ? <SignOutSetting …/> : undefined`），组件调用 `accountRequest("logout", …)`（`apps/control-center/src/components/sign-out-setting.tsx:21`，实际打 `/api/identity/v1/logout`，见 `account-login.tsx:12`）。
7. Access 模式下“网页内退出”如果只是清 Himawari 自己的会话，必然被静默换发撤销：页面收到 401/403 后 `recoverBrowserEntry` 会调 `/api/identity/v1/sessions` 用 Access 断言静默重建会话并 reload（`apps/control-center/src/browser-entry.ts:54-61`，`gateway-client.ts:98-110`）。所以 Access 议真正的退出就是跳 `/cdn-cgi/access/logout`——Cloudflare 官方文档明确说可以用这个 URL“在应用里做自定义退出按钮”，效果是清应用 cookie、已发令牌 20–30 秒内失效，且“用户无法只退出单个应用”（https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ "Log out as a user" 一节）。产品里已有先例：周报「重新登录」直接 `window.location.assign("/cdn-cgi/access/logout")`（`apps/control-center/src/components/weekly-report.tsx:1085-1087`）；运维手册也把“打开 /cdn-cgi/access/logout 再登一次”当作标准动作（docs/runbooks/production-web-entry-runbook.md:69）。
8. 验收环境模拟 Access 的方式：假发行方提供 `/cdn-cgi/access/certs` 和 `/cdn-cgi/access/get-identity`（`test/fixtures/product-path-harness.ts:618-634`），前端 TLS 服务器给**每个**请求注入新的 `cf-access-jwt-assertion` 头（855-865、867-895），即“Access 会话永远新鲜”。这意味着该环境**无法验证会话过期/退出**，只能按配置直连。
9. `identity.kind: "built-in"` 是严格配置里的一等分支，只要 5 个键（kind/sessionIdle/sessionAbsolute/recentAuthentication/csrf，`packages/platform-node/src/strict-configuration.ts:638-670`），且不需要 `identity-bootstrap` 密钥（1313-1320）；账号只能经 `admin-cli account create` 建，配置必须 built-in（`apps/admin-cli/src/account-command.ts:58-60`），凭据走 0600 私有文件（1-28、86-99 的 mode/nlink/uid 检查）， enrollment 输出文件里带 TOTP `otpUri` 和恢复码（169-186），TOTP 密钥加密入库。
10. built-in 登录/退出的接口层已有带真密码真 TOTP 的集成测试（`test/integration/built-in-identity.test.ts`：112 行 wrong-password 反例、259-267 行调用 `POST /api/identity/v1/logout` 验证撤销），但不经浏览器。
11. Playwright 官方建议：改服务端状态的测试“一个 worker 一个账号”；不需要登录态时可用干净 context（storageState 不带）或 `storageState: { cookies: [], origins: [] }` 重置（https://playwright.dev/docs/auth "Moderate: one account per parallel worker"、"Avoid authentication in some tests"）。本验收是单线程顺序执行一个大 `it`（product-path-browser.test.ts:5733 起），没有并行 worker 冲突。
12. i18n 新增文案被 `check:locale`（`scripts/check-control-center-locale.mjs:39-56`）强制三种语言齐全，新增 UI 文案是三端都要改的“值”。
13. 门槛的反向用例（缺 walkthrough、失败状态、缺场景、超时都拒绝）已在 `npm run check:delivery-deploy` 链路里每天跑（test_deploy.py:386-407；package.json:27、44）。

### 推测 / 未核实

- built-in 模式下网关是否仍然注册 `/api/identity/v1/sessions` 并强制要求 Access 断言头（identity-gateway.ts:1042-1053 只看到注册无开关）——若注册，内置 env 的前端注入行为要另定。
- 内置验收环境选 `publicMode: false`（对齐回退配置 runbook:148）对入口流程的具体影响。
- `test/integration/built-in-identity.test.ts` 生成 TOTP 验证码的具体 helper 能否直接复用到浏览器剧本（`code()` 出处未读到）。
- 内置验收双安装对 Hermes 单线程运行的耗时影响幅度（按现有 beforeAll 400 秒超时推断大约再加几分钟）。

## 二、方案本身

### A. 记忆增改删 —— 放进现有 Access 验收环境，不另起环境

**理由**：生产就是 Access（runbook:63）；记忆增改删的整条链路（页面 → 网关命令 → SQLite memory adapter）与登录方式无关，Access 模式在验收里已能真实走通（现状 accept-memory-page 已能打开页面、CI 里的集成测试已用同一 adapter）；再起一个环境只为了重复同一链路，成本（双安装双浏览器）没有收益。

**改动点（三处名单 + 一处剧本 + 一处定位清单）：**

1. `RELEASE_ACCEPTANCE_SCENARIOS`、门槛 `REQUIRED_SCENARIOS`、覆盖表 `memory` 数组、`test_deploy.py:17` 的 `SCENARIOS` 四处同步加 `accept-memory-crud`（现名单 18 → 19 个）。
2. `release-walkthrough-ui.ts` 新增定位（全部用现有 i18n 鍵，不写死文案）：添加按钮（`memory.page.add`，zh-CN.ts:651）、添加表单 textbox（`aria-label=memory.page.addTitle`，memory-page.tsx:2076）、保存（`memory.save`:618）、取消（`governed.cancel`）、编辑（`memory.editAction`:629）、删除（`memory.deleteAction`:630）、详情抽屉（`role: dialog, name: memory.page.detail`）、通知条（`role: alert`，复用现有 `pageError` 定位模式）、搜索框（`memory.search`）、「最近删除」链接（`memory.page.statusLink`）。文案改了不用动剧本。
3. 场景体（放在 `accept-memory-page` 之后、`accept-phone-layout` 之前）：

- **正向增**：进记忆页，用 `memoryCount` 的正则读出当前条数 N（现成定位 `/^记忆\s*\d+$/`，不写死数字）；点添加，填入唯一文案 `验收增改删 ${crypto.randomUUID().slice(0, 8)}`（运行期生成，不写死）；保存；断言通知 `memory.page.added` 出现、抽屉关闭、列表里出现含 token 的条目、计数变 N+1。
- **正向改**：点开该条目进详情，点「编辑」，文本编辑器初始值在场景里已见到的是原文；改成 `改后内容 ${同一 token 尾巴}`，保存；断言视图显示新文本、变更历史（`memory.history` 区）出现一条事件。
- **正向删 + 反向删的组合**：点「删除」；断言通知含 `memory.page.deleted` 文案样式、「最近删除」链接由隐变显（memory-page.tsx:1599-1605 受 `trashed` 计数驱动）、搜索该 token 在活跃视图得到 `memory.page.noResults`（zh-CN.ts:688，反向断言："不该出现的东西不出现”）；再点恢复，断言回到外部可见、计数为 N+1。恢复后重新删除一次，让最终收敛到“删掉”状态并断言。
- **反向增**：添加表单里留空点保存——按钮本身 disabled（memory-page.tsx:2114 `disabled={memory.busy || !text.trim()}`），断言点击无副作用：无通知、计数不变、无新条目。
- **反向改**：改一半点取消（`TextEditor` 有 onCancel，memory-page.tsx:462），断言详情仍显示原文、变更历史无新条目。
- 全程不点「置顶」开关（见必答 1 的说明），不依赖“最近认证”类 5 分钟门槛（记忆操作不在其内）。

**配套自动检查与反向验证**：`check:release-walkthrough`（coverage + locators 两个检查）会立刻抓名单/清单不同步——反向验证：任删一处名单里的名字，`npm run check:release-walkthrough` 直接红（检查逻辑读过，release-walkthrough-coverage.test.mjs:54-68）。门槛拒收缺/败场景的反向证据已有现成测试（test_deploy.py:398-407）。**新增的遗留动作**：方案要求在 Hermes 上做一次故障演练——把新增场景的某条正向断言人为改错，确认整包被 `deploy.sh` 拒收，留证据文件（对齐 I-73 案例的教训：改动要能证明“反了真的拦不住”才叫有门槛）。

### B. 退出登录 —— 单独起一个内置账号验收环境（新建第二组 installation + browser）

**理由**：退出登录入口目前只存在 built-in 模式（app.tsx:559-563）；验收环境模拟的 Access 因“每请求注入断言”（harness.ts:867-895）永远是登录态，根本没有可退出/不可退出的状态差异可断言；而内置登录是 runbook 明文写的生产退路（runbook:148），它不出支持过的验收吗 = 退路坏了才发现。内置登录经过真实浏览器（真密码、真 TOTP、真会话 cookie）是接口层测试给不了的——I-73 的教训正是“校验链的浏览器端-后端两端都要真走”。

**具体做法：**

1. `installProductPath` 加一个 `identity: "built-in"` 变体：配置 `identity.kind: "built-in"`（只带 sessionIdle/Absolute 取最大值避免场景中途过期、recentAuthentication、csrf），`secretReferences` 去掉 `identity-bootstrap`（strict-configuration.ts:1313-1318 不再要求），harness 分支停止签发注入 `cf-access-jwt-assertion`（ Mediterranean 866-877 属“假 Access”装置，built-in 时不应有）；跳过 POST `/bootstrap`（harness.ts:1227-1253；built-in 配置根本不允许 bootstrap 键，strict-configuration.ts:640-651 的 `rejectUnknown` 会拒绝）。
2. 服务首次 start（authority 文件就绪，account-command.ts:78-85 校验它 active）后，验收测试用 `admin-cli account create` 建账号：`--config` 指向 harness 写好的 configurationPath，`--input` 是测试用 `mkdir mode 0700` 临时目录里 0600 写入的 `{username, password}`（用户名密码运行期随机生成），`--output` 读回 enrollment 文件里的 `otpUri`，测试内本地计算当前 TOTP 码（复用 built-in-identity.test.ts 同一份 helper，不进仓库常量）。密钥只存在于 0600 文件，不进 argv、日志、仓库（对齐 admin-cli 注释 line 30 的约束）。
3. 新 scenario `accept-builtin-sign-out`（名单同样加进四处），由独立 describe 跑自己的 installation 和浏览器 context（不该污染主验收的 context）。正向/反向：

- **正向登录**：打开 origin → 出现登录（entry kind `built-in-login`，browser-entry.ts:54）；填用户名密码 → 第二步填 TOTP（AccountLogin 流程，account-login.tsx:58-84）→ composer 可见；设置 → 账号区出现「退出登录」（`account.signOut`，zh-CN.ts:79），且设备页 `sessions-devices` 有运行期生成的设备名。
- **反向-错误密码**：故意填错密码 → 断言错误提示可见（`account.rateLimited`/拒绝类文案）且没有进入 composer；重试正确密码仍能进（证明被挡的是本次而非账号被锁）。
- **正向退出**：设置 → 退出登录 → 页面回到登录入口；重开新 context（Playwright 官方做法：干净 context 模拟“别的浏览器”，playwright.dev/docs/auth）→ 仍是登录入口，旧 context 的 storageState 在新 context 里也进不去（旧会话已撤销的反向证明；接口层对应证据 built-in-identity.test.ts:259-267）。
- **反向-旧会话**：退出前把当前 context 的 storageState 存下来，退出后用该 storageState 开新 context 直接访问 —— 断言拿不到 composer（401 后进 `built-in-login`），即“撤销过的会话不能复活”。

4. 该环境里 same memory adapter 共用，不需重复记忆 CRUD。

### C. Access 设置里补“退出登录”—— 该补，补成“跳转 Access 退出页”

**判断**：这是产品缺口，应该补。证据链：① Cloudflare 官方文档点名支持“用 `<应用域名>/cdn-cgi/access/logout` 在应用里做退出按钮”（session-management 页面 "Log out as a user"）；② 运维手册已把手动打开这个 URL 当标准动作（runbook:69）；③ 产品内周报流里已经有了这个跳转（weekly-report.tsx:1085），说明先例成立，缺的是设置里的常规入口；④ 反面理由“静默换发会把你拉回来”只说明“假退出”没用，不说明“真退出（清 Access cookie）”不该存在——恰好是它决定按钮必须是跳转而非仅清本地会话。

**怎么做**：`SignOutSetting` 拆成两个形态：built-in 保持现状（POST logout）；cloudflare-access 模式渲染一个新组件（如 `AccessSignOutSetting`），点击先弹确认框（文案写明“会退出 Cloudflare Access 的所有应用会话，重新登录需要邮箱验证码”——对应 Cloudflare 文档 revoke-across-all-applications 语义），确认后 `window.location.assign("/cdn-cgi/access/logout")`。`app.tsx:559-563` 的条件改成两种 identityMethod 各配一个组件。新增 i18n 键三语言同加（被 check:locale 强制）。

**怎么验收**：主验收（Access env）加一个轻场景 `accept-access-sign-out-entry`：设置里出现该入口（按 identityMethod 条件渲染的正向断言 + jsdom 单测同时两种分支）；点击 → 用 Playwright `page.route` 拦截 `/cdn-cgi/access/logout` 的导航请求并返回 200 + 提示，断言浏览器确实发起了到该路径的导航（path 是 Cloudflare 平台固定路径，和 `jwksUrl` 一样属平台契约，写进 i18n/常量一处而非剧本里三处散落）。真正的跨应用清 cookie、20–30 秒令牌失效无法在本机复现，**未核实/信任边界**：属 Cloudflare 平台行为；兜底手段是 runbook「结果验证」加一条一次性人工动作：上线后点一次设置里的退出入口确认 Access 登录页出现（该动作会真的登出 Andy 的 Access 会话，只能手动在用户知情时做，不能自动化进每次发布）。

## 三、考虑过但不选的做法

1. **记忆 CRUD 也放内置环境**：同一条网关链路重复第二遍，多花一套安装时间，只多验证一个 `identityMethod` 前端分支（记忆页不依赖它）。不选。
2. **在主验收里直接走“退出→重登”**：退出会话会把主 walkthrough 后续所有场景（phone 复用 `context.storageState()`，product-path-browser.test.ts:5931、5970）的登录态毁掉，顺序耦合太脆。不选，用独立 describe 隔离。
3. **Access 模式做“只清 Himawari 会话”的退出**：静默换发会在下次 401 时把你登回来（browser-entry.ts:56-61），等于假按钮。不选。
4. **把 Access 退出验收成“真的被 Cloudflare 登出”**：本机无 Cloudflare，验收环境是自签 JWT + 每请求重发断言，任何“会话已无效”断言都测不到真平台。不选，改为断言“跳转发生” + 生产一次性人工验证兜底。
5. **用 JSON 生成器/表单驱动 mock 登录替代真 TOTP**：违反“测试不许用假替身替换业务逻辑”的精神——登录是要验收的真实逻辑。不选。
6. **给 built-in 环境跑 `publicMode: true`**：配置校验大概率允许，但生产退路文档用的是 `publicMode: false`（runbook:148），验收应该模拟会真实落地的形态。选 false（未核实 true/f_false 行为差异，属实施时确认项）。

## 四、风险与反例（漏掉的情况）

- **顺序耦合**：CRUD 场景让后继场景的记忆总数永久 +1，`accept-unrelated-no-memory`（要求“条相关记忆”为 0，test:5803）依赖新记忆与 `写到一个pdf文件` 这条请求无语义重叠——token 用随机 ID，风险低但要在故障演练里验证一次。
- **TOTP 时间窗边界**：验证码在窗口边缘生成会偶发失败；内置剧本须用余量（等下一窗口）或重试一次，避免发布被非产品故障卡住（反例：发布被 30 秒时钟窗拒绝，误判产品故障）。
- **admin-cli 的排它锁**：`SqliteProductStateRepository.open` 与服务抢 state-root 锁（account-command.ts:136 注释），建账号须在 startServices 之后、不动服务；若服务启动要写库可能竞争——未核实竞争窗口大小，实施时把 account create 放进 beforeAll 的关键路径并记录日志。
- **界面文案/aria 改版**：定位走 i18n 鍵意味着改文案剧本自动跟随；但 ARIA 名”（如把按钮改成别的语义角色）变了剧本和 jsdom 单测会同时红——这是好事，但说明改 aria 结构也属于影响验收的破坏性改动。
- **漏掉的情况**：① 手机上的记忆页 tab 只被 accept-phone-layout 拍照检查，增改删只在桌面覆盖（手机真实用户每周要用吗——Andy 决定，见下）；② 「恢复对话里的记忆提案」（`memory.respond`）也没覆盖，属于增之外的入口；③ Access 会话 1 个月后自然过期的路径任何环境都测不到（runbook:62 会话 1 个月），只能靠生产手动。
- **已知门槛缺口（I-73 措辞）**：`accept-model-switch` 同类问题——验收场景没在 Hermes 真跑过之前，门槛是“纸面成立”。本方案的两个新场景同样要等第一次真跑 + 故障演练才算“落门槛完成”。

## 五、需要人拍板的取舍

1. **Access 退出入口算不算产品改动立项**：我判断“该补”（方案 C），但这是 UI 行为变化（会登出整个 Access 会话），按约束“改登录方式属大改动要 Andy 同意”，这条处于灰色地带——按钮本身不是换登录方式，但触发的是平台级登出。需要 Andy 点头。
2. **要不要为退出登录单独开内置验收环境**（方案 B）：多花一套安装/浏览器时间和 Hermes 单线程耗时，换“生产退路被真走”。我的判断是值得；若嫌贵，可接受砍到“只测登录 + 退出 + 反向旧会话”（无记忆操作），但不接受完全不测。
3. **定位清单是否算“地址”约束**：`/cdn-cgi/access/logout` 是 Cloudflare 平台固定路径，我建议写成一处常量（同 `jwksUrl` 的处理）而非配置项；若 Andy 认为“路径也算写死”，则需在配置里加可覆盖字段——成本一样但更通用。
4. **故障演练的执行时机**：每次发布都演练太贵，一次性演练 + 后续靠名单检查，是否可接受。

## 六、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？**

本方案的改动范围仅是：UI 组件（新增 access 退出钮）、测试文件、fixture 配置、i18n、定位清单——不触碰任何组装发给模型的内容的代码路径。一个次级影响：CRUD 场景新增的记忆会在后续场景对话中被检索回提示。这符合现有规则：选中的记忆属“每轮会变的值"，规则明文要求它只在最后一条消息（`.claude/rules/prompt-prefix.md:28` 原文“每轮都会变的内容只放在最后一条用户消息里。例如当前时间、本轮选中的记忆"）；历史只追加的通用要求见同文件 35-36 行。既有阻断检查 `npm run check:prompt-prefix`（prompt-prefix.md:74）会在内容组装真的被破坏时红，且自带反向用例（改写历史、系统提示带变化值、关冻结）。场景我也做了自我设限：不点「置顶」，避免新记忆进入“每次都带上”的路径。结论：模型请求开头不变，每轮变的值仍在末条消息。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

不会。方案改的是 UI/测试/配置文案，不涉及发送给模型的内容序列化。新增的 i18n 键是编译期固定的目录条目；记忆文本由场景固定（同一次运行内不变），后续轮次若被取回，遮盖按“遮法只取决于自己和前面的内容"的确定性规则处理（prompt-prefix.md:52-54），且请求遮盖确定性有现成阻断检查兜底。场景产生的随机 token 只进 UI 数据库与记忆库，不进任何“无序集合”或时间戳驱动的序列化。唯一带时间的值（`get-identity` 的 `iat`、JWT 签发时间）是**既有** fixture 行为（harness.ts:628、855-865），本次不触碰。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

分四层，每层给反例下落：① 名单一致性——`release-walkthrough-coverage.test.mjs:54-81` 解析三处源码逐一比对，加错名字/漏加 `test_deploy.py` 都会红（逻辑已读，属可静态验证的强一致）；② 定位清单独占性——`release-walkthrough-locators.test.mjs:17-34`，剧本里手写定位即失败；③ 门槛拒收——walkthrough 缺场景/状态非 passed/超时都产生 `BROWSER_ACCEPTANCE_*` 退出码 1（gate py:48-56），其反向真实失败由 `check:delivery-deploy` 的 test_deploy.py:399-407 日常验证（缺包、另一 artifact、失败状态、无计时的拒绝用例全部在跑）；④ 剧本内部的新反向断言（错误密码、旧会话、删后搜不到、空表单不可保存）其“真的会拦住故障”目前**只能**靠两类证据：接口层同类反向用例已存在且会失败（built-in-identity.test.ts:106-109、259-267），外加要求 Hermes 上一次性故障演练（见方案 A 配套）补上端到端证据——这是与 I-73 相同级别的诚实成本，不做完之前“门槛已落”不算数。

**4. 每个产生/修改的值，两端都核过了吗？**

逐值核对：

- `accept-memory-crud` / `accept-builtin-sign-out`（新场景 id）：产生处=测试名单+剧本；消费处=门槛 py、覆盖表（含 `memory` 表面数组）、`test_deploy.py` 的模拟 walkthrough、walkthrough 写入过滤（test:5718-5720 按 `RELEASE_ACCEPTANCE_SCENARIOS` 过滤 results）。四个名单 + 一个覆盖表必须同步，否则 ① 层检查报错——双端都有校验，且校验本身反例可跑。
- 新定位键（`memory.add/edit/delete/save/…`）：产生处=`release-walkthrough-ui.ts`；消费处三端——浏览器剧本、jsdom 单测（`release-walkthrough.unit.test.ts:425-437` 同用 UI 清单）、locators 独占性检查。名字必须与组件 aria 属性（来自 i18n 鍵）一致，jsdom 单测充当"两个包规则一致"的对账端。
- 新 i18n 键：产生处=三个语言目录；消费处=`message-ids.ts` 注册表 + `check:locale`（en 与 zh/ja 逐键比对，缺译报错）+ UI 组件。IA 上还要过 `check:glossary`、`check:layout` 等整链路（package.json:27）。
- Access 退出按钮的跳转路径 `/cdn-cgi/access/logout`：产生处=新常量/组件；消费处=浏览器导航（真 Cloudflare 处理）、剧本 route 拦截断言、jsdom 单测断言 assign 调用。后端校验端是 Cloudflare 平台（文档确认路径合法），本仓库无后端二次校验——这正是该值要么写文档、要么配置化的理由之一。
- built-in 配置键（`identity.kind` 等 5 键、去掉 `identity-bootstrap` ref）：产生处=新 fixture 变体；校验端=strict-configuration.ts:640-670（只收 5 键，`rejectUnknown` 反过来说明多塞会当场配置失败——这条校验是“改动本身能通过生产校验”的硬证据）+ secretReferences 端（1313-1327 只强制 csrf 密钥存在）。
- `admin-cli account create` 的三组值（凭据私有文件 0600/enrollment 输出/TOTP 密钥入库）：产生处=admin-cli（主动校验输入文件 mode/uid/nlink，account-command.ts:86-99、119）；消费处=验收测试读回 otpUri 算码、服务端验证登录（built-in 会话校验，接口测试端已证）。配套校验：authority active 断言（78-85）。
- walkrguard 汇总值 `results`/`walkthrough.json`：过滤阈值改动龙头在 test:5718，消费端 gate 按 `results[].scenario/status` 收——schema 不变，无格式风险。
- 唯一实测端 slack：新场景要求的坐标在第一次 Hermes 真跑前都是未验证推定（同 I-73 case 里"该场景还没在 Hermes 上真跑过"的教训），方案把“真跑 + 故障演练”列为完成定义的一部分，而不是可选步骤。
