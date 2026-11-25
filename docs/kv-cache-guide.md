---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-05"
covers: ".agents/instructions/prompt-prefix.md, apps/agent-service/src/cache-hit-monitor.ts, apps/agent-service/test/__prompt_golden__/memory.conversation-review.txt, packages/application/src/ports/model-usage.ts, packages/application/src/services/model-egress.ts, packages/application/src/services/perception-extraction.ts, packages/prompt-catalog/src/trusted.ts, packages/runtime-pi/src/configured-model-binding.ts, packages/runtime-pi/src/egress-context.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, packages/runtime-pi/test/prompt-prefix.compat.test.ts, packages/runtime-pi/test/runtime-environment-block.unit.test.ts, packages/sensitive-capture/src/redaction.ts, test/integration/production-http-composition-process.test.ts, test/integration/thread-prompt-bundles.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# 模型请求的 KV 缓存规范

<a id="contents"></a>

这份文档是 Himawari 组装“发给模型的请求”时的最佳实践。它写三样东西：每条做法是什么、为什么（附一手来源原话），以及 Himawari 现在做到了没有。开发时必须遵守的条目另写在 [.agents/instructions/prompt-prefix.md](../.agents/instructions/prompt-prefix.md)，两份的条目编号一致。

KV 缓存，也叫提示缓存（prompt cache）：模型服务方把“请求开头完全相同的部分”缓存起来。下一次请求的开头只要和上一次逐字节相同，这部分就不用重新计算，速度更快，费用通常只有正常输入价的一成左右。匹配是逐字节的：开头任何一处变了，从那里往后的内容全部按全价重算。

Andy 在 2026-11-05 要求把这些做法整理成最佳实践，用来指导 Himawari 的开发。他当天同意了两处规则改动：

- 遮盖规则加一个例外：主人点名的秘密在这条消息里处处都遮；
- 写明系统提示和工具“按对话冻结”。

**怎么维护这份文档。**谁改了缓存相关的行为，谁就在同一个 PR 里更新下面的“Himawari 现状”一栏和“已知差距”，并在“改动记录”里加一行；修好一项已知差距时，把它从“已知差距”移到对应条目的现状里。这样文档始终和代码一致，不需要等发版后再集中补（Andy 2026-11-05 同意）。

目录：

