# 代码复核报告

基准 ba915c21 → 检出 830b565d。以下所有行号均以检出 HEAD 的文件为准，全部为「读代码证实的」，未标注「推测」的不要当成猜测。

## 侧重检查

**走过的流程：第 2 轮代码复核（`--previous`）从入口到结束**——`parseArgs`（1947-2084，有测试）→ `resolveCommits`（测试有覆盖）→ `buildPrompt`（测试有覆盖，且单测逐字节比对固定段）→ `budgetCheck`/`roundForRun`（测试有覆盖）→ 自检和副本准备（本次未改）→ `runOne` → `reviewModel`（429 重试有脚本化真实 opencode 测试）→ 记账（**此段组装逻辑仅在 runOne 内，无端到端测试**）→ `substituteFor` → `budgetCheck`（替补前）→ 替补运行 → 退出码判定。

**没有测试覆盖的代码路径**（证据：在 test/tooling/opencode-review.test.mjs 全文检索 `REVIEW_SUBSTITUTE` 和 `process.exitCode` 均无结果）：
1. main() 里替补整套流程：`REVIEW_SUBSTITUTE` / `REVIEW_SUBSTITUTE_SKIPPED` 两行打印、替补的 buildPrompt/预算拒绝（scripts/model-review/opencode-review.mjs:2234-2260）——`substituteFor`、`budgetCheck` 各自有单测，但组装走不到测试里。
2. 退出码 4 的「covered」判定（2267-2273）：`covered && record.model === results[0].model` 这句效果——替补成功时豁免 DeepSeek 失败——没有反向用例验证「GLM 替补失败时仍退出 4」。
3. 记账组装（runOne 2205-2229）：`apiError`/`retry`/`retriedAfter`/`substitute` 字段写入账本后的 parseUsage 兼容性靠测试 fixture 与代码互证，未直接走 runOne。

**文档与代码一致性**：`.agents/instructions/model-review.md`、AGENTS.md、ADR 0174、ADR 0068 的 amended_by、案例库 84 我逐条对照过实现，除下文「低 4」一处流程空缺外均一致。规则文件第 3 步「替补前按第 4 步的先问门槛重新核对」对应 2246-2251 的 budgetCheck，属实。

## 发现的问题

---

**【中】scripts/model-review/opencode-review.mjs:1361-1375 — 「同一模型每轮提示词在『本次材料』之前逐字节相同」这条约束没有跨轮的运行时自动检查**

- 问题：promptSha256 记进账本（2213）但只在同一轮用 `--round` 重跑时比对（`roundForRun`，1361-1375）；开启新一轮（`options.round === undefined`）时 `promptOnDisk` 返回 null（2122-2126，`if (options.round === undefined) return null`），没有任何代码比对本轮与上轮提示词的固定段。若脚本在同一个 PR 的第 1 轮和第 2 轮之间被改动（或未提交改动直接跑第 2 轮），DeepSeek 第 2 轮的请求开头和第 1 轮不同，KV 缓存全部 miss，没有任何检查报错——只有账本里两行不同的 sha256，无人比对。
- 证据：2122-2126（`promptOnDisk(model) { if (options.round === undefined) return null; ... }`）、1368-1374（仅 `--round` 时比对）；反向用例只有单元测试 `[review chain] gives DeepSeek the same fixed prompt...`（test/tooling/opencode-review.test.mjs），没有运行时门槛。这和本项目「每个事故落一道自动检查」的惯例以及目标 3「不能被绕过」的要求不一致。
- 建议：跑复核时把固定段（`buildPrompt` 里 `---- 本次材料 ----` 之前的部分）的摘要也记进账本，并让 `assertReviewed` 的链检查对同模型相邻两点的固定段摘要做比对；或至少在 `prompts[model]` 组装后立即与 `roundsOnDisk` 中该模型上一轮 prompt 文件的开头逐字节比对，不一致即以 `PROMPT_PREFIX_CHANGED` 拒绝。

---

**【低】scripts/model-review/opencode-review.mjs:1020-1021 — `REVIEW_ROUND_HEADS_DIFFER` 从 `assertReviewed` 直抛，合并门前以退出码 2 崩溃而非按 `REVIEW_NOT_CURRENT` 报告**

- 问题：`coveragePoints` 在同一轮的 ok 记录 head 不一时 `throw new Error(...)`，`assertReviewed`（1056）不捕获，`main()` 的 catch（2281-2285）直接打印并以 2 退出。绕过者改写提交历史后伪造账本时得到的是崩溃而不是列明原因的拒绝。
- 证据：1020-1021 `throw new Error("REVIEW_ROUND_HEADS_DIFFER ...")`；`assertReviewed` 内无 try；此行为沿袭改动前的 `lastCompleteRound`（880-894），不是本次新引入。
- 建议：把 `coveragePoints` 的 throw 转成 problems 中的一个条目，走既有 `REVIEW_NOT_CURRENT` 通道。

---

