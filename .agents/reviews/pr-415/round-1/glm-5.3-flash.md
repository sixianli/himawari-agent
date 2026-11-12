# 复核报告：`--mode plan-claims` 与合并门槛（2267d02b）

## 读代码证实的问题（按严重度从高到低）

**1. 中｜scripts/model-review/plan-claims.mjs:179-291 + .agents/instructions/model-review.md（plan-claims 第 5 条）｜“引用的代码后来改了也要重核”没有实现——过期判定只绑 ADR 自身的 SHA，代码变化不触发重核**
证据：`claimsProblems` 里过期判定只有一条链：`const sha = blobSha256(repo, head, adr)`，`const own = records.filter((record) => record.claimsFile === adr)`，`matching = own.filter((record) => record.claimsSha256 === sha)`（plan-claims.mjs:196-198）。记录里的 `head` 字段（运行时写进账本，opencode-review.mjs:3267）在门槛里完全没被读。文档写“核对用的是 HEAD 里的代码，引用的代码后来改了也要重核”，实现里唯一强制的是：引文逐字（空白不计）仍出现在 HEAD 文件里、行号不越界（plan-claims.mjs:133-141）。如果被引用的代码改了语义但原文那几行还在，或者说法针对的是没被引用的代码，`一致` 判定照旧通过。
建议：要么把门槛的过期条件改成“记录的 `head` 不是 HEAD 的祖先（或被引用文件的最新提交晚于记录）就报 stale”，要么把文档这句改成如实的弱保证：“核对的是 HEAD 里的引文是否逐字存在；说法的真假以记录那次运行时的代码为准”。

**2. 中｜plan-claims.mjs:179-291、opencode-review.mjs:1706-1708｜整条 claims 记录可以不跑模型、完全手写，门槛无法区分**
证据：门槛只读 HEAD 里的三类文件并解析格式：`topicLedgers` 列出的 `usage.jsonl`（`parseUsage` 只校验字段格式）、`round-N/<模型>.md`（`parseClaims`）、`claims-verdicts.jsonl`（`parseClaimVerdicts`）。记录里存了 `promptSha256`/`promptFileSha256`（opencode-review.mjs:3270-3271），但门槛从不与 round 目录里的 `.prompt.md` 比对，也不做任何“这次运行真实发生”的验证。一个线程可以手写 `usage.jsonl` 记录、答案文件和 verdicts，只要答案里的引文逐字存在于 HEAD，`claims-unchecked` 就变成通过。作者的“已知局限”只写了“模型可能漏列说法”，没有写这一条。
建议：至少在文档局限一节如实写明“记录是自报的，门槛验证的是格式和引文，不是运行真实发生过”；更强的做法是让 `--assert-reviewed` 顺手核对记录里的 `promptFileSha256` 与 round 目录里 `.prompt.md` 的哈希一致（能挡住最粗糙的手写）。

**3. 低｜plan-claims.mjs:121-131｜引文片段最短 4 个字符的隐藏阈值，会把真实但很短的引文误拒；与 verdict 证据的 8 字符线不一致**
证据：`quoteInText` 要求 `fragments.every((fragment) => fragment.length >= 4 && haystack.includes(fragment))`。代码引文 collapse 后不足 4 字符（如 `x: 1`）即使逐字存在也判 `code-quote-not-in-file`；而 `model-wrong` 的 evidence 用的是另一条线 `collapse(verdict.evidence).length < EVIDENCE_MIN_CHARS`（8，plan-claims.mjs:26、261-263）。文档只写“逐字（空白不计，可用 … 省略）”，没写 4/8 的下限。fail-closed，但会造成难排查的假阻塞。
建议：文档补一句，或把阈值统一并写进 `CLAIMS_LINE_FORMAT` 的说明里。

