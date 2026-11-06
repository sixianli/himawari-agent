结论先说：方向对，但按原文直接实施会卡住。最严重的是 **T3 把复核记录提交进 PR** 和 **T2 要求最后复核的 `head` 等于当前提交** 形成循环；其次是 **T5 不能只在 `MODE_TEXT` 里加一句**，现有脚本是一轮只生成一份 prompt、两个模型共用。建议先改方案再动工。

## 证实的

### 1. 高：T2 与 T3 互相锁死，记录提交永远比复核新

**问题**：T3 要求线程在合并前把 `.agents/reviews/<PR>/` 随 PR 提交；T2 要求合并前最后一轮复核的 `--head` 等于分支当前提交，而且方案明确说“只改 `docs/`、`.agents/` 文字的提交不豁免”。

**证据**：
- 方案第 57 行：“合并前，最后一轮复核的 `--head` 必须等于分支当前提交”。
- 方案第 69 行：“线程在合并前把这个目录随 PR 一起提交”。
- 方案第 21 行：“只改 `docs/`、`.agents/` 文字的提交要不要豁免：建议**不豁免**”。
- 记录目录是 `.agents/reviews/<PR>`（方案第 23、67 行）。

于是：复核完 `H` 得到记录 → 提交记录得到 `C` → 当前提交变成 `C`，不等于 `H` → 必须复核 `C` → 又产生新记录 → 再提交成 `C2`……没有终止条件。 Andy 已拍板“记录存 `.agents/reviews`”，所以不能靠换目录解决，必须给“只增加复核记录”的提交一个明确的窄例外。

**建议**：
- `--assert-reviewed` 接受两种情况：当前提交等于被复核提交；或 `git diff --name-only <被复核提交>..<当前提交>` 的路径全部在 `.agents/reviews/<本 PR>/` 下。
- 只豁免这个目录，不豁免其他 `docs/`、`.agents/` 改动。
- 补测试：复核 `H` → 只提交记录 `C` 通过；再多改一个非记录文件失败。

### 2. 高：T2 只校验 `head`，没有校验 `base` 和 `previous`

**问题**：方案把“批准之后推了提交”简化成“提交哈希相等”，但 GitHub 的原话是按 **diff 状态**作废旧批准，且明确包含“目标分支相关 PR 合并”和“merge base 变化”。只校验 head 挡不住目标分支前进、更新分支、merge base 变化后 diff 已经变了的情况。

**证据**：
- 方案第 57、58 行只要求 `head` 相等。
- `scripts/model-review/opencode-review.mjs:1446-1460` 的 `record` 只有 `head: commits.head`，没有 `base`、`previous`。
- GitHub 文档：“If the diff changes from this state (for example, because a contributor pushes new changes to the pull request branch or clicks **Update branch**, or because a related pull request is merged into the target branch), the approving review is dismissed as stale”；“If the merge base changes, the pull request cannot be merged until someone approves the work again.”
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

**建议**：
- 每条用量记录加 `base`、`previous`、`promptHash`。
- `--assert-reviewed` 检查 `previous` 是被复核提交的祖先；如果当前目标分支的 merge base 已变，要求重新复核，而不是只看 head。
- 补测试：复核后 main 前进、`base` 变化必须失败；`previous` 不是祖先必须报 `REVIEW_NOT_ANCESTOR`。

### 3. 高：`--assert-reviewed` 的“最大 ok 轮次”选法有洞，和 `--round` 重跑冲突

**问题**：方案说“找出 `outcome` 为 `ok` 的最大轮次，要求两个模型在这一轮都是 `ok`”。但 `--round` 重跑会在同一轮留下“先失败、后成功”两条记录；只跑一个模型也会留下不完整的一轮。按字面实现容易把“只有更早一轮完整”误判为通过，或者把同一轮里已经成功的重跑判失败。

**证据**：
- `test/tooling/opencode-review.test.mjs:1761-1766` 的示例：第 2 轮 DeepSeek `ok`、GLM `timeout`；`--round 2` 重跑 GLM 后同一轮会有两条 GLM 记录。
- `readUsage` 返回全部行（`opencode-review.mjs:728-748`）；`keepEarlierAttempt` 只负责改文件名（`opencode-review.mjs:780-800`）。
- 方案第 58 行没有说明“重复记录怎么算”“缺一个模型算不算”“按 `mode` 过滤”。

