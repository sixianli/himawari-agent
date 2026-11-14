# 复核结论

本轮增量 `d4bf2b74..be62587d` 只改了 `#settle`（改为尽力而为）、一处文档措辞和一条测试。**未发现高/中危的新问题**。发现 2 条低危/测试缺口，以及 1 条非本轮引入的文档与代码偏差。

## 读代码证实的问题

### 低：反向用例只覆盖 `listPending` 失败，没有覆盖“改状态失败”

- 文件：`test/integration/production-memory-capture.test.ts:2634-2654`、`apps/agent-service/src/production-owner-rules.ts:544-546, 563-572`
- 证据：
  ```ts
  const waiting = await store
    .listPending({ ...scope, now, limit: this.#limit() })
    .catch(() => undefined);
  ...
  if (covered)
    await store
      .decide({ ...scope, proposalId: row.proposalId, from: "pending", to: "accepted", now })
      .catch(() => false);
  ```
  新增用例只注入了：
  ```ts
  listPending: async () => { throw new Error("list failed"); },
  ```
  没有让 `decide` 在 `#settle` 阶段失败。
- 问题：作者的说法是“读待采纳列表或**改状态**失败都不抛错”，但自动检查只证明了列表读取失败这一半。若以后有人删掉 `decide(...).catch(() => false)`，现有用例仍会通过。
- 建议：再加一条用例，让 `decide` 第一次成功（`confirm` 认领）、第二次（`#settle` 整理）抛错，断言 `confirm` 仍返回 `active`。

### 低：`#settle` 失败被完全静默吞掉，且“漏掉的留到下次”没有独立的后续重试

- 文件：`apps/agent-service/src/production-owner-rules.ts:544-546, 563-572`、`docs/architecture-v0.1.md:420`
- 证据：两处都只 `.catch(() => undefined)` / `.catch(() => false)`，没有日志、审计或返回值；文档写：“这一步失败不影响规则生效，**漏掉的留到下次**”。
- 问题：`#settle` 只在 `#activate` 的两个出口调用（`:590`、`:645`）。所谓“下次”实际只在同参数规则再次被激活时发生；如果之后没有同参数操作，这条已生效规则的重复提议会以“待采纳”留在列表里直到过期（默认 30 天），占用 20 个名额中的一个，且用户无法再把它标成拒绝（它仍是 pending，可拒绝，但规则已经生效）。
- 说明：这不是本轮新引入的（第 4 轮就有 settle 失败路径），但本轮把失败从“抛给调用方”改成“完全静默”，使运维侧再也看不到失败。
- 建议：至少通过现有 `onFailure`/审计通道记一条日志；或让 `listProposals` 在读取时顺带做一次一致性整理（不改模型输入）。

### 说明：文档“一条规则生效时”比代码实际范围宽（非本轮引入）

- 文件：`docs/architecture-v0.1.md:420`、`apps/agent-service/src/production-owner-rules.ts:962-995`
- 证据：文档说“一条规则生效时，参数相同、还在待采纳的其他提议一并标成已采纳”；但直接走 `memory.rule.respond` 的 `reconfirm`（`:1288-1289` → `reconfirm()` `:962`）把 `needs_review` 规则改成 `active` 时，不会调用 `#settle`，只有 `#activate` 的两个出口会调用。
- 影响：范围很窄（需要已有同参数 pending 提议且规则处于 `needs_review`），但这确实是文档与代码的不一致。
- 建议：要么在 `reconfirm` 成功后也做一次“尽力而为”的 `#settle`，要么把文档限定为“经提议采纳/自动生效时”。

## 推测（未证实）

- `#settle` 静默失败会浪费一个待采纳名额，通常只持续到该提议过期；如果数据库长期异常，可能长期占位，但这是推测，未做故障注入验证。
- “本容器已通过 typecheck/lint/integration 等”未运行，未核实；迁移 0095 “从未被持久库应用过”也无法仅从代码核实，标为未核实。

## 侧重检查

