## 发现的问题（按严重度）

### 1. 中：有分类覆盖时，“现在的点”按分类门槛算，但曲线、表格、建议仍按单一全局门槛算，报告数字自相矛盾
- 文件:行：`packages/calibration/src/thresholds.ts:353-372`、`packages/calibration/src/thresholds.ts:515`；测试见 `test/integration/threshold-suggestion.test.ts:306-324`
- 【读代码证实】
- 问题：`currentPoint` 改成了 `livePoint`（每条样本用自己的 `currentThreshold`），但 `curve`、`table`、`suggestThreshold` 仍调用 `curvePoint`，对所有样本使用同一个全局门槛。分类有覆盖时，报告会出现：
  - “现在的门槛下：漏报 6 条”，而同一张表里当前默认门槛那一行是 0 条漏报；
  - “建议门槛 850（现在 850）”，同时又列出 6 条重跑会改变结果。若只是保持默认 850、分类覆盖 950 仍在，这 6 条实际上不会改变。
- 证据：
  ```ts
  const candidates = thresholdCandidates(samples, gate.scoreMax, current);
  const curve = candidates.map((threshold) => curvePoint(samples, threshold, required));
  ...
  currentPoint: livePoint(samples, current, required),
  ...
  .map((threshold) => curvePoint(samples, threshold, required)),
  ```
  ```ts
  `**漏一条按多扰 ${ratios} 次算：建议门槛 ${suggestion.threshold}**（现在 ${segment.current}）。...
  ```
  新测试甚至固定了“建议 850、当前 850、6 条 flips”的组合：
  ```ts
  expect(overall?.threshold).toBe(850);
  expect(overall?.flips.map((flip) => flip.id).sort()).toEqual(["h0", ..., "h5"]);
  ```
- 建议：总体段在有分类覆盖时，要么让“候选门槛”只替换没有覆盖的分类（after 也按 `thresholdOf` 计算），要么不要给单一全局建议，只输出各分类建议；同时补测试断言“currentPoint 等于表格中当前门槛那一行”，以及“flips 与真正应用该改动的结果一致”。

### 2. 低：新增的“服务在 849/850 边界从登记表取门槛”测试不是反向用例
- 文件:行：`packages/application/test/tentative-memory-capture.unit.test.ts:163-170`；旧实现见 `852e9e3a` 的 `automatic-memory-service.ts`（`this.options.automaticConfidencePermille ?? 850`）
- 【读代码证实】
- 问题：测试从 `MEMORY_AUTO_COMMIT_GATE.defaultThreshold` 取值（当前 850），而旧代码硬编码也是 850。因此把服务改回 `?? 850`，这条测试仍然通过，无法证明“从登记表取门槛”。
- 证据：
  ```ts
  const at = MEMORY_AUTO_COMMIT_GATE.defaultThreshold;
  const below = await capture([candidate({ confidencePermille: at - 1 })]);
  ...
  const onLine = await capture([candidate({ confidencePermille: at })]);
  ```
- 建议：增加能区分实现的用例，例如直接测试 `thresholdFor(gate, category)` 的分类覆盖，或让测试使用一个带 `byCategory` 覆盖的门槛配置并驱动服务；否则这条测试只能防止未来默认值被改后不一致，不能作为本次重构的反向门槛。

### 3. 低（推测/未来扩展）：SQL 去掉了 `COALESCE(outcome, verdict)`，对非 memory 类别会读空
- 文件:行：`packages/calibration/src/thresholds.ts:432-442`；数据库约束见 `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:45-50`
- 【推测】
- 问题：当前只登记了 `memory_candidate`，该类别 `outcome` 必填，所以现在不触发。但如果以后给 `proactive` 等类别加门槛，`proactive` 行是 `outcome IS NULL`、结果放在 `verdict`；新 SQL 只选 `outcome`，这些行会全部落入 `missingScore`。
- 证据：
  ```sql
  CHECK ((kind = 'proactive') = (verdict IS NOT NULL)),
  CHECK ((kind = 'proactive') = (outcome IS NULL)),
  ```
  ```ts
  return `SELECT id, kind, outcome, reason_code AS reasonCode,
  ```
- 建议：恢复 `COALESCE(outcome, verdict) AS outcome`，或显式同时选出 `verdict` 并在 `ThresholdDecisionRow` 里处理。

### 4. 低：分母说明没有提到 `kept_tentative` 已被排除
- 文件:行：`packages/calibration/src/thresholds.ts:554`；实际排除逻辑在 `133-136`，跳过说明在 `563-565`
- 【读代码证实】
- 问题：分母实际排除了 `ambiguousReasons`（`kept_tentative`），但说明只写“已评价、由门槛决定、有分数、评价和结果对得上”。按字面，一条已评价、有分数、结果对得上的 `kept_tentative` 似乎应计入，实际却不计入。
- 证据：
  ```ts
  "两者都除以纳入统计的已评价条数（已评价、由门槛决定、有分数、评价和结果对得上）。",
  ```
  ```ts
  if (gate.ambiguousReasons.includes(row.reasonCode)) {
    ambiguous += 1;
    continue;
  }
  ```
- 建议：在括号里补“且不属于暂存/ambiguousReasons”，或把“低于门槛但暂存”明确列为第四类排除项。

