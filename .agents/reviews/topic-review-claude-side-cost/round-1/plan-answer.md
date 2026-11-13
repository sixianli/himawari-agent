# 复核流程瘦身方案

> 说明：我只做了只读检查，没有修改文件，也没有运行测试。下文行号对应当前检出的提交 `155732a3`。材料里给出的费用、token、步数统计我没有独立复算，标为「材料提供」。

## 一、方案依赖的前提

| # | 前提 | 来源 | 原话 / 证据 |
|---|---|---|---|
| P1 | 每一次模型复核是一个新会话，提示词每轮只组装一次，不存在跨轮复用同一段会话历史 | `scripts/model-review/opencode-review.mjs:346-376`、`:3230`、`:3340-3356`；`.agents/instructions/model-review.md:104` | 代码：`const prompts = Object.fromEntries(options.models.map((model) => [model, buildPrompt(...)]))`；文档原话：“侧重写在‘本次材料’之前、同一个模型每轮都一样，所以每个模型发出的内容仍然只在末尾追加” |
| P2 | 复核提示词的固定部分在 `---- 本次材料 ----` 之前，材料在最后 | `scripts/model-review/opencode-review.mjs:351-375`；`test/tooling/opencode-review.test.mjs:162-187` | 代码把 `fixed` 与 `material` 拼接；测试断言两次不同材料的 `second.slice(0, fixedEnd)` 完全相同 |
| P3 | 增量轮现在明确允许“读任何文件” | `scripts/model-review/opencode-review.mjs:367-368` | 原话：`上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。` |
| P4 | 合并门的“一轮算数”按账本里模型的 `outcome: ok` 判断，不按 `verdicts.jsonl` 判断；`verdicts` 只在 `low-fix` 路径参与判定 | `opencode-review.mjs:1273-1341`、`:1439-1510`；`.agents/instructions/model-review.md:68` | 文档原话：“一轮算数的条件：这一轮要跑的模型……每个都有 `ok` 的结果或有替补它的 `ok` 结果” |
| P5 | `low-fix` 要求每条成立的低严重度意见都有 `verdicts.jsonl`，且 `quote` 必须逐字出现在模型答案里 | `opencode-review.mjs:1171-1270`、`:1557-1599`；`.agents/instructions/model-review.md:61` | 代码：`if (!answers.get(verdict.model)?.includes(verdict.quote)) problems.push("quote-not-found ...")` |
| P6 | `--report` 从当前提交里的账本生成，不重新调用模型 | `opencode-review.mjs:1636-1695`；`.agents/instructions/model-review.md:71` | 代码：`const shown = gitStatus(["show", \`HEAD:${ledgerPath}/usage.jsonl\`], repo)` |
| P7 | 默认只跑 DeepSeek，模型清单在配置文件里 | `scripts/model-review/review-models.json:1-7`；`.agents/instructions/model-review.md:4` | 配置：`"default": ["opencode-go/deepseek-v4.1-flash"]` |
| P8 | 子代理适合把探索和判断放进独立上下文，只把结论带回主线程 | https://docs.claude.com/en/docs/claude-code/sub-agents | 原话：“Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions.”；“the subagent does that work in its own context and returns only the summary.” |
| P9 | KV 缓存只认逐字节前缀，缓存读取远便宜于全价输入 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching ；`.claude/rules/prompt-prefix.md:6,35,51` | 官方原话：“Prompt caching covers the full prefix: `tools`, `system`, and `messages` (in that order)...”；规则原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”“同样的内容，每次都要序列化成同样的字节” |
| P10 | 只看改动本身、不核对每个值的产生处和使用处，会漏掉事故 | `docs/incidents-and-gates.md:112`（I-73） | 原话：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” |
| P11 | 线程每次机械步骤约 25–40 次工具调用、上下文 15–30 万 token，整线程 39–86 美元 | 本次材料 | 材料提供，未独立复算 |
| P12 | I-98“线程反复传错 `--previous`，已有开跑前检查” | 本次材料 | 我在当前检出的 `docs/incidents-and-gates.md` 里没有找到 I-98 这一行；**未核实** |

