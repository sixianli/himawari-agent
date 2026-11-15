## 复核结论

以下意见按严重度排列。第 1–4、6 条为读代码证实；第 5、7 条的具体标注中，涉及运行环境行为的部分是推测。

### 1. 中：规则说 `--spend-day` “只算已合进 main 的账本”，代码实际算工作区里所有账本

- 文件:行：`.claude/rules/owner-standing-rules.md:17`；`scripts/model-review/opencode-review.mjs:1226-1238`
- 问题：同一 PR 的两份规则文字对同一行为说法不一致，而且规则与代码不一致。按代码，在功能分支上运行 `--spend-day` 会把这个分支尚未合进 main 的账本、甚至未提交的账本一起算进去。
- 证据：

  `.claude/rules/owner-standing-rules.md:17`：
  > 每天的复核和核对花费由协调者用 `node scripts/model-review/opencode-review.mjs --spend-day` 汇总报给 Andy（只算已合进 `main` 的账本）

  `.agents/instructions/model-review.md:140`：
  > 它按日本时间的日期把工作区里所有 `.agents/reviews/*/usage.jsonl` 的花费加起来……只看得到已经在这个工作区里的账本：别的分支上还没合进来的复核不在内，所以先合最新 `main` 再看。

  代码 `opencode-review.mjs:1226-1237`：
  ```js
  function reviewLedgers(repo) {
    const dir = join(repo, REVIEWS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name.startsWith("pr-") || entry.name.startsWith("topic-")) && existsSync(join(dir, entry.name, "usage.jsonl")))
  ```
  代码没有任何“只读 main”的检查，直接读工作区目录。
- 建议：把 `.claude/rules/owner-standing-rules.md:17` 改成和代码一致的“只算这个工作区里现有的账本（别的分支还没合进来的不算）”；如果确实要求只算 main，应在命令里显式读 `origin/main` 的树，而不是读工作区。

### 2. 中：别的 topic 账本损坏会挡住无关的 plan-claims 复核，且让 `--spend-day` 整条命令失败

- 文件:行：`scripts/model-review/opencode-review.mjs:1240-1245`、`:1249-1255`、`:2063-2139`、`:3760-3764`
- 问题：`claimsFileRecords` 和 `dailySpend` 对每本兄弟账本直接调用 `readUsage`；只要有一行 JSON 坏掉或字段校验不过，`parseUsage` 就抛 `USAGE_LEDGER_INVALID`。`main` 的兜底会把错误打印后以 2 退出。结果是：某本与当前 claims 文件无关的旧账本坏了，会阻止当前 plan-claims 开跑；`--spend-day` 也会一条都不打印，失去“汇总当天花费”的作用。
- 证据：

  `opencode-review.mjs:1241-1244`：
  ```js
  return reviewLedgers(repo)
    .filter((key) => key.startsWith("topic-") && key !== exceptKey)
    .flatMap((key) => readUsage(join(repo, REVIEWS_DIR, key)))
    .filter((record) => record.mode === "plan-claims" && record.claimsFile === claimsFile);
  ```

  `opencode-review.mjs:1249-1253`：
  ```js
  for (const key of reviewLedgers(repo)) {
    const records = readUsage(join(repo, REVIEWS_DIR, key)).filter(...)
  ```

  `opencode-review.mjs:2137`：
  ```js
  throw new Error(`USAGE_LEDGER_INVALID ${path}:${number}`);
  ```
- 建议：按账本隔离错误。预算路径可以选择“失败即拒绝”，但错误里应明确写出是哪个兄弟账本坏了；`--spend-day` 更合适打印 `REVIEW_SPEND_DAY_UNREADABLE <账本名> <原因>` 后继续汇总并标明“合计不完整”，或明确报错但至少指出坏账本。补一条反向用例：坏一本无关账本时，不相关 claims 文件的核对行为符合设计。

### 3. 中：`at` 不是合法时间字符串时，`dailySpend` 会抛 `RangeError`，而不是给出可读错误

