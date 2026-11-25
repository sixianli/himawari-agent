---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0076-no-model-cost-budget-limits.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0111-no-expensive-models-anywhere.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0124-unknown-model-call-blocks-only-its-own-resend.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0128-record-cache-usage-of-every-model-request.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0148-send-every-model-request-through-one-in-process-egress.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/platform-node/src/strict-configuration.ts, packages/runtime-pi/src/configured-model-binding.ts, packages/runtime-pi/src/pi-model-transport.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/src/cache-usage-observation.ts, packages/application/src/services/model-egress.ts, packages/persistence-sqlite/src/sqlite-model-budget-operations.ts, apps/agent-service/src/production-model-composition.ts, scripts/check-expensive-models.mjs, scripts/operations/cache-hit-report.mjs, test/fixtures/jarvis-test/models.json"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0297：模型调用的现行做法

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [走哪条路发请求](#routes)
  - [用哪些模型、不用哪些](#models)
  - [花费：只记账，不设上限](#cost)
  - [结果不确定的调用](#unknown)
  - [唯一的出口和遮盖](#egress)
  - [限流时重试](#retry)
  - [记下每次请求的缓存命中](#cache)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

模型调用（Himawari 向模型服务方发请求的那一层）的决定原来分散在九份 ADR 里：换成 Vercel 网关（0048）、不设费用上限（0076）、花钱的评测先定上限（0109）、禁用贵模型（0111）、经 Magpie 用套餐额度（0117）、结果不确定的调用只挡自己（0124）、记缓存命中（0128）、唯一出口和遮盖（0148）、限流重试（0245）。后面的改了前面的不少地方（例如 0117 让主模型改走 Magpie，0111 改掉了 0109 的裁判模型）。这份 ADR 只写现在为真的做法；旧文全文在 `supersedes` 列的固定提交链接里。原则层面的“模型按策略路由”见 [ADR 0296](0296-foundational-architecture-principles.md) 第 12 条。

<a id="decision"></a>

## 决定

<a id="routes"></a>

### 走哪条路发请求

- 主模型配置成 `provider: "magpie"`：Magpie（装在生产机上的模型路由程序）的路由组名加本机回环地址，只接受本机 http，不接受 `providerRouting`。Magpie 按路由组的顺序把请求交给 Andy 已付费套餐里的模型，套餐内的 token 优先用（[Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#money-and-models)）。
- 配置仍允许 `provider: "vercel-ai-gateway"`，但模型只能是 `deepseek/deepseek-v4.1-flash`，并且必须写密钥引用和 `providerRouting`（服务方顺序和按费用兜底）。
- 请求一律由 Pi 的 `openai-completions` 接口发出，只换地址和密钥，不另写协议。Magpie 路线打开 Pi 的 `sendSessionAffinityHeaders`：主对话带 Pi 的会话编号，单次调用带本次运行的编号，Magpie 据此把同一段对话固定在同一个账号上，保住服务方的缓存。
- Magpie 只接 API Key 和 Andy 明确同意的订阅登录；条款不允许第三方转发的订阅（例如 Claude Max）不接。
- 记忆向量的算法见 [ADR 0224](0224-memory-embedding-runs-on-the-host.md)。

<a id="models"></a>

### 用哪些模型、不用哪些

- 任何场景（生产、评测、裁判、测试、后台任务）都不通过按 token 付费的渠道调用 Claude、OpenAI 或同价位的模型。`npm run check:expensive-models` 扫描代码、脚本、测试和配置，出现 `anthropic/…`、`openai/…` 或不带前缀的 `claude-…`、`gpt-<数字>…` 就失败；`docs/` 和评测原始记录不扫。新增任何模型名都写进集中配置，并在 PR 里写出每百万 token 的价格。
- 评测的裁判模型集中写在 `test/fixtures/jarvis-test/models.json`，被测模型是生产主模型，裁判不能和被测模型同一家。
- 花钱的评测要先定上限：`npm run eval:jarvis:live` 不带 `--confirm-cost=<美元>` 就不开跑（`JARVIS_LIVE_COST_APPROVAL_REQUIRED`），开跑前先发一个只要 1 个 token 的请求试探网关，被拒就不开跑（`JARVIS_LIVE_GATEWAY_REFUSED`）。评测和生产不共用预算。

<a id="cost"></a>

### 花费：只记账，不设上限

- 配置里没有 `budgets` 段，出现就以 `UNKNOWN_FIELD` 拒绝启动；准入不因费用拒绝任何调用。
- 预算账本（`model_budget_accounts`、`model_budget_allocations` 和调用身份）照旧记每次调用的预估、实际花费和 `reserved → started → settled | unknown | released` 状态，用作用量统计和防重复发送的门禁。
- Magpie 不返回账单字段，所以按配置里的单价乘以 token 数记账，没有单价就拒绝；单价按保守的公开价格写，套餐内的实际花费是 0。
- 对话模型返回 402（额度用完）时记为 `PI_MODEL_QUOTA_EXCEEDED`，网页说明是额度用完、不是网络问题。

<a id="unknown"></a>

### 结果不确定的调用

- 同一调用位置上有一笔 `unknown`，再申请仍返回 `replay`，挡住它自己的重发；账户保持“待对账”，但同一轮里其他调用照常预留和开始。
- 账户“待对账”时，整轮不会被重新派发，后台任务的这一次也不会被恢复重跑，因为那等于把不确定的那次调用再发一遍。

<a id="egress"></a>

### 唯一的出口和遮盖

- 主对话、辅助调用和嵌入都只用 `model-egress.ts` 的 `ModelEgress` 包过的 `fetch` 发请求，不接外部网关。出口识别请求路径，解析 JSON 后逐段遮盖字符串；推理块、图片、工具定义、结构标识这些位置不碰，工具参数一律检查。
- 拒绝发送而不是放行：路径不认识、请求体不是 JSON、嵌入输入是 token 编号数组、遮盖后仍检出机器密钥，都抛 `ModelEgressRefusedError`。
- 占位符形如 `[验证码#kqzmdwrp]`，编号由 HMAC 取得、按值稳定，所以前缀不变；机器密钥固定写 `[密钥]`，不可还原。只在主对话的显示端把占位符换回原文（`restoreModelStream`），什么时候遮、内部存原文的做法见 [ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)。
- `npm run check:egress-redaction` 要求三个发送点都用 `exchange.wrapFetch(`，并拒绝出口模块之外直接遮盖或另开模型请求出口。

<a id="retry"></a>

### 限流时重试

- 聊天请求和压缩摘要请求在请求层最多重试 2 次（`maxRetries: 2`，服务方要求等超过 10 秒就立刻失败），只重发字节完全相同的请求，失败的那次不进历史，不影响缓存。Pi 自己的自动重试仍然关着。
- 出口对同一份请求的重发只遮盖一次，直接沿用上一次的请求体，保证重发的字节相同。
- 每个被拒绝的响应写一行 `model.request_rejected` 日志（状态码、`retry-after`、服务方主机名）。
- 后台单次调用（`pi-model-transport.ts`）仍是 `maxRetries: 0`。不在同一对话中途自动换模型或服务方，因为那会让缓存整段重算。

<a id="cache"></a>

### 记下每次请求的缓存命中

- 每次正常请求结束后在 `model_usage_observations` 记一行：输入、输出、缓存读、缓存写 token，加用途、来源、服务方、模型和时间。服务方没上报缓存字段时记 `cache_reported = 0`，和“命中 0”分开。
- 命中率 = 已上报且输入不少于 1024 token 的请求的缓存读取之和 ÷ 输入之和，样本少于 5 条不出数。记录在预算结算之后写，失败只写诊断，不影响回答。报告用 `scripts/operations/cache-hit-report.mjs`。

<a id="rejected"></a>

## 放弃的做法

- 全局费用上限：挡住正常对话，Andy 定为只记账；按任务的预算另记在 backlog。
- 接 LiteLLM、Portkey 这类外部网关做遮盖：多一个要运维的服务，遮盖规则也要在两处保持一致。
- 失败时换模型或服务方：缓存整段重算，对话前后用的模型也不一致。

<a id="consequences"></a>

## 后果

- 换模型或加服务方，先改配置和 Magpie 的路由组；代码里不写模型名。
- 所有发给模型的内容都经同一个出口，新加的模型调用必须走它，否则 `check:egress-redaction` 失败。
