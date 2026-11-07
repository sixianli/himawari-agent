下面按“前提 → 四个方案 → 未核实/推测 → 必答问题”给出。所有文件行号都基于当前检出 `bd0859a9`。

## 一、前提（读代码或一手来源证实）

**P1 两个模型固定，不能换。**
依据：`.agents/instructions/model-review.md:4`：“用 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash` 两个模型，推理强度都设为高，各看一遍。只能用这两个模型”。

**P2 现状只对“会出错”意见引起的修改再复核，合并 main 不属于触发条件。**
依据：`.agents/instructions/model-review.md:28`：“按‘会出错’的意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮（传 `--previous <上一轮复核的提交>`，模型先看增量），一直到线程核对后没有‘会出错’的意见为止”。

**P3 停止原因规则已经存在，但只写在规则里。**
依据：`.agents/instructions/model-review.md:29`：“连续三轮没过，第三轮的‘会出错’意见可以先改，但改完不再复核，直接停下报告 Andy……等他决定”。

**P4 复核模型只读，不能运行代码或测试。**
依据：`.agents/instructions/model-review.md:44`：“模型自己读代码：只开读文件、按内容搜索、按文件名找文件，以及 `git diff`、`git log`、`git show`、`git blame`、`git status`；改文件、别的命令、派子代理、仓库外的路径全部禁止”。

**P5 脚本本来就是“固定说明在前、本次材料最后”。**
依据：`scripts/model-review/opencode-review.mjs:179-201`，`fixed` 先拼，`material` 后拼；现有测试 `test/tooling/opencode-review.test.mjs:161-186` 断言两次请求在“---- 本次材料 ----”之前逐字节相同。

**P6 每轮是新的 opencode 会话；只有追问复用会话并在末尾追加。**
依据：`scripts/model-review/opencode-review.mjs:410-423` 只在传 `session` 时加 `--session`；`reviewModel` 只在追问时传 `session`（`:613-625`）。测试 `test/tooling/opencode-review.test.mjs:956-960` 断言追问请求是前一次请求的严格前缀加尾部追加。

**P7 费用累计只读 `--out/usage.jsonl`。**
依据：`scripts/model-review/opencode-review.mjs:661-681` 的 `readUsage(out)`；`:1250-1259` 用 `readUsage(options.out)` 做预算检查；`:1321-1335` 每轮记录 `round`、`model`、`head`、`outcome`、`cost`。

**P8 发给模型的内容只能在末尾追加，每轮变化值只能在最后一条消息里。**
依据：`.claude/rules/prompt-prefix.md:16-17`：“已经发给过模型的内容，不得改动、不得重排、不得删除，只能在末尾追加……每轮都会变的内容放在最末尾……只能写进最后一条用户消息。系统提示和工具定义里不得出现会变的值。”

**P9 合并进 main 目前不等 CI。**
依据：`.agents/instructions/delivery-mode.md:27`：“GitHub 合并门槛：合并进 `main` 不等待 `ci/required`。”

**P10 #248 确实存在“合并 main 后未复核”的改动。**
依据：`git show bd0859a9` 的提交说明：“双模型复核 2 轮（0.26 美元）；合并 main 后的规则改动（把摘要白名单收窄）未再复核。”

**P11 I-73 的漏检是“只看了 diff，没做跨模块契约核对”。**
依据：`docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」，漏了一个跨模块的契约问题”。

**P12 “同题多跑”不如“分维度跑”适合复杂复核。**
依据：Anthropic《Building effective agents》，https://www.anthropic.com/engineering/building-effective-agents ，原文：“For complex tasks with multiple considerations, LLMs generally perform better when each consideration is handled by a separate LLM call, allowing focused attention on each specific aspect.” 同文把并行分成 “Sectioning: Breaking a task into independent subtasks run in parallel” 和 “Voting: Running the same task multiple times to get diverse outputs”。

**P13 让第二个模型看着第一个模型的答案再答，会把第二个模型锚定在第一个答案上。**
依据：CoVe 论文摘要，https://aclanthology.org/2024.findings-acl.212/ ：“answers those questions independently so the answers are not biased by other responses”。这条用于否决“顺序复核：B 看 A 的结论再找漏”。

**P14 方案讨论的记录也有同样风险。**
依据：`.agents/instructions/model-review.md:16`：“材料只写问题、目标、约束、已核对的事实和查到的一手资料，不写线程的方案或倾向。” 以及 `.agents/instructions/model-review.md:17` 的 `plan-review` 会把线程方案发过去。因此材料是否混入线程方案，需要靠保存的 prompt 事后可查。

---

## 二、问题一：合并 main、冲突解决和复核后的小改动

### 方案

**改规则：把“最终提交”改成“将要合并的树”，并把“复核后新增任何会进入合并结果的提交”都列为必须再复核。**

`.agents/instructions/model-review.md` 第 1、3 步改成：

