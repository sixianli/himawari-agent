我就直接读取文件吧。
现在进行测试、规则和配置文件分析：
接下来是测试文件：
# 复核结论（PR #255：OpenCode 复核流程整改）

## 发现的问题（按严重度从高到低）

**1.（中）scripts/model-review/opencode-review.mjs:282-294 — 完整性核对核的是“清单对清单”，不是“包内容字节”。**
证据（读代码证实）：`installedIntegrityProblems` 先读 `node_modules/.package-lock.json`，然后逐条比较该 JSON 里每个包的 `integrity` 字段与提交的锁文件：

```
283: const installedPath = join(prefix, "node_modules", ".package-lock.json");
285: const installed = JSON.parse(readFileSync(installedPath, "utf8")).packages ?? {};
...
290: if (!expected?.integrity || expected.integrity !== entry.integrity)
291:   problems.push(`${name} ${entry.integrity ?? "no-integrity"}`);
```

`package-lock.json` 里的 integrity 是 npm 下载时的 tarball 摘要；`.package-lock.json` 是 npm 安装时自己写下的清单。安装后把 `node_modules/opencode-ai` 里的文件替换掉、清单不动，这道“每次使用前核对”照样通过。`.agents/instructions/model-review.md:62` 写的是“核对已装的每个包的摘要和锁文件一致”，读者会理解成对磁盘上的包内容重新取摘要，与实现不符。建议：对包目录（至少二进制和入口文件）做内容摘要核对，或把规则文件这句话改写为实际语义。

**2.（中）scripts/model-review/opencode-review.mjs:299-317 — 完整性核对一旦失败永不恢复，只能手工删缓存目录。**
证据（读代码证实）：安装仅当 `!existsSync(binary)`（299 行）才发生；之后 315-317 行核对出问题就直接抛 `OPENCODE_INTEGRITY_MISMATCH`，没有任何删除 `~/.cache/himawari-opencode-…` 目录并重试的分支。首次 npm ci 出现网络错误留下残缺目录但碰巧有 `.bin/opencode` 时，每次运行都以完整性错误停摆（推测此场景需要实际复现，代码路径是证实的）。建议：核对不符时删掉 prefix 重装一次，或至少在报错文本里写明“删除该目录后重试”。

**3.（低）scripts/model-review/opencode-review.mjs:761-775 — 账本里同一轮出现两条 head 不同的 ok 记录时，合入门/汇报路径以陌生错误退出码 2。**
证据（读代码证实）：`lastCompleteRound` 里 `heads.length !== 1` 抛 `REVIEW_ROUND_HEADS_DIFFER`；`assertReviewed`/`reviewReport` 不接这个错误，main 的兜底 catch（1710-1713）打印后退出码 2，而不是走 `REVIEW_NOT_CURRENT`（退出码 5）的问题清单。和账本其他损坏（`USAGE_LEDGER_INVALID`，873-874 行）有精细化报错的处理不一致。正常写账本不会触发（每轮 head 固定），属于损坏账本路径的行为缺口。

**4.（低）scripts/model-review/opencode-review.mjs:1526-1531 — `--assert-reviewed`/`--report` 提前 return，跳过其余参数校验。**
证据（读代码证实）：这两个分支在 `for (const required of ["head","brief"])` 之前直接 `return options`，`--out`、`--pr --topic` 冲突等不再校验，传入会被静默忽略。影响小，但绕过了第 4 条参数校验理念本身。

**5.（低）scripts/model-review/opencode-review.mjs:362-364 — 禁用长参数按“禁用名是实参前缀”匹配，实参比所有禁用名都长时就放行。**
证据：`if (name.length > 2 && GIT_BANNED_OPTIONS.some((banned) => banned.startsWith(name)))`。即 `--output2` 这类“以禁用名为自身前缀”的实参会通过替身（推测 git 当前没有这种选项，影响是推测）。自检探针实测过的绕过形态（缩写、引号、反斜杠、tab、`difftool` 等，941-1038）都有反向用例兜住。

