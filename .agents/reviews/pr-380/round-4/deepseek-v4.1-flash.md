已看 `git diff 5422ad7..b0e311d` 的增量，并对照读了 `production-owner-rules.ts`、`durable-memory-service.ts`、`sqlite-owner-rule-operations.ts`、`sqlite-memory-operations.ts`、`thread-prompt-bundle-service.ts`、`prompt-catalog` 和新增测试。`.agents/reviews/pr-380/round-3/judgments.md` 不在当前稀疏检出里，`git show` 也被工具拒绝，所以第 3 轮意见本身**未核实**。

## 读代码证实的

### 1. 中：按分句判断会把“以后再说”这类一次性推迟的话判成常设，可能自动生效

文件:行：`apps/agent-service/src/production-owner-rules.ts:260-266`、`apps/agent-service/src/production-owner-rules.ts:566-568`

问题：`isStandingQuote` 只要任意一个分句同时含常设字样、且该分句不含一次性字样就返回 true。于是“这封先不用管，以后再说”“今天先这样，以后再看”会被判成明说；旧逻辑因整句含“这封/今天”会拒绝。若模型给出 `inferred:false`，服务端会直接 `#activate`，不走提议卡。

证据：
```ts
return clausesOf(quote).some(
  (clause) =>
    STANDING_MARKERS.some((marker) => clause.includes(marker.replace(/\s+/gu, ""))) &&
    !ONE_OFF_MARKERS.some((marker) => clause.includes(marker.replace(/\s+/gu, ""))),
);
```
```ts
const explicit =
  !input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote));
if (explicit) return this.#activate(proposal, replayed);
```
按代码直接推出（未运行）：`"这封先不用管，以后再说"` 被切成 `["这封先不用管","以后再说"]`，第二句含 `以后` 且无一次性词，整体为 true。

建议：把“再说/再看/再讲/以后的事/later/we'll see”这类推迟语当一次性标记；或要求常设分句本身含可执行谓语/数量词（如“每次……必须……”），而不是只有裸的“以后”。补“这封先不用管，以后再说”这类反向用例。

### 2. 中：确认已撤销规则时，先恢复记忆再改规则状态；`setStatus` 失败会留下“规则已停用但出处记忆已恢复”

文件:行：`apps/agent-service/src/production-owner-rules.ts:472-505`、`apps/agent-service/src/production-owner-rules.ts:412`

问题：`#activate` 先 `#writeMemory`（内部会 `#reviveMemory`），再 `rules.create`，最后把 retired 规则改回 active。如果规则改状态失败（并发 revision 变化或写库失败），抛出 `RULE_UNAVAILABLE`，此时记忆已经是 active，而规则仍是 retired。按 ADR 的说法，这正是要避免的“规则已停用而模型仍看得到这条规矩”。

证据：
```ts
const memoryId = await this.#writeMemory({ ... });
...
if (stored?.status === "retired") {
  const revived = await this.#options.rules.setStatus({ ... status: "active" ... });
  if (!revived) throw new OwnerRuleError("RULE_UNAVAILABLE");
}
```
建议：把恢复记忆和改规则状态放进同一个事务；或在 `setStatus` 失败时重新归档刚恢复的记忆。补一个注入 `setStatus` 失败的用例。

### 3. 中：出处记忆被永久删除后，写规则类记忆会把它重新建出来，和“已删除就报错”不一致

文件:行：`apps/agent-service/src/production-owner-rules.ts:383-413`、`apps/agent-service/src/production-owner-rules.ts:658-666`、`packages/application/src/services/durable-memory-service.ts:121-153`

问题：`#writeMemory` 先 `applyProposal({decision:"create"})` 再 `#reviveMemory`。如果记忆行已经被治理删除永久清掉，`applyProposal` 的 create 分支读不到旧记录，会新建一条 active 记忆；随后 `#reviveMemory` 看到 active 直接返回。于是“已删除就报错、要主人重新说”只在 `reconfirm` 路径成立；对旧的提议卡再次点“生效”会把主人永久删除的记忆重新建回来。