---

## 二、方案本身

核心思路：**把“做判断、读代码、改代码、写 verdicts/judgments”放进一个全新的小上下文子代理；主线程只负责预算、启动、最后跑合并门和 `--report`。** 机械动作由 `opencode-review.mjs` 新增的两个子命令完成，不新增任何绕过合并门的路径。

### 1. 复核段交给子代理，主线程只拿结论

**新增文件**

- `.claude/agents/code-review-round.md`
  - frontmatter：`name: code-review-round`、`description` 写明“合并前复核的逐条判断与修改”、`tools: Read, Grep, Glob, Edit, Write, Bash`、`model: inherit`、`omitClaudeMd: true`（若当前 Claude Code 版本不支持，退回在任务说明里附流程卡）。
  - 系统提示只写：先读 `.agents/instructions/model-review-card.md`；只准用 `opencode-review.mjs` 跑模型；只准改本 PR 相关文件；不合并、不推送、不使用 `--accept-unreviewed`；遇到 Andy 才能决定的事返回 `NEEDS_ANDY`。
  - 返回固定结构：`REVIEW_SUMMARY`、`REVIEW_FIXES`、`REVIEW_GATE`、`REVIEW_REPORT`、`NEEDS_ANDY`。主线程不接收模型答案全文、逐条代码摘录和 judgments 正文。

- `.agents/instructions/model-review-card.md`
  - 一页流程卡，目标 ≤ 12 KB，只写：一轮的 6 步、命令、判类表、阈值、什么时候读全文的哪个锚点、报告/合并门怎么跑。
  - 大文件按需查：卡片里给锚点，例如 `.agents/instructions/model-review.md#code-review`、`#owner-control`、`docs/incidents-and-gates.md#incidents`、`docs/lessons.md#trust-reported-checks`，并明确“只有卡片点名的锚点才读全文，不整份读 8 万/18 万/15 万字节的文件”。

**修改文件**

- `AGENTS.md:52,55`：把“见 `.agents/instructions/model-review.md`”改成“先读 `.agents/instructions/model-review-card.md`；只有卡片指向的锚点才读全文”。同时改掉第 52 行“低的照样修改、补测试”，改成“第 3 轮起低的只列不修”。
- `.agents/instructions/model-review.md:46`：在“合并之前：代码复核”开头加一句“先读流程卡；完整规则只在卡片点名的锚点里查”。不删除完整规则。
- `package.json`：新增 `check:model-review-workflow`，加入 `check:steps`。

**主线程与合并门/报告**

- 主线程只做：跑复核模型命令、把 round 号/预算/分支交给子代理、子代理结束后**自己再跑一次** `--assert-reviewed` 和 `--report`。这样即使子代理自报“通过”，最终判定仍由主线程按账本重新算，符合 `docs/lessons.md:173-198` 的教训。
- 合并门本身不改：`--assert-reviewed` 仍只看账本和提交链。

**风险**

- 子代理有 `Bash`，理论上能推送/合并；靠系统提示约束，和现有“防误操作不防有意”同一取舍。若要更硬，可用 `isolation: worktree`，但会增加主线程合并步骤。
- 子代理不再拥有主线程的跨轮记忆；跨轮信息必须写进任务说明或账本。反例：子代理忘了上一轮已判定“不成立”的意见，重复报告。缓解：任务说明附上一轮 `verdicts.jsonl` 的 id/结论摘要，不附全文。

---

### 2. 机械步骤交给一条命令：`--prepare-round` / `--finish-round`

在 `opencode-review.mjs` 里新增两个子命令，复用现有 `parseVerdicts`、`lowFixProblems`、`assertReviewed`、`reviewReport`，不新增账本模式。

#### `--prepare-round <轮次>`

作用：从已提交的本轮模型答案里提取候选意见，生成紧凑工作包；不调用模型、不写账本。