**6.（低，测试/文档一致性问题集合——读代码证实；推测部分标注）**
- 主入口的“完整运行”路径没有测试走到落盘段：`REVIEW_RAW_DIR` 打印、raw 目录命名 `rawDir`（1455-1457，含 `himawari-review-raw`）、`.stderr.txt` 的写入条件（1690-1692）在 `main()` 里无覆盖（真实自检测试 test/tooling/opencode-review.test.mjs:819 用 `--self-check-only`；重跑端到端测试 2261 在花钱前就退出）。
- `PROMPT_TOO_LARGE`（1576-1577）无测试。SIGINT/SIGTERM 清理（1609-1618）无测试。`opencodeBinary` 摘要目录名（323-328）无直接断言。
- `--questions-ref` 的函数（1388-1393）有测试（1123、1126），但作为命令行参数传入 `main()` 的端到端路径没有测试。
- 作者说法“测试文件里有一条 `stops reading near the time limit`，本 PR 没碰它”——本次 git diff 证实没有出现在改动里；“在改动前的 main 上就会 OOM”未核实（不能运行 vitest）。
- `biome.json:9` 新增 `!!.agents/reviews`，与“记录目录文件不参与格式化”一致；`package-lock.json` 实数 `opencode-ai` + 12 个平台包共 13 条，与规则文件“12 个平台包”一致。
- 说明性发现（不算错）：`three-rounds` 的核对只是 `rounds.length >= 3`（844 行），实现不了“连续三轮没过”的判定；规则文件第 7 条自己写明“至少有三轮”，文字和代码一致，是设计上的限制。

## 作者说法逐条核对结果（读代码证实为主）

- T1（环境变量）：属实。`opencodeEnv` 白名单（407-411）、白名单内容（382-405）、runOpencode 改用 `opencodeEnv(parentEnv)`（518）、探针 `git log $REVIEW_PARENT_CANARY`（1010）、parentEnv 注入 canary（1232）、`/proc/self/environ` 探针（998）、反向用例（test 482-496）和真实自检含密钥用例（819-852）都在。“Mac 上是否够用”未核实。
- T7（安装）：基本属实（npm ci 296-319、摘要目录名 323-328、`OPENCODE_INTEGRITY_MISMATCH` 310/317、测试 682-746），但见问题 1、2——核对语义和恢复行为与说法有出入。
- T8（重跑）：属实（`roundForRun` 892-910 四种拒绝、`keepEarlierAttempt` 915-930、测试 2181-2305，端到端在花钱前拒绝 2261-2305）。一处小缝隙：失败改名后 prompt 文件不存在时（`onDisk === null`，905-907）不做提示词比对——规则文件第 84 条的写法（“`<模型>.prompt.md` 和这次不同时拒绝”）与代码一致，缝隙只存在于 PR 说法的绝对表述。
- T3（记录进仓库）：属实。`--pr`/`--topic` 强制（1540-1545）、`--out` 仅自检（1538-1539）、固定目录（1442-1457）、prompt 按 模型命名（1459-1461、1654-1656）、原始事件和思考进 tmpdir（1455-1457、1667、1671）、sparse checkout（1422）、`.git/info/attributes` 标 `-diff`（1424）、替身拒 `agents/reviews` 参数与 `-a`/`--text`/`--binary`（357、61-62、347）、两条 Records 探针（1012-1022）、测试 1019-1058、879-893。作者自曝的局限属实且代码确实没有堵 `git show <对象号>`（`checkGitArgs` 不认 blob 哈希，`-diff` 属性只影响 diff 输出）。
- T2（合并前核对）：属实。`assertReviewed`（781-821）五类问题、override 入账本（804-812）、退出码 5（1560-1564）。作者没把握的两类情况都有测试：合并 main 产生 unreviewed 清单（1877-1905）、只改记录目录放行（1863-1875）、非祖先（1953-1964）、override（1966-1988）、先答后装（1990-2021，退出码 5/0 均验证）。更多形态（如 rebase 重写后的祖先关系、记录目录部分改名）未逐一核实。
- T6（汇报）：属实（831-857，一致性表 842-848，测试 2022-2103，含退出码 2 的反向用例 2072-2103）。
- T5（侧重）：属实（`MODEL_LENSES`/`lensFor` 178-191、插入在材料之前 206、规则文件第 4 问在 46 行、`--questions-ref` 1388-1393/1498、测试 207-243 逐字比对两模型提示词差异）。
- 约束核对：主脚本无代码注释（读全文件证实）；“脚本启动 opencode 前会清掉 OPENCODE_PURE”（规则 78 行）通过白名单不含它实现（被测试 793-817 的 `OPENCODE_PURE` 用例证实）。