- 文件:行：`scripts/model-review/opencode-review.mjs:1247-1255`、`:2109-2115`、`:2063-2139`
- 问题：`parseUsage` 只对 `mode === "plan-claims"` 的记录校验 `at`；其他模式（例如 code-review）的 `at` 只要求它是字符串就会通过。`dailySpend` 随后对任何字符串调用 `Date.parse` 并 `toISOString()`。当 `record.at` 是字符串但解析失败时，`Date.parse` 返回 `NaN`，`new Date(NaN).toISOString()` 抛 `RangeError: Invalid time value`，整条 `--spend-day` 崩溃，错误信息也不指向坏记录。
- 证据：

  `opencode-review.mjs:2109-2115`：
  ```js
  const claimsValid =
    record?.mode !== "plan-claims" ||
    (validClaimsFile(record.claimsFile) &&
      /^[0-9a-f]{64}$/.test(record.claimsSha256 ?? "") &&
      REVIEW_MODELS.includes(record.model) &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(record.at ?? "") &&
      Number.isFinite(Date.parse(record.at)));
  ```

  `opencode-review.mjs:1250-1254`：
  ```js
  const records = readUsage(join(repo, REVIEWS_DIR, key)).filter(
    (record) =>
      typeof record.at === "string" &&
      new Date(Date.parse(record.at) + JAPAN_OFFSET_MS).toISOString().slice(0, 10) === date,
  );
  ```
- 建议：先取 `const ms = Date.parse(record.at);`，要求 `Number.isFinite(ms)` 再参与比较；或者在 `parseUsage` 里对所有模式的 `at` 都做格式和有限性校验，统一报 `USAGE_LEDGER_INVALID`。补 `at: "not-a-date"` 的反向用例。

### 4. 中低：`--repo` 写错或不存在时，`--spend-day` 静默报 0，plan-claims 也静默少算别的 topic

- 文件:行：`scripts/model-review/opencode-review.mjs:1226-1228`、`:3666-3669`、`:3760-3764`
- 问题：`reviewLedgers` 在 `.agents/reviews` 不存在时直接返回空数组。对预算型命令来说，这是危险的假阴性：`--spend-day --repo /拼错的路径` 会输出 `total=0.000 over=no`；plan-claims 传错 `--repo` 时，跨 topic 汇总也变成空，1 美元门槛被静默放宽。现有测试还把“目录不存在返回空”固化成期望。
- 证据：

  `opencode-review.mjs:1226-1228`：
  ```js
  const dir = join(repo, REVIEWS_DIR);
  if (!existsSync(dir)) return [];
  ```

  `opencode-review.mjs:3666-3669`：
  ```js
  if (options.spendDay) {
    const today = new Date(Date.now() + JAPAN_OFFSET_MS).toISOString().slice(0, 10);
    for (const line of spendDayLines(dailySpend(options.repo, options.date ?? today)))
  ```

  测试 `test/tooling/opencode-review-merge-gate.test.mjs:2134`、`:2160-2164` 都断言空目录返回空结果。
- 建议：显式传了 `--repo` 而该路径不是目录或没有 `.agents/reviews` 时，应报错（例如 `SPEND_DAY_REPO_MISSING`），至少打印一行警告，避免把“路径写错”误读成“今天没花钱”。默认 `--repo` 来自脚本自身路径，可保留宽松行为；测试要区分这两种情况。

### 5. 低：`--date` 只校验格式和 `Date.parse` 可解析，不保证是真实日历日期；测试没有覆盖

- 文件:行：`scripts/model-review/opencode-review.mjs:3316-3319`；`test/tooling/opencode-review-merge-gate.test.mjs:2171-2177`
- 问题：正则只要求四位年、两位月、两位日，`Date.parse` 对不存在的日期是否返回 `NaN` 取决于运行环境。若某环境把 `2026-02-31` 归一化成 3 月 3 日，`--date 2026-02-31` 会通过校验并静默查错日期。现有反向用例只覆盖了 `"11-14"` 这种明显格式错误。
- 证据：

  `opencode-review.mjs:3317-3319`：
  ```js
  options.date = take();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) || Number.isNaN(Date.parse(options.date)))
    throw new Error("ARG_INVALID --date");
  ```

  测试 `opencode-review-merge-gate.test.mjs:2174`：
  ```js
  expect(() => parseArgs(["--spend-day", "--date", "11-14"])).toThrow("ARG_INVALID --date");
  ```
- 建议：做回环校验，例如 `new Date(Date.parse(`${date}T00:00:00Z`)).toISOString().slice(0, 10) === date`，并补 `2026-02-31`、`2026-13-01` 这类用例。`Date.parse` 在 V8 上对不可能日期的具体行为，我未在本环境运行 node 验证，属于推测风险。

### 6. 低：预算已把别的 topic 算进来，但 `REVIEW_SPENT_TOTAL` 仍只报当前账本，规则却让人用它汇报费用

