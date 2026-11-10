## 结论摘要

改动确实是只读的：没有新增迁移，没有改提示词/工具定义/历史消息，也没有把新值送进模型请求；新增查询只服务控制中心。读代码发现的问题主要集中在新契约字段的**产出端校验比消费端松**、Muse 条目截断后的**比较结论可能与周报不一致**，以及几个低风险的错误路径/文档不一致。未运行测试（本次只能用 read/grep/glob/git），以下均为读代码结论。

---

## 发现（按严重度从高到低）

### 1. 中（潜在）：周报的 `messageId` 生产端只校验长度，消费端要求 Gmail 规则；不合规的历史值会让整份周报失败

- 文件:行
  - `packages/gateway-contracts/src/contracts-v2.ts:849`（周报 `gapCases[].messageId: gmailMessageId`）
  - `apps/agent-service/src/production-gap-cases.ts:81`（`messageId: candidate.pairedMessageId`）
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:412`（`recordMuse` 只做 `text(pairedMessageId, 1, 256)`）
  - `packages/persistence-sqlite/src/migrations/0073_muse_reference_paired_message.sql:1-2`（列约束只有长度 1–256）
  - `apps/agent-service/src/production-observation.ts:305`（整份周报 `gatewayV2MessageSchema.parse(snapshot)`）

- 问题：周报差距案例现在把 `paired_message_id` 原样放进 `messageId`，而契约要求它必须匹配 `[A-Za-z0-9_-]{1,256}`。`recordMuse` 和 0073 的数据库约束并不保证这一点；只要库里有一条这样的记录，`#gapCases` 生成的整个 `proactive.weekly.snapshot` 会在 `production-observation.ts:305` 解析失败，整个周报打不开，而不是仅这一条案例被跳过。即使绕过周报解析，页面按钮也会把该 ID 发给 `decision.email.read`，而 `contracts-v2.ts:1089` 的 `gmailMessageId` 同样会拒绝它。

- 证据（亲自读到的代码）：
  ```ts
  // contracts-v2.ts
  messageId: gmailMessageId,
  ```
  ```ts
  // sqlite-decision-ledger-operations.ts
  (pairedMessageId === null || text(pairedMessageId, 1, 256)) &&
  ```
  ```sql
  -- 0073
  ALTER TABLE muse_reference_entries ADD COLUMN paired_message_id TEXT
    CHECK (paired_message_id IS NULL OR length(paired_message_id) BETWEEN 1 AND 256);
  ```

- 推测/边界：当前生产正常的 Muse intake 路径会经过 `production-muse-intake.ts:226-232` 和 `sqlite-muse-intake-operations.ts:41-44` 的 Gmail 正则校验，因此正常数据大概率安全。仓库内除测试外没有找到 `recordMuse` 的生产调用点；风险来自旧数据或其他写入方。未核实生产库里是否存在非 Gmail 形状的 `paired_message_id`。

- 建议：在 `recordMuse` 和/或 `readGapCandidates`/`buildGapCases` 出口按 `GMAIL_MESSAGE_ID_PATTERN` 校验；不合规的记录跳过并记日志，而不是让整份周报失败。或者周报字段放宽为 `boundedString(256)`，前端只在通过 Gmail 规则时才显示“看这封邮件”。补一条“插入非 Gmail 形状的 paired_message_id，周报仍能生成/该案例被过滤”的反向测试。

---

### 2. 中：Muse 条目先截断到 20 条再算比较结论；条目超过 20 时页面结论可能与周报相反

