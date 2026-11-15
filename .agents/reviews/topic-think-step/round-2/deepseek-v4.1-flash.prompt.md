你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 b9063f750e22246eb2174f973a2a8bf4e8e3dba8。
本 PR 的基线提交是 8fc09d2b348c8fd16b9ae707bb602ea4afceeb7a（main 与 b9063f750e22246eb2174f973a2a8bf4e8e3dba8 的共同祖先）。
待核对的方案：
方案文件：.agents/plan-drafts/think-step-plan.md（在提交 b9063f750e22246eb2174f973a2a8bf4e8e3dba8 里的内容）

# 第 2 步「想一想」方案（草案，等 Andy 同意才动工）

日期：2026-11-14（JST）。接在 PR 520、530、533、534 之后。第 1 步已经做完：提议箱、两种确定动作、“去办一件事”开运行。这一步要做的是“谁来提议”：一个入口，把新知道的事交给她想一想，值得提时往提议箱里放一条。

## 一、先答两个问题

### 1. 大厂的主动建议怎么做，用户看到什么

我只信打开过或搜到摘要的一手来源，没打开原文的都标了。

- **OpenAI ChatGPT Pulse**：每天夜里异步研究，依据是记忆、聊天记录和你给的反馈，早上以一组卡片出现；每张卡可以点赞、点踩、点“调整”说想看什么。来源：<https://openai.com/index/introducing-chatgpt-pulse/>（这个页面我这边返回 403，没打开原文，只读到搜索给出的摘要，**未核实原话**）。它的发布说明（<https://help.openai.com/en/articles/6825453-how-do-i-give-feedback-on-chatgpt> 搜索结果里的版本）说 Pulse 已下线，主动更新并入“定时任务”，让用户自己说“每天早上给我一份简报”。下线原因没有找到原话，不能下结论；我的推断（未核实）是：一个无人要求、每天固定出现的内容流留不住人，让用户自己定的任务更稳。
- **Google Gemini 定时操作和任务计划**：用户自己写一句话加时间，或事件驱动（例如某个主题有新闻就运行）；也是用户先定。来源：<https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/>、<https://support.google.com/gemini/answer/17094710>（搜索摘要，没逐页打开）。
- **Anthropic**：无人值守的运行靠两层防护而不是一次次弹确认。原话（我打开读了）：“manual prompts … users accept 93% of them anyway”；“Auto mode uses two layers of defense: one for what Claude reads, one for what Claude does”；“stripping tool results is the primary prompt-injection defense, since tool outputs are where hostile content enters the context.” 来源：<https://www.anthropic.com/engineering/claude-code-auto-mode>。
- **Apple Intelligence**：个人上下文在设备上处理；我没有找到苹果关于“主动提议”的一手说明，**不下结论**。

对我们的意义有三条：
1. 用户看到的形态都是“一张可以接受、不要、调整的卡片，带一句为什么”。我们定的是同一个形态（一句问话、肯定按钮、否定按钮、为什么、风险档位，计划里否定按钮叫“不用”，网页现有的标签是“不要”，`apps/control-center/src/i18n/resources/zh-CN.ts:925`）。第 1 步已经有提议箱的存储和两个接口（`proposals.read`、`proposal.respond`，`packages/gateway-contracts/src/client-capabilities.ts:171-172`），但提议显示在首页上要等首页那几个 PR：`production-home.ts` 现在只接了旧的外部 agent 提议（`external_proposals`），没接 `owner_proposals`。
2. 没人要求的建议要极少而准。OpenAI 把固定的内容流收回成用户自己定的任务，说明数量大了就会烦。所以这一步默认很保守，宁可少提；“不用”要记下来影响以后。
3. 后台运行读到外来内容后，写操作要拦住，这和我们已有的做法（ADR 0257）一致，见下面第三节。

### 2. 这是不是根因做法

问题是：现在她只会等人问。根因不是“缺几个提醒功能”，而是**没有一个统一入口：新知道一件事时，没有地方判断“要不要主动说一句”**。做法是一个入口加一次判断，所有来源（邮件检查、新存下的记忆、以后的感知、日历）都往这一个入口写，不为每个来源单独写一套提议代码，所以这是根因做法，不是按场景堆规则。

