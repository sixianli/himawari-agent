## 结论摘要

方案的方向（模型只见元数据、值只在出口出现、按目的地核对）是对的，但有几处硬伤会直接推翻它的安全承诺：**聊天里输入的密码会以明文进对话记录**、**模型回显占位符会被还原成明文写进历史**、**“照抄 1Password”与 1Password 实际“每次放出都要人批准”不一致**、**`vault_request` 是一个没有幂等/SSRF/重定向/大小限制的通用带密 HTTP 客户端**、**字段名被当作自由文本标识符**、**沙箱能力程序拿到值后可以把值打印出来**。下面按严重度列，先列证实的，再列推测/未核实。

---

## 证实的发现（按严重度）

### 严重

**1. “对话记录、记忆、日志里永远没有值”与 ADR 0183 和现有还原机制直接矛盾；聊天里输入的密码会明文入库，模型回显占位符会被还原成明文写进历史。**
- 证据：
  - `docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:38-40`：“敏感信息只在数据发往外部时遮盖；Himawari 自己的存储和界面展示用主人的原文。”第 69 行：“主人的数据库里会有密码、密钥的明文拷贝”。
  - `packages/runtime-pi/src/egress-context.ts:57-92`：`restoreModelStream` 会把助手文本里的占位符还原成原文，`restoredMessage` 只处理 `block.type === "text"`，还原后的消息进入历史/显示。
  - `packages/sensitive-capture/src/redaction.ts:310-329`：`mask` 会把值放进 `table` 和 `known`，用于后续还原。
  - 方案 v2 删掉了 v1 第 2 条“存完把聊天记录里的明文换成 `[已存入保险箱：名字]`”这一步，却没有给出替代方案。
- 建议：二选一，并在 ADR 里写清：
  - (a) 这一版不支持“聊天里直接打密码存保险箱”，只支持 iPhone 录入；或
  - (b) 在入库前就把聊天消息里的值换成占位符，历史里只存占位符；这需要一条对“只追加”规则的明确例外（不能事后改写已发出的历史），并且要证明改写后的字节与当时发给模型的一致。
  - 无论哪种，都要让 `restoreModelStream` **不还原保险箱占位符**（只还原普通出口遮盖的占位符），否则模型一在文本里复述占位符，历史里就会出现明文。

**2. 1Password 的真实安全模型是“每次放出凭据都要人批准、没有长期授权”；方案“同一项同一站点以后不再问”与它引用的第一手来源相反，也弱于 1Password。**
- 证据：<https://support.1password.com/1password-claude-security/> 原文：“**A human approves every credential release.** Each request Claude makes is shown to you in a prompt from the 1Password desktop app. **There are no standing approvals: a new agent session means a new prompt.**” 同页还写“Access is scoped and short-lived... discarded when the session ends or after a hard time limit.”
- 方案 v2 第 6 条：“同一项同一站点以后不再问”，第 8 条“长期授权列表和撤销”，并在开源表里写“1Password for Claude … 照抄安全设计：…人批准”。
- 建议：默认改成“每次释放都要批准”（至少对密码、银行卡密码、PIN、TOTP 种子这类高价值项）；长期授权只用于低风险、只读的 API key，并且要主人显式打开。若坚持“每站点首次批准”，就不要写“照抄 1Password”，并在方案里说明这是比 1Password 更弱的模型、残余风险是什么。

**3. `vault_request` 是通用带密 HTTP 客户端，缺少 SSRF、重定向、请求头/查询参数限制、幂等/对账、响应大小/超时限制；它可以把密码发到任意允许站点的任意路径，也可以重复提交付款。**
- 证据：
  - 方案第 4 条：“`vault_request(编号, 网址, 方法, 放在哪)`，由服务器代发，按 bearer/请求头/查询参数/JSON/表单放进 key。网址的站点必须在允许名单里，跨站点跳转不跟。响应里出现原值就遮掉。”
  - 仓库现有的 `packages/runtime-sandbox/src/network-egress.ts:61-79` 只对沙箱代理做 `host:port` 白名单和公网 IP 检查；`:138-179` 对 HTTPS 只做 CONNECT 隧道。方案说“不在沙箱出口代理里替换”，但也没有指定服务器代发使用哪个安全客户端。
  - `packages/application/src/services/web-capability-service.ts:285-364` 的 `executeAction` 有 `idempotencyKey`、`authorityFence`、`reconcile`；`vault_request` 没有对应机制。
- 建议：不要把 `vault_request` 做成通用 HTTP 客户端。改成“准备/执行”两步，或要求登记好的连接器/操作（固定方法、固定路径模板、固定字段、固定风险档），由程序生成请求；必须：只允许 https、禁止跟随重定向、DNS 解析后只连公网地址、禁止 `Host/Content-Length/Transfer-Encoding/Connection/Cookie` 等危险头、禁止 CRLF、禁止把秘密放查询参数、限制响应大小/超时/并发、对不可逆操作要求幂等键和结果未知时的对账。否则“付款、转账、改密码每次问”无法落实，因为通用 HTTP 工具不知道自己在付款。

