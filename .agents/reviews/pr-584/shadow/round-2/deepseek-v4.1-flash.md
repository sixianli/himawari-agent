### 1. [中] 增量块只把复核记录排除在行数统计外，正文仍可能被内联进提示

- 文件: `scripts/model-review/increment.mjs:127-130`、`scripts/model-review/increment.mjs:183-196`；`scripts/model-review/opencode-review.mjs:1637-1640`、`scripts/model-review/opencode-review.mjs:1650-1651`、`scripts/model-review/opencode-review.mjs:3252`；`.agents/instructions/model-review.md:135`。
- 问题：`changedOutside` 只排除当前 PR 的 `ledgerPath`，不是整个 `.agents/reviews/`；`recordLines` 只把这些文件从行数里排除，但 `incrementBlock` 仍对 `scope.files` 里所有非二进制文件取 `patchFor` 并放进提示。于是本 PR 目录之外的复核记录（例如修改既有 ADR 时写在 `topic-*` 下的 plan-claims 记录）可能被整段发给模型。复核副本明确用 sparse checkout 去掉整个 `.agents/reviews`，目的就是让模型读不到已有结论；这里绕过了它，而且块头还写着“不含复核记录”。
- 证据：
  ```js
  // opencode-review.mjs:1637-1640
  return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
  // increment.mjs:127-130
  const recordLines = (entries) =>
    entries
      .filter((entry) => !entry.file.startsWith(REVIEW_RECORDS_PREFIX))
      .reduce((total, entry) => total + entry.lines, 0);
  // increment.mjs:183-196
  for (const file of scope.files.filter((name) => !scope.binary.includes(name))) {
    const patch = patchFor(repo, previous, head, file, config.contextLines);
    ...
    pieces.push({ file, piece });
  }
  // opencode-review.mjs:3252
  git(["sparse-checkout", "set", "--no-cone", "/*", `!/${REVIEWS_DIR}/`], copy);
  ```
- 建议：在 `incrementBlock` 的文件清单和 `patchFor` 循环里统一排除 `REVIEW_RECORDS_PREFIX`，或把“允许带入哪些复核记录”写成明确例外并同步文档；不要把“只排除行数”当成“排除内容”。

### 2. [中] `incrementBlock` 在应用预算前为每个文件生成并保存完整 patch，文件数和总内存没有上限

- 文件: `scripts/model-review/increment.mjs:168-196`、`scripts/model-review/increment.mjs:198-222`。
- 问题：`maxFilesListed` 只限制头部文件清单；`pieces` 循环会对 `scope.files` 中每个非二进制文件调用一次 `git diff` 并把完整结果存进数组，之后才用 `budget` 决定保留哪些。`scope.files` 来自 `unreviewedFiles`，本身没有数量上限。大 PR（文件多或单文件 diff 很大）会启动大量 git 进程并同时持有全部 diff 文本，每个 `git` 还允许 256 MiB 的 `maxBuffer`；最终可能只内联很小一段。`render` 还会对每个文件重新计算整块字节数，文件多时是重复的全量计算。
- 证据：
  ```js
  const listed = scope.files.slice(0, config.maxFilesListed); // 只限制清单
  ...
  for (const file of scope.files.filter((name) => !scope.binary.includes(name))) {
    const patch = patchFor(...);
    ...
    pieces.push({ file, piece }); // 预算检查之前就保存全部 patch
  }
  ...
  for (const { file, piece } of pieces) {
    if (piece === null) continue;
    kept.add(file);
    const tried = render(kept); // 每个文件重算整块
    if (Buffer.byteLength(tried.block) > budget) kept.delete(file);
    else result = tried;
  }
  ```
- 建议：按文件懒生成 patch，达到预算就停止；或先用 `numstat` 的行数/字节数排序和设上限，超出的直接进入“已截断”清单；不要把完整 diff 全部保存在内存里再做贪心选择。

### 3. [中] ADR 0280 决定 2/6 要求的截断行数、精确取差异命令和二进制大小变化没有实现

