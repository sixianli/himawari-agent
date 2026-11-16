<a id="document-governance-in-every-session"></a>
# 每个会话都做文档治理

每个云端线程（在 claude.ai 云端运行的工作线程）都要在本项目里真正使用 `document-governance` 技能（管理 `docs/` 下项目文档的技能）。仓库不保存这个技能的副本。云端线程从 Andy 的 claude.ai 账号获得它，Mac 上的会话从 `~/.claude/skills/` 获得它；无论哪种，都通过 Skill 工具（加载技能的工具）取得，下面的项目规则仍然适用。

<a id="where-the-skill-is"></a>
## 技能在哪里

- 做受治理的文档工作之前，先通过 Skill 工具加载 `document-governance`，然后按技能里 "Load Only What Is Needed"（只加载需要的部分）这份清单的说法，只读 `references/` 下与当前工作对应的那份参考文件。
- 在仓库根目录以 `python3 -B <skill directory>/scripts/<script>.py ...` 的形式运行它的脚本，目录用 Skill 工具报告的那个。不得加 `-I`：这些脚本要从自己所在的文件夹互相导入。
- 当 Skill 工具没有列出 `document-governance` 时，在计划里说明这一点，并照抄同类型中最新一份现有文档的 frontmatter（文件开头的元数据块）和结构，不得自己发明格式。

<a id="when-to-use-it"></a>
## 什么时候用它

以下触发条件在快速模式和完整模式下都适用：

- 只有同时满足两条的决定才写 ADR：改回去代价大，并且后来的人会问“当初为什么这样定”。调上限、换机器规格、改流水线设置这类改起来不费事的决定，写进提交说明，不写 ADR。ADR 正文一到两页，详细设计放进规格再链接过去。够得上的决定，要用技能包里的 `assets/templates/adr-template.md`（仓库不保存副本）在 `docs/adr/` 中新建一份 ADR（架构决策记录），编号接在现有最大编号之后。决定改变时，就地取代先前那份 ADR（见技能的 `references/workflows.md` 中 "ADR Supersession"（ADR 取代）一节）；绝不改写先前 ADR 的决定内容。
- 用户或某个线程决定保留的后续工作，通过 `idea_backlog.py backlog capture` 记成 Backlog 条目（待办工作条目）。绝不新建 `docs/TODO.md` 或手工维护的索引。
- 当用户要求保留一个想法（例如“记下这个想法”）时，用 `idea_backlog.py idea capture` 记录。
- 当一项改动让一份反映当前事实的文档明显出错（PRD（产品需求文档）、架构文档、仍在进行的规格、某份 Runbook（操作手册）的步骤）时，在同一个提交里改正它。
- 过期的文档直接删除，不归档（Andy 2026-11-16 定：“那些已经过期的文档直接删掉就行了”）：工作已做完或已放弃的规格（Spec）和旧计划（Plan）、已退役或被替换的 Runbook、已到终态的想法和 Backlog 条目，在结束它的那次改动里用 `git rm` 删掉；旧版本在 git 历史里。删之前找出所有指向它的文档、代码和测试并改掉：只是指向历史的引用直接去掉，读者仍需要旧文的改成指向 GitHub 上删除前那个提交的固定链接，仍然有效而别处没有的事实先搬到它该在的文档。不再新建归档目录。被取代的 ADR 不删，原地标记“已被取代”。
- 不再新建计划文件：执行顺序由代理自己的计划能力安排；必须跨会话保留的先后约束写进规格的 `Delivery Order` 小节。
- 事故及其门槛记入 `docs/incidents-and-gates.md`，编码代理反复犯的错误记入 `docs/lessons.md`，两者都遵循 [incident-gates.md](../../.claude/rules/incident-gates.md)；项目进度状态绝不记入这两处。

<a id="the-documentation-check"></a>
## 文档检查

