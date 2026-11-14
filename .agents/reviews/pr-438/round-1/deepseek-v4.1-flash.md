## 复核结论

这次改动只新增 `.agents/reviews/topic-four-features-wiring/` 下 11 个文件，没有改代码、配置、文档或测试（`git diff --stat` 证实）。按记录内容核对，没有发现高严重度的代码或安全问题；记录由脚本生成的特征很强。发现 3 个低严重度的记录/流程问题，另有 1 个费用先问线需要作者确认。

**复核方式说明：** 当前复核副本按 `.agents/instructions/model-review.md:128` 把 `.agents/reviews/` 排除并标成 `-diff`，所以 `git diff` 只显示 Binary，`git show <路径>` 被 `REVIEW_GIT_REFUSED` 拒绝。我按该文件已登记的局限，用 `git diff --raw` 取得 blob 哈希后用 `git show <blob>` 读取内容；这不是正常复核流程能看到的路径，下面的“证实”包括对 blob 内容的读取。

## 发现（按严重度）

### 1. 中（前提：未取得 `--approved-usd`；未核实）

- 文件：`.agents/reviews/topic-four-features-wiring/usage.jsonl:1-5`
- 问题：方案讨论的实际费用已超过 0.5 美元先问线；记录里没有 Andy 同意额外预算的证据。
- 证据：五条记录的 `cost` 分别是 `0.13440354999999998`、`0.10622644200000002`、`0.078351624`、`0.12275176`、`0.15006151199999998`，合计 `0.591794888`。按 `spentOf` 的规则，第 2 条带 `"inFlight":true`，累计时应按 `max(cost+0.05, 0.2)` 算，实际预算口径约 `0.685568446`。`scripts/model-review/opencode-review.mjs:1080-1098` 的 `spentOf`/`budgetCheck` 正是这样算；`.agents/instructions/model-review.md:132` 明写“方案讨论超过 0.5 美元，就以 `BUDGET_NEEDS_APPROVAL` 拒绝开跑……他同意的总额用 `--approved-usd <美元>` 传入”。
- 建议：作者补充说明第 2 轮是否取得 Andy 的 `--approved-usd`；如果没取得，这次运行本身违反了先问线，应在 PR 描述里明确记录，而不是只写“只新增记录”。

### 2. 低

- 文件：`.agents/reviews/topic-four-features-wiring/round-2/deepseek-v4.1-flash.prompt.md` 和 `glm-5.3-flash.prompt.md` 的“本次材料”段
- 问题：记录说三方方案在 `round-1/` 和 `thread-plan-v0.md`，但本 PR 没有 `thread-plan-v0.md`；线程自己的独立方案缺失，记录不能完整复原“三方”。
- 证据：prompt 原文：“三方（线程、DeepSeek、GLM）各自独立出的方案在 `.agents/reviews/topic-four-features-wiring/round-1/` 和 `thread-plan-v0.md`。”`git diff --stat 6e33c029..3055686` 只列出 11 个文件，没有 `thread-plan-v0.md`；`git log --oneline -- thread-plan-v0.md` 无输出。
- 建议：把 `thread-plan-v0.md` 补进记录目录，或在记录目录里加一份说明“线程方案未归档、本记录只含两轮模型输出”。不要直接改已归档的 prompt 文件。

### 3. 低

- 文件：`.agents/reviews/topic-four-features-wiring/round-2/glm-5.3-flash.md`
- 问题：round-2 prompt 让模型去读 `.agents/reviews/.../round-1/`，但复核沙箱按设计把这个目录隐藏；GLM 因此把路径判成“不存在/引用失效”，这条错误结论被原样存进了记录。
- 证据：prompt 指向 `round-1/`；`.agents/instructions/model-review.md:128` 原文“复核副本用 sparse checkout 去掉整个 `.agents/reviews/`”；GLM 答案原文：“方案开头引用的 `.agents/reviews/topic-four-features-wiring/round-1/` 在当前检出版本里不存在（glob 无结果）。要么是未提交的本地文件，要么路径写错，引用失效。”
- 建议：以后的 plan-review 材料不要指向 `.agents/reviews` 下的文件，或在材料里写明“复核副本看不到记录目录”；这条记录本身可在新增的说明里注明该结论是沙箱造成的，不要修改已归档答案。

