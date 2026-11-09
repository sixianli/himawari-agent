## 复核结论

### 已读代码证实

#### 高

**1. 已删除的 `session.revoke` 仍被现有测试解析，测试会直接失败**
- 位置：`packages/integration-github/test/github-integration.unit.test.ts:732`
- 问题：作者说这 18 个操作“后端、前端、测试都没有使用”，但该测试仍用 `gatewayV2MessageSchema.parse` 构造 `type: "session.revoke"`。`session.revoke` 已从 `GATEWAY_V2_MESSAGE_TYPES` 和 `schemasByType` 删除，解析会在进入控制面之前抛错。
- 证据：
  - `packages/integration-github/test/github-integration.unit.test.ts:732-742`
    ```ts
    const nonGitHub = gatewayV2MessageSchema.parse({
      ...monitorCommand("revoke", 2),
      type: "session.revoke",
      ...
    }) as Extract<GatewayV2Command, { readonly type: "session.revoke" }>;
    ```
  - `packages/gateway-contracts/src/contracts-v2.ts:2123-2134` 用 `enumeration(GATEWAY_V2_MESSAGE_TYPES).parse(...)` 取 type；`packages/gateway-contracts/src/validation.ts:41-42` 对不在集合里的值调用 `fail`。
  - 该测试是普通 `it`（`github-integration.unit.test.ts:707`），`vitest.workspace.ts` 又包含 `packages/integration-github/**/*.unit.test.ts`，所以会真实执行。
- 建议：把这条“非 GitHub 命令交给既有控制面”的用例改成仍存在的 v2 命令（如 `grant.revoke` 或 `approval.respond`），同步改 payload；再全仓搜一遍被删操作名，确认没有别的测试/脚本残留。

**2. 新的 `check:operations` 抓不到“删除后仍被引用”的问题，本次正好漏过**
- 位置：`scripts/check-operations.mjs:160-166`
- 问题：检查只遍历当前约定里的操作，对“已从约定删除但代码/测试还在用”的名字完全不看。因此 `session.revoke` 这种残留不会让 `check:operations` 报红，反而由普通测试在运行时炸掉；这与它“拦住空壳”的目标形成漏洞。
- 证据：
  ```js
  for (const { name, kind } of operations) {
    ...
    if (!backendTexts.some((text) => text.includes(literal))) missing.push("后端实现");
    if (!frontendTexts.some((text) => frontendSends(text, name))) missing.push("调用方");
    if (!testTexts.some((text) => text.includes(literal))) missing.push("测试");
  ```
  此外，`operations-pending.json` 只校验“名单项在约定里”，也不校验“约定外但代码里仍出现的已删操作”。
- 建议：加一条独立扫描（例如维护被删操作 deny-list，扫描 `apps/*/src`、`packages/*/src`、`test/`，命中即报红），或在 `gatewayV2MessageSchema.parse` 的调用点做静态检查；至少把 `session.revoke` 这个例子补成反向用例，证明检查能拦住同类问题。

#### 中

**3. 0085 迁移没有“旧数据 + 重建后”的自动检查，作者说的迁移测试覆盖名不副实**
- 位置：`packages/persistence-sqlite/src/migrations/0085_memory_reminder_cancelled.sql:1-29`
- 问题：迁移用 `CREATE ... next` → `INSERT ... SELECT` → `DROP` → `RENAME` 重建表，逻辑本身看起来安全（新表保留 `memory_id UNIQUE`、外键、两个索引，旧 `scheduled/dismissed` 行满足新 CHECK）。但仓库里没有任何测试在应用 0085 前插入 `memory_reminders` 行：全仓 `memory_reminders` 只出现在迁移、`sqlite-memory-reminder-operations.ts` 和 `schema-catalog.ts`，测试文件里没有。`migration-engine.contract.test.ts` 等只把序列号 84 改成 85，或从空库按序应用。
- 证据：
  ```sql
  INSERT INTO memory_reminders_next (...)
  SELECT id, owner_id, agent_id, memory_id, due_at, remind_at, repeat, status, dismissed_at,
    created_at, updated_at
  FROM memory_reminders;

  DROP TABLE memory_reminders;
  ALTER TABLE memory_reminders_next RENAME TO memory_reminders;
  ```
  迁移约束：
  ```sql
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'dismissed', 'cancelled')),
  ...
  CHECK ((status = 'scheduled') = (dismissed_at IS NULL))
  ```
- 建议：仿照 `memory-consolidation-basis-migration.contract.test.ts` 新增 `0085` 专用迁移测试：先在 84 版本插入 `scheduled` 与 `dismissed` 各一行，应用 0085 后断言：
  - 两行原样保留；
  - 新约束接受 `cancelled` 且拒绝 `cancelled + dismissed_at NULL`；
  - 两个索引存在；
  - `PRAGMA foreign_key_check` 为空。
  这也能覆盖 `ON CONFLICT (memory_id)` 依赖的唯一约束在重建后仍存在。

#### 低

