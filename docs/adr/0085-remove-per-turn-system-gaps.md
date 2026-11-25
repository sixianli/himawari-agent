---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md"
date: "2026-10-26"
covers: "apps/agent-service/src/production-titled-runtime.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0085：去掉每轮回答里 Himawari 自己造成的等待

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0054 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-26 第十二版上线后，用生产数据库的 `trace_events`（每轮执行过程的事件表，只取了事件类型和时间）和服务日志核对了两轮对话的耗时（原始数据在项目共享文件 `2026-10-26-news-run-trace.txt` 和 `2026-10-26-run-gap-journal.txt`）：

- “我最喜欢的颜色是？”这一轮共 12.1 秒，模型真正输出只用了约 3.9 秒，没有调用任何工具。上下文准备好（`context.formed`）到模型开始（`runtime.model_started`）之间有 2.7 秒没有任何事件；模型输出结束 1.1 秒后才写进数据库；运行结束后又过了 1.7 秒回答才提交。
- “查新闻”这一轮共 27.1 秒，其中准备和衔接约 6.4 秒；“等你确认”事件比实际暂停晚约 3.6 秒才写进数据库，而网页从数据库读事件，所以确认卡片会晚出现。

从代码和日志查到的原因：

1. **每轮开头都预热沙箱**（沙箱：用操作系统机制限制程序能访问的文件和网络的隔离环境）。日志里预热分别用了 4.9 秒和 7.5 秒，两轮里事件写入变慢、运行完成推迟的时间点，都紧跟在预热结束之后；颜色那轮根本没用工具。每轮结束时还要先停掉这个沙箱（约 1–2 秒），才提交回答。2026-10-26 起联网搜索已经不进沙箱（[ADR 0079](0079-parallel-read-only-tools-and-host-web-tools.md)），平时聊天和搜索基本用不到它。
2. **调度器（取出待执行对话轮次并开始执行的循环）没人叫醒**。`ProductionRunDispatchLoop` 有 `wakeup()`，但整个产品代码里没有地方调用它，新消息和审批后的续跑都要等每秒一次的兜底扫描，每次白等 0–1 秒。
3. **后台起标题拖住了整轮**。第一条回答文字出现时，后台会启动起标题、记忆写入、对话片段摘要和记忆整理四个模型调用；这些调用借用本轮的执行租约（证明“这一轮由谁执行”的凭证）登记，所以本轮在暂停或完成之前要等它们都登记好。但记忆写入要等起标题的模型调用**整个做完**才开始登记，新对话第一轮的确认卡片和“已完成”因此要多等一次模型调用。
4. **找记忆和读档案先后进行**。上下文准备时先拼档案（`OwnerProfileService.compose`），再做记忆检索（含一次向量化网络调用），两者互不依赖。
5. **每个流式事件都单独写一次进度检查点**。模型每吐一段字，协调器（`RunCoordinator`）要写事件内容、事件记录、进度检查点三次数据库提交，加上运行层自己保存的一次，共四次。生产数据库用 WAL 加 `synchronous = FULL`（每次提交都等数据落盘），而这台机器每次同步写入约 11.5–18.7 毫秒（[BL-20261001-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 的实测），所以文字写进数据库会落后模型。进度检查点里流式期间变化的只有事件计数和最后事件编号，恢复逻辑并不依赖它们。

Andy 2026-10-26 在沙箱方案文档里同意了“按对话复用沙箱、用到才启动、不再每轮预热”的方案 B（[ADR 0054 的 2026-10-26 补充](0054-readonly-tools-in-host-and-reused-task-sandbox.md#parallel-session-start)记了第一步，并写明“按对话复用和去掉每轮预热另行记录”）。他对过程区的要求（原话）：“每一步的时间一定一定要准确。因为如果不准确的话，就没办法从这个这一每一轮的这个过程里面看到主要的耗时。”

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **不再每轮预热沙箱。** 服务不再在每轮开始时调用 `prewarmEnvironment`。第一次真正用到 `bash`、`write`、`edit` 时才启动常驻沙箱，同一轮之后的调用照旧复用它。没用工具的一轮不再启动沙箱，结束时也就没有沙箱要停。沙箱服务里的预热入口保留，留给方案 B 的下一步“按对话复用”使用。
2. **命令被接受后立刻叫醒调度器。** HTTP 网关的命令接口（`/api/gateway/v1|v2|thread/v3/commands`）返回成功后调用 `wakeup()`，覆盖发新消息和点“允许”后的续跑；每秒一次的兜底扫描保留，用来处理其他来源的待执行轮次。
3. **后台模型调用同时登记，不再等起标题做完。** 起标题和记忆写入在第一条回答文字出现时同时开始；本轮在暂停、需要核对结果或完成之前，仍然等这四个后台调用都在本轮租约下登记完（登记完成指模型调用已记为“已开始”，不等模型回答），租约约束不变。实现在 `apps/agent-service/src/production-titled-runtime.ts`。
4. **找记忆和读档案同时进行。** 两者都完成后再记录候选记忆，事件顺序不变。
5. **流式事件不再逐个写进度检查点。** 只有阶段、结束状态或诊断码变化时才写；事件记录的父子链接照旧逐个相连，最后一次写入的检查点仍指向本轮最后一个事件。事件本身和执行租约检查不变。
6. **每轮写一行分段计时。** 每次执行结束时，服务日志写一行 `run.timing`：本轮总时长，以及上下文准备、记忆检索、模型调用登记、事件记录、数据库提交、工具检查和执行、停沙箱、提交回答等每一类步骤的次数、累计毫秒、最长一次和首次开始、最后结束的时间点。只记名字和数字，不记内容。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0054 的关系

本 ADR 取代 [ADR 0054 的 2026-10-25 补充](0054-readonly-tools-in-host-and-reused-task-sandbox.md#resident-prewarm)里“Run 开始时预热”这一条；同一段里“同一 Run 重新认领租约不再换环境”的复用规则不变。ADR 0054 的[决定](0054-readonly-tools-in-host-and-reused-task-sandbox.md#decision)本身不变：命令和写入仍在沙箱里执行，同一轮复用一个沙箱。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **保持每轮预热，只做其他减法**：第一次读写文件不用等，但不用工具的回答每轮仍被拖慢几秒。没有采用。
- **立刻做按对话复用的常驻沙箱**：每轮既不用启动也不用停，但要改环境的生命周期、回收和恢复，工作量约 1–2 天，按方案 B 排在后面做。
- **结束时先提交回答再停沙箱**：能省掉结尾的 1–2 秒，但要放宽“沙箱确认释放后才算完成”的规则；不预热以后，不用工具的轮次本来就没有沙箱要停，所以不需要放宽。
- **起标题和记忆写入不借用本轮租约**：本轮完全不用等后台调用，但后台调用就失去了按本轮权限登记的约束，要另设一套权限。没有采用；同时登记已经把等待缩到最慢一个的登记时间。
- **把每轮所有数据库写入合成一次提交**：省得最多，但要改多个存储接口和恢复逻辑。先只去掉进度检查点这一次；要不要让过程记录不再每次等落盘，另由 Andy 决定。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：没用工具的回答不再被沙箱预热和停沙箱拖慢；每轮开头和审批后续跑少等 0–1 秒；新对话第一轮的确认卡片和“已完成”不再等起标题；每段文字少一次落盘等待；每轮的耗时第一次可以按步骤拆开看。
- 代价：一轮里第一次用 `bash`、`write`、`edit` 要等常驻沙箱启动（ADR 0054 2026-10-26 补充之后预计约 3–5 秒，上线后按 `sandbox.srt_session.timing` 实测）。流式期间服务崩溃时，检查点里的事件计数会比实际少，恢复时照旧按“被中断”处理。
- 后续：按方案 B 做按对话复用的常驻沙箱；上线后用 `run.timing` 回填实测数据到[工程案例库](../engineering-casebook.md#case-run-gaps)；过程记录是否不再每次等落盘，Andy 2026-10-26 已选“过程记录不等落盘”，见 [ADR 0088](0088-process-records-skip-disk-sync.md)。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0054：只读文件工具在主进程执行，命令和写入复用任务沙箱](0054-readonly-tools-in-host-and-reused-task-sandbox.md)
- [ADR 0079：同一轮的只读工具并行执行，联网搜索和读网页在服务进程执行](0079-parallel-read-only-tools-and-host-web-tools.md)
- [BL-20261024-006：每个 Run 第一次用工具要等 9–16 秒](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/backlog/BL-20261024-006-first-tool-call-cold-start.md)
- [工程案例库：每轮回答里的系统空档](../engineering-casebook.md#case-run-gaps)
- [ADR 0119：模型开始写工具调用时预热沙箱](0119-conversation-speed-prewarm-on-tool-call-and-embedding-retry.md#amendments)（2026-10-30，修改本 ADR 决定第 1 点的启动时机）
- [SOURCE: docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md#resident-prewarm]
