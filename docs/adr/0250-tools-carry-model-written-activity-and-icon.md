---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: ""
superseded_by: ""
date: "2026-11-12"
covers: ".agents/instructions/prompt-prefix.md, apps/control-center/src/step-summary.ts, apps/control-center/test/step-summary.unit.test.ts, packages/application/src/services/thread-prompt-bundle-service.ts, packages/gateway-contracts/src/process-step.ts, packages/gateway-contracts/src/validation.ts, packages/prompt-catalog/src/activity.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/fixtures/d4-golden-requests.json, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, test/integration/thread-run-lifecycle.test.ts"
verified_at: "cbda12b8fc3e2f2273f1048c46bbf39060938cc3"
---

# ADR 0250：每个工具多两个可选参数，过程行的那句话和图标由模型自己给

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

对话里有一行“它正在做什么”，叫过程行（手机和网页上显示 Himawari 这一步在做的事）。现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`），图标也是网页按工具名查表。Andy 2026-11-12 批准了过程行用的 40 个图标，并同意“图标由 himawari 自己从这 40 个里面挑”。苹果客户端的详细设计里讲这件事的那一段还没合进 main，在 PR 405 的提交 f7cbbf01 上（[“过程行的那句话和图标由 Himawari 自己给”一段](https://github.com/sixianli/himawari-agent/blob/f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0/docs/execution/specs/2026-11-11-apple-device-body-design.md#process-row-icons)，下文简称“详细设计”），它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备。本 ADR 记下服务器端怎样实现。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. **Andy 同意由模型挑图标，也同意老对话的请求开头换新一次。** 来源：Andy 2026-11-12 在 iOS 设计线程的原话“同意图标由 himawari 自己从这 40 个里面挑”；[详细设计](https://github.com/sixianli/himawari-agent/blob/f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0/docs/execution/specs/2026-11-11-apple-device-body-design.md#process-row-icons)同一段：“工具的参数结构变了，每个老对话的请求开头换新一次（Andy 2026-11-12 同意）”。
2. **Pi 允许在工具执行前就地改参数，而且改动会作用到真正的执行。** 来源：Pi 1.5.0 的官方文档 <https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/docs/extensions.md> 第 973 行“Fired after `tool_execution_start`, before the tool executes”，第 982 行“Mutations to `event.input` affect the actual tool execution”，第 984 行“No re-validation is performed after your mutation”；1.5.1 的 <https://unpkg.com/@earendil-works/pi-coding-agent@1.5.1/docs/extensions.md> 同一段在第 975、984、986 行，说法相同（仓库里的转述见 [Pi 二次开发规范](../pi-development-guide.md#pattern-tool-call)）。
3. **Pi 的 `prepareArguments` 不是给这种用途的。** 来源：<https://unpkg.com/@earendil-works/pi-coding-agent@1.5.0/docs/extensions.md> 第 2302 行：“Use it to mimic an older accepted input shape when Pi resumes an older session …… Keep the public schema strict.”
4. **Pi 校验参数时用的是副本，对话记录里保留模型的原样参数。** 来源：<https://unpkg.com/@earendil-works/pi-ai@1.5.0/dist/utils/validation.js> 第 53 行：“A copy, so tools that modify their arguments never modify the tool call in the transcript.”
5. **每个工具的定义都经过同一个函数。** 来源：`packages/runtime-pi/src/pi-runtime-adapter.ts` 的 `toolDefinition()`：冻结的工具、带执行句柄的工具、系统提示里的工具说明都从它取（`frozenDefinitions`、`requestTools`、`productSystemPrompt`）。
6. **参数结构变了，老对话会换新一次冻结的开头。** 来源：`packages/application/src/services/thread-prompt-bundle-service.ts` 的 `toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”；规则 `.agents/instructions/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”。
7. **开始执行时的过程事件里本来就带着模型给的参数。** 来源：`pi-runtime-adapter.ts` 的 `case "tool_execution_start"`：`arguments: event.args` 写进 `tool_intent` 记录。
8. **网关的过程记录不接受多出来的字段。** 来源：`packages/gateway-contracts/src/validation.ts` 第 212 行：``if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");``。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **参数。**`toolDefinition()` 给每个参数结构是对象的工具加两个可选的字符串参数：`activity`（一句话说这一步在做什么）和 `activityIcon`（图标名）。工具自己已经有同名参数的，不加，也不删它的参数（它的说明文字和这里的逐字相同时除外，那时按加过处理，执行前删掉）。两项都不进 `required`。说明文字在 `packages/prompt-catalog/src/activity.ts`。只因执行句柄出现、不冻结的工具，只在这一轮实际用的冻结工具（对话冻结时存下的那份）带这两个参数时才带：它们不进冻结的系统提示，系统提示里有没有图标表只由冻结的工具决定。
2. **图标表在系统提示里只列一次。**按[详细设计](https://github.com/sixianli/himawari-agent/blob/f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0/docs/execution/specs/2026-11-11-apple-device-body-design.md#process-row-icons)，40 个图标里“结果”那 4 个（`hand-stop`、`alert-circle`、`player-stop`、`check`）是服务器知道的状态，不给模型挑；其余 36 个（Andy 2026-11-12 下午改了三个名字：待办 `checklist` 改 `clipboard-list`，别的工具 `tools` 改 `puzzle`，健康数据 `heart-rate-monitor` 改 `heartbeat`，经设计线程转来）连同每个名字的意思写成系统提示里的“过程图标”一节，只要有一个工具带这两个参数就加上。参数说明里只写“从系统提示‘过程图标’一节挑”，不在每个工具里重复列 36 个名字。参数类型是字符串，不用枚举：名字不在表里时不让工具调用失败，由服务器换成 `puzzle`（“别的工具”）。
3. **执行前取走。**在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里，对加过这两个参数的工具，从 `event.input` 删掉它们（前提 2）。所以权限判断（`preflight`）、审批、工具本身和“工具循环停止”的判断看到的都是去掉后的参数。这是 Pi 官方写法，不新增偏离。
4. **随过程记录发出。**`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录时，从模型的参数里取出这两项：`activity` 把换行、控制字符和双向控制符换成空格，连续空白并成一个，去掉首尾空白，最多 80 个字符（参数说明里请模型写 30 个字以内，80 是服务器的硬上限）；`activityIcon` 在 36 个名字之内就原样给，否则给 `puzzle`。记录的 `input` 里不再有这两项。网关契约 `threadExecutionRecordSchema` 加这两个字段。网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值；执行结束的那条记录两个字段为空字符串。
5. **退回。**模型没给 `activity` 时，服务器按这个对话的回答语言（`thread.answerLocale`）用模板补一句，例如“搜索网页”。模板和“工具名对到哪一类”的表放在 `packages/gateway-contracts/src/process-step.ts`，三种语言一份，手机和服务器共用，手机不再看到 `web_search` 这类工具名。网页的过程区仍从自己的 i18n 文字表取同样的句子，`apps/control-center/test/step-summary.unit.test.ts` 的 `[ICON-3]` 锁住网页那几条和共享表逐字相同；网页按工具名分类也改用共享表的 `processStepKind`。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- Claude Code 的 Bash 工具有一个 `description` 参数，模型每次调用写一句“这条命令在做什么”，界面显示这句话而不是命令本身（Claude Code 自带工具的参数说明，来源是它发给模型的工具定义；没有找到公开文档页面，未核对一手链接）。
- OpenAI 的函数调用文档建议把工具参数说明写清楚，没有专门的“过程说明”字段（<https://platform.openai.com/docs/guides/function-calling>，未逐字核对）。

