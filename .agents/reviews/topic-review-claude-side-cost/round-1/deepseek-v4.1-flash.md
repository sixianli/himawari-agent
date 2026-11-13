## 结论

方向大体对（隔离复核、脚本承接机械步骤、按需读文档、增量优先），但现在这份方案还不能直接实施。最要紧的是四点：它把不存在的 `I-98` 开跑前检查当成事实；`--judge-skeleton` 依赖模型答案里并未约定的 `###` 标题；第 3 轮起低意见“只列不修”直接推翻了 ADR 0175 的明确决定；一个子代理连续跑多轮不会真正缩小上下文，反而会在子代理里重新长出长上下文。

## 证实的（按严重度）

### 高

**1. “I-98 已有开跑前检查”是错的；代码里没有 `--previous` 的祖先检查。**
- 证据：`parseArgs` 只是收下值（`scripts/model-review/opencode-review.mjs:2836`），`resolveCommits` 只做 `rev-parse`（`:2601-2605`），真正检查 `previous` 是不是链上前一点的祖先要到合并门 `walkChain`（`:1343-1369`、`:1439-1522`）。本检出的事故表只到 I-96（`docs/incidents-and-gates.md:124-132`），没有 I-98。
- 影响：传错 `--previous` 会先花钱跑完，到合并门才失败；改成“只复核增量”后，错误增量还会让模型系统性漏掉真正改过的代码。
- 建议：在 `main()` 花钱、安装、自检之前加 `PREVIOUS_NOT_ANCESTOR`、`BASE_NOT_ANCESTOR`、`PREVIOUS_EQUALS_HEAD`、`EMPTY_INCREMENT` 检查，打印实际提交；测试要断言这些错误在任何模型请求之前发生。

**2. `--judge-skeleton` 假设每条意见都是 `### ` 标题，但输出契约没有这个要求。**
- 证据：代码复核的输出格式只写“按严重度从高到低排列，每条写：严重度、文件:行、问题、证据、建议”（`opencode-review.mjs:300-302`），提示词里没有要求三级标题（`:346-376`）。模型完全可能用 `1.`、`-`、表格或段落。
- 影响：找不到标题时可能生成零条 verdict，`--finish-round` 会得出“没有中高意见”的结论；这正是现有机制“验证不了没有漏列”的已知盲区（`.agents/instructions/model-review.md:44`、`:71`）。
- 建议：把“每条意见以 `### 意见 <序号>：...` 开头”写进模型输出契约，或要求一个围栏 JSONL 块；`--judge-skeleton` 只认这个标记，找不到就 `JUDGE_SKELETON_UNSUPPORTED` 非零退出，不写空文件。还要排除“必答问题”“侧重检查”“结论”等章节。测试要覆盖项目符号、编号列表、无标题、标题重复。

**3. 第 3 轮起低意见“只列不修”与 ADR 0175 和现行文档直接冲突。**
- 证据：ADR 0175 明确写“把低严重度意见直接忽略、不修改。不采用：低严重度也是真实的错误，照样要改、要补测试”（`docs/adr/0175-cheaper-code-review-rounds.md:95`）；`AGENTS.md:52` 说“低的照样修改、补测试”；`model-review.md:61` 也是同样规则；案例库写“低档意见仍然要修改”（`docs/engineering-casebook.md:5338`、`:5352`）。
- 影响：只写一份“ADR 0263 记下规则变化”不够，旧 ADR 的决定仍然有效，AGENTS.md 又是自动加载的摘要，后续线程会按互相矛盾的两套规则做。
- 建议：新 ADR 必须明确取代或修订 0175 的第 5 条，并同步 AGENTS.md、model-review.md、案例库。更重要的是缩小“不修”的范围：只允许“故意构造的怪输入、触发后只是报错拒绝”的低意见不修；文字漏写、文档与代码不符、缺回归测试仍应修。否则“文档和代码一致”这个目标会被这条规则自己破坏。