### 5. 低：`ambiguous` 先于“未评价”判断，未评价的暂存记录也被套上“评价只说明……”的解释
- 文件:行：`packages/calibration/src/thresholds.ts:133-143`、`563-564`
- 【读代码证实】
- 问题：`kept_tentative` 的检查在 `ownerRating === null` 之前，因此未评价的暂存记录计入 `ambiguous`，不计入 `unrated`；报告却写成“低于门槛但暂存 N 条（评价只说明该不该留下……）”，对未评价记录并不成立。
- 证据：
  ```ts
  if (gate.ambiguousReasons.includes(row.reasonCode)) {
    ambiguous += 1;
    continue;
  }
  if (!gate.gatedReasons.includes(row.reasonCode)) { ... }
  if (row.ownerRating === null) { unrated += 1; continue; }
  ```
- 建议：先判断 `ownerRating === null`，或在 `ambiguous` 里拆出“未评价的暂存”，避免报告解释与数据不符。

### 6. 低：服务仍可被 `automaticConfidencePermille` 覆盖，报告与“登记表是唯一来源”不完全一致
- 文件:行：`packages/application/src/services/automatic-memory-service.ts:168-169`
- 【读代码证实；生产影响为推测】
- 问题：服务实际取 `automaticConfidencePermille ?? thresholdFor(...)`，报告只按 `thresholdFor`/`byCategory` 计算。仓库里目前只有测试设置 `automaticConfidencePermille: 850`，与默认相同；一旦生产配置成别的值，报告里的“现在的门槛”就不再是服务真正使用的门槛。
- 证据：
  ```ts
  (this.options.automaticConfidencePermille ??
    thresholdFor(MEMORY_AUTO_COMMIT_GATE, candidate.attributes?.category ?? null))
  ```
- 建议：去掉该覆盖项，或把它纳入 `ThresholdGate`/报告输入，确保“单一来源”名实相符。

## 侧重检查

- 错误路径：参数缺值、未知参数、`--end` 无 `--days`、显式 owner/agent 不存在、没有唯一 scope、`thresholdRowsSql` 的非法 `kindCount` 都有显式报错；只读连接有 `readonly: true` 和 `fileMustExist: true`。结论：主要错误路径覆盖合理。
- 不可信/不合规输入：SQL 只拼接占位符数量，kind 值走绑定参数；`score` 校验了有限值和 0..scoreMax；`rating/outcome` 对不上会单独计数；`category` 用 `Object.hasOwn` 避免原型链键。结论：未发现注入或越界路径。唯一小点是报告直接把数据库里的 `id` 写进 Markdown，但该 id 由内部生成，风险低。
- 资源耗尽：查询范围已收窄到登记门槛的 kind；候选值数量随样本线性增长；`--days` 被 `resolveWindow` 限制在 1..366。结论：没有明显放大风险。
- 不可撤销操作：报告脚本只读、事务内读取、不改任何门槛；应用侧改动仍走原有记忆提交路径，没有新增删除/覆盖操作。结论：无新增不可撤销操作。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md:27-29` 和 `84-85` 要求固定内容在前、会变内容只在最后一条消息；本次没有改提示词、工具、历史或遮盖，且 `thresholdFor` 当前结果仍是 850，与旧硬编码一致。ADR 0179 对 `kept_tentative` 的语义与本次“暂存不计入曲线”的说明一致。未找到专门描述“门槛建议”报告的文档，因此是否有文档遗漏要求「未核实」。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动只在 `packages/calibration`、只读报告脚本和 `AutomaticMemoryService` 的门槛取值；没有修改系统提示、工具定义、历史消息或遮盖逻辑。当前 `thresholdFor(MEMORY_AUTO_COMMIT_GATE, ...)` 的默认值仍是 850，和旧硬编码 850 相同，所以也不改变已存记忆的生成行为。发给模型的内容仍然只在末尾追加，本次没有把任何每轮变化的值塞进系统提示或历史。

2. **不会让同一段文字在不同请求里变成不同的字节。** 本次改动不生成模型请求文本。报告本身的顺序也基本固定：SQL `ORDER BY checked_at, id`，候选门槛用 `Set` 后按数值排序，分类用 `Object.keys(...).sort()`，kind 列表也排序。唯一可见的非确定性是既有 `ungatedKinds` 用了 `localeCompare`，不同 locale 下报告行序可能不同；这只影响报告，不影响模型请求。

3. **有自动检查，但不是每条改动都有真正的反向用例。** `kept_tentative` 排除、分类 `currentPoint`/`replay`、显式 scope 不存在、参数解析这几条在 `852e9e3a` 的旧实现上会失败，是有效反向用例。但“服务从登记表取门槛”的测试在旧硬编码 850 上也会通过；SQL 只读登记 kind 的改动没有独立测试（即使改回读取全部 kind，`gateSamples` 仍会按 kind 过滤，测试不会失败）；有分类覆盖时的标题文本也没有测试。

4. **当前生产路径上的新增值两端基本对得上。** `ambiguousReasons` 里的 `kept_tentative` 与服务实际写出的 reason code 一致；`GateAnalysis.ambiguous` 被报告消费；`thresholdRowsSql` 的 kind 来自 `THRESHOLD_GATES`，参数顺序为 `owner/agent/start/end/kind...`，校验了 `kindCount`；`thresholdCandidates` 新增的 `current` 参数所有调用点已更新；参数解析保留第一个 `=` 后的完整值，`--db=/tmp/a=b.sqlite` 能正确通过。仍有两处不一致：非 memory 类别的 `verdict` 未处理（见问题 3），以及 `automaticConfidencePermille` 可绕过登记门槛（见问题 6）。
