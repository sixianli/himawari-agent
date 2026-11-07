# 复核报告（PR 281：复核经本机 Magpie）

## 侧重检查（先看的部分）

我把「最普通的使用流程」定为 `--mode code-review`（可带/不带 `--gateway magpie`），从 `main()` 走到结束：

`parseArgs` → `buildPrompt` → 代理/预算检查 → `readUsage`/`roundForRun` → `opencodeBinary` →（gateway 时）`installGateway`+`binaryProblem` → `prepareCopy` → `installGitGuard` → `selfCheck`（gateway 时含 probeGateway、passthroughProbe、failoverProbe、guardProbe）→ 不加开关时 `reviewConfig({mode})` / 加开关时 `configPath = reviewConfig({mode, gateway: routed})` → `startLiveGateway` → 逐模型 `runOne`（含失败再重试、wrapUp、替代模型）→ 写账本 → 打印 `REVIEW_SPENT_TOTAL` → `finally cleanup`（`stopGateway` + 杀子进程 + 删临时目录）。

结论：
- **读到即证实的**：不加 `--gateway` 时，这条流程和改动前逐行相同（`reviewConfig` 的 gateway 分支只在传入 gateway 时才改变输出，opencode-review.mjs:174-176；主流程其余改动都以 `gateway` 为开关条件）。
- **读到即证实的覆盖缺口**：`--self-check-only` 在 opencode-review.mjs:2639 处 `if (options.selfCheckOnly) return;`，早于 `startLiveGateway`（opencode-review.mjs:2637-2650）。所以测试 `test/tooling/review-gateway.test.mjs` 里唯一的真 OpenCode 端到端用例（用 `--self-check-only --gateway magpie`，review-gateway.test.mjs:435-464）**只在正式跑之前停止**。正式跑才涉及的路径全部没有自动测试：`startLiveGateway`（查 uid、登录失败回退、`magpie quota` 失败回退、积分底线决策、`GATEWAY_PREFLIGHT_FAILED`）、`runOne` 里 `gatewayRecordFields` 的非 null 分支、`gatewayDropped` 字段、`gatewayUsageLine` 打印、结束后 `binaryProblem` 设退出码 4、以及中断信号下 live 网关的清理。作者的端到端证据是手工冒烟（`.agents/reviews/topic-gateway-smoke-test/`，该目录我对 `git show` 被 `REVIEW_GIT_REFUSED` 拦住，**未核实**）。
- 单元-checked 的部分确实有覆盖且有反向用例：配置不变、账本新字段严格校验（含 3 条会抛 `USAGE_LEDGER_INVALID` 的反向）、积分底线、安装完整性、透传改写/遮盖/删工具会报错、`GATEWAY_NOT_LOOPBACK`。作者称「保护去掉后对应用例失败」属可信的结构推断（改掉代码则对应 expect 必然失败），但**未实测**。

## 发现（按严重度）

**中 | scripts/model-review/opencode-review.mjs:2637-2650 与 test/tooling/review-gateway.test.mjs:435-464**
「经 Magpie 真跑」的整条主流程没有任何自动测试，所有保护（积分底线、preflight、usage 记账、失败回退）只在自检段之前被执行或根本没有测试。
证据：`--self-check-only` 路径在 main 里 `if (options.selfCheckOnly) return;`（:2639）先于 `startLiveGateway`（:2638-2650）；单测里 `gatewayRecordFields` 只测了 `null` 入参（review-gateway.test.mjs:221-225）。
（读代码证实；建议：补一两个不起真 OpenCode、把 gateway 依赖注入的假 binary/假 `usage.jsonl` 的集成用例，至少覆盖底线回退、preflight 失败、用量写账三条。）

**中 | scripts/model-review/opencode-review.mjs:2652-2659、scripts/model-review/gateway.mjs:517-532**
启动窗口内的 SIGINT/SIGTERM 会留下孤儿 magpie 进程。
证据：`stopGateway` 初始为空操作（:2654 `let stopGateway = () => {}`），赋值 `stopGateway = () => liveGateway.live.stop()` 在 `await startLiveGateway(...)` **之后**（:2650-2652）；而 magpie serve 是 `detached: true` 的独立进程组（gateway.mjs:518-522），不在 `activeChildren` 里；`magpie quota`/curl 等 `spawnSync` 还会长时间阻塞事件循环。窗口期收到信号时 cleanup 杀不到它，`process.exit` 后 magpie 残留监听回环端口（容器内，影响有限）。推测但机制明确；建议：spawn serve 前就注册一个 kill 句柄（或把 child 加入 activeChildren 同类清单）。

**低 | .agents/instructions/model-review.md（旧「密钥」段）**
旧句子「只有自检连本机假服务器时才写假密钥」与新功能矛盾。证据：原文未改（diff 上下文第 71 行段），而 gateway 模式下正式复核的配置写 `apiKey: CLIENT_KEY`（opencode-review.mjs:141）。`docs/incidents-and-gates.md` 里的 I-76 行已更新说明「经 Magpie 时占位密钥只允许和回环地址一起出现」，说明文档这行漏了同步。建议在该句补「（经 Magpie 时见下一节）」。

**低 | scripts/model-review/opencode-review.mjs:137-141、2304-2311（asDirect）**
透传探针只验证 `REVIEW_MODELS[0]`（deepseek），GLM 的请求头没有任何透传核对；`asDirect` 的两次替换是**同一个模型**的两种写法（`magpie/group/review-x` 与 `group/review-x`），作者说法 7「把 OpenCode 写进系统提示的**两个模型名**换回直连写法」与代码不符（若指两个模型，则只见一个）。既然真自检经透传探针通过（作者称；未核实），意味着 OpenCode 系统提示只含当前模型名——但这只是单点验证。建议对两个模型各跑一次或说明只验其一的理由。

