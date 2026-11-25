---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
---

# ADR 0128：每次模型请求都记下缓存命中，先有尺子再改上下文

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 16:11（日本时间），Andy 定了一条原则：所有模型的上下文组装都要让 KV 缓存（模型服务保存的、已算过的提示词前缀，下一次请求前缀相同就不用重算，更快也更便宜）命中最大化，也就是固定内容放前、会变的内容放后。要改上下文组装，先得有一把尺子量出“改之前、改之后”各用途的命中率。

现状（代码证据）：

- 聊天路径（`PiAgentRuntimeAdapter`）和模型端口路径（`TrustedModelProviderAdapter`，标题、记忆、邮件判断、动作审查）都会拿到 token 用量，但只进预算结算，不留“这是哪种用途、命中了多少”。
- Pi（`@earendil-works/pi-ai` 0.84.2）的 `parseChunkUsage` 把缺失的缓存字段当 0。所以从 Pi 的用量里分不出“提供方说命中 0”和“提供方根本没报”，把后者算成 0% 会让命中率看起来比真实情况差，误导判断。
- 已有的实测：邮件判断的提示词第 3 行带时间戳，命中为 0（#133 已改）；Magpie 经 CodeBuddy 转发 DeepSeek 时，缓存字段能透传（3759 个前缀 token 命中 3584，按 128 对齐）。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 打开过的一手资料：

- OpenAI 提示词缓存文档：命中按前缀匹配，用量里 `cached_tokens` 给出命中数；建议“Append new messages rather than rewriting earlier turns”。https://platform.openai.com/docs/guides/prompt-caching
- DeepSeek 上下文硬盘缓存文档：用量里用 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens` 两个字段报告命中和未命中。https://api-docs.deepseek.com/guides/kv_cache
- Anthropic 提示词缓存文档：用量里用 `cache_read_input_tokens` 和 `cache_creation_input_tokens`，顺序是工具、系统、消息。https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Manus 工程博客：“Make your context append-only”，并把 KV 缓存命中率当作 Agent 最重要的单项指标。https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- OpenTelemetry GenAI 语义约定（状态为 Development）：用 `gen_ai.usage.cache_read.input_tokens` 等属性记录缓存读取，总输入 token 含命中部分。https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

共同点：各家字段名不同，但都在每次响应的用量里给出命中数；业界做法是按请求记录、按用途汇总。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **每次正常模型请求结束后记一行。** 新表 `model_usage_observations`（迁移 `0068_model_usage_observations`），主键是 `(owner_id, agent_id, run_id, invocation_id)`，记输入、输出、缓存读取、缓存写入 token，加用途、来源路径（`model-port` 或 `agent-stream`）、提供方、模型和时间。字段名和“总输入含命中”的约定对齐 OpenTelemetry GenAI。
2. **“没上报”和“命中 0”分开。** 在抓取层（`packages/runtime-pi/src/cache-usage-observation.ts`）克隆响应，扫描 SSE 用量帧里有没有 OpenAI、DeepSeek、Anthropic 三种缓存字段之一（值为 0 也算上报）。没有就记 `cache_reported = 0`，缓存读写强制记 0。数据库约束保证 `cache_reported = 0` 时读写必须是 0。
3. **统计口径写死。** 命中率 = 已上报且输入不少于 1024 token 的请求的缓存读取总和 ÷ 输入总和（1024 是 OpenAI 的最短可缓存长度）；样本少于 5 条不出数，显示“样本不足”；未上报的不进分母，另列“已上报 X / 共 Y”；同一次运行里的第二次及以后调用单独给一列，因为它们前缀本该命中。
4. **记录不进预算事务，失败不影响回答。** 预算结算成功之后才记录，失败只写诊断（`model-usage.record_failed`）。不进预算事务是因为主动提醒走的免计量通道也要统计；失败不影响回答是因为统计只是尺子。
5. **报告先用脚本。** `scripts/operations/cache-hit-report.mjs` 以只读方式打开 SQLite，按用途、模型、日期（日本时间）或用途加模型分组。要不要做网页，等 Andy 在方案 A、B、C 里选。
6. **用途登记。** `ModelUsagePurpose` 是固定清单；没登记的用途会被归到 `other`，后续的自动检查会要求每个用途先登记并保持固定前缀稳定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **从 Pi 的用量字段直接取**：改动最小，但分不出“没上报”，放弃（`parseChunkUsage` 缺字段按 0 处理）。
- **把缓存列加到 `model_invocation_identities`**：同一张表有结算语义，加列要改回放和约束，范围大；且免计量通道没有这条记录。放弃，用独立的表。
- **直接上 Langfuse 或 Phoenix 之类的观测平台**：Langfuse 自托管要 Postgres、ClickHouse、Redis 和对象存储，对一个人的部署太重；Hermes 上的那一套属于另一个项目，数据里没有缓存 token 字段。先自己采集，字段对齐 OpenTelemetry，以后接这些平台时不用改采集。
- **先做网页再采集**：要先有数据才知道页面该画什么，放弃，先采集和脚本。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 上线后每次模型请求多一次 SQLite 小写入，失败不阻塞回答。生产上的耗时影响：未测量。
- 聊天、标题、记忆整理、邮件判断、动作审查的命中率都能按日期看，改上下文组装前后可以对比。
- 提供方不上报缓存字段时，该用途显示“未上报”而不是 0%。哪些来源不上报，要上线后看数据，不预设。
- 还没做的：每个用途的前缀稳定性自动检查、三处提示词修改、历史固定块（3 + 1 + 2）、缓存页面。它们是后续的 PR，各自先出范围说明。
- 门槛（本次没有事故，只是建尺子，因此不新增事故行；自动检查随下一个 PR 提交）：
  - `test/integration/sqlite-model-usage.test.ts`：真实 SQLite 下的口径、样本门槛、分组、幂等和非法记录；
  - `packages/runtime-pi/test/cache-usage-observation.unit.test.ts`：三种字段、零值、缺字段；
  - `packages/platform-node/test/trusted-model-provider.unit.test.ts`、`packages/runtime-pi/test/pi-model-transport.unit.test.ts`、`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`：两条路径都在结算之后记录，记录失败不影响回答。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [工程案例库：案例 71](../engineering-casebook.md#case-cache-usage-ruler)
- [ADR 0104：本轮材料放在最后一条用户消息](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0104-turn-material-in-last-user-message.md)
- [ADR 0117：Magpie 经自有订阅路由模型](0117-magpie-routes-models-through-owned-subscriptions.md)
- [架构文档：模型调用与预算](../architecture-v0.1.md)

[↑ 返回阅读导航](#contents)
