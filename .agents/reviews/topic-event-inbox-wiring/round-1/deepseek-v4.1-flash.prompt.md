你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5206b1c9fdb50e38472ffd8ddbdafc2e9eb31d4e。
问题、目标和约束：
# 问题：Himawari 的“新事情”怎样都走同一个入口，她怎样在主人不在时自己回头跟进

## 背景

Himawari 是只服务一个主人（Andy）的个人 Agent，服务端在 `apps/agent-service`。产品愿景见 `docs/product-vision.md`（原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率）。这件事要写进 PRD v0.3，作为最先实施的一项；v0.3 的目标是 Andy 每天在 iPhone 上用。

Anthropic 2026-11-13 的文章 Building always-on agents（https://claude.com/resources/articles/building-always-on-agents ）把常驻 agent 拆成五个部件：事件收件箱（所有来源写进一张持久表，由工作进程取出开运行，按来源编号去重，一个收件箱同一时间一个工作进程）、定时（跟进 follow-up 是 agent 给自己定的截止点，周期任务 schedule 按固定节奏；定时存在收件箱之外的表里，调度器到点往收件箱写事件，定时自己不开运行）、记忆（含每个进行中任务的进度文件，和“已经告诉过用户什么”）、权限、发件箱（发多少要用评测调，先安静再慢慢赢得注意）。

## 已核对的现状（main 提交 5206b1c9f，读代码得出，没有实测）

1. 入口表和工人已有：`docs/adr/0274-new-things-go-through-one-think-entrance.md`；`apps/agent-service/src/production-think-inbox.ts`（`ThinkSourceRegistry`、`ProductionThinkInbox.submit`）、`production-think-worker.ts`（`runOnce`：领一条、用 Jev 判值不值得想、交给运行）、`production-think-runner.ts`（以 `external_event` 来源开一次只读工具的运行）、`production-think-actions.ts`（运行能提的动作：`task.run`、新建提醒、改提醒时间，都进提议箱等主人点头）。
2. 没有任何来源接进入口：`apps/agent-service/src` 非测试代码里没有调用 `ProductionThinkInbox.submit` 的地方，也没有 `sources.register` 的调用；`production-http-composition.ts` 只启动了 `think.loop`。ADR 0274 第 105 行写“来源接入和旧代码清理在后续 PR 里”。
3. 邮件检查自带定时器：`apps/agent-service/src/production-proactive.ts`（`setInterval(() => void this.tick(), …intervalMs)`），判断结果写提醒页条目并可能推送。
4. 手机感知有自己的抽取定时器：`apps/agent-service/src/production-perception-extraction.ts`。
5. 提醒到点只推送：`apps/agent-service/src/production-web-push.ts` 的 `#deliver` 用 `listDue` 取到期项后发送。提醒工具只有 `reminder_set`、`reminder_list`、`reminder_cancel`（`production-reminder-writer.ts`），都是提醒主人。
6. Himawari 不能给自己定“过几天再看一眼”的闹钟，也没有主人说“每天早上帮我……”后会叫醒她的周期任务。应用层有写好但没装进生产的 `packages/application/src/services/unified-trigger-ingestion-service.ts`、`durable-background-work-service.ts`、`scheduler-service.ts`（`apps/` 下无引用）；数据库有 `scheduled_jobs` 表。
7. 推送：推送种类是 `"reminder" | "approval" | "run"`（`packages/application/src/ports/web-push.ts`）；ADR 0273 用判断模型在主人忙时延后推送；ADR 0184 被忽略的推送自动降频；`packages/application/src/services/attention-policy-service.ts`（ADR 0014 的集中注意力策略）在 `apps/` 非测试代码里无引用。
8. 对话里的 Himawari 没有读“她主动告诉过主人什么”的工具。
9. 没有跨多次运行的任务进度记录。

## 目标

- 新邮件、新存下的记忆、手机感知到的事、她自己定的跟进、主人要的周期任务，都经同一个入口叫醒她；以后加新来源只是登记加写一行。
- 她能给自己定跟进（例：退款邮件 3 天没收据就再查一次并告诉主人），主人能要周期任务（例：每晚查明天天气判断要不要带伞）。醒来时她知道上次做到哪。
- 主人在 iPhone 上看到的每次开口或沉默都能追到是哪件事引起的。
- 新来源变多后不会各自决定推不推，把主人吵到。

## 约束

- 所有会改东西的动作仍要主人点头（提议箱）；后台运行只有只读工具。
- 发给模型的内容只追加：系统提示和工具定义按对话冻结，每轮会变的值只放最后一条消息（`.agents/instructions/prompt-prefix.md`）。
- 理解主人意思的判断交给模型，不用关键词表或正则（ADR 0249）；是非或多选判断优先用 Jev。
- 不许写死：数量、间隔、上限、门槛都要是可见可改的设置；清单要从登记表动态得到。
- 规则是硬性设定，不是记忆（愿景原则 3）。
- 只有一台 4 核 8GB 的生产机，SQLite 单写。
- 单人使用；多人不做。不考虑旧数据兼容。
- 请判断哪些该在 v0.3 做、哪些不该做，并给出分步顺序和每步的验收（要有一条正向、一条不该触发的反向，能在 iPhone 真机上做）。