新增参数：

```bash
node scripts/model-review/opencode-review.mjs --prepare-round 3 --pr 42 \
  [--context-lines 20] [--packet-out <路径>]
```

行为：

1. 从 `HEAD` 读 `.agents/reviews/pr-42/usage.jsonl`，确认该轮存在且有 `outcome: ok` 的记录；没有则报 `PREPARE_ROUND_NOT_REVIEWED`。
2. 从 `HEAD` 读该轮每个模型的 `<模型>.md`，用容错解析器按“严重度 + `文件:行`”切候选意见；每条生成稳定 id `F1`、`F2`…（按答案出现顺序），并只取答案里**逐字存在、单行**的片段作为 `quote`。
3. 对每条意见引用的文件，从**该轮复核的 `head` 提交**读代码，截取 `--context-lines` 行；再附上该文件在 `base..head` 或 `previous..head` 里的 diff hunk（用 `git diff --numstat -z` 和固定格式，不依赖终端宽度）。
4. 输出到临时目录（不进仓库，避免被 `delegate.mjs check` 当成非法记录）：
   - `packet.md`：每条意见的 id、model、模型给的严重度、位置、quote、代码上下文、diff；
   - `verdicts.todo.jsonl`：只预填 `id`、`model`、`quote`；
   - `judgments.todo.md`：逐条待填写的骨架。
5. 解析不了的块不丢弃，列进 `packet.md` 的“未解析块”并打印 `REVIEW_PACKET_PARTIAL unparsed=<n>`；子代理必须对这部分读原答案。

#### `--finish-round <轮次>`

作用：把子代理填好的紧凑决策文件变成最终 `verdicts.jsonl`、`judgments.md`，按现有规则判断能否 `low-fix`，只提交记录目录，然后跑合并门和报告。

新增参数：

```bash
node scripts/model-review/opencode-review.mjs --finish-round 3 --pr 42 \
  --decisions <决策文件> [--judgments <judgments.md>] \
  [--accept-low] [--commit] [--message "<提交说明>"] \
  [--stop no-error|three-rounds|andy-decision|run-failed] \
  [--andy-quote "<原话>"] [--main-ref origin/main]
```

决策文件用 TSV，列为：

```text
id  valid  class  severity  trigger  consequence  modelSeverity  reason  evidence  judgment
```

`id` 必须来自 `packet.md`；`quote` 不再手抄，由脚本从 packet 注入。`--finish-round`：

1. 校验 id 存在且不重复、字段合法、`quote` 仍是模型答案的逐字子串（复用 `parseVerdicts` 和 `lowFixProblems` 的同一套检查）。
2. 生成最终 `round-N/verdicts.jsonl` 和 `round-N/judgments.md`。除 `quote` 外，文本字段走现有 `maskedRecordText`，防止 I-86 类密钥误报。
3. 若给 `--accept-low`，调用现有 `assertReviewed({ acceptLow })`；只有现有条件全过才追加 `low-fix` 账本，否则打印 `REVIEW_LOW_FIX_REFUSED`。
4. 若给 `--commit`：
   - 先检查记录目录之外没有未提交改动；有则拒绝 `REVIEW_FINISH_DIRTY <文件...>`，不提交；
   - 只 `git add -- .agents/reviews/pr-N` 并提交，提交说明用 `--message` 或固定默认；
   - 绝不 commit 代码修复；代码修复必须由子代理先单独提交。
5. 提交后重新调用 `assertReviewed`；通过且给了 `--stop` 时再调用 `reviewReport`。
6. 退出码：校验失败 5；合并门不过 5；通过 0。

**合并门为什么没有被削弱**

- `--finish-round` 不写任何 `code-review` 的 `ok` 记录；它只能通过现有 `assertReviewed` 追加 `low-fix`。
- `low-fix` 仍要求：最后一点是当前轮、`verdicts` 已提交、quote 逐字存在、成立错误全为 `low`、改动规模/测试文件符合现有上限。
- 主线程最后仍自己跑 `--assert-reviewed`，子代理自报不算数。

