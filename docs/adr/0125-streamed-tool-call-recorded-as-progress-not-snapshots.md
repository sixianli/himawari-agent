---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "apps/control-center/src/components/execution-process.tsx, apps/control-center/src/execution-timeline.ts, apps/control-center/test/execution-timeline.unit.test.ts, packages/application/src/services/thread-execution-projection.ts, packages/application/src/services/thread-execution-state.ts, packages/application/test/thread-execution-state.unit.test.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, scripts/delivery-mode/browser-acceptance-gate.py, test/integration/product-path-browser.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0125：模型写工具参数时只记“写到哪个文件、写了几行”，页面实时显示，不再每段都存整条消息

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [后续：写到一半的工具不算待执行的工具](#follow-up-2026-10-31)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 14:12（日本时间），Andy 在生产网页（第二十一版）发“写一个简易小游戏”，过程区显示“思考 44.5 秒”。这 44.5 秒里页面只有计时在走，中途还弹出“暂时无法加载这段对话，请重试”，状态行写着“部分执行记录暂不可读取”（[事故 I-38](../incidents-and-gates.md#incidents)）。

生产日志（Mac 线程只读导出，`/mnt/project-files/game-run-20261030T0512Z-20261030T053350-c0f0.txt`）里的事实：

- 这 44.5 秒是一次模型调用（Magpie 记录 `route_id 1793289861577`）：开始后 3.8 秒出第一个思考 token，19.0 秒出第一个正文 token，44.4 秒结束，输出 10358 token，其中思考 2592 个，结束原因是 `tool_calls`。也就是说，后面约 25 秒模型在写“写入文件”这个工具调用的参数，也就是整个游戏的代码。
- 这一轮服务端存了 686 条执行记录（`trace_events`），`run.timing` 记的是快照捕获（`pi.capture`）665 次共 33.7 秒，内容写库（`payload.commit`）1368 次。
- 网页读执行记录的请求（`thread.execution`）最长 13.0 秒，读执行状态（`thread.execution_state`）在这一轮结束后还要 12.3 秒。同一时段数据库排队最长只有 1.1 秒，所以慢不在排队。

根因（代码证据）：

1. Pi 运行适配器（`packages/runtime-pi/src/pi-runtime-adapter.ts`）对每个流式片段（`message_update`），都把到当时为止的**整条**助手消息存成一份快照，包括工具参数的原文（`partialArgs`）和解析结果（`arguments`）。参数越写越长，后面每份快照都有几十 KB，读的时候要把这几百份快照全部解密、解析一遍。网页一次读取最多等 15 秒，一次刷新又要连着读好几样，所以超时；连续 3 次失败就弹出“暂时无法加载这段对话”。
2. 执行记录只在模型消息结束后才生成工具步骤（`packages/application/src/services/thread-execution-projection.ts`），过程时间线（`apps/control-center/src/execution-timeline.ts`）又把以工具调用结束的整次模型调用都算作“思考”。所以写参数的 25 秒在页面上就是“思考”，没有任何进度。
3. 执行状态没读到时，状态行和步骤行直接显示“部分执行记录暂不可读取”（`apps/control-center/src/components/execution-process.tsx`），把本来能显示的“正在准备工具调用”也盖住了。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- OpenAI 函数调用文档：“Streaming can be used to surface progress by showing which function is called as the model fills its arguments”，可以“displaying the arguments in real time”。参数以 `response.function_call_arguments.delta` 事件逐段送来，每个事件只带新增的一段，由客户端拼起来。https://developers.openai.com/api/docs/guides/function-calling
- Anthropic 细粒度工具流式（fine-grained tool streaming）：工具参数“as Claude generates it”逐段送达，目的是缩短“the time to the first fragment of a large parameter, such as a document or a block of code”；流里传的是 `input_json_delta` 片段，结束时才解析完整参数。https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming

共同点：模型写大段工具参数（文件内容、代码）时，界面要立刻显示“在调用哪个工具、写到哪里了”；流里传的是新增片段，完整参数只在结束时拼出一次，不会每段都重发整份。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **写参数的过程中，只存进度，不存原文。** 流式片段里的工具调用，存下来的只有工具名、调用编号、文件路径（参数里的 `path`，有就带）和进度（已写字符数、已写行数），不再带 `partialArgs` 和半截参数（`withToolCallProgress`，`packages/runtime-pi/src/pi-runtime-adapter.ts`）。完整参数照旧只在消息结束（`message_end`）时存一次，审批、执行和历史都用这一份。
2. **执行记录在写的过程中就生成工具步骤。** 投影读到带进度的工具调用时，生成这个工具的步骤（`phase: updated`，带文件路径）和一条 `runtime.tool_call.writing` 记录（内容是已写行数）。
3. **页面实时显示写入进度。**
   - 状态行显示“正在写入文件 · 已写 N 行”（英文 “Writing a file · N lines so far”，日文 “ファイル書き込み中 · N 行まで”）。
   - 步骤行显示“写入文件 game.html · 已写 N 行”。
   - 过程区里“思考”只算到模型开始写工具调用为止，写参数的时间算进“写入文件”这一步（时间线里是“输出”一段）。
4. **执行状态还没读到时，不盖住进度。** 一轮还在进行、执行状态没读到时，状态行和步骤行照常显示从执行记录算出的进度。只有这一轮结束后还读不到，才显示“部分执行记录暂不可读取”。

“没有任何动作”的定义：页面上除计时器以外，连续超过 5 秒没有任何文字或数字变化。本次的门槛按这个定义检查：写文件开始后 3 秒内出现“已写 N 行”，之后行数继续增加。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只改页面文字，把“思考”改成“思考和写入”**：数据量问题还在，读执行记录照样 10 秒以上，“暂时无法加载”照样会出现。放弃。
- **限制快照频率（例如每秒最多存一份整条消息）**：能把份数降到几十份，但每份仍然是几十 KB 的整条消息，总量还是随输出长度的平方增长，长回答一样会慢。放弃。
- **改存新增片段（像 OpenAI、Anthropic 的流那样）**：最省空间，但网页和执行记录现在按“每条记录是完整状态”来读，改成片段要重写读取和页面拼接，范围大。工具参数页面本来就不显示原文，只需要路径和行数，所以先只对工具参数这样做；回答正文的流式快照留给 BL-20261030-001（流式过程记录批量写）一起处理。
- **把网页读取时限从 15 秒放宽**：只是让用户多等，原因没去掉。放弃。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 写一个 400 行文件的流式过程，存下的工具调用快照总量小于文件本身的大小。测试用的是 400 行、每行约 80 字的文件：改前每份快照都带着当时为止的全部内容，改后每份不到 150 字节。
- 页面在写文件时每次刷新都能看到行数变化。走查脚本用的假模型分 40 段、在 12 秒内送完参数。真实模型是否也是边写边送，取决于模型服务。生产上 DeepSeek V4.1 Flash 经 Magpie 的实际表现，要等上线后看。
- 回答正文的流式快照仍是整条存，长回答仍有同类开销，记在 BL-20261030-001。
- 门槛：
  - `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`：“records a streamed file write as its path and line count until the call is complete”；
  - `packages/application/test/thread-execution-state.unit.test.ts`：“turns a streamed file write into a write step with the lines written so far”；
  - `apps/control-center/test/execution-timeline.unit.test.ts`、`execution-view.unit.test.ts`、`execution-process.unit.test.ts` 的写入进度用例；
  - 出包走查必过场景 `accept-file-writing-progress` 和 `accept-progress-without-state`（`test/integration/product-path-browser.test.ts`，`scripts/delivery-mode/browser-acceptance-gate.py` 缺一项就不能上线）。

<a id="follow-up-2026-10-31"></a>

## 后续（2026-10-31）：写到一半的工具不算待执行的工具

第二十二版出包走查里，`accept-file-writing-progress` 第一次真实运行失败：页面 30 秒内没出现“已写 N 行”。原因是后端状态计算（`packages/application/src/services/thread-execution-state.ts`）把写到一半的 write 工具记录算成“准备中”的工具，页面只在模型阶段显示行数。修正：工具的最新记录比它的 `runtime.tool_call.writing` 记录旧时，参数还在写，不进入工具列表和效果汇总；消息结束后再写的工具记录才使它成为待执行的工具。本 ADR 的决定不变。

第一次修正（严格“晚于”）在 2cbceb9 的出包走查中仍然失败：同一条模型消息记录产出的工具记录和 `runtime.tool_call.writing` 记录序号相同。判断改为“不晚于”（`>=`），测试改用真实记录生成代码的输出。

第三次（6cba685 出包）：`accept-file-writing-progress` 通过，`accept-progress-without-state` 失败，执行状态慢 4 秒时“已写 N 行”晚了 4293 毫秒。网页把读执行记录和读执行状态放在同一个“正在读”标志下，状态慢会拖住下一次读记录。现在记录读完即释放标志，状态单独排队读。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [事故与门槛清单 I-38](../incidents-and-gates.md#incidents)
- [工程案例库：案例 67](../engineering-casebook.md#case-silent-file-writing)
- [界面设计规范](../ui-ux-design-guide.md)
- [ADR 0105：过程区一句话总结](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md)

[↑ 返回阅读导航](#contents)