**4. 响应和页面快照只遮“原值”，不遮编码/变换后的值；允许站点可以把密码 base64、URL 编码、JSON 转义、hex、反转后回显给模型，模型能解出来。**
- 证据：方案第 4 条“响应里出现原值就遮掉”“返回给模型的页面快照…出现原值的地方换成固定占位符”。`packages/sensitive-capture/src/redaction.ts:411-425` 的 `known` 匹配是精确字符串匹配，不做编码变换。1Password 的做法是填值期间“agent sleeps”，不让 agent 在值还在页面时读页面（见上引 1Password 页“While 1Password fills, the agent sleeps”）。
- 建议：
  - 填值/发请求期间不返回原始响应体或页面快照，只返回成功/失败/状态码；需要页面内容时，等值已从 DOM 清除或重新导航后再读。
  - 如果必须返回内容，做多编码扫描（原值、URL 编码、base64、hex、JSON 转义、HTML 实体、反转）并遮掉；加一个“金丝雀值”在响应里以各种编码出现都必须被遮的测试。
  - Stagehand 的 `observe` 调用模型时，页面内容也要先经过同样的扫描/遮盖，不能只靠出口遮盖的通用规则。

**5. 字段名是主人定义的自由文本，却被当作 `vault_list`/`vault_save`/`vault_fill`/`vault_request` 的标识符；它过不了 `machineString`，会重名，也无法表达字段类型（密码 vs TOTP 种子）。方案的“编号过四处校验”没有覆盖字段名。**
- 证据：
  - 方案第 1 条：“字段名（用户名/密码/PIN/key/两步验证种子等，主人定）”；第 4 条模型写 `vault_fill(编号, 字段)`。
  - `packages/gateway-contracts/src/validation.ts:49-62` 的 `machineString` 只允许 `[A-Za-z0-9._:-]`，中文/空格字段名过不了；如果工具参数用 `machineString`，主人定的“密码”会直接失败。
  - `packages/application/src/ports/web.ts:67-88` 的 `PreparedWebAction` 只有 `fieldRefs`，没有“字段→哪个保险箱项/字段”的映射；`vault_fill(id, field)` 无法安全地绑定到具体输入框。
- 建议：把“字段”拆成三样：
  - `fieldKey`：稳定、严格（例如 `[a-z][a-z0-9-]{0,31}`），所有消费者共用；
  - `label`：主人看的显示名，可自由文本，但不作标识符；
  - `fieldType`：枚举（`username`、`password`、`pin`、`api_key`、`totp`），决定能不能 `vault_fill`、能不能 `vault_request`、TOTP 是否只允许派生码。
  在 `vault_list` 里返回 `fieldKey` + `label` + `fieldType`，模型只写 `fieldKey`；`vault_save` 和 `vault_fill` 都按 `fieldKey` 精确匹配。把 `fieldKey` 加进 I-73 式的新值清单，逐个使用处核对。

**6. 方案把“模型可见的编号”和“主机密钥引用”“沙箱程序名”“载荷引用”混为一谈；实际消费者校验不同、来源也不同。**
- 证据：
  - `packages/platform-node/src/host-secret-source.ts:65-73` 的 `assertReferencePart` 校验的是**主密钥引用**（`keyRef`），不是保险箱项编号；方案第 1 条说“编号…同时过…主机密钥引用…校验”，这是错配。
  - `apps/execution-worker/src/program-secret-injection.ts:20-33`：`name` 是程序变量名，用 `^[a-z][a-z0-9-]{0,31}$` 校验；`ref` 是 `secretRef`，只要求出现在 `granted` 里。方案说“编号…过…沙箱程序名…校验”，但编号如果作为 `ref`，并不过这个正则；如果作为 `name`，那它又是程序变量名。两者不能混。
  - `packages/execution-contracts/src/contracts-v2.ts:125-129` 的 `secretReferenceSchema` 用 `machineString` 校验 `secretRef`；`packages/platform-node/src/payload-protector.ts:86-103` 的 AAD 又把 `ref` 绑进加密。编号同时是公开 slug、payload ref、secret ref 时，改编号就要重加密、重授权、重写能力清单。
- 建议：分离四个值：
  - `itemId`：内部随机、不可变、不显示给模型，作为 payload ref；
  - `slug`：模型可见的稳定别名，严格校验，永不复用；
  - `secretRef`：能力清单/沙箱用的引用，带独立命名空间（例如 `vault:<itemId>:<fieldKey>`），由专门的 `VaultSecretSource` 解析，不落到主机密钥源；
  - `masterKeyRef`：主密钥引用，单独配置。
  按 ADR 0257 的“新值清单”格式，逐行写“谁产生、谁使用、两端怎么校验、哪道检查守着”。

**7. 沙箱能力程序拿到明文后可以把值打印出来、写文件或发网络；方案只说“模型自己写的脚本拿不到值”，但没有遮能力程序的输出，也没有限制它的网络范围。**
- 证据：
  - `apps/execution-worker/src/program-secret-injection.ts:34-53`：`injectProgramSecrets` 把解析出的 `secrets` 直接放进返回的 JSON；程序可以 `console.log(JSON.stringify(input))` 或写文件。
  - `docs/adr/0031-isolated-tool-execution.md:73`：“runtime socket、Host 私有控制 IPC、数据库和长期秘密不交给任务。”
  - 方案第 4 条：“现有 secretRefs 注入…只给事先审查过的能力程序；模型自己写的脚本拿不到值（它可以把值打印出来带走）。”这句话只解释了为什么不给模型脚本，没有解释为什么审查过的程序不会带走。
