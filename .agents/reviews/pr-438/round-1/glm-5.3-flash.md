# 复核结论

先说环境：当前检出的工作副本本身没有 `.agents/reviews/`（sparse checkout 只含 67% 文件），而且我的 `git show 3055686e:.agents/reviews/.../usage.jsonl` 被直接拒绝（`REVIEW_GIT_REFUSED records-path ...`）。这正是被复核的脚本自己布置的复核环境（见下文证据），因此**所有记录文件的内容我一项都没能读到**，内容级说法只能标「未核实」，我核实的是改动范围、文件名/字节数结构与脚本机制是否吻合。

## 发现（按严重度）

**1. 中 | scripts/model-review/opencode-review.mjs:2540-2542、583/595-596 | 作者的两条内容级说法复核者无法独立证实（含“没有密钥”“没有手工编辑”）**
- 证据（读代码证实）：`prepareCopy` 把整个 `.agents/reviews/` 从复核副本剔除并写 `-diff` 属性（`sparse-checkout set --no-cone /* !/${REVIEWS_DIR}/`；`/${REVIEWS_DIR}/** -diff`，2540-2542）；`checkGitArgs` 拒绝任何含 `agents/reviews` 的参数（583、595-596）。我自己跑 `git show` 就被 `REVIEW_GIT_REFUSED records-path` 拒掉，亲历证实。
- 影响：记录内容是否有密钥、是否被手工编辑过，我和另一位复核者按设计都看不到，只能靠合并门的机器检查（见第 3 条）和 Andy 抽查。
- 建议：不用改代码。让 Andy（能读记录的环境）对照 usage.jsonl 的 `promptFileSha256`/`promptSha256` 抽查一次，或确认合并时 `--assert-reviewed` 真的跑过。

**2. 低 | .agents/reviews/topic-four-features-wiring/usage.jsonl | 账本内容未核实：行数、能否过 parseUsage、与 attempt 文件的对应关系**
- 证据：读不到（同上）。代码事实：账本只要有一行非法，同 topic 下次开跑会抛 `USAGE_LEDGER_INVALID`（opencode-review.mjs:1662-1738；文档 .agents/instructions/model-review.md:131 也这么写）。round-1 deepseek 有 1 字节的 `attempt-1.md`，按机制（`keepEarlierAttempt` 1809-1824 改名旧文件；`maskedRecordText("")` = `"\n"` 恰 1 字节，2578-2580；文档 model-review.md:130“失败那次的文件改名为 `<模型>.attempt-<序号>.*`”），账本里 round-1 应有 deepseek 的失败记录行——是否如此未核实。
- 建议：作者或 Andy 确认 usage.jsonl 每行都能被 `parseUsage` 接受（重跑同 topic 一次不花钱的自检即可暴露）。

