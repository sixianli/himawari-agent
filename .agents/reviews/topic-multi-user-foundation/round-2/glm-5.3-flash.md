# 方案审核报告（多人块 1）

## 侧重检查

我选的普通流程：**一位受邀客人第一次登录并发一条消息**。走法：浏览器 → Cloudflare Access 登录 → Cloudflare Tunnel → 前门（新）→ 按名册转发到本人 Unix 套接字 → 每人那份的 Fastify → `identity-gateway.ts` 会话认证 → 线程网关 → 运行调度 → `modelAdmission`（service-main.ts:826-837）→ 模型组合（上限闸门，新）→ 出口遮盖（`production-model-egress.ts:76-85`，按本人 payload 密钥派生遮盖键）→ Magpie → 用量装饰器写本人库 + 名册（新）→ 响应流经前门管道转发回去。

结论：
- **现有测试覆盖的**：从每人那份的 Fastify 向内，全部有覆盖（`test/integration/production-http-composition-process.test.ts` 的 `[PR-A]`/`[PR-B]` 用例真实存在于 1908、1959、2173、2182、2189 行；`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 存在）。
- **没有任何现有覆盖、全部靠新检查的**：前门（验令牌、按 `sub` 路由、套接字转发、SSE 管道、签名头）、合成配置、租户创建/绑定、名册、上限闸门、用量装饰器。方案的第十节对每条都配了反向用例，设计上覆盖是齐的；我发现的缺口见下文第 2、5、7 条。
- **文档一致性**：方案的每条事实前提我核对后基本成立（见末尾清单），但漏掉了 ADR 0234 的四条已接受决定（高-1、高-3、高-4、中-8）。

---

## 按严重度排列的问题

### 高-1：第一版就让客人进来，违反 ADR 0234「P3-1 之前不给别人开通」
- **严重度：高（证实的方案与已接受决定冲突）**
- **证据**：ADR 0234 决定 7（`docs/adr/0234-one-program-per-person-database-file.md:72`）原话：**「记忆向量现在走 Vercel，P3-1（向量改成本机算）上线之前不给别人开通。」** 同文件 71 行：「别人的请求不允许落到任何按量付费的路上」。而代码里每个实例启动都会按配置建嵌入客户端（`service-main.ts:807` `configuredEmbedding(configuration)`），方案的合成配置「沿用现状」意味着每个客人的记忆检索打 Andy 的 Vercel key。方案 2.3 只写「那之前沿用现状，接口先留好」，PR E 只说「向量部分等 P3-1」，全文没有一个地方写「客人开通以 P3-1 上线为前提」。
- **建议**：在方案结论和第八节明确：块 1 交付时进程内客人数为 0，或客人的记忆检索降级为关键词（ADR 0223 已有降级路径）；P3-1 合并前不给客人配 `runPolicy.proactive` 和完整记忆。

### 高-2：第一次登录绑定的「同一个事务」跨两个 SQLite 文件做不到，且方案没找到真正的现有初始化流程
- **严重度：高（证实的判断错误 + 漏场景）**
- **证据**：3.3 写「在**同一个事务**里：创建这个人的目录和库……把 `sub` 绑进名册、调用本人库的 `bindFirstOwner`」。名册（`roster.sqlite`）和本人库（`product.sqlite`）是两个文件，SQLite 没有跨文件事务。中断会留下半个租户：目录和库建好、名册没绑（或反过来），重试时撞「库已存在」。
- 另外，方案说的「现有的初始化流程」在仓库里是 **admin-cli 的 `init` 命令**（`apps/admin-cli/src/initialize-command.ts`）：`mkdir` 非递归占位（36-44 行注释「Existing directories… are never overwritten, including after an interrupted attempt」）、持 state-root 锁、`initializeProductIdentity`（`packages/persistence-sqlite/src/initialize-product-identity.ts:12`）写 owners/agents/deployments、**authority.json 最后写**（69-71 行注释「The authority marker is published last. A failed/partial installation cannot pass normal service startup」）。`initializeStateRoot` 本身不建 authority 文件，服务启动要求它存在且匹配（`service-main.ts:718-728`，缺了报 `AUTHORITY_INACTIVE`）。方案没点名这套顺序纪律。
- **建议**：绑定流程改为复用 `init` 命令的顺序（最后写 authority 标记）+ 幂等续作（init 的占位设计本身就支持重试）+ 失败补偿删除；把「同一个事务」改成「分步可恢复，中断不会产生能通过启动校验的半个租户」。一手来源支持：OWASP 多租户清单第 7 节「Treat onboarding as an all-or-nothing operation: if a step fails, remove partially created resources and record the failure」（https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html）。

### 高-3：漏了 ADR 0234 决定 5 对 Gmail 回调的强制要求
- **严重度：高（证实）**
- **证据**：ADR 0234:67：**「回调时除了查记录还要核对当前登录身份，不能只凭记录里的人名绑定；为此要加自动检查（A 的回调绑不到 B）」**。方案 2.3 和 PR E 只写「登记时写 `tenantId`，回调时按它找人」，没有当前身份核对，第十节也没有对应检查。
- **建议**：共用回调在绑定前比对当前令牌的 `sub`/`email` 与登记记录；第十节加检查「A 发起、B 的浏览器收到回调不得绑到 A」（反向：去掉核对，测试必须失败）。

### 高-4：漏了「给别人开通」的上线条件门槛
- **严重度：高（证实）**
- **证据**：ADR 0234 决定 14（0234:86）：ADR 0083 第 6 条四项条件「继续约束……**给别人开通**的步骤」。`docs/backlog/BL-20261026-003-isolated-instance-per-person.md:39` 记录：「生产连续 7 天没有『用不了』级别的事故：不满足（I-72、I-73 在 11-02，I-84 在 11-07）」。方案第十节「事故门槛」写「本块没有新事故」，但没写既有门槛约束块 1 的部署范围。
- **建议**：方案写明：在 Andy 豁免或条件满足之前，块 1 上线只含 Andy（外部去向）+ 零客人；豁免要记原话（同 ADR 决定 14 的要求）。

### 中-5：前门写死拒绝 `/bootstrap`、`/break-glass` 的静态名单会烂
- **严重度：中（证实的设计缺陷；替代方案为推测）**
- **证据**：回环判断集中在 `identity-gateway.ts:505-512` 的 `isLoopback`，目前两处使用（544、809，均已核实）。将来任何新增的 isLoopback-only 路径（或任何文件里的回环信任点）都不会自动进入前门的名单，这是 I-73 式「名单和代码漂移」。对 Andy 的外部进程确实只能靠前门名单（他那边一个字节不动，转发请求在他看来全部来自 127.0.0.1——这个分析本身是对的，我核实了 `isLoopback` 和两处调用）。
- **建议**：对**进程内**租户不用名单，改用结构办法：前门转发时带前门签名头（方案已有），每人那份在处理回环专属路径时，凡是带有效前门签名头的请求一律视为非回环（或由前门把 `remoteAddress` 置为哨兵值）。这样回环判断仍由现有代码守住，名单只留给 Andy 外部那一条路，并给名单加一条静态检查：扫描仓库里 `isLoopback` 的全部调用点，名单必须覆盖（否则失败）。

### 中-6：名册被两个进程写，方案没写跨进程并发；用量「一次写、同一个事务」跨文件也做不到
- **严重度：中（证实的缺口 + 推测的影响量级）**
- **证据**：第四节写「名册的写操作全部在共用层」，但第七节的管理命令「是另一个进程，它只写名册」、`tenant invite` 也是命令——至少两个进程写同一个 `roster.sqlite`，方案没有 WAL、busy_timeout、锁等待的任何安排。用量装饰器「在写入每人库的同时，把……累加进名册（一次写，同一个事务里不写别处）」——每人库和名册是两个文件，事务同样跨不过去；且名册成为每次模型调用的写热点（20 人 × 每轮 chat + 标题 + 记忆 + 邮件判断），写竞争未测（本仓库 I-29 的教训正是单写线程排队）。
- **建议**：名册单写者原则——管理命令只写名册的 `limits`/`audit`/`tenants`（低频），用量计数由服务进程在内存聚合、按秒或每 N 次刷盘（软上限本来就该有在途占位，见方案自己的设计）；开 WAL、设 busy_timeout；写明刷盘滞后时上限按「内存值」判断，重启时用名册值 + 每天对账。

### 中-7：I-73 相对称——检查 11 缺合约层校验，且方案对 `safeReference` 的事实陈述有误
- **严重度：中（证实的事实错误 + 检查缺口）**
- **证据**：方案第五节写「配置校验（`safeReference`，`strict-configuration.ts` 约 95–101 行）……邮箱里的 `@` 不在允许字符里」。实际 `safeReference` **允许** `@` 和 `/`：`strict-configuration.ts:100` 的正则是 `/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/`。不允许 `@` 的是机器标识校验（`packages/domain/src/identifiers.ts:39`，`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`）和两个合约包的 `machineString`（`packages/gateway-contracts/src/validation.ts:54`）。结论（用 `owner:<slug>`）是对的，但按方案的检查 11「交给真正的配置解析器（`parseProductConfiguration`）」单独跑，**带 `@` 的 ownerId 会被配置层放过**，要等网关合约层才爆——正是 I-73 的形状（I-73 的教训原话：「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」，`docs/incidents-and-gates.md:112`）。
- **建议**：检查 11 明确列出四层都要过：`parseProductConfiguration`、`createOwnerId/createAgentId/createDeploymentId`、两个合约包的 `machineString`、以及 `initializeProductIdentity` + 真库迁移。顺带把第五节那句「`@` 不在允许字符里」改成准确的表述。

### 中-8：浏览器同源共享的草稿/偏好没进方案
- **严重度：中（证实漏了已接受决定的后果项）**
- **证据**：ADR 0234 后果（0234:111）：**「浏览器里存的草稿和偏好要改成按人分开，换人登录时重新登记推送」**。多人共用一个公开网址后，同一浏览器先后登录两个人，本地存储（I-16 之后仍留在浏览器的键，如草稿、主题）会串人；推送订阅也要换人重新登记。方案块 1–6 都没提。
- **建议**：至少写进风险节并指派给某个 PR 或块 4；自动检查沿用 `owner-settings-sync` 那套「浏览器存储键白名单」的办法（I-16 的门槛先例）。

### 中-9：`TENANT_QUOTA_EXCEEDED` 不带文案映射，第一版超限用户看到的是笼统失败
- **严重度：中（证实有先例可复用；影响为推测）**
- **证据**：配额类错误码有专门的呈现先例：I-11（`incidents-and-gates.md:50`）里 402 被映射成三语的「额度被拒」说明，并有测试（`execution-view.unit.test.ts`、`pi-runtime-adapter.compat.test.ts`）。方案第七节说要「网页显示『本月已用多少 / 上限多少』」却又把界面划给块 4，PR F 只交付错误码。
- **建议**：PR F 顺带把新码接进现有的错误码 → 三语文案映射和对应测试；块 4 只做「用量数字页面」。

### 低-10：若干前提行号漂移与未核实项的更正/落实
- **严重度：低（证实）**
- **证据**：F1 引 `service-main.ts:516`，实际 `export async function runAgentService(` 在 525 行；F4 引 `strict-configuration.ts:1528-1536`，单主人的实际解析在 1557-1561；undici 在 `packages/platform-node/package.json:28`（方案写 26）。内容全部属实。
- **建议**：注明行号以某个提交为准（我检出的 HEAD 是 65d39ca）。F18（每库 1 写 3 读线程）我未重新打开，维持方案自己的「沿用」标记。

### 低-11：起人顺序和 JST 月份的确定性没写死
- **严重度：低（推测）**
- **证据**：第六节「按顺序起来」没给排序键；SQLite 无 ORDER BY 的返回顺序不保证。`usage_monthly` 的 `month` 用「JST 的 `YYYY-MM`」，若依赖进程时区就不可复现。
- **建议**：起人按 `ORDER BY created_at, tenant_id`；月份显式按 +09:00 计算。这是把 prompt-prefix 规则第 10 条（顺序固定、不依赖遍历顺序）的纪律用到新数据结构上。

### 低-12：W5 其实已经可以核实，且套接字权限有个实现细节
- **严重度：低（证实 + 推测）**
- **证据**：Fastify 官方 Server 文档（https://fastify.dev/docs/latest/Reference/Server/）：`listen` 的选项「extend the Node.js core options object. Thus, all core options are available」，其中含 Unix 套接字的 `path`；同页 `listeningOrigin` 一节原话「a Unix socket server will return the socket path, e.g. `fastify.temp.sock`」。方案可把它从「未核实」改为已核实。另外 Node 建 Unix 套接字文件的默认 mode 是 0666 按掩码收敛，不保证 0700——`listen` 之后要对套接字文件 `chmod 0700`，检查 8 要测套接字文件本身的权限位（推测，实现细节）。

---

## 对标核实结果（一手来源）

- **W1 已核实**：Cloudflare 官方文档（https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/，2026-06-25 更新）确有「email — The email address of the authenticated user, verified by the identity provider」和「sub — …unique to an email address per account…would get a different `sub` if they are removed and re-added」。**补充两条方案没写的事实**：① 服务令牌认证时 `sub` 是**空字符串**——前门必须显式拒绝空 `sub`；② `aud` 是数组且按 Access 应用发——一个 Access 应用配多条策略时 `aud` 不变，方案成立。
- **W3 已核实**：OWASP 原话逐字存在：「establish tenant context early in the request lifecycle」「Treat client-supplied tenant identifiers as selectors only. Verify that the authenticated principal is authorized to act in the selected tenant」。方案前门第 4 条「不接受请求里任何字段指定」与此一致。
- **W5 已核实**：见低-12。
- **代码前提核对**：F2（682/714-737）、F3（496-523/771-777）、F6、F7（`production-http-composition.ts:278`）、F8（`http-gateway-server.ts:803`）、F9（603-605）、F10（520-559）、F11（`production-proactive.ts:170`）、F12（826-837）、F13（`model-usage.ts:18-42`）、F19（`production-model-composition.ts:47`）、F20（544/809）、ADR 0076（39-41）、遮盖键按 payload 密钥派生（`production-model-egress.ts:76-85`）、`MODEL_USAGE_PURPOSES` 8 个用途（`model-usage.ts:3-12`）、`check:prompt-prefix` 存在（`package.json:56`）、迁移 0087 确属 product 序列——**全部成立**。`/mnt/...` 下的测量文件和 Magpie 文档不在本机可核范围，维持方案自己的未核实标记。

---

## 如果由我来定

方案的主干（拆 `startTenantRuntime`、前门、名册、Andy 第一版留外部、上限做在模型端口层而非 `modelAdmission`）我认同，保留。我会改六处：

1. **开通前提写死**：块 1 上线 = Andy 外部 + 零客人；客人上线以 P3-1（本机向量）和 ADR 0083 第 6 条四项条件（或 Andy 记录原话豁免）为前提（高-1、高-4）。
2. **绑定流程改成「分步可恢复」**：复用 admin-cli `init` 的顺序纪律（authority 标记最后写、目录占位防半成品）+ 幂等重试 + 失败补偿删除，替代跨库「同一个事务」（高-2）。
3. **Gmail 回调补当前身份核对 + 「A 的回调绑不到 B」检查**（高-3）。
4. **回环信任改结构化**：进程内租户用「带前门签名 = 非回环」，静态名单只留给 Andy 外部路径并加调用点覆盖检查（中-5）。
5. **名册单写者 + WAL + 内存聚合用量**，每月上限判断用在途内存值（中-6）。
6. **检查 11 加四层校验**（含两个合约包的 `machineString`），PR F 带上 `TENANT_QUOTA_EXCEEDED` 的文案映射（中-7、中-9）；浏览器本地存储按人分开记入风险或块 4（中-8）。

### 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会，满足规则。依据：PR A 是纯搬运且要求「现有全部测试不改一行就通过」，守门的是 `npm run check:prompt-prefix`（`package.json:56`，规则第 74 行写明它含反向用例：改写历史用户消息、系统提示带每轮变化的值、关掉冻结都必须失败）和端到端 `[PR-A]`/`[PR-B]` 用例（`production-http-composition-process.test.ts:1908/1959/2173`，其中 2182 行就是反向用例）；Andy 第一版走不动一个字节的外部进程；进程内租户全是新对话；上限闸门在组装之前拒绝，不修改任何内容；遮盖键按人派生但对同一人同一对话稳定（`production-model-egress.ts:76-85`）。每轮会变的值（时间、记忆、运行环境说明）的落位代码没有被这次改动触碰。补充要求：起人顺序和 JST 月份要确定化（低-11），防止同类纪律在新代码里松动。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 本方案没有引入这样的值。遮盖取决于「它自己和它前面的内容 + 遮盖密钥 + 构建内固定的提示词清单」（规则第 11 条、53 条），三者按人稳定；名册、月份、前门签名头都不进模型内容。需要钉死的两处：名册遍历要显式 ORDER BY，JST 月份要显式 +09:00（低-11）；Magpie 动态模型清单随启动时刻漂移是今天已有的行为，不是本方案引入，但方案第七节的「允许列表」检查顺带把这点纳入告警。

**3. 有没有对应的自动检查、反向用例会不会真的失败？** 大体有且设计合理：现有门槛真实存在并含反向用例（已核实测试文件与 `[PR-B] REVERSE` 用例在 2182 行）；新检查逐条配了反向用例（如检查 1 的「永远返回同一个人必须失败」、检查 6 的「写死额度数字必须失败」、检查 10 的「临时放行必须失败」），可落地。缺口两处：检查 11 缺合约层解析（中-7）；检查 10 的静态名单需要「覆盖 `isLoopback` 全部调用点」的静态核对，否则名单烂了检查也不会红（中-5）。

**4. 每个新值两端都核对了吗？** 逐个核过的结论：`owner:<slug>`/`agent:<slug>`/`deployment:<slug>` 通过三处校验（`identifiers.ts:39` 允许冒号连字符；`strict-configuration.ts:100` 放行；`gateway-contracts/validation.ts:54` 放行），`agentServiceInstanceId = agent-service:${deploymentId}` 是纯字符串拼接没问题，执行进程实例编号的精确匹配（`service-main.ts:418` 附近）我**未核实**，方案自己也标了核对义务；`tenant_id` 只进路径，需防路径遍历（方案检查 11 的反向用例已含）；名册字段、`limits`/`usage_monthly`/`audit` 的消费方都在共用层，一致；`TENANT_QUOTA_EXCEEDED` 有呈现先例可接（中-9）；套接字路径需显式 chmod（低-12）；管理命令跨进程写名册缺并发安排（中-6）。每把 `payload-encryption` 密钥必须恰好一份（`production-model-egress.ts:69-74` 要求 `payloadKeys.length === 1`），合成配置要保证这一点，方案未明说，建议补进检查 11。