1. 第 1 步不再是“最终提交”，而是“准备合并的最终树”。明确写：
   - 最近一次复核之后，PR 分支上任何会改变合并结果的新提交（包括合并 main、解决冲突、复核后的一行修正、依赖更新、规则更新）都必须再复核一轮，才能合并。
   - 只新增 `.agents/reviews/<PR>/` 记录的提交不算改动（由脚本检查排除）。
2. 第 3 步明确：
   - 合并 main 后的复核传 `--previous <最近一次复核的提交>`，不是从头完整重看。
   - 合并提交要单独标出来：材料里写清两个父提交，要求先看 `git diff <previous>..<head> -- . ':(exclude).agents/reviews/**'`，再核对冲突解决；main 自身在别的 PR 已复核的部分不要求重读，但必须核对“两边组合后的最终树”。
3. 第 5 步补一句：不能用“这只是复核后顺手改的小改动”跳过复核；只要不是纯记录提交，就按第 3 步再复核。

**改脚本：`scripts/model-review/opencode-review.mjs`。**

- `main()` 解析 `head` 后，用 `git rev-list --parents -n1 <head>` 判断是否为合并提交。是的话往 `buildPrompt` 的 material 末尾追加一段固定格式的“本次 head 是合并提交，父提交为 …；重点核对冲突解决和组合结果”。这一段属于每轮材料，仍在末尾。
- `--previous` 在 `--pr` 已有记录时允许省略：脚本自动取“最近一个完整轮次的 `head`”，并在输出里打印 `PREVIOUS_DEFAULTED`。这样线程不会误把记录提交或 main 的提交当成上一轮复核点。显式传 `--previous` 时必须以该值为准；如果它和记录不一致，检查脚本会报错。
- `usage.jsonl` 的记录增加 `base`、`previous`、`mergeParents` 字段，便于事后判断这一轮复核的是不是合并提交。
- 不改变单轮内部的追加结构：合并检测只往 material 末尾加一行，不碰固定说明。

**新增 `scripts/model-review/check-review-record.mjs`（问题和问题四共用）。**

它做四件事：

1. 从 `.agents/reviews/<PR>/usage.jsonl` 找出最近一个完整轮次：两个固定模型都有记录、同一 `round`、`outcome === "ok"`。取该轮 `head` 作为 `reviewedHead`。
2. 如果存在比这个完整轮次更新的不完整轮次，报 `REVIEW_INCOMPLETE`。
3. `git merge-base --is-ancestor reviewedHead HEAD` 必须成立，否则报 `REVIEW_HEAD_NOT_ANCESTOR`（分支被改写）。
4. 运行 `git diff --quiet reviewedHead..HEAD -- . ':(exclude).agents/reviews/**'`。有差异就报 `UNREVIEWED_CHANGES`，并列出文件。只有记录目录变化则通过，输出 `REVIEW_RECORD_OK <head>`。

合并前线程必须运行它，并把输出贴进 PR。它不能强制 GitHub 阻止合并（快速模式不等 CI），但至少把“有没有未复核改动”从口头判断变成可复现命令。

### 考虑过但不选

- **只在合并 main 后复核，其他小改动仍然不复核**：不选。提交说明已经证明 #248 出问题的就是“合并 main 后的规则改动”这一小改动；同样的漏洞也会出现在“复核后顺手改一行”。规则应按“最终树”而不是按“改动大小”触发。
- **合并 main 后每次做完整复核（不传 `--previous`）**：不选。成本翻倍，而且会把 main 上其他人的大量改动重新读一遍。增量复核仍能读整棵树，不会漏掉组合结果；只有 main 改动特别大时才建议临时做完整复核。
- **让 GitHub CI 检查复核记录**：不选。快速模式下合并不等 CI；而且 CI 不能替线程跑付费模型。
- **只靠 PR 描述声明“已复核”**：不选。不可验证，也不防记错提交。

### 风险和反例

- 复核通过后、真正合并前，main 又前进了，GitHub 生成的合并提交会包含新的 main 改动。这些改动属于别的 PR，已有自己的复核；本 PR 只能保证自己分支上的树。若要求连这段也覆盖，就必须在每次 main 前进后重跑，成本不可控。建议明确边界：本 PR 只对“自己分支上的最终树”负责。
- 合并冲突解决可能引入新问题。脚本只能提示“这是合并提交”，不能强制模型读冲突文件；如果模型仍然只看 diff，仍可能漏。因此问题三的共享契约清单也必须适用于合并复核。
- `--previous` 自动取最近完整轮次时，如果线程想故意从更早的提交重看，必须显式传 `--previous`；这会产生“看起来复核了但增量更大”的情况，检查脚本只能验证 head，不能验证模型真的读了增量。

### 需要拍板

1. 合并 main 后的复核用增量（推荐）还是完整重跑？
2. 是否接受把“复核后任何非记录提交”都算未复核，而不只是合并 main？
3. 复核记录提交本身豁免，是否可以接受？

