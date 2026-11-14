# PR 436 第 9 轮复核结论

说明：以下「证实」都是我在当前检出的 `162c431a` 上亲自读到的代码；「推测」是基于调用时序或未来使用方式的判断。测试没有运行（本环境不允许），作者的“已通过”我没有核实。

## 发现的问题（按严重度从高到低）

### 1. 中高｜已采纳的提议会再次交给处理方执行，通用箱没有幂等或已执行结果记录
- 文件：`apps/agent-service/src/production-proposals.ts:311-345`
- 问题：只有 `pending` 才认领；`accepted` 直接跳过认领继续执行 `handler.adopt`。网关幂等键每次调用都是新的（`apps/control-center/src/messages.ts:68` 的 `id("idempotency")`），所以重复点击、两台设备、或换一个幂等键重发都会再次执行处理方。
- 证据：
  ```ts
  let claimed = false;
  if (row.status === "pending") { ... }
  ...
  const basis = await this.#readBasis(row.evidenceRef);
  ...
  return await handler.adopt({ proposalId, threadId: row.threadId, data: basis.data });
  ```
- 说明：当前唯一注册的 `owner_rule` 处理方是幂等的（按 ruleId 创建/恢复），所以眼下不会重复建规则；但这次重构的目的正是以后接入“下一步”类提议，一旦处理方发邮件、下单、扣款，重复采纳就是重复的不可逆操作。
- 建议：`accepted` 状态直接返回保存过的 `resultRef`/回执，不重新执行；只对显式声明“可重放”的处理方（规则这条）重新执行；或在 handler 契约里要求幂等并持久化 adoption receipt。

