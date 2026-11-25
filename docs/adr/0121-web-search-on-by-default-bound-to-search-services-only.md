---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "apps/agent-service/src/public-search-authorization.ts, scripts/delivery-mode/browser-acceptance-gate.py, test/integration/product-path-browser.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0121：联网搜索默认打开、不再逐次询问；开关只跟搜索服务的地址绑定，换模型不再让它失效

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 Andy 在 iPhone 上问天气时被"搜索网页"审批卡打断（[事故 I-29](../incidents-and-gates.md#incidents)），之后问"多个网页搜索这里，大厂的最佳实践是？"。审批线程查了各家的官方文档（只读，没有调用模型）：

- ChatGPT 在需要最新信息时自动搜索，答案带来源；它的代理只在不好撤回、涉及钱或账号的操作前请用户确认（[ChatGPT 联网搜索帮助](https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt)、[cloud browser 帮助](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)）。
- Claude 网页版"Claude searches the web when it helps"，每个回答都带引用（[Claude 帮助中心](https://support.claude.com/en/articles/10684626-enable-and-use-web-search)）。
- Gemini 的模型"automatically generates one or multiple search queries and executes them"（[Gemini API 文档](https://ai.google.dev/gemini-api/docs/generate-content/google-search)）。
- Claude Code 默认要批准搜索，但"以后不再问"在这个项目里永久生效（[Claude Code 权限文档](https://code.claude.com/docs/en/permissions)）。

Andy 当天在审批线程的选择卡上选了"默认打开，从不问"。

同一天 Andy 还发现：他一直在设置里开着"允许联网搜索"，在手机上却发现是关着的。代码核对（`apps/agent-service/src/public-search-authorization.ts`）的结果：开关本来就存在服务端，手机和电脑读的是同一份；但开关存下时记了一个摘要，摘要里有每个能读私人数据的模型的完整配置（`configuredModelDisclosureIdentity`，模型配置整段 JSON 的 sha256）。只要模型配置有任何变化，例如第十九版把主模型换成 Magpie 路由组（[ADR 0117](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md)），摘要就对不上，开关在所有设备上一起悄悄变成"关"，页面上没有任何说明。生产当时的开关状态没有读（读生产数据要 Andy 另行同意），"第十九版换模型导致失效"是根据代码的推断。

<a id="decision"></a>

## 决定

1. **默认打开。** 主人从没动过这个开关时，联网搜索和读网页视为已允许，符合配置的搜索不弹审批卡。第一次真的用到时，服务把"默认打开"写进开关记录（`search.authorization.default` 命令，记录里 `actorId` 为 `default`），并写一条 `search.authorization.enabled` 审计，之后每次搜索照旧从开关派生一次性授权并记下来源版本，撤销后已派生的授权一起作废。没有服务租约的调用方（只读查询）不写记录，只按默认值显示"开着"。
2. **开关只跟搜索服务的地址绑定。** 开关记录存"同意时的搜索服务地址列表"（`recipients`，排过序），判断开关是否有效时只比这份列表和当前配置的搜索、读网页供应商地址。模型配置怎么变都不影响开关。每次搜索仍核对请求里的接收方包含一个当前配置的、可读私人数据的模型，这一条不变。旧记录里的 `bindingDigest` 不再使用；旧记录本来就存了 `recipients`，升级后按新规则直接生效，不用重新同意。
3. **搜索服务换了地址才关，并说明原因。** 主人同意过的地址列表和当前配置不一致时（例如加了 DeepSeek），开关显示为关，读接口返回 `providersChanged: true`，设置里开关下面写明"搜索服务换了地址，你还没同意过，所以先关上了"，并列出新地址。这时搜索会照旧弹审批卡，卡上"记住我的选择"或设置里打开开关都会把新列表记为已同意。主人自己关掉的开关不提示，也不会因为配置变化被自动打开。
4. **不可撤回的操作照旧逐次确认。** 本决定只针对联网搜索和读网页这两个只读、没有副作用的工具；付款、发邮件、改文件、执行命令等仍按原有审批规则。
5. **上线走查改成先验默认打开。** `test/integration/product-path-browser.test.ts` 的场景顺序改为：`accept-news-search`（全新安装下搜索直接出结果，页面不出现任何审批卡）→ `accept-search-toggle`（设置里开关默认是开的，关掉后读回为关）→ `accept-search-approval`（关着时一步两次搜索只出一张卡，批准后 10 秒内出回答）→ `accept-after-restart`（重启后开关仍是关的，再打开后搜索直接出结果）。场景名不变，出包检查 `scripts/delivery-mode/browser-acceptance-gate.py` 不用改。

本决定依赖[产品愿景](../product-vision.md)里的"主动效率"：只读搜索每次都问，打断主人却不增加安全。它和"边界可逆"的取舍是：主人随时能在设置里关掉；数据会发往的服务地址一变就停下来等主人看过，这一条守住"用户主权"。

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 默认打开、不逐次询问（本 ADR） | 与 ChatGPT、Claude、Gemini 一致；问天气不再被打断 | 新安装的实例会把查询词发给配置里的搜索服务，主人要关得去设置 | Andy 10-30 选定 |
| 默认关、第一次问一次、记住选择（原做法） | 首次使用前主人一定看过发往哪里 | 开关一失效就又开始问；Andy 已明确不要 | 不选 |
| 每轮问一次 | 每轮都可控 | 最打断；没有一家大厂这样做 | 不选 |
| 开关继续绑定模型配置，换模型时页面提示 | 换模型也让主人知情 | 模型配置会随路由、版本号频繁变，每次都要重新打开；搜索结果交给模型和交给搜索服务是两件事，前者已由"模型能读私人数据"的配置把关 | 不选 |
| 换搜索服务时也自动沿用 | 永远不打断 | 查询词会悄悄发到主人从没见过的地址，违反"用户主权" | 不选 |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：问天气、查新闻不再弹卡；换模型或改路由不会再把开关悄悄关掉；开关状态在服务端，手机和电脑网页看到的一致。
- 代价：全新安装的实例第一次搜索时就把查询词发给配置的搜索服务（目前是 Exa 公开接口）；设置里写明发往哪些地址，主人可以随时关。
- 已上线的实例：主人原来开着的开关在升级后恢复为开（旧记录的地址列表没变）；主人原来手动关掉的，升级后仍是关。
- 后续：生产当前开关记录的实际内容等上线后经 Andy 同意再只读核对。全站其他只存在浏览器里的设置（语言、外观等）由"让所有用户设置各端同步"线程另行处理，不在本 ADR。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0071：联网搜索和读网页改为可替换的供应商链](0071-replaceable-web-search-and-fetch-providers.md)（"供应商列表一变必须重新同意"在本 ADR 中保留）
- [ADR 0079：并行只读工具和宿主侧网页工具](0079-parallel-read-only-tools-and-host-web-tools.md)
- [ADR 0117：Magpie 经自有订阅路由模型](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md)
- [事故与门槛清单：I-29、I-34](../incidents-and-gates.md#incidents)
- [工程案例库：案例 62](../engineering-casebook.md#case-approval-stall)
- [架构文档：已授权公开搜索与聊天执行反馈](../architecture-v0.1.md)（产品需求 v0.2 里“开启后不逐次询问搜索”的说法仍然成立，未改）

[↑ 返回阅读导航](#contents)
