---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0085-remove-per-turn-system-gaps.md"
date: "2026-10-30"
---

# ADR 0119：模型一开始写工具调用就预热沙箱，找记忆的向量请求 3 秒没回就重发一次，Magpie 路由组把 CodeBuddy 排第一

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0085 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [后续](#follow-up)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 00:18（日本时间），Andy 在 iPhone 上用第十九版试了几轮对话后说"问一个很简单问题，都要花很久的时间"，要求做对话提速专项。线程用只读脚本拆了 10-29 23:46 到 10-30 00:22 的 13 轮对话（只读时间、次数和长度，不读内容；脚本和报告在项目共享目录 `conversation-speed/`）。去掉"等你确认"的审批时间后：

| 段 | 13 轮合计 | 每次 |
| --- | --- | --- |
| 模型出第一个字前的等待 | 142 秒 | 28 次请求，中位数 5.1 秒 |
| 工具开工前的空等 | 约 75 秒 | 17 次工具调用，中位数 3.2 秒 |
| 模型开工前（整理上下文、找记忆） | 46 秒 | 每轮中位数 3.4 秒，其中找记忆中位数 1.5 秒，最慢 9.1 秒 |

只调一次模型的简单问题，从按发送到看到第一个字用了 6.5–16.3 秒。

三处的原因：

1. **模型首字。** 生产主模型经本机 Magpie（把多个模型来源合成一个接口的路由程序，[ADR 0117](0117-magpie-routes-models-through-owned-subscriptions.md)）的路由组 `group/himawari-main` 依次尝试。组里排在最前的两个 OpenCode 免费模型在生产机上一直拿不到额度，每次都回 429（额度用完），之后才轮到 OpenCode Go 的 DeepSeek V4.1 Flash。等待时间与请求大小无关：4 千 token、没命中缓存的请求和 2 万 token、大部分命中缓存的请求都等约 5.1 秒。生产机上的短请求实测（每组 5 次）：经路由组中位数 3.0 秒，跳过免费模型直指 Go 2.5 秒，经 Magpie 走 CodeBuddy 新加坡 1.1 秒；生产机到 opencode.ai 的网络约 0.5 秒。
2. **工具空等。** [ADR 0085](0085-remove-per-turn-system-gaps.md) 去掉了每轮预热后，常驻沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境，同一轮里多次调用共用一个）要等工具请求一路走到 Worker（执行命令的后台进程）才开始启动。日志 `sandbox.srt_session.timing` 显示新开一个会话要 3.2–5.0 秒，写文件和执行命令各要一个会话；在它之前，工具请求的准入和派发（`tool.dispatch.timing` 的 `dispatch` 段）已经花了 2.4–6.7 秒，两段是串行的。
3. **找记忆。** 要先把问题变成向量（经 Vercel 去美国的供应商），连续发消息时 0.9–1.8 秒，隔几分钟再发的第一轮 1.9–9.1 秒；向量请求的超时等于整个模型请求的时限，慢的那一次只能干等。

<a id="decision"></a>

## 决定

1. **模型一开始写工具调用就预热沙箱。** Pi 运行适配器（`packages/runtime-pi/src/pi-runtime-adapter.ts`）在模型流式输出里看到工具调用开始（`toolcall_start`）时，立即用工具名回调 `onToolCallStarted`，不等过程记录写盘。服务（`apps/agent-service/src/production-tool-call-prewarm.ts`）只在工具是 `bash`、`write`、`edit` 之一、且在配置的 `runPolicy.coding.enabledTools` 里时，调用 [ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md#resident-prewarm) 留下的 `prewarmEnvironment`，同一轮只调一次。预热启动命令和写文件两个会话；真正的调用照旧走完整准入，只复用已启动的沙箱进程；预热失败只写诊断（`sandbox.srt_prewarm.failed`），真正的调用按原来的冷启动走。没用这三个工具的轮次不预热。
2. **找记忆的向量请求 3 秒没回就重发一次。** 在一轮对话里找记忆时，第一次向量请求最多等 3 秒；超时就把这次记为"结果不确定"（`markUnknown("transport_unresolved")`，和原来被取消时一样），用新的调用序号（`ordinal` 2）重新登记再发一次，第二次用剩下的全部时限。只重发一次，后台记忆整理不重发。重发时写诊断 `memory.embedding_retried`。3 秒取自 10-28 的 40 轮实测（中位数 1.39 秒，第 90 百分位 2.29 秒）。
3. **Magpie 路由组把 CodeBuddy 排第一。** Andy 10-30 00:41（日本时间）在选择卡上选定：`group/himawari-main` 改为 CodeBuddy 新加坡 DeepSeek V4.1 Flash → Go DeepSeek V4.1 Flash → Go GLM-5.3-Flash → 两个免费模型（挪到最后，不删）。这是生产机上 Magpie 的配置，不在本仓库。10-30 01:04 Mac 线程已改好并重启 `magpie.service`，改前备份和改后实测记在 [ADR 0117 的 10-30 顺序变更](0117-magpie-routes-models-through-owned-subscriptions.md#revision-1030-order)。
4. **上线前的网页走查给对话耗时设上限。** 走查（`test/integration/product-path-browser.test.ts`）记下“简单问题”和“执行命令”两个场景从按发送到答案出现的毫秒数 `answerMs`；`scripts/delivery-mode/browser-acceptance-gate.py` 在简单问题超过 4 秒、执行命令超过 12 秒或没有计时时拒绝出包和上线。走查用脚本模型，这个上限只管 Himawari 自己的耗时；第一版上限是 20 秒、60 秒；10-30 按第二十版走查实测（简单问题 1,223 毫秒、执行命令 5,721 毫秒）收紧为 4 秒、12 秒：执行命令约为实测的 2 倍，简单问题本身很短，测试机负载一抖动比例就大，所以放到约 3 倍。

<a id="amendments"></a>

## 与 ADR 0085 的关系

本 ADR 修改 [ADR 0085 的决定](0085-remove-per-turn-system-gaps.md#decision)第 1 点"第一次真正用到 `bash`、`write`、`edit` 时才启动"：启动时机提前到模型开始写这三个工具之一的调用时。ADR 0085 去掉每轮预热的理由仍然成立：不用工具的轮次仍然不预热，也不会在模型开始回答前就和流式写盘抢磁盘。ADR 0085 的其余决定不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 恢复每轮开始就预热（ADR 0054 的 10-25 补充） | 最早启动 | 10-26 实测每轮 4.9–7.5 秒，不用工具的轮次也付；与流式写盘抢磁盘 | 不选，ADR 0085 已否定 |
| 按对话常驻沙箱，跨轮复用 | 第二轮起完全不用启动 | 要改复用键、租约和停沙箱的时机，涉及安全设计，改动大 | 留作后续，见[后果](#consequences) |
| 工具调用开始时预热（本 ADR） | 只在真的要用工具时付；启动和模型写参数、准入、派发重叠 | 模型写了调用又没执行时白启动一次 | 选用 |
| 找记忆改用本机小向量模型（BL-20261028-008） | 每次约 90 毫秒 | 常驻约 1.4 GB 内存，要重建记忆索引；Andy 10-28 定"以后做" | 不在本次 |
| 找记忆不设单次上限，只靠总时限 | 不多花钱 | 慢的那次要等满（实测 9.1 秒） | 不选 |
| 两个请求同时发，先回先用 | 尾部最短 | 每轮都花两份钱、两条记账 | 不选；超时后再发只在慢时多花一份（每次约 0.00001 美元） |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 预计每轮第一次用到 `bash`、`write`、`edit` 时省 3–5 秒，同一轮第一次用另一类会话时再省 3–5 秒（预热同时启动两个会话）。找记忆的最长等待从 9 秒降到约 3 + 1.5 秒。CodeBuddy 排第一后，按短请求的实测，每次模型请求再省约 1.4 秒（真实大小的请求还没测）。实际效果以上线后真实网页的前后对比为准（测法：同样三句话，同一时段各发 5 次，比首字和整轮时长的中位数，见[后果](#measure)），写进[案例 63](../engineering-casebook.md#case-conversation-speed)。
- 预热会提前占用工作区租约：同一目录上另一轮的工具调用要等这一轮结束（ADR 0054 补充里已有的代价，只是开始时间从"第一次调用"提前到"开始写调用"）。
- 更多私人对话经 CodeBuddy 新加坡（数据留存 14 天，经社区登录插件），额度上限未核实；额度用完时 Magpie 按顺序退回 Go。
- <a id="measure"></a>前后对比的测法：上线前（第十九版）和上线后（第二十版）在同一时段（日本时间晚上）各发 5 次同样的三句话：“你是谁”“东京现在几点”（简单问题）和一个让它写一个小文件的任务。每次新开对话，跑 `conversation-speed/speed-profile.mjs` 读这些轮次的时间（不读内容），比较两组的首字时间中位数和整轮时长中位数；反向检查：不用工具的轮次日志里不能出现 `sandbox.srt_prewarm`。
- 后续：工具准入一次调用跑 6 遍完整核对（`sandbox.admission.timing`），派发段 2.4–6.7 秒，仍是[事故 I-25](../incidents-and-gates.md#incidents) 的主要剩余；按对话常驻沙箱见上表。

[↑ 返回阅读导航](#contents)

<a id="follow-up"></a>

## 后续

- 2026-10-30：[ADR 0123](0123-cut-off-embedding-attempt-charged-at-its-ceiling.md) 修改本 ADR 第 2 条：被 3 秒掐断的那次向量请求改为按费用上限结清，不再记“结果不确定”；重发改用新的调用位置 `<原位置>:attempt:2`。原做法会让这一轮的预算账户进入“待对账”，重发和主对话都被拒（事故 I-37）。其余决定不变。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0085：去掉每轮回答里的系统空档](0085-remove-per-turn-system-gaps.md)
- [ADR 0054：只读工具在宿主执行、同一轮复用沙箱](0054-readonly-tools-in-host-and-reused-task-sandbox.md)
- [ADR 0117：Magpie 经自有订阅路由模型](0117-magpie-routes-models-through-owned-subscriptions.md)
- [事故与门槛清单](../incidents-and-gates.md)
- [工程案例库：案例 63](../engineering-casebook.md#case-conversation-speed)
- [Backlog BL-20261028-008：本机向量模型](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/backlog/BL-20261028-008-local-memory-embedding.md)

[↑ 返回阅读导航](#contents)
