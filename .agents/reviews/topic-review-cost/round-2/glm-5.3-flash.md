我先看仓库结构和方案里引用的关键文件。
现在读脚本的关键部分。
git 替身挡了复核记录路径，账本无法在本地核实。再看 AGENTS.md 的大改动规则和模型侧重测试。
最后取一条一手来源，核对「过滤低价值复核意见」的业界做法。
# 审核结论

## 侧重检查（先列，按你的额外侧重要求）

**走过的最普通流程**（代码复核，从入口到结束）：

1. `parseArgs` → 取 `--head/--base/--previous/--models`（opencode-review.mjs:1633-1739，`options.models` 默认就是 `REVIEW_MODELS` 两个，:1638）
2. `resolveCommits` → `reviewQuestions`（从 `--base` 提交读必答问题，:1529-1534）
3. `buildPrompt`（:193-222，固定段+侧重+材料）
4. `budgetCheck`（:764-772）
5. `roundForRun`（:1004-1046）
6. `prepareCopy`（:1558-1581，sparse-checkout 把 `.agents/reviews/` 从模型能读的范围拿掉）
7. `selfCheck`（:1343-1410，硬编码对 `REVIEW_MODELS` 两个模型各跑一遍，:1361）
8. 两个模型并行跑 → 各自 `usage.jsonl` 入账（:1862-1879）
9. 提交记录目录 → `--assert-reviewed`（:812-886，`lastCompleteRound` 要求**两个**模型都 ok，:784-798）→ `--report`（:896-922）

**新改动未在任何测试（`test/tooling/opencode-review.test.mjs`，98 例）覆盖、方案也没列的路径**：单模型收尾轮次下的 `--report --stop no-error`；单模型轮的 `--round` 重跑提示词一致性；`--accept-low` 的参数白名单（普通复核里给 `--accept-low` 是否拒绝）；`--accept-low` 记录之后再跑 `--assert-reviewed` 的幂等行为；plan/plan-review 模式 + 单模型是否被“必须两模型”的新规则误伤。

**事实核对**：P1-P4、P9、P10、P11 及引用的行号全部核实无误（`REVIEW_MODELS` 在 74b80d55 的 :24、`lastCompleteRound` 在 :784、`--session` 仅追问步在 :531）。P5-P8（PR #255 的 `usage.jsonl`、`judgments.md`）**未核实**：本检出没有 `.agents/reviews/` 目录，且 git 替身按设计拒绝读取该路径（实测返回 `REVIEW_Git_REFUSED records-path .agents/reviews`），我无法核对账本和判断文件；P6 的单价拆分也没有独立来源核对。

---

## 问题清单（严重度从高到低）

### 证实的问题

**[高] 1. 改法二的核心测试写不出来：「有中、高意见时 `--accept-low` 拒绝放行」没有任何数据来源可核对。**
证据：账本每行的字段是 `at/cost/round/mode/model/head/outcome/…`（opencode-review.mjs:1862-1879），`parseUsage` 的校验也只认这些（:943-987）；意见及其严重度只存在于线程自己写的 `judgments.md`（自由文本，方案只要求“已提交”）。脚本拿不到“这轮有没有中、高意见”这个事实，这条反向用例无从写起——这正是 I-73 式的两端缺失（docs/incidents-and-gates.md:112）。方案的全部防线（“判低必须写依据”、Andy 抽查）都是纸面上的，机器层面 `--accept-low <轮次>` 无条件放行。
建议：把每轮意见结构化（如 `round-<n>/verdicts.json`：意见 id、来源模型、成不成立/类别、严重度、触发方式和后果各一句，注意 JSONL 单行、无控制字符、键序固定的既有约束，:926-987）。`--accept-low` 核对：所指轮次的 verdicts 里没有中/高、每条低都有依据字段；叙述性的 `judgments.md` 作附件留在目录里。

**[高] 2. `--report` 没跟着改，改法一落地后普通流程必断。**
证据：opencode-review.mjs:905 `const latestComplete = lastCompleteRound(records)?.round === latest && latest > 0;`，`no-error` 要求 `latestComplete` 且门检通过（:907-913）；model-review.md:38 写死 `no-error` “要求最后一轮两个模型都 ok”。改法一只改“合并前检查”（方案 :65），第 7 步汇报必抛 `REPORT_STOP_INCONSISTENT`。方案的测试清单（改法一 :67-71）对此只字未提。
建议：方案补上 `reviewReport` 的台词：`no-error`/`run-failed` 的判定改成“最后一轮要么双模型全 ok、要么 DeepSeek ok（改法一）、要么链上有被接受的低严重度记录”，并配反向用例（旧账本、双账本各一）。

