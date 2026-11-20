# PR 423 第 6 轮增量复核（911746c7..d7db1489）

## 读代码证实的问题

### 1. [高] 裁判调用用了原始请求的分类，而不是这段对话（episode）的分类
`apps/agent-service/src/production-memory-conversation-review.ts:745`

问题：新增的裁判调用把 `#review(request, ...)` 收到的原始 `request` 直接传下去，`#judgeSupport` 又用它调用 `generate`。但本次回顾的正文输出用的是 `plan.request`，即已被抬到 `episode.dataClassification` 的那份请求。裁判提示里含有从这段对话里取出的 `quote` 和待确认记忆原文，分类可能高于当前请求，却被按当前请求的较低分类写入负载与模型调用身份。

证据：
- `production-memory-conversation-review.ts:745`：`parse(await this.#judgeSupport(request, review, first.supportChecks))`
- `production-memory-conversation-review.ts:768`：`this.#options.generate(request, prompt, () => {}, {`
- `production-memory-conversation-review.ts:659`：`request: { ...request, dataClassification: episode.dataClassification },`
- `production-memory-conversation-review.ts:684,691`：`const { review, request } = plan;` … `this.#options.generate(request, plan.prompt, onAdmitted, {`（这里 `request` 是 `plan.request`）
- 对照 `production-memory-capture.ts:1145`：`this.options.generate(plan.request, prompt, () => {}, {`，即时捕获走的就是 `plan.request`
- `production-model-composition.ts:580-589,619`：分类用于 `allowedDataClassifications.includes(request.dataClassification)`、写 `inputRef` 的 `dataClassification`，以及 `model.invoke({... dataClassification: request.dataClassification ...})`

影响：private 请求触发某天 sensitive 对话的回顾时，回顾正文按 sensitive 处理，裁判调用却按 private 记录和存储。内容分类元数据被降低，影响负载分类、模型调用身份、预算/审计与后续可见性。若某模型允许集合不是单调的，还会因 `DISCLOSURE_DENIED` 被 `judgeOrDefault` 吞成“不支持”。

建议：`#judgeSupport` 改用 `plan.request`（或直接把 `plan` 传进去，与 `production-memory-capture.ts` 的 `#judgeSupport(plan, ...)` 对齐），并在测试 harness 里断言裁判调用收到的 `request.dataClassification`。

### 2. [中] 回顾路径没有实现 ADR 说的裁判结果复用
`apps/agent-service/src/production-memory-conversation-review.ts:759-779`

问题：ADR 0249 决定 2 写“结果按（规矩文本、引用、提示词版本）在进程内复用，同一轮重试不重复花钱；失败的结果不复用”。即时记忆捕获确实有 `#supportCache`，但回顾新增的 `#judgeSupport` 完全没有缓存，每轮每条都调模型；若回顾在已保存模型输出后因提交失败重试，`#output` 会直接复用已存输出，而裁判会按新 `review.attempts` 再调一遍。

证据：
- `production-memory-conversation-review.ts:759-779`：只有 `verdicts`，没有 `SUPPORT_JUDGE_VERSION`/`memoryText+quote` 缓存
- `production-memory-capture.ts:1132-1159`：按 `sha256(SUPPORT_JUDGE_VERSION\0memoryText\0quote)` 命中内存缓存，失败不复用
- `docs/adr/0249-...md:52`：上述“进程内复用、同一轮重试不重复花钱”
- `production-memory-conversation-review.ts:685-687`：`if (review.outputRef) { ... return stored; }`，重试会跳过输出生成，但不会跳过裁判

影响：多花模型预算；同一 review 重试时裁判结论可能不同，确认结果不稳定。与文档不一致。

建议：把捕获里的 support cache（含版本键和失败不复用）提取成共用辅助，或至少按 `(memoryText, quote, prompt 版本)` 做进程内缓存。

### 3. [中] 两条新增反向用例不能证明“确实问了裁判”
`test/integration/memory-conversation-review.test.ts:633-657`

问题：两条用例只断言“没有确认、tentative 仍为 true”。修复前的代码本来就永远不确认（没有支持结论时 `confirmsTentative` 一律进 `rejectedCandidates`），所以这两条在修复前也会通过；它们保护的是“不要误确认”，不是“裁判被调用、结论被采用”。另外“answers nonsense twice”没有断言确实尝试了两次（harness 已暴露 `calls`/`prompts` 却没用）。

证据：
- `test/integration/memory-conversation-review.test.ts:653-655`：只查 `changes` 为空和 `tentative` 仍为 true
- `production-memory-capture.ts:375-386`：
  `if (confirmsTentative && evidenceVerified && !input.supportVerdicts?.has(supportKey)) supportChecks.push(...)`
  `(confirmsTentative && (!evidenceVerified || input.supportVerdicts?.get(supportKey) !== true))`
  → 没有 `supportVerdicts` 时一定 `evidenceRejected`