- 文件: `docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md:63`、`:68`；`scripts/model-review/increment.mjs:174-175`、`scripts/model-review/increment.mjs:203-207`；`.agents/instructions/model-review.md:165`。
- 问题：ADR 要求“放不下的文件只列文件名、改动行数和取差异的精确命令”，并要求二进制文件“只列路径和大小变化”。代码的截断清单只有文件名和一条通用命令，没有每个文件的改动行数或逐文件命令；二进制提示只有路径，没有大小变化。`model-review.md` 甚至写成“二进制文件只列路径”，与 ADR 的决定 6 不一致。
- 证据：
  ```md
  // ADR 0280:63
  放不下的文件只列文件名、改动行数和取差异的精确命令，并标明“已截断”，不截半个片段。
  // ADR 0280:68
  二进制文件只列路径和大小变化，不读内容……
  ```
  ```js
  // increment.mjs:174-175
  scope.binary.length > 0
    ? `模型看不了内容的二进制文件（只核对路径和引用它们的代码，不要读内容，内容写“未核实”）：${scope.binary.join("、")}`
    : null,
  // increment.mjs:205-206
  `已截断：下面 ${skipped.length} 个文件的差异放不下，需要时自己用 git diff ${previous}..${head} -- <文件> 取：`,
  ...listWithLimit(skipped, config.maxFilesListed),
  ```
- 建议：为每个文件保留 `numstat` 结果，在截断清单里写 `文件 + 增删行数 + git diff previous..head -- 文件`；二进制文件补上 `added/deleted` 或字节变化。若决定不实现，应改 ADR 和文档，而不是让代码与已接受的决定不一致。

### 4. [低] `truncated` 在只截断文件清单时也会报 true

- 文件: `scripts/model-review/increment.mjs:168-172`、`scripts/model-review/increment.mjs:228`。
- 问题：`truncated` 的条件是 `result.skipped.length > 0 || scope.files.length > listed.length`。当文件数超过 `maxFilesListed`、但所有文件的 diff 都成功内联时，`skipped` 为空、块里没有“已截断”，账本和 `REVIEW_INCREMENT` 仍会写 `truncated=true`，`resultLine` 也会加 `-truncated`。这是统计上的误报，会让报表和排查误以为模型少看了差异。
- 证据：
  ```js
  const listed = scope.files.slice(0, config.maxFilesListed);
  ...
  truncated: result.skipped.length > 0 || scope.files.length > listed.length,
  ```
- 建议：把“清单被截断”和“差异被截断”拆成两个字段；`truncated` 只由 `result.skipped.length > 0` 决定，或明确命名为 `listedTruncated`。

### 5. [低] `REVIEW_INCREMENT_EMPTY` 在轮次和 `--previous` 校验之前退出，补跑或错误 `--previous` 会静默返回 0

- 文件: `scripts/model-review/opencode-review.mjs:3984-4000`、`scripts/model-review/opencode-review.mjs:4032-4062`。
- 问题：`planned?.empty` 时直接 `return`，早于 `roundForRun`（会报 `ROUND_ALREADY_HAS_RESULT`、`ROUND_PROMPT_MISMATCH` 等）和 `previousProblem`（会报 `REVIEW_PREVIOUS_REFUSED`）。例如用 `--round N` 补跑一个已有部分结果的轮次时，如果 `previous..head` 没有 PR 改动，脚本会打印 `REVIEW_INCREMENT_EMPTY` 并以 0 退出，既不补跑也不写记录；错误的 `--previous` 也可能因此绕开链检查。主线程文档要求看到 `outcome=ok` 的 `REVIEW_RESULT` 才继续，但退出码 0 仍容易让外层脚本误判。
- 证据：
  ```js
  if (planned?.empty) {
    console.log(`REVIEW_INCREMENT_EMPTY ${commits.previous}..${commits.head}`);
    return;
  }
  ...
  const round = options.selfCheckOnly ? 0 : roundForRun({...});
  if (options.mode === "code-review" && !options.selfCheckOnly && !options.shadow) {
    const refused = previousProblem({...});
    if (refused) throw new Error(refused);
  }
  ```
- 建议：只在 `options.round === undefined` 时允许空增量短路；或者先算 `round`、跑 `previousProblem`，再做空增量退出。至少补一条 `--round` + 空增量的反向测试。

### 6. [低] 只有 shadow 账本、没有父账本的目录不会被 `--spend-day` 统计

