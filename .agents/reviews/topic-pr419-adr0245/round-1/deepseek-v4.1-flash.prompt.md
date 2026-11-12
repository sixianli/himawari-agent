你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 4e8e914759bdc425cef5a8cb479b9898ca32faec。
待核对的方案：
方案文件：docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md（在提交 4e8e914759bdc425cef5a8cb479b9898ca32faec 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0198-upgrade-pi-to-1-5-0.md"
date: "2026-11-12"
---

# ADR 0245：模型请求被限流或暂时不可用时，在请求层重试最多 2 次

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-12 09:13 JST，Andy 在手机上发“新闻”，页面显示“发送中”，18 秒后回答“模型服务当前限流”。生产日志（`out.txt`，在 Andy 的 Mac 上）显示：这一轮在 00:13:42Z 收到上游 429（provider_status_429），同一秒起标题的后台调用也被同一上游限流；数据库没有堵（这一轮 154 次操作总排队 349 ms）。Himawari 对 429 没有任何重试，立刻报错，用户只能自己重发。

Himawari 关着两层重试：Pi 的自动重试（`packages/runtime-pi/src/pi-runtime-adapter.ts` 里 `retry: { enabled: false, maxRetries: 0 }`），以及传给模型服务方请求函数的 `maxRetries: 0`。第一层要关，因为 Pi 的自动重试会往历史追加 `context_edit`，改变已发出的内容（[ADR 0198](0198-upgrade-pi-to-1-5-0.md#decision) 前提 5、决定 7）。第二层没有这个问题：它在发出 HTTP 请求的那一层，只重发同一份请求，不碰对话历史。

别人怎么做：OpenAI 官方限流指南说有 `Retry-After` 就照它等，没有就指数退避加随机抖动，并限制次数和总时长（<https://developers.openai.com/api/docs/guides/rate-limits>）；OpenAI 和 Anthropic 的官方 SDK 默认都在请求层重试 2 次。Pi 的模型层自己带了同样的官方做法：`@earendil-works/pi-ai` 的 `maxRetries` 和 `maxRetryDelayMs` 选项（`dist/utils/provider-retry.js`：只重试 408、409、429、5xx 和连接错误；先看 `retry-after-ms`、`retry-after`，没有就从 0.5 秒起指数退避；服务方要求等得比上限还久就立刻失败）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-12 09:31 JST，Andy 在决定卡“对 429 限流，要不要在请求层自动重试最多 2 次？”上选了“重试加记日志（推荐）”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 传给 Pi 模型层的 `maxRetries` 从 0 改成 2，`maxRetryDelayMs` 设为 10 秒。重试只重发同一份请求体，失败的那次不进历史，不影响 KV 缓存（[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md)第 4 条）。服务方要求等超过 10 秒时立刻失败，总等待不超过约 22 秒。
2. Pi 的自动重试仍然关着，决定 7 的前提不变。
3. Vercel 网关的请求观察器原来只许每次调用发一次请求。改成：上一次得到 408、409、429 或 5xx 的拒绝（没有生成内容，不记用量）时允许重发，最多重发 2 次；其他非 2xx（如 400、401）、发过一次成功响应后再发，仍然报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；网络错误之后再发，直接重抛原来的错误，不再发请求。
4. 聊天请求和压缩摘要请求里，每个被拒绝的响应写一行服务日志 `model.request_rejected`：运行号、状态码、`retry-after`、`x-should-retry`、服务方主机名（不含路径、密钥和内容；头部文字截到 128 个字符）。这是这次查不到“谁返回的 429、等多久”的缺口。
5. 超过等待上限而失败时，错误信息以“Server requested …s retry delay (max: …s).”开头，仍按其后的状态码归类成“限流”，用户看到的还是“模型服务当前限流”。
6. 出口遮盖对“同一份请求再发一次”只做一次：同一个出口交换里，请求地址、方法和请求体都与上一次完全相同时，直接沿用上一次遮盖后的请求体，不重新遮盖、不重复上报拦截记录。否则第二次遮盖会带着第一次已记下的“点名值”，把排在点名消息前面的同一个值也遮掉，重发的字节就和第一次不同（复核第 1 轮发现，`[RETRY-429]` 用例复现过）。被拒绝（遮盖后仍有敏感内容）的请求也一样（只对带地址和文字请求体的请求；先检查地址和“请求对象自带请求体”，再看有没有记住）：重发直接再抛同一个拒绝，不再检查、不重复上报；Pi 仍会把这个拒绝当连接错误重试 2 次，白等约 1.3 秒，但不会多发出任何内容（复核第 2 轮发现，用本地探针复现：重试 3 次调用）。约定：一个出口交换服务一次模型调用，只记住上一次请求；以后要在同一个交换里交错发多个不同请求，先改这里。
7. 范围：只覆盖聊天请求和压缩摘要请求。标题、邮件判断、记忆整理等后台调用走 `packages/runtime-pi/src/pi-model-transport.ts`，仍然 `maxRetries: 0`，它们的准入、用量和缓存预热是另一条路，另行决定；记忆保存已有自己的同轮重试（[ADR 0222](0222-retry-and-queue-failed-memory-capture.md)）。
8. 不在同一对话中途自动换模型或服务方：换服务方会让缓存整段重算（prompt-prefix 规则第 8、9 条）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- 打开 Pi 自动重试：官方有，但会追加 `context_edit`，违反“只追加”，放弃。
- 自己在 Himawari 里另写一层重试循环：Pi 的模型层已经有官方的同样做法，不重复造。
- 只加日志不重试：Andy 没选。
- 不改：用户每次遇到偶发限流都要手动重发，放弃。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 偶发的 429/503 对用户不可见，最多多等几秒。
- 被拒绝的响应没有生成内容，不记用量，所以一次调用仍只记一份用量；准入和预算按调用算，没有变。
- Pi 的请求层重试也包括连接错误。直连服务方时，连接在服务方已处理请求之后断开，可能让同一个请求再生成一次；OpenAI、Anthropic 的官方 SDK 默认也这样做，我们接受这个风险，用量仍按一次调用只记一份。走 Vercel 网关时观察器不会真的再发，直接重抛原来的错误。
- 压缩摘要请求也走同一个请求函数，一并重试；它的失败原因仍按状态码归类。
- 持续限流时多发最多 2 次请求，每次都带上同一份遮盖后的内容。
- 测试：`packages/application/test/model-egress.unit.test.ts` 的 `[RETRY-429]`（重发字节相同、只上报一次；被拒绝后重发再抛同一个拒绝、只上报一次；不同请求体、自带请求体的请求对象不沿用记忆的反向用例）；`prompt-prefix.compat.test.ts` 里真实 Pi + 真实遮盖的遮盖重发用例；`provider-rejection-observation.unit.test.ts`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[ADR-0198]`（持续 503 时重发的请求字节完全相同、历史里没有 `context_edit`、下一轮仍以第一轮开头）、`[RETRY-429]` 及其反向用例（等待超过上限立刻失败）；`gateway-observation.unit.test.ts`。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0198](0198-upgrade-pi-to-1-5-0.md)
- [Pi 二次开发规范](../pi-development-guide.md#pattern-settings)
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)

[↑ 返回阅读导航](#contents)
