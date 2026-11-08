# 复核结论（PR #283，cd2b1e3d）

总评：作者关于“没改模型内容、迁移只追加、编号格式、版本号更新”的说法基本与代码一致；但把 `gmail_message_id` 放进 `contentDigest` 会破坏既有幂等语义，且迁移与配对缺少必要的反向保证和纠错路径。

## 读代码证实的问题（按严重度）

### 1. 严重度：高 — 把 `gmail_message_id` 放进 `contentDigest`，升级后相同内容会被判成冲突

- 文件：`apps/agent-service/src/production-muse-intake.ts:264-300`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:260-278`
- 问题：`parts` 新增了 `gmailMessageId`，即使值为 `null`，`JSON.stringify` 也多了这个键，导致**所有 proactive 条目的摘要字节都变了**，不只是带编号的条目。旧库里的行保存的是旧摘要；升级后 Muse 只要以新的 `batch_seq` 重发同一自然键、内容完全相同（页面重试、补发、跨批回溯），就会从 `duplicate` 变成 `conflict`，并写入 `muse_intake_conflicts`、让 HTTP 响应里的 `conflict` 计数增加。整批重发（同一 `batch_seq`）不受影响，因为它在批级别先判 `replay`；受影响的是自然键级别的重复投递。
- 证据：
  - `apps/agent-service/src/production-muse-intake.ts:276`：`gmailMessageId: safe(gmailMessageId),`
  - `apps/agent-service/src/production-muse-intake.ts:300`：`contentDigest: digestOf("proactive", parts, safe(title), safe(body)),`
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:266-269`：
    ```ts
    if (stored?.digest === item.contentDigest) {
      duplicate += 1;
    } else {
      conflict += 1;
    ```
- 影响：违反 ADR 0162 第 5 条“同一自然键、内容相同回重复”的语义；旧条目在升级后无法再通过重发补上邮件编号（冲突路径是 `ON CONFLICT ... DO NOTHING`，不会更新 `gmail_message_id`）。
- 建议：`gmail_message_id` 是配对元数据，不是提醒内容，应从 `contentDigest` 的 `parts` 中移除；若确实希望“后补编号”算变更，也应只在值非空时纳入，并为旧摘要设计兼容/迁移方案，同时补一条跨版本/带与不带编号的回归测试。

### 2. 严重度：中 — 写错邮件编号后没有纠正路径，且编号不可见

