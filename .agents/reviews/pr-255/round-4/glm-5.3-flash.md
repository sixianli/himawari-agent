现在我来核查一下完整的 PR 范围（这些文件在基准与 HEAD 之间是否发生了变更），并读取关键的源码部分。
我的副本中的 git shim 阻止了我读取记录路径（该功能本身运行正常——证实了防护措施的存在）。让我来阅读一下主要的流程。
## 侧重检查

我走了一条最普通的使用流程（代码复核从入口到结束），按执行顺序核对每一步在 `test/tooling/opencode-review.test.mjs` 里有没有覆盖（读到的段落不逐一列出，只列路径与结论）：

1. `parseArgs`（scripts/model-review/opencode-review.mjs:1573-1671）— 参数校验都有用例（含负例）。
2. `resolveCommits` — 仅是 `rev-parse` 包装，未见专门用例；被整链路跑测间接经过，风险低。
3. `reviewQuestions` / `questionsSource`（:136-147、:1477-1482）— 有覆盖：第 4 条必答问题断言在 test:213-214，从 base 提交读问题在 test:1145-1163。
4. `buildPrompt` / `MODEL_LENSES`（:193-222、:178-191）— 有覆盖：两模型侧重互斥、位置在「本次材料」之前（test:219-244）。
5. `proxyCredentialProblems`（:425-429）— 有覆盖含新负例（test:2434-2440）。
6. `readUsage` / `parseUsage` / `budgetCheck` — 有覆盖（test:2247-2269、2200+）。
7. `roundForRun` / `nextRound` / `roundsOnDisk` / `keepEarlierAttempt` — 有覆盖（test:2283-2333、2386-2425、2476+）。
8. `installOpencode` / `installedIntegrityProblems`（:282-346）— 真实 `npm ci` 的用例在 test:755-783（300 秒超时跑真安装）。
9. `prepareCopy` / `removeUnsafeProjectFiles` / `envFilesInHistory` — 有覆盖（test:1117 ENV_FILE_IN_HISTORY；整链路测试都会走到）。
10. `installGitGuard` / `checkGitArgs` / 受限 bash — 有覆盖（test:786 起）。
11. `selfCheck` / `probePlan` / `checkProbeRequests` / `guardProbe` — 单元覆盖 + 名字带 `[review env]` 的反向用例。
12. `reviewModel` / spend-guard / 收尾追问 — 有覆盖（追问在同会话只追加、`[I-77]` 在途步数用例）。
13. `assertReviewed` / `reviewReport` / 例外路径 — 有覆盖（test:1900-2200，含 `REVIEW_OVERRIDE_REFUSED`、`ledger-differs-from-HEAD`、`REPORT_STOP_INCONSISTENT`）。

没有测试覆盖的路径（读代码证实）：`main()` 的 `SIGINT`/`SIGTERM` 清理（opencode-review.mjs:1735-1740，测试文件里 grep 不到 SIGINT）；`killProcessGroup` 实际被 SIGKILL 的分支。其余我未跑测试（无运行权限），「反向用例会不会真失败」是按断言方向核对代码逻辑得出的，不是运行结果。

文档与代码一致性：`model-review.md` 里的 T1–T8 描述逐条与代码对应上（白名单 `OPENCODE_KEPT_ENV` 两份名单一致；锁文件 13 条 sha512 = opencode-ai + 12 平台包，`:15-180`；`--round` 的四种拒绝码与 `roundForRun` 一致；`--out` 限制、`--pr`/`--topic` 强制、例外认定「本 PR 的记录目录」都与 code 对齐）。`biome.json` 新增 `!!**/.agents/reviews`（实际写的是 `!!.agents/reviews`，形式与其他条目一致）。

## 发现的问题（按严重度从高到低）

## 结论之前：读代码证实的与推测分开

**低｜scripts/model-review/opencode-review.mjs:854**
问题：`assertReviewed` 打印 `REVIEW_OVERRIDE quote=${recorded.quote}` 时，若例外记录是本 PR 修复（6a3b29a2）之前写入、quote 里带换行的旧记录，会把固定几行拆断。
证据：:846-854 直接 `find(...)` 后打印，`parseUsage`（:914-937）对 `quote` 字段没有任何校验；限制只在 `parseArgs`（:1608-1616）拦新输入。
建议：打印前对 `recorded.quote` 做 `\r\n` 校验或拒旧记录；只影响新修复之前创建的例外，工程量小。

**低｜scripts/model-review/opencode-review.mjs:862**
问题：追加例外记录时 `JSON.stringify` 的 `problems` 数组来自 `changedOutside` 的原始文件名，文件名里若有反斜杠/引号只影响该行 JSON 之外的可读性——核对过 `JSON.stringify` 会正确转义，无实际错误。此条仅记录已排除的疑点，不算问题。

