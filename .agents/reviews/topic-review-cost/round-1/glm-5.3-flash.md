我先核对一下我在方案里要引用的一手来源（仓库自身规则已在上面读过），再写结论。
# 方案：削减代码复核费用（低严重度不触发复核 + 第 2 轮起单模型）

## 一、方案依赖的前提

**读代码或来源证实的**（文件：行 + 原话）：

1. `.agents/instructions/model-review.md:25`——“会出错”的定义把“不合规范的、恶意的或不可信的输入会让功能出错”和“说明、规则、文档与代码或事实不符”都算进去（原话见该行），这就是 PR #255 后几轮怪输入意见反复出现的根源。
2. `.agents/instructions/model-review.md:28`——“按‘会出错’的意见……就对这些修改再复核一轮……一直到线程核对后没有‘会出错’的意见为止”；`:31`——“一轮里只要有一条意见被判为‘会出错’……这一轮就算没过”。任何一条意见（哪怕一行注释）都能把循环推下去。
3. `scripts/model-review/opencode-review.mjs:784-798`（`lastCompleteRound`）——“if (!models.every((model) => passed.some((record) => record.model === model))) continue;”：一轮要被合并检查认作“完整”，默认要求 `REVIEW_MODELS`（`:24`）里两个模型在同轮都有 `ok`。这是“第 2 轮起单模型”要改的核心。
4. `scripts/model-review/opencode-review.mjs:806-826`（`changedOutside`+`assertReviewed`）——合并检查要求复核提交是 HEAD 祖先、且“两者之间只改了本 PR 的记录目录”（非记录目录文件的变动一律报 `unreviewed`）。**低严重度修复动了代码但不复核，必须给这条检查一个放行机制，否则方向 3 根本落不了地。**
5. `scripts/model-review/opencode-review.mjs:943-987`（`parseUsage`）——账本行校验：mode 白名单、head 必须是 SHA-1/SHA-256 提交哈希、`["head","model","outcome"]` 对三种模式必填、任何字段不得换行。新增记录类型要同时改“产生端”（录入命令）和“所有消费端”。
6. `scripts/model-review/opencode-review.mjs:997-1001`（`nextRound`）——只排除 `override`；`:835-843` 的 override 门槛数轮次只数 `mode === "code-review"`。新记录类型若不被排除/不计数，会把轮次编号和 override 门槛搅乱（I-73 型“两端没对上”）。
7. `scripts/model-review/opencode-review.mjs:764-772`（`budgetCheck`）——`thisRunMax = 0.2 × models.length`，单模型轮自动少算一半上[rand]限；`:703` 计划内 1 美元先问线不变。
8. `.claude/rules/prompt-prefix.md:27-29、35`——“固定的在前，会变的在后”“已经发给过模型的内容……只能在末尾追加”；本脚本每次运行都是新会话、整段提示一次构造（`buildPrompt`，`:193-222`），材料在最后。
9. Anthropic 官方 code-review 插件一手 README：“Scores each issue 0-100 for confidence level / Filters out issues below 80 confidence threshold”，并把“pedantic nitpicks""Issues linters will catch”列为被过滤的假阳性（https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md ，2026-11-06 我本人抓取原文核对）。这支持“低严重度意见不再触发整轮复核”是成熟做法。

**推测**（未逐一核实）：models.dev 单价、PR #255 六轮 0.789 美元及“56% 思考 / 58% 缓存输入”的拆分——副本里没有 `.agents/reviews/pr-255/`，按你给出的已核对事实采信；DeepSeek 单模型增量轮的每轮费用 0.05–0.08 美元是估算。

## 二、方案本身

### 1. 规则怎么改（`model-review.md`）

**第 2 步后新增“严重度分级”条款**（插在第 2 步两条分界线之后，作为第 2 步的子规则）：

- 线程把判为成立的“会出错”意见再分严重度：
  - **低**：同时满足①只有线程在测试里故意构造的非真实输入才能触发（文件名开头带空格、参数含控制字符这类，正常用户正常使用造不出来）；②触发后是报错拒绝、不产生错误结果；或意见只是“文字漏写/写得不准，但照着读不会做出实际错误动作”。判低必须写判断依据（文件：行或实际运行结果）。
  - **中/高**：其余全部，包括拿不准的。
- **低严重度的意见照样修改**（改代码、文档、规则或测试），但不再触发复核轮；修改完成后用一条命令把意见和改动记进账本（见脚本部分），合并前检查认这条记录。中/高严重度的修改照现行第 3 步：修改 → 再复核一轮。

