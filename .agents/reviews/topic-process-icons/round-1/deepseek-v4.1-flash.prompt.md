你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 13b46cb69d5ebd0b1b9524925de19a2376e38a6e。
待核对的方案：
方案文件：docs/adr/0250-tools-carry-model-written-activity-and-icon.md（在提交 13b46cb69d5ebd0b1b9524925de19a2376e38a6e 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: ""
superseded_by: ""
date: "2026-11-12"
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

对话里有一行“它正在做什么”，叫过程行（手机和网页上显示 Himawari 这一步在做的事）。现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`），图标也是网页按工具名查表。Andy 2026-11-12 批准了过程行用的 40 个图标，并同意“图标由 himawari 自己从这 40 个里面挑”。苹果客户端的详细设计（`docs/execution/specs/2026-11-11-apple-device-body-design.md` 的“过程行的那句话和图标由 Himawari 自己给”一段，在 PR 405 的分支上）定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备。本 ADR 记下服务器端怎样实现。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. **Andy 同意由模型挑图标，也同意老对话的请求开头换新一次。** 来源：Andy 2026-11-12 在 iOS 设计线程的原话“同意图标由 himawari 自己从这 40 个里面挑”；详细设计同一段：“工具的参数结构变了，每个老对话的请求开头换新一次（Andy 2026-11-12 同意）”。
2. **Pi 允许在工具执行前就地改参数，而且改动会作用到真正的执行。** 来源：`@earendil-works/pi-coding-agent@1.5.0` 的 `docs/extensions.md` 第 973 行“Fired after `tool_execution_start`, before the tool executes”，第 982 行“Mutations to `event.input` affect the actual tool execution”，第 984 行“No re-validation is performed after your mutation”；1.5.1 同一段在第 975、984、986 行，说法相同。
3. **Pi 的 `prepareArguments` 不是给这种用途的。** 来源：同一文件第 2302 行：“Use it to mimic an older accepted input shape when Pi resumes an older session …… Keep the public schema strict.”
4. **Pi 校验参数时用的是副本，对话记录里保留模型的原样参数。** 来源：`@earendil-works/pi-ai@1.5.0` 的 `dist/utils/validation.js` 第 53 行：“A copy, so tools that modify their arguments never modify the tool call in the transcript.”
5. **每个工具的定义都经过同一个函数。** 来源：`packages/runtime-pi/src/pi-runtime-adapter.ts` 的 `toolDefinition()`：冻结的工具、带执行句柄的工具、系统提示里的工具说明都从它取（`frozenDefinitions`、`requestTools`、`productSystemPrompt`）。
6. **参数结构变了，老对话会换新一次冻结的开头。** 来源：`packages/application/src/services/thread-prompt-bundle-service.ts` 的 `toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”；规则 `.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”。
7. **开始执行时的过程事件里本来就带着模型给的参数。** 来源：`pi-runtime-adapter.ts` 的 `case "tool_execution_start"`：`arguments: event.args` 写进 `tool_intent` 记录。
8. **网关的过程记录不接受多出来的字段。** 来源：`packages/gateway-contracts/src/validation.ts` 第 175 行：``if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");``。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **参数。**`toolDefinition()` 给每个参数结构是对象的工具加两个可选的字符串参数：`activity`（一句话说这一步在做什么）和 `activityIcon`（图标名）。工具自己已经有同名参数的，不加，也不删它的参数。两项都不进 `required`。说明文字在 `packages/prompt-catalog/src/activity.ts`。
2. **图标表在系统提示里只列一次。**40 个图标里“结果”那 4 个（`hand-stop`、`alert-circle`、`player-stop`、`check`）是服务器知道的状态，不给模型挑；其余 36 个连同每个名字的意思写成系统提示里的“过程图标”一节，只要有一个工具带这两个参数就加上。参数说明里只写“从系统提示‘过程图标’一节挑”，不在每个工具里重复列 36 个名字。参数类型是字符串，不用枚举：名字不在表里时不让工具调用失败，由服务器换成 `tools`。
3. **执行前取走。**在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里，对加过这两个参数的工具，从 `event.input` 删掉它们（前提 2）。所以权限判断（`preflight`）、审批、工具本身和“工具循环停止”的判断看到的都是去掉后的参数。这是 Pi 官方写法，不新增偏离。
4. **随过程记录发出。**`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录时，从模型的参数里取出这两项：`activity` 去掉首尾空白、最多 80 个字符；`activityIcon` 在 36 个名字之内就原样给，模型给了那句话但图标没给或不在表里就给 `tools`，那句话也没给时两个都是空字符串。记录的 `input` 里不再有这两项。网关契约 `threadExecutionRecordSchema` 加这两个字段。网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值。
5. **退回。**两个值都为空时，网页仍用现在的模板句子和图标；手机显示这一步的名称、图标用 `tools`。模板不搬到服务器：模板要三种语言，在网页的 i18n 里。

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
- **网页暂时不显示这句话。**网页的过程区仍用模板句子；要不要改用模型那句话，按详细设计“网页的过程区可以用同一句话”另行决定，改了要做真实网页上的正反两种验收。
- **测试。**`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 的 `[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型锁住：工具定义带这两个参数、系统提示只出现一次图标表、工具执行和权限判断拿到的参数里没有它们、工具自己的同名参数原样保留、过程事件里仍有它们；把钩子里的删除去掉，这条测试会失败。`test/integration/thread-run-lifecycle.test.ts` 的 `[ICON-2]` 用真实 SQLite 锁住过程记录的两个字段、退回 `tools`、`input` 里不再有它们，并用网关契约逐条解析。
- **请求字节的对照文件更新了。**`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本，其他字段不变。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范：工具执行前拦截或改参数](../pi-development-guide.md#pattern-tool-call)
- [发给模型的内容只追加](../../.claude/rules/prompt-prefix.md)
- [ADR 0165：按对话冻结请求开头](0165-freeze-the-request-head-per-conversation.md)
- [ADR 0203：照 Pi 官方的扩展写法](0203-follow-pi-official-extension-patterns.md)

[返回阅读导航](#contents)
