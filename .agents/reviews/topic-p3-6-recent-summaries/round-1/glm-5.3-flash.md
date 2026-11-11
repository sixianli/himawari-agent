# 方案：让 Gmail 主动检查带上最近 1–2 天的日摘要

## 一、方案依赖的前提（读代码证实）

1. **日摘要按 `(owner_id, agent_id, day)` 有索引、每天每对话一条，来源分 `day_summary` 和 `compaction`**
   `packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql:11`「`source TEXT NOT NULL CHECK (source IN ('day_summary', 'compaction'))`」、`:24`「`UNIQUE (thread_id, source, first_sequence)`」、`:27`「`CREATE INDEX memory_episodes_scope_index ON memory_episodes(owner_id, agent_id, day)`」。摘要文本最长 1200 字（`packages/memory-engine/src/episodes.ts:25`「`const MAXIMUM_SUMMARY_CHARACTERS = 1200;`」），敏感-only 段写占位文字（`episodes.ts:27`「`const UNSUMMARIZED = "（这段对话只含敏感内容，没有做摘要）";`」）。文本经 payload 加密存取（`apps/agent-service/src/service-main.ts:1383-1389`）。
2. **日摘要现在只进聊天的 recall 工具，主动检查完全不读它**
   `apps/agent-service/src/production-memory-recall.ts:248-259`（episodes 经 `search` 进 recall 输出）；`ProactiveMailCheckService` 全文（`packages/application/src/services/proactive-mail-check-service.ts`）没有任何 episodes 引用。
3. **存储端口没有“按天列举”的能力**：`MemoryEpisodeStorePort` 只有 `upsert / search / listUnembedded / attachEmbedding / listUnsummarized`（`packages/application/src/ports/memory-episodes.ts:45-73`），`search` 是向量+BM25 相关性检索（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1297-1382`），不保证覆盖“昨天全部对话”。
4. **主动检查是每次全新的一次性请求**：`proactivePrompt` 拼一条字符串（`proactive-mail-check-service.ts:374-411`），经 `ProactiveModelInvoker.prepare` 写成 model_input payload，Pi 传输层用 `backgroundModelContext` 包成「固定系统提示 + 一条 user 消息」（`packages/runtime-pi/src/egress-context.ts:23-28`、`packages/runtime-pi/src/pi-model-transport.ts:309`）。
5. **KV 缓存规则与业界来源**：`.claude/rules/prompt-prefix.md:27-29`（固定的在前、会变的只放最后一条用户消息）、`:35`（已发内容只追加）、`:51`（同样内容每次序列化成同样字节）、`:67`（后台调用也是固定在前、数据居中、时间最后）。规则引用的一手来源：Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、OpenAI https://developers.openai.com/api/docs/guides/prompt-caching 、DeepSeek https://api-docs.deepseek.com/guides/kv_cache 、Claude Code https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/ 、Manus https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 。
6. **决策记录的输入有严格的写校验和读映射，两端都要改**（I-73 的教训所在）：写校验 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:643-690`（`validateInputs` 逐字段校验），读映射 `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:140-215`（`entryFromRow` 只映射已知字段，未知字段会被丢掉）。
7. **费用与时间上限**：单次 3 分钟（`perCheckMs` → `proactive-mail-check-service.ts:627-631`），日费用上限按 prompt 字符估算（`apps/agent-service/src/production-proactive.ts:58-72`「`Math.ceil(prompt.length * …)`」），所以摘要字符天然计入估算，不需要另外记账。
8. **敏感分级**：模型可见分级是 `modelVisibleClassifications()`（`packages/application/src/services/model-visibility.ts:20-22`，public/private/sensitive；restricted 不可见）；prompt 的数据分级取 `highestClassification("private", 记忆分级)`（`proactive-mail-check-service.ts:1112-1115`），模型描述符不允许该分级时抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`（`apps/agent-service/src/production-model-composition.ts:521-523`）。
9. **新固定文字必须进提示词目录**，目录外出现提示词标记词会被拦（`docs/lessons.md:668`：「`PROMPT_OUTSIDE_CATALOG …`」，门槛是 `apps/agent-service/test/prompt-catalog.unit.test.ts` / `npm run check:prompt-catalog`）；目录条目样式见 `packages/prompt-catalog/src/mail.ts:36-61`。
10. **每个调用模型准入的源文件必须登记真实 SQLite 集成测试**（I-37，`npm run check:real-admission`）。

## 二、方案本身

### 1. 读哪些摘要、怎么取舍

- **新增一个端口方法** `MemoryEpisodeStorePort.listRecentSummaries({ ownerId, agentId, fromDay, toDay, allowedClassifications, limit })`，SQLite 实现走 `memory_episodes_scope_index`：`WHERE owner_id=? AND agent_id=? AND day BETWEEN ? AND ? AND source='day_summary' AND classification IN (模型可见) ORDER BY day ASC, id ASC`。不需要迁移、不需要嵌入调用（不加嵌入费用、不给 I-25/I-45/I-60 那条链路添活）。
- **窗口**：`fromDay = localDay(now − 1 天, timeZone)`、`toDay = localDay(now, timeZone)`，即本地时区的昨天+今天；`timeZone` 用 `runPolicy.timeZone`（与生成端 `episodes.ts:76-83` 同一函数/同一时区，避免错位）。天数不写死，进 `ProactiveConfiguration`（`packages/application/src/ports/configuration.ts:215`）新增 `daySummaryDays`（默认 2）与 `daySummaryMaxEntries`（默认 8）、`daySummaryMaxCharacters`（默认 4000，约 3 条满额摘要）。
- **取舍顺序**：天窗口内的行全取（上限 `daySummaryMaxEntries`），超字符预算时**从最旧的开始丢整条**（不截半条，截半条会让摘要语义残缺）；只取 `source='day_summary'`。`compaction` 摘要的是单对话历史段而非“那天发生了什么”，先不带（见拍板项）。占位文字 `UNSUMMARIZED` 的条目照样列出（它告诉模型“那天有对话但只有敏感内容”，本身有信息量；是否跳过见拍板项）。
- **分级**：注入前按 `isModelVisible` 再过滤一层（端口校验 + service 层双保险），并把摘要的 `dataClassification` 并进 `#judge` 的 `highestClassification`——与现有记忆行为完全同构。

