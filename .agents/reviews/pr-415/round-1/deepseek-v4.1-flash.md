## 读代码证实的

### 1. 中高 — 门槛只验证“引文真实存在”，不验证“判断正确”，模型把错误说法判成“一致”就能通过
`scripts/model-review/plan-claims.mjs:252-255`、`268-287`
- 每条 CLAIM 只做 `claimEvidenceProblem`：文件存在、行号不越界、代码引文在该文件里出现过（`133-143`、`121-131`）。不检查引文是否在第 N 行、更不检查引文是否支持这条说法。
- 安排给线程的 `model-wrong` 也一样：只要 `evidence` 是 `evidenceFile` 里任意 ≥8 个字符的真实文字，就通过（`276-284`）。线程可以用一句无关的真实代码把任何“不一致/找不到”盖掉。
- 因此 P5 那句错话，只要低价模型判成“一致”并随便引一行 `maskSensitiveTexts` 的真实代码，门槛就通过；测试只覆盖了模型“正确判成不一致”的分支（`test/tooling/plan-claims-gate.test.mjs:302-306`）。

### 2. 中 — `delegate.mjs` 接受了新 mode，但根本无法委派 plan-claims
`scripts/model-review/delegate.mjs:57`、`105-128`、`31`；`scripts/model-review/opencode-review.mjs:2858-2860`
- `validateTask` 用 `MODES.includes(task.mode)`，新 mode 加入 `MODES` 后这里会放行。
- 但 `reviewArgv` 永远拼 `--brief task.brief`，且 `COMMAND_OPTIONS` 没有 `--claims-file`；`opencode-review.mjs` 明确 `claimsMode && options.brief` 直接报 `ARG_BRIEF_NOT_FOR_PLAN_CLAIMS`，同时要求 `--claims-file`。
- 即使绕过参数问题，`delegate.mjs:31` 的 `ROUND_FILE_PATTERN` 只允许 `.md`/`.stderr.txt`，`claims-verdicts.jsonl` 会被判为 unexpected-file。
- 文档说 Mac 本地线程把复核交给 himawari-cloud（`.agents/instructions/model-review.md:21` 一带），plan-claims 没有例外说明，实际却无法委派。

### 3. 中低 — “取最晚一轮”依赖未校验的 `at`，缺失/非法时会退回第一条记录
`scripts/model-review/plan-claims.mjs:207-215`；`scripts/model-review/opencode-review.mjs:1672-1708`
- `latest` 用 `Date.parse(record.at)`；`parseUsage` 没有要求 `at` 是合法时间。全部为 `NaN` 时 `reduce` 的比较永远为假，结果取第一条，不是最晚一条。
- 同处也没有要求 plan-claims 的 `record.model` 必须是 `REVIEW_MODELS`，任意模型名 + 对应答案文件即可被当成有效记录。