### 2. 中｜认领后仍用认领前的 evidenceRef，同内容重提会换引用并删旧载荷，采纳会误报 NOT_FOUND，或在内容已变时按旧依据执行
- 文件：`apps/agent-service/src/production-proposals.ts:304,312-321,335`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:117-142`
- 问题：`adopt` 在 304 行读到 `row`，认领成功后 335 行仍用**认领前**的 `row.evidenceRef`。同内容重提时指纹不变、版本不加（SQL 的 `CASE WHEN fingerprint = ? THEN 0 ELSE 1 END`），但 `evidence_ref` 每次都被换成新引用，随后旧载荷被删（`production-proposals.ts:297-298`）。于是合法且未过期的卡点采纳会读到已经删掉的旧引用。
- 证据：
  ```ts
  version = version + CASE WHEN fingerprint = ? THEN 0 ELSE 1 END, fingerprint = ?,
  evidence_ref = ? ...
  ```
  ```ts
  const row = await this.read(proposalId);          // 304，缓存 evidenceRef
  ...
  claimed = (await store.decide({..., ...(expected ? { expected } : {})})) !== undefined;
  ...
  const basis = await this.#readBasis(row.evidenceRef); // 335，仍用旧引用
  ```
  另有竞态：若内容已变、但在旧载荷删除前 335 行读到旧依据，处理方会按旧内容执行，而表里已经是新版本 pending。
- 建议：认领成功后重新读一次行，校验 `version/fingerprint` 和 `evidenceRef` 仍是界面看到的那一版，用最新 `evidenceRef` 读依据；不匹配就 `PROPOSAL_CHANGED`。或者同内容重提不换载荷引用，旧引用延迟到确认无人读取后再清理。

### 3. 中｜`settle` 不带版本号/指纹认领 `pending → accepted`，可能把内容已变的新版本直接标成已采纳
- 文件：`apps/agent-service/src/production-proposals.ts:381-402`
- 问题：`settle` 从列表读出 `row` 的依据后，调用 `store.decide` 时**没有**传 `expected`：
  ```ts
  done = basis !== undefined && covered(basis.data);
  ...
  await store.decide({ ...scope, proposalId: row.proposalId, from: "pending", to: "accepted", now })
  ```
  这段时间里如果同一 `proposalId` 被重提（版本加一、内容/依据变化），`decide` 仍会把新版本标成 accepted，没有比对 `version/fingerprint`。
- 说明：目前只有规则处理方提供 `settled`，且 `covered` 只按参数相同判断，参数变了会换 proposalId，所以眼下实际影响很小；但这是通用箱暴露给未来处理方的能力，属于版本核对的漏口。
- 建议：`settle` 也带上读取时的 `{version, fingerprint}`（或至少 `evidenceRef`），不匹配就跳过。

### 4. 中｜`proposals.snapshot` 的输出可能违反自身契约；一条坏提议会让整个待采纳列表解析失败
- 文件：`apps/agent-service/src/production-proposal-control.ts:23-32,64-84`；`packages/gateway-contracts/src/validation.ts:89-106`；`packages/persistence-sqlite/src/migrations/0095_owner_proposals.sql:5-7`
- 问题：控制层 `shown()` 先去掉 Bidi/控制符并 `trim`，再按**码点**截断；但网关 `boundedString` 要求非空且按 **UTF-16 长度**限长。通用表只校验 `length(type) BETWEEN 1 AND 64`、`summary/effect 1..400`，没有“去掉后仍非空”“不能是 astral 字符”的约束。结果是：
  - 一个只含 `U+202E` 或空格的 `summary/effect/type/evidence.kind` 会被 `shown()` 变成 `""`，而契约要求 `boundedString` 至少 1 个字符；
  - 200 个 astral 字符的 `summary` 经 `Array.from(...).slice(0,200)` 仍是 200 个码点、但 JS `length` 是 400，`boundedString(200)` 会拒绝。
  服务端 delegate 返回后并不会再校验（`packages/application/src/services/governance-gateway-adapter.ts:211` 直接返回 delegate 结果），但网页客户端会 `gatewayV2MessageSchema.parse`（`apps/control-center/src/gateway-client.ts:269`），于是整次 `proposals.read` 失败，同一 owner/agent 的所有提议都看不到。
- 说明：`owner_rule` 这条路径的 `summary` 经过 `validRuleSummary`（拒绝 Cf/Cc/空白）、`quote` 拒绝 Surrogate、`type` 是枚举，所以现在触发不到；这是新通用箱对**未来通用调用方**的契约漏洞。
- 建议：在 `propose` 入口按表约束和网关约束校验，或在 `query` 里过滤空项/按 UTF-16 截断；补一条“只含 Bidi/astral 的提议”反向用例，断言 `gatewayV2MessageSchema.parse` 仍能通过。

### 5. 中｜“采纳和拒绝同时发生只能有一个生效”的反向测试已经失效
- 文件：`test/integration/production-memory-capture.test.ts:2417-2448`；`apps/agent-service/src/production-memory-control.ts:1234-1241`
- 问题：这个测试仍在用 `memory.rule.respond` 的 `action: "reject"`：
  ```ts
  command(context.control, "memory.rule.respond", { target: proposal["proposalId"], action: "reject" }, ...)
  ```
  但 `reject` 已从 `OWNER_RULE_ACTIONS` 移除，控制层对未知动作永远抛 `MEMORY_RULE_ACTION_UNKNOWN`。所以这个用例里 `reject` 永远不会成功，测试只证明了 `adopt` 成功，没有覆盖新的 `proposal.respond("reject")` 与 `adopt` 的竞态。
- 证据：`production-memory-control.ts:1234-1241` 只剩 confirm/reconfirm/undo，其他一律 `MEMORY_RULE_ACTION_UNKNOWN`。
- 建议：改用 `context.proposalControl.execute({ type: "proposal.respond", action: "reject" })` 与 adopt 并发，断言恰好一个 fulfilled，另一个是 `PROPOSAL_CHANGED` / `PROPOSAL_ACCEPTED` / `PROPOSAL_REJECTED`，并断言规则和记忆数量只变一次。

### 6. 中低｜单列主键 `id` 与通用调用方自定义 `proposalId` 组合，跨 owner/agent 相同 id 会主键冲突
- 文件：`packages/persistence-sqlite/src/migrations/0095_owner_proposals.sql:2`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:92,179-202`；`apps/agent-service/src/production-proposals.ts:261-264`
- 问题：表主键是全局单列 `id`，但所有读写都按 `owner_id + agent_id + id` 过滤。`propose` 先 `fetch` 自己 scope 的行（查不到），然后直接 `INSERT`；如果另一个 owner/agent 已有同 `id`，`INSERT` 会撞主键，抛底层约束错误并把刚写入的依据删掉。规则提议的哈希包含 owner/agent，所以规则这条安全；通用箱没有强制 id 带 scope。
- 证据：
  ```sql
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  ```
  ```ts
  `SELECT ... FROM owner_proposals WHERE owner_id = ? AND agent_id = ? AND id = ?`
  ```