**测试**

新增 `test/tooling/opencode-review-workflow.test.mjs`：

- `--prepare-round`：两条意见的答案 → packet 含 `F1/F2`、quote 均为答案子串、代码上下文来自复核 head；同一输入两次输出逐字节相同。
- 反向：答案里一条意见没有 `文件:行` → 必须进“未解析块”并打印 `REVIEW_PACKET_PARTIAL`；若解析器静默丢掉，用例失败。
- `--finish-round`：合法决策 → 生成 `verdicts.jsonl` 能过 `parseVerdicts`，`--commit` 只提交记录目录，合并门 `REVIEW_CURRENT`。
- 反向：缺 `valid`、`id` 不在 packet、quote 不在答案、重复 id、`--commit` 时有记录目录外的未提交文件、`low-fix` 超 5 文件/30 行/无测试文件、同一轮第二条 `low-fix`，都必须拒绝且不写账本。
- 反向：只有失败模型记录的仓库跑 `--finish-round`，必须 `REVIEW_NOT_CURRENT`，且账本里不能出现新的 `ok`。

---

### 3. 一页流程卡，大文件按需查

已并入第 1 项。额外检查：

- 新增 `scripts/check-model-review-workflow.mjs` 或在现有 `scripts/check-instruction-links.mjs` 里加一项：
  - 卡片存在且不超过配置上限；
  - 必须包含 `--assert-reviewed`、`--report`、`--accept-low`、`--prepare-round`、`--finish-round` 和“不合并”“不用 `--accept-unreviewed`”；
  - 卡片里的 Markdown 链接和锚点都能解析（复用现有链接检查）。
- 反向用例：删掉卡片里的 `--assert-reviewed`、把卡片扩到超过上限、把某个锚点改成不存在的 `#foo`，检查必须失败。
- 风险：卡片和完整规则会漂移。缓解：卡片只写流程和命令，判类细节仍链接到全文；检查脚本只锁命令和锚点，不复制规则正文。

---

### 4. 增量轮只查增量；第 3 轮起低意见只列不修

#### 4.1 增量轮只看增量

修改 `buildPrompt` 的材料段（仍在最后一条消息里）：

```text
上一轮复核到 <previous>。本轮只核对 <previous>..<head> 的增量及其直接影响：
先读下面列出的改动文件，只打开改动 hunk、调用点和相关测试；不要整份读大文件，
不要重复查上一轮已确认的代码；没读到的地方标「未核实」。
```

并增加一个由脚本计算的确定性摘要：

- 用 `git diff --numstat -z <previous> <head>` 取改动文件，按路径排序；
- 在材料里列出“文件 / 增删行数”，超过配置上限时只列数量并让模型自己跑 `git diff --stat`；
- 不把 `git diff` 全文塞进提示词，避免提示词过大。

新增参数/配置：

- `review-models.json` 增加 `policy.incrementalMaxFiles`、`policy.packetContextLines` 等；或这些作为 CLI 参数 `--incremental-max-files`、`--context-lines`。建议放配置，避免写死。

测试：

- `opencode-review.test.mjs` 增加：有 `--previous` 时固定前缀与无 `--previous` 时逐字节相同；材料里出现“只核对增量”且**不出现**“可以读任何文件”；改动文件列表排序稳定；同一 previous/head 两次 buildPrompt 输出相同。
- 反向：把旧句“可以读任何文件”改回去，测试必须失败；把文件列表顺序打乱，测试必须失败。

#### 4.2 第 3 轮起低意见只列不修

**规则改动**

- `.agents/instructions/model-review.md:59-61` 和 `AGENTS.md:52`：明确“第 3 轮及以后，`valid:true,class:error,severity:low` 的意见照常写入 `verdicts.jsonl`/`judgments.md`，但不修改、不补测试、不跑 `--accept-low`；在报告里逐条列出。”
- 仍然要求：中、高严重度必须修；`low-fix` 只在第 1、2 轮或 Andy 明确要求时使用。

