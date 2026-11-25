---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-07"
---

# ADR 0178：方案讨论和代码复核的模型调用，改经每次运行自起的本机 Magpie

> **2026-11-25 起暂停。** Andy 叫停了全部 OpenCode 复核：方案讨论、方案说法核对和合并前代码复核都不跑，合并只看测试和 CI（见 [AGENTS.md](../../AGENTS.md#working-with-opencode)）。Andy 说恢复之前，本文的决定不适用。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [对“只追加”规则的受控例外](#prompt-prefix-exception)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#links)

<a id="context"></a>

## 背景

方案讨论和合并前的代码复核，用 `scripts/model-review/opencode-review.mjs` 启动 OpenCode（一个能让模型读代码、调用工具的命令行程序）1.19.5，让 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash` 只读地审代码（规则见 [.agents/instructions/model-review.md](../../.agents/instructions/model-review.md)）。脚本把服务方写死为 OpenCode Go（Andy 的 10 美元月度套餐），而这个套餐的额度快用完了。

Andy 还有一个腾讯 CodeBuddy 国际版（WorkBuddy AI）免费账号，里面有同样的两个模型。2026-11-07 他提出：复核时 Claude Code 和 OpenCode 都只关心“用哪个模型、什么推理强度”，背后的服务方交给 Magpie（一个开源的本机模型网关，对外提供 OpenAI 兼容接口，背后能挂多个账号套餐和 API 密钥，一家用不了就换下一家）去选；Magpie 和 OpenCode 都跑在云端线程自己的容器里，不连生产服务器 `84.247.157.41`。

同一天在云端容器里实测（整个过程和数字见 `.agents/reviews/topic-review-gateway-magpie/` 里的提示词“已核实的事实”一节）：

- 生成密钥要 Pro 套餐，所以 CodeBuddy 只能用账号登录。登录凭证存成云端环境的网络密钥（出口代理在请求离开容器后补上，容器里看不到值）；Magpie 的 CodeBuddy 插件读一份只含假凭证 `proxy-injected` 的桌面登录文件，代理照样补上真凭证。
- 经 Magpie 跑完一整轮 PR 273 的 DeepSeek 复核：12.9 分钟，38 步，单步最多 5,922 个 token；途中 CodeBuddy 断开一次，Magpie 把 5 次请求转给 Go，复核没受影响。
- 同一天 OpenCode Go 上的 DeepSeek 超时两次、报服务错误三次，CodeBuddy 的 DeepSeek 也故障了约 20 分钟。只靠一家，复核会卡住。

方案讨论记录在 `.agents/reviews/topic-review-gateway-magpie/`：整合方案 `proposal.md`、逐条判断 `judgments.md`。DeepSeek 两轮都没出结果，整合只依据 GLM 的独立方案和审核意见。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-07：“在 opencode 往外调大语言模型的时候，通过 Magpie 的路由。在这个 magpie 路由里，我可以填我现在拥有的提供商……Claude Code 和 opencode 之间的协作，Claude Code 只用关心使用哪一个模型和哪一个推理强度。”
- 同日：“不要去连我的那个云服务器”；“选项 B”（把登录凭证存进云端环境）；积分底线“设成 20”；OpenCode Go 额度用完前复核继续直连 Go。
- 同日对整合方案：插件改写系统提示的例外“同意”；`stays=session`“按照你的建议”；积分预留按“0.2 美元封顶 × 历史最大换算比”“可以”；遮盖保持关闭、版本锁定主动升级都“按照你的建议”。

<a id="decision"></a>

## 决定

1. **新增开关 `--gateway magpie`，默认关。** 关着时 OpenCode 的配置和以前逐字节相同（测试锁住）。开着时，OpenCode 只配一个服务方 `magpie`（`@ai-sdk/openai-compatible`，地址是本次 Magpie 的回环地址），模型 `opencode-go/deepseek-v4.1-flash` 映射成 `magpie/group/review-deepseek-v4.1-flash`。模型全名、账本里的 `model`、提示词文件名、`--models` 都不变，旧账本照常能读。
2. **版本锁定、主动升级。** `scripts/model-review/gateway-lock.json` 记 Magpie 命令行版的版本和四个平台的下载地址、SHA-256（取自 Magpie 官方更新源 `https://usemagpie.ai/api/latest`），以及 CodeBuddy 插件的版本和 npm integrity。`node scripts/model-review/gateway.mjs upgrade` 一条命令改锁文件，升级后跑自检和测试再提交；不在运行时自动取最新版（Magpie 2026-11-07 一天之内从 0.1.3232 发到 0.1.3240）。`node scripts/model-review/gateway.mjs install` 按锁文件下载、校验，不符就删掉并报 `GATEWAY_INTEGRITY_MISMATCH`。每次运行前后再核对 Magpie 程序的 SHA-256（`GATEWAY_BINARY_CHANGED`），防止自动更新换掉程序。
3. **每次运行自起一个全新的 Magpie，跑完关掉。** 配置、用量记录和插件登录都放在本次的临时目录里（`HOME`、`XDG_CONFIG_HOME` 等指过去），程序和 Bun 缓存在安装目录里复用。服务方和路由组按 `scripts/model-review/gateway.json`（不含密钥）生成：CodeBuddy 在前、Go 在后，`routing=order`、`stays=session`；Go 的地址改为 `https://opencode.ai/inference/go/v1`（云端环境的 Go 网络密钥只对这个路径代填）。路由组名加 `review-` 前缀，避免和 Magpie 为“多家都有的模型名”自动建的组撞名（实测 `glm-5.3-flash` 撞过）。OpenCode 进程显式设 `NO_PROXY` 包含回环地址，直连 Magpie；同时设 `OPENCODE_ENABLE_EXA=1`，否则自定义服务方下 OpenCode 不给方案讨论提供网页搜索工具。
4. **花费上限。** OpenCode 配置里按 Go 的单价写模型 `cost`，现有的 `spend-guard.mjs`（请求发出前拦，I-77 的门槛）、每模型 0.2 美元、先问线都照旧生效。真实花费从本次 Magpie 的 `usage.jsonl` 按服务方汇总，写进账本的 `gateway: "magpie"` 和 `providers` 字段（CodeBuddy 记积分，Go 按单价折算美元）；读不到时记 `costUnknown`，按保守公式记账。
5. **积分底线 20。** 开跑前经代理查账号编号、经本次 Magpie 查剩余积分；剩余减去预留低于 20，或查不到，或带着 CodeBuddy 启动 Magpie 失败，就从本次路由组里去掉 CodeBuddy，只走 Go，并打印 `GATEWAY_CREDIT_FLOOR`。预留 = 模型数 × 0.2 美元 × 积分/美元换算比（可能由 GLM 顶替 DeepSeek 的代码复核轮次按两个模型算）；换算比取账本里只用了 CodeBuddy 的运行中最大的那个，且不低于实测值 54（PR 273 第 1 轮：Go 0.081 美元，CodeBuddy 4.37 积分）。不用中位数，因为预留要的是一次运行最多会用多少。底线只在开跑前判断一次，运行中不拦。
6. **自检。** 开 `--gateway` 时，原有探针（只读限制、写文件、读仓库外、费用插件拦截、输出上限、推理强度）全部改为经本次自检用的 Magpie 发到本机假服务器；输出上限按网关声明值核对（DeepSeek 12.8 万，GLM 3.2 万）。新增：透传探针（同一提示直连和经 Magpie 各发一次，只在系统消息里把 OpenCode 自己写进去的模型名换回直连写法后，第一条带工具的请求的 `messages` 和 `tools` 序列化结果相同，并确认提示里的假邮箱没被遮盖）、故障转移探针（第一个成员返回 500，必须换到第二个）、费用计入检查（经 Magpie 时 OpenCode 给探针运行算出的费用必须大于 0）、程序摘要检查。真跑之前再做联网预检：本次要跑的模型的路由组成员都在 Magpie 的模型清单里，否则 `GATEWAY_PREFLIGHT_FAILED`。`gateway.json` 读入时逐项校验（`GATEWAY_CONFIG_INVALID`），用量记录读不懂时记 `costUnknown`，脚本结束或收到中断信号时停掉它启动过的所有 Magpie。
7. **Magpie 的敏感信息遮盖在复核时保持关闭**（它默认就关）；遮盖被打开且会遮邮箱时，透传探针会失败。开着时模型看到的是占位符，复核会看错测试里的假密钥和安全例外清单的摘要值。
8. **切换。** OpenCode Go 额度用完前，复核默认仍直连 Go；Andy 验收经 Magpie 的复核后，再把默认改为开，直连方式保留一个版本作为退路。

<a id="prompt-prefix-exception"></a>

## 对“只追加”规则的受控例外

CodeBuddy 会以错误码 11128 拒绝它不认可的系统提示。被拒时，插件 `@magpie-community/opencode-workbuddy-auth@0.2.24` 先给那句话加一个逗号重发，再不行就把系统提示挪进第一条用户消息（插件 `index.mjs` 的 `systemAsUser`，README 原文“sent once more … with the system prompt moved into the first user message”）。这改变了已经发出的请求开头，违反 [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md) 第 4 条。Andy 2026-11-07 同意作为受控例外：只在 CodeBuddy 拒绝时发生，同一个插件进程内对同一段提示的处理是确定的。透传探针只证明 Magpie 本身（经自定义服务方）转发第一条请求时不改内容，不覆盖 CodeBuddy 插件自己的改写；插件的行为依据是它的源码和 README。另外，出故障换服务方时缓存要整段重算一次，这是第 9 条允许的情况；`stays=session` 保证换过去以后不再来回切。

<a id="options"></a>

## 比较过的方案

### 方案 A：每次运行自起本机 Magpie（采用）

- 好处：OpenCode 和复核脚本都不关心服务方；一家故障自动换下一家；账号套餐和 API 密钥都能接；生产上已经在用 Magpie（ADR 0117）。
- 代价：多一个 0.1.x 版本、发版频繁的程序，要锁版本；每次自检多起几个 Magpie，约多 40 秒。

### 方案 B：OpenCode 直接装 CodeBuddy 插件

- 好处：少一层；实测已能跑通。
- 代价：服务方又写回 OpenCode 配置，违背 Andy“OpenCode 不关心服务方”的要求；没有故障转移。

### 方案 C：改用 CodeBuddy 自己的命令行 `codebuddy -p`

- 代价：现有的只读限制、费用拦截插件、自检全要重写；无人值守模式必须加 `-y` 跳过权限确认；输出里没有每一步的费用。

### 方案 D：LiteLLM 或 OpenRouter 一类网关

- 代价：都不能用 CodeBuddy 的账号套餐；OpenRouter 还要按服务方原价加价。

### 方案 E：旁路 Docker 镜像装 OpenCode 和 Magpie

- 代价：云端不能换基础镜像；旁路容器每个会话都要先启动 Docker 后台服务，容器里的代理和证书要另配。启动脚本加环境快照已经能做到“装一次、之后复用”（[Claude Code 云端环境文档](https://code.claude.com/docs/en/cloud-environments)：“Anthropic snapshots the filesystem and reuses that snapshot as the starting point for later sessions”）。

### 不采纳的审核意见

- 用 Magpie 网关密钥的 token 或美元限额在转发前拦：现有费用插件配上单价已能在请求前拦，并有 I-77 的门槛；Magpie 的美元限额对没有价格的 CodeBuddy 不计。
- 另设积分的先问线：积分不是钱，Andy 定的是“剩余低于 20 不用”。

<a id="consequences"></a>

## 后果

- 好处：OpenCode Go 用完或任何一家故障时，复核还能继续；新增服务方只改 `gateway.json`。
- 风险：社区插件的桌面登录文件格式可能随插件升级改变，靠锁版本和联网预检兜住；CodeBuddy 条款风险由 Andy 承担（ADR 0117 已接受同一做法）；积分和生产 Himawari 共用，底线 20 只保证复核不用掉最后 20 积分；云端环境里存的是一份一年有效、能操作整个账号的登录凭证，撤销方法是删掉 himawari-cloud 环境里 `www.workbuddy.ai` 那条网络密钥。
- 局限：`--gateway magpie` 依赖出口代理代填凭证，现在只适用于云端会话；Mac 上要用还得另做登录，Mac 验证按项目规则暂缓。
- 后续：Andy 验收后把默认改为开；下一个版本删掉直连方式。
- 2026-11-07 Andy 验收（原话：“改成默认走 Magpie”）：默认由环境变量 `HIMAWARI_REVIEW_GATEWAY` 决定，himawari-cloud 设成 `magpie`，命令行 `--gateway magpie|direct` 优先，都没有时直连。直连方式不删：Mac 上没有出口代理代填凭证，只能直连。
- 2026-11-07 Andy 开了 OpenDesign 包月套餐（接口 `https://amr-link.open-design.ai/v1`，密钥在 himawari-cloud 的网络密钥里），加为第三家服务方，排在 CodeBuddy 之后、Go 之前；路由保持 `order`（Andy 原话：“那就把 Magpie 的模式设成按固定顺序，顺序是先 codebuddy，然后是 OpenDesign，然后才是 opencode go”）。试过 Magpie 的默认策略 `smart`：它只读得到 CodeBuddy 的额度，读不到 OpenDesign 和 Go，实测 6 次独立会话三家轮流接到请求，没有按到期时间挑。
- 2026-11-08 Andy 定（原话：“不能因为某一家连不上这次复核就不做了呀……它们多个 provider 之间是主备关系”）：开跑前检查发现某一家的成员不可用时，只去掉这一家，复核继续；去掉之后任何一个要跑的模型没有可用成员才停下（每家服务方都必须提供全部复核模型，读入配置时检查）。
- 2026-11-08 Andy 同意整合后的方案（`.agents/reviews/topic-review-control/proposal.md`）：新增 `--providers` 让这一次只用列出的服务方（积分底线照旧）；复核可以随时叫停（`owner-stopped` 照样记账）；Andy 明确说跳过时任何 PR 都可以不复核合并，原话记进账本。
- 2026-11-08 Andy 同意（原话：“同意”）Mac 本地线程不在本机跑复核，一律交给 himawari-cloud 里的云端线程（方案和取舍见 `.agents/reviews/topic-review-delegation/`）：新增 `--require-gateway`（不经 Magpie 或没有代理就在读材料、安装、花钱之前停下）和 `scripts/model-review/delegate.mjs`（生成任务说明、核对云端推回来的结果、等分支出现新提交）。Mac 上因此不需要配任何模型密钥。

<a id="links"></a>

## 关联文档

- [ADR 0117：主模型经生产机 Magpie](0117-magpie-routes-models-through-owned-subscriptions.md)
- [ADR 0175：代码复核第 2 轮起只用 DeepSeek](0175-cheaper-code-review-rounds.md)
- [事故 I-76、I-77](../incidents-and-gates.md#incidents)
- [工程案例库 案例 60](../engineering-casebook.md#case-magpie-subscriptions)
- Magpie 参考文档：https://github.com/yetone/magpie/blob/main/docs/reference.md
