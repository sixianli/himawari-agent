## 读代码证实的问题（按严重度从高到低）

### 1. [中] `realEval.modelRef` 能通过启动校验，但运行时可能根本不支持该模型

- 文件：`packages/platform-node/src/strict-configuration.ts:1476-1489`，`apps/agent-service/src/production-model-composition.ts:507-512`
- 问题：配置校验只排除了 `role === "embedding"`，并要求 private/sensitive。`specialist` 模型（`api: "typesafe-systemone"`）也会通过。但评测实际走 `proactiveModel`，它只接受 `api === "openai-completions"`，否则抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`。这正是 I-73 那类“清单里的 id 能过这一层校验，却过不了下一层”的问题。
- 证据：
  - `strict-configuration.ts:1479-1484`：`!descriptor || descriptor.role === "embedding" || !descriptor.allowedDataClassifications.includes("private") || !descriptor.allowedDataClassifications.includes("sensitive")`
  - `production-model-composition.ts:508-512`：`descriptor?.api !== "openai-completions" ... throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");`
- 建议：启动校验增加与 `proactiveModel` 相同的 API/能力条件（如 `descriptor.api === "openai-completions"`），并增加一个“用 specialist 模型配置 realEval 必须在启动被拒”的反向用例。

### 2. [中] 抽查样本写入的是明文记忆正文和原话，删除记忆后也不会立刻消失

- 文件：`apps/agent-service/src/production-real-eval.ts:183-208`、`apps/agent-service/src/production-gap-export.ts:89-91`、`apps/agent-service/src/production-real-eval.ts:72-81`、`apps/agent-service/src/service-main.ts:1752-1761`
- 问题：`report.sample` 里包含 `question/response/quote/memory`，`writeRealEvalSample` 只调用 `maskForExport`。`maskForExport` 只是出口敏感值遮盖（卡号、密码等），不是去掉记忆正文。也就是说，原本加密保存的记忆正文和主人原话会多出一份明文副本；记忆被治理删除时，题干 payload 会删，但样本文件要等到 7 天后才过期。评测关闭时只在启动时清理一次，若启动时样本还不到 7 天，之后进程长期不重启就永远不会再清理。
- 证据：
  - `production-real-eval.ts:199-203`：`question: maskForExport(item.question), response: maskForExport(item.response), quote: maskForExport(item.quote), memory: maskForExport(item.memory)`
  - `production-gap-export.ts:89-91`：`return redactForEgress(text).text;`
  - `production-real-eval.ts:78`：`if (!found || Date.parse(now) - found.mtimeMs < REAL_EVAL_SAMPLE_TTL_MS) return false;`
  - `production-real-eval.ts:231-236`：`start()` 在 `mode === "off"` 时直接返回。
- 建议：样本只保留题目、回答、判分和记忆编号/版本，不写 `memory/quote` 全文；或使用 payload protector 把样本也加密。删除记忆时联动删除样本；评测关闭时也保持一个低频过期检查，而不是只在启动时做一次。

### 3. [中] 敏感记忆遇到不允许 sensitive 的向量模型会让整轮评测失败，并每天重试

- 文件：`apps/agent-service/src/production-run-memory.ts:133-143`、`apps/agent-service/src/production-real-eval.ts:378-398`、`packages/application/src/services/real-memory-eval-service.ts:304-312`、`apps/agent-service/src/production-real-eval.ts:59-60`
- 问题：敏感记忆是允许出题的（`isModelVisible("sensitive")` 为真），但配置校验只要求生成模型允许 sensitive，没有要求 embedding 模型也允许。检索时把记忆的 `sensitive` 传给向量模型，若不支持就抛 `EMBEDDING_REQUEST_OUTSIDE_POLICY`；服务层会 `absorb` 预估费用后重新抛出，整轮记为 `failed`，之后每 24 小时重试。也就是说一条敏感记忆就能让真实评测长期跑不完。
- 证据：
  - `production-run-memory.ts:133-138`：`!descriptor.allowedDataClassifications.includes(classification) ... throw ... "EMBEDDING_REQUEST_OUTSIDE_POLICY"`
  - `production-real-eval.ts:378-390`：`recall: async (question, dataClassification) => { const context = { ...timeout(), dataClassification }; ... }`
  - `real-memory-eval-service.ts:305-311`：`budget.absorb(deps.recallEstimateMicros); throw error;`
