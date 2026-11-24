你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 87721e1d7127b157cfa624746e2ec27452afdf22。
本 PR 的基线提交是 5206b1c9fdb50e38472ffd8ddbdafc2e9eb31d4e（main 与 87721e1d7127b157cfa624746e2ec27452afdf22 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md（在提交 87721e1d7127b157cfa624746e2ec27452afdf22 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0184-back-off-ignored-proactive-pushes.md, docs/adr/0255-model-scores-urgency-of-home-items.md, docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md, docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md, docs/adr/0274-new-things-go-through-one-think-entrance.md, docs/adr/0277-the-system-deletes-expired-think-threads.md, docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md"
superseded_by: ""
amends: "docs/adr/0230-perception-records-and-memories-inferred-from-perception.md, docs/adr/0244-hard-rules-step4-unified-push-gate.md"
date: "2026-11-24"
---

# ADR 0285：一个主对话加她自己开的子线程，所有新事情走同一个收件箱

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [出处](#links)

<a id="context"></a>

## 背景

Andy 要 Himawari 像 Anthropic 文章《Building always-on agents》（<https://claude.com/resources/articles/building-always-on-agents>）说的那样一直在线：所有来源先写进一个收件箱（inbox，存新发生的事的表），由一个工人取出处理。现状是：收件箱表 `think_inbox` 已建，但除了测试没有来源往里写；Andy 的每条消息各自建一次运行；邮件、手机感知、推送延后、首页排序、语音“是不是在叫她”各有一个只看一小块信息的小判断或固定公式；Andy 同意过的“去办一件事”会新开一个对话，散在对话列表里。

Andy 2026-11-24（JST）在设计线程里定了方向，原话包括：“我其实想做的是一个能帮我处理所有事情、既主动又聪明的 AI agent”（11-12）；“把‘判断模型值不值得想’这部分逻辑全部删掉。我要的是让主模型能看得到所有必要的上下文”；“打开就是一个主对话，没有新建线程这个入口”；“需要灵活判断的，都要交给模型；机械式、流水线式的……就留给程序”；“不要过分分散用户的注意力，用户的注意力一定要用在刀刃上”。这些决定改动 Agent 循环、权限、推送和数据结构，改回去代价大，所以记成 ADR。详细设计在[规格](../execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md)。

<a id="decision"></a>

## 决定

1. **一个主对话。** App 和网页只有一个主对话，没有新建对话的入口。Andy 的消息、她主动说的话都在这里。上线时删掉以前的全部对话（Andy 22:03 定，22:04 在看过“记忆出处会变空、记忆片段跟着删”的后果后仍选删）。
2. **她自己开子线程。** 主对话里的她判断一件事要不要放到后台的子线程（干净上下文的对话）去办、开几个；几件重活的子线程同时跑。任务说明照 Anthropic 多代理研究系统的几项写全。子线程用照搬 Claude Code 的四个待办工具（建、改、列、看）管计划；Andy 中途的新要求由主对话转给对应子线程。子线程每笔有费用预算，花完停下等主对话决定，全部花费受产品的花费上限管，到了停下等 Andy（合愿景原则 8）。
3. **一个收件箱、一个工人。** Andy 的消息、同意卡片的回答、邮件、提醒、子线程消息、感知、新记忆都写进收件箱，按对话分组交给一次运行；一次运行只处理一类来源（Andy 的，或外来的），因为权限按运行来源判断。表 `think_inbox` 改名 `inbox_events`，删掉每天计数的列和 `think_inbox_declined` 表。
4. **判断交给她，固定规则交给程序。** 删掉 7 处替她做决定的小判断和公式：感知五个分来源检查和条数上限、首页要紧度打分（ADR 0255）、推送延后判断（ADR 0273）、自动降频（ADR 0184）、邮件推送公式、“值不值得想”（ADR 0274）、语音“是不是在叫她”（ADR 0264；认声音那道保留）。程序只做去重、排先后、按 Andy 定的规矩延后推送、核对格式和出处、执行 Andy 点过的具体动作。
5. **Andy 的聊天记录保持干净。** 主对话和子线程之间的往来、收件箱事件都存为内部消息：模型看得到，聊天记录不显示。进度放在点开才看的“后台在办”。她只在真有新东西或要 Andy 拿主意时开口（照 Meta Muse 的“only when something is meaningfully new or needs your input”），开口时可以在消息下给可点的下一步选项；带具体动作的选项按钮文字由程序按真实参数生成，点了算这一次的同意。
6. **她说的话是聊天消息，推不推她定。** 新加“她的话”推送，内容是她写的原话；子线程跑完不再自动推；同一条推送用来源编号当推送表主键，防重放；安静时段规则（ADR 0244）加管“她的话”。提醒到点一定在主对话留一条消息，她那次运行失败时程序按原话准时推。
7. **权限照 Meta Muse。** 按动作和“有没有读过外来内容”定，不按是谁想到的：只读直接做；改 Andy 自己的、能撤回的，没读过外来内容时直接做，读过就问；发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数；花钱每次问。读过外来内容后的写操作对所有运行都从“拒绝”改成“问”。同意卡片可选“只这一次、这件事里、几天内、以后都行”，花钱只有“只这一次”。替换 Andy 11-24 早先定的“她自己想到的只能查”。
8. **上下文管理照搬 Anthropic 默认值。** 压缩在 15 万 token 时做；两次压缩之间成批清理旧工具结果：10 万 token 开始清、保留最近 3 次、每次至少清 5000、能按编号取回；计划、子线程结果、同意卡片和记忆快照不清。不做评测（Andy 20:50 定：“直接照搬人家就行了”）。清理是“发给模型的内容只追加”规则事先留出的例外。

<a id="options"></a>

## 放弃的做法

- **每件外来的事先开一个子线程判断，再报给主对话**：主对话更短，但判断时看不到 Andy 最近在聊什么。Andy 选了主对话直接判断。
- **保留旧对话、只从界面去掉**：线程推荐这个，因为记忆出处不会变空；Andy 看过后果后选了全部删掉。
- **子线程“跑满几次就停”**：Anthropic、OpenAI、Google 的官方资料都没有这种规则；改用费用预算。
- **按评测定压缩和清理的时机**：Andy 要求直接用 Anthropic 的默认值。
- **先查再写防重复推送**：两次运行同时查会漏，改由数据库主键拒绝。
- **按“谁想到的”分权限**：Muse 不这样分，且自己想到的事被一律拒绝，等于做不了。

<a id="consequences"></a>

## 后果

- 好处：Andy 只看一个地方；判断都由看得到全部上下文的主模型做；几件事并行，回复不被后台挤住；每次开口或不开口都有记录。
- 代价：主对话上下文更长，靠子线程分走重活、外来事件只放简要、压缩和清理控制；子线程同时跑得越多，运行位越不够，要在生产机实测后调大；删旧对话后，上线前的记忆没有出处，记忆线程“翻原话”查不到上线前的内容。
- 被取代：ADR 0184、0255、0264、0273、0274、0277、0278。ADR 0230 的感知分来源检查和条数上限、ADR 0244 的推送种类清单按本决定修改，其余不变。
- 后续：分五步上线，每步一个 PR，顺序和验收见[规格的分步上线](../execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md#steps)；编码由单独的线程做；App 界面交苹果端设计线程。

<a id="links"></a>

## 出处

- [SOURCE: docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md]
- [SOURCE: docs/product-vision.md]
- 一手资料：Anthropic always-on agents、多代理研究系统、上下文编辑和压缩文档，Claude Code 待办工具和 agent teams 文档，Meta Muse 两篇公开文章，OpenAI 定时任务帮助页；网址和原话见规格的[业界怎么做](../execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md#industry)和各节。