- 文件:行
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:539-540`（`ORDER BY e.muse_at, e.id LIMIT ?`，上限 `MAIL_TRACE_MUSE_LIMIT = 20`）
  - `apps/agent-service/src/production-observation.ts:347-361`（用截断后的 `trace.museEntries` 构造 `museRows` 并计算 `comparison`）
  - `apps/agent-service/src/production-observation.ts:383`（`truncated: trace.museEntries.length >= MAIL_TRACE_MUSE_LIMIT`）

- 问题：周报的 `summarizeMuse` 会看该邮件所有 Muse 条目，并按 `pairEntriesByMail` 优先选“提醒过”的条目。新页面只看前 20 条；如果前 20 条都没提醒而第 21 条提醒了，页面会显示 `himawariOnly`/`bothSilent`，周报却显示 `both`/`museOnly`。这直接违背 ADR 0197 “页面上的结论和周报的数字不会各说各话”的目标。另外 `truncated` 在恰好 20 条、没有更多时也为 true，属于 off-by-one。

- 证据：
  ```ts
  // production-observation.ts
  const paired = pairEntriesByMail(museRows).get(messageId);
  const comparison = !processed
    ? "noHimawariRecord"
    : !paired
      ? "noMuseEntry"
      : mailComparisonBucket(paired, { ... });
  ```
  ```ts
  // production-observation.ts
  muse: { entries, truncated: trace.museEntries.length >= MAIL_TRACE_MUSE_LIMIT },
  ```

- 建议：比较结论用独立的聚合查询（例如同时取 `COUNT(*)` 和 `MAX(muse_reminded)`）覆盖全部条目，或先算全部条目的“是否提醒”再取前 20 条用于展示；`truncated` 用总数是否大于上限判断。补一条 21 条、最后一条才提醒的测试。

---

### 3. 低（潜在）：新快照里 `memoryIds`/`entryId` 用 `machineString`，但写入端只校验长度；异常 ID 会让整个快照解析失败

- 文件:行
  - `packages/gateway-contracts/src/contracts-v2.ts:1105`（`memoryIds: nullable(array(machineString))`）
  - `packages/gateway-contracts/src/contracts-v2.ts:1112`（`entryId: machineString`）
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:604-605`（`memoryByMail` 的值只校验 `messageId.length` 和 `ids(list,16)`；`ids` 只校验长度 1–256）
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:413`（`recordMuse` 的 `write.id` 只校验 `text(1,128)`）
  - `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:560`（`entryId: String(row["entryId"])` 原样返回）

- 问题：`memoryByMail` 里的记忆 ID、`muse_reference_entries.id` 都只经过长度校验；如果出现空格、开头不是字母数字等，`production-observation.ts:387` 的 `gatewayV2MessageSchema.parse` 会让整个邮件详情页报错。`ruleIds` 用的是 `boundedString(256)`，不受此限。

- 证据：
  ```ts
  // sqlite-proactive-operations.ts
  Object.entries(inputs.memoryByMail).some(
    ([messageId, list]) => messageId.length < 1 || messageId.length > 256 || !ids(list, 16),
  )
  ```
  ```ts
  // sqlite-decision-ledger-operations.ts (recordMuse)
  text(write.id, 1, 128) &&
  ```
  ```ts
  // contracts-v2.ts
  memoryIds: nullable(array(machineString)),
  ...
  entryId: machineString,
  ```

- 推测：当前记忆 ID 和 Muse entry ID 都由生产 ID 生成器产生，通常是 `memory:*`、`muse-reference-entry:*` 形式，实际大概率安全；这是“写入端比消费端松”的潜在问题，仓库内现有测试没有覆盖非 machine-safe 的 ID。

- 建议：要么在写入端统一按 `machineString` 校验真正要回传给控制中心的 ID，要么契约对展示用 ID 放宽为 `boundedString`。补一条“带空格/非字母开头的 memory id 写入后，邮件页仍能解析”的反向测试。

---

### 4. 低：`decision.chain.read` 未安装时，邮件页把“功能未启用”显示成“无记录”

- 文件:行
  - `apps/control-center/src/components/mail-decision-page.tsx:91-98`
  - `apps/control-center/src/components/mail-decision-page.tsx:163-171`

- 问题：`readChain` 为 null（配置里没有 `decision.chain.read`）时，`chain` 会以 `Promise.resolve(null)` 结束，界面走 `chain.kind === "ready"` 分支显示 `decision.chain.noRecord`（“无记录”），而不是“当前部署未启用依据链”。这会把“没有安装功能”和“确实没有记录”混为一谈。

- 证据：
  ```tsx
  const chain = useLoad<DecisionChain | null>(
    () =>
      decisionId && readChain
        ? readChain(decisionId)
        : mail.kind === "ready"
          ? Promise.resolve(null)
          : new Promise<never>(() => undefined),
  ```
  ```tsx
  ) : chain.kind === "ready" ? (
    <p className="decision-chain-note">{message("decision.chain.noRecord")}</p>
  ```

- 建议：区分 `readChain === null` 的情况，显示“当前部署未启用依据链”或隐藏该卡；补一条只安装 `decision.email.read`、不安装 `decision.chain.read` 的用例。

---

### 5. 低：`prod-read.sh gmail-decisions` 把原始 `message_id` 拼进 JSON 路径；异常字符会让整次只读查询报错

- 文件:行
  - `scripts/operations/prod-read.sh:98-100`

- 问题：SQL 用 `'$.floorHits."' || p.message_id || '"'` 拼 JSON 路径。`proactive_processed_messages.message_id` 在数据库里只有长度约束（`0069_decision_ledger.sql:103`），如果旧数据/异常数据里含有双引号、方括号或点，`json_extract` 的路径会失效，整条 `gmail-decisions` 查询可能抛错，而不是只影响一行。不是 SQL 注入（仍然是 SQL 表达式而不是拼 SQL 字符串），但属于健壮性问题。

- 证据：
  ```sql
  (SELECT count(*) FROM json_each(json_extract(d.inputs, '$.floorHits."' || p.message_id || '"'))) AS rule_count
  ```

- 建议：先用 `json_each(d.inputs, '$.floorHits')` 再按 `key = p.message_id` 过滤，避免拼 JSON 路径；或在脚本层过滤非 Gmail 形状的 `message_id`。

---

### 6. 低：文档说“每一环都能点到原始记录”，但规则和邮件两节并没有链接

- 文件:行
  - `docs/adr/0197-one-page-for-one-email-decision.md:39`
  - `apps/control-center/src/components/decision-chain-drawer.tsx` 规则列表（约 152–180 行）和 mails 段（约 181–200 行）

- 问题：ADR 写“依据链每一环仍可点到原始记录”，但复用后的 `DecisionChainBody` 中只有记忆条目有“看来源对话”链接；规则行只是文本，mails 段只是计数，没有可点击入口。这是文档与代码不一致，不是新引入的功能回归。

- 证据：
  ```tsx
  {chain.rules.items.map((rule, index) => (
    <li key={`${rule.ruleId}:${index}`}>
      <p>{message("decision.chain.rule", { id: rule.ruleId })} ...</p>
      <small>{message("decision.chain.ruleMails", { count: rule.mailCount })}</small>
    </li>
  ))}
  ```

- 建议：把 ADR 改成“记忆可点到原始记录，规则/邮件计数暂时只是展示”，或在页面补链接后再保留这句话。

---

## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可逆操作和文档一致性重点看了这些路径：

- **不可信输入**：`decision.email.read` 的 `messageId` 在 `contracts-v2.ts:1089` 由 `gmailMessageId` 校验；`readMailTrace` 的 SQL 全部参数化，并按 `owner_id/agent_id` 限定（`sqlite-decision-ledger-operations.ts:524-525`、`:539-540`）。控制中心侧 `proactive.ts:104-106` 只在操作已安装时提供调用。结论：未发现跨 owner 读取或 SQL 注入。
- **错误路径**：未知邮件、别人的邮件、缺失决策记录均有集成测试覆盖；`seal.open` 和读取链的异常被捕获成 null/失败状态（`production-observation.ts:324-331`）。发现的一个 UX 问题是第 4 条“未安装依据链显示无记录”。
- **安全/隐私**：`textWithheld` 为 true 时 `title`/`text` 都返回 null（`production-observation.ts:340-342`），集成测试用真实封存数据验证了 `JSON.stringify` 不含被扣留正文；`muse_reference_entries` 和 `muse_intake_items` 的 join 也按 owner/agent 限定。未发现新的写操作或可撤销/不可撤销动作，全部为 SELECT/读取。
- **资源耗尽**：Muse 条目有 20 条上限，查询有 `LIMIT 20`；但第 2 条指出截断后仍用于比较，且 `truncated` 有 off-by-one。整体风险有限，因为没有把“全部条目”加载进内存。
- **不可逆操作**：没有新增迁移、没有写库、没有删除；`prod-read.sh` 仍以 `{ readOnly: true }` 打开数据库（`scripts/operations/prod-read.sh:50`）。`gmail-decisions` 只返回元数据，不返回邮件/记忆正文。
- **文档/规则一致性**：
  - ADR 说“不改发给模型的内容、不加迁移”与 diff 一致；
  - `.agents/instructions/test-and-production-hosts.md` 已把 `gmail-decisions` 加进固定只读查询；
  - 第 6 条“每一环可点”是唯一明显的文档过强表述；
  - `test/integration/decision-email.test.ts:353-355` 只比较了契约与持久化层两份 Gmail 正则，`apps/agent-service/src/production-muse-intake.ts:60` 还有第三份 `GMAIL_ID_PATTERN` 没被这条“等价测试”覆盖。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 依据 [prompt-prefix.md#rules](.claude/rules/prompt-prefix.md#rules)，关键看系统提示、工具定义、历史、遮盖和压缩。

- 本次 diff 没有触及 `packages/prompt-catalog`、`packages/runtime-pi` 或任何模型请求组装/出口遮盖代码；改动集中在控制中心、gateway 契约、SQLite 读取、观测查询、prod-read 脚本、测试和文档。
- `decision.email.read` 是控制中心向 agent-service 发起的只读查询，返回给页面，不会进入模型消息。
- 新查询的返回字段不含“当前时间”这类每轮变化的值；`processedAt`/`museAt` 来自数据库记录，不是请求头。因此不存在把每轮变化值塞进系统提示/工具定义的问题。
- 因此发给模型的内容仍是“只在末尾追加”，本次改动没有改变已有请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**模型侧不会；新查询本身对同一份数据库也是确定的。**

- `#emailTrace` 对 `floorHits`/`memoryByMail`/`relatedByMail` 做 `[...new Set(...)].sort()`（`production-observation.ts:321-322`），不是依赖对象遍历顺序。
- Muse 条目 SQL 有 `ORDER BY e.muse_at, e.id`（`sqlite-decision-ledger-operations.ts:540`），顺序固定。
- 没有依赖“后面的内容”的遮盖逻辑；`clean` 是确定性的。
- 唯一需要注意的是封存内容的 `seal.open`：如果遮盖/加密密钥轮换，同一 payload 读出的字节可能变化；但这不是模型请求内容，且和现有 gap case/Muse 读取路径一致。未发现新的非确定性来源。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有，而且反向用例大多是真用例；但仍缺几条关键反向覆盖。**

已读到的检查：
- `test/integration/decision-email.test.ts`：真实 SQLite + `ProductionObservation`，覆盖正常解析、比较词、跳过/老记录字段为空、未知邮件、别人的邮件、扣留正文、256/257 长度、契约与存储正则。
- `test/integration/decision-email-browser.test.ts`：真实浏览器，覆盖正向页面、老记录显示“无记录”、没有判断时无依据链且不能对比、手机单列/不横向滚动、返回周报。
- `apps/control-center/test/weekly-report.unit.test.ts` 的 `[P1-5]`：覆盖页面渲染、`decision.email.read`/`decision.chain.read` 的调用参数、周报 `end` 参数、未安装操作时不显示按钮、错误提示、中英日文案。
- `test/tooling/prod-read.test.mjs`：`gmail-decisions` 只读、只返回元数据。
- `packages/gateway-contracts/test/gateway-v2.fixture.ts` 增加了新查询/快照，契约测试会经过 schema。

反向用例的有效性：
- 去掉 `textWithheld` 判断，扣留测试会失败；
- 去掉 owner/agent 过滤，别人的邮件测试会返回数据而失败；
- 去掉周报 `messageId`，`production-observation.ts:305` 的整份 snapshot 解析会失败（现有周报集成测试会暴露）；
- 改错 `mailComparisonBucket`，`decision-email.test.ts` 的 `both`/`museOnly`/`noMuseEntry`/`noHimawariRecord` 断言会失败。

缺口：
- 没有 >20 条 Muse 条目、最后一条才提醒的用例（第 2 条）；
- 没有非 Gmail 形状的 `paired_message_id` 进入周报的用例（第 1 条）；
- 没有非 `machineString` 的 memory/entry id 用例（第 3 条）；
- 没有只安装 `decision.email.read`、不安装 `decision.chain.read` 的 UI 用例（第 4 条）。
- 本次未运行测试，以上是读测试代码的判断。

### 4. 每个新产生/修改的值，使用它的地方都能接受吗？

逐个核对如下：

- `decision.email.read` / `decision.email.snapshot` 类型名：
  - 产生：`contracts-v2.ts` 的 `GATEWAY_V2_MESSAGE_TYPES`、`decisionEmailQuerySchema`、`decisionEmailSnapshotSchema`、`schemasByType`。
  - 使用：`production-observation.ts:187`、`production-approval-gateway.ts:109`、`proactive.ts:104-106`、`check:operations`。
  - 结论：已同时加入契约、后端路由、前端调用和测试，`check:operations` 的“后端/调用方/测试”三件套能通过（按脚本逻辑读代码）。

- `GMAIL_MESSAGE_ID_PATTERN` / `gmailMessageId`：
  - 产生：`validation.ts:62-71`，并从 `index.ts` 导出。
  - 使用：`contracts-v2.ts:849`（周报 `messageId`）、`:1089`（查询）、`:1094`（快照）。
  - 结论：契约内部一致；和 `sqlite-muse-intake-operations.ts:41` 的一致性有测试（`decision-email.test.ts:353-355`）。但 `production-muse-intake.ts:60` 还有第三份正则没有测试覆盖，见第 1/第 6 条。

- 周报 `gapCases[].messageId`：
  - 产生：`buildGapCases` 从 `candidate.pairedMessageId` 原样复制（`production-gap-cases.ts:81`），源头是 `muse_reference_entries.paired_message_id`。
  - 使用：`weekly-report.tsx:1283` → `mail-decision-page` → `decision.email.read`。
  - 结论：**两端校验不对齐**，详见第 1 条。当前正常 intake 路径大概率能通过，但 `recordMuse`/历史数据存在风险。

- `MailTrace` 的字段（`decisionId`、`threadId`、`outcome`、`skipReason`、`ownerRating`、`processedAt`、`decidedAt`、`ruleIds`、`memoryIds`、`relatedMessages`）：
  - 产生：`readMailTrace`（`sqlite-decision-ledger-operations.ts:522-555`）和 `#emailTrace`（`production-observation.ts:369-381`）。
  - 消费：`decisionEmailSnapshotSchema`（`contracts-v2.ts:1094-1107`）。
  - 结论：
    - `outcome`/`skipReason`/`rating` 的取值受数据库 CHECK 约束（`0069_decision_ledger.sql:106-113`），与契约枚举一致；
    - `ruleIds` 用 `boundedString(256)`，基本能接受写入端长度约束；
    - `memoryIds`/`entryId` 用 `machineString`，见第 3 条的潜在不一致；
    - `relatedMessages` 由 `forMail` 去重后 `.length`，非负整数，满足 `integer(0)`。

- Muse 条目（`entries[].entryId`、`museAt`、`reminded`、`kind`、`state`、`title`、`text`、`textWithheld`、`timingOk`、`contentOk`）：
  - 产生：`readMailTrace` 的 LEFT JOIN 结果和 `#emailTrace` 的 `open`/`clean`。
  - 消费：`decisionEmailSnapshotSchema`。
  - 结论：`kind`/`state` 与 `MUSE_INTAKE_KINDS`/`MUSE_INTAKE_STATES` 一致；`title`/`text` 经过 `clean`，控制字符被替换且长度受限；`textWithheld` 已处理。主要风险是 `entryId` 的 `machineString` 不对齐。

- `MAIL_TRACE_MUSE_LIMIT` / `truncated`：
  - 产生：`decision-ledger.ts:199` 常量、`readMailTrace` 的 `LIMIT`、`#emailTrace:383`。
  - 消费：页面 `detail.muse.truncated` 的提示文案。
  - 结论：上限本身可用，但 `truncated` 在恰好 20 条时误报，且比较结论使用了截断后的集合，详见第 2 条。

- `gmail-decisions` 查询输出：
  - 产生：`prod-read.sh:94-107` 的 SELECT。
  - 消费：只读查看者/文档/测试。
  - 结论：只读、无正文；但 JSON 路径拼接见第 5 条。

- `GapCaseSnapshot` 的 `Omit<GapCase, "messageId">`：
  - 产生：`production-gap-export.ts:16`。
  - 使用：`production-observation.ts:421` 的 `{ ...found, weekStart, weekEnd }`。
  - 结论：类型上省略了 `messageId`，但运行时 spread `found` 仍会把 `messageId` 放进封存快照；导出时 `isGapCaseSnapshot` 不读取它，所以不会泄漏到导出，但类型并没有真正“去掉”这个字段。这是低风险的类型/运行时不一致，不是功能错误。

- 周报/邮件页的 `endDay`：
  - 产生：`weekly-report.tsx` 的 `report.endDay`。
  - 使用：`mail-decision-page.tsx:100` → `weekly.read(endDay)`；契约 `proactiveWeeklyQuerySchema` 接受 `nullable(jstDaySchema)`（`contracts-v2.ts:778-780`）。
  - 结论：`report.endDay` 是 JST 日期字符串，能通过契约；并且把同一个 `endDay` 传回去会得到同一观察窗口，和现有周报一致。

- i18n 新键：
  - 产生：`message-ids.ts`、`en.ts`、`ja.ts`、`zh-CN.ts`、`MESSAGE_SAMPLE_VALUES`。
  - 使用：`mail-decision-page.tsx`、`weekly-report.tsx`、`decision-chain-drawer.tsx`。
  - 结论：三种语言都补齐了新键，带占位符的键也补了样例值；未发现缺键。

---

## 未核实

- 未运行任何测试或构建（本次工具限制），第 3 题的“反向用例会失败”是根据测试断言和代码路径判断的。
- 未查看生产数据库，无法确认是否存在非 Gmail 形状的 `paired_message_id`，也无法确认文档里的生产演示邮件 `1a1ab3c2a4871176` 是否真实。
- 未核实仓库外是否有服务直接调用 `DecisionLedgerPort.recordMuse`；仓库内除测试外没有找到调用点。