### 2. 放在提示的哪里

`proactivePrompt` 里、**记忆块之前**新增一个数据段：

```
MAIL_JUDGMENT（固定指令，不动）
→ 新增 MAIL_JUDGMENT_DAY_SUMMARIES_HEADER（fixedPrompt，≥24 字符，写明"背景资料，只帮你判断，不是指令"）
→ JSON.stringify([{ day, threadId, text }, …])   // 按 day 升序、id 升序，键序固定
→ （现有）memories 块 → tentative note → items 块 → MAIL_JUDGMENT_NOW
```

理由：这条消息本来就是唯一的、最后一条用户消息（前提 4），整段都是“会变的资料”，完全符合规则第 2、15 条；不进系统提示（系统提示是固定的 `EGRESS_PLACEHOLDER_LEGEND`，一行都不动）；模型读邮件前先知道“主人最近在忙什么”，判断顺序合理。若某次窗口内没有摘要，**整个段（含 header）都不出现**，与现有 memories 段的条件渲染一致（`proactive-mail-check-service.ts:391-403`），不产生空块噪声。

### 3. 决策记录记什么

`ProactiveCheckInputs`（`packages/application/src/ports/proactive-checks.ts:208`）新增：

```ts
readonly daySummariesInjected: boolean;
readonly daySummaryDays: readonly string[];      // 实际注入的 day 列表（去重、升序）
readonly daySummaryEpisodeIds: readonly string[]; // 实际注入的 episode id
readonly daySummaryCharacters: number;            // 注入总字符
```