**4. `isSurfaceInstalled` 与界面清单/作者说法不一致：`sessions-devices` 空操作仍是 `allowed`，`tasks` 也不是“没有任何操作”**
- 位置：
  - `apps/control-center/src/app/control-center-inventory.ts:66-71`（新增 `operations.length > 0`）
  - `apps/control-center/src/app/control-center-inventory.ts:397-412`（`sessions-devices`：`queries: []`、`mutations: []`，但 `contractStatus: "frozen"`、`integrationPolicy: "allowed"`）
  - `apps/control-center/src/app/control-center-inventory.ts:157-168`（`tasks` 仍保留 `github.monitor.set_state`，却写 `contractStatus: "missing"`、`integrationPolicy: "blocked"`）
  - `apps/control-center/test/control-center-inventory.unit.test.ts:104-105`（测试显式豁免 `sessions-devices`、`health-deployment` 的空操作要求）
- 问题：
  - 作者/ADR 说“没有任何操作的页面改成约定缺失、集成被阻止”，但 `sessions-devices` 没有改；`tasks` 也不是“没有任何操作”。
  - `isSurfaceInstalled` 现在对 `sessions-devices` 返回 false，但 `CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS` 仍把它列为 integration-ready（该常量目前只在测试里用）。
  - 实际上 `app.tsx:191-199` 对 built-in identity 的 `sessions-devices` 有 `nativeDevices` 旁路，`health-deployment` 也有特判，所以未发现用户可见的“错误安装/未安装”；问题是清单语义混乱，容易误导后续页面接入。
- 建议：把 `sessions-devices` 像 `health-deployment` 一样显式标注为“走原生身份接口”并在 `isSurfaceInstalled` 里特判，或给清单加 `transport` 字段；同时修正 ADR 文字（`tasks` 仍有一个 GitHub 监控命令，不是零操作）。

**5. schema 目录描述已过时**
- 位置：`packages/persistence-sqlite/src/schema-catalog.ts:660-662`
- 证据：
  ```ts
  entry(
    "memory_reminders",
    "MemoryReminderStorePort",
    "one reminder per Memory, scheduled until dismissed; yearly ones roll forward",
  ```
- 问题：现在还有 `cancelled`，且取消后年度提醒不顺延；描述只提 `dismissed`。
- 建议：改成包含 `cancelled` 和“关闭时间沿用 `dismissed_at`”的说明。

**6. “真取消”并非严格不可逆：取消后仍可被 `snooze`/`dismiss` 重新激活**
- 位置：`apps/agent-service/src/production-memory-control.ts:861-889`
- 证据：
  ```ts
  const next =
    action === "snooze"
      ? { status: "scheduled" as const, ... }
      : action === "dismiss" && reminder.repeat === "yearly"
        ? { status: "scheduled" as const, ... }
        : { status: (action === "cancel" ? "cancelled" : "dismissed") ... };
  ```
  这里没有检查 `reminder.status`；对已 `cancelled` 的提醒再发 `snooze`，会写回 `scheduled`。正常界面不会显示已取消提醒（`production-memory-control.ts:527-558` 只从 `listUpcoming` 返回 `scheduled`），但直接调网关命令仍可行；旧版 `dismissed` 也有同样行为，所以不是本次新引入。
- 建议：若取消应当是终态，在 `memory.reminder.respond` 里拒绝非 `scheduled` 状态上的 `snooze`/`dismiss`（或至少文档写清“取消可通过 snooze 恢复”）。

### 推测 / 未核实

- 未运行任何测试或 `npm run check:operations`（工具限制），所以“真实仓库零报红”我只能从代码推断；`check-operations.test.mjs` 的“passes on the real repository”是否通过未实测。
- `.claude/rules/prompt-prefix.md` 不在本次 sparse checkout 里，未直接读到原文；前缀规则我用 `docs/adr/0149-append-only-model-requests.md:51-58` 的复述核对。
- 未核实历史数据库里是否存在已删除类型的持久化网关消息；代码层没找到调用方，但没查生产数据。
- 迁移重建期间没有类似 `assertDiskHeadroom` 的检查；`memory_reminders` 一般很小，未判为问题。

---

## 侧重检查

查过以下错误路径、不可信输入、安全与不可逆路径：

1. **提醒取消的权限与输入**：`ProductionMemoryControl.execute` 在 `memory.reminder.respond` 前用 `assertOwner`，并核对 `reminder.ownerId/agentId`（`production-memory-control.ts:855-865`）；`ProductionReminderWriter.cancel` 也核对 owner/agent（`production-reminder-writer.ts:289-294`）。SQL 全部参数化。结论：没有发现越权或注入问题。
2. **`cancelled` 的写入与所有读取端**：
   - 写入：`production-memory-control.ts:883-888`、`production-reminder-writer.ts:296-304`；
   - 约束：0085 迁移接受 `cancelled`；
   - 更新校验：`sqlite-memory-reminder-operations.ts:164-169` 现在按 `scheduled <=> dismissed_at IS NULL` 校验，`cancelled` 被接受；
   - 到期/即将到来：`sqlite-memory-reminder-operations.ts:125、142` 只查 `scheduled`，`cancelled` 被排除；
   - Web Push：`production-web-push.ts:472-479` 只对 `scheduled` 生成通知；
   - 界面快照：`production-memory-control.ts:527-558` 只从 `listUpcoming` 取，`cancelled` 不出现。
   结论：读写两端都接受 `cancelled`，没有发现枚举漏判。
