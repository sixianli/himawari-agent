# 复核结论（5823448，相对 5a0605cb 增量 + 基线 aa1b0b0 全量）

## 按严重度排列

**1. 低 · scripts/calibration-report/thresholds.mjs:56-58 / test/integration/threshold-suggestion.test.ts**
`--days`/`--end` 的成功路径在本脚本没有测试：`rejects bad arguments` 只测了参数校验报错（test/integration/threshold-suggestion.test.ts:371），`run` 的全部用例都不带 `--days`。`resolveWindow` 本身可能由 calibration-report.test.ts 覆盖（未核实）。另：多 scope 时 `THRESHOLD_SCOPE：…请用 --owner 和 --agent 指定`（thresholds.mjs:76-79）这个分支没有用例（测试只覆盖了“指定 scope 不存在”，:353-362）。
建议：补一条带 `--days` 的端到端用例和一条多 scope 报错用例。

**2. 低 · packages/calibration/src/thresholds.ts:600**
`ambiguousRatings` 输出排序用 `localeCompare`。规则第 10 条（.claude/rules/prompt-prefix.md:51）要求顺序固定、不依赖环境。键受 DB CHECK 限制只能是 `useful/unneeded/missed`（migrations/0069_decision_ledger.sql:27），ASCII 三串在所有 locale 下排序一致，所以实际风险极低；`RATING_NAMES[rating] ?? rating` 的回退也因这个 CHECK 不可达。
建议：改用固定键序或 `<` 比较，把“理论上依赖 ICU”消掉。

**3. 信息 · packages/calibration/src/thresholds.ts:40,414-418,516**
pinned 规则在生产中目前不可达：唯一的 gate `MEMORY_AUTO_COMMIT_GATE.byCategory` 是空对象（:40），`Object.hasOwn` 恒假 → pinned 恒返回 null，`mixedCurrent` 恒 false，报告新标题文案（:516）在真实数据上永远不出现，只有测试里合成的 `{ ...gate, byCategory: { health: 950 } }`（threshold-suggestion.test.ts:296）能走到。这不是错误，但作者说“有分类覆盖时……”——现状没有任何分类覆盖；将来给 `byCategory` 填值时这段才生效。

**4. 信息 · packages/calibration/src/thresholds.ts:463**
`COALESCE(outcome, verdict)` 对本查询是无操作：0069 迁移的表级 CHECK 是 `(kind = 'proactive') = (verdict IS NOT NULL)` 且 `(kind = 'proactive') = (outcome IS NULL)`（0069_decision_ledger.sql:46-47），即 memory_candidate 行 verdict 恒 NULL、outcome 恒非 NULL。该写法与既有查询一致（packages/calibration/src/index.ts:629、packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:133），纯防御性，无风险。

**5. 信息 · 文档**
docs 与 ADR 0179 只写“门槛 850 不变”，未提及 `automaticConfidencePermille`（该选项本来只有测试在用），删除后无文档失配。P4-4 的门槛建议工具本身（`report:thresholds`）没有对应 ADR/文档条目（grep docs 无结果），若按仓库惯例需要补，标注为观察项。

## 侧重检查（普通流程走查）

流程：`npm run report:thresholds -- --db=x` → `parseArguments`（有测试）→ `--miss-cost` 解析（有测试）→ 窗口解析（**本脚本无成功用例**，见问题 1）→ `findScopes`/scope 校验（不存在/单 scope 有测试，**多 scope 分支无测试**）→ 只读打开 DB → `thresholdRowsSql`（COALESCE，见问题 4）→ `gateSamples`（unrated/ambiguous 拆分有测试且反向会失败：若 ambiguous 先于 unrated 判定或拆分丢失，`ambiguous`/`ambiguousRatings`/`unrated` 三处断言都会挂）→ `analyzeSegment`（pinned 贯穿 curve/table/suggestions/currentPoint，测试断言表内 850 行与 `currentPoint` 相同、`flips` 为空；若去掉 pinned，health 样本 900≥850 会 act，misses 6→0、flips 非空，测试失败，反向用例真实有效）→ `thresholdReport` 文案（有 `toContain` 断言）。另一条流程：`AutomaticMemoryService` 门槛判定 → 单元测试新增了 at-1/at 边界用例（tentative-memory-capture.unit.test.ts:162-171），能抓住硬编码或换默认；golden 测试删掉 850 选项后走登记表路径。无覆盖的只有问题 1 列的两个分支。

## 必答问题

1. **不会改变请求开头。**改动不触碰任何组装模型请求的代码：校准报告是离线只读 CLI（thresholds.mjs:60-63 `readonly: true`）；`AutomaticMemoryService` 删除的选项生产从未设置（全仓库 grep 零引用），且默认 `thresholdFor(MEMORY_AUTO_COMMIT_GATE, category)` 在 `byCategory` 为空时恒返回 850，与 golden 测试里原设的 850 逐值相同 → 产生的 committed/tentative 记忆集合不变，注入请求的内容不变。发给模型的内容仍是只追加。
2. **基本不会。**报告所有可变集合都显式排序：候选值 Set→排序（thresholds.ts:202）、表行排序（:391-393）、分类段按排序后的 keys（:419）、`ambiguousRatings` 排序输出（:600，唯一瑕疵是 localeCompare，见问题 2）。报告无时间字段、无遮盖依赖。模型请求路径无新增值。
3. **有，且反向用例会失败。**pinned：threshold-suggestion.test.ts:295-351（无 pinned 时 table 850 行 misses 0≠6、overall flips 非空，均断言失败）；ambiguous/unrated 拆分：:284-292；门槛边界：tentative-memory-capture.unit.test.ts:162-171；golden 测试删选项后由快照约束回归。
4. **逐值核对均通过。**`ambiguousRatings`：产生于 gateSamples:144，仅消费于报告 :597-602（键有 DB CHECK 兜底、显示有回退）；`PinnedThreshold`：定义 ：227，curvePoint/replay/suggestThreshold/analyzeSegment/analyzeGate 全部消费，analyzeSegment 内 curve/table/suggestions/currentPoint 四处无遗漏；删除 `automaticConfidencePermille`：零残留；`COALESCE(outcome, verdict)`：消费端 `row.outcome` 类型 `string|null`（:80）匹配，schema 保证 verdict 不混入 memory_candidate；新 npm script 与 `thresholds.d.mts` 签名一致，`calibration.d.mts` 的 `export *` 覆盖新导出。

作者五条说法全部与代码一致，未发现说法与代码不符之处。
