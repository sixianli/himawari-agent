## 结论

未发现高严重度问题。本轮 5 条“作者的说法”与代码基本一致；主要问题集中在“全部分类”段的样本口径、模型给出的分类现在会影响生产门槛，以及几处测试没有真正覆盖到新分支。

## 问题（按严重度）

### [中] “全部分类”段算样本门槛时没有扣掉被分类覆盖钉住的样本

- **文件:行**：`packages/calibration/src/thresholds.ts:371`、`packages/calibration/src/thresholds.ts:414-417`
- **问题**：`overall` 的 `enough` 用的是全部样本，但带分类覆盖的样本被 `pinned` 固定为各自的当前门槛，完全不随“建议的默认门槛”变化。若样本几乎全在带覆盖的分类里，分段的默认门槛实际没有任何可调整样本，报告仍会给出“建议门槛 X”，并把所有样本算进置信区间。
- **证据**：
  ```ts
  const enough = samples.length >= required;   // thresholds.ts:371，用的是全部 samples
  ...
  (sample) =>
    sample.category !== null && Object.hasOwn(gate.byCategory, sample.category)
      ? sample.currentThreshold
      : null,                                   // thresholds.ts:414-417，覆盖分类被钉住
  ```
- **建议**：`overall` 单独计算“未被钉住”的样本数，用这个数判断 `enough`，并在标题/正文写明“默认门槛只由 N 条无分类覆盖的样本支撑”。如果该数为 0，就不要给默认门槛建议，直接说明“所有样本都受分类覆盖，默认门槛无数据”。

### [中·潜在] 生产门槛现在依赖模型给出的 category，分类覆盖配低后可被模型选择绕过

- **文件:行**：`packages/application/src/services/automatic-memory-service.ts:166-167`、`apps/agent-service/src/production-memory-capture.ts:357-361`
- **问题**：自动存入与否现在取决于 `candidate.attributes.category`，而这个 category 来自抽取模型的输出，只做了枚举校验，没有独立核实。将来只要某个分类的 `byCategory` 门槛低于默认门槛，模型（包括被提示注入影响的模型）就可以把低分候选标成该分类，从而绕过默认门槛。
- **证据**：
  ```ts
  candidate.confidencePermille <
    thresholdFor(MEMORY_AUTO_COMMIT_GATE, candidate.attributes?.category ?? null)
  // automatic-memory-service.ts:166-167

  const category = (
    typeof value["category"] === "string" && CATEGORIES.has(value["category"])
      ? value["category"]
      : "other"
  ) as MemoryCategory;
  // production-memory-capture.ts:357-361，category 直接来自模型 JSON
  ```
- **说明**：当前 `MEMORY_AUTO_COMMIT_GATE.byCategory` 是 `Object.freeze({})`（`thresholds.ts:40`），所以目前不可利用；这是随将来配置分类门槛而出现的信任边界问题。
- **建议**：分类门槛只允许“比默认更严格”，或对模型给出的分类再走一次可信判定；至少在注册 `byCategory` 时校验取值范围，并补一条“模型把低分候选标成低门槛分类”的反向用例。

### [低] 历史重跑的 “before” 用的是当前登记表门槛，不是决策当时生效的门槛

- **文件:行**：`packages/calibration/src/thresholds.ts:169`、`packages/calibration/src/thresholds.ts:278-280`
- **问题**：`ThresholdSample.currentThreshold` 在分析时由当前 `thresholdFor(gate, row.category)` 算出；`decision_ledger` 没有保存决策当时的门槛。现在默认门槛仍是 850，所以现有数据上没问题；但一旦按建议修改默认/分类门槛，旧记录会被按新门槛解释，“重跑”会报出错误的 before/after。
- **证据**：
  ```ts
  currentThreshold: thresholdFor(gate, row.category),   // thresholds.ts:169
  ...
  const before = sample.score >= sample.currentThreshold;  // thresholds.ts:278
  const after = sample.score >= (pinned(sample) ?? threshold);
  ```
- **建议**：在账本里记录本次决策使用的门槛（新列或 inputs 里的固定字段），或把 `before` 改成由 `outcome`/`reason_code` 直接推出来；如果两者都暂不做，至少在报告里写明“重跑只在门槛未改动时有效”。

### [低] 新逻辑的自动检查有缺口，部分反向用例并不能真正锁住本轮改动