### 4. 低 — 引文检查会误杀合法短引文、路径带空格，行号 0 也能过
`scripts/model-review/plan-claims.mjs:121-130`、`98-104`、`133-143`
- `quoteInText` 要求每个片段长度 ≥4，`true`、`0`、`ok`、`a=1` 这类真实短引文一律判失败；文档只说“逐字”，没有这个限制。
- `locationOf` 的 `[^\s:`]+` 不接受带空格的路径。
- `place.line > text.split("\n").length` 没有检查 `line >= 1`，`file:0` 能过。
- “找不到”且 `location` 为 `-` 时直接返回 `null`（`134`）；带 location 的“找不到”又跳过代码原文检查（`141`），和文档“每条 CLAIM（含一致）的文件:行 + 代码原文都要核”不完全一致。

### 5. 低 — stale 记录的目录不会被排除出“未复核文件”，与设计第 4 点文字不符
`scripts/model-review/plan-claims.mjs:203-206` 与 `216-228`；`scripts/model-review/opencode-review.mjs:1378-1380`
- `matching.length === 0` 时先 `continue`，`claims.files` 根本不会加入该 ADR 已有的 plan-claims 轮次目录。只有内容摘要匹配的那一轮才享受豁免；stale 时旧记录文件会被当成 PR 自己的未复核改动（虽然再跑一次后就会恢复）。

### 6. 低 — 门槛解析的是“遮盖后的答案”，引文含密钥样式文字会被判成伪造
`scripts/model-review/opencode-review.mjs:3259`；`scripts/model-review/plan-claims.mjs:245`、`141`
- 模型答案落盘走 `maskedRecordText`，把像密钥的文字换成 `[已遮盖:...]`；门槛随后 `parseClaims(answer)` 读的是这个遮盖版，再拿去和 HEAD 里的原始代码逐字比对。
- 若方案在谈论测试令牌、假密钥等代码，模型如实引用原文，存储时被遮盖，门槛报 `claims-evidence ... code-quote-not-in-file`，正常流程无法通过，只能 `--accept-unreviewed`。

### 7. 低 — 新问题字符串和 `CLAIMS_FLAGGED` 未走 `printable`，有日志注入面
`scripts/model-review/plan-claims.mjs:204,233,242,247,249,254,273,284,286`；`scripts/model-review/opencode-review.mjs:3361`
- `adr`、`short`（模型名最后一段）、`ledger.file`、`claim.location` 都是外部/提交内容；`ADR_PATH_PATTERN` 的 `[^/]+` 允许换行，模型名只排除了 `\r\n`，`location` 完全没过滤控制字符。现有代码对文件名一律用 `printable`，这里没有。

### 8. 低 — `claimsFile` 的字符集比 `ADR_PATH_PATTERN` 窄，非 ASCII/带空格的 ADR 无法被核对
`scripts/model-review/plan-claims.mjs:7-8`、`15-22`
- `ADR_PATH_PATTERN` 允许 `docs/adr/0001-中文.md`，`CLAIMS_FILE_PATTERN` 只允许 `[A-Za-z0-9._/-]`；这种新增 ADR 会触发 `claims-unchecked`，但 `--claims-file` 又过不了参数校验，除非整份 PR 用 `--accept-unreviewed`。两端校验不一致。

### 9. 低 — 提示词说“字段里不要出现竖线”，解析器却专门支持代码字段里的竖线，测试也用了
`scripts/model-review/opencode-review.mjs:279`；`scripts/model-review/plan-claims.mjs:47-51`；`test/tooling/plan-claims-gate.test.mjs:154,164`
- 方案原句里只要有 `|`（Markdown 表格、位或表达式）就会字段错位；模型若遵守“不要出现竖线”，又无法引用含 `|` 的代码。代码字段靠 `parts.slice(5).join("|")` 补救，但原句字段没有补救。

### 10. 低 — 新增的两个 fixture 没有被任何代码引用
`test/tooling/fixtures/plan-claims/plan-right.md`、`plan-wrong.md`
- 全仓库搜索不到引用；测试文件内联了自己的 `RIGHT_SENTENCE`/`WRONG_SENTENCE`。作者说“测试和 fixtures”，实际 fixtures 是死文件。

## 推测 / 未核实

- `.agents/reviews/topic-plan-claims-gate/` 里的“真实模型实测”无法核实：本环境的 git 替身对该路径返回 `REVIEW_GIT_REFUSED records-path`，所以只能看到文件和大小，读不到内容。
- `docs/lessons.md:184` 说“用真实模型实测的结果见这件事的记录目录”，按现有信息只能标“未核实”。
- `addedAdrs` 在 `git diff` 失败时会抛 `GIT_FAILED`（`plan-claims.mjs:159`），不是返回可覆盖的 `REVIEW_NOT_CURRENT`，会让 `--assert-reviewed` 直接异常退出；正常仓库很难触发，未实测。
- `blobAt` 的 256 MiB `maxBuffer`、以及对整份文件反复 `collapse`，理论上可被“引用超大文件 + 大量 CLAIM”拖慢门槛；仓库规模下影响有限，未实测。

## 侧重检查

- **错误路径**：`claimsProblems` 用 try/catch 包住 `parseUsage`，坏账本报 `claims-ledger-invalid`；`parseClaimVerdicts` 第一行坏就抛 `CLAIM_VERDICTS_INVALID`，门槛转成 `claims-verdicts-invalid`，方向是 fail-closed。`addedAdrs` 的 git 失败是唯一会抛到顶层的路径。`main` 在 claims 汇总阶段 `readFileSync` 答案文件，若 outcome 为 ok 但文件缺失会直接异常退出（现有 runOne 通常会写文件，属低概率）。
- **不可信输入**：模型答案只做位置解析；`id` 限长 40，`verdict` 白名单，路径禁止绝对路径/`..`/`.agents/reviews`，`evidence` 最少 8 字符。漏洞是“真实但无关”的引文可以满足证据检查（见问题 1），以及日志未过滤控制字符（问题 7）。
- **安全**：不上网、禁用 edit、bash 只放行几条 git 读命令；`blobAt` 用 `spawnSync` 数组参数，没有 shell。路径穿越有拦截。真正的问题是门槛的信任模型：它信任账本本身和低价模型的“一致”判断，线程可用真实代码片段伪造 `model-wrong` 证据。
- **资源耗尽**：没有对 CLAIM 数量、引用文件大小设上限；大文件 + 多条 CLAIM 会放大 `split`/`collapse` 成本。影响开发门槛，不是生产路径。
- **不可撤销操作**：`--assert-reviewed` 本身只读；`--accept-unreviewed` 仍是追加 override 记录，没有新增不可撤销动作。
- **规则/文档一致性**：`AGENTS.md` 与 `.agents/instructions/model-review.md` 的“只新增 ADR、只改已有 ADR 不受影响、claims- 可覆盖”与代码一致；但“每条（含一致）都要文件:行 + 代码原文”“记录目录不计入未复核”“取最晚一轮”三处表述比实现强（问题 4、5、3）。Himawari 侧的结论“不改变发给 Himawari 的内容”成立。

## 必答问题

1. **不会改变 Himawari 已经见过的请求开头。** 改动只在 `scripts/model-review/*` 和开发文档；`buildPrompt` 对 `code-review`/`plan`/`plan-review` 的输出未变（`questions` 对现有调用始终非空，`OFFLINE_MODES` 对 `code-review` 等价，见 `opencode-review.mjs:304-328`）。新 `plan-claims` 是“固定说明在前、材料在后”，`head`、方案内容等每轮会变的值都在最后追加的材料里，符合“只在末尾追加、变化值放最后”的规则。

2. **不会。** `recordText` 只做确定性的换行/行尾空格归一（`2572-2574`）；plan-claims 的提示词没有时间戳，`head` 和方案正文在末尾；`claimsSha256` 是确定性的 SHA-256；`files`/`topicLedgers` 的顺序来自 git，固定；`maskSecretLike` 只作用于落盘文件（`3244`、`3259`），不改变发给模型的字节。唯一按时间变化的是 usage 里的 `at`，它不进入模型输入。

3. **有自动检查，反向用例确实覆盖了主要错误路径，但实际运行路径有缺口。** `test/tooling/plan-claims-gate.test.mjs` 会被 `ci/policy.json` 的 tooling 项目按 `test/tooling/**/*.test.mjs` 收集，CI 的 policy/coverage 会跑；反向用例覆盖了无记录、stale、伪造引文、文件/行不存在、无 CLAIM、最近一轮失败、`--accept-unreviewed`、无新增 ADR、只改已有 ADR。未运行验证（只读限制）。缺口：`main` 的 plan-claims 真实运行路径（读提交里的 blob、写 `claimsFile`/`claimsSha256`、`CLAIMS_FILE_NOT_COMMITTED`、解析失败退出码 4）没有端到端测试；两个新增 fixture 未被引用；也没有“错误说法被判成一致时门槛应失败”的反向用例——因为当前实现确实不会失败（见问题 1）。

4. **不是每个值都被两端完整校验。**
   - 通过的：`"plan-claims"` 已加入 `MODES`/`OFFLINE_MODES`/`ASK_FIRST_LINE_USD`/`MODE_TEXT`；`claimsFile`/`claimsSha256` 在 `parseUsage` 有格式校验；所有新问题都以 `claims-` 开头，能命中 `OVERRIDABLE_PROBLEMS`。
   - 不通过的：`delegate.mjs` 接受 mode 但拼不出合法参数（问题 2）；`claimsFile` 字符集与 `ADR_PATH_PATTERN` 不一致（问题 8）；`at` 和 `model` 没有被 `parseUsage` 对 plan-claims 收紧（问题 3）；`claims.files` 只在摘要匹配时生成，stale 时与设计文字不一致（问题 5）。另外，账本记录没有绑定“该次运行时的 head 是 HEAD 祖先”，只信任提交在 HEAD 的账本，这是现有复核门槛共同的信任模型，不是本次独有。
