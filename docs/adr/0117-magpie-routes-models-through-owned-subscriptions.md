---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
---

# ADR 0117：主模型改经生产机本机的 Magpie 网关，优先用 Andy 已订阅套餐里的额度

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [路由顺序](#routing-order)
- [各套餐能不能接](#subscriptions)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#links)

<a id="context"></a>

## 背景

2026-10-29，Andy 要求给 Himawari 找“隐私最好、价格最低”的模型方案。调研结果写在项目文档“Himawari 模型方案调研：隐私最好、价格最低”里：如果愿意付钱，最好的是模型不换（DeepSeek V4.1 Flash），改经 OpenRouter（一家模型路由公司）强制零保留，并优先发给 Morph（一家推理厂商）。

同一天 16:09（日本时间），Andy 改了目标，原话：“必须充分利用 magpie 的核心能力，尽量使用我已经订阅的套餐里面的 token。尽量不直接使用 vercel 和 openrouter 的模型。”他已付费的套餐有：OpenCode Go（OpenCode 的 10 美元月度套餐）、SuperGrok（xAI 的 Grok 会员）、腾讯 CodeBuddy 的免费额度，以及 Claude Max（Anthropic 的会员，每月附送 200 美元 API 额度）。

Magpie（[usemagpie.ai](https://usemagpie.ai/)，开源，MIT 协议）是一个本地模型网关：它对外提供 OpenAI 兼容接口，背后可以挂多个 API Key 或订阅登录，额度用完时自动换下一个账号或模型。

在这之前，Himawari 只能经 Vercel AI Gateway（Vercel 的模型网关）调用一个写死的模型 `deepseek/deepseek-v4.1-flash`，每次调用的费用从 Vercel 返回的账单字段里核对。

Andy 16:07 在线程里同意在生产机安装 Magpie。17:10–17:13 已装好并空跑：版本 v0.1.2001，`/opt/magpie/v0.1.2001/magpie`，系统服务 `magpie.service`，专用用户 `magpie`，只监听 `127.0.0.1:3425`，关闭了统计上报（`DO_NOT_TRACK=1`、`MAGPIE_NO_STATS=1`），也关掉了读取其他客户端登录信息的功能（`magpie accounts discovery off`）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Himawari 的主模型可以配置成 `provider: "magpie"`。** 配置里写 Magpie 的路由组名（例如 `group/himawari-main`）和本机地址 `baseUrl: "http://127.0.0.1:3425/v1"`。只接受本机回环地址的 http，不接受其他主机，也不接受 Vercel 专用的 `providerRouting`。改动在 `packages/platform-node/src/strict-configuration.ts`、`packages/runtime-pi/src/configured-model-binding.ts` 和 `apps/agent-service/src/production-model-composition.ts`。
2. **Pi 部分直接复用，不另写协议。** Pi（Himawari 底层的 Agent 框架）的 `openai-completions` 接口本来就支持自定义地址，Magpie 走的就是这个接口。Himawari 只负责配置校验和费用记账。只有 Vercel 才用 `openrouter` 格式的思考参数；Magpie 用 Pi 默认的 OpenAI 格式，由 Magpie 再翻译给后面的模型。Magpie 路线还打开 Pi 的 `sendSessionAffinityHeaders`（每次请求带上会话编号的开关）：主对话带 Pi 的会话编号，其他单次调用（例如邮件判断）带本次运行的编号，放在 `x-session-affinity` 和 `session_id` 请求头里。Magpie 据此给 OpenCode Go 生成固定的 `x-opencode-session`。Go 从 2026-09 起会拒绝不带这个头的请求；不带的话，Magpie 只能按对话第一句话推算，两段同样以“你好”开头的对话会被当成同一段。
3. **费用按 token 自己算。** Magpie 不返回 Vercel 那样的账单字段，所以 `packages/runtime-pi/src/pi-model-transport.ts` 对 Magpie 用配置里的单价乘以 token 数来记账，没有单价就拒绝。主对话一路（`pi-runtime-adapter.ts`）和预算服务本来就对非 Vercel 厂商按单价计算，不用改。配置里的单价按 Vercel 上的保守价格写，保证每个任务的费用上限仍然有意义，尽管套餐内的实际花费是 0。
4. **Magpie 只接 API Key 和 Andy 明确同意的订阅登录。** 详见[各套餐能不能接](#subscriptions)。
5. **记忆检索用的向量模型（`alibaba/qwen3-embedding-8b`）暂时继续走 Vercel。** 它每百万 token 只要 0.01 美元，Magpie 也不提供向量接口。

[↑ 返回阅读导航](#contents)

<a id="routing-order"></a>

## 路由顺序

Magpie 里建一个路由组 `himawari-main`，按顺序（`routing=order`）排：

1. OpenCode Go 的 DeepSeek V4.1 Flash：套餐里每月 80 美元额度，官方估计约 17.3 万次。
2. OpenCode Go 的 GLM-5.3-Flash：零保留、不训练，在美国或欧盟运行。
3. SuperGrok（经 Grok Build 登录）。
4. Vercel 上的 DeepSeek V4.1 Flash，只允许走 Morph：前面都用完时兜底，每千次调用约 0.45 美元。

Magpie 会对同一段对话固定用同一个账号，以保住厂商那边的提示词缓存（README 原文：“A conversation stays on the account that answered it”）。

[↑ 返回阅读导航](#contents)

<a id="subscriptions"></a>

## 各套餐能不能接

| 套餐 | 接法 | 条款情况 | 决定 |
| --- | --- | --- | --- |
| OpenCode Go | API Key，Magpie 有现成配置项 | [Go 文档](https://opencode.ai/docs/go/)写明“designed for OpenCode and other coding agents that produce similar types of requests”，并监控滥用；要求客户端带自己的 User-Agent 和 `x-opencode-session` | 接 |
| SuperGrok | 在生产机装 Grok Build 命令行工具并登录，Magpie 用它的登录调用 | xAI 只公开允许在 OpenCode 等认可的客户端里用订阅（[xAI 公告](https://x.ai/news/grok-opencode)），没有允许自建服务这样调用的条款 | Andy 知道风险后选择接（10-29 16:58，“我现在有腾讯的codebuddy、opencode go、supergrok 都可以给magpie来路由给himawari用”） |
| 腾讯 CodeBuddy 免费额度 | Magpie 只能让 CodeBuddy 用 Magpie 的模型，不能反过来；社区插件 WorkBuddy 带“每日自动签到” | [腾讯云条款](https://www.tencentcloud.com/document/product/1256/77269)禁止用“scripts, plug-ins, emulators, API calls”等方式刷活动或奖励 | 不接，也不开自动签到 |
| Claude Max 订阅登录 | Magpie 驱动本机 `claude` 程序 | [Claude Code 法律页](https://code.claude.com/docs/en/legal-and-compliance)：不允许第三方“route requests through Free, Pro, or Max plan credentials” | 不接 |

OpenCode Go 的 DeepSeek 要在设置里打开“Global”地区才能用，数据会离开美国和欧盟；它的零保留协议按月续签（文档写着当前到 2026-10-31）。如果协议没有续上，就把它从路由组里拿掉。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：经 OpenRouter 强制零保留，走 Morph（调研时的推荐）

- 好处：隐私最好（书面的强制零保留，免费账号也能用），价格接近最低。
- 代价：每次调用都要付钱（加 5.5% 充值手续费），不能用已付费的套餐额度。Andy 16:09 明确不要。

### 方案 B：不经 Magpie，Himawari 直接连各家 API Key

- 好处：少一个常驻服务。
- 代价：额度用完自动换下一家、按套餐额度窗口排先后，都要在 Himawari 里自己写一遍。SuperGrok 也没有 API Key 可用。

### 方案 C：经 Magpie（采用）

- 好处：一个本机地址就能切换多个套餐，额度用完自动换下一个；Himawari 只多一个配置分支。
- 代价：多一个 0.1.x 版本的常驻服务（发版很频繁，项目不接受外部代码）；Himawari 看不到最终用了哪家，只能按单价估算费用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：套餐内额度够用时，主模型不再花 Vercel 的钱。
- 风险：**Magpie 只监听本机时不检查访问密钥**（启动日志：“anything works; the gateway only listens on localhost”），所以生产机上任何本地程序都能用 Andy 的套餐额度。我们核对过：Himawari 让模型执行命令的沙箱（`linux-bubblewrap-command-provider.ts`、`capabilities/isolation.ts`）都用 `--unshare-all` 切断网络，连不到宿主的 `127.0.0.1`。剩下能调用的只有生产机上的 root 和几个系统服务。我们判断这个风险可以接受。Himawari 仍然带上 Magpie 生成的网关密钥，以后 Magpie 对外监听时密钥照样生效。
- 风险：SuperGrok 的接法没有条款支持，可能被拒绝，也可能影响 Andy 的 X/Grok 账号。
- 风险：OpenCode Go 说套餐是为编程 Agent 设计的。Himawari 的后台邮件判断不像编程请求，可能被当成滥用。
- 隐私：邮件判断现在和主对话共用一个路由组，所以 Go 的 DeepSeek 打开 Global 地区后，邮件的发件人、标题和摘要也可能出美国和欧盟。邮件判断改用单独的、只在美欧运行的模型，已记为 [BL-20261029-001](../backlog/BL-20261029-001-gmail-judge-separate-model.md)。
- 后续：在 Magpie 里配好 OpenCode Go 的 Key 和 SuperGrok 登录，建 `himawari-main` 路由组，再出包把生产配置的主模型改成 Magpie，然后在真实网页里验收。

[↑ 返回阅读导航](#contents)

<a id="links"></a>

## 关联文档

- [ADR 0111：任何场景都不调用 Claude、OpenAI 等贵模型](0111-no-expensive-models-anywhere.md)：Andy 10-29 补充，已付费套餐里的额度不算在内。
- [ADR 0048：Vercel AI Gateway 替代 OpenRouter](0048-vercel-ai-gateway-replaces-openrouter.md)
- [ADR 0074：Claude 直接在生产机上线、回滚和诊断](0074-claude-runs-production-deployments.md)
- [产品愿景](../product-vision.md)：这里取舍的是“主动性与效率”里的成本，换来了一部分隐私风险。按原则顺序，Andy 作为主人亲自做了这个选择（用户主权）。
- [工程案例库 案例 60：本机 Magpie 网关替 Agent 在多个套餐之间切换](../engineering-casebook.md#case-magpie-subscriptions)

[↑ 返回阅读导航](#contents)
