# 审核结论

先说总体：方案的代码事实核对基本准确（我逐条对了引文，仅两处行号小偏），四块的优先级和“先接真实数据来源”的判断我认同。但方案有 3 个会在实施时翻车的问题：C 的“改了几个文件”定义在现记录的数据下算不出来；A 的提议编号是内容哈希，“不要”的拒绝状态会和重复提议相撞；B 的“任何一项不过就保持停用”和现状态机的实际落点不符。下面按严重度排列。

---

## 证实的（对着代码或一手来源核过）

### 高 1：块 C 的“改了几个文件”定义，现有记录的数据算不出来
- 证据：
  - `packages/application/src/services/workspace-changes.ts:25-32`：判定“修改”用的是 `sameEntry`，比的是 `kind/size/modifiedAtNs/inode`，**不是内容**。文件被 touch 过但内容没变也会记成 modified；反过来，“内容和当时不同”这个说法在记录里没有对应物。
  - ADR 0097 决定 3（`docs/adr/0097-bash-writes-workspace-with-change-ledger.md:45-46`）原话：“只对新建和修改的文件计算 SHA-256 指纹”，记录内容包括“每个改动条目**前后的大小和时间**”——**before 状态没有内容摘要**。
  - 所以“删掉后又恢复原样的不算”无法按内容判定：恢复后的文件和对话开始前的版本之间没有可比的内容摘要，只有大小和修改时间（inode 必然变了）。
- 建议：把定义改成从记录可计算的净效果——“去重路径后，最后一条记录为删除、且现在不存在的算删除；最后一条为新建/修改、现在仍在的算修改”，不承诺按内容比较；或者给留档补记 before 摘要，且只对新增数据生效。方案里“内容和当时不同”这句要先改，否则反向用例（“改回原样为 0”）根本写不出来。
- 另一条（未核实，方案自己也没提）：ADR 0097 只对 `bash` 留档；`write`/`edit` 类工具直接写文件是否进 `run_payload_artifacts`，方案没查。“改了几个文件”若只看命令记录，可能漏掉非 bash 写入。

### 高 2：块 A 的“不要”状态会撞上重复提议（proposalId 是内容哈希）
- 证据：
  - `apps/agent-service/src/production-owner-rules.ts:645-653`：`proposalId = rule-proposal:${hash(JSON.stringify([ownerId, type, params, summary, quote])).slice(0,32)}`。同一内容再提议得到**同一个 id**；且 `:396` `#writeText` 在载荷已存在时不重写。
  - `test/integration/production-memory-capture.test.ts:1939-1943` 明确断言了这一点：同一句 fragment 再次提议，返回的是同一个 proposalId。
  - 另外 `params` 用 `JSON.stringify` 序列化，键顺序取模型参数的插入顺序：内容相同、键序不同的两次提议会得到**不同**的 id，新提议列表会出现两条几乎一样的提议。
- 后果：如果“不要”把拒绝状态按 proposalId 记在方案新增的那张表里，主人拒绝一次之后，模型再提一模一样的提议（哪怕主人主动又想要了），会继承旧的“拒绝”状态；列在待采纳里的还有可能出现键序不同的近重复项。
- 建议：提案状态表的主键定为 proposalId + 产生时间（或加“提议轮次”），重复提议把状态重置回待定、保留拒绝历史；序列化进哈希前先规范化 params 的键序（只影响新提议，proposalId 虽经工具结果回给模型，但那是末尾追加的消息，不违反只追加）。这两条都要写进方案，不能留给编码时临场定。

### 高 3：路由缺口（I-73 同类：值只查了名单，没查处理方）
- 证据：
  - `apps/agent-service/src/production-approval-gateway.ts:200-237`：control plane 的 delegate 是一串 `if`，没命中的命令**全部落到 `searchAuthorization.set`**（`:236`），而 `public-search-authorization.ts:105-106` 第一行就 `if (command.type !== "search.authorization.set")` 拒绝。
  - 块 B 要装的 `capability.*`、块 A 的新提议操作，现在都不在任何分支里。只把操作名加进契约和 installedOperations（`production-approval-gateway.ts:250-262`）而 delegate 不加分支，手机上会得到一条莫名的错误。
- 方案的自动检查“操作名同时在契约、已安装清单、路由三处”没覆盖“路由到正确处理方”。建议改成四查：契约、已安装清单、delegate 分支、处理方内部的类型断言；并加反向用例：装了操作名但 delegate 没有分支时测试必须失败。
- `capability.install.approve`（契约已有，`packages/gateway-contracts/src/contracts-v2.ts:90`）也必须进已安装清单——块 B 的重新启用“再由主人带面容批准”，批准这一步就是它，方案的操作清单里没列。

