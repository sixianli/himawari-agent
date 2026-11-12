已达到本代理的最大步数限制，工具已被禁用。下面是基于已读代码的完整复核结论（未运行测试，测试实际通过/失败均标「未核实」）。

## 侧重检查

- 只读性：本 PR 的新增读取路径（`home.read`、`countDue`、`listUnattended`）只执行 SELECT/COUNT，无写入、无迁移、无不可撤销操作。已核实。
- 错误路径：`HomeFeedService.#collect` 会吞掉单个来源的异常并写入 `incompleteSources`；`awaitingCount()` 丢弃了 `incompleteSources`，因此网页推送拿到的是不完整的件数。已核实。
- 不合规范/不可信输入：`line()` 会清掉 C0/DEL 控制字符并按上限截断；但条目 id 没有统一做 machineString 校验，见问题 2。已核实。
- 安全/敏感内容：条目的 `sentence` 会进入 `home.snapshot`，推送只带计数不带文字；未发现敏感正文进入日志或推送。但数据分级存在低估，见问题 1。
- 资源耗尽：`mailSource` 忽略 `sourceReadLimit`，每次读最多 500 条 insight 且逐条解封；`awaitingCount()` 在每次要发推送时都可能触发整轮 home 读取。属可接受但值得注意的开销。
- 规则/文档一致性：`ci/operations-pending.json` 的登记与 `scripts/check-operations.mjs` 的判定方式对得上；未发现必须同步的配置文档。
- 未核实：未运行任何测试；契约响应是否在服务端重新 parse（HTTP 路由只 parse 入站 query，出站 snapshot 未见服务端校验）。

## 读代码证实的问题

### 1. 严重度：中 — 敏感内容的数据分级被低估

- 文件：`apps/agent-service/src/production-home.ts:188`、`:212`；`packages/application/src/services/proactive-mail-check-service.ts:1334-1338`、`:1621`；`packages/application/src/services/home-feed.ts:79-86`；`packages/gateway-contracts/src/contracts-v2.ts:741`、`:747-755`；`apps/agent-service/src/production-home.ts:555-559`
- 问题：
  - 邮件条目一律写 `dataClassification: "private"`，但邮件检查保存 insight 内容时用的是 `insight.dataClassification`（可由被召回记忆抬高到 sensitive/restricted）。
  - `upcoming[]` 里带着记忆正文，但 `HomeUpcoming` 和合约里的 upcoming 对象完全没有分类字段。
  - `home.snapshot` 顶层 `dataClassification` 来自客户端 query（`...query` 未覆盖），而不是条目里的最高分级；客户端发 `public` 就会得到一个装着自己敏感记忆文字、却标为 public 的 snapshot。
- 证据：
  - `production-home.ts:188`：`dataClassification: "private",`
  - `production-mail-check-service.ts:1338`：`const dataClassification = highestClassification("private", [ ...promptMemories..., ...summaries... ]);`
  - `production-mail-check-service.ts:1621`：`insight.dataClassification,`（封存正文）
  - `home-feed.ts:79-86`：`HomeUpcoming` 无分类字段
  - `contracts-v2.ts:747-755`：upcoming 对象只有 `reminderId/memoryId/text/dueAt/repeat/sourceThreadId`
  - `production-home.ts:555-559`：`return { ...query, kind: "snapshot", type: "home.snapshot", actor: ..., payload: ... }`
- 建议：在 `readProactiveOverview`/`ProductionMemoryControl.upcomingViews` 中把正文分级带出来；home 统一计算 `max(item.dataClassification)` 并写进 snapshot 顶层 `dataClassification`；`upcoming` 增加分级或至少按最高分级处理。补一条「sensitive 邮件/提醒进入 home」的测试。

### 2. 严重度：中 — 外部提议 id 的生产端与合约校验端不一致（I-73 型）

