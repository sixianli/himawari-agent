<a id="himawari-agent-project-instructions"></a>
# Himawari Agent 项目指令

<a id="delivery-mode"></a>
## 交付模式

在决定一项改动需要哪些测试、文档步骤、合并检查或生产步骤之前，先读仓库根目录的 `DELIVERY_MODE`。只要它写的是 `fast`，[.agents/instructions/delivery-mode.md](.agents/instructions/delivery-mode.md) 就替代它在本文件和 `.agents/instructions/` 下各文件中点名的那些规则。只有用户能切换模式。CI（持续集成，即每次推送后 GitHub Actions 自动跑的检查）按 [ADR 0176](docs/adr/0176-ci-on-ovh-vps.md) 在 CI VPS（Andy 在 OVH 租的一台只跑 CI 的云服务器）上的自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）里运行，macOS 检查暂停；合并前 PR 最新提交上的 `ci/required` 必须是成功，本地的快速模式检查也仍是必过的门槛；草稿 PR 不跑 CI，CI 本身坏了、失败已确认与本 PR 无关时，按 Andy 2026-11-12 的长期授权不等 CI 直接合并，PR 描述写明失败原因；CI 因本 PR 的改动变红时先查先修（[ADR 0241](docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md)）。

<a id="product-vision"></a>
## 产品愿景

[docs/product-vision.md](docs/product-vision.md) 是贯穿整个开发周期的最高层产品文档。每个会话，包括云端线程，在设计或修改面向用户的功能、记忆、主动行为、工具、权限或自我改进之前，都要先读它。

- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。当一个设计在两条原则之间取舍时，要写明它依据的是哪一条原则。
- “自有优先、数据自持”（"Owned first, data held by the owner"）取代了早先“本地优先”（"local-first"）的说法：Himawari 在哪里运行、数据存在哪里，由 Andy 控制，可以是 Andy 租用的服务器。不得把 Himawari 描述为本地优先。
- PRD（产品需求文档）规定一个版本的范围，可以推迟愿景中的部分内容，但不得与愿景矛盾。只有用户能修改愿景正文；新版本替换整份文档，并在附录中记录改动，并新开一份采纳 ADR 取代上一份。
- 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.3 的采纳记录是 [ADR 0153](docs/adr/0153-adopt-product-vision-v2-3.md)。

<a id="glossary"></a>
## 词表

同一个东西，整个系统只用一个名字。改界面文案或写文档、说明、提示文案之前，先读 [docs/glossary.md](docs/glossary.md)：新名在“新名”列，不再用的写法在“旧叫法”列。`npm run check:glossary`（`npm run check` 的一步）读那张表，在三种语言的界面文案、现行文档和指令文件里发现旧叫法就失败。要新增或改名，改词表那一行，不改脚本。

<a id="owners-global-instructions-and-skills"></a>
## Andy 的全局指令和技能

Andy 的全局指令已复制到 [.claude/rules/owner-global-instructions.md](.claude/rules/owner-global-instructions.md)。Claude Code 会自行加载这个文件；其他任何代理，只要它的会话没有从 Andy 的机器上加载 Andy 的全局指令（例如云端会话），就要在开始工作前读这个文件。仓库不保存 Andy 的技能的副本：云端线程用 Andy 上传到 claude.ai 账号的技能，Andy 的 Mac 上的会话用 `~/.claude/skills/`。

<a id="documentation-governance"></a>
## 文档治理

改动 `docs/` 下任何文件之前，先读[文档治理](.agents/instructions/document-governance.md)：什么时候用 `document-governance` 技能、代码和文档怎么保持一致。改了 `docs/` 的提交，提交前必须手动运行这个技能的严格校验，并且不得新增校验错误。

<a id="code-and-documentation-consistency"></a>
<a id="incidents-and-repeated-mistakes"></a>
## 事故和反复犯的错误

每个会话都遵守 [.claude/rules/incident-gates.md](.claude/rules/incident-gates.md)：每个事故都要有一道自动检查，同一个错误出现三次必须上硬门槛。

<a id="prompt-prefix-append-only"></a>
## 发给模型的内容只追加

设计或修改任何发给模型的上下文（系统提示、工具定义、历史、资料块、遮盖、压缩）之前，先读 [.claude/rules/prompt-prefix.md](.claude/rules/prompt-prefix.md)：已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。每条做法的理由、一手来源和本项目的现状见 [模型请求的 KV 缓存规范](docs/kv-cache-guide.md)。`npm run check:prompt-prefix` 是阻断检查。

<a id="model-review-before-merge"></a>
<a id="working-with-opencode"></a>
## 和 OpenCode 协作：方案讨论和代码复核