**[高] 3. `--accept-low` 的记录形态完全没定义，与现状机制多处撞车（必答问题 4 的典型）。**
证据（均可核实）：`assertReviewed` 找已有例外的方式是扫全部 `mode==="override"` 的记录并打印 `REVIEW_OVERRIDE quote=…`（:852-864）——若 accept-low 复用 `override` 这个 mode，之前 Andy 原话的例外记录会被 accept-low 记录冒名顶替；`parseUsage` 的 mode 白名单只有三种模式 + `override`（:957-958）；记录必须带 40/64 位提交哈希（:964-967）；`nextRound` 只排除 `override`（:999）；`ASSERT_OPTIONS` 白名单（:1617-1623）要加项；普通复核里给 `--accept-unreviewed` 有 `ARG_ACCEPT_UNREVIEWED_ONLY_WITH_ASSERT` 拦截（:1717-1718），`--accept-low` 需要同样的拦截，方案没提。
建议：给 accept-low 单独的记录类型（独立 mode 值或 override 内的 `kind` 字段），列出它的每一个生产点和消费点（parseUsage、assertReviewed 的 recorded 查找、reviewRounds 计数、nextRound、budgetCheck、docs 第 36-37 段文案），每处写一条反例测试。

**[中] 4. 必答问题 1/文档一致性：给 DeepSeek 补侧重的方式与现行声明矛盾，也白白丢缓存。**
证据：model-review.md:61 声明“侧重写在『本次材料』之前、同一个模型每轮都一样，所以每个模型发出的内容仍然只在末尾追加”；方案 ：66 让 DeepSeek 的侧重随“是否传 `--previous`”变化 → “每轮都一样”不再成立，文档不更新就是他们自己规则里的“会出错”类（P2）。另外 P6 的 GLM `cacheRead=0.205/0.355` 说明虽然每次运行是新会话，服务方侧的跨运行前缀缓存收益是真实存在的（模型请求前缀里 LENS 在材料之前，:198-221）；条件化固定段会让 DeepSeek 第 1 轮的缓存对第 2 轮起失效，恰恰和省钱目标相反。现有测试 `gives each model its own focus`（opencode-review.test.19:219-249）没有覆盖 previous/无 previous 两种取值。
建议：把“规则文件、说明和代码是否一致”直接写进 `MODEL_LENSES` 的 DeepSeek 常量（所有轮次、所有侧重模式统一），固定前缀逐字节不变；model-review.md:61 同步改写；补测试“同一模型有无 previous 的提示，固定段逐字节相同”。

**[中] 5. 「不传 `--previous` 必须两模型」没有限定到 code-review 模式。**
证据：`--models` 是三种模式共用参数（model-review.md:102“三种模式都可以加 `--models`”，测试 ：157 也确认 plan 模式的独立形态）；方案 :64 的规则若按字面实现，会禁止方案讨论阶段用 `--models` 只跑一个模型（交接文件 P14 显示实际有人这么用）。plan 模式按定义永远没有 `--previous`。
建议：限定“只给一个就报错”到 `--mode code-review`；plan/plan-review 保持现状，并在测试里写明这个区分的反向用例。

**[中] 6. 合并前检查的新语义本身不完备：没有定义 accept-low 记录和复核轮如何串联成“链”。**
证据：现状的 gate 只认 `lastCompleteRound().head` 一点（:813-825）。方案 ：65 说“存在一轮双模型完整复核；在那之后每一轮 DeepSeek ok”，:80 说 gate 认 accept-low 记录的条件——但两段拼起来回答不了：全低轮的修改（发生在该轮记录之后）由哪条记录覆盖？链中出现“全低轮→修改→DeepSeek轮→修改→又全低轮”时怎么走？accept-low 记录之后重复跑 `--assert-reviewed` 打印什么、退出码多少（现状对 override 有对应分支 ：852-876，方案缺对称物）？
建议：把 gate 写成显式状态机：最完整双模型轮之后，每个“改动覆盖点”要么是 DeepSeek ok 的复核轮，要么是“全低轮 | accept-low 记录（记录时 head 即覆盖点）”；最后一个覆盖点之后只许改记录目录；逐条配测试（含“两个 accept-low 中夹一复核轮”的正反例）。

### 推测或设计取舍类（不是代码层面的硬伤）