- 建议：把能力程序的 stdout/stderr、生成的文件、返回值都当作不可信输出，用本次用过的保险箱值做遮盖；限制该能力的网络 scope（例如只允许它需要的 API 主机，不允许任意出网）；能力安装/审查时把要访问的 `secretRef` 明确列给主人看；加“能力程序打印金丝雀值必须被遮/必须失败”的测试。

### 高

**8. 苹果“密码”不能像方案说的那样“一键带入”任意第三方站点的密码；iOS 只为 App 关联域名推荐凭据，第三方服务苹果明确要求用 `ASWebAuthenticationSession`。**
- 证据：<https://developer.apple.com/documentation/security/password-autofill> 原文：“Password AutoFill recommends credentials **only for your app’s associated domain**, and the user must authenticate using Face ID or Touch ID before accessing these credentials.” 同页：“if you need to log into a third-party service, use `ASWebAuthenticationSession` instead, which supports Password AutoFill when your user hasn’t already logged in.”
- 方案第 2 条：“值的输入框用 iOS 密码类型，可以点系统自动填充从苹果‘密码’一键带入（苹果唯一允许的接法）。”
- 建议：改成“手动输入/粘贴”，或对第三方站点用 `ASWebAuthenticationSession` 登录（但那是登录，不是把密码读进保险箱）；如果要接苹果“密码”，只能做凭据提供方扩展（把 Himawari 的凭据提供给别的 App），不能读取任意密码。把这一限制写进 iPhone 端设计。

**9. “分几步”与“新工具一次加齐，已有对话的请求开头只换新一次”自相矛盾；按当前分步，工具集会变三次，前缀会重算三次。**
- 证据：方案第 1 步加 `vault_list`/`vault_save`，第 2 步加 `vault_request`，第 3 步加浏览器工具；方案末尾又说“新工具一次加齐…只换新一次”。`.agents/instructions/prompt-prefix.md:42-45` 规定工具集合变了才换新一次，并且“每次都留记录”。
- 建议：要么所有工具在同一个发布里加齐（后面的工具先以“未启用”的固定定义存在，执行端返回固定错误码），要么承认会换新多次，并在每次换新时记录。不要同时写两种。

**10. `vault_list` 只规定“按编号排序”，没有规定允许的地方、字段名、字段类型的顺序和序列化；同一项在不同请求里可能输出不同字节。**
- 证据：方案第 3 条“返回编号、名字、字段名、允许的地方，按编号排序”；`.agents/instructions/prompt-prefix.md:53`：“JSON 的键顺序、工具的顺序、列表的顺序…都要固定，不能依赖对象遍历顺序或数据库返回顺序。”
- 建议：所有集合/列表都排序（`allowedOrigins.sort()`、`fields.sort(by fieldKey)`），用稳定的 JSON 序列化；结果里不要放时间、版本、最近使用时间这类每轮会变的值。加一个“打乱数据库返回顺序，`vault_list` 字节不变”的测试。

