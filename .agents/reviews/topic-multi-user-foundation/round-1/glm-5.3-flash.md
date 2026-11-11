代码读得差不多了，现在查业界一手资料来支撑“每人一个 SQLite 库 + 按身份路由”的设计。
# 方案：单进程多主人（每主人一个「格间」cell + 一个注册表库）

## 一、方案依赖的前提

### 读代码或来源证实的

**代码事实（文件：行）**

- P1 整个服务由 `runAgentService` 按一份配置组装、只为一个主人：读配置（`apps/agent-service/src/service-main.ts:682`）、开一个 `product.sqlite`（739–752）、领 authority（757–779）。全代码按 `configuration.ownerId` 单值展开（约 290 处引用，材料给的数，我抽验了 `production-file-read-services.ts:57`、`production-runtime-tools.ts:899` 等多处，一致）。
- P2 authority 与主人绑定在每个 state root 一份：启动时校验 `authorityFile.id/ownerId/agentId` 与配置一致（`service-main.ts:717–726`），还要和 `product.sqlite` 里的持久化 authority 一致（727–738）；`authority.json` 的字段校验在 `packages/platform-node/src/state-root-layout.ts:522–548`。
- P3 登录绑定「第一个主人」：`identity-gateway.ts:603–605`（`readBySubject` 无 active 绑定即 `OWNER_NOT_BOUND`），底层 `bindFirstOwner` 检查 `SELECT COUNT(*) FROM owner_identity_bindings`（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:4756–4764`）。
- P4 请求开头按对话冻结，冻结记录存在产品库 `thread_prompt_bundles`（迁移 `0077_thread_prompt_bundles.sql`，`packages/persistence-sqlite/src/migration-engine.ts:614–617`）；适配器每次请求先 `promptBundles.resolve`，取不到才用当前候选（`packages/runtime-pi/src/pi-runtime-adapter.ts:1363–1388`）。系统提示由固定目录文字 + 配置里的 `runPolicy.systemInstruction` 拼成，不含 ownerId（`apps/agent-service/src/production-run-policy.ts:102–116`）。
- P5 每轮会变的值在最后一条用户消息：`"最后一条用户消息承载本轮的新请求，其中 <owner-message> 里是主人本轮说的话，<himawari-context> 里是系统附上的时间和资料"`（`packages/prompt-catalog/src/chat.ts:277`；ADR 0164、0165）。
- P6 出口遮盖的密钥从配置的 `payload-encryption` secret 派生：`createHmac("sha256", material).update(PLACEHOLDER_KEY_LABEL)`（`apps/agent-service/src/production-model-egress.ts:69–84`）。
- P7 每个数据库是独立 worker 线程：1 个写 lane + 只读 lane，各起一个 `Worker`（`packages/persistence-sqlite/src/sqlite-execution-context.ts:104–119`）。
- P8 进程内共享状态实例化在 `ProductionProactive` 里：`readonly #states = new Map<string, {owner, expiresAt}>()`（`apps/agent-service/src/production-proactive.ts:170`）。
- P9 费用上限已被删，但预算账本保留作用量统计与对账：「保留预算账本作为用量统计和恢复门禁」（`docs/adr/0076-no-model-cost-budget-limits.md` 决定 1、3）；每次调用记 token 走 `ModelUsageStorePort.record`（`packages/application/src/ports/model-usage.ts:35–42`）。
- P10 已有门槛：`npm run check:prompt-prefix`「逐字节比，其他字段按值比……带反向用例：改写历史里的用户消息、让系统提示带上每轮变化的值、关掉冻结、请求中间出现 system 消息，检查都必须报告失败」（`.claude/rules/prompt-prefix.md:74`）；完整 check 清单在 `package.json:27`，含 `check:egress-redaction`、`check:model-ref-contract`、`check:prompt-catalog`（内含 `prompt-rendering-golden.unit.test.ts` 金样测试，`package.json:57`）。
- P11 state root 目录必须属于服务账号 uid：「State-root directory is not owned by the service account」（`state-root-layout.ts:113–119`）。
- P12 网页层已有按主人收口的原语：`scopedIdentityState` 对每个绑定调用断言 ownerId（`apps/agent-service/src/production-http-composition.ts:347–375`），`ProductionThreadGatewayAccessPolicy` 按 ownerId+agentId 构造（398–408）。
- P13 执行进程经 UDS 连入，套接字名默认 `execution.sock`（`packages/platform-node/src/execution-uds-transport.ts:152`），启动绑定文件带 `ownerId` 字段（`state-root-layout.ts:68、85`）。

