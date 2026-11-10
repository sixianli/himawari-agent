我先核对仓库结构和方案引用的关键文件，再逐条核对。
规则文件和 I-73 已核对。现在核对方案引用的代码位置。
核对业界说法，抽查两条关键一手来源：
# P1-6 数据导出方案审核报告

## 审核方式说明
核对范围：仓库 `fd283e4` 上方案引用的全部关键文件（迁移 SQL、persistence 写入路径、sensitive-capture、CLI、memory 页、规则与事故文档、ci/policy.json）；业界说法抽验了两条一手来源（Claude 导出帮助页、Letta AgentFile 文档）。未逐条复验：Mem0/Google Takeout/GDPR 原文（方案自己也标了未核实，且不支撑关键设计决定）。

---

## 证实的按严重度排列

### 高-1｜导出遮盖的调用方式会被自家门槛 `check:egress-redaction` 拦下，方案没有登记安排（必答问题 4 的两端断点，I-73 同类）
- **问题**：§2.4 说“我不自己实现任何识别，只调 `sensitive-capture` 的导出函数”。但现有门槛禁止出口模块之外的代码直接调用遮盖：`scripts/check-egress-redaction.mjs:178-180`——“只有出口模块能直接调用 redactForEgress，请改走 ModelEgress（packages/application/src/services/model-egress.ts）”。导出命令在 `apps/admin-cli` / `apps/agent-service` 里新写调用点，`npm run check` 会直接失败；方案 §2.6-6 只说“进 npm run check”，没说怎么过这一步。
- **建议**：在方案里明确：导出遮盖要么封装成 `packages/sensitive-capture` 暴露的导出专用入口，要么在 `check-egress-redaction.mjs` 的登记清单加条目并写理由，配一条“未登记的导出侧调用会被拦”的反向用例。

