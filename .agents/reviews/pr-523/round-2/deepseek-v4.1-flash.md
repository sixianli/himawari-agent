本轮只审计增量 `4a05d1a..7655980` 涉及的 6 个代码/测试文件，并沿证据查看了 `owner-intent-gate.ts`、`strict-configuration.ts`、提示词目录、ADR 0257、两份已提交的评测结果，以及同仓库里已有的两个 Jev 解析器用于对照。未整份重读增量未触及的旧代码。

### 1. 中高 — 评测仍不校验「主人明说」的放行率，恒答 not_explicit 的适配器照样通过
文件：`scripts/evals/owner-intent-live.eval.ts:160-185`（重点 181-185）
问题：上一轮意见 3 只补了 `errors===0`，没有补「主人明说」的放行率/错误判定。一个永远返回 `not_explicit`（解析成功、无 error）的适配器仍然全部通过。
证据（读代码证实）：
- 断言只有三条：`expect(entry.injectionAutoAllowed...).toBe(0)`、`expect(entry.borderlineAutoAllowed...).toBe(0)`、`expect(entry.errors...).toBe(0)`；`legitAutoAllowed`、`wrongIds` 只计算不使用。
- 已提交的 `evals/owner-intent-check/jev-and-deepseek-run1-min900.json:5-45` 显示 jev `legitAutoAllowed: 2, legitTotal: 30, errors: 0`，`wrongIds` 列出 28 条 legit，这份结果在当前断言下会“通过”。
建议：断言 legit 放行下限（按 ADR 0257 建议的 `minConfidence=600`，jev 为 24/30）或断言 legit 的 `wrongIds` 为空/在允许集合内；同时把实际使用的 `minConfidence` 写进结果并在断言里校验。

### 2. 中 — 新加的 `confidence === max(probabilities)` 约束可能把真实 Jev 响应全部拒绝，且没有用新解析器重跑评测
文件：`packages/application/src/services/owner-intent-answer.ts:118-130`
问题：新解析器要求 `choice`、`confidence` 必填，且 `|confidence - max(yes,no)| <= 0.001`。这是本次新增的强假设，仓库里既有的 Jev 解析路径都不这么做。
证据（读代码证实）：
- `packages/platform-node/src/typesafe-jev-transport.ts:132-166` 只校验 `confidence` 在 0..1、`probabilities` 求和为 1、`probabilities[choice] >= max`，从不要求 `confidence` 等于最大概率。
- `test/integration/production-jev-review.test.ts:198-200` 的夹具就是 `confidence = 0.95`、`probabilities: { [choice]: 1 }`，两者并不相等。
- `packages/application/src/services/memory-import-duplicates.ts:56-74` 在数组形式下只用 `option.probability`，完全忽略 `choice`/`confidence`。
- `git diff 4a05..765 --stat` 显示 `evals/owner-intent-check/*.json` 未更新；`git show 4a05:packages/application/src/services/owner-intent-answer.ts` 确认旧解析器没有这条约束，所以现有评测结果不是新解析器跑出来的。
推测：如果 `/v1/decisions` 的真实响应在数组形式下不带 `choice`/`confidence`，或 `confidence` 与最大概率不相等（同族 `/v1/systemone` 的夹具就如此），每次核对都会抛 `OWNER_INTENT_ANSWER_INVALID`，gate 返回 `check_failed`，所有符合条件的动作都出卡片。功能仍然“安全”，但等于永远不生效。
建议：去掉 `confidence` 与最大概率的相等约束（保留求和、`choice` 为最大值、概率范围检查），或者确认这是 `/v1/decisions` 的硬约束后用真实响应重跑并提交新结果，同时补一条来自真实响应的夹具。

### 3. 低 — 提交的评测结果与当前断言不一致，不能作为「评测通过」的证据
文件：`evals/owner-intent-check/jev-and-deepseek-run1-min900.json:47-71`、`scripts/evals/owner-intent-live.eval.ts:184`
问题：当前代码断言 `errors===0`，但提交结果里 deepseek 的 `errors` 是 14；这份结果也在 strict parser 之前生成。把它当成本 PR 的评测证据会误导。
证据（读代码证实）：结果文件第 54 行 `"errors": 14`；fix 提交只改了评测脚本和解析器，没有重新生成结果文件。
建议：用当前代码和严格解析器重新生成结果，或把旧文件明确标注为修复前/作废，不要同时提交为现行证据。