**业界事实（网址）**

- B1 Discourse multisite 就是「一个程序 + 每站一个库 + 共享进程」：官方论坛原话「Each multisite has its own database. There is no cross-posting allowed. The shared part is the ruby processes / memory.」（https://meta.discourse.org/t/i-have-some-questions-about-multisite/33651 ；配置样例 https://github.com/discourse/discourse/blob/master/config/multisite.yml.production-sample ）。
- B2 Cloudflare Durable Objects 把「每实体一份隔离存储」列为标准多租户形态：「Per-entity storage — Each user, tenant, or resource needs its own isolated database」「A Durable Object's attached storage is private to its unique instance and cannot be accessed by other objects」（https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ 、https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/ ）。
- B3 代理层按身份记账、上限存库并可随时改：LiteLLM 的 `max_budget` + `budget_duration`（30d 即每月重置）按 key/team 强制，「Costs Per key get auto-populated … After the key crosses it's max_budget, requests fail」，且明确「Budgets require a database——花费从数据库读出才强制」（https://docs.litellm.ai/docs/proxy/team_budgets 、https://docs.litellm.ai/docs/proxy/users ）。
- B4 SQLite WAL 模式单写多读、读写互不阻塞（https://www.sqlite.org/wal.html ，"readers do not block writers and a writer does not block readers"），支撑「每库独立读写 lane」继续成立。

### 推测（未核实）

- T1 20 人 × 每库 4 个线程 ≈ 80+ 线程在 4 CPU/8GB 上的实际内存占用——仓库里没有测量数据（材料也说测量是并行的事）。
- T2 Magpie 动态模型清单（`expandConfigurationWithMagpieModels`，`service-main.ts:684`）返回顺序是否稳定：它只影响新对话建冻结记录那一刻的候选，冻结后不再变，但我没有逐行核对清单展开的全部路径。
- T3 Node 单进程内无法用 OS 手段给单个主人限内存（worker_threads 也没有内存上限）——基于 Node 运行时的一般知识，未在本仓库核实。

## 二、方案本身

### 1. 分界：哪些共用、哪些每人一份

**必须共用（进程级单例）**
- 入口：Fastify 服务、静态文件、Cloudflare Access JWT 验证器（一个 Access 应用即可，audience 单值，同 `configuration.identity`）；验证后按绑定查出 ownerId，把请求交给对应格间。这就是 Discourse multisite 的形态（B1）。
- 注册表库（新）：部署级 authority（沿用现在 `authority.json` + 单行语义，deploymentId 全机一个）、`owners` 表（ownerId、agentId、状态、创建时间）、`owner_identity_bindings`（CF sub → ownerId，取代 P3 的「第一个主人」语义）、`owner_quotas` 表（每月上限微美元、重置日、修订号、更新人）。上限只存这里，运行中由 Andy 改（B3；约束第 3 点）。
- 模型通路：Magpie 客户端与模型清单（都用 Andy 的套餐，provider secret 共用）；向量模型已在独立共用进程（另一 PR）。
- 全局并发闸：现在 `concurrency.totalRuns` 是配置级单值（`strict-configuration.ts:1557–1564`），多主人后要有进程级总闸 + 每人格间小闸，防止一人吃满 4 CPU。
- 后台调度器：一个进程级调度器按 owner 遍历触发各格间的主动查邮件、整理记忆、推送（现在这些是每配置一份的定时器），每个格间的任务独立 try/catch + 指数退避。

**每人一份（cell，一个纯对象组合体）**
- `stateRoot/owners/<ownerId>/`：`data/product.sqlite`、`payload-ciphertext/`、`cache/`、`runtime/execution.sock`（P13 的接口位）。每个目录过 P11 的 uid/权限检查（检查函数复用，参数化路径即可）。
- 该库里的所有 store（P12 说明产品表本就带 owner_id/agent_id，scope 传参即可）、启动恢复、运行调度小闸、记忆组合（嵌入走共用客户端）、Gmail 待处理状态（P8 的 Map 从进程级变成 cell 级）、proactive/web-push/muse、`thread_prompt_bundles`、protector + 出口遮盖（每人一把 `payload-encryption` 密钥，Andy 的密钥原样保留，见必答 1）。
- 执行接口：boot binding 与套接字按 owner 路径发布（`owners/<id>/runtime/execution.sock` + 各自 boot binding 文件，字段不变，P13），并行块按 ownerId 起独立系统账号沙箱。

