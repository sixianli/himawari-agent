---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0222：记忆捕获失败时同轮重试一次，再失败放进待补队列，每次失败留一条决策记录

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

记忆捕获（memory capture）是每轮对话后由一次后台模型调用从主人的话里找出值得记的内容。任务块 P3-5 要求：这次调用失败时同轮重试一次；再失败就把这一轮放进待补队列，下一轮运行时补做；每次失败都留一条决策记录（决策记录是 Himawari 对每个自动判断留下的可评价记录）。在这之前，捕获失败只写一条审计（`extraction_failed`）和一行日志，什么都没记，主人看不到，也不会再试。

[I-63](../incidents-and-gates.md#incidents) 是这个问题的一个实例：2026-11-01 一轮捕获报 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED`，什么都没记，模型却说“记住了”。当时加的缓解只认这一个错误码，并且在模型出口那一层对标题、捕获、episode、整理一起生效。生产日志里捕获失败还有 `MEMORY_CAPTURE_RESPONSE_INVALID`（模型回的不是合法 JSON）和 `PORT_CONFLICT`（写记忆时并发冲突），它们不重试。

Andy 在 2026-11-11 同意了变更清单（`/mnt/project-files/p3-5-capture-retry/change-list.md`），并在卡片上选了“新结果名，重建决策记录表”。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 捕获失败只审计不重试：main `cb56223` 的 `apps/agent-service/src/production-memory-capture.ts:855-856`，`} catch (error) { audit("extraction_failed");`。
2. 现有重试只认一个错误码：main `cb56223` 的 `apps/agent-service/src/production-model-composition.ts:633`，`if (!(error instanceof Error) || error.message !== "AI_GATEWAY_TOOL_CALL_UNSUPPORTED")`。
3. 决策记录的结果值有数据库检查：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:50`，`(kind = 'memory_candidate' AND outcome IN ('kept', 'discarded', 'pending_approval'))`。
4. SQLite 不能直接改检查约束，要新建表、复制、删旧表、改名：<https://www.sqlite.org/lang_altertable.html>（“Making Other Kinds Of Table Schema Changes”）。决策记录表被六张表引用，迁移 0087 已按这个做法重建过一次（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 决定 4）。
5. 模型准入（每次模型调用前的预算和执行权检查）需要当前运行的执行租约，同一个调用编号再次申请会被当成重放：`apps/agent-service/src/production-run-composition.ts`（捕获的 `generate` 经 `auxiliaryMemoryGeneration` 走同一个准入）、`packages/application/src/services/model-invocation-admission-service.ts`。
6. 发给模型的内容只追加、后台调用固定的在前：[.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md) 第 15 条“后台调用也是固定的在前、会变的在后”。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **同轮重试一次，只对可能是偶发的错误。**会重试的错误码：`AI_GATEWAY_TOOL_CALL_UNSUPPORTED`、`AI_GATEWAY_REQUEST_TIMEOUT`、`AI_GATEWAY_RATE_LIMITED`、`AI_GATEWAY_PROVIDER_UNAVAILABLE`、`AI_GATEWAY_EMPTY_RESPONSE`、`PI_MODEL_STREAM_ERROR`、`MEMORY_CAPTURE_RESPONSE_INVALID`、`MEMORY_CAPTURE_RESPONSE_INCOMPLETE`、`PORT_CONFLICT`（`SAME_TURN_RETRYABLE_CAPTURE_ERRORS`）。其他错误（例如输出被截断、数据分级不允许）同一轮再试一次多半还是一样，不重试，直接排队。重试用同一份提示词字节和同一个遮盖标签，只换调用编号（`memory-capture:<轮>:retry`），所以第二次请求和第一次逐字节相同。
2. **捕获这一路不再有出口层的重复重试。**捕获调用传 `retryToolCall: false`，出口层 I-63 那次重试只留给标题、episode 和整理。这样一轮捕获最多两次模型调用，不会变成四次。
3. **模型调用第一次失败就先写进待补队列，再重试。**新表 `memory_capture_backlog`（迁移 0088），主键是生成编号 `memory-capture:<原轮>`，存主人、Agent、对话、原轮、补做次数、最近一次错误码和时间，不存提示词和原文。对话被永久删除时这一行跟着级联删除。队列行要等这一轮存进记忆、或者写了“放弃”才删，所以进程在重试途中重启，这一轮还在队列里。
4. **写记忆失败时不重试、不排队，直接写“放弃”。**还没开始写记忆的失败（运行已经失效、登记这次生成失败）和模型调用失败一样处理：同轮可重试的就重试，否则排队，因为这时什么都还没写。模型已经给出结果、开始写记忆之后失败（例如写冲突 `PORT_CONFLICT`），这一次存可能已经写进一部分：存记忆是按候选逐条写的，外面没有整体事务。重新问模型再存，新结果的条目和顺序可能不同，会多出近似的记忆或重复更新；用同一份结果再存也不安全，例如新记忆已建好、取代旧记忆那一步失败时，再存会在“编号相同、内容相同”的分支直接返回，旧记忆不会被标成被取代，却被当作成功（PR 377 第 3 轮复核指出）；更新类的提议会再应用一次，多一条历史和一个版本号，还会重新安排提醒。所以存失败时先写一条 `capture_gave_up`，原因码是存的错误码，网页显示“这轮没记全”，说明里写明可能已存下一部分；再删掉队列行（如果有）。同轮和补做都按这条处理。写记录和删行各自失败时只上报，不互相挡住。删行失败时（存成功之后或写了放弃之后都一样），进程记下这一条只差删行，之后补做读到它只删行、不再问模型；这份记录最多留 1000 条，和已捕获轮次的记录一样。进程恰好在写放弃之后、删行之前重启，这一条会再补做一次，这个窗口只有一次数据库写入那么长，本 ADR 接受它。
5. **下一轮补做一条。**本轮自己的捕获拿到准入之后，串行补做本主人最旧的一条（不含本轮刚放进去的），只取对话仍打开、不在回收站的；每轮最多一条。同一个进程里正在同轮重试或正在补做的那一条，别的轮次不会再去补（服务按单进程、单写者运行，所以不另做跨进程的领取锁）。补做用本轮的租约，调用编号 `memory-capture:<本轮>:backlog`；按 id 读回原轮主人那条消息和它之前的 50 条，用当前记忆状态重建提示词，所以补做的提示词不是原轮的逐字复刻：已有记忆是现在的，“本轮相关的记忆”为空（那是原轮运行时才有的）。生成编号不变，记忆 id 是 `memory:<生成编号>:<序号>`。进入队列的轮次都是还没开始写记忆就失败的（模型调用、运行失效、登记这次生成），所以补做不会和原轮重复；只有在“存成功、删队列行之前”进程恰好重启时，下一次补做才会再存一遍，那时模型输出的顺序可能不同，可能多出一条近似的记忆，这个窗口只有一次数据库写入那么长，本 ADR 接受它。主人暂停了记忆时跳过、留着；补做第 3 次仍失败就删行、记“放弃”。准入暂时拿不到（`MEMORY_CAPTURE_ADMISSION_UNAVAILABLE`、`MEMORY_CAPTURE_MODEL_UNAVAILABLE`）不算一次补做。对话在回收站里时队列行留着不补，对话被永久删除时随之删除；数据导出不含这张表，因为它只是待办，不是主人的数据。
6. **每次失败一条决策记录，用三个新结果值。**`capture_retrying`（模型调用失败、同轮会重试）、`capture_queued`（等下一轮补做）、`capture_gave_up`（补做 3 次仍失败，或存记忆失败）。原因码写错误码，`ruleIds` 留空。变更清单原写的是一个结果值 `capture_failed` 加原因 `retrying/queued/gave_up`；实施时改成三个结果值，因为原因码这一栏要放错误码才能看出是哪种失败，而去向只有三种，放进结果值后网页标签和周报分组直接按结果值判断，不用解析原因。数据库检查放行这三个值，所以迁移 0088 按 0087 的做法重建决策记录表和六张子表。
7. **网页和周报。**每日评价里这三种显示成“记忆抽取失败，已重试”“记忆抽取失败，下一轮补做”“这轮没记全”（三种语言）；它们不算“已执行”，没有记忆原文可读，也不显示“内容已隐藏”。周报校准新增一组“记忆抽取失败”，校准报告和网页周报的评价选项都是“没漏掉什么”和“漏了该记的”。
8. **不改提示词文字、系统提示和敏感内容规则。**补做走同一个模型出口和同一个准入。

**后续（[ADR 0240](0240-capture-writes-in-one-transaction.md)）：**整轮写库改成一个事务后，决定 4 里“写记忆失败直接放弃、不重试、不排队”和决定 6 里“存记忆失败记 `capture_gave_up`”改为：写失败留在队列、最多共 3 次；本 ADR 其余决定不变。决定 7 里 `capture_gave_up` 的网页说明相应改为“这轮没记下”（三种语言），表示这一轮没有存下任何内容。决定 4 里“放弃后、删行前重启，这一条会再补做一次”改为：补做读到已满 3 次的行只删行、不再问模型，这时不会补写“放弃”记录，网页上这一轮没有解释行，影响只限于解释。上面决定 4 的原文保留不改。

同轮重试有一个已知限制：如果这一轮的运行已经结束、租约已经交还，重试拿不到准入，这一轮就按排队处理，留给下一轮补做，而不是拖住这一轮的结束。依据是“用户主权”之后的“记忆可靠性”优先于“主动性与效率”：记忆不丢，但不让主人多等。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 对模型调用的偶发错误，官方 SDK 的做法是对超时、限流和 5xx 自动重试有限次数，对 4xx 类不重试：Anthropic SDK 默认重试 2 次（<https://github.com/anthropics/anthropic-sdk-typescript/blob/main/README.md#retries>），OpenAI SDK 同样默认 2 次（<https://github.com/openai/openai-node/blob/main/README.md#retries>）。本 ADR 同轮只多试一次，因为捕获是后台调用，失败的轮次还有队列兜底。
- 后台任务失败后放进持久队列、限次补做、超过次数转为“放弃”并留记录，是常见的死信队列做法（例如 AWS SQS 的 `maxReceiveCount`：<https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html>）。
- 改检查约束的迁移做法依据 SQLite 官方文档（前提 4）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **只在第二次失败后才入队。**进程在重试途中重启会丢这一轮。
- **沿用“已跳过”结果、不动表。**网页会把“重试成功”的那一轮也显示成“已跳过记忆”，和实际不一致；Andy 在卡片上选了新结果名。
- **补做时只看本对话。**主人不再回到的对话永远补不上。
- **存记忆失败也重新问模型、或把它放进补做。**第一次存可能已经写进一部分，换一份模型结果再存会重复写或重复更新（PR 377 第 2 轮复核指出）。
- **存记忆失败时用同一份结果再存一次。**第 2 轮复核后试过，第 3 轮复核指出它会把“取代旧记忆没做完”当成成功、重复更新和重新安排提醒；要做对得让每个候选的写入可续做，超出本任务，所以放弃，改为写“放弃”留痕。
- **所有错误都重试。**输出被截断这类错误同样的输入再试一次还会失败，只多花钱。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 一轮捕获最多两次模型调用；下一轮最多再多一次补做调用。
- 迁移 0088 重建决策记录表；契约测试 `packages/persistence-sqlite/test/memory-capture-backlog-migration.contract.test.ts` 核对重建前后六张子表的行、索引和触发器完全一致，新结果值能写入、未知结果值被拒、对话删除时队列行级联消失。
- `npm run check:memory-capture-retry`（`npm run check` 的一步）运行带 `[P3-5]` 的 19 条测试：`test/integration/production-memory-capture.test.ts` 的 13 条和上面的迁移契约测试 6 条。
- I-63 的根因（模型为什么回工具调用）仍没查清，那一行状态不变，只写明重试现在覆盖更多错误。
- 记忆捕获、episode、整理的花费仍记在“标题”预算账户上，本 ADR 不改，另开小修。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：上一次重建决策记录表。
- [事故和门槛清单](../incidents-and-gates.md#incidents)：I-63。
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)。

[返回阅读导航](#contents)