- 仓库没有对 `docs/` 做全面校验的自动检查：`npm run check:docs` 及其脚本已删除，大多数文档的 frontmatter（文件开头的元数据块）问题不会让提交被拦下。`npm run check` 里有几步只检查 `docs/` 的特定部分，失败时同样会拦下提交，例如：`npm run check:glossary` 查词表里的旧叫法；`npm run check:incident-gates` 查事故清单的格式；`npm run check:instruction-links` 查指令文件指向的 `docs/` 文件和锚点是否存在；`npm run check:docs-links` 查 `docs/`（不含 `docs/archive`）里每个行内 Markdown 相对链接的文件和锚点是否存在（`DOCS_LINK_MISSING`、`DOCS_ANCHOR_MISSING`；用 `marked` 解析，行内链接、图片和参考式定义都查（脚注定义不算），链接落点可以在 `docs/` 之外，落在仓库外算断链；各种代码块和行内代码里的链接不查，符号链接的源文件不查，锚点只认标题和 `<a id>`）；指向 `.ci-output/` 等不入库的证据，写成行内代码路径，不写成链接；`npm run check:markdown-tables` 查 `docs/` 下的表格，有一行的列数和表头不一样就失败：表体某行列数不对时，GitHub 仍显示表格，但会丢掉多出的格子或补上空格子（例如三列表里混进了五列的行）；分隔行列数不对时，GitHub 整张表都不显示成表格。`npm run check:adr-numbers` 查 `docs/adr/` 下每个 `.md` 文件的名字都是“四位编号-小写短名.md”（其他扩展名的文件不检查），并且没有两份 ADR 共用一个编号；还查每份 ADR 标题里的“ADR 编号”等于文件名编号（`ADR_NUMBER_TITLE`），以及 `docs/`（不含 `docs/archive`）里落点在名为 `adr` 的目录、文件名符合 ADR 命名的行内 Markdown 链接，文件和锚点都存在（`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING`），和正文或文件开头字段里写出的、带 `docs/adr/` 前缀的 `docs/adr/四位编号-短名.md` 路径（网址里的不算），文件都存在（`ADR_PATH_MISSING`）；引用式链接和 HTML 链接不检查。新建 ADR 前，除了看 main，还要看还没合并的 PR 新加的 `docs/adr/` 文件，取所有这些编号里最大的加一（[那条教训](../../docs/lessons.md#adr-number-collision)）。
- 改动了 `docs/` 下任何文件的提交，提交前必须手动运行这个技能的严格校验（`python3 -B <skill directory>/scripts/validate_docs.py . --strict`，约一秒，只读），并且不得新增校验错误。技能没有加载时，在提交说明和交付报告里写明没能运行校验。
- Runbook 不再封存指纹（`contract_sha256`、`runbook-contract` 清单和 `runbook.py seal` 已从技能里删除，旧文件里留着的这些字段会被忽略，编辑时顺手删掉）。照一份 Runbook 操作之前，先运行 `runbook.py check` 查结构，再读它 `Authoritative Sources` 小节列出的文件，和 Runbook 的步骤对照；不一致就停下，先改 Runbook。

<a id="runbooks-that-guide-an-operation"></a>
## 用来指导操作的 Runbook

在按一份仍有效的 Runbook 做真实操作之前，先过技能 `references/runbook-workflow.md` 里的三道门槛。在快速模式下，生产上线和回滚按 [delivery-mode.md](delivery-mode.md)（`scripts/delivery-mode/deploy.sh` 和 `rollback.sh`）执行，不按 Runbook。

<a id="the-engineering-casebook"></a>
## 工程案例库

[docs/engineering-casebook.md](../../docs/engineering-casebook.md) 不属于这个技能管理的文档类型；它由 [AGENTS.md](../../AGENTS.md) 中的 `Engineering Casebook` 一节管理。ADR 记录决定及其理由；案例讲述用于面试的故事并链接到 ADR，ADR 的参考资料再链接回该案例。

<a id="delivery-reports"></a>
## 交付报告

每份交付报告写明：更新了哪些文档，哪些文档有意保持不变及原因，技能严格校验运行时的结果以及推迟处理的 Runbook 问题数量，以及新建的任何 Backlog 条目或 ADR。在技能里发现的缺陷，按 [Andy 的全局指令](../../.claude/rules/owner-global-instructions.md) 的要求，写在 "Skill feedback"（技能反馈）标题下。

<a id="code-and-documentation-consistency"></a>
## 代码与文档一致

在快速模式下，本节由本文件前面几节和[交付模式](delivery-mode.md#fast-mode)中较轻的规则替代：严格校验不再自动运行；改动了 `docs/` 的提交，提交前必须用 `document-governance` 技能手动运行它，且不得新增校验错误；Runbook（操作手册）的重新封存推迟进行。

代码和文档绝不能脱节。

- 每个改变行为、接口、配置、测试所需环境或操作步骤的提交，都要在同一个提交里更新受影响的文档：仍在进行的规格、架构文档、Runbook、Backlog 条目，以及 ADR（架构决策记录）的后续处理（用新 ADR 取代旧 ADR，而不是改写旧 ADR）。如果没有文档受影响，要在交付说明里写明并给出理由。
- 每次提交前，运行文档严格校验，例如 `python3 <document-governance skill>/scripts/validate_docs.py . --strict`。一个提交不得引入新的校验错误。当改动涉及某个 Runbook 的 `Authoritative Sources` 小节列出的文件时，要对照新代码审查这个 Runbook，并在同一个提交里改正它。
- 文档校验和 Runbook 检查是几秒内跑完的只读脚本；可以在 MacBook 上运行。这一点不适用于构建或测试。
- 修复缺陷时，同时更正描述旧行为的文档。当一份文档记录了某个决定时，要保持它的状态字段和链接是最新的。
- 提交说明和交付报告要列出更新了哪些文档，以及严格校验的结果。
