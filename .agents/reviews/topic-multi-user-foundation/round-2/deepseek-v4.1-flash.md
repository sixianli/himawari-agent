# 审核结论

已按当前检出的 `65d39ca700906ad310176bee8872a7ec62e2034e` 核对。方向（一个程序、每人一个库、共用层只做前门/名册/闸门）我认同，但下面这些点在开工前必须改方案；其中几条会直接导致登录/CSRF 失效、跨人泄露或上线后全员不可用。

---

## 一、已证实的问题（按严重度）

### 1. 严重度：高｜前门“只带令牌和会话 cookie”会破坏登录、CSRF 和所有写请求

**问题**：方案说前门转发时“只带原始请求头里的令牌和会话 cookie”。现有 HTTP 层不是只依赖这两样。会话创建、所有写请求、静态/预览请求都要求原样保留 `Host`、`Origin`、`Sec-Fetch-Site`、`Content-Type`、`X-CSRF-Token` 等头；主机名不对直接 403。

**证据**：
- `packages/platform-node/src/identity-gateway.ts:975-981`：`assertSessionCreationOrigin` 要求 `host === origin.host`、`origin === origin.origin`、`sec-fetch-site === "same-origin"`，否则 `ASSERTION_INVALID`。
- `packages/platform-node/src/http-gateway-server.ts:251-268`：`assertPublicHost` 和 `assertMutationBoundary` 要求 `host`、`origin`、`sec-fetch-site` 和 JSON `content-type`。
- `packages/platform-node/src/http-gateway-server.ts:731-741`：认证同时读 `cf-access-jwt-assertion` 和会话 cookie，但其它头由 Fastify 路由层继续使用。
- 方案第三节第 5 条原文：“前门转发时只带原始请求头里的令牌和会话 cookie（每人那份代码照样验一遍令牌和会话）。”

**建议**：改为“除逐跳头外，原样转发所有端到端请求头”，明确保留 `Host`、`Origin`、`Sec-Fetch-Site`、`Content-Type`、`Accept`、`X-CSRF-Token`、`Cookie`、`Cf-Access-Jwt-Assertion`；剥掉客户端自带的“前门签名头”。加真实浏览器路径的端到端用例：首次建会话、发消息、上传/预览、SSE。若作者本意是“额外带上令牌和 cookie”，也必须改写措辞并测试，否则实现者会按字面做。

---

### 2. 严重度：高｜Andy 的“外部去向”仍共用新前门这个故障点，“上线风险为零”不成立

**问题**：方案第八节说 Andy 第一版仍是原单人进程，“聊天不和客人共用故障范围”“上线风险为零”。但所有请求都要先经过新前门；前门又和进程内客人同在一个进程里。只要某个客人 OOM、崩溃或前门代码出错，Andy 也会断。Tunnel 还必须从前门走，回滚也不是“让前门不转发”这么简单。

**证据**：
- 方案第二条：“新增一个很小的‘前门’：进程里一个共用的网页入口……”
- 方案结论第 7 条：“Andy 的上线风险为零，回滚就是让前门不转发。”
- `docs/adr/0234-one-program-per-person-database-file.md:85` 已接受“主程序崩了所有人一起断几十秒”。
- `apps/agent-service/src/service-main.ts:525-681` 的生命周期是进程级的，一个进程内多个运行时没有独立故障域。

**建议**：不要把“Andy 风险为零”写进方案。至少承认：Andy 的可用性依赖新前门；若要兑现“不共用故障范围”，前门应是独立的小进程/独立事件循环，或者 Andy 保留一条不经过前门的应急入口。回滚要写成具体操作：Tunnel 改回 Andy 端口并重载 cloudflared，验证 Andy 直连可用。

---

### 3. 严重度：高｜Andy 仍监听 127.0.0.1 时，其它人的执行进程/沙箱可绕过前门直接打 `/bootstrap`、`/break-glass`

**问题**：方案只在前门拒绝这两个路径，但 Andy 的外部服务仍在本机回环端口上。现有判断只看来源 IP 是否回环；任何本机进程连 `127.0.0.1:<Andy端口>` 都会被当成“本机请求”。块 1 还没有给每个执行进程独立系统账号和防火墙，因此不能假设它们连不到 Andy 的端口。

**证据**：
- `packages/platform-node/src/identity-gateway.ts:505-512`：`isLoopback` 只比较 `127.0.0.1`、`::1`、`::ffff:127.0.0.1`、`localhost`。
- `packages/platform-node/src/identity-gateway.ts:544-545`：`/bootstrap` 只检查 `isLoopback(input.remoteAddress)`。
- `packages/platform-node/src/identity-gateway.ts:809-812`：`/break-glass` 同样只检查回环。
- `apps/agent-service/src/production-http-composition.ts:278-281`：生产网页服务只允许 `127.0.0.1`/`::1` 监听。
- ADR 0234 第 7 条只写了“执行账号用防火墙挡住，连不到 Magpie”（`docs/adr/0234-one-program-per-person-database-file.md:73`），没有说挡住 Andy 的网页端口。

**建议**：块 1 在给别人开通前，必须把 Andy 的入口也纳入隔离：至少用防火墙禁止其它执行账号访问 Andy 的回环端口；更彻底的是把 Andy 的单人服务改为 Unix 套接字或只接受带前门凭据的请求，并关闭 `/bootstrap`、`/break-glass`。仅靠前门路径拒绝不够。

---

### 4. 严重度：高｜“名册和本人库在同一个事务里”做不到；WAL 下跨文件不原子

**问题**：首次登录要在同一个事务里创建目录、创建本人库、写名册、调用 `bindFirstOwner`。目录创建不是事务；名册和本人库是两个 SQLite 文件、两条连接；本仓库又使用 WAL。SQLite 官方明确：WAL 下多文件事务只保证单文件原子，主机崩溃时可能出现一个文件有、另一个没有。

**证据**：
- 方案 3.3 原文：“在同一个事务里：创建这个人的目录和库……把 `sub` 绑进名册……调用本人库的 `bindFirstOwner`。”
- `packages/persistence-sqlite/src/migration-engine.ts:1029`：`database.pragma("journal_mode = WAL")`。
- `packages/persistence-sqlite/src/sqlite-worker.ts:123`：同样设置 WAL。
- SQLite 官方 ATTACH 文档：<https://www.sqlite.org/lang_attach.html> 原话：“Transactions involving multiple attached databases are atomic, assuming that the main database is not `:memory:` and the journal_mode is not WAL. If ... the journal_mode is WAL, then transactions continue to be atomic within each individual database file. But if the host computer crashes in the middle of a COMMIT where two or more database files are updated, some of those files might get the changes where others might not.”
- OWASP 多租户备忘单也要求开户“all-or-nothing”，失败要删掉半成品：<https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html> 原话：“Treat onboarding as an all-or-nothing operation: if a step fails, remove partially created resources and record the failure.”

