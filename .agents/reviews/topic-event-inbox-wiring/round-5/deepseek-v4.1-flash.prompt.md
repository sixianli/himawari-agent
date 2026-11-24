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
仓库就是当前目录，已检出 3a60083e39c98a18a6152e4ebb750f95fe126f52。
问题、目标和约束：
# 问题：Himawari 改成“一个主对话 + 她自己开的后台子线程”，所有新事情走同一个收件箱

## 背景

Himawari 是只服务一个主人（Andy）的个人 Agent，服务端在 `apps/agent-service`，Agent 循环用 Pi（`@earendil-works/pi-coding-agent` 1.5.0，规范见 `docs/pi-development-guide.md`）。产品愿景 `docs/product-vision.md`（原则冲突时：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率，第 55 行）。

这件事之前已经出过四轮方案（`.agents/reviews/topic-event-inbox-wiring/round-1` 到 `round-4`），但主人认为那是逐条打补丁，要求整体重新设计，并加入了新的要求。请不要参考旧方案文件，从问题本身出发。

## 主人的要求（原话，2026-11-16 到 2026-11-24）

1. 所有事件来源进同一个收件箱，由一个 worker 消费，再决定要不要跑 agent loop；主人自己发的消息、审批回答也进收件箱。连发几条能合就合成一轮。
2. “我希望所有的决策都尽可能让大模型去做，也希望大模型能掌握尽可能多的信息。”“我要的是让主模型能看得到所有必要的上下文，然后让它做出最聪明的判断。”所以：不要在主模型前面放只看一小块信息的小判断模型做筛选；不要程序写死公式决定推不推、说不说。
3. “我做这个项目我要做到极致，就是我要它足够聪明，你不用帮我考虑模型调用的问题。”设计里不得以“多一次模型调用”“更贵”为理由降低聪明程度。
4. 收件箱不设排队数量和每天数量上限（“提醒效果最优先，而不是我能不能看得过来”）；定时任务也不设每天跑几次、一共跑几次的上限。
5. 提醒到点也要叫醒她，由她带着记忆决定怎么提醒；但主人自己定的提醒绝不能丢。
6. 定时到点能不能动手看是谁要的：主人亲口说的、或主人同意过的提议，按 ADR 0278 的规则能写；她自己想到的只读。
7. 她发给主人的每一句话都是一条真正的聊天消息，存在聊天记录里；为什么发、推没推、主人觉得有用还是打扰，记在现有决策记录（`decision_ledger`）里，沉默也要记；她在任何对话里都要看得到自己最近主动说过什么、为什么。
8. 线程组织：“我希望这个 AI personal agent 有一个主线程：我大部分时候在这个主线程里和它聊天，然后由 Himawari 自己判断我发的这件事，有没有必要在背后单独新建一个干净上下文的线程去处理。”子线程处理中或处理完，可以在必要时实时和主线程沟通；主线程实时掌握每个子线程的进度和结果。核心目的是减少主人注意力分散。
9. 主人的担心：主会话上下文太长，模型能力会下降；大任务要能被她自己拆成独立的小任务交给子线程；每个子线程要先做计划（列出待办和完成标准），再一步一步做，达标后把结果交回主线程；主线程收集各子任务的完成情况再汇报给主人。
10. 子线程要能动态改计划：主人中途在主线程加需求或改动，主线程识别并分发给对应子线程；子线程重新思考，需要就更新计划，再接着做。“就是一个很智能的机制。”

另有一个独立线程在重新设计记忆系统（会给模型加“搜旧对话、打开旧对话原话”的对话工具和 `/memories` 文件视图的记忆工具；记忆快照在主对话每次压缩时重建，两次压缩之间的记忆变化追加在下一条消息末尾）。这里需要读记忆或旧对话时直接用那两个工具，压缩时机由这里定。

## 已核对的现状（main 提交 891955719，读代码得出，没有实测）

