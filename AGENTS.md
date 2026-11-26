<a id="himawari-agent-project-instructions"></a>
# Himawari Agent 项目指令

<a id="delivery-mode"></a>
## 交付模式

在决定一项改动需要哪些测试、文档步骤、合并检查或生产步骤之前，先读仓库根目录的 `DELIVERY_MODE`。只要它写的是 `fast`，[.agents/instructions/delivery-mode.md](.agents/instructions/delivery-mode.md) 就替代它在本文件和 `.agents/instructions/` 下各文件中点名的那些规则。只有用户能切换模式。合并前 PR 最新提交上的 `ci/required` 必须是成功；草稿 PR 不跑 CI、CI 没变绿时怎么办、CI 在哪台机器上跑，见[快速模式](.agents/instructions/delivery-mode.md#fast-mode)。

<a id="product-vision"></a>
## 产品愿景

[docs/product-vision.md](docs/product-vision.md) 是贯穿整个开发周期的最高层产品文档。每个会话，包括云端线程，在设计或修改面向用户的功能、记忆、主动行为、工具、权限或自我改进之前，都要先读它。

- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。当一个设计在两条原则之间取舍时，要写明它依据的是哪一条原则。
- “自有优先、数据自持”（"Owned first, data held by the owner"）取代了早先“本地优先”（"local-first"）的说法：Himawari 在哪里运行、数据存在哪里，由 Andy 控制，可以是 Andy 租用的服务器。不得把 Himawari 描述为本地优先。
- PRD（产品需求文档）规定一个版本的范围，可以推迟愿景中的部分内容，但不得与愿景矛盾。只有用户能修改愿景正文；新版本替换整份文档，并在附录中记录改动，并新开一份采纳 ADR 取代上一份。
- 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.4 的采纳记录是 [ADR 0310](docs/adr/0310-adopt-product-vision-v2-4.md)。自 v2.4 起，Himawari 是每人一个、互相隔离的多用户产品，愿景里的“我”指每一份的主人。

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

设计或修改任何发给模型的上下文（系统提示、工具定义、历史、资料块、遮盖、压缩）之前，先读 [.agents/instructions/prompt-prefix.md](.agents/instructions/prompt-prefix.md)：已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。那份规则不在开局自动载入，只要动到上面这些内容就必须先读，不能靠自己判断“影响不大”而跳过。拿不准一个改动算不算动到这些内容时，问自己下面几个问题，只要有一个答“会”或“不确定”，就算动到了，先去读它：

- 这个改动会不会让模型已经见过的请求开头变化？
- 我加的值是不是每轮都一样？不一样的只能放在最后一条消息里。
- 我是不是在存历史之前处理了消息？
- 我加进去的列表或 JSON，顺序是不是固定的？
- 这个改动会不会让同一对话换模型、换服务方，或者增删工具？

每条做法的理由、一手来源和本项目的现状见 [模型请求的 KV 缓存规范](docs/kv-cache-guide.md)。`npm run check:prompt-prefix` 是阻断检查。

<a id="model-review-before-merge"></a>
<a id="working-with-opencode"></a>
## 和 OpenCode 协作：方案讨论和代码复核

**已暂停（Andy 2026-11-25 原话：“把 opencode 的审核给它暂停掉。无论是方案的审核还是 Code Review，都不需要 opencode 来审核了”“我觉得 opencode 的审核太浪费 token 和时间了”）。** 暂停期间方案讨论（`plan`、`plan-review`）、方案说法核对（`plan-claims`）和合并前代码复核（`code-review`）一律不跑，合并只看测试和 CI；合并队列也不再检查复核记录。下面的写法保留到 Andy 说恢复为止，恢复时删掉这一段、把合并队列的复核检查接回来。

方案讨论和合并前的代码复核，都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看：默认只用 `opencode-go/deepseek-v4.1-flash`，只有 Andy 特别指明时才加上 `opencode-go/glm-5.3-flash`。一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。

- 写代码之前要出方案时（大改动一定要）：先 `--mode plan` 让模型独立出方案，再 `--mode plan-review` 审核线程自己的方案；线程逐条比较后，只把整合后的方案和真正要 Andy 拍板的几项交给他（[方案讨论](.agents/instructions/model-review.md#plan-discussion)）。
- 方案交给 Andy 之前（凡是会写进新 ADR 的整合方案）：`--mode plan-claims` 把方案里关于代码和文档现状的每句话对着代码核一遍；PR 新增了 ADR 而没有这一步的记录，`--assert-reviewed` 不通过（[核对代码说法](.agents/instructions/model-review.md#plan-claims)）。
- 合并 PR 之前：`--mode code-review`，每一轮由主线程在后台跑 DeepSeek 复核，答案出来后交给子代理 `code-review-round` 在新的小上下文里判断和修改，复核到没有中、高的“会出错”意见为止。开始前先读一页的[代码复核流程卡](.agents/instructions/model-review-card.md)；意见怎么分级、几轮停下、低严重度怎么处理，见[代码复核](.agents/instructions/model-review.md#code-review)；Andy 说跳过、叫停或指定服务方时怎么做，见[Andy 怎样控制复核](.agents/instructions/model-review.md#owner-control)；Mac 本地线程不在本机跑复核，见[Mac 线程把复核交给云端线程](.agents/instructions/model-review.md#delegate)。

除 `plan-claims` 外，每次的提示里必须有[每次都要问的问题](.agents/instructions/model-review.md#checklist)，包括「这个改动会不会改变模型已经见过的请求开头」。

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

设计或修改 Himawari 网页（视觉设计、聊天交互、品牌素材）之前，先读[网页设计基线](.agents/instructions/web-design-baselines.md)。iPhone、Apple Watch、Mac 三个 App 的界面和交互一律照苹果最新的《Human Interface Guidelines》（苹果官方界面设计规范）做，能用系统组件就用系统组件，见 [Andy 定的长期规则](.claude/rules/owner-standing-rules.md#apple-clients-follow-the-hig)。

<a id="engineering-diagrams"></a>
## 工程图

- 除非用户明确要求使用 `archify` 技能，否则不得用它为本项目生成任何工程图，包括流程图、架构图、时序图、状态图和数据流图。笼统地要求画一张图，不等于授权使用 `archify`。

<a id="workspace-contract"></a>
<a id="repository-boundary"></a>
<a id="pi-first-development-principle"></a>
## Pi 优先与工作区

涉及模型连接、提供方、路由、流式输出、模型运行时、Agent 循环（模型一步步调用工具的那套流程）、工具、会话或扩展，或者要改依赖、导入 `@earendil-works/pi-*` 包、查看 `pi-mono` 源码之前，先读 [Pi 优先与工作区约定](.agents/instructions/pi-and-workspace.md)。在 Pi 上加功能或改接入点之前，必须先读 [Pi 二次开发规范](docs/pi-development-guide.md)：官方有写法就照官方写，偏离官方要先出方案经 Andy 同意（[ADR 0294](docs/adr/0294-building-on-pi.md)）；照官方写也不免除“大改动先出方案”。

<a id="pushing-commits"></a>
## 推送提交

每个提交立即推送到 `origin` 上同名的分支（见全局指令的“Git 与操作”一节）。项目补充：

- 它适用于所有代理做的提交。
- 已推送的提交不等于已充分测试的提交。提交说明仍必须写明实际运行了哪些测试层；第 3 层在 PR 或合并之前运行，而不是在每次推送之前。

<a id="test-and-production-hosts"></a>
## 测试主机和生产主机

在运行、安排或委派任何构建、测试、资格验证或上线之前，或者在登录生产机之前，先读 [.agents/instructions/test-and-production-hosts.md](.agents/instructions/test-and-production-hosts.md)。简要来说：定向测试和提交前检查在云端线程的容器里跑，完整测试由 GitHub CI 跑，没有单独的测试服务器；服务器端的构建、检查和测试绝不在 MacBook 上运行；iPhone、Apple Watch、Mac 客户端的构建和单元测试在 GitHub 的 macOS 机器上做，经 TestFlight 安装，不依赖 Andy 的 Mac（ADR 0309 第 14 条）。

<a id="test-trigger-timing"></a>
## 测试触发时机

在决定运行哪些测试层、把测试层写进提交说明或添加测试之前，先读 [.agents/instructions/test-trigger-timing.md](.agents/instructions/test-trigger-timing.md)。它定义了第 0-5 层，以及共享钩子强制要求的 `Layer-0-tests:` 提交说明行。

<a id="database-migrations"></a>
## 数据库迁移

新增或修改产品库的迁移之前，先读 [.agents/instructions/migrations.md](.agents/instructions/migrations.md)：编号用 `npm run migration:new` 生成，不再向协调者要编号，也不改共用的清单。决定见 [ADR 0265](docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md)。

<a id="disk-space-hygiene"></a>
## 磁盘空间清理

在完整构建、完整的 `npm test`、产品路径资格验证或上线之前，以及在删除 Mac 或测试主机上的构建产物、临时文件或证据之前，先读 [.agents/instructions/disk-space-hygiene.md](.agents/instructions/disk-space-hygiene.md)。
