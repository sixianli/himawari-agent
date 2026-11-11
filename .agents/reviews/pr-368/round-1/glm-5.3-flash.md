改用文件工具继续核查。
# 复核报告：P4-4 门槛建议值（852e9e3a）

## 读代码证实的问题（按严重度从高到低）

### 1.（中）「门槛单一来源」的守门测试实际守不住
- 文件：test/integration/threshold-suggestion.test.ts:259-262
- 问题：名为 "keeps the live auto-commit threshold in one place" 的测试只断言常量，不验证生产代码真的在用这个常量。
- 证据：
  - 测试只有 `expect(MEMORY_AUTO_COMMIT_GATE.defaultThreshold).toBe(850)` 两行；
  - 生产接线 apps/agent-service/src/production-memory-capture.ts:562 构造服务时**不设** `automaticConfidencePermille`，走的是被改动的那行 fallback（automatic-memory-service.ts:168-169）；
  - 唯一显式设 850 的测试 test/integration/automatic-memory-golden.test.ts:329 恰好**绕过**了新代码。
- 后果：若有人把服务改回硬编码 850（或 849/900），全部测试仍然全绿。单元测试（packages/application/test/tentative-memory-capture.unit.test.ts:19 用 700<850→tentative）只能拦住「门槛降到 ≤700」这类错误。
- 建议：加一条不加 `automaticConfidencePermille` 的边界用例（849→tentative、850→auto），断言值取自 `thresholdFor(MEMORY_AUTO_COMMIT_GATE, null)`。

### 2.（中）byCategory 按分类覆盖逻辑零测试覆盖，且「登记表」其实是代码常量
- 文件：packages/calibration/src/thresholds.ts:26、38、43-47、365-374
- 问题：P4-7 要依赖的 `byCategory` 覆盖、`thresholdFor` 的分类分支、`analyzeGate` 的分类分段、replay 里按分类的 `currentThreshold`（thresholds.ts:159、237），本次**没有任何测试**触碰到（fixture 的 byCategory 恒为空 `{}`）。另外所谓「门槛登记表」就是 `MEMORY_AUTO_COMMIT_GATE` 这个冻结对象字面量，不是可配置存储——P4-7 要改代码才能加覆盖。
- 证据：thresholds.ts:38 `byCategory: Object.freeze({})`；thresholds.ts:365 分类段只遍历 `Object.keys(gate.byCategory)`，空则一段都不画。
- 建议：补一条非空 byCategory 的用例（至少覆盖 thresholdFor 和分类段的建议值/重跑），或在 P4-7 的任务里明确登记这条缺口。

### 3.（低）discarded+unneeded 这组「正确的沉默」被当「对不上」剔除，抬高两个率
- 文件：packages/calibration/src/thresholds.ts:104-107
- 证据：`sampleTruth` 只认 useful（双向）、kept+unneeded、discarded+missed；discarded+unneeded（没存、主人也说不需要——决策正确）返回 null，进 `mismatchedRating` 剔除。
- 后果：分母剔掉了正确样本，展示的误扰率/漏报率整体偏高；所有门槛点同等抬高，曲线比较仍公平，但绝对数失真。
- 说明：这与作者说法一致（「其余组合计为对不上」），是**口径设计**问题而非说法与代码不符。
- 建议：要么把该组合计入「正确沉默」留在分母，要么在报告里写明口径。

### 4.（低）门槛类别清单三处重复，漂移会静默兜底
- 证据：THRESHOLD_CATEGORIES（thresholds.ts:3-14）、MEMORY_CATEGORIES（packages/application/src/ports/memory-projection.ts:13-24）、DB CHECK（packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:29-35）各一份；`thresholdFor` 对不在表里的分类静默回退 defaultThreshold（thresholds.ts:44-46），无报警。
- 建议：由 P4-7 收敛为单一来源或加一致性检查。

### 5.（低）同代价且同距离时的平局未定义方向
- 文件：thresholds.ts:277-282：代价相等取离现行门槛近的；两者都相等（如 849 与 851 对 850）时保留升序里第一个（更低的），确定性但任意。「同代价取最近」的说法成立，仅此边角未声明。

### 6.（信息）`formatRate` 的样本不足分支在当前接线下不可达
- thresholds.ts:438-439 的 `successes/samples` 分支只在 `samples < required` 时触发，而所有打印率的地方都发生在 `enough === true` 之后（thresholds.ts:446-458）。死分支，非缺陷。