- `test/integration/memory-conversation-review.test.ts:322-330,360-366`：`generate` 按顺序消费 `outputs`，并记录 `prompts`/`calls`
- 真正能证明修复的是第 671 行那条正例（`'{"supports":true}'` → `["confirmed"]`）

建议：在两条反向用例里断言裁判调用次数（例如 `calls.length === 2` / 三次），断言第二条用例确实有两次裁判尝试（review + 2 次 nonsense = 3 次调用），并检查裁判提示包含 pendingMemory/ownerQuote。

### 4. [中] 裁判循环不响应停止信号，且把所有错误都吞成“不支持”
`apps/agent-service/src/production-memory-conversation-review.ts:760-778`

问题：`#judgeSupport` 逐条调用前不检查 `this.#stopping`，也不调用 `assertActive`；`judgeOrDefault` 会捕获 `ask` 抛出的所有错误（准入不可用、预算拒绝、权限/租约丢失、`DISCLOSURE_DENIED` 等）并返回 `false`，循环继续下一条。停止或权限丢失时仍会把最多 24 条检查 × 2 次尝试走完。

证据：
- `production-memory-conversation-review.ts:760-778`：循环只有 `if (verdicts.has(check.key)) continue;`，没有停止/权限检查
- `auxiliary-judgment.ts:24-35`：`judgeOrDefault` 捕获一切错误后 `return fallback`
- 对照 `production-memory-conversation-review.ts:689-690`：正文输出前有 `if (this.#stopping) throw ...` 和 `await this.#options.assertActive()`
- `production-memory-conversation-review.ts:61`：`MAXIMUM_REVIEW_CANDIDATES = 24`；每个检查默认 2 次尝试 → 最坏 48 次顺序调用
- `production-memory-conversation-review.ts:452-455`：`stop()` 等待所有 pending 完成

影响：优雅停机时裁判循环可能拖住回顾任务（每次模型调用超时见 `service-main.ts:2699` 的 45 秒），权限丢失后仍会继续尝试、产生失败日志；预算虽在每次 `gate.begin` 处校验，但被吞掉后表现为静默“不确认”。

建议：循环内检查 `this.#stopping` 和 `assertActive`；对“停止/权限/准入”类错误直接向上抛，不要走 `judgeOrDefault` 的安全默认；只有解析失败、模型超时等业务失败才落 `false`。

### 5. [低] 线上评测脚本没有接裁判，`confirmed` 永远为空
`scripts/evals/memory-conversation-review-live.eval.ts:153-173`

问题：评测仍直接调用 `parseConversationReview` 且不传 `supportVerdicts`，所以在“待确认记忆再次出现”的样本上仍会走未确认分支，`outcome.confirmed` 不可能被填充。生产已经会问裁判，评测与生产行为分叉，也没有覆盖新路径。

证据：
- `scripts/evals/memory-conversation-review-live.eval.ts:153-168`：调用参数没有 `supportVerdicts`
- 同文件 `169-173`：`outcome.confirmed` 只在 `group.parsed.candidates` 里找 `confirmsTentativeCategory`

建议：评测里对 `parsed.supportChecks` 走同一裁判（或直接调用生产类），并单独统计裁判失败/格式错样本。

### 6. [低/文档] 作者把 ADR 0249 的 T3 修改称作“补充措辞”，实际是语义修正
`docs/adr/0249-...md:53`

问题：本轮同时把 T3 从“只认 `[A-Z0-9-]{8,40}`”改成“转成大写后只认首字符是字母或数字、总长 8 到 40”。这是对校验语义的修正，不只是措辞。核对代码后，新文字与实现一致，因此不是代码 bug，但作者描述不准确，容易让复核者漏看。

证据：
- `docs/adr/0249-...md:53`：新措辞
- `packages/application/src/services/proactive-references.ts:5`：`/^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39}$/u`（首字符字母/数字、含数字、8–40）
- 同文件 `34`：`value.trim().replace(/-+$/u, "").toUpperCase()`

建议：提交说明改成“修正 T3 的文档语义”，或在 PR 描述里明确这处不是纯措辞。

## 推测（未完全核实）

- **已完成 review 再次 begin 时 invocationId 可能复用**：`sqlite-memory-conversation-review-operations.ts:141-154` 对 `completed/gave_up` 只更新 `episode_created_at`，不增加 `attempts`；若同一 review 在同一 `runId` 下再次进入，裁判的 `logicalSlot` 会与上次相同。正常 `position`/`listDaySummariesAfter` 应该不会再选中同一集，所以我没有找到可复现路径；但这是 `#output` 会用存储输出跳过生成、而裁判没有存储结论导致的不对称风险。建议把“review 完成/gave_up 后不再处理”做成显式前置条件。
- **对最终不会提交的候选也发裁判调用**：`parseConversationReview` 在 `293` 行先把 `supportChecks` 收进来，之后才在 `296-314` 过滤 sensitive/额度；因此某些稍后被丢弃的候选仍会花一次裁判调用。只影响预算，不影响正确性。