**11. 新工具没有登记进 ADR 0257 的工具动作登记表/能力清单，也没有风险档；“付款、转账、改密码每次问”对通用 `vault_request` 不可执行。**
- 证据：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:105-122`（没登记的工具给不了模型、权限引擎要求能力清单）、`:139-155`（按事实判断）、`:163-169`（读过外来内容后的中风险动作先一律问）；`packages/application/src/services/tool-action-registry.ts:71-79` 要求行有家族、内容来源、授权路径、能力名。
- 方案只在第 5 条写“走统一授权出口（ADR 0257）”，没有写 `vault_list`/`vault_save`/`vault_request`/`vault_fill` 的登记行、能力清单、动作类别、是否可撤销、是否对外、结果算谁的内容。
- 建议：按 ADR 0257 给四个工具各写一行登记；`vault_request` 不能登记成“读取”，除非它只能做只读 API；对会写/付款的请求，必须走“准备动作 + 结构化事实 + 风险档”的路，而不是让模型直接发任意 HTTP。加真实工具定义快照（字节和顺序）测试。

**12. 批准的绑定/撤销不完整：按 (项, 站点) 的长期授权没有绑定字段/动作；替换值、改允许的地方、删除项时没有说会不会撤销；在途操作没有 fence。**
- 证据：方案第 6 条“同一项同一站点以后不再问”，第 8 条“长期授权列表和撤销”；`packages/application/src/services/web-capability-service.ts:218-232` 的 `blockSessionsAfterAuthorityTransfer` 展示了“授权转移后阻断会话”的做法，但方案没有对应设计。
- 建议：批准键至少是 `(itemId, origin, fieldKey, actionKind)`；替换值/改允许的地方/删除项时撤销相关长期授权；撤销要立即生效，并用 `authorityFence`/修订号让在途操作失效；批准令牌要短期、单次、绑定请求哈希。

**13. 没有密钥管理/轮换/恢复方案：主密钥丢失则所有值不可恢复；轮换没写；删除/替换后旧密文可能留在 SQLite/WAL/备份里。**
- 证据：`packages/platform-node/src/payload-protector.ts:273-308` 已有 `rewrap`（KEK 轮换），但方案第 1 条只写“专用主密钥放主机密钥源”，没有写轮换、备份、丢失后的处理。`docs/adr/0183` 已经说明数据库里会有明文拷贝；保险箱的值虽然加密，但备份/恢复同样需要主密钥。
- 建议：写清主密钥的 provisioning、备份/托管、轮换流程（用 `rewrap` 重包 DEK，保留旧 KEK 直到全部重包完成）、删除/替换的保留策略（备份/WAL 不保证擦除，至少说明“旧密文在备份中仍存在，靠主密钥轮换使其不可读”），以及“服务器被完全攻破时值会泄露”的威胁模型。

### 中

**14. `vault_request` 允许把秘密放查询参数，会经服务器访问日志、代理、Referer 泄露；也没有限制请求头名称。**
- 证据：方案第 4 条“按 bearer/请求头/查询参数/JSON/表单放进 key”；`packages/runtime-sandbox/src/network-egress.ts:9-29` 只对代理剥离 hop-by-hop 头，不覆盖服务器代发客户端。
- 建议：禁止把秘密放查询参数；请求头只允许白名单（如 `Authorization`、`X-Api-Key`），拒绝 CRLF、`Host`、`Cookie`、`Content-Length`、`Transfer-Encoding`、`Connection`、`Proxy-*`；审计只记 origin，不记完整 URL。

**15. `vault_save` 可能覆盖已有项或给已有项加“允许的地方”；方案说“允许的地方只能主人改”，但没有把 `vault_save` 限制成只能新建。**
- 证据：方案第 2 条“存进去的这项状态是‘待确认’”，第 5 条“条目的允许地方只能主人改”；但没有说 `vault_save` 遇到已存在的编号怎么办。
- 建议：`vault_save` 只能新建（或新建一个待确认版本）；编号冲突直接拒绝；任何对已有项的允许地方/状态/字段的修改只能由 iPhone 主人操作，并走版本号乐观锁。

**16. TOTP 种子可能被当成普通字段通过 `vault_fill` 或 `vault_request` 发出去；方案没有字段类型来禁止“填种子”，只允许“派生码”。**
- 证据：方案第 7 条“保险箱可存两步验证种子，程序当场算出 6 位码填进去”；第 1 条字段名自由文本；第 4 条 `vault_fill(编号, 字段)` 和 `vault_request` 没有按字段类型限制。
- 建议：`fieldType: "totp"` 的字段禁止 `vault_fill` 直接填种子、禁止 `vault_request` 发送种子；只允许“计算 6 位码并填进 `otp` 输入框”；码不落库、不进日志、不进模型、页面快照里出现也要遮。

**17. 没有资源上限：`vault_request` 的响应大小/超时/重定向/并发、`vault_fill` 的浏览器超时、`vault_list`/`vault_save` 的条目数/值大小/字段数。**
- 证据：方案没有写任何上限；`packages/application/src/services/web-capability-service.ts:18` 有 `MAX_PUBLIC_RESOURCE_BYTES = 2 * 1024 * 1024` 可作参照；`network-egress.ts:80-88` 有 10 秒超时和 16 KB 头限制。
- 建议：给 `vault_request` 设最大响应体（例如 2 MB）、连接/读取超时、最大重定向次数 0、并发上限；给 `vault_fill` 设页面加载/观察/填值超时；给 `vault_save` 设值长度（例如 4 KB）、字段数、允许地方数；给 `vault_list` 设条目上限/分页。

**18. 自动检查没有落到一个命名的门槛，也没有证明反向用例会失败；覆盖面缺工具调用参数、沙箱输出、浏览器/Stagehand/CDP 日志、HTTP 客户端日志、推送正文、编码后的响应、聊天输入路径。**
- 证据：方案“自动检查”只有金丝雀和反向验收的描述；`docs/incidents-and-gates.md:112` 的 I-73 教训是“只看改动本身不够”，门槛要能自动运行并拦住。`.agents/instructions/prompt-prefix.md:74-81` 的检查是一个具体命令，方案没有对应命令。
- 建议：新增 `npm run check:vault-contract`（所有新值过所有消费者，反向值必须失败）和 `npm run check:vault-canary`（全流程 + 反向注入必须失败），并加进 `npm run check` 和上线验收；反向用例直接调用工具，不依赖模型“被说服”。

**19. Stagehand 默认支持 iframe 和 Shadow DOM；方案的“顶层页面/不填跨站点 iframe”必须由程序显式拒绝，不能假设 Stagehand 不做。Stagehand v4 返回 `{ data: Action[] }`，且要禁用 Browserbase/服务端缓存/遥测。**
- 证据：<https://docs.stagehand.dev/v4/basics/observe>：“Iframe and Shadow DOM support Stagehand automatically handles iFrame traversal and shadow DOM elements without requiring additional configuration.” 同页示例返回 `result.data`；<https://docs.stagehand.dev/v3/references/observe> 也写“Iframe and Shadow DOM interactions are supported out of the box.” 方案第 4 条说“它返回的输入框由程序核对：可见、在顶层页面、同站点、类型对”。
- 建议：程序拿到 `Action.selector` 后，解析它是否在顶层 frame、是否 Shadow DOM、是否同 origin；任何 iframe/shadow DOM/跨 origin 直接拒绝。使用本地浏览器（不要 `env: "BROWSERBASE"`），关闭 `serverCache`/遥测；用 v4 的 `result.data`。

**20. Playwright 在仓库里只有 `@playwright/test` 这个 devDependency，不是运行时 `playwright` 依赖；方案说“仓库已有依赖、直接用”需要补运行时依赖和沙箱浏览器安装。**
- 证据：`package.json:117-120` 只有 `@axe-core/playwright` 和 `@playwright/test`。
- 建议：显式加 `playwright` 运行时依赖，锁定版本，在沙箱镜像里安装 Chromium；加一个“沙箱里能启动浏览器”的检查。

**21. “读过外部内容后的使用默认问一次”比 ADR 0257/0278 的“每个有后果的动作都要主人批准”更弱。**
- 证据：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:48`：“写操作由 `askAfterExternalContent` 接手，每一个都要主人批准”；`:73`：“主人同意的任务读过网页后要写东西时，主人会多收到审批请求，每个写操作一次。” `docs/adr/0257...md:163-169`：“先做的：出卡片等主人点头。”
- 建议：默认按 ADR 0257/0278 每次问；如果主人想对某项某站点“设成不问”，那是一个需要评估的放宽，应该另写 ADR/评测，不要在这个方案里默认推荐。

