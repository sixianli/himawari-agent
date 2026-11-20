**侧重检查**

本轮查过的范围：`ad387e81..948e400` 之间同一分支上的四次合入 main（`464abd166`、`2ff2dd240`、`3cda3206c`、`948e400a3`），重点核对 `3cda3206c` 与 `948e400a3` 的 `git show` 组合差异（只有冲突解决才会出现在组合差异里），以及作者点名的四个文件在 `ad387e81`、两个父提交、HEAD 三处的差值。逐项检查了：

- **错误路径**：`memory.import.duplicates.read` 在没有 checker 时走哪条分支（见意见 1）。
- **不可信输入**：`memory.rule.respond` 新增的 `ask_first` / `allow_directly` 路径。`execute()` 入口先 `assertOwner`（`production-memory-control.ts:1650`），`BuiltInActionRuleSwitches.setAskFirst` 会按 `BUILT_IN_ACTION_RULES` 校验 `target`，未知规则报 `ACTION_RULE_NOT_FOUND`，不是任意 id 都能写入；写入走 `commitStateAndEvents` + authority fence + 幂等键（`action-rule-switches.ts:77-117`）。结论：未发现越权或任意写。
- **安全 / 出口**：导入判重的模型请求只带 `existing`/`candidates` 文字，并按 `redactForExternalText` 遮盖、`zeroDataRetention: true`（`memory-import-duplicate-decision.ts:22-65`）；生产 checker 要求 `productionSuitable` 的密钥源、空密钥报错（`production-memory-import-duplicates.ts:197-226`）。服务端只取非 `sensitive`/`restricted` 的已有记忆（`production-memory-control.ts:1393-1399`）。
- **资源耗尽**：checker 有 `maximumExistingMemories`、`maximumRequests`、`dailyMaximumRequests`、批次与超时限制（`production-memory-import-duplicates.ts:114-184`）；但如意见 1，这套限制目前在装配层根本到不了 `ProductionMemoryControl`。
- **不可撤销操作**：本轮改动没有新增删除/覆盖记忆的路径；`ask_first` 开关可逆，未见不可撤销写入。
- **规则 / 文档 / 代码一致性**：ADR 0271 第 7、8 条说配置后该查询应做模型判断，但装配层漏传，见意见 1；作者对“冲突文件只有那四个”的说法也与实际合并记录不完全一致，见意见 3。

作者四个文件的核心说法逐条核对：`production-memory-control.ts` 同时保留 `BuiltInActionRuleSwitches`（第 45 行）与 `ProductionImportDuplicateChecker`（第 62 行），两个 options 字段（258、272 行）和两套查询实现都在；`service-main.ts` 的两个导入与两个值都在（95、131-136、2987、2994 行）；`production-http-composition.ts` 的 `ProductionDeviceControl`、`ProductionFilesControl`、`ProductionLoginDevicesControl` 导入和实例都在，未重复；`memory-page.tsx` 的 `BuiltInActionRulesSection` 与 `OwnerRulesSection` 导入（52 行）和渲染（2478-2479 行）都在。**没有发现任何一边的导入或被使用值被删掉，也没有重复声明。**

---

### 1. 高 — 导入判重的 checker 在 HTTP 组合层被静默丢弃，配置后整项功能仍全部返回 `skipped`

文件：`apps/agent-service/src/service-main.ts:2994`、`apps/agent-service/src/production-http-composition.ts:237-240`、`apps/agent-service/src/production-http-composition.ts:1191-1206`、`apps/agent-service/src/production-memory-control.ts:1346-1358`

问题：`service-main` 把 `memoryImportDuplicates` 放进 `createProductionHttpComposition({ memory: { ... } })`，但 `ProductionHttpCompositionOptions["memory"]` 没有 `importDuplicates` 字段，构造 `ProductionMemoryControl` 时也没有转发它。于是生产环境里 `ProductionMemoryControl.options.importDuplicates` 永远是 `undefined`，`#importDuplicates` 对每个条目都返回 `skipped`。ADR 0271 声称配置 `runPolicy.importDuplicates` 后会由模型判断，实际配置了也不会调用模型。

证据（读代码证实）：

```ts
// service-main.ts:2984-2994
memory: {
  service: activeDurableMemory,
  externalProposals,
  actionRules: new BuiltInActionRuleSwitches({ ... }),
  ...(memoryClassifier ? { classifier: memoryClassifier } : {}),
  ...(memoryImportDuplicates ? { importDuplicates: memoryImportDuplicates } : {}),
  onAudit: ...
}
```

```ts
// production-http-composition.ts:237-240 —— 没有 importDuplicates
readonly externalProposals?: ProductionMcpMemoryWriter;
readonly actionRules?: Pick<BuiltInActionRuleSwitches, "list" | "setAskFirst">;
readonly classifier?: Pick<ProductionMemoryClassifier, "classify">;
readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
```