**建议**：改成可重试的 provisioning saga：名册先写 `provisioning`，再建目录/库/绑定，最后写 `active`；每一步幂等，失败可回滚或继续；启动时扫描 `provisioning` 做修复。不要在请求里同步跑完整创建。用量计数也不要依赖跨库事务，改成“先写本地账本，再异步/幂等汇总到名册”，或用 outbox + 对账。

---

### 5. 严重度：高｜启动顺序会让上线/重启期间长时间不可用：先起 20 个人，最后才起前门

**问题**：方案 2.1 第 4 条写“对每个活跃的人调用 `startTenantRuntime`，再起前门”；第六节又写“按顺序起来、错开启动”。I-28 实测单人启动就要 12–31.5 秒，且瓶颈是磁盘随机读；20 个人顺序启动会是几分钟。前门最后起，意味着这段时间连“维护中”页面都没有，一个人启动卡住会拖住所有人。

**证据**：
- 方案 2.1 第 4 条：“读名册，对每个状态为‘活跃’的人调用 `startTenantRuntime`，再起前门。”
- `docs/incidents-and-gates.md:66`（I-28）：第十九版启动 34.5 秒、第二十四版 31.5 秒，历史上 12.0–31.5 秒；“慢的永远是打开数据库和创建沙箱服务”。
- `apps/agent-service/src/service-main.ts:686-717`：启动时展开 Magpie 模型、打开数据库、初始化状态目录、绑定执行进程；这些都会在每个人身上重复。

**建议**：前门必须先起；租户按有界并发（比如 2–4）启动，每个有独立超时；未就绪的租户由前门返回维护页；支持按需懒启动。块 0 的测量要加“冷启动总时长”和“20 人启动的磁盘/CPU 峰值”，不能只测常驻内存。

---

### 6. 严重度：高｜嵌入仍走 Vercel AI Gateway，既违反“不用按量付费”，也不在配额/用量里

**问题**：方案说“模型目录只来自 Magpie 的分组，不含任何按量付费的服务方”，并把闸门包在“主模型和各个辅助模型”上。但生产形态模板里的 `embedding` 仍走 `vercel-ai-gateway`；ADR 0234 明确 P3-1 之前不给别人开通。嵌入也不在 `MODEL_USAGE_PURPOSES` 里，配额枚举覆盖不到。

**证据**：
- `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:99-110`：`role: "embedding"`、`provider: "vercel-ai-gateway"`、`secretRef: "vercel-gateway"`。
- `apps/agent-service/src/service-main.ts:249-255`：`configuredEmbedding` 直接取 `role === "embedding"` 的描述符。
- `apps/agent-service/src/service-main.ts:257-261`：`isDeterministicOnly` 只看非 embedding 描述符。
- `packages/application/src/ports/model-usage.ts:3-12`：`MODEL_USAGE_PURPOSES` 只有 chat、thread-title、memory-capture、memory-episode、memory-consolidation、mail-judgment、action-review、other，没有 embedding。
- `apps/agent-service/src/production-run-memory.ts:321-340`：嵌入有自己的 permit/usage 路径。
- ADR 0234 第 7 条（`docs/adr/0234-one-program-per-person-database-file.md:72`）：“记忆向量现在走 Vercel，P3-1（向量改成本机算）上线之前不给别人开通。”

**建议**：把 P3-1 作为给别人开通的硬前置；或者本块只做 Andy 外部、不允许客人使用记忆向量。若必须在 P3-1 前开通，必须把 embedding 的费用/调用也纳入同一个闸门，并明确 Vercel key 只给 Andy 本人用。不要写“模型目录只来自 Magpie”而不覆盖 embedding。

---

### 7. 严重度：高｜`/admin/*` 没有真正的管理员鉴权设计，任何登录用户都可能改上限

**问题**：方案只说 `/admin/*` 是“Andy 专用”，但前门只做通用 Access JWT 校验。若不在前门额外检查名册里 `kind = owner` 且是 Andy 的 `sub`，任何客人拿到自己的有效令牌就能调用 `PUT /admin/limits` 改自己或别人的额度。管理页“只返回数字”也不能防止改数字。

**证据**：
- 方案第七节：“管理页（Andy 专用，由前门提供）……本块只留 `GET /admin/tenants`、`PUT /admin/limits` 两个接口给它。”
- 方案第三节只描述“验令牌、按 sub 查名册、转发”，没有管理员角色判断。
- OWASP 多租户备忘单：<https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html> 原话：“Treat client-supplied tenant identifiers as selectors only. Verify that the authenticated principal is authorized to act in the selected tenant.”

**建议**：前门对 `/admin/*` 做独立授权：`roster.kind = owner` 且 `external_subject_ref` 等于 Andy 的绑定，最好再用单独的 Cloudflare Access 应用/策略；所有管理写操作要 CSRF 保护并写审计。加反向用例：普通成员令牌调用 `/admin/*` 必须 403，且不能看到任何人的内容。

---

### 8. 严重度：高｜靠“路径名单”拒绝 `/bootstrap`、`/break-glass` 可被编码/规范化绕过

**问题**：方案只写“前门写死拒绝这些路径”，没有说按什么形式比较。前门和后面 Fastify 的路由规范化可能不一致；`/%62ootstrap`、`//bootstrap`、`/bootstrap/`、`/foo/../bootstrap`、分号参数等都可能在前门看来不是该路径、到了后面却命中。Fastify 默认 `ignoreDuplicateSlashes`、`ignoreTrailingSlash` 是关闭的，但百分号编码由路由/解码层处理，不能靠字符串前缀。

**证据**：
- 方案第三节第 8 条：“前门写死拒绝这些路径（名单在代码里……）。”
- `packages/platform-node/src/identity-gateway.ts:1049`、`:1097`：实际路由是精确的 `/bootstrap`、`/break-glass`。
- Fastify 文档：<https://fastify.dev/docs/latest/Reference/Server/#routeroptions> 的 `ignoreDuplicateSlashes`、`ignoreTrailingSlash` 默认 `false`，但 `onBadUrl`、URL 解码等仍会让“原始字符串”和“路由看到的路径”不同。