**建议**：
- 明确定义：只看 `mode === "code-review"`；取“在目标 head 上、两个必需模型都至少有一条 `ok` 记录”的最晚完整轮；同一模型同一轮有多条时，以最后一次尝试为准，或只要有一次 `ok` 即算该模型成功，但要在方案里写死并测试。
- 缺少任一模型、只有更早轮次、最新一轮失败后没有重跑、账本不存在，都必须失败。
- 补这些测试，并把 `--assert-reviewed` 放在安装 opencode、自检、`prepareCopy` 之前（`main()` 里 `opencodeBinary()` 在 1385 行、`selfCheck` 在 1402 行）。

### 4. 中高：T3 把历史复核记录放回被复核的仓库，后续模型会读到

**问题**：复核脚本会克隆整个提交树给模型读。复核记录提交进 PR 后，下一次复核（尤其 T2 要求复核“记录提交”时）以及以后所有 PR 的复核，都能读到上一轮模型的结论、prompt 和方案材料。这会破坏“独立复核”，也可能让上一轮的错误/网页注入内容影响下一轮。

**证据**：
- `prepareCopy` 克隆整个提交树：`opencode-review.mjs:1270-1290`。
- `removeUnsafeProjectFiles` 只删 `.opencode/`、`opencode.json(c)`、`.env*`、指向副本外的符号链接：`opencode-review.mjs:1210-1233`。
- 读权限是 `read: { "*": "allow" }`：`opencode-review.mjs:96`。
- 方案第 69 行要求记录随 PR 提交。

**建议**：
- 在一次性副本里排除 `.agents/reviews`（和 `.opencode` 一样处理），或给模型加 deny 规则；`--assert-reviewed` 从原仓库/提交里的账本读，不依赖副本。
- 补自检探针：模型读 `.agents/reviews/<某 PR>/` 必须被拒绝或文件不存在。
- 不要把上一轮模型结论拼进 prompt/brief。

### 5. 中高：T5 不能只在 `MODE_TEXT` 加一句，现有 prompt 生成、保存、匹配都是“一轮一份”

**问题**：现在两个模型共用一份 prompt，`main()` 只生成一次，`roundForRun` 只比较一份 `prompt.md`。要按模型给不同侧重，必须改 prompt 生成、保存、重跑匹配和记录字段，方案低估了改动。

**证据**：
- `buildPrompt` 不接收模型，只按 `mode` 生成：`opencode-review.mjs:176-203`。
- `main()` 只生成一次：`opencode-review.mjs:1356-1361`；每轮只写一份 `roundDir/prompt.md`：`1424-1426`。
- `roundForRun` 只比较一个 `promptOnDisk`：`opencode-review.mjs:763-777`；`ROUND_PROMPT_MISMATCH` 的文档在 `model-review.md:75`。
- `reviewModel` 对两个模型传同一个 `prompt`：`opencode-review.mjs:1427-1438`。

**建议**：
- 改成 `buildPrompt({ mode, model })`：共享固定部分 + 每个模型的静态侧重句；保证侧重句在 `---- 本次材料 ----` 之前。
- 每轮保存 `prompt-<model>.md`（或 `prompt/<model>.md`），`roundForRun` 按模型比较；`usage.jsonl` 增加 `promptHash`。
- 调整 `keepEarlierAttempt` 的后缀、`PROMPT_TOO_LARGE` 检查和现有测试。
- 补测试：同一模型跨轮固定前缀逐字节相同；两个模型的 prompt 只在侧重句上不同；每个模型仍拿到全部必答问题。

### 6. 中：P2 的 GitHub 依据被误读，#248 也不是合并提交

**问题**：方案用“GitHub 也不区分合并提交”来论证“合并 main 的合并提交也算改动”。但 GitHub 文档说的是“**影响 diff** 的提交”会作废旧批准，另一个“most recent reviewable push”是**另一个可选设置**，不是同一件事。并且 #248 的最终提交 `bd0859a9` 只有一个父提交 `b4c620f9`，不是合并提交；它的问题是“合并 main 之后又改了规则文件”，不是“合并提交本身”。