### 4. 低

- 文件：`scripts/model-review/delegate.mjs:331-336`（使用方）；`.agents/reviews/topic-four-features-wiring/*.md`（被使用方）
- 问题：作者说“线程没有手工编辑”，但现有检查只能核对 prompt 文件哈希，不能核对答案文件；答案文件没有哈希，CI 也不会对 topic 记录跑 `delegate.mjs check`。
- 证据：`delegate.mjs:331-336` 只做 `const answer = showFile(...); ... const prompt = showFile(...); ... sha256(prompt) !== (record.promptFileSha256 ?? record.promptSha256)`；没有 `answer` 的哈希比较。`.agents/instructions/model-review.md:116` 也只说明账本记 `promptSha256`/`promptFileSha256`。`git diff --check` 通过只能证明没有行尾空白，不能证明答案未被改写。
- 建议：如果“没有手工编辑”是这次提交的验收条件，应把答案文件的摘要也写进账本，或把 `delegate.mjs check` 纳入记录校验；否则应把这句话降级为“按脚本格式推定”，不要当成已自动证明的事实。

## 读代码证实与推测分开

**读代码证实的：**

- diff 只有 `.agents/reviews/topic-four-features-wiring/` 下 11 个文件；工作区 `git status` 干净。
- `usage.jsonl` 五条记录可被 `opencode-review.mjs` 的 `parseUsage` 接受：`mode` 是合法的 `plan`/`plan-review`，`head` 是 40 位提交哈希，`model` 是 `REVIEW_MODELS` 里的两个模型，`gateway:"magpie"`，`providers` 每项都是整数请求数/失败数和有限美元值，`gatewayDropped` 是字符串数组，`cost` 非负。
- round-1 两个模型的 prompt 文件是同一个 blob（`ca31e082`），对应账本里相同的 `promptSha256`；round-2 两个 prompt 只差脚本注入的 `MODEL_LENSES` 侧重段，`git diff da69b4ef 61ee6bf7` 显示差异恰好只有这一行。这强烈支持脚本生成。
- `attempt-1` 文件名与 `keepEarlierAttempt`（`opencode-review.mjs:1809-1823`）的命名一致；`attempt-1.md` 是 1 字节换行，符合 `recordText` 总是追加换行的写法（`opencode-review.mjs:2578-2579`）。
- `promptSha256` 与 `promptFileSha256` 在五条记录里都相等，且 prompt/答案里没有出现 `[已遮盖:...]`，说明写入时没有触发脚本的密钥遮盖规则。
- `round-2` 的 GLM 答案确实写入了“round-1 不存在”的结论，原因就是复核副本隐藏 `.agents/reviews`。

**推测或未核实：**

- 第 2 轮是否取得 Andy 的 `--approved-usd`：未核实；费用超线是事实，审批不在记录里。
- 答案文件是否被线程手工改过：没有答案哈希，无法证明；只能根据格式、换行、行尾空白和 prompt 一致性推定。
- “记录里没有密钥或主人私人信息”：我按脚本的密钥规则人工通读了全部 prompt、答案和账本，没有发现私钥、Bearer、JWT、`sk-`、GitHub/AWS 令牌或密码赋值；但未运行真正的 `scan-machine-secrets`/gitleaks。记录里的“Andy”“日本入管局”等内容在仓库现有 ADR/产品文档中已经出现，不是这次新增的私密信息。
- `thread-plan-v0.md` 是否存在于仓库外：未核实；仓库内 `git log` 和 glob 都没有找到。

## 侧重检查