**【低】scripts/model-review/opencode-review.mjs:1010-1016 — 用 `--round` 手动重跑替补模型（GLM）成功后，该轮不被复核链承认，钱白花、门失败关闭**

- 问题：替补效果只在 `record.substitute === true && record.substituteFor === REVIEW_MODELS[0]` 时成立（1013-1016）。若脚本替补前被判超预算（`REVIEW_SUBSTITUTE_SKIPPED`，2252），线程随后手动 `--round n --models glm-5.3-flash`（parseArgs 允许，测试 2066 证实）把 GLM 跑好了，账本里这条 ok 记录没有 `substitute` 标志，`coveragePoints` 不把它当链上一点，门继续报 `unreviewed`。
- 证据：1010-1016；2252 `REVIEW_SUBSTITUTE_SKIPPED` 分支后续无任何补救；规则文件第 6 步只写了「DeepSeek 是 ok、或替补的 GLM 是 ok」两种链上情况。
- 属失败关闭（不是绕过），但与目标 1「DeepSeek 不行就让 GLM 替补」的实际可操作路径有落差；文档也没写这种手动重跑会被浪费。
- 建议：让 `--round` 手动补跑的 GLM 也带上 `substitute: true, substituteFor: REVIEW_MODELS[0]`（或放宽 `coveragePoints` 的认定），并在规则文件写明这条路径。

---

**【低】scripts/model-review/opencode-review.mjs:980-993 — low-fix 规模核对把二进制/纯删除文件按无穷行计，误伤会触发 `too-many-lines`**

- 问题：numstat 对二进制文件输出 `-`，`match[1] === "-" ? Infinity : ...`（983），`Infinity > 30` 即报 `too-many-lines`。「只改 `.md` 的除外」用 `endsWith(".md")` 判（994），若修复含一张 `.png` 或一个二进制文档，即使只有 5 个文件也会被拒绝（`invalid file with "-"`，包括被 `git rm -f` 删掉的文件）。
- 证据：980-993、测试未覆盖二进制路径。
- 建议：删除的文件行数为 0（不计行数上限），二进制文件单独按「文件数」限制；或仅对进账本的修复排除二进制。

---

**【低】scripts/model-review/opencode-review.mjs:970、1223-1226 — verdicts 的 `id` 不要求唯一，报告按 id 反查取第一条**

- 问题：`lowFixProblems`（974/975）与 accept-low 的 `findings`（1155）都以 `id` 串列、逐字核对 quote；两条意见允许同 `id`（`parseVerdicts` 909-943 无唯一性检查）。`--report` 反查 `verdicts.find(item => item.id === id)`（1225）在重复 id 时展示错那条的原话，抽查会误导。
- 建议：`parseVerdicts` 对重复 id 报 `VERDICTS_INVALID`。

---

**【低】scripts/model-review/opencode-review.mjs:2221-2223 — 重跑记录的 `retriedAfter` 记第一次的错误，第二次的 `apiError` 覆盖占主体，其一致性靠约定而不是校验**

- 问题：`reviewModel` 重跑后 `summary: { ...second.summary, usage }`（761），`summary.apiError` 因此只是第二次 attempt 的错误；若第二次 outcome 为 no-text（无 error 事件），记录里 `retry: "retried"`、`retriedAfter` 有值但 `apiError` 缺失。校验端（parseUsage 1260-1318）对 `apiError`、`retry`、`retriedAfter` 三个字段完全不校验（是自由字符串+单行检查）。说出去的信息与账本能对上，但没有机器校验三者的触发条件（例如 `retry: "no-budget"` 必须伴随 `apiError`）。作者说法「记 retry 的原因」逐字符属实，属记录性而非漏洞。
- 建议：parseUsage 对 `retry` 字段增加枚举与伴随字段约束（retried/no-budget/no-time/cost-unknown，no-budget/no-time 必须有 apiError）。

---

**【低·推测】.agents/reviews/ 目录内容（含 PR #255 的 0.434/0.355/56%/58% 数字）无法核实**：稀疏签出未包含 `.agents/reviews/`，git show 被本仓库的 git 守卫（REVIEW_GIT_REFUSED）拦截，ADR 0174「每轮费用」「DeepSeek 0.434、其中 56% 花在思考」「合计 0.79 美元」等只依据账本的结论我无法独立核对。另外：测试 140 条、`npm run check`/`npm run build` 通过的说法也无法在此环境执行验证——已核对测试文件确有与上述说法逐一对应的用例（含反向用例，见必答 3）。

## 读代码逐条证实作者的说法（除上面未核实的几条）