### 自动检查与反向用例

新增在 `test/tooling/model-review-records.test.mjs`：

- 正常：`reviewedHead` 之后只加 `.agents/reviews/<PR>/` 提交 → `REVIEW_RECORD_OK`。
- 反向：`reviewedHead` 之后加一个改代码的提交 → `UNREVIEWED_CHANGES`，列出文件。
- 反向：最新轮次只有一个模型有记录 → `REVIEW_INCOMPLETE`。
- 反向：把分支 reset 到 `reviewedHead` 之前 → `REVIEW_HEAD_NOT_ANCESTOR`。
- 合并提交：`head` 是 merge commit 时，材料末尾出现两个父提交；把这段提示删掉或放到固定说明里，测试必须失败。
- 把 `check-review-record` 的排除路径 `.agents/reviews/**` 去掉，上面的“纯记录提交通过”用例会变成失败——这就是反向用例真的会失败。

---

## 三、问题二：费用连续性和复核记录持久化

### 方案

**把代码复核的输出目录固定为 `.agents/reviews/<PR 编号>/`，并把可审计的小文件提交进仓库。**

**改脚本 `scripts/model-review/opencode-review.mjs`。**

- 新增 `--pr <正整数>`。`--mode code-review` 时：
  - 默认 `--out = <repoRoot>/.agents/reviews/<pr>`。
  - 如果显式传了不同的 `--out`，直接 `REVIEW_OUT_MISMATCH`。这堵住“换个目录名，1 美元从零开始”的漏洞。
  - 预算、轮次号、`usage.jsonl` 全部继续从该目录读，不需要新账本格式。
- 新增防丢账检查：如果工作区里 `.agents/reviews/<pr>/usage.jsonl` 不存在，但 `git log --all --format=%H -- .agents/reviews/<pr>/usage.jsonl` 能找到历史记录，就报 `REVIEW_LEDGER_NOT_CHECKED_OUT` 拒绝开跑。这样线程切到旧分支或旧工作区时不会悄悄从零累计。
- `plan` / `plan-review` 在 PR 还不存在时，新增必填 `--review-id <稳定短名>`（建议取分支名或任务 slug，不能每次随机）。路径同样是 `.agents/reviews/<review-id>/`。PR 建好后用一次 `--rename-review-id <旧> <PR>` 做 `git mv`；目标已存在就拒绝，保留同一份 `usage.jsonl`，不会重置费用。如果线程坚持在 PR 创建后直接用 PR 号跑计划讨论，也可以直接传 `--pr`。
- 每轮 `usage.jsonl` 记录增加 `pr` / `reviewId`、`base`、`previous`、`promptSha256`、`lens`（问题三用）。轮次和费用字段保持现状，避免破坏旧记录兼容。
- 每轮写出：
  - `round-<n>/<模型>.prompt.md`：该模型实际收到的完整提示词（问题三后两个模型提示词不同，所以必须按模型分文件）。
  - `round-<n>/<模型>.md`：模型正文。
  - `round-<n>/<模型>.thinking.md`：思考内容。
  - `round-<n>/<模型>.jsonl`：原始事件。**不提交**，只留在本地 `--out`，并在 `meta.json` 里记它的 SHA-256。
  - `usage.jsonl`：追加，不重写旧行。
  - `meta.json` 和 `summary.md`：见问题四。
- 原始事件几 MB，提交进 git 会让仓库膨胀，而且大部分是工具调用流，不是“模型原话”。模型原话在 `<模型>.md`；思考在 `.thinking.md`。如果 Andy 要求连原始工具流也永久保存，才改为提交 `.jsonl.gz`，并接受仓库增长。
- 在 `prepareCopy` 检出后，用 sparse checkout 排除 `.agents/reviews`，让复核模型看不到之前各轮的 prompt、结论和线程方案；同时新增根目录 `.gitattributes`，写 `/.agents/reviews/** -diff`，让 `git diff` 不显示这些记录的内容。脚本给模型的 diff 命令统一写成 `git diff <base>..<head> -- . ':(exclude).agents/reviews/**'`。
- 新增 `.agents/reviews/.gitignore`，忽略 `round-*/**/*.jsonl` 和 `round-*/**/*.stderr.txt`，确保原始事件不会被误提交。
- 修改 `biome.json` 的 `files.includes`，加 `!!.agents/reviews`，理由和 `.agents/tasks` 一样：这是生成的数据目录，不该被格式化和 lint 改写。
- `.agents/reviews` 不在 `docs/` 下，因此不触发文档治理的严格校验；但它仍会被 `check:secrets` 扫描。如果模型原文里出现了看起来像密钥的字符串，脚本不应该自动加宽白名单；线程必须核对后用现有 `machine-secret-scan-baseline.json` 的窄条目处理，或者不提交那一段。

### 考虑过但不选