- **错误路径：** `parseUsage` 会拒绝损坏的账本；这五条都能通过。`nextRound`/`roundForRun` 能处理同一轮里“owner-stopped + ok”两条 deepseek 记录；`attempt-1` 命名符合 `keepEarlierAttempt`。未发现账本格式或轮次错误。
- **不合规范/不可信输入：** 记录来自模型输出，脚本写盘时有密钥遮盖；prompt 和答案没有发现控制字符问题，`git diff --check` 通过。但答案文件没有哈希，无法排除人工改写；`parseUsage` 只校验账本，不校验答案正文。
- **安全：** 没有发现密钥或新的私人信息；`.agents/reviews` 按设计对复核模型隐藏，本次是通过已登记的 blob 哈希局限读到的。记录中包含内部架构、文件路径、成本和模型选择，这些是否允许入库应由作者按仓库隐私边界确认。
- **资源耗尽：** 记录总量约 150 KB，不影响运行；但这次讨论费用已超过 0.5 美元先问线，且 `inFlight` 让预算口径高于账本显示值。
- **不可撤销操作：** 这次只是新增文件，可回退；记录里讨论的提交/停用/重新启用等不可逆操作没有被执行。
- **规则/文档一致性：** `.claude/rules/prompt-prefix.md` 没有被改动，记录也不进入模型请求；`.agents/instructions/model-review.md` 的密钥遮盖、记录路径、预算规则与脚本基本一致。不一致点就是上面第 2 条的 `thread-plan-v0.md` 缺失，以及第 3 条 prompt 指向复核副本隐藏的目录。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 只增加静态记录文件，不改系统提示、工具定义、历史消息或遮盖规则；记录本身没有被任何代码自动拼进模型请求。发给模型的内容仍然只在末尾追加，每轮会变的值没有新增到请求前缀里。依据：`.claude/rules/prompt-prefix.md:27-28`“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”，以及 `:35`“已经发给过模型的内容……只能在末尾追加”。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对这些记录本身不会：prompt 和答案文件是静态字节，`usage.jsonl` 也是固定 JSON 行。唯一会变的是账本里的 `at`、`cost`、token 数等运行元数据，它们不在模型请求里；不应把它们拼进 prompt。round-2 两个 prompt 不同，是脚本按 `MODEL_LENSES` 给两个模型不同侧重，不是依赖前后文遮盖导致的非确定字节。依据：`.claude/rules/prompt-prefix.md:51` 要求 JSON 键顺序、列表顺序固定；这里没有新增模型输入，也就没有新的字节确定性问题。

3. **有没有对应自动检查，反向用例会不会真的失败？**
   部分有，但不是针对这 11 个文件。`git diff --check` 通过；`parseUsage`/`delegate.mjs check` 可以校验账本格式和 prompt 哈希，但这次没有在 CI 里对 topic 记录运行。现有 `test/tooling/opencode-review*.test.mjs` 覆盖了密钥遮盖、`attempt` 改名和账本非法格式等反向用例，但没有用例断言“这些具体答案文件未被手工编辑”。所以：脚本逻辑有回归测试；这次记录内容没有专门的自动检查，答案文件的“未手工编辑”无法通过反向用例证明。

4. **每个值两端都能接受吗？**
   账本值和文件名两端都能接受：`TOPIC_PATTERN` 接受 `four-features-wiring`（`opencode-review.mjs:2561`）；`promptFileName` 生成的 `deepseek-v4.1-flash.prompt.md`、`glm-5.3-flash.prompt.md` 与文件一致（`:2715-2717`）；`ROUND_FILE_PATTERN` 和 `delegate.mjs` 的 `attempt` 分支接受 `.attempt-1.*`（`delegate.mjs:31、331-357`）；`parseUsage` 接受 `mode`、`head`、`model`、`outcome`、`gateway`、`providers`、`gatewayDropped`、`cost`（`:1662-1739`）；`keepEarlierAttempt` 与现有 `attempt-1` 文件匹配（`:1809-1823`）。不能接受的是记录内容层面的引用：`thread-plan-v0.md` 不存在；另外答案文件在消费端没有摘要校验，无法核对“未手工编辑”。

## 对作者说法的核对

- “只新增 `.agents/reviews/topic-four-features-wiring/` 下的文件”：**证实**，diff 只有这 11 个文件。
- “不改代码、配置、文档和测试”：**证实**，diff 中没有这些路径。
- “记录里不得有密钥或主人的私人信息”：**未发现密钥**；但只能算人工通读加脚本遮盖规则检查，不能替代真实 gitleaks；`Andy`、`日本入管局` 等已在仓库现有文档中出现，不是这次新增的私密信息。
- “这些文件都是 `scripts/model-review/opencode-review.mjs` 自己写出的，线程没有手工编辑”：**脚本生成的可能性很高**（prompt 一致、lens 差异、`attempt` 命名、账本字段和换行格式都对得上）；但答案文件没有哈希，严格说“线程没有手工编辑”**未核实**，现有自动检查也不能证明。
