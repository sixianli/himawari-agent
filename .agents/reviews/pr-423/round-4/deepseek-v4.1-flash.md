## 结论

第 4 轮增量（087cb03bd..768ece89）与作者说法基本一致：单号抽取的 1/10 预算上限、`#summariesOff`、ADR 0180 措辞、ADR 0249 补充、两条测试名称/新增反向用例都能在代码里对上。未发现高或中严重度缺陷；只有下面几处低严重度的测试/文档精度问题，另有一条预算是“推测影响”的边界。

## 发现（按严重度）

### 低-1：`#summariesOff` 的“限额关闭”分支没有任何自动用例，且当前生产不走这条分支（读代码证实）

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:1513-1521`；`test/integration/proactive-mail-check.test.ts:3621-3624`
- 问题：新逻辑只有在 `recentSummaries` 已配置、但 `days/perCheck/characters` 被设成小于 1 时才和旧条件不同。仓库里唯一设置 `summaryLimits` 的用例是 `characters: 25`（仍开启）；`apps/agent-service/src` 没有给 `ProductionProactive` 传 `summaryLimits`。也就是说这条修复在生产今天的配置下等价于旧的 `recentSummaries === undefined` 判断，而且没有反向用例钉住“限额关闭时不再预留摘要占位”。
- 证据：

```ts
1513:   #summariesOff(): boolean {
1514:     const limits = { ...DEFAULT_PROACTIVE_SUMMARY_LIMITS, ...this.#options.summaryLimits };
1515:     return (
1516:       this.#options.recentSummaries === undefined ||
1517:       limits.days < 1 ||
1518:       limits.perCheck < 1 ||
1519:       limits.characters < 1
1520:     );
1521:   }
```

```ts
3623:         summaryLimits: { characters: 25 },
```

  `git show --stat 1d3474017` 只改了服务文件和复核记录，没有改测试。若有人把 `#summariesOff` 的 `limits.* < 1` 分支删掉，现有测试不会失败。
- 建议：加一条反向用例，`recentSummaries` 已配置、`summaryLimits: { characters: 0 }`（或 `perCheck: 0`），把 `dailyCostMicros` 调到“带摘要占位就判不了、去掉占位就能判”的边界，断言判断照常发生且账本 `summaryRead` 为 `off`、没有摘要调用。

### 低-2：新增的 1/10 反向用例标题说“spends”，实际只断言抽取次数（读代码证实）

- 文件：`test/integration/proactive-mail-check.test.ts:2706-2722`；`test/integration/proactive-mail-check.test.ts:363-368`；`packages/application/src/services/proactive-mail-check-service.ts:691-693`
- 问题：用例只断言 `referencePrompts` 长度为 1。该用例没有 `scriptReferences`，参考抽取走的是兜底模型，成本为 0；因此它验证的是“按预估费用只发一次抽取”，不是“实际花费不超过十分之一”。标题与作者上一轮“用例名只声称真测到的内容”的原则略有出入。
- 证据：

```ts
2707:       const h = await harness({ dailyCostMicros: 1_000, batchSize: 1 });
...
2721:       expect(h.referencePrompts).toHaveLength(1);
```

```ts
366:               referenceQueue.shift() ??
367:               new ScriptedModelPort([descriptor], referenceEvents('{"items":[]}', 0)),
```

```ts
691:       const estimate = this.#options.limits.estimateCostMicros(prompt);
692:       if (planned + estimate > allowance) break;
693:       planned += estimate;
```

- 建议：把标题改成“plans at most a tenth…”之类，或在用例里给参考抽取设置非零 cost，并断言实际 `costMicros`/`planned` 不超过 `dailyCostMicros / 10`。不过该用例作为“去掉 allowance 两行会变成 3 次”的反向用例是有效的：参考调用成本为 0、`reserveMicros=100`，预算检查能放行 3 次，只有 allowance 会把它截到 1 次。

### 低-3（推测影响）：抽取预留没有包含 related/memories，`一批的预估费用` 不是严格上界

- 文件：`packages/application/src/services/proactive-mail-check-service.ts:916-949`、`966-979`、`983-1004`
- 问题：`referenceReserveMicros` 在 related 读取和记忆召回之前计算，传入的是 `new Map()` 和 `[]`；真正判断用的 `firstBatch` 会带 `relatedViews` 和 `batchMemories`。因此抽取阶段留给判断的“一批预估费用”只覆盖不带前情/记忆的那一版提示词。ADR 0249 第 85 行说“给判断留出一批的预估费用”，措辞上不是严格保证。
- 证据：

