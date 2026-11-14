## 作者说法核对

- 「这个 PR 只改指令和文档，不改代码」「脚本行为没有改」：**属实**。`git diff --stat` 只涉及 `.agents/instructions/model-review-card.md`、`.claude/agents/code-review-round.md`、`AGENTS.md`、两份 ADR 和数据文件；`scripts/model-review/opencode-review.mjs` 没有任何改动。
- 「子代理从 `--judge-skeleton` 开始」：**属实**。流程卡第 1 步和子代理定义都这样写，`--judge-skeleton` 也真实存在（`scripts/model-review/opencode-review.mjs:3047`）。
- 「ADR 0263 把子代理启动约 1.5 万 token 改成实测约 7 万」：**有数据支持**。数据文件给出 7.05 万、7 万到 7.26 万、72569。
- 「ADR 0175 的 amended_by 补上 0263」：**属实**，且与 0263 的 `amends` 双向一致。
- 「花钱先问的检查从子代理移到主线程，判断规则和合并检查都不变」：**大体属实，但流程卡的描述与脚本的实际阈值不一致**（见第 5 条）；另外「出现 REVIEW_RESULT 即算成功」的判定与脚本输出不一致（见第 1 条）。

## 侧重检查

- **错误路径**：查了 `resultLine`、`latestReviewRound`、`judgeSkeleton`、`finishRound`、`main()` 的失败分支。发现失败轮次仍会打印 `REVIEW_RESULT`，而 `--judge-skeleton` 只接受 `outcome=ok` 的轮次。
- **不合规范 / 不可信输入**：查了 `parseArgs` 对 `--pr`、`--base`、`--previous`、`--models`、`--gateway`、`--accept-low` 的校验，以及 `parseVerdicts` 对模型名、换行、控制字符的校验；这些没有因本改动变化。新发现的不可信/不完整输入是 `NEXT` 命令里的 `<材料文件>` 占位符。
- **安全**：本改动不新增外部输入路径、不新增网络请求、不改变遮盖逻辑；子代理仍不能运行花钱复核、不能 `--accept-unreviewed`、不能改别的分支。没有发现新的凭据或秘密泄露路径。
- **资源耗尽**：主线程后台跑 40 分钟，而脚本默认 `--timeout-minutes 25`；真正的浪费点是失败轮次仍起子代理，每次约 7 万 token。
- **不可撤销操作**：没有。改动只涉及复核、判断、提交和推送，不涉及删除、部署、合并。
- **规则 / 文档 / 代码一致**：发现第 1、2、5、6、7、8、9 条所述不一致。
- **未核实**：Claude Code 的「后台 Bash 结束会叫醒主线程」和「子代理缓存 5 分钟」属于平台行为，仓库代码里没有；PR 481 的原始会话记录不在仓库内，只能核对数据文件的转述；没有运行测试（复核环境只允许读和 git 只读命令）。

## 意见

### 1. 中高 — 把「出现 REVIEW_RESULT」当成复核成功，失败轮次也会起子代理

文件:行：`.agents/instructions/model-review-card.md:19`；`scripts/model-review/opencode-review.mjs:1157`、`:1681-1682`、`:3656-3657`

问题：流程卡说「输出里有 `REVIEW_RESULT` 行以后」就起子代理。但脚本对**每一条结果**都打印 `REVIEW_RESULT`，不管 `outcome` 是不是 `ok`；`--judge-skeleton` / `--finish-round` 又要求最新一轮至少有一条 `ok` 记录，否则抛 `ROUND_NOT_OK`。

证据（读代码证实）：

- `scripts/model-review/opencode-review.mjs:3656-3657`：`for (const record of results) { console.log(resultLine(record)); ... }`，`results` 包含失败的记录。
- `:1157`：`REVIEW_RESULT round=... outcome=${record.outcome} ...`，失败时也会打印。
- `:1681-1682`：`const ok = own.filter((record) => record.outcome === "ok"); if (ok.length === 0) throw new Error(\`ROUND_NOT_OK round-${round}\`);`
- 流程卡第 19 行用「有没有 `REVIEW_RESULT`」而不是「`outcome` 是不是 `ok`」判断。