**第 28 行**改为“只按中、高严重度的‘会出错’意见（或第 5 步 Andy 采纳的意见）做修改后复核一轮”；**第 31 行**的“一条会出错就算没过”改为“一条中/高严重度的会出错意见算没过”（低严重度已记录的不算）；**第 32、33 行**的连续三轮计数、Andy 裁定同步按“中/高”口径；**第 38 行** `no-error` 的含义改为“没有中/高严重度意见，已记录的低严重度修复由 `--report` 逐条列出”。

### 2. 脚本怎么改

**(a) 新账本记录类型 `low-fix`**（每行字段）：`at`、`round`（产生意见的复核轮）、`mode:"low-fix"`、`model`（提出这条意见的模型）、`head`（修复完成时的提交哈希）、`quote`（模型答案里的那一行原话）、`files`（本次修复改动的文件路径数组）、`cost:0`。
`parseUsage` 校验：`mode` 白名单加 `low-fix`；`low-fix` 要求 `head` 过 `COMMIT_PATTERN`、`quote` 非空、`round` 是正整数、`model` 属于 `REVIEW_MODELS`、`files` 是非空字符串数组且每项不以 `/` 开头、不含 `..` 路径段（其余控制字符/换行由现有 `hasLineBreak` 全字段兜住）。

**(b) 录入命令（线程一条命令，只读、不装 opencode、0 花费，在 `opencodeBinary()` 之前返回）**：

```
node scripts/model-review/opencode-review.mjs --record-low-fix --pr <编号> \
  --round <轮> --model deepseek-v4.1-flash \
  --quote "<模型答案里那段意见的一行原话>" --files <路径1>,<路径2>
```

校验全部在写账本之前：命令与 `--assert-reviewed`/`--report` 互斥（`ARG_NOT_FOR_SUBCOMMAND`）；`--round` 在账本里存在且该轮该 `model` 有 `outcome=ok` 的 code-review 记录（否则 `LOW_FIX_ROUND_NOT_FOUND` / `LOW_FIX_MODEL_NOT_OK`）；`quote` 去首尾空白后必须逐字等于 `round-<n>/<模型>.md` 里的某一行（否则 `LOW_FIX_QUOTE_NOT_FOUND`）；`files` 每项必须是被 git 跟踪的路径（否则 `LOW_FIX_FILE_INVALID`）；工作区账本与 HEAD 一致才追加（复用 `ledger-differs-from-HEAD` 的写法）。命令在修复提交**之后**跑（否则文件未跟踪会被拒），账本随 PR 提交。

**(c) 合并前检查 `--assert-reviewed`**：
- `lastCompleteRound`：round 1 仍要求两个模型都有 `ok`；round ≥2 只要求 DeepSeek 有 `ok`（glm 的 ok 记录照认不拒，旧 PR 账本零迁移）。**并加一条增强**：向后（轮号大的方向）每个 complete round 的 `head` 必须是上一个 complete round `head` 的后代（`merge-base --is-ancestor`），堵“复写历史后只补一轮 DeepSeek 洗掉双模型复核”的漏洞。
- `unreviewed` 放行：`changedOutside(reviewedHead, HEAD)` 里每个非记录目录文件，必须被某条 `low-fix` 记录的 `files` 数组覆盖；每条参与覆盖的记录同时要过三关：`head` 是 HEAD 祖先、`quote` 能在 HEAD 树的 `round-<n>/<模型>.md` 里逐字找到（用 `git show`，两边都先 trim）、自身过 `parseUsage`。任何一条不过，报 `low-fix-invalid <round> <原因>` 且和 `unreviewed` 一样导致失败——**先验 low-fix 合法性再谈覆盖，防止涂改记录后靠另一条兜底**。
- `nextRound` 过滤改成排除 `override` 和 `low-fix`；override 三轮门槛的轮次计数维持只数 `code-review` 模式（`low-fix` 不是复核轮）。

**(d) 第 2 轮起只跑 DeepSeek**：得出轮号后（`roundForRun` 之后、装 opencode、自检、花钱之前）：mode 为 code-review 且 round > 1 时，默认模型清单收敛为 `[deepseek-v4.1-flash]`；若调用方显式传了含 glm 的 `--models`，报 `GLM_ONLY_FIRST_ROUND <round>` 以退出码 2 结束，账本不变。收敛后的清单同时喂给 `roundForRun`、`budgetCheck`（`thisRunMax` 自动减半）和实际运行。`--round 1 --models glm` 这种补跑第 1 轮失败模型的用法不受影响。