- 建议：启用 realEval 时，启动校验同时要求 embedding 模型允许 sensitive；或者把“该记忆无法被向量模型处理”降级为跳过该题/该记忆，而不是让整轮失败。

### 4. [中/低] 费用只按已写入的运行记录累计，记录失败或进程崩溃时 7 天硬上限会漏算

- 文件：`packages/application/src/services/real-memory-eval-service.ts:409-421`、`apps/agent-service/src/production-real-eval.ts:253-261`
- 问题：`realEvalSpentMicros` 只读 `real_eval_runs`。运行开始时不落库，费用只在 `recordRun` 时写入；如果 `recordRun` 失败、进程崩溃或数据库写入失败，已经花掉的钱不会进入最近 7 天累计。下一次 tick 看不到任何运行记录，仍可能拿到完整额度再跑。单进程内 `#running` 能防重入，但跨进程没有数据库租约。
- 证据：
  - `real-memory-eval-service.ts:409`：`await deps.store.recordRun({ ... })`
  - `production-real-eval.ts:260`：`const remaining = configuration.weeklyCapMicros - realEvalSpentMicros(runs, now);`
- 建议：运行开始前先写一条“已开始/已预留”的记录，或使用数据库锁/租约；`recordRun` 失败时把本次 `spentMicros` 以可恢复方式单独落盘/落库。多实例部署时应加跨进程互斥。

### 5. [低/中] 日期时刻比对会误判，而误判会永久拒绝一个记忆版本

- 文件：`packages/application/src/services/real-memory-eval.ts:128-153`、`packages/application/src/services/real-memory-eval-service.ts:243-247`
- 问题：`dateTokens` 只保留到“时”“月”“日”，丢掉分钟和完整日期。例如原话是 `7:30`，题目写 `七点半`，会被判成 `7时` 相同而误报泄题；原话有 `一点`（“一点小事”）也可能被当成 `1时`。一旦判为 `leak`，服务会把该记忆版本写入 `declined`，以后不再出题。
- 证据：
  - `real-memory-eval.ts:130-131`：`matchAll(/(\d{1,2})\s*:\s*\d{2}/gu)`，只取 `match[1]`
  - `real-memory-eval-service.ts:245-247`：`if (generated.rejected !== "response_invalid") declined.push(declinedKey(memory.id, memory.revision));`
- 建议：按完整日期/时刻（年-月-日、时:分）比较，或对“只命中日期/时刻”的情况只丢弃本题而不永久拒绝该记忆版本；补充 `7:30` vs `七点半`、`一点小事` 的反向用例。

### 6. [低] `discardQuestion` 失败时会丢掉 declined 记录并留下题干

- 文件：`packages/application/src/services/real-memory-eval-service.ts:270-279`
- 问题：`finally` 中直接 `await deps.discardQuestion(questionRef)`。如果删除题干 payload 失败，异常会覆盖原来的 `false`/`addQuestion` 异常，后面的 `rejected`/`declined` 记账不会执行；下次运行可能为同一记忆版本再次出题、再次花钱。
- 证据：`if (!stored) await deps.discardQuestion(questionRef);`
- 建议：单独捕获 `discardQuestion` 的错误，仍然记录本次失败和 declined（或写一个待清理标记），并保证运行记录里只出现错误名。

### 7. [低] 样本临时文件不会被过期清理