证据：
```ts
const existing = await this.options.state.read(proposal.memory.id);
if (existing) { ... return existing; ... }
...
const record: ProductMemoryRecord = Object.freeze({ ... status: "active", ... });
const saved = await this.saveWithProjection(record, null, "upsert", generationId, ...);
```
`#writeMemory` 里的顺序：
```ts
await this.#options.memory.applyProposal({ decision: "create", ... }, generation);
await this.#reviveMemory(memoryId);
```
建议：`#writeMemory` 在 `applyProposal` 前先用 `memories.read` 判断；对“曾存在、现在被永久删除”的键拒绝重建。若无法区分新旧，至少在 `#activate` 的 replay/confirm 路径先检查 source memory 是否还存在。补永久删除后的反向用例。

### 4. 中：同参数已有规则时提前返回，既不复核也不恢复那条规则的出处记忆，还硬编码成 active

文件:行：`apps/agent-service/src/production-owner-rules.ts:453-469`、`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:88`

问题：`existing` 包含 `needs_review`，`sameRule` 只比参数，不看状态。命中 `same` 时直接返回 `status:"active"` 和 `same.sourceMemoryId`，既不 `#reviveMemory`，也不把 `needs_review` 改回 active。若那条重复规则的出处记忆已归档或永久删除，用户点“生效”会看到 active 回执，但数据库里规则仍是 `needs_review`、记忆仍未恢复/已不存在；“已删除就报错”也不成立。

证据：
```ts
const same = existing.find(
  (row) => row.ruleId !== ruleId && sameRule(row.parameters, parsed.type, parsed.params),
);
if (same)
  return Object.freeze({
    status: "active",
    ruleId: same.ruleId,
    ...
    memoryId: same.sourceMemoryId,
```
而 `list` 确实包含待重审规则：
```sql
AND (? = 1 OR status IN ('active', 'needs_review'))
```
建议：`same` 分支使用 `same.status`，先对 `same.sourceMemoryId` 调用 `#reviveMemory`，需要时再走 `setStatus`；补同参数、出处记忆已归档/已删除的用例。

### 5. 低：没有逗号的真常设句会被分句判断漏掉

文件:行：`apps/agent-service/src/production-owner-rules.ts:48`、`apps/agent-service/src/production-owner-rules.ts:79-103`、`apps/agent-service/src/production-owner-rules.ts:268-273`

问题：`CLAUSE_BREAK` 只按标点切分，且一次性词是整词包含。`"今天起每次都提醒我"`、`"今日から毎回必ず…"`、`"この種類のメールは必ず…"` 这类没有逗号的常设句，`今天/今日/この` 与 `每次/毎回/必ず` 落在同一分句，被判 false，只能生成提议；而 ADR 的“从今天开始，以后每次…”依赖逗号。

建议：对“从今天/今日起”“今日から”“この種類/この手の”这类前缀先归一化，或把“从…起/から”作为常设上下文；补中英文无逗号用例。

### 6. 低：新增测试没有覆盖“已删除/回收站”和失败顺序

文件:行：`test/integration/production-memory-capture.test.ts:1940-1963`

问题：新增断言只覆盖：归档后的 reconfirm 会把记忆恢复为 active；以及 `isStandingQuote` 的三个直接调用。没有覆盖：trashed、deletion_pending/永久删除；`#writeMemory` 的已删除路径；`setStatus` 失败后的记忆/规则状态；同参数 `same` 分支；“以后再说”这类假阳性。

证据：
```ts
expect(isStandingQuote("从今天开始，以后每次收到入管局的邮件都必须提醒我")).toBe(true);
expect(isStandingQuote("刚才那封必须提醒我")).toBe(false);
expect(isStandingQuote("这封必须提醒我")).toBe(false);
```
这三个中，前两个改造前会失败，确实是有效反向用例；但“这封必须提醒我”在改造前也是 false，不能证明分句逻辑。

建议：补上述失败路径和假阳性用例；把 `isStandingQuote` 提到独立单测，避免只能靠集成测试。

### 7. 低：提交的实测结果仍有一次失败，按脚本默认阈值会失败

文件:行：`scripts/evals/owner-rule-live.eval.ts:21`、`scripts/evals/owner-rule-live.eval.ts:215-216`、`evals/owner-rule/result.json`

问题：`result.json` 的 glm 是 14/15，失败原因是“标成了推断”。脚本默认 `EVAL_MINIMUM_PASS_SHARE=1`，即要求 100%；除非运行时显式调低，否则用同一份结果重跑会失败。结果文件也没有记录阈值、git 提交或工具说明版本。评测还依赖 `EVAL_CONFIRM_COST>0`，不在 CI 里，不能作为回归门禁。

