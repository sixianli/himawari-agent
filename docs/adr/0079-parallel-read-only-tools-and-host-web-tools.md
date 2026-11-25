---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0031-isolated-tool-execution.md, docs/adr/0071-replaceable-web-search-and-fetch-providers.md"
date: "2026-10-26"
covers: "apps/agent-service/src/web-tool-run.ts, packages/platform-node/src/public-web-egress.ts, packages/platform-node/src/web-provider-failure.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-sandbox/src/public-egress-address.ts, test/integration/web-content-limits.test.ts, test/integration/web-provider-shared-connection.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0079：同一轮的只读工具并行执行，联网搜索和读网页在服务进程执行

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0031、0071 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [2026-10-26 补充：读网页和搜索的内容大小与失败原因](#content-limits)

<a id="context"></a>

## 背景

2026-10-25 生产上一条“查新闻”的请求用了 48.2 秒。排查结果：模型本身之外，我们自己的程序约占 24.3 秒。最大的两块是：

- 每次 `web_search`（联网搜索工具）都要经过沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境）：签发一次性执行凭据、启动 Worker（受限执行进程）、经任务宿主和出口代理发请求，单次搜索的沙箱开销约 8 秒，其中授权核对一轮约 14 次。
- 模型在同一次回复里发出的多个工具调用（一个“批次”）被逐个执行。Himawari 给每个工具都标了 `executionMode: "sequential"`（Pi 的执行方式开关，`sequential` 表示一个接一个执行），Pi 只要发现批次里有一个工具是 `sequential`，整批就串行执行，两次搜索只能排队。

主流做法：Claude Code 的沙箱只包住 shell 命令，读文件、联网搜索、读网页这类工具不进沙箱（[Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)）；模型在一次回复里发出多个工具调用时，可以并行执行这些调用（[Claude 工具调用文档：并行工具调用](https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use)）。Pi 0.84.2 的默认执行方式也是并行：批次里所有工具都不是 `sequential` 时，先逐个做调用前检查，再同时执行，最后按模型原来的调用顺序交回结果。

Andy 2026-10-26 的决定（原话）：

> 一轮中 多工具执行的话，学习 claude 的做法，并行执行。
> 沙箱的开启策略和复用策略必须重新设计，现在太慢了
> 授权核对这里，使用行业内最佳实践来做
> 搜索不放在沙箱执行
> 授权核对的最佳实践你先调研清楚，给我个最佳方案

本 ADR 只记录第一句和第四句：只读工具并行执行、搜索不进沙箱。沙箱启动和复用策略、授权核对做法等 Andy 确认方案后另行决定。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **`web_search` 和 `web_fetch`（读网页工具）在服务进程里执行，不再进沙箱。**
   - 授权步骤不变：照旧先做输入检查、产品授权（含联网搜索开关的设置 revision 检查）和披露检查，命中主机缓存时同样不跳过授权。授权通过后不再签发执行凭据、不启动 Worker，由服务进程直接调用供应商链（Exa、DeepSeek），执行前后各确认一次本轮仍然有效。
   - 出口限制改由服务进程自己的网络出口检查承担（`packages/platform-node/src/public-web-egress.ts`）：只允许 `https`，只允许配置里供应商的固定主机和端口（例如 `mcp.exa.ai:443`、`api.deepseek.com:443`）；连接前解析出的所有地址都必须是公网地址，判断规则与沙箱出口代理共用（`packages/runtime-sandbox/src/public-egress-address.ts`）。
   - 服务启动时只创建一个网络连接池（`createPublicWebDispatcher` 返回的 undici `Agent`，在进程里保持并反复使用 HTTPS 连接的对象），所有搜索和读网页供应商都通过它发请求，后面的调用复用已建立的连接，不再每次重新握手。2026-10-26 Andy 在方案文档里要求（原话）：“这里要做到：即使以后换成了别的网络搜索和fetch客户端也要保持这个特性”。因此连接池是供应商构造的必填参数（`WebProviderDispatcher`），新供应商不接这个参数就无法通过类型检查；只有暂时保留的沙箱程序显式传 `SANDBOX_PROXY`，改走沙箱出口代理。`test/integration/web-provider-shared-connection.test.ts` 对 `WEB_PROVIDERS` 里登记的每个供应商检查：请求都经过传入的连接池，第一次调用之后的搜索和读网页不再新建连接；新登记的供应商没有对应的测试替身时测试失败。
   - 供应商密钥仍从主机密钥目录按配置里的引用和版本读取，只在本次调用的内存里使用，不写入工具结果或日志。
   - 结果保存为本次调用的 `host-result`，服务重启后的恢复直接读它，不会重发请求。工具结果的格式、失败说明、缓存和熔断规则与原来的沙箱程序完全一致：两边共用同一段代码（`apps/agent-service/src/web-tool-run.ts`）。沙箱程序 `web-search-main.js`、`web-fetch-main.js` 暂时保留，因为已部署的安装绑定引用它们。
2. **同一批次里的只读工具并行执行。**
   - 产品在工具描述里用 `executionMode: "parallel"` 标出可以并行的工具，只有在服务进程里执行的只读工具才会被标出：`read`、`ls`、`find`、`grep`（服务进程只读执行可用时）和 `web_search`、`web_fetch`（服务进程联网执行可用时）。其余工具，包括 `write`、`edit`、`bash` 和所有走沙箱的工具，仍是 `sequential`。批次里只要有一个 `sequential` 工具，整批照旧串行，所以会改动文件或启动命令的工具不会和别的工具同时执行。
   - 运行层（`packages/runtime-pi/src/pi-runtime-adapter.ts`）拒绝把 `write`、`edit`、`bash` 标成并行，这种配置在创建会话前就让本轮失败。
   - 并行批次的恢复记录：Pi 在整批都执行完之后才把结果写入对话，所以并行批次执行中保存的恢复记录里没有已完成的结果，记录里注明 `parallel: true`。恢复时整批重新进入执行，已经完成的调用由各自保存的 `host-result` 直接返回，不会重新访问文件或供应商。恢复时会再核对一次：当前会话的工具确实会让这一批并行执行，否则拒绝恢复，防止串行批次里会改动状态的调用被当成可重放。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0031、0071 的关系

- [ADR 0031](0031-isolated-tool-execution.md) 要求可能访问网络的工具默认在隔离执行环境执行。本 ADR 把 `web_search` 和 `web_fetch` 列为例外：它们只向配置里固定的供应商发出经过授权的请求，不执行模型提供的代码，出口由服务进程的出口检查限制。其他会联网、启动进程或写文件的工具仍按 ADR 0031 执行。
- [ADR 0071](0071-replaceable-web-search-and-fetch-providers.md) 写的是“授权通过之后、发给沙箱之前”使用主机缓存，并由沙箱程序访问供应商。本 ADR 起，访问供应商改在服务进程；供应商链、回退、缓存、熔断和“一次同意覆盖整条链”的规则不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **一次搜索带多个关键词（批量查询）**：不采用。它要改工具参数和模型提示，只对搜索有效，读文件、读网页仍然排队；按 Andy 的决定改为通用的并行执行。
- **保留沙箱，只把同一轮的搜索复用一个已启动的沙箱**：不采用作为本次方案。复用只能省掉启动部分，执行凭据签发和多轮授权核对仍在；沙箱启动和复用策略的整体重新设计另行决定。
- **所有工具都按 Pi 默认并行**：不采用。写文件、执行命令会互相影响，并且现有的审批暂停和结果未知恢复只按串行批次设计。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：一次联网搜索不再有约 8 秒的沙箱开销；同一批次里的多个只读调用同时执行，总耗时接近其中最慢的一个。实际速度在上线后实测记录。
- 限制：服务进程联网执行时不经过沙箱的输出上限（`maxOutputBytes`），结果大小只受供应商适配器自己的上限约束（搜索条数上限、读网页的 `maximumBytes`）。
- 限制：Pi 的工具循环检查在调用执行后才更新，并行批次里的调用在执行前已全部通过检查，所以同一批里重复的只读调用不会被中途拦下；下一次模型请求照旧会被拦。重复的搜索和读网页由主机缓存直接返回。
- 并行批次中某个调用进入审批等待时，本轮暂停，同批其他正在执行的调用会被中止；批准后整批重新执行，已完成的调用直接返回保存的结果。
- 生产启用不需要改配置：服务进程在配置了 `runPolicy.publicSearch` 或 `runPolicy.publicFetch` 时自动建立联网执行；出口主机来自配置里的供应商列表。

[↑ 返回阅读导航](#contents)

<a id="content-limits"></a>

## 2026-10-26 补充：读网页和搜索的内容大小与失败原因

Andy 2026-10-26 在方案文档里对“保留超时和返回内容大小上限”这一句的评论（原话）：

> 这一块也要按照行业最实践来做，别因为错误或者不当的内容大小限制而影响效果或让模型搜索过多次！

改前的问题：

- 读网页一次只返回 32 KiB（生产配置 `publicFetch.maximumBytes = 32768`），没有接着读的办法，模型只能重新搜索或换网页。
- 传给 Exa 的 `maxCharacters`（按字符计的长度上限）用的是字节数，截断按字节做，可能把一个汉字截成半个后再丢掉。
- Exa 响应超过 256 KiB、搜索文本超过 128 KiB、DeepSeek 响应超过 512 KiB 时整次调用失败，已经读到的内容全部丢掉。
- 失败时模型只看到“读取网页失败”“公开网页搜索失败”，不知道是超时、网页打不开还是服务不可用，只能盲目重试或重新搜索。

参考做法：Claude Code 自己的读网页工具带 `offset` 参数（从网页正文的第几个字符开始读），一页太长时用上一次结果给出的位置接着读。

决定：

1. **读网页一次最多 100 KiB，可以接着读。** `web_fetch` 新增可选参数 `offset`（整数，0 到 10,000,000），第一次不填。结果新增 `offset`、`truncated`；没读完时再给 `nextOffset` 和一句中文提示“用同一个 url 和 offset=… 再调用一次 web_fetch，不要重新搜索”。启动配置里 `publicFetch.maximumBytes` 的上限从 48 KiB 改为 100 KiB（`WEB_FETCH_MAXIMUM_BYTES`），`publicSearch` 的上限不变。主机缓存的键包含 `offset`，同一网页的不同段分开缓存。上线时要把生产配置的 `publicFetch.maximumBytes` 从 32768 改为 102400。
2. **按完整字符切分。** 返回的每一段都按 UTF-8 字节数装满到上限为止，从不拆开一个字符（包括表情这类占两个 UTF-16 单位的字符）；各段按顺序拼起来正好等于原网页。`offset` 的单位是 JavaScript 字符串位置，模型不需要自己算，只需原样带回 `nextOffset`。向 Exa 请求的 `maxCharacters` 是“offset + 本段字节上限 + 1”个字符：Exa 的这个参数只计正文，不计开头的标题和网址行，多要 1 个字符用来判断后面是否还有内容。DeepSeek 读网页接口没有长度参数，返回整页，由我们按同样规则切段。
3. **内容多时截断返回，不整次失败。** 搜索文本不再有 128 KiB 的整体上限，逐条解析，每条摘录仍最多 12000 字符、最多 10 条。供应商原始响应的安全上限改为按请求算：Exa 搜索 1 MiB；Exa 读网页按请求的字符数留足余量（每字符按 6 字节算再加 64 KiB，最多 16 MiB）；DeepSeek 16 MiB。只有响应超过这个安全上限时才失败，失败原因是“网页内容超过可读取的上限”。
4. **失败原因分类告诉模型，并给出下一步。** 模型看到的结果只有 `error`（错误代码）和 `message`（中文原因加建议），不含供应商名称、HTTP 状态码、供应商返回的原文或任何密钥：

   | 情况 | 读网页代码 | 搜索代码 | 给模型的建议 |
   | --- | --- | --- | --- |
   | 超时（Exa 抓取超时、DeepSeek 408/504、本地 45 秒期限到） | `WEB_FETCH_TIMEOUT` | `WEB_SEARCH_TIMEOUT` | 可以重试一次，仍超时就换来源或改短查询 |
   | 网页打不开或拒绝读取（Exa 抓取失败、DeepSeek 403/404） | `WEB_FETCH_UNREACHABLE` | — | 不要重试同一网址，换其他来源 |
   | 内容超过安全上限 | `WEB_FETCH_TOO_LARGE` | `WEB_SEARCH_TOO_LARGE` | 换更具体的页面，或把 `limit` 调小 |
   | 限流（429） | `WEB_FETCH_RATE_LIMITED` | `WEB_SEARCH_RATE_LIMITED` | 等几秒再试，不要连续重试 |
   | 服务暂时不可用（5xx、402 余额不足、网络错误、格式变化） | `WEB_FETCH_UNAVAILABLE` | `WEB_SEARCH_UNAVAILABLE` | 稍后再试 |
   | 输入不合规或供应商不支持 | `WEB_FETCH_INPUT_INVALID` / `WEB_FETCH_INPUT_UNSUPPORTED` | `WEB_SEARCH_INPUT_INVALID` / `WEB_SEARCH_INPUT_UNSUPPORTED` | 改好参数或换网址 |

   “网页打不开”和“内容超过上限”在供应商链里会换下一家试，和超时、限流一样。分类和文字在 `packages/platform-node/src/web-provider-failure.ts`，服务进程和暂时保留的沙箱程序共用。
5. **搜索结果的正文摘录不另加。** 2026-10-26 查 Exa 免费 MCP 的工具清单（`tools/list`）：`web_search_exa` 只有 `query`、`numResults`、`objective` 三个参数，没有控制摘录长度的参数，返回的每条结果已经带 `Highlights:`（正文摘录，实测常见 1000 字符以上）。DeepSeek 搜索的 `summary` 是给模型用的摘要（官方文档写通常 600 到 800 字符）；它的 `need_content` 会返回整页正文，每次搜索都要多下载最多 10 个整页，变慢，和这次提速的目标相反，所以不开。
6. **`objective` 保留。** 同一次查询的工具清单把 `objective` 列为 `web_search_exa` 的必填参数（`required: ["query", "objective"]`），去掉会让请求不合规。
7. **超时和搜索次数不变。** 整条供应商链仍共用 45 秒期限；不限制模型的搜索次数。

验证：`test/integration/web-content-limits.test.ts` 经服务进程联网执行入口（`createProductionHostWeb`）和本地 HTTP 测试替身覆盖 Exa 和 DeepSeek：一页约 0.9 MB 的中英文和表情混排网页分段读完后拼回原文、每段不拆字符且装满；超过旧上限的内容截断返回；九种失败各自给出对应代码和建议且不带供应商细节。

[↑ 返回阅读导航](#contents)