## 侧重检查（普通流程走查）

**流程 A：Andy 跑报告** `npm run report:thresholds --db=…`（package.json:99）→ thresholds.mjs `parseArguments` → 无 owner/agent 时 `findScopes`（calibration.mjs:11-15，多 scope 报错 thresholds.mjs:66-71）→ 事务内 `assertTimestampFormat` + 按 THRESHOLD_SQL 读 rows/kindCounts（只读打开，thresholds.mjs:55-58）→ `analyzeGate`/`gateSamples` 过滤 → `thresholdReport` 输出。
- **有测试**：缺参/未知参、样本不足不给数字、完整曲线+建议+重跑、usefulSilenced 清单、直跑 node、常量。
- **无测试覆盖的路径**：`--days`/`--end` 窗口解析、`--owner`/`--agent` 显式指定、多 scope 的 THRESHOLD_SCOPE 报错、`--miss-cost` 的解析错误分支（thresholds.mjs:38-46）、byCategory 分类段（见问题 2）、`formatRate` 空分支（不可达）。
- SQL 列与 schema 逐列核对过（0069_decision_ledger.sql：kind/outcome/verdict/reason_code/owner_rating/rated_at/category/confidence_permille/checked_at 全存在；CHECK 允许 proactive 的 outcome 为 NULL，与 `COALESCE(outcome, verdict)` 吻合）。
- 写入端对上：automatic-memory-service.ts:542-543 由 `candidateLedger` 写 category/confidence_permille，来源是 `candidate.attributes?.category`（类型 MemoryCategory，与 THRESHOLD_CATEGORIES 逐项一致，见问题 4）。

**流程 B：生产自动存入** `processCommittedRun` → 敏感/显式分支（不动）→ 门槛比较（automatic-memory-service.ts:165-170）。行为逐字节不变：byCategory 空 → `thresholdFor` 恒返 850，与旧 `?? 850` 等价。该行由 tentative-memory-capture.unit.test.ts 隐式覆盖（700→tentative、空 quote→discard），golden 测试绕过（见问题 1）。

## 必答问题

1. **不会改变请求开头。**改动三处：只读报告脚本（不在请求路径）、calibration 包纯新增导出、服务的门槛取值来源。读代码证实 `thresholdFor(MEMORY_AUTO_COMMIT_GATE, category)` 在 byCategory 为空时恒等于 850，与改动前 `?? 850` 逐字节同行为；没有触碰系统提示、工具定义、历史、遮盖，也没有引入任何每轮变化的值。满足「只追加」规则。
2. **不会。**唯一生产改动依赖候选自身的 `attributes.category`（候选自己的属性，不依赖前后文），确定性；报告输出全部经排序（thresholds.ts:183、341-342、399）或按确定性插入序（Map），无时间、无无序集合进内容。将来 P4-7 设 byCategory 后门槛仍只取决于该候选自己的分类，遮盖不受影响。
3. **有自动检查，反向用例部分成立。**test/integration/threshold-suggestion.test.ts 在 integration 项目内（ci/policy.json:159）。真的会失败的反向用例：宽度断言（114-115 行 `worstCaseIntervalWidth(n-1) > 0.1`）、样本不足时不出现「建议门槛」（136 行）、错误参数（264-268 行）。**缺口**：服务端接线无反向用例（问题 1）、byCategory 全无覆盖（问题 2）。
4. **逐值核对均通过，两处登记在案。**`report:thresholds`→脚本存在；THRESHOLD_SQL 全部列存在于 0069 迁移且与写入端（candidateLedger）对上；MEMORY_AUTO_COMMIT_GATE 被 application 消费、依赖已声明（application/package.json:22）；「没有分数的类别正常列出」由 schema CHECK（0069:41-44 强制非 memory_candidate 无分数）+ `ungatedKinds` 保证，测试覆盖（223-226 行）。**未核实**：本机未运行，`node 直跑 .mjs → import @himawari-agent/calibration（导出 .ts）`的类型剥离机制未实测，但与既有 report.mjs 同机制且有 "runs as a plain node program" 用例。风险登记：byCategory 覆盖端无任何消费测试（P4-7 前），类别清单三处重复（问题 4）。

**作者说法核对**：九条说法中「已评价条数不到 N 只输出样本不足」措辞略宽——实际计数还剔除不由门槛决定、没分数、评价对不上的条目，但代码里的输出措辞（测试 134 行）是精确的，其余八条全部与代码一致。
