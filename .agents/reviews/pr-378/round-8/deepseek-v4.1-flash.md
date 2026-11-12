## 复核发现（按严重度从高到低）

### 1. 高：【证实机制，触发条件为推测】档案或检索里的一条坏记忆，仍会让整轮评测停摆
- **文件:行**：`apps/agent-service/src/service-main.ts:1704`、`packages/application/src/services/real-memory-eval-service.ts:330`、`apps/agent-service/src/production-real-eval.ts:569`
- **问题**：第 8 轮只给「题目所出自的记忆」加了读取保护（`readSource`），但作答前的**档案读取**和**检索结果读取**没有保护。任意一条参与档案或检索的记忆 payload 解密/UTF-8 解码失败，都会抛出异常：
  - `service-main.ts:330` 的 `const profile = await deps.profile();` 在逐题循环之外，档案读取失败直接让整轮进 `catch`；
  - `production-real-eval.ts:569` 的 `const text = await readText(memory.contentRef);` 在检索循环里没有 `try/catch`，失败会经 `real-memory-eval-service.ts:347-352` 的 `catch { budget.absorb(...); throw error; }` 原样抛出。
- **证据**（亲自读到）：
  - `service-main.ts:1704-1713`：`readText` 只对 `payload` 缺失返回 `undefined`，`unprotect` 抛错没有兜底。
  - `production-real-eval.ts:569-572`：`for (const { memory } of found) { const text = await readText(memory.contentRef); ... }`，没有 `catch`。
  - `real-memory-eval-service.ts:211-221` 的 `readSource` 保护只用于出题和单题作答，没有覆盖 `profile()` 和 `recall()`。
- **影响**：只要有一条活跃记忆的密文损坏或密钥轮换不完整，之后每周评测会稳定失败（`outcome=failed`），分数永远出不来；这正好推翻第 8 轮「坏记忆不再拖垮整轮」和 ADR「作答时读不出的题计为答不了，不影响其他题」的目标。
- **建议**：在 `production-real-eval.ts` 的 `recall` 循环里对 `readText` 加 `try/catch`（读不出就跳过该条，或计入一个 unreadable 计数）；在 `service-main.ts:1704` 的 `readText` 里把解密/解码异常转成 `undefined`（与 `payload` 缺失一致），避免 `OwnerProfileService.compose` 因一条坏记忆整体失败。并补一条“某条非题目来源的记忆解密失败，整轮仍 completed”的测试。

### 2. 中：【证实】临时读取失败会被当成永久拒绝，永久跳过一条记忆
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:211-221`、`:263-268`、`:252-255`
- **问题**：`readSource` 捕获所有异常（包括 SQLite busy、密钥服务暂时不可用、进程内暂时故障），统一返回 `unreadable: true`，随后无条件：
  ```ts
  declined.push(declinedKey(memory.id, memory.revision));
  ```
  下一次运行 `skip = declinedFromRuns(recentRuns)`，候选过滤 `!skip.has(declinedKey(record.id, record.revision))`。窗口是 `RECENT_RUNS_FOR_DECLINES = 520`（第 118 行），按每周一次约等于 10 年；只有记忆版本号变化才会重新出题。
- **证据**：
  - `real-memory-eval-service.ts:211-221`：`catch { return { text: undefined, quote: undefined, unreadable: true }; }`
  - `:264-268`：`if (source.text === undefined || source.quote === undefined) { ... declined.push(declinedKey(memory.id, memory.revision)); continue; }`
  - `:252-255`：`const skip = declinedFromRuns(recentRuns); const candidates = memories.filter((record) => !skip.has(...));`
- **说明**：`source_missing`（永久没有原话）记 declined 合理；但 `source_unreadable` 里混入了可恢复的临时错误。ADR 写的是“读取（解密）出错时……同一版本以后也不再问”，这是有意的取舍，但代码没有区分永久损坏与临时故障。
- **建议**：至少在 `source_unreadable` 时区分错误类型（解密/编码失败可永久，I/O/DB 类错误不记 declined，或记一个带重试次数的临时标记）；或在 decline 时记下时间，超过 N 天自动重试一次。补一条“第一次抛瞬时错误、第二次读取成功则仍会出题”的测试，明确预期。

### 3. 中：【证实】抽查样本的修改时间在将来时，永远不会满 7 天过期
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:88-98`
- **问题**：第 8 轮给进行中标记加了“mtime 在将来时先 `utimes` 改成 now”，但 `expireRealEvalSample` 没有同样的处理：
  ```ts
  if (!found || Date.parse(now) - found.mtimeMs < REAL_EVAL_SAMPLE_TTL_MS) return false;
  ```
  若样本写入后系统时钟回拨（或样本 mtime 因其他原因超前），`now - mtime` 为负，条件恒成立，样本永不删除。
