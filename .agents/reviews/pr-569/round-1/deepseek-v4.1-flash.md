## 核对范围说明

本次实际改动是 `013f760bd` 和 `8325d2703` 两次提交。`git log 4d12029..d5ae1fe` 只有 `d5ae1fe 送达时机设置返回三语名称、说明和单位 (#566)`，说明对比基准不是当前分支的祖先；diff 里 `delivery-timing-copy.ts` 的删除、`delivery_timing.settings.read` 去掉 `locale`、`.agents/reviews/pr-566` 的删除都来自基准上的 #566，不是 PR 569 的内容，我在下面的结论里没有把它们算作本 PR 的问题。

## 侧重检查

- **错误路径**：看了 `#deleteOpen` 的事务边界、载荷文件删除失败、`deleteExpiredThinkThreads` 的批量循环、`ThinkThreadRetention` 的异常捕获和 `stop()`。发现两处值得说：删除选择与真正删除之间没有二次校验未结束运行；载荷文件删除失败后自动清理不会重试。
- **不合规范/不可信输入**：`deleteExpiredThinkThreads` 校验了 `limit`（1–500）和两个时间能否 `Date.parse`；SQL 只用参数绑定，没有拼接输入；`threadRetentionDays` 的配置解析、设置修改和读取端都校验了 1–90。未发现客户端可直接传入授权字段或删除参数的路径。
- **安全/越权**：删除 SQL 同时限定 `owner_id`、`agent_id`、`origin = 'think'`、`status = 'open'`；新测试也证明客户端自己用 `thread:think:` 前缀建的 `owner` 对话不会被删。删除入口没有绑到网关。诊断只写 code 和 error name，不带内容。
- **资源耗尽**：单轮最多 1000 个（20 批 × 50），单个连接；批次之间没有取消点。删除失败可能留下加密文件，见第 2 条。
- **不可撤销操作**：自动删除没有主人确认，这是方案明确同意的例外；但并发窗口和失败后的载荷文件残留会让“7 天后删干净”不完全成立。
- **规则/文档一致性**：`docs/architecture-v0.1.md` 已更新；但方案要求的 ADR 没有写，且“`deleteImmediately` 重构后行为不变”与共享删除路径新增 `title_ref` 的事实不完全一致。
- **未核实**：没有实际运行测试；App 客户端是否接受第 11 项和 `days` 单位不在本仓库核对；生产数据库是否始终处于 WAL、`writeServiceDiagnostic` 在实际关闭中的行为未现场验证。

### 1. 中 — 到期选择与真正删除不在同一个事务，删除时只复查 active 定时任务，不复查未结束运行

文件：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:494-517`、`:532-545`、`:798-838`

问题：`deleteExpiredThinkThreads` 先用一条 SELECT 选出到期线程，再逐个调用 `#deleteOpen`。SELECT 里排除了未结束运行，但 `#deleteOpen` 只重新检查 active 的 `scheduled_jobs`，没有重新检查 `runs`。如果在线程被选中之后、`#deleteOpen` 删除之前，想一想工人或重试路径在这个线程上新建/恢复了一次运行，线程及其运行会被直接删掉，违反“有未结束运行的不删”。同样，如果线程在这段窗口里被恢复成 active，也会按旧的选择结果被删。

【读代码证实】
```sql
AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id
  AND r.status NOT IN ('completed', 'failed', 'cancelled'))
```
```ts
const activeTaskIds = this.#values(
  database,
  `SELECT id FROM scheduled_jobs WHERE thread_id = ? AND status = 'active' ORDER BY id`,
  [objectId],
);
if (activeTaskIds.length > 0) { throw new GovernedDeletionError(...) }
```
```ts
database.prepare("DELETE FROM runs WHERE thread_id = ?").run(objectId);
```
`#deleteOpen` 里没有对 `runs` 的二次检查。

【推测】这是并发窗口，不是单线程下能稳定复现的路径；但归档失败、停在 active 的想一想线程正是会被重试和清理同时看到的对象，窗口不是纯理论。

建议：把“仍未到期、没有未结束运行、仍是 think”这样的条件放进删除事务里做条件删除，或至少在 `#deleteOpen` 被清理路径调用时在事务内重新执行一次 `runs` 和 `archived_at/updated_at` 条件；条件不满足就跳过这个线程，而不是整轮抛错。