- **不可信/不合规输入**：`confirm`/`reject` 都先校验 `PROPOSAL_ID_PATTERN`（`production-owner-rules.ts:839, 890`），SQLite 侧又校验同一正则（`sqlite-owner-rule-proposal-operations.ts:30`）；`memory.rule.respond` 的未知动作明确报错（`production-memory-control.ts:1292-1295`）。通过。
- **安全/租户隔离**：载荷解密用 `#scope()`（ownerId+agentId），表的读写都带 `owner_id`/`agent_id` 条件，proposalId 哈希也含 ownerId+agentId（`:736-745`）。通过。
- **资源耗尽**：待采纳默认上限 20、TTL 30 天，列表最多 200；`#settle` 最多遍历 `#limit()` 条并逐条解密，规模有界。通过。
- **不可撤销操作**：`#settle` 会未经用户点击把同参数 pending 提议标成 accepted，之后 `reject` 返回 `RULE_PROPOSAL_ACCEPTED`；但只有“同类型同参数、规则已生效”时才这样，行为可接受。本轮没有改变这一点。
- **规则/文档一致性**：本轮文档措辞“尽力把原来的载荷写回去”“这一步失败不影响规则生效”与代码一致；上面第 3 条是旧偏差。

## 必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。整个 PR 没有改 `packages/prompt-catalog`，`ownerRuleToolDescriptors`（`production-owner-rules.ts:159-219`）也未变；新增的 `memory.ruleProposals.read` 是控制面网关查询（`production-memory-control.ts:533-579`），不进入系统提示、工具定义或历史。发给模型的内容没有增加任何字段，也不存在“每轮变化的值”。依据 [prompt-prefix.md:27-35](../../.claude/rules/prompt-prefix.md#rules) 的只追加要求仍然满足。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会影响模型请求。本轮只改提议状态与文档；`#settle` 用的 `now` 只写进 `decided_at`，不进模型输入。唯一的时变值是新列表快照的 `generatedAt`（`production-memory-control.ts:576`），属于控制面返回，不在模型请求里。提议编号哈希是确定性的：`canonicalJson` 排序对象键（`production-owner-rules.ts:367-378`），参数经 `parseOwnerRuleParameters` 归一化并排序（`packages/application/src/rules/rule-types.ts:86, 109-115`），同内容同字节。

**3. 有没有自动检查，反向用例真的会失败吗？**
有检查，但只覆盖一半。新增用例注入 `listPending` 抛错（`test/integration/production-memory-capture.test.ts:2643-2645`）；如果把 `#settle` 上的 `.catch(() => undefined)` 去掉，`confirm` 会抛错，该用例会失败，所以这条反向用例是真的。`decide` 的 `.catch(() => false)` 没有被覆盖，属于缺口（见上）。整 PR 的其它反向用例（上限、过期、重置失败）我读到的部分确实会构造失败路径（如 `:2408-2441`、`:2656-2690`）；测试未实际运行，标为未核实。

**4. 每个新值/字段，产生处和使用处两端都能接受吗？**
逐项核对后未发现不匹配：
- `proposalId`：产生处为 `rule-proposal:` + 32 位十六进制（`production-owner-rules.ts:736-745`）；SQLite 用同一正则（`sqlite-owner-rule-proposal-operations.ts:30`），迁移列为 `length 1..128`（`0095_owner_rule_proposals.sql:2`），网关 `machineString` 允许 `A-Za-z0-9._:-` 且 ≤128（`validation.ts:49-59`），命令 `resultRef` 也用它（`contracts-v2.ts:2555`）。通过。
- `origin`：产生 `owner_said`/`inferred`（`:763`），端口类型、迁移 CHECK、网关枚举（`contracts-v2.ts:1664`）一致。
- 动作 `reject`：加入 `OWNER_RULE_ACTIONS`（`contracts-v2.ts:1631`）与命令 schema（`:1697`），`production-memory-control.ts:1284-1287` 有对应分支，控制台类型/调用也包含（`apps/control-center/src/memory.ts:31,193`）。
- 列表字段上限：控制面裁剪 `type 64 / summary 200 / quote 500 / trial 10 条 / from、subject 200`（`production-memory-control.ts:551-558`），契约 bounds 完全相同（`contracts-v2.ts:1662-1669`）；`summary` 源头本身限 200（`rule-types.ts:252`）。通过。
- 表结构：虽然主键仍是单列 `id`，但 proposalId 哈希含 ownerId/agentId，且所有查询都带 owner/agent 条件，跨 agent 不会串。通过。
- MCP 路径：`listed:false` 直接写载荷并返回 `proposed`（`production-owner-rules.ts:748`），绕开“已有同参数规则直接激活”的分支，因此 `ProductionMcpRuleWriter.accept` 期望的 `status === "proposed"` 仍成立（`production-mcp-rule-writer.ts:80-84`）。通过。
- 错误码映射：新增的 `RULE_PROPOSAL_*`/`RULE_PROPOSALS_FULL` 在 `production-memory-control.ts:1297-1303` 都被映射为 `INVALID_OPERATION`（`RULE_NOT_FOUND` 为 `NOT_FOUND`），控制台只按失败处理，不依赖具体码。通过。
