---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
---

# ADR 0207：压缩摘要请求沿用原对话的开头，吃到缓存

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Pi（Himawari 用的模型运行库）的自动压缩会另外发一次模型请求，把较早的历史总结成一段摘要。这个请求原来把历史序列化成一条新的用户消息，系统提示换成 Pi 自己的一份，也不带工具，所以请求开头和原对话完全对不上，整段历史按未命中价计算；规则文件 `.agents/instructions/prompt-prefix.md` 第 13 条要求压缩请求沿用原对话的系统提示和工具，一直是“已知差距”。

第一步（PR 346，[事故 I-92](../incidents-and-gates.md#incidents)）先修了更严重的问题：按对话冻结工具时，这个不带工具的摘要请求被我们自己的流函数包装拦下，压缩一次都发不出去。这份 ADR 是第二步：让摘要请求和原对话共用开头。来源：Andy 的待办 BL-20261109-8w6ct3，方案由两个模型各自出方案、再互审（记录在 `.agents/reviews/topic-compaction-cache/`）。

<a id="premises"></a>

## 前提

1. Pi 1.5.0 的压缩请求固定 `cacheRetention: "none"`，并把历史序列化成一条用户消息：`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js` 的 `completeSummarization`（“Avoid cache writes for one-off summaries”）和 `generateSummaryWithUsage`（“Serialize conversation to text so model doesn't try to continue it”）。
2. `session_before_compact` 钩子的事件带 `preparation`（含 `isSplitTurn`、`firstKeptEntryId`）、`branchEntries` 和 `reason`：同一包 `dist/core/extensions/types.d.ts` 的 `SessionBeforeCompactEvent`；返回空则走默认压缩（`agent-session.js` 的 `_runAutoCompaction`，`extensionResult?.compaction` 为空就继续默认流程）。
3. `buildSessionProjection(branchEntries)` 返回按顺序排列的投影条目，`prepareCompaction` 就是用它算出要总结的消息：`compaction.js` 的 `prepareCompaction`（“const projection = buildSessionProjection(pathEntries)”），`buildSessionProjection` 和 `convertToLlm` 都从包入口导出（`dist/index.d.ts`）。
4. Himawari 的所有 Pi 模型请求都经 `packages/runtime-pi/src/pi-runtime-adapter.ts` 的 `governedModelRuntime` 包装，进入 `admitPiStream`（预算准入、出口遮盖、用量记录）。
5. Claude Code 压缩时“exact same system prompt, user context, system context, and tool definitions as the parent conversation. We prepend the parent's conversation messages, then append the compaction prompt as a new user message at the end”（https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/）；Anthropic API 文档“Send the same `system` prompt and `tools` that you use for the rest of the conversation.”，并说摘要调用“reads the tool definitions but never runs a tool”（https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand）；OpenAI Codex 把总结指令作为最后一个输入项记到历史克隆后面（https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/compact.rs）。
6. DeepSeek 价格每百万 token：缓存命中 $0.003，未命中 $0.15（https://api-docs.deepseek.com/quick_start/pricing/）。

<a id="decision"></a>

## 决定

1. **用一个只观察的 `session_before_compact` 钩子算出摘要范围，不替换 Pi 的压缩流程。**钩子（内联扩展 `himawari-compaction-prefix`）用 `buildSessionProjection(branchEntries)` 取出切点（`firstKeptEntryId`）之前的全部消息，经 `convertToLlm` 转成发给模型的格式，去掉 system 消息（请求开头由 Himawari 自己的冻结开头提供）。只在 `reason` 是 threshold 或 manual、`isSplitTurn` 为假时处理；溢出（overflow）时上一次请求本身就可能超过窗口，拆分轮要另写一份“轮前缀”摘要，这两种都不处理，走 Pi 默认请求。
2. **改写摘要请求，而不是自己发请求。**流函数包装发现压缩期间的无工具摘要请求时，若上一次普通请求的前几条历史消息和钩子算出的范围逐条完全相同，就把摘要请求换成：上一次普通请求的系统提示、完整工具定义（含执行句柄工具）、这几条历史消息，末尾追加一条用户消息（指令放进 `packages/prompt-catalog`，条目 `runtime.compaction.summary-instruction`），指令写明“不要继续对话、不要调用工具、只回复结构化摘要”。对不上、窗口放不下（估算输入（历史、系统提示、工具定义和指令）加输出上限加 4096 余量超过窗口）、没有上一次普通请求，一律不改写，走 Pi 默认请求，不比现状差。
3. **请求参数和主对话一致。**会话编号沿用上一次普通请求的（Magpie 会话亲和）；不传 Pi 固定的 `cacheRetention: "none"`，改沿用上一次普通请求的设置；模型、推理强度、输出上限仍是 Pi 给的。仍走同一个 `admitPiStream`，预算准入、出口遮盖、窗口检查都照旧。
4. **摘要请求的用量记为 `other`，不是 `chat`，**不混进对话缓存命中率告警；命中的缓存 token 记在用量表里，可以单独看压缩请求的命中情况。
5. **测试：**`packages/runtime-pi/test/prompt-prefix.compat.test.ts`（属于 `npm run check:prompt-prefix`）里 `[COMPACT-2]` 两组：端到端一条（摘要请求的工具定义、系统提示和切点前的历史与上一次普通请求相同，包含第一轮、不含切点后的第二轮，末尾是指令，用量记 `other`；撤掉改写，这条失败）；`sharedSummaryContext`、`sharedSummaryOptions` 的单元用例（历史对不上、没有上一次请求、窗口放不下各一条反向用例；会话编号和缓存设置取自上一次普通请求）。`[COMPACT-1]` 只断言摘要请求里至少有一条没有共享开头（走了 Pi 默认请求），证明摘要请求在冻结工具下发得出去；它不证明同一轮里还有改写的请求，也不证明退回的原因；`[COMPACT-3]`：改写后的摘要请求若返回工具调用，不执行任何工具，并写 `PI_COMPACTION_FAILED`。拆分轮、溢出、钩子里切点找不到这几种退回，没有单独的用例，留作后续补测。
6. **压缩期间一律拒绝工具执行。**摘要请求带着完整工具，模型若回工具调用，产品侧的工具入口（`assertKnown`）在 `compaction_start` 到 `compaction_end` 之间直接抛 `RUNTIME_TOOL_EXECUTION_STOPPED`，不依赖 Pi 的摘要路径恰好不执行工具。`runtime-event-contract.unit.test.ts` 的 `[COMPACT-3]` 用例直接验证：压缩开始后执行工具被拒，压缩结束后恢复；撤掉这个判断，该用例失败。`prompt-prefix.compat.test.ts` 的 `[COMPACT-3]` 只证明端到端下没有产品工具被执行并写 `PI_COMPACTION_FAILED`，不区分是 Pi 没执行还是这道防线拦住。防线不会卡住后面的工具，已在 Pi 1.5.0 源码核实（`@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-44DLKSKE.js`，压缩过的单行文件，搜 `compaction_start`）：手动压缩 `compact()` 在发出 `compaction_start` 之后，成功路径发 `compaction_end`，`catch` 里（失败、被中止、被扩展取消）也发 `compaction_end`，`finally` 清理状态；自动压缩 `_runAutoCompaction()` 先置 `started=true` 再发 `compaction_start`，之后任何抛错都进 `catch`，`started` 为真就发 `compaction_end`（带 `aborted` 和 `errorMessage`）。`compacting` 变量属于单次运行，不跨运行。
7. **日志：**每次摘要请求写一条服务日志 `compaction.summary_request`，带 `sharedHead`（是否用了共享开头），生产里可以直接统计命中改写的比例。

<a id="industry"></a>

## 业界怎么做

Claude Code、Anthropic API 的服务端压缩、OpenAI Codex 都是同一个做法：压缩请求用原对话的系统提示、工具和历史做前缀，只在末尾追加“请总结”（见前提 5）。我们放弃的只有一点：Claude Code 把整段历史都放进压缩请求，我们和 Anthropic“保留最近几轮”那一页一样，只放切点之前的旧消息，切点之后的消息 Pi 原样保留。

<a id="options"></a>

## 放弃的做法

- **自己在 `session_before_compact` 里发请求并返回摘要。**要自己重做 `compact()` 里的文件操作列表、拆分轮、重试，而且返回的压缩会被 Pi 标成 `fromHook`，文件操作列表不再带到下一次压缩。改写 Pi 自己发出的请求更小，Pi 的压缩流程原样保留。
- **等 Pi 上游的 `cacheFriendly` 选项。**上游提交 cff1cf5 有类似的基础函数，但不在锁定的 1.5.0 里，也没有接上。以后 Pi 提供了，这个改写就可以去掉。
- **为了命中缓存改回不压缩或改压缩阈值。**阈值是第三步（按模型配置触发点）的事，和这件事无关。

<a id="consequences"></a>

## 后果

- 一次压缩要读的前缀（约窗口减保留的近期部分）从按 $0.15 每百万计价，变成按 $0.003 每百万计价：窗口 100 万时每次压缩约省 $0.14，按每月至多 2 次算每月省不到 $0.3（估算，生产压缩次数未核实）。更实际的好处是 96 万 token 的请求不再冷启动，等待时间短很多（未测量）。
- 摘要请求里的工具调用和工具结果是结构化的原文，不再被 Pi 序列化时截断到 2000 字符，摘要请求可能比原来大；放不进窗口时不改写。摘要质量会因为请求形式变化而变，需要付费评测才能比较，评测只在 Andy 同意后做。
- 压缩成功后，下一次普通请求的开头会变一次（规则第 12 条允许的压缩例外），这一点没有变。
- 模型可能忽略“不要调用工具”而返回工具调用：Pi 把没有文字的摘要当作失败，失败经 `PI_COMPACTION_FAILED` 写日志，不改变对话内容。

<a id="references"></a>

## 关联文档

- [模型请求的 KV 缓存规范](../kv-cache-guide.md)
- [规则文件：发给模型的内容](../../.agents/instructions/prompt-prefix.md)
- [ADR 0165](0165-freeze-the-request-head-per-conversation.md) 第 7 条“压缩请求原样放行”：本 ADR 之后，压缩期间的无工具摘要请求在条件满足时改写成共享开头，其余仍原样放行；“上一次普通请求”指上一次已通过检查、即将发出的普通请求
- [事故与门槛清单](../incidents-and-gates.md)（I-92）
- [BL-20261109-8w6ct3](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261109-8w6ct3-compaction-request-reuses-conversation-head.md)