- **证据**：`production-real-eval.ts:95` 的上面的判断；对比 `:155` 的 `if (found.mtimeMs > Date.parse(now)) await utimes(file, new Date(now), new Date(now));` 只用于标记文件。
- **影响**：抽查样本含记忆正文和原话（ADR 已改为“其余正文照原样”），本应最多留 7 天；时钟回拨后可能长期留在磁盘上，和 ADR/案例 87 的“满 7 天删除”不一致。
- **建议**：在 `expireRealEvalSample` 里对 `found.mtimeMs > Date.parse(now)` 先 `utimes` 到 now，再按 TTL 判断，或直接把未来 mtime 视为已过期。补一条“样本 mtime 在将来，第一次清理后 7 天内过期”的测试。

### 4. 低：【证实路径】一次 `utimes` 失败会让每个 tick 都失败，评测永久不跑
- **文件:行**：`apps/agent-service/src/production-real-eval.ts:155`、`:415-424`
- **问题**：`readUnfinishedRealEvals` 对每个标记执行 `await utimes(...)`，失败会抛出；`ProductionRealEval.#tick` 只对 `expireRealEvalSample` 做了 `.catch(...)`，对 `readUnfinishedRealEvals` 没有捕获，异常直接结束本次 tick。若某个标记文件 mtime 在将来且 `utimes` 因权限/只读文件系统失败，这个文件会一直坏在那里，之后每个小时的 tick 都在同一处失败，评测永远不运行。
- **证据**：
  - `:155`：`if (found.mtimeMs > Date.parse(now)) await utimes(file, new Date(now), new Date(now));`
  - `:415-424`：只有 `expireRealEvalSample(...).catch(...)`，随后 `const unfinished = await readUnfinishedRealEvals(...)` 没有捕获。
- **建议**：对单个标记的 `stat/readFile/utimes` 失败做局部 `try/catch`（记诊断并跳过该文件），不要让一个坏文件阻断整个 tick；如果担心预算漏算，可把该标记按“读不懂”计入本次额度，同时继续处理其他标记。

### 5. 低：【证实设计】固定面板无限增长，固定预算下后面的题会被系统性饿死
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:328`
- **问题**：所有非退役题（`active`）每轮都整批加入 `pending`，没有上限或抽样：
  ```ts
  pending.push(...active.map((question) => ({ question, panel: "fixed" as const })));
  ```
  题库会随每周新记忆单调增长；`weeklyCapMicros` 固定时，一轮只能回答其中一部分，`unanswered` 会越来越大，固定面板分数会被早期题目主导，且每周都会把预算花到上限。
- **证据**：`real-memory-eval-service.ts:328` 无 `slice`/抽样；`scoreItems` 的 `fixed` 面板统计全部 active 题。
- **建议**：给固定面板设上限或轮换（例如按创建时间分层抽样），或在预算不足时优先轮换未答过的固定题；至少在 ADR 的“后果”里写明面板增长的代价。

### 6. 低：【证实】作者说法/文档与代码不一致
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:118`、`:279`、`docs/adr/0219-real-memory-eval-sets.md:40`、`docs/engineering-casebook.md:5498`、`:5571`
- **问题**：
  1. 作者说法第 2 条写“从最近 **52** 次运行的 `summary.declined` 读”，代码是 `RECENT_RUNS_FOR_DECLINES = 520`（第 118 行，`:226` 使用）。`52` 是报告脚本 `scripts/operations/real-eval-report.mjs` 的默认条数，和出题去重窗口不是一回事。
  2. 第 2 轮修改说明第 3 条写“所有被拒的出题都记进 `summary.declined`”，但代码对 `response_invalid` 明确不记（`:279-280`），第 3 轮说明也写了“`response_invalid` 不记”，两处说法互相矛盾。
  3. ADR 第 40 行和案例 87 第 5498 行写“`service-main.ts` 的 `readQuote` 用 `episodeProtector.unprotect`”；实际 real eval 的 `readQuote` 在 `apps/agent-service/src/production-real-eval.ts:508-511`，用的是 `deps.protector`（service-main 传入的 `realEvalProtector`），不是 `service-main.ts` 里的 `episodeProtector`。`episodeProtector` 在 service-main 是另一批记忆 episode/web push 服务用的别名。
  4. 案例 87 第 5571 行写“共 7 轮……累计 0.99 美元”；当前复核已是第 8 轮，这段在本次改动后就会过期。`pr-378/usage.jsonl` 在当前检出中不可读（`.agents/reviews` 不在工作树），金额和 `REVIEW_SPENT_TOTAL` 未核实。