推测：单模型失败时，主线程会起一个子代理，子代理第一步 `--judge-skeleton` 直接报 `ROUND_NOT_OK`，白花约 7 万 token；双模型一轮里一个成功一个失败时更糟：`ok.length > 0`，子代理会只用成功那个模型的答案继续判断，失败模型的意见被静默漏掉。流程卡的报错表里也没有 `ROUND_NOT_OK`。

建议：把条件改成「所有该跑的模型都有 `outcome=ok` 的 `REVIEW_RESULT`」；主线程同时检查命令退出码。把 `ROUND_NOT_OK` 加进报错表。若只想用默认模型，也要明确「至少默认模型 `ok`」。

### 2. 中 — `NEXT` 命令里的 `<材料文件>` 占位符没人负责替换

文件:行：`.agents/instructions/model-review-card.md:18`；`.claude/agents/code-review-round.md:16`；`scripts/model-review/opencode-review.mjs:1803`

问题：`--finish-round` 打印的下一轮命令是：

`NEXT fix-and-rereview ... --head <修改后的提交> --previous ${reviewed} --pr ${pr} --brief <材料文件>${gateway}`

流程卡只说「把 `<修改后的提交>` 换成它交回的新提交，`--previous` 已经填好」，没有说 `<材料文件>` 也要替换；子代理定义也只提到 `<修改后的提交>`。

证据（读代码证实）：

- `scripts/model-review/opencode-review.mjs:1803` 明确含有 `--brief <材料文件>`。
- 流程卡第 18 行只列了 `<修改后的提交>` 一个替换项。
- 子代理定义第 16 行只写「下一轮命令里的 `<修改后的提交>` 换成哪个提交」。

推测：主线程照抄后，shell 会把 `<材料文件>` 当成输入重定向，`--brief` 取到下一个参数或缺失，脚本以 `ARG_MISSING_VALUE --brief` / `ARG_UNKNOWN` 失败，下一轮根本跑不起来。旧流程里命令由子代理执行、子代理提示里有材料路径，风险较小；现在改由主线程执行，这个遗漏更容易发生。

建议：流程卡和子代理定义都明确「`<修改后的提交>` 和 `<材料文件>` 两个占位符都要替换」；更好的做法是让 `--finish-round` 从账本或本轮记录里带上 brief 路径，不再打印占位符。

### 3. 中 — Andy 采纳「可以更好」后，谁修改没有写清

文件:行：`.agents/instructions/model-review-card.md:31`、`:44-48`；`.agents/instructions/model-review.md:62`、`:71`

问题：流程卡说「Andy 采纳了『可以更好』的意见，或者要再跑一轮，同样先由主线程跑复核，再起子代理。」但按新流程，复核是在子代理启动**之前**跑的；子代理第 4 步只按 `NEXT` 修中高问题，没有步骤说谁先把 Andy 采纳的「可以更好」改动做掉。这样复核看到的仍是没有采纳改动的代码，采纳的改动可能被漏掉，或者在复核之后才做、变成未复核改动。

证据（读代码证实）：

- 流程卡第 31 行只说「先由主线程跑复核，再起子代理」。
- 子代理第 4 步（第 44-48 行）只分 `fix-and-rereview`、`fix-low-then`、`low-deferred`、`done`，`fix-and-rereview` 写的是「修中高问题」，没有「可以更好」。
- `model-review.md:62`、`:71` 要求「Andy 采纳的意见做了修改，就对这些修改再复核一轮」，但没说这一步由谁执行。

推测：这是分工上的真实空档。若主线程先跑复核再起子代理，子代理不会主动做「可以更好」的采纳改动；若子代理做了，又没有指令让它再请求一轮复核。

建议：在流程卡明确一条：主线程先按 Andy 采纳的意见修改并提交（或先起一个专门修改的子代理），再用 `--previous <上一轮复核提交>` 跑复核；或者明确规定由判断子代理先做采纳修改，然后交回主线程跑复核。不能只写「先跑复核再起子代理」。