**建议**：前门先做与后端一致的规范化（解码、去掉重复斜杠/尾斜杠、拒绝 `..`、统一大小写），再拒绝所有规范化后等于或位于敏感路径之下的请求；对 `%2f`、`%62` 等写反向用例。更稳的是：进程内租户直接关闭这两个路由（方案已说），Andy 外部则用防火墙/Unix 套接字，不把安全边界只放在前门字符串判断上。

---

### 9. 严重度：高｜共用 Gmail 待处理表会丢掉“同一台设备”绑定，且全局 20 条会被一个人占满

**问题**：现有 Gmail 回调把发起人记成 `subjectId:deviceId`，回调时要求完全相同。方案说共用登记处“登记时写 `tenantId`，回调时按它找人”，只保留了人，没有保留设备；ADR 0234 要求“只认发起授权的同一台已登录设备”。另外现有上限是全局 20 条，共用后一个人可以占满，别人无法发起授权。

**证据**：
- `apps/agent-service/src/production-http-composition.ts:564-568`：`owner` 返回 `${authentication.subjectId}:${authentication.deviceId}`。
- `apps/agent-service/src/production-http-composition.ts:610-617`：回调把该字符串传给 `completeAuthorization`。
- `apps/agent-service/src/production-proactive.ts:282-289`：`pending.owner !== input.owner` 就失败。
- `apps/agent-service/src/production-proactive.ts:58-59`：`STATE_TTL_MS = 10 * 60_000`、`MAX_PENDING_STATES = 20`；`:266-270` 全局淘汰最旧。
- ADR 0234 第 5 条（`docs/adr/0234-one-program-per-person-database-file.md:67`）：“只认发起授权的同一台已登录设备……A 的回调绑不到 B”。

**建议**：不要只写 `tenantId`。共用层记录 `tenantId + ownerId + deviceId + expiresAt + state`，回调时同时核对当前登录身份和设备；按租户设上限，避免一个人占满；加反向用例：A 发起的 state 用 B 的登录/设备回调必须失败，过期/重放/并发各一条。

---

### 10. 严重度：高｜每人的密钥只规划了 `payload-encryption`，但 CSRF 密钥还签文件预览和搜索令牌

**问题**：方案只写“每个人一把 `payload-encryption` 密钥”，然后共用基础配置里的其它密钥。但 `identity.csrf.keySecretRef` 这把密钥不只做 CSRF，还派生文件预览 ticket key 和搜索 key。若所有租户共用同一把 CSRF 密钥，跨租户的预览/搜索令牌边界就变弱；至少不是方案宣称的“每人的遮盖和加密天然不同”。

**证据**：
- `apps/agent-service/src/production-http-composition.ts:729-735`：从 `identityConfiguration.csrf.keySecretRef` 解析 CSRF key。
- `apps/agent-service/src/production-http-composition.ts:968-975`：`ticketKey = HMAC(csrfKey, "himawari.file-preview.key.v1")`；`searchKey = HMAC(csrfKey, "himawari.search.key.v2")`。
- `packages/platform-node/src/browser-thread-files.ts:216-240`：预览只用 ticket 里的 `fileId + expiresAt` 和当前实例的 owner 查文件；ticket 本身不绑定租户。
- 方案第五节只列出“每人一把 `payload-encryption`”，共用 Magpie/Gmail 密钥。

**建议**：明确每人一份的密钥清单至少包括 `payload-encryption`、`identity-csrf`、文件预览/搜索派生 key、`web-push`（如按人）、`identity-bootstrap`（如保留）。共用层只放 Magpie provider key、Gmail OAuth client secret 这类真正全局的凭据。加检查：A 的预览 ticket/搜索令牌在 B 的实例上必须无效。

---

### 11. 严重度：中高｜现有 JWT 验证器不返回 `email`；方案却要“用共用验证器取出 email”

**问题**：方案靠 Cloudflare Access 令牌里的 `email` 做邀请匹配和 `sub` 重绑，但现有 `CloudflareAccessJwtVerifier` 只返回 `externalSubjectRef`、issuer、audience、时间、`providerSubject`，没有 `email`。要实现方案，必须改验证器/增加接口，并明确拒绝 service token（`sub` 为空、无 email）和 `type != "app"` 的令牌。

**证据**：
- `packages/platform-node/src/identity-gateway.ts:202-219`：返回对象没有 `email`，只检查 `sub`、`exp`、签名、issuer、audience。
- Cloudflare 官方文档：<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/> 原话：“email: The email address of the authenticated user, verified by the identity provider.”；service token 的示例 payload `sub` 是空字符串，表格写“Contains an empty string when authentication was through a service token.”
- 方案 3.3：“前门见 `sub` 不在名册里、`email` 匹配一条‘已邀请’……”

**建议**：扩展验证结果，显式返回 `email` 和 `type`，要求 `type === "app"`、`sub` 非空、`email` 非空且经过验证；对没有 email 的令牌直接 401。把这段作为独立代码改动列进 PR，不要写成“用现有验证器即可”。

---

### 12. 严重度：中高｜“邮箱是稳定身份、自动重绑 `sub`”会带来账号回收/别名/旧会话问题

**问题**：Cloudflare 的 `sub` 确实会在移出再加回时变化，但把 `email` 当作人的稳定身份并不安全：邮箱可被回收、可用 plus 别名、可由不同 IdP 登录。自动把新 `sub` 绑到旧邮箱对应的人，等于“谁能证明控制这个邮箱，谁就接管旧数据”。旧会话/设备也没有在重绑时撤销。

**证据**：
- Cloudflare 文档（同上）原话：“The ID of the user. This value is unique to an email address per account. The user would get a different `sub` if they are removed and re-added to your Zero Trust organization, or if they log into a different organization.”
- 方案 3.3：“邮箱是名册里的稳定身份，`sub` 是可重绑的缓存……前门更新名册里的 `sub` 和本人库里的绑定（只有令牌里经验证的 `email` 与名册一致才允许）。”
- 方案未提别名、大小写、回收、旧会话撤销。

