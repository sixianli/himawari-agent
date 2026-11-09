## 侧重检查

- **错误路径 / 不可信输入**：`scripts/operations/prod-read.sh` 的 `system-instruction` 用 `O_NOFOLLOW`、`fstat`、固定错误码（`prod-read.sh:108-135`）；`rule-memories` 只读打开、`LIMIT 500`、隐藏 `content_ref` 等列（`prod-read.sh:47-56,85-91`）。这些是基准提交已有的查询，本轮 aa0b 没改；新文档的结论依赖它们。
- **资源耗尽**：`rule-memories` 有 500 条上限（`prod-read.sh:88`），测试覆盖 501 条截断（`test/tooling/prod-read.test.mjs:200-215`）。新文档没有新增无界查询。
- **不可撤销操作**：本轮只改文档和复核记录，没有写生产、没有迁移、没有删除路径。
- **安全**：新文档把生产 `systemInstruction` 原文写进仓库。实际文字是通用操作要求，未看到机密；但仓库里只记录了“同意读两个固定查询”（`.agents/instructions/test-and-production-hosts.md:19`），没有“同意公开写进仓库”的原话，属于授权依据未完全核实（低风险）。
- **规则/文档/代码一致**：`runPolicy.systemInstruction` 最长 16384 字节与 `strict-configuration.ts:1125-1129` 一致；拼接位置与 `production-run-policy.ts:116` 一致；`memory:memory-capture:` 前缀与 `production-memory-capture.ts:585,781` 一致。主要不一致在“恢复后仍会注入”这一句，见下。

## 发现（按严重度）

### 中：`docs/agent-rulebook-inventory.md:158` “从回收站恢复的 rule 类记忆仍会注入”说过头

- **文件:行**：`docs/agent-rulebook-inventory.md:158`（相关行 `:156`）
- **问题**：同一段表格写明回收站那一条 `待确认` 是“是”（`:156`）；按代码，待确认记忆即使恢复成 `active` 也不会进“主人规则”块。该句把“可能注入”写成了“仍会注入”，与该表、M-4、H-13 和现有测试矛盾。新产生的规则也可能是待确认（M-1），同样不会立即注入。
- **证据**：
  - `docs/agent-rulebook-inventory.md:156`：`| 2026-11-02 | trashed | 是 | ...`
  - `docs/agent-rulebook-inventory.md:158`：`以后新产生或从回收站恢复的 rule 类记忆仍会注入。`
  - `packages/application/src/services/owner-profile-service.ts:100`：`if (attributes.supersededBy !== null || attributes.tentative === true) return false;`
  - `packages/application/src/services/owner-profile-service.ts:164`：`memory.status === "active" &&`
  - `packages/application/src/services/durable-memory-service.ts:360`：`nextRecord(current, { status: "active" }, this.options.now()),`（`recover` 只改状态，不清 `tentative`）
  - 另外 `owner-profile-service.ts:149-152,165-167,169` 还分别受 `maxClassification`、`currentlyValid`、`validTo`、主人“不带”设置限制。
  - 反向测试已存在：`packages/application/test/owner-profile-service.unit.test.ts:178` 的 `[PA-2] never puts a tentative memory into the profile block`。
- **建议**：改成“从回收站恢复成 `active`、且不是待确认、未被取代、未过期、分类允许、没有被主人设为‘不带’的 `rule` 类记忆，才会按 M-4/M-5 注入；表中这条 `trashed` 恢复后仍会因待确认而不注入，除非先确认。”

### 低：`docs/agent-rulebook-inventory.md:217` 对 C-1 的旧说法已过期

- **文件:行**：`docs/agent-rulebook-inventory.md:217`
- **问题**：C-1 已经写入了生产 `systemInstruction` 原文（`:170`），但 G 节仍把 C-1 的问题写成“生产配置里实际写了什么”。现在 C-1 留在 19 条里的真实原因是“出处仓库内查不到”，不是内容没读。
- **证据**：
  - `docs/agent-rulebook-inventory.md:170`：C-1 行已含“原文只有一行：「修改或删除文件前先确认路径和内容；……」”
  - `docs/agent-rulebook-inventory.md:217`：`- 配置：C-1（生产配置里实际写了什么）、C-7（除冻结外的运行参数）。`
