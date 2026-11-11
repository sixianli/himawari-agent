# P3-3 方案审核报告

## 先说核对结果：方案作者的事实前提我逐条验证过，全部属实

- fusion RRF(k=60)×boost、`slice(0, limit)`、无分数线：`packages/memory-engine/src/fusion.ts:94-114` ✓
- 只有向量路有门槛：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1152`（`vector.filter(({signal}) => signal >= input.minimumSimilarity)`），关键词路 -bm25（:1159）、实体路 COUNT(*)（:1176）✓
- 聊天门槛 qwen3 默认 0.6：`apps/agent-service/src/production-memory-composition.ts:92-96`，常量在 `packages/memory-engine/src/embedding.ts:25` ✓
- Gmail 默认 0.45 且逐次传入：`packages/platform-node/src/strict-configuration.ts:1054-1057`、`apps/agent-service/src/production-proactive-memory.ts:46` ✓
- 候选不带 sourceRefs（`packages/application/src/ports/memory-projection.ts:225-236`）、`DurableMemoryService.search` 已拿 sourceRefs（`packages/application/src/services/durable-memory-service.ts:391-396`）✓
- 评测基线数字与 `evals/memory-retrieval/history.jsonl` 里 10-29 那条一致（hitRate 0.8 / recall 0.774 / precision 0.854 / leak 0.021，24 条记忆 88 条查询）✓；但 **2026-11-11 的“实跑”没有落盘**（history.jsonl 只有一条 10-29 记录），这次实跑本身未核实。

---

## 问题清单（严重度从高到低）

### 1.【高·证实】截断会波及“整理记忆”（consolidation）路径，方案没列这个使用方

方案的截断做在 provider 层（fusion），而整理记忆的检索**直接调用 `memoryComposition.projection.search`**，不走 `DurableMemoryService.search`：

- `apps/agent-service/src/service-main.ts:1501`：`const consolidationProjection = memoryComposition.projection;`
- `apps/agent-service/src/service-main.ts:1956-1962`：`consolidation.search({ownerId, agentId, query, limit})`（不传 minimumSimilarity → 用构造值 0.6）
- `apps/agent-service/src/production-memory-consolidation.ts:101-108`：整理记忆靠这个 search 找“同一事实的已有记忆”来合并/替换。

后果有两面：其一，整理记忆的查询正是“问一条已有记忆的话”，很多命中只靠关键词或人名、相似度低于 0.57（方案自己的数据说明这类候选大量存在），新截断会把它们砍掉，整理能力退化（I-20 那类“替换/补充细节”链路依赖它）；其二，“找出近重复去合并”恰好是去重想删掉的东西——去重放在 `DurableMemoryService.search` 不影响它，但**截断放在 provider 层影响它**，两个改动的作用范围不对称，方案只论证了前者。这里也没有任何测试覆盖（方案测试清单不含 consolidation）。
**建议**：截断不要放在 provider 默认行为里，改为只在带场景门槛的产品检索（聊天、Gmail、recall）生效——例如截断参数由 `HybridMemoryProviderOptions` 显式开启、`production-memory-composition.ts` 接线，而 consolidation 在 service-main:1956 显式传“关”；或者至少给 consolidation 的 search 加一条“截断前行为不变”的反向测试，并在方案“改的文件/影响面”里列上 consolidation。

### 2.【中·证实】完成标准（recall@5 降幅 ≤2 点）没有自动检查，且本次实跑证据没落盘

- `test/integration/memory-retrieval-eval/live.test.ts:322` 唯一的断言是 `expect(usage.requests).toBeGreaterThan(0)`；命中率/召回只写进 `round.json`，不比对任何阈值（:297-317）。
- 该测试 `describe.skipIf(!LIVE)`（:159），不在 `npm run check` 里，永远不会拦提交。
- `evals/memory-retrieval/history.jsonl` 只有一条 10-29 记录，方案声称的“2026-11-11 实跑，与 10-29 一致”在仓库里没有记录，谈不上“作为完成标准的证据”。

fusion 单测和 strict-configuration 反向用例能证明“截断机制在工作”，但不能证明“召回没掉”——A、B 两个被否掉的规则说明这条线附近对参数极其敏感（Elastic 的官方文档也提醒线性加权组合“optimal weights are specific to each data set”：https://www.elastic.co/search-labs/blog/hybrid-search-elasticsearch ，而 RRF 之所以被广泛采用正是不需要校准：https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion）。
**建议**：① 实施后立刻实跑并把 round 追加进 history.jsonl；② 在 live.test.ts 里加一条断言：生产阈值 run 的 hitRate/recall 不低于 history.jsonl 里最近一条生产 run 减 0.02，低了就 fail；③ dedup 补一条阈值反向用例（规范化后 Dice ≈0.85 的同源两条不合并），证明 0.9 不是摆设。方案的 fusion 反向用例（weights 置 0 时人名 0.50 被截）设计是对的。

### 3.【中·证实】memory.recall 工具的截断行为方案没写明；tentative/confirmed 双路的去重语义未定义

- `apps/agent-service/src/production-memory-recall.ts:173-179、185-193` 调 `provider.search` 时**不传 minimumSimilarity**，落到构造值 0.6（`hybrid-memory-provider.ts:163`）。方案只说 Gmail 用 0.45−0.03、聊天用 0.6−0.03，没有说 recall 工具也会被截（截断线 0.57）、以及“limit×3 拉回来的候选被截到只剩高相关的”对 recall 工具的翻找旧记忆场景（低相似度也要翻出来）是否可接受。
- recall 的 render 有两路：tentative（`limit/2`）+ confirmed（`limit − tentative.length`，:170、:240-245）。去重函数共用没问题，但“跨不跨这两路去重、tentative 和 confirmed 同源近重复时留谁”没有定义——这两路顺序是先 tentative 后 confirmed，与“排在前面的留”的规则冲突时行为未定。
**建议**：方案补一节“各调用方的截断线与去重范围”，把 recall 工具（0.6−0.03，两路各自去重、不跨路）写成明确决定，并加对应单测。

### 4.【低·证实】去重需要读正文，`DurableMemoryService.search` 现在不读候选正文，readText 失败的语义未定义

`durable-memory-service.ts:367-428` 的 search 目前只读记录元数据（readMany），正文在渲染层才读（recall render `production-memory-recall.ts:223` 是 `catch(() => undefined)` 跳过）。去重判定“sourceRefs 有交集才读两边正文”意味着：① 每次检索可能新增若干次 payload 解密（protector.unprotect）；② 某条候选正文读不出来时，是“当不同源保留”还是“跳过”，方案没写。顺手核对：正文读取能力已存在（`options.content`，:379 已用于读查询），无权限障碍。
**建议**：写明“正文读取失败按不同源处理（保守保留）”，并在去重单测里加一条 readText 抛错的用例。

### 5.【低·证实】配置键“被接受但无消费者”在本仓库有先例，新键要写明生效范围

`strict-configuration.ts:1299-1300` 接受 `memory.adapter = "mem0-oss"`，但全仓库没有任何地方读 `memory.adapter`（grep 仅命中校验处两行）——键被接受、无效果。方案的 4 个新键（keywordWeight/entityWeight/cutoffMargin/dedupeSameSource）只接在 `HybridMemoryProvider` + `DurableMemoryService` 上，两端校验方案都写了（白名单在 `strict-configuration.ts:1288-1292` 的 `rejectUnknown` 里加键 + provider 构造再校验，与现有 `production-memory-composition.ts:95-96` 模式一致），这部分是对的。但要防止下一个 mem0 式悬空。
**建议**：docs 参数说明里写明“仅 himawari-sqlite 检索路径生效”，并考虑 `adapter` 非 himawari-sqlite 时拒绝这些键（或删掉 mem0-oss 这个死选项，另开待办）。

### 6.【推测】sqlite-vec 引擎补算 similarity 的读放大没有估算

方案说“对 ≤200 个候选读 blob 算”。sqlite-vec 路径下向量候选的 blob 本来只读 top-limit，补算意味着关键词/实体候选也要逐个读 embedding blob（qwen3 8B、4096 维，量化后每行 KB 级）；每次检索最多三路 × limit 行。项目有过检索延迟事故（I-30：向量请求无上限最慢 9.1 秒）。数量级上大概率没事，但方案没估、没测。
**建议**：实施时在 SQLite 契约测试里顺带量一次补算耗时，或先用 SQL 侧表达式（`1 - vec_distance_cosine` 同款）对候选逐个算，避免 JS 读 blob。

### 7.【未核实】评测数字 A/B/C 的离线复算

表里的三组数字依赖离线复算脚本和 11-11 实跑，仓库里只有 10-29 基线（与方案一致），复算过程我无法独立验证。“C 在 wl 0.15–0.2、we 0.1–0.3、线 0.55–0.58 一片区域满足”和“丢的 1 条/剩下的无关带出”标未核实。区域不为单点这一说法若属实，过拟合担忧会缓解——这正是问题 2 建议落盘的原因。

---

## 侧重检查（测试覆盖 / 文档规则一致 / 普通流程走查）

**走的流程**：Andy 在生产网页发一句话 →
1. `service-main.ts:1289` 把 `durableMemory` 接进 run 组合 →
2. `production-run-composition.ts:229-247` 包装 search（计时 + `recalled` 记录）→
3. `production-run-memory.ts:339-382`：owner/agent 校验（:341-344）、查询 payload 分类校验（:345-350）、调 `DurableMemoryService.search`（:352-366）、结果映射（:369-380，注意 `sourceRef: memory.sourceRefs[0] ?? memory.id` 只取第一个）→
4. `durable-memory-service.ts:367-428`：provider.search（limit×4）→ readMany → 分类/来源过滤 → 排序 → slice → markUsed →
5. `hybrid-memory-provider.ts:122-181`：embed → index.search（`sqlite-memory-operations.ts:1097-1191`）→ `fuseCandidates` →
6. 结果作为 context block 进入 `pi-runtime-adapter.ts:623-642` `turnPrompt` 的最后一条用户消息；历史按 ADR 0149 存实际发出的那条。

**结论**：新增的截断（第 5 步）和去重（第 4 步）都在这条链上有测试方案覆盖（fusion 单测、SQLite 契约、dedup 单测、集成用例）；**没有覆盖的路径**是上面问题 1 的 consolidation 分支（service-main.ts:1956，同一 provider 的另一个消费者）和问题 3 的 recall 双路。两点提醒：① 方案选在 `DurableMemoryService` 层做去重是正确位置——第 3 步的映射只保留 `sourceRefs[0]`，如果在更外层做去重会拿到残缺的来源信息；② 提交时按 I-05 的 L0 检查要声明相关测试（`check-layer0-tests`），方案测试清单够用但没提这个仓库流程；`npm run check:prompt-prefix`（含“每轮变化的记忆”多轮用例）在改动后应真跑一轮，尽管本次改动理论上不触规则。

---

## 如果由我来定，我会怎么改这份方案

1. **截断的作用域收窄**：截断参数不进 `HybridMemoryProvider` 默认行为，由 `production-memory-composition.ts` 显式接线；consolidation（service-main.ts:1956）显式保持旧行为，并加反向测试。
2. **完成标准变成可执行的检查**：实跑追加进 `history.jsonl`，live.test.ts 加“不低于历史基线 −0.02”断言；dedup 补 Dice 阈值反向用例。
3. **写明三个调用方（聊天 / Gmail / recall 工具）各自的截断线和去重范围**，含 tentative/confirmed 是否跨路去重。
4. 其余照方案执行：去重放应用层（位置正确、可逆）、similarity 由存储层补算（两个引擎 + in-memory 索引都改）、strict-configuration 白名单 + 构造时复校验、去重阈值做成常量——这些都同意。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。截断和去重只影响两处：本轮最后一条用户消息里 `<himawari-context>` 的记忆块（`pi-runtime-adapter.ts:623-642`，记忆本来就是每轮会变的值、规则第 2 条允许它只在最后一条消息），以及 `memory.recall` 工具结果（轮内追加的工具结果，仍是末尾追加）。系统提示、工具定义、历史消息、遮盖都不触碰；历史存实际发出内容（ADR 0149），本方案不改任何已发消息。Gmail 判断邮件是无历史的一次性后台调用，符合规则第 15 条。`npm run check:prompt-prefix` 会继续逐字节守住这一点。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会新增这种来源。rel 分数的全部输入（本句 bm25、本请求候选集的最高 bm25、是否命中人名、sim）都是本次请求内确定的；去重的规范化（NFKC+小写+去标点）只用于判定不进输出；留哪条由确定性排序决定（score 相同用 memoryId `localeCompare` 兜底，`fusion.ts:113`、`durable-memory-service.ts:418-420`），不依赖对象遍历顺序；去掉后面的重复项不改变前面条目的字节。唯一的间接效应是 markUsed 改变 lastUsedAt → 影响未来轮次的 recency，这是现状已有的行为。
3. **有没有自动检查、反向用例会不会真的失败？** fusion 单测的反向用例（weights 置 0 时人名候选被截）和 strict-configuration 的未知键/越界用例会真的失败，这部分成立。**缺口**：完成标准（召回降幅 ≤2 点）没有自动检查——live.test.ts 只断言了 usage>0（:322）且不在 `npm run check`；dedup 缺 0.9 阈值的反向用例；consolidation 路径完全无覆盖（问题 1）。
4. **每个产生/修改的值，两端都核对了吗？** `similarity?`：生产端 sqlite 两引擎 + in-memory 测试索引（方案都列了）+ eval 的 recordingIndex（透传，无需改，`live.test.ts:97-112`），消费端是 fusion 截断，契约测试对齐 sqlite sim 与向量 signal——闭环成立。新配置键：白名单 + 范围校验 + 构造复校验——闭环成立，但要写明仅 himawari-sqlite 生效（问题 5）。`dedupeSameSource` 默认 true：影响聊天、Gmail、recall 三条路（评测集不覆盖，靠单测）——但方案**漏了 provider 层截断的第四个消费者 consolidation**（问题 1，本次审核最重要的发现）。