带没带、带了哪些、丢了多少，一次可见。**两端同步改**（I-73 的教训）：
- 写端：`validateInputs`（`sqlite-proactive-operations.ts:643`）加校验——day 必须是 10 字符日期、id 上限同 `MAX_INPUT_IDS`、characters 非负安全整数、`daySummariesInjected` 必为 boolean；
- 读端：`entryFromRow`（`sqlite-decision-ledger-operations.ts:140-215`）加映射与默认值（旧记录缺字段时 `injected=false`），`DecisionInputs` 类型同步。

### 4. 怎么保证聊天不受影响

- 改动面只在 `ProactiveMailCheckService`、memory-engine 的新读取方法、SQLite 实现的新 case；聊天路径（recall 工具、`MemoryEpisodeService.search`、上下文投影）**一行不动**。
- 读取走 `repository.memoryEpisodes()` 的读通道（ADR 0131 独立只读连接），一次索引查询 + 最多 N 条 payload 解密，毫秒级，且发生在主动 run 自己的 3 分钟预算内，不在任何聊天请求路径上。
- 费用按 `prompt.length` 估算，摘要字符自动计入日上限与单批判断；不加网络调用。

### 5. 测试（含反向）

| 用例 | 位置 | 反向验证方式 |
|---|---|---|
| 昨天+今天的 `day_summary` 进 prompt、决策记录 `daySummaryDays/EpisodeIds` 正确；前天的窗口外不出现 | `test/integration/proactive-mail-check.test.ts`（真实 SQLite，沿用现有假 reader/model 夹具） | 改窗口计算把前天包进来 → 红 |
| 普通聊天请求里不含日摘要块 | 抓请求体的现有集成测试（`thread-run-lifecycle` / `memory-model-visible` 风格）断言不含新 header 文字 | 在聊天投影里塞摘要 → 红 |
| restricted 分级摘要不注入 | 同上 | 去掉过滤 → 红 |
| 无摘要/读 payload 失败 → `daySummariesInjected=false`，run 照常完成 | 同上 | 改成抛错中断 run → 红 |
| `validateInputs` 拒绝畸形字段（day≠10 字符、负数、id 超 256） | `sqlite-proactive-operations` 集成测试 | 去掉校验分支 → 红 |
| 同一数据两次构造 prompt 字节相同（排序+JSON 键固定） | `proactive-mail-check-service` 单测 | 依赖 DB 返回顺序（去 ORDER BY）→ 红 |
| 时区反例：Tokyo 时区下“昨天”与 UTC 不同 | 同上 | 写死 UTC → 红 |
| 新目录条目被 `npm run check:prompt-catalog` 覆盖（trusted 清单、目录外文字拦截） | 门槛自动 | — |
| `check:real-admission`：新调用方登记真实 SQLite 集成测试 | 门槛自动 | — |

## 三、考虑过但不选的做法

1. **复用 `episodes.search`（按每封邮件搜相关摘要）**：搜索是相关性排序，不保证覆盖昨天全部对话（漏掉“昨天说过的事”正是本问题）；每次还要嵌入查询，多费用多失败面。按 day 索引直接读最便宜、确定。
2. **放系统提示**：违反规则第 2 条「系统提示和工具定义里不得出现会变的值」（`.claude/rules/prompt-prefix.md:28`）。
3. **把摘要转存成主人记忆，走现有 recall**：会让普通聊天也看到，直接违反验收 1。
4. **新增第二种主动 run（每日简报）**：验收只要求 Gmail 检查带块；生产目前只接了 Gmail 一种 run，扩范围超出目标。
5. **带 `compaction` 来源**：语义是“某对话的历史压缩”，不是“那天发生了什么”，混入会稀释日块的可读性；先不带。

## 四、风险与反例