- **建议**：改成 `C-1（原文已读，出处仓库内查不到）`，或直接写 `C-1（出处）`。

### 低：`docs/agent-rulebook-inventory.md:158` “其他设置没有查”容易与 C-1 已读冲突

- **文件:行**：`docs/agent-rulebook-inventory.md:158`、`:170`
- **问题**：C 节说“其他分类的记忆和其他设置没有查”，但 C-1 明确写了已经读取生产配置的 `systemInstruction`。如果“其他设置”指除 rule 记忆外的所有设置，这句话与 C-1 矛盾；作者大概率想说的是“除 C-1 外没有逐项查其他设置”。
- **证据**：
  - `docs/agent-rulebook-inventory.md:158`：`这次只查了 rule 类，其他分类的记忆和其他设置没有查……`
  - `docs/agent-rulebook-inventory.md:170`：`2026-11-09 经 Andy 授权只读，原文只有一行……`
- **建议**：改成“除 C-1 的 `systemInstruction` 外，其他设置没有查”。

### 低/未核实：writer 对“ds-4”的授权解释超出仓库记录

- **文件:行**：`docs/agent-rulebook-inventory.md:170`、`.agents/instructions/test-and-production-hosts.md:19`
- **问题**：作者说“Andy 同意的就是补进清单”。仓库规则只记录“Andy 2026-11-09 在项目线程里同意读这两个固定查询”，没有“同意把原文写进仓库”的记录。把生产原文写进“原文”列符合清单目的，方向可以接受；但“Andy 同意补进清单”这句话在仓库内无法核实，属于推断。
- **证据**：
  - `.agents/instructions/test-and-production-hosts.md:19`：`Andy 2026-11-09 在项目线程里同意读这两个固定查询，范围不扩大到配置文件的其他内容`
  - `docs/agent-rulebook-inventory.md:170`：`2026-11-09 经 Andy 授权只读，原文只有一行……`
- **建议**：在提交说明或文档出处里引用 Andy 同意“补进清单”的原话；如果只有读授权，就把说法收紧为“经授权读取后记录在清单里”。

## 读代码证实的 / 推测的

**读代码证实：**
- `memory:memory-capture:` 前缀正确：`production-memory-capture.ts:781` 生成 `memory-capture:${runId}`，`:585` 生成 `memory:${generation}:${ordinal}`；`packages/domain/src/identifiers.ts:39` 允许冒号。
- `deleted_verified` / `trashed` 不会注入：`owner-profile-service.ts:164` 要求 `status === "active"`，`sqlite-memory-operations.ts:942-953` 的 `listActive` 也只查 `active`。
- 待确认、过期、被取代、分类不允许、主人设为“不带”都会阻止注入：`owner-profile-service.ts:100,149-152,165-169`。
- 从回收站恢复只改状态为 `active`/`archived`，不清 `tentative`：`durable-memory-service.ts:349-364`、`sqlite-governed-deletion.ts:425-432`；恢复成 `archived` 也不会注入。
- `rule-memories` 查询字段与文档说明一致：有 `updated_at`、`inference`、`classification`、`status` 等，不含 `content_ref`（`prod-read.sh:85-91`）。
- `systemInstruction` 最长 16384 字节、拼接位置与文档一致：`strict-configuration.ts:1125-1129`、`production-run-policy.ts:116`。