**(e) `--report`**：每条 `low-fix` 记录单列一行 `REVIEW_LOW_FIX round=<n> model=<m> head=<h> files=<a,b>` 加 quote 原文，紧跟在 `REVIEW_RESULT` 之后、费用行之前；`no-error` 的一致性检查不变（`lastCompleteRound` + gate 全过，此时 gate 已认 low-fix）。

**(f) 测试**（`test/tooling/opencode-review.test.mjs`，全部带反例）：
- complete-round：round1 双 ok + round2 仅 DeepSeek ok → 认 round 2；反例①round2 仅 glm → 维持 round=1 并报 unreviewed；反例②round1 只有 DeepSeek → `no-complete-round`；反例③round2 head 不是 round1 head 后代 → 失败。
- low-fix 正例：round1 双 ok + 一条合法 low-fix → `REVIEW_CURRENT`；反例：a) 改动文件不在任何 `files` 里 → unreviewed；b) quote 不在 HEAD 树的模型答案文件里 → `low-fix-invalid`；c) low-fix head 不是 HEAD 祖先 → 失败；d) files 含 `../x` 或控制字符 → `USAGE_LEDGER_INVALID`；e) files 空数组 → 拒绝；f) 同文件只被列出但 low-fix 无效 → 整体失败（不因另一条记录盖过去）。
- 录入命令（`--record-low-fix`）：正例写入一行、退出 0；反例：quote 不在答案文件里、files 未被跟踪、round 不存在、该模型该轮不是 ok、与 `--assert-reviewed` 混用（`ARG_NOT_FOR_SUBCOMMAND`）——五个反例都必须以对应错误退出且**不写账本**。
- 轮 ≥2 单模型：正例默认只构造 DeepSeek 的提示词；反例：round>1 传 `--models glm` 或缺省双模型 → `GLM_ONLY_FIRST_ROUND`、退出码 2（用 `HIMAWARI_OPENCODE_BIN=/nonexistent` 证明它在安装 opencode 之前就拒绝）。
- report：low-fix 逐行列出、`spentOf` 不计入（cost=0）；反例：gate 不过时 `no-error` 报 `REPORT_STOP_INCONSISTENT`（沿用现有断言）。

### 3. 考虑过但不选的做法

- **让模型自己打严重度**：与现行“分类由线程做”（规则第 2 步）矛盾，且模型的分级无法自动核对；分级的全部监管交给“只能录模型答案原话 + Andy 抽查”这条链。
- **自动（静默）丢弃 glm 而不报错**：隐式行为会在排查时制造困惑；显式报错逼线程写下意图。
- **低严重度修复后再补一轮 DeepSeek**：吃回省下的钱，直接违背 Andy 定的方向。
- **低严重度记到单独文件（如 `low-fix.jsonl`）而不是 `usage.jsonl`**：`--report`/费用/校验链都已挂在 `usage.jsonl` 上，双文件意味着第二套“产生↔消费”契约要同时维护——正是 I-73 的教训，不选。
- **把第 2 轮起的推理强度降到 medium**：DeepSeek 56% 的花费在思考上，再降一档收益可观；但增量复核（找中高问题）恰恰靠思考质量，属于“降质量买钱”，单独列为待拍板项，不并入本方案。
- **只靠提高“会出错”定义的门槛来砍轮数**（不打严重度、直接把怪输入从定义里剔除一刀切）：没有留下“低严重度仍要修+抽查”的痕迹，Andy 失去逐条复核错裁的机会，比按严重度分流更粗。

### 4. 风险与反例

- **滥用 1：线程把真实问题都判低**。防线只有两条纪律性的：quote 必须逐字来自模型答案（不能无中生有），`--report` 逐条列出供抽查。这不是机器防线，和现行“脚本只核对说法与账本自洽”（规则第 38 行）的既有定位一致。
- **滥用 2：录一条大门值的 low-fix 却改了一堆代码**。files 数组必须覆盖全部非记录目录改动，但线程可以把所有文件都列进去。可选加固（需拍板）：限制单条 low-fix 的 files 数量（如 ≤5）或改动行数，超了按中/高走复核。
- **误拒反例**：线程手抄 quote 少了空格 → `LOW_FIX_QUOTE_NOT_FOUND`，无损失重录；模型答案文件名非 ASCII 已被覆盖（规则第 81 行、测试已有先例）。
- **误放反例**：git 允许文件名换行，而账本字段禁止换行 → 这种文件永远盖不住，只会安全地失败（报 unreviewed），不会误放。
- **滥用 3（新增隐患，用后代检查堵）**：复写历史后只跑 DeepSeek 一轮，让两双模型复核过的提交不产生后代关系 → 方案 2(c) 的“后一轮 head 必须是前一轮后代”会拒绝。

