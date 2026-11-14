---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0060-hard-constraint-on-third-repeat.md"
superseded_by: ""
amended_by: "docs/adr/0269-load-instructions-on-demand-at-thread-start.md"
date: "2026-10-29"
---

# ADR 0107：每个事故落一道自动检查，同一错误第三次必须有硬门槛

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0060](0060-hard-constraint-on-third-repeat.md) 规定：编码代理（Claude、Codex、opencode 等替 Andy 写代码和跑测试的程序）同一错误第三次出现时，停下来找根因并加硬约束（代理无法跳过的检查）；一次错误不需要记录。它管的是代理自己的操作失误，不管产品和上线出的事故。

2026-10-28 晚（日本时间，下同）出了两件事，都是“前面已经吃过亏、却没有任何检查拦住”：

- 第十八版上线时，worker（执行命令的后台进程）只等 agent（主服务）30 秒，agent 启动要 35–55 秒，切换后报 `WORKER_STARTUP_TIMEOUT` 自动回退，停服约 9 分钟。第十七版上线时同样超时过 2 次，只是 systemd 自动重启后碰巧起来了，没人当回事。
- PR #80 改了网页界面，发布走查测试（出包时在测试机上用真实浏览器按 Andy 的用法走一遍的测试）里的页面定位是写死的，没跟着改，直到出包时才被拦下，又多了一个 PR（#87）和一次出包。

此前的事故处理习惯是修掉那一个问题，再写进案例库或 lessons，没有要求“下一次会被什么自动拦住”。Andy 在 2026-10-29 00:56 同意“每个事故必须落成一道自动检查，只写文档不算关闭”，并加了一条：“如果同一个错误已经翻了三次，那么必须有一个硬门槛来阻止犯第四次，这个硬门槛可以是任意一种测试或者是可执行逻辑（脚本等）”（项目线程“建立事故硬门槛机制”的第一条消息）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

本 ADR 取代 ADR 0060，保留它的全部规则（第三次停下、先找根因、加代理无法跳过的硬约束、证明它在复现上失败而去掉错误后通过、计数跨会话和代理、代理的错误记在 `docs/lessons.md`），并增加：

1. **每个事故都要落成一道门槛，才算关闭。** 事故指生产故障、上线失败或回退、上线前很晚才被拦下的问题，以及 Andy 自己用时才发现、本来能被检查发现的缺陷。门槛是自动运行、不通过就拦住的检查：上线前检查、出包检查、测试、`npm run check` 里的一项、提交钩子，或者每次使用都会自检的脚本。只写文档、案例或提醒不算。
2. **同一错误第三次出现时，必须已经有硬门槛挡住第四次。** 这条对事故和代理的错误都适用；门槛可以是任何一种测试或可执行的逻辑。需要只有 Andy 能做的决定或操作时，先把门槛准备好再问他，条目标为“等 Andy”。
3. **事故与门槛清单。** [docs/incidents-and-gates.md](../incidents-and-gates.md) 每条写日期、现象、根因、出现次数、门槛（文件或命令）和状态。每个线程开工时读，收尾时更新。`npm run check` 运行 `scripts/check-incident-gates.mjs` 核对这张表：“已落门槛”必须写出仓库里真实存在的门槛文件，次数达到 3 的条目不能是“缺门槛”。
4. **收尾报告写明门槛。** 每个线程的交付报告写明这次的事故落了哪道门槛（文件或命令），或者为什么不需要。

今晚两件事各落一道：

- 启动超时：生产切换后的启动读回 `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs` 要求从 worker 启动到 agent 和 worker 都报 `service.ready` 不超过 30 秒（实例文件 `scripts/delivery-mode/instances/andy-production.json` 的 `startupReadyBudgetSeconds`），超过就判失败、按已有流程回退；`scripts/delivery-mode/make-packet.py` 出包时读该提交里 worker 的等待时间，要求“30 秒上限 + 15 秒余量（`startupReadyMarginSeconds`）”不超过它，否则拒绝出包。这样碰巧起来的慢启动也会被拦住，worker 等待和 agent 启动时间也不会再悄悄错开。agent 启动慢的根因由出包线程在 PR #89 修复（权限检查改到后台线程一次走完）。
- 走查没跟上界面：发布走查用到的页面定位集中到 `apps/control-center/test/release-walkthrough-ui.ts`；`apps/control-center/test/release-walkthrough.unit.test.ts` 用真实的网页组件（只把网络换成假数据）按走查的顺序点一遍，并检查走查代码不再自己写定位；它作为 `npm run check:release-walkthrough` 进了 `npm run check`，每次提交前都跑，约 3 秒。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：保持 ADR 0060，只管代理第三次的错误