3. **迁移不可信/旧数据路径**：外键仅指向 `owners/agents/memory_records`，无表引用 `memory_reminders`；重建保留 `UNIQUE(memory_id)` 和两个索引。未发现引用该表的外键、触发器或视图；数据 copying 保留旧状态。结论：逻辑上安全，但缺少带旧数据的测试（见中 3）。
4. **不可逆操作**：取消保留记忆记录（符合 ADR），但网关允许之后用 `snooze`/`dismiss` 把 `cancelled` 改回 `scheduled`（见低 6）。未发现删除或泄露用户数据的路径。
5. **资源耗尽**：0085 在单个事务内整表重建，会临时多一份表数据；`memory_reminders` 每人每记忆一行，量级小，未判为问题。
6. **规则/文档与代码一致性**：发现 ADR/作者说法与 `session.revoke` 测试残留、`sessions-devices` 清单状态、`tasks` 仍保留一个 mutation、`schema-catalog` 描述过期等不一致，已列在上文。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（基于代码核对）。改动没有触及 `packages/prompt-catalog`、系统提示、工具定义或历史消息组装；`reminder_cancel` 的名称、参数、说明文字在 `production-reminder-writer.ts:86-97` 未变，`apps/agent-service/test/__prompt_golden__/tools.definitions.txt` 也未在 diff 中。`memory.reminder.respond`/`reminder_cancel` 只改变数据库里的 `status` 写入值，没有把新值放进系统提示或工具定义；每轮会变的时间/资料仍只来自最后一条用户消息（规则见 `docs/adr/0149-append-only-model-requests.md:51-58`；`.claude/rules/prompt-prefix.md` 本次未检出，读不到原文）。发给模型的内容仍然是只在末尾追加。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会（就模型请求而言）。改动没有引入时间字段、无序集合或依赖前后文的序列化；迁移 ledger 里的 `applied_at` 不进入模型请求；提醒列表 SQL 仍按 `remind_at,id`/`due_at,id` 排序；`cancelled` 只是被确定性过滤。网关响应的内容会因状态不同而变化，但不会改写已发送给模型的历史。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
- `check:operations`：有 `test/tooling/operations-check.test.mjs`，缺后端、缺调用方（排除界面文案）、缺测试（排除夹具）、名单项已齐全、名单项无理由/不在约定、安装名单含约定外名字等反向用例都断言了具体错误；去掉对应逻辑这些用例会失败。
- 提醒状态：`production-memory-capture.test.ts:1165-1180、1285-1296、1365-1414` 覆盖 cancel=`cancelled`、dismiss=`dismissed`、年度取消不顺延；去掉迁移或状态改动时，`UPDATE ... status='cancelled'` 或断言会失败。
- `isSurfaceInstalled`：`control-center-inventory.unit.test.ts:35-52` 现在会因为空操作页面被排除而得到 `["threads","approvals"]`；把 `operations.length > 0` 删掉，`inbox-digest`/`trace`/`settings`/`sessions-devices` 会被算成已安装，该测试会失败。
- 缺口：没有“0085 带旧数据重建”的测试；也没有“删除后仍有引用”的反向测试，`session.revoke` 就是这么漏掉的（见高 1、高 2）。

**4. 每个改动产生的值，使用它的地方都能接受吗？**
- `status = "cancelled"`：写入端、DB 约束、应用层类型、`update` 校验、到期/即将到来查询、Web Push、界面快照均已核对，全部接受。
- 迁移 `sequence 85` / `changeSet`：迁移引擎、`LATEST_MIGRATION_SEQUENCE`、`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX = 85`、迁移测试序列号均已同步；未发现残留 84。
- 被删除的 18 个操作和 8 个回执：契约、夹具、e2e 服务器、界面清单、i18n 残留（仅文案 id）已清理；但 `packages/integration-github/test/github-integration.unit.test.ts:734、742` 仍使用 `session.revoke`，使用端不接受（见高 1）。
- `ci/operations-pending.json` 的 23 个键：脚本会校验“名单项必须在约定里”，当前键看起来都能对上；未逐个程序化核对（未运行脚本）。
- 清单项：`sessions-devices` 空操作仍 `frozen/allowed`，`tasks` 仍有 `github.monitor.set_state` 却标 `missing/blocked`，与“零操作才 blocked”的规则不一致（见低 4）。

**总体结论**：提醒状态和迁移本身的代码路径基本自洽，删除操作也清理得比较彻底；但本次至少有一个真实的测试调用方（`session.revoke`）漏删，会让 CI 失败，且新增的 `check:operations` 无法发现这类残留。建议先修该测试并补一条“已删操作不得再被引用”的门槛，再补 0085 的旧数据迁移测试。