**建议**：重绑不要自动完成，至少要求 Andy 在管理命令里确认，或要求重新走邀请；重绑时撤销旧 session/device，写审计并通知。邮箱统一 NFKC + 小写，明确 plus 别名策略；加用例：旧 `sub` 在重绑后立即失效、不同大小写/别名按约定处理。

---

### 13. 严重度：中高｜配额闸门的两条判断有误：后台调用其实会计数，嵌入又完全没覆盖

**问题**：方案 F19 说后台邮件判断“不走准入，直接放行”，因此“如果把闸门放在 modelAdmission，后台调用既不被拦也不被计数”。代码里后台的 `admission` 确实被 `UNMETERED_PERMIT` 放行，但 `usage` 仍然传给了 `auxiliaryModelFor`，所以 token 用量是记的；真正漏掉的是嵌入。方案把闸门放在模型端口方向对，但“每个用途都被计数”的反向用例不能证明嵌入也被覆盖。

**证据**：
- `apps/agent-service/src/production-model-composition.ts:47-53`：`UNMETERED_PERMIT` 只是 admission permit，`assertActive/markStarted/...` 都是空操作。
- `apps/agent-service/src/production-model-composition.ts:491-493`：`auxiliaryModelFor` 在 `options.usage` 存在时传 `usage: { purpose: text.purpose, ...options.usage }`。
- `apps/agent-service/src/production-model-composition.ts:506-516`：proactive 只覆盖 admission，usage 仍走 `options.usage`。
- `packages/application/src/ports/model-usage.ts:3-12`：没有 embedding purpose。
- `apps/agent-service/src/production-run-memory.ts:321-340`：嵌入走自己的 permit/usage。

**建议**：修正 F19 的表述；闸门同时包住生成模型和嵌入；`MODEL_USAGE_PURPOSES` 增加 embedding 或在嵌入 permit 上单独计数；反向用例要枚举“实际调用入口”，而不是只枚举常量数组。

---

### 14. 严重度：中｜配额计数跨两个库、崩溃/子进程回退会漏计或绕过

**问题**：方案说“写入每人库的同时，把用量累加进名册，一次写，同一个事务里不写别处”。两个库不能一个事务（见第 4 条）。调用发生后写名册失败会少计；进程崩溃会丢掉在途 reservation；方案又说内存放不下就改子进程，但“进程内只有一个闸门”的检查并占位在子进程模式下不共享，前门和名册不变并不能让闸门不变。

**证据**：
- 方案第七节：“进程内只有一个闸门，‘检查并占位’在同一个同步步骤里完成……”
- 方案 2.4：“前门和每人那一份只通过 Unix 套接字说话，所以……换成‘起一个子进程’即可，前门和名册都不变。”
- 第 4 条已引 SQLite WAL 跨文件不原子。
- OWASP 多租户备忘单要求共享配额用原子更新：<https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html> 原话：“Use shared counters with atomic updates when limits must apply across multiple application instances.”

**建议**：要么明确“块 1 只做进程内，不做子进程回退”，要么把配额做成独立于运行时的共享服务/共享库，reservation 落盘、幂等结算、崩溃恢复。用量先写本地账本，再异步汇总；开机对账之外，还要有“未结算 reservation 恢复”和“名册写失败 fail-closed”策略。

---

### 15. 严重度：中｜名册成为全局写热点；每库多线程/内存也超过 ADR 0234 的约束

**问题**：每次模型调用都写 `roster.sqlite` 的 `usage_monthly`，SQLite 只有一个写者；20 人并发会把所有调用串行化。每个 `SqliteProductStateRepository` 启动即有 1 个写线程 + 1 个读线程，最多 3 个读线程；20 人最多 80 个线程。ADR 0234 明确要求“读线程按需启动并设全程序总上限”，方案没有落实。

**证据**：
- `packages/persistence-sqlite/src/product-state-repository.ts:162`：`READ_WORKER_COUNT = 3`。
- `packages/persistence-sqlite/src/product-state-repository.ts:263-275`：`open` 时先启动一个读上下文；`:699` 读请求时最多再加到 3。
- ADR 0234 后果（`docs/adr/0234-one-program-per-person-database-file.md:111`）：“每个库的读线程要改成按需启动并设全程序总上限（现在每库最多 4 个线程，20 人就是 80 个）。”
- 方案 F18 只是沿用“1 写 + 最多 3 读”，没有给全局上限。

**建议**：名册用量改为内存聚合 + 周期批量落盘，或每个租户一行、短事务；给 SQLite 读线程设全程序上限和队列；在块 0 测量 20 个库线程的 RSS/句柄数，不只测单个运行时。

---

### 16. 严重度：中｜“内存放不下就改子进程”方向反了

**问题**：方案说块 0 测出来进程内放不下，就改成“起一个子进程运行单人外壳”。单人整套约 680 MB；子进程是更大的内存占用，不是更小。子进程只解决崩溃隔离，不解决内存不足。反过来，如果进程内都放不下，子进程更放不下。

**证据**：
- 方案结论第 8 条：“前门和每人那一份只通过 Unix 套接字说话，所以块 0 测出来内存放不下时，把‘起一个人’换成‘起一个子进程’即可。”
- 方案 F21：一整套单人服务约 680 MB；进程内每多一个人的增量还没测。
- ADR 0234 第 15 条把子进程作为“内存放不下或需要更强崩溃隔离”的二选一，也混淆了两件事。

**建议**：把回退条件拆开：内存不足 → 减少功能（向量延迟加载、执行进程共享/池化）、减少在线人数、加内存、懒启动；崩溃隔离不足 → 子进程。先测“进程内每增加一个人的增量”，再决定。

---

### 17. 严重度：中｜标识格式的判断不完全对；组合 ID 的消费者没有核对

**问题**：方案说“邮箱里的 `@` 不在允许字符里，所以用 `owner:<slug>`”。实际上 `safeReference` 允许 `@` 和 `/`，是机器标识校验不允许 `@`；`owner:<slug>` 能同时通过两者，结论碰巧对，但理由错。更关键的是组合 ID：`execution-worker:${deploymentId}`、`agent-service:${deploymentId}` 会变长；`tenantId` 也不是现有配置字段。方案只要求把生成的单个 ID 过校验，没有要求把组合后的值交给所有消费者。

