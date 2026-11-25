本轮只复核了增量 `f8d1cbe..c42712b4`（含合并 main 带入的 PR 635、PR 639）。查过：`production-web-push.ts`、`service-main.ts`、`sqlite-web-push-operations.ts`、`20261124212416_main_thread.sql`、两处新增/改动的推送测试、`verify-source-cache-fixtures.mjs` 与 `source-cache.mjs`、ADR 0258、`client-capabilities.ts`、生成的 `ClientCapabilities.swift`、README/S12/canvas 的文档改动。没有运行测试；`.agents/reviews` 下的复核记录被策略拒绝读取，未核实，以你给的摘要为准；原型 HTML 全文没有逐屏读。未发现高、中严重度问题。

### 1. 低：只有内部回话的运行会退回通用“已完成”推送，新分支没有用例
文件：`apps/agent-service/src/production-web-push.ts:452-472`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:722-726`

问题：新增 `reply.internal = 0` 后，若一次运行（`startedBy === "user_message"`、`completed`）唯一的已提交 agent 消息是内部消息，`replyMessageId` 变成 NULL，代码不会 `continue`，而是落到 `run:${runId}:${status}`，主人会收到“已完成”加对话标题，而不是“她的回话”或干脆不推。新测试分别覆盖了“跳过内部消息挑更早的回话”（SQLite）和“outbox 里的内部消息作废”（生产推送），没有覆盖“只有内部回话”这个新分支。

证据：
```ts
if (run.startedBy === "user_message" && run.status === "completed" && run.replyMessageId) {
  items.push({ ... sourceRef: run.replyMessageId ... });
  continue;
}
items.push({ ... sourceKey: `run:${run.runId}:${run.status}...` ... });
```
```sql
AND reply.role = 'agent' AND reply.message_status = 'committed'
AND reply.internal = 0
ORDER BY reply.sequence DESC LIMIT 1) AS replyMessageId
```
补充：当前生产代码里 `commitAssistantMessage` 的插入不含 `internal` 列（`sqlite-thread-operations.ts:1306-1309`，默认 0），只有 `admitOwnerMessage` 会写 owner+internal（`sqlite-thread-operations.ts:1203-1219`），所以 role=agent 的内部消息目前只有测试直接插库能造出来，这条分支暂时不可达，故列为推测性低问题。

建议：补一条“内部回话是唯一 agent 消息”的反向用例，并明确该场景是作废整次运行推送还是退回“已完成”，不要只靠现有两个用例。

### 2. 低：源码缓存夹具的修复没有可稳定复现的自动检查，根因是推断
文件：`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:8`、`:70-72`

问题：这次只改了夹具的 git 环境（`maintenance.auto=false`、`gc.auto=0`），提交说明也写明本机 git 2.43 复现不了、根因是按报错路径和 git 版本推断。夹具里没有任何断言确认这些配置生效，也没有覆盖 ENOTEMPTY 的用例；如果真正写文件的是别的后台进程或文件系统时序，CI 还会再 flake。清理仍然是无条件 `rmSync(..., { recursive: true, force: true })`。

证据：
```js
const env = { ..., GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" };
```
```js
} finally {
  rmSync(root, { recursive: true, force: true });
}
```
建议：下一次 CI static 通过只能算验证；可在清理前等待/重试，或显式给 `git fetch` 加 `--no-auto-maintenance`，让“关掉后台维护”这件事不依赖全局 env 推断。

## 上一轮意见核对

第 2 轮第 4 条（ADR 0258 仍写客户端能力表是旧对应）已改好。ADR 现在写“`approvals`、`suggestions` 对主对话（`chat`），`capabilities-adapters`、`improvements` 登记为这一版手机上不做”（`docs/adr/0258-each-apple-device-plays-to-its-strength.md:108`），与 `packages/gateway-contracts/src/client-capabilities.ts:387-398` 完全一致，生成的 `NativePage` 枚举也已去掉 `today.approvals`/`today.suggestions`/`settings.capabilities`/`settings.improvements`（`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:61-67`）。Swift 里只有页面枚举、没有逐页映射，ADR 的说法宽松但不错误。

## 读代码证实的

- 内部消息推送链路是端到端接上的：SQLite 列 `internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1))`（迁移 `20261124212416_main_thread.sql:9`）；查询过滤 `reply.internal = 0`（`sqlite-web-push-operations.ts:725`）；`service-main.ts:3083-3088` 只有 `role === "agent"` 且 `internal === true` 才透传；`production-web-push.ts:885` 读到内部消息直接作废。
- 反向用例在逻辑上确实会失败：去掉 `AND reply.internal = 0`，`inner-b`（sequence 4）会成为 `replyMessageId`，SQLite 测试期望的 `"said-b"` 不成立（`test/integration/sqlite-web-push.test.ts:481-501`）；去掉 `message.internal === true`，生产推送测试会多推一条“子线程：邮件已经看完了。”，期望只推一条不成立（`test/integration/production-web-push.test.ts:838-875`）。
- 夹具的 `run` 把同一份 `env` 传给所有 git 调用，`source-cache.mjs` 的 init/fetch/checkout 也都走这个 `run`（`source-cache.mjs:17-31`），所以 `maintenance.auto`/`gc.auto` 对整条链路生效。
- 新增的 `internal` 字段是可选字面量 `true`，唯一的生产实现端 `service-main.ts` 已正确传；其它 `new ProductionWebPush` 都在测试里且不传该字段，可选类型兼容。
- 合并 main 带入的 PR 639 文档改动彼此一致：README 说“第一排在第 66 版加了一屏”（`README.md:10`），S12 写“第 66 版在第 1 排补了‘展开往来’一屏”（`docs/execution/specs/2026-11-11-apple-device-body-design.md:84`），canvas 宽度从 3436 改为 3862。

## 推测、未核实

- ENOTEMPTY 的根因（git 2.56 在 fetch 后后台自动维护）和这次配置是否足以彻底消除竞态：未核实，提交说明自己也写明是按报错和版本推断、本机复现不了。
- 内部回话是唯一 agent 消息时的“已完成”推送后果：代码分支已证实，但当前生产写不出 role=agent/internal=1，属未来子线程功能才会触发，见意见 1。
- 原型 `NextChat.dc.html` 的新屏内容没有逐句核对；`.agents/reviews` 记录因策略拒绝读取。

## 侧重检查

- 错误路径：内部消息、消息被删/非 agent/线程不可读，都会走 `{ expired: true }` 并被 `#record(..., "expired", null)` 收口（`production-web-push.ts:625-628`），不会重试泄漏；`settled()` 也会把内部消息报成已处理（`:689`），符合预期。
- 不可信输入：`internal` 来自数据库且列有 CHECK；`readMessage` 只接受 `role === "agent"`；新增的 git 配置键/值是固定字面量，没有拼接用户输入。
- 安全：Web Push 和 Apple Push（companion）共用 `contentOf` → `#content`（`production-web-push.ts:593-604`、`production-apple-push.ts:357`），所以内部消息不会出现在锁屏；普通“运行完成”推送只用标题，不读消息正文（`:971-987`），不会换路径泄漏。
- 资源耗尽：作废项落到 expired 记录并被清理，没有无限重试；新增配置只关闭后台维护，不影响夹具原有的 bundle 校验、权限检查。
- 不可撤销操作：增量没有涉及。
- 规则/说明/代码一致：ADR 0258 与能力表、生成 Swift 一致；README/S12/canvas 版本号一致；夹具注释与代码说法一致。

## 必答问题

1. 不涉及。本轮增量没有改系统提示、工具定义、历史消息或遮盖结果；`internal` 只用于推送过滤，而且内部消息本来就在上下文之外（`test/integration/main-thread.test.ts:310-319` 可证）。没有新的每轮变化值被放到最后一条消息之外。
2. 不涉及。增量没有引入依赖前后文的遮盖、时间字段或无序集合进入模型请求；夹具里的 git 提交时间只影响临时测试仓库自身。
3. 内部消息推送改动的两个反向用例经代码推演确会失败（见上文证据），但未实际运行。夹具修复没有确定性的反向用例，只能等 CI static 复现/通过来验证。ADR 与 README/S12 只受文档校验约束，没有行为测试。
4. 已逐个核对：`internal` 字段的生产端（`service-main.ts:3083-3088`）、消费端（`production-web-push.ts:241`、`:885`）、数据库端（迁移 `:9`、查询 `:725`）两端校验一致；`GIT_CONFIG_*` 由 `run` 覆盖夹具内所有 git 调用；ADR 0258 的页面去处与 `CLIENT_PAGE_TABLE`、生成 Swift 一致。没有发现“产生端能产生、使用端不接受”的值。