```ts
// production-http-composition.ts:1191-1205 —— 只转发 actionRules/externalProposals/classifier
reviews: { memories: repository.memoryReviews(), rules: repository.ruleReviews() },
book: repository.memoryBook(),
ledger: repository.decisionLedger(),
...(options.memory.actionRules ? { actionRules: options.memory.actionRules } : {}),
...
...(options.memory.externalProposals ? { externalProposals: options.memory.externalProposals } : {}),
...(options.memory.classifier ? { classifier: options.memory.classifier } : {}),
onAudit: options.memory.onAudit,
```

```ts
// production-memory-control.ts:1346-1358 —— checker 为空时全部 skipped
const checker = this.options.importDuplicates;
const results = checker ? await this.#checkImportDuplicates(checker, refs) : null;
...
verdict: results?.[index]?.verdict ?? "skipped",
memoryId: results?.[index]?.memoryId ?? null,
```

生产里构造 `ProductionMemoryControl` 的唯一位置就是 `production-http-composition.ts:1131`（`git grep`/全仓搜索只有这里和测试文件），没有第二条装配路径。

来源说明：这不是本次冲突解决新造的代码。main 的 `4d139c528` 已在 `service-main` 里用条件展开传入 `importDuplicates`，但从未改过 `production-http-composition.ts`；`d4c1fcd1` 和分支父 `3cda3206c` 都已缺少这段转发。**所以两个父提交本身就有这个问题，本次合并原样保留。** 但这正是 I-73 提醒的“生产者与使用端对不上”：值产生了，中间层不认。

推测（未运行 tsc，仅依据 TypeScript 行为）：`...(memoryImportDuplicates ? { importDuplicates: ... } : {})` 是展开属性，TS 的 excess property check 不会报 `Object literal may only specify known properties`，所以类型检查放过了它，错误只能到运行时暴露。

建议：
1. 在 `ProductionHttpCompositionOptions["memory"]` 增加 `readonly importDuplicates?: Pick<ProductionImportDuplicateChecker, "check" | "existingLimit">`；
2. 在 `new ProductionMemoryControl({...})` 里增加 `...(options.memory.importDuplicates ? { importDuplicates: options.memory.importDuplicates } : {})`；
3. 增加一条经 `createProductionHttpComposition` 的用例，断言配置存在时该查询会调用 checker、不会全部 `skipped`（见意见 2）。

### 2. 中 — 没有任何自动检查覆盖 service-main → http-composition → ProductionMemoryControl 的 importDuplicates 传递，反向用例也不会失败

文件：`test/integration/production-memory-capture.test.ts:382-384`、`apps/control-center/test/memory-interactions.unit.test.ts:1959`、`apps/agent-service/test/production-http-composition.unit.test.ts`（全文没有 `importDuplicates`/`duplicates` 的断言）

问题：现有测试都绕开了真正的装配链。集成测试直接在 `new ProductionMemoryControl({ classifier, importDuplicates, ... })` 里塞 checker；网页测试只测 `applyImportDuplicates` 纯函数；`production-http-composition` 的用例里没有导入判重的任何断言。因此意见 1 的“中间层漏传”不会让任何用例失败，正向用例（配置了 checker 应返回 `same`/`unsure`）和反向用例（没配置才是全 `skipped`）都没有在装配层建立。

证据（读代码证实）：

```ts
// test/integration/production-memory-capture.test.ts:382-384
const control = new ProductionMemoryControl({
  classifier,
  importDuplicates,
```

```ts
// apps/control-center/test/memory-interactions.unit.test.ts:1959
const checked = applyImportDuplicates(parsed.items, [ ... ]);
```

建议：补一条集成用例，走 `createProductionHttpComposition({ memory: { importDuplicates: checker, ... } })`，然后发 `memory.import.duplicates.read`，断言 checker 被调用且结果不是全 `skipped`；同时补“没有 checker 时全 `skipped`”的反向断言。这样意见 1 的漏传会立刻失败。

### 3. 低 — 作者对“本轮冲突文件”的描述不完整、也不完全准确

文件：`packages/application/src/ports/configuration.ts:369-372`；合并提交 `3cda3206c`、`948e400a3`

问题：作者说本轮冲突只有 `production-memory-control.ts`、`service-main.ts`、`production-http-composition.ts`、`memory-page.tsx` 四处，但实际是：
- `production-http-composition.ts` 的文本冲突是在 `3cda3206c` 解决的，不是最后的 `948e400a3`（`948e400` 对该文件相对第一父没有任何改动）；
- `948e400a3` 的 `git show` 还显示 `packages/application/src/ports/configuration.ts` 有组合解决差异：分支的 `toolRefusals` 与 main 的 `importDuplicates` 被并排保留（369、372 行）。