## 侧重检查（走过的一条普通流程）

以 `--mode code-review --base <commit> --head <commit> --pr N --brief 文件` 从入口走到结束：

1. `parseArgs`（测试覆盖，260-295）→ 2. `resolveCommits`（部分覆盖：head 用例 1000-1001，`--base`/`--previous` 端到端解析无独立测试）→ 3. `questionsSource`+`reviewQuestions`（覆盖 1108-1132）→ 4. `buildPrompt`（覆盖 180-258）→ 5. `PROMPT_TOO_LARGE`（**无覆盖**）→ 6. `readUsage`/`parseUsage`（覆盖 2147）→ 7. `budgetCheck`（覆盖 2109-2145）→ 8. `roundForRun`（覆盖 2181-2305）→ 9. `opencodeBinary`（缓存目录命名**无直接覆盖**；`HIMAWARI_OPENCODE_BIN` 捷径被多个端到端测试用）→ 10. `prepareCopy`+`removeUnsafeProjectFiles`（覆盖 966-1018、1019-1058、1060-1106）→ 11. `installGitGuard` + 受限 bash（覆盖 750-）→ 12. `selfCheck` 全部探针（计划层覆盖 381-635；真实 opencode 执行层覆盖 819-852，需真机）→ 13. `reviewModel` 首轮+追问（大量覆盖 1273-1795）→ 14. 落盘：`REVIEW_RAW_DIR`、raw 目录、`promptSha256`、`.stderr.txt`（**无覆盖**）→ 15. `resultLine`/`REVIEW_SPENT_TOTAL`（覆盖 2022-2037）→ 16. 退出码 4 路径（部分覆盖）。信号清理（11 的 SIGINT 分支）整条**无覆盖**。

结论：文档（`.agents/instructions/model-review.md` 新增段落）与代码逐条对得上，未发现其他文字与代码矛盾；主要缺口集中在问题 1、2 和上面第 6 条列的无覆盖分支。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？不会。**读代码证实：每次复核/自检都是 `runOpencode` 全新会话（650-660 无 session 参数的调用路径只出现在首轮），唯一追加进旧会话的是追问的 `WRAP_UP_PROMPT`（709 行，`--session` 复用 508 行）。每轮会变的值（head、base、previous、材料正文、git diff 的指引）全部在首条消息的“本次材料”一节（209-221），固定部分在前面（198-208），侧重句也插在固定段且逐测两模型差异（test 213-243）。追问配置只把 allow→ask（122-128），deny 不动，工具定义不变。未发现违反 prompt-prefix.md 硬规则 1、2 的改动。
2. **同一段文字会不会变成不同字节？没有发现模型可见文本的不确定性。**证据：`buildPrompt` 全部输入来自提交（head/base/previous 解析自提交、questions 从提交读、brief 是文件），无时间戳/随机值（809、942、1674 的 `Date`/`randomBytes` 只进账本和自检标记，不发模型）；且 `roundForRun` 用 `ROUND_PROMPT_MISMATCH`（904-907）强制重跑提示词和上次落盘文件逐字一致，反向用例在 2207-2208。自动遮盖机制本 PR 未触碰（未核实遮盖器本身，改动不涉及）。
3. **有没有自动检查、反向用例会不会真失败？大齐备。**证实存在并获得反向用例的：env 白名单（793-817）、真实自检含密钥（819-852）、canary 泄露（482-496）、lock/摘要（695-746 含篡改拒绝）、重跑四拒绝（2201-2305 含端到端“花钱前退出且不建文件”2299-2301）、合入门（1877/1953/2013-2017 含退出码 5）、汇报不一致（2039-2069、2097-2099 退出码 2）、记录目录隐藏（1019-1058、879-893）。已知反向用例空白：`PROMPT_TOO_LARGE`、信号清理、完整性失败后的恢复（问题 2）、`REVIEW_ROUND_HEADS_DIFFER` 路径（问题 3）。