**22. 方案没有给保险箱元数据定数据分级；如果值用 `restricted`，`vault_list` 的元数据也可能被模型出口拦下；如果元数据用 `private`，又可能在导出/推送里出现。**
- 证据：`packages/gateway-contracts/src/contracts.ts:17` 的分级是 `public/private/sensitive/restricted`；`packages/platform-node/src/payload-protector.ts:194-201` 把 `dataClassification` 绑进 AAD。
- 建议：值用 `restricted`（永不出模型/外部服务）；元数据用 `private` 或 `sensitive`，并明确 `vault_list` 的返回分类、导出/推送是否包含元数据。加测试证明 `restricted` 的值不会进入模型请求。

### 低

**23. “只有三个出口能解密”不准确：`vault_save` 的占位符还原、TOTP 计算也会接触明文。** 建议改成“四个接触点：保存、填表、代发、沙箱注入；TOTP 只派生码”。

**24. “编号…过主机密钥引用校验”是错配；主机密钥引用是主密钥，不是项编号。** 见第 6 条。

**25. “1Password、Bitwarden 有程序接口，但数据要经第三方服务”不完全准确：Bitwarden 可自托管；1Password Connect 可自托管但需从 1Password 云同步。** 建议改成“默认要经第三方/云同步；若坚持数据自持，先评估自托管 Bitwarden 或本地方案”。

**26. “agent-auth（MIT，1 星）…照抄”作为安全设计依据太弱；** 建议主要依据 1Password、Anthropic/OpenAI 的一手安全文章，1 星项目只作参考。

---

## 推测 / 未核实

- **`vault_save` 如何拿到当前模型请求的占位符对照表**：`restoreModelStream` 只还原助手文本，不还原工具调用参数（`packages/runtime-pi/src/egress-context.ts:57-92`）；`vault_save` 要自己还原，需要把 `Exchange.table` 从模型传输层传到工具执行层。方案没有写这个管道；我未在代码里找到现成的“把 exchange 传给工具”的机制。**未核实，需在实现前确认。**
- **服务器代发 HTTP 客户端是否已有 SSRF 防护**：我未在仓库里找到方案所说的“服务器代发”客户端；`network-egress.ts` 是沙箱代理，不是应用层 HTTP 客户端。**未核实。**
- **`web-capability-service` 能否直接承载 `vault_fill`**：现有 `AuthenticatedWebAdapterPort.prepare` 只收 `fieldRefs`，没有“字段→秘密”的映射（`packages/application/src/ports/web.ts:164-177`）。方案说“接到现有机制上”，但需要扩展契约；**未核实是否有其他适配器已支持**。
- **苹果 `ASWebAuthenticationSession` 能否满足“把密码存进 Himawari 保险箱”**：苹果文档只说它支持第三方服务登录，不是说能把密码读出来；**需要产品层面确认**。
- **Stagehand 在本地浏览器模式下是否还会发遥测/使用 Browserbase 服务**：文档说服务端缓存只在 Browserbase 下生效，但遥测未核实；**实现时要显式关闭并抓包验证**。

---

## 侧重检查

我按你给的侧重逐项查了这些路径，结论如下：

**错误路径**
- `vault_save` 传非法占位符/不存在的占位符/非占位符字面量/已存在编号/非法字段名/非法 origin：方案只说“所有错误只返回固定错误码”，没有逐个定义错误码，也没有测试。**缺口。**
- `vault_request` 传 `http://`、带 userinfo 的 URL、IP 字面量、解析到内网的域名、`TRACE`/`CONNECT`、带 `\r\n` 的头、`Host`/`Content-Length`、超大/超慢响应、30x 重定向：方案没有覆盖。**缺口，且是安全缺口。**
- `vault_fill` 传隐藏字段、跨 origin iframe、Shadow DOM、页面在准备/执行间变化、提交失败：方案覆盖了“隐藏/跨站点 iframe/页面变了/失败清空”，但没覆盖 Shadow DOM、`prepare/execute` 与填值的时序、提交后服务端已成功但客户端超时的“未知结果”。**部分缺口。**
- 主密钥不可用/损坏：`EnvelopePayloadProtector` 会抛 `PAYLOAD_KEY_UNAVAILABLE`（`packages/platform-node/src/payload-protector.ts:351-363`），方案没有说这时是拒绝所有保险箱操作、还是回退明文。**缺口。**

