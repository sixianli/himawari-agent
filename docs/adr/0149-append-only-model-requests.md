---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-02"
covers: ".agents/instructions/model-review.md, .agents/instructions/prompt-prefix.md, apps/agent-service/src/cache-hit-monitor.ts, apps/control-center/src/turn-summary.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, test/integration/thread-run-lifecycle.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0149：发给模型的内容只追加，历史存实际发出去的那条

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [根因](#root-cause)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [没有查清的部分](#open-questions)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-02 00:44（日本时间），Andy 在生产网页的对话「明天是否需要带伞」里追问「晚上呢?」，这一轮显示「缓存命中 0%」，Token 15.3k。缓存命中是指模型服务方对请求开头与上一次完全相同的那段不再重新计算，更快也更便宜。Andy 的原话是「这是原则性问题」。

[返回阅读导航](#contents)

<a id="root-cause"></a>

## 根因

界面的算法没有错：`apps/control-center/src/turn-summary.ts` 的分母是未命中输入加命中加写入，所以 0% 是模型调用记录里真的没有命中。

生产上逐字符对比这个对话两轮的请求内容（只读，数据来自 `model_usage_observations` 和 `provider_request` 记录）：第 2 轮第一次请求和第 1 轮最后一次请求，前 10954 个字符相同，相当于系统提示加工具定义，约 4.2k token，从第 2 条消息起不同。第 1 轮里这条用户消息是 705 字符的 `<himawari-context>` 资料块加提问，第 2 轮同一条消息被换成只有 62 字符的提问。它后面的回答、工具调用、搜索结果原样保留，但前面变了，对按开头匹配的缓存来说全部作废。

代码在 `packages/runtime-pi/src/pi-runtime-adapter.ts` 的 [withOwnerWords](https://github.com/sixianli/himawari-agent/blob/7115db19ef978d3c61b646a4626635a9288a4b1d/packages/runtime-pi/src/pi-runtime-adapter.ts)：每次 `message_end` 存历史前，把本轮发出去的那条用户消息换回主人原话。这是 [ADR 0104](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0104-turn-material-in-last-user-message.md) 的一条决定，它的理由是「前面的消息每轮都相同，可以被缓存命中」，这个理由是错的：模型上一轮见到的是带资料块的版本，下一轮见到的是不带的版本，前面的消息恰恰每轮都不同。当时的缓存测量只比较了同一次请求里的重复，没有比较相邻两轮。

影响：2026-11-01 06:00 到 15:44（UTC）的 92 次 chat 请求里，每个对话「第 2 轮及以后的第一次请求」共 18 次，输入合计约 46.2 万 token，只命中约 4.1 万（9%），占全部输入 148 万 token 的约 31%。同一轮内前缀严格追加的请求，47 次里 36 次命中。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

沿用 ADR 0104 的其余决定：系统提示只放不变的内容，本轮时间和全部资料放进最后一条用户消息的 `<himawari-context>`，主人的话单独包在 `<owner-message>`，资料里的「我」指主人。替换它的一条：

1. 原生历史存实际发出去的那条用户消息，资料块照留，不再换回原话。删掉 [withOwnerWords](https://github.com/sixianli/himawari-agent/blob/7115db19ef978d3c61b646a4626635a9288a4b1d/packages/runtime-pi/src/pi-runtime-adapter.ts)。
2. 在 `<himawari-context>` 开头加一句：更早的消息里附的时间和资料只反映当时，不代表现在，以本条消息里的为准。它只出现在新发的消息里，已存的历史不改。
3. 硬规则：已发给模型的内容不得改动、重排、删除，只能在末尾追加；每轮会变的内容只放最后一条用户消息；遮盖必须确定。写入 [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)，由 `AGENTS.md` 指向。
4. 阻断检查 `npm run check:prompt-prefix`：用真实 Pi 适配器和真实出口遮盖对回环服务跑多轮对话（含工具调用、搜索结果、银行卡号遮盖、附件长文本、每轮变化的记忆和时间），逐字节检查后一次请求以前一次为开头；反向用例把历史里的用户消息改写、让系统提示带每轮变化的值，必须失败。测试同时在 `test/integration/thread-run-lifecycle.test.ts` 的真实数据库组合里检查跨轮前缀。
5. 生产监控：后续轮次的 chat 请求命中率低于 50%（且输入不少于 1024 token、上游报告了缓存字段）时，服务日志写 `cache.follow_up_low_hit`（`apps/agent-service/src/cache-hit-monitor.ts`）；`scripts/operations/cache-hit-report.mjs --by turn` 按轮次和首次请求分开给出命中率。阈值 50% 的依据：改成只追加之后，后续轮次第一次请求的前缀等于上一次请求的全部内容，预期命中率约等于上一次输入占这一次输入的比例，生产数据里这个比例通常在 70% 以上；上游偶发零命中（见[没有查清的部分](#open-questions)）会触发日志，这是预期，日志是报告，不是告警。
6. 双模型复核的问题清单加一条：这个改动会不会改变模型已经见过的请求开头（[.agents/instructions/model-review.md](../../.agents/instructions/model-review.md)）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保持换回原话，只在别处补缓存**：与业界做法相反，每轮必断，放弃。
- **批量清理旧资料块（历史超过长度时一次性清掉很早轮次的资料块）**：Pi 已经有超窗口自动压缩，没有数据证明需要另做一套，等只追加上线并有命中率数据后再看。
- **把不变的资料（档案、主人要求）拆成固定块放在历史之前**：收益更大，但要动资料块的组装，和档案何时更新有关，是另一个大改动，单独出方案。
- **关掉 Magpie 的内容遮盖**：见[没有查清的部分](#open-questions)，数据不支持它造成零命中，不动。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- ✅ OpenAI 提示缓存指南：“Append new messages rather than rewriting earlier turns.”（<https://developers.openai.com/api/docs/guides/prompt-caching>）
- ✅ Manus 官方博客：“Make your context append-only. Avoid modifying previous actions or observations.”（<https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>）
- ✅ DeepSeek 上下文硬盘缓存文档：“A subsequent request can only hit the cache if it fully matches a cache prefix unit.”“The cache system works on a "best-effort" basis and does not guarantee a 100% cache hit rate.”“Cache construction takes seconds.”（<https://api-docs.deepseek.com/guides/kv_cache>，2026-11-02 打开）

上面前两条沿用 2026-10-30 的选项文档引文，本次没有重新打开原网页；DeepSeek 一条本次打开核对过。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每轮历史多存一份资料块（这个对话是 705 字符，会随选中的记忆数量变大）。超过窗口时由 Pi 的自动压缩处理；压缩那一轮前缀必然变短，这是规则 5 允许的少数例外，`check:prompt-prefix` 不覆盖压缩路径。
- 部署后第一轮：已存的旧历史里用户消息是原话版本，新一轮的开头和上一次发出的不一样，缓存断一次；之后恢复追加。
- 风险：旧资料块里的旧事实可能被模型当成现在的情况。用第 2 条的说明句缓解，需要用反向用例验证（见下）。
- 未验证（要在真实模型上做，用套餐额度）：重放 ADR 0104 那 140 个用例，确认不会回到「模型把资料当成主人的话、整段重讲」；先让资料块说一个事实、下一轮改成另一个事实，模型必须按最新的。上线后的生产命中率：未测量。
- 门槛：见[决定](#decision)第 4、5 条；事故 [I-66](../incidents-and-gates.md#incidents)。去掉 [withOwnerWords](https://github.com/sixianli/himawari-agent/blob/7115db19ef978d3c61b646a4626635a9288a4b1d/packages/runtime-pi/src/pi-runtime-adapter.ts) 的修复，改前 4 条正向用例失败，改后通过。3 条反向用例只证明检查器能发现断裂，拦住 [withOwnerWords](https://github.com/sixianli/himawari-agent/blob/7115db19ef978d3c61b646a4626635a9288a4b1d/packages/runtime-pi/src/pi-runtime-adapter.ts) 这类回归的是正向用例。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有查清的部分

同一时间段，前缀严格追加的请求仍有 11 次零命中（47 次里），例如这个对话第 1 轮第 2 次请求，与上一次间隔 17 秒。已排除（生产只读核对）：我们的请求前缀不稳定（同一轮内字节严格追加）；Magpie 重启（`NRestarts=0`，11-01 全天无重启）；重试或换供应商（Magpie 日志没有 400、429、回退记录，Himawari 侧 26 个有响应的请求全是 200）；响应头差异（命中和零命中的响应头集合相同）。

没有证实的两个嫌疑：

1. 上游自身：DeepSeek 文档写明缓存是尽力而为、构建需要几秒；OpenCode Go 的文档要求每个对话带固定的 `x-opencode-session` 以便路由和缓存，Magpie 源码（`internal/gateway/opencode_session.go`）会把我们发的会话编号转成这个头，生产版本 v0.1.2001（2026-10-29）里的 openCodeSeed 和 OpenCodeClient 读过，同样会把会话编号设成 `x-opencode-session`，但没有拿到 Magpie 发出的真实请求头来证实；响应里没有上游节点信息。
2. Magpie 的内容遮盖（`redact=true`）：每个请求先过本地模型，几乎都超过 2 秒时限，超时后只用规则遮盖。对 6 组相邻请求核对遮盖记录，遮盖了同样的两个值、占位符和长度完全相同，数据不支持它造成零命中；但拿不到发给上游的最终请求体，不能彻底排除。它还给每个请求加约 2 秒延迟。

要确认只能抓 Magpie 发给 OpenCode Go 的真实请求体，或向上游确认；这需要改 Magpie 配置或加探针，要 Andy 同意，本 ADR 不做。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 取代：[ADR 0104](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0104-turn-material-in-last-user-message.md)
- [ADR 0128：记录每次模型请求的缓存用量](0128-record-cache-usage-of-every-model-request.md)
- [ADR 0148：所有模型请求只走一个进程内出口](0148-send-every-model-request-through-one-in-process-egress.md)
- 事故：[I-66](../incidents-and-gates.md#incidents)
- 选项文档：cache-hit-stats/cross-turn-history-options.md（项目文件库）
- 案例：[案例 82](../engineering-casebook.md#case-append-only-prefix)

[返回阅读导航](#contents)
