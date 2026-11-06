增量 diff 已经拿到。现在读主脚本 `scripts/model-review/opencode-review.mjs` 的关键部分。
工具环境限制确认（只能 read/grep/glob 和 git 只读命令）。继续读脚本。
已读完脚本全部 1900 行。现在核对规则文件、测试覆盖和 biome.json、lock 目录。
规则文件已核对。现在看测试覆盖情况。
# 复核结论（PR #255，d2ade1f，基准 bd0859a，上一轮 c6d132f）

## 侧重检查

我走的流程：只跑代码评审最普通的一条链——`node scripts/model-review/opencode-review.mjs --mode code-review --base <b> --head <h> --pr <n> --brief <文件>`，从入口 `parseArgs` 一路到记录落盘（`opencode-review.mjs:1737-1887`）。逐段核对测试覆盖（`test/tooling/opencode-review.test.mjs`，共 2812 行）：

- **有覆盖**：`parseArgs`（含 `ARG_OUT_ONLY_FOR_SELF_CHECK`、`--round`、`--main-ref` 控制字符等，:276-2430）；`resolveCommits`/`reviewQuestions`/`questionsSource`（:1066、:1181-1201）；`buildPrompt`/`recordText`/`printable`（:283-320）；`proxyCredentialProblems` 含新 `//u:p@` 用例并断言密码不外泄（:2551-2584）；`parseUsage`/`budgetCheck`（:2303-2360）；`roundForRun` 全部拒绝分支（:2360-2535）；`installOpencode` + 完整性核对，含真实 `npm ci` 和真实 `--version`（:737-812）；`prepareCopy` 的遮盖、历史 .env 拒绝（:1066-1145）；git 替身 + `bash -r` 集成（:816-857）；`reviewModel`/收尾/费用插件全套假服务器用例（:1284-1852、I-77 系列 :1535-2803）；`--assert-reviewed`/`--report` 用真实脚本起进程并断言退出码 5/0（:2180-2290）。
- **无覆盖/部分覆盖的执行路径**：
  1. `main()` 的 code-review 模式端到端（:1737-1887 整段：真实双模型、写 `<模型>.md`/`stderr.txt`、追加 `usage.jsonl`、`REVIEW_SPENT_TOTAL`）没有用例——需要真金白银，只能分解验证；plan 模式的端到端只走到了提前退出的分支（:2433-2462 PROMPT_TOO_LARGE、:2618-2658 花钱前拒绝），「真跑完一轮并写盘”的 main() 全程未核实。
  2. 自检端到端用例（:885-918）只传 `--mode plan`；code-review 配置的差异只有 `reviewConfig`/`expectedTools` 的单元级断言（:119-176、:1836）。
  3. `keepEarlierAttempt` 的多模型、多后缀改名有覆盖（:2590-2616）。
- **文档与代码一致性**：核对 `model-review.md:53-104` 与代码，发现一处不一致（问题 1）；`biome.json` 只是给 `.agents/reviews` 加 lint 排除（diff 证实），与代码无冲突。
- 说明：「改为 0700、测试先建成 0777」有覆盖（:304-314）；`stops reading near the time limit` 用例确实存在（:1509-1522）且本增量未触碰 ✓。118 个用例是否全过、云端「撤掉修复测试失败」的门槛证据：**未核实**（我没有执行环境）。

## 问题清单（按严重度）