**不合规范/不可信输入**
- 模型是不可信的：它可以传任意 `编号`、`字段`、`网址`、`方法`、`放在哪`、请求头。方案的校验重点是编号，字段名/头名/方法/URL 规范化都没有定义。**缺口。**
- 网页是不可信的：提示注入、隐藏字段、跨站点 iframe、DOM 变化、页面脚本、Service Worker、WebSocket、DNS prefetch、`file://`/`data:`/`blob:`。方案覆盖了前几项，没覆盖 Service Worker/WebSocket/DNS prefetch/非 HTTP scheme。**缺口。**
- 主人输入是不可信但可纠正的：origin 需要小写、去默认端口、处理 IDN/尾点、拒绝 `http`（除非明确允许本地）。方案说“精确 origin”，但没有写规范化规则。**缺口。**

**安全**
- 服务器持有主密钥并能解密所有值：这能防“模型/上下文泄漏”和“只拿到数据库”，但**防不了服务器进程被攻破**。1Password 的模型是“agent 提供商根本不接触秘密”，本方案不是；方案应把威胁模型写清，不要让 Andy 以为它等价于 1Password。**证实的差异。**
- `vault_request` 的 SSRF/重定向/查询参数/头注入：**证实的缺口**（见第 3、14 条）。
- 响应/页面快照的编码变换泄漏：**证实的缺口**（见第 4 条）。
- 沙箱能力程序输出/网络：**证实的缺口**（见第 7 条）。
- Stagehand 的 LLM 调用和浏览器共享网络：如果页面和 Stagehand 的模型调用在同一网络命名空间，页面可能把数据发到模型网关或把网关当 oracle；方案没有把“页面的网络”和“Stagehand 调模型的网络”分开。**推测/需设计确认。**
- 日志：服务器 HTTP 客户端、Playwright、Stagehand、CDP、systemd journal、审计、错误详情都可能带值；方案只说“日志里永远没有值”，没有列出这些路径。**缺口。**

**资源耗尽**
- `vault_request` 的响应大小/超时/重定向/并发、`vault_fill` 的浏览器超时、`vault_list`/`vault_save` 的条目/值/字段上限：方案都没有。**缺口**（见第 17 条）。
- TOTP 计算很便宜；但 `vault_fill` 的 `observe` 可能对超大页面反复调模型，费用/时间可能失控。**缺口。**

**不可撤销操作**
- `vault_request` 可以直接调用付款/转账 API：没有幂等键、没有“未知结果”对账、没有准备动作。**证实的缺口**（见第 3 条）。
- `vault_fill` 填表后提交：现有 `executeAction` 有幂等/对账（`web-capability-service.ts:285-364`），但方案没有说填值本身如何接入；填值可清，提交不可逆。**部分缺口。**
- 删除/替换值、撤销长期授权、主密钥丢失/轮换：方案没有写撤销对在途操作的影响、旧密文保留、备份恢复。**缺口**（见第 12、13 条）。

**规则/说明文档/代码一致性**
- 方案“对话记录永远没有值” vs ADR 0183 + `restoreModelStream`：**矛盾**（第 1 条）。
- 方案“照抄 1Password 人批准” vs 1Password “每次释放都要批准、没有长期授权”：**矛盾**（第 2 条）。
- 方案“苹果密码一键带入” vs Apple “只为关联域名推荐、第三方服务用 ASWebAuthenticationSession”：**矛盾**（第 8 条）。
- 方案“新工具一次加齐” vs 分三步加工具：**矛盾**（第 9 条）。
- 方案“读过外部内容后默认问一次” vs ADR 0257/0278 “每个有后果动作都问”：**偏弱**（第 21 条）。
- 方案“编号过主机密钥引用/沙箱程序名” vs 代码实际校验对象：**错配**（第 6 条）。
- 方案“Playwright 仓库已有依赖” vs `package.json` 只有 `@playwright/test` devDependency：**不准确**（第 20 条）。
- 方案“Stagehand v4.4.0 MIT” vs npm/GitHub：**属实**（4.4.0、MIT）；但 v4 返回结构是 `{ data: Action[] }`，实现要对。

---

## 如果由我来定，我会怎样改这份方案