**报告改动**

在 `reviewReport` 里新增只读 section：

```text
低严重度“会出错”，第 3 轮起仅列出、未修：
REVIEW_LOW_DEFER round=3 id=F4 model=deepseek-v4.1-flash fixed=no <quote>
```

实现：

- 从账本取 `round >= policy.lowDeferFromRound` 的 `code-review` 记录；
- 从每条记录自己的 `head` 提交读 `round-N/verdicts.jsonl`，筛 `valid && class === "error" && severity === "low"`；
- 按 `round`、文件内顺序输出；若该 id 已被同轮 `low-fix.findings` 覆盖，标 `fixed=yes`；
- `verdicts.jsonl` 缺失时打印 `REVIEW_LOW_DEFER_UNREADABLE round=N`，不让报告崩。

**合并门改动：无。** 现有门本来就不要求低严重度必须修；`low-defer` 不需要新账本模式，避免改 `parseUsage`、`coveragePoints`、`delegate.mjs`。

**配置**

`review-models.json` 增加：

```json
"policy": {
  "lowDeferFromRound": 3,
  "cardMaxBytes": 12288,
  "packetContextLines": 20,
  "packetMaxBytes": 60000,
  "incrementalMaxFiles": 50
}
```

`reviewModelsProblems` 校验这些值都是正整数/正数；`reviewReport` 和 `--prepare-round` 都从这里读，不写死。

**测试**

- `opencode-review-merge-gate.test.mjs`：构造第 1、3 轮低严重度错误，报告必须列出第 3 轮、不列第 1 轮；若第 3 轮有 `low-fix`，标 `fixed=yes`。
- 反向：把 `lowDeferFromRound` 改成 4，第 3 轮不再列出，测试必须失败以证明配置真的生效；缺 `verdicts.jsonl` 时报告不崩且打印 `UNREADABLE`。
- 规则一致性：`check:glossary`、`check:instruction-links`、`check:markdown-tables` 照跑；新增卡片/文档里的链接必须通过。

---

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
|---|---|
| 让脚本自动给意见分类 | 违反“分类由线程做”（`.agents/instructions/model-review.md:50`），且会把判断责任从复核者移走；合并门会看起来更自动化，但实际更容易漏中高问题。 |
| 改模型输出格式为 `FINDING|...` 机器行 | 会改固定提示词，可能改变模型行为；现有输出格式已经要求严重度和 `文件:行`。用容错解析 + “未解析块”更安全。 |
| 把复核模型的工具限制为只能读改动文件 | 会漏掉跨文件调用点和间接影响，直接违反“不降低中高问题被抓到”。只限制提示词范围，不限制工具。 |
| 把整个复核交给云端 `delegate.mjs` | 云端线程按现有契约只管跑模型、不写 verdicts（`.agents/instructions/model-review.md:169`），把判断也搬过去等于改契约，且费用只是转移，不减少。 |
| 新增 `low-defer` 账本模式 | 要改 `parseUsage`、`coveragePoints`、`delegate.mjs check` 和报告，面太大；现有门不要求修低意见，报告直接从 `verdicts.jsonl` 读即可。 |
| `--finish-round` 自动提交所有改动 | 可能把无关代码、临时文件一起提交，也可能掩盖未复核改动；只允许提交记录目录，代码修复必须先单独提交。 |
| 单独新建 `review-round.mjs` | 会多一个入口，容易绕开 `opencode-review.mjs` 的校验；作为子命令放进现有脚本，复用同一套门和报告。 |
| 子代理改用 Haiku 等更便宜模型 | 可能降低判断质量；先用 `inherit`，用数据验证后再考虑。 |

---

## 四、风险和反例