### 4. 低 — 20 KB 预算按原文计，未计 JSON 转义和遮盖膨胀，极端文本仍会因 INPUT_TOO_LARGE 走卡片
文件：`apps/agent-service/src/production-owner-intent.ts:46-55,88-96`、`packages/platform-node/src/owner-intent-decision.ts:37-71`
问题：`withinBytes` 用原始 UTF-8 字节数限制主人原话，但发给 Jev 的是 `JSON.stringify` 后的 body，换行变 `\n`、控制字符变 `\uXXXX`，遮盖占位符通常也比原文长。20 KB 原文仍可能膨胀到超过 `MAX_REQUEST_BYTES = 32_768`，抛 `OWNER_INTENT_INPUT_TOO_LARGE` 后走卡片。失败是关闭式的，安全，但上一轮意见 6“不再总是走卡片”只对普通文本成立；同时“最近 6 条”对长消息实际会少于 6 条（测试已改成 `<=6`）。
证据（读代码证实）：预算在 `collectOwnerWords` 内对原文字节计数；`ownerIntentRequestBody` 是序列化后才检查 32 KB 上限。
建议：保留 32 KB 硬上限作为兜底；如需更稳，可在序列化后按实际 body 再裁剪/降低原话预算，并把测试名称和文档改成“至多 6 条”。

**上一轮意见核对**
- 意见 1（决策响应校验）：已改好。`owner-intent-answer.ts:104-135` 现在校验模型名、恰好一个 `choice` 答案、两个选项齐全、概率和、`choice` 为最大值、`confidence`；单测覆盖了缺概率、少选、重复、和不为 1、choice 非最大值等反向用例。仅剩意见 2 的“过度严格”风险。
- 意见 3（评测）：部分改好。补了 `errors===0`，但 legit 放行率仍未断言，见意见 1。
- 意见 4（permille 四舍五入）：已改好。`isExplicit = yes > no`，`pair(0.4999,0.5001)` 判为 `not_explicit`，有反向单测。
- 意见 5（键遮盖）：已改好。`owner-intent-decision.ts:30` 改为 `redact(key)`，新增的键遮盖用例在旧实现下会泄漏卡号、会失败。
- 意见 6（32 KB 冲突）：典型文本下已改好，20 KB 预算 + 丢弃最旧消息；剩余极端膨胀问题见意见 4。

**侧重检查**（已查路径与结论）
- 错误路径：`OwnerIntentGate.#run` 的 `catch` 把超时/解析失败统一转成 `check_timed_out`/`check_failed`，不会自动放行；解析器的非法输入全部抛错。未见吞错放行。
- 不可信输入：响应端校验模型名、答案数量、类型、概率范围与求和；请求 32 KB、响应 1 MB 上限都在。Jev 返回内容不会直接进入主对话。
- 资源耗尽：请求/响应大小和原话字节预算都有上限；残留的转义膨胀只会失败关闭，见意见 4。
- 密钥：`apiKey` 惰性解析，空值抛错，未写入日志/审计/状态；未发现泄漏。请求体里的 `capabilityRef` 已被排除。
- 不可撤销操作：gate 的适用范围仍是 `reversible` 的 `MEDIUM` 动作（`owner-intent-gate.ts:74-85`），未扩大。
- 外来内容：发给 Jev 的只有 `ownerWords`（只取 owner 自己的消息）和 `action.tool/operation/parameters`；但 `parameters` 本身可能含由外来内容生成的文字，属于“动作参数”范围内的残留提示注入风险，提示词已声明为数据，且评测注入类为 0。
- 规则/文档一致性：ADR 0257 明确“评测过了才打开”，而评测没有 legit 断言且结果未用新解析器重跑，是本次最需要补的证据缺口。

**必答问题**
1. **不会改变模型已经见过的请求开头。** 增量没有改系统提示、工具定义、历史或主请求的遮盖，主对话仍只在末尾追加。Jev 是一次独立旁路调用，固定 `instructions` 在前、`ownerWords`/`action` 在后，符合后台调用的“固定在前、会变的在后”；它不进入主对话请求。
2. **不涉及主对话。** 主对话遮盖逻辑未动。Jev 旁路每次请求新建 `known`/`tag`，同一段文字在一次请求内遮法确定；占位编号按出现顺序分配，跨请求可能不同，但这是 zeroDataRetention 的一次性旁路、不参与提示缓存，不构成“已发内容字节被改写”。
3. **有部分自动检查。** 解析器反向用例、键遮盖、字节预算都有单测，且这些反向用例在旧实现下确实会失败。但真实评测没有用新解析器重跑，`errors===0` 也覆盖不到 legit 放行率，旧结果还与新断言冲突（意见 1、2、3）。
4. **输出值的两端核对通过。** `parseOwnerIntentDecision` 的输出形状未变（`verdict` 为 `explicit`/`not_explicit`、`confidence` 为 0..1000 整数、`quote:null`），直接使用端 `parseOwnerIntentAnswer`、`judgeOwnerIntent`、gate 的审计/状态记录、评测脚本都能接受。增量没有新增配置键或序列化格式；唯一风险是输入侧对真实 Jev 响应的新假设（意见 2），不是输出端不匹配。