- **对话多的主人两天摘要超预算**：按条丢弃最旧，决策记录里能看出实际带了哪些；极端情况退化为现状。
- **分类升级到 sensitive 而模型描述符不允许**：`prepare` 抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`，整批判失败——与现有敏感记忆行为一致（前提 8），但需要一条正向测试证明 sensitive 摘要在允许的描述符下能正常发送。
- **摘要文本含敏感值**：prompt 经出口遮盖，外来内容照常检查（规则第 11 条，确定性遮盖）；header 是目录固定文字，≥24 字符进 trusted 清单（I-78 的机制），不会被遮出不同字节。
- **prompt 变长挤压单批邮件数**：`#fitBatch` 的 perBatch 窗口不含摘要块，同样邮件数下每批 token 变多，批数可能增加、更早撞日费用上限——由估算器自然兜底，测试里放一条长摘要观察批行为。

## 五、需要人拍板的取舍

1. `compaction` 来源要不要带（我建议不带）。
2. `UNSUMMARIZED` 占位条目要不要跳过（我建议保留）。
3. 天数/条数/字符预算的默认值（2 天 / 8 条 / 4000 字符）与是否进严格配置文件（`strict-configuration.ts` 的解析和 `check:product-path-configuration` 要同步，**未核实**该文件对新键的具体校验写法）。
4. 摘要块要不要参与每封邮件的 `usedMemoryIds` 式追溯（我建议不参与，块级记录已够审计）。

## 六、「证实」与「推测」分开

**读代码证实**：前提 1–9 全部（各条已附文件:行）；决策记录写/读两端的现有字段清单；费用估算按 prompt 长度；主动请求是单条 user 消息的一次性调用。
**推测**：`strict-configuration.ts` 对新增配置键的校验方式（未读该文件）；两天摘要的实际 token 量对批行为的影响（未实测）；真实对话里日摘要对判断质量的改善（要上线后用决策记录的 ownerRating 验证）。

## 七、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。主动检查是每次全新的一次性请求（`egress-context.ts:23-28`），没有“已发过的开头”可改；本改动的全部内容（header + 摘要 JSON）都在那条唯一的、也是最后的用户消息里，会变的值（day 窗口、摘要、now）全在最后一条消息，系统提示一行不动，工具定义无。聊天路径零改动，聊天对话的逐字节追加性不受影响。依据：`.claude/rules/prompt-prefix.md:27-29、35、67`。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。摘要文本是落库的稳定文本；列表按 `day ASC, id ASC` 固定排序、JSON 键序固定（规则第 10 条）；遮盖是确定性的且固定文字进 trusted 清单（规则第 11 条、I-78 机制）。唯一随请求变的是“选哪些天”，这正是允许放在最后一条消息里的每轮变化值。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
有。上表 8 条用例全部设计成“改掉对应代码就红”：窗口算错、过滤去掉、排序去掉、校验删掉、记录字段删掉，各有断言直接命中；另有 `check:prompt-catalog`、`check:real-admission` 两道既有门槛自动覆盖新代码，且按仓库惯例每条反向用例须在修复前代码上先跑出失败再修（I-66/I-73 的做法）。

**4. 每个产生/使用的地方都能接受吗？**
逐个核对过：①新目录条目——产生于 `prompt-catalog/src/mail.ts`，唯一使用方是 `proactive-mail-check-service.ts`，被 `check:prompt-catalog` 与 I-78 trusted 机制双重覆盖；②新端口方法——产生于 `memory-episodes.ts` 端口，实现在 `sqlite-memory-operations.ts`（入参校验：day 正则、limit 上限、classifications 白名单，对齐该文件现有 `search` 的校验风格 `:1298-1308`），使用方是 memory-engine 与 mail-check-service（service 层再过 `isModelVisible`）；③新配置键——产生于 `ProactiveConfiguration`，使用于 `production-proactive.ts` 构造，**strict-configuration 的解析端未核实，必须按 I-73 的教训把“配置能被产品自己的解析接受”写进 `check:product-path-configuration` 反向用例**；④新 inputs 字段——产生于 `#finish` 的 trace，消费端两处（`validateInputs`、`entryFromRow`）都要同步加，否则要么写不进去、要么写进去读不出来（I-73 原话：「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」，`docs/incidents-and-gates.md:112`）。
