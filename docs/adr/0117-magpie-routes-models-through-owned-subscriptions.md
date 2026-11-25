---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "apps/agent-service/src/production-model-composition.ts, packages/platform-node/src/strict-configuration.ts, packages/runtime-pi/src/configured-model-binding.ts, packages/runtime-pi/src/pi-model-transport.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
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
- [2026-10-29 晚间修订：实际接入情况](#revision-1029-evening)
- [2026-10-30 顺序变更：CodeBuddy 排第一](#revision-1030-order)
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

> 本节是 16:58 时的计划。实际接入的顺序和各套餐结论以[晚间修订](#revision-1029-evening)为准。

Magpie 里建一个路由组 `himawari-main`，按顺序（`routing=order`）排：

1. OpenCode Go 的 DeepSeek V4.1 Flash：套餐里每月 80 美元额度，官方估计约 17.3 万次。
2. OpenCode Go 的 GLM-5.3-Flash：零保留、不训练，在美国或欧盟运行。
3. SuperGrok（经 Grok Build 登录）。
4. Vercel 上的 DeepSeek V4.1 Flash，只允许走 Morph：前面都用完时兜底，每千次调用约 0.45 美元。

Magpie 会对同一段对话固定用同一个账号，以保住厂商那边的提示词缓存（README 原文：“A conversation stays on the account that answered it”）。

[↑ 返回阅读导航](#contents)

<a id="subscriptions"></a>

## 各套餐能不能接

> 本表是 16:58 时的判断。CodeBuddy 和 SuperGrok 的结论后来变了，见[晚间修订](#revision-1029-evening)。

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
- 风险：SuperGrok 的接法没有条款支持，可能被拒绝，也可能影响 Andy 的 X/Grok 账号。（后来没有接，见[晚间修订](#revision-1029-evening)。）
- 风险：CodeBuddy 国际版经社区插件接入，条款风险由 Andy 承担；数据在新加坡保留 14 天。
- 风险：OpenCode Go 说套餐是为编程 Agent 设计的。Himawari 的后台邮件判断不像编程请求，可能被当成滥用。
- 隐私：邮件判断现在和主对话共用一个路由组，所以 Go 的 DeepSeek 打开 Global 地区后，邮件的发件人、标题和摘要也可能出美国和欧盟。邮件判断改用单独的、只在美欧运行的模型，已记为 [BL-20261029-005](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/backlog/BL-20261029-005-gmail-judge-separate-model.md)。2026-10-29 19:55 JST 主人决定：邮件、记忆这类私人数据不必特意避开 CodeBuddy，不另建私人路由组。
- 后续：在 Magpie 里配好 OpenCode Go 的 Key 和 SuperGrok 登录，建 `himawari-main` 路由组，再出包把生产配置的主模型改成 Magpie，然后在真实网页里验收。

[↑ 返回阅读导航](#contents)

<a id="revision-1029-evening"></a>

## 2026-10-29 晚间修订：实际接入情况

当天 17:57–19:56（日本时间）Andy 又做了几项决定，生产机上的 Magpie 已按下面的样子配好。前面的计划文字保留原样，以本节为准。

**路由组 `group/himawari-main`（按顺序，`routing=order`）**

1. `opencode-zen/deepseek-v4.1-flash-free`：OpenCode Zen 的免费模型，零保留。Andy 18:22 说“接免费模型”，要求免费模型排在套餐模型前面。
2. `opencode-zen/glm-5.3-flash-free`：同上。
3. `opencode-go/deepseek-v4.1-flash`：OpenCode Go 套餐。
4. `opencode-go/glm-5.3-flash`：OpenCode Go 套餐。
5. `workbuddy-ai/deepseek-v4.1-flash-sg`：腾讯 CodeBuddy 国际版，排在最后。

组里没有 Vercel。Andy 18:28 定：Vercel 只留嵌入模型（Go 和免费模型都没有嵌入模型），外加一个默认关闭的兜底。

**各套餐的结论变化**

| 套餐 | 原来的结论 | 现在 | 依据 |
| --- | --- | --- | --- |
| 腾讯 CodeBuddy | 不接（当时以为 Magpie 只能反过来给 CodeBuddy 用） | 接国际版，排最后 | 社区插件 `@magpie-community/opencode-workbuddy-auth` 0.1.47 能让 Magpie 调用 CodeBuddy 的模型，之前的判断错了。Andy 18:31 授权在生产机装 Bun 和这个插件并登录他的账号，条款风险由 Andy 承担。国际版隐私政策：数据保留 14 天，服务器在新加坡，中国大陆的团队可能访问，默认不用于训练。 |
| SuperGrok | Andy 知道风险后选择接 | 先不接 | Andy 18:53 选“先不接”。已下载的 Grok Build 文件已删除，没有运行过。 |
| OpenCode Zen 免费模型 | 未列入 | 接，排最前 | 见上。19:26 实测两个免费模型第一次请求就回 429“免费额度已用完”，原因未查清；Andy 19:56 选“先留着”。Magpie 在冷却期内本地跳过它们，约每小时一次多等约 0.5 秒。 |
| Claude Max 附送的 API 额度 | 未定 | 先不接 | Andy 19:14：只用在评测器校准这类必须高能力模型的地方，接之前必须等他点头。 |

**其他决定**

- OpenCode 客户端身份：用 Magpie 的默认做法，按 OpenCode 官方客户端的样子发请求（Andy 19:12 选定）。
- 私人数据：邮件、记忆这类私人数据不必特意避开 CodeBuddy，不另建私人路由组（Andy 19:55）。
- 主模型切到 Magpie 随第十九版上线；配置写法见 `strict-configuration.ts` 对 `provider: "magpie"` 的校验。

[↑ 返回阅读导航](#contents)

<a id="revision-1030-order"></a>

## 2026-10-30 顺序变更：CodeBuddy 排第一

10-30 00:41（日本时间）Andy 在对话提速专项的选择卡上选定新顺序，理由和测量见 [ADR 0119](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md#decision)。01:04 Mac 线程在生产机改好并重启 `magpie.service`（`himawari-prod.service` 没动），改前的配置备份在生产机 `/root/config-backups/magpie-providers.json.before-codebuddy-first-20261029T160404Z`。路由组 `group/himawari-main` 现在的顺序：

1. `workbuddy-ai/deepseek-v4.1-flash-sg`：腾讯 CodeBuddy 国际版（新加坡）。
2. `opencode-go/deepseek-v4.1-flash`
3. `opencode-go/glm-5.3-flash`
4. `opencode-zen/deepseek-v4.1-flash-free`：免费模型挪到最后，不删。
5. `opencode-zen/glm-5.3-flash-free`

改后在生产机发 5 次短请求，响应头 `x-magpie-provider`（Magpie 标明实际由哪个来源回答）全是 `workbuddy-ai`，首字节 3.26 秒（冷）、0.97、1.13、1.07、0.93 秒；改前经路由组中位数 3.0 秒。上一节“免费模型排最前”和“CodeBuddy 排在最后”以本节为准。

[↑ 返回阅读导航](#contents)

<a id="links"></a>

## 关联文档

- [ADR 0111：任何场景都不调用 Claude、OpenAI 等贵模型](0111-no-expensive-models-anywhere.md)：Andy 10-29 补充，已付费套餐里的额度不算在内。
- [ADR 0048：Vercel AI Gateway 替代 OpenRouter](0048-vercel-ai-gateway-replaces-openrouter.md)
- [ADR 0074：Claude 直接在生产机上线、回滚和诊断](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0074-claude-runs-production-deployments.md)
- [产品愿景](../product-vision.md)：这里取舍的是“主动性与效率”里的成本，换来了一部分隐私风险。按原则顺序，Andy 作为主人亲自做了这个选择（用户主权）。
- [ADR 0119：对话提速](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md)：10-30 顺序变更的理由和测量。
- [工程案例库 案例 60：本机 Magpie 网关替 Agent 在多个套餐之间切换](../engineering-casebook.md#case-magpie-subscriptions)

[↑ 返回阅读导航](#contents)

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 决定所有受邀的人都和 Andy 走同一个 Magpie、同一套已有的订阅（按本 ADR 的路由顺序，不额外付费）（Andy 2026-11-11 说不再用 Vercel 的 key）。本 ADR 里“数据可以走 CodeBuddy 是 Andy 对自己数据的同意”只对 Andy 自己的数据成立；其他人的数据经过 Andy 的套餐账号、有时走到 CodeBuddy，要在邀请时告知对方。OpenCode Go 的条款写明只给单人使用（整合方案 1.8 节），这个风险由 Andy 承担，见 [ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 的后果一节。其他人的请求不允许落到按量付费的路上，除非 Andy 在配置里明确打开。本 ADR 的路由顺序不变。