### 4. 中 — `fix-low-then` 之后谁做收尾没有写

文件:行：`.agents/instructions/model-review-card.md:29`、`:46`、`:49`

问题：主线程只写了 `fix-and-rereview`、`low-deferred`、`done` 三个分支，没有写 `fix-low-then`。子代理在 `fix-low-then` 分支会修低问题、跑 `--accept-low`、提交账本，然后交回；之后没有指令告诉主线程进入收尾或再跑 `--assert-reviewed` / `--report`。

证据（读代码证实）：

- `model-review-card.md:29`：只列了 `fix-and-rereview` 和 `low-deferred` / `done`。
- `:46`：`fix-low-then` 是独立分支，子代理执行 `--accept-low` 后不再复核。
- `:49`：子代理只在「主线程要求收尾时」做合并前检查。

推测：`--accept-low` 成功后如果主线程不主动要求收尾，可能没有人跑最终的 `--assert-reviewed` / `--report`，PR 停在「低问题已改、账本已提交」但没有最终检查。

建议：在第 29 行加上 `fix-low-then`：子代理交回后，主线程进入收尾并自己跑 `--assert-reviewed`、`--report`。

### 5. 低 — 先问线的估算 0.1 美元和脚本的 0.2 美元上限不一致

文件:行：`.agents/instructions/model-review-card.md:18`；`scripts/model-review/opencode-review.mjs:144`、`:1140-1147`

问题：流程卡说「已花的加上这一轮预计约 0.1 美元会超过 1 美元时先问 Andy」。脚本 `budgetCheck` 用的是每个模型 `COST_LIMIT_PER_MODEL_USD = 0.2`，即这一轮最多按 0.2 美元预留。

证据（读代码证实）：

- `scripts/model-review/opencode-review.mjs:144`：`export const COST_LIMIT_PER_MODEL_USD = 0.2;`
- `:1142-1147`：`const thisRunMax = COST_LIMIT_PER_MODEL_USD * models.length; const total = spent + thisRunMax; ... if (total <= line) return null; ... return \`BUDGET_NEEDS_APPROVAL ...\`;`
- 流程卡第 18 行写的是 0.1。

推测：已花在 0.81 到 0.90 之间时，主线程按 0.1 估算可能认为不用先问，但脚本会以 `BUDGET_NEEDS_APPROVAL` 拒绝；主线程只好停下来问 Andy 再带 `--approved-usd` 重跑。不会造成未批准的花费，但多一次往返，也和作者「判断规则不变」的说法不完全一致。

建议：流程卡改成「按脚本每个模型 0.2 美元的上限估算」，并明确 `BUDGET_NEEDS_APPROVAL` 时把数字报给 Andy、用 `--approved-usd` 重跑。

### 6. 低 — 「等复核 8 到 12 分钟」没有数据支撑，数据里有 5.4 分钟

文件:行：`.agents/instructions/model-review-card.md:6`；`docs/adr/0263-cheaper-claude-side-of-code-review.md:53`；`docs/assets/review-cost/2026-11-13-data.txt:38`

问题：流程卡和 ADR 都说子代理「等 8 到 12 分钟的复核」。数据文件记录的是「这两次之前分别空等了 10.8 分钟（等 DeepSeek 复核）和 5.4 分钟」。

证据（读代码/文档证实）：

- 数据文件第 38 行：`分别空等了 10.8 分钟（等 DeepSeek 复核）和 5.4 分钟，都超过子代理缓存的 5 分钟`。
- 数据只把 10.8 分钟标成「等 DeepSeek 复核」，5.4 分钟的等待对象没有标明；无论如何，5.4 不在 8 到 12 的范围内。

推测：这不影响「5.4 分钟也已超过 5 分钟缓存」的结论，但「8 到 12 分钟」是范围扩大后的转述，和引用数据对不上。

