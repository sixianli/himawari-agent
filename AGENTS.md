<a id="himawari-agent-project-instructions"></a>
# Himawari Agent 项目指令

<a id="delivery-mode"></a>
## 交付模式

在决定一项改动需要哪些测试、文档步骤、合并检查或生产步骤之前，先读仓库根目录的 `DELIVERY_MODE`。只要它写的是 `fast`，[.agents/instructions/delivery-mode.md](.agents/instructions/delivery-mode.md) 就替代它在本文件和 `.agents/instructions/` 下各文件中点名的那些规则（用户决定，2026-10-25）。只有用户能切换模式。GitHub Actions（GitHub 自带的自动构建和测试服务）已关闭（[ADR 0092](docs/adr/0092-pause-github-actions.md)）：CI（持续集成，即每次推送后自动跑的检查）不会运行，所以本地的快速模式检查是唯一的质量门槛，PR 上没有 CI 结果是正常的。

<a id="product-vision"></a>
## 产品愿景

[docs/product-vision.md](docs/product-vision.md) 是贯穿整个开发周期的最高层产品文档（用户决定，2026-10-28，[ADR 0101](docs/adr/0101-adopt-product-vision-v2-1.md)）。每个会话，包括云端线程，在设计或修改面向用户的功能、记忆、主动行为、工具、权限或自我改进之前，都要先读它。

- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。当一个设计在两条原则之间取舍时，要写明它依据的是哪一条原则。
- “自有优先、数据自持”（"Owned first, data held by the owner"）取代了早先“本地优先”（"local-first"）的说法：Himawari 在哪里运行、数据存在哪里，由 Andy 控制，可以是 Andy 租用的服务器。不得把 Himawari 描述为本地优先。
- PRD（产品需求文档）规定一个版本的范围，可以推迟愿景中的部分内容，但不得与愿景矛盾。只有用户能修改愿景正文；新版本替换整份文档，并在附录中记录改动。

<a id="owners-global-instructions-and-skills"></a>
## Andy 的全局指令和技能

Andy 的全局指令已复制到 [.claude/rules/owner-global-instructions.md](.claude/rules/owner-global-instructions.md)。Claude Code 会自行加载这个文件；其他任何代理，只要它的会话没有从 Andy 的机器上加载 Andy 的全局指令（例如云端会话），就要在开始工作前读这个文件。仓库不保存 Andy 的技能的副本；[.claude/rules/owner-skills.md](.claude/rules/owner-skills.md) 列出这些技能，并说明每种会话从哪里获得它们（[ADR 0132](docs/adr/0132-owner-skills-from-the-claude-ai-account.md)）。

<a id="documentation-governance"></a>
## 文档治理

本仓库明确对 `docs/` 下所有受治理的项目文档采用 `document-governance` 技能。每个会话，包括云端线程，都遵守 [.claude/rules/document-governance.md](.claude/rules/document-governance.md)：技能在哪里、什么时候用，以及在仓库已没有自动文档检查的情况下如何运行它的严格校验（[ADR 0133](docs/adr/0133-docs-check-removed-from-npm-run-check.md)）。

<a id="code-and-documentation-consistency"></a>
## 代码与文档一致