- **文件:行**：`packages/application/test/tentative-memory-capture.unit.test.ts:163-171`、`test/integration/threshold-suggestion.test.ts:284-292`、`test/integration/threshold-suggestion.test.ts:326-350`
- **问题**：
  - 服务测试只用 `MEMORY_AUTO_COMMIT_GATE.defaultThreshold`，从未覆盖“分类覆盖”分支；而 `byCategory` 当前为空，`thresholdFor(..., category)` 的分类路径在测试里不可达。这个测试在删除选项前后都会通过（旧默认也是 850），不能反向证明“选项已删、分类门槛生效”。
  - `COALESCE(outcome, verdict)`（`thresholds.ts:463`）没有任何测试；当前唯一 gate 的 `memory_candidate` 由 schema 保证 `outcome` 非空，所以这条改动在当前数据上也是死路径。
  - 报告分母新增的“低于门槛但暂存的不算”（`thresholds.ts:587`）没有断言。
  - 带分类覆盖的测试只覆盖了“建议等于当前、零翻转”的情况，没有覆盖“非覆盖分类真的随建议翻转、覆盖分类不动”的混合场景。
- **证据**：
  ```ts
  const at = MEMORY_AUTO_COMMIT_GATE.defaultThreshold;   // 只测默认值
  const below = await capture([candidate({ confidencePermille: at - 1 })]);
  const onLine = await capture([candidate({ confidencePermille: at })]);
  ```
- **建议**：把门槛选择抽成可注入的纯函数，或给服务测试提供可控 gate；补 `thresholdFor` 分类覆盖的直接用例、`COALESCE` 的 outcome-null/verdict-non-null 行、分母文案断言，以及一个混合分类且建议产生非空 flips 的用例。

### [低] 三份分类清单各自维护，没有一致性检查

- **文件:行**：`packages/calibration/src/thresholds.ts:3-14`、`packages/application/src/ports/memory-projection.ts:13-24`、`packages/application/src/ports/decision-ledger.ts:56-67`
- **问题**：`THRESHOLD_CATEGORIES`、`MEMORY_CATEGORIES`、`DECISION_CATEGORIES` 目前内容相同，但没有类型或测试把它们绑在一起。新增一个分类时，只要漏改其中一份，`thresholdFor` 就会静默回退到默认门槛，报告也不会生成对应的分类段。这正是 [I-73] 那类“两端都改了、但没验证两端能对接”的风险。
- **证据**：三处列表目前都是 `identity, preference, relationship, goal, project, rule, health, finance, event, other`。
- **建议**：从一处导出分类，另两处引用；至少加一个 `npm run check` 里的测试断言三份列表相等，并断言 `byCategory` 的键都能通过 `decision_ledger` 的 category 校验。

### [低] 报告脚本无窗口/上限，大库可能产生资源压力

- **文件:行**：`scripts/calibration-report/thresholds.mjs:82-90`、`packages/calibration/src/thresholds.ts:554-560`
- **问题**：不传 `--days` 时使用 `ALL_TIME`，把该 owner/agent 的全部 `memory_candidate` 行读进内存；重跑部分会把每一个翻转 id 全部拼进输出。个人库通常没问题，但没有分页或数量上限，数据量大时会一次性占用大量内存并生成巨大 Markdown。
- **证据**：
  ```ts
  rows: database.prepare(thresholdRowsSql(kinds.length)).all(...parameters, ...kinds),
  counts: database.prepare(THRESHOLD_SQL.kindCounts).all(...parameters),
  ```
- **建议**：默认给出时间窗口，或对重跑清单加上“只列前 N 条，其余给计数”的上限；必要时流式写 stdout。

## 读代码证实的 / 推测的

**读代码证实的：**

- 本轮 5 条说法与代码一致：分类覆盖被 `PinnedThreshold` 钉住；服务选项已删除且全仓库无残留引用；未评价暂存计入 `unrated`、已评价暂存按 rating 拆开；SQL 已恢复 `COALESCE`；报告分母文案已加“低于门槛但暂存的不算”。
- 当前 `byCategory` 为空，`MEMORY_AUTO_COMMIT_GATE.defaultThreshold` 为 850，服务行为与旧的 `?? 850` 等价。
- 三份分类清单内容一致，但无自动一致性检查。
- `memory_candidate` 的 `outcome` 由 schema 约束非空，`COALESCE` 对当前 gate 无实际影响。

**推测：**

- 问题 2 的可利用性取决于将来是否给某个分类配更低的门槛。
- 问题 3 的实际错误取决于将来是否修改默认/分类门槛；现有数据仍是 850。
- 问题 6 的资源压力取决于生产库规模。
- 报告在 `--days` 下包含 `window.label`，且暂存评价用 `localeCompare` 排序，字节会随当前日期/locale 变化；但报告不是发给模型的内容。

## 侧重检查