证据：
```ts
const MINIMUM_PASS_SHARE = Number(process.env["EVAL_MINIMUM_PASS_SHARE"] ?? "1");
...
expect(passed / total, model).toBeGreaterThanOrEqual(MINIMUM_PASS_SHARE);
```
结果摘要：
```json
"model": "glm-5.3-flash", "passed": 14, "total": 15
```
建议：修复该用例或明确记录放宽阈值的理由；把“英文词必须放 words”这类行为做成确定性 fixture 测试，而不是只靠在线评测。

### 8. 低：服务端有“请重新说一遍”的 detail，但网页端收不到

文件:行：`apps/agent-service/src/production-memory-control.ts:1094-1102`、`apps/control-center/src/memory.ts:122-135`

问题：`#reviveMemory` 抛出的 `OwnerRuleError` 带有“这条规则的出处记忆已删除，请重新说一遍”，但控制层转换成 `ApplicationPortError(INVALID_OPERATION, error.code)`，丢掉 detail；前端 `run` 只 `setFailed(true)`。用户只看到失败，不知道要重新说。

建议：给已删除出处记忆一个稳定的错误码/文案并在 i18n 中展示；或把 detail 安全地传到回执/记忆页。

## 其他观察（不是本次引入）

- 英文 marker 用 `includes` 匹配：`mustard` 含 `must`、`nevertheless` 含 `never`、`mustn't` 含 `must`，都可能让 `isStandingQuote` 误判为常设。这是本次之前就有的，`apps/agent-service/src/production-owner-rules.ts:53-78` 和 `:260-266`，本次未修。若要收紧，拉丁文 marker 应加词边界。

## 推测 / 未核实

- `prompt-manifest.json` 里 `tools.rule-set` 的新 `sha256` 是否和实际文本一致，我无法运行哈希命令核对。自动检查会算 `sha256(JSON.stringify(entry.segments))` 并在不一致时报 `PROMPT_MANIFEST_STALE`（`apps/agent-service/test/prompt-catalog.unit.test.ts:172-194,318,370-380`），所以提交的 check 若跑过应能发现；这里标未核实。
- 工具说明文字变了以后，`TRUSTED_PROMPT_TEXTS` 只取当前目录（`packages/prompt-catalog/src/trusted.ts:10-14`、`entry.ts:61-69`）。按 `prompt-prefix.md` 第 11 条，老对话里冻结的旧工具说明会从“固定文字”清单里消失，理论上可能改变出口遮盖。我对照了旧/新文本，未发现 6 位以上连续数字或密码/验证码类字样，因此推断不会改变老对话字节；但实际遮盖器未运行，标为推断。
- 第 3 轮复核记录未读到，作者对第 3 轮意见的逐条落实是否完整，未核实。

## 侧重检查