**[中] 7（推测，基于账本数字成立的前提）. 放行低严重度的机制在和“省钱动机”直接利益冲突的位置没有制衡强度。**
若 P5-P8 的数字属实，跳一轮省约 0.07-0.13 美元；判断全部由要省钱的当事线程做、无第二模型背书（model-review.md:24 现行“分类由线程做”被沿用）。业界一手来源（Anthropic 官方 code-review 插件 README，https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/README.md：“Scores each issue 0-100 for confidence level; Filters out issues below 80 confidence threshold”）里，低价值意见是在复核侧由打分过滤的——过滤发生在“复核者”手上，而不是由申请跳过复审的当事方事后给“已承认成立的”问题免审。方案是反向的：意见先被承认成立，再免审修改。
建议（不动成本）：最低配 = `--report` 把低放行条目单独成节、每 PR 低放行超过 N 条先问 Andy；更好的 = 让该轮模型在输出里给每条意见的触发条件和后果各写一句（输出格式本来要求“按严重度排列”，:154-155），线程的“低”必须引用模型的严重度或说明为何降级——分歧点就有据可查，抽查也有抓手。

**[低] 8（推测成本）. 预计效果没算两个修正项。** DeepSeek 第 2 轮起加了文档一致性侧重，每轮会多读规则文件，单价略升；“改法一+二 0.25-0.35”依赖“第 3 轮左右收尾”的假设，只有 P8 一个 PR 的样本。建议在方案里标注置信度，跑两个 PR 后回填实测。

**[低] 9. 反例兜底仍靠“线程写测试并运行”，而复核模型不运行代码（P2 同款局限）。** 改法二把低意见的修改放在完全无模型复审的路径上，兜底只有测试；建议 accept-low 的条件里加一条“该轮之后新增的提交里有对应的测试改动”（脚本可以核对 `changedOutside` 清单里含 test 文件），至少让“补了测试”从口号变成可核对项。

**[低] 10. 命名/语义小问题：** “中、高”合并成一档却用两个名字（:78），模型输出本身就有严重度一列，直接叫“低/非低”；`--accept-low` 与 `--accept-unreviewed` 同时传入的行为没定义；`OVERRIDE_MIN_ROUNDS=3`（opencode-review.mjs:804）在改法二会让很多 PR 只剩 1-2 轮，Andy 真要走例外时被 `rounds=n needs=3` 拒得更频繁，方案没讨论这个交互。

---

## 如果由我来定

1. **先补数据结构再动流程**：第 0 步是让每轮意见落成机器可读的 verdicts（结构化、单行、键序固定）。没有它，改法二的脚本、测试、防滥用机制全都虚设。
2. **改法一保留，DeepSeek 侧重常量化**（所有轮次一致），保证请求前缀逐字节稳定、文档声明和缓存两端都不破（问题 4）。
3. **`--models` 新规则只限 code-review**；plan 保持单模型可用（问题 5）。
4. **合并前检查写成显式状态机**（双模型轮 → 交替的 DeepSeek ok 轮 / accept-low 覆盖点 → 之后只许改记录目录），`reviewReport` 的 stop 语义同步改，补全全部反例（问题 1-3、6）。
5. **防滥用用真实制衡代替口头承诺**：`--report` 单列低放行条目；单 PR 低放行超过 5 条（或建议值先定）先问 Andy；线程的“低”必须对照模型给出的严重度（问题 7）。

### 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 会话层面不会：每次复核都是新会话（:531 证实只有追问步续用会话），改提示词只对新会话生效（prompt-prefix.md:43），本轮所有改动都不触碰任一正在进行的对话的历史。但注意两处：(a) 请求**头部**（固定段）里按 `--previous` 条件化 LENS 会破坏“同一模型每轮都一样”的声明并丢跨运行缓存收益，建议常量化（高优先修正项，见问题 4）；(b) `weightings`/账本变化不发进模型，遮盖机制不受影响。结论：可以做到“仍只在末尾追加、每轮会变的值都在材料段”，但方案原文的写法会把会变的值（lens 有无）放进头部，要改。
2. **同一段文字会不会在不同请求里变成不同字节？** 发给模型的内容不会：新增的都是固定字符串，材料段里的提交哈希本轮内是常量。账本/verdicts 文件里会有时间戳（现状 `override` 记录已如此，:872，可接受），但给 verdicts 定 schema 时要遵守既有单行、无控制字符、键序固定的约束。
3. **有没有对应的自动检查、反向用例真的会失败吗？** 现状下：改法一的 gate 测试方向对但少了 `--report` 一侧和 plan 模式误伤；改法二列的五条测试里，**第一条现在根本写不出来**（问题 1），必须先做 verdicts 结构化。方案自称“每条都做反向验证”，在我核对的层面对约 40% 的条目不成立。
4. **每个新值的产生/使用两端核对过了吗？** 没有——这正是方案最大的缺口（问题 1、3、6）：`--accept-low`、它的记录 type、verdicts 字段，每一个新值的消费点（parseUsage、assertReviewed 的 recorded 分支、reviewRounds、nextRound、reviewReport、docs 第 36-38 段）方案一个都没列，正是 I-73 那类只看改动不看两端的做法。
