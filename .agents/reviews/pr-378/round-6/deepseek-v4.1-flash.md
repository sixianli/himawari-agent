## 复核材料

- 对比：`a857cd40..131f06b7`，重点看 `f7aa5499..131f06b7` 增量。
- 只读了代码、测试、ADR/casebook；本轮工具不能运行测试，所以“测试是否通过/反向用例是否真的失败”只能从用例内容判断，未实际执行。

## 发现（按严重度）

### 1.【中】【已证实】0.5 美元不是严格硬上限，单次调用可把总额推过上限

- 文件：`packages/application/src/services/real-memory-eval.ts:366-369`，测试 `packages/application/test/real-memory-eval-service.unit.test.ts:478-489`
- 问题：`record` 先把实际费用加进累计，再判断是否超限并抛错；因此这一次调用的费用已经记入，运行可以超过上限后才停。材料里写的是“每周费用硬上限 0.5 美元，花到上限必须立刻停”，代码和 ADR 都是“最多超出一次调用的预估误差”，两者严格说不一致。
- 证据：
  ```ts
  record(actualMicros: number): void {
    this.#spentMicros += Math.max(0, actualMicros);
    if (this.#spentMicros > this.#limitMicros) throw new RealEvalBudgetExceededError();
  }
  ```
  测试直接把 `capMicros: 500`、`estimateMicros: 1`、实际 `1_000` 写成期望：
  ```ts
  expect(report.outcome).toBe("budget_exceeded");
  ...
  expect(report.costMicros).toBe(2 * 100 + 10 + 1_000);
  ```
- 建议：如果要求真的是硬上限，调用前的 `reserve` 必须用“保守上界”（按模型描述的最大输入/输出价格、必要时加上遮盖膨胀余量），而不是详细 prompt 的当前字节数估算；否则应在 ADR 和对外说法里明确这是“软上限，最多一次调用误差”。

### 2.【中】【已证实】`undiscarded` 只靠运行记录落库，记录写不进去时会永久留下题干 payload

