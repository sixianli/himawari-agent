## 侧重检查

走过的最普通使用流程（一次 `--mode code-review --pr N --base X --brief B --head H` 代码复核）：`parseArgs`（mjs:1612，测试覆盖：ARG_* 多条）→ `resolveCommits`（mjs:1533，测试 1191）→ `questionsSource`/`reviewQuestions`（mjs:1510/136，测试 1176-1183）→ `buildPrompt` + `PROMPT_TOO_LARGE`（测试 187/2423）→ `proxyCredentialProblems`（测试 2489-2503）→ `readUsage`/`parseUsage`（测试 2311-2329）→ `budgetCheck`（测试 2270-2302）→ `roundForRun`（测试 2347-2605）→ `installOpencode`/完整性（测试 731-796）→ `prepareCopy` + sparse checkout + `-diff` 属性 + `ENV_FILE_IN_HISTORY`（测试 1075/1136）→ `installGitGuard`（测试 811/1264）→ 自检（真实 opencode 跑探针，测试 875-903）→ `prepareRawDir`（新，测试 293-298）→ `keepEarlierAttempt` + 四类文件写入（测试 2539-2561）→ `reviewModel`（测试 1274-1666）→ 账本追加。

**没有测试覆盖的路径**（读代码证实）：`removeUnsafeProjectFiles`（mjs:1476-1491，符号链接/`.opencode`/`opencode.json` 删除逻辑只有 `prepareCopy` 间接触发，无直接断言）；`npmCi` 的真实网络安装分支（测试用假下载器覆盖到 integrity 检查）；`main()` 的 SIGINT/SIGTERM 清理（mjs:1774-1787）；作者声称的“云端容器逐个撤掉修复时对应测试失败”——运行记录不可读，标**未核实**，但第 5 轮六项修复在测试里各有一条对应用例（见必答 3）。

## 发现的问题（按严重度）

**中**　scripts/model-review/opencode-review.mjs:954-956　`singleLine` 只检查账本记录的顶层字符串值，嵌套值（如 override 记录的 `problems` 数组）里的换行不会被拒。证据：`Object.values(record ?? {}).every((value) => typeof value !== "string" || !/[\r\n]/.test(value))`；且 mjs:870 写入的 override 记录含 `problems` 数组，其中可来自带换行的 git 文件名（`git diff -z` 输出允许换行文件名）。后果：账本可能存进打印时会破坏 `assertReviewed`/`--report` 固定行格式的值。建议：校验非字符串字段（数组递归检查或只允许原始类型）。

**低**　scripts/model-review/opencode-review.mjs:844-846　`REVIEW_OVERRIDE_REFUSED rounds=N needs=3` 只看轮数：当 problems 全是 `main-not-merged`、`ledger-not-committed` 这类非 unreviewed 原因且轮数<3 时，报错只说轮数不够，掩盖了“即使轮数够也会被拒”的事实。证据：846-848 行三元只按 `reviewRounds < OVERRIDE_MIN_ROUNDS` 分支。行为正确，输出有误导性。建议：non-unreviewed 原因存在时优先报 `only-unreviewed-files` 类因由。

**低**　scripts/model-review/opencode-review.mjs:1586-1590　`prepareRawDir` 只对 root `chmodSync`，已存在的旧 raw 子目录（本改动之前以 0755 创建）不会被收紧，只有新建目录得到 0700。证据：`mkdirSync(dir, { recursive: true, mode: 0o700 })` 对已存在目录不生效，`chmodSync` 仅作用于 root。影响仅限升级前遗留目录。建议：对传入 `dir` 一并 `chmodSync`。

**低**　.agents/instructions/model-review.md:59　文档把 `OPENCODE_KEPT_ENV` 描述为「PATH、HOME、语言和时区、临时目录、XDG 数据目录、代理和证书设置」，代码（mjs:398-421）还传 `USER`、`LOGNAME`、`TERM`、`LC_CTYPE`、`XDG_CACHE_HOME`、`XDG_STATE_HOME`。文档少列了这一部分。建议补全清单。

**低**　scripts/model-review/opencode-review.mjs:1115-1117　`/proc/self/environ` 探针只在 Linux 装配（`process.platform === "linux"`），Mac 上跳过——与作者自述“没在 Mac 上验证”一致，属已知局限而非矛盾。记录在案。

作者说法与代码不符处：**没有发现**。T1（白名单+双探针 mjs:397-421/1116/1129/1338）、T2（mjs:840-874，例外只盖 unreviewed、已提交例外同样要三轮）、T7（mjs:301-341，`npm ci`+逐包 sha512+摘要前 12 位目录名）、T8（mjs:987-1027，四类拒绝全在 `opencodeBinary()` 之前，mjs:1771；改名 mjs:1819-1820）、T3（mjs:1544-1546、1700-1701）、T6（mjs:894-911）均与描述一致。

## 必答问题

1. **不改变。** 第 5 轮增量（assertReviewed、parseUsage、prepareRawDir、parseArgs ref 校验、文档、测试）不触及任何发给模型的内容：`buildPrompt`（mjs:193-222）仍是固定段在前、`head/base/previous/brief` 全在末尾 material 段；会中变化只有追问在对话末尾追加一句（工具定义不变）。证实。
2. **不会。** 增量新增内容中，账本时间戳（mjs:838/870）只写不读给模型；提示词里只有提交哈希、固定文本和作者提供的 brief，无时间依赖、无遮盖、无无序集合（`records.reverse()`（mjs:854）只影响哪个 override 生成字段被选，输入确定则输出确定）。证实。
3. **有，且反向可证。** 本轮六项修复各有对应用例且逻辑上“撤掉修复即失败（would fail）"：例外范围与已提交例外三轮（测试 1992-2029，保持 `overridable` 不含 scope/rounds 则旧逻辑判定 overridden=true，断言 false 失败）；单行字段（2317-2323 的 outcome 带换行）；40 位哈希（"not-a-commit"，旧代码放行）；mode 拼写（"code-reveiw"，旧代码因 `!MODES.includes` 短路放行）；0700（293-298）；ref 以 `-` 开头（300-308）。“云端确实逐个跑过撤除”**未核实**。