- **错误路径**：查了 `#reviveMemory`、`#archiveMemory`、`reconfirm`、`undo`、`#activate` 和 `confirm`。结论：`reconfirm` 的“先恢复记忆、再改规则状态”在失败时不会留下 active 规则 + 归档记忆；`undo` 的“先归档、再停用”方向正确；但 `#activate` 的 retired→active 路径在 `setStatus` 失败时会留下 retired 规则 + active 记忆（问题 2），`same` 提前返回完全不恢复（问题 4）。
- **不合规范/不可信输入**：`ruleId`/`proposalId` 有前缀和长度/正则校验；`params`、`summary` 在 `parseOwnerRuleParameters` 和 `validRuleSummary` 里重新校验；`confirm` 对解密后的提案没有 schema 校验，坏 JSON 会抛 `SyntaxError` 而不是 `RULE_*`，但提案由本服务加密写入，风险低。新增一次性词和分句逻辑只影响判断，不引入外部输入解析。
- **安全 / 隐私**：发现“永久删除的出处记忆可能被旧的提议卡重新创建”（问题 3），这是不可逆删除语义上的实质问题。`#reviveMemory` 只按 memoryId 读、没有 owner/agent 过滤，但 memoryId 由本服务生成、规则行也按 owner/agent 读取，未见新的越权路径。
- **资源耗尽**：quote 上限 500、列表每项 32、规则最多 32 条；`#storedOwnerRules` 每次邮件检查最多读 200 行；replay 受 `mailsPerOutcome` 限制；在线评测默认 `EVAL_CONFIRM_COST=0` 直接拒绝花钱。未见本次新增无界循环或明显放大。
- **不可撤销操作**：`undo` 可再确认恢复；本改动没有新增硬删除。问题 3 是“永久删除被重建”，属于删除语义风险。
- **规则文件/说明文档/代码一致**：ADR 关于“按分句、同一分句不含一次性字样”的句子与代码一致；“200 个 UTF-16 单位”与 `validRuleSummary` 的 `trimmed.length` 一致。但 ADR 写的“出处记忆已删除的会报错”对 `#writeMemory` 和 `same` 分支不成立（问题 3、4）。
- **工具说明是否只影响新对话**：代码里没有功能开关；只要 `memory` 启用，`ProductionRuntimeTools` 就会注册规则工具（`production-runtime-tools.ts:563`、`service-main.ts:1301-1319`）。因此“工具还没上线”只能理解为 PR 尚未部署，无法由代码保证。对已存在对话，`ThreadPromptBundleService` 只在工具名、参数结构、模型、推理强度、语言、分类变化时换新；`toolSchemaChanged` 会去掉 `title/description` 等文字字段（`thread-prompt-bundle-service.ts:120-157,201-207`），所以**工具说明文字变化不会让老对话换新**。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动里唯一进入模型请求的是 `TOOL_RULE_SET.text`，它在工具定义里，而工具定义按对话冻结：已有 bundle 在 `origin === undefined` 且工具名、参数结构、模型等未变时直接返回旧 bundle（`packages/application/src/services/thread-prompt-bundle-service.ts:194-207`）。工具说明文字不在 `toolSchemaChanged` 的比较范围（`:120-157`）。`isStandingQuote` 的改动只影响服务端“直接生效还是生成提议”，不改变发给模型的文本。也没有新增每轮变化的值；`x-opencode-session` 只在评测脚本里，不在生产请求里。新对话会拿到新说明，这是 `prompt-prefix.md` 第 6 条允许的。唯一需要留意的是问题“推测/未核实”里说的老冻结文字不再属于 `TRUSTED_PROMPT_TEXTS`，但我未发现旧文本含会被遮盖的敏感值，推断字节不变。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本次没有新增依赖前后文的遮盖、时间字段或无序集合。新 marker 数组是固定常量，`clausesOf` 的切分和 `foldText` 是确定性的；`parseOwnerRuleParameters` 对列表做了去重和排序；规则/提议 id 由固定输入哈希得到；工具说明是固定文本。评测 header 只影响评测脚本。未见新的非确定性。既有遮盖清单变化的理论风险见上一条，属于推断，不是本次新增的去中心化随机。

3. **有没有自动检查，反向用例是否真的会失败？**
   有部分检查。新增的 `isStandingQuote("从今天开始，以后每次…") === true` 和 `"刚才那封必须提醒我" === false` 在旧逻辑下会失败，是有效的反向用例；“这封必须提醒我”旧逻辑也返回 false，不能单独证明分句改动。`prompt-catalog` 的 manifest/stale 检查是自动的。但“以后再说”假阳性、已删除/回收站记忆、`setStatus` 失败顺序、同参数 `same` 分支都没有测试。在线评测不是 CI，且提交的 `result.json` 仍有 glm 14/15，按默认 100% 阈值会失败。所以不能说改动已有完整自动检查。

4. **每个值的使用方都能接受吗？**
   大部分可以：`memories` 依赖三处构造都补了（`production-http-composition.ts`、`service-main.ts`、测试），`ProductMemoryStatePort.read` 在 SQLite 里不按状态过滤，确实能读到 archived/trashed（`sqlite-memory-operations.ts:554-558`）；`sourceMemoryId` 的 `memory:rule:<32hex>` 满足 SQLite 的 `MEMORY_ID` 校验；工具说明的 manifest 有 digest 检查。但有两处两端不一致：一是 `#writeMemory` 先用 create 再检查，永久删除的记忆会被重建（问题 3）；二是 `same` 提前返回不恢复也不校验出处记忆，却报告 active（问题 4）。这两处说明“清单里的值/状态”在后端没有被完整核对。