- 文件:行：`scripts/model-review/opencode-review.mjs:3760-3772`、`:4017`；`.agents/instructions/model-review.md:31`、`:139`
- 问题：`budgetCheck` 现在收到 `[...records, ...sameFileRecords]`，但运行结束打印的 `REVIEW_SPENT_TOTAL` 仍只来自 `readUsage(options.out)`。规则第 139 行说“线程汇报费用就用这个数”，而第 31 行说 plan-claims 的 1 美元门槛包括别的 topic 里同一 claims 文件的费用。正常跑完时，协调者看到的累计数会小于门槛判断实际采用的钱。
- 证据：

  `opencode-review.mjs:3760-3769`：
  ```js
  const records = options.selfCheckOnly ? [] : readUsage(options.out);
  const sameFileRecords = ... claimsFileRecords(options.repo, options.claimsFile, reviewKey(options));
  const overBudget = ... budgetCheck({ ..., records: [...records, ...sameFileRecords], ... });
  ```

  `opencode-review.mjs:4017`：
  ```js
  console.log(`REVIEW_SPENT_TOTAL ${totalSpent.toFixed(4)} ${options.out}`);
  ```
- 建议：plan-claims 运行时额外打印一行合并后的累计（例如 `REVIEW_SPENT_TOTAL_SAME_CLAIMS <总额>`），或把 `REVIEW_SPENT_TOTAL` 的口径改成和门槛一致并在规则里写明；否则协调者汇报时会低估同一方案文件的实际累计。

### 7. 低：未知参数写入 stderr 后立即 `process.exit(2)`，可能截断输出；参数内容也未做控制字符处理

- 文件:行：`scripts/check-incident-gates.mjs:101-106`
- 问题：Node 的 `process.exit()` 可能在异步 I/O 完成前退出，管道场景下刚写的 stderr 有被截断的风险；另外未知参数原样拼进输出，若参数含换行或控制字符，会污染错误输出。这两点不影响正常路径，但属于错误路径的健壮性问题。
- 证据：

  ```js
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--open");
  if (unknown.length > 0) {
    process.stderr.write(`INCIDENT_ARGUMENT_UNKNOWN ${unknown.join(" ")}\n`);
    process.exit(2);
  }
  ```
- 建议：改成 `process.exitCode = 2;` 后 `return`，或者把输出放进同步路径；并对未知参数使用仓库里已有的 `hasControlCharacter`/替换函数。`process.exit` 截断的具体概率我未实测，属于推测。

## 侧重检查

