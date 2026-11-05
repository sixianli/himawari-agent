# 复核报告（PR #255 第 2 轮，基准 bd0859a，上一轮 bb057722）

## 侧重检查

**走查的流程**：最普通用法＝代码复核 `node scripts/model-review/opencode-review.mjs --mode code-review --pr 7 --base <提交> --head <提交> --brief brief.md`。

入口到结束的路径：`parseArgs`(1524) → `resolveCommits`(1634) → `questionsSource`+`reviewQuestions`(1635, 1428/136) → 读 brief → `buildPrompt` 双模型(1637) → PROMPT_TOO_LARGE(1643) → `readUsage`+`budgetCheck`(1645-1654) → `roundForRun`/promptOnDisk 回退(1660-1672) → `opencodeBinary`(安装核对+按需重装, 1673, 319-346) → `prepareCopy` sparse-checkout 隐藏 `.agents/reviews`(1687, 1457-1479) → `installGitGuard`(1689) → `selfCheck`(1690, 1242) → 非自检段：写 opencode.json、并发 `reviewModel`、写 prompt/结论/stderr/原始事件、账本追加、`REVIEW_SPENT_TOTAL`、退出码 4(1705-1768)。

**测试覆盖结论**：前半段每个环节都有直接测试（参数、问题读取 test:1150-1157、大提示 test:2291、预算 test:2163、重跑护栏 test:2290/2340、安装重装 test:748、副本 test:1033 起、git 替身 test:780、真实自检 test:849、模型会话 wrap-up test:1248-1808、合并门 test:1893-2074、report test:2075-2156）。**没有测试覆盖**的是非自检运行段 main 全程之外的以下分支（推测：因为需要真实 opencode 和真密钥）：并发跑两个模型、`<模型>.stderr.txt` 写入(1757-1759)、`REVIEW_RAW_DIR` 打印(1716)、账本追加和退出码 4 的组合、SIGINT/SIGTERM 清理(1680-1685)。另外真实入口自检测试只跑了 `--mode plan`(test:860)，code-review 模式（不联网、工具表不同）的真实自检配置没跑过。

**文档、规则与代码一致性**：逐条核对了本增量改写的 `model-review.md` 段落（第 6/7 步、重跑回退、安装重装、/proc 平台差异、override 拒绝、子命令参数），均与代码一致。`biome.json` 排除 `.agents/reviews` 与记录目录内容（模型 markdown）不会被 lint 改写的意图一致（改动本身就是为过 `git diff --check`）。

## 问题（按严重度从高到低）

**【中·推测】scripts/model-review/opencode-review.mjs:929-931** —— `--round 1` 重跑可能被 override 记录误伤。账本里 override 记录（837 行写的是 `mode:"override"`、无 `round` 字段、`head` 是 override 时的头）在 `inRound = records.filter((record) => (record.round ?? 1) === requested)` 中会被算进第 1 轮，其 head 通常不同于第 1 轮的 head，重跑第 1 轮会报多余的 `ROUND_HEAD_MISMATCH`。代码路径可证，场景在“override 之后又想补跑第 1 轮”才会出现，实际影响有限。建议：过滤掉 `mode === "override"`，或给 override 记录显式写 `round`。

**【低·证实】scripts/model-review/opencode-review.mjs:291-298** —— 完整性核对只比 npm 的安装记录（`node_modules/.package-lock.json` 里的 integrity 字符串），不查文件系统：opencode-ai 之外的包整个被删、或 `node_modules` 目录被动过，只要这条 JSON 还在就不会被发现（只专门查了 opencode-ai 缺失）。规则文件已如实写明“不重新计算已装文件的摘要”，不算文档不符，仅作已知极限提示。

**【低·证实】scripts/model-review/opencode-review.mjs:1500-1502, 1736** —— `recordText` 把结论所有行的行尾空格/制表符剥掉，包括代码块内部（markdown 行尾两空格换行、对齐用空格会失真），存档不是模型输出的逐字节原样。只影响存档保真，不影响发给模型的内容；且这是为了通过 `git diff --check` 的刻意取舍。

**【低·未核实】门槛证据** —— 作者声称“云端容器逐个撤掉修复时对应测试失败、111 通过 1 跳过”。我核对过对应测试都存在且断言构造了真实的反例（见必答问题 3），但本环境不能运行测试，无法证实这些运行记录。

其余作者说法逐条核对均与代码一致（见末尾）；未发现与代码不一致的描述。

## 必答问题

1. **不会改变模型已见过的请求开头。**（证实）bb057722→8e37839 的增量完全没碰 `buildPrompt`、`MODE_TEXT`、`reviewConfig`、`runOpencode` 的请求组装（33 行脚本 diff 中无一处）。发给模型的仍是一次性新会话的整段提示：固定段（角色/工具清单/任务/必答问题/侧重/输出格式）对同模式同模型逐字节相同，会变的 head/base/previous/材料（193-222 行）全部拼在末尾“本次材料”块里；wl_up 第二次运行复用 `--session` 只在末尾追加 `WRAP_UP_PROMPT`(718-730)。CF78BC59 引入的模型侧重（206 行，位于材料之前）每轮对同一模型固定不变，符合“只追加”规则（.claude/rules/prompt-prefix.md:16-17）；本流程没有任何遮盖。

2. **不会。**（证实）提示词是纯字符串按固定顺序拼接，必答问题来自已提交文件的固定版本（1428-1433）；环境白名单按固定清单过滤（398-427）；新加的 `rawDir` 仓库摘要、`recordText`、`promptSha256` 都是确定性纯函数。带时间字段（`at: new Date().toISOString()`，1740）只进 usage.jsonl 和临时目录路径，从不进入发给模型的提示。

3. **有，且反向用例在断言结构上成立。**（证实测试存在；运行结果未核实）promptSha256 回退→test:2290；`ARG_NOT_FOR_SUBCOMMAND`/`ARG_ASSERT_AND_REPORT`→test:297-305；改名进记录目录→test:1937；三轮 override 拒绝→test:2008-2041；`installed-lock-unreadable`+删掉重装→test:748-775；REVIEW_PARENT_CANARY 真实自检→test:849-882（白名单失效即回 `...process.env` 时假模型 `git log $REVIEW_PARENT_CANARY` 的报错含标记，`PROBE_READ_OUTSIDE` 必失败）；recordText→test:288（反向即去掉修复后提交含行尾空格过不了 `git diff --check`——推测，该 gate 存在未核实）。