### 中 4：块 B“任何一项不过就保持停用”与状态机实际落点不符
- 证据：`packages/application/src/services/capability-lifecycle-service.ts:400-405`（approveInstallation 只接受 `installation_proposed`）、`:414-426`（activate 里资格检查失败直接抛 `NOT_AUTHORITATIVE`，此时记录已停在 `installation_approved`，不是“停用”）。重新启用路径 disabled→proposed→approved→activate，最后一步失败时记录停在“已批准未激活”，没有自动回到 disabled 的路。
- 建议：方案写明激活失败后记录停在 `installation_approved`、手机怎么显示、能否重试激活；别承诺“保持停用”。其余核对过没问题：停用会撤销句柄并取消定时任务（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2605-2653`），重新启用不恢复它们是对的；回执上的 N 需要 `:2620-2630` 那条查询另出数（`invalidate` 返回值里没有），产生方和回执消费方要在方案里点名。
- 附带：退回上一版要求 `rollbackDeclaration` 和 `runtimeQualification` 存在（`:580-585`），“只有存在上一版时才显示”是对的。

### 中 5：块 A 的“看依据”回放数字现在并不在提议载荷里
- 证据：`Proposal` 接口（`production-owner-rules.ts:241-249`）只有 `key/type/params/summary/quote/threadId/source`；`confirm()` 调 `#activate(proposal, null)`（`:669-676`），回放为 null。要“存产生那一刻的回放数字”必须改提议载荷格式。
- 方案没提旧数据：已存在的提议载荷不会被重写（`:396`），读旧提议时回放为空，UI 要有空态兜底。建议在方案里补一句。

### 中 6：“不要”和现有 undo/confirm 语义的交互没定义
- 证据：现行为是确认→active、undo→retired、**对同一 proposalId 再次 confirm 会复活规则**（`production-memory-capture.test.ts:1967-1975`；幂等性另有 `test/integration/mcp-write.test.ts:1165`“activates once however often the confirmation is resent, and an undone rule stays undone”）。
- 方案只说“只把提议标成拒绝，不写规则不写记忆”，没说：拒绝之后再 confirm 算什么？建议写明：对已拒绝提议的 confirm 返回“提议已拒绝”错误，或拒绝只对未确认提议有效。

### 中 7：块 A 漏了现存的第二个提议来源（MCP 外部规则提议）
- 证据：`apps/agent-service/src/production-mcp-rule-writer.ts:70-101`：外部客户端 `propose_rule` 走同一条 `rules.create → confirm` 链，但主人在外部客户端确认后**立即 confirm，从不停在提议状态**；决策另有标记 `rule-decision:mcp:${proposalId}`（`:13、:86-95`）。
- 方案全文没提这条线。新列表要加反向用例“外部已决策的提议不出现在待采纳列表”；“不要”的拒绝标记命名空间也不能和 `EXTERNAL_RULE_DECISION_PREFIX` 冲突。否则就是 I-73 式的两套标记互不知情。

### 低 8：块 C 主机显示名只有“加 1 个字段”，没有产生方
- 证据：`packages/application/src/ports/host-files.ts:26-40`（`HostDirectoryGrant` 是冻结记录，`hostId` 在 :29、`displayPath` 在 :31——方案引的 28、30 偏了一行），存于 grants 表，被文件读取服务按 `grantId/hostId` 比对（`apps/agent-service/src/production-file-read-services.ts:233`）。
- 谁写这个名字、写入口的操作名、长度和字符校验、加字段后 grants 记录 JSON 的迁移，方案都没写。I-73 的教训就是“值只在一端认”。另外 `displayPath` 已经是“显示用的路径”，新字段和它的语义关系（没起名显示 displayPath）要写清楚，避免两个显示字段打架。

### 低 9：顺序与序列化没定全
- 方案自动检查里“列表顺序固定”只挂在块 A 的确认/不要那组；块 A 新表的排序键、块 C“这个文件夹的改动”的排序都没定。规则 `.claude/rules/prompt-prefix.md:51`（规则 10）要求列表顺序固定——这些不进模型请求，但手机端同样要确定渲染。

---

## 推测（未核实或风险判断）

- **块 C 的新查询性能**：`run_payload_artifacts` 现有查询都按 `owner/agent/run_id/purpose` 走（如 `sqlite-capability-invocation-operations.ts:1054`），我没找到按目录授权或按对话聚合的索引。方案把“是否另建投影表”推迟到编码线程核实，这个推迟合理，但“这个文件夹的改动”要跨 run 聚合（`runs.thread_id` 存在，可行），大目录长对话下全表扫的风险要有预案。
- **Claude Code 对标引用**：两句原话我都从 https://code.claude.com/docs/en/sub-agents 核到了（“Each subagent runs in its own context window…” 和 “When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session and names the subagent that is asking.”）。引用成立；结论“先有真的派出去，才有列表”我认同，E 放最后并单独同意是对的。
- **方案开头引用的 `.agents/reviews/topic-four-features-wiring/round-1/` 在当前检出版本里不存在**（glob 无结果）。要么是未提交的本地文件，要么路径写错，引用失效。

---

## 侧重检查