**证据**：
- `packages/platform-node/src/strict-configuration.ts:98-103`：`safeReference` 正则为 `^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$`，允许 `@`、`/`、`:`。
- `packages/domain/src/identifiers.ts:39`：`MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`，不允许 `@`、`/`，允许 `:`。
- `apps/agent-service/src/service-main.ts:418-425`：要求 `binding.workerInstanceId === \`execution-worker:${configuration.deploymentId}\``。
- `apps/execution-worker/src/service-main.ts:159`：同样生成 `execution-worker:${configuration.deploymentId}`。
- 方案 handle 返回 `tenantId`，但 `parseProductConfiguration` 的字段列表（`strict-configuration.ts:1271-1292`）没有 `tenantId`。

**建议**：写一张“值 → 产生处 → 所有消费者 → 校验”的表；对 `owner/agent/deployment` 和组合后的 `workerInstanceId/agentServiceInstanceId` 都用真实解析器和最长 slug 跑一遍。明确 `tenantId` 是等于 `ownerId` 还是新增字段；若是新增，要加配置校验和迁移。检查要点就是 I-73 的教训（`docs/incidents-and-gates.md:112`）。

---

### 18. 严重度：中｜文档/ADR 不一致：方案说要改 ADR 0076，ADR 0234 说 0076 不变

**问题**：方案第七节说“这改变了 ADR 0076 的一部分，需要新 ADR 说明；ADR 号找协调者要”。但 ADR 0234 已经接受，并明确说 ADR 0076 删掉的是“累计总额、永不清零”，按人按月是另一类，0076 不变。方案应引用 0234，而不是再要一个新 ADR。

**证据**：
- `docs/adr/0234-one-program-per-person-database-file.md:81`：“[ADR 0076](0076-no-model-cost-budget-limits.md) 删掉的是‘累计总额、永不清零’的上限，仍然成立；这里加的是‘按人、按月、会重置、看得见、Andy 可改’的上限……0076 不变。”
- 方案第七节末句：“这改变了 ADR 0076 的一部分，需要新 ADR 说明；ADR 号找协调者要。”

**建议**：改为“遵守 ADR 0234 第 8、9 条；不再新开 ADR，除非 Andy 要改 0234 的语义”。如果确实要改，先写清改哪一条，不要留“找协调者要号”。

---

### 19. 严重度：中｜浏览器端存储、Service Worker、推送没有按人隔离

**问题**：多用户共用同一个 `publicOrigin`，浏览器里的 localStorage/IndexedDB/草稿/偏好/Service Worker 缓存/推送订阅都是按 origin 存的，不会因为后端按库分开而自动分开。A 退出、B 在同一浏览器登录时，可能看到 A 的草稿/偏好，或继续收到 A 的推送。ADR 0234 已把这件事列为必须处理，方案完全没提。

**证据**：
- ADR 0234 后果（`docs/adr/0234-one-program-per-person-database-file.md:111`）：“浏览器里存的草稿和偏好要改成按人分开，换人登录时重新登记推送。”
- 方案第一节“每人一份”只列了服务端对象，没有浏览器存储；检查 1 只测服务端 ID。

**建议**：登录/退出时清空或切换用户命名空间；Service Worker 缓存按 `sub` 分 key，禁止缓存带个人数据响应；推送订阅换人时重新登记并撤销旧订阅；加测试：A 退出后 B 登录，浏览器里读不到 A 的草稿/偏好，收不到 A 的推送。

---

### 20. 严重度：中｜限额值、`scope`、未知价格没有定义

**问题**：`limits.scope` 是字符串（`tenant:<id>`、`others_total`、`default_new`），没有类型/格式校验；`metric = usd_estimate` 遇到未知价格时怎么办没写。Magpie 官方文档明确“没有已知价格的调用不计费用”，所以 `usd_estimate` 口径会少计，不能当严格上限。`monthly_limit = null` 表示不限，`default_new` 为空时新人不设上限，只告警，这会让“其他人总上限”也挡不住新人。

**证据**：
- 方案第四节 `limits` 表：`scope`、`metric`、`monthly_limit`。
- Magpie 文档：<https://github.com/yetone/magpie/blob/main/docs/reference.md> 原话：“Cost is an estimate at the Usage page's prices; a call with no known price adds none.”；“Requests from this computer that send no gateway key are not limited.”
- 方案第七节：“`default_new` 为空时新加的人不设上限但前门告警提醒。”

**建议**：`scope` 改成结构化列（`scope_kind` + `tenant_id`），DB `CHECK` + CLI 校验；`metric` 用枚举；明确未知价格时的行为（拒绝、按保守单价估算，或禁止用 `usd_estimate` 作硬上限）；`default_new` 为空时至少受 `others_total` 约束，且新人默认不能被无限使用。

---

### 21. 严重度：中｜模型目录顺序不确定，可能导致同一个人/不同人拿到不同路由

**问题**：Magpie 模型清单按供应商返回顺序解析，`descriptorFor` 用数组下标算 `priority`。如果清单顺序变化，或者每个租户各自展开一次，优先级/路由可能不同。方案说“模型配置从同一份基础配置合成”，但没有要求排序或只展开一次并共享不可变描述符。

**证据**：
- `apps/agent-service/src/production-magpie-models.ts:66-110`：按 `data` 数组顺序 push。
- `apps/agent-service/src/production-magpie-models.ts:113-125`：`priority: primary.priority + 1 + index`。
- `apps/agent-service/src/service-main.ts:686`：启动时展开一次；多人外壳若每个租户都调用，就会各拿一份顺序可能不同的清单。

**建议**：在共用层展开一次，按 `ref` 排序成稳定列表，再以不可变对象注入所有租户；加测试：打乱 Magpie 返回顺序，生成的描述符和优先级必须一致。这也直接关系第 2 个必答问题（无序集合）。

---

### 22. 严重度：中｜Unix 套接字细节：文件权限应是 0600，路径长度和旧套接字处理要复用现有实现

**问题**：方案写“监听自己的 Unix 套接字（权限 0700）”。0700 是目录权限；套接字文件本身通常是 0600。现有 `AuthenticatedUdsServer` 已经处理了路径长度（Linux 107 字节）、目录 0700、socket 0600、旧 socket 属主/存活检查、停止时 unlink。方案应该复用，而不是新写一套 Fastify/undici 逻辑。