- 建议：迁移改用 `PRIMARY KEY (owner_id, agent_id, id)`，或由箱统一在编号里注入/校验 scope，保证不同租户不会撞 id。

### 7. 低中｜`release` 失败被吞，处理方失败后提议可能停在 accepted 并从待采纳列表消失
- 文件：`apps/agent-service/src/production-proposals.ts:329-334`
- 问题：认领成功后处理方失败，`release` 要退回 pending；但：
  ```ts
  await store.decide({ ...scope, proposalId, from: "accepted", to: "pending", now: clock.now() })
    .catch(() => undefined);
  ```
  退回失败被静默忽略，行会留在 `accepted`。用户看到采纳失败，但这条提议不再出现在待采纳列表里，也不能用“不要”处理，只能再点一次采纳（又走第 1 条的重复执行路径）。
- 建议：`release` 失败要上报明确错误并记录，或让失败路径保留 pending 并给出可重试提示。

### 8. 低｜`#sweep` 在载荷已经不存在时永远不会把 `evidence_ref` 置空
- 文件：`apps/agent-service/src/production-proposals.ts:404-416`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1824-1830`
- 问题：
  ```ts
  const gone = await payloads.delete(evidenceRef).then(() => true).catch(() => false);
  if (gone) await store.clearEvidence({ ...scope, proposalId, evidenceRef }).catch(() => false);
  ```
  SQLite 的 `deletePayload` 是 `changes === 1`，载荷已被别的清理删掉时返回 `false`。此时 `clearEvidence` 永远不会执行，`evidence_ref` 永久悬挂，每次 `list()` 的 `settledEvidence` 都会再选中它、占用 100 条批次。
- 建议：不论 `delete` 返回 true/false，只要确认载荷不存在就调用 `clearEvidence`；或把 `delete=false` 也当作已清掉。

### 9. 低｜通用 `type/summary/effect` 没有入口长度校验，超长/空要到 SQLite CHECK 才报原始错误
- 文件：`apps/agent-service/src/production-proposals.ts:247-288`；`packages/persistence-sqlite/src/migrations/0095_owner_proposals.sql:5-7`
- 问题：`propose` 只校验时间、上限、origin、fingerprint、source 组合，不校验 `type` 长度 1-64、`summary/effect` 长度 1-400。超长会写入依据后由表 CHECK 拒绝，再删依据并抛底层数据库错误，而不是稳定的 `ProposalError`。
- 建议：在 `propose` 入口按表约束校验，抛 `ProposalError`；同时避免先写依据再被表拒绝。

### 10. 低｜集成测试没有真正验证“配置的上限随响应返回”
- 文件：`test/integration/production-memory-capture.test.ts:2473-2490`
- 问题：提议是用 `proposalLimit: 2` 的 box 创建的，但 `proposalsQuery(context)` 用的是默认配置的 `context.box`，于是断言 `full.limit` 为 `20` 而不是 `2`。测试验证了“满了拒绝”和“3 天过期”，但没有验证新配置项 `runPolicy.ownerProposals.pendingLimit` 会出现在 `proposals.snapshot` 里。
- 建议：用与创建提议相同的配置构造 `ProductionProposalControl`，断言 `limit === 2`、`expiresAfterDays === 3`。

### 11. 低｜文档与代码的小不一致
- 文件：`docs/architecture-v0.1.md:424-426`；`apps/agent-service/src/production-proposals.ts:329-334,297-298`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:152-177`
- 问题：
  - 文档 424 行说“已拒绝或已过期的重新打开时版本号也加一”，代码对已采纳的重开（152-177 行）也 `version = version + 1`，文档没提；
  - 文档 426 行说“处理方失败就把状态改回待采纳”，但已采纳状态再采纳时 `claimed=false`，`release` 不执行，处理方失败后状态仍是 accepted；
  - 文档 425 行说“读的一方不会遇到依据缺失的空档”，但第 2 条的 stale-ref 竞态仍可能让读者读到已删除的旧引用。