### 2. 中 — 载荷文件删除失败或进程在事务后崩溃时，加密文件可能永久残留，而且这次清理会被当成“已删除”

文件：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1300-1334`、`:640-659`、`apps/agent-service/src/production-think-retention.ts:59-67`

问题：`#deleteOpen` 的核心删除在事务里完成，随后 `#deletePayloadFiles` 才删加密文件；文件删除失败会被捕获并标记 `payload: failed`，`#deleteOpen` 返回 `lifecycle: "deletion_pending"`。但 `ThinkThreadRetention.runOnce` 只按 `reports.length` 计数，不区分成功和失败；线程行已经从 `threads` 删除，下一次清理不会再选中它。全仓检索里 `purgeExpiredTrash` 只有 admin CLI 和测试调用，服务运行时没有自动重试这些 pending tombstone 的路径。结果是：线程、消息和载荷行已经删掉，但密文文件可能留在磁盘上，直到有人手工跑 purge。这使“加密文件也按 7 天完整删除”在失败路径和崩溃路径上不成立。

【读代码证实】
```ts
} catch (error) {
  return Object.freeze({
    ...record,
    targets: Object.freeze({
      ...record.targets,
      payload: targetState(
        "failed",
        attempts,
        error instanceof GovernedDeletionError ? error.code : "PAYLOAD_DELETE_FAILED",
      ),
    }),
  });
}
```
```ts
const verified = TARGETS.every(
  (target) => afterArtifacts.targets[target].status === "verified",
);
const finalRecord: StoredDeletionRecord = Object.freeze({
  ...afterArtifacts,
  lifecycle: verified ? "deleted_verified" : "deletion_pending",
});
```
```ts
deleted += reports.length;
if (reports.length < BATCH) break;
```
【读代码证实】`purgeExpiredTrash` 只在 `sqlite-governed-deletion.ts:662-695` 定义，检索到的调用方是 `apps/admin-cli/src/index.ts:687` 和测试。

【推测】如果服务运行期间一直没人手工 purge，这些文件会一直留着；进程在核心事务提交后、文件删除前崩溃也会留下同样状态。

建议：让清理任务在后续轮次也扫描 `deletion_tombstones` 中对象类型为 `thread`、来源是想一想、且 `status = 'incomplete'` 的记录，重试 `#deletePayloadFiles`；或者让 `runOnce` 把 `lifecycle !== "deleted_verified"` 视为失败并写入诊断，不要只按 `reports.length` 报告成功。

### 3. 中低 — 新增的 `title_ref` 清理没有测试，而且它让 `deleteImmediately` 的行为也变了

文件：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1019-1023`、`:456-466`；`test/integration/think-runner.test.ts:647-650`、`:681-682`；`test/integration/sqlite-governed-deletion.test.ts:91-109`

问题：作者说“顺带补删 `threads.title_ref` 载荷”，代码确实在共享的 `#threadPayloadRefs` 里加了这一行。这个函数不只给新的清理路径用，也给 `deleteImmediately` 用（`deleteImmediately` → `#deleteOpen` → `#deleteCore`），所以停服时的永久删除现在也会多删标题载荷。这与“`deleteImmediately` 重构后行为不变”的说法不一致：锁和停服要求没变，但删除的载荷集合变了。更关键的是，这条新增逻辑没有自动检查：新测试只断言 `content_ref`，`sqlite-governed-deletion.test.ts` 的线程 fixture 也只有 `metadata_ref`，没有任何 `title_ref` 用例。把这一行删掉，现有测试不会失败。

【读代码证实】
```ts
...this.#values(
  database,
  "SELECT title_ref FROM threads WHERE id = ? AND title_ref IS NOT NULL",
  [threadId],
),
```
【读代码证实】`deleteImmediately` 现在直接转调共享路径：
```ts
return await this.#deleteOpen(database, input.objectType, objectId);
```
新测试只收集消息的 `content_ref`：
```ts
const contentRefs = sql(
  "SELECT content_ref AS ref FROM thread_messages WHERE thread_id = ?",
  thinkId,
).map((row) => String(row["ref"]));
```
测试 fixture 里没有插入 `title_ref`（`sqlite-governed-deletion.test.ts:91-109`）。