**低｜scripts/model-review/opencode-review.mjs:323-331**
问题（核对项，结论为一致）：「刚装好就不一致时直接报错，不重装」在 :325 用 `reused` 区分，与文档表述一致；重装仅发生在复用时。已证实。

其余我重点核对的作者说法未发现不一致（见下）。

## 作者说法逐条核对

- T1 环境白名单 + canary 探针：证实。`OPENCODE_KEPT_ENV`（:398-421）+ `opencodeEnv` 在 spawn 时使用（:541）；父进程 canary 探针 `git log $REVIEW_PARENT_CANARY_ENV`（:1096），且有反向用例（test:512-526）。`/proc/self/environ` 只在 Linux（:1082-1084），Mac 跳过、作者未验证（推测：Mac 上无 `/proc` 无法用同样方式核对，作者已被文档写明）。
- T7 锁文件安装：证实（:279-346 + opencode-lock/package-lock.json 13 条 sha512）。
- T8 `--round`：证实（:954-994、:999-1014、:1776-1777；重命名发生在打开模型前）。
- T3 记录进仓库：证实（`reviewDir` :1540-1542、`--out` 仅自检 :1657-1658、sparse checkout 与 `-diff` 属性 :1506-1529、`GIT_BANNED_OPTIONS` 含 `--text`/`--binary`/`--show-signature` :45-63、`REVIEWS_PATH_FRAGMENT` "agents/reviews" :359、:373-374）。我自己这边实测：我尝试 `git show <提交>:.agents/reviews/pr-255/usage.jsonl`，被环境直接给出 `REVIEW_GIT_REFUSED records-path`——端到端验证了替身检查生效。
- T2 合并前核对：证实（:804-876；例外搜索带 `changedOutside == 0` 与文档一致）；「本 PR 的记录目录」的范围由 `ledgerPath` 具体到 `pr-N`（:813）。
- T6 汇报：证实（:878-912）。
- T5 各有侧重 + 第 4 条必答问题 + `--questions-ref`：证实（:178-191、:1597 附近、test:213-214）。
- 第 4 轮增量与 #256/#252 合并：证实无冲突。40ed87d9 后 opencode-review.test.mjs 的假服务器改动与 #255 的 `record` 参数合流一致；e6293956 的 #252 只动 hermes-runner/docs/ADR，与 PR 文件无交集。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。每次复核每次运行都是全新会话：首条消息是 `buildPrompt` 输出的单一提示词（系统提示、工具定义由 opencode 自己按固定 `reviewConfig` 生成，脚本不注入会变值）；会变的 head/base/previous、侧重（每模型固定）、必答问题（从已提交版本读）都写进这唯一一条消息末尾（:209-222）。收尾追问在同会话只追加一句 `WRAP_UP_PROMPT`（:701、:726-738），工具定义不变（只把 allow 改 ask，:122-128）。依据 prompt-prefix #1/#2 满足。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会（就本 PR 的改动而言）。提示词由提交哈希、提交过的 questions 源和 brief 确定性拼接；时间戳 `new Date().toISOString()` 只写入账本记录（:862、:1795），不发模型；`rawDir` 的 repoId 哈希不发模型；`-diff` 属性让 `git show/diff` 对记录目录的输出固定为 "Binary files"。哈希/换行处理（trim、recordText）都确定性。推测性备注：若后来又有人改 prompt 模板（含第 3 问「逐个使用点」指向的生成处），才会破坏，目前无。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有。第 3 轮修的 8 处各有一条以上用例（代理空格/无协议头：test:2434-2440；换行补齐和非 ASCII `-z`：test:1947-1971；`nextRound` 排除例外：test:1967；原话换行拒绝：test:308-313；`parseUsage` 字段：test:2258-2262；重跑含例外轮次：test:2386-2425）。「反向用例会不会真失败」我是按断言与代码逻辑推导的（例如不加 `-z`，`git log` 默认 quotePath 会把 `判断.md` 转成引号+八进制，`startsWith(".agents/reviews/pr-7/")` 判假，测试必失败）；没有运行，标此处部分未核实。

未核实项：cloud 门槛实验（逐个撤修复的反复验证）、`.agents/handoffs/`、`.agents/reviews/` 两轮方案讨论原文与 judgments.md（在本副本中按设计隐藏，且我自己的复核被 git 替身拦住）、OpenCode协力 #252/#256 各自 PR 的复核记录（作者称已在各自 PR 复核）、Mac 上 `OPENCODE_KEPT_ENV` 的适配（作者自述未验证）。