**证据**：
- GitHub 原话：“when commits are pushed that affect the diff in the pull request”；“If the diff changes from this state ... the approving review is dismissed as stale”。
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- `git log --format='%H %P %s' -1 bd0859a9` 输出：`bd0859a9... b4c620f9... 安全检查：... (#248)`，只有一个父提交。
- 方案第 21、37 行把它当作“合并 main 产生的合并提交”的证据。

**建议**：
- 把规则直接写成“最后一轮复核之后产生的任何提交都算，包括合并提交和合并 main 后的手工改动”，不要用 GitHub 的“是否合并提交”来论证。
- 如果要对齐 GitHub，应校验 diff/merge base，而不是只校验 commit 哈希。
- #248 的证据改为“合并 main 后的规则文件改动”，不要再写“合并提交”。

### 7. 中：T3 的 key、仓库根和 `--out` 迁移没有设计完

**问题**：方案说 `--out` 不再由线程指定，但 T2 的 `--assert-reviewed` 仍用 `--out`；`parseArgs` 现在强制要求 `--out`，`--self-check-only` 的测试也传 `--out`。另外 `<仓库>` 没说是 `repoRoot` 还是 `--repo`；`--topic` 可任意取名，仍能通过“换一个 topic”重置账本，且纯数字 topic 可能和 PR 编号撞目录。

**证据**：
- `repoRoot` 是脚本相对路径：`opencode-review.mjs:80`；`--repo` 可以指向别处：`1308`。
- `parseArgs` 要求 `--out`：`opencode-review.mjs:1341-1343`；测试 `test/tooling/opencode-review.test.mjs:750-762` 用 `--out` 跑 `--self-check-only`。
- 方案第 58 行 `--assert-reviewed ... --out`；第 67 行又说 `--out` 不再由线程指定。

**建议**：
- 统一用 `reviewKey({ repo, pr, topic })`，目录用 `pr-<数字>` / `topic-<短名>` 加前缀，避免撞名；目录名正则建议 `^[a-z0-9][a-z0-9-]{0,63}$`，纯数字只允许 `--pr`。
- 用 `options.repo`，不要用脚本的 `repoRoot`。
- `--out` 只保留给 `--self-check-only` 或内部兼容；`--assert-reviewed` 和写结果用同一个 key。
- 方案阶段用 `--topic`、代码复核用 `--pr` 时，要说明两本账的关系；否则“同一个 PR 的所有轮次都在一个账本”并不成立，除非把 topic 账本在开 PR 后迁移/链接到 PR 目录。
- 测试要覆盖 `--pr`/`--topic` 二选一、两者都给、`../`、绝对路径、符号链接、纯数字 topic。

### 8. 中：T3 只保存 `.md` 和 `usage.jsonl`，会丢失败现场；账本也缺复核范围

**问题**：现在非 `ok` 的运行会保存 `<model>.stderr.txt`（`opencode-review.mjs:1461-1463`），方案第 68 行只列了 `prompt.md`、`<model>.md`、`usage.jsonl`。失败原因、opencode 报错和当时看的是 `base`/`previous` 都查不到，事后审计不完整。

**建议**：
- 保存 `<model>.stderr.txt`；在 `usage.jsonl` 或每轮 `review.json` 里记录 `base`、`previous`、`promptHash`、`models`、`stopReason`。
- 原始事件和 thinking 可以留在临时目录，但至少保留 tool call 的摘要和失败原因。

### 9. 中：T5 的真实对比不是“一轮的钱”，而且示例 PR 号不对

**问题**：要比较“同一提示词”和“各有侧重”两种写法，至少需要两轮（基线一轮 + 侧重一轮），因为交接文件 F3 已说明旧的复核记录没有保存。方案第 25 行说“花一轮的钱”，预算算少了；另外 I-73 的引入 PR 在事故记录里写的是 #207，不是方案里的“#213 之后 I-73 那次”。

**证据**：
- 方案第 25 行：“花一轮的钱”“例如 #213 之后 I-73 那次”。
- 交接文件第 98 行：仓库里没有 `usage.jsonl` 或复核结论文件，旧基线不可得。
- `docs/incidents-and-gates.md:112`（I-73）：“#207 让模型清单从 Magpie 动态获取……”。
- 方案第 25 行自己算的“一轮最多 0.4 美元，实际约 0.06 到 0.13”是**一轮**；两轮约 0.12–0.26（上限 0.8）。