要说实话的缺口：
- “值不值得提”的命中率现在没有数据，我们是靠评测和头几周的真实记录来调的，不是先知道的。
- 业界有 Pulse 下线这个反例（见上），所以第一版数量小、可关、可看到记录，没有数据证明好之前不扩大。
- 第一版想的那一次**不用工具**（下面第二节解释为什么），所以它只能凭事先查好的资料提议，查不了网。

## 二、方案

### 前提（每条写了来源，我自己打开读过）

1. 提议箱已有两类处理方，一步动作和“去办一件事”都能登记：`apps/agent-service/src/production-proposals.ts` 的 `ProposalActionHandler`（接口里的 `verify`、`execute`、`readBack`、`undo`），合并的提交 `8fc09d2b3`（PR 534）、`e2af70416`（PR 533）。
2. 现在没有任何来源调用 `proposeReminderReschedule`、`proposeReminderCreate`、`proposeTaskRun`。来源：这三个函数在 `apps/agent-service/src` 里只被定义和被测试引用，PR 说明写明“还没有来源调用”。（用 `grep -rn "proposeTaskRun" apps/agent-service/src` 可复现，结果只有定义文件。）
3. 后台模型调用的现有写法是“一段提示进、一段文字出”，不带工具：`apps/agent-service/src/production-model-composition.ts:531`（`async prepare({ invocationId, prompt, deadlineAt, dataClassification })`）。
4. 应用层有“定时、外部事件也能当触发来源”的类型，但生产服务没有接线：`packages/application/src/services/unified-trigger-ingestion-service.ts:13`（`export type UnifiedTriggerSource = "user_message" | "schedule" | "external_event";`），而 `grep -rn "trigger.admit\|TriggerAdmissionPort" apps/agent-service/src` 没有结果。所以“带工具的后台想一想”需要先新做一条不由主人消息开始的运行路径，这是大工程，第一版不做。
5. 是非题和多选题的判断已经有 Jev（TypeSafe AI 的决策接口）的现成调用写法：`packages/platform-node/src/memory-import-duplicate-decision.ts:81`（`POST ${base}/decisions`，经 Vercel AI Gateway，带 `zeroDataRetention: true`，同文件第 64 行）；权限审批用的是 `packages/platform-node/src/owner-intent-decision.ts:84`；说名字是不是叫她用的是 `packages/platform-node/src/voice-addressee-decision.ts:99`。Jev 的回答是“是”的概率；TypeSafe 的建议是不低于 0.7 算是、不高于 0.3 算不是，中间当作单独一种结果（`docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:57` 引的 <https://docs.typesafe.ai/confidence.md>）。Andy 在 11-14 定：是非和选一类判断优先用 Jev。
6. 同意后开的运行，触发来源是 `external_event`；这类运行里**不管读没读外部内容**，授权这一步都会把它标成“有外来内容”：`apps/agent-service/src/owner-scope-authorization.ts:249`（`if (source.sourceType === "external_event") await marks.mark(invocation.runId, "external_event");`）。内置规则拒绝其中的写操作：`packages/application/src/rules/action-rules.ts:238`（`action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts` → 拒绝）。
7. 触发来源只有三种，加新的要重建触发表：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`（`CHECK (source_type IN ('user_message', 'schedule', 'external_event'))`）。
8. 首页“正在做的”取的是来源不是 `user_message` 的运行：`packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:958`（`AND t.source_type != 'user_message'`）。
9. 第 1 步计划原文规定提议类型、按钮字数、不写死：`/mnt/project-files/ambient-sensing/proposed-actions-plan.md`（“审核后改的地方”一节优先）。

### 流程

1. **来源写一条“入口记录”**：类型、出处引用、版本、有没有外来内容、一句已经清洗过的概括。来源自己登记进一张表，新增来源只加一行登记，不改判断代码。
2. **程序先做不用模型的检查**（门）：同一出处同一版本只想一次；每天最多新建多少条提议（保险上限，默认 20，可改，用量页能看到今天卡掉了几件）；没有主人这边的依据的不想。数字都进配置，不写死。
3. **第一次判断：值不值得提——是非题，用 Jev。** 输入是入口记录的概括、近 7 天安排、检索到的相关记忆。Jev 答是或否并带信心值；信心落在“中间带”（按 TypeSafe 建议默认 0.3 到 0.7，两个数都是配置）、调用失败、解析失败，一律当“否”（安全默认），并记进决策记录。结果记进决策记录。
4. **第二次判断：想出提议——生成题，用 DeepSeek V4.1 Flash 走现有的后台模型调用。** 一次，不用工具：程序先把要用的资料（相关记忆、近 7 天安排、相关提醒）查好放进提示里，模型只能在**登记表现有的动作**里选一个（改提醒时间、新建提醒、去办一件事、什么也不做），并写问话和肯定按钮的字。提示里的动作清单由登记表**动态生成**：以后登记新动作，提示自动多一项，不用改提示词。
5. **程序校验后才放进提议箱**：动作名必须在登记表里、参数过各自处理方的检查、依据至少一条主人这边的记忆、按钮字数守上限，超了就用通用的“好”。外来内容引出的“去办一件事”照第 1 步的规则：必须读全文才能同意。
6. 之后全是第 1 步已有的：首页条目、推送、采纳、读回、撤销。

为什么第一版不用工具：带工具的后台运行要先装上“不由主人消息开始的运行”（前提 4），那是这个方案里最大的一块，而且工具能读网页就会碰到外来内容的白名单问题（已在计划“审核后改的地方”第 1 条定了做法：有外来内容的事只给本机工具）。先做不带工具的一次判断，数据和用户反馈有了再加。代价：由邮件引出的、需要上网查才能提准的事，第一版提不出来，只能提成“去办一件事”由主人点头后再查。

### 不写死的地方（逐项）

- 来源：登记表加一行。动作：登记表加一行，提示自动带上。
- 数量：每轮处理条数、队列长度、重试次数、过期时间、保险上限、Jev 的信心门槛，全是配置，默认放宽，用量页显示。
- 模型：走现有的模型路由配置，不写死模型名；Jev 的模型引用也在配置里。
- 不用词表判断“用户想要什么”：判断全部交给模型，程序只校验格式和白名单（符合 `owner-standing-rules.md` 里的规定）。

### 模型花费预估（估的，没实测）

没有仓库里的价格表，下面用最近的 DeepSeek 复核账来折算：一轮复核约 19 万输入、1 万多输出、几百万缓存读取，花 0.07 到 0.12 美元。折算：
价格有仓库里的出处：Jev 在 Vercel 上叫 `typesafe-ai/jev`，每百万输入 token 0.042 美元，输出不收钱（`docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:56`）；DeepSeek V4 Flash 的目录价是每百万 token 输入 0.06、输出 0.18、缓存读取 0.015 美元（`docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md` 的价格表，是 2026-09-07 读公开目录的观察值，当时的价，实际账单可能不同）。
- 第一次判断（Jev）：输入约 3 千 token，每次约 0.0001 美元。
- 第二次判断（DeepSeek 一次生成）：输入约 6 千、输出约 500，再加思考 token 按 2 千算，每次约 0.001 美元。
- 假设一天 50 个入口记录进门、其中 10 个过第一次判断：50×0.0001 + 10×0.001 ≈ 0.015 美元/天，按 10 倍留余量也不到 0.2 美元/天。
- 评测（上线前）：约 60 个合成用例（该提的、不该提的、夹带指令的外来内容、近重复）× 两次判断 ≈ 0.07 美元，远低于 0.5 美元，不用先问；按“花钱先问”的规定，超过时再问。
- 用量记成新用途 `next-step-proposal`，单独显示，不算进邮件检查现有的每日上限。

### 动工前要 Andy 同意的（这一步算“大改动”）

1. 新增一类后台模型调用（Jev 的是非判断加 DeepSeek 的一次生成）。这是改模型调用，要 Andy 点头。
2. 新增用途 `next-step-proposal` 和它的花费显示。
3. 第一版不带工具、先不装“不由主人消息开始的运行”，同意吗。

## 三、外来事件运行写不了的事：推荐做法

现状（前提 6）：同意后开的运行记成 `external_event`，授权一律当它有外来内容，所以它**一切非读取动作被直接拒绝**，不弹审批。结果是主人点了“好”，任务只能做只读的事，写操作会被拒，对主人来说像“同意了却没办”。

三个选项：

- **A（推荐）：新增一种“主人同意过的任务”的运行来源，写进规则里。** 触发表那一列不动（避免重建表，前提 7）：触发的来源凭据已经写着提议编号（PR 534 的 `sourceProofRef: proposal:<编号>:<凭据>`），读运行来源时按这个前缀判断，给它一个新的政策事实 `run_source_owner_approved_task`（改 `policy-fact-registry.ts`、`owner-scope-authorization.ts:249` 附近不再自动标外来内容、`RunExecutionSource.sourceType` 的联合类型加一项，`packages/application/src/ports/run-execution-source.ts:26`）。**读到了真的外来内容（搜索结果、网页、邮件）之后，写操作仍然拒绝**，因为 `refuseBackgroundAfterExternalContent` 的条件没变，只是不再无条件标上。这样：没读过外部内容的任务可以写（照常逐项审批）；读过网页的任务不能再写。需要“查完再办”的事，拆成两步：研究任务提供结果，写操作另外提成一条确定动作，让主人按那一行明细点头。理由：边界和可逆性高于主动性（愿景的裁决顺序）；和 Anthropic 的做法一致（读进来的外部内容是注入入口，要隔开）。
  - 代价：改授权规则，需要新 ADR、规则例子和测试，约 1 个 PR，复核要认真；属于“权限和授权”类大改动，要 Andy 同意。
  - 时机：建议在第 2 步上线给主人看到“去办一件事”提议之前做完；否则主人会遇到“同意了但被拒”。如果先不做，我在第二次判断的提示里让“去办一件事”只用于只读目标（登记表的描述动态带出这个限制），这样不会提出做不了的事。
- **B：保持现状，只读任务。** 零代码；任务写死成“只能查、列、总结”。风险小，但“同意了没办成”的例子会多，价值低。
- **C：给触发表新增来源值（重建表）。** 比 A 重，收益相同，不推荐。

## 四、分几个 PR（每个自己合）

1. 入口表和登记表（来源、动作），门（去重、保险上限、配置、用量显示）。不调模型，用测试里的假来源验。
2. 第一次判断（Jev）和第二次判断（一次生成）、提示词登记（走 `prompt-catalog`，对着 `prompt-prefix.md` 的规则只追加）、校验、写入提议箱。用本机回环的假模型服务做自动测试，**不用真模型**。
3. 接两个来源：邮件检查、“新存下的记忆”（要先读入库路径，避免一条对话产生很多行把每天次数用光）。
4. 删掉 v0.2 没接上线的“主动建议”代码和合约（第 1 步计划“先后顺序”第 2 条写了这件事，要动哪些文件还没逐个读）。
5. 评测（花钱，先问）和周报的三个数（提了几条、采纳几条、不用几条）。
6. （另一个，要 Andy 同意）第三节选项 A。

每个 PR 都带反向用例：不该提的输入期望没有提议；外来内容夹带指令期望一次都不漏出去、不执行；换一个来源、换一个动作不改判断代码也能进来（通用性用例）。

## 五、没核实的事

- Jev 的接口细节（是否支持三选一、请求格式）：只读了现有的三处调用代码和 ADR 0264 里引的文档摘录，没有打开 Jev 官方文档，写 PR 2 前要查。
- 价格用的是仓库文档里记的价（Jev 来自 ADR 0264，DeepSeek 来自 2026-09-07 的目录观察），不是实际账单；token 数量是估的，没有实测。
- 邮件检查入库路径和“新存下的记忆”的接入点没读代码。
- Pulse 下线的原因没有找到原话；Gemini 的两个页面只读了搜索摘要；苹果没有找到一手说明。
- 本方案没有让 DeepSeek 审，也还没有跑“核对代码说法”（`--mode plan-claims`）；因为要写 ADR，PR 里要带这一步，动工前我会跑。
