---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
covers: ".agents/instructions/pi-and-workspace.md, .claude/rules/owner-standing-rules.md, packages/runtime-pi/package.json"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0203：在 Pi 上加功能先照官方写法，偏离要 Andy 批准

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

Himawari 建在 Pi（Earendil 开源的 Agent 框架，官方仓库 <https://github.com/earendil-works/pi>）上。仓库原有的 [Pi 优先与工作区约定](../../.agents/instructions/pi-and-workspace.md) 只要求“先检查 Pi 能力、能复用就复用”，没有说“怎么接入”要照官方写法，也没有说偏离要谁批准。2026-11-10 核查发现，适配层有几处接入点没有用 Pi 文档推荐的写法，其中替换模型请求函数一处的 ADR 只比较了一种官方写法。

Andy 2026-11-10 的原话：“你得写一个 PI agent 的开发规范，让 AI coding agent 以后在开发 Himawari agent 的时候有一个参考，避免它在开发的时候自己胡乱发挥”；“最好在这个 Pi agent 的开发规范里面附上官方推荐的一些写法。除非是官方自己也没有好的解决方案，或者他们自己有缺陷的时候，我们才根据需求灵活发挥，但是呢，这种灵活发挥的地方，要把方案做出来，然后给我看看”；“你找官方文档的时候，请你找最新版本的官方文档，那些老旧、过时的就不要找来参考了”。

<a id="premises"></a>

## 前提

1. Pi 官方为每类扩展需求给了推荐接入点：`@earendil-works/pi-coding-agent@1.5.1` 的 `docs/extensions.md`（事件和 `pi.*` 方法）、`docs/sdk.md`（嵌入用法）、`docs/custom-provider.md`（接服务方）、`examples/extensions/`。例如 `docs/extensions.md` 第 973 行“tool_call … **Can block.**”。
2. 官方要求接服务方时尽量复用已有实现：`docs/custom-provider.md` 第 172 行“This is safer than copying a stream implementation because it preserves Pi’s message conversion, tool handling, usage accounting, cancellation, and compatibility behavior.”
3. 官方嵌入接口写明不得给内部状态赋值来恢复历史：`docs/sdk.md` 第 40 行“Assigning `session.agent.state.messages` does not replace persisted context.”
4. 锁定版本是 1.5.0（`packages/runtime-pi/package.json` 第 10、11 行），2026-11-10 的最新版本是 1.5.1（`npm view @earendil-works/pi-coding-agent version`）；1.5.1 把 `cacheWarming` 默认值从 `"streaming"` 改成 `"idle"`（`docs/settings.md` 第 21 行）。
5. 只有 `packages/runtime-pi` 能导入 Pi：[pi-and-workspace.md](../../.agents/instructions/pi-and-workspace.md#workspace-contract)“只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包”。

<a id="decision"></a>

## 决定

1. 新建 [Pi 二次开发规范](../pi-development-guide.md)，列出每类需求的官方写法（附出处和摘自官方的代码），AGENTS.md 写明在 Pi 上动工前必读。
2. 官方有写法就照官方写。只有官方没有能满足需求的写法，或官方写法有缺陷时，才允许自己设计；设计必须先出方案交 Andy，同意后才写进代码和规范，并另开 ADR、加一条在 Pi 行为变化时会失败的测试。
3. 查官方写法时同时读锁定版本和最新版本的文档，以锁定版本的接口写代码，两者不同之处写进方案或提交说明；不读比锁定版本更老的文档。
4. 2026-11-10 核查出的 7 处现有偏离登记在规范的[现有偏离表](../pi-development-guide.md#current-deviations)，状态都是“待 Andy 定”；批准前新代码不得照抄，也不得在上面加功能。本决定不改代码。

<a id="industry"></a>

## 业界怎么做

- Pi 官方文档本身就按“先选最小的接入方式”组织：`docs/custom-provider.md` 第 7 行“Choose the smallest integration”给出从改配置到自写流式实现的顺序，只在前面都不行时才自写。
- 同类开源项目 OpenClaw 选了另一条路：把 Pi 的 Agent 运行时收回自己维护（`CHANGELOG/2026.5.22.md`“internalize the former Pi agent runtime into OpenClaw”，引自 [ADR 0198](0198-upgrade-pi-to-1-5-0.md#premises) 前提 7）。Himawari 继续用 Pi 的 Agent 循环，所以接入点要跟着官方走，否则每次升级都要重新对齐自己的写法。

<a id="options"></a>

## 放弃的做法

- **只靠原有的“Pi 优先”原则。**它只管“用不用 Pi”，不管“怎么接”，现有偏离就是在这条原则下产生的。
- **一次把现有偏离全部改成官方写法。**其中 D1（替换模型请求函数）动到发给模型的请求开头、准入和出口遮盖，按 [Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features) 属于大改动，必须先出方案讨论，不能顺手改。

<a id="consequences"></a>

## 后果

- 每个在 `packages/runtime-pi` 动接入点的改动，提交说明或方案里要写清用的是哪条官方写法（出处）或哪份批准过的偏离 ADR。
- 现有 7 处偏离要逐条出方案交 Andy 定；定之前它们保持原样。
- 升级 Pi 时要逐条重查偏离表，并看 `CHANGELOG.md` 里改了哪些默认值（例如 1.5.1 的 `cacheWarming`）。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md)
- [Pi 优先与工作区约定](../../.agents/instructions/pi-and-workspace.md)
- [ADR 0023：通用人工审批与持久执行恢复](0023-durable-hitl-execution.md)
- [ADR 0198：Pi 升到 1.5.0](0198-upgrade-pi-to-1-5-0.md)

[↑ 回到阅读导航](#contents)