1. **解析器漏意见**：模型写成一段没有 `文件:行` 的文字。缓解：未解析块必须列出，子代理对 `REVIEW_PACKET_PARTIAL` 必须读原答案；测试用缺位置的意见做反向用例。
2. **预取上下文过期**：复核 head 之后代码又改了。缓解：上下文只从复核 `head` 读；合并门要求最终提交与复核 head 之间 PR 改动未变，变了就必须重跑。
3. **子代理越权修改/推送**：系统提示禁止，但 Bash 仍可执行。缓解：主线程最后自己跑门和报告；必要时用 `isolation: worktree`，主线程只合并子代理的提交。
4. **自动提交范围错误**：`--commit` 只允许记录目录，记录目录外有任何未提交改动就拒绝。反例：改了 `src/a.ts` 没提交就 `--finish-round --commit`，必须报 `REVIEW_FINISH_DIRTY`。
5. **增量轮漏跨文件影响**：只查增量可能漏掉调用点。缓解：提示词允许读调用点和测试，但禁止整份读大文件；上线后按 PR 统计“中高意见数/漏到下一轮的意见数”，若下降就回退这一条。
6. **第 3 轮起低意见不修**：低严重度仍可能是怪输入下的真实缺陷。缓解：报告逐条列出，Andy 可要求修；如果 Andy 要求修，仍可走现有 `low-fix`。
7. **配置漂移**：`lowDeferFromRound` 改了，旧账本的报告显示会变。缓解：它只影响报告显示，不影响合并门；改配置要按规则走评审。
8. **主线程仍要跑两条命令**：`--assert-reviewed`、`--report`。这是刻意保留的，不让子代理自报代替最终判定。

---

## 五、需要人拍板的取舍

1. **子代理权限**：允许它直接改代码、跑测试并提交代码修复，还是只产出 verdicts 和建议补丁，由主线程改？我建议允许改代码，但主线程保留最终门和报告。
2. **低意见起始轮**：第 3 轮起全部低意见只列不修，还是只对“怪输入触发、报错拒绝”这类低意见生效？我建议按现有“低”的定义全部适用。
3. **配置位置**：`lowDeferFromRound` 等放 `review-models.json` 的 `policy`，还是新开 `review-policy.json`？我建议放现有配置，减少文件数。
4. **增量轮严格程度**：是否接受“只查增量 + 调用点/测试”，不再要求模型通读相关大文件？这会减少步数，但可能降低跨文件问题的发现率。
5. **报告缺 verdicts 时的行为**：只打印 `REVIEW_LOW_DEFER_UNREADABLE` 警告，还是让 `--report` 失败？我建议只警告，避免报告被旧记录卡住；但若 Andy 要求更严，可改为失败。
6. **子代理模型**：先用主线程同模型，还是直接降到更便宜的模型？我建议先同模型，测量后再决定。

---

## 六、读代码或来源证实的 / 推测的

**已证实（读代码或一手来源）**

- 复核提示词由 `buildPrompt` 一次性组装，固定部分在材料前，材料在最后（P1、P2）。
- 增量轮当前确实写着“可以读任何文件”（P3）。
- 合并门按账本 `outcome: ok` 串链，`verdicts` 只在 `low-fix` 路径参与（P4、P5）。
- `--report` 从当前提交的账本生成，不调用模型（P6）。
- 默认模型和配置位置（P7）。
- 子代理有独立上下文、只回传摘要，来自 Anthropic 官方文档（P8）。
- KV 缓存按字节前缀匹配，缓存读取约 0.1 倍价格（P9）。
- I-73 的教训原文（P10）。
- 当前仓库没有 `.claude/agents/` 目录；新增子代理文件是必要动作。

**推测 / 未核实**

- 25–40 次工具调用、15–30 万 token、39–86 美元、0.4–1.4 美元：材料提供，未复算。
- I-98 在当前检出的 `docs/incidents-and-gates.md` 中没有找到；**未核实**。
- 子代理能减少多少 token：未实测；取决于 packet 大小、子代理读文件次数和它返回的摘要长度。
- 增量轮“只查增量”对中高问题发现率的影响：未实测；需要灰度对比。
- 当前 Claude Code 版本是否支持 `omitClaudeMd`：未核实；不支持时在任务说明里附流程卡。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变复核模型已经见过的请求开头。**