**证据**：
- `packages/platform-node/src/authenticated-uds-transport.ts:218-222`：macOS 103、Linux 107 字节上限，超了直接拒绝。
- `packages/platform-node/src/authenticated-uds-transport.ts:227-228`：`mkdir(..., 0o700)` + `chmod(..., 0o700)`。
- `packages/platform-node/src/authenticated-uds-transport.ts:266`：`chmod(this.socketPath, 0o600)`。
- `packages/platform-node/src/authenticated-uds-transport.ts:230-246`：旧 socket 的属主、存活、inode 检查。
- Fastify 文档确认 `listen` 接受 Node net 选项，且 `listeningOrigin` 明确提到 Unix socket：<https://fastify.dev/docs/latest/Reference/Server/#listen> / `#listeningorigin`。所以 W5 不算风险，但没必要为此引入新路径。

**建议**：前门到租户的 UDS 直接复用/扩展现有 `AuthenticatedUdsServer`，每租户一把 bearer/peer instance 凭据；如果要 Fastify 监听，也要自己加路径长度、0600、旧 socket 和停止清理。方案里的“前门签名头”建议改成现有的“凭据 + peer instance”模式，避免共享 HMAC。

---

## 二、推测 / 未核实

1. **SSE 经 undici 转发的行为**：方案自己标未核实。需要真实事件流测“首字节前是否缓冲、客户端断开是否向上游传播、租户停止时是否关闭流”。未核实。
2. **Cloudflare 同一邮箱用邮箱验证码和 Google 登录时 `sub` 是否相同**：W1 只说“unique to an email address per account”，没有说跨 IdP 相同；方案据此推断相同，未实测。未核实。
3. **生产 Magpie 版本是否支持每 key 限额**：文档（`docs/reference.md`，当前 main）确认支持，但 ADR 0117 记的是 v0.1.2001；生产实际版本未核实。
4. **进程内每多一个人的内存增量、20 人冷启动时长、磁盘峰值**：方案只测了单人常驻 680 MB，未测增量。未核实。
5. **`email` 的大小写、plus 别名、Unicode 规范化**：Cloudflare 文档没有给出统一规则，方案自己标未核实。
6. **前门和租户 Fastify 对 URL 编码/路径规范化的具体差异**：需要按实际 Fastify 版本做黑盒测试；目前只能确认存在风险。
7. **`tenant invite` 是否能自动更新 Cloudflare Access 名单**：方案标未核实。
8. **Andy 生产配置的脱敏副本**：方案需要协调者提供；仓库里的 `production-shape-config-template.json` 只是模板，不能证明与生产逐字段相同。未核实。
9. **`usd_estimate` 的单价映射**：`ModelUsageObservation` 只有 `provider`/`model`，没有 `modelRef`；如果同一 `provider/model` 有多个描述符/价格，映射会有歧义。未核实实际是否会重复。
10. **改名册一行就能把 Andy 搬进进程内**：未核实且我认为不成立；见必答问题 1。

---

## 三、侧重检查

### 错误路径
- **首次登录 provisioning 中途失败**：方案说跨库同事务，实际做不到；会留下“名册 active、库没绑定”或“目录建了、名册没写”的半成品。见第 4 条。
- **启动失败/慢启动**：前门最后起，一个人卡住拖住所有人；I-28 实测启动 12–31.5 秒。见第 5 条。
- **配额写失败/进程崩溃**：名册和本人库不一致，配额少计；方案只写“每天对账”。见第 14 条。
- **Gmail 回调失败/重放/并发**：共用状态表和全局 20 条上限，缺少按人限流和设备绑定。见第 9 条。
- **租户停止失败**：方案说“停用 → stop() 并断开连接”，但没有说 stop 超时、后台任务/SSE/子进程/定时器/DB 线程如何强制清理。检查 13 只提端口/套接字/定时器，建议加上 DB worker、执行进程、SSE 连接。

### 不合规范或不可信的输入
- **JWT**：现有验证器只校验签名、issuer、audience、`sub`、`exp`，不校验 `type`、`email`；service token 的 `sub` 为空。见第 11 条。
- **路径**：前门路径拒绝没有规范化，存在编码/重复斜杠/尾斜杠绕过风险。见第 8 条。
- **邮箱**：大小写、plus 别名、Unicode、回收未定义；自动重绑风险。见第 12 条。
- **限额输入**：`scope`/`metric` 是自由字符串，未知价格未定义。见第 20 条。
- **slug/ID**：`safeReference` 允许 `@`、`/`，机器标识不允许；组合 ID 长度未校验。见第 17 条。
- **请求体**：方案只在风险里说“给请求体积加上限”，没有说前门是否缓冲请求体、是否在签名前读完。若前门为了签名而缓冲大 body，会 OOM。建议前门也设 `maximumBodyBytes`，并流式转发。

### 安全
- **管理员接口**：没有 owner 角色校验。见第 7 条。
- **Andy 直连回环**：其它执行进程可绕过前门打 `/bootstrap`、`/break-glass`。见第 3 条。
- **跨租户票据/搜索令牌**：CSRF key 共用会把预览/搜索 key 也共用。见第 10 条。
- **前门签名头**：方案没有说密钥怎么分。若所有租户拿到同一把 HMAC secret，任何一个租户运行时都能伪造另一个租户的“前门签名”。建议每租户一把凭据，或者前门持有私钥、租户只拿公钥；更简单是复用现有 `AuthenticatedUdsServer` 的每 peer 凭据。
- **浏览器存储/推送**：未按人隔离。见第 19 条。
- **日志**：方案说“系统日志只记编号，不记内容”，但没有检查错误路径会不会把 email、路径、提示词带进日志。建议加日志脱敏测试。

### 资源耗尽
- **启动风暴/磁盘**：见第 5 条。
- **内存**：向量 1.4 GB + 20 个执行进程 + 20 个 Fastify + DB 线程；方案未测增量。见第 16 条。
- **DB 线程**：20 人最多 80 个读线程。见第 15 条。
- **名册写热点**：每次模型调用写同一个 SQLite。见第 15 条。
- **Gmail 状态表**：全局 20 条，一个人可占满。见第 9 条。
- **SSE/长连接**：没有每租户/全局连接上限，也没有断开清理。未核实。

### 不可撤销的操作
- **删除一个人**：方案有 `deleting` 状态，但没有删除流程、Access 名单撤销、Gmail 撤销、目录/执行账号删除、回执。ADR 0234 第 10 条要求逐项核对。本块可以不做，但不要留下半删除状态。
- **邮箱重绑**：自动改绑定是高风险不可逆操作。见第 12 条。
- **密钥轮换/重建**：每租户 key 重建会改变遮盖字节，令该租户所有对话前缀失效；Andy 迁移若重建 key 会毁掉全部缓存。见必答问题 1、2。
- **配额封顶**：把 `others_total` 设为 0 会立刻停掉所有客人，管理命令需要二次确认和审计。

