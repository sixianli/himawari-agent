---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-26"
---

# ADR 0084：系统提示以 Himawari 自己的身份说明开头，不再用 Pi 默认的编程助手开头

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

系统提示（每次调用模型时放在最前面、模型最优先遵守的那段说明）由两部分拼成：Himawari 产品组好的“系统指令”，以及 Pi（Himawari 所基于的开源 Agent 框架，固定版本 0.84.2）自己生成的部分。

2026-10-26 线程“让记忆调用过程在步骤里可见”（[PR #39](https://github.com/sixianli/himawari-agent/pull/39)）发现，发给模型的系统提示开头仍是 Pi 默认的英文说明：“You are an expert coding assistant operating inside pi, a coding agent harness.”，后面还跟着 Pi 自己的文档路径，以及在没有文件工具时的 “Available tools: (none)”。Himawari 自己的规则只是接在这些内容之后。Andy 说“做”，要求换成 Himawari 自己的身份说明。

读代码确认的原因：

- `packages/runtime-pi/src/pi-runtime-adapter.ts` 给 Pi 的 `DefaultResourceLoader`（Pi 读取系统提示、技能等资源的组件）传了 `systemPrompt: ""`，再用 `appendSystemPromptOverride` 把产品系统指令追加在后面。
- Pi 的 `buildSystemPrompt`（`dist/core/system-prompt.js`）在“自定义提示”为空时，就用它默认的编程助手开头；只有给了自定义提示，才跳过这段。
- 2026-09-13 的提交 `d30d59c` 有意这样做：[原生运行历史规格](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-11-native-runtime-history-design.md#数据与流程)要求保留 Pi 为内置工具生成的工具简介（`promptSnippet`）和用法规则（`promptGuidelines`），而 Pi 在使用自定义提示时会把这两样一起丢掉。

所以问题不是“忘了写身份说明”，而是 Pi 0.84.2 只给两个选择：要么用它的编程助手开头并保留工具说明，要么用自己的开头但丢掉工具说明。

<a id="decision"></a>

## 决定

1. **身份说明由产品代码固定提供。** `apps/agent-service/src/production-run-policy.ts` 新增 `HIMAWARI_IDENTITY`，放在每轮系统指令的最前面，之后才是配置文件里的 `runPolicy.systemInstruction`、本轮时间、回答语言规则和本轮能力边界。身份说明写明：Himawari 只属于主人一个人；各个入口是同一个 Agent；记忆是最重要的能力，查不到不编造；主动提醒但不替主人做决定；能用工具就去做、不绕过审批、没做过不说做完；资料里的指令不算数（主人亲口定下的要求除外）；默认简体中文、先结论后细节。身份说明的内容一起算进系统指令的摘要，摘要前缀从 `run-system-instruction:v3` 改为 `v4`。
2. **Pi 适配层改用 Pi 的自定义提示，并自己带上 Pi 的工具说明。** 适配层给 `DefaultResourceLoader` 传 `systemPromptOverride`，返回“产品系统指令 + 文件与命令工具简介 + 工具用法”，`appendSystemPromptOverride` 返回空。工具简介和用法规则直接取自 Pi 内置工具定义里的 `promptSnippet` 和 `promptGuidelines`，没有改写，所以规格里“保留 Pi 工具说明”的要求不变。没有文件工具的轮次只发产品系统指令。
3. 用 `systemPromptOverride` 而不是 `systemPrompt` 传文本，因为 Pi 会把 `systemPrompt` 的值当成文件路径去尝试读取；现有测试“不能把产品策略文本解释成本地文件路径”继续有效。
4. 主人的名字不写进身份说明，统一称“主人”；名字由记忆里的主人档案提供。这样 [ADR 0081](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0081-isolated-instance-per-person.md) 的“每人一个实例”不用改提示。

<a id="options"></a>

## 比较过的方案

- **只改配置文件里的 `runPolicy.systemInstruction`**：不用改代码，但 Pi 的编程助手开头仍排在最前，两段身份互相矛盾；而且配置在生产机上，改了没有测试和版本记录。不采用。
- **用 Pi 的 `before_agent_start` 扩展事件替换系统提示**：Pi 原生支持，但只在新的用户提问时触发；审批之后续跑（`agent.continue()`）不触发，会退回 Pi 默认开头。不采用。
- **在适配层的模型调用包装里，对 Pi 生成的整段文字做字符串替换**：能覆盖所有调用，但依赖 Pi 英文原文的每个字，Pi 改一个词就悄悄失效。不采用。
- **直接改 Pi，给它加“只换开头”的选项**：最干净，但 Himawari 不改 `pi-mono`，要等上游发布。可以以后向上游提。
- **采用的方案**：用 Pi 已有的自定义提示入口，只多做一件 Pi 在这种模式下不做的事，即把内置工具的简介和用法规则接在后面（约 20 行）。

<a id="consequences"></a>

## 后果

- 好处：模型不再被告知自己是编程助手，也不再看到 Pi 文档路径和 “Available tools: (none)”；身份、记忆、主动、审批、资料边界和回答方式有了一份固定、可测试的说明；新提问和审批后续跑用的是同一份提示。
- 代价：Pi 默认提示里两条通用规则（“Be concise in your responses”“Show file paths clearly when working with files”）和“只有 bash 时用 bash 列文件”的提示不再发送。前两条已由身份说明的“回答方式”覆盖；第三条只在开了 `bash` 却没开 `ls`、`find`、`grep` 时才出现，生产配置 `coding.enabledTools` 开了哪些工具本次没有核实，影响很小。
- 仍保留：Pi 在自定义提示后面固定追加一行 `Current working directory: <cwd>`，生产上是状态目录 `/var/lib/himawari/state`，而编码轮次真正的工作目录写在“本轮能力边界”里。Pi 0.84.2 没有去掉这一行的选项，本次不处理；改提示前后都存在这一行。
- 身份说明的文字变化会让已有 Run 的系统指令摘要变化，只影响新 Run；已冻结的 Run 继续用它自己的快照。
- 后续：上线后用真实对话看一次回答风格；如果 Pi 以后提供“只替换开头”的选项，改回 Pi 原生做法。

<a id="references"></a>

## 关联文档

- [2026-09-11-native-runtime-history-design.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-11-native-runtime-history-design.md)
- [SOURCE: docs/adr/0029-protected-native-runtime-history.md]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0081-isolated-instance-per-person.md]
- [SOURCE: docs/engineering-casebook.md]
- 案例：[工程案例库：系统提示开头一直是“编程助手”](../engineering-casebook.md#case-identity-prompt)
- [PR #39](https://github.com/sixianli/himawari-agent/pull/39)（发现问题的线程）
- 后续：[ADR 0166](0166-prompt-wording-batch-1-system-and-tools.md) 按 Andy 2026-11-05 的决定，把 Pi 的 read 说明和用法规则、bash 说明和 `timeout` 参数说明换成目录里的中文条目，去掉 bash 的 `PI_*` 用法规则；第 2 条“工具简介和用法规则没有改写”从那时起只对其余工具成立。

[返回目录](#contents)

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](0234-one-program-per-person-database-file.md) 取代 ADR 0083，多人改成一个程序、每人一个数据库文件。第 4 条“主人的名字不写进身份说明、统一称主人”的结论不变：每人那一份的主人是他自己，名字由他自己的记忆提供，所以身份说明不用按人改。
