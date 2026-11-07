你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 b454ed99ea1003e1b74e616cd8fc62b1a0860824。
对比基准是 ba915c214119b044e105ecfe617d2d98c100db27，先运行 git diff ba915c214119b044e105ecfe617d2d98c100db27..b454ed99ea1003e1b74e616cd8fc62b1a0860824 看改动。
上一轮复核到 830b565d2ab26cad6979414c35c0e8f5eaed22e7，先看 git diff 830b565d2ab26cad6979414c35c0e8f5eaed22e7..b454ed99ea1003e1b74e616cd8fc62b1a0860824 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
问题：合并前的代码复核每轮两个模型各看一遍，PR #255 复核 6 轮花了约 0.79 美元。另外 OpenCode 服务满载（HTTP 429）时，脚本把结果记成 no-text，看不出是服务的问题。

目标（Andy 2026-11-06 同意）：
1. 代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek；DeepSeek 遇到可以重试的服务报错时，脚本自己再整轮重跑一次，第 2 轮起还不行就让 GLM 替补。
2. “会出错”的意见分中高和低两档。低档的修改够小（不超过 5 个文件、每个文件不超过 30 行、带测试改动，只改 .md 的除外）时，用 --assert-reviewed --accept-low 记进账本，不再复核。
3. 合并前检查（--assert-reviewed）和 --report 都要认这两种新情况，同时不能被绕过：例如改写提交历史后只补一轮单模型复核，或手写一条 low-fix 记录。

约束：只改 scripts/model-review/opencode-review.mjs、它的测试、规则文件 .agents/instructions/model-review.md、AGENTS.md、新 ADR 0174、ADR 0068 的 amended_by、案例库和方案文件。不能改变复核模型已经见过的提示词开头的写法规则：同一个模型每轮提示词在“本次材料”之前必须逐字节相同。

作者的说法（请逐条对照代码核对）：
- summarizeEvents 认出 type:"error" 事件，outcome 记 api-error；apiErrorOf 去掉控制字符、截到 300 字；isRetryable 为 true 或带 retry-after 时算可重试。
- reviewModel 在可重试的服务报错后等 60 秒（retryWaitMs）再调用一次 reviewOnce；两次的费用相加，第二次的上限是 0.2 美元减去第一次的花费；钱不到 0.07 美元或时间不够时不重试，记 retry 的原因。
- substituteFor 只在 code-review、传了 --previous、只跑 DeepSeek、DeepSeek 结果是可重试的 api-error 时返回 GLM；替补前重新做 budgetCheck。
- parseArgs：code-review 不传 --previous 也不传 --round 时必须两个模型；传了 --previous 不写 --models 时只跑 DeepSeek。
- coveragePoints 从 lastCompleteRound 起，把之后 DeepSeek ok 或替补 GLM ok 的轮次、以及 low-fix 记录串成一条链；assertReviewed 要求每一点的提交是前一点的后续，low-fix 点的 from 等于前一点的提交，并对 low-fix 点重新跑 lowFixProblems。
- lowFixProblems 核对 verdicts.jsonl 已提交、格式对、原话逐字出现在 round-<n>/<模型>.md、成立的 error 全是 low 且至少一条、规模上限和测试改动。
- parseUsage 严格校验 low-fix 记录；nextRound、roundForRun 不把它算一轮；--report 单列“低严重度已改、未复核”。
- 测试在 test/tooling/opencode-review.test.mjs，140 条全过；npm run check 和 npm run build 通过。

第 2 轮：上一轮复核到 830b565d，之后的提交按上一轮的意见修改了（本轮只看这些修改是否正确、有没有引入新问题，也可以读任何文件）：
- verdicts.jsonl 里重复的 id 以 VERDICTS_INVALID 拒收。
- 复核链改成 walkChain 按轮次顺序接：不带 --previous 的双模型轮重新起头；其余每一点的 previous 必须是前一点的提交或更早的提交，复核的提交必须是前一点的后续；没有 previous 的单模型轮接不上。
- substituteFor 只在 review.retry 为 "retried" 时替补。
- lowFixProblems 从 low-fix 记录自己的提交（to）读 verdicts 和模型答案；合并前检查还核对记录里的 files、findings 和重算的一致。
- 空的 retry-after 头不再算可重试；--accept-low 被拒时退出码 5。
- 规则文件、AGENTS.md、ADR 0174 的措辞相应修改。