- 子代理、流程卡、`--prepare-round`、`--finish-round`、报告新 section 都不接触复核模型的提示词。
- 增量轮改动只改 `buildPrompt` 的材料段；材料段在 `---- 本次材料 ----` 之后，是最后一条用户消息的内容。固定部分（角色、工具、任务、必答问题、侧重、输出格式）不变。依据：`opencode-review.mjs:351-375`，现有测试 `test/tooling/opencode-review.test.mjs:162-187`。
- 每一轮复核都是新会话，`buildPrompt` 每轮只调用一次；不存在“上一轮已经发过的内容”被改写。轮内 opencode 追加工具结果也是在末尾追加。
- 每轮会变的值（`head`、`base`、`previous`、增量文件列表）全部只在材料段里，不在系统提示、工具定义或固定前缀里。依据：`.claude/rules/prompt-prefix.md:28,35`。
- 需要特别说明：`--finish-round` 写账本时沿用现有 `at: new Date().toISOString()`，这个时间只在账本里，不进入任何模型请求；不是新增的“每轮变化值”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**设计上不会。**

- packet、incremental 摘要、报告 section 都从固定提交和固定输入生成；不使用当前时间、不使用 `Set`/对象遍历顺序输出。
- 改动文件列表用 `git diff --numstat -z` 后按路径排序；packet 的 id 按答案出现顺序；报告按 `round` 和文件内顺序。
- 不使用依赖前后文的遮盖：packet 用现有 `maskedRecordText`/`maskSecretLike`，同一段文字在同一规则下遮成同样字节。依据：`.claude/rules/prompt-prefix.md:51-54`。
- 唯一带时间的是账本 `at`，它不进入模型请求，也不进入 `--report` 固定行；和现状一致。
- 风险点：如果实现时用 `git diff --stat` 而不加 `--no-color`/不固定宽度，可能受终端影响；方案明确用 `--numstat -z` 自己格式化。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，计划新增：

- `test/tooling/opencode-review.test.mjs`：增量提示词前缀不变、旧句“可以读任何文件”不存在、文件列表排序稳定；把旧句改回去或打乱顺序，用例失败。
- 新 `test/tooling/opencode-review-workflow.test.mjs`：`--prepare-round` 的 packet/id/quote/上下文；`--finish-round` 的字段校验、quote 校验、只提交记录目录、`low-fix` 上限、失败模型不能变 `ok`。每个正向用例都有对应反向输入，反向输入必须报具体错误码。
- `test/tooling/opencode-review-merge-gate.test.mjs`：报告的低严重度 section；阈值配置改变后列表必须变化；缺 verdicts 时必须打印 `UNREADABLE` 且不崩。
- 新 `scripts/check-model-review-workflow.mjs`（或扩展 `check:instruction-links`）：卡片存在、大小上限、必需命令、锚点/链接；删除命令或改坏锚点必须失败。
- `test/tooling/model-review-card.test.mjs`：子代理 frontmatter 解析、`omitClaudeMd: true`、工具列表不含 `Task`/`Agent`、系统提示含“只经 `opencode-review.mjs`”“不合并”“不用 `--accept-unreviewed`”；删掉任一约束必须失败。
- 现有 `npm run check:prompt-prefix` 仍要跑；虽然它管的是产品对话，但能防止仓库级规则退化。新增 `check:model-review-workflow` 加入 `check:steps`。

**反向用例的有效性**：每个新检查都要用“把修复撤掉/把旧行为放回去”的方式验证一次失败。例如：把 `buildPrompt` 的旧句恢复 → 提示词测试失败；让 `--commit` 允许记录目录外改动 → `REVIEW_FINISH_DIRTY` 用例失败；把 `lowDeferFromRound` 改掉 → 报告列表用例失败。