建议：在 `sqlite-governed-deletion.test.ts` 的 fixture 中给线程加一个 `title_ref` 和对应的 ciphertext 文件，分别覆盖 `deleteImmediately` 和想一想清理；同时把“`deleteImmediately` 行为不变”改成“锁和停服要求不变，标题载荷现在也删除”。

### 4. 低 — 反向用例没有覆盖 active 定时任务、active 的 +1 天宽限、设置读取失败、加密文件和开始/停止等待

文件：`test/integration/think-runner.test.ts:609-690`；`apps/agent-service/src/production-think-retention.ts:36-67`

问题：现有新增测试确实覆盖了“主人自己的 `thread:think:` 对话不删”“有未结束运行不删”“越界设置退回默认值”这三个反向点，而且如果去掉 `origin = 'think'` 过滤或去掉 `runs` 的 `NOT EXISTS`，测试会失败，这点是有效的。但还缺：
- `scheduled_jobs.status = 'active'` 时不删；
- `archived_at` 与 `updated_at` 两条截止线，特别是 active 分支的“天数 + 1”没有被区分测试（3 天、2 天这组用两种算法都会通过）；
- `overrides()` 抛错时退回默认值；
- 加密文件实际被删（现在只检查 `payloads` 行）；
- `title_ref` 载荷被删；
- `start()`/`stop()` 会等待正在跑的一轮、诊断失败不会让服务崩溃。

【读代码证实】新测试里只有一条时间推进断言：
```ts
clock.value = later(30);
expect(await retention.runOnce()).toBe(0);
sql("UPDATE runs SET status = 'completed' WHERE thread_id = ?", thinkId);
clock.value = later(3);
expect(await retention.runOnce()).toBe(0);
overrides = { threadRetentionDays: 500 };
expect(await retention.retentionDays()).toBe(7);
overrides = { threadRetentionDays: 2 };
expect(await retention.runOnce()).toBe(1);
```
没有 `scheduled_jobs` 插入，没有 `overrides` 抛错，没有文件存在性断言。

建议：按上面每一条各加一条会失败的用例，尤其是 active 分支要在“正好 `days + 1` 之前”断言不删、在“等于/超过”断言删除；加密文件要在 `stateRoot/data/payload-ciphertext` 下断言文件不存在。

### 5. 低 — 方案要求的 ADR 没有写，自动删除例外只在架构文档里出现

文件：`.agents/plan-drafts/think-thread-retention-plan.md:34`；`docs/architecture-v0.1.md:437`

问题：方案第 6 条明确要求“另写一份 ADR，记录‘系统自动删除想一想对话’是‘永久删除要主人确认’的一个例外”。diff 和仓库里没有新增对应 ADR，只有 `docs/architecture-v0.1.md` 的运行说明和现有 ADR 0274。对于“不可撤销的自动删除”这种例外，缺少 ADR 会让后来的人无法知道边界和决定依据。

【读代码证实】方案原文：
```md
6. 文档：更新 `docs/architecture-v0.1.md` 里讲想一想对话的两段。另写一份 ADR，记录“系统自动删除想一想对话”是“永久删除要主人确认”的一个例外。
```
仓库中没有与 `think retention` / `自动删除想一想` 对应的 ADR 文件（`docs/adr/0274` 讲的是入口，不包含保留期删除）。

建议：补一份 ADR，写清只删 `origin = 'think'`、保留期取值范围、失败/崩溃后的处理、与 `deleteImmediately` 停服锁的关系。

### 6. 低 — 诊断回调抛错时，`#running` 会变成被拒绝的 Promise，`stop()` 可能把错误带进服务关闭流程

文件：`apps/agent-service/src/production-think-retention.ts:74-84`、`:91-95`；`apps/agent-service/src/production-http-composition.ts:1859-1863`

问题：`start()` 的链是 `runOnce().catch(...).finally(...)`。如果 `onDiagnostic` 自己抛错，`.catch` 处理器抛出，`.finally` 会返回一个被拒绝的 Promise 并赋给 `#running`。`stop()` 直接 `await this.#running`，于是关闭服务时会抛错，后面的 `home.stopScoring()`、`app.close()` 可能被跳过。作者说“失败只记诊断，不让服务崩”，这里有一个诊断失败反过来影响关闭的路径。