**建议**：
- 明确要跑两轮：基线（同一提示词）和侧重各一轮；开跑前把 0.12–0.26 的实际预算报给 Andy。
- 先核对 I-73 对应的 PR 是 #207；如果要测“I-73 之后”的修复，另选 PR 并写明。
- 预注册指标：已知问题是否被提出、两模型意见重合数、各自独有意见数、误报数、花费；一轮只能当 smoke test，不能证明普遍更好。

### 10. 中：T5 的“各有侧重”与 Anthropic 做法不完全一致，可能降低冗余

**问题**：Anthropic 官方插件确实分了不同代理，但四个代理里 **有两个做同一件事（CLAUDE.md 合规）**，这是在高风险区域保留冗余；另外有置信度打分过滤。方案把两个模型分成互不重叠的侧重，且“侧重只决定先查什么”在提示词层面不可强制执行，可能让两边都漏掉对方侧重的区域。

**证据**：
- Anthropic README：“Agents #1 & #2: Audit for CLAUDE.md compliance”；“4 parallel agents”；“Each issue independently scored 0-100”；“Filters out issues below 80 confidence threshold”。
  https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/code-review/README.md （原文路径为 `plugins/code-review/README.md`）
- 方案第 79-83 行：DeepSeek 和 GLM 的侧重互不重叠，且“不限制能报什么”。

**建议**：
- 两个模型都保留全部必答问题和所有高风险类别；侧重只作为“额外必须回答的一节”，例如两个模型都必须回答“跨模块契约是否成立”，DeepSeek 再额外查错误路径/安全，GLM 再额外查测试/文档。
- 或者按 diff 动态分配侧重（改了合约就两边都查合约），不要固定按模型分。
- 置信度过滤可以不照搬，但至少让模型给每条意见附“证据强度”，线程分类时用。

### 11. 中：T2 与“连续三轮没过”的停止条件冲突

**问题**：规则第 32 行说连续三轮没过，第三轮的“会出错”意见可以先改，但“改完不再复核，直接停下报告 Andy”。T2 又要求合并前最后一轮复核必须覆盖当前提交。如果 Andy 在这种状态下说“合并”，线程要么违反“不再复核”，要么违反 T2。

**证据**：
- `.agents/instructions/model-review.md:32`：“连续三轮没过，第三轮的‘会出错’意见可以先改，但改完不再复核，直接停下报告 Andy……”。
- 方案第 57 行：合并前最后一轮复核的 `head` 必须等于当前提交。

**建议**：
- 在 T2 里写明例外：连续三轮停止后，只有在 Andy 明确说“合并”并且报告里记录“已改未复核”的提交和原因时，才允许合并；`--assert-reviewed` 要打印 `REVIEW_OVERRIDE` 之类，不能静默通过。
- 或者在那种状态下强制再跑一轮，但要改规则里“不再复核”的措辞。

### 12. 中：T6 没有自动检查，停止原因也不全

**问题**：方案自己承认 T6 是写作规范、没有自动检查；而且第 5 行只列了“没有会出错的意见”和“连续三轮没过”，漏了 Andy 裁定“这条不改”、费用/时间失败、模型非 `ok`、Andy 说合并等停止原因。第 4 行“最后一轮之后未复核的提交”也要说明记录提交是否算。

**证据**：
- 方案第 91-98 行。
- `model-review.md:32-33` 还有 Andy 裁定“这条不改”的例外。
- `REVIEW_RESULT` 的 `outcome` 可能是 `timeout`、`cost-limit`、`no-text` 等（`opencode-review.mjs:802-809`）。

**建议**：
- 增加脚本 `--report`，从 `usage.jsonl`/`review.json` 直接生成 T6 的固定几行，避免手抄。
- 记录 `stopReason`（不是只记 `outcome`），T6 列出所有停止原因。
- 加一个轻量测试：`--report` 必须输出 `REVIEW_RESULT`、`REVIEW_SPENT_TOTAL`、`--assert-reviewed` 结果和固定句；规则文件里的固定句也要有检查。仍没有 CI 的话，至少不要只靠人抄。

### 13. 中：`--assert-reviewed` 应读已提交账本，并在花钱步骤之前运行

**问题**：方案说读 `--out` 下的 `usage.jsonl`，那是工作区文件；线程可以在本地未提交的记录上通过检查，但合并进去的提交里没有这些记录，或者记录被改过。T3 的目的是事后可查，检查必须对“要合并的那棵树”生效。