**推测 / 未核实：**
- 生产库里具体 3 条记录的状态、日期、`private`、`inference=false`、编号前缀是否确实如表格所写：生产数据不在仓库，无法从代码核实。
- `systemInstruction` “只有一行”是否确实没有换行：生产配置不在仓库，未核实。
- C-2 的称呼在生产 `owner_preferences` 里是否已填：文档已声明没有查，未核实。
- 查询没有按 `owner_id` / `agent_id` 过滤（`prod-read.sh:85-91`）；如果生产库有多个 owner/agent，文档的“生产库里只有 3 条”是整库计数。生产大概率单 owner，影响低，但未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮 diff 只改 `docs/agent-rulebook-inventory.md` 和复核记录；没有改 `packages/prompt-catalog/`、`production-run-policy.ts`、`owner-profile-service.ts` 或任何运行时代码。文档不会进入 Himawari 的模型请求。系统提示、工具定义、历史消息、遮盖结果都没有变化；仍然只在末尾追加，每轮会变的值仍然只在最后一条消息里（依据 `.claude/rules/prompt-prefix.md` 第 4、6、10、11 条）。文档里记录的 `systemInstruction` 原文不是生产配置本身，也没有被代码读取。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。这是静态文档，没有运行时序列化；新增的 ID、状态、`updated_at` 日期都是固定字符，不参与任何请求组装，也不依赖前后文、时间或无序集合。

3. **有没有对应的自动检查，反向用例会失败吗？**
   - 查询本身有测试：`test/tooling/prod-read.test.mjs:179-216` 覆盖只读、隐藏原文、`LIMIT 500`、501 条截断；`:287-293` 覆盖拒绝多余参数。这些反向用例去掉对应保护会失败。
   - 文档的新事实没有自动检查：`check:markdown-tables` 之类只检查表格形状和链接，不会验证“3 条都已删除”“恢复后会注入”是否正确。
   - 现有 `owner-profile-service.unit.test.ts:178` 的 PA-2 反向用例正好证明“待确认记忆不注入”；如果给新句子的无条件“仍会注入”写测试，它会失败。因此这句不是“缺测试”，而是与已有测试相反。
   - 我未运行 `validate_docs.py --strict` 或 `npm run check`，只读代码和测试文件；作者说文档严格校验有 12 个与 main 相同的旧错误，这一点未核实。

4. **改动涉及的每个值，两端都能接受吗？**
   - `memory:memory-capture:`：产生端 `production-memory-capture.ts:585,781`，校验端 `identifiers.ts:39` 允许 `:`；可以接受。
   - `deleted_verified` / `trashed`：产生端状态机允许（`sqlite-memory-operations.ts:631-643`），消费端 `owner-profile-service.ts:164` 只接受 `active`；因此文档“当前这 3 条不注入”正确。
   - `private`：`PROFILE_CLASSIFICATIONS` 接受 `private`（`owner-profile-service.ts:17`），但还受 `maxClassification` 上限；文档没有提这一点。
   - `rule` 类别：消费端 `owner-profile-service.ts:187` 只取 `category === "rule"`；可以接受。
   - `updated_at`：查询端和更新端都存在该字段；可以接受。
   - `runPolicy.systemInstruction`：解析端上限 16384、拼接端使用它；可以接受。
   - **不通过的一端**：文档说“恢复的 rule 类记忆仍会注入”，但消费端还会因 `tentative`、`validTo`、`maxClassification`、主人“不带”等条件拒绝；这正是 I-73 式“只看了清单/改动，没核对消费端校验”的缺口。

## 作者说法核对

- “第 1 轮意见已改，只动了 C 节”：增量 `33d600c9..aa0b38f5` 确实只改了 `docs/agent-rulebook-inventory.md` 的 C 节段落，另外新增了 `.agents/reviews/pr-329/` 复核记录；从文档内容看属实。
- “不能断定聊天里主人规矩只有 C-1（已交代 C-2）”：这个收紧是对的，C-2 在 `owner-profile-service.ts:279` 会作为规则块第一行注入。
- “来源是从编号前缀推断”：属实，`production-memory-capture.ts:585,781` 支持该前缀；文档也明确写了“这是从编号推断的”。
- “状态说明的日期取自 `updated_at`”：查询确实返回 `updated_at`（`prod-read.sh:88`），更新/恢复路径也维护它；但生产具体日期未核实。
- “不会再注入改成按当前状态”：方向正确；“当前 3 条不会注入”有代码依据。问题在下一句“以后恢复的仍会注入”又变成了无条件保证。
- “ds-4（原文写进仓库）判为不成立”：方向上可以接受——清单的“原文”列本来就要填，旧 C-1 行也写着“待读取后补全”；但仓库里只有读授权，没有“同意写进仓库”的原话，“Andy 同意的就是补进清单”这一点未核实。
