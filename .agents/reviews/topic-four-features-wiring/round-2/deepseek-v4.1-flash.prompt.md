你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 cd91001b934785b4f28fbd30c3b7da43e740b473。
待审核的方案：
# 整合方案：“Himawari 自己”页四块功能怎样接进线上（v1，待两个模型审）

代码事实核对于 main 的 cd91001b。三方（线程、DeepSeek、GLM）各自独立出的方案在 `.agents/reviews/topic-four-features-wiring/round-1/` 和 `thread-plan-v0.md`。

## 对标和根因

- 别家怎么做：Claude Code 的子 agent 是主 agent 通过一个工具真正启动的独立上下文，界面上的任务列表只列真实启动过的子 agent（来源 https://code.claude.com/docs/en/sub-agents 原话 “Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions.”“When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session and names the subagent that is asking.”）。也就是先有“真的派出去”这件事，才有可看的列表。ChatGPT 记忆与规则的界面做法未核实（官方帮助页拒绝访问），本方案不依赖它。
- 这是根因还是表面：原来的说法是“代码写好了、只差装进线上”。核对后发现四块里三块的根因是生产里没有人产生这些数据，只装读取那一半是表面修补，手机会拿到永远为空的列表。本方案按“真实数据从哪来”重新定每一块。

## 前提（每条都对着代码看过）