**4. 一个子代理连续跑多轮，不会达到“小上下文”的目标。**
- 证据：官方文档说子代理“runs in its own context window”，且“Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history”；同时“Other built-in and custom subagents load both [CLAUDE.md 和 git status]，unless you set `omitClaudeMd`”（https://code.claude.com/docs/en/sub-agents）。方案说“起一个子代理……再复核，直到停止条件”，这会在这个子代理内部重新累积 15 万–30 万 token 的上下文。
- 影响：主线程是小了，但总 token 不一定下降，甚至因为子代理默认加载项目指令而更高。
- 建议：每轮起一个新的 runner 子代理，主线程只做编排；新增 `.claude/agents/model-review-runner.md`，frontmatter 用 `omitClaudeMd: true`、`tools: Read, Grep, Glob, Bash, Edit, Write`、`maxTurns` 上限、不要 `Agent`/`WebFetch`/`WebSearch`。把 PR 号、base/head、brief、流程卡路径放在给子代理的第一条用户消息里，不要写进子代理的系统提示或流程卡。

### 中高

**5. 两个新命令没有定义成真正的子命令，按现在的参数解析会被拒绝；也没有测试。**
- 证据：`parseArgs` 在判断 `--assert-reviewed`/`--report` 之前就要求 `--head`、`--brief`、`--base`（`opencode-review.mjs:2911-2947`）；子命令选项清单只有 assert/report（`:2791-2807`）。`--judge-skeleton --pr N` 会先撞上 `ARG_REQUIRED --head`，不是方案说的“一条命令”。
- 建议：新增 `JUDGE_OPTIONS`、`FINISH_OPTIONS`，在 `main()` 里像 `--report` 一样在读材料、装 opencode、起 Magway、自检之前早退；要求 `--pr` 和 `--round`，拒绝 `--mode`、`--head`、`--brief`、`--report` 混用；导出唯一的 `CLI_FLAGS` 给流程卡测试用。正反用例都要有：缺 `--round`、两个子命令同时给、给了 `--mode`、`--accept-low` 混用。

**6. `--finish-round` 把 `why` 设为可选，违反“每条判断都要有依据”。**
- 证据：规则要求“每条都写下判断和依据（文件:行或实际运行结果）”，判为不成立或“可以更好”都必须给出能核对的依据（`model-review.md:50`、`:58`）。可选 `why` 会让生成的 `judgments.md` 出现没有依据的条目。
- 建议：`--finish-round` 要求每条 verdict 都有非空 `why`；至少 `valid=false` 和 `class=better` 必须有；脚本无法判断语义，但至少拒绝空值、换行和控制字符，并把 `why` 一起遮盖。

**7. 多模型、重跑轮和历史轮会让 `--pr N` 选错轮次或让 `id` 冲突。**
- 证据：`parseVerdicts` 只保证同一个文件里 `id` 不重复（`opencode-review.mjs:1203`），如果两个模型都生成 `V1`，整份文件作废；轮次序号和目录由 ledger/`roundForRun` 决定（`:1828-1876`），目录最大的 `round-*` 不等于“最后一轮成功复核”。重跑还会留下 `.attempt-N` 文件。
- 建议：`--judge-skeleton` 和 `--finish-round` 都要求显式 `--round`，从 HEAD 的 `usage.jsonl` 和 `coveragePoints` 找这一轮 `outcome=ok` 的模型，按 ledger 里的完整模型名找 `<模型>.md`；`id` 用 `${模型短名}-${序号}`。找不到成功轮次就拒绝，不猜目录。