- **错误路径**：`thresholds.mjs` 对未知参数、空值、`--end` 缺 `--days`、非法 `--days`、非法 `--miss-cost`、不存在的 owner/agent 都有拒绝路径；顶层捕获后以退出码 2 结束。DB 只读打开，`finally` 关闭。仅有一个小的顺序问题：`--owner`/`--agent` 配对检查在打开数据库之后，参数错误时会先做一次文件打开。
- **不可信输入**：CLI 的 owner/agent 全部走 SQL 占位符，`kind` 占位符数量来自静态 gate，不拼接用户输入；`--days` 限制 1–366，`--miss-cost` 只收有限正数。DB 的 `owner_rating`、`category`、`confidence_permille` 均有 schema 约束。模型给出的 `category` 是新引入的跨边界输入，见问题 2。
- **安全 / 不可撤销操作**：报告只写 stdout，不改门槛、不写数据库；服务改动只影响内存候选的存储路径。没有新增密钥或日志泄露点。
- **资源耗尽**：见问题 6。
- **规则/文档一致性**：没有改动提示词组装，未违反“只在末尾追加”；ADR 0179 仍写“自动存入门槛 850 不变”，当前 registry 为空所以一致，但若将来启用分类覆盖，该 ADR 和推测类 700 上限的描述需要同步更新。仓库里未找到本轮新报告脚本的说明文档，文档一致性**未核实**。本轮复核记录 `.agents/reviews/pr-368/round-2/*` 被 git 拒绝读取，我未能核对上一轮原文，**未核实**。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动不涉及提示词组装、工具定义、历史消息或遮盖；新增的 `report:thresholds` 只往 stdout 写本地报告。服务端虽然改成从登记表取门槛，但当前 `byCategory` 为空，默认值仍是 850，与旧行为等价，因此没有新的每轮变化值。将来若分类覆盖生效，最多改变某条记忆是正式还是暂存；它会出现在后台邮件判断提示的记忆块里（`proactive-mail-check-service.ts:389-410`），但那是固定的指令之后的可变数据，不是系统提示/工具定义/历史开头，仍然符合“固定的在前、会变的在后”。没有发现违反 `prompt-prefix.md#append-only` 的地方。

2. **会不会让同一段文字在不同请求里变成不同字节？** 对发给模型的内容没有新增这种风险：没有新的序列化集合、时间字段或依赖后文的遮盖；门槛是静态登记表值。会把不同字节带进报告的是 `window.label`（依赖当前日期）和 `ambiguousRatings` 的 `localeCompare` 排序（依赖 locale），但报告不是模型请求，且同一输入/同一日期下排序是确定的。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，但不完整。读代码判断：`threshold-suggestion.test.ts:326-350` 若去掉 `PinnedThreshold`，会重新出现旧测试里的 `h0…h5` 翻转，因此该用例会失败；`:284-292` 若恢复旧逻辑，会得到 `ambiguous=54, unrated=0`，也会失败。这两条是真正的反向保护。`tentative-memory-capture.unit.test.ts:163-171` 只测默认门槛边界，旧代码同样通过，**不能**作为“选项删除/分类门槛生效”的反向用例。`COALESCE`、报告分母文案、混合分类下的非覆盖样本翻转都没有测试。测试未在本环境运行，以上是按代码路径判断，**未运行核实**。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `automaticConfidencePermille`：已从接口删除，全仓库（含 golden 测试）无残留引用；仓库内调用方都能接受。对外部调用方是破坏性变更，**仓库外未核实**。
   - `ambiguousRatings`：由 `gateSamples` 产生，`analyzeGate` 透传，`thresholdReport` 消费，`.d.mts` 和测试也按 `GateAnalysis` 类型使用；rating 键被 schema 限制为 `useful/unneeded/missed`，两端一致。
   - `PinnedThreshold`：新增可选参数，旧调用方不传时等价于原行为；仓库内所有 `curvePoint/replay/suggestThreshold` 调用点都已接上。
   - `report:thresholds`：`package.json` 指向的 `scripts/calibration-report/thresholds.mjs` 存在，`parseArguments` 的每个 key 都在 `run` 里处理，`.d.mts` 与实际导出基本一致。
   - `COALESCE(outcome, verdict)`：消费端把它当 `string | null`；当前 `memory_candidate` 的 `outcome` 由 schema 保证非空，所以安全。将来若给 `proactive` 建 gate，需要保证 verdict 值能通过该 gate 的 `gatedReasons`/`positiveOutcomes` 校验，目前没有这条路径的测试。
   - 分类值：三份清单当前一致，但无自动校验；这是本轮最值得补的“两端核对”项。`byCategory` 的数值也没有有限数/范围校验，配置错误可能让生产门槛变成 `NaN` 或越界值。
