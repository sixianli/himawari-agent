## 变更范围

`git show --stat 33d600c` 证实：只改了 `docs/agent-rulebook-inventory.md`（1 file，+13/-4），没有代码、测试或运行时配置改动。

## 侧重检查

- **只读查询与不可信输入**：`prod-read.sh` 仍是固定查询、无参数、数据库 `readOnly: true`；`system-instruction` 用 `O_NOFOLLOW`、`fstat` 检查普通文件和权限，未发现本次改动引入新的输入面或命令注入面。
- **记忆状态与注入资格**：核对 `packages/domain/src/durable-state.ts`、`durable-memory-service.ts`、`owner-profile-service.ts`。`trashed` 可恢复为 active，`deleted_verified` 是终态；规则块只接受 `status === "active"`。文档对这两个状态的含义没有写反。
- **不可撤销操作**：`deleted_verified` 不可恢复；`trashed` 可恢复。另发现本次把生产 `systemInstruction` 原文写进 git 历史，这一发布动作本身不易撤销。
- **资源耗尽**：`rule-memories` 有 `LIMIT 500`，没有循环或大批量读取问题。
- **规则、文档与代码一致性**：发现下面几处“结论说过头”或缺少可复核依据。
- **未核实**：生产实际返回的 3 条记录的值、`systemInstruction` 是否真的只有一行、原始查询输出本身，仓库里都看不到。

## 问题（按严重度）

### 1. 中 — `docs/agent-rulebook-inventory.md:158`

**问题**：“聊天里主人自己写下的规矩，目前实际生效的只有 C-1 那一行系统指令”说得过头。固定查询只查 `category = 'rule'`，不能代表所有“主人规矩”；而且 C-1 是生产配置，不是“聊天里”写下的。

**证据**：
- 文档原文：`按状态判断，不会再有 rule 类记忆注入「主人规则」块；聊天里主人自己写下的规矩，目前实际生效的只有 C-1 那一行系统指令`
- `scripts/operations/prod-read.sh:88` 的查询是：`... FROM memory_records WHERE category = 'rule' ...`，只覆盖 `rule` 分类。
- `packages/application/src/services/owner-profile-service.ts:193-201` 显示，非 `rule` 分类的 `identity`、`preference`、`relationship`、`goal`、`project` 也会进入档案块；`:187` 才单独处理 `rule` 分类。也就是说，一条被模型判成 `preference` 的主人规矩仍可能通过档案块注入。
- 文档自己在 `:144` 的 M-1 和 `:201` 的 F-2 都承认：一条话会不会变成 `rule` 由模型决定。因此“rule 记忆为空”不能推出“聊天里主人规矩只有 C-1”。

**建议**：把结论限定为“本次 `category='rule'` 的只读查询里没有 active 记录；其他分类和其他设置未查，不能据此断定聊天里的主人规矩只有 C-1”。

### 2. 中 — `docs/agent-rulebook-inventory.md:158`

**问题**：“三条都来自对话后的记忆提取”无法由这次使用的固定查询证明。查询不返回来源字段；手工新建和导入也能产生 `rule` 类、`inference=false`、`private` 的记忆。

**证据**：
- `prod-read.sh:88` 只取 `id, status, tentative, classification, importance_permille, confidence_permille, inference, recorded_at, updated_at, valid_to, superseded_by, use_count`，没有 `source_thread_id` 或来源类型。
- `apps/agent-service/src/production-memory-control.ts:639-647` 的手工新建路径设置 `sourceThreadId: null`、`inference: false`，并接受传入的 `category`（可以是 `rule`）。
- `production-memory-control.ts:731` 的导入路径生成 `memory:import:${batchId}:${ordinal}`，同样可以落成 `rule`。
- 因此，除非作者是根据 `id` 前缀（例如 `memory:memory-capture:...`）判断的，否则从查询输出本身不能区分“对话后提取”“手工新建”“导入”。文档没有写这个依据。

**建议**：如果依据是 `id` 前缀，请在文档里写明；否则删掉这句，或改成“从元数据看不出与手工/导入规则记忆的区别”。

### 3. 低 — `docs/agent-rulebook-inventory.md:158`

**问题**：“不会再有 `rule` 类记忆注入”是把当前快照说成了未来保证。M-1 本身说每条主人消息后都可能产生新的规则记忆；`trashed` 那条也可以恢复为 active。