- 好处：不增加工作量。
- 代价：今晚两件事都没到“代理第三次”，也不是代理操作失误，照样不会有任何检查；启动超时已经出现 4 次，仍然只靠运气。

### 方案 B：每个事故写进案例库和 lessons，加更详细的提醒

- 好处：成本低，面试材料也更全。
- 代价：ADR 0060 已经证明文字提醒挡不住；Andy 明确说只写文档不算关闭。

### 方案 C：每个事故都落自动检查，第三次必须有硬门槛，并用一张能被脚本核对的清单跟踪（采用）

- 好处：每个事故关闭时都能说出“下一次会被什么拦住、在哪个文件”；清单本身也被 `npm run check` 核对，不会写了一个不存在的门槛就算完。
- 代价：每次事故多花修门槛的时间；门槛会误拦（例如启动上限在慢机器上），要按实测调参数；清单核对只能证明门槛文件存在，证明不了它真能拦住，后者靠每条门槛自己的复现测试。

### 走查定位的两种做法

- 只在 PR 合并前要求跑一遍真实的发布走查：最接近真实，但要在 Hermes 上构建安装包（约 6 分钟）再走查（约 2 分钟），云端线程连不上 Hermes，每个界面 PR 都要开 Mac 远程会话。
- 共享定位加一个用真实网页组件跑的契约测试（采用）：约 3 秒，云端也能跑；代价是用的是 jsdom（在 Node 里模拟浏览器页面的库），自己按 ARIA（网页无障碍标准里的“角色”和“名字”）规则找元素，和真浏览器有细小差别，样式、布局和真实后端的问题它看不到，仍由出包时的真实走查兜底。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：用 #80 之前的旧定位重现，契约测试三处都失败（开关找成复选框、不先展开折叠的过程、去设置里找记忆）；去掉旧定位后通过。启动读回对 29.35 秒、35 秒、55 秒的启动都报 `STARTUP_READY_TOO_SLOW`，9 秒的启动通过。
- 负面：worker 等待还是 30 秒的提交出包会被拒绝（30 + 15 > 30），这是有意的；出包线程的修复 PR #89 已把等待改为 45 秒并先合进 main（提交 `d8b893a`）。启动上限 30 秒是按出包线程在生产数据副本上的实测定的，上线后按日志里的真实启动时间再调。
- 后续：
  - `AGENTS.md` 的 “Repeated Mistakes” 一节改为 “Incidents and Repeated Mistakes”，引用本 ADR；新增 `.claude/rules/incident-gates.md` 让每个云端线程读到。
  - 清单里 I-05（第 0 层漏跑相关测试，已 6 次）的门槛在快速模式下被关掉、云端会话也没有检查脚本，要不要恢复由 Andy 决定。
  - 规则再变时写新 ADR 取代本 ADR。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的决定：[ADR 0060](0060-hard-constraint-on-third-repeat.md)。
- 事故与门槛清单：[docs/incidents-and-gates.md](../incidents-and-gates.md)。
- 代理反复犯的错误：[docs/lessons.md](../lessons.md)。
- 发布走查上线门槛：[docs/lessons.md 的“上线验收只查了首页 200 没真点网页”](../lessons.md#release-without-browser-walkthrough)。
- 操作包生成：[ADR 0086](0086-generate-release-packets-from-parameters.md)。
- 面试案例：[工程案例库案例 47](../engineering-casebook.md#case-incident-gates)；启动慢的根因修复见[案例 46](../engineering-casebook.md#case-startup-permission-audit)。