- **建议**：把 52 改成 520；把“所有被拒”改成“除 `response_invalid` 外的被拒”；把 ADR/案例里的 `service-main.ts` 改为 `production-real-eval.ts` 并写 `realEvalProtector`；复核轮数用“截至第 N 轮”的写法。

### 7. 低：【证实缺口】第 8 轮“作答时读不出计为答不了”的两条路径没有自动测试
- **文件:行**：`packages/application/src/services/real-memory-eval-service.ts:333-338`、`packages/application/test/real-memory-eval-service.unit.test.ts:215-225`
- **问题**：第 8 轮声称 `readQuestion` 抛错和 `readSource` 抛错都计为 `unanswerable`，但测试里：
  - `readMemoryText` 只在**出题阶段**被设置成抛错（`:215-218` 的 `unreadable` 选项）；
  - `readQuestion` 永远是 `async (ref) => payloads.get(ref)`（`:225`），另一个用例是 `async () => undefined`，没有“抛错”的用例；
  - 没有 `readQuote` 在作答阶段抛错的用例。
- **证据**：上面两处测试代码；`real-memory-eval-service.ts:333-338` 的 `.catch((): undefined => undefined)` 和 `readSource(memory)`。
- **建议**：补 `readQuestion` 抛错和 `readQuote`/`readMemoryText` 在作答阶段抛错的用例，断言 `unanswerable` 增加、本轮仍 `completed`、其他题照常计分；并把第 1 条发现的 `profile`/`recall` 坏 payload 也补成反向用例。

### 8. 低：【证实】抽查样本的遮盖参数不是“统一出口”的完整参数
- **文件:行**：`apps/agent-service/src/production-gap-export.ts:89-91`、`packages/application/src/services/model-egress.ts:220-230`
- **问题**：`maskForExport(text)` 只是 `redactForEgress(text)` 的默认调用，没有传 `known`、`trusted`、`ruleset`；而真实出口会传 `known`、`TRUSTED_PROMPT_TEXTS` 和可选的 `redactionRuleset`。ADR/案例写“敏感值按统一出口的规则遮掉”并不完全准确。
- **证据**：`maskForExport` 只有 `return redactForEgress(text).text;`；`model-egress.ts:221-229` 传了 `tag / known / table / trusted / ruleset`。
- **说明**：对后台评测调用本身，`known` 通常为空，因此实践差异主要是 `trusted`（样本方向是遮得更多）和 `ruleset`；不是立即的泄露，但文档承诺不准确，且样本是落盘文件，建议按出口参数一致地遮盖。
- **建议**：把出口的实际遮盖选项抽成可复用函数，样本和模型请求共用；或把文档改成“按出口的默认规则遮盖”。

---

## 侧重检查

我围绕错误路径、不可信输入、安全、资源耗尽和文档一致性查了以下路径：