**8. 新增的 `trigger`、`consequence`、`why` 和报告行没有控制字符/遮盖处理。**
- 证据：`parseVerdicts` 只拒绝 `\r\n`（`:1171-1207` 的 `hasLineBreak`，定义在 `:1701-1705`），不拒绝 ANSI 转义等其他控制字符；记录遮盖靠 `maskSecretLike`（`:2654-2714`），合并门靠 `recordSecretProblems`（`:2769-2777`）；`--report` 会把内容贴进 PR 描述。模型原话已经遮过，但线程写的 `trigger`/`consequence`/`why` 没有。
- 建议：`--finish-round` 写 `judgments.md` 和 `--report` 打印新字段时统一 `printable` + `maskSecretLike`；verdict 文本字段含控制字符直接拒绝；新文件用 `flag: "wx"` 原子写，工作区和 HEAD 里已存在都拒绝覆盖。测试放 ANSI 转义、私钥样式字符串、重复写入。

**9. “只复核增量”会降低召回，而“不降低中高问题被抓到”没有证据。**
- 证据：现在的提示是“先看 `git diff previous..head` 的增量，但可以读任何文件”（`opencode-review.mjs:368`；`model-review.md:157`）。方案给的第二轮 195、第三轮 107 等数字，不能证明这些意见都落在增量里；多轮复核的意义正是前一轮会漏。
- 建议：上线前用历史 PR 做一次 A/B：同一批 head 分别用现行提示和“只增量”提示跑，比较中高意见集合、步数和费用。提示词改成“优先增量 + 增量的直接调用端/使用端（一步）+ 发现证据指向旧代码时必须跟下去”，不要写“增量没改变行为就不要重查”。在结论里要求模型写清查过的范围和未查部分。

### 中

**10. 低意见“只列不修”缺少可核对的持久记录，`--report` 的推导也不稳。**
- 证据：`--report` 现在只从 `low-fix` 记录生成“低严重度已改、未复核”一节（`opencode-review.mjs:1660-1679`）；`STOP_REASONS["no-error"]` 的文案是“没有‘会出错’的意见”（`:1629-1634`），但低意见也是 `class=error`。如果第 3 轮低意见不修、第 4 轮又因别的原因开跑，最后一轮没有低意见时，前面被放过的低意见会从报告里消失。
- 建议：`--finish-round` 生成 `round-<n>/deferred-lows.json`（轮次、head、模型、id、quote、trigger、consequence），随记录一起提交；`--report` 列出所有尚未被后续轮次覆盖的 deferred low；`--stop` 增加 `low-deferred`，或至少把 `no-error` 文案改成“没有中、高严重度的‘会出错’意见，低严重度见下节”。`--assert-reviewed` 要校验这个文件里的 id 仍然存在且仍是 low。

**11. 子代理把“分类、修改、提交”都接走，主线程不看答案，和“分类由线程做”冲突。**
- 证据：规则写明“分类由线程做，不由模型做”（`model-review.md:50`），每条判断要有依据（`:51-58`）；委托给云端线程时还专门规定云端“不做判断、不改代码、不合并”（`:164`）。
- 建议：把 runner 定义成“线程的手”，但主线程必须在提交前读小文件 `verdicts.jsonl`、`judgments.md` 和 `git diff --stat`，至少抽查中高意见和安全相关 diff；runner 不得 push、merge、使用 `--accept-unreviewed`；费用以 `usage.jsonl` 的 `REVIEW_SPENT_TOTAL` 为准，不采用 runner 自报数字。若要彻底把判断交给子代理，必须改规则并写进 ADR，不能悄悄做。

**12. 流程卡的锚点测试和现有 `check:instruction-links` 重复；参数测试没有单一来源。**
- 证据：`scripts/check-instruction-links.mjs:7-12` 已把 `.agents/instructions` 纳入，`:49-80` 已检查 Markdown 链接和锚点。方案再写一套容易漂移。
- 建议：锚点继续交给 `npm run check:instruction-links`；新测试只做参数一致性：从脚本导出 `CLI_FLAGS`，扫描卡里的 `--[a-z-]+`，每个都必须在集合里且能被 `parseArgs` 接受。再加一条卡文件大小上限，防止又长成第二个大文件。