- **继续用 `--out` 临时目录，再定期复制到云端对象存储**：不选。多一套基础设施和凭据，违反 Andy “存进仓库”的决定。
- **存进 `docs/`**：不选。Andy 已明确不放 `docs/`，且会触发文档治理。
- **把所有 `round-*/<模型>.jsonl` 都提交**：不选，除非有特别理由。几 MB × 每轮 × 每个 PR 会长期拖慢 clone；模型原话和材料已经在 prompt/答案/思考里。
- **把记录放到独立 orphan 分支**：考虑过。它能彻底避免记录进入被复核的 diff，但线程每次要切/建分支，预算读取和推送也更复杂；本方案用 sparse checkout + `.gitattributes` + diff pathspec 达到接近效果。如果实测仍发现模型会从历史对象里 `git show` 记录，再改成独立分支。
- **用一个“carry-over”文件手工补旧费用**：不选为默认。它能救现有 PR，但也制造重新计费的口子；现有 PR 应当重跑或由 Andy 明确批准一个总额。

### 风险和反例

- 记录提交进入 PR 分支后，PR 的 diff 会多出记录目录。用 sparse + `.gitattributes` 可以让模型看不到内容，但 GitHub 网页的 diff 仍会看到文件列表；这是可接受的代价。
- `check:secrets` 可能对模型原文误报。不能为了消掉误报而整体排除该目录，否则记录可能变成藏密钥的地方。需要逐条核对。
- 旧 PR（包括 #248）的历史花费已经随云端容器消失，无法从仓库恢复。只能从提交说明看到“2 轮 0.26 美元”；每轮原话和 prompt 已不可得。这是已发生的损失，方案只能防止以后再发生。
- 如果线程在 PR 分支之外跑复核，`--pr` 路径仍然固定，但记录可能落在错误分支；`REVIEW_LEDGER_NOT_CHECKED_OUT` 只能发现“历史里有、工作区没有”，发现不了“在别的未推送分支上产生了新记录”。

### 需要拍板

1. 原始 `.jsonl` 不提交，只提交 prompt、答案、思考、usage、summary，是否可以接受？
2. 计划讨论记录是否也要用 `--review-id` 持久化；还是只保代码复核记录？
3. 已有 PR 的旧费用是否需要人工 carry-over，还是直接重跑？
4. 是否接受 sparse checkout + `.gitattributes` 这套“记录在 PR 里但复核模型看不到”的做法。

### 自动检查与反向用例

新增 `test/tooling/model-review-records.test.mjs`：

- `parseArgs(["--mode","code-review","--pr","248",...])` 得到的 `out` 必须是 `.agents/reviews/248`。
- 显式传别的 `--out` → `REVIEW_OUT_MISMATCH`。
- 同一 PR 两次运行，第二次预算读到第一次的 `usage.jsonl`；把目录名换成别的 → 预算从零，测试必须失败（反向证明路径固定是必要的）。
- 在另一个分支已有 ledger、当前分支没有 → `REVIEW_LEDGER_NOT_CHECKED_OUT`。
- `prepareCopy` 后副本里不存在 `.agents/reviews`，`git status` 仍然干净；把 sparse 排除删掉，测试失败。
- `.gitignore` 生效：`round-1/model.jsonl` 不被 `git ls-files` 列出，`usage.jsonl` 被列出。
- 反向：让 `--out` 退回旧逻辑，预算测试和路径测试都必须失败。

---

## 四、问题三：两个模型意见重叠，I-73 式的跨模块契约漏检

### 方案

**不做“同一提示词跑两遍”，改成“共享必查项 + 每个模型一个固定的重点视角”。两个模型仍然各看整份改动，视角只决定第一轮注意力和必答项，不把工作切成互不相交的两半。**

改 `scripts/model-review/opencode-review.mjs`：

- 新增 `REVIEW_LENSES`，按模型短名固定映射：
  - `deepseek-v4.1-flash`：**跨模块契约**。要求列出本改动新增/修改的每一个对外标识、字段、类型、序列化格式、取值范围、配置项和清单项；用 `grep`/`glob` 找到所有生产者与消费者（不同包、不同进程、清单、数据库、测试夹具），逐一核对“这里产生的值能不能通过每一处校验”；必须回答类似“清单里的 id 能通过后端校验吗”的问题。
  - `glm-5.3-flash`：**输入与失败路径**。要求列出所有外部输入（用户、网络、文件、数据库、配置、模型输出）及边界；检查非法、恶意、不可信输入，错误分支、超时、重试、并发、资源耗尽、不可逆操作；尽量给出具体反例。
- 两个模型都追加一条**共享必查项**：
  - “对本改动中每一个新增或修改的标识、字段、类型、接口、序列化格式和取值，列出生产者和消费者，核对两端契约；只看 diff 不够。若本改动扩展了清单、目录或配置，必须把清单里生成的每个值交给下游校验。”
  这一条直接针对 I-73，和视角分开：视角决定先查什么，共享项保证两个人都不能跳过契约。
