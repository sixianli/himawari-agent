你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3c4eefa5ff9b9733cccb9b6e911a776d1d2a4262。
本 PR 的基线提交是 ec350d9a5664d994f30f40487d28c1065db97d11（main 与 3c4eefa5ff9b9733cccb9b6e911a776d1d2a4262 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md（在提交 3c4eefa5ff9b9733cccb9b6e911a776d1d2a4262 里的内容）

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

Andy 2026-11-15 同意了“想一想”方案 v2，其中写明：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”，每个有后果的动作仍要主人点一下，不造绕过审批的口子。设备动作的例外见决定 3。

<a id="premises"></a>

## 前提

1. 同意后开的运行记成 `external_event`：`apps/agent-service/src/production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`，来源凭据是 `` sourceProofRef: `proposal:${proposalId}:${session.proofRef}`, ``。
2. “想一想”自己的运行也记成 `external_event`，但来源凭据不同：`apps/agent-service/src/production-think-runner.ts` 里的原文是 `` sourceProofRef: `think:${entry.id}`, ``。
3. 内置规则 `refuseBackgroundAfterExternalContent` 对“不是主人消息发起、带外部内容”的非读取动作给出 `refuse`；`askAfterExternalContent` 对带外部内容的非读取动作给出 `ask_owner`：见 `packages/application/src/rules/action-rules.ts`。两条同时命中时取更严的一条。
4. 工具读到的内容不是主人自己的数据时（例如 `web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`），这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`。
5. Andy 的同意经协调者转来：“按 v2 方案做，上线前评测约 0.6 美元可以花，残留风险已知情。复核轮次也都同意。模型调用和 A' 两个 PR 合并前仍等他说合并。”方案原文在 `.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节。

<a id="decision"></a>

## 决定

1. 读运行来源时（`thread.readRunExecutionSource`），触发来源是 `external_event`、来源凭据以 `proposal:<提议编号>:` 开头、并且这条 `task.run` 提议的状态是“已同意”，来源上就带 `ownerApprovedTask`。这个判断在数据库里做，只认服务器自己写的提议记录；来源凭据指向的提议不是“已同意”（例如还在待定），就不带。
2. 带这个标记的运行，授权层不再因为来源是外部事件就自动标上外部内容，并给每个动作加上事实 `run_source_owner_approved_task`（“这一轮是你同意过的一件任务”）。任务说明本身是主人看过全文后同意的，所以不算外部内容。
3. 内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）升到第 2 版，条件里加上“不带 `run_source_owner_approved_task`”。于是同意过的任务读到外部内容后，写操作由 `askAfterExternalContent` 接手，每一个都要主人批准；设备动作里不允许外部内容引出的那些（例如日历、联系人、家居）在设备动作授权层照旧直接拒绝，到不了这两条规则。
4. 没读过外部内容时，同意过的任务和主人自己发起的运行一样：只动主人自己数据、可撤回、不对外的写入由内置规则预先放行；发送、花钱、删除这类没有规则预先放行的动作照常问主人。
5. 想一想自己的运行、定时任务和其他外部事件运行不带这个标记，规则不变，读到外部内容后照旧直接拒绝。
6. 依据愿景的裁决顺序：边界与可逆性高于主动性。这个改动不放宽任何“问主人”的地方，只是把“直接拒绝”换成“问主人”，人工闸门还在。

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
- 回归测试：`test/integration/tool-action-registry.test.ts`（没读外部内容可写、读后改成问主人、没有标记仍拒绝），`test/integration/task-proposals.test.ts`（同意后来源带标记；来源凭据改指一条还在待定的 `task.run` 提议后不带）。