**13. ADR 编号 0263 可能不对。**
- 证据：本检出最高的 ADR 是 0261（`docs/adr/0261-...md`），0260、0262、0263 都不存在；文档治理要求看 main 和所有未合并 PR 后取最大号加一（`.agents/instructions/document-governance.md:28`）。
- 建议：在本检出上应先建 0262；如果另有未合并 PR 占 0262，再用 0263。合并前跑 `npm run check:adr-numbers`。

**14. “下一步完整命令”含 `--head`/预算/`--accept-low` 分支，方案没说清楚。**
- 证据：`--accept-low` 有 5 文件/30 行/至少一个测试改动/同一轮最多一次等条件（`model-review.md:61`；实现 `opencode-review.mjs:1557-1580`）；累计费用超过 1 美元要先问 Andy（`model-review.md:62`；`budgetCheck` `:1137-1145`）。
- 建议：`--finish-round` 只打印带 `<新提交>` 占位的模板和当前 `REVIEW_SPENT_TOTAL`，不要假装是可直接执行的完整命令；按 `--accept-low` 的拒绝原因分支到“再跑一轮”或“先问 Andy”。

### 低

**15. `--finish-round` 没有拒绝覆盖已有 `judgments.md` 的规则。**
- 建议：和 `--judge-skeleton` 一样，工作区或 HEAD 已有目标文件就拒绝，除非显式 `--force`；写入用 `wx`。

**16. 低意见报告可能很长。**
- 建议：给报告设条数上限或先打印总数；超过上限时按模型/轮次分组，避免 PR 描述不可读。

## 推测 / 未核实

- 39–86 美元、0.4–1.4 美元、15 万–30 万 token、25–40 次工具调用、各轮 460/195/107/57/34/51 条，这些数字在本仓库里找不到出处，标“未核实”。要用它们支撑决策，应附上 ledger/usage 导出或测量脚本。
- 实际模型答案用不用 `###` 标题，本检出没有 `.agents/reviews` 目录，无法核对真实分布；但输出契约不要求标题，风险成立。
- “每轮起一个子代理”比“一个子代理跑多轮”省多少 token，需要实测；官方文档只能证明上下文隔离，不能证明总费用下降。
- 只复核增量对中高召回的影响，未做历史 PR A/B，未核实。
- 目标 Claude Code 版本是否支持 `omitClaudeMd`、`maxTurns`、`tools` 等字段，本仓库没有版本记录；引用的是当前官方文档。
- ADR 0262 是否已被未合并 PR 占用，无法从本检出看到 GitHub 上的所有 PR；标未核实。

## 侧重检查

- **错误路径**：查了 `--previous`/`--base` 错误、重跑/替补轮、失败模型、缺失答案、`.attempt-N`、重复 id、`--accept-low` 拒绝原因。结论：正常路径方案覆盖了，但开跑前 `--previous`、选轮次、多模型 id、`--finish-round` 覆盖保护都缺。
- **不合规范/不可信输入**：查了模型答案的标题/列表/段落、`trigger`/`consequence`/`why` 的自由文本、ANSI 控制字符、像密钥的文字、文件名、PR/round 参数。结论：必须让骨架解析“找不到就拒绝”，并对新字段统一 `printable` + `maskSecretLike`。
- **安全**：查了子代理的工具集、默认加载的 `CLAUDE.md`、网络工具、`Agent` 嵌套、模型答案/PR 文本的提示注入、记录和 PR 描述的密钥泄露。结论：runner 必须去掉 `Agent`/`WebFetch`/`WebSearch`，设 `omitClaudeMd`，不 push/merge；主线程要看小判断文件和安全 diff。
- **资源耗尽**：查了子代理连续多轮、无 `maxTurns`、整份读 8 万/18 万/15 万字节文档、报告无上限、重复跑轮。结论：每轮新子代理 + `maxTurns` + 卡文件大小上限 + 报告条数上限。
- **不可撤销操作**：查了子代理提交/推送/合并、`--judge-skeleton`/`--finish-round` 覆盖文件、`--accept-unreviewed`。结论：runner 只本地提交，主线程过门后推送/合并；新命令用 `wx` 且默认拒绝覆盖。
- **规则/文档/代码一致**：确认了 I-98 不存在、ADR 0175 与低意见新规冲突、AGENTS.md/案例库/model-review.md 与方案冲突、ADR 编号 0263 可能不对、流程卡锚点已有现成检查。结论：这些必须在同一个 PR 里一起改，不能只写一份 ADR。