在快速模式下，本节由 [.claude/rules/document-governance.md](.claude/rules/document-governance.md) 和[交付模式](#delivery-mode)中较轻的规则替代：自 2026-10-31 起，严格校验不再自动运行（[ADR 0133](docs/adr/0133-docs-check-removed-from-npm-run-check.md)）；改动了 `docs/` 的提交，提交前必须用 `document-governance` 技能手动运行它，且不得新增校验错误（用户决定，2026-10-31）；Runbook（操作手册）的重新封存推迟进行。

用户在 2026-09-29 要求代码和文档绝不脱节。文档脱节已经发生过一次：提交 `51fe7f6` 修改了 `apps/control-center/src`，却没有重新封存 `docs/runbooks/hermes-control-center-upgrade-runbook.md`，从那以后严格校验一直失败。

- 每个改变行为、接口、配置、测试所需环境或操作步骤的提交，都要在同一个提交里更新受影响的文档：规格、计划、架构文档、Runbook、Backlog 条目，以及 ADR（架构决策记录）的后续处理（用新 ADR 取代旧 ADR，而不是改写旧 ADR）。如果没有文档受影响，要在交付说明里写明并给出理由。
- 每次提交前，运行文档严格校验，例如 `python3 <document-governance skill>/scripts/validate_docs.py . --strict`。一个提交不得引入新的校验错误。当改动涉及某个 Runbook 的契约源文件（Runbook 里 `runbook-contract` 清单列出的仓库文件，封存时它们的内容会算进 `contract_sha256`）时，要对照新代码审查这个 Runbook，然后在同一个提交里用 `runbook.py seal ... --confirm-reconciled --apply` 重新封存它。
- 文档校验和 Runbook 检查是几秒内跑完的只读脚本；可以在 MacBook 上运行。这一点不适用于构建或测试。
- 修复缺陷时，同时更正描述旧行为的文档。当一份文档记录了某个决定时，要保持它的状态字段和链接是最新的。
- 提交说明和交付报告要列出更新了哪些文档，以及严格校验的结果。

<a id="incidents-and-repeated-mistakes"></a>
## 事故和反复犯的错误

规则见 [ADR 0107](docs/adr/0107-every-incident-gets-an-automatic-gate.md)，它取代 ADR 0060，并保留其全部规则（用户决定，2026-10-29）。每个会话，包括云端线程，都遵守 [.claude/rules/incident-gates.md](.claude/rules/incident-gates.md)。简要来说：

- 每个事故（生产故障、失败或已回滚的发布、直到生成上线包的后期才被拦下的问题，或者用户发现的、本可以被某项检查抓到的缺陷）只有在存在一项能在它身上失败的自动检查时才算关闭：上线前置检查、上线包检查、测试、`npm run check` 中的一步、钩子（hook，在提交或推送等时机自动运行的脚本），或每次使用时都自我检查的脚本。仅有文档、案例库条目和提醒，不能关闭事故。
- 当同一个错误第三次发生时，无论是 Claude 犯的、它指挥的任何代理犯的，还是作为重复事故出现，都必须有一道硬门槛（任何测试或可执行逻辑）挡住第四次。停下当前工作，查明之前的预防为什么失败，加上门槛，并证明它有效：在复现场景下它失败，去掉错误后它通过；如果需要只有用户才能做的改动，就准备好改动、提出请求，并让那部分工作保持暂停。
- [docs/incidents-and-gates.md](docs/incidents-and-gates.md) 列出每个事故的日期、症状、根本原因、发生次数、门槛和状态。线程开始时读它；在线程的交付报告之前更新它。`npm run check` 会对它运行 `scripts/check-incident-gates.mjs`。
- 统计发生次数时要跨会话、跨代理，以 `docs/incidents-and-gates.md`、`docs/lessons.md`、交接文件和提交说明作为历史记录。会话交接时要点名任何已经发生过两次的错误。
- 把结果记录在它该在的地方：事故及其门槛记在 `docs/incidents-and-gates.md`；编码代理反复犯的错误连同其约束记在 `docs/lessons.md`（已有条目涵盖时就扩展该条目；达到三次的条目要写明它的约束以及约束在哪里运行）；产品缺陷在任务中修复，或登记为 Backlog 条目；测试、上线或操作的运行方式的改变，记在对应的 Runbook、计划或规格里；用户对 Claude 工作方式的偏好记在 Claude 的记忆里。
- 交付报告要写明找到的根本原因、为每个事故添加的门槛（文件或命令）或不需要门槛的理由，以及记录在了哪里。

<a id="proposal-premises"></a>
## 方案的前提

每个方案开头都要列出它依赖的前提，每个前提附上来源（文件路径加行号，或 URL）和引用的原话；没有来源的前提不得使用，另一个 Claude 写的总结不算来源（用户决定，2026-10-31）。每个会话，包括协调者和云端线程，都遵守 [.claude/rules/proposal-premises.md](.claude/rules/proposal-premises.md)。

<a id="engineering-casebook"></a>
## 工程案例库

用户在 2026-10-26 要求把本项目的每个难题和重要决定都保存为案例，用于用户的 AI 应用工程师（AI Application Engineer）和 AI 代理工程师（AI Agent Engineer）面试。[docs/engineering-casebook.md](docs/engineering-casebook.md) 就是这份记录。这条规则在快速模式和完整模式下都适用。

- 只收录对面试或求职有帮助的案例：能在面试里讲约 2 分钟的大问题或重要决定（例如产生了 ADR 的架构决定、改变了某个实测延迟或可靠性数字的改动、修复了生产事故的工作）。修一个普通 bug 这类琐碎的事不收录（用户决定，2026-10-31）。线程做出了够格的工作，要在同一次交付中向案例库添加一个案例，或扩展已有的案例。
- 使用案例库的案例模板，并保留每一节：背景与症状、根本原因、我们的解决方案、讨论过的备选方案及放弃了什么、业界做法、对比与取舍、实测结果、相关 ADR 和 PR，以及 30 秒面试版本。用简体中文写；可以使用英文术语，第一次出现时要解释。
- 只引用实际打开过的第一方来源，附一段简短引文，并用案例库的来源图例标注每一个来源。每个数字都要取自提交说明、ADR、测试记录或日志，写明出处；没有测量时写“未测量”。
- 把案例加入案例库的目录和能力地图。当后来的改动改变了某个案例的结果时，在该案例后追加一条注明日期的后续记录，而不是改写它的结论。
- 交付报告要写明添加或更新了哪个案例，或者说明这项工作为什么不需要案例。

<a id="project-instruction-commits"></a>
## 项目指令的提交

- 对本项目级 `AGENTS.md` 的修改，经过审查和适用的检查后，可以单独提交，无需征求用户确认。本文件指向的 `.agents/instructions/` 下的指令文件同样如此。这样的提交只暂存这些文件，并保留无关的工作。像其他提交一样推送它（见下文“推送提交”）。

<a id="documentation-language-and-clarity"></a>
## 文档语言与清晰

- 本文件、`.claude/rules/` 和 `.agents/instructions/` 下的指令文件，以及其他所有项目文档，一律用简体中文（用户决定，2026-10-31）。

<a id="document-readability-and-navigation"></a>
## 文档可读性与导航

- 创建或修订项目文档时，在可行之处提供方便的导航链接。在长文档开头放一个可点击的目录或审阅摘要；不要在短文档里只为了导航而增加不必要的结构。
- 在同一文档内引用其他章节时，使用带描述性章节标题的内部链接，而不是“第 2 节和第 9 节”或“5.1 和 5.4”这类光秃秃的引用。摘要表格中对详细规则的引用也应直接链接到相关章节。
- 在有用的地方，在从目录或审阅摘要跳转过去的较长章节里提供“返回目录”或“返回审阅摘要”链接，让读者可以方便地来回跳转。
- 引用其他项目文档时，使用有意义的链接文字和相对于仓库的路径。如果要指向某一段具体内容，在可行时链接到相关章节。保留文档治理要求的 SOURCE 标记；导航链接不得替代来源声明。
- 使用目标 Markdown 阅读器支持的标题锚点或显式锚点。标题、章节或路径改变时，更新相关链接。交付前检查链接目标存在、锚点唯一；除非真的点击链接验证过，否则不得声称导航在阅读器里可用。
- 在当前文档任务的范围内逐步改进导航。不得只为了加链接而改写无关文档或成批重组历史内容。

<a id="approved-web-design-baselines"></a>
## 已批准的网页设计基线

- 每个设计或修改网页的会话，包括协调者和云端线程，都要先读 [docs/ui-ux-design-guide.md](docs/ui-ux-design-guide.md)：它的规则、用户批准并喜欢的设计，以及已经遇到过的不良设计（用户决定，2026-10-29）。交付时，把每个新的 UI 或 UX 问题加入其中的不良设计，把用户批准的每个设计加入其中的良好设计，把它们教会的任何规则加入其中的规则；能自动检查的规则还要配一项检查，例如在 `scripts/check-layout-audit.mjs`（`npm run check:layout`）中加一个场景或检测器。
- 修改 Himawari 网页的视觉设计、聊天交互或品牌素材之前，先读[当前 v4 交互与视觉基线](docs/execution/specs/2026-09-15-control-center-v4-design.md)和[原始 logo 基线](docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md)，并打开其中引用的可交互原型和视觉效果图。
- `assets/brand/himawari/v1/` 和 `docs/assets/control-center/2026-09-10-v1/` 保存着用户在 2026-09-10 批准的原始设计。后续实现的布局、主题、每轮执行过程和工具展示，都要对照这些参考检查；不得覆盖基线文件。用户批准某项设计改动后，把它另存为新版本，并更新文档中的引用。
- 当前聊天页必须遵循 `docs/assets/control-center/2026-09-15-v4/` 中冻结的原型，加上 2026-09-27 批准的、位于 `docs/assets/control-center/2026-09-27-v5/` 的执行环境状态行和侧边栏运行标记，加上 2026-10-26 批准的、位于 `docs/assets/control-center/2026-10-26-v6/` 的时间条过程区和向日葵花盘标志（[ADR 0087](docs/adr/0087-chat-ui-v6-process-timeline.md)；该原型的其余部分尚未批准，新标志的品牌素材在 `assets/brand/himawari/v2/`），加上 2026-10-27 批准的、位于 `docs/assets/control-center/2026-10-27-v7/` 的手机聊天页（[ADR 0096](docs/adr/0096-phone-chat-page-safe-area-and-quiet-answer-line.md)：回答下方不显示模型名，一行记忆提示，安全区内边距，圆形发送按钮），加上 2026-10-28 批准的、位于 `docs/assets/control-center/2026-10-28-v8/` 的对话“更多”面板（[ADR 0100](docs/adr/0100-conversation-more-panel-files-and-background-commands.md)：标题栏上一个按钮，只显示正在运行的后台命令数；“文件”标签页和“后台”标签页，按轮次分组；桌面上是右侧栏，手机上是底部弹出面板），加上 2026-10-28 批准的、位于 `docs/assets/control-center/2026-10-28-v9/` 的一批界面改动（[ADR 0105](docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md)：一句话的过程摘要并附总用时，步骤下方只显示 token 总数和 KV 缓存命中率，操作按钮只放在回答下方，记忆页和提醒页分开，设置对话框分四个标签页），加上 2026-10-29 批准的、位于 `docs/assets/control-center/2026-10-29-v10/` 的 Gmail 提醒、决策日志、Andy 每日审阅清单和已连接应用设置（[ADR 0106](docs/adr/0106-proactive-loop-v1-gmail-read-only.md)：颜色只用来表达含义，红色表示需要 Andy 处理的事，琥珀色表示值得看一眼或已自行恢复的情况，紫色只用于可以点击的东西），加上 2026-10-29 批准的、位于 `docs/assets/control-center/2026-10-29-v11/` 的一批界面改动（[ADR 0110](docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md)：顶栏由两组分开的悬浮圆形按钮组成，标题居中，设置放在侧边栏底部；分支出来的对话显示它的来源轮次和出处；命令步骤把命令本身收进“命令详情”；使用页面自己的下拉菜单；在文件页上传），加上 2026-10-29 批准的、位于 `docs/assets/control-center/2026-10-29-v12/` 的记忆页（[ADR 0112](docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md)：两个标签页，“记忆”和“变更”；顶部一张卡片，显示每次对话都会带上哪些记忆，每条记忆有一个由 Andy 控制的开关；按主题浏览，桌面上用侧边列表，手机上用下拉菜单；详情放在抽屉或底部弹出面板里；不加“新”标签），加上 2026-10-30 批准的、位于 `docs/assets/control-center/2026-10-30-v13/` 的向日葵标志（[ADR 0126](docs/adr/0126-sunflower-mark-grows-233-seeds.md)：大标志 233 颗种子，小标志 89 颗，按黄金角排布，只有圆点、没有花瓣；新种子从中心长出，把旧种子向外推，但只有首页标志和正在生成的回答的标志会动，其他一律静止，开启“减少动态效果”时什么都不动；`assets/brand/himawari/v2/` 中 96 颗种子的花盘现在是历史参考，新的在 `v3/`）；保留 v1 作为历史参考和品牌素材的来源。改动不得重新引入独立的审批入口或删除对话的操作，也不得新增堆积内部运行信息（模型、token、步骤、审批、内部记录）的通用面板或页面。有特定用途的面板或页面，在用户批准其原型并将其另存为新的基线版本后，可以添加（用户于 2026-10-28 收窄了这条规则，[ADR 0100](docs/adr/0100-conversation-more-panel-files-and-background-commands.md#baseline-rule)）。
- 原型中的消息、模型、思考摘要、工具输出、用时和审批都是演示数据。它们不能证明生产功能已经实现，也不能证明真实执行已经成功。

<a id="code-comments"></a>
## 代码注释

用户禁止代码注释的全局规则（用户决定 G149，2026-10-21）在这里适用：一条都不写，并删除你编辑的每个文件里已有的注释。项目补充：它约束所有代理；把理由和验证证据写进提交说明和交付说明；`biome-ignore` 算作要保留的工具指令；见[关于新增代码注释的教训](docs/lessons.md#new-code-comments)。

<a id="engineering-diagrams"></a>
## 工程图

- 除非用户明确要求使用 `archify` 技能，否则不得用它为本项目生成任何工程图，包括流程图、架构图、时序图、状态图和数据流图。笼统地要求画一张图，不等于授权使用 `archify`。

<a id="repository-boundary"></a>
## 仓库边界

- 产品代码和产品文档属于本仓库。
- 同级的 `pi-mono` 仓库是上游源码参考和调试用的检出副本。
- 使用 `/Users/triggerjames/DoNotDeleteThis/documents/sxl_code_work_space/pi-mono` 作为唯一认定的只读 Pi 源码检出副本；不要再去寻找其他检出副本，如果它不可用，要报告。这并不授权本地依赖链接，也不授权提交依赖改动。
- 不得把 Himawari 专属的产品逻辑放进 `pi-mono`。

<a id="pi-first-development-principle"></a>
## Pi 优先的开发原则

- Himawari 构建在 Pi Coding Agent 和 `pi-mono` 中其他可复用模块之上。在设计或实现任何与模型连接、提供方、路由、流式输出、模型运行时、Agent Loop（代理循环）、工具、会话或扩展相关的能力之前，先检查当前的 `pi-mono` 源码和锁定版本的 `@earendil-works/pi-*` API。
- 把对 Pi 的检查限定在与当前改动相关的模块、接口和调用方。依赖关系或尚未解决的证据需要时，再扩大检查范围。
- 只要现有的 Pi 能力已经满足需求，就复用、组合、配置它，或对它做最小的适配。不得仅仅为了做一个产品本地版本，就在 Himawari 里重新实现 Pi 的模块或协议。
- Himawari 自有的代码应当补上 Pi 不负责的产品专属事务，例如权限与审批、数据分级与披露、密钥句柄和主机密钥来源、受保护的 Payload（载荷）、持久状态与审计、产品层面的模型选择/备选策略、预算执行，以及 Gateway/Worker/Memory 的集成。
- 在保留一个重复实现之前，记录下具体缺少哪项 Pi 能力，验证薄适配层或与上游兼容的扩展无法满足需求，并解释为什么必须重复实现。优先选择 Pi 适配层或小型上游扩展，而不是第二套协议实现。
- 做与 Pi 相关的设计或代码审查时，说明复用了哪项 Pi 能力、哪项职责归 Himawari、以及为什么需要额外的实现。这份复用说明的篇幅要与改动大小相称；一个小的适配可能只需要一小段。

<a id="workspace-contract"></a>
## 工作区约定

- 所有直接外部依赖的版本都保持精确；不得为直接依赖引入版本范围。
- 只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包；产品领域、契约、应用代码和入口依赖产品自有的类型。
- 把已发布的 Pi 依赖保存在已提交的清单文件和锁文件中。本地 `../pi-mono` 源码链接必须是主动开启的、可撤销的，并且不得改变已提交的依赖声明。

<a id="pushing-commits"></a>
## 推送提交

用户的全局推送规则（每个提交立即推送到 `origin` 上同名的分支，用户决定 2026-09-30）由 [ADR 0057](docs/adr/0057-batch-layers-one-two-for-small-defects.md#unchanged) 保留。项目补充：

- 它适用于所有代理做的提交。
- 已推送的提交不等于已充分测试的提交。提交说明仍必须写明实际运行了哪些测试层；第 3 层在 PR 或合并之前运行，而不是在每次推送之前。

<a id="test-and-production-hosts"></a>
## 测试主机和生产主机

在运行、安排或委派任何构建、测试、资格验证或上线之前，或者在登录 Hermes 或云服务器 `84.247.157.41` 之前，先读 [.agents/instructions/test-and-production-hosts.md](.agents/instructions/test-and-production-hosts.md)。简要来说：绝不在 MacBook 上运行 Himawari 测试。

<a id="test-trigger-timing"></a>
## 测试触发时机

在决定运行哪些测试层、把测试层写进提交说明或添加测试之前，先读 [.agents/instructions/test-trigger-timing.md](.agents/instructions/test-trigger-timing.md)。它定义了第 0-5 层，以及共享钩子强制要求的 `Layer-0-tests:` 提交说明行。

<a id="hermes-test-server-connectivity"></a>
## 连接 Hermes 测试服务器

- 每条 Hermes 命令都通过 `.ci-output/handoff/scripts/hermes-ssh.sh '<command>'` 运行，每次上传都通过 `.ci-output/handoff/scripts/hermes-upload.sh <local file> <remote path>` 进行；绝不直接对 Hermes 调用 `ssh`、`scp`、`sftp` 或 `rsync`。这两个包装脚本经 Tailscale（一种组建私有网络的工具）连接（`ProxyCommand=none`，`HostName=100.64.53.104`），检查远端主机名是 `hermes-home`，把单次调用限制在 300 秒内，并且在受保护的第 3 层或第 4 层运行进行期间只允许只读命令，因为 Hermes 上的任何其他进程都会使那次运行作废。`hermes_direct_ssh_guard.py` 这个 PreToolUse 钩子（在工具调用前运行的检查）会拒绝直接调用（[教训](docs/lessons.md#measurement-not-isolated)）。Tailscale 不可用时，向用户报告，而不是手动改走 `hermes-ssh` 技能的 Cloudflare 线路。工具链的 `PATH`、环境变量、`umask 022` 以及用 `git bundle` 同步代码的方法，见[测试主机操作 Runbook](docs/runbooks/test-host-operations-runbook.md#live-state-preflight)。
- 新的下载，包括更新版本的工具链或 bubblewrap（一种沙箱工具），都需要先得到用户批准。不得在服务器上编辑代码。
- 不得为绕过故障而修改 SSH 配置、凭据、Cloudflare 设置、防火墙或主机密钥校验；要向用户报告。

<a id="disk-space-hygiene"></a>
## 磁盘空间清理

在完整构建、完整的 `npm test`、产品路径资格验证或上线之前，以及在删除 Mac 或测试主机上的构建产物、临时文件或证据之前，先读 [.agents/instructions/disk-space-hygiene.md](.agents/instructions/disk-space-hygiene.md)。