- `buildPrompt` 增加 `model`/`lens` 参数。固定说明里插入该模型的 lens 文本。material 仍是最后一段，里面只有 `head`、`base`、`previous`、`brief`。
- 每个模型的固定前缀不同，但同一模型跨轮次完全相同：lens 只由模型名决定，绝不按轮次、日期、PR、随机数变化。这样不会破坏同一模型多轮之间的前缀一致性。
- 每轮按模型写 `<模型>.prompt.md`，不再写一份“所有模型共用”的 `prompt.md`。
- 输出格式增加一段：“先写你按分工重点检查了什么，再写其他发现”。防止模型只交视角内的内容。

改 `.agents/instructions/model-review.md` 和 `AGENTS.md` 入口，写清“两个模型看同一份改动，但重点视角不同；视角不是分工放弃，任何模型发现视角外的问题也必须报告”。

**一次真实对比实验（Andy 已同意花一轮的钱）。**

- 用历史 I-73 案例：`head = d347c51d`（合并 #207 后的有 bug 状态），`base = 7911a7ad`（#207 合并前的 main），材料用 #207 的原始标题/说明重写，不写“斜杠”“machineString”“后端校验”等答案提示。
- 用新方案跑一轮两个模型。判定成功的最低标准：至少一个模型在“会出错”级别指出“清单生成的 `modelRef` 会过不了某个 `machineString` / 契约校验”，或明确把“清单 id 必须逐个交给发送/保存/沙盒校验”列为必查项并给出具体路径。
- 同时记录两份报告的重叠度：把“同一文件:行 + 同一问题”视为重复，计算 `重复条数 / 并集条数`。由于旧方案的原始报告没有保存，这个数只能作为新方案的第一份基线，不能严格证明“比旧方案更不重叠”。
- 实验记录存到本次规则改动 PR 的 `.agents/reviews/<PR>/experiment-i73/`，包括 per-model prompt、答案、usage 和结论。不要把实验记录写进 `docs/`。
- 如果两个模型都漏了 I-73，不采纳该改法，先分析是 lens 设计问题还是共享必查项写得太泛。

### 考虑过但不选

- **只加共享契约清单，不给模型分视角**：可以作为“实验失败后的退路”。它可以提高 I-73 的检出概率，但没有解决“两个模型花同样的钱做同样的事”的重叠问题。
- **顺序复核：A 先看，B 看 A 的结论再找漏**：不选。B 会被 A 的结论锚定；CoVe 的摘要明确说验证问题要独立回答才不被其他答案带偏（https://aclanthology.org/2024.findings-acl.212/ ）。而且规则第 4 行要求两个模型“各看一遍”，顺序复核会让 B 实际在审核 A 而不是独立看 PR。
- **把改动硬切成两半，A 只看一半、B 只看另一半**：不选。任何一半漏检都没有第二个人兜底，和 I-73 的教训相反。
- **每轮随机换视角或按轮次旋转**：不选。同一模型跨轮次的固定前缀会变，缓存失效，也破坏可复现性（违反 prompt-prefix 的精神）。

### 风险和反例

- 两个模型都可能把 lens 当成“只查这一块”，忽略其他问题。规则和输出格式必须明确“视角只是起点，发现视角外的问题也要报”；如果实验显示模型确实只看 lens，退回到“共享契约清单 + 同提示词”。
- lens 是按模型名硬分配的；如果某个模型本来就更容易发现输入/失败路径，分配可能反了。这只能靠实验和后续 PR 观察调整；不能中途在同一个 PR 里换，否则同一模型前缀变了。
- 一轮实验只能证明“这个案例是否被抓住”，不能证明所有跨模块问题都改善，也不能严格证明重叠下降。要真正的 A/B 需要旧方案也重跑一轮，但这会多花一轮的钱。
- 增加共享契约必查项会让所有代码复核稍微变长、变贵；最近一轮两个模型合计约 0.06–0.13 美元，增加量应很小，但要在实验里记实际值。

### 需要拍板

1. 是否接受“共享契约必查项 + 模型分视角”，还是只加共享必查项。
2. 哪个模型拿“跨模块契约”、哪个拿“输入与失败路径”；如果实验证明反了，是否允许在下一次改规则时交换。
3. 一轮实验的结果达到什么标准才算“改法有效”；我建议至少抓住 I-73 的契约问题，否则不推广。

### 自动检查与反向用例

新增 `test/tooling/model-review-lenses.test.mjs`：

- `REVIEW_LENSES` 的键必须恰好是两个固定模型的短名，不能有第三个、不能缺一个、不能重复。
- 同一模型连续调用两次 `buildPrompt`，固定前缀逐字节相同；`head`、`base`、`previous`、`brief` 只能出现在 material 段。
- 两个模型的固定前缀必须在 lens 段不同，且都包含共享契约必查项。
- 反向：把两个模型映射到同一个 lens → 测试报 `LENS_NOT_DISTINCT` 失败。
- 反向：让 lens 依赖 `round` 或日期 → 同一模型跨轮次前缀不再相同，前缀测试失败。
- 反向：把 `head` 写进固定前缀 → 现有“固定说明不随 head/base/brief 变化”的测试失败。
- 反向：`--models` 只跑一个模型时，不要求另一个模型的 lens 出现；出现未被请求的 lens 也要失败。