### 规则文件、说明文档和代码是否一致
- **prompt-prefix 规则**：方案没有新增会变的系统提示/工具定义，方向正确；但“输入不变所以前缀不变”不能只靠文字，必须用逐字节检查。见必答问题 1。
- **ADR 0234**：方案漏了 P3-1 前置（第 7 条）、Gmail 同设备（第 5 条）、浏览器存储（后果）、读线程上限（后果）、删除流程（第 10 条）、Andy 逐字节迁移（第 11 条）。
- **ADR 0076**：方案说“改变 0076”，0234 说不变。见第 18 条。
- **F19**：后台“不被计数”是误读。见第 13 条。
- **F16**：“约 290 个文件只是往下传”没有证明；至少 `browser-thread-files.ts:151-156` 会把认证 owner 和配置 owner 做比较，说明有些地方会判断，不是纯透传。全量行为未审计，标未核实。
- **F18**：实际 `READ_WORKER_COUNT` 在 `product-state-repository.ts:162`，不是方案写的 161-163 区间；内容对，行号小偏差。
- **W2**：Turso 的 Multi-DB Schemas 页面现在写着 “This feature is now deprecated for all new users.”（<https://docs.turso.tech/features/multi-db-schemas>）。它仍可支持“每人一个库”的类比，但不适合作为“成熟做法”的主证据；Basecamp 的 SQLite 实现更合适。
- **W5**：Fastify 文档确认 `listen` 继承 Node net 选项，并有 Unix socket 的 `listeningOrigin` 描述；这一条可以从未核实升级为已核实。

---

## 四、如果由我来定，我会怎样改这份方案

### 第一步：把“不能做”的先砍掉

1. **块 1 不给客人开通任何走 Vercel 的路径**：P3-1 本机向量完成之前，客人只能用对话模型，记忆向量要么关闭，要么只服务 Andy。把这条写成硬门槛，不是风险提示。
2. **块 1 不做“进程内多人 + Andy 外部直连”混合**，至少不在同一个进程里：
   - 要么前门独立成一个小进程，租户运行时在另一个进程；这样 Andy 的外部进程和客人不共享 OOM。
   - 要么维持 Andy 外部，但用防火墙/Unix 套接字把 Andy 的入口与其它执行账号隔离，并关闭 `/bootstrap`、`/break-glass`。
   - 不要写“Andy 风险为零”。

### 第二步：前门按“反向代理”而不是“业务入口”来设计

- 原样转发所有端到端头；只剥逐跳头和客户端伪造的“前门签名头”。
- 路径规范化后拒绝敏感路径；对 `%2f`、`%62`、`..`、重复斜杠、尾斜杠、大小写写反向用例。
- `/admin/*` 独立授权：`kind=owner` + Andy 的 `sub` + 独立 Access 策略 + CSRF + 审计。
- 每租户一把 UDS 凭据（复用 `AuthenticatedUdsServer`），不要共享 HMAC；socket 0600、目录 0700、路径长度检查。
- 前门先起，租户有界并发/懒启动，未就绪返回维护页。

### 第三步：名册和 provisioning 改成可恢复的状态机

- 名册 `status` 增加 `provisioning`、`failed`；创建流程幂等，失败清理半成品；启动时修复。
- 名册和本人库不做跨库事务；用量先写本地账本，再异步汇总；配额 reservation 落盘，崩溃可恢复。
- `tenantId` 明确定义（建议就用 `ownerId` 或单独加字段），`revision` 加进 schema。
- `limits` 用结构化列 + 枚举 + DB CHECK；`default_new` 为空时仍受 `others_total` 约束；未知价格明确策略。

### 第四步：密钥按“每人一份”列全

- 每人：`payload-encryption`、`identity-csrf`、预览/搜索派生 key、`web-push`、`identity-bootstrap`（如保留）。
- 共用：Magpie provider key、Gmail OAuth client secret。
- 加检查：A 的密钥解不开 B 的密文；A 的预览 ticket/搜索令牌在 B 无效；同一租户重启后遮盖字节不变。

### 第五步：Gmail 和浏览器端

- Gmail 共用层只做“按 state 路由”，记录 `tenantId + ownerId + deviceId + expiresAt`，按租户限流；回调时同时核对当前登录身份和设备。
- 浏览器存储/Service Worker/推送按 `sub` 隔离，退出时清理/撤销；换人登录重新登记推送。

### 第六步：测试顺序

先做 PR A（纯搬运 + 单租户行为不变），再做 B（名册/provisioning），再做 C（前门 + 头转发 + 路径），再做 D（邀请/绑定/停用），再做 E（Gmail/并发/向量注入），最后 F（配额）。每个 PR 都带反向用例；不要等全部做完才跑 `check:prompt-prefix`。

---

## 五、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**第一版（Andy 仍在原单人进程、客人是新对话）：不会，前提是以下三件事同时成立：**

- 系统提示、工具定义、历史仍由同一套代码生成。现有代码里 `ownerId`/`agentId` 只用于准入、出口遮盖和权限判断，没有进入系统提示/工具定义；`packages/runtime-pi/src/pi-runtime-adapter.ts:1040-1048` 等只做 gate 校验，不拼提示。
- 每人的 `stateRoot` 只影响运行环境说明，而运行环境说明按规则放在最后一条用户消息里（`packages/runtime-pi/test/prompt-prefix.compat.test.ts:670-712` 证明只在最后一条、只在变化时发）。
- 每人的模型目录、服务商、密钥、提示词目录和 Andy 当前一致；不能因为“每人生成一份配置”就改变模型顺序/优先级（见第 21 条）。

**但未来把 Andy 搬进新结构时，不能“只改名册一行”：** 必须复用 Andy 原来的 `payload-encryption` 密钥、数据库和配置。否则遮盖 key 变了，同一段文字遮出的字节变了，Andy 所有老对话的请求开头从遮盖处整段失效（`.claude/rules/prompt-prefix.md:51-54` 规则 11；ADR 0234 第 11 条要求迁移前后逐字节相同）。方案第八节说“以后只改名册一行”不成立。