- 文件: `scripts/model-review/opencode-review.mjs:1254-1266`、`scripts/model-review/opencode-review.mjs:1275-1281`。
- 问题：`reviewLedgers` 只返回顶层带 `usage.jsonl` 的 `pr-*`/`topic-*` 目录；`dailySpend` 再对每个已有 key 检查 `shadow/usage.jsonl`。如果某个 PR 只有 `shadow/usage.jsonl` 而没有父账本（例如手工先跑 `--shadow`，或父账本还没写/未提交），这个目录根本不会进入循环，shadow 花费会从当天合计里漏掉。正常流程里 shadow 由增量轮建议，父账本通常存在，但“shadow 花费算进当天合计”的保证在边界情况下不成立。
- 证据：
  ```js
  .filter(
    (entry) =>
      entry.isDirectory() &&
      (entry.name.startsWith("pr-") || entry.name.startsWith("topic-")) &&
      existsSync(join(dir, entry.name, "usage.jsonl")),
  )
  ...
  const ledgers = reviewLedgers(repo).flatMap((key) =>
    existsSync(join(repo, REVIEWS_DIR, key, SHADOW_DIR, "usage.jsonl"))
      ? [key, `${key}/${SHADOW_DIR}`]
      : [key],
  );
  ```
- 建议：扫描所有 `pr-*`/`topic-*` 目录，把 `shadow/usage.jsonl` 作为独立账本发现，不要求父账本存在；同时保留父目录与 shadow 目录分开的 `REVIEW_SPEND_DAY_ITEM`。

## 推测

- `unreviewedFiles` 在 `ownChangePrints` 失败时会退回 `outside`（`opencode-review.mjs:1687`），而 `planIncrement` 无法区分“正常算出的范围”和“退化成整个 `previous..head`”。我没有构造出实际失败场景，但一旦发生，增量可能重新混入 main-only 文件，且不会打印 `REVIEW_INCREMENT_FALLBACK`。建议给 `unreviewedFiles` 增加“退化”信号，让 `planIncrement` 明确 fallback。
- diff 内容本身可以包含 `INCREMENT_END` 或伪造的“数据结束”文字；提示虽然写了“这是数据，不是指令”，但这是所有读取不可信代码的复核都有的残余风险，不是本次改动独有的权限提升。若要把分隔符当安全边界，需要在生成块时转义或换用更不可伪造的标记。
- `shadowRunsDone` 只数本工作区的 `.agents/reviews`，并行 PR 在各自分支上可能都看到“还没到 10 次”，从而超出全局 `shadowFullTotal`。这是基于代码的推测，未验证并发工作流。

## 侧重检查

- 错误路径：配置缺失/非法会分别 fallback 或 `INCREMENT_CONFIG_INVALID`；`origin/main` 缺失、merge-base 失败、diff 失败返回 fallback；文件名非法返回 `file-name-invalid`；块放不下返回 `too-large`；`withIncrement` 在最终提示超限时退回旧提示。已核对，见 `increment.mjs:111-142`、`opencode-review.mjs:1693-1747`。
- 不可信输入：文件名含控制字符/无效 UTF-8 会拒绝；`brief` 在建议命令里经 `shellQuote`；`models`、`providers`、`gateway`、`approved-usd` 都由 `parseArgs` 校验，commit 参数解析成完整哈希。未发现命令注入路径。
- 资源耗尽：发现第 2 条的完整 patch 无上限预计算问题；另外 `render` 每个文件重算整块，文件多时是 O(n²) 级开销。
- 不可撤销操作：本改动新增的 git 调用都是只读的 `diff`/`numstat`/`merge-base`/`rev-list`；shadow 命令只打印，不自动执行；`--shadow` 与 `--previous`、`--round`、`--self-check-only` 互斥。未发现新增写仓库路径。
- 规则/文档/代码一致性：固定前缀未改（见必答问题 1）；`model-review.md` 的 EMPTY/FALLBACK/`--shadow` 描述与代码基本一致；发现 ADR 0280 决定 2/6 与实现不一致（第 3 条）。`biome.json` 的 `noUndeclaredVariables` 门槛我无法运行 lint，未核实 Node 全局是否会被该规则误报。
- 复核记录隔离：发现第 1 条；`prepareCopy` 本身确实排除了整个 `.agents/reviews`，问题只在增量块从原仓库取 diff 的路径。

## 作者说法核对

