---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0040-background-output-closed-after-bash-returns.md"
date: "2026-09-29"
---

# ADR 0039：Bash 主进程退出但后台程序仍占用输出时，按 Pi 的方式正常结束

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

模型在 Bash 工具里用后台方式启动程序时，例如 `npm run dev &` 启动本地网页开发服务器，Bash 主进程很快退出，但后台程序继承了同一个输出通道（stdout/stderr，程序写出文字的管道），并且一直不关。

2026-09-29 工具执行排查第二轮在真实 Mac 产品路径上确认：Himawari 的 Bash 适配器 `createSandboxedCodingOperations().executeCommand()`（`packages/platform-node/src/files/sandboxed-coding-operations.ts`）只在子进程的全部输出通道关闭时才结束命令，所以这类调用会一直卡着，直到工具期限才被强制结束。证据见 `.ci-output/tool-execution-audit/2026-09-28/round2/b3-r1-diagnosis.md`。

上游 Pi（本项目依赖的开源编程助手框架，固定版本 0.84.2）的本地 Bash 已经处理了同一个问题：`waitForChildProcess` 在主进程退出后继续读取输出，输出连续安静 100 毫秒才结束调用，返回退出码，后台程序照常运行（源码 `dist/utils/child-process.js`，注释引用 earendil-works/pi#5303）。

[ADR 0033 决定](0033-process-sandbox-default-and-optional-containers.md#decision)第 5 条规定，SRT 模式（在宿主机上限制单个进程能访问哪些文件和网络的进程级沙箱）下后台任务和本地网页开发服务器这类服务任务照常允许。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

用户在 2026-09-29 确认：

1. Bash 主进程退出后，继续读取输出；输出连续安静一小段时间（沿用 Pi 的 100 毫秒）就结束这次调用，正常返回退出码和已经拿到的输出。每收到一段新输出，重新开始计时。
2. 后台程序继续运行，不因这次调用结束而被结束；目录占用的释放仍按 ADR 0033 第 2 条处理。
3. 返回给模型的结果里注明：仍有后台程序在运行，它之后的输出不会显示在这次结果里。
4. 界面按 ADR 0033 第 5 条让用户看清还有哪些后台程序在运行。
5. 不把这种情况当成失败，不丢弃已拿到的输出。工具期限、取消、资源上限、不重新执行等现有规则不变：后台程序持续输出、输出一直不安静时，由工具期限结束调用。
6. 实现时优先复用 Pi 的现有能力；如果 Pi 没有把它作为公开接口提供，只能在 Himawari 适配器里实现同样的做法，要记录缺少的 Pi 能力和原因。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：照 Pi 正常结束（采用）

- 好处：后台启动开发服务器这类常见用法能正常工作，与上游 Pi 和 ADR 0033 第 5 条一致。
- 代价：后台程序之后的输出不会出现在这次结果里；需要在结果和界面上说清楚。

### 方案 B：按确定失败处理

即工具执行排查第二轮 reply-15 中由 Claude 提出的 `SANDBOX_OUTPUT_INCOMPLETE` 方案：丢弃输出，告诉模型已按失败处理、效果未知。

- 好处：更保守，不会把可能不完整的输出当成完整结果。
- 代价：每次后台启动服务器都会报失败，模型可能以为没有启动成功而重复启动；与 ADR 0033 第 5 条冲突。

### 方案 C：暂记为已知限制

- 好处：这一轮不改代码。
- 代价：这类调用继续卡到工具期限才结束。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 不实现 `SANDBOX_OUTPUT_INCOMPLETE` 确定失败。
- 模型能拿到后台程序启动之前和启动时的输出，之后的输出拿不到；需要时应改用写日志文件等方式查看。
- 输出一直不安静的后台程序，会让这次调用持续到工具期限。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- SRT 模式的停止、释放和后台任务规则：[SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]
- 进行中的工具执行排查：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]
