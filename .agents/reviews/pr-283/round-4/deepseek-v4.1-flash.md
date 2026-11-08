## 结论

第 3 轮增量（`ff420704..9f8357e3`）只改了三处实质内容：摘要来源表过滤 `gmail_message_id`、ADR 0162 文字、一个 HTTP 回归用例。核心修复方向正确：不带编号先到、带编号后到时，摘要不再因编号变化，因此能走“重复 + 补编号”。没有发现高严重度的、读代码可证实的缺陷；下面按风险排列，含一个需要合并前确认的条件性风险。

## 问题（读代码证实）

### 中（条件性，流程风险）— 原地改写已存在的迁移 0079
- 文件：`packages/persistence-sqlite/src/migrations/0079_muse_intake_gmail_message.sql:1-5`；`packages/persistence-sqlite/src/migration-engine.ts:761-775`
- 问题：0079 在本 PR 内被改过（`git show ff420704` 确认由“只查长度”改成“长度 + 字符集”）。作者说它从未在任何持久环境应用。若这个前提不成立，升级后迁移账本里的 digest 与定义不一致，会以 `SQLITE_MIGRATION_DIGEST_MISMATCH` 拒绝启动；而且旧的弱约束会留在库里。
- 证据：`migration-engine.ts:761-765` 比较 `definition.digest !== record.digest`，不一致即抛错；`migration-engine.ts:686-692` 也校验 SQL 与定义摘要。
- 建议：合并前确认没有任何本机/开发/预发库停在序列 79；若有，不能改 0079，应新增一条迁移修补。
- 注：这是“如果前提为真就没事”的条件性风险，不是已证实的缺陷。

### 低 — 晚补编号不更新已存的 `sources`，且摘要输入与库存来源表不一致
- 文件：`apps/agent-service/src/production-muse-intake.ts:276-278`、`:300`；`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:227-231`
- 问题：摘要用的 `parts.sources` 过滤掉了 `gmail_message_id`，但落库的 `write.sources` 仍保留它；后到编号走 `fillGmailMessage` 时只更新 `gmail_message_id` 列，不更新 `sources` JSON。于是“后来补上编号”的条目会出现“列有值、来源表没有该列”的不一致；若将来有人用库存 `sources` 重算摘要，会算不回原值。
- 证据：`production-muse-intake.ts:276-278` 仅对 `parts` 过滤；`:300` 写库仍是 `reader.sources`；`sqlite-muse-intake-operations.ts:228-230` 只 `SET gmail_message_id = ?`。
- 建议：补编号时一并把 `sources` 里的 `gmail_message_id` 写上（来源可取该次输入的 source），或在设计上让库存来源表也不含该列，消除两套输入。

### 低 — 重发带来不同编号时静默忽略，无可追溯记录
- 文件：`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:281-298`
- 问题：摘要不含编号，且补编号只在 `gmail_message_id IS NULL` 时执行；Muse 若后来用同一自然键发来“改正后的编号”，会被当成重复并静默丢弃，不写冲突、不记日志、也没有纠正入口（ADR 已承认“没有纠正入口”）。错误配对的记录无法追溯是哪一批带进来的。
- 证据：`fillGmailMessage` 的 `AND gmail_message_id IS NULL`（`:228-230`），`filled.changes === 1` 才补配对（`:291-297`），没有任何 else 分支记录“编号不同”。
- 建议：当库存编号非空且与本次不同时，至少记一个计数/日志（不要覆盖），便于发现 Muse 侧编号漂移和事后纠正。

### 低 — 字符规则三处重复，其中两处 TS 可共享
- 文件：`apps/agent-service/src/production-muse-intake.ts:67`；`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:41`；`packages/persistence-sqlite/src/migrations/0079_muse_intake_gmail_message.sql:4`
- 问题：作者说三处重复、迁移 SQL 无法共享常量属实。但两个 TS 位置完全可以共享一个定义；一旦漂移，可能出现解析通过而存储抛错，导致整批 500 而不是按非法条目计数。
- 建议：把 `^[A-Za-z0-9_-]{1,256}$` 提到 `packages/application/src/ports/muse-intake.ts` 导出，解析与存储都引用；SQL 侧保留并在测试里对齐。

### 低 — 测试覆盖小缺口
- 文件：`apps/agent-service/test/production-muse-intake.unit.test.ts:108-115`；`test/integration/muse-intake-http.test.ts:328-337`
- 问题：摘要“带/不带编号得到同一 digest”“不同编号仍是同一 digest”只有 HTTP 集成用例覆盖，没有更快的解析层单元用例；`unit.test.ts` 现有用例只验证同样文本 digest 相同。
- 建议：补一条 Layer-0：同一条目带与不带 `gmail_message_id` 的 `write.contentDigest` 相等；换一个编号也相等。