真实模型能否抓住 I-73 不能进 `npm run check`，因为要花钱；它是一次性实验，记录在仓库里备查。

---

## 五、问题四：PR 描述和提交说明看不出复核到哪、是否有未复核改动、为什么停

### 方案

**让脚本生成机器可读的复核摘要，线程只补“分类和停止原因”这一层判断；PR 描述必须从摘要里复制固定字段。**

改 `scripts/model-review/review-record.mjs`（新模块，供脚本和检查共用）：

- `summary.json` 至少包含：
  - `pr` / `reviewId`、`mode`
  - `rounds`：每轮 `round`、`head`、每个模型 `outcome`、`cost`、`wrapUp`、`toolCalls`
  - `reviewedHead`：最近一个完整轮次的 head
  - `totalCost`
  - `modelsRanCode: false`，并附一句话“复核模型只读，未运行代码或测试”
  - `recordsRoot`：`.agents/reviews/<PR>`
- 线程在每轮分类后写一个 `decision.json`，字段：
  - `round`
  - `errorCount`（判为“会出错”的条数）
  - `betterCount`
  - `notValidCount`
  - `andyAcceptedCount`
  - `stopReason`：`no-error` / `three-rounds` / `andy-decision` / `run-failed`
  - `andyQuote`（仅 `andy-decision` 时必填）
  - `unreviewedChanges`：由检查脚本算，不手填
- `renderSummary` 生成 `.agents/reviews/<PR>/summary.md`，固定字段：

```text
复核对象（最后一次完整轮次的 head）：<sha>
复核后未复核改动：无 / <文件列表>
停止原因：没有「会出错」的意见 / 连续三轮没过 / Andy 裁定 / 运行失败
复核性质：双模型只读代码复核；模型只读文件和 5 条 git 读命令，未运行代码或测试
轮次与费用：第 1..N 轮，累计 <美元>
```

改 `.agents/instructions/model-review.md` 第 5 步和第 30 行附近，规定：

- 不允许写“双模型复核 N 轮都过了”。这句话会被理解成测试通过。
- 必须写“双模型代码复核 N 轮，均无「会出错」意见；复核模型只读文件和 5 条 git 读命令，未运行代码或测试”。
- 如果停止原因是连续三轮，必须写“因为连续三轮出现「会出错」意见而停下”，并列出已改未复核和未解决。
- 如果停止原因是 Andy 裁定，必须附上他的原话。
- PR 描述必须有上面五个字段；提交说明必须带 `Reviewed-head: <sha>` 和 `Review-record: .agents/reviews/<PR>/summary.md`。GitHub 的合并说明通常沿用 PR 标题，所以 PR 描述是主要承载处。

新增 `scripts/model-review/check-review-record.mjs` 的校验部分：

- 校验 `summary.json` 与 `usage.jsonl` 一致：`reviewedHead` 必须是最近完整轮次的 head；每轮费用和 outcome 对得上。
- 校验停止原因与分类一致：
  - `no-error`：最近完整轮次 `errorCount === 0`，且所有模型 `outcome === "ok"`。
  - `three-rounds`：最近三个完整轮次 `errorCount > 0`。
  - `andy-decision`：必须有 `andyQuote`。
  - `run-failed`：最近轮次存在 `outcome !== "ok"`，且不能声称“均无会出错”。
- 校验 `summary.md` 包含固定文本，且不含“都过了”这类说法的误用。
- 输出 `REVIEW_SUMMARY_OK` 或具体错误码。

### 考虑过但不选

- **只让线程在 PR 描述里手写**：不选。会写漏、写旧，事后无法校验。
- **从 git log 自动推断停止原因**：不选。git 只知道提交，不知道线程把哪条意见判成“会出错”，也不知道 Andy 是否裁定不改。
- **把“是否运行测试”写成“复核模型没有运行代码”但保留“复核通过”**：不选。必须把“代码复核”和“测试通过”明确分开；模型只读，不能声称测试通过。
- **把分类结果也交给模型生成**：不选。规则第 2 步已经明确分类由线程做，不由模型做（`.agents/instructions/model-review.md:24`：“分类由线程做，不由模型做”）。

### 风险和反例