1. **中**（读代码证实）：`.agents/instructions/model-review.md:84` 与代码不一致。代码本轮新增了「轮次记录缺 `head` → `ROUND_CANNOT_VERIFY <n> head`」（`opencode-review.mjs:1026-1027`），规则只写了「提示词文件不在时……两样都没有时以 `ROUND_CANNOT_VERIFY` 拒绝」，没有任何缺 `head` 分支的说明。按本 PR 规则自己的分类，说明与代码不符属「会出错」。建议在 :84 补一句，例如「这一轮已有记录缺 `head` 时同样 `ROUND_CANNOT_VERIFY`」。
2. **低**（读代码证实）：`--main-ref` 拒绝控制字符（`opencode-review.mjs:1672-1673`）而 `--questions-ref` 只拒 `-` 开头（:1674-1676），不对称；`questionsRef` 会被拼进 `GIT_FAILED git show ${questionsRef}^{commit}`（:1531、:1523），出错时经 `console.error`（:1897）原样打到 stderr，可注入换行。规则 :72 也只写了「不能以 `-` 开头」。输入者是本线程，风险低；建议同样调用 `hasControlCharacter` 并同步规则。证据：`"      if (options.mainRef.startsWith("-") || hasControlCharacter(options.mainRef))"` vs `"      if (options.questionsRef.startsWith("-"))"`。
3. **低**（读代码证实）：`COMMIT_PATTERN` 放宽为 40 或 64 位（`opencode-review.mjs:924`），但测试里没有任何「64 位 head 通过 `parseUsage`」的正向用例——通过用例全是 40 位、无用例是 64 位。建议在 `describe("opencode review spending")` 的账本用例里加一条 64 位合法记录。
4. **低**（材料措辞 vs 代码）：作者材料 T7 说「核对已装的每个包的 sha512」，实现是把 `node_modules/.package-lock.json` 里每个 `integrity` 与提交锁文件逐项比对（:291-298），**不重算磁盘文件摘要**（连 `.package-lock.json` 一起篡改就不会被发现）；`model-review.md:62` 已如实写明这一局限（「它不重新计算已装文件的摘要」），所以是材料措辞含糊而非文档错误。
5. **低**（读代码证实，属保守行为非错误）：`isSecretEnvName`（:1536-1538）的 `/^\.env(?!…)/` 会把 `.envrc`（direnv 配置）也当密钥文件，历史中出现过就整体拒绝复核。与规则 :64「`.env` 一类文件」不冲突，列此供知悉。

推测/未核实（均无执行环境）：118 个测试全过、云端逐条撤修复的失败证据、Mac 上 `OPENCODE_KEPT_ENV`（作者自认）、`stops reading near the time limit` 在改动前 main 上的内存耗尽复现、以及上一轮存档里模型的原文（已隐藏）。

## 必答问题

1. **不会改变请求开头。** 本增量没有改动 `buildPrompt`（:193-222）、`reviewConfig`（:84-120）或 `runOpencode` 的消息内容（:524-537）；会变的值（head/base/previous/brief/本次材料）都拼在 prompt 末尾的 material 里（:209-221），模型侧重也按「模型+模式」确定且固定在 material 之前（:198-208）；追问只在末尾追加 `WRAP_UP_PROMPT`（:732、:739），工具定义不变（:114-119 只改权限）。
2. **没有新增跨请求字节漂移的来源**（读代码证实）：prompt 各字段无时间戳、无顺序不确定集合；`recordText`、遮盖（clone+sparse-checkout+`-diff` attributes+git 替身按参数判断，不读消息内容）都是内容无关的确定操作。带时间的 `new Date().toISOString()` 只出现在写进仓库的账本/结果文件（:872、:1859），不进发给模型的内容。
3. **有对应自动检查，反向用例成立**（代码级证实，未运行）：`//u:p@` 代理（测试 ：2551-2552，旧正则匹配不到所以反向会失败）、文件名转义（:294、:2044-2055，且伪造文件名不再能造出独立 `REVIEW_CURRENT` 行）、嵌套列表换行（老代码只查顶层字符串，新用例 `problems:["a\nREVIEW_CURRENT"]` 反向可过 :2356-2357）、缺 head（:2484-2498 新用例）、拒绝原因合并（:2049-2055）、回车符（:291）、0700（先 0777 再断言 :304-314）。例外：64 位 head 缺正向用例（见问题 3）；实际执行结果未核实。