- 文件：`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:447-481`、`apps/agent-service/src/production-muse-intake-control.ts:121-132`
- 问题：评价时直接把条目里存的 `gmail_message_id` 复制到 `muse_reference_entries.paired_message_id`，不做任何与真实 Gmail 邮件的对应校验；条目插入是 `ON CONFLICT ... DO NOTHING`，没有更新 `muse_intake_items.gmail_message_id` 的路径；控制中心概览也不返回编号。若 Muse 发错编号、或令牌泄露后被用来填入任意已处理邮件的编号，周报会把提醒配到错误的邮件上，且只能“清除 Muse 数据”后重收，不能就地修正。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:449-450`：读取 `gmail_message_id`。
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:479`：`item.gmailMessageId,` 写入 `paired_message_id`。
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:215`：`ON CONFLICT (...) DO NOTHING`，没有更新分支。
  - `apps/agent-service/src/production-muse-intake-control.ts:122-131`：返回给网页的条目没有 `gmailMessageId`。
- 建议：至少让所有者能看到将要配对的编号，并提供纠正入口；或在“摘要相同、仅编号从空变为非空”时允许受控更新 `gmail_message_id`，并同步/重建尚未评价或已评价的对照条目。若坚持不做纠正，应在 ADR 和运行手册中写明“编号写错只能清除重收”。

### 3. 严重度：中 — 迁移 0079 缺少“已有行升级”和 CHECK 反向测试

- 文件：`packages/persistence-sqlite/test/muse-intake-migration.contract.test.ts:22-60`
- 问题：现有迁移测试是从 74 升到最新，此时 `muse_intake_items` 还不存在（0075 才建表），所以 0079 只在一个空表上执行；没有测试“schema 78 已有 Muse 条目 → 升到 79 后旧行保留、`gmail_message_id` 为 NULL”，也没有测试数据库拒绝空串/257 字符。通用迁移测试只是把版本号从 78 改成 79，属于计数检查，不能覆盖 0079 的数据语义。
- 证据：
  - `packages/persistence-sqlite/test/muse-intake-migration.contract.test.ts:23`：`it("upgrades a database at sequence 74 and keeps existing rows"...`
  - 同文件 `47-57`：只断言四张表的名字，没有断言列和数据。
  - 可对照 `packages/persistence-sqlite/test/decision-ledger-migration.contract.test.ts:324-357`，0073 有真实的“旧行保留 + 空编号/超长编号被拒”测试。
- 建议：新增 78→79 的迁移测试：先插入一条 Muse 条目和引用，做快照后应用 79，断言旧字段不变、`gmail_message_id` 为 NULL；再断言插入空串和 257 字符失败。

### 4. 严重度：低 — 存储层只校验长度，不校验接收端的字符集

- 文件：`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:81`、`packages/persistence-sqlite/src/migrations/0079_muse_intake_gmail_message.sql:1-2`
- 问题：HTTP 入口用 `/^[A-Za-z0-9_-]{1,256}$/u` 严格限制，但端口和数据库只检查 `length BETWEEN 1 AND 256`。所有生产写入目前都经过 HTTP，所以现在不是可利用漏洞；但任何绕过 `parseMuseBatch` 的内部调用（worker/direct、测试、未来入口）都能把 `not an id; drop table` 这类字符串写进去，然后复制到 `paired_message_id`。两端校验不一致。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:81`：`if (!nullableText(item.gmailMessageId, 256)) return "gmail message id";`
  - `packages/persistence-sqlite/src/migrations/0079_muse_intake_gmail_message.sql:2`：仅 `length(...) BETWEEN 1 AND 256`。
- 建议：把字符集谓词抽成共享校验，至少在端口 `itemProblem` 里复用；数据库可用 `NOT GLOB '*[^A-Za-z0-9_-]*'` 补上同等的纵深防御。参数化查询本身没有注入问题。

### 5. 严重度：低 — 文档与代码不一致

- 文件：`docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:40,58`、`docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:46`、`docs/runbooks/muse-intake-runbook.md:130`、`apps/agent-service/src/production-muse-intake.ts:52-64`
- 问题：
  - ADR 0154 仍写“自动配对不在本次范围”“主分支上目前没有……自动接收端”，而本 PR 已实现自动配对；ADR 0162 只是新增第 8 条，没有把 ADR 0154 标成被修订。
  - 运行手册说“每条提醒带上这个编号”，但 `gmail_message_id` 不在 `SCHEDULED_KEYS` 中；`muse_scheduled_run` 即使带了该字段也会被静默丢弃（计入 `droppedFieldCount`），不会报错。运行手册没有说明“仅提醒条目，定时运行不接收”。
- 证据：
  - `docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:40`：“自动配对不在本次范围”
  - `docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:58`：“主分支上目前没有……自动接收端”
  - `apps/agent-service/src/production-muse-intake.ts:52-64`：`SCHEDULED_KEYS` 不含 `gmail_message_id`
- 建议：在 ADR 0154 增加 `amended_by` 或修订说明；运行手册明确字段只对 `muse_proactive_item` 生效，`muse_scheduled_run` 带该字段会被丢弃。

## 推测 / 未核实

- Gmail API 的 `id` 字符集没有在本仓库内被文档化，代码只按实测十六进制示例收紧到 `[A-Za-z0-9_-]`。如果 Google 返回含其他字符的合法 id，接收端会整条拒收提醒。这一点未联网核实，标为推测。
- Muse 是否会在新的 `batch_seq` 里重发已发过的自然键，未核实；但接收端明确支持这种重复投递，所以第 1 条的风险路径真实存在，只是触发频率未知。
- `proactive_processed_messages.message_id` 与 Muse 邮箱是否同一账号、编号是否同源，代码只能确认 Himawari 存的是 Gmail API 的 `message.id`（`packages/platform-node/src/gmail-source.ts:189`），无法离线确认 Muse 账号一致。
- 预存问题（非本次引入）：`rate` 无论条目 `state` 是否为 `suppressed` 都写 `muse_reminded = 1`；不过控制中心的 `rateable` 只放行 `delivered`/`succeeded`（`production-muse-intake-control.ts:88-90`），正常网页路径不会评价 suppressed 条目。若未来开放直接端口评价，自动配对会把“没提醒”的条目算成提醒。

## 侧重检查

- **错误路径/不合规范输入**：`gmail_message_id` 的非字符串、空串、超长、非法字符在 HTTP 解析阶段都会让整条被拒；但 `muse_scheduled_run` 上的同名字段被静默丢弃而不是拒绝。已核实。
- **安全**：SQL 全部参数化，无注入；编号最长 256，随请求体上限受控，无资源耗尽风险。主要信任风险是持有服务令牌的 Muse 可以命名任意已处理邮件编号，从而影响校准统计；这是自动配对带来的新影响面。
- **不可撤销操作**：编号一旦随条目写入，没有更新接口；错误配对只能通过“清除 Muse 数据”整体删除后重收。已核实。
- **规则文件/说明文档一致性**：ADR 0154 与新加的 ADR 0162 第 8 条、运行手册与 `SCHEDULED_KEYS` 存在上述不一致。已核实。
- **模型请求**：本次改动没有触碰提示词目录、运行时请求组装、出口遮盖或历史存储，未发现模型请求路径变化。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 diff 只改 Muse 接收解析、SQLite 存储/迁移、评价写入和文档；Muse 数据只进入控制中心概览和周报，不进入发给模型的系统提示、工具定义、历史或遮盖结果。因此“只在末尾追加、每轮变化值放最后一条消息”这条规则没有被触发；`contentDigest` 的变化只影响入库去重，不影响模型请求字节。
2. **对模型请求字节没有影响；对存储的 `contentDigest` 有影响。** 同一输入在改动前后会得到不同摘要（新增了 `gmailMessageId: null` 键），同一文本带编号和不带编号也会不同；这正是第 1 条的问题。没有新增时间字段或无序集合；`sources` 的键顺序由字段读取顺序固定，单次解析内是确定的。
3. **有部分自动检查。** HTTP 测试的正向存储和非法编号反向用例是真实的：去掉字符集校验后，`not an id; drop table` 会被接收，`accepted: 0` 断言会失败。存储测试覆盖了“有编号则配对、无编号则不配对”。但**没有**覆盖跨版本摘要兼容、带/不带编号的重复投递、迁移 78→79 保留旧行、数据库拒绝空串/257 字符。
4. **长度和类型两端一致，字符集两端不一致；迁移版本链路一致。** 产生处：`production-muse-intake.ts:233-239`（HTTP 正则 + 256）、`0079` 迁移列（1–256）。使用处：`sqlite-muse-intake-operations.ts:81`（仅 1–256）、`:213/:253` 插入、`:323` 读出、`:449/:479` 复制到 `paired_message_id`；目标列 `0073` 与 `recordMuse` 也都是 1–256；周报 `packages/calibration/src/index.ts:354,294` 把 `paired_message_id` 当作 `proactive_processed_messages.message_id` 的精确键，长度范围一致。迁移序号 79 在 `migration-engine.ts`、各迁移测试和 `workspace-lifecycle-audit.mjs` 中一致，`check-audit-schema-range.mjs` 会自动比对。唯一需要补的是字符集在存储/端口层的同等校验（第 4 条）。
