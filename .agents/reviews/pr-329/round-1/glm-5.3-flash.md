Diff 是纯文档改动。现在核对代码里的记忆状态语义、prod-read.sh 的查询、以及 systemInstruction 的处理。
查询语句读到了。关键发现：`rules` 查询选择的列里没有来源/出处列，但有 `inference` 和 `tentative`。现在核对 memory_records 的 schema 和注入逻辑。
注入过滤逻辑已确认。再核对 C-1 的 16384 字节上限和 systemInstruction 的拼接位置，以及清单里 C 节标题锚点。
核对文档一致性测试是否存在，以及 prod-read 测试对两个查询的覆盖。
## 复核结论

改动范围核实：`git diff` 显示本次提交只改了 `docs/agent-rulebook-inventory.md`（4 处：先看结论加一行、C 节新增生产记忆表和结论句、G 节一行、H 节一行），无代码改动。

### 读代码证实的（与作者说法相符的部分）

- 状态语义没写错：`deleted_verified` 是终端态、删除经 provider 清理核实后才进入（`packages/domain/src/durable-state.ts:410-411`，转移表 `deletion_pending → deleted_verified`，无出边）；`trashed` 是回收站、可恢复。文档里「删除并核实」「在回收站」的说明正确。
- 「不会再有 rule 类记忆注入主人规则块」有代码支撑：注入筛选要求 `memory.status === "active"`（`packages/application/src/services/owner-profile-service.ts:164`），且待确认直接排除（同文件 :100）。三条记忆是 trashed/deleted_verified，无论如何进不了。
- 「待确认/推断得来/使用次数」对应的列真实存在：`tentative`（migration 0054:1）、`inference`、`importance_permille`、`confidence_permille`、`use_count`（migration 0052、0001_initial_product_schema.sql:402-403），且 `rule-memories` 查询确实选了这些列（`scripts/operations/prod-read.sh:88`）。
- C-1 的「最长 16384 字节」属实：`packages/platform-node/src/strict-configuration.ts:1128-1129`；systemInstruction 拼在固定身份提示词后属实：`apps/agent-service/src/production-run-policy.ts:116`。
- 「查询不读原话」属实：查询不选 `content_ref`，测试也断言了这一点（`test/tooling/prod-read.test.mjs:183`）。
- 授权范围与规则一致：`.agents/instructions/test-and-production-hosts.md:19` 写明 Andy 2026-11-09 只同意这两个固定查询、「范围不扩大到配置文件的其他内容」，与 C-1、H 节「配置文件的其余部分没有读」一致；`system-instruction` 查询也确实只读 `runPolicy.systemInstruction` 一个字段（prod-read.sh:131）。
- 锚点 `[C](#memory-rules)` 有效：`docs/agent-rulebook-inventory.md:136` 有 `<a id="memory-rules"></a>`。
- 先看结论、C 节、G 节、H 节四处新说法互相一致，与 M-4 的注入条件一致。

### 问题（按严重度）

**中｜docs/agent-rulebook-inventory.md:158（C 节结论句）**
问题：「聊天里主人自己写下的规矩，目前实际生效的只有 C-1 那一行系统指令」说过头了，有两处偏差。
证据：其一，C-1 不是「聊天里」写下的，是 `/etc/himawari/config.json` 里的配置（prod-read.sh:8、C-1 行自己也这么写）。其二，主人设置的称呼会作为「主人规则」块第一行注入：「主人在设置里填写的称呼是「…」」（`owner-profile-service.ts:277-281`），对应清单 C-2（「硬（注入）」）——这也是主人自己写的、会生效的文字，被「只有 C-1」忽略了。生产里是否填了称呼未核实，但清单把 C-2 标为硬注入，就该在此句中交代。
建议：改为「主人亲手写下的规矩里，进聊天上下文的只有 C-1 一行系统指令，以及 C-2 的称呼（若已填写）」。

**低｜docs/agent-rulebook-inventory.md:157**
问题：「三条都来自对话后的记忆提取」是查询输出推不出来的结论。
证据：`rule-memories` 查询只选 `id, status, tentative, classification, importance_permille, confidence_permille, inference, recorded_at, updated_at, valid_to, superseded_by, use_count`（prod-read.sh:88），不含 `source_thread_id`，也不读 `memory_provenance`（0001_initial_product_schema.sql:410-416，有 `source_type`）；且存在其他写入方（如 `production-reminder-writer.ts:223` 也写 `inference: false` 的记忆，0057 migration 有导入批次）。
建议：把这句改成「来源未核实（查询不含来源列）」，或另获授权后补一次带 `source_thread_id` 的只读查询。

**低（信息）｜docs/agent-rulebook-inventory.md:154-156、168**
问题：生产数值本身（3 条、各状态、tentative 0/1/1、use_count 6/0/0、指令原文那一行）仓库里没有原始输出可对照，全部未核实；但表格每一列都能对上查询选的列，schema 也支持，无结构性矛盾。
建议：如需可复核，可把两次查询的原始 JSON 输出脱敏后存进仓库（比如 `test/qualification/evidence/` 之类的目录）。

### 侧重检查

走的流程：主人在聊天里说一条规矩 → 对话记忆提取（`production-memory-capture.ts:453`，rule 类非显式默认 tentative）→ 存入 `memory_records`（category='rule'）→ `owner-profile-service.ts:162-187` 按 status=active、分类、非 tentative、非被取代筛选 → 拼进 owner-rules 块。三条生产记忆在这条流程的筛选处被挡住，与文档结论一致。
测试覆盖：本次改动是纯文档，无测试也不可能有用例；它依赖的 `prod-read.sh` 两个查询有测试覆盖（`test/tooling/prod-read.test.mjs:179-293`：只读打开、LIMIT 500、不选 content_ref、多余参数返回 64）。仓库没有任何针对 `agent-rulebook-inventory.md` 的自动检查（grep 无结果）——文档结论与生产库的一致性只能靠人工复核，属已知局限。
未核实：生产库实际返回的行、生产配置原文（作者也声明原始输出只在线程里）。

### 必答问题

1. **不会。** 纯文档改动，diff 只有一个 md 文件，不触碰系统提示、工具定义、历史消息或遮盖；「只追加」规则无从谈起，也不受影响。
2. **不会。** 没有代码、配置、序列化改动；文档不进入模型请求。被记录的 systemInstruction 原文在代码里的消费点（`production-run-policy.ts:105-107` 的 operationKey 哈希）本次未动。
3. **部分。** 改动本身（文档）没有自动检查；它依据的两个查询有测试且反向用例（多余参数拒绝）确实会失败（prod-read.test.mjs:287-293）。但「清单写的内容与生产库一致」没有任何检查。
4. **逐个核对通过，除一处**：状态名与 `durable-state.ts:393` 枚举一致；16384 与 `strict-configuration.ts:1128` 一致；「待确认/推断/使用次数」对应真实列；授权日期与 `.agents/instructions/test-and-production-hosts.md:19` 一致；指令原文只被文档引用、无代码消费方。唯一没核对上的是「来源=对话后的记忆提取」——查询没有来源列，见上面低严重度问题。