下面两个时机都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看：默认只用 `opencode-go/deepseek-v4.1-flash`，方案讨论和代码复核的每一轮都是这样（Andy 2026-11-12 定，[ADR 0259](docs/adr/0259-review-models-default-to-deepseek.md)）；只有 Andy 特别指明时才加上 `opencode-go/glm-5.3-flash`（`--models deepseek-v4.1-flash,glm-5.3-flash`）。默认跑哪些模型写在 `scripts/model-review/review-models.json`，不写死在脚本里。一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。

- 写代码之前要出方案时（大改动一定要）：先让模型在不看线程结论的情况下独立出方案（`--mode plan`），再请它审核线程自己的方案（`--mode plan-review`）。线程把各方逐条比较，先替 Andy 判断采纳什么、不采纳什么、为什么，只把整合后的方案和真正要他拍板的几项交给他。
- 合并 PR 之前：对最终提交做一次代码复核（`--mode code-review`），每一轮默认只用 DeepSeek。线程把成立的意见分成“会出错”和“可以更好”，“会出错”的再分中、高和低两档：中、高的要修改并对修改再复核，连续三轮没过就先停下报告 Andy，否则复核到没有中、高的“会出错”意见为止；低的在第 1、2 轮照样修改、补测试，改动够小时用 `--accept-low` 记进账本、不再复核，第 3 轮起只列不修，两种都在汇报里逐条列给 Andy 抽查；可以更好的不修改，列给 Andy，他说采纳才改，改完同样再复核。Andy 明确说跳过复核时，不论复核了几轮，都按那份文件用 `--accept-unreviewed` 记下他的原话后合并；他也可以随时叫停正在跑的复核或指定这一次用哪家服务方。Mac 本地线程不在本机跑复核，按那份文件把复核交给 himawari-cloud 里的云端线程，结果先经 `delegate.mjs check` 核对再采用。每一轮由主线程在后台跑 DeepSeek 复核，答案出来后交给子代理 `code-review-round` 在新的小上下文里判断和修改，主线程只拿结论并自己再跑一次 `--assert-reviewed`；跑复核时先读一页的[代码复核流程卡](.agents/instructions/model-review-card.md)，完整说明只按卡上的链接读对应一节（[ADR 0263](docs/adr/0263-cheaper-claude-side-of-code-review.md)）。
- 方案交给 Andy 之前（凡是会写进新 ADR 的整合方案）：用 `--mode plan-claims` 让低价模型把方案里每一句关于代码和仓库文档现状的话对着代码核一遍，线程逐条处理“不一致”和“找不到”；PR 新增了 ADR 而没有这一步的记录，`--assert-reviewed` 不通过。它不保证方案一定对，只保证每句现状说法都被对着代码看过、每条对不上的都有人处理过。做法和判定见[核对代码说法](.agents/instructions/model-review.md#plan-claims)，起因见[审核时直接采信代理自报的检查结果](docs/lessons.md#trust-reported-checks)。

除 `plan-claims` 外，每次的提示里必须有那份文件列出的问题，包括「这个改动会不会改变模型已经见过的请求开头」（`plan-claims` 只核事实，提示里没有这些问题）。步骤、材料怎么写、费用先问门槛和只读限制，见 [.agents/instructions/model-review.md](.agents/instructions/model-review.md)。

<a id="proposal-premises"></a>
## 方案的前提

每个方案开头都要列出它依赖的前提，每个前提附上来源（文件路径加行号，或 URL）和引用的原话；没有来源的前提不得使用，另一个 Claude 写的总结不算来源。每个会话，包括协调者和云端线程，都遵守 [.claude/rules/proposal-premises.md](.claude/rules/proposal-premises.md)。

<a id="owners-standing-rules"></a>
## Andy 定的长期规则

花钱先问、禁用贵模型、修 bug 先查根因、大改动先出方案讨论再动工、界面数字要有定义并做反向验收、Andy 在项目聊天说的话转给线程即算授权（删 Mac 上的文件除外）、KV 缓存优先的上下文排列，这些规则写在 [.claude/rules/owner-standing-rules.md](.claude/rules/owner-standing-rules.md)。每个会话，包括在 Mac 终端直接开的会话，开工前都要读它。

<a id="engineering-casebook"></a>
## 工程案例库

用于 Andy 面试的工程案例库是 [docs/engineering-casebook.md](docs/engineering-casebook.md)，只收能在面试里讲约 2 分钟的大问题或重要决定。交付这类工作之前，先读[案例库规则](.agents/instructions/engineering-casebook.md)；交付报告写明写了哪个案例，或者为什么不需要。

<a id="project-instruction-commits"></a>
## 项目指令的提交

- 对本项目级 `AGENTS.md` 的修改，经过审查和适用的检查后，可以单独提交，无需征求用户确认。本文件指向的 `.agents/instructions/` 下的指令文件同样如此。这样的提交只暂存这些文件，并保留无关的工作。像其他提交一样推送它（见下文“推送提交”）。

<a id="documentation-language-and-clarity"></a>
## 文档语言与清晰

- 本文件、`.claude/rules/` 和 `.agents/instructions/` 下的指令文件，以及其他所有项目文档，一律用简体中文。

<a id="document-readability-and-navigation"></a>
## 文档可读性与导航

创建或修订项目文档之前，先读[文档写法](.agents/instructions/writing-docs.md)（目录、章节内链接、锚点）。

<a id="approved-web-design-baselines"></a>
## 已批准的网页设计基线

设计或修改 Himawari 网页（视觉设计、聊天交互、品牌素材）之前，先读[网页设计基线](.agents/instructions/web-design-baselines.md)。

<a id="engineering-diagrams"></a>
## 工程图

- 除非用户明确要求使用 `archify` 技能，否则不得用它为本项目生成任何工程图，包括流程图、架构图、时序图、状态图和数据流图。笼统地要求画一张图，不等于授权使用 `archify`。

<a id="workspace-contract"></a>
<a id="repository-boundary"></a>
<a id="pi-first-development-principle"></a>
## Pi 优先与工作区

涉及模型连接、提供方、路由、流式输出、模型运行时、Agent 循环（模型一步步调用工具的那套流程）、工具、会话或扩展，或者要改依赖、导入 `@earendil-works/pi-*` 包、查看 `pi-mono` 源码之前，先读 [Pi 优先与工作区约定](.agents/instructions/pi-and-workspace.md)。

在 Pi 上加功能或改接入点（会话、工具、工具调用前后的拦截、系统提示、发给模型的请求、模型服务方、压缩、往运行中插消息、中止）之前，必须先读 [Pi 二次开发规范](docs/pi-development-guide.md)：官方有写法就照官方写；只有官方没有好写法或官方写法有缺陷时才能自己设计，而且要先出方案给 Andy 看，他同意后才能写进代码。照官方写不免除“大改动先出方案”（见上文 [Andy 定的长期规则](#owners-standing-rules)）。规范里“现有的偏离”一节列出的写法不得照抄。决定见 [ADR 0203](docs/adr/0203-follow-pi-official-extension-patterns.md)。

<a id="pushing-commits"></a>
## 推送提交

每个提交立即推送到 `origin` 上同名的分支（见全局指令的“Git 与操作”一节）。项目补充：

- 它适用于所有代理做的提交。
- 已推送的提交不等于已充分测试的提交。提交说明仍必须写明实际运行了哪些测试层；第 3 层在 PR 或合并之前运行，而不是在每次推送之前。

<a id="hermes-test-server-connectivity"></a>
<a id="test-and-production-hosts"></a>
## 测试主机和生产主机

在运行、安排或委派任何构建、测试、资格验证或上线之前，或者在连接 Hermes 测试服务器、登录云服务器 `84.247.157.41` 之前，先读 [.agents/instructions/test-and-production-hosts.md](.agents/instructions/test-and-production-hosts.md)。简要来说：服务器端的构建、检查和测试绝不在 MacBook 上运行；iPhone、Apple Watch、Mac 客户端的构建、单元测试和安装在 Andy 的 Mac 上用 Xcode 做。

<a id="test-trigger-timing"></a>
## 测试触发时机

在决定运行哪些测试层、把测试层写进提交说明或添加测试之前，先读 [.agents/instructions/test-trigger-timing.md](.agents/instructions/test-trigger-timing.md)。它定义了第 0-5 层，以及共享钩子强制要求的 `Layer-0-tests:` 提交说明行。

<a id="database-migrations"></a>
## 数据库迁移

新增或修改产品库的迁移之前，先读 [.agents/instructions/migrations.md](.agents/instructions/migrations.md)：编号用 `npm run migration:new` 生成，不再向协调者要编号，也不改共用的清单。决定见 [ADR 0265](docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md)。

<a id="disk-space-hygiene"></a>
## 磁盘空间清理

在完整构建、完整的 `npm test`、产品路径资格验证或上线之前，以及在删除 Mac 或测试主机上的构建产物、临时文件或证据之前，先读 [.agents/instructions/disk-space-hygiene.md](.agents/instructions/disk-space-hygiene.md)。