```ts
916:     const referenceReserveMicros =
...
925:                 new Map<string, RelatedView>(),
...
929:               [],
```

```ts
991:               this.#batchMemories(firstBatch, recalled.hits),
...
993:               relatedViews,
```

- 说明：这是第 1 轮引入的既有结构，不是本轮增量；本轮的 1/10 上限会显著缓解它。是否真的导致判断被 `capped_daily` 取决于前情数量和每日额度，我没有用真实数据验证，标为推测。建议若要收紧，可按 `relatedCharactersPerMail` / `perBatch` 给预留加上界，或把 ADR 的措辞改成“预留一个不含前情和记忆的判断批次”；并补一个“前情很大、额度刚好”的用例。

## 侧重检查

- 错误路径：allowance 触顶只是 `break`，`references` 缺少条目时 `#related` 用 `?? []` 兜底，不会抛错；抽取调用仍是原来的 `try {} catch {}`。`#summariesOff` 只影响预留大小，不改变 `#summaries` 的返回路径。未发现新增异常路径。
- 不可信输入：单号仍是模型输出，进入 `parseMailReferences`/`validMailReferences` 后要过形状、日期、逐字整串、每封最多 3 个等校验（本轮未改）；allowance 只使用提示词长度，攻击者能让抽取被跳过，但受 `bodyCharactersPerMail/perBatch` 限制，未发现注入或越权。
- 安全：没有新增外部调用、日志或秘密读取；ADR 0180 指向的 `packages/application/src/services/proactive-references.ts` 确实存在，`extractReferenceIds` 除 ADR 文字外已无代码引用。
- 资源耗尽：1/10 上限是收敛性的；迭代次数受候选数和 `perCheckMs/6` 信号限制；`dailyCostMicros` 配置校验为 1..100,000,000 整数，极小值只会让抽取被跳过，不会放大开销。
- 不可撤销操作：本轮没有。
- 文档/代码一致性：ADR 0180 第 41 行与 `gmail-related.ts` 的整串匹配、搜索后复核一致；ADR 0249 第 85 行与 `perCheckMs/6`、1/10 一致；测试名去掉 YYYY-MM-DD 是合理的——该集成用例里的 `2026-11-07` 并不在邮件的 subject/body/snippet 中，本来就不是在测日期形状（日期由 `proactive-references.unit.test.ts` 覆盖）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本轮没有改任何提示词文字、工具定义、历史消息或遮盖逻辑（增量只有预算判断、文档、测试）。参考抽取是一次性后台调用，提示词是固定的 `MAIL_REFERENCE_EXTRACTION.text` 加本批 JSON（`proactive-mail-check-service.ts:445-458`），没有对话历史。判断提示词仍是固定说明在前、资料在后、`now/timeZone/today` 在最后（`proactive-mail-check-service.ts:478-505`）。allowance 只会让本轮的某些抽取/前情不出现，属于当前请求末尾数据的差异，不是对已发前缀的改写；没有新增“每轮都变、却放在头部”的值。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会由本轮引入。allowance 只依赖 `dailyCostMicros`、`batchSize`、候选顺序和提示词长度，都是同一输入下的确定值；没有引入时间字段、无序集合或依赖后文的遮盖。跨检查时参考抽取次数可能因配置或邮件集合不同而变化，但那是输入数据变化，不是序列化不确定性，也不影响已发内容。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 1/10 有反向用例（`proactive-mail-check.test.ts:2706`），按预算算术，删掉 `692-693` 两行后该用例会做 3 次抽取而不是 1 次，确实会失败（未实际运行测试，属代码推算）。`#summariesOff` 的限额关闭分支没有对应用例（见低-1），这部分回归不会被自动发现；当前生产也没有传入 `summaryLimits`，所以该修复今天只对直接使用服务并覆盖限额的调用者生效。

4. **改动产生/修改的每个值，两端都能接受吗？** 本轮没有新增或修改任何持久化标识、字段、配置键、清单项或序列化格式。唯一新增的是内部常量 `REFERENCE_SHARE_DENOMINATOR = 10`，只在 `#references` 内使用；消费的 `dailyCostMicros` 来自 `strict-configuration.ts:1085` 的整数校验（1..100,000,000），两端类型/范围一致。`#summariesOff` 与 `#summaries` 使用同一组默认值和合并方式（`DEFAULT_PROACTIVE_SUMMARY_LIMITS` + `this.#options.summaryLimits`），不会出现“预留认为开启、实际 `#summaries` 却关闭”的不一致。