1. **先定威胁模型和产品取舍**：明确“服务器能解密所有值，防的是模型/上下文/数据库单独泄漏，不防服务器被完全攻破”；让 Andy 在这个前提下选“服务器存”还是“只 iPhone 存”。不要把它说成 1Password 等价。
2. **把“值”和“元数据”彻底分开**：值用 `EnvelopePayloadProtector` 加密，分类 `restricted`，payload ref 用随机内部 id（不用模型可见 slug）；元数据（名字、字段 label、允许 origin、状态）单独存，分类 `private`/`sensitive`，并考虑把元数据哈希绑进 AAD 或单独 MAC，防止数据库被改。
3. **新值清单照 ADR 0257 的格式写全**：`itemId`、`slug`、`fieldKey`、`fieldType`、`allowedOrigin`、`secretRef`、`masterKeyRef`、`approvalRef`、`status/version`、`totpCode`。每个值写“谁产生、谁使用、两端怎么校验、哪道检查守着”，不要只写“编号过四处”。
4. **字段模型**：`fieldKey` 严格 slug + `label` 自由文本 + `fieldType` 枚举。`vault_list` 返回三者；`vault_fill`/`vault_request` 只接受 `fieldKey`；`totp` 字段只能派生码，不能直接填/发。
5. **聊天输入路径二选一**：这一版只支持 iPhone 录入；或者入库前就换成占位符，历史只存占位符，并给“只追加”规则写一条明确例外。无论哪种，都让 `restoreModelStream` 不还原保险箱占位符。
6. **授权模型对齐 1Password/ADR 0257**：默认每次释放都问；长期授权只给低风险只读 API key，且要主人显式打开；批准绑定 `(itemId, origin, fieldKey, actionKind)`，短期/单次；替换值/改 origin/删除项撤销授权；用在途 fence。
7. **浏览器填表**：扩展 `PreparedWebAction` 加 `fieldAssignments: { fieldKey, secretRef }[]`；填值作为一个有 `pageVersion` 的 prepare/execute 动作；只允许 exact origin、顶层、可见、类型匹配；显式拒绝 iframe/Shadow DOM/跨 origin；用沙箱出口代理做第一道网络围栏，Playwright 拦截做第二道；填值期间不返回页面快照，失败清空，未知结果走 reconcile。
8. **API 请求**：不做通用 HTTP。改成“登记好的连接器/操作”，固定方法、路径模板、字段、风险档；或做 `vault_request_prepare`/`vault_request_execute`，带结构化 side-effect facts、幂等键、对账。强制 https、禁止重定向、SSRF 防护、头/方法白名单、禁止查询参数放秘密、响应大小/超时/并发上限、响应只返回状态或经过多编码遮盖。
9. **沙箱注入**：单独的 `VaultSecretSource`，ref 命名空间 `vault:<itemId>:<fieldKey>`；能力安装时把 secretRef 列给主人；能力程序输出/文件/返回值全部遮值；限制网络 scope；加金丝雀测试。
10. **TOTP**：`fieldType: "totp"`；只允许程序派生 6 位码；种子和码都不落库/不进日志/不进模型/页面快照里遮掉。
11. **门槛**：`npm run check:vault-contract`（所有新值过所有消费者 + 反向值必须失败）、`npm run check:vault-canary`（全流程 + 反向注入必须失败）、上线验收场景（iPhone 录入、列表、代发、填表、evil.example、跨站请求、隐藏字段、跨站 iframe、页面变化、聊天输入、沙箱打印、编码响应、重定向、SSRF、超大响应）。工具定义加真实快照（字节和顺序）。
12. **KV 缓存**：所有工具一次加齐，或明确接受多次换新并记录；`vault_list` 所有列表排序；不把保险箱值预置进 `known` 去重遮历史；工具结果在生成时就遮好再入库；每轮变化的值只放最后一条工具结果。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- **工具定义会变一次（如果一次加齐）或多次（如果按当前分步）**。按 `.agents/instructions/prompt-prefix.md:42-45`，工具集合变了可以换新一次，但要记录；当前“分三步加工具”会导致三次换新，与“只换新一次”矛盾。
- **`vault_list`/`vault_fill`/`vault_request` 的结果在末尾追加**，条目变化不改工具定义，这点是符合规则的；但必须保证 `vault_list` 的输出排序/序列化稳定（见第 10 条）。
- **会改变已发前缀的风险有两处**：
  - 如果按 v1 的做法把保险箱值预置进出口遮盖的 `known` 表，再重遮整段历史，就可能让同一段历史在不同请求里遮成不同字节。v2 必须明确：只在工具结果生成时遮，不用 `known` 回头改历史。
  - `restoreModelStream` 会把助手文本里的占位符还原成明文再入库（`packages/runtime-pi/src/egress-context.ts:57-92`）。这既违反“对话记录没有值”，也可能在下一次请求里因为规则/密钥变化而遮出不同字节。必须排除保险箱占位符的还原。
- **每轮会变的值**：TOTP 码、最近使用时间、条目状态/版本不能进系统提示/工具定义；`vault_list` 如果返回这些，也必须只在末尾的工具结果里，且最好不返回会变的值。当前方案只把“编号/名字/字段/允许的地方”放 `vault_list`，方向对，但要补排序和“不含时间/状态”的约束。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