【推测】`writeServiceDiagnostic` 正常只是 `output.write`，大多数时候不会抛；只有在输出流关闭/异常等情况下才会出现，未实际复现。

建议：把诊断调用包在 try/catch 里，保证 `.catch` 永远返回 0；`stop()` 也吞掉这次运行的异常（仍然等待完成），避免关闭流程被诊断输出影响。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 没有改 `packages/prompt-catalog`、系统提示、工具定义、历史消息组装或遮盖逻辑；新增的 `production-think-retention.ts` 只在运行结束后清理隐藏的 `origin = 'think'` 对话，`sqlite-governed-deletion.ts` 只做删除。删除的想一想线程不会被后续对话当作历史复用；我也没有找到删除会改写某条已发消息的逻辑。发给模型的内容仍然只在末尾追加，每轮变化的值没有新增到系统提示或更早位置。未核实的地方是仓库外的 App 客户端展示，和模型请求无关。

2. **同一段文字会不会在不同请求里变成不同字节？** 这个改动本身不会。新增设置的名称、说明、单位都是静态文字；`THINK_SETTING_DEFINITIONS` 是固定数组，新增项固定排在最后；删除 SQL 用 `ORDER BY COALESCE(...), t.id`，结果顺序确定；没有新增依赖对象遍历顺序的集合序列化。清理使用当前时间只影响“删哪些行”，不会写进发给模型的文字。`think.settings.read` 里原有的 `generatedAt` 仍是接口字段，不是模型输入。

3. **有没有对应的自动检查，反向用例真的会失败？** 有基本检查，但不完整。`test/integration/think-runner.test.ts:609-690` 覆盖了正常删除、主人同名前缀对话不删、有未结束运行不删、越界设置退回默认值；去掉 `origin = 'think'` 或 `runs` 的 `NOT EXISTS` 时这些断言会失败。`test/integration/think-settings.test.ts:229-248` 覆盖了第 11 项、`days` 单位和三语文字，并通过 gateway schema 解析。缺的反向检查见第 4 条：active 定时任务、active 分支的 +1 天、设置读取抛错、加密文件、`title_ref`、`start/stop` 都没有会失败的用例。

4. **新增/修改的每个值，两端的校验都能接受吗？**
   - `threadRetentionDays`：产生于 `THINK_SETTING_DEFINITIONS`（`packages/application/src/ports/configuration.ts:434`，1–90，默认 7）；配置解析端 `parseThinkInbox` 动态按定义校验（`packages/platform-node/src/strict-configuration.ts:1394-1403`）；设置修改端 `ProductionThinkSettings.change` 校验整数和范围（`apps/agent-service/src/production-think-settings.ts:239-245`）；读取端 `ThinkThreadRetention.retentionDays` 再校验一次（`production-think-retention.ts:37-49`）；gateway 的 `think.settings.snapshot` 用 `machineString` 接受 key/unit，未枚举限制（`packages/gateway-contracts/src/contracts-v2.ts:883-900`）。两端都能接受。
   - 新单位 `days`：`THINK_SETTING_UNITS`、`THINK_SETTING_UNIT_TEXT` 都已加（`production-think-settings.ts:136-146`），gateway 用字符串，未发现其他枚举消费者。
   - `title_ref`：生产端是线程标题写入（`sqlite-thread-operations.ts` 的 `title_ref`），消费端现在是 `#threadPayloadRefs`；外键存在，`#payloadReferenced` 会保护共享载荷。但这条消费没有测试，见第 3 条。
   - `deleteExpiredThinkThreads` 的 `limit`：适配器限制 1–500，唯一调用方传 50（`production-think-retention.ts:4`、`:59-63`），匹配。
   - 诊断 code `think.retention_failed`：走通用的 `writeServiceDiagnostic`，没有白名单限制，能接受。
   - 需要修正的说法：`deleteImmediately` 并非“行为完全不变”，它通过共享 `#threadPayloadRefs` 也开始删除 `title_ref` 载荷。