**证据**：
- `readUsage` 直接读 `join(out, "usage.jsonl")`：`opencode-review.mjs:728-748`。
- `main()` 在 `readUsage` 之后才安装 opencode、自检、克隆（`opencode-review.mjs:1385-1409`）；方案没有说 assert 放在哪一步。
- T3 计划把账本提交进仓库（方案第 69 行）。

**建议**：
- `--assert-reviewed` 增加 `--at <提交>` 或默认从当前 HEAD 用 `git show <提交>:.agents/reviews/<key>/usage.jsonl` 读；至少要求该路径在工作区干净（`git status --porcelain -- .agents/reviews/<key>` 为空）。
- 放在 `opencodeBinary()`、`prepareCopy`、`selfCheck` 之前，保证“只读、不花钱、快速失败”。
- 账本只是线程可改的文本文件，真正的硬门槛要等 CI；CI 也不能只信工作区，要核对提交历史。

## 推测 / 未核实

- **T3 目录可能被 Biome 扫到**：`biome.json` 的 `includes` 是 `**`，只排除了 `.agents/tasks`；`.agents/reviews` 下的 `.jsonl`/`.md` 是否会被 `format:check` 或 `lint` 处理，我没有运行验证，**未核实**。建议显式加排除。
- **模型输出入库的网页注入风险**：方案讨论模式允许 `webfetch`/`websearch`，模型结论可能包含外部网页内容；`check:secrets` 只是按 `scripts/scan-machine-secrets.mjs:5-19` 的模式扫描，不是内容消毒器。风险不高（自己的线程、私有仓库），但“`check:secrets` 会扫描，所以不额外处理”这句话不足以证明安全。**推测**。
- **T5 的“两个模型意见容易重叠”**：交接文件 F6 自己标为“推测（没有数据）”。真实对比一轮也只能提供个案，不能证明一般结论。**推测**。
- **GitHub 对合并提交的精确行为**：文档说按 diff/merge base 作废旧批准，但没有在本地复现“只合并不改 diff 的合并提交”是否一定作废。**依据文档，未实测**。
- **T2 的“打印差了哪些提交”**：方案没有设计输出格式和“当前提交不是被复核提交后代”的情况；**未核实**实现方式。

## 如果由我来定，我会怎样改这份方案

1. **先定 T3 的记录格式，再定 T2 的检查**，两项一起做，不拆开。
   - 每轮目录：`usage.jsonl`、`review.json`（PR/topic、head、base、previous、mode、models、promptHash、stopReason）、`prompt-<model>.md`、`<model>.md`、失败时的 `<model>.stderr.txt`；原始事件和 thinking 留在临时目录。
   - key 用 `pr-<数字>` 或 `topic-<slug>`，使用 `--repo` 根目录；纯数字只允许 `--pr`；校验 `../`、绝对路径、符号链接。
   - 把 `.agents/reviews` 从复核副本和模型可读范围里排除；`--assert-reviewed` 从原仓库的提交里读账本。
2. **T2 改成“复核收据”而不是只比 head**。
   - 记录 `head`、`base`、`previous`、`promptHash`。
   - 通过条件：最后一个完整代码复核轮的两个模型都是 `ok`，且满足以下之一：当前提交等于被复核提交；或 `current..reviewed` 的 diff 只在 `.agents/reviews/<本 PR>/` 下。
   - 另外检查 `previous` 是祖先、`base` 没有变化；变了就要求重新复核或明确记录 override。
   - 失败时打印 `REVIEW_NOT_CURRENT`、缺失的提交、缺失的模型、当前/记录的 `head`/`base`。
3. **T5 用“共享底线 + 额外侧重”**。
   - 两个模型都保留全部必答问题和全部高风险类别；侧重作为额外必答小节。
   - `buildPrompt({mode, model})`，每轮保存每个模型的 prompt；补单元测试和假服务器请求测试。
   - 真实对比至少两轮（基线 + 侧重），先核对 I-73 对应 PR 是 #207，预注册指标和预算，再请 Andy 批。
4. **T6 用脚本生成汇报**。
   - `--report` 从 `review.json`/`usage.jsonl` 生成固定行，不靠手抄；停止原因用 `stopReason` 枚举，覆盖 Andy 裁定“不改”、费用/时间失败、模型非 `ok`、连续三轮停止。