- **错误路径**：出题阶段 `readSource` 已兜底；`readQuestion`、单题 `readSource` 已兜底；`addQuestion` 返回 false 或抛错会 `discardQuestion`；`discardQuestion` 失败进 `undiscarded` 并下次重删；模型调用失败/费用缺失/费用非整数会 `absorb` 预估并记 `failed`；`writeSample` 失败记 `failed`；标记损坏/将来时间/已记录 runId 的处理有测试。**缺口**是档案/检索读取（发现 1）和 `utimes` 失败（发现 4）。
- **不可信输入**：模型题干只接受 4–120 字、单行、限定 JSON，且做 6 字 n-gram、两位以上数字、日期时刻、敏感值检查；`response_invalid` 下轮重试，其他拒绝记 declined；输出有 64 KB 上限；这些路径代码和测试基本一致。
- **安全**：运行 summary 只含计数、分数、记忆编号/版本、错误名，不含正文（集成测试有断言）；进行中标记不含正文；题干加密存储；删除记忆时 `real_eval_questions` 级联删除，治理删除会收集 `question_ref` 后删除 payload（集成测试有断言）；数据导出把题库列进“未导出”并验证导入后为空。抽查样本**有意**含记忆正文和原话（0600/0700、7 天），这一点与第 8 轮 ADR 文字一致；但样本 mtime 未来时不会过期（发现 3），遮盖参数也不完全等同出口（发现 8）。
- **资源耗尽/费用**：模型调用走 `proactiveModel` 的 unmetered 许可，不占生产预算；每次调用前 `reserve` 预估，实际超限 `record` 立刻抛；检索前 `ensureRemaining` + `reserve(recallEstimateMicros)`；7 天累计包含失败运行和崩溃标记。**一个小的低估点**：`embedForMailCheck` 在超时时会重试一次（`production-run-memory.ts:307-319`），单次检索最多可能产生两次嵌入费用，但只按一次 `recallEstimateMicros` 预留，实际超限只可能多出一次嵌入预估（ADR 已承认“最多超出一次调用”的误差）。固定面板无限增长见发现 5。
- **并发/重复计费**：同一进程 `tick()` 有 `#running` 互斥；跨进程不互斥是 ADR 明写的设计。标记和数据库记录同时存在时，`recordedRunIds` 会删标记并只按数据库计费；多个标记各自按 `capMicros` 累计，属于偏保守而不是漏算。关着评测时 `RealEvalSampleExpiry` 每小时的清理不受正常跑评测影响。
- **规则/文档一致性**：prompt-prefix 规则第 15 条（固定指令在前、数据在后、时间类值最后）在三个 prompt 构造器里满足；新 prompt 已加入 `prompt-manifest.json` 和 `trusted.ts`。文档不一致见发现 6。
- **未核实**：我没有运行任何测试，无法确认作者说的 18 条/8 条无关失败、126 条测试、`npm run check` 48 步、0.99 美元复核费用；`.agents/reviews` 在当前检出中不可读；迁移号“合并前会改成 main 下一个空号”只能看到当前 0087→0088 连续，无法看到队列里的其他 PR。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果？**

不会改变已有多轮对话的请求开头。评测是一个独立的后台单次调用，不复用任何对话历史：`questionPrompt`、`answerPrompt`、`judgePrompt` 都是“固定指令 + 本次 JSON 数据”的一条消息，`answerPrompt` 里唯一每轮变化的值 `now` 位于 JSON 最后（键顺序 `profile, memories, question, now`），满足“固定在前、会变的值在后”。`proactiveModel` 新增的 `purpose` 只是用量归因，不改请求字节。唯一需要留意的是 `trusted.ts` 新增了评测固定文字，会扩大 `TRUSTED_PROMPT_TEXTS`；只有某段文字恰好完整包含这些新 prompt 片段时才会改变遮盖（方向是少遮那一段），对现有对话内容实际不会命中。因此可以回答：发给模型的内容仍然只在末尾追加，每轮会变的值都在最后一条消息的有效载荷里；评测调用本身没有历史可改。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