- 文件：`apps/agent-service/src/production-mcp-memory-writer.ts:184-185`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:139-140`；`packages/persistence-sqlite/src/data-export/schemas.ts:177`；`apps/agent-service/src/production-home.ts:310`、`:314-316`；`packages/gateway-contracts/src/contracts-v2.ts:709`、`:716`
- 问题：外部提议 id 在写入端只校验长度（1-40），存储层只校验 1-128，数据导入 schema 也只是 `text(1,128)`；home 却把它原样放进 `key`（`boundedString(160)`）和 `target.id`（`machineString`）。只要库里有一条 id 含空格、斜杠、Unicode 或控制字符（例如手工/导入的备份），整个 `home.snapshot` 就会校验失败，而不只是这一条消失。正常 MCP 路径用 `randomUUID()`，所以可达性主要来自数据导入/其他调用方，但后果是「一条坏 id 拖垮整个首页」。
- 证据：
  - `production-mcp-memory-writer.ts:184-185`：只判断 `input.proposalId.length < 1 || input.proposalId.length > EXTERNAL_PROPOSAL_ID_MAXIMUM`
  - `sqlite-external-memory-proposal-operations.ts:139-140`：只判断 `input.id.length`
  - `data-export/schemas.ts:177`：`id: text(1, 128)`
  - `production-home.ts:310`：`key: \`external_proposal:${proposal.proposalId}\``；`:316`：`id: proposal.proposalId`
  - `contracts-v2.ts:709`：`key: boundedString(160)`；`:716`：`id: nullable(machineString)`
- 建议：抽一个共享的 proposal id 规则（至少 `machineString` 同构）放到写入/存储/导入三端；或在 home 里对不合约的 id 置空/跳过该条并记诊断。补一条「导入/构造含空格或斜杠 proposalId 的待确认提议」的反向测试，断言 home 仍能返回。

### 3. 严重度：中低 — 超出 reminders 读取上限的到期提醒会再次出现在 upcoming，造成展示重复

- 文件：`apps/agent-service/src/production-home.ts:534-537`；`apps/agent-service/src/production-memory-control.ts:455-499`、`:502-518`；`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:143-159`
- 问题：`upcoming` 只排除 `dueReminderViews(settings.sourceReadLimit)` 返回的那批 `rowIds`。当到期提醒数超过 `sourceReadLimit` 时，多出来的到期提醒仍满足 `listUpcoming` 的 `due_at >= now` 条件，会出现在 `upcoming` 里；同时它们又被算进 `unread`/`awaitingCount`。等于同一条已到期提醒既算「等主人处理」，又显示成「即将到来」。
- 证据：
  - `production-home.ts:536-537`：`const due = await memory.dueReminderViews(settings.sourceReadLimit); return memory.upcomingViews({ ..., exclude: new Set(due.rowIds) });`
  - `production-memory-control.ts:497-498`：`rowIds: rows.map(({ id }) => id), unread: Math.max(0, total - rows.length)`
  - `production-memory-control.ts:510-518`：`listUpcoming({ from: input.now, to: input.until, ... }).filter(({ id }) => !exclude.has(id))`
  - `sqlite-memory-reminder-operations.ts:154-155`：`WHERE ... r.due_at >= ? AND r.due_at <= ?`（只按 `due_at` 过滤，不看 `remind_at`）
- 建议：`upcoming` 应排除所有 `remind_at <= now` 的提醒（或在 `listUpcoming` 增加 `remind_at > now` 条件），而不是依赖有限条数的 `due.rowIds`。补一条「到期数 > sourceReadLimit、dueAt 在未来」的测试，断言这些提醒不出现在 upcoming。

### 4. 严重度：低中 — `awaitingCount()` 在单来源失败时静默返回偏小的件数，推送仍会带这个错数

- 文件：`packages/application/src/services/home-feed.ts:188-220`；`apps/agent-service/src/production-web-push.ts:398-405`
- 问题：`#collect` 把来源异常吞进 `incompleteSources`，`awaitingCount()` 只返回 `Set(size)+unread`，不告诉调用方有来源失败。因此网页推送在 Gmail overview 等来源失败时会带一个偏小的 `app_badge`，而不是像作者说的「函数抛错时不带 badge」——该函数实际上几乎不会抛错。
- 证据：
  - `home-feed.ts:199-202`：`catch (error) { incomplete.push(source.name); this.#options.onSourceFailure(...); }`
  - `home-feed.ts:217-220`：`const { candidates, unread } = await this.#collect(..., true); return new Set(...).size + unread;`
  - `production-web-push.ts:398-405`：`return (await this.#options.awaitingCount()) ?? 0;`