1. 生产手机网关已安装的操作没有 delegation、improvement、workspace.list/detail、capability 任何一项。来源 `apps/agent-service/src/production-approval-gateway.ts:54-60`，原话 `"approval.list", "approval.detail", "approval.respond", "search.authorization.read", "search.authorization.set"`。
2. 生产里没有人写“帮手”记录。`apps/` 下没有构造 `DelegationService` 或 `DurableDelegationStateAdapter`；生产里叫 delegation 的是 `apps/agent-service/src/production-runtime-tools.ts:379` 原话 `return new WorkerDelegationService({`，它只是把一次工具调用交给隔离进程执行。模型没有“派子任务”的工具。后台命令只存在内存里，来源 `apps/agent-service/src/production-background-commands.ts:99` 原话 `readonly #commands = new Map<string, BackgroundCommand>();`。
3. 现成的“改进候选”服务管的是代码补丁，而且没有“采纳”。来源 `packages/application/src/services/improvement-candidate-service.ts:218` 原话 `readonly decision: "reject" | "request_revision";`；字段见 `packages/application/src/ports/improvement.ts:21-75`（`baseRevision`、`patchRef`、`allowedPaths`）。`apps/` 下没有构造它。
4. 生产里已有一条真的“提议，主人点头才生效”的流程：规则提议。来源 `apps/agent-service/src/production-owner-rules.ts:639` 原话 `if (explicit) return this.#activate(proposal, replayed);`，不是明说的在 `:654` 原话 `await this.#writeText(proposalId, JSON.stringify(proposal));` 只存成提议。提议带 `summary`（一句话说明）和 `quote`（主人原话）。手机已装 `memory.rules.read`、`memory.rule.respond`（`apps/agent-service/src/production-memory-control.ts:64-65`）。
5. 但待确认的提议现在列不出来、也拒绝不了：提议只按编号存成一份载荷，没有列表；`undo` 只认规则编号，来源 `production-owner-rules.ts:760` 原话 `if (!ruleId.startsWith(OWNER_RULE_ID_PREFIX) || ruleId.length > 64)`。可执行的规则类型只有两种邮件规则，来源 `packages/application/src/rules/rule-types.ts:204、209` 原话 `"mail_must_notify",`、`"mail_read_whole_thread",`。
6. 生产里真实的文件改动记录是每条命令前后的目录对比（ADR 0097，`docs/adr/0097-bash-writes-workspace-with-change-ledger.md` 决定 3 原话 “记录写进这次运行的持久记录（`run_payload_artifacts`）”）。选了工作目录副本时不记，来源 `apps/agent-service/src/production-coding-workflow.ts:559` 原话 `tool === "bash" && grant !== null && !binding.workspaceCopy`。`WorkspaceService` 在 `apps/` 下没有构造，`workspace.list/detail` 依赖的投影没有写入方。
7. 授权目录只有主机编号和路径，没有主机显示名。来源 `packages/application/src/ports/host-files.ts:28、30` 原话 `readonly hostId: string;`、`readonly displayPath: string;`。
8. 能力停用后没有路回到在用；停用会在一个事务里撤销句柄、取消定时任务。来源 `packages/application/src/services/capability-lifecycle-service.ts:622` 原话 `return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);`、`:419` 只允许 `installation_approved` 激活；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2622-2648` 把 `scheduled_jobs` 改成 `revoked`。`apps/` 下没有构造 `CapabilityLifecycleService`，所以“它会的本事”这一行连停用都还没接。
9. 改工具集合会让请求开头变一次，要 Andy 同意。来源 `.claude/rules/prompt-prefix.md` 第 6 条原话 “只有下面这些情况才换新一次……工具集合变了”，第八节原话 “会，就停下来出方案，Andy 同意才动工”。

## 方案

三方在四块的方向上结论一致，下面是整合后的做法。裁决依据：边界与可逆性先于主动性（愿景第 2 章的优先级）。

### A. 待采纳的改进：接到规则提议上（第 1 个做）

- 数据来源：规则提议，不用“改进候选”服务。
- 新增：一张提议表（提议编号、类型、参数、一句话说明、主人原话、来源对话、产生时算出的试算例子和回放数字、状态、时间）；读操作“待采纳提议列表”；写操作沿用确认，另加“不要”（只把提议标成拒绝，不写规则、不写记忆）。
- “看依据”显示提议产生那一刻存下的原话和回放数字，读的时候不重算（重算会随邮件变化）。
- 采纳后可撤销：沿用已有的规则撤销。
- 第一版只会出现两种邮件规则的提议。原型里“雨天多留 10 分钟”这类要先有对应的规则类型（每种类型带执行和回归测试），是另一件事。
- 改表：1 张。模型调用：不动（`rule_set` 工具已在）。

### B. 它会的本事 + 重新启用（第 2 个做）

- 先把现成的能力列表、详情、停用、退回上一版装进生产（现在都没装）。
- 新增“重新启用”：只允许从“已停用”回到“待批准安装”，再走现成的激活，重新核对安装包摘要、重新做运行环境资格检查，任何一项不过就保持停用。要面容（最近认证）和回执。
- 停用时被撤销的句柄和被取消的定时任务一律不恢复。回执上写明“有 N 个定时任务仍是取消状态”，N 来自数据库实数；要恢复由主人重新建。
- 只有存在上一版时才显示“退回上一版”。
- 改表：不改（能力记录是 JSON，状态机加一条边）。模型调用：不动。属授权类大改动，写 ADR。

### C. 代码和文件夹：先只读（第 3 个做）

- 数据来源：ADR 0097 的每条命令改动记录加授权目录，不接 `WorkspaceService`。
- 新增读操作“这个文件夹的改动”：路径、新建/修改/删除、时间、来自哪次对话。
- “改了几个文件”的定义：这个授权目录下，从该对话第一条有记录的命令之前算起，内容和当时不同的文件去重后的个数；没改是 0；删掉后又恢复原样的不算。
- 主机显示名：授权目录上加一个由主人起的名字字段；没起名就显示路径，不写死机型。
- 第一版不显示“+42 −7”行数（没人记录），不显示“它想提交”（没有真实的提交预览）。
- 用工作目录副本时没有改动记录，第一版对副本显示“暂无记录”并在编码任务里先核实生产实际用哪种。
- 改表：是否另建按文件夹查询的投影表，由编码线程核实 `run_payload_artifacts` 的索引后定；主机显示名加 1 个字段。模型调用：不动。

### D. 提交代码（后置，单独同意）

- 装现成的提交闸门（提议时冻结提交说明和代码状态，提交时要面容，状态变了就作废）。“它想提交”的说明必须是模型提提交时的原话，所以需要给模型一个“提议提交”的工具，这会改工具集合。

### E. 派出去的帮手（最后，单独同意）

- 现在不显示这一行。把一次工具调用说成“帮手”是显示和实际不一致。
- 真做：给模型一个派子任务的工具，装现成的 `DelegationService`；标题是模型派出那一刻写的原话；手机能看、能取消（网关现在只有看，要补取消）；每个子任务有时间和费用上限。这会改工具集合，也增加模型费用。

## 没采纳的意见

- GLM：改进另做一套 `advice.*`，采纳后写成偏好记忆。不采纳：愿景规定规则不是记忆，采纳后只是记忆就不会必定执行；规则提议已是现成骨架。
- GLM：帮手第一期按能力调用回执聚合成“它今天在忙什么”。不采纳：一天几百条工具调用，不是主人关心的“事”；DeepSeek 和线程都认为宁可不显示。
- DeepSeek：帮手先显示后台命令。不采纳：后台命令在内存里，重启即失，“今天做完的”显示不出来。
- GLM：重新启用时把 reviewer 记成主人、状态回到 `installation_proposed`；DeepSeek：回到 `installation_approved`。采纳前者的严格度（回到待批准，再由主人带面容批准），因为批准这一步正好是面容和回执挂的地方。
- GLM：提交先走普通审批通道。不采纳为第一期：现在没有提交预览的写入方，按钮背后没有可冻结的内容。

## 要 Andy 定的

1. 帮手：同意现在不显示、以后作为单独的大改动（新模型工具）另议吗？
2. 改进：同意第一版只有邮件规则的提议，新规则类型另议吗？
3. 重新启用：同意“重新检查 + 面容，定时任务不自动恢复”吗？
4. 提交代码：同意后置吗？

## 自动检查（每块编码任务都带）

- 手机用到的每个操作名同时在契约、已安装清单、路由三处，缺一处测试失败。
- 提议“不要”不写规则不写记忆；确认两次只生效一次；列表顺序固定。
- 停用后直接激活被拒绝；重新启用后旧句柄仍撤销、定时任务仍取消；资格检查不过保持停用；没有面容被拒绝。
- “改了几个文件”有反向用例：没改为 0，改回原样为 0。
- 全部用真实 SQLite 和真实服务。