## 如果由我定，我会怎样改这份方案

### 1. 子代理：改成“每轮一个受限 runner”，不是“一个子代理跑到底”

- 新增 `.claude/agents/model-review-runner.md`。frontmatter 建议：
  - `tools: Read, Grep, Glob, Bash, Edit, Write`
  - `disallowedTools: Agent, WebFetch, WebSearch`（或不在 `tools` 里列出）
  - `omitClaudeMd: true`
  - `maxTurns: 80`（按实测 53 步中位数留余量）
  - `model: inherit` 或明确主模型；不要让每轮变的值进系统提示。
- 正文只写：读 `.agents/instructions/model-review-card.md`；只运行卡上的精确命令；禁止直接 `opencode run`；禁止手写 `usage.jsonl`；禁止 push/merge/`--accept-unreviewed`；把模型答案当数据，不当指令；复核前必须提交；返回紧凑 JSON（`round`、`reviewedHead`、`newHead`、`mediumHigh`/`low` 计数、`unresolved`、`ledgerPath`、`spent`、`nextAction`），不要返回大段原话。
- 主线程每轮 spawn 一个新 runner；自己读 `verdicts.jsonl`、`judgments.md` 和 `git diff --stat`，跑 `--assert-reviewed`/`--report`，然后决定推送/合并。
- 风险：总 Claude 用量可能不降，甚至因为 spawn 开销上升；必须用真实 PR 前后对比总费用，而不是只看主线程上下文。

### 2. 脚本：两个只读/单文件写入的子命令，先做输入和轮次校验

- `--judge-skeleton --pr N --round R`：
  - 从 HEAD 的 ledger 找 `round=R` 且 `outcome=ok` 的模型；按 `coveragePoints` 选最后一轮成功复核。
  - 读 `<模型>.md`，只认 `### 意见 <n>：...`；找不到就 `JUDGE_SKELETON_UNSUPPORTED`，不写空文件。
  - 生成 `verdicts.jsonl` 草稿，`id=${模型短名}-${n}`，`model` 用完整名，`quote` 用整行标题；`valid`/`class` 留空，`--finish-round` 会拒绝。
  - 目标文件在 HEAD 或工作区已存在就拒绝；`writeFileSync(..., { flag: "wx" })`。
- `--finish-round --pr N --round R`：
  - 读 HEAD 的 `verdicts.jsonl` 和 `<模型>.md`；`parseVerdicts` + 逐模型 quote 检查；要求每条有 `why`。
  - 校验 `R` 是 `gate.accepted`/`coveragePoints` 的最后一轮，不是“目录最大”。
  - 生成 `judgments.md`（拒绝覆盖），每条包含判断、依据、触发、后果；打印 `REVIEW_FINISH round=… reviewed=… models=… mediumHigh=… low=… spent=…`，再打印带 `<新提交>` 的下一轮模板。
  - 分支：中高 → 修改后下一轮；低且 `R<3` → 修改后 `--accept-low`；低且 `R>=3` → 写 `deferred-lows.json`；无 → 可合并。
  - 不写 ledger，不花钱，不装 opencode；在 `main()` 里早退。