1. [一手来源](#sources)
2. [做法、理由和现状](#practices)
3. [已知差距](#gaps)
4. [怎么检查](#gates)
5. [改动记录](#changes)

<a id="sources"></a>

## 一手来源

| 代号 | 来源 | 原话（节选） |
|---|---|---|
| S1 | [Anthropic 提示缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | “Cache hits require 100 percent identical prompt segments”；“the cache follows the hierarchy: `tools` → `system` → `messages`. Changes at each level invalidate that level and all subsequent levels.”；“Changing thinking parameters … invalidates cached message prefixes”；“Changes to `tool_choice` or the presence/absence of images anywhere in the prompt invalidate the cache”；“a cache entry only becomes available after the first response starts”；“Cache read tokens are 0.1 times the base input tokens price” |
| S2 | [OpenAI 提示缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching) | “Keep the prefix stable.”；“Append new messages rather than rewriting earlier turns.”；“Preserve tool definitions, ordering, and schemas.”；“Set `tool_choice` to `"none"` instead of removing the tool definitions.”；“Put stable developer instructions and shared reference material first.”；“use a stable `prompt_cache_key` … to help route related requests to the same cache.”；“Compare total input cost before and after compaction” |
| S3 | [DeepSeek 上下文缓存文档](https://api-docs.deepseek.com/guides/kv_cache) | “enabled by default for all users”；“A subsequent request can only hit the cache if it fully matches a cache prefix unit.”；“does not guarantee a 100% cache hit rate” |
| S4 | [Gemini 缓存文档](https://aistudio.google.com/docs/caching) | “Try putting large and common contents at the beginning of your prompt”；“Try to send requests with similar prefix in a short amount of time” |
| S5 | [Claude Code 工程文章：Prompt caching is everything](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/) | “static content first, dynamic content last”；“we add a <system-reminder> tag in the next user message or tool result with the updated information”；“Changing the tool set in the middle of a conversation is one of the most common ways people break prompt caching.”；“When we run compaction, we use the _exact same_ system prompt, user context, system context, and tool definitions as the parent conversation.”；“we run alerts on our prompt cache hit rate and declare SEVs if they're too low.” |
| S6 | [Claude Code 提示缓存文档](https://code.claude.com/docs/en/prompt-caching) | “each model has its own cache”；编辑 CLAUDE.md “does not invalidate the cache, but the edit also doesn't apply”；“the resumed conversation keeps the system prompt it started with” |
| S7 | [Manus 工程文章：Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | “Make your context append-only.”；“Ensure your serialization is deterministic.”；“A common mistake is including a timestamp … at the beginning of the system prompt.”；“avoid dynamically adding or removing tools mid-iteration.”；“Our compression strategies are always designed to be restorable.” |
| S8 | [Anthropic 上下文编辑文档](https://platform.claude.com/docs/en/build-with-claude/context-editing) | 清理旧工具结果“Invalidates cached prompt prefixes … clear enough tokens to make the cache invalidation worthwhile” |

[↑ 返回目录](#contents)

<a id="practices"></a>

## 做法、理由和现状

编号和 [.agents/instructions/prompt-prefix.md](../.agents/instructions/prompt-prefix.md) 一致。

| # | 做法 | 来源 | Himawari 现状 |
|---|---|---|---|
| 1 | 固定的在前，会变的在后：工具定义 → 系统提示 → 历史 → 最后一条用户消息 | S1、S2、S4、S5 | 做到 |
| 2 | 每轮会变的内容只放最后一条用户消息；系统提示和工具定义里没有会变的值 | S5、S7 | 做到（[ADR 0303](adr/0303-what-the-model-is-sent.md)：运行环境说明放在最后一条消息里，只在第一轮、内容变化时和压缩后发）；感知记录的内容只作为 `perception_read` 这一次调用的工具结果追加在末尾，不进系统提示、工具定义，也不插到更早的位置 |
| 3 | 告诉模型新情况时追加消息，不改系统提示 | S5、S6 | 做到（ADR 0164：工具循环停止、运行中压缩后补发运行环境说明都用追加消息） |
| 4 | 已发内容不改、不重排、不删，只追加 | S2、S7 | 做到（[ADR 0303](adr/0303-what-the-model-is-sent.md)）；例外四种，见规则第 4 条 |
| 5 | 存历史存实际发出去的那条 | 本项目事故 I-66 | 做到；出口遮盖除外：历史存遮盖前的内容，每次发送时确定地重新遮盖（遮盖密钥不变、前面的历史不变、对话的遮盖规则版本不变时字节相同；规则版本随冻结的提示记录固定，见 [ADR 0305](adr/0305-recognizing-and-masking-secrets.md)） |
| 6 | 系统提示和工具按对话冻结，只在规定的几种情况下换新并留记录 | S6 | 做到（[ADR 0303](adr/0303-what-the-model-is-sent.md)）；“工具参数结构变了也换新”2026-11-05 获批并已实现（只改说明文字不换新）；只在一轮运行开始时判断，运行中途不换新 |
| 7 | 工具集合尽量不变，不能用的工具由执行端拒绝，而不是删掉 | S2、S5、S7 | 部分做到：本项目选择“工具集合变了换新一次”，只因执行句柄出现的工具接在冻结工具后面并计数；它们出现或消失的那一轮，冻结工具之后的系统提示和历史整段重算。`device_action`、`perception_read` 两个工具的定义是固定文字，和有没有配对设备、设备支持哪些动作无关；现在能做什么由 `device_action` 的 `describe` 结果告诉模型，所以配对、换设备、加动作都不会改变请求开头。这两个工具上线的那一次，每个老对话按“工具集合变了”换新一次 |
| 8 | 同一对话中途不换模型、不换推理强度，其他请求参数保持稳定 | S1、S2、S6 | 换模型或推理强度会换新一次（ADR 0165），没有阻止中途更换 |
| 9 | 同一对话的请求送到同一个服务方 | S2、S6 | Magpie 发会话亲和头（`packages/runtime-pi/src/configured-model-binding.ts` 的 `sendSessionAffinityHeaders`）；没有传缓存路由键；实际是否稳定**未核实**，见[已知差距](#gaps) |
| 10 | 序列化确定：JSON 键顺序、工具顺序、列表顺序固定 | S7 | 冻结后系统提示和工具按原字节读回；资料块和运行环境说明的列表顺序固定（ADR 0164） |
| 11 | 遮盖确定：一段内容的遮法只取决于它自己、前面的内容和提示词目录生成的固定文字清单（固定文字不检查、也不当关键词上下文）；出口遮盖认出的密码或验证码（满 6 个字符）会被记下，在点名的那条消息里和同一次请求后面的消息里，单独出现的地方都遮 | 本项目 | 做到（`packages/application/src/services/model-egress.ts`、`packages/sensitive-capture/src/redaction.ts`、`packages/prompt-catalog/src/trusted.ts`）；例外条款 2026-11-05 获批；固定文字清单见 I-78 |
| 12 | 压缩集中做、少做，用总输入费用判断是否值得 | S2、S8 | 压缩由 Pi 自动触发；没有按费用评估 |
| 13 | 压缩请求沿用原对话的系统提示和工具 | S5、S6 | 做到（[ADR 0294](adr/0294-building-on-pi.md)：摘要请求用上一次普通请求的系统提示、工具和切点前的历史，末尾追加总结指令；拆分轮、溢出压缩、对不上或放不进窗口时退回 Pi 默认请求） |
| 14 | 清理旧工具结果要成批、少做、能恢复 | S7、S8 | 做到（[ADR 0285](adr/0285-one-main-thread-subthreads-and-one-inbox.md) 第 8 条）：Pi 的 `context` 钩子在压缩线的三分之二（15 万时是 10 万）以上、留最近 3 次、一次至少清 5000 token 时，把较早的工具结果换成占位；清了哪些由历史逐条重放算出，字节确定；`tool_result_recall` 按编号取回原文；压缩线从 20 万改成 15 万 |
| 15 | 后台调用也是固定的在前、会变的在后 | S2、S4 | 大体做到（例如邮件判断把当前时间放在最后）；遮盖占位符说明作为后台调用的系统提示放在最前面（`packages/runtime-pi/src/egress-context.ts` 的 `backgroundModelContext`，[ADR 0303](adr/0303-what-the-model-is-sent.md)），原来接在整段提示最后、排在当前时间之后；感知抽取（`packages/application/src/services/perception-extraction.ts`）按同样的顺序排：固定说明、资料包装、这一段的记录（按时间和编号排序）、还没完成的待办（按编号排序）、日历表、当前时间；没有统一检查。回看对话（`memory.conversation-review`，[ADR 0231](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0231-review-past-conversations-to-fix-memory.md)）按固定指令、本段数据 JSON、最后一行当地日期的顺序排，提示渲染黄金文件 `apps/agent-service/test/__prompt_golden__/memory.conversation-review.txt` 锁住固定部分 |
| 16 | 分叉出去的辅助计算沿用父对话的开头 | S5 | 没做（对话标题、记忆捕获各自另起开头） |
| 17 | 开头相同的并发请求，等第一个开始返回再发 | S1 | 同一对话一般不并发，未专门处理 |

补充几点各家文档里有、但不单列成规则的事实：

- 缓存有最小长度。多数服务方不缓存 1024 个 token 以下的请求（S1、S2；Gemini 的门槛更高，S4），所以短请求命中率低不算异常。
- 缓存会过期。Anthropic 默认 5 分钟，可选 1 小时（S1）；DeepSeek 通常在“几小时到几天”内清除（S3）。后台结果隔很久才回到对话时，那一轮注定没命中。
- 写入缓存可能另收费。Anthropic 写入 5 分钟缓存按 1.25 倍计价，1 小时缓存按 2 倍（S1）。DeepSeek 的文档没有写写入费用，以它的价格页为准。
- 显式缓存断点（Anthropic 的 `cache_control`）要放在最后一个“每次都相同”的块上，不能放在每次都变的块上（S1）。本项目主用的服务方是自动缓存，不需要手动设断点；以后接需要断点的服务方时照这一条做。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 已知差距

1. **同一对话会不会换服务方，还没核实（第 9 条）。**生产主用 Magpie，它带会话亲和头；`providerRouting.order` 只对 Vercel AI Gateway 生效，Magpie 不接受这个配置（`packages/runtime-pi/src/configured-model-binding.ts`）。会话亲和是否真的让同一对话落在同一处，要看 Magpie 的路由日志确认；不稳定的话，再决定要不要传固定的路由键。
2. **低命中只写日志，不报警（见[怎么检查](#gates)）。**业界把命中率当可用性指标（S5）。可以并进上面任一项一起做。

[↑ 返回目录](#contents)

<a id="gates"></a>

## 怎么检查

- **阻断检查：**`npm run check:prompt-prefix`。用真实的 Pi 适配器和出口遮盖跑多轮对话，检查后一次请求是否以前一次请求开头（`messages` 逐字节比，其他字段按值比，`max_tokens` 除外），并带反向用例。测试在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`。
- **端到端：**`test/integration/production-http-composition-process.test.ts` 里的 `[PR-A]`、`[PR-B]` 用例，用真实服务和 SQLite 抓取原始请求体来比对。
- **感知内容的位置：**同一个测试文件里带 `[iOS-5]` 的四条用例直接看请求的结构：感知内容只出现在最后追加的那条工具结果里；把它放进系统提示、放进工具定义、插到更早的位置或换成别的角色，检查都必须报告失败。它们算在 `check:prompt-prefix` 要求的条数里。
- **其他测试：**换新的各种条件在 `test/integration/thread-prompt-bundles.test.ts`；运行环境说明的发送时机和运行中压缩后补发，在 `packages/runtime-pi/test/runtime-environment-block.unit.test.ts` 和 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`。这些不属于 `check:prompt-prefix` 这一步。
- **生产监控：**对话的后续轮次请求（输入至少 1024 个 token，上游报告了缓存用量）命中率低于 50% 时，服务日志写一行 `cache.follow_up_low_hit`，阈值和命中率判断见 `packages/application/src/ports/model-usage.ts`，是否后续轮次见 `apps/agent-service/src/cache-hit-monitor.ts`；`node scripts/operations/cache-hit-report.mjs <product.sqlite> --by turn` 给出分轮次的命中率。排查时先排除四种情况：缓存过期、按规则换新、换了服务方、遮盖密钥轮换。

[↑ 返回目录](#contents)

<a id="changes"></a>

## 改动记录

| 日期 | 改动 | 依据 |
|---|---|---|
| 2026-11-25 | 第 14 条做到：成批清理旧工具结果和 `tool_result_recall`；压缩线从 20 万改成 15 万（ADR 0285 取代 ADR 0210） | Andy 2026-11-24 20:50 JST 定照搬 Anthropic 默认值；2026-11-25 00:25 JST 对编码计划：“同意，继续” |
| 2026-11-11 | 第 15 条现状：新增的回看对话后台调用按固定在前、日期在最后排（ADR 0231） | Andy 2026-11-11 对回看对话变更清单：“同意” |
| 2026-11-12 | 第 2、7、15 条现状补上感知：感知内容只以工具结果追加；`device_action`、`perception_read` 的定义固定，上线时老对话换新一次；感知抽取的排列顺序。“怎么检查”加上 `[iOS-5]` 结构检查 | 详细设计 [苹果设备上的身体](execution/specs/2026-11-11-apple-device-body-design.md) “发给模型的路径”一节（该节写明 Andy 同意老对话只重建一次） |
| 2026-11-10 | 第 13 条做到：压缩摘要请求沿用原对话的系统提示、工具和切点前的历史；已知差距第 1 条（压缩请求不共用开头）移到第 13 条的现状 | Andy 2026-11-09：写入待办“压缩请求吃不到缓存”；2026-11-10 要求主动推进所有事情 |
| 2026-11-10 | 大窗口模型的压缩触发点封顶在 20 万 token（[ADR 0210](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md)） | Andy 批准第三步方案，默认约 20 万 |
| 2026-11-07 | 第 4 条加入第四种例外：开发用的模型复核经 Magpie 调 CodeBuddy 时，插件在 11128 拒绝后改写系统提示（ADR 0178，只影响复核脚本） | Andy 2026-11-07 对整合方案：“同意” |
| 2026-11-06 | 第 11 条补上：提示词目录里的固定文字不检查、不当关键词上下文（I-78） | Andy 2026-11-06 同意修复出口遮盖误遮固定指令 |
| 2026-11-05 | 第 15 条现状：后台调用的占位符说明从提示末尾挪到系统提示（W-31） | Andy 2026-11-05：“就在这个任务里面做好，一起上” |
| 2026-11-05 | 加入维护规矩：改缓存行为的 PR 同时更新本文 | Andy 2026-11-05：“同意这个做法” |
| 2026-11-05 | 新建本文。把规则文件从“只追加”扩成完整的最佳实践；加入“按对话冻结”和遮盖例外；列出三项已知差距 | Andy 2026-11-05：“同意，里面这些 KV Cache 最佳实践的规则，除了写到 Claude Code 的线程工作指引里面之外，也要记一份到项目里合适的位置” |

[↑ 返回目录](#contents)