**低 | 作者说法「review-gateway.test.mjs 19 条通过」**
实数 18 个 `it`（逐个数过：配置 8、账本 2、底线 3、透传 2、安装 2、自检 1）。与说法差 1，可能把手滑写成 19 或另有隐藏用例——未核实。

**低 | scripts/model-review/gateway.mjs:310-336（summarizeGatewayUsage）**
美元折算不计 `cache_write`（Magpie 行若有该字段则被漏掉），方向偏低；但它只用于账本 `providers` 明细和打印，不入预算（账本 `cost` 来自 OpenCode 事件统计，opencode-review.mjs:366-377）。同文件 :338-351：usage 文件存在但格式漂移（行不能解析）时整体返回 `null` → `costUnknown`，安全；存在但缺 group 行时则静默 `providers: {}` 且**不标** `costUnknown`（opencode-review.mjs:2456-2458）——预算不受影响（仍按 OpenCode 成本记账），只是明细丢失无告警。建议对后一种情况也打日志。

**低 | scripts/model-review/gateway.mjs:268-278（creditsLeft）**
对 Magpie 返回格式的假设：`remaining` 是百分比（`limit * remaining / 100`）、窗口名「Total credits」或唯一同名 Windows。格式变化时安全降级为 `null` → CodeBuddy 被整个丢掉（保守，不会在无上限下运行）。但如果将来格式语义变了（如 remaining 已是绝对值），会**错误保留 CodeBuddy**（left 算错方向不可控）。锁版本 + 预检能部分兜住。未核实（无法看到 Magpie 真实响应）。

**低 | scripts/model-review/gateway.mjs:280-290（creditsPerUsd）**
`record.gateway === "magpie"` 硬编码，没用 `GATEWAYS`；目前唯一网关是对的，以后加网关会错。小事，顺手改。

## 必答问题

1. **不改模型已见过的开头？** 不加 `--gateway`：是。`reviewConfig({mode, gateway: undefined})` 与改动前逐字节相同（测试锁住，review-gateway.test.mjs:68-73 会逐键比较），主流程其它改动全在 gateway 分支内；模型的提示词组装（`buildPrompt`/`MODEL_LENSES`）未动，每轮会变的值仍在最后一条用户消息。加 `--gateway`：这是「新会话开头」的一次性变化（provider/model 名成 `magpie/group/review-*`），不是对已发内容的改写；运行中变化只有两处——ADR 0178 记录的 CodeBuddy 11128 受控例外（插件改写系统提示）和 failover 换服务方（prompt-prefix 规则第 9 条允许）。结论：符合「只追加」，例外也只有 ADR 写明的那一个。
2. **同段文字不同字节？** 发给模型的路径上没有新增依赖前后文的遮盖、时间字段或无序集合；新增的可变值（`providers`、`gatewayDropped`、`costUnknown`、时间戳）全部只进账本行（每条是追加）。一个瑕疵：`providers` 的键插入顺序取决于 Magpie 日志行的到达顺序（`summarizeGatewayUsage` 不排序），将来若有任何东西逐字节比对账本行会踩规则第 10 条——但目前账本只用于预算核算和展示，无消费者比字节。暂不违反。
3. **自动检查与反向用例？** 有：配置不变、账本校验、底线、安装完整性、透传/故障转移、自检端到端共 18 条；反向用例（遮盖篡改、删 tools、错误网关名、SHA 不符、缓存码互换等）从断言看真能失败——读代码证实其结构性成立，实际运行未核实。**缺口**：正式跑（self-check 之后）的整条路径没有自动检查，见第一、二条发现。
4. **每个新值的产生端与消费端？** 逐个核过：`--gateway` 参数（parseArgs↔main）✓；`gateway: "magpie"`（写账 :2705、`parseUsage` 校验 :1458-1461、`creditsPerUsd` 过滤 :282——第三处硬编码未用 `GATEWAYS`，一致但目前OK）✓；`providers`/`costUnknown`（写 :2704-2706、读 `spentOf` :937-946 保守、`parseUsage` :1399-1412 结构校验，负 credits 会拒）✓；`gatewayDropped` 仅展示，无消费方要求 ✓；`group/review-<短名>` 与 `gateway.json` 的 members、`groupArgs`、`launchModel`、`gatewayProvider`、`summarizeGatewayUsage` 六处使用 `groupName/groupId` 一致 ✓；`MODEL` 全名 `REVIEW_MODELS` 未改，账本身份不变 ✓；Magpie CLI 实际能否接受 `group add models=... routing=... stays=...`、`provider add/set`、`quota --json`、把用量写到 `<XDG_CONFIG>/magpie/usage.jsonl` 且行带 `req/provider/status/credits/in/out/reasoning/cache_read`——**未核实**（无网、不能跑），这些由作者的真实验收兜底，并已通过「preflight 成员全在清单、失败即停」和 usage 读不出来时的保守记账做了失败教训兜底。

**未核实清单**：Magpie 命令行与 usage.jsonl 的真实行为与 schema；`@magpie-community/opencode-workbuddy-auth` 插件 11128 改写行为；两份冒烟记录的实际内容（`.agents/reviews` 被 git 替身拦截，`git show` 返回 `REVIEW_GIT_REFUSED`）；`npm run check` 的 41 步；「保护去掉后失败」的实测声明。