- 文件：`packages/application/src/services/real-memory-eval-service.ts:148-155, 208-215, 288-294, 387-429`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:884-888`
- 问题：删除失败的题干编号只存在本次运行的 `summary.undiscarded` 里，下一次运行只读“最新一次运行”的 `summary`。如果本次 `recordRun` 失败（标记留下、没有数据库行），或者运行在读取 `undiscarded` 之前失败（`listRuns` 抛错）但仍然写入了一条 `undiscarded: []` 的记录，这些编号就脱离了链条，之后再也不会被重删。
- 证据：
  ```ts
  function undiscardedOfLatestRun(runs) {
    const refs = runs[0]?.summary["undiscarded"];
    ...
  }
  ```
  ```ts
  const recentRuns = await deps.store.listRuns({ ...deps.scope, limit: RECENT_RUNS_FOR_DECLINES });
  for (const ref of undiscardedOfLatestRun(recentRuns))
    await deps.discardQuestion(ref).catch(() => { ... });
  ```
  汇总在 `try/catch` 之外写入：
  ```ts
  const summary = { ..., declined, undiscarded, ... };
  await deps.store.recordRun({ ... });
  ```
  而治理删除只收集题库表引用的题干：
  ```ts
  "SELECT question_ref FROM real_eval_questions WHERE memory_id = ?"
  ```
  未被题库收下的 orphan payload 不在其中，所以即使删除记忆也不会清掉它们。
- 建议：把待删题干做成持久队列/表，而不是只放在运行 summary；或至少在 `recordRun` 失败时保留旧记录并重新扫描最近 N 次运行；`listRuns` 失败时不要写空的 `undiscarded` 覆盖链条。

### 3.【中】【已证实】数据库运行记录与遗留标记会同时计数，导致一次崩溃后评测被挡约 7 天

- 文件：`apps/agent-service/src/production-real-eval.ts:49-53, 117-152, 390-417`
- 问题：`runs` 同时包含数据库运行记录和未完成标记；标记的 `capMicros` 是“本次可用额度”。如果 `service.run` 已经成功 `recordRun`，但进程在下一行 `rm(marker)` 之前崩溃或删除失败，那么下一次 tick 会同时加“数据库实际费用 + 标记里的剩余额度”，把已花费用重复计算，`remaining <= 0`，评测被挡约 7 天。
- 证据：
  ```ts
  const runs = [...(await store.listRuns({ ...this.#options.scope, limit: 520 })), ...unfinished];
  const remaining = configuration.weeklyCapMicros - realEvalSpentMicros(runs, now);
  ...
  const report = await service.run(...);
  await rm(marker, { force: true });
  ```
- 建议：标记里写入本次 `runId`，读取时若数据库中已有同 `runId` 的运行记录就跳过该标记；并把 `rm(marker)` 放进 `finally`，至少避免正常路径的删除失败造成重复计数。

### 4.【低】【已证实】旧版本 `in-progress.json` 不会被识别，也不会被删除

- 文件：`apps/agent-service/src/production-real-eval.ts:39, 125`
- 问题：前缀改成了 `in-progress-`，旧文件名 `in-progress.json` 不以 `in-progress-` 开头，也不是 `.tmp`，所以既不计入 7 天费用，也永远不会被清理。只有“从 f7aa 那种中间版本跑过并留下标记”的升级场景才会遇到；如果这个分支从未部署，实际影响很小。
- 证据：
  ```ts
  export const REAL_EVAL_IN_PROGRESS_PREFIX = "in-progress-";
  ...
  if (!name.startsWith(REAL_EVAL_IN_PROGRESS_PREFIX)) continue;
  ```
- 建议：启动读取时兼容并删除旧文件名，或在升级说明里明确手工清理。

### 5.【低】【已证实】评测关闭时只清理抽查样本，不清理进行中标记及 `.tmp`

- 文件：`apps/agent-service/src/production-real-eval.ts:172-203`；对比 `docs/adr/0219-real-memory-eval-sets.md:58`
- 问题：ADR 写“标记……满 7 天后删掉”，但标记清理只发生在 `ProductionRealEval.#tick` 的 `readUnfinishedRealEvals` 里；评测关闭后启动的是 `RealEvalSampleExpiry`，它只调用 `expireRealEvalSample`，不扫描 `in-progress-*`。因此关闭评测后，残留标记和标记 `.tmp` 会一直留着（不含正文，主要是垃圾文件）。
- 证据：
  ```ts
  const check = () => void expireRealEvalSample(this.#directory, this.#now()).catch(...);
  ```
  `expireRealEvalSample` 只处理 `latest-sample.json` 及其 `.tmp`。
- 建议：把标记清理也放进关闭时的定时器，或抽出统一的清理函数。

### 6.【低】【已证实】作者说法与代码有几处不一致

- 文件/证据：
  - “从最近 52 次运行的 `summary.declined` 读” ✗：`RECENT_RUNS_FOR_DECLINES = 520`（`real-memory-eval-service.ts:117`），生产 `listRuns` 也是 520（`production-real-eval.ts:395`）。
  - “拒绝过的同一版本记忆以后不再问” ✗ 有例外：`response_invalid` 不写 `declined`（`real-memory-eval-service.ts:259-263`），`addQuestion` 抛错也不写 `declined`（只有返回 `false` 时写，`:296-299`）。ADR 已写明 JSON 异常这一例外，但顶层说法没有。
  - “weekly 距上次运行满 7 天才跑” ✗ 不完整：失败的运行 24 小时后会重试；`dueRealEvalTrigger` 的 24 小时规则和“非 failed 且 7 天内”规则是分开的（`production-real-eval.ts:55-71`）。
- 建议：把这三处改成与代码/ADR 一致的说法，尤其是 52→520、失败重试 24 小时、`response_invalid` 例外。

### 7.【低】【推测】输入费用用遮盖前的 prompt 估算，遮盖可能让实际发送字节变长

- 文件：`apps/agent-service/src/production-real-eval.ts:227-232`；`docs/adr/0219-real-memory-eval-sets.md:58`
- 问题：`estimateMicros` 的输入部分按传入的原始 `prompt` 字节数计算；出口遮盖在发送时把敏感值换成占位符，占位符可能比原值长。ADR 已承认这一点，并称 2 倍输出余量可以吸收。是否真的能吸收取决于模型单价；如果某个模型输出单价比输入便宜、或记忆里敏感值很多，理论上仍可能低估。
- 建议：若要严格，按遮盖后的长度预估，或给输入估算加固定安全系数；至少补一条遮盖膨胀的预算测试。
- 说明：这是推测，未找到实际超限用例；`estimateMicros` 本身对同一 prompt 是确定的。

### 8.【低】【推测】日期泄漏检查对“一点”仍有漏检，属于已知取舍

- 文件：`packages/application/src/services/real-memory-eval.ts:128-135`
- 问题：`oneMeansHour` 要求前面 4 个字符内有时段词，或后面紧跟“钟/整/半/数字+分”；因此“下午的一点”（中间有“的”）不认，“你一点做什么？”这种裸“一点”也不认。后一种正是为了避免“一点也不”的误报而做的取舍，但确实会让含“1 点”答案的题干漏过日期检查。
- 证据：
  ```ts
  const PART_OF_DAY = /(凌晨|早上|...|午夜)\s*$/u;
  const AFTER_HOUR = /^\s*(钟|鐘|整|半|[0-9〇零一二三四五六七八九十]+\s*分)/u;
  ```
- 建议：如果更重视泄题检查，可把“一点”前面的“的/在/是”等虚词也纳入判断，或对“一点”同时做数字/上下文联合判断；否则在 ADR 里明确列出这个漏检代价。

## 侧重检查

- **错误路径：**
  - `addQuestion` 抛错 → `finally` 删除 payload；删除失败会进 `undiscarded`（`real-memory-eval-service.ts:286-299`）。但后续 `recordRun` 失败会丢编号（见发现 2）。
  - `createRealEvalModel.generate`：费用缺失/小数/负数抛 `COST_INVALID`，`finally` 保证先释放 authority 再释放 payload（`production-real-eval.ts:285-293`）；服务层按预估 `absorb`（`:199-203`）。
  - `proactiveModel.prepare` 申请密钥句柄失败时释放刚写的 `inputRef`（`production-model-composition.ts:540-555`），并测试覆盖（`production-model-composition.unit.test.ts:1516+`）。该路径影响所有主动调用，但只改错误清理，不改正常请求字节。
  - `writeSample` 失败 → 本次运行记 `failed`，临时文件被删除（`production-real-eval.ts:330-336`；`real-memory-eval-service.ts:400-406`）。
  - 样本过期清理失败被 `catch`，不挡评测（`production-real-eval.ts:387-389`）。
- **不合规范/不可信输入：**
  - 模型输出限制 64 KiB、题干 4–120 字、单行、禁 `{}<>`、JSON 结构、kind 白名单、泄题/敏感值检查（`real-memory-eval.ts:195-246`）。检查顺序是先解析、再长度/结构、再泄题/敏感值，合理。
  - 进行中标记：非法 JSON、负数 `capMicros`、非规范 ISO、未知 trigger 都按“花光整周上限 + mtime”处理（`production-real-eval.ts:96-152`），保守。旧文件名是例外（发现 4）。
  - `undiscarded` 里的 ref 会以字符串形式从运行 summary 读回并删除；`payload.delete` 带 owner/agent 作用域（`durable-adapters.ts:302`），跨身份删除受限制。
- **安全/敏感信息：**
  - 题干 payload、出题/作答/判分调用使用题目来源记忆的 `dataClassification`；检索也传该分级（`production-real-eval.ts:480-541`）。`memory_history_events.quote_ref` 的分类与 memory 不一致时，SQLite 层会直接失败（`sqlite-memory-operations.ts:869`），所以 quote 不会低于 memory 分级。
  - 抽查样本写入前对 question/response/quote/memory 调 `maskForExport`，文件 0600、目录 0700（`production-real-eval.ts:308-338`）。
  - 运行 summary 只含分数、计数、记忆 id/revision、题干 ref、错误名；集成测试实际断言 summary 不含正文（`test/integration/real-memory-eval.test.ts:354-357`）。
  - 错误日志走 `stableErrorCode`，只输出大写 code 或 STARTUP_FAILED，不输出错误文字（`service-runtime.ts:45-59`）。
  - 残留风险：`undiscarded` 链丢失后的 orphan 题干 payload（发现 2）和抽查样本最多留 7 天（文档已写明）。
- **资源耗尽：**
  - 输出有 64 KiB 上限（`production-real-eval.ts:41, 270`），题目数量受 `newMemoriesPerRun <= 200` 限制，费用受预算限制；`pending` 包含全部固定面板题，数量随题库增长，但每次作答受预算约束，最坏情况会扫描全部题后 `budget_exceeded`，没有看到无界循环。
  - 未完成标记数量理论上可随多次崩溃增长；每个标记按剩余额度计，通常会立即把剩余额度压到 0，不会同时无限跑新评测。
- **不可撤销操作：**
  - 模型调用花钱不可撤销，硬上限问题见发现 1。
  - 删除题干 payload 不可撤销，但这是设计目的；失败时有重试链，链断后残留见发现 2。
- **规则/文档一致性：**
  - `prompt-prefix` 第 15 条要求固定指令在前、数据在后、变化值最后；三个新 prompt 都满足（见必答问题 1）。
  - casebook 第 5498 行、ADR 第 40 行说 `service-main.ts` 的 `readQuote` 用 `episodeProtector.unprotect`；实际 `readQuote` 在 `production-real-eval.ts`，服务里传入的是 `realEvalProtector`（`service-main.ts:1677, 1697`）。两者最终都是同一个 `protector` 实例，结论（生产进程解密）没错，但变量名/文件位置不精确。
  - casebook 里“第 0 层相关测试 126 条通过、`npm run check` 48 步全过、提交 1c9f8477/34dd5826”未核实（未运行检查）。

## 作者说法核对

- 第 1 条：迁移 0088、外键级联、题库 payload 清理、治理删除收集 `question_ref` 均已核对为真；迁移号是否按队列改成 main 下一个空号属于合入流程，未核实。
- 第 2 条：出题资格、退役、题型、泄题/敏感值、快判、预算、失败只记错误名均与代码一致；但“最近 52 次”是错的（代码 520），“拒绝过的不再问”对 `response_invalid` 和 `addQuestion` 抛错不成立。另“作答前按对话相同规则”是近似：ADR 已承认没有对话历史、规则块和 `recall` 工具。
- 第 3 条：`off/once/weekly`、默认不跑、once 样本、weekly 7 天、24 小时规则、`purpose` 默认 `mail-judgment`/评测 `other` 均核对为真；但 weekly 的失败运行 24 小时就重试，不是“满 7 天才跑”。
- 第 4 条：五组决策计数、`useful` 算做对，核对为真；`summarizeDecisions` 的组名与 `DECISION_EVAL_GROUPS` 一致。
- 第 5 条：导出省略题库并在“未导出”写明理由，核对为真；测试 `data-export.test.ts:612-633` 覆盖。
- 第 6 条：无法运行测试，未核实“与本改动无关的 18+8 条失败”。
- 第 2 轮历史说法：其中“题退役时也删其 payload”“所有被拒都记 declined”已被第 3 轮改掉，不是最终代码；以第 3 轮之后的说法为准。
- 第 3 轮：退役不删 payload、`absorb` 预估记账、`addQuestion` false 记 declined、`response_invalid` 不记、关闭时清样本、日期时刻检查，均核对为真。
- 第 4 轮：按记忆分级检索、费用非法抛 `COST_INVALID`、按 UTF-8 字节预估、样本先写失败记 `failed`、`modelRef` 支持 private+sensitive，均核对为真；字节预估存在遮盖膨胀的理论缺口（发现 7）。
- 第 5 轮：`in-progress` 标记、`openai-completions`/向量模型 sensitive 校验、样本和临时文件清理、discard 失败计数、“一点”不当时间、casebook 案例，均基本核对为真；`discardQuestion` 已从“只计数”升级为“计数 + undiscarded”（第 6 轮），casebook 变量名有轻微不精确。
- 第 6 轮：分文件标记、原子 rename、非法标记按整周上限、7 天删除、不覆盖旧标记、两个 release 的 try/finally、`undiscarded` 重删、日期规则、ADR 后果，均核对为真；但 `undiscarded` 的持久性和标记/记录双计有缺口（发现 2、3）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动没有触碰对话的系统提示、工具定义、历史消息或遮盖逻辑；真实评测是独立的 `proactiveModel` 后台调用。三个提示词都是“固定指令在前、JSON 数据在后”：`questionPrompt`（`real-memory-eval.ts:174-179`）、`answerPrompt`（`:248-263`）、`judgePrompt`（`:265-281`）；`answerPrompt` 的 `now` 也在末尾 JSON 里。`production-model-composition.ts:529-565` 的 prepare 改动只在申请密钥句柄失败时多删一个 payload，不改变正常请求字节。因此对已有对话仍满足“只在末尾追加”，每轮变化的值在最后一条消息/尾部数据里。

2. **同一段文字会不会在不同请求里变成不同字节？**
   没有发现本次改动引入“依赖后文/前文的遮盖”或“带时间字段进入开头”的问题。`questionPrompt`/`judgePrompt` 的 JSON 键顺序固定；`answerPrompt` 只有末尾的 `now` 和本次数据变化，属于设计允许的尾部变化。`dateTokens` 只用 `Set` 做成员判断，不影响序列化。需要保留的两点：`pickNewMemories` 用 `localeCompare` 排序（不同 locale 下可能不同，`real-memory-eval.ts:68`），以及 `profile.texts`/召回顺序我尚未逐行核到排序来源；这些影响的是尾部数据选择，不影响请求开头，但若要求跨环境逐字节确定，需进一步确认。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：
   - 标记：非法标记按整周上限（`production-real-eval.unit.test.ts:529+`）、旧标记不覆盖（`:571+`）、正常删除（`:496+`）。
   - `undiscarded` 重删（`real-memory-eval-service.unit.test.ts:373-397`）。
   - `prepare` 失败释放 payload（`production-model-composition.unit.test.ts:1516+`）。
   - 日期时刻（`real-memory-eval.unit.test.ts:139-145`）。
   - 预算单次超预估（`real-memory-eval-service.unit.test.ts:478-489`）、检索预留（`:424-429`）、写入失败（`:431-443`）。
   - 配置/接口/分级（`startup-configuration.unit.test.ts:1466+`、`production-mail-embedding.unit.test.ts:78+`、`real-eval.contract.test.ts`）。
   这些用例从内容看会在旧实现上失败（旧单文件标记、旧无 `undiscarded`、旧 prepare 不释放等），但本轮不能运行测试，无法实际确认。**缺少反向用例**：数据库记录与遗留标记同时存在时的重复计数；`listRuns`/`recordRun` 失败导致 `undiscarded` 链断裂；旧 `in-progress.json`；遮盖膨胀导致预算低估。尤其预算测试把“费用超过 cap”写成了期望，等于把“硬上限”要求排除在测试之外。

4. **每个新值两端都能接受吗？**
   逐个核对结果：
   - `runPolicy.realEval.{mode,modelRef,weeklyCapMicros,newMemoriesPerRun,requestTimeoutMs}`：由 `parseRealEval` 产生（`strict-configuration.ts:1104-1127`），由 `service-main.ts:1668-1736` 消费；`weeklyCapMicros` 上限 500000、`newMemoriesPerRun` 1–200、`requestTimeoutMs` 1000–300000，均匹配。`modelRef` 在 `strict-configuration.ts:1476-1505` 校验 `openai-completions` 且允许 private+sensitive，`service-main` 从 `descriptors.generation` 查找，能接受。
   - `trigger`（`manual`/`weekly`）：端口、数据库 CHECK、`dueRealEvalTrigger` 一致。
   - `outcome`（`completed`/`budget_exceeded`/`failed`）：端口、数据库 CHECK、报告脚本一致。
   - `kind`（`fact`/`preference`/`time`/`abstain`）与 `retiredReason` 六值：端口、迁移 CHECK、`sqlite-real-eval-operations.ts:148-159` 一致。
   - `questionRef`：先写 payload 再插入 `real_eval_questions.question_ref`，外键 `ON DELETE RESTRICT`；删除记忆时治理删除先收集该 ref 再删题（`sqlite-governed-deletion.ts:884-888`），集成测试通过内容看一致。
   - `undiscarded`：生产者写进 `summary`，消费者下一次运行读最新 summary 并调用 `discardQuestion`；类型/作用域能接受，但**持久性两端不一致**（发现 2）。
   - `summary.scores/items/added/retired`：报告脚本 `real-eval-report.mjs:29-53` 按这些字段读取，`scoreItems`/服务 summary 形状匹配。
   - `real_eval_questions`/`real_eval_runs`：导出明确不包含（`export.ts:437+`、测试 `data-export.test.ts:612-633`）；`real_eval_runs` 不在导入“目标必须为空”的表中，属于派生统计，影响有限但不是完全一致。
   - 标记文件名 `in-progress-<ts>-<uuid>.json`：生产/读取同一模块一致；旧 `in-progress.json` 不匹配（发现 4）。
   - `latest-sample.json`：写入/过期清理前缀一致。
   - `purpose: "other"`：`MODEL_USAGE_PURPOSES` 包含 `other`（`model-usage.ts:3-14`），可用。

## 未核实

- 测试实际是否通过、casebook 里的 126 条/48 步/提交号。
- `prompt-manifest.json` 三个 sha256 是否与源码文本一致（本轮不能计算哈希）。
- `profile.texts` 和召回结果在同内容下的跨环境字节顺序（只看代码未追到 `OwnerProfileService.compose` 的完整排序实现）。
- 从 f7aa 中间版本实际部署过、留下旧 `in-progress.json` 的现场；因此发现 4 的实际影响大小未确认。