好的一面是这两处都保留正确，没有丢字段；只是作者的说法与代码不一致，容易让复核漏掉 `configuration.ts` 这种非导入的冲突面。

证据（读代码证实）：

```ts
// packages/application/src/ports/configuration.ts:366-375
export interface RunPolicyConfiguration {
  readonly timeZone?: string;
  readonly approvalBodyPreviewCharacters?: number;
  readonly toolRefusals?: ToolRefusalConfiguration;
  readonly realEval?: RealEvalConfiguration;
  readonly museIntake?: MuseIntakeConfiguration;
  readonly importDuplicates?: ImportDuplicateConfiguration;
  readonly mcpRead?: McpReadConfiguration;
  readonly device?: DeviceConfiguration;
```

建议：把冲突清单改成“`3cda3206c`: http-composition；`948e400a3`: production-memory-control、service-main、memory-page，以及 configuration.ts 的字段并集”。

---

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 读代码证实：不会。本轮改动只涉及 agent-service 的网关/控制装配、control-center 的页面和 `configuration.ts` 的字段并集，没有改 `packages/prompt-catalog`、系统提示、工具定义或历史消息的组装。新增的唯一模型调用是导入判重的独立 Jev 请求（`memory-import-duplicate-decision.ts:22-65` 自建 `questions` + `input`），它不进入对话请求，也不复用对话的系统提示/工具/历史。因此“只在末尾追加、会变的值放最后一条消息”这条前缀规则没有被本次合入改变。未核实：没有运行缓存命中或请求体回归测试。

2. **会不会让同一段文字在不同请求里变成不同字节？** 读代码证实：对话请求不会。合入本身没有改任何请求序列化。被合入的导入判重请求会对 `existing`/`candidates` 调 `redactForExternalText`，并用每次调用新建的 `sequentialPlaceholderTag()` 生成占位符（`memory-import-duplicate-decision.ts:29、53、57`），同一段敏感文字在不同请求里可能得到不同编号的占位符；但这是独立的后台判重请求，不是有前缀缓存的对话请求，不影响请求开头。`memory.rules.snapshot` 里的 `generatedAt` 是既有字段，且只是网关查询结果，不是模型请求。推测：若未来把判重请求纳入缓存/去重键，需要重新考虑占位符稳定性。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 部分有。`ProductionImportDuplicateChecker` 单测、`applyImportDuplicates` 单测、`BuiltInActionRulesSection` 单测都存在；但**装配层没有检查**：没有任何用例经 `createProductionHttpComposition` 传入 `importDuplicates` 并断言 checker 被调用，也没有断言 MemoryPage 同时渲染两个规则区。因此意见 1 的漏传不会让任何现有正向或反向用例失败。详见意见 2。

4. **每个产生/修改的值，每个使用端都能接受吗？** 逐个核对：
   - `actionRules`：`service-main` 产生 → `ProductionHttpCompositionOptions.memory.actionRules` 声明（238 行）→ 转发给 `ProductionMemoryControl`（1194 行）→ `#rules`/`execute` 使用；两端一致，OK。
   - `importDuplicates`：`service-main` 产生 → HTTP 组合的 `memory` 类型**不声明**、构造**不转发** → `ProductionMemoryControl` 的 `options.importDuplicates` 永远 `undefined`，查询全 `skipped`。两端不一致，见意见 1。
   - `builtIn`（`memory.rules.snapshot`）：服务端无论 `actionRules` 是否存在都给出数组（`production-memory-control.ts:908`），契约 schema 要求该字段（`contracts-v2.ts:2043-2052`），网页设置 `builtInRules`（`memory.ts:161-166`）；两端一致，OK。
   - `ask_first` / `allow_directly`：契约 `OWNER_RULE_ACTIONS` 扩展（`contracts-v2.ts:2007-2013`）、网页 `OwnerRuleAction` 扩展、服务端 `execute` 专门分支（`production-memory-control.ts:1750-1762`）并校验目标规则；两端一致，OK。
   - `files-control` / `device-control` / `login-devices` 的导入和操作清单：导入齐全、`routeOptions` 里对应 operations 都已展开、控制类都已实例化；无重复声明，OK。
   - `toolRefusals` / `importDuplicates` 配置字段：`configuration.ts` 两字段都在，`service-main` 分别用于 run composition 和 checker 工厂；字段本身 OK，但后者下游断链，见意见 1。

   这正是 I-73 的同类问题：只看“值被传出去了”不够，要看中间层是否真的接受并继续传给使用端。