1. 收件箱表和工人已有但空转：表 `think_inbox`（`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql`），`docs/adr/0274-new-things-go-through-one-think-entrance.md:105`：“带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。”`apps/agent-service/src` 非测试代码里没有调用收件箱 `submit` 的地方。
2. 主人的消息一到就建一次运行，一一绑定：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1092` 写 `triggers`；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:147`：`trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,`；`packages/application/src/services/context-formation-service.ts:556`：`parsed.prompt.id !== request.trigger.id ||`；聊天系统提示 `packages/prompt-catalog/src/chat.ts:278` 写着“最后一条用户消息承载本轮的新请求”。
3. 后台“想一想”运行：判断模型先看一句概括决定值不值得想（`packages/prompt-catalog/src/think.ts:4` `think.worth-question`）；运行强制只读（`apps/agent-service/src/service-main.ts:1719` `readOnlyRun`；`packages/prompt-catalog/src/think.ts:38` “这次运行不能做任何写操作”）；只能提三种动作（`apps/agent-service/src/production-think-actions.ts:58`、`:75`、`:95`）；每件事开一个隐藏的后台对话，7 天后删。
4. 主人同意的“去办一件事”（`task.run` 提议）会新开一个对话：`apps/agent-service/src/production-task-proposals.ts:111`：``threadId: `thread:proposal:${key}` as ThreadId,``。
5. 邮件：模型看正文片段、每封最多 3 条相关记忆（`packages/application/src/services/proactive-mail-check-service.ts:211` `perMail: 3`）给出分类，然后固定公式决定推不推（同文件 `:1274` `const wantsPush =`）。
6. 手机感知：五个来源各一个检查提示（`packages/application/src/services/perception-source-prompts.ts:14-20`：speech、calendar、location、message、screen），提示里只有条目、日历和当前时间（同文件 `:42` 起），没有记忆；来源有每次、每天条数上限（`packages/application/src/services/proactive-source-runtime.ts:19` `ProactiveSourceLimitKind = "per_check" | "per_day"`）。
7. 推送：推送循环每 10 秒（`apps/agent-service/src/production-web-push.ts:28`）把到期提醒、审批、运行结束、最新提议、Muse 断开推出去，不经过模型；推送前另有一个判断模型只看主人此刻状态决定是否延后（`packages/prompt-catalog/src/perception.ts:596` `push.delivery-timing-question`，ADR 0273）；连续被忽略就程序自动降频（ADR 0184）。首页条目由另一个模型打要紧度（`packages/prompt-catalog/src/review.ts:72` `home.urgency`）。
8. 应用层有几套没有装进生产的服务：`AttentionPolicyService`、`ReflectionService`、`SchedulerService`、`SuggestionService`、`UnifiedTriggerIngestionService`、`DurableBackgroundWorkService`（在 `apps/` 下搜不到引用）。
9. 后台命令的结果以一条追加消息送回原对话（`packages/prompt-catalog/src/background.ts` 的 `background.notice`）。Pi 官方的运行中插消息：`docs/pi-development-guide.md:285`：“`deliverAs: "steer"` 在当前这轮工具跑完、下一次请求模型之前送达”。
10. 运行容量和时限（生产配置模板 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:150-157`）：`totalRuns` 3、`foregroundReserved` 1、`runMs` 300000。生产机 4 核 8GB。
11. 压缩：`packages/runtime-pi/src/compaction-prefix.ts:75` `COMPACTION_TRIGGER_CAP_TOKENS = 200_000`；模型上下文窗口 1,000,000（同一配置模板 `:87`）。
12. 发给模型的内容只追加、工具定义按对话冻结（`AGENTS.md` 第 43 行起，`.agents/instructions/prompt-prefix.md`）；理解用户意思交给模型，不用词表（`.claude/rules/owner-standing-rules.md` “理解用户的意思交给模型”一节）。
13. 授权：ADR 0278（`docs/adr/0278-*.md`）规定主人同意的任务能做什么；读过外部内容后写操作要先问主人。

## 一手资料（已读原文）

- Anthropic, Building always-on agents（2026-11-13）https://claude.com/resources/articles/building-always-on-agents ：“every source sends an event to an inbox, where a worker picks it up.”“Events that continue earlier work, such as a reply from the user, resume an existing session”；运行中到的事件“you can either push it to the next run, fold it into the current run, or interrupt and restart.”；“An inbox should only have one active worker at a time.”；“For each ongoing task, the agent should keep a progress file that covers what's been done and what's left.”；“If a session becomes too long, you can either compact the older messages or start a new session.”文章没有讲子代理。
- Anthropic, How we built our multi-agent research system https://www.anthropic.com/engineering/multi-agent-research-system ：“Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries.”“The LeadResearcher begins by thinking through the approach and saving its plan to Memory”；“Currently, our lead agents execute subagents synchronously”，异步“adds challenges in result coordination, state consistency, and error propagation”。
- Anthropic, Effective context engineering for AI agents https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ：子代理“returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)”；压缩、工具结果清理、结构化笔记。
- Anthropic, When to use multi-agent systems https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them ：“Start with the simplest approach that works, and add complexity only when evidence supports it.”
- Claude Code 子代理 https://code.claude.com/docs/en/sub-agents 与 agent teams https://code.claude.com/docs/en/agent-teams （共享任务列表三种状态、主管可随时给成员发消息改方向、成员结束自动通知主管）。
- OpenAI 编排 https://developers.openai.com/api/docs/guides/agents/orchestration ：agents as tools 时“The manager keeps ownership of the reply.”
- Pi 自带的子代理示例：`@earendil-works/pi-coding-agent` 包里 `examples/extensions/subagent/`（每个子代理一个独立 pi 进程）。

## 请回答

1. 主对话和子线程怎么组织：谁决定开不开子线程、开几个；子线程的任务说明里要有什么；子线程怎么先列计划、按计划做、判断完成；结果怎么交回、主对话怎么汇总并告诉主人。
2. 主对话和子线程之间怎么实时互发消息；主人中途改需求时怎么送到对应子线程、子线程怎么改计划；主对话怎么随时看到每个子线程的最新计划和进度。
3. 收件箱怎么同时服务主对话、子线程、外来事件（邮件、感知、记忆）、定时（提醒、跟进、周期任务）、审批回答；并行和先后怎么排；一次运行 5 分钟时限下长任务怎么续。
4. 主对话怎样一直保持不变长、不变笨（压缩时机、什么留在主对话、什么放外面）。
5. 子线程里遇到要主人审批的写操作怎么办；子线程的权限从哪来。
6. 现有代码里哪些“写死的决定”和“只看一小片信息的判断”要改、怎么改、哪些应保留以及理由。
7. 分几步上线、每步的验收（正向和反向）。
