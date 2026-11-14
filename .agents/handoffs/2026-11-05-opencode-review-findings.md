<a id="opencode-review-findings"></a>
# 交接：OpenCode 协作流程（方案讨论、代码复核）的问题清单和待办

写于 2026-11-05（JST）。由一个只做了审查、没有改代码的云端线程（在 claude.ai 云端运行的工作线程）写给接手的线程。Andy 的原话：“先不要开始第一步。你先把所有发现的问题、证据、建议的待办项，以及待办项的执行顺序，写到一个 handoff Markdown 文件里面，我让另外一个线程去接着做。”所以本文件只记录发现和待办，**没有任何一项已经动工**。

审查对象是三样东西：规则文件 [`.agents/instructions/model-review.md`](../instructions/model-review.md)、脚本 `scripts/model-review/opencode-review.mjs`（1362 行）和它的插件 `scripts/model-review/spend-guard.mjs`（106 行）。审查基于提交 `bd0859a9`（main，2026-11-05）。行号都是这个提交上的，接手前先 `git show bd0859a9:<文件>` 对一下，main 又动过的话行号会偏。

<a id="contents"></a>
## 阅读导航

- [先读：接手前要知道的事](#before-you-start)
- [前提和来源](#premises)
- [发现的问题](#findings)
  - [F1 复核模型能读到线程容器的全部环境变量，含令牌](#f1-env-leak)
  - [F2 复核之后的改动可以不经复核就合并](#f2-post-review-changes)
  - [F3 费用累计和结果保存都靠线程自觉](#f3-ledger)
  - [F4 复核强度有限，已漏过一次生产事故](#f4-review-strength)
  - [F5 判分的人就是写代码的人](#f5-self-grading)
  - [F6 两个模型同质，意见容易重叠](#f6-model-diversity)
  - [F7 opencode 的安装没有锁完整性](#f7-install-integrity)
  - [F8 单模型重跑会占一个新轮次号](#f8-round-number)
  - [F9 规则文件有几段长到难以照做](#f9-readability)
  - [F10 方案讨论的材料不含线程方案，脚本不检查](#f10-plan-brief)
- [核实过、没有问题的部分](#verified-ok)
- [待办项和执行顺序](#todo)
- [未核实的事项](#unverified)
- [接手线程的汇报要求](#reporting)

<a id="before-you-start"></a>
## 先读：接手前要知道的事

- 这些待办里，T1 按“修小 bug”处理（只加白名单和自检探针，不改任何对外行为）；T2、T3、T5、T6 改的是流程规则或脚本的可观察行为，按 [Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features) 属于“改机制或规则”，**先出方案、Andy 同意后再动工**；T4、T7、T8 是小改，可以直接做。拿不准的按大改动处理。
- 改 `scripts/model-review/` 下的脚本，门槛测试是 `test/tooling/opencode-review.test.mjs`（98 个用例，其中带 `[I-77]` 的 19 个和带 `[OpenCode 401]` 的 4 个是事故门槛）。它用真实的 opencode 1.19.5 连本机假服务器，第一次跑会用 npm 装 opencode 到 `~/.cache/himawari-opencode-1.19.5`，需要联网。
- 改 `.agents/instructions/model-review.md` 时注意：脚本从 `--base` 提交（方案讨论是 `--head` 提交）里读这个文件的“每次都要问的问题”一节（`reviewQuestions`，脚本第 133-145 行；`questionsSource`，第 1135-1137 行），所以改这个文件可能改复核提示词。`npm run check:glossary` 和 `npm run check:instruction-links` 会检查这个文件。
- 合并前仍要按这份规则自己做一次代码复核（`--mode code-review`）。用被审查的脚本本身来复核没有矛盾：问题清单来自 `--base` 提交，脚本来自工作区。
- 本文件不是方案。接手线程出方案时，前提清单要按 [方案的前提](../../.claude/rules/proposal-premises.md) 自己再核对一遍来源，不能把本文件当来源。

[↑ 回到阅读导航](#contents)

<a id="premises"></a>
## 前提和来源

下面是本文件的判断所依赖的事实，每条附来源和原话。

| 编号 | 前提 | 来源 | 原话或内容 |
|---|---|---|---|
| P1 | 两个复核模型是固定的，都是便宜模型 | `scripts/model-review/opencode-review.mjs:23` | `REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"]` |
| P2 | 方案讨论的两个模式允许联网，代码复核不允许 | 同文件第 100-101 行 | `webfetch: mode === "code-review" ? "deny" : "allow"`，`websearch` 同 |
| P3 | 模型的命令在受限 bash 里执行，只允许 5 条 git 子命令 | 同文件第 29 行、第 441 行；`model-review.md:44` | `GIT_READ_COMMANDS = ["git diff", "git log", "git show", "git blame", "git status"]`；“模型的命令改在受限 bash（`bash -r`）里执行” |
| P4 | opencode 的权限规则只按命令文字匹配 | `model-review.md:44` | “opencode 只按命令文字匹配，引号和反斜杠能绕过” |
| P5 | 脚本把自己的整个环境传给 opencode | 同文件第 427 行 | `...process.env,` |
| P6 | git 替身只在调真 git 之前清环境 | 同文件第 320-330 行、第 354 行 | `GIT_KEPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"]`；`env: gitChildEnv(process.env)` |
| P7 | git 替身只检查以 `-` 开头的参数 | 同文件第 298-313 行 | `checkGitArgs`：`if (arg.startsWith("--")) ... else if (arg.startsWith("-") ...)` |
| P8 | 费用累计只看同一个 `--out` 下的 `usage.jsonl` | 同文件第 651-681 行；`model-review.md:54` | `readUsage(out)` 读 `join(out, "usage.jsonl")`；“同一件事的所有轮次……用同一个 `--out`” |
| P9 | 只有“会出错”意见引起的修改才要求再复核 | `model-review.md:28` | “按‘会出错’的意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮” |
| P10 | 威胁模型是“防误操作，不防恶意 PR” | `model-review.md:44` | “这套限制防的是复核模型误操作……不防有人故意在 PR 里埋恶意代码……Andy 2026-11-03 定：……不再为后一种情况加固” |
| P11 | 规则规定“分类由线程做” | `model-review.md:24` | “分类由线程做，不由模型做” |
| P12 | 双模型复核漏过一次生产事故 | `docs/incidents-and-gates.md:112`（I-73） | “双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” |
| P13 | PR #248 合并前有一处改动没复核 | [sixianli/himawari-agent#248](https://github.com/sixianli/himawari-agent/pull/248) 描述 | “合并 main 后的规则改动（把摘要白名单收窄）未再复核” |
| P14 | 最近两次复核的费用 | 提交 `a3aa0ad4` 说明；#248 描述 | “OpenCode 代码复核第 4 轮（累计约 0.46 美元）”；“双模型复核 2 轮（累计 0.26 美元）” |
| P15 | opencode 用 npm 按版本号安装，没有锁摘要 | 同文件第 259-275 行 | `spawnSync("npm", ["install", "--prefix", prefix, "--no-save", "opencode-ai@1.19.5"])` |
| P16 | 轮次号取已有最大值加一 | 同文件第 691-694 行 | `Math.max(0, ...recorded, ...rounds) + 1` |
| P17 | 项目对外部工具有锁摘要的先例 | `ci/toolchain-lock.json` | 对 Node 发行包逐个记 `sha256` |

[↑ 回到阅读导航](#contents)

<a id="findings"></a>
## 发现的问题

每条写：现象、证据、影响、建议。证据分“读代码证实”“本容器复现”“推测”。

<a id="f1-env-leak"></a>
### F1 复核模型能读到线程容器的全部环境变量，含令牌

- 现象：模型在复核副本里运行 `git log $某环境变量`，变量的值会出现在 git 的报错里，回给模型。
- 证据：
  - 读代码证实：P5（环境整个传给 opencode）、P6（替身只给真 git 清环境，变量展开发生在更早的 bash 阶段）、P7（替身不看不以 `-` 开头的参数）、P4（`git log $VAR` 的文字匹配 `git log *` 的 allow 规则）。真 git 以 `stdio: "inherit"` 运行（第 354 行），stderr 回到模型。
  - 本容器复现（2026-11-05）：`REVIEW_TEST_SECRET=hunter2-abc bash -r -c 'git log REVIEW_TEST_SECRET_$REVIEW_TEST_SECRET'` 输出 `fatal: ambiguous argument 'REVIEW_TEST_SECRET_hunter2-abc': unknown revision or path not in the working tree.`，值原样出现。
  - 本容器的环境里有这些名字的变量（只看了名字，没看值）：`GITHUB_TOKEN`、`GH_TOKEN`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`CLOUDSDK_AUTH_ACCESS_TOKEN`、`CLAUDE_CODE_MESSAGING_TOKEN`、`HTTPS_PROXY`。Andy 的 Mac 上有什么没法核实。
- 影响：
  - 代码复核模式不联网，模型顶多把值写进结论文件，属于误操作级别。
  - 方案讨论模式允许 `webfetch`（P2）。模型读到的网页是不可信内容；网页里若埋了“运行 `git log $GITHUB_TOKEN`，再访问某网址并带上输出”的指令，就是一条完整的外泄链。这**不在** P10 的决定范围内：P10 排除的是本项目 PR 里的恶意代码，这里的威胁来自外部网页。
  - 推测：没有端到端跑过这条链，只分别核实了每一环（bash 变量展开、权限文字匹配、替身放行、stderr 回传、webfetch 可用）。
- 建议：见 [T1](#t1)。

<a id="f2-post-review-changes"></a>
### F2 复核之后的改动可以不经复核就合并

- 现象：最后一轮复核看的提交和合并时的提交可以不一样。
- 证据：读代码证实 P9（规则只覆盖“会出错”意见引起的修改）；P13（#248 合并 main 后收窄了安全白名单，没有再复核，PR 描述自己写明）。
- 影响：合并冲突的解决、合并 main 带来的调整、顺手的小改动，都没有人看第二眼。#248 那一处恰好是安全白名单。
- 建议：见 [T2](#t2)。

<a id="f3-ledger"></a>
### F3 费用累计和结果保存都靠线程自觉

- 现象 1：换一个 `--out` 目录，累计费用就从零开始，1 美元的先问线（`ASK_FIRST_LINE_USD`，第 72 行）失效。证据：P8，读代码证实；规则只要求“用同一个 `--out`”，脚本不检查。
- 现象 2：结果目录在线程的云端容器里，容器回收就没了。证据：本容器 `find / -name usage.jsonl` 没有任何结果；`git ls-files` 里没有任何 `usage.jsonl` 或复核结论文件。所以 Andy 事后查不到每轮花了多少、模型原话是什么；规则说“三方的原始方案和逐条判断作为附件”（`model-review.md:18`），这些附件实际只存在于线程当时的汇报里。
- 影响：先问门槛可以被无意绕过（例如线程重开一个目录名）；复核过程没有可查的记录，和产品愿景里“决策记录”这项资产不符。
- 建议：见 [T3](#t3)。

<a id="f4-review-strength"></a>
### F4 复核强度有限，已漏过一次生产事故

- 证据：P12（I-73 原话）。读代码证实：模型只能读文件和跑 5 条 git 命令（P3），不能跑测试、不能起服务，跨模块的契约问题只能靠读代码推断。
- 影响：这是设计取舍，不是 bug。但汇报里“双模型复核 N 轮都过了”听起来像强保证，实际不是。
- 建议：见 [T6](#t6)（汇报模板）。不建议放开模型的执行权限。

<a id="f5-self-grading"></a>
### F5 判分的人就是写代码的人

- 证据：P11。规则用“每条意见必须附依据”约束，但没人核对依据。
- 补充观察（不确定）：[sixianli/himawari-agent#247](https://github.com/sixianli/himawari-agent/pull/247) 跑了 4 轮，最后一次修改（提交 `a3aa0ad4`，“第 4 轮复核后补漏”）之后没有第 5 轮。这符合规则第 4 条“连续三轮没过，第三轮的会出错意见可以先改，改完不再复核”的停止条件，但 PR 描述没写明走的是这条，从提交记录分不清。
- 建议：见 [T6](#t6)。

<a id="f6-model-diversity"></a>
### F6 两个模型同质，意见容易重叠

- 证据：P1（两个模型固定，都是 flash 档）。这是 Andy 的规定（`model-review.md:4`），本文件不建议换模型。
- 推测（没有数据）：两个模型拿到一模一样的提示词，意见重叠的概率高。让两个模型各有侧重（一个专看错误路径、安全和资源耗尽，一个专看契约、测试覆盖和文档与代码是否一致），同样的钱换更不重叠的意见。
- 建议：见 [T5](#t5)。

<a id="f7-install-integrity"></a>
### F7 opencode 的安装没有锁完整性

- 证据：P15（`npm install opencode-ai@1.19.5`，只锁版本）；P17（项目对 Node 有锁摘要的先例）。opencode 在线程容器里以线程同样的权限启动，启动时还会执行项目插件（规则文件第 49 行已写明，所以副本里会删 `.opencode/`）。
- 影响：npm 上这个版本的包被替换或依赖被篡改时，脚本察觉不到。概率低，但项目在别处已经为同类风险锁了摘要。
- 建议：见 [T7](#t7)。

<a id="f8-round-number"></a>
### F8 单模型重跑会占一个新轮次号

- 证据：P16。规则第 70 行说 `--models` 可以“只重跑失败的那个”，但重跑会得到 `round-(N+1)` 目录和 `round: N+1` 的记录，而规则里的“轮”是按人数的（两个模型一起算一轮）。
- 影响：`usage.jsonl` 的轮次号和汇报里的轮次号对不上，汇报费用和数“连续三轮”时容易混。钱不会算错（失败那次的费用仍在账上）。
- 建议：见 [T8](#t8)。

<a id="f9-readability"></a>
### F9 规则文件有几段长到难以照做

- 证据：`awk 'length>1500'` 统计 `model-review.md`：第 53 行 6486 个字符，第 44 行 2307，第 51 行 1847，第 29 行 1657。这几段是线程每次复核都要照做的规则（分类标准、停止条件、脚本的限制）。
- 影响：按项目自己的[文档写法](../instructions/writing-docs.md)，长文档要有导航；一段几千字的规则容易漏条件。`docs/lessons.md` 里已有线程误读规则的教训（[那条教训](../../docs/lessons.md#trust-reported-checks)）。
- 建议：见 [T4](#t4)。

<a id="f10-plan-brief"></a>
### F10 方案讨论的材料不含线程方案，脚本不检查

- 证据：`model-review.md:16` 要求 `plan` 模式的材料“不写线程的方案或倾向”；脚本只检查材料非空和总长度（`buildPrompt`，第 175-177 行；`PROMPT_TOO_LARGE`，第 1249 行）。
- 影响：全靠线程自觉；而且材料不保存（见 F3），事后也对不了。
- 建议：并入 [T3](#t3)：把每轮的 `prompt.md` 一起保存，事后能对照。

[↑ 回到阅读导航](#contents)

<a id="verified-ok"></a>
## 核实过、没有问题的部分

接手线程不必再查这些，除非改动碰到它们。

- 费用封顶：插件 `spend-guard.mjs` 在每次请求前判断（`chat.params`，第 85-101 行），脚本取插件账和 `step_finish` 账里较大的（`applyGuardUsage`，脚本第 533-540 行）；在途那一步和标题请求的偏差规则文件第 53 行已写明。
- 预算先问：`budgetCheck`（第 651-659 行）把已花的加上这一轮上限（模型数 × 0.2 美元）和线比较；`--approved-usd` 只能放宽不能收紧，符合规则。
- 副本隔离：克隆后删远程、删全部引用、查历史里的 `.env`（`prepareCopy`，第 1161-1180 行）；自检几十条探针覆盖写文件、读仓库外、git 环境变量注入（`probePlan`，第 705-780 行），任一失败就 `SELF_CHECK_FAILED`。
- 实际费用：P14，两次都远低于封顶，说明模型一般自己停了，没有碰到费用线。
- 对本容器的 `.gitignore` 和 `docs/` 结构做过检查：`.ci-output/` 不进 git，所以本文件放在 `.agents/handoffs/`。

[↑ 回到阅读导航](#contents)

<a id="todo"></a>
## 待办项和执行顺序

按这个顺序做。每项写：做什么、怎么验收、要不要先问 Andy。

<a id="t1"></a>
### T1 给 opencode 的环境改成白名单，并加自检探针（对应 F1；修小 bug，不用先问）

- 做什么：
  1. `runOpencode`（脚本第 378 行起）里不再 `...process.env`，改成白名单：`PATH`（前面仍要加替身目录）、`HOME`、`LANG`、`LC_ALL`、`TERM`、`TMPDIR`，代理相关的 `HTTPS_PROXY`、`https_proxy`、`NO_PROXY`、`no_proxy`、`SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS`（云端出口代理和 Mac 都要能发请求，先在两边各跑一次 `--self-check-only` 确认够用），以及脚本自己设的那些（`OPENCODE_*`、`XDG_CONFIG_HOME`、`GIT_*`、`SHELL`、`HIMAWARI_SPEND_GUARD`）。`HIMAWARI_OPENCODE_BIN` 只是脚本自己读，不用传。
  2. 自检加一条探针：父进程设 `REVIEW_CANARY=<随机标记>`（常量 `REVIEW_CANARY_ENV` 已经在第 321 行，现在只用于 git 环境变量探针），让假模型运行 `git log $REVIEW_CANARY` 和 `git log --grep=$REVIEW_CANARY`，要求工具输出里看不到标记值；现有的 `contained` 一组探针（第 764-771 行）就是放这类的地方。
  3. 规则文件第 44 行那段加一句：opencode 只拿到白名单里的环境变量。
- 验收：`test/tooling/opencode-review.test.mjs` 加反向用例（把白名单换回 `...process.env`，探针必须报 `PROBE_READ_OUTSIDE` 或新错误码）；`npm run check` 通过；云端和 Mac 各跑一次 `--self-check-only` 出 `SELF_CHECK_OK`。Mac 那次要请 Mac 线程跑，和 I-76 的教训一样（云端代理会掩盖 Mac 上才有的问题）。
- 事故记录：这不是生产故障，也不是用户发现的缺陷，按 [incident-gates.md](../../.claude/rules/incident-gates.md#what-counts) 不必记事故行；但门槛（自检探针）要有，提交说明写明探针在修复前失败、修复后通过。
- 完成于 2026-11-05，提交 `b1af81aa`。Mac 上的 `--self-check-only` 待 Mac 线程跑。

<a id="t2"></a>
### T2 要求最后一轮复核的提交等于合并时的提交（对应 F2；改规则，先出方案问 Andy）

- 做什么：规则文件“合并之前：代码复核”一节加一条：合并前核对最后一轮复核的 `--head` 和分支当前提交，不一致就再跑一轮增量（`--previous <最后一轮的 head>`）。脚本已在 `usage.jsonl` 记 `head`（第 1326 行），所以可以做成硬门槛：加一个 `--assert-reviewed <提交>` 之类的检查，或者在汇报模板里要求贴出 `usage.jsonl` 最后一行的 `head`。
- 方案里要回答：合并 main 产生的合并提交算不算“改动”（建议算，因为冲突解决是人写的）；只改文档的提交要不要豁免。
- 验收：规则文字改好；若加脚本检查，带正反用例。
- 2026-11-05 已出方案，未动工，等 Andy 拍板：见[方案](2026-11-05-opencode-review-plan-t2-t3-t5-t6.md)。
- 完成于 2026-11-05，提交 `0a0cd74e`（按[方案第 2 版](2026-11-05-opencode-review-plan-v2.md)改为 `--assert-reviewed`：比较代码差别而不是比较提交，并要求 main 已合进分支）。

<a id="t3"></a>
### T3 复核结果进仓库，账本按 PR 归档（对应 F3、F10；改流程，先出方案问 Andy）

- 做什么（方案要给 Andy 选）：
  - 账本的键：`--out` 由脚本按 `--base` 提交推导，或者要求传 `--pr <编号>`，让同一个 PR 的所有轮次必然落在同一个账本里，换目录名绕不过。
  - 保存什么：每轮的 `prompt.md`、两个模型的结论 `.md`、`usage.jsonl`。原始事件 `.jsonl` 和思考 `.thinking.md` 很大，建议不存。保存位置建议 `docs/reviews/<PR 编号>/`（这会让它受文档治理约束，要和 `document-governance` 技能的类型对上）或 `.agents/reviews/<PR 编号>/`（不受治理）；这是 Andy 要定的一项。
  - 什么时候存：线程在最后一轮复核后、合并前提交这些文件。
- 为什么值得：Andy 事后能查每轮费用和模型原话；产品愿景把“决策记录”列为四项资产之一。
- 验收：规则文字改好；脚本若推导 `--out`，带用例（同一 base 两次运行落在同一账本；不同 base 分开）。
- 2026-11-05 已出方案，未动工，等 Andy 拍板：见[方案](2026-11-05-opencode-review-plan-t2-t3-t5-t6.md)。另：F3 和本项把复核记录和产品愿景的“决策记录”挂钩，这是错的，更正见方案文件最后一节。
- 完成于 2026-11-05，提交 `d90b7e72`（按[方案第 2 版](2026-11-05-opencode-review-plan-v2.md)：记录存 `.agents/reviews/pr-<编号>/` 或 `topic-<短名>/`，复核副本里去掉记录目录）。

<a id="t4"></a>
### T4 把规则文件的长段落拆成小标题和列表（对应 F9；只改排版，不改内容，可直接做）

- 做什么：第 29 行（停止条件和轮次计数）、第 44 行（脚本的限制）、第 51 行（自检内容）、第 53 行（费用封顶和追问）各拆成带锚点的小节和列表。内容一字不改，只分段。
- 注意：这个文件的“每次都要问的问题”一节被脚本解析（`reviewQuestions` 按 `<a id="checklist"></a>` 找节、按 `数字. ` 取问题），不要动那一节的格式；拆完跑一次 `node -e` 调 `reviewQuestions` 确认仍取到 3 条。
- 验收：`npm run check:glossary`、`npm run check:instruction-links` 通过；`awk 'length>1500'` 没有输出。
- 完成于 2026-11-05，提交 `50ee1d88`。用子列表代替“带锚点的小节”，文字不变。

<a id="t5"></a>
### T5 让两个模型各有侧重（对应 F6；改提示词，先出方案问 Andy）

- 做什么：`MODE_TEXT`（脚本第 146-173 行）按模型加一段侧重说明，或者给 `--models` 配不同的 `--brief` 附加段。两个模型仍都回答全部必答问题。
- 注意：这会改发给模型的提示词开头。复核模型的每次运行都是新会话，没有跨运行的缓存可言，所以[只追加规则](../../.agents/instructions/prompt-prefix.md)这里不构成障碍，但方案里要写明这一点。
- 验收：至少用一个真实 PR 跑一轮，对比两个模型意见的重叠度，报给 Andy。这会花钱（一轮最多 0.4 美元），按先问门槛处理。
- 2026-11-05 已出方案，未动工，等 Andy 拍板：见[方案](2026-11-05-opencode-review-plan-t2-t3-t5-t6.md)。
- 完成于 2026-11-05：代码 `cf78bc59`；对比实验两轮共 0.3075 美元，结果和结论在 `.agents/reviews/topic-t5-experiment/README.md`。

<a id="t6"></a>
### T6 固定汇报模板（对应 F4、F5；改规则，先出方案问 Andy）

- 做什么：规则文件加一个汇报模板，固定这几行：最后一轮复核的 `head`；之后未复核的改动和原因；每轮的 `REVIEW_RESULT` 行（含 `steps`、`cacheRead`、`cost`）；`REVIEW_SPENT_TOTAL`；如果触发了“连续三轮没过”的停止条件，写明。再加一句：复核模型不能运行代码，“复核通过”只表示读代码没发现问题。
- 验收：规则文字改好；下一个 PR 的汇报照模板写。
- 2026-11-05 已出方案，未动工，等 Andy 拍板：见[方案](2026-11-05-opencode-review-plan-t2-t3-t5-t6.md)。
- 完成于 2026-11-05，提交 `2bfb8ee0`（`--report` 生成汇报固定几行，核对停下的原因）。

<a id="t7"></a>
### T7 锁 opencode 安装包的摘要（对应 F7；可直接做）

- 做什么：`opencodeBinary()`（第 259-275 行）安装后核对 `opencode-ai@1.19.5` 及其平台二进制包的 `sha512`（npm 的 `integrity` 字段），不符就以新错误码（例如 `OPENCODE_INTEGRITY_MISMATCH`）停下；摘要记在 `ci/toolchain-lock.json` 或脚本常量里。也可以改成 `npm install --ignore-scripts` 再核对。
- 验收：带反向用例（篡改摘要必须被拒）；云端和 Mac 各装一次通过（Mac 的平台包和云端不同，摘要要分别记）。
- 完成于 2026-11-05，提交 `31600e93`。Mac（darwin-arm64 平台包）上的安装未验证。

<a id="t8"></a>
### T8 单模型重跑补到原轮次（对应 F8；可直接做）

- 做什么：加 `--round <序号>`，只在该轮目录里缺这个模型的结果时允许，记录的 `round` 用这个序号；不传时行为不变。
- 验收：用例覆盖“补跑落在原目录”“原目录已有该模型结果时拒绝”“不传时仍取最大加一”。

[↑ 回到阅读导航](#contents)
- 完成于 2026-11-05，提交 `127fe420`。

<a id="unverified"></a>
## 未核实的事项

- F1 的外泄链没有端到端跑过。要验证可以在自检假服务器上加一条“网页里埋指令”的探针，但那要让假模型先 `webfetch` 再 `git log`，比 T1 的探针复杂；T1 把环境清掉之后这条链就断了，所以不一定需要。
- Andy 的 Mac 上环境变量里有什么，没法从云端核实。
- #247 第 4 轮之后没有第 5 轮的原因，从提交记录分不清（见 F5）。
- `bash -r` 之外，opencode 自己的 `read`、`grep`、`glob` 工具会不会读到环境变量：读代码看这三个工具只碰文件系统，`external_directory: deny` 挡了仓库外的路径（第 107 行），但没有专门验证 `/proc/self/environ` 这类路径（副本在 `/tmp` 下，`/proc` 在仓库外，应该被挡；自检有 `..` 和绝对路径探针，第 758-762 行，没有 `/proc`）。T1 的探针可以顺手加一条 `read /proc/self/environ`。

[↑ 回到阅读导航](#contents)

<a id="reporting"></a>
## 接手线程的汇报要求

- 每做完一项，在交付报告里写：对应的 F 编号、改了什么、门槛在哪个文件、修复前后门槛的结果。
- 需要 Andy 拍板的（T2、T3、T5、T6），把方案和真正要选的几项一起交给他，附本文件的链接，不要让他逐条看本文件。
- 花钱的步骤（T5 的真实对比、合并前的代码复核）按[钱和模型](../../.claude/rules/owner-standing-rules.md#money-and-models)先问。
- 本文件只追加：接手线程做完一项，在对应待办下加一行“完成于 <日期>，提交 <哈希>”，不改原文。

[↑ 回到阅读导航](#contents)