- summarizeEvents 认 `type:"error"`、outcome `api-error`、变体优先于 truncated/no-text：271、297-298 ✓；apiErrorOf 控制字符替换、`slice(0, 300)`、isRetryable / retry-after(-ms)：228-247 与真实捕获 fixture（test/tooling/fixtures/opencode-review/deepseek-429-events.jsonl 中 `error.data.statusCode/isRetryable/responseHeaders.retry-after[-ms]`）吻合 ✓。
- reviewModel 等 60 秒（`API_ERROR_RETRY_WAIT_MS=60000`，705/744）、整轮重跑、费用相加 753、第二次上限 `0.2 - firstCost`（736+749+781，`COST_LIMIT_PER_MODEL_USD=0.2`）、钱不够判线 0.05+0.02=0.07（724，常量 67/69）✓；原因记 no-budget/no-time/cost-unknown（723-725、2222）✓。
- substituteFor 四个前置条件与代码一致（712-718）；替补前 budgetCheck+提示词大小（2243-2251）✓。
- parseArgs：第 1 轮必须两模型（2064-2067）、`--previous` 不带 `--models` 默认只 DeepSeek（2068）✓。
- coveragePoints 从 lastCompleteRound 起串链（1000-1037），按时序连粉丝、low-fix 的 `from === 前一点 head`（1064），low-fix 点重跑 lowFixProblems（1068-1076）✓。
- lowFixProblems 六项核对（verdicts 已提交 954、格式 958、原话逐字 969、全部 low 且至少一条 972-975、规模 987-996、测试/`.md` 除外 995）✓；parseUsage low-fix 严格校验（1287-1297）✓；nextRound/roundForRun 用 NOTE_MODES 排除（1328-1352）✓；--report 单列低档段（1233、1215-1228）✓。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
还不算违反规则。本次唯一动到提示词前缀的是 DeepSeek 的固定侧重文案（178-184，加了一句「……以及规则文件、说明文档和代码是否一致」），它由 `buildPrompt` 193-222 从「本次材料」之前的数组生成，第 1 轮起每轮逐字节相同（测试 3150 有逐字节断言）；每轮会变的 head/base/previous/brief 全部排在 `---- 本次材料 ----` 之后（209-221）。重跑的请求和第一次字节相同（测试断言 `requests[6].messages` 等于 `requests[0].messages`）；替补 GLM 是全新对话。遮盖与尾部追加机制本次未动。但「跨轮自动检查」缺失（上面【中】），前缀一旦因脚本被改动而漂移，只有单测运气能兜住，运行时无人拦截。

**2. 会不会同一段文字在不同请求里变成不同字节？**
不会。没新增上下文相关的遮盖；提示词固定段不含时间、路径或运行值；`coveragePoints` 对 Set/排序全部显式 `sort`（1006-1007）且输出只进控制台/账本；带时间戳和服务器错误文本的字段（`at`、`apiError`、`retriedAfter`）只写入账本记录、不回发模型，且控制字符已清（228-247），保证 parseUsage 的单行检查不会被破坏。

**3. 有没有对应的自动检查？反向用例会失败吗？**
大多数有：retry（等 60 秒/合费用/不重试原因）、替补前置条件（含 GLM 自身、plan-review、双模型、非 previous 七组反向用例）、pick链（chain-broken 重写历史的反向用例、「报告接受 DeepSeek 单轮/拒绝失败轮」）、低档放行（not-low/no-test-change/too-many-files/too-many-lines/quote-not-found/no-low-errors/not-last-round/verdicts-not-committed，且反向用例都断言写账本前 `REVIEW_LOW_FIX_REFUSED` 被打回、账本不含 low-fix 行——我核对过这些期望串与实现产出的字符串一致）、hand-written low-fix 在门上被重查（测试 `[low fix] checks a hand-written low-fix record again at the gate` 预期 `low-fix-invalid ... no-test-change`）。缺口：跨轮提示词前缀（【中】）、main() 的替补/退出码路径（【低 3】）、`npm run check`/140 条全过未核实（无法运行）。

**4. 每个新值的两端都核对过吗？**
逐一核对：`outcome:"api-error"`（substituteFor、退出码、coveragePoints、resultLine、账本格式）✓；`apiError`/`retry`/`retriedAfter`（仅展示用途，parseUsage 不校验自由字段，见【低 6】）✓ 性质上能过校验；`substitute`/`substituteFor`（coveragePoints 严格匹配 + 七组反向用例）✓；`mode:"low-fix"` 及其字段（parseUsage、coveragePoints、assertReviewed 重查、report、nextRound/roundForRun、spentOf：cost 0）✓；`--accept-low`（ASSERT_OPTIONS、被 --report 以 ARG_NOT_FOR_SUBCOMMAND 拒绝、与 --accept-unreviewed 互斥）✓；verdicts.jsonl 各字段（parseVerdicts 完全对齐规则文件第 3 步的说明，`severity` 仅对成立的「会出错」必填，与规则字面一致；thread 降判要求 reason 的实现与规则吻合）✓。无 I-73 式「清单 id 过不了后端校验」这类两端不一致；最接近的两处是【低】1、2、4：链承认的替补标志只在自动替补时打上（手动 `--round` 补跑 GLM 不计）、verdict id 不唯一、low-fix 大小上限对二进制文件误判。