- **只读和不可逆操作：** 已核实 `main` 在 `parseArgs` 之后先进入 `options.spendDay` 分支并直接 `return`（`opencode-review.mjs:3666-3670`），不读网关配置、不启动 opencode、不调用模型；`claimsFileRecords`/`dailySpend` 只做 `readdirSync`、`readFileSync`；`check-incident-gates.mjs` 也只读。没有写文件或删除操作。
- **错误路径和不可信输入：** 目录形式的清单、未知参数都有自动测试；损坏的兄弟账本（第 2 条）、非法 `at`（第 3 条）、拼错的 `--repo`（第 4 条）、非法日历日期（第 5 条）是主要残留问题。`--date` 缺失值、`--date` 单独使用、`--spend-day` 带其他子命令参数都已有拒绝测试。
- **安全：** 没有新增网络或密钥使用；`--spend-day` 输出账本目录名和未知参数时未做转义（第 7 条及 `spendDayLines`），但这些值来自本地仓库目录和本地命令行，影响有限。跨 topic 预算可能被仓库里任意 `topic-*` 目录的记录抬高或阻断，这仍在“账本随仓库提交、可信”的既有信任模型内。
- **资源耗尽：** 每次 plan-claims 开跑和每次 `--spend-day` 都会把相关 `usage.jsonl` 整份读入内存并全部解析，没有流式或大小上限；账本规模通常不大，未单独列为问题。
- **规则、文档和代码一致：** 发现第 1、6 条不一致。ADR 0269 新增前提 6 后，把正文引用从“前提 1”改成“前提 6”，指针与新增编号一致；外部原文我无法上网核实，标为**未核实**。两份规则文字确实都改了，但其中“只算已合进 main”的表述与代码相反。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会（读代码证实）。复核脚本的提示词构造没有改：`buildPrompt` 仍是固定的 `fixed` 在前、`material` 附在末尾（`opencode-review.mjs:367-395`）。新增的 `--spend-day`、`claimsFileRecords`、事故清单参数检查都不进入 `buildPrompt`。`.agents/instructions/model-review.md` 虽然改了，但提示词只通过 `reviewQuestions` 抽取 `<a id="checklist"></a>` 到下一个锚点之间的编号条目（`opencode-review.mjs:288-298`）；新增的第 140 行在“怎么跑”一节，位于 checklist（第 79–86 行）之外，不会被抽进提示词。每轮会变的 `head`、`base`、`previous`、`brief`、`priorFindings`、`claimsBase` 仍在末尾的“本次材料”里。系统提示、工具定义、遮盖逻辑都没有改动。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会（读代码证实）。新代码没有新增模型请求字段，也没有改遮盖；`reviewQuestions` 的抽取结果不变。`--spend-day` 的输出本身随日期和账本内容变化，但只打印到控制台，不进入模型请求；`reviewLedgers` 对目录名做了 `.sort()`，`dailySpend` 和 `claimsFileRecords` 的顺序是确定的。若协调者自己把 `--spend-day` 输出粘进后续提示词，那是使用方式问题，不是本改动引入的请求字节不确定性。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，而且主要反向用例是有效的（读代码证实）：
   - `claimsFileRecords` 用例写了同文件的其他 topic、不同文件的 topic、非 plan-claims 的 topic，并传入当前 topic 作为 `exceptKey`；去掉排除当前账本、去掉 mode 过滤或去掉文件名过滤，断言都会失败。
   - `dailySpend` 用例用 `14:50Z`/`15:10Z` 覆盖 JST 跨日，用 `14:59Z` 覆盖前一日边界；去掉 `+9h` 或符号写反，`total` 和 `items` 断言会失败；`over` 也覆盖了 true/false。
   - `parseArgs` 反向用例覆盖 `--date` 格式错误、`--date` 不带 `--spend-day`、`--spend-day` 带 `--pr`。
   - 事故清单测试覆盖目录路径和未知参数 `--Open`，去掉对应的 `try/catch` 或参数检查都会失败。
   - **缺口（读代码证实）：** 没有覆盖兄弟账本损坏、非法 `at`、拼错 `--repo`、真实日历日期；`main` 里 `records: [...records, ...sameFileRecords]` 这行没有端到端或集成测试，只有 `claimsFileRecords` 的纯函数测试；`--spend-day` 也没有一次完整的命令级输出测试。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？** 逐项核对如下（读代码证实）：
   - `options.date`：产生于 `parseArgs:3316-3319`，只被 `main:3668` 传给 `dailySpend`，消费端只做字符串相等比较，不再校验；生产者校验格式但不管日历真实性（第 5 条）。没有其他后端或别名使用这个值。
   - `options.spendDay`：产生于 `parseArgs:3315`，被 `parseArgs:3380-3385` 和 `main:3666` 使用；`SPEND_DAY_OPTIONS` 与分支一致，`--date` 单独使用会被拒绝。
   - `DAILY_SPEND_LINE_USD`：值 5，被 `dailySpend` 的 `over`、`spendDayLines` 的 `line=` 和测试使用；两份规则文字也写 5，当前一致。
   - `record.claimsFile`：写账本前由 `validClaimsFile`/`claimsFileSecretLike` 校验（`parseArgs`），读兄弟账本时由 `parseUsage` 的 `claimsValid` 再校验（`opencode-review.mjs:2109-2115`），两端校验一致；`claimsFileRecords` 用它的原始字符串做相等匹配，路径没有规范化但 `validClaimsFile` 已拒绝 `.`、`..`、空段，实际等价写法很少。
   - `exceptKey`：`main:3764` 传 `reviewKey(options)`，与 `reviewDir`/`options.out` 用的键相同（`reviewKey` 只在 `pr-`/`topic-` 间选择），所以当前 topic 账本不会被重复算。
   - 新错误码 `INCIDENT_LIST_UNREADABLE`、`INCIDENT_ARGUMENT_UNKNOWN`：前者只被 `checkIncidentGates` 返回、CLI 打印和测试消费；后者只被 CLI 以退出码 2 消费。没有其他代码按固定错误码集合解析，故不存在“新值过不了下游校验”的问题。
   - 需要额外注意的一处口径：`dailySpend` 只按 `at` 过滤，不按 `mode` 过滤，因此 plan/plan-review 的方案讨论花费也会计入 `total`，而 `owner-standing-rules.md` 的 5 美元例外原文只覆盖“代码复核和方案说法核对（plan-claims）”。这是偏保守的算法，会让询问比规则要求更早触发；如果这是有意设计，建议在规则里写明“当日报告包含所有复核模式的合计，作为上限”。