**运行中增删主人**：注册表库挂在本进程，用 SQLite `update_hook`/短轮询感知变化；新增主人 = 建目录 + 惰性开 cell（失败只把该主人标 `provisioning_failed`，不影响他人，B2 的「每实体隔离」）；停用 = 拒新请求 → drain → 关库。

### 2. 拆成几步（每步可单独合并、单独过测试）

1. **纯重构**：把 `runAgentService`（P1）拆成 `buildSharedComposition(config)` + `buildOwnerCell(config)` 两层，单主人行为不变。验收：`npm run check` 全绿（含 `check:prompt-prefix`），无新值产生。
2. **注册表库 + 搬家工具**：建 registry schema、`admin-cli` 增加迁移子命令（现有 `initialize-command.ts` 扩展）：把 Andy 的 `product.sqlite`、密钥、authority 原样移入 `owners/<现 ownerId>/`，registry 里登记他，绑定记录搬入 registry。兼容：单主人配置仍可按旧布局启动。验收：迁移 dry-run 集成测试 + 迁移后跑 `check:prompt-prefix` 的多轮场景（ Andy 对话冻结记录随库文件整体搬走，P4）。
3. **多 cell 运行时**：registry 监听、惰性 cell、每 cell 生命周期与故障隔离、全局并发闸、后台调度器改造。
4. **身份多绑定**：`bindFirstOwner` 改为「每 owner 一条 active 绑定」（P3 的 COUNT 检查改为按 owner_id），`scopedIdentityState`（P12）改为查 registry；MCP 入口沿用 ADR 0227 的「主体必须绑定到本实例 active 主人」，从单值变成按 sub 查。
5. **费用封顶**：`owner_quotas` + cell 内模型准入（复用 P9 账本做月内累计 + 预留/结算）+ 页面展示（本人看自己的，Andy 看全员汇总）；拒绝码如 `OWNER_QUOTA_EXCEEDED`，页面显示「本月额度已用完」（B3、BL-20261026-003 的现成文案先例）。代码里不出现任何数字，上限只能来自 registry。
6. **执行接口**：per-owner socket + boot binding 发布，与并行块联调（本步只留接口）。

### 3. 每步怎么证明没改坏单人、怎么验证「A 读不到 B」

- 单人不坏：第 2 步后，用 Andy 迁移夹具跑既有全部门槛，特别是 `check:prompt-prefix`（P10，反向用例本来就会失败）和 `prompt-rendering-golden`；第 3 步加一条「单 cell（只注册 Andy 一人）」时整套集成测试照跑。
- A 读不到 B：新增 `check:tenant-isolation` 集成门槛——一个进程两个 cell + 假模型服务器：① 用 A 的会话令牌请求 B 的 threadId → 404 且 B 库零读；② A 的 run 触发模型调用时断言请求只含 A 库里的记忆/历史；③ B 停用后 B 的入口全 401；④ 一格间迁移失败/库损坏，另一格间仍能完成一次 run；⑤ ③④ 的反向用例：把 `scopedIdentityState` 的 ownerId 断言删掉或让一格间失败连带关进程，用例必须失败（对齐 I-92/I-73「撤掉修复→用例失败」的门槛写法）。
- 隔离的金标准是「A 的代码路径上根本拿不到 B 的连接」：registry 按 ownerId 分发 cell，cell 内所有 store 由构造函数注入该 owner 的 repository 实例，不传 ownerId 参数就不会碰到别人的库（B2 的 per-entity private storage 语义）。

## 三、考虑过但不选的做法