- `decision.json` 是线程手写的，仍有主观判断。自动检查只能验证“自洽”，不能验证线程真的读了模型意见。
- 如果线程在最后一次检查之后又改了 PR 描述，仓库里的 summary 和 GitHub 上的描述可能不一致。快速模式下没有 CI 强制，只能靠合并前人工核对。
- 记录提交本身可能让 PR 分支 head 变化；`reviewedHead` 必须保持“最后一次代码复核的 head”，不能因为提交记录就更新，否则会把记录提交也当成被复核内容。检查脚本要排除 `.agents/reviews/**`。
- 如果一轮里一个模型 `outcome` 是 `cost-limit` 或 `timeout` 但仍写了正文，`runOutcome` 仍会标记非 ok（见 `opencode-review.mjs:696-703`）；这种情况不能被 summary 说成“完整复核”。检查必须拦住。

### 需要拍板

1. 是否接受“线程写 decision.json，脚本生成 summary.md，PR 描述照抄固定字段”这套两层结构。
2. 是否把 `check-review-record --pr <n>` 作为合并前必跑项，并接受“它只是可验证命令，不是强制 Git 平台门槛”。
3. 是否允许 `run-failed` 后不合并；还是要求必须重跑到 `ok` 才能合并。

### 自动检查与反向用例

新增在 `test/tooling/model-review-records.test.mjs`：

- 正常：两个模型完整轮次、`errorCount=0`、`stopReason=no-error` → `REVIEW_SUMMARY_OK`。
- 反向：`summary.md` 写“双模型复核 2 轮都过了” → 校验失败。
- 反向：最新轮次 `outcome=cost-limit`，但 `stopReason=no-error` → 失败。
- 反向：`stopReason=three-rounds`，但最近三轮里有一轮 `errorCount=0` → 失败。
- 反向：`reviewedHead` 与 `usage.jsonl` 最近完整轮次的 head 不一致 → 失败。
- 反向：只给一个模型记录，声称完整复核 → `REVIEW_INCOMPLETE`。
- 反向：`reviewedHead` 之后有代码提交 → `UNREVIEWED_CHANGES`；只有记录目录提交则通过。

---

## 六、已证实 vs 推测 / 未核实

**已证实（读代码、读规则、读 git 历史）：**

- 当前复核轮次是新的 opencode 会话；追问才复用会话并只在末尾追加（`opencode-review.mjs:410-423`、`:613-625`、测试 `:956-960`）。
- 当前提示词是固定说明在前、材料在后（`opencode-review.mjs:179-201`）。
- 当前费用只从 `--out/usage.jsonl` 读（`opencode-review.mjs:661-681`、`:1250-1259`）。
- 当前 `usage.jsonl` 记录已有 `round/model/head/outcome/cost`（`opencode-review.mjs:1321-1335`）。
- #248 提交说明确实承认“合并 main 后的规则改动未再复核”。
- I-73 的漏检原因在 `docs/incidents-and-gates.md:112` 写明。
- 当前规则确实只要求对“会出错”意见引起的修改再复核（`model-review.md:28`）。
- 合并进 main 不等 CI（`delivery-mode.md:27`）。
- Anthropic 文章和 CoVe 摘要的原文已核对。

**推测 / 未核实：**

- 材料说后续分支已有“opencode 只拿白名单环境变量”“npm ci”“新增 `--round`”，这些在当前检出看不到；本方案默认它们会先合入，否则“重跑单个模型补进同一轮”需要额外实现。**未核实。**
- `.gitattributes` 的 `-diff` 能否挡住模型用 `git show <hash>:<path>` 直接读记录，未实测；sparse checkout 能挡住 `read`，但挡不住知道路径后的 `git show`。如果这一点重要，需再加 git 替身对 `.agents/reviews` 参数/路径的拒绝。
- sparse checkout 在脚本的 clone + fetch + checkout 流程里是否能让 `git status` 保持干净，需在实现时用真实 git 版本验证；本方案把它列为测试项。
- 一轮实验能否抓住 I-73，属于实验结果，不能预先声称。当前只能确定 I-73 历史上旧方案漏了。
- 现有旧 PR 的历史花费和原话是否还能从别处恢复：**未核实，且大概率不能**；容器回收后仓库里没有这些文件。

---

## 七、必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**四个方案中，只有问题三改固定提示词；其余三个不改模型请求。**

- 问题一：合并检测只在 `buildPrompt` 的 material 段末尾加“这是合并提交、父提交是谁、冲突文件”这类本轮信息；`--previous` 默认值只改变 material 里的上一轮提交。固定说明不动。每轮仍是新的 opencode 会话，不涉及改写已发历史。
- 问题二：`--pr`、路径、预算、记录文件、sparse checkout、`.gitattributes` 都在模型请求之外；`prompt` 文本本身不增加时间、目录、费用字段。记录文件不进复核副本。
- 问题三：会给两个模型各自的固定前缀加 lens，并把共享契约必查项加到固定部分。**对新会话来说是从头开始的新提示词，没有改动它已经见过的历史。** 对同一模型跨轮次，lens 只由模型名决定，不随轮次/日期/PR 变，所以同一模型的前缀仍然稳定。`head`、`base`、`previous`、`brief` 仍只在最后的 material 段。
- 问题四：summary、decision、PR 字段都在模型请求之外。
- 追问路径不变：仍是同一 session 末尾追加 `WRAP_UP_PROMPT`，现有 `expectAppendedTo` 测试继续守（`test/tooling/opencode-review.test.mjs:956-960`）。

