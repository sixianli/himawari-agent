---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "packages/application/src/services/execution-live-feed.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0138：回答文字边写边推给网页，过程记录写入后立刻通知

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 2026-10-31 在生产第二十二版上发现，回答是写完后一整块出现的，不像 ChatGPT 或 Claude 那样逐字出现。

同一天在生产网页（Andy 的 Chrome）里实测了两轮长回答，页面里注入只读脚本，记录回答区字数、推送通知和每个接口请求的时间（数据见项目共享目录 streaming/measurement-20261031-prod.md）。第二轮页面自报“写回答 1261 字 7.4 秒”。这 7.4 秒里网页收到 19 次“有变化”通知，也发了过程记录查询，但回答区一个字都没显示，结束时一次出现 1229 字。

原因有两层，都已对照代码确认：

1. 文字本来就不是推给网页的。服务端把模型每段输出存成整条消息的快照，再由推送循环（`product-thread-gateway-adapter.ts` 的 `watchExecution`）每 500 毫秒查一次数据库，有新记录才通知网页“有变化”，通知里没有文字。网页等 80 毫秒后发请求，把记录拉回来。
2. 拉回来的结果被丢掉了。网页的过程记录查询要 2.7–3.8 秒才返回，返回时拿“对话详情刷新编号”判断结果是否过期；详情约每秒刷新一次，编号每次加一，所以写作期间每次查询都被当成过期丢弃，缓存不更新，下一次又从头读，越读越大（5.1、11.1、15.3 KB）。只有这一轮写完、详情不再刷新后，最后一次查询才被采用。

只修第 2 层，字会每隔“0.5 秒加一次查询”跳一次，仍然不像逐字。Andy 2026-10-31 17:16 JST 说“要做就做彻底一点，体验要做到和其他的大厂要一样”，随后同意“彻底版”。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

只核对到 API 层；两家网页产品内部怎么做没有一手出处，不作依据。

- Anthropic 流式文档（https://platform.claude.com/docs/en/build-with-claude/streaming ，2026-10-31 打开）：“you can set `"stream": true` to incrementally stream the response using server-sent events (SSE)”。每个内容块有 “a `content_block_start`, one or more `content_block_delta` events, and a `content_block_stop` event”，文字、思考和工具参数都以增量在同一条流里推出。
- OpenAI 流式文档（https://developers.openai.com/api/docs/guides/streaming-responses ，2026-10-31 打开）：“HTTP streaming (`stream=true`) over server-sent events (SSE)”，文字增量事件是 `response.output_text.delta`。
- 渲染节流：MDN `requestAnimationFrame`（https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame ）说回调在 “before the next repaint” 调用，频率 “will generally match the display refresh rate”。Vercel AI SDK 排错页（https://ai-sdk.dev/docs/troubleshooting/react-maximum-update-depth-exceeded ）的示例是 “Throttle the messages and data updates to 50ms”，理由是每段都重绘会让 Markdown 之类的渲染过载。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **文字直推。** 新增一个进程内的实时消息源 `ExecutionLiveFeed`（`packages/application/src/services/execution-live-feed.ts`）。Pi 运行时每收到一段文字（`text_start`、`text_delta`、`text_end`），就把这条消息到此为止的全文交给它（`PiAgentRuntimeAdapterDependencies.onAssistantText`）。消息源算出“这次比上次多出来的字”和它的起始位置，推送循环用新的事件 `thread.execution_text`（字段 `itemId`、`offset`、`text`）经已有的 SSE 连接推给网页。
2. **推出去之前先脱敏。** 消息源用和落库记录相同的 `redactTracePayload` 脱敏，并用 `machineSecretHoldStart`（原 `pi-model-transport.ts` 里的扣尾逻辑，移到共用文件，现在在 `packages/sensitive-capture/src/machine-secrets.ts`）把末尾像密钥开头的部分先扣住，等下一段到了再判断，所以被拆成两段到达的密钥也推不出去。
3. **新记录立刻通知。** 运行时写入过程记录（`TraceStorePort.appendNext`）后立刻叫醒推送循环，不再等 500 毫秒；没有新记录时仍按 500 毫秒检查一次，作为后备。
4. **网页按帧显示。** 网页把收到的增量接在当前文字后面，用 `requestAnimationFrame` 每帧最多刷新一次。位置对不上（中间漏了一段）时不猜，改为拉一次记录。显示时取“推来的文字”和“落库记录里的文字”中较长的一份；这一轮结束后只认落库的最终回答。
5. **查询结果不再被详情刷新判过期。** 过程记录查询改用独立的编号，只在切换对话、换连接、新建对话时作废。
6. **不变的：** 落库、审计、脱敏规则、提示词和上下文拼装都不动，所以对 KV 缓存（模型服务端对相同前缀的复用）没有影响。

用户主权、边界可逆这两条原则这里不受影响；这个决定服务的是“主动效率”里的速度，同时没有降低记忆和记录的可靠性，因为权威记录仍是落库的快照。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **只修丢弃问题。** 改动最小，但字仍然每 0.5 秒以上跳一次，达不到 Andy 要的体验。
- **把轮询间隔缩到 50 毫秒。** 每个打开的页面每秒 20 次数据库读，生产机已经出过数据库排队的事故（I-36、I-45），不可取。
- **每次推整条全文。** 实现最简单，但长回答每帧都发一遍全文，流量随长度平方增长；改为推增量加位置，位置对不上时退回拉取。
- **过程区每条记录也直接推内容。** 需要把过程记录的投影逻辑复制一份到推送路径；现在改为写入后立刻通知加增量拉取，延迟已降到一次请求往返，先不复制。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 推送连接上会多出很多小事件。推送循环在网页读得慢时自动把同一条消息的连续增量合并成一个事件，不会无限堆积。
- 服务重启时进行中的文字状态丢失，重连后网页靠拉取补齐，这一轮结束后以落库为准。
- 这次没有在生产上复测，上线后用同一个页面脚本复测，对比服务端写字时间和网页显示时间。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [事故与门槛清单 I-49](../incidents-and-gates.md#incidents)
- [工程案例库 案例 75](../engineering-casebook.md)
- [ADR 0131：读请求走独立只读连接](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0131-read-lane-separate-readonly-connection.md)

[↑ 返回阅读导航](#contents)
