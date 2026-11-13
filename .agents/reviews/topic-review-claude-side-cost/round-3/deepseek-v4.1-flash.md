CLAIM|1|一致|scripts/model-review/opencode-review.mjs:300|合并前的代码复核用 `scripts/model-review/opencode-review.mjs`。|    role: "你是独立的代码复核者。",
CLAIM|2|一致|scripts/model-review/review-models.json:3|请 DeepSeek V4.1 Flash 复核。|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|3|一致|scripts/model-review/opencode-review.mjs:251|只读复核。|      edit: "deny",
CLAIM|4|一致|.agents/instructions/model-review.md:52|线程（Claude Code 的一段对话）再逐条判断、修改、再复核。|2. 分类由线程做，不由模型做。线程对每一条意见逐条核对，每条都写下判断和依据（文件:行或实际运行结果），先判断它成不成立，再把成立的意见分成两类：
CLAIM|5|找不到|-|2026-11-13 统计 180 个 PR 的复核记录。|-
CLAIM|6|找不到|-|统计 4 个 PR 线程的用量。|-
CLAIM|7|找不到|-|数字和取法见 [`.agents/reviews/topic-review-claude-side-cost/data.md`](../../.agents/reviews/topic-review-claude-side-cost/data.md)。|-
CLAIM|8|找不到|-|4 个 PR 的整个线程按 API 价折算 39–86 美元。|-
CLAIM|9|找不到|-|同一批 PR 的 DeepSeek 复核 0.4–1.4 美元。|-
CLAIM|10|找不到|-|线程上下文常有 15 万到 30 万 token。|-
CLAIM|11|找不到|-|每调一次工具都按缓存价重读整段上下文。|-
CLAIM|12|一致|.agents/instructions/model-review.md:52|一轮复核要读答案、逐条打开代码。|2. 分类由线程做，不由模型做。线程对每一条意见逐条核对，每条都写下判断和依据（文件:行或实际运行结果），先判断它成不成立，再把成立的意见分成两类：
CLAIM|13|一致|.agents/instructions/model-review.md:59|手写 `verdicts.jsonl`（逐字抄模型原话）和 `judgments.md`。|   - 逐条判断除了写进给人看的 `round-<n>/judgments.md`，还要一条一行写进 `round-<n>/verdicts.jsonl`（脚本读它）：
CLAIM|14|一致|.agents/instructions/model-review.md:65|提交、跑检查。|   - 一轮里的“会出错”意见全部是“低”时，这一轮不再触发下一轮：线程照常修改、补测试、做反向验证，把这一轮的 `verdicts.jsonl` 和修改都提交后，运行 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <编号> --accept-low <轮次>`。
CLAIM|15|找不到|-|约 25–40 次调用。|-
CLAIM|16|找不到|-|线程常整份读 `.agents/instructions/model-review.md`（约 8 万字节）。|-
CLAIM|17|找不到|-|`docs/incidents-and-gates.md`（约 18 万）。|-
CLAIM|18|找不到|-|`docs/lessons.md`（约 15 万）。|-
CLAIM|19|找不到|-|读进来以后每次调用都要重付。|-
CLAIM|20|找不到|-|2026-11-11 起，增量轮（带 `--previous`）中位 53 步。|-
CLAIM|21|找不到|-|和第 1 轮的 57 步差不多。|-
CLAIM|22|一致|scripts/model-review/opencode-review.mjs:368（提交 ccec8bd0f^）|提示原话是“这一轮先看 git diff 的增量，但可以读任何文件”。|      ? `上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
CLAIM|23|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|按 [ADR 0175](0175-cheaper-code-review-rounds.md) 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本。|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|24|找不到|-|每轮都这样。|-
CLAIM|25|找不到|-|图表和逐项解释见线程文档“复核省 token 和提速：数据与结论”。|-
CLAIM|26|一致|.agents/instructions/model-review-card.md:16|每一轮用 Claude Code 的 Agent 工具起一个子代理 `code-review-round`。|PR 开好、测试过了以后，每一轮用 Agent 工具起一个新的子代理 `code-review-round`（定义在 `.claude/agents/code-review-round.md`，在后台跑），提示照下面写，把尖括号换成实际值。
CLAIM|27|一致|.claude/agents/code-review-round.md:2|定义在 `.claude/agents/code-review-round.md`。|name: code-review-round
CLAIM|28|一致|.agents/instructions/model-review-card.md:6|新的一段对话，上下文从零开始。|每一轮复核交给一个新开的子代理（Claude Code 的 Agent 工具新开的一段对话，上下文从零开始，一轮做完就结束，不在子代理里攒出长上下文）
CLAIM|29|一致|.claude/agents/code-review-round.md:3|由它跑这一轮复核、逐条判断、按结论修改并提交，然后交回几行结论。|description: 合并前代码复核的一轮执行者。PR 线程每一轮新起一个：它跑这一轮 OpenCode 复核、逐条判断、按结论修改并提交，只交回几行结论。按 .agents/instructions/model-review-card.md 做。
CLAIM|30|一致|.agents/instructions/model-review-card.md:16|主线程不读模型答案和判断文件。|主线程不读模型的答案、`verdicts.jsonl` 和 `judgments.md`，只看子代理交回的几行结论；Andy 问细节时再去读。
CLAIM|31|一致|.agents/instructions/model-review-card.md:25|收尾时自己再跑一次 `--assert-reviewed`。|收尾时，主线程自己跑一次 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <编号>`，看到 `REVIEW_CURRENT` 才采信它的结论
CLAIM|32|一致|.agents/instructions/model-review-card.md:25|子代理自报的结果不算数。|（子代理自报的检查结果不算数，见[审核时直接采信代理自报的检查结果](../../docs/lessons.md#trust-reported-checks)）
CLAIM|33|一致|.claude/agents/code-review-round.md:3|逐条判断仍由 Claude 做，只是换到子代理里。|description: 合并前代码复核的一轮执行者。PR 线程每一轮新起一个：它跑这一轮 OpenCode 复核、逐条判断、按结论修改并提交，只交回几行结论。
CLAIM|34|一致|.agents/instructions/model-review-card.md:2|做法写在新的一页流程卡 `.agents/instructions/model-review-card.md`。|# 代码复核流程卡
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:2972|`opencode-review.mjs` 新增两条命令。|export const ROUND_TOOL_OPTIONS = ["--judge-skeleton", "--finish-round", "--pr", "--repo"];
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:3378-3385|这两条命令不花钱。|    for (const line of judgeSkeleton(options)) console.log(line);
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:1684|`--judge-skeleton --pr <编号>`：把最新一轮模型答案里每个 `###` 标题写成 `verdicts.jsonl` 的一行。|    if (!skipped && /^###\s+\S/.test(line)) findings.push(line);
CLAIM|38|一致|scripts/model-review/opencode-review.mjs:1701-1703|编号和原话已填好。|          id: `${records.length > 1 ? `${short}-` : ""}${index + 1}`,
CLAIM|39|一致|scripts/model-review/opencode-review.mjs:1639|“结论”“侧重检查”“必答问题”几节里的标题跳过。|const SKELETON_SKIPPED_SECTIONS = /必答|侧重|结论|总结|summary|conclusion/i;
CLAIM|40|一致|scripts/model-review/opencode-review.mjs:1693|文件已存在时拒绝覆盖。|    throw new Error(`JUDGE_SKELETON_EXISTS ${ledgerPath}/round-${round}/verdicts.jsonl`);
CLAIM|41|一致|scripts/model-review/opencode-review.mjs:1717|一条都找不到时拒绝、不写文件。|      `JUDGE_SKELETON_NONE round-${round} 答案里没有找到以「### 」开头的意见，读答案后手写 verdicts.jsonl；确实没有意见就写一个空文件`,
CLAIM|42|一致|scripts/model-review/opencode-review.mjs:304|代码复核的输出格式同时改为“每条意见单独一个以 `### ` 开头的标题”。|      "输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。",
CLAIM|43|一致|scripts/model-review/opencode-review.mjs:1746|`--finish-round --pr <编号>`：核对每条原话都在答案里。|    if (!answers.get(verdict.model).includes(verdict.quote))
CLAIM|44|一致|scripts/model-review/opencode-review.mjs:1748|判“不成立”和“可以更好”的都写了依据 `why`。|    if ((!verdict.valid || verdict.class === "better") && !String(verdict.why ?? "").trim())
CLAIM|45|一致|scripts/model-review/opencode-review.mjs:1750|自由文本里没有控制字符。|      ["why", "trigger", "consequence", "reason"].some(
CLAIM|46|一致|scripts/model-review/opencode-review.mjs:1781|由 `verdicts.jsonl` 生成 `judgments.md`。|  writeFileSync(join(dir, "judgments.md"), judgment);
CLAIM|47|一致|scripts/model-review/opencode-review.mjs:1785|打印这一轮的计数和下一步命令。|    `ROUND_SUMMARY pr=${pr} round=${round} reviewed=${reviewed} mediumHigh=${high.length} low=${low.length} better=${better.length} invalid=${verdicts.filter((verdict) => !verdict.valid).length}`,
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:1791|下一轮命令里的 `--previous` 自动填成这一轮复核的提交。|      `NEXT fix-and-rereview node scripts/model-review/opencode-review.mjs --mode code-review --base ${record.base} --head <修改后的提交> --previous ${reviewed} --pr ${pr} --brief <材料文件>${gateway}`,
CLAIM|49|找不到|-|这个错已出现三次。|-
CLAIM|50|一致|.agents/instructions/model-review.md:6|线程跑代码复核先读流程卡。|跑代码复核时先读一页的[代码复核流程卡](model-review-card.md)，这份文件只在卡上指到的那一节读（[ADR 0263](../../docs/adr/0263-cheaper-claude-side-of-code-review.md)）。
CLAIM|51|一致|.agents/instructions/model-review-card.md:4|遇到卡上没写的情况或报错，按卡上的链接只读完整说明的对应一节。|这一页是合并前代码复核的常用路径。完整规则在[和 OpenCode 协作](model-review.md)（约 8 万字节），平时不通读，遇到下面没写到的情况或报错时，按链接只读对应那一节。
CLAIM|52|一致|.agents/instructions/model-review-card.md:4|事故清单和教训记录按编号查。|事故清单 `docs/incidents-and-gates.md` 和教训记录 `docs/lessons.md` 也一样：按编号或标题用 `grep` 查那一段，不整份读。
CLAIM|53|一致|test/tooling/review-round-tools.test.mjs:215|测试核对流程卡上的每个锚点和参数都真实存在。|    for (const anchor of anchors) expect(full).toContain(`<a id="${anchor}"></a>`);
CLAIM|54|一致|scripts/model-review/opencode-review.mjs:371|带 `--previous` 的轮次，提示改为“先看增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端；增量没碰到、行为也没被改变的旧代码不必整份重读，但证据指向旧代码时要跟下去；结论写清查过哪些范围”。|      ? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。`
CLAIM|55|一致|scripts/model-review/opencode-review.mjs:360-362|必答问题不变。|    ...(questions.length > 0
CLAIM|56|一致|scripts/model-review/opencode-review.mjs:1799|第 3 轮起，一轮里成立的“会出错”意见全是低时，不修、不记 `low-fix`、不再复核。|      `NEXT low-deferred 第 ${round} 轮只剩低意见，不修，--report 会列出：${low.map((verdict) => printable(verdict.id)).join(",")}`,
CLAIM|57|一致|scripts/model-review/opencode-review.mjs:1869|`--report` 新增一节“低严重度未修（第 3 轮起只列不修）”。|      ? [`低严重度未修（第 ${LOW_DEFER_FROM_ROUND} 轮起只列不修）：`, ...deferredLines]
CLAIM|58|一致|scripts/model-review/opencode-review.mjs:1651|列出第 3 轮起每一轮只剩低意见、又没记 `low-fix` 的那些意见。|    if (errors.length === 0 || errors.some((verdict) => verdict.severity !== "low")) continue;
CLAIM|59|一致|scripts/model-review/opencode-review.mjs:1654|轮次、编号、原话、触发条件、后果。|        `  第 ${round} 轮 ${printable(verdict.id)} ${verdict.model.split("/").pop()}：${printable(verdict.quote)}｜${printable(verdict.trigger)} → ${printable(verdict.consequence)}`,
CLAIM|60|一致|scripts/model-review/review-models.json:7|起始轮次写在 `scripts/model-review/review-models.json` 的 `lowDeferFromRound`。|  "lowDeferFromRound": 3
CLAIM|61|一致|scripts/model-review/opencode-review.mjs:101|不写死在脚本里。|export const LOW_DEFER_FROM_ROUND = reviewModels.lowDeferFromRound;
CLAIM|62|一致|scripts/model-review/opencode-review.mjs:1793|第 1、2 轮照旧按 ADR 0175 修低意见。|  else if (low.length > 0 && round < LOW_DEFER_FROM_ROUND)
CLAIM|63|一致|scripts/model-review/opencode-review.mjs:1495|合并检查不变：最后一轮复核的就是当前代码，复核链本来就接得上。|  const { accepted, broken } = walkChain(points, { isAncestor, lowFixCheck });
CLAIM|64|一致|docs/adr/0263-cheaper-claude-side-of-code-review.md:7|这修订了 ADR 0175 第 5 条在第 3 轮及以后的适用范围。|amends: "docs/adr/0175-cheaper-code-review-rounds.md"
CLAIM|65|找不到|-|ADR 0175 的其他决定不变。|-
CLAIM|66|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮。|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|67|一致|docs/adr/0259-review-models-default-to-deepseek.md:11|ADR 0259：方案审核和代码复核默认只用 DeepSeek。|# ADR 0259：方案审核和代码复核默认只用 DeepSeek，默认模型写在配置里
CLAIM|68|一致|.agents/instructions/model-review.md:2|和 OpenCode 协作。|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|69|一致|.agents/instructions/model-review-card.md:2|代码复核流程卡。|# 代码复核流程卡

`.agents/reviews/topic-review-claude-side-cost/data.md` 在工作区未检出，git 读取该路径又被守卫拒绝，所以背景里的统计数字都没能核实；`model-review.md`、`incidents-and-gates.md`、`lessons.md` 的字节数也无法测量。第 22 条旧提示是按父提交 ccec8bd0f^ 的版本核对的，其余没读到原文的地方按找不到处理。