## 侧重检查

- 非法/不规范输入：编号长度、字符均在解析层（`production-muse-intake.ts:233-239`、`:67`）、存储层（`sqlite-muse-intake-operations.ts:41-45,87`）、数据库（`0079:1-5`）三处拒绝；空串/257 字符/含空格均有测试（`muse-intake-migration.contract.test.ts:100-103`、`muse-intake-http.test.ts:309-326`）。整条提醒在解析失败时直接 `rejected++`，不会落到草稿，也不会先封存载荷，未发现孤立 payload。✅
- 安全/SQL：所有新 SQL 均为参数化，编号正则排除引号、分号、空格。✅
- 资源耗尽：批上限 100 条、请求体 262144 字节（`production-muse-intake.ts:23-24`），编号上限 256；重复路径每条最多两次 UPDATE，未发现放大点。✅
- 不可撤销操作：补编号是单向且无审计（见上“低”），ADR 已接受“无纠正入口”，但“无任何记录”可以低成本改善。
- 跨租户：补编号与周报查询都带 `owner_id/agent_id`（`sqlite-muse-intake-operations.ts:229-234`、`calibration/src/index.ts:358-359`），不会串号。✅
- 文档/代码一致：ADR 0162 的“不进摘要/整条拒收/占位补编号/已有不覆盖”与代码一致；ADR 0154、运行手册的说明也一致。唯一不一致风险是迁移 0079 原地改写的应用前提（未核实）。

## 逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动没有触及提示词目录、工具定义、历史存储或出口遮盖；Muse 数据只进入所有者侧快照/周报（`apps/agent-service/src/production-observation.ts:170-234`）和数据库，`gmailMessageId` 没有进入任何发给模型的消息。因此仍满足“只在末尾追加、每轮变化值只在最后一条消息”的规则（`.claude/rules/prompt-prefix.md:27-35`）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
这条增量本身不会。新的摘要输入是 `Object.entries(reader.sources)` 的过滤结果，键顺序来自代码固定的字段处理顺序，不依赖 Muse 的 JSON 键顺序，也不含时间/随机；同一输入每次摘要字节一致。唯一的隐患是上条“库存 `sources` 与摘要输入不对称”，若将来从库存重算摘要会不一致，但当前没有这种代码路径。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有。主修复由 `test/integration/muse-intake-http.test.ts:328-337` 覆盖：先无编号、后带编号，断言 `duplicate:1, conflict:0` 且编号被补上。按代码推演，去掉 `production-muse-intake.ts:276-278` 的过滤后，第二次的摘要会包含 `sources.gmail_message_id`，与库存摘要不同，结果变成 `conflict:1`，该用例必然失败——这就是反向用例。受工具限制我无法实际执行测试，结论来自逐行推演。非法编号、超长编号、存储拒绝分别有 HTTP/存储/迁移测试（`muse-intake-http.test.ts:309-326`、`muse-intake-store.test.ts:371-379`、`muse-intake-migration.contract.test.ts:100-103`）。缺口是缺少解析层“带/不带编号 digest 相同”的单元用例。

**4. 每个新值的使用端都能接受吗？**
逐端核对如下：
- `gmail_message_id` 输入：解析层正则+上限（`production-muse-intake.ts:67,233-239`）→ 存储校验（`sqlite-muse-intake-operations.ts:41-45,87`）→ 列 CHECK（`0079:1-5`），规则一致，接受。
- `gmailMessageId` 读写：插入参数（`sqlite-muse-intake-operations.ts:219,268`）、列表投影（`:354`）、评价时读取（`:480-510`）都接受。
- `paired_message_id`：列 CHECK 只有长度 1–256（`0073:1-2`），新编号是其子集，接受；周报按它查 `proactive_processed_messages.message_id`（`calibration/src/index.ts:353-359,402-409`），而该列由 Gmail 源写入 API 返回的 `message.id`（`packages/platform-node/src/gmail-source.ts:179-190`），两端是同一个 Gmail `id`；`message_id` 的 CHECK 也只有长度（`0069:103`），接受。
- `intake_item_key`：补配对用的 `museIntakeItemKey(kind, naturalKey)`（`application/src/ports/muse-intake.ts:157-159`）与评价插入、列表 JOIN 的拼接方式一致（`sqlite-muse-intake-operations.ts:296,360,487`），接受。
- `SUPPORTED_SCHEMA_MAX=79`（`scripts/operations/workspace-lifecycle-audit.mjs:5`）与 `LATEST_MIGRATION_SEQUENCE`（由含 79 的清单推出，`migration-engine.ts:627-636`）一致，迁移契约测试的序列列表也已加到 79，接受。

**未核实**：作者“0079 从未在任何持久环境应用”的事实前提，以及测试的实际执行结果（工具限制，无法运行测试）。
