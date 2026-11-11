# 代码复核报告：P3-3 检索相关分截断 + 同源去重

## 侧重检查（先查的流程与结论）

我走了一条最普通的使用流程——**聊天一轮自动带记忆**：

`context-formation-service.ts:236`（memory.search）→ `production-run-memory.ts:352` → `production-run-composition.ts:231` → `DurableMemoryService.search`（durable-memory-service.ts:407-483，硬编码 `relevanceCutoff: true`，去重后 markUsed）→ `HybridMemoryProvider.search`（hybrid-memory-provider.ts:193-204 组装 cutoff）→ sqlite 索引 `candidateSimilarities`（sqlite-memory-operations.ts:1214-1280）→ `fuseCandidates` 截断（fusion.ts:107-111）→ trace `memory.selection`（context-formation-service.ts:283）→ 记忆文本进入最后一条用户消息。

**该流程中没有测试覆盖的代码路径：**
- `service-main.ts:362-369` 的 `onRelevanceUnknown → memory.relevance_unknown` 诊断链路：fusion 单测只测了回调本身，service-main/production-memory-composition 的接线没有任何测试。
- `production-proactive-memory.ts:41`（Gmail 检查）：没有测试断言它经 DurableMemoryService 拿到 cutoff/dedupe 后的行为（间接覆盖）。
- HybridMemoryProvider + 真实 sqlite-vec 索引 + `relevanceCutoff` 的组合：provider 单测用 mock 索引（hybrid-memory-provider.unit.test.ts:203-211），集成测试只测索引层的 similarity 补算（memory-engine-index.test.ts:316-360），两者之间没有端到端一跳。

其余流程（memory.recall 工具、配置解析、Gmail/consolidation 的开关取舍）都查过，结论见下。

## 发现的问题（按严重度从高到低）

**1. 中低 | packages/application/src/services/durable-memory-service.ts:429 | 「由调用方显式打开截断」的说法与代码不符，场景层无法退出**
证据：`relevanceCutoff: true` 在 `DurableMemoryService.search` 里是无条件硬编码（429 行），不是由聊天/Gmail 场景调用方传入；所有走这个服务的调用（production-run-memory.ts:353 聊天、production-proactive-memory.ts:41 Gmail）都被强制打开，未来新增调用方也无法关闭。这与 ADR 0221 决定 4 的意图一致，但作者说法 3「截断由调用方显式打开」只对 provider 端口成立，对场景层不成立。建议：说法改为「服务层固定打开」，或给 search 加显式开关。

**2. 低 | apps/agent-service/src/service-main.ts:362-369 | `memory.relevance_unknown` 诊断链路无自动测试**
证据：全仓 grep `relevance_unknown|onRelevanceUnknown`，仅 fusion.unit.test.ts:155 覆盖 fusion 层回调；service-main 365 行的 `context.diagnostic` 接线和 `writeServiceDiagnostic` 输出无测试。ADR 0221 决定 3 承诺「写一行诊断日志」，若接线被改坏不会被发现。建议：在 production-memory-composition 或 service-main 测试里加一条。

**3. 低 | packages/testing/src/in-memory/memory-index.ts:39-50 | 测试替身的「相似度」是点积不是余弦，且不校验维度**
证据：`similarity()` 直接返回 `dot`（50 行），只要 `document.embedding?.model === input.embedding.model` 就算，维度不同时按缺省 0 补齐；生产端（sqlite-memory-operations.ts:1214 起）是余弦且 SQL 过滤 `embedding_dimensions = @dimensions`。用这个替身测截断行为时，keyword/entity 候选拿到的 similarity 语义和生产不一致，可能掩盖截断边界 bug。建议：替身改用余弦并校验维度，或注明仅适用于归一化向量。

**4. 低 | packages/application/src/services/same-source-dedupe.ts:51-56 | 达到 limit 后 `dropped` 列表不完整**
证据：`if (kept.length >= limit) break;` 在处理候选前直接退出，之后的重复候选既不进 kept 也不进 dropped。当前 dropped 只被测试消费，无实际影响；但若未来拿 dropped 做日志/审计会漏记。建议：注释级知情即可（仓库禁注释，则在测试里断言此行为）。

**5. 信息 | apps/agent-service/src/production-memory-recall.ts:249-251 | 已确认替换待确认后，`tentativeNote` 可能随之消失**
证据：confirmed 替换 kept 中最后一条 tentative 时，`tentativeMemories` 变空，306 行的 `tentativeNote` 不再出现——尽管 tentative 搜索确实成功过。行为合理（主人看不到 tentative 内容就不需要提示），但无测试断言，属未声明的行为变化。