所以结论：**发给模型的内容仍然只在末尾追加；每轮会变的值（head/base/previous/brief/合并父提交）仍然只出现在最后的材料块里。** 唯一的一次性变化来自问题三新增的固定 lens/契约文本，它会让新复核的缓存重新建立一次，但不会作用于任何已进行中的会话。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- 问题三的 lens 是模型名到固定文本的查表，不含时间、轮次、PR 号、随机数；同一模型在任何轮次拿到的 lens 字节相同。共享契约文本也固定。
- `head`、`base`、`previous` 本来就每轮不同，但它们在最后 material 段；这不是“同一段文字在不同请求里变字节”，而是本轮材料本来就在末尾变化。
- `usage.jsonl` 和 `summary.json` 里的 `at`/`generatedAt` 时间戳只写记录文件，不进入 prompt；`.agents/reviews` 又被排除出复核副本和 diff，所以模型不会读到带时间的记录。
- 摘要里的模型顺序由 `options.models`/固定模型表决定，建议再按 `REVIEW_MODELS` 的固定顺序排序；不把 `Set`/目录遍历顺序直接序列化进任何模型可见文本。
- 遮盖方面，本方案不新增遮盖逻辑；如果对记录文件做敏感信息遮盖，必须复用现有确定性规则，不能依赖前后文。当前方案没有自动遮盖，只保留现有 `check:secrets` 拦截。

结论：**没有引入“同一段文字依赖前后文遮成不同字节”的机制。** 记录文件里的时间戳不发给模型；模型可见的 prompt 中每轮变化的值仍只在 material 段。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，分四组，并建议把纯单元测试加入 `npm run check`：

- 问题一/四共用 `check-review-record` 和 `test/tooling/model-review-records.test.mjs`：正常记录通过；`reviewedHead` 后有代码提交、轮次不完整、head 不是祖先、summary 与 ledger 不一致、`stopReason` 与分类矛盾、写“都过了”，都必须失败。
- 问题二在同一个测试文件：固定 `.agents/reviews/<PR>`、拒绝别的 `--out`、跨目录预算连续、ledger 未检出、sparse 排除记录、`.gitignore` 不误提交原始事件。把路径固定或排除逻辑删掉，反向用例会失败。
- 问题三在 `test/tooling/model-review-lenses.test.mjs`：lens 键集合、同模型前缀稳定、两个模型 lens 不同、共享必查项存在、material 只在末尾。把两个模型 lens 写成一样、或让 lens 依赖轮次，测试会失败。
- `package.json` 建议新增：
  - `"check:model-review": "vitest run --config vitest.workspace.ts --project tooling test/tooling/model-review-records.test.mjs test/tooling/model-review-lenses.test.mjs"`
  - 把它加进 `check:steps`，因为这两个文件只做纯逻辑/temp git 操作，不调用付费模型。

**反向用例要真的会失败，做法是先把新测试写在旧实现上或做一个临时变异：**

- 把 `check-review-record` 的 `.agents/reviews/**` 排除去掉 → “纯记录提交通过”反向失败。
- 把预算路径改回 `options.out` → “换目录名从零累计”反向失败。
- 把两个模型的 lens 都设成同一段 → `LENS_NOT_DISTINCT` 失败。
- 把 `head` 加进固定说明段 → 现有前缀测试（`opencode-review.test.mjs:161-186`）失败。
- 把 `summary.md` 的“均无会出错意见”改回“都过了” → 摘要校验失败。

**做不到的自动检查：**

- I-73 是否真的被新 lens 抓住，必须花钱跑真实模型，不能进 `npm run check`；只能做一次性实验并把结果存进 `.agents/reviews`。
- “线程有没有认真读模型意见”“分类是否正确”属于人/线程判断，脚本只能检查 `decision.json` 与记录是否自洽，不能证明判断为真。
- 合并 main 后到真正合并之间 main 又前进所引入的改动，不是本 PR 分支能自动检查的；本方案只覆盖本分支最终树。

---

## 八、真正需要 Andy 拍板的几项（汇总）

1. **问题一**：合并 main 后是增量复核（推荐）还是完整复核；是否把所有“复核后非记录提交”都算未复核。
2. **问题二**：原始 `.jsonl` 是否只留本地、不提交；计划讨论记录是否也要持久化；旧 PR 费用是否人工 carry-over 或重跑。
3. **问题三**：是否接受“共享契约必查项 + 模型分视角”，以及两个模型分别拿哪个视角；实验未达到“抓住 I-73”时是否退回只加共享清单。
4. **问题四**：是否接受线程写 `decision.json`、脚本生成 `summary.md`、PR 描述照抄固定字段；合并前运行 `check-review-record --pr <n>` 是否作为必跑步骤。