**3. 低 | .agents/reviews/topic-four-features-wiring/round-{1,2}/*.prompt.md | 两轮提示词的模型间字节数差值结构需要作者确认两轮的 `--mode`**
- 证据（字节数来自 git diff --stat，是亲自读到的；重建是推测）：round-1 deepseek 与 glm 的 prompt **同为 12153 字节**；round-2 相差 **27 字节**（13660 vs 13687）。我逐字数过 `MODEL_LENSES`（opencode-review.mjs:286-291）：glm 的侧重文本恰好比 deepseek 多 9 个汉字 = 27 字节。round-2 的 27 字节差与“带侧重”精确吻合，round-1 的 0 差与“无侧重”（mode=plan，`LENS_MODES` 不含 plan，285、293-298）吻合。代码允许同一账本跨轮换模式（`ROUND_MODE_MISMATCH` 只查同一轮，1772-1773），且“独立出方案（plan）+ 审核（plan-review）共用一本账”正是文档记载的用法（model-review.md:130）。所以最可能的解释是 round-1=plan、round-2=plan-review——但这是推测，内容读不到，无法证实。
- 建议：作者确认两轮各自的 `--mode`；若两轮同模式，这个字节数结构反而对不上，需要解释。

**4. 信息（证实，与作者说法一致的部分）**
- git diff 6e33c02..3055686 共 11 个文件，全部新增（`Bin 0 ->`），全部在 `.agents/reviews/topic-four-features-wiring/` 下，无任何代码/配置/文档/测试改动——作者“只新增记录文件”的说法成立。
- 目录短名 `four-features-wiring` 符合 `TOPIC_PATTERN`（`^[a-z][a-z0-9-]{0,62}$`，2561）。
- 1 字节的 `attempt-1.md` 与脚本失败重跑机制一致（见第 2 条），不像手工伪造的痕迹。
- 文档（model-review.md:127-132 关于记录目录、轮次、attempt、预算、账本校验）与代码逐条对得上。

## 侧重检查

走的流程：「方案讨论记录从生成到随 PR 合并」。
1. 云端线程跑 `opencode-review.mjs --topic …`：`runOne` 先遮盖再写 prompt（3257）、遮盖后写答案（3272）、`ledgerLine` 遮盖后追加账本行（2679-2681、3309）；失败重跑时 `keepEarlierAttempt` 把旧文件改名 attempt-N（3255、1809-1824）——round-1 的 1 字节 attempt 文件即此产物。
2. 复核副本剔除 reviews 目录（2540）。
3. 合并前 `assertReviewed`：`parseUsage`（1662）+ `coveragePoints`/`walkChain`（1419-1420）+ `recordSecretProblems`（1440-1446）；`record-secret-like` 不在 `OVERRIDABLE_PROBLEMS`（1303-1311）里，不可用 `--accept-unreviewed` 豁免。
4. 测试覆盖（test/tooling/opencode-review-merge-gate.test.mjs）：提交像密钥的记录→合并门报 `record-secret-like`、遮盖后放行的反向用例（642-659、695-711、713-729）；`parseUsage` 坏行抛错（2417 附近）；`keepEarlierAttempt`（2216-2227）；改 brief 重跑被 `ROUND_PROMPT_MISMATCH` 拒（2104）；`ledgerLine` 遮盖（531-555）。
5. **没有覆盖的路径**：a) “记录是否手工编辑过”没有任何检查——只有重跑同一轮时才用磁盘上的 prompt 文件或账本哈希间接校验（1783-1801）；b) 已提交记录的真实内容（包括本批 11 个文件）从未被任何测试或复核者读过；c) 侧重结论：本 diff 无代码改动，无需新测试；机制级单测是齐的，缺的是对“已提交内容”的端到端检查，而这是设计使然。

## 必答问题

1. **不会改变发给模型的内容**。本次 diff 只新增记录文件；模型收到的提示由 `buildPrompt` 每次现算（300-330），不读账本；记录目录被 sparse checkout 剔除（2540）且 git 替身拒绝读取（595-596），复核模型连旧记录都看不到。每轮会变的值（head/base、时间戳 `at`、prompt 哈希）只出现在**新增**的记录文件和当轮 prompt 末尾的材料段里；所有记录都是新文件/新行，不改旧文件——仍是只在末尾追加。亲历证据：我这次复核收到的提示结构就是脚本产物，且记录对模型不可见。
2. **本次改动没有引入新的不稳定来源**。存在的字节敏感点都是旧机制：遮盖依赖运行时登记值（`registeredTestValues` 来自 gitleaks.toml，2623-2635），同一原文在不同时间遮盖结果可不同；`at` 是写入时的时间戳（3276）。但每个值只生成一次、写入后不再变，已提交的字节是固定的；本次 diff 未改任何生成/遮盖代码。
3. **有自动检查，反向用例真实会失败**。“不得有密钥”由 `recordSecretProblems`（2697-2706）在合并门执行，测试证实：提交含假 key 的记录→`record-secret-like` 报错，遮盖后通过（merge-gate 测试 642-659），且不可豁免（713-729 证实 `--accept-unreviewed` 压不掉）。但“不改变发给模型的内容”这条约束没有直接的反向用例——它是对本次 diff 的属性而非代码行为，此 diff 无代码、无可测对象；相关机制由既有 prompt-prefix 兼容测试在产品侧覆盖，与本 diff 无关。
4. **逐值核对**：① 目录短名 `topic-four-features-wiring`：产生方符合 `TOPIC_PATTERN`（2561），消费方 `claimsProblems`/`topicLedgers` 只在新增 ADR 时扫 topic 账本（plan-claims.mjs:184-223），本 diff 未加 ADR，无影响；② `usage.jsonl` 行：消费方 `parseUsage`/`budgetCheck`/`nextRound`/`roundForRun`/`spentOf`，校验在 1662-1738——**这些具体行能否通过校验未核实**（内容读不到），其余字段的产生端（3275-3309）与消费端校验逐字段吻合；③ attempt 文件名：消费方 delegate.mjs:348-352 接受 `<stem>.attempt-<数字><后缀>`，吻合；④ `.prompt.md`/`.md` 文件名与 promptFileName（2715-2717）、maskedRecordText（2578-2580、3272）一致。唯一开口就是第 2 条：账本行的最终可解析性未核实。