我们的做法和 Claude Code 的一致：让模型在调用工具时顺带写这句话，而不是另发一次请求去概括，也不按工具名套模板。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **在工具的 `execute` 里删。**能做到，但“工具循环停止”的判断用的是 `tool_result` 事件里的参数，模型每次换一句话会让同样的调用看起来不同；而且这条路要在每个执行入口都记得删。`tool_call` 钩子是官方说的改参数的地方，一处就够。
- **用 `prepareArguments` 删。**官方说它只用来兼容老对话的旧参数格式（前提 3）。
- **每个工具的参数说明里都列 36 个名字或写成枚举。**模型更容易照抄，但每个工具多约一百多个 token，工具多时每次请求多出几千个 token；而且名字一旦不在枚举里，工具调用会被 Pi 的校验拒掉，模型要重试一次。
- **另发一次模型请求概括这一步。**每一步多花一次钱、多等一次，而发起调用的模型本来就知道自己在做什么。
- **服务器按工具名套图标。**这正是要换掉的写死的表。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- **老对话的请求开头换新一次。**每个工具的参数结构都变了，按 `toolSchemaChanged` 每个老对话下一轮换新一次冻结的系统提示和工具，那一轮按全价算输入（Andy 已同意，前提 1）。之后同一对话照常只追加。
- **对话记录里保留模型的原样参数。**模型下一轮看到的历史里，工具调用仍带着它自己写的 `activity` 和 `activityIcon`（前提 4），这符合只追加，不改历史。
- **网关契约变了。**过程记录多了两个必填字段，旧版网页和旧版手机解析新记录会报“unknown field”。网页和服务器一起上线；手机客户端在 iOS 第 2 批按新形状解析。
- **退回的句子在读取时生成。**过程记录每次读取时按这个对话当时的回答语言补模板句子，所以改了回答语言之后，旧步骤里退回的那句也跟着换语言；模型自己写的句子不变。这只影响显示，不影响发给模型的内容。
- **服务器按参数名取这两项。**生成过程记录时不知道工具的参数结构，所以工具自己若有叫 `activity` 或 `activityIcon` 的参数，它的值也会被当成过程行的句子和图标，并从记录的 `input` 里拿掉；工具执行拿到的参数不受影响。目前生产里没有这样的工具。
- **网页暂时不显示模型写的那句话。**网页的过程区仍按界面语言显示模板句子；要不要改用模型那句话，按详细设计“网页的过程区可以用同一句话”另行决定，改了要做真实网页上的正反两种验收。注意模板句子在服务器那边按回答语言，在网页上按界面语言，两者可能不同。
- **测试。**`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 的 `[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型锁住：工具定义带这两个参数、系统提示只出现一次图标表、工具执行和权限判断拿到的参数里没有它们、工具自己的同名参数原样保留、过程事件和下一次请求的历史里仍有它们，并锁住没有冻结工具、或者沿用的冻结工具（例如升级前冻结的旧版）不带这两个参数时，执行句柄带来的工具也不带、系统提示里没有图标表，沿用的冻结工具带参数时句柄工具也带；还锁住模型每次换一句 `activity` 时，同样的调用仍会被工具循环停止拦下（Pi 1.5.0 的 `tool_call` 和 `tool_result` 钩子拿的是同一个参数对象）。`test/integration/thread-run-lifecycle.test.ts` 的 `[ICON-2]` 用真实 SQLite 锁住过程记录的两个字段、句子里的换行和控制字符被换掉、退回 `puzzle`、`input` 里不再有它们，并用网关契约逐条解析。
- **请求字节的对照文件更新了。**`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本，其他字段不变。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范：工具执行前拦截或改参数](../pi-development-guide.md#pattern-tool-call)
- [发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md)
- [ADR 0165：按对话冻结请求开头](0165-freeze-the-request-head-per-conversation.md)
- [ADR 0203：照 Pi 官方的扩展写法](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0203-follow-pi-official-extension-patterns.md)

[返回阅读导航](#contents)
