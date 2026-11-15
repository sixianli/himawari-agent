---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0278：主人同意过的任务读到外部内容后，写操作改成问主人

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。主人同意后，Himawari 新开一个对话，把任务说明交给一次后台运行去办。这次运行的触发来源是 `external_event`。没有下面决定 1 的标记时，授权层把触发来源是 `external_event` 的运行当成带外部内容，内置规则对它的写操作直接拒绝，不弹审批。如果同意过的任务也这样处理，主人点了“同意”，任务只能查、读，要写入、发送就被拒，对主人来说像“同意了却没办”。

“想一想”方案 v2（`.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节，见前提 5）写明：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”，每个有后果的动作仍要主人点一下，不造绕过审批的口子。设备动作的例外见决定 3。

<a id="premises"></a>

## 前提

1. 同意后开的运行记成 `external_event`：`apps/agent-service/src/production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`，来源凭据是 `` sourceProofRef: `proposal:${proposalId}:${session.proofRef}`, ``。
2. “想一想”自己的运行也记成 `external_event`，但来源凭据不同：`apps/agent-service/src/production-think-runner.ts` 里的原文是 `` sourceProofRef: `think:${entry.id}`, ``。
3. 内置规则 `refuseBackgroundAfterExternalContent` 对“不是主人消息发起、带外部内容”的非读取动作给出 `refuse`；`askAfterExternalContent` 对带外部内容的非读取动作给出 `ask_owner`：见 `packages/application/src/rules/action-rules.ts`。两条同时命中时取更严的一条。
4. 工具读到的内容不是主人自己的数据时（例如 `web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`），这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`。
5. 方案原文在 `.agents/plan-drafts/think-step-plan.md`，标题是“修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）”，其中写着“A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准””。Andy 2026-11-15 在项目聊天回这份方案的原话是：“这里按照你的建议来”。

<a id="decision"></a>

## 决定

1. 读运行来源时（`thread.readRunExecutionSource`），触发来源是 `external_event`、来源凭据以 `proposal:<提议编号>:` 开头、并且这条 `task.run` 提议的状态是“已同意”，来源上就带 `ownerApprovedTask`。这个判断在数据库里做，只认服务器自己写的提议记录；来源凭据指向的提议不是“已同意”（例如还在待定），就不带。
2. 带这个标记的运行，授权层不再因为来源是外部事件就自动标上外部内容，并给每个动作加上事实 `run_source_owner_approved_task`（“这一轮是你同意过的一件任务”）。任务说明本身是主人看过全文后同意的，所以不算外部内容。
3. 内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）升到第 2 版，条件里加上“不带 `run_source_owner_approved_task`”。于是同意过的任务读到外部内容后，写操作由 `askAfterExternalContent` 接手，每一个都要主人批准；设备动作里不允许外部内容引出的那些（例如日历、联系人、家居）在设备动作授权层照旧直接拒绝，到不了这两条规则。
4. 没读过外部内容时，同意过的任务和主人自己发起的运行一样：只动主人自己数据、可撤回、不对外的写入由内置规则预先放行；发送、花钱、删除这类没有规则预先放行的动作照常问主人。
5. 运行开始时冻结的运行输入快照里也有来源；恢复运行（`RunExecutionInputService`）和到期结算（`production-run-expiry.ts`）拿冻结的来源和数据库里重新读出的来源比对时，用 `frozenRunSourceIdentity` 去掉 `ownerApprovedTask` 再比。这个标记每次都从数据库里的提议状态重新算，授权层读的也是重新读出的来源，所以不带这个键的快照照常恢复和收尾。
6. 想一想自己的运行、定时任务和其他外部事件运行不带这个标记，规则不变，读到外部内容后照旧直接拒绝。
7. 依据愿景的裁决顺序：边界与可逆性高于主动性。这个改动不放宽任何“问主人”的地方，只是把“直接拒绝”换成“问主人”，人工闸门还在。

<a id="industry"></a>

## 业界怎么做

Anthropic 的 Claude for Chrome 说明里写着“Claude asks users before taking high-risk actions like publishing, purchasing, or sharing personal data”，并把权限当作防御网页夹带指令的第一道防线（https://claude.com/blog/claude-for-chrome ）。这里同样不在读到外部内容后一刀切禁止，而是把有后果的动作交给主人确认。OpenAI 的 ChatGPT agent 帮助页这次打不开（返回 403），没有引用。

<a id="options"></a>

## 放弃的做法

- 保持直接拒绝，任务只能读：主人同意了却办不成，价值低。
- 读到外部内容后仍拒绝写，要写就拆成两步（先研究，再另提一条确定动作）：更安全，但主人要点两次，而且和 Andy 的答复“同意的任务什么操作都能做”不符。
- 给触发表加一个新的来源值：要重建表，效果和现在相同。
- 连审批都免：和“边界与可逆性高于主动性”冲突，不做。

<a id="consequences"></a>

## 后果

- 主人同意的任务读过网页后要写东西时，主人会多收到审批请求，每个写操作一次。
- `task.run` 提议没有撤销入口：主人同意时领取就把它标成“已同意”，之后没有代码再改它的状态（开运行失败只把执行状态记成失败），所以这次运行一直带着标记。数据库里核对“已同意”，管的是来源凭据指向另一条还没同意的提议的情况，这时不带标记。
- 一封精心构造的网页或邮件仍可能诱导任务去提出一个写操作，挡住它的是主人的审批。新事实的代码 `run_source_owner_approved_task` 记在动作意图里，控制中心的治理页列出的是这个代码本身，不显示它的说明文字“这一轮是你同意过的一件任务”；审批卡片本身这次没有改。
- 设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝，和主人自己发起的运行一样，这个改动不放宽它们。
- 回归测试：`test/integration/tool-action-registry.test.ts`（没读外部内容可写、读后改成问主人、没有标记仍拒绝），`test/integration/task-proposals.test.ts`（同意后来源带标记；来源凭据改指一条还在待定的 `task.run` 提议后不带），`test/integration/thread-run-lifecycle.test.ts` 和 `packages/application/test/frozen-run-source-identity.unit.test.ts`（冻结快照里没有 `ownerApprovedTask`、重新读出的来源有，运行照常恢复；来源的其他字段不同仍被拒）。