5. **测试统一放进 `test/tooling/opencode-review.test.mjs`**，每条反向用例都要有“改前失败、改后通过”的记录；T5 的付费对比不算自动门槛，只是验收实验。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

- **T2、T3、T6 不会改发给模型的字节**：它们只加校验、记录、汇报，不碰 `buildPrompt`。T3 保存 `prompt.md` 也不会改变实际发出的 prompt。
- **T5 会改固定开头**：它把每个模型的侧重句放进固定部分。复核脚本每次运行都是新会话（`runOpencode` 只有追问一步带 `--session`，`opencode-review.mjs:478-491`；前提 P13），没有“已经发过的历史”被改写。真正每轮变化的 `head`、`base`、`previous`、`brief` 已经全部在 `buildPrompt` 的“本次材料”段，也就是最后一条用户消息（`opencode-review.mjs:190-202`）。
- 因此结论是：**只要 T5 的侧重句放在 `---- 本次材料 ----` 之前、并且按模型固定，发给模型的内容仍然只在末尾追加，每轮变化的值都在最后一条消息里。** 依据 `.claude/rules/prompt-prefix.md:16-19`；OpenAI 提示缓存文档也要求“Put stable developer instructions and shared reference material first”“Append new messages rather than rewriting earlier turns”：
  https://developers.openai.com/api/docs/guides/prompt-caching
- 唯一要注意的是：T5 上线会让两个模型原有的固定前缀各失效一次，之后稳定；这不是“改历史”，但部署时会有一次缓存未命中。方案应写明。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- **不会因为前后文或时间字段而变**：复核脚本没有遮盖逻辑，所以不涉及“依赖前后文的遮盖”；`head`/`base`/`previous` 都是 `resolveCommits` 解析出的完整哈希，确定；`usage.jsonl` 里的 `at` 时间和 `cost` 不是发给模型的输入。
- **T5 是“不同模型收到不同 prompt”，不是“同一段文字因上下文变成不同字节”**：DeepSeek 和 GLM 各有一份固定的侧重句，这属于设计上的不同请求；同一个模型跨轮应保持相同固定前缀。
- **但 T3 必须按模型保存 prompt**：如果按方案只保存一份 `prompt.md`，它既不是 DeepSeek 实际收到的字节，也不是 GLM 实际收到的字节，事后无法逐字节核对。建议改成 `prompt-<model>.md`，并在 `review.json` 里记 `promptHash`。
- 另外，`--topic`/`--pr` 的路径值不要拼进 prompt；目前 `buildPrompt` 也没有拼路径，保持即可。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- **T2**：方案列了正反用例，但不够。需要补：缺一个模型、只有更早轮次完整、同一轮先失败后重跑成功、`previous` 不是祖先、`base` 变化、记录提交例外、账本不存在/损坏。按项目惯例，每条反向用例都要在改动前运行并失败，改动后通过；只写测试不算门槛。
- **T3**：方案列了 `--pr`/`--topic` 二选一、目录名、同一 PR 第二轮读费用，但漏了：`--self-check-only` 不再要求 `--out`、`--repo` 指向别的仓库、`../`/绝对路径/符号链接、纯数字 topic 撞 PR、计划阶段 topic 和 PR 账本的关系、`.agents/reviews` 不被模型读到、失败时保存 stderr。现有测试 `test/tooling/opencode-review.test.mjs:750-762` 还传 `--out`，改 `--out` 删除后会直接失败，正好可以用来验证迁移覆盖。
- **T5**：**没有自动检查**，只有一次付费对比。这不满足“改动有没有对应的自动检查”。至少要增加：`buildPrompt({mode, model})` 的单元测试（两个模型侧重不同、固定前缀跨轮一致、都包含全部必答问题）；假服务器集成测试捕获两个请求，断言除侧重句外材料相同。付费对比只能算验收实验，不能算回归门槛。
- **T6**：**没有自动检查**，方案也承认。建议至少让 `--report` 生成固定行并加测试；否则 T6 只是写作规范，无法证明下一个 PR 真的照写。
- 最后要确认这些测试确实进入项目门槛（`test/tooling/opencode-review.test.mjs`，以及 `npm run check`/`test:tooling` 的入口），而不是只放在某个不跑的目录里。