我走的普通流程：主人在聊天里说“日本入管局相关的邮件以后必须通知我”→ 模型调 `rule_set`（描述符在 `production-owner-rules.ts:157-188`）→ 原话完整且带“以后”→ 直接激活；换一句转述/残句 → `status: "proposed"`，存载荷（`:654`）→ 手机端目前**列不出来**（`memory.rules.read` 的快照只含规则、过滤 retired，`production-memory-control.ts:487-516`，不含提议）→ `memory.rule.respond` 已支持 confirm/reconfirm/undo（`:1175-1200`，网页入口 `apps/control-center/src/memory.ts:152`）。

覆盖结论：
- **已覆盖**：提议产生与格式、confirm、undo、复活、needs_review 全链路在 `test/integration/production-memory-capture.test.ts:1885-2005`（真实 SQLite）；重复确认幂等在 `mcp-write.test.ts:1165`；网页回执卡在 `apps/control-center/test/owner-rules.unit.test.ts`；能力服务的停用/回退/激活在 `test/integration/authorization-capability-governance.test.ts`（服务层）。
- **这次改动新产生、没有覆盖的路径**：待采纳列表读操作、“不要”写操作、三处（应四处）一致检查、`capability.*` 在生产网关的 delegate 接线（现有测试全在服务层，不过生产网关）、块 C 的全部。
- **文档一致性**：`prompt-prefix.md` 规则 6/7/8 与方案第 9 条前提一致，引文逐字核对无误；ADR 0213 写的 `memory.rule.respond` 动作集（撤销、确认提议、重新确认）与代码一致。

---

## 如果由我来定，我会怎样改这份方案

顺序和四块取舍照旧（A→B→C，D/E 后置单独同意，判断正确），改四点：

1. **块 A**：先写死三件事——提议状态表主键含产生轮次、拒绝后 confirm 的行为、旧提议载荷无回放数字的空态；把 MCP `propose_rule` 这条线纳入反向用例；提议入哈希前规范化 params 键序。自动检查加“重复提议不继承拒绝、键序不同不产生重复行”。
2. **块 B**：操作清单补 `capability.install.approve`；把“任何一项不过就保持停用”改成“资格检查不过停在已批准未激活，可重试激活”；写明 N 的查询来源和回执消费方。
3. **块 C**：“改了几个文件”改成净效果定义（最后一条记录为准），删掉“删掉后又恢复原样不算”这个按内容不可判定的承诺，或改为“删除后未再出现”；先核实 `write` 工具写入是否留档，不留档就在方案里写明第一版只统计 bash 改动。
4. **所有块**：自动检查从“三处一致”升级为“四处一致”（契约、已安装清单、delegate 分支、处理方类型断言），反向用例含“装了操作名但 delegate 没分支必须失败”。

## 必答问题

1. **会不会改模型已见过的请求开头？** A/B/C 不会：全是手机网关读写操作和显示层，不进 `rule_set` 工具结果以外的模型内容，且 `rule_set` 工具本就在（`production-owner-rules.ts:149-208`），无增删。D/E 会改工具集合——这正是规则 6 的换新情形，方案已标注“单独同意”，符合 `.claude/rules/prompt-prefix.md:84`（第八节“会，就停下来出方案，Andy 同意才动工”）和规则 7（改工具集合就换新一次）。每轮会变的值没有新增，所有新数据都在最后一条消息或根本不进模型。结论：合规，前提是 D/E 动工前出 ADR。
2. **同一段文字会不会变成不同字节？** 不进模型请求的部分不算；进模型的只有 A 的 proposalId（经 `rule_set` 工具结果回给模型，`production-owner-rules.ts:655-666`）。它按内容哈希生成，确定性 OK，但依赖 `JSON.stringify` 的键序（见高 2），建议规范化；B 的 N、C 的列表只在手机侧，不影响遮盖和缓存。遮盖规则不涉及本次改动。
3. **有没有自动检查、反向用例会不会真失败？** 有设计且方向对（用真实 SQLite 与真实服务，符合仓库惯例），“确认两次只生效一次”在现有代码里语义成立（幂等复用同一 ruleId）。但三处缺口：路由分支无反向用例（高 3）、“改回原样为 0”在现数据下写不出来（高 1）、拒绝/复活语义没定义（中 6）。补齐后反向用例可真失败。
4. **每个值的产生方和使用方都核过了吗？** 逐个：proposalId（产生 `production-owner-rules.ts:645`；消费 confirm 正则 `:670`、`memory.rule.respond` `:1182-1186`、MCP writer `:81-84`——两端一致，regex 均为 `^rule-proposal:[0-9a-f]{32}$`）；重新启用的状态边（产生需新服务方法；消费 `approveInstallation:400-405`、`activate:414-426`，均为 lifecycle 白名单校验，方向可行）；`capability.install.approve`（契约有、生产未装未路由——必须补两端）；主机显示名和回执 N（**都还没有产生方**，方案只写了消费端，这是方案里最接近 I-73 复发的地方，见低 8 和中 4）。