### 5. 需要人拍板的取舍

1. **low-fix 是否设规模上限**（文件数/行数）：不设是“Andy 抽查兜底”，设了是“机器拦截但多一条要维护的规则”。我倾向设：files ≤ 5 且各文件改动 ≤ 30 行（`git diff --numstat` 可在 gate 里核），超限报 `LOW_FIX_SCOPE_EXCEEDED` 要求走中/高复核。
2. **第 2 轮起是否降到 medium 推理强度**：约再省 40–50% 的 DeepSeek 花费，换取增量复核的找茬强度下降。
3. **“第 2 轮起只让 DeepSeek”与现有 override 三轮门槛（`:36`）的互动**：单模型轮更便宜，“连续三轮没过停下”的门槛要不要同步降低（如两次）？我倾向不动，等费用数字稳定后再调。

### 6. 成本效果（推测）

PR #255 型（6 轮 0.789 美元）：第 1 轮双模型 0.10–0.16 不变；第 2 轮起单模型增量输入小、且 DeepSeek 无 GLM 的缓存重读，估 0.05–0.07/轮；更主要的收益是中/高严重度意见比“会出错”全集少（材料：后几轮多为怪输入与规则文档类意见），触发轮数预计降一半以上。合计估 0.30–0.45 美元（约省 60%）。#248（0.26 美元）降幅小，因为第 1 轮占大头。1 美元先问线保持不变，单模型轮使 `thisRunMax` 自动减半。

## 三、必答问题逐条回答

1. **会不会改变模型见过的请求开头？** 不会。`buildPrompt`（opencode-review.mjs:193-222）的固定部分（角色、工具清单、必答问题、侧重、输出格式）原样保留，材料（含 brief、`--previous` 增量说明）仍在末尾；每次复核运行都是新会话、单请求，无历史可改写，无遮盖。改动只动规则文件和 brief 的**内容**（随各自轮次整体重建提示词），不改变“固定在前、材料在后”的结构。依据 prompt-prefix.md:27-29、35（“只能在末尾追加”）。新增的严重度说明若写进 `MODE_TEXT`/`MODEL_LENSES` 的固定段，同一段在各轮之间逐字节一致（每次都是新对话，冻结不冻结都无缓存损失）；每轮会变的值（`head`/`previous`/`base` 哈希、brief）本就只在材料区（:210-221）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。`low-fix` 记录带 `at` 时间戳，与现行每条账本记录相同（opencode-review.mjs:1862-1879 均写时间戳），且账本不进模型请求；gate 的文件覆盖比较用 `git diff --no-renames --name-only` + `\0` 分割（:806-810），与顺序无关；quote 比对双端先 trim（行尾空白被 `recordText` 统一去除是既有行为，:1601-1603）。
3. **有没有自动检查、反向用例会不会真失败？** 有，见方案 2(f)：complete-round 收窄、后代检查、low-fix 三关校验、录入命令五项校验、单模型轮拒绝，每条都列了具体反例和断言的错误码（`GLM_ONLY_FIRST_ROUND`、`LOW_FIX_QUOTE_NOT_FOUND`、`low-fix-invalid` 等），vitest 覆盖；失败路径全部在花钱/写账本之前返回。
4. **每个新值的产生端和使用端都能对上吗？** `mode:"low-fix"`：产生端 `parseUsage` 放行（:957 的 `modeValid` 加白名单）↔ 使用端四处同步——`lastCompleteRound`（忽略它）、`nextRound`（排除它，否则低修复会推高下一轮号）、`:835` 的 override 轮次计数（只数 code-review，天然不受影响）、`assertReviewed`（消费 files/quote/head）；漏改 `nextRound` 就是 I-73 式“只看改动、不查消费端”，已列为必改项。`files`：产生端校验为被跟踪的仓库内路径、无控制字符 ↔ 消费端 `changedOutside` 的路径同为相对仓库根的字符串，逐名相等即可；换行文件名盖不住但只会安全失败。`quote`：产生端命令行校验无控制字符（复用 `--andy-quote` 的 `hasControlCharacter`）↔ 消费端对 HEAD 树模型答案文件逐行 trim 比对，两端口径一致。模型标识：录入命令复用 `--models` 的“短名或完整名”解析（:1687-1690），与账本里存的完整名同源。
