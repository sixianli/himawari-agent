## 侧重检查（先写这一节）

**普通流程走读（代码复核第 1 轮，`node scripts/model-review/opencode-review.mjs --pr <n> --head <sha> --base <sha> --brief brief.md`）**：

1. `parseArgs`（opencode-review.mjs:1564-1658）：校验 `--pr`、`--base`、`--head`、`--brief`，`--out` 只在 `--self-check-only` 允许（1646）。测试覆盖（test 文件 264 行 describe「keeps each review's ledger in one fixed folder」）。
2. `main()`（1661）：`resolveCommits`、`reviewQuestions(questionsSource(...))`（从 `--base` 提交读问题，1466-1473；测试 1151-1158 覆盖含 `--questions-ref`）、`brief = recordText(readFileSync(...))`（1676；`recordText` 单元测试在 test:290）、`buildPrompt`（含 `MODEL_LENSES`，lens 只加给 code-review/plan-review，178-191；测试 211-245）、100KB 上限（1683）。
3. 新增代理检查（1685-1686）在 `readUsage`/`budgetCheck`/`roundForRun` 之前，在任何 opencode 或花钱之前。✓
4. `roundForRun`（945-985）：`--round` 的 NOT_FOUND / MODE_MISMATCH / ALREADY_HAS_RESULT / HEAD_MISMATCH / PROMPT_MISMATCH / CANNOT_VERIFY 全在 `opencodeBinary()` 装机（1716）之前。✓
5. `prepareCopy`（1497-1520）：sparse checkout 去 `.agents/reviews`、写 `.git/info/attributes` `-diff`、删远端和引用。测试 1050 覆盖。「git 替身拒绝参数」未逐条核实 `checkGitArgs` 全表（未核实），但探针计划和 git-guard 测试（900-960、380-505）覆盖主要方向。
6. 花钱路径 `selfCheck` → `reviewModel` → 写 `.md`/`.thinking.md`/`.jsonl`/账本（1748-1811）。组件级测试齐（wrap-up、I-77、记账），但没有一条测试从 `main()` 走通「真 opencode + 假服务器 + prepareCopy + 记账 + 退出码 4」全程：`withScriptedReview`（test:1233-1265）绕开 `main()` 自己 shallow clone；主入口级测试用 `HIMAWARI_OPENCODE_BIN=/nonexistent`（2072、2318、2419、2494）只测到花钱前的拒绝。stderr 写盘（1800-1802）和 `REVIEW_RAW_DIR`（1759）没有入口级断言。这属于组装层缺口，不阻塞本次改动。

## 发现（按严重度从高到低）

*没有发现「会导致出错」的问题。以下均为低严重度或记录性条目。*

**低（文档与代码不一致）** — `.agents/instructions/model-review.md:62`
- 文档说「核对不一致或安装记录缺失、读不出时，脚本删掉这个安装目录、按锁文件重装一次（打印 `OPENCODE_REINSTALL`）」。代码只在「已装过（二进制存在）」时才重装：`const reused = existsSync(binary); if (!reused) npmCi(...)` 之后若 fresh 安装即不一致，直接抛 `OPENCODE_INTEGRITY_MISMATCH`，不重装也不打印（opencode-review.mjs:319-332）。行为合理，但文档比代码宽。
- `.agents/instructions/model-review.md:57` 说代理「带账号密码（`://用户:密码@`）时拒绝」，代码的 `proxyCredentialProblems` 正则 `/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i`（opencode-review.mjs:426）连「只有用户名没有密码」的 `http://u@host` 也拒。代码更严，无安全后果，仅措辞不精确。

**低（记录性，跨版本提示词漂移）** — opencode-review.mjs:1676 + 976-982
- 本轮把 `--brief` 读入包了 `recordText`（去行尾空格/制表符）。`buildPrompt` 的材料区只做 `brief.trim()`（217），两头一合并：同一份 brief 若中间行有行尾空格，改动前的 prompt 字节和改动后不同。该 PR 第 1/2 轮的账本（promptSha256 按 8e378395 的旧字节记录）在升级后用 `--round` 重跑时，若 brief 有这种空格会以 `ROUND_PROMPT_MISMATCH` 被拒。向前无影响（同版本内确定性成立），属兼容性提示。

**记录性** — opencode-review.mjs:941
- `nextRound` 把没有 `round` 字段的记录按第 1 轮算，`mode:"override"` 的例外记录也没有 round，因此会计入 `Math.max(...)`。眼下无害（例外只在同一账本已有 ≥3 轮代码复核后才可能存在，opencode-review.mjs:838-853），但这是对不变量的隐式依赖，值得留意。

**作者自报、我未核实的**：门槛证据（「撤掉修复时对应测试失败」「113 通过 1 跳过」）、`OPENCODE_KEPT_ENV` 在 Mac 上的可用性、隐藏记录目录的局限声明。测试本身我读到了且断言方向正确，但按本会话约束不能运行验证。

**核对作者说法**：第 3 轮的 9 处修改逐条与代码一致（代理 423-427/1685-1686；已提交例外 840-852；账本不一致 853-856；`ROUND_CANNOT_VERIFY` 976-977；`ROUND_MODE_MISMATCH` 与例外不算轮 956-962；`recordText` 上 brief 1676 与 stderr 1801；规则文件补文与代码一致，含 raw 路径加仓库摘要 1535-1537）。测试均存在且反向用例方向正确。之前没把握的项里，我只确认了代码逻辑，合并提交的边缘场景（如 `REVIEW_ROUND_HEADS_DIFFER` 抛错而非列问题，opencode-review.mjs:791-792）行为未实测。

## 必答问题逐条

1. **会不改变已见请求开头？→ 不会。** 本次改动只影响：a) 第一条（也是新会话唯一开头）用户消息的 brief 预处理；b) 重跑前的拒绝逻辑。追冋试路径（`WRAP_UP_PROMPT`、`reviewConfig(wrapUp)`）本轮未动；测试用真 opencode 对假服务器逐字节断言 `expectAppendedTo(requests[0], requests[1])` 且追加区含提示语（test:1448-1453）。每轮会变的值（head/base/previous 哈希、material）都在该轮第一条消息里；`new Date()` 只进账本。符合 [prompt-prefix 规则](.claude/rules/prompt-prefix.md#rules)。
2. **同一段文字同字节？→ 会。** 脚本内无遮盖逻辑，无时间戳进模型输入；`recordText`、`rawDir` 路径摘要（1536）、`promptSha256`（1790）都是确定的纯函数。唯一要注意的是上面「记录性」条：跨脚本版本、brief 中间行带行尾空格时 prompt 字节会变，但同一次运行内不成立该问题。
3. **有自动检查吗？反向用例真的会失败？→ 有。** 代理（test:2386-2428，入口级含「stderr 不含 secret」与 NO_PROXY 反例）、已提交例外与反向（test:2036-2049：改了代码后 overridden=false、账本不一致拒绝）、`ROUND_CANNOT_VERIFY`（test:2275，正是把旧代码「返回 2」改成抛错的反向断言）、`ROUND_MODE_MISMATCH` 与例外不算轮（test:2349-2384）、`/proc` 探针按平台断言（test:436-439 与 probePlan 1073-1075）。「否方向会真失败」我靠读断言确认，未实际运行。