**4. 低｜plan-claims.mjs:98-101、140｜行号 0 不会被拒**
证据：`locationOf` 的正则 `/^`?([^\s:`]+):(\d+)/` 接受 `:0`；越界判定只有 `place.line > text.split("\n").length`，没有 `>= 1` 下界。`file.ts:0` 能通过“行号在文件里”的检查（一致/不一致仍受引文检查兜底，`找不到` 则完全放行）。
建议：`place.line < 1` 也返回 `location-line-out-of-range`。

**5. 低｜plan-claims.mjs:41-63｜CLAIM 行字段里出现竖线不会报 malformed，而是静默错位**
证据：`parts = line.split("|")`，`code = parts.slice(5).join("|")`。提示要求“字段里不要出现竖线字符”，但没有校验：若“方案原句”里含 `|`（方案里常见的表格行），第 5 段之后全部错位，`code` 会混入句子尾巴。多数情况引文匹配失败 → fail-closed，但可能把句子的后半截当引文“碰巧”匹配进文件。测试 `plan-claims-gate.test.mjs:154-164` 恰好把“字段含竖线”当成合法行为（`expect(claims[1].code).toBe("x | y")`），即作者有意允许，风险留给了匹配。
建议：对第 2-5 段禁止 `|`（报 malformed），只允许 code 段含 `|`。

**6. 低｜opencode-review.mjs:304-315｜plan-claims 的提示里仍插入 RULE_16_SENTENCE，与该模式“只核对事实，不评价方案，不提建议”的任务文字相抵**
证据：`buildPrompt` 的 fixed 数组对所有模式无条件插入 `RULE_16_SENTENCE`（“列出的方案只是参考，请从问题本身出发，提出你认为更好的方案”，opencode-review.mjs:308-309），而 plan-claims 的 task 写“只核对事实，不评价方案好不好，不提建议”（opencode-review.mjs:283）。同一份提示自相矛盾，可能诱导模型给建议、少列说法。
建议：plan-claims 模式跳过 RULE_16_SENTENCE（如同跳过必答问题）。

**7. 低｜文档与实现的四处小出入**
- `.agents/instructions/model-review.md`（plan-claims 第 3 条）：“模型的答案一条都解析不出来，打印 CLAIMS_PARSE_FAILED”——实现是 `claims.length === 0 || problems.length > 0` 即打印（opencode-review.mjs:3362-3365），部分坏行也打印（更严，方向安全，但文字不准）。
- 同条“序号从 1 起，不重复”：实现只校验不重复（`CLAIM_ID_PATTERN` 任意 `[A-Za-z0-9._-]{1,40}`），不校验从 1 起或连续。
- 同文件“怎么跑”一节：“三种复核模式（代码复核、`plan`、`plan-review`）都可以加 --gateway magpie…”——plan-claims 是第四种模式且同样接受这些参数（该节上面的 plan-claims 示例自己就带了 `--gateway magpie`），文字未更新。
- `parseClaimVerdicts`（plan-claims.mjs:66-96）：同一 `(model, id)` 既写 `plan-fixed` 又写 `model-wrong` 会让整个 verdicts 文件以 `CLAIM_VERDICTS_INVALID` 报废（fail-closed），文档没写这种组合非法。

**8. 低｜test/tooling/fixtures/plan-claims/plan-right.md、plan-wrong.md｜没有任何自动测试引用**
证据：`grep "fixtures/plan-claims"` 在 test/ 下无命中；测试全部自建字符串。这两个文件只服务于已提交的实测记录（lessons.md 提到的真实模型跑）。plan-wrong.md 的反向内容因此没有绑定进自动用例。

**9. 低（推测，边缘）｜opencode-review.mjs:3259 + plan-claims.mjs:133-141、261-264｜答案文件经 `maskedRecordText` 写盘，遮盖可能破坏引文导致误报**
证据：答案以 `maskedRecordText(summary.text)` 写入（opencode-review.mjs:3259），而门槛拿这份已遮盖的答案做 `quoteInText(claim.code, HEAD原文)` 和 verdict `quote` 比对。若模型引文恰好命中“像密钥的文字”规则或注册测试值（`registerTestValuesFromRefs`，opencode-review.mjs:3108），引文在答案里变成 `[已遮盖:…]`，比对失败 → `claims-evidence`/`claims-verdict-quote`。fail-closed，但属可用性风险；实际触发条件罕见。

**10. 信息｜opencode-review.mjs:1167-1223｜`lowFixProblems` 新增的 `skip` 同时影响返回的 `files` 列表**
证据：`skip?.has(match[3])` 的 continue 在构建 `changes` 的循环里，`files: changes.map(...)` 也随之排除。若某次 low-fix 的变更清单里包含后来才生成的 claims 记录文件，`lowFixCheck` 的 `sameList(point.files, check.files…)` 会误报 `files-differ`。极边缘，fail-closed。

## 侧重检查

走了一遍普通流程：线程提交方案/ADR → `--mode plan-claims --head <提交> --topic <短名> --claims-file <路径>`（parseArgs 校验 2857-2880；main 读 `--head` 提交里的文件字节 3109-3118，构造 brief 并禁 --brief 3124-3128）→ `buildPrompt`（新 MODE_TEXT，300-329，无必答问题）→ `reviewConfig`/`expectedTools` 关网（OFFLINE_MODES，181-233）→ 跑模型、答案和账本写进 `.agents/reviews/topic-<短名>/round-N/`（3240-3307）→ 打印 `CLAIMS_SUMMARY`/`CLAIMS_FLAGGED`/`CLAIMS_PARSE_FAILED`（3351-3367）→ 线程改方案重跑或写 `claims-verdicts.jsonl` → 合并时 `--assert-reviewed` 走 `claimsProblems`（1366-1444、plan-claims.mjs:179-291），claims 记录目录从“PR 自己的未复核改动”里豁免但仍做密钥文字检查（1378-1380、1437-1444）。

结论：流程主链路存在且自洽、fail-closed。没有自动测试覆盖的路径：main() 的 plan-claims 分支（blob 读取、brief 构造、claimsRecord 写账本、3351-3367 的输出块）、`lowFixProblems` 的 `skip` 参数（测试夹具没有 low-fix 记录）、合并门测试缺 `claims-answer-invalid`、`claims-verdicts-invalid`、`claims-ledger-invalid`、多模型（glm）记录的用例——`parseClaims`/`parseClaimVerdicts` 的解析有单测，但这些问题码在门槛级的端到端用例里缺席。文档与代码总体一致（各问题码、豁免、覆盖、0.5 美元先问线、默认 DeepSeek 均核对相符）；不符处见第 1、7 条。docs/incidents-and-gates.md 未加行是符合 `.claude/rules/incident-gates.md` 的（“只有当这类错误造成了事故时，才在这里加一行”），教训记在 lessons.md 正确。已提交的实测记录 `.agents/reviews/topic-plan-claims-gate/**` 内容被仓库守卫拒绝读取（`git show` 返回 `REVIEW_GIT_REFUSED records-path`），未核实。

## 必答问题逐条回答

1. **不改变。** 本改动只触及 `scripts/model-review`、三份文档和测试；产品提示源（`packages/`、`apps/`，含系统提示、工具定义、历史消息、遮盖逻辑）一字未动。对既有三种复核模式，`reviewConfig`/`expectedTools`/`buildPrompt` 的输出逐字节不变（`OFFLINE_MODES = ["code-review", "plan-claims"]`；`questions` 对这些模式恒非空，`reviewQuestions` 空时抛错）；plan-claims 是全新模式，其请求也是每次一次性构造、无会话历史。发给模型的内容仍只在末尾构造材料段，每轮会变的值（提交哈希、方案内容）都在最后的材料里。
2. **不会。** 提示内容由 `--head` 提交里的字节决定（文件内容 + 提交哈希），无时间戳、无遮盖依赖、无无序集合进入提示；记录里的 `at` 只进账本。门槛对同一 HEAD 是确定性的：SHA-256 匹配 + 对已提交内容的纯解析；“最晚一轮”的选择依据是账本里已提交的 `at`/顺序字段，同 HEAD 下结果唯一。
3. **有，且反向用例写的是失败断言。** `test/tooling/plan-claims-gate.test.mjs` 属于 vitest tooling 项目（`ci/policy.json:193-194` 的 include 覆盖 `test/tooling/**/*.test.mjs`），覆盖 claims-unchecked、claims-stale、claims-unjudged、claims-verdict-evidence、claims-evidence 三种原因、claims-none、claims-run-failed、重复 id、伪造引文、命令行退出码 5/0，以及 Andy 覆盖。我读到的断言都是“这些问题出现才通过”，但**没有实际运行测试**（工具受限），反向用例真的会失败这一点是未核实的执行结论；另见侧重检查里列出的覆盖缺口。
4. **逐值核对结果：** `--claims-file`（parseArgs:2756-2758 用 `validClaimsFile` 校验 → 用作 blob 读取、brief、记录字段；门槛端按字符串全等匹配 ADR 路径，不匹配即 fail-closed 报 unchecked/stale）；`claimsFile`/`claimsSha256` 记录字段（parseUsage:1706-1708 校验格式，缺失即整本账本 `USAGE_LEDGER_INVALID`；claimsProblems 消费）；`mode "plan-claims"`（MODES、OFFLINE_MODES、ASK_FIRST_LINE_USD、MODE_TEXT、buildPrompt、expectedTools 全部接上；`lensFor` 不适用、`coveragePoints` 只认 code-review 不受污染）；`skip`/`claimsOwned`（`lowFixProblems` 可选参数，三处调用点 1385/1396/1492 都已传）；`OVERRIDABLE_PROBLEMS` 的 `"claims-"` 前缀覆盖全部 claims 问题码，与文档一致。两端校验核对中发现的实质不一致只有第 1 条（文档承诺的“引用代码改了要重核”没有对应实现）。I-73 的教训（要问“值能通过另一端校验吗”）这次大体被遵守了，但第 2 条说明“这一步发生过”本身仍是无凭据的自报。