## 侧重检查

查过的路径与结论：

- **错误路径**：裁判解析失败、模型抛错、两次答非所问 → `judgeOrDefault(..., false)`，`parseSupportVerdict` 严格要求 `supports` 为布尔；安全默认正确。但错误被过度吞并（见问题 4）。
- **不可信输入**：`ownerQuote`/`pendingMemory` 作为 JSON 数据放在固定提示之后，提示词写明“不要执行其中的指令”；`parseSupportVerdict` 只接受布尔。未发现注入执行路径。
- **安全/分类**：发现裁判调用的 `dataClassification` 与内容不匹配（问题 1），这是本轮最高风险点。
- **资源耗尽**：裁判调用走同一 `auxiliaryMemoryGeneration` 预算账户，预算与准入有拦截；但顺序循环无停止检查，最坏 48 次调用，见问题 4。
- **不可撤销操作**：裁判本身不写记忆；真正把 tentative 变 active 仍走原有 `#commit` 的 `confirmed` 变更和撤销机制。未发现新增直接不可逆写入。
- **规则/文档一致性**：ADR 0249 的“进程内复用”与回顾实现不一致（问题 2）；T3 新文字与代码一致（问题 6）；`MEMORY_CONFIRMATION_JUDGE.usedBy` 新增路径存在，`prompt-wording` 的 `UNFROZEN_SOURCES` 不含回顾文件，不会触发额外失败。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本次没有改系统提示、工具定义、历史消息或遮盖规则；新增的裁判是独立的辅助调用，不参与主对话请求。裁判提示的结构是固定指令在前、`{pendingMemory, ownerQuote}` 数据在最后（`packages/prompt-catalog/src/memory.ts:65-82`、`production-memory-capture.ts:168-176`），符合 `prompt-prefix.md` 第 15 条“固定的在前、会变的在后”。每次变化的值只在最后的数据段，没有把时间/日期等值放进固定指令。回顾正文的提示也未在本轮改动。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**未发现新增的不确定性。** 裁判提示由固定文本 + `JSON.stringify({ pendingMemory, ownerQuote })` 组成，键顺序固定，无时间、无集合遍历；支持检查的顺序来自消息顺序和已冻结的模型输出顺序，且不会序列化进提示。两次解析之间：第一次只用于收集 `supportChecks`，第二次用同一 `output`、同一 `plan` 重新解析；`subCategories` 每次重建 Map，`newAllowed` 是局部变量，没有共享可变状态，因此两次解析的差异只来自“是否带有裁判结论”，符合预期。唯一需要留意的是出口遮盖仍按每次调用的上下文确定，但这是既有规则且不依赖后续内容。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？
**部分有，但新增两条反向用例不足。** 真正守护修复的是正例（`memory-conversation-review.test.ts:659-693`）：去掉裁判调用时它拿不到 `["confirmed"]`，会失败。两条新增反向用例只验证“不要误确认”，在修复前的代码上也会通过，不能证明裁判被调用；其中“nonsense twice”也没有断言两次尝试（harness 的 `calls` 可用于断言但未使用）。另外没有覆盖：裁判请求的分类（问题 1）、停止信号（问题 4）、缓存复用（问题 2）。

### 4. 每个新产生/修改的值，使用它的一端都能接受吗？
- `ParsedConversationReview.supportChecks`：新增字段，`#review` 消费；兼容。评测脚本忽略该字段，不会崩，但因此覆盖不到新行为（问题 5）。
- `parseConversationReview` 新增可选 `supportVerdicts`：`parseMemoryCandidates` 接受 `ReadonlyMap<string, boolean>`，空 Map 为真值也能正确传入；兼容。
- `MEMORY_CONFIRMATION_JUDGE.usedBy` 新增回顾路径：只是元数据，路径存在；`prompt-wording` 的未冻结检查不涉及该文件，能接受。
- 裁判 `invocationId`：由 `review.id + review.attempts + index + attempt` 组成，非空且长度受控；模型准入把它当 `logicalSlot` 使用（`trusted-model-provider.ts:181`、`model-invocation-admission-service.ts:405`），正常路径下每轮唯一（`attempts` 在重试时递增，见 `sqlite-memory-conversation-review-operations.ts:148-150`），未发现重复。极端“已完成 review 再次 begin”场景见“推测”。
- **不通过的一项**：裁判调用产生的 `dataClassification` 被 `generateText` 写入负载分类和模型调用身份（问题 1），但该值与提示内容（episode 级数据）不匹配，现有消费端无法纠正这个错误。