- 建议：把文档改成与代码一致，或修代码；如果“已采纳再采纳”是规则专用语义，最好写清楚通用处理方不保证。

### 12. 低｜`origin` 不在指纹里，重提可在版本不变时改变来源标记
- 文件：`apps/agent-service/src/production-proposals.ts:279-283`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:120-141`
- 问题：指纹只包含 `[type, summary, effect, evidence, data]`，`origin` 单独随重提更新。同一内容从“模型推断”变成“主人说过”（或反之）时版本号不变，旧卡片看到的来源标记可能已过期。
- 建议：把 `origin` 纳入指纹，或单独维护来源版本；至少确认界面展示的来源与实际一致即可接受。

## 侧重检查

- **错误路径**：查了 `adopt` 的认领/失败退回/已采纳重入（第 1、2、7 条）、`reject` 的重试与 `PROPOSAL_CHANGED`（`production-proposals.ts:348-379`）、`settle` 的尽力而为（第 3 条）、`#sweep` 的删除/置空（第 8 条）。`reject` 的版本校验本身是完整的：先带 expected 认领，失败后重读并再次校验，最后区分 rejected/accepted/expired。
- **不可信/不合规范输入**：`owner_rule` 路径的 `quote/summary/params` 校验仍在（`production-owner-rules.ts:747-791`、`rule-types.ts:257-274`），Bidi 展示清理存在（第 4 条）；但新通用 `type/summary/effect/evidence` 没有等价的入口校验，`evidenceOf` 只做字段类型过滤（第 4、9 条）。
- **安全/越权**：`proposal.respond` 校验 `actorType === "owner"` 且 `scope.ownerId/agentId` 匹配（`production-proposal-control.ts:99-104`），网关 `AgentGatewayV2Service.authorize` 还校验 subject/scope（`agent-gateway-v2-service.ts:95-110`）；依据载荷通过 `protector.unprotect` 按 owner/agent 解密（`production-proposals.ts:207-222`）。跨租户的主键问题见第 6 条。
- **资源耗尽**：`owner_proposals` 行永不删除、已采纳依据有意保留，这是作者明确的设计取舍；`#sweep` 每轮最多 100 条、列表最多 200 条，没有发现新的无界循环。悬挂引用见第 8 条。
- **不可撤销操作**：第 1 条是重点——通用箱允许已采纳提议被再次交给处理方，当前规则幂等，但未来不可逆处理方没有保护。
- **规则/文档一致**：第 11、12 条；另外作者说的“工具定义和提示词未动”与 diff 一致（`production-owner-rules.ts` 的 `ownerRuleToolDescriptors` 未改，diff 中没有 `packages/prompt-catalog` 改动）。
- **未核实**：测试是否全部通过（不能运行）；真实 App/浏览器验收（作者说没做）；是否有开发者本地库应用过旧的 0095（若应用过，`validateLedger` 会因 name/digest 不同抛 `DIGEST_MISMATCH`，见 `migration-engine.ts:873-887`）；数据导出不含新表的实际影响（作者已声明另行决定）。

## 逐条回答必答问题