- **每主人一个进程/容器（silo，ADR 0083 旧方向）**：方向已被 Andy 定为单程序（材料目标 1）；且 8GB 放不下 20 份进程+各自 SQLite 缓存。留作 escape hatch：cell 接口本身就是为将来拆进程准备的。
- **共用一个库、只靠 owner_id 过滤（纯 pool）**：一行漏掉 WHERE 就是跨人泄露，且一个库损坏全员遭殃；与已定方向相反（B2 的对比论证）。
- **前置代理（nginx/Envoy）按 JWT sub 路由到每主人端口**：需要一个新常驻组件、每主人一个端口和隧道配置，而验证 JWT 的代码进程内现成（P12）；进程内分发更简单可测。
- **用 Vercel AI Gateway 每人一把 key 做预算**：要求按量付费 key，与「所有人走 Andy 的 OpenCode Go」冲突；且 BL-20261026-003 那套按 key 设预算的做法随之作废。
- **把每月上限写进配置文件靠重启生效**：不满足「运行中随时配置」；上限放 registry（有修订号，可审计，类似规则手册 ADR 0209 的做法）。

## 四、风险与反例

- **内存（T1，推测）**：80 个 worker 线程 + 每连接页缓存可能超预算。缓解：每主人读 lane 数可配、cell 惰性开关 + 空闲 LRU 关闭；等并行测量出数再定参。反例：20 人同时前台 run，全局闸必须先于每 cell 闸生效，否则进程 OOM 全员死——单进程内这是硬限制（T3），需要接受「一格间失忆式重启」或将来拆进程。
- **密钥与请求开头**：若迁移时误换了 Andy 的 `payload-encryption` 密钥，遮盖占位字节全变，所有老对话请求开头失效（P6、ADR 0165 明示密钥轮换的后果）。迁移工具必须只复制、不重生成该密钥，并加「迁移前后密钥材料指纹一致」的校验。
- **配额竞态**：同月并发多笔模型调用各自预留，若只查累计值会超支；必须复用 P9 账本的原子预留/结算（事务内 `spend+estimate <= cap` 判定），不能读后写。
- **registry 成为单点**：registry 库坏 = 全员登录/配额不可用（数据不丢，各人库独立）。风险远小于共用产品库，但要在 health 里单独暴露。
- **新主人会话的开头差异**：每主人的 `runPolicy.systemInstruction`、密钥、工具集合可以不同——这是设计允许的（各自独立冻结，P4），不违反只追加；但要防止实现时把「全 registry 的值」（如主人总数、他人信息）拼进任何一格间的请求内容——反例即 `check:tenant-isolation` 的 ② 加一条用例。

## 五、需要人拍板的取舍

1. **单进程单点的最终兜底**：接受「进程崩了全员短暤断」还是保留 ADR 0083 式进程隔离给最重要的人（Andy）？我建议先单进程，接口按可拆进程设计，出问题再拆，不预先付 20 份内存。
2. **每月窗口的定义**：自然月（UTC 还是主人时区）、还是滚动 30 天（B3 两种都支持）？影响 `owner_quotas` 的重置字段与页面文案。
3. **超限后的行为**：硬拒（本方案默认，返回明确文案）还是降级到更便宜模型？LiteLLM 两者都有（B3），需要产品决定。
4. **Andy 的管理入口形态**：admin-cli 子命令（现成、loopback、免新认证面）还是网页管理页（要给 Andy 单独的管理员身份）？
5. **`provisioning_failed` 主人的恢复流程**谁能操作、要不要双人确认（涉及别人数据的删/迁）。