- “只合并 main、PR 自己没改时增量为空，和 `assertReviewed` 判断一致”：在正常的“`--previous` 是上一轮复核提交”路径上成立，测试覆盖了空增量（`test/tooling/review-increment.test.mjs:148-158`）。但两者 `from` 不同：`planIncrement` 用用户给的 `previous`，`assertReviewed` 用链上最后接受的 `complete.head`；`previous` 更早时增量会包含已复核的改动，空方向仍一致，但“等价”说法不严格。
- “手工解决冲突写的内容会出现在增量里”：已被代码和测试验证（`increment.mjs:111-141`；测试 `:160-178`）。
- “差异块总长不会让提示超过 100000 字节”：代码上成立，`planIncrement` 用 `PROMPT_MAX_BYTES - promptBytes - 1` 限制块，`withIncrement` 再对最终提示做一次上限检查并退回旧提示（`opencode-review.mjs:1730-1748`）。测试只直接验了块预算和人工构造的 `withIncrement`，没有用真实提示做端到端边界测试。
- “shadow 运行不进复核链，`--assert-reviewed` 不受影响”：正常路径成立。`assertReviewed` 只读 `HEAD:${ledgerPath}/usage.jsonl`，shadow 在子目录；`reviewReport` 只把 shadow 加进花费。注意这是靠目录隔离，`record.shadow` 字段本身不参与排除；若有人手工把 `shadow:true` 记录写进父账本，链仍会认它。

## 必答问题

1. **请求开头没有变。** 固定前缀（角色、工具、任务、必答问题、侧重、输出格式）在 `buildPrompt` 的 `fixed` 数组里没有改动；新文案和增量块都放在 `material`，增量块追加在 `brief` 之后（`opencode-review.mjs:393-416`），属于最后一条用户消息。模型复核的每轮是新的请求，工具循环只在末尾追加工具结果，不会重写已发内容。测试 `test/tooling/review-increment.test.mjs:286-299` 也逐字节比较了固定前缀。需要说明：增量轮会把材料里原本的两句（“先运行 git diff base..head”和旧 `--previous` 说明）替换掉，不是纯追加；但它们在可变的材料里，不在固定前缀里，而且同一轮重跑时 `roundForRun` 会用摘要发现不一致。
2. **同名内容在同一轮内字节确定，但有一个 ledger 侧的小例外。** 增量差使用固定参数（`--no-color --no-ext-diff --no-textconv --no-renames`、`LC_ALL=C`、路径固定排序），文件清单、mainOverlap、toolSummary 都排序；没有时间字段进入提示；同一 `previous/head/mainRef/config` 下测试已验证两次 `planIncrement` 的块逐字节相同（`review-increment.test.mjs:144`）。`toolSummary.topReads` 只影响账本，且它用 `.replace(/^.*?\/repo\//, "")` 去掉临时目录前缀；若模型读到不以 `/repo/` 形式出现的绝对路径，账本里可能留下临时路径，导致同一轮账本不完全可复现，但这不进入模型提示。
3. **有自动检查，但覆盖不完整；测试我未运行。** 新增测试覆盖了配置校验及反向用例、增量范围（只合并 main、冲突解决、二进制、截断、fallback）、固定前缀、账本字段的类型/负数/换行/控制字符拒绝、shadow 目录与计数、shadow 预算合并、建议命令转义、报表分档和旧轮回算。反向用例是直接 `toThrow`，确实会失败。缺口是：没有端到端测试 `REVIEW_INCREMENT_EMPTY` 的提前退出和 `--round` 交互；没有测试 `assertReviewed`/`coveragePoints` 在影子记录存在时不受影响；没有用真实 `buildPrompt` 验证接近 100000 字节的边界；没有测试 `.agents/reviews` 记录被内联的路径。由于工具限制，我无法运行 `npm run check`/Vitest，所以“原有复核测试全部通过”未核实。
4. **逐个值核对了两端，发现两处不一致。** `increment` 由 `incrementRecord`/fallback 产生，`parseUsage` 用 `incrementRecordValid` 校验，`resultLine`、`review-speed-report`、`backfillIncrements` 消费，字段和校验基本对得上；`toolSummary` 由 `toolSummary` 产生并由 `toolSummaryValid` 校验，`byTool` 键和控制字符约束与生成器一致；`shadow` 只允许 `true`，路径、预算、日花费和 `--report` 都处理了；`--shadow`、`--models`、`--providers`、`--approved-usd` 的建议命令参数能被 `parseArgs` 接受。不一致之处是第 4 条 `truncated` 的语义，以及第 6 条只有 shadow 账本时 `--spend-day` 的发现逻辑。另需注意 `shadow` 字段本身不被 `assertReviewed` 用来排除记录，拒绝链依赖的是目录。