**6. 信息 | 评测数字未核实**：ADR 0221 的 85.4%→89.1%、recall 77.4% 无法在不运行评测的情况下验证；`retrieval-eval-fixture.unit.test.ts:88-93` 只断言「精度上升、召回降幅 ≤2 点」的方向性标准，fixture 数据文件（evals/memory-retrieval/candidates-qwen3-embedding-8b.json）已入库且自带 schema 与说明，live 评测被 ci/policy.json:166 排除出常规集成项目（合理）。

**读代码证实的（说法逐条核对，均成立）**：默认值 0.15/0.15/0.05（relevance.ts:11-15）；相关分公式与「排序前剔除」（fusion.ts:129-166、107-111）；sqlite-vec 用 `vec_distance_cosine`、JS 引擎读 blob（sqlite-memory-operations.ts:1254、1170），不发嵌入请求；consolidation search 不打开（service-main.ts:1971-1976 无 relevanceCutoff）；去重规则（NFKC/小写/去空白标点、Dice≥0.9、少于 8 字只认相同、数字串先行否决、读不出按不重复——same-source-dedupe.ts:12-45）；去重在名额和 markUsed 之前、后续补满（durable-memory-service.ts:462-481；集成测试 durable-memory-projection.test.ts:515-523 断言被跳过的 lastUsedAt 为 null）；recall 两组合并去重、已确认优先、总数 ≤ limit（production-memory-recall.ts:256-258）；配置白名单 + 0≤x<1 + 布尔（strict-configuration.ts:122-141、1312），provider 构造再校验（hybrid-memory-provider.ts:64-65）；`production-run-memory.ts` 未被碰、新代码无注释；向量路 `signal >= minimumSimilarity` 过滤未动（sqlite-memory-operations.ts:1179）。**推测（未核实）**：测试实际运行结果、评测具体数字。

## 必答问题

**1. 是否改变模型已见过的请求开头？** 不会。diff 只触碰检索选择、配置、文档、测试，未触碰提示词目录、请求组装、遮盖。记忆属于规则明确允许的「本轮选中的记忆」，只放在最后一条用户消息（prompt-prefix.md 第 28 行）；截断与去重只减少/替换本轮选中的记忆条目，输出结构与顺序（confirmed 先、tentative 后，production-memory-recall.ts:275）不变。请求仍只在末尾追加。`check:prompt-prefix` 门槛存在且带反向用例（prompt-prefix.md 第 74 行）。

**2. 同一段文字是否可能在不同请求里变成不同字节？** 新代码没有引入这种不确定性：keyword 归一分母是本次查询候选集的函数（同查询+同索引→同值）；去重比较是纯函数，遍历基于按 score desc + id 排序的数组（durable-memory-service.ts:459-461）和有序的 kept 数组；所有 Set/Map 只用于成员判断不进序列化；digitRuns 输出固定。无新增时间依赖字段；`now`/`current` 等是既有行为且在末尾内容里。跨请求变化只来自库内容本身变化（既有）。

**3. 有没有自动检查，反向用例会不会真的失败？** 有，覆盖面较好：fusion 单测 7 条含 unknown 回调、entityWeight=0 剔除、无 cutoff 不截；`retrieval-eval-fixture.unit.test.ts:95-109` 反向用例（只认向量门槛、零加分）断言召回掉超过 2 点——若有人删掉关键词/实体加分，第一个用例（88-93 行）的召回断言也会失败；去重、recall 合并、配置非法值、markUsed 只记留下者均有正反用例。我未运行测试，「真的会失败」是依据断言方向推断；评测数字本身未核实。

**4. 每个新值的产生端与使用端是否互相接受？** 逐一核对（I-73 式双端检查）：
- `MemoryIndexCandidate.similarity`（ports/memory-projection.ts:240）：产自 sqlite `candidateSimilarities` 与 in-memory 索引，消费于 fusion.ts:135-140；sqlite 端语义为余弦（0-1），fusion 端按 0-1 线比较——一致；但测试替身端是点积（见问题 3）。
- `relevanceCutoff`（ports/memory-projection.ts:209）：产自 durable-memory-service.ts:429、production-memory-recall.ts:181/194；消费于 hybrid-memory-provider.ts:145/193；不传则完全不截断——两端一致，consolidation（service-main.ts:1971）不传，符合 ADR。
- `memory.retrieval.{keywordWeight,entityWeight,cutoffMargin,dedupeSameSource}`：strict-configuration 白名单+范围校验（非法值拒绝启动，startup-configuration.unit.test.ts:165-199 覆盖 NaN/Infinity/1/字符串/未知键/非对象）→ production-memory-composition.ts:100-117 补默认值 → provider 构造二次校验（RangeError）→ dedupeSameSource 经 service-main.ts:1169/1256 到两个布尔消费端。双端都有校验，I-73 的教训（只看改动、不查下游校验）这次是吸取了的。
- `memory.relevance_unknown` 诊断事件：产生端存在，无下游校验问题，但链路无测试（见问题 2）。
- 评测 fixture/dataset 文件：被单测读取，路径存在，live 评测已从常规 CI 项目排除。