**每轮会变的值**：方案没有新增“时间/额度/租户名”进系统提示或工具定义，方向正确。只要实现时坚持：租户 ID、配额、路径、在线状态都不进 head，只进最后一条消息或 UI，就满足规则 1、2。要加一条真实检查：用 Andy 的旧库回放，合成租户配置生成同一请求，逐字节比较 `messages` 和工具定义；不能只靠“输入没变”的文字推理。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**在同一个租户、同一段对话内：不会，前提是 payload key 和遮盖规则版本稳定。** 出口遮盖 key 从 `payload-encryption` 派生（`apps/agent-service/src/production-model-egress.ts:64-88`），同一把 key + 同一规则版本 → 同一字节；规则 11 要求确定性。

**跨租户：会不同，这是方案有意为之（每人一把 key）。** 这本身可以接受，因为不同租户没有共享对话历史；但必须写清楚“不能指望跨租户缓存共享”。真正的风险是：

- 租户 key 重建/轮换 → 该租户老对话前缀失效；
- 把 Andy 搬进来时新建 key → Andy 全部老对话失效；
- 模型目录顺序/优先级不固定 → 同一模型集可能选出不同 model/路由；
- 若把 `updated_at`、配额、租户名、在线状态等放进系统提示/工具定义 → 每轮字节不同，直接违反规则 2；
- 若共享 CSRF key，预览/搜索 token 的字节也不按租户分开（见第 10 条）。

**建议检查**：同一租户重启后同一段文字遮盖字节相同；不同租户不同；Andy 迁移前后逐字节相同；打乱 Magpie 模型顺序后描述符相同。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有检查，但不够，且有几条反向用例是空的或只证明了一半：**

- 检查 1 只测“A 带 B 的对话/记忆/设备 ID”。要加：Gmail 回调、SSE、`/admin`、预览 ticket、搜索 token、推送、导出、浏览器存储。
- 检查 2 说“B 拒绝（`OWNER_NOT_BOUND` 或前门签名头不符）”。这会让“签名头检查坏了但 owner 绑定挡住了”也通过。要拆成两条：直接连 B 的 socket、带 B 的合法会话但无前门签名 → 必须失败；带正确前门签名 → 成功；伪造签名 → 失败。
- 检查 3 的“运行时尝试取所有人的列表拿不到”在 TypeScript 里很弱；同进程模块图仍可深引用。要用包导出边界/lint/独立 tsconfig，而不是只写运行时测试。
- 检查 10 的路径拒绝要加编码/规范化反向用例，否则测不到绕过。
- 检查 12 枚举 `MODEL_USAGE_PURPOSES` 不能发现“新加一条不经过枚举的调用”；要静态检查所有 `streamSimple`/模型构造入口，或在 transport 层强制 gate；还要覆盖 embedding。
- **缺失的检查**：前门头转发（Host/Origin/Sec-Fetch-Site/CSRF）、首次登录 provisioning 崩溃重试、名册/本人库不一致、配额写失败/进程崩溃、`/admin` 普通成员 403、未知价格、A 的预览/搜索 token 在 B 失败、Andy 直连回环、启动时间预算、20 人冷启动。

每条反向用例必须在“旧代码/故意破坏的代码”上真的失败；只断言“返回 403”不够，要断言失败原因是预期的那一道防线。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能全部接受，逐个核对如下：**

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `email` | 前门从 JWT 取 | 现有 verifier 不返回 email（`identity-gateway.ts:202-219`） | **不通过**；要改 verifier，拒绝 service token/空 email |
| `external_subject_ref` | verifier 用 `sha256(issuer + "\0" + sub)`（`identity-gateway.ts:213`） | 本人库绑定、名册 | 前门必须存这个摘要，不能存原始 `sub`；两端一致 |
| `ownerId/agentId` | 名册/生成器 | `safeReference`（允许 `:/@`）+ `createOwnerId`（允许 `:`，不允许 `@`） | `owner:<slug>` 可通过；方案“@ 不在允许字符”理由错，但结论可用 |
| `deploymentId` | 名册/生成器 | `execution-worker:${deploymentId}`、`agent-service:${deploymentId}`（`service-main.ts:418`、`execution-worker/src/service-main.ts:159`） | 组合后要按最大 slug 验证长度/格式/消费者；方案只测单个 ID |
| `tenantId` | `startTenantRuntime` 返回值 | 名册、闸门、日志 | 现有配置没有这个字段（`strict-configuration.ts:1271-1292`）；要定义是 `ownerId` 还是新字段 |
| `roster.revision` | 管理命令 | 多人外壳轮询 | 方案表里没有 `revision` 列；要补 schema |
| `limits.scope` | 管理命令 | 闸门 | 自由字符串，无类型/CHECK；建议结构化列 |
| `month` | 用量记录 | 名册汇总 | JST `YYYY-MM` 要全链路一致；不要进 prompt |
| `usd_estimate_micros` | 由价格折算 | 配额 | 未知价格 = 0，会少计；要定义策略 |
| `TENANT_QUOTA_EXCEEDED` | 闸门 | 模型错误层/UI | 方案自己标“未核实”；要在真实 UI 测显示 |
| `http.listen` 新 Unix 选项 | 每人配置 | `strict-configuration.ts:548-597`、`production-http-composition.ts:278-281`、`:1202-1206` | 当前只接受 loopback host+port；要同时改解析器、校验器和 listen 调用 |
| `secretReferences` | 每人配置 | `assertIdentitySecretReference`、各 key 使用处 | 只给 `payload-encryption` 不够；`identity-csrf` 还派生预览/搜索 key（`production-http-composition.ts:968-975`） |
| 前门签名头 | 前门 | 每租户 UDS | 密钥分发未定义；共享 HMAC 会让任一租户伪造别人；建议复用 `AuthenticatedUdsServer` 的每 peer 凭据 |
| `kind/status` | 名册 | 前门、生命周期 | 需要与本人库绑定状态同步；停用要撤销会话/设备，不只关 socket |
| `expires_at`/trial | 名册 | 前门 | 到期后拒绝和清理流程未写；本块可延期，但不要留半实现 |

**结论**：方案里至少 `email`、`tenantId`、`revision`、`limits.scope/metric`、未知价格、`secretReferences` 全量、Unix listen 配置这几项，产生端和使用端目前对不上。按 I-73 的教训（`docs/incidents-and-gates.md:112`），每一个生成出来的值都要原样交给真正的配置解析器、标识校验器、数据库和 UI 校验，不能只测生成器。
