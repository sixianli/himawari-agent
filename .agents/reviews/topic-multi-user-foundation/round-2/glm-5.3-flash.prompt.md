你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 65d39ca700906ad310176bee8872a7ec62e2034e。
待审核的方案：
# 多人块 1 实现方案（线程初稿，未给模型看过）：共用层和每人一份

> 只出方案，没有改代码。代码现状以分支 `claude/project-thread-kw2jw2`（基于 main `2997b49`）为准。
> 上游方案：`/mnt/project-files/multi-user-plan/integrated-plan.md`（下称“整合方案”），Andy 2026-11-11 已定：一个程序、每人一个数据库文件；所有人走 Andy 的 OpenCode Go 套餐、不用 Vercel；每人每月上限由 Andy 随时配置、代码里不写死。

## 阅读导航

- [结论](#tldr)
- [前提和来源](#premises)
- [对标：业界怎么做、我们为什么这样做](#benchmark)
- [一、哪些共用、哪些每人一份](#cut)
- [二、拆分办法：把一个函数拆成“起一个人”](#extract)
- [三、前门：按登录身份把请求送到那个人](#front-door)
- [四、名册](#roster)
- [五、每人一份的配置、密钥、目录](#per-tenant)
- [六、后台任务和生命周期](#lifecycle)
- [七、模型路由和每人每月上限](#cost)
- [八、Andy 自己的数据怎么搬](#andy)
- [九、分几个 PR、每步怎么证明没改坏](#prs)
- [十、自动检查](#gates)
- [十一、风险和未核实](#risks)

<a id="tldr"></a>
## 结论

1. **把 `runAgentService` 这个约 2000 行的函数拆成“起一个人（`startTenantRuntime`）”和“进程外壳”两半。** 起一个人拿到的就是今天那份 `configuration`，只是 ownerId、agentId、deploymentId、stateRoot、密钥引用换成这个人的。今天单人用的路径等于“只起一个人的外壳”，所以每一步都能用现有测试证明没改坏。
2. **新增一个很小的“前门”**：进程里一个共用的网页入口，验 Cloudflare Access 令牌，按令牌里的用户编号（`sub`）查名册，把请求转发给那个人自己的网页服务。每个人的网页服务监听自己的 Unix 套接字（权限 0700），不再各占一个本机端口。
3. **新增一个“名册”**：一个独立的小 SQLite 文件，记谁是谁、状态、上限、每月用量计数。不放任何私人内容，也不动 Andy 的 `product.sqlite`，所以**不占迁移号**。
4. **登录绑定在前门里完成**：Andy 用命令邀请一个邮箱；这个邮箱第一次登录时，前门用令牌里经身份提供方验证过的 `email` 找到邀请，把 `sub` 记进名册并绑进那个人的库。
5. **每人每月上限放在名册里，数值只由 Andy 的管理命令写入**；调用模型之前由一个共用的“闸门”按人、按总量核对。代码里没有任何额度数字，自动检查会扫。
6. **一个人起不来或授权丢失，只让这个人显示“维护中”**，不再让整个进程退出（今天授权丢失会让整个服务停）。
7. **Andy 自己的那一份第一版不搬进来（新）**：前门支持两种去向：“进程内的人”和“外部去向”（一个已经在跑的本机端口）。第一版 Andy 是外部去向，仍由现在那个单人进程服务，数据、配置、请求开头一个字节都不动；客人在进程内。这样 Andy 的聊天不和客人共用故障范围，Andy 的上线风险为零，回滚就是让前门不转发。以后要把 Andy 搬进来，只改名册里一行。
8. **“同一进程还是每人一个进程”已有测量依据**：生产机实测可用内存 6.4 GB，一整套单人服务约 680 MB（主进程 473 MB、执行进程 161 MB、守护进程 49 MB），每人一个进程大约只能同时在线 7 人，所以维持“进程内”（`/mnt/project-files/multi-user-measure/result.md`）；进程内每多一个人的增量还没测，要在测试机上用假数据测。下面这条是兜底：：前门和每人那一份只通过 Unix 套接字说话，所以块 0 测出来内存放不下时，把“起一个人”换成“起一个子进程”即可，前门和名册都不变。

<a id="premises"></a>
## 前提和来源

每条都附原话；“未核实”的方案不从它出发。

| # | 前提 | 来源 | 原话或摘录 |
|---|---|---|---|
| F1 | 整个服务由一个函数为一份配置组装 | `apps/agent-service/src/service-main.ts:516` | `export async function runAgentService(` |
| F2 | 启动时读一份配置并和库里的部署权限核对主人 | `service-main.ts:682`、`:714-737` | `new JsonFileConfigurationPort(args.configurationPath).load()`；`authorityFile.ownerId !== configuration.ownerId` → `AUTHORITY_MISMATCH` |
| F3 | 授权丢失会让整个进程停 | `service-main.ts:495`、`:773` | `waitForTerminationOrAuthorityLoss`；`onLost` 里 `resolveAuthorityLoss?.()` |
| F4 | 配置里只有一个主人、一个部署、一个状态目录 | `packages/platform-node/src/strict-configuration.ts:1528-1536` | `deploymentId`、`ownerId`、`stateRoot` 各一个 |
| F5 | 状态目录必须属于服务账号、权限 0700 | `packages/platform-node/src/state-root-layout.ts:108-113` | `info.uid !== process.getuid()` → `PERMISSIONS_UNSAFE` |
| F6 | 执行进程经状态目录里的套接字连接 | `service-main.ts:1175` | `socketPath: path.join(configuration.runtimeDirectory, "execution.sock")` |
| F7 | 网页服务只允许监听本机地址和端口 | `apps/agent-service/src/production-http-composition.ts:278` | `http.listenHost !== "127.0.0.1" && http.listenHost !== "::1"` → 配置不完整 |
| F8 | 网页服务不信任代理头 | `packages/platform-node/src/http-gateway-server.ts:803` | `trustProxy: false` |
| F9 | 登录按 Cloudflare 用户编号找绑定的主人，没绑定就拒绝 | `packages/platform-node/src/identity-gateway.ts:603-605` | `readBySubject(assertion.externalSubjectRef)` … `OWNER_NOT_BOUND` |
| F10 | 现有“绑定第一个主人”只在本机回环且凭一次性口令 | `identity-gateway.ts:520-560` | `BOOTSTRAP_NOT_LOOPBACK`、`matchesDigest(input.token, …)` |
| F11 | Gmail 授权的待处理记录在实例内存里 | `apps/agent-service/src/production-proactive.ts:170` | `readonly #states = new Map<string, { readonly owner: string; readonly expiresAt: number }>();` |
| F12 | 模型调用的准入决定在一个可注入的函数里 | `service-main.ts:824-835` | `const modelAdmission: ModelInvocationAdmissionResolver = async (scope) => {` 里先比对 `scope.ownerId !== configuration.ownerId`，不符返回 `undefined` |
| F13 | 每次模型调用已记 token 数，没有费用和月汇总 | `packages/application/src/ports/model-usage.ts:18-44` | `ModelUsageObservation`（含 `inputTokens`、`outputTokens`、`cacheReadTokens`、`occurredAt`）；`ModelUsageStorePort.record` |
| F14 | 产品里不设费用上限，保留用量账本 | `docs/adr/0076-no-model-cost-budget-limits.md:36-41` | “删除配置里的整个 `budgets` 段”；“保留预算账本作为用量统计和恢复门禁” |
| F15 | Magpie 在本机不检查访问密钥 | `docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:114` | “Magpie 只监听本机时不检查访问密钥” |
| F16 | 非测试代码里约 290 个文件引用 `ownerId` | `grep -rln ownerId --include=*.ts apps packages`（我跑的，去掉 test） | 291 个文件；多数是把配置里的主人往下传，不是自己判断 |
| F17 | 进程级的共享状态很少 | `grep -rnE "^(export )?(const|let) \w+ = new (Map|Set|WeakMap)"` 非测试 | 只有 `production-model-egress.ts:18` 的按对象索引的 `WeakMap` 和一些常量集合；`process.env` 只用于运行环境路径、代理和沙箱路径，不存主人信息 |
| F18 | 一个库 1 个写线程加最多 3 个读线程 | `packages/persistence-sqlite/src/product-state-repository.ts:161-163`（整合方案 P22 引用） | `const READ_WORKER_COUNT = 3;`（我没有重新打开这一行，沿用整合方案的引用，**标为沿用**） |
| F19 | 后台邮件判断的模型调用不走准入，直接放行 | `apps/agent-service/src/production-model-composition.ts:47`、`:516` | `begin: async () => ({ disposition: "fresh" as const, permit: UNMETERED_PERMIT })` |
| F20 | “绑定第一个主人”和“应急登录”只在请求来自本机回环时才可信 | `packages/platform-node/src/identity-gateway.ts:544`、`:809` | `if (!isLoopback(input.remoteAddress))`；`!isLoopback(input.remoteAddress) ||` |
| F21 | 生产机实测内存 | `/mnt/project-files/multi-user-measure/result.md` | “可用 6.4 GB”；“一整套 Himawari … ≈ 680 MB”；“同一进程里多一个人的内存增量没测” |
| W1 | Cloudflare Access 令牌里的 `email` 经身份提供方验证；`sub` 对每个邮箱唯一，被移出再加回来会变 | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ | “The email address of the authenticated user, verified by the identity provider.”；“The ID of the user. This value is unique to an email address per account. The same user gets a different `sub` if they are removed and re-added to your Zero Trust organization” |
| W2 | 每人一个库是成熟做法；多库改表时没改完的库要单独处理 | https://docs.turso.tech/features/multi-db-schemas | “each tenant has their own database”；“Make sure any application querying the child databases handle any databases not yet updated” |
| W3 | 租户上下文要在请求最早处建立，客户端传来的租户标识只能当选择器 | https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html | “Treat client-supplied tenant identifiers as selectors only.”；“establish tenant context early in the request lifecycle” |
| W4 | Basecamp 的每租户一个 SQLite 实现 | https://github.com/basecamp/activerecord-tenanted | “All tenant-related code execution must happen within a well-defined isolated tenant context” |
| W5 | Fastify 可以监听 Unix 套接字 | https://fastify.dev/docs/latest/Reference/Server/#listen | **未核实，开工先读原文**（我凭记忆知道有 `listen({ path })`，没有打开原文） |

**未核实（方案不从它们出发）**

- 块 0（生产机测量）的结果：一个人那一份常驻多少内存、整机还剩多少。它决定“进程内”还是“子进程”，见[第二节](#extract)。
- F18 的行号没有重新核对。
- W5。
- 前门转发长连接（服务器推送事件，SSE）时的缓冲和断开行为：需要在实现第一步用真实的事件流测一次。
- 同一个邮箱先后用邮箱验证码和 Google 登录，`sub` 是否相同：W1 说“每个邮箱唯一”，据此推断相同，**没有实测**。
- 令牌里 `email` 的大小写、别名（plus 地址）规则：名册要统一小写比较，别名要不要等同，开工前问 Cloudflare 文档。

<a id="benchmark"></a>
## 对标：业界怎么做、我们为什么这样做

- **业界**：每人一个 SQLite 库是公开做法（W2、W4）；多租户的共同要点是“租户上下文在请求最早处确定、客户端传来的标识只当选择器、每个租户的代码只拿得到自己的资源”（W3）。Muse、Manus 等是每人（每任务）一台虚拟机（整合方案 W1、W4），隔离最强但贵，Andy 已排除多花钱。
- **用户看到的**：对标 ChatGPT/Claude，用户只看到一个网址、登录后就是自己的空间；别人的存在对他不可见。我们一致。
- **这是根因还是表面修补**：根因是“主人”被当成进程级常量写进了配置对象。表面修补是在每个接口加一个 `if (ownerId …)`，不会让“A 读不到 B”成立。本方案让每个人那一份只拿到自己的库对象（结构上拿不到别人的），这是根因处理。
- **放弃了什么**：放弃了“单库加 owner_id 列”（SQLite 没有按行权限，整合方案 W33）；暂不做每人一个进程（等块 0 的内存数）。

<a id="cut"></a>
## 一、哪些共用、哪些每人一份

**共用层（进程里只有一份，只在这里能看到“所有人的列表”）**

| 东西 | 说明 |
|---|---|
| 前门 | 唯一监听本机端口的网页入口；验令牌、按人转发 |
| 名册 | 谁是谁、状态、邀请、上限、每月用量计数 |
| Cloudflare 令牌验证器 | 一份公钥集合缓存，所有人共用 |
| 本机向量模型的客户端 | 约 1.4 GB，在单独进程里（另一个 PR），通过注入给每个人那一份 |
| Gmail 授权待处理表 | 现在在每份实例的内存里（F11），改成共用，按“发起时记下是谁”找人 |
| 并发闸门和费用闸门 | 全机并发、每人并发、每人每月上限、其他人总上限 |
| 日志 | 系统日志只记人的编号，不记内容 |
| 静态网页文件的读取 | 一份只读内容，所有人的网页服务共用同一份字节 |

**每人一份（`startTenantRuntime` 里按人创建）**

数据库（`product.sqlite`）、授权/租约/围栏、状态目录（含密钥）、负载加密密钥、执行进程的套接字、模型组合和每人的模型配置、记忆组合、运行调度、后台任务（主动查邮件、整理记忆、推送）、网页服务（Fastify 实例）、健康状态、推送订阅和“在线状态”。

**代码层面的硬规则**：每人一份的代码只拿得到“本人的对象”，没有任何接口能列出所有人。`TenantRegistry`（所有人的列表）只在共用层，它的类型不导出给每人一份的包（见[第十节](#gates)检查 3）。

<a id="extract"></a>
## 二、拆分办法：把一个函数拆成“起一个人”

### 2.1 做什么

1. 把 `runAgentService` 里从“读配置之后”到“网页服务监听之前”的全部组装，原样搬进 `startTenantRuntime(input)`，返回一个句柄：`{ tenantId, listenPath, health, stop(), onAuthorityLost(handler) }`。
2. 现在函数里靠闭包共享的十几个 `let`（`repository`、`authorityLifecycle`、`http`、`runs` 等，`service-main.ts:520-560`）变成 `startTenantRuntime` 的内部状态，生命周期仍用现有的 `ProductionServiceLifecycle`，每个人一个实例。
3. `runAgentService` 保留为“进程外壳”：解析参数、读配置、起一个人、等信号，关机时停掉它。**单人部署走这一条，行为不变。**
4. 多人外壳（新）：读名册，对每个状态为“活跃”的人调用 `startTenantRuntime`，再起前门。

### 2.2 不动的

- 每人一份内部所有 `configuration.ownerId` 的读法保持不变（F16：约 290 个文件只是往下传）。**这是本方案最重要的省事点：不去改这 290 个文件。**
- 配置校验器 `strict-configuration.ts` 不改成多主人；改成“基础配置（共用部分）+ 每人覆盖（见[第五节](#per-tenant)）”合成出每个人各自合法的一份，再交给原来的校验。

### 2.3 要改的小口子

| 口子 | 现在 | 改成 |
|---|---|---|
| 网页服务监听（F7） | 只能 127.0.0.1 加端口 | 增加一种“监听 Unix 套接字路径”，路径在本人状态目录的 `runtime/`，权限 0700；原来的端口监听保留，单人外壳继续用 |
| 授权丢失（F3） | 让整个进程退出 | `startTenantRuntime` 把它变成句柄上的事件；单人外壳仍然退出，多人外壳只把这个人标为“维护中”并告警 |
| 向量模型 | 每个实例自己建（`configuredEmbedding`） | 通过依赖注入拿共用客户端（P3-1 合并后；那之前沿用现状，接口先留好） |
| Gmail 待处理表（F11） | 实例内 Map | 注入一个共用的“授权状态登记处”，登记时写 `tenantId`，回调时按它找人 |
| 并发 | 每个实例各算各的 | 注入共用并发闸门；没传时行为不变 |
| 沙箱执行进程（F6） | 每人一个套接字，天然分开 | 不变；每人一个执行进程和系统账号是块 2 的事 |

### 2.4 进程内还是子进程（不现在定）

`startTenantRuntime` 的返回值只暴露套接字路径和少数方法。块 0 的内存数出来后：
- 放得下：进程内起（默认，Andy 已同意“一个程序”）。
- 放不下：换成“起一个子进程运行单人外壳”，前门不变。这一步的改动只在多人外壳里，不改这一块的其他部分。
本块**只实现进程内**，不同时做两种。

<a id="front-door"></a>
## 三、前门：按登录身份把请求送到那个人

1. 前门监听今天网页服务监听的那个本机端口，所以 Cloudflare Tunnel 的配置不用改。
2. 每个请求先取 `Cf-Access-Jwt-Assertion` 头，用共用验证器验签名、有效期、受众（今天每人那份代码里做的同一套检查，W3：租户上下文最早建立）。验不过直接 401，不转发。
3. 取出 `sub` 和 `email`：先用 `sub` 查名册；查不到再用 `email` 找邀请（见 3.3）。名册里状态不是“活跃”的人立刻拒绝（不等会话过期）。
4. 转发给该人的 Unix 套接字，路径由名册和状态目录规则算出，**不接受请求里任何字段指定**。
5. 前门转发时只带原始请求头里的令牌和会话 cookie（每人那份代码照样验一遍令牌和会话），并加一个前门签名头给每人那一份核对“这个请求确实是前门按这个人转来的”，防止本机另一个账号直接连这个套接字（套接字权限 0700 是第一道，签名头是第二道）。
6. 每人那份代码里的登录校验（`identity-gateway.ts`）**保持不变**：令牌里的 `sub` 必须是库里绑定的主人，否则 `OWNER_NOT_BOUND`（F9）。前门选错人时，这一道会拒绝，所以前门写错不会变成“A 看到 B”，只会变成“A 打不开”。
7. 转发实现用已有依赖 `undici`（`packages/platform-node/package.json:26`），流式响应（SSE）直接管道转发，不缓冲；不加新依赖。
8. **前门必须拒绝 `/bootstrap` 和 `/break-glass` 两类路径（新，来自模型审核）**：现有这两个入口靠“请求来自本机回环”判断是否可信（`identity-gateway.ts:544`、`:809` 调用 `isLoopback(...)`）。前门放在前面后，转发到 Andy 的外部端口的请求在他那边看起来全部来自 127.0.0.1，公网请求就会被当成本机请求。所以：前门写死拒绝这些路径（名单在代码里，是安全边界，不是额度这类可配置值）；进程内每个人的配置把 `identity.bootstrap.enabled` 设为 false（绑定只由前门内部完成）；反向用例：临时放行这条路径，测试必须能观察到“公网请求被当成本机”而失败。
9. 前门不处理任何业务路径，只处理：健康检查、静态文件（可选：交给每人那份）、`/admin/*`（Andy 专用，见[第七节](#cost)）和一个共用的 Gmail 授权回调。

### 3.3 邀请和第一次登录绑定

- Andy 用命令 `tenant invite <邮箱>` 在名册里记一条“已邀请”（邮箱统一小写）。
- 这个邮箱第一次通过 Cloudflare Access 登录时：前门见 `sub` 不在名册里、`email` 匹配一条“已邀请”，在**同一个事务**里：创建这个人的目录和库（调用 `initializeStateRoot` 和现有的初始化流程）、把 `sub` 绑进名册、调用本人库的 `bindFirstOwner`（今天的 F10 只允许回环加口令，这里改成“前门内部调用，不走网页”）。
- Cloudflare 那一侧要先把邮箱放进 Access 名单，否则令牌发不出来；这一步是否能用接口自动化**未核实**，不能的话 `tenant invite` 打印“请把这个邮箱加进 Access 名单”，由 Andy 点一下。
- W1 说用户被移出再加回来，`sub` 会变：所以**邮箱是名册里的稳定身份，`sub` 是可重绑的缓存**。遇到 `sub` 不认识但邮箱对应一个已绑定的活跃的人时，前门更新名册里的 `sub` 和本人库里的绑定（只有令牌里经验证的 `email` 与名册一致才允许）。

<a id="roster"></a>
## 四、名册

一个独立文件：`<共用状态目录>/roster.sqlite`（共用状态目录是新的，和 Andy 现有的 `/var/lib/himawari/state` 并列，**不动 Andy 的库**）。用同样的迁移引擎，但是它自己的迁移序列，不占 `product.sqlite` 的迁移号（0087–0091 都是 product 的）。

| 表 | 字段（要点） |
|---|---|
| `tenants` | `tenant_id`、`email`（唯一，小写）、`external_subject_ref`（可空，登录后绑定）、`owner_id`、`agent_id`、`deployment_id`、`kind`（`owner`、`member`、`trial`）、`status`（`invited`、`active`、`maintenance`、`suspended`、`deleting`）、`created_at`、`expires_at`（体验用，空表示长期） |
| `limits` | `scope`（`tenant:<id>` 或 `others_total` 或 `default_new`）、`metric`（`calls`、`tokens`、`usd_estimate`）、`monthly_limit`（可空，空表示不限）、`updated_by`、`updated_at` |
| `usage_monthly` | `tenant_id`、`month`（JST 的 `YYYY-MM`）、`calls`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`usd_estimate_micros`、`unknown_calls` |
| `audit` | Andy 每次改上限、邀请、停用的记录 |

- **数值只由管理命令写入**，没有默认数字：`default_new` 为空时新加的人不设上限但前门告警提醒（Andy 说的“灵活配置”）。
- 名册只存编号、邮箱、状态、数字，不存对话、记忆、密钥。
- 名册的写操作全部在共用层，每人一份的代码拿不到名册对象。

<a id="per-tenant"></a>
## 五、每人一份的配置、密钥、目录

- **合成配置**：共用基础配置（模型目录、截止时间、公开地址、运行策略等，今天那份 JSON）加每人覆盖：`deploymentId`、`ownerId`、`agentId`、`stateRoot`（`<租户根>/<tenant_id>`）、`runtimeDirectory`、`cacheDirectory`、`secretReferences`、`http.listen`（改成套接字路径）。F5 要求目录属于服务账号：所有人的目录都属于主程序账号，别的账号进不去（块 2 再给每人一个执行账号，只能进工作目录）。
- **密钥**：每个人一把 `payload-encryption` 密钥，在创建这个人时生成，存在他自己的状态目录下的密钥目录；`createProductionModelEgress`（`production-model-egress.ts:60-86`）里的遮盖密钥从它派生，所以每人的遮盖和加密天然不同。共用的密钥（Magpie 网关密钥、Gmail 客户端密钥）放共用层，通过只读引用注入。
- **标识格式（来自 DeepSeek 审核，我读了校验函数再确认，标为“实现时核对”）**：`ownerId`、`agentId`、`deploymentId` 必须同时满足机器标识校验（`createOwnerId` 等）和配置校验（`safeReference`，`strict-configuration.ts` 约 95–101 行），邮箱里的 `@` 不在允许字符里，所以用 `owner:<slug>`、`agent:<slug>`、`deployment:<slug>` 这类格式；`<slug>` 只含小写字母、数字、连字符，用于路径和日志。执行进程的实例编号要和部署编号一致（`service-main.ts:418` 附近的精确匹配），块 2 起执行进程时按这个规则生成。创建一个人时，生成的整套值要原样交给真正的配置解析器（`parseProductConfiguration`）和标识校验函数、再打开库试一次，不能只测“生成器”（I-73 的教训）。
- **文件认主人**：库里已有部署权限记录（F2 的 `inspectDeploymentAuthorityReadOnly`），启动时它必须和合成出的 `ownerId`、`agentId` 一致，否则拒绝打开（现有检查，不用新写）。
- **Andy 的那一份**：`stateRoot` 仍是现有的 `/var/lib/himawari/state`，其余字段取现有配置，所以对 Andy 来说合成出的配置和今天逐字段相同（[第八节](#andy)）。

<a id="lifecycle"></a>
## 六、后台任务和生命周期

- 每个活跃的人在服务启动时按顺序起来，**错开启动**（同时起 20 个会撞上 I-28 那种启动超时），失败的人进入“维护中”，前门对这个人返回维护页，其余人照常。
- 后台任务（主动查邮件、整理记忆、推送）都是每人那份里的循环，只读写本人的库；定时错开由并发闸门的“后台队列”统一排，前台对话优先，给 Andy 留保底名额（具体数字由块 0 的测量和块 4 的公平策略定，本块只留接口：闸门接收 `acquire(tenantId, priority)`）。
- **增删一个人不停服**：管理命令是另一个进程，它只写名册并把名册里的 `revision` 加一；多人外壳每几秒读一次这个数字（读一个整数，几乎不花资源），变了就对比名册和正在运行的人：新增“活跃” → `startTenantRuntime`；停用 → `stop()` 并断开连接。不引入新的进程间通道。
- 关机顺序：先停前门（不再收新请求），再并行停每个人（每人沿用现有 `lifecycle.shutdown()` 的顺序），最后关名册。
- 每人的健康状态单独上报；前门的健康检查只看前门自己加名册，不被单个人的故障拖红。

<a id="cost"></a>
## 七、模型路由和每人每月上限

**路由**：所有人的模型配置都从同一份基础配置合成，模型目录只来自 Magpie 的分组（ADR 0117），不含任何按量付费的服务方；有一条配置检查：合成出的每个人的模型目录里出现不在允许列表里的服务方就拒绝启动。这个允许列表也是配置项，不是代码里写死的名字。

**上限闸门（共用层）**：

- **位置：模型调用的统一出口，不是 `modelAdmission`（修改，来自模型审核并已核实）**：`modelAdmission`（F12）只管前台对话；后台主动查邮件的判断调用用 `UNMETERED_PERMIT` 直接放行（`apps/agent-service/src/production-model-composition.ts:47`、`:516`），不走它。如果把闸门放在 `modelAdmission`，后台调用既不被拦也不被计数，别人的套餐用量会漏记。所以闸门包在“模型端口”这一层（`createDefaultModelComposition` 返回的主模型和各个辅助模型，包括会话标题、记忆整理、邮件判断），所有用途都经过它。反向用例：枚举 `MODEL_USAGE_PURPOSES` 里的每个用途，每个都必须被计数；新增一个绕过闸门的用途，检查必须失败。拒绝时返回稳定错误码 `TENANT_QUOTA_EXCEEDED`，网页显示“本月已用多少 / 上限多少”，后台任务遇到它时跳过并记一条日志，不重试。实现时仍要确认前台对话收到这个错误码会显示成可理解的提示，而不是笼统的“模型失败”（未核实）。
- **第二层：每人一把 Magpie 网关密钥（可选，来自 DeepSeek 方案，未核实）**：Magpie 官方文档说每把网关密钥可单独设 token 或估算费用上限、按日/周/月、运行中可改，超限返回 429（https://github.com/yetone/magpie/blob/main/docs/reference.md ）。好处是模型出口处有第二道、并能按人归属用量；限制是“本机不带密钥的请求不受限”“未知价格的调用不计费用”，所以它只能当第二道，主上限仍在程序里（ADR 0234 第 8 条）。生产装的 Magpie 版本是否支持该功能未核实（ADR 0117 记的是 v0.1.2001），要先在测试机上核对，不支持就不做这一层。
- 计数：给每人的 `ModelUsageStorePort`（F13）加一层装饰，在写入每人库的同时，把调用次数、token 数和折算金额累加进名册的 `usage_monthly`（一次写，同一个事务里不写别处）。每人库里的明细仍是账本，名册里是执行上限用的计数；开机和每天各对一次账，不一致时告警并以每人库的明细为准。
- 折算金额：用模型目录里已有的单价（`modelCatalog` 里的 `price`）折算，套餐内调用没有真实账单，所以“次数、token、折算金额”三种口径都记，Andy 配上限时选一种。
- **软上限**：和 Vercel 的预算一样（整合方案 W11），超限那一次已发出的调用会完成。进程内只有一个闸门，“检查并占位”在同一个同步步骤里完成（进程内存里记每人在途调用数），所以并发调用最多超出在途那几次，不会像“先读后写”那样漏计。这一点要写进界面文案，不写成“精确上限”。
- 其他人总上限（保护 Andy 自己的套餐额度）：同一个闸门按 `others_total` 汇总所有 `member`、`trial` 的当月用量。
- **Andy 管理**：命令行 `tenant limit set <tenant|others_total|default_new> <口径> <数值或 none>`，写 `limits` 和 `audit`，下次调用立刻生效，不重启。管理页（Andy 专用，由前门提供）和用量展示是块 4 的界面部分，本块只留 `GET /admin/tenants`、`PUT /admin/limits` 两个接口给它，并保证管理页**只返回数字，不返回任何人的内容**。
- 这改变了 ADR 0076 的一部分，需要新 ADR 说明；ADR 号找协调者要。

<a id="andy"></a>
## 八、Andy 自己的数据怎么搬

- **第一版（推荐）**：名册里加一行 `kind = owner`、去向为“外部”（Andy 现有单人进程的本机端口）；前门按 Andy 的 `sub` 把请求转给它。他的进程、配置、数据库、密钥、状态目录、模型路由**一个字节都不动**，不重启。需要的唯一改动是：Cloudflare Tunnel 的入口从 Andy 的端口改指向前门端口（或前门占用现在的端口、Andy 的进程换端口），这是上线时的一次配置改动，要 Andy 同意。
- **以后（可选）**：把 Andy 搬进进程内，改名册里的去向并重启；这时才需要下面的“配置合成逐字段等于现有配置”和“请求开头逐字节不变”两项检查，先做成可运行的检查，但不在第一版里使用。
- 单人外壳继续存在并长期被 Andy 使用，所以 PR A 之后单人路径必须一直被测试覆盖。
- 发给模型的请求开头（系统提示、工具定义、历史）由每人那份里原有的代码生成，输入（模型、服务方、密钥、提示词目录）不变，所以不变。自动检查 9 证明它（[第十节](#gates)）。
- 配置合成必须对 Andy 逐字段等于今天的配置：做一个“合成配置 == 现有生产配置”的比较测试，用生产配置的脱敏副本（**需要协调者给一份不含密钥的现有配置**，或我从仓库里的样例推；**未核实**）。
- 回滚：因为 Andy 的目录没动，把外壳换回单人外壳加原来的配置文件即可。

<a id="prs"></a>
## 九、分几个 PR、每步怎么证明没改坏

每个 PR 单独合并，每个都跑完整现有测试，单人路径行为不变。

| PR | 内容 | 证明方式 | 改表 |
|---|---|---|---|
| A | 把 `runAgentService` 拆成 `startTenantRuntime` 加单人外壳；授权丢失变成句柄事件；监听增加套接字选项；不加任何多人功能 | 现有全部测试不改一行就通过；`check:prompt-prefix` 通过；端到端 `[PR-A]`、`[PR-B]` 通过 | 无 |
| B | 名册（独立文件和迁移）、合成配置、`TenantRegistry`；Andy 作为 `owner` 记录 | 合成配置对 Andy 等于现有配置；名册迁移测试 | 无（名册是新文件，不占 product 迁移号） |
| C | 前门：验令牌、按 `sub` 路由、套接字转发、前门签名头；多人外壳 | 两个人并排的集成测试（检查 1）；SSE 转发测试；前门选错人被每人那份拒绝的反向用例 | 无 |
| D | 创建一个人（生成标识、目录、密钥、库，整套值过真实校验）、邀请和第一次登录绑定、`email` 到 `sub` 重绑、停用立即拒绝、前门拒绝 `/bootstrap` 和 `/break-glass` | 检查 5 和第十节新增的检查 10、11 | 无 |
| E | 共用层接管：Gmail 授权登记处、并发闸门接口、向量客户端注入（向量部分等 P3-1） | 检查 4 | 无 |
| F | 每月上限闸门、用量计数、管理命令、`/admin` 接口 | 检查 6（和块 4 的界面分开交付） | 无 |

**和进行中的改动的冲突**：`service-main.ts` 被很多 PR 同时改（P3-1、P5-3、P4-8 等）。PR A 是纯搬运，建议**先合 A、再让别的线程基于 A 的形状改**；协调者需要通知各线程：合 A 之后 `service-main.ts` 里的组装逻辑搬到了新文件，别在旧位置继续加东西。

<a id="gates"></a>
## 十、自动检查

沿用整合方案第六节的 1 到 4、6、9、10；本块新增和细化如下。每条都有反向用例，保证检查不是空的。

1. **两个人并排**：用真实前门和两个真实的每人一份、真实 SQLite。A 的令牌访问 A 的每个接口成功；A 的令牌带上 B 的各种编号（对话号、记忆号、设备号）访问，全部被拒或查不到。反向：把“按 `sub` 找人”改成永远返回同一个人，检查必须失败。
2. **前门选错人也不泄露**：测试里故意把 A 的请求转发到 B 的套接字，B 必须拒绝（`OWNER_NOT_BOUND` 或前门签名头不符）。
3. **结构**：每人一份的包不得引用 `TenantRegistry`、名册对象；静态检查加一个运行时测试（在每人一份的代码里尝试取“所有人的列表”必须拿不到）。
4. **授权丢失只影响一个人**：让 A 的授权租约丢失，A 变“维护中”，B 的请求照常成功。
5. **邀请绑定**：受邀邮箱第一次登录绑定成功；没被邀请的邮箱得到明确的拒绝页；`sub` 变了但邮箱一致能重绑；邮箱令牌被伪造（签名错）得不到任何绑定。
6. **上限**：A 用完额度后下一次调用被拒并显示用量，B 不受影响；Andy 改上限后不重启即生效；其他人总上限生效；并发调用不会让多个人互相漏计；**代码和配置样例里出现写死的额度数字，检查必须失败**（扫描 `packages` 和 `apps` 下与闸门相关的文件里的数字字面量，白名单在检查脚本里，不在代码里）。
7. **配置合成对 Andy 逐字段不变**，以及对 Andy 的**请求开头逐字节不变**（用现有 `prompt-prefix.compat.test.ts` 的方法对合成配置各跑一遍）。
8. **目录权限**：每个人的状态目录权限 0700、属于主程序账号；两个人的 `payload-encryption` 密钥不同；用 A 的密钥解不开 B 的密文。
10. **前门不放行本机专用路径**：公网请求打 `/bootstrap`、`/break-glass` 被拒；反向：临时放行，测试必须失败。
11. **创建一个人的值全链路**：生成的标识、路径、密钥引用交给真实的配置解析器、标识校验函数、状态目录初始化和库迁移，全部通过；反向：标识里带 `@`、状态目录嵌套在别人目录里、重复邮箱、重复 `sub`，必须在写任何文件之前失败。
12. **每个模型用途都被闸门计数**（见第七节）。
13. **事故门槛**：本块没有新事故；PR A 是搬运，风险是“漏搬一个监听或一个停止步骤”，所以检查 1 里加“启动—停止—再启动”资源清理用例（端口、套接字文件、定时器都释放）。

<a id="risks"></a>
## 十一、风险和未核实

1. **PR A 体量大、冲突多**：靠“只搬运、测试不改”降低风险；不能一次做完的话，按“网页服务那一段”“运行调度那一段”分两步搬，每步都能合并。
2. **进程内 20 份的内存**：未测量；超了就改子进程（[2.4](#extract)）。
3. **一个人的失控请求拖垮整个进程**：整合方案已列为接受的风险；本块给请求体积加上限，并让每人的失败只关闭他自己的部分。
4. **前门成为单点**：它很薄，不含业务逻辑；崩溃时整个进程重启，和现在一样。
5. **SSE 转发和重连**：未核实，PR C 第一步先用真实事件流测。
6. **名册和每人库的一致性**：名册说“活跃”但库打不开 → 维护中；库在但名册没有 → 不起（避免孤儿）。
7. **要 Andy 决定的事**：没有新的；上限和路由已按他 11-11 的话定。需要他知道的一点：第一版他的聊天仍在原来的进程里，不和客人共用故障范围。
8. **全机并发**：现在 `concurrency.totalRuns` 是每份配置一个值，进程内多个人时总和会变大（两个模型都指出）；本块把并发闸门做成必须有的接口，具体数字等多人并发实测（测试机）再定，由 Andy 配置，不写死。