## 六、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（在满足下述条件时）。发给模型的内容仍然只在末尾追加：系统提示 = prompt-catalog 固定文字 + 配置里的 `systemInstruction`（P4），不含任何新增的多租户值；工具定义按对话冻结、连同历史存进 `thread_prompt_bundles`，该表在 Andy 的 `product.sqlite` 里，随库文件整体搬迁、字节不动（P4）；每轮会变的值（时间、记忆、运行环境）本就只在最后一条用户消息（P5），本方案不新增任何进请求头的内容。必须钉死的三个条件：① Andy 的 `payload-encryption` 密钥材料原样迁移（P6，遮盖占位字节进请求）；② prompt-catalog 构建不变（`check:prompt-catalog` 金样守着）；③ 工具集合与配置值不变。每轮会变的值是否都在最后一条消息里——是，且本改动不引入新的每轮变化点。门槛：`check:prompt-prefix`（P10，含反向用例）+ 迁移夹具多轮前缀检查。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
本方案不引入会。遮盖是「固定标签 + HMAC(key, 明文)」（P6），同密钥下确定性；每人一把密钥意味着 A、B 的同文遮出不同字节——这不违反规则（各自请求内自洽），但**每主人的密钥一经启用不得轮换**，否则该主人全部对话请求开头失效（ADR 0165 已明示）。需注意的点：时间字段继续只在最后一条消息（P5）；工具/模型清单是有序数组，来源是配置与固定目录（P4、`production-run-policy.ts:82` 的 capabilities 只含固定文字），本方案不改其排序；配额数字、主人列表等新值一律不进请求内容（写进 `check:tenant-isolation` 用例）。未核实：T2（Magpie 清单顺序），它只影响新对话冻结那一刻，冻结后不变，风险被 P4 兜住。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
已有：`check:prompt-prefix` 逐字节、带 4 类反向用例且「检查都必须报告失败」（P10）；`check:egress-redaction`、`check:model-ref-contract`（I-73 的教训门槛，`apps/agent-service/test/model-ref-contract.unit.test.ts:50`）继续守原值。新增（第二节第 3 点）：`check:tenant-isolation`（跨人读取、一格间故障不连坐、配额拦截），其中 ①③④⑤ 都按仓库惯例写「撤掉实现/删掉断言 → 用例失败」的反向验证（先例：I-92 的 `[COMPACT-1]`、I-73 的 model-ref 门槛）；配额用例的反向是删掉准入处的预留检查。全部挂进 `package.json` 的 `check` 序列（P10）才算落门。

**4. 改动产生或修改的每个值，两端都核对过吗？**
逐个列：
- **新 ownerId**（注册时经 `createOwnerId` 生成，与 `strict-configuration.ts:1531` 同一校验）：使用方——authority 一致性检查（`service-main.ts:720–726`，registry 化后这段改读 registry，但校验语义保留）、所有 store 的 scope 传参、boot binding 字段（`state-root-layout.ts:68、85`，执行块按它核对，两端字段名与类型不动）。`bindFirstOwner` 的「第一个主人」COUNT 检查（P3）必须同步改，否则新主人永远绑不上——这就是 I-73 型的「产生端改了、使用端没跟上」点，第 4 步与第 5 步的 `check:tenant-isolation` 反向用例同时守两端。
- **deploymentId**：保持全机一个（registry），每主人库内的持久化 authority 行写同一个值，`production-file-read-services.ts:163–169`、`production-worker-forward-transport.ts:37–44` 等逐字段比对处无需改。
- **registry 新表/新配置键**（`owners`、`ownerQuotas`、每主人路径）：必须进 `strict-configuration` 的解析与 `rejectUnknown`（`strict-configuration.ts:1453–1458` 的模式），否则启动即拒——新键的「产生端（迁移/CLI 写入）」和「使用端（配置解析）」都要过各自校验，对齐 I-73 教训。
- **`OWNER_QUOTA_EXCEEDED` 拒绝码**：产生端在模型准入，使用端有三处——HTTP 错误码表（`AGENT_SERVICE_ERROR_CODES`，`service-main.ts:165`）、proactive 的跳过分支、UI 文案映射，三处都要在 `check:tenant-isolation` 里各有一条用例，否则又会漏（I-73 同型）。
- **每主人密钥引用（`payload-encryption` purpose 不变）**：产生端是迁移动作，使用端是 `createProductionModelEgress` 的「恰好一条引用」断言（P6，`production-model-egress.ts:72–74`）——每主人 config 必须各自恰有一条，`check:secrets` 扫描同步覆盖新目录。
- **per-owner 套接字路径与 boot binding**：字段不变、路径变，使用端是执行块（并行块），按约束「只留接口」：路径拼接函数唯一（`execution-uds-transport.ts:152` 的 `socketName` 参数化），并写进给并行块的接口文档。
- **序列化格式**：registry 用 SQLite 行，无新 JSON 格式暴露到边界；迁移是文件搬移 + 记录改写，`product.sqlite` 内部格式零改动，所有既有读取方无感知。
未核实：admin-cli 各子命令对 registry 库的写入路径是否复用持久化层的校验（第 2 步实施时核对）。