- 建议：让 `awaitingCount()` 在任一 awaiting 来源失败时返回 `undefined`（或返回 `{count, incomplete}`），web push 据此省略 `app_badge`；至少让推送侧知道计数不完整。

### 5. 严重度：低 — 邮件来源没有落实 `runPolicy.homeFeed.sourceReadLimit`，且有 500 条内部硬上限未计入 unread

- 文件：`apps/agent-service/src/production-home.ts:156-214`；`packages/application/src/services/proactive-overview.ts:148`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:998-1009`
- 问题：邮件来源忽略传入的 `limit`，`unread` 固定为 0；而底层 `listInsights` 有 `LIMIT 500`。超过 500 条待处理的 open insight 时，多出的条目既不在列表也不在 unread，件数会少算。审批/敏感记忆请求/规则来源同样忽略 `limit`（好在它们底层未设上限）。
- 证据：
  - `production-home.ts:156`：`async read({ locale })`（未解构 `limit`）；`:214`：`return { items, unread: 0 };`
  - `sqlite-proactive-operations.ts:1006`：`... ORDER BY ... LIMIT 500`
- 建议：要么给邮件来源也按 `limit` 截断并计算 `total - items.length`（需要 overview 返回总数），要么在文档/合约里明确邮件不受 `sourceReadLimit` 约束。

### 6. 严重度：低 — `awaitingCount()` 与 `read().awaitingCount` 只在当前来源顺序/前缀约定下相等

- 文件：`packages/application/src/services/home-feed.ts:164-178`、`:188-220`、`:230-231`、`:249`
- 问题：`read()` 先对所有来源的候选做按 key 去重，再按 `awaitsOwner` 分组；`awaitingCount()` 只读 awaiting 来源。若某个 non-awaiting 来源先返回了与 awaiting 来源相同的 key，`read()` 会把后到的 awaiting 条目丢掉并少计，而 `awaitingCount()` 仍会算它。当前生产来源 key 前缀互不重叠（`insight:`/`reminder:`/`tidy:`/`run:` 等），且 awaiting 来源排在前面，所以今天不触发；但该服务是通用导出的，作者「任何数据下相等」的说法过强。
- 建议：把去重放在 `awaitsOwner` 过滤之后，或在 `read()` 中按 awaitsOwner 分开去重；补一条跨类别同 key 的单元测试。

### 7. 严重度：低 — 缺少关键反向测试

- 文件：`test/integration/home-feed.test.ts`（未覆盖 external proposals、超长/非法字符）、`packages/application/test/home-feed.unit.test.ts`
- 问题：现有测试覆盖了排序、来源失败、awaitsOwner 矛盾、截断计数、网页推送 badge 等；但没有：
  - external proposals 来源的任何集成用例；
  - 超过/等于合约上限的长文本、含控制字符/非法 machineString 的 id；
  - `awaitingCount` 与 `read` 在「跨 awaitsOwner 同 key」时的比较；
  - 到期提醒数 > `sourceReadLimit` 时 upcoming 的去重。
- 证据：`test/integration/home-feed.test.ts` 全文未出现 external proposal 的 seed；`home-feed.test.ts` 中的 reminder 用例只用少量数据。
- 建议：补上述反向用例，尤其问题 1/2/3 的用例；作者声称「内容过长不会让整个响应校验失败」目前没有测试守着。

### 8. 严重度：低 — memory overview 重构后多做了 lead 文本读取，输出未变但成本上升

- 文件：`apps/agent-service/src/production-memory-control.ts:608-644`、`:940-942`
- 问题：`conversationReviewViews` 为 home 计算 `lead`（逐条 `readText`），而 memory overview 调用后又把 `lead` 丢掉。返回内容确实没变，但 overview 的数据库/解密开销增加了。
- 证据：`:940-942`：`(await this.conversationReviewViews(TIDY_UPS_SHOWN)).map(({ lead: _lead, ...review }) => review)`
- 建议：把「带 lead」和「不带 lead」拆成两个方法，或让 overview 使用不读 lead 的版本。

## 推测 / 未核实

- 设备动作文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:527` 里的 `home.read` 是智能家居读取动作；本 PR 的 `home.read` 是网关首页查询。两者命名相同但注册表不同，目前代码不冲突；未来若共用命名空间/审计事件，可能混淆。属推测，未核实是否有统一命名约束。
- `home.snapshot` 出站是否在任何一层被 `gatewayV2MessageSchema.parse` 校验：HTTP 路由只对入站 query 调用 `parseV2BusinessMessage`，`sendJson` 直接发送 service 返回值；未看到出站校验。未核实是否还有其它中间层校验。
- 测试是否实际通过/失败未运行，未核实。上述「反向用例会失败」均为读断言后的推断。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 没有改系统提示、工具定义、历史消息或遮盖逻辑；新增的 `ProactiveOverviewInsight.decisionId/createdAt` 和 `ProactiveOverview.connection.changedAt` 只被 home 使用，`production-proactive.ts:566-583` 的 snapshot 明确只映射旧字段，`daily-review.ts` 只用 `overview.decisions/audit`，未把新增字段送进模型提示。发给模型的内容仍只在末尾追加，每轮变化的值仍只在最后一条消息里。依据：[prompt-prefix 只追加](../../.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求不会。对 `home.snapshot`：`line()` 是确定性的，排序在 key 上做了最终 tie-break，`revision` 由稳定的 `JSON.stringify([items,...])` 生成；`revision` 不含 `generatedAt`。会随请求变化的是显式的 `locale`（不同语言目录文字不同）和 `generatedAt`（当前时间），这些不是同一段文字的遮盖/序列化歧义。`awaitingCount` 使用固定 `"en"` 但只影响标签，不影响键/计数。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有一部分：`packages/application/test/home-feed.unit.test.ts` 覆盖乱序排序、awaitsOwner 与来源矛盾、来源抛错、列表截断仍保留真实计数、unread 相加、同 key 去重、badge 不读非 await 来源；`test/integration/home-feed.test.ts` 覆盖各来源、合约 parse、run SQL 的主要分支、截断计数、badge 与 home 计数一致；`production-web-push.test.ts` 的 `[HOME-count]` 覆盖「只在发送时读计数、undefined/抛错时不带 app_badge」；`startup-configuration.unit.test.ts` 覆盖 `homeFeed` 默认值与越界；合约 fixture 覆盖 `home.snapshot` 解析。缺口见问题 7（external proposals、超长/非法字符、跨类别同 key、超限提醒进 upcoming）。这些用例在移除对应保护时应当失败（读断言可推断），但我没有运行测试，**是否真的会失败未核实**。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `home.read`/`home.snapshot`：合约、`installedOperations`、HTTP `installedGatewayV2Operations`、`ci/operations-pending.json` 均已登记，`check-operations` 能识别。
   - `HOME_ITEM_KINDS`/`HOME_TARGET_TYPES`/`HOME_ORIGIN_TYPES`/`HOME_SOURCE_NAMES`/`HOME_RANKS`/`HOME_ACTIONS`/`HOME_POLARITIES`/`HOME_LOCALES`：生产端用到的值均在枚举内。
   - `homeFeed` 七个配置键：接口、默认值、解析边界、使用处一一对应；`sourceReadLimit`/`upcomingLimit` 的 200 上限与 sqlite reminder 的 200 上限对齐。
   - `memoryReminder.countDue`、`runLifecycle.listUnattended`：适配器字符串与 sqlite switch 分支一致，`limit` 由 `integer` 保证 ≥1、`failedSince` 由 `instantText` 校验。
   - `UnattendedRunRecord.state`：`"running" | "failed"` 与 port 一致。
   - 唯一明确对不上的是**外部提议 id**：写入端只校验长度，home 的 `target.id` 用 `machineString`、import 也只允许任意 1-128 文本，见问题 2。
   - 另外 `upcoming` 正文缺少 `dataClassification`、邮件正文分级恒为 private、snapshot 顶层分级继承 query，见问题 1。

**总体结论**：核心排序、计数聚合、来源失败隔离和网页推送 badge 的接入方向是对的，作者关于「不碰模型前缀」「排序与来源顺序无关（唯一 key 时）」「awaitsOwner 矛盾丢弃」「来源失败写 incompleteSources」「badge 只在发送时取」的说法基本成立。但敏感内容分级、外部提议 id 的跨端校验、超限到期提醒出现在 upcoming 这三处需要在本步骤或第 2 步前修掉；其中 id 校验问题正是 I-73 那类「只看了改动、没问清单里的 id 能不能过后端校验」。