### 高-2｜§2.6 测试 1 与 §2.5 自相矛盾，往返“逐字节相同”按方案现状必失败（必答问题 3）
- **问题**：§2.5 正确地指出导入必须把指向未导出对象的外键置空（`memory_history_events.source_thread_id`，`0065_memory_history.sql:10`，FK `REFERENCES threads(id) ON DELETE SET NULL`），并说比较口径要排除这些列。但 §2.6-1 写的是“两份 data/*.jsonl 逐字节相同（排除导出时间）”。首份导出里这些字段有值、导入再导出后是 null，字节不可能相同——这条测试照写必红，实施者会被迫削弱断言。
- **建议**：把导出格式的字段定义成逻辑表示：不直接序列化数据库外键列，线程来源一律以 `provenance[]` 里的编号字符串出现（写入端也从 `memory_records.source_thread_id` 转换过来，见下一条）。这样“逐字节相同”才成立，§2.5 的口径特例也可以删掉。

### 高-3｜方案的“待核实”项核实结果与方案假设不同：现有写入**不**同时写 thread 来源到 provenance；且漏了 `memory_records.source_thread_id` 的处理和使用端
- **证据**：`sqlite-memory-operations.ts:818-824` 是唯一写 `memory_provenance` 的地方，只写 `source_type='reference'`（来自 `sourceRefs`）；线程来源只存在 `memory_records.source_thread_id`（`0001_initial_product_schema.sql:401`，同样是 FK）。
- **问题**：① 方案 §2.5 只处理了历史表的 `source_thread_id`，漏了 `memory_records.source_thread_id` 导入时也必须置空（同样有 FK）；② 导入新建 `source_type='thread'` 行时没说 `source_deleted` 填什么——目标库无此线程，应填 1，否则记忆页“来源对话已删除”的判定（I-20 的门槛，`sqlite-governed-deletion.ts:762`、`804`、`838` 维护的就是这个标志）会把不存在的来源当“还在”；③ `sources()`（`sqlite-memory-operations.ts:455-463`）把 provenance 全部编号读进 `sourceRefs`，下游 `apps/agent-service/src/production-memory-control.ts:358-396` 按长度过滤使用——导入会改变这个字段的构成，长度上限（`MEMORY_SOURCE_REF_MAX_LENGTH`）之外的线程编号会被静默丢弃。使用端校验未核对。
- **建议**：方案补上 `memory_records.source_thread_id` 的置空规则和 `source_deleted=1`；实现前把 `sourceRefs` 的全部消费者列一遍（I-73 的教训正是“只看改动本身”）。

### 中-4｜索引重建路径经核实不能直接复用，且导入触发的是真实付费嵌入调用
- **证据**：`memory_projection_jobs.generation_id NOT NULL REFERENCES memory_generations(id)`（`0001:418-430`）；`memory_generations` 又绑定 `thread_checkpoint_jobs` 和具体 thread（`0001:381-391`）；`sqlite-memory-operations.ts:1530` 还有"Memory projection generation is outside scope"校验。方案 §0-8 标“未核实：导入后重建索引走哪条现有路径”。
- **结论**：导入的存量记忆没有 generation 链，现有投影任务链需要伪造整条 `thread_checkpoint_jobs → memory_generations` 才能用。另外嵌入是真实模型调用，过预算准入（I-37、I-11 的背景）。
- **建议**：把“导入后重建索引”从“触发现有路径”改为方案里独立的一节：要么用直写路径（`sqlite-memory-operations.ts:1001-1037` 的全文索引写入 + 单独排嵌入），要么明说 v1 导入后全文索引立即可用、嵌入延迟到后台任务，并给反向用例（导入后检索评测在嵌入完成前后各跑一次的预期）。

### 中-5｜字节确定性的两个未写明前提（必答问题 2）
- **证据**：占位符 `[密码#xxxxxxxx]` 的 8 位后缀不是值的哈希，而是单次调用内按首见顺序分配的序号（`external.ts:60-74` `sequentialPlaceholderTag`）；不带 `tag` 选项时占位符根本没有后缀（`redaction.ts:317`：`[${label}]`）。
- **问题**：要满足方案 §5-2“遮盖只取决于该条自身文字”，导出必须**每条记忆独立调用一次遮盖、每行新建 tag 函数、`known` 映射不跨行共享**。方案没写这个约束；如果实现为了“密码在 A 条点名、B 条也出现”而共享 known 表，同一行的字节就取决于前面的行——重导出、密封还原、manifest 哈希全部不稳。另外 `recorded_at` 可为 NULL（`0065:19` 用 `COALESCE(recorded_at, updated_at)`），行序键 `recorded_at, id` 要写明 NULL 排在哪个位置。
- **建议**：把“每行独立遮盖、序号从 aaaaaaaa 起”写进格式规范，加一条测试：单独遮一行和整库导出时该行字节相同。

### 中-6｜替换记忆页下载（§2.3）没有 UI 层测试和发布走查安排，且现有测试会破（必答问题 3 + 我的侧重）
- **证据**：现有导出是纯客户端（`memory-page.tsx:2040-2062`），有一个往返解析测试 `apps/control-center/test/memory-interactions.unit.test.ts:1454`（断言 `parseMemoryExport` 解析 `himawari-memories.json`）。方案改成服务端 zip 后这个测试断言的格式不再产生，但 §2.6 没列它；本项目对界面改动的门槛惯例是 memory-interactions 用例 + 发布走查必过场景（I-08 事故、`browser-acceptance-gate.py`），§2.6 全部是 CLI 层测试。
- **建议**：§2.6 补：①重写/删除 `memory-interactions` 里的导出相关用例；②新下载按钮的交互用例（点击→拿到 zip→文件名）；③发布走查加“导出能下载且解得开”场景；④三语文案进 `check:locale` 范围。

### 低-7｜`restricted` 条目正文置 null 在导入端无法落库（推测为设计缺口，机制已证实）
- `memory_records.content_ref NOT NULL`（`0001:399`），载荷必须有内容。“正文置 null”在库里怎么表示（空 payload？只含占位符的 payload？）未定义。要么定义，要么把这条改成“置为固定占位文本并标 masked”。

### 低-8｜读事务外按 ref 取 payload 的边界
- 证实的一半：`content_ref` 有 `ON DELETE RESTRICT`（`0001:399`、`0065:7`），记忆行在快照里时 payload 删不掉，方案“按 ref 取安全”大体成立。边角：读事务结束后若该记忆恰好被删除验证（I-20/MH-4 流程会删记忆再删 payload），再按 ref 取会落空，导出中途失败。建议 payload 读取放进同一个读事务，或对 miss 定义“整体失败并报哪条”。

### 低-9｜待核项可以关掉的：`check:glossary` 存在
- `docs/glossary.md:24`：“这份词表是 npm run check:glossary 的唯一数据来源……新词表项不用改脚本。”方案 §5-4 的“待核”落实为：把“导出包”“密封层”及旧叫法登记进词表即可。

### 低-10｜manifest 的 `schema_migration` 缺少使用端定义（必答问题 4）
- 方案只说记录库迁移号，没说导入端拿它干什么：目标代码版本低于导出库迁移号时拒绝还是升级？本项目已有两次“写死迁移号”事故（I-46、I-61，门槛都是复用 `migration-engine.ts` 的 `LATEST_MIGRATION_SEQUENCE`）。建议：导入端不要手抄数字，直接读迁移引擎，并写明不匹配时整体拒绝。

---

## 业界对标抽验（两条，均与方案一致）
- Claude 导出：官方页证实"Exports include your chats, projects, memory, and account data"、邮件链接 24 小时失效（https://support.claude.com/en/articles/9450526-export-your-claude-data ，原话同上）；且官方明说"Exported data can't be imported into another personal Claude account"——方案“大厂不保证导回、我们必须做导入”的判断成立。
- Letta `.af`：官方文档证实单文件 JSON 含系统提示/记忆块/工具/配置、可导入、"When you export agents with secrets, the secrets are set to `null`"、archival passages 仅在路线图（https://docs.letta.com/v1-sdk/concepts/agent-file/ ）。方案引用属实（URL 重定向到 v1-sdk 路径，内容一致）。

---

## 侧重检查
**走的流程**：最普通的一条——Andy 打开记忆页 → 点导出 → 拿到文件。
- 改前路径：`memory-page.tsx:2024-2079` ExportPanel（客户端拼 JSON）→ 浏览器下载；测试覆盖：`memory-interactions.unit.test.ts:1454`（解析往返）。
- 改后路径：页面按钮 → **服务端导出端点（新，无覆盖）** → 鉴权/owner 校验（新，无覆盖）→ 导出组装（复用 CLI 函数，§2.6 有覆盖）→ 遮盖调用（撞高-1 的门槛）→ **zip 打包与下载（新，无覆盖）** → **三语文案（check:locale 范围，未列）**。
- **结论**：方案 §2.6 的测试全部落在 CLI 数据层，UI 侧从端点下载按钮整条路径零覆盖，也没有像项目惯例那样登记发布走查必过场景（对照 I-08、I-14、I-23 的做法）。文档/规则一致性：方案与 ADR 0019 的关系处理得当（不改迁移包、只加一句说明）；与 `.claude/rules/prompt-prefix.md` 无冲突（见必答 1）。

---

## 如果由我来定，这份方案怎么改
总体结构我认可（jsonl 唯一主数据、派生 Markdown、manifest 哈希、版本化、导入只进空库），对标核实也站得住。需要改五处：
1. **格式定义改为纯逻辑表示**：不序列化任何数据库外键列；线程来源统一进 `provenance[]`（含 `deleted: true` 标记），使“导出→导入→再导出逐字节相同”真实成立（解高-2、高-3①②）。
2. **遮盖章节补两条硬约束并配测试**：走登记过的调用入口（高-1）；每行独立遮盖、序号从 `aaaaaaaa` 起、known 不跨行（中-5），加“单独遮一行 = 整库导出时该行”的字节一致性测试。
3. **索引重建独立成节**：放弃“复用 memory_projection_jobs”的假设，定义导入后全文索引立即可用、嵌入后台补、嵌入调用过预算准入（中-4），并在检索评测里加“嵌入未完成时”的预期。
4. **测试矩阵补 UI 层**：重写 `memory-interactions` 的导出用例，服务端端点 + owner 鉴权 + zip 下载各一条，发布走查加必过场景（中-6）。
5. **补齐两个值的使用端定义**：`schema_migration` 由迁移引擎读取、不匹配整体拒绝（低-10）；`restricted` 条目的导入表示（低-7）；`source_deleted=1` 随 thread provenance 写入（高-3）。

## 必答问题逐条回答
1. **请求开头**：不涉及。导出/导入不发任何对话模型请求，不组装、不改系统提示、工具定义、历史或遮盖结果；替换记忆页下载是纯下载路径改动。唯一例外是导入触发的嵌入调用（独立请求，与对话前缀无关）。发给模型的内容仍只追加——本改动不触碰请求组装。
2. **字节确定性**：方向对、前提缺。方案已定键序和行序，但占位符序号依赖调用方式（每行独立才确定，中-5），`recorded_at` 可空需定排序。落实后同一文字每次导出字节相同；遮盖只依赖本行文字的前提要写成规范并测试。
3. **自动检查与反向用例**：设计的反向用例（篡改清单、关遮盖、删行）真实会失败；但 §2.6-1 照方案现状写必失败（高-2）；UI 路径零覆盖（中-6）；导出遮盖调用会被 `check:egress-redaction` 拦，需先登记（高-1）。`check:glossary` 存在，新词登记即可（低-9）。
4. **每个值的两端**：`format_version`（导出↔导入校验，闭环）；`schema_migration`（**使用端未定义，低-10**）；占位符（导出↔密封还原↔导入↔机密扫描，序号机制决定必须每行独立，中-5；扫描需确认占位符自身零命中）；`〔m:id〕`（导出↔测试 3，闭环）；`source_type='thread'` 行（导入产生，governed deletion 与 `sourceRefs` 消费，**使用端未核对完，高-3③**）；新词（check:glossary 存在，登记即可）；导出遮盖调用点（**与 `check:egress-redaction` 登记冲突，高-1**）。