### 1. 改动会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？
**不会改变请求开头。** `rule_set` 的工具定义来自 `ownerRuleToolDescriptors`（`apps/agent-service/src/production-owner-rules.ts:160-220`），本次 diff 没有改它，也没有改 `packages/prompt-catalog`；系统提示同样未动。提议箱、`owner_proposals` 表、`proposals.read/snapshot/respond` 都只服务于主人界面，不参与上下文组装。`rule_set` 的结果仍然作为工具结果追加在本轮末尾；`proposalId` 是内容哈希，`trials`/`replay` 都在这个追加的工具结果里。因此符合“只在末尾追加、会变的值在最后一条消息里”。依据：`.claude/rules/prompt-prefix.md` 第 4、5 条（第 33-36 行）和第 1-2 条（第 27-29 行）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**就模型可见内容而言不会。** `canonicalJson` 对对象键排序（`production-proposals.ts:119-130`），`proposalId` 由 owner/agent/规范化参数/说明/原话计算（`production-owner-rules.ts:792-801`），指纹按固定字段顺序计算（`production-proposals.ts:279-283`）。`randomUUID()` 和时间只用于 `evidenceRef`/`createdAt`（`production-proposals.ts:263-267,233`），不会出现在模型输入或工具结果里。`proposals.snapshot` 里的 `generatedAt` 会变，但它只发给界面。
需要留意的是：同一 `rule_set` 调用在不同时间会因邮件回放数字不同而产生不同的内部指纹/版本，这些数字本来就出现在末尾的工具结果里（既有行为），不属于请求开头。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？
**有，但存在明显缺口。**
- 确实有效的反向用例：`test/integration/production-memory-capture.test.ts:2882-3000` 用真实 SQLite 覆盖了列表/依据、版本随内容变化、旧版本号与错指纹 `PROPOSAL_CHANGED`、无处理方 `PROPOSAL_TYPE_NOT_ADOPTABLE`、可拒绝、来源入库；这些断言是真会失败的。
- **失效的用例**：`production-memory-capture.test.ts:2417-2448` 的“adopt 与 refuse 同时发生”仍在调用已删除的 `memory.rule.respond("reject")`，reject 必然报 `MEMORY_RULE_ACTION_UNKNOWN`，所以只验证了 adopt 成功（第 5 条）。
- **缺少的反向用例**：第 2 条的“同内容重提并发采纳”竞态、第 4 条的“空/astral 字段导致 snapshot 解析失败”、第 6 条的跨租户同 id、第 1 条的“已采纳再采纳不重复执行处理方”、第 10 条的配置上限随响应返回。
- 本环境不能运行测试，所以作者“全部通过”未核实。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？
大部分两端一致，但有几处不一致，已逐条列为问题：
- `proposalId`：规则侧 32 位十六进制、存储层/箱/网关 `machineString` 都能接受；但通用调用方需要自己保证前缀匹配 `^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$`，箱没有替调用方加 scope（第 6 条）。
- `version/fingerprint`：产生、存储校验（64 位十六进制）、网关 `integer(1)`/`machineString`、采纳/拒绝的 expected 比对基本一致；缺口在 `settle` 不带 expected（第 3 条）和认领后不再校验（第 2 条）。
- `type/summary/effect/evidence`：表只限长度，控制层按码点截断并去掉 Bidi/Cc，网关 `boundedString` 按 UTF-16 且要求非空——两端不一致，可让整个列表解析失败（第 4 条）；`type/summary/effect` 在箱入口也没有长度校验（第 9 条）。
- `origin`：存储层 `ORIGINS`、网关 `PROPOSAL_ORIGINS` 一致，但不在指纹里（第 12 条）。
- `evidenceRef`：新引用长度 `proposalId + ":" + 16` 不超过表 256，载荷引用也使用同一字符串，规则/MCP 旧路径按 proposalId 读取仍兼容；没有发现长度或字符集冲突。
- 配置键 `runPolicy.ownerProposals.pendingLimit/expiresAfterDays`：严格配置解析、`ProductionProposalBox` 构造校验、文档三处一致（1-200、1-3650，默认 20/30）；但集成测试没有用同一配置的 control 验证返回值（第 10 条）。
- 迁移/表名：`owner_proposals` 在 schema catalog、迁移引擎、存储操作、测试中一致；跨租户主键见第 6 条。