**证据**：
- 文档 `:144` 的 M-1：`每条主人消息之后，由模型判断有没有“对 Himawari 的要求”，有就写成 rule 类候选`。
- `packages/application/src/services/durable-memory-service.ts:349-364` 的 `recover` 允许 `trashed`/`archived` 回到 `active`；`:354`：`if (current.status !== "trashed" && current.status !== "archived")`。
- 当前这 3 条确实不会注入：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:948` 的 `listActive` 只查 `status = 'active'`，`owner-profile-service.ts:164-167` 又过滤一次。
- `deleted_verified` 确实是终态：`packages/domain/src/durable-state.ts:410-411` 是 `deleted_verified: new Set()`。

**建议**：改成“这 3 条按当前状态都不会注入；以后新产生或恢复的 active 规则记忆仍会注入”。

### 4. 低 — `docs/agent-rulebook-inventory.md:170`

**问题**：把生产 `runPolicy.systemInstruction` 原文直接写进仓库文档，扩大了授权读取之外的暴露面。授权文字只说可以“读这两个固定查询”，没有明确说可以把原文发布到 git。

**证据**：
- 文档原文：`原文只有一行：「修改或删除文件前先确认路径和内容；会覆盖或删除大量内容的操作，先向用户说明。」出处仓库内查不到`
- `.agents/instructions/test-and-production-hosts.md:19` 的授权范围是：`Andy 2026-11-09 在项目线程里同意读这两个固定查询，范围不扩大到配置文件的其他内容`。
- 这条指令本身不像密码或密钥，但 git 历史不可撤回；如果以后该字段含更敏感内容，这个先例有风险。

**建议**：确认 Andy 的同意是否包含“把原文写进仓库”；如果不包含，改成转述或摘要，只保留“仅一条文件操作确认/大量删除前说明”的描述。

### 5. 低（未核实）— `docs/agent-rulebook-inventory.md:154-156`

**问题**：表里的“2026-11-06 删除并核实”“2026-11-08 删除并核实”没有说明取自哪个字段。查询同时返回 `recorded_at` 和 `updated_at`，文档的“记录日期”明显用 `recorded_at`，但“状态说明”里的日期看起来来自 `updated_at`；如果读者误以为都是 `recorded_at`，日期就对不上。

**证据**：`prod-read.sh:88` 同时选取 `recorded_at, updated_at`；表格只列了“记录日期”，没有列 `updated_at`。

**建议**：在表头或注释里写明“状态说明日期取自 `updated_at`”；如果不确定 `updated_at` 就是删除核实时间，标“约”或删掉具体日。

## 读代码证实 vs 推测

**读代码证实的：**
- 本次只改文档。
- `rule` 查询只覆盖 `category = 'rule'`，不返回来源字段。
- 手工新建和导入都能创建 `rule` 类记忆，且 `inference: false`、`sourceThreadId: null`。
- 规则块/记忆检索只接受 `status === "active"`。
- `trashed` 可恢复为 active，`deleted_verified` 是终态。
- `systemInstruction` 最大 16384 字节，且拼在 `HIMAWARI_IDENTITY` 之后。
- 仓库里找不到这条生产 `systemInstruction` 原文，说明它不是仓库里的测试夹具值。

**推测/未核实：**
- 生产实际返回的 3 条记录及其日期、重要度、把握、使用次数是否就是表里这些值。
- `systemInstruction` 在读取时是否确实只有一行。
- 这三条记忆是否真的来自对话后的提取（只有 `id` 前缀可能提供线索）。
- 把生产 `systemInstruction` 原文写进仓库是否在 Andy 的授权范围内。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次没有改系统提示、工具定义、历史消息或遮盖逻辑；`grep agent-rulebook-inventory` 也没有发现运行时代码引用这份文档。发给模型的内容仍然只在末尾追加；按 `prompt-prefix.md:27-28`，每轮变化的记忆/资料块仍在最后一条用户消息里。C-1 记录的 `systemInstruction` 属于系统提示，是冻结内容，不是每轮变化的值；本次也没有改它的值。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。文档文字不进入模型请求；没有新增依赖前后文的遮盖、时间字段或无序集合。唯一涉及“顺序”的是 `prod-read.sh` 的 `ORDER BY recorded_at DESC, id`，那是只读查询的确定性排序，和模型请求序列化无关。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   没有针对新结论的自动检查。现有 `test/tooling/prod-read.test.mjs` 只验证查询形状、参数拒绝、`LIMIT 500`、不读 `content_ref`、配置文件的 `O_NOFOLLOW` 等，不验证生产数据，也不验证文档里的“3 条/没有生效/来源”结论。提交说明写的是只跑了 `check:glossary`；适用于新表格的 `check:markdown-tables` 没有在提交说明里运行（我核对了新旧表格列数，都是 7 列，结构应能通过）。如果文档里的生产数字写错，没有任何反向用例会失败。建议把脱敏后的查询输出作为任务附件/记录保存，或明确标注这是“一次性、未经自动检查的只读快照”。

4. **每个被改动/新增的值，使用它的地方都能接受吗？**
   - `deleted_verified`、`trashed`：是 `memory_records.status` 的合法值（`0001_initial_product_schema.sql:398`），产生方是 `durable-memory-service`/domain transition；使用方 `owner-profile-service.ts`、`durable-memory-service.ts` 的检索都要求 `active`，`recover` 只接受 `trashed`/`archived`，`deleted_verified` 为终态。两端一致，文档的状态说明正确。
   - `rule` 分类：schema 的 CHECK 里包含 `rule`（`0052_memory_engine.sql:1`），规则块只取这个分类，能接受。
   - `private`：`PROFILE_CLASSIFICATIONS` 包含 `private`，但因为这 3 条不是 active，实际不会注入；文档的“不会注入”结论成立。
   - `systemInstruction`：`strict-configuration.ts:1128-1129` 接受最长 16384 字节，`production-run-policy.ts:116` 把它拼在固定身份提示词之后，文档的“拼在固定身份提示词后面”与代码一致。
   - **不一致的点**：文档写的来源“对话后的记忆提取”不是查询返回的字段；手工新建/导入路径也能产生同样元数据的 `rule` 记忆。这一项没有通过“产生方→使用方”的双端核对，是本次最需要修正的地方。