会，除非补上这些：
- `vault_list` 的 `allowedOrigins`、`fields` 必须排序；JSON 键顺序固定。
- 响应/页面快照的遮值必须用**按值确定的固定占位符**（例如现有的 `ModelEgress.externalTag()`，`packages/application/src/services/model-egress.ts:121-126`），不能用 `maskSensitiveTexts` 这种按出现顺序编号的标签（`packages/sensitive-capture/src/redaction.ts:546-569`）。
- 不要把保险箱值预置进 `known` 去重遮已经发过的历史；遮值要在工具结果生成时完成并入库。
- TOTP 码、时间、最近使用记录不要进模型可见内容；如果页面快照里出现，要遮成固定占位符。
- 遮盖密钥轮换会让同一段历史里的占位符字节变化（`.agents/instructions/prompt-prefix.md:81` 已列为缓存失效原因）；方案要接受这一次缓存失效，并说明 `vault_save` 的旧占位符在轮换后可能无法还原。
- `EnvelopePayloadProtector` 的随机 DEK/nonce 只影响密文，不影响模型请求；不要把密文放进模型可见内容。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- **目前只有描述，没有可执行门槛**。方案说“金丝雀…反向：故意让工具结果带值，测试必须失败”“编号同一个校验规则过所有使用处”，但没有给命令、没有说在 `npm run check` 还是上线验收里跑、没有说反向用例怎么注入。
- **必须补**：
  - `npm run check:vault-contract`：把 `itemId`/`slug`/`fieldKey`/`allowedOrigin`/`secretRef`/`payloadRef`/`approvalRef` 逐个过所有消费者的校验；拿一个故意不合规的值，必须至少有一个消费者报错；两个包的规则要一致（I-73 的做法）。
  - `npm run check:vault-canary`：保险箱放金丝雀值，跑 iPhone 录入、`vault_list`、`vault_save`（聊天路径）、`vault_request`、`vault_fill`、沙箱注入；扫描模型请求、数据库其他表、对话记录、审计、导出、日志（服务器 HTTP 客户端/Playwright/Stagehand/CDP/systemd）、推送正文、工具调用参数、沙箱输出、页面快照；反向把值注入工具结果/沙箱输出/编码响应，测试必须失败。
  - 上线验收：evil.example、跨站请求、隐藏字段、跨站 iframe、Shadow DOM、准备/执行间页面变化、提交失败、重定向、SSRF、超大响应、查询参数放秘密、`vault_save` 覆盖已有项、TOTP 种子直接填、删除后长期授权失效。
  - 工具定义真实快照（字节和顺序），保证新工具一次加齐或记录多次换新。
- **反向用例要直接调用工具，不要依赖模型被说服**；否则模型偶尔不配合，测试会假通过。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不能，方案只核对了“编号”的一部分，而且有两处错配。逐个看：

- **`itemId`/`slug`**：过 `machineString`（`packages/gateway-contracts/src/validation.ts:49-62`）和 capability manifest 的 `secretRef`（`packages/execution-contracts/src/contracts-v2.ts:125-129`）没问题；但“主机密钥引用”是主密钥 ref（`packages/platform-node/src/host-secret-source.ts:65-73`），不是项编号；“沙箱程序名”校验的是 `secretRefs` 映射的 `name`（`apps/execution-worker/src/program-secret-injection.ts:20-33`），不是 `ref`。方案把这三个混在一起，是 I-73 式的错配。
- **`fieldKey`/字段名**：方案让主人定自由文本，模型写 `vault_fill(编号, 字段)`；它过不了 `machineString`，会重名，不能表达 `totp` 类型。**没有逐个使用处校验**，这是最大的 I-73 风险。
- **`allowedOrigin`**：产生于 iPhone/`vault_save`，使用于保险箱表、`vault_request` 目的地、`establishSession.allowedOrigins`（`packages/application/src/services/web-capability-service.ts:118-162`，`exactOrigin` 在 `:548-551` 允许 `http`）、沙箱出口代理的 `host:port` 白名单（`packages/runtime-sandbox/src/network-egress.ts:61-79`）、审计。需要统一规范化（小写、默认端口、IDN/尾点）、强制 https、拒绝 userinfo；代理那边要把 origin 映射成 `host:port`，并处理默认端口。方案没有写这些。
- **`secretRef`（沙箱）**：不能直接复用 `HostSecretMaterialSource` 的 ref 规则（不允许 `:`）；需要单独的 `VaultSecretSource` 和命名空间，并确认能力清单的 `secretRef`、`granted`、`program-secret-injection` 的 `name`/`ref` 两端一致。
- **`payloadRef`**：`EnvelopePayloadProtector` 的 AAD 绑定了 `ref`（`packages/platform-node/src/payload-protector.ts:86-103`）；如果公开 slug 同时是 payload ref，改 slug 就要重加密；删除后复用编号还可能让旧密文的 AAD 匹配。建议用随机内部 id 作 payload ref。
- **`status`/`version`**：方案只说“状态、版本”，没有枚举、没有乐观锁冲突行为、没有删除/替换时撤销授权的规则。
- **`approvalRef`/长期授权**：没有绑定 `(itemId, origin, fieldKey, actionKind)`，没有过期/单次/撤销 fence。
- **`totpCode`**：产生于服务器，使用于填表；必须不落库/不进日志/不进模型/页面快照里遮掉；方案没有给字段类型来禁止种子被直接填/发。
- **审计里的“站点”**：如果记完整 URL，查询参数里的秘密会进审计；应只记 origin。

**一句话**：方案需要像 ADR 0257 的“新值清单”那样，把每个新值逐行写清产生处、使用处、两端校验和自动检查；现在只写了“编号过四处”，而真正会出问题的是字段名、origin、secretRef、payloadRef、授权引用和 TOTP 码。