- 文件：`apps/agent-service/src/production-real-eval.ts:189-207`、`apps/agent-service/src/production-real-eval.ts:72-81`
- 问题：写入路径是 `latest-sample.json.<runId>.tmp`。如果 `writeFile` 或 `rename` 失败，临时文件会留下；`expireRealEvalSample` 只删除 `latest-sample.json`，不清理 `.tmp`。临时文件同样包含 `maskForExport` 后的正文。
- 证据：`const temporary = \`${file}.${report.runId}.tmp\`;`，以及 `expireRealEvalSample` 只看 `REAL_EVAL_SAMPLE_FILE`。
- 建议：用 `try/finally` 删除临时文件；过期清理时一并清掉 `latest-sample.json.*.tmp`。

### 8. [低] 样本过期检查失败会阻断整轮评测

- 文件：`apps/agent-service/src/production-real-eval.ts:256`、`apps/agent-service/src/production-real-eval.ts:72-81`
- 问题：`#tick` 先 `await expireRealEvalSample(...)`。如果 `stat`/`rm` 抛非 `ENOENT` 错误（例如权限问题），整个 tick 直接失败，连 `dueRealEvalTrigger` 都不会执行。样本清理不应该阻止评测运行。
- 建议：`#tick` 内捕获并记录过期错误，继续判断是否该跑评测。

## 作者说法与代码/文档不一致的地方

- “从最近 52 次运行的 summary.declined 读”：代码是 520，见 `real-memory-eval-service.ts:117` 的 `RECENT_RUNS_FOR_DECLINES = 520`。
- “所有被拒的出题都记进 summary.declined”：`source_missing` 只记 `rejected`，不记 `declined`；`response_invalid` 按第 3 轮说明故意不记。见 `real-memory-eval-service.ts:231-247`。
- “weekly 距上次运行满 7 天才跑”：失败运行 24 小时后就重试；`budget_exceeded` 被视为非 failed，会再阻止 7 天。见 `production-real-eval.ts:60-69`。
- ADR 第 59 行写“最近 7 天没有成功跑完的运行就跑”，但 `budget_exceeded` 也会被当作已完成，代码与“成功跑完”不完全一致。
- “遮盖后的抽查样本”：实际只遮盖卡号/密码等敏感值，记忆正文和原话完整保留，见第 2 条。
- “退役题……记忆删除时随题删”：题干 payload 不是由外键直接随题删的，而是 `sqlite-governed-deletion.ts` 显式收集 `question_ref` 后删除；如果走非治理删除路径，不能仅靠外键保证题干 payload 被删。见 `sqlite-governed-deletion.ts:884-890`。

## 推测/未核实

- 多实例部署时两个进程同时 tick：代码只有进程内 `#running` 去重，没有数据库租约，理论上可并发跑两次。未核实生产是否允许多实例。
- `recordRun` 失败/进程崩溃导致费用漏算：代码路径已确认，但触发频率取决于数据库和部署稳定性。
- 作者说 `production-model-composition.unit.test.ts` 18 条、`model-payload-cleanup.unit.test.ts` 8 条是无关的既有失败：未运行测试，未核实。
- 迁移号合并前是否会被改成 main 上下一个空号：未核实。
- 生产 embedding 模型是否实际允许 sensitive：未核实；代码只证明了不支持时会拒绝。

## 侧重检查