建议：改成「实测等待约 5 到 11 分钟」，或直接写「10.8 分钟和 5.4 分钟两次都超过 5 分钟」。

### 7. 低 — 子代理返回清单不再包含 `REVIEW_SPENT_TOTAL`，流程卡仍说主线程看「它交回的已花的钱」

文件:行：`.agents/instructions/model-review-card.md:29`；`.claude/agents/code-review-round.md:15-16`

问题：流程卡说 `NEXT fix-and-rereview` 时主线程「看一眼它交回的计数和已花的钱」。但子代理定义的最后交回清单只剩 `ROUND_SUMMARY`、`NEXT`、提交和意见，不再包含 `REVIEW_SPENT_TOTAL`。

证据（读代码/文档证实）：

- `.claude/agents/code-review-round.md:15-16`：只列 `ROUND_SUMMARY`、`NEXT`、改了哪些提交、下一轮命令里的 head。
- `.agents/instructions/model-review-card.md:29`：写着「它交回的计数和已花的钱」。

推测：主线程其实在自己的复核输出里有 `REVIEW_SPENT_TOTAL`，所以不会丢数据；但流程卡的说法会让主线程等一个不会交回的字段。

建议：改成「用主线程自己那条 `REVIEW_SPENT_TOTAL`」，或者把 `REVIEW_SPENT_TOTAL` 加回子代理交回清单。

### 8. 低 — 子代理定义里的「花钱超过先问线」已过时

文件:行：`.claude/agents/code-review-round.md:11`

问题：子代理不再运行 `--mode code-review`，可用的子命令（`--judge-skeleton`、`--finish-round`、`--accept-low`、`--assert-reviewed`、`--report`）都不花钱；但定义里仍写「花钱超过流程卡写的先问线」。

证据（读代码证实）：

- `scripts/model-review/opencode-review.mjs:3390-3403`：这四个子命令直接返回，不进入模型调用。
- 子代理定义第 11 行仍保留花钱先问的措辞。

推测：这不会直接造成错误，但会让子代理在应当继续判断时误以为要停下来问钱，或者让读者误以为子代理还能产生复核费用。

建议：删掉这句话，或改成「复核费用由主线程负责；子代理只跑上面这些不花钱的子命令」。

### 9. 低 — ADR 0263 决定正文仍说子代理跑复核，和新增修订条矛盾

文件:行：`docs/adr/0263-cheaper-claude-side-of-code-review.md:52-53`

问题：决定第 1 条正文仍写「由它跑这一轮复核、逐条判断、按结论修改并提交」，紧接着的 2026-11-14 修订条写「子代理从生成判断草稿开始，不再跑花钱的复核」。

证据（读代码/文档证实）：

- 第 52 行原文仍是「由它跑这一轮复核」。
- 第 53 行修订条明确说「不再跑花钱的复核」。

推测：ADR 保留历史正文、用修订条覆盖是仓库已有做法，所以不一定算错；但读者只看决定正文会得到旧结论，和流程卡、子代理定义冲突。

建议：在第 52 行末尾加「（2026-11-14 修订：复核改由主线程跑，见下条）」，或把正文改成现行做法。

### 10. 低 — 新增流程没有自动检查，现有测试只验证锚点和参数存在

文件:行：`test/tooling/review-round-tools.test.mjs:249-265`

问题：这个 PR 的新流程描述没有对应测试。现有「review card」用例只检查：`model-review.md` 锚点存在、流程卡里提到的 `--option` 在脚本里出现过、ADR 链接文件存在、流程卡长度小于 12000。它不会检查「`REVIEW_RESULT` 是否代表成功」「`NEXT` 命令的占位符是否都被替换」「1 美元先问线是否和脚本一致」。

证据（读代码证实）：

- `test/tooling/review-round-tools.test.mjs:254-264`：只做锚点、`--options`、ADR 链接和长度断言。
- 没有断言 `REVIEW_RESULT` 的 `outcome`、`NEXT` 的 `<材料文件>`、`BUDGET_NEEDS_APPROVAL` 阈值。

