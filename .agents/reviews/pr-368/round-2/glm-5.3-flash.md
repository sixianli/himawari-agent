# 复核报告：P4-4 第 2 轮（852e9e3a → 5a0605cb）

## 侧重检查

走的流程：`npm run report:thresholds -- --db=x` 入口 → `parseArguments`（thresholds.mjs:23-41）→ `run`（:53）→ `findScopes` + scope 校验（:67-81）→ `assertTimestampFormat` → `thresholdRowsSql(kinds.length)` 查询（:82-90）→ `analyzeGate` → `gateSamples` → `analyzeSegment`（candidates/curve/livePoint/suggestThreshold/replay）→ `thresholdReport` → `output.write`。测试侧读了 `test/integration/threshold-suggestion.test.ts` 全文和 `packages/application/test/tentative-memory-capture.unit.test.ts` 的边界用例。

结论：主流程端到端有覆盖（含 `runs as a plain node program` 真起 node 进程）；三个没有测试覆盖的代码路径：
1. thresholds 脚本的 `--days`/`--end` 窗口查询 happy path（测试只覆盖了 THRESHOLD_WINDOW 报错和默认全部时间的路径）；
2. `mixedCurrent=true` 时的报告标题渲染（thresholds.ts:482-485 的「默认门槛 X，有覆盖的分类按各自的门槛」字符串没有任何断言；带 byCategory 的新测试走的是 `analyzeGate` 直调，不经 `segmentLines`）;
3. `parseRatios` 的非法输入分支（旧问题，非本轮引入）。

## 发现的问题（按严重度）

**1.（低）`automaticConfidencePermille` 与报告的门槛不同源，报告可能说错「现在的门槛」**
- 文件：packages/application/src/services/automatic-memory-service.ts:165-169
- 证据：`candidate.confidencePermille < (this.options.automaticConfidencePermille ?? thresholdFor(MEMORY_AUTO_COMMIT_GATE, ...))`，而报告（thresholds.ts:386-403）只用登记表的 `defaultThreshold`/`byCategory`。本轮新加的边界测试（application test:162-171）也只验证登记表路径。grep 全仓库，该覆盖只在 `automatic-memory-golden.test.ts:329` 被设为 850（与默认相同），生产没有非 850 的入口——所以现在是潜在问题，不是现行 bug。
- 建议：要么删掉这个覆盖参数，要么在报告/检查里校验两者一致（类似 I-73 的教训：两端各一个值，没人对账）。

**2.（低，已声明的取舍，提示其代价）kept_tentative 连「不该存」的评价也整体丢弃**
- 文件：packages/calibration/src/thresholds.ts:133-136
- 证据：`if (gate.ambiguousReasons.includes(row.reasonCode)) { ambiguous += 1; continue; }` 在读 rating 之前就跳过。owner 对暂存记忆评「不该存」（memory_kept 组的合法评价，index.ts:40）本来是「这条低分存错了」的直接证据，现在只剩 ambiguous 总数一个痕迹，报告里不区分评价。作者的理由（评价说明该不该留、不说明该不该存）对「不该存」这一档并不完全成立——但这是显式写进报告文案的设计决定，不算与代码矛盾。
- 建议：至少在报告的 ambiguous 一行里分评「不该存」的条数，让这个信号可见。

**3.（核实为安全，但值得记录）SQL 去掉了 `COALESCE(outcome, verdict)`**
- 文件：packages/calibration/src/thresholds.ts:436
- 证据：0069_decision_ledger.sql:46 `CHECK ((kind = 'proactive') = (verdict IS NOT NULL))`，且新查询用 `kind IN` 只取 memory_candidate，verdict 恒为 NULL，COALESCE 本来就是恒等。安全。

## 作者说法逐条核对（读代码证实）

全部成立，未发现说法与代码不一致：
- 暂存记录不计入曲线、单独计数、报告写明原因：thresholds.ts:133-136、170、408、563-565 ✓
- livePoint 按每条记录自己的门槛、与 replay 的 before 一致：thresholds.ts:225-231 与 :263（replay 的 `before = sample.score >= sample.currentThreshold`）一致 ✓；默认门槛总在候选里：:186 ✓；mixedCurrent 标题：:482-485 ✓
- SQL 只读登记了门槛的 kind：thresholds.ts:432-442，调用端 thresholds.mjs:85-87 参数顺序（owner, agent, start, end, kinds）与占位符匹配 ✓
- 参数按第一个等号切分、缺值报 THRESHOLD_OPTION_VALUE：thresholds.mjs:27-31 ✓；owner/agent 不存在报错：:69-74 ✓
- 分母说明改为纳入统计的条数：thresholds.ts:554，与 gateSamples 的排除顺序一致 ✓
- 五组补测试都存在且与实现相符 ✓

## 必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。diff 全量读过（git diff 已看），只碰 `packages/calibration`、`scripts/calibration-report`、两个测试文件和 `.agents/reviews` 复核记录，不碰系统提示、工具定义、历史、遮盖，也不碰任何组装模型请求的代码。不存在「每轮变的值」的问题——这是离线报告脚本，不进模型请求。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。报告输出不是模型请求；即便只看报告本身的确定性：SQL `ORDER BY checked_at, id`（thresholds.ts:441）、kinds 排序（thresholds.mjs:85）、`thresholdCandidates` 返回前排序（thresholds.ts:192）、`Object.keys(byCategory)` 排序（:394）、suggestions 分组按 missCostRatios 固定顺序（:504-509）。时间只进窗口参数，不进输出文本。没有依赖前后文的遮盖、没有无序集合直接序列化。

**3. 有没有对应的自动检查，反向用例会不会真失败？**
有，且我逐个推断过：`kept_tentative` 计入测试——旧代码把它放在 gatedReasons（旧 gatedReasons 见 diff 删除行），50 条会进样本并把 flips 打非空，断言必失败；mixed-current 测试期望 `misses: 6`，旧 `currentPoint` 用统一门槛 850 会算出 0，必失败；scope 和参数解析用例旧代码不报这些错，必失败。服务 849/850 边界测试是回归守卫：服务在上一轮（852e9e3a）已经改用 `thresholdFor`，旧代码也能通过它——它防的是将来有人把 850 写回服务里，方向正确。我未运行测试（环境限制），失败推断基于逐行读旧代码。

**4. 每个产生/使用的新值，两端都核对了吗？**
逐对核对完毕：`ambiguousReasons`（产：thresholds.ts:37；用：:133，唯一的 gate 是 MEMORY_AUTO_COMMIT_GATE，接口新增字段无别的实现）；`ambiguous` 计数（产：:170；用：:408 → :563）；`thresholdRowsSql(kindCount)`（产：:432，有 RangeError 守卫；用：thresholds.mjs:87，占位符数量与 kinds 长度一致，全是 `?` 无注入面）；`THRESHOLD_SQL.rows` 删除后 grep 无残留消费者；`kept_tentative` 分类与 ADR 0179:54 和服务实际写入（automatic-memory-service.ts:183）一致，schema 的 reason_code 只限长度不限枚举，不会插不进去。发现的两端不一致就是上面第 1 条（服务覆盖参数与登记表双源），这是本轮改动之外预存的缝隙，但本轮「服务从登记表取门槛」的说法让它显得已完全同源，实际还差这一个参数。