- 错误路径：检查了 `model.failed`、`COST_INVALID`、`MODEL_NOT_COMPLETED`、`OUTPUT_TOO_LARGE`、预算超限、`addQuestion` 返回 false/抛错、`discardQuestion` 抛错、`recordRun` 抛错、样本写入失败、样本过期失败、embedding 分级拒绝。结论见第 1、3、4、6、8 条。
- 不合规/不可信输入：检查了模型输出的 JSON、`kind`、题干长度、换行/花括号、泄题、敏感值、判分 verdict，均有限制；题干和回答最终通过 JSON 编码进入提示词，未发现直接注入。配置解析、SQLite 的 kind/outcome/trigger/reason/sha256/时间格式校验也逐一核对。
- 安全/敏感信息：`summary` 只含分数、计数、记忆编号@版本、错误名；错误记录取 `error.name`；样本文件的问题是第 2 条；检索、作答、判分都按 memory/profile/召回结果的最高分级调用模型；治理删除会删除题干 payload。数据导出确认不含题库，集成测试也验证了题干不会进入导出文件。
- 资源耗尽：预算上限、单次预估、520 次运行窗口、题库/退役题增长、临时文件残留、样本 TTL、定时器重入都检查了。题库和退役题会长期累积（这是 ADR 明确保留的设计），但没有上限清理。
- 不可撤销操作：`declined` 和题目退役是不可撤销的；日期误判会因此永久排除一个记忆版本（第 5 条）。样本删除是 7 天 TTL。
- 规则/文档一致性：对照了 `.claude/rules/prompt-prefix.md` 第 15 条、ADR 0219、schema-catalog 和实际迁移/代码；主要不一致见上一节。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。此次改动新增的是独立的背景评测请求，没有系统提示、工具定义或历史消息；出题、作答、判分都是“固定提示词在前，本次数据 JSON 在后”（`questionPrompt`、`answerPrompt`、`judgePrompt`）。唯一每轮变化的值是作答提示词里的 `now`，它位于 JSON 数据的最末尾。现有对话的提示词文字没有改动，新增 eval 文本只是追加到可信固定文本清单；新增内容不会出现在旧历史里，因此不会改变旧对话已冻结的请求开头。依据：`.claude/rules/prompt-prefix.md` 第 15 条，以及 `real-memory-eval.ts:159-163、233-248、250-266`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   评测提示词本身：固定文本是常量，`JSON.stringify` 的对象键顺序固定；检索结果在 `fusion.ts:113` 按 `score`、再按 `memoryId` 排序，顺序确定。`now` 会变，但它是每次变化的末尾数据，属于允许的情况。遮盖在统一出口执行，输入相同、分级相同、固定文本清单相同的情况下结果确定。**未核实**的是 `OwnerProfileService.compose` 的块顺序是否在所有数据状态下都完全确定；若其顺序依赖数据库返回顺序，则同一内容可能产生不同字节。样本文件不是发给模型的内容，不在此问题范围。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：预算超限、真实费用大于预估时立刻停、`COST_INVALID`、UTF-8 字节预估、样本写入失败记 failed、分级传递、敏感模型配置拒绝、泄题/敏感值、日期时刻、题目退役、重复出题、`response_invalid` 重试、24 小时/7 天触发、样本 TTL、删除题干、导出不含题库、提示词固定头等。反向用例大多是有效的（例如 `stopping at once when a call costs more than its estimate` 会抓住“实际超过预估仍继续”的回归）。但有以下缺口：
   - 没有 specialist/typesafe 模型配置必须启动拒绝的用例；
   - 没有 `7:00` 与 `七点半` 这种日期误判的反向用例；
   - 没有 `discardQuestion` 自身失败的用例；
   - 没有 `recordRun` 失败/进程崩溃后费用累计的用例；
   - 没有多进程并发租约的用例；
   - 没有“mode=off 且进程长期不重启时样本仍会超过 7 天”的用例。

4. **改动产生/修改的每个值，两端校验都能接受吗？**
   大部分能：`kind`、`retiredReason`、`outcome`、`trigger` 与迁移 CHECK 和端口常量一致；`promptSha256` 是 64 位十六进制；`createdAt/retiredAt/startedAt/finishedAt` 使用 ISO 毫秒格式；`costMicros` 是非负安全整数；`model` 长度 1..256 与 `safeReference` 上限一致；`questionRef` 的 payload 删除和 `ON DELETE RESTRICT` 也做了治理删除配套测试。**有一处不一致**：`realEval.modelRef` 在配置侧接受 `specialist`（`typesafe-systemone`），但运行时 `proactiveModel` 只接受 `openai-completions`，见第 1 条。另一处是配置侧没有校验 embedding 模型是否允许 sensitive，而运行时会拒绝敏感记忆的检索，见第 3 条。