推测：第 1 条和第 2 条这样的矛盾可以完全通过现有测试；反向用例（例如把成功条件写成「有 REVIEW_RESULT 就行」）不会失败。

建议：至少加两类反向用例：一是「失败轮次不应起子代理」，二是「`NEXT` 命令里的每个 `<...>` 占位符都在流程卡/子代理定义里有替换说明」。更稳的做法是让 `--finish-round` 输出结构化的 `NEXT_HEAD` / `NEXT_BRIEF` 字段，测试直接核对。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 PR 没有改代码，`buildPrompt`、`MODE_TEXT`、`MODEL_LENSES`、`reviewQuestions`、工具配置和遮盖逻辑都没变；发给复核模型的仍然只有固定的指令、侧重点和必答问题，加上末尾的本轮材料（`head`、`base`、`previous`、`brief`）。新流程只是把同一个 `--mode code-review` 命令从子代理挪到主线程执行，主线程自己的对话是追加一条工具调用和工具输出，不是改写已有前缀。按 `prompt-prefix.md` 的规则，已有对话的前缀不受影响；改 AGENTS.md / 流程卡只影响新对话，这是规则允许的。依据：`scripts/model-review/opencode-review.mjs:349-371`、`:298-337`，以及本次 diff 只含文档。

2. **会不会让同一段文字在不同请求里变成不同字节？** 没有新增这种来源。新文档和数据是静态文本；`amended_by` 是静态字符串；没有新增时间、随机数或无序集合。`REVIEW_RESULT` / `REVIEW_SPENT_TOTAL` 的数值每轮不同，但它们只出现在主线程的工具输出里，不进复核模型的提示词前缀，也不参与同一段文字的序列化。依据：`resultLine`（`:1156-1158`）、`budgetCheck`（`:1140-1147`）和 diff。

3. **有没有对应的自动检查？反向用例会真的失败吗？** 只有部分。`test/tooling/review-round-tools.test.mjs:249-265` 会检查流程卡的锚点、提到的选项是否在脚本里存在、ADR 链接是否存在，以及卡片长度；它**不会**检查新流程的成功条件、`NEXT` 占位符或 0.1/0.2 阈值。因此第 1、2、5 条这类错误不会被现有反向用例拦下。建议按第 10 条补测试。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `amended_by`（`docs/adr/0175-cheaper-code-review-rounds.md:8`）：使用方是 `scripts/check-adr-numbers.mjs` 的路径正则和人工阅读；逗号分隔多路径在仓库里已有先例（ADR 0031、0176），两边的 `amends` / `amended_by` 也双向一致，**可以接受**。
   - `REVIEW_RESULT`：产生方 `resultLine`（`:1157`）对所有结果都打印；使用方流程卡第 19 行把「存在」当成功，**不能接受**，见第 1 条。
   - `REVIEW_SPENT_TOTAL`：产生方在运行结束时打印（`:3688-3689`），流程卡第 23 行把它传给子代理，**可以使用**；但第 29 行说子代理交回它，与子代理定义不一致，见第 7 条。
   - `NEXT` 命令：产生方 `finishRound`（`:1803`）含 `<修改后的提交>` 和 `<材料文件>` 两个占位符；使用方流程卡第 18 行只说明替换前者，**不能直接接受**，见第 2 条。
   - 子代理列出的子命令：`--judge-skeleton`、`--finish-round`、`--accept-low`、`--assert-reviewed`、`--report` 都真实存在（`:3045-3048`、`:3065-3068`、`:2985-3000`）；但 `--accept-low` 必须和 `--assert-reviewed` 一起用（`:3137-3139`），子代理定义里单独列它容易让人误用，实际应按 `--finish-round` 打印的完整命令执行。
   - 数据里的数字：`8 到 12 分钟` 与数据的 `10.8 / 5.4 分钟` 对不上，见第 6 条；`0.1 美元` 与脚本的 `0.2 美元/模型` 对不上，见第 5 条；`约 7 万 token` 与数据的 7.05 万到 7.26 万、72569 基本一致。