不会因为“依赖前后文的遮盖、带时间的字段、无序的集合”而变。评测 prompt 的 JSON 键顺序固定，`questionPrompt` 只有 memory/quote，`judgePrompt` 顺序固定，`answerPrompt` 的 `now` 固定在最后；档案文本的顺序来自 `OwnerProfileService` 的确定性块顺序，检索结果顺序来自同一次搜索的得分顺序。出口遮盖的占位符编号是 HMAC（类型+值）算出来的，对同样内容和同一密钥稳定；评测后台调用没有 `known` 上下文，不依赖前面的消息。唯一“同段文字不同字节”的情况是 `answerPrompt` 的 `now` 每轮不同，但它在末尾且本就应该变，不影响前面的固定指令缓存。严格地说，如果检索索引或档案内容变化，`memories`/`profile` 数组本身会变，这是数据变化，不是同一段文字被序列化成不同字节。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有，覆盖比较广：
- 配置：`startup-configuration.unit.test.ts` 覆盖合法配置和 9 种非法配置（mode、modelRef、cap、newMemoriesPerRun、requestTimeoutMs、未知字段、embedding 不允许 sensitive、specialist 模型），这些用例在去掉校验时会失败。
- 费用：`real-memory-eval.unit.test.ts` 的 `RealEvalBudget` 用例、`real-memory-eval-service.unit.test.ts` 的“检索前额度不足不搜索”“实际费用超限立刻停”“失败按预估记账”用例；反向删除 `record` 的超限判断会让这些断言失败。
- 标记/清理：`production-real-eval.unit.test.ts` 覆盖未记录标记按整周上限计、已记录 runId 删标记、多个标记不覆盖、不可读标记、将来时间标记过期、测评关闭时清理；去掉对应判断时测试会失败。
- 协议/存储：真实 SQLite 的 `real-eval.contract.test.ts`、`test/integration/real-memory-eval.test.ts`、`sqlite-governed-deletion.test.ts`、`data-export.test.ts` 覆盖题库写入、版本退役、删除记忆连带删题干 payload、导出不含题库。
- 泄题：日期时刻 `几` 的新用例有反向断言。

**缺口**：第 8 轮声称的“作答时 `readQuestion` 抛错计为答不了”没有抛错的测试；`readQuote` 在作答阶段抛错也没有；样本 mtime 在将来、`utimes` 失败没有测试；档案/检索里坏 payload 导致整轮失败没有测试（这是发现 1）。另外我无法运行测试，所以“反向用例真的会失败”只能从断言结构判断，未实际执行验证。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

我逐个核对了主要生产/消费两端，没有发现会直接导致校验失败的值：
- 配置键 `runPolicy.realEval`：`parseRunPolicy` 的 `rejectUnknown` 白名单、`RealEvalConfiguration` 类型、service-main 读取三端一致；`modelRef` 仍使用 `safeReference`，允许 `/`、`:`（I-73 那类带斜杠的 Magpie 引用可通过），且校验只接受 openai-completions、允许 private+sensitive 的生成模型。
- `real_eval_runs.id`：生产是 `real-eval-run:<uuid>`（约 50 字符），数据库检查 1–128；服务内 `newId` 是 `real-eval:<uuid>`，也不会超长。`question.id`、`question_ref`、`question_model` 都在数据库长度约束内；`prompt_sha256` 是 64 位小写十六进制，满足 `^[0-9a-f]{64}$` 和 `length=64`。
- 时间字段：`startedAt`/`finishedAt`/`createdAt` 都来自 `new Date().toISOString()`，满足迁移里的毫秒 ISO GLOB；`retired_at`/`retired_reason` 成对写入，满足 CHECK。
- `summary`：`scoreItems` 的 `Proportion` 和 `summarizeDecisionEval` 的分组都是可 JSON 序列化对象，`real_eval_runs.summary` 的 `json_valid + json_type='object'` 可接受；`real-eval-report.mjs` 读取的 `items/added/retired/scores` 字段和类型守卫与 summary 结构一致。
- `undiscarded` 里存的是题干 payload ref，下一次运行再传给 `discardQuestion`；ref 由内部 `newId` 生成，不会指向已收下题目的新 ref，删除已删除的 ref 是空操作。
- 抽查样本的 `runId` 用作临时文件名，格式为内部生成的 `real-eval-run:<uuid>`，无外部输入，不构成路径穿越。
- 进行中标记的 `runId/startedAt/trigger/capMicros` 与服务端 `inProgressRun` 的校验匹配；时间必须规范 ISO，写入端正是 `toISOString()`。
- 数据导出把题库列为未导出，导入测试断言 `real_eval_questions` 计数为 0。

**未核实/无法确认**：作者列出的“18 条 + 8 条无关测试失败”没有实际运行验证；`.agents/reviews` 的复核费用账本在当前检出不可读；“迁移号合并前会改号”只能看到当前 0087→0088 连续。