### 4. 每个新值的产生处和使用处都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `F<n>` id | `--prepare-round`，按答案顺序 | 决策 TSV → `--finish-round` → `verdicts.jsonl` → `parseVerdicts` → `lowFixProblems.findings` → `report` | 产生处只生成安全格式；finish 拒绝不在 packet 的 id、重复 id；`parseVerdicts` 拒绝空/重复；`lowFixProblems` 用集合比较，和账本 `findings` 两端一致；report 只对链上记录查 id |
| `quote` | `--prepare-round` 从模型答案截取 | `verdicts.jsonl` → `parseVerdicts` → `lowFixProblems` 的 `.includes` → `report` | prepare 只取单行、逐字子串；finish 再核一次；`parseVerdicts` 拒绝换行/空；`lowFixProblems` 对模型答案原文核对；report 原样打印 |
| `model` | 账本/配置里的完整模型名 | decisions → verdicts → `parseVerdicts` 的 `REVIEW_MODELS.includes`；答案文件名用短名 | prepare 只从本轮 `ok` 记录取；finish 不接受不在 `REVIEW_MODELS` 的值；文件名映射和现有 `split("/").pop()` 一致 |
| `valid` / `class` / `severity` / `trigger` / `consequence` / `modelSeverity` / `reason` | 子代理填的决策 TSV | `parseVerdicts`、`lowFixProblems`、报告 | `parseVerdicts` 现有规则不变：`class` 只能是 `error`/`better`；成立错误必须有 severity/trigger/consequence/modelSeverity；低严重度且模型不是低时必须有 reason |
| `evidence` | 子代理填的决策 TSV（新增可选字段） | `verdicts.jsonl` 额外字段、`judgments.md` 生成 | `parseVerdicts` 不拒绝额外字段，但检查所有字段无换行；finish 生成时对非 quote 字段遮盖；`recordSecretProblems` 仍扫描提交后的记录 |
| `round` | 命令行 → `roundForRun`/`nextRound` | 记录目录 `round-N`、账本 `round`、`coveragePoints`、`lowFixProblems`、报告 | 现有 `parseArgs` 要求正整数；`roundForRun` 要求与已有记录/目录一致；新命令复用同一参数 |
| `policy.lowDeferFromRound` | `review-models.json` | `reviewModelsProblems` 校验、`reviewReport` 选择轮次、文档/测试 | 配置读入时必须是正整数；报告只读不写门；测试改变量后输出必须变化 |
| `policy.cardMaxBytes` / `packetContextLines` / `packetMaxBytes` / `incrementalMaxFiles` | `review-models.json` | 检查脚本、`--prepare-round`、`buildPrompt` | 读入时校验正数；超出时打印截断/拒绝，不静默忽略 |
| 子代理 `name` / `description` / `tools` / `omitClaudeMd` | `.claude/agents/code-review-round.md` frontmatter | Claude Code 加载器、检查脚本 | 检查脚本解析 YAML，校验必填字段、工具白名单、禁止 `Task`/`Agent`；字段缺失或改名必须失败 |
| 卡片里的命令/锚点 | `.agents/instructions/model-review-card.md` | 线程照做、检查脚本 | 检查脚本要求固定命令字符串存在、链接可解析；删命令/改坏锚点必须失败 |
| `--finish-round` 的提交范围 | `--commit` 分支 | `git add -- .agents/reviews/pr-N` | 提交前检查记录目录外无改动；有则 `REVIEW_FINISH_DIRTY`，不提交 |
| `low-fix` 的 `files` / `findings` | 现有 `lowFixProblems` 从 diff 和 verdicts 重算 | `assertReviewed.lowFixCheck` 的 `sameList`、`report` | 现有两端校验不变：账本记录值必须和重算值一致，否则 `files-differ`/`findings-differ` |

**结论**：新增值里最关键的是 `id`、`quote`、`policy` 和提交范围。它们都在产生处和消费处有显式校验；`quote` 继续以模型答案原文为唯一真相，`id` 不能凭 hand-write 绕过 packet，`policy` 只影响报告/打包，不影响合并门的放行条件。