- 加 `--report` 的“低严重度未修（第 3 轮起只列不修）”一节，从 `deferred-lows.json` 和最后一轮 verdicts 生成；`--stop` 增加 `low-deferred` 或改 `no-error` 文案。
- 在 `resolveCommits`/`main()` 加 `PREVIOUS_NOT_ANCESTOR`、`BASE_NOT_ANCESTOR`、`PREVIOUS_EQUALS_HEAD`、`EMPTY_INCREMENT`。
- 测试：新命令的正反用例、quote 不存在、id 重复、多模型、失败轮、`.attempt`、覆盖保护、控制字符、秘密文本、预算分支、`--accept-low` 拒绝分支；每个反向用例要能在去掉对应检查时真的失败。

### 3. 流程卡：只做“常用路径 + 精确命令”，不要复制规则

- 新增 `.agents/instructions/model-review-card.md`，控制在 6–8 KB：启动、判断、收尾、合并前检查、报告、出错时去哪个锚点。
- `AGENTS.md` 只在现有“和 OpenCode 协作”一节加一句“先读流程卡”；不要放进进制检查清单，否则会改变 `reviewQuestions` 的提取。
- 锚点交给 `npm run check:instruction-links`；新增 `test/tooling/model-review-card.test.mjs`，从脚本导入 `CLI_FLAGS`，检查卡里每个参数都在集合里，卡文件不超过上限，且没有日期/PR 号这类动态值。
- 风险：卡和原文仍会漂移；用“卡只写命令和分支，规则只链接”控制。

### 4. 增量与低意见：先保留召回，再省步数

