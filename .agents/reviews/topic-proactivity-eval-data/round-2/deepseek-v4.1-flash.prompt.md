你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5834935d102709955c38e76220c6ed8a6df5cc51。
待审核的方案：
# 线程的方案：一行判断加后续事件，评估只读决策记录这一组表

列出的方案只是参考，不要局限于它。请从问题本身出发，找漏掉的场景、判断错的地方、和业界成熟做法不一致的地方；如果你认为有更好的方案，请直接提出，和这份方案同等对待。

## 要解决的问题

愿景 Jarvis Test 第 10 条要统计所有由模型做的门槛决策（主动提醒的开口与沉默、记忆保留与丢弃、整理合并与作废）的命中率、误扰率、已审漏报率并看趋势。主人问的是：记哪些数据、数据的什么状态，才能判断系统和 agent 变好还是变坏；现在数据散在很多表里，要不要整理。

## 核心判断

主动性是一道判断题：每来一件事，判断要不要开口。要下“变好还是变坏”的结论，四样东西缺一不可：

1. 每一次判断（开口和沉默都算）连同当时看到的材料和模型给的把握分数。
2. 这次判断的正确答案。
3. 做判断时是哪一版：模型、提示词、门槛设置。
4. 这次开口有没有到主人眼前。

现状：邮件主动检查基本有 1 和部分 2；想一想、提议箱没有 1；3 哪里都没有；4 只有推送有。

## 数据模型：一行判断，加挂在它上面的事件

原则：干活用的表（think_inbox、owner_proposals、web_push_outbox、web_push_attempts、web_push_feedback）只管流程状态；评估用的事实只存在决策记录这一组表里，每个事实只有一个家。

### 1. decision_ledger：每次判断一行

- 所有主动来源的判断都写一行，包括决定不开口。
  - 想一想：在 `apps/agent-service/src/production-think-worker.ts` 的 `settle` 处写。`worth_no`、`worth_unsure`、`nothing_to_propose` 写 `proposal/not_proposed`；写出提议写 `proposal/proposed`（或 `told`）；运行失败、答案无效、动作被拒写新结果值 `proposal/judgment_failed`（不算判断，只计数）。`content_ref` 指向 think_inbox 的摘要载荷（她当时看到的材料），`subject_ref` 是 `think:<条目编号>`，写出提议时另记提议编号。
  - 提议箱：任何来源创建提议时，在 `sqlite-owner-proposal-operations.ts` 的创建事务里写 `proposal/proposed`，`subject_ref` 是 `proposal:<编号>`；同一个提议由想一想产生时只写一行（想一想那一行带上提议编号，提议箱不再重复写）。
  - 邮件主动检查、记忆、整理照旧。
- 重建 decision_ledger 一次，做这些改动：
  - 新增 `origin`：这次判断来自哪个来源（gmail、think 的来源种类、对话里、感知等），取值来自已有的来源登记，不写死。
  - 新增 `version_id`，指向新表 `decision_versions`。
  - 放宽 `confidence_permille` 的 CHECK，让所有种类都能记把握分数（现在只允许 memory_candidate）。想一想第一次判断（Jev）的置信度、邮件判断的分数都记进来。
- 新表 `decision_versions(id, owner_id, agent_id, fingerprint JSON, first_used_at)`：`id` 是指纹内容的 SHA-256；指纹包含实际作答的模型、提示词编号和内容摘要、当时生效的门槛和设置值、来源名。同一指纹只存一行。所有写决策记录的地方（邮件判断、想一想两次判断、记忆捕获、整理）都带上。

### 2. decision_signals：判断之后发生的每件事一行

- 信号种类从 CHECK 改成参照表 `decision_signal_kinds(signal, actor, explicitness, polarity)`：
  - `actor`：owner（主人做的）或 system（系统发生的）。
  - `explicitness`：explicit（明说）或 implicit（从行为推测）。
  - `polarity`：positive、negative、neutral。
- 取值：
  - 露出（system、neutral）：`delivered`（推送送达设备）、`shown`（App 里卡片第一次显示在屏幕上，由客户端回报）。
  - 主人明说：`accepted`（说好，positive）、`rejected`（说不用，negative）、`undone`（说好后撤销，negative）。
  - 主人行为：`opened`（neutral）、`dismissed`（neutral）、`replied`（后来自己去做了，positive）。
  - 系统结果：`executed`（说好后办成，positive）、`execution_failed`（negative）、`expired`（到期没人理，neutral）、`superseded`、`withdrawn`（neutral）。
- 提议箱的状态变化在 `sqlite-owner-proposal-operations.ts` 的同一个事务里写对应事件。
- 推送：`web_push_feedback` 去掉 `opened_at`、`dismissed_at`，只留送达和短编号。设备回报的短编号先找到对应判断（按 `push_source_key`），再写事件。没有判断的推送（主人自己定的提醒、审批请求、任务完成）在送达时写一行 `web_push/delivered` 决策记录，事件挂在它上面；这类不进准确率，只单独统计点开率。旧的点开、划掉搬成事件。
- 客户端回报统一成一个命令（现有 `push.feedback.record` 扩展或新命令），能回报 shown、opened、dismissed，带发生的表面（App、通知、手表）。main 上苹果客户端目前没有任何远程推送代码，客户端部分交给做苹果端的线程，服务端先把接口做好。
- 决策记录 `proposal` 种类里已登记但只表示主人反应或后续结果的结果值（accepted、dismissed、expired、executed、failed、undone、superseded）不再使用，从参照表删除，避免两处都能记。

### 3. 主人的评分

- 沿用 `decision_ledger.owner_rating`（useful、unneeded、missed）。
- 每日复盘的抽样范围扩到 proposal 种类（含想一想的沉默）。抽样优先级：先抽“露出了但没有明说事件”的开口，和把握分数靠近门槛的沉默；已经有明说事件的不抽。
- 邮件按封评分（`proactive_processed_messages.owner_rating`）保持不变：它的单位是一封邮件，不是一次检查，和决策记录的评分不是同一件事。

### 4. “关掉这一类”

主人关掉一个主动来源或调低它的上限，已经会写 `limit_change` 决策记录；补上“启用/停用”的变化也写。统计时把停用算作最强的负面信号，不挂在某一次判断上。

## 怎样算出结论

正确答案分三档：主人评分 > 主人明说的事件 > 行为推测。前两档进对错，第三档单独列。

线上趋势（复用 `packages/calibration`，按 origin 和 version 分组，30 天和每周两种窗口，带 Wilson 区间和样本量）：

- 准确率 = 判为对的开口 / 有答案的开口。
- 漏报率 = 评为“漏了”的沉默 / 抽查过的沉默。
- 打扰量 = 每天露出次数；其中负面事件次数。
- 办成率 = executed / accepted。
- 覆盖率 = 有答案的开口 / 露出的开口（太低说明数字不可信）。

区间不重叠才说变好或变坏，否则写“看不出”。“没反应”不写入，读取时按可配置窗口计算；窗口等定义放设置，改了以后历史按新定义重算。

不花钱的同题重考：因为每次判断（含沉默）都记了把握分数，改门槛时可以直接用历史记录算“如果门槛是 X，准确率和漏报率各是多少”，不用调用模型。

要花钱的同题重考（后续，另报主人批准）：换模型或改提示词时，把评过分的历史判断连同材料重做一遍比分。

## 不做

- 统计页面另开。
- 不改任何发给模型的内容，不新增模型调用。