- 增量提示只改 `buildPrompt` 的 `previous` 材料行（`opencode-review.mjs:368`），不改 `MODE_TEXT`、lens、必答问题、工具定义；这样固定前缀不变，现有测试 `test/tooling/opencode-review-merge-gate.test.mjs:2401-2408` 继续通过。
- 提示写成：“先看 `previous..head` 增量；必须查增量的直接调用端和使用端（一步）；增量没改变行为的老代码不必重读，但发现证据指向老代码时必须跟下去；结论写清查过的范围和未查部分。”不要写“不要重查”。
- 上线前用历史 PR 做 A/B，比较中高意见召回、步数、费用；没有数据就只加“优先增量”，不删“可以读任何文件”。
- 低意见：只推迟“故意怪输入 + 安全报错”的低意见；文档不准确、缺回归测试仍修。新增 `deferred-lows.json`，`--report` 列出所有未被后续轮覆盖的低意见；新 ADR 明确取代 ADR 0175 第 5 条，并同步 `AGENTS.md:52`、`model-review.md:61`、案例库 `:5338`/`:5352`。
- ADR 编号先查未合并 PR；本检出应使用 0262。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
- 复核模型这一侧：只要增量说明只加在 `buildPrompt` 的 `previous` 材料行（`:368`），`MODE_TEXT`、lens、必答问题、第 16 条原话、工具定义、系统提示都不动，固定前缀就仍是逐字节相同；现有测试 `opencode-review-merge-gate.test.mjs:2401-2408` 会守住这一点。不要为了“只查增量”去改 `MODE_TEXT` 或 `RULE_16_SENTENCE`，那会改掉固定提示，也会让“同一个模型每轮固定前缀相同”的保证失效。
- 子代理这一侧：Claude Code 子代理每次是新的上下文，官方文档说它“starts fresh”，不会看到主线程历史；主线程历史只追加一条 Agent 工具调用和结果，不改旧消息。PR 号、base/head、brief、round、费用这些每轮变的值放在给子代理的第一条用户消息里；系统提示 `.claude/agents/model-review-runner.md` 和流程卡里不要写日期、PR 号、head。
- 新脚本命令不向复核模型发请求，不影响请求开头。若以后把 `judgments.md`/报告喂给子代理，也应作为最后一条用户消息追加，不改前面的内容。
- 结论：按上面的实现，仍然只在末尾追加，每轮变的值都在最后一条消息里；前提是不要把增量规则写进固定系统提示。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
- 会，如果新命令用时间、随机数、目录遍历顺序或模型名集合的无序迭代。必须：`--judge-skeleton` 用“模型短名-序号”做稳定 id；`--finish-round` 的 `judgments.md` 和下一步命令不含 `new Date()`；多模型顺序按 `REVIEW_MODELS` 或 ledger 顺序；`--report` 的低意见按轮次、模型顺序、id 排序，不用 `readdirSync` 顺序；`maskSecretLike` 和登记测试值已经是确定性排序。子代理返回的摘要不是下一次请求的前缀；如果它被原样追加进主线程历史，存的就是实际发出去的那份字节。
- 结论：设计上可以做到确定；但方案没有规定这些顺序和“不写时间”，这是需要补的实现约束。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
- 现在的方案只有“流程卡锚点/参数”检查，不够。至少要有：`--judge-skeleton` 的无标题/项目符号/重复标题/多模型/覆盖拒绝；`--finish-round` 的缺 `why`、quote 不存在、id 重复、选错轮次、覆盖 `judgments.md`、控制字符/秘密文本、预算分支；`--report` 的低意见小节和 `--stop low-deferred` 一致性；`--previous`/`--base` 非祖先在花钱前失败；`buildPrompt` 固定前缀不变；runner 定义含 `omitClaudeMd`、不含 `Agent`/网络工具、`maxTurns` 有值。
- 每个反向用例要按“去掉修复后测试失败”验证，不是只测正向。子代理行为本身无法单元测试，但可以测定义文件和流程卡命令，主线程再用 `--assert-reviewed`/`--report` 兜底。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
- `--previous`：`parseArgs:2836` 产生 → `buildPrompt:368`、ledger `previous`、`coveragePoints:1273-1341`、`walkChain:1343-1369` 使用；两端现在只有“提交存在”和“链上祖先”校验，缺开跑前校验。加 `PREVIOUS_NOT_ANCESTOR`。
- `--base`：`parseArgs:2835` → 提示词 `:366`、ledger `base`、`assertReviewed` 合并基线；缺开跑前祖先校验。
- `round`：ledger/`nextRound:1821-1826` 产生 → `round-<n>` 路径、`coveragePoints`、`--report`、新命令；新命令不能再用“目录最大”推断。
- `id`：`--judge-skeleton` 产生 → `parseVerdicts:1203`、`lowFixProblems` 的 `findings`、`reviewReport:1674-1677`；必须多模型唯一且稳定。
- `model`：ledger/答案文件名产生 → `parseVerdicts` 的 `REVIEW_MODELS` 校验、答案查找、报告；`--finish-round` 必须用完整模型名找对文件。
- `quote`：`<模型>.md` 产生 → `parseVerdicts`、`lowFixProblems` 的逐字检查、报告；骨架只能摘真实存在的标题行，且要从未遮盖/已遮盖一致的那份答案取。
- `why`：新字段，verdicts 产生 → `judgments.md`；规则要求有依据，必须必填并遮盖。
- `severity`/`class`/`valid`/`trigger`/`consequence`/`modelSeverity`/`reason`：verdicts 产生 → `parseVerdicts:1186-1202`、`lowFixProblems`、`reviewReport`、`--finish-round`；新命令不能接受半填状态，低意见推迟时也要保留这些字段供报告。
- `deferred-lows.json`：新文件，`--finish-round` 产生 → `--report`/`--assert-reviewed` 使用；要定义格式、排序、遮盖，并让 `--assert-reviewed` 校验 id 仍存在且仍是 low。
- `judgments.md`：`--finish-round` 产生 → 人看，脚本不读；因此更要有 `why` 和证据，不能只靠脚本 quote 检查。
- `CLI_FLAGS`：脚本导出 → 流程卡测试使用；单一来源，避免卡和解析器漂移。
- ADR 编号：人写 → `check:adr-numbers` 和文档链接；先确认 0262 是否被未合并 PR 占用。
