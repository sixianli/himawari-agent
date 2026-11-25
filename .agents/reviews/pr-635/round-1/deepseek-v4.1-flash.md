## 主要意见

### 1. 高：生产代码没有任何路径写入 internal=1 的助手消息，本次修复对真实数据是空转，作者对 PR 631 的描述与代码不符

**文件:行**：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1203-1206`、`:1306-1309`；`packages/application/src/ports/threads.ts:73-88`；`apps/agent-service/src/service-main.ts:3071`

**问题**：作者说“主对话和子线程之间的往来、收件箱事件、相关工具步骤都标成内部”，并称本次要拦的是 `thread_messages.internal=1` 的助手消息。但当前提交里，只有 `admitOwnerMessage` 的 INSERT 带 `internal`，且该 INSERT 把 `role` 写死为 `'owner'`；`commitAssistantMessage` 的 INSERT 根本没有 `internal` 列，`CommitAssistantMessageInput` 也没有 `internal` 字段。也就是说，当前生产代码不可能写出 `role='agent' AND internal=1` 的消息。本次新增的 SQL 条件 `reply.internal = 0` 和 `#content` 里的 `message.internal === true` 都只能被测试里手工插入的行或伪造的 `readMessage` 触发。

**证据**：
- 仅 owner 写入带 internal：
```ts
INSERT INTO thread_messages (
  id, owner_id, agent_id, thread_id, revision, sequence, role,
  content_ref, classification, committed_at, turn_id, run_id, message_status, internal
) VALUES (?, ?, ?, ?, 1, ?, 'owner', ?, ?, ?, ?, ?, 'committed', ?)
```
`sqlite-thread-operations.ts:1203-1206`
- 助手消息写入没有 internal，直接落到列默认值 0：
```ts
INSERT INTO thread_messages (
  id, owner_id, agent_id, thread_id, revision, sequence, role,
  content_ref, classification, committed_at, turn_id, run_id, message_status
) VALUES (?, ?, ?, ?, 1, ?, 'agent', ?, ?, ?, ?, ?, 'committed')
```
`sqlite-thread-operations.ts:1306-1309`
- `CommitAssistantMessageInput` 没有 `internal`：`packages/application/src/ports/threads.ts:73-88`
- 生产代码里没有任何调用传 `internal: true`；`apps/agent-service` 里带 `internal: true` 的只有测试和 service-main 的“从仓库读出后原样传递”这一处。

**建议**：要么在这个 PR 一并补上真正的写入路径（例如给 `commitAssistantMessage` / 内部事件 / 工具步骤写入加上 `internal`，并用真实命令服务做集成测试），要么明确本 PR 只是为后续写入路径做防御，并在说明里删掉“PR 631 已经把子线程往来、工具步骤标成内部”的说法。否则这次的安全修复在本提交上无法被真实生产数据验证。

**分类**：读代码证实。

### 2. 中：只有内部消息的用户消息运行会改推“已完成”，与规格“你的消息叫起的运行不再推已完成”冲突，且没有用例

**文件:行**：`apps/agent-service/src/production-web-push.ts:452-472`、`:971-987`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:349`、`:356`

**问题**：`listFinishedRuns` 过滤掉 internal 回复后，`replyMessageId` 变成 `null`，代码会走 `run:${run.runId}:${run.status}` 的普通运行完成推送。这个分支的标题/正文来自线程标题，不是内部消息原文，所以不直接泄露消息内容；但规格明确说“你的消息叫起的运行，跑完不再推‘已完成’，改成推她回你的那句话”，并说子线程跑完不再自动推。作者的说明把退回“已完成”当成可接受行为，这与 ADR/规格不一致。新增的 Web Push 用例里同时有一条公开回复，因此没有覆盖“只有内部 agent 消息”这一分支；SQL 用例只验证 `replyMessageId` 为 `said-b`，也没有验证仅内部消息时是否应该完全沉默。

**证据**：
```ts
if (run.startedBy === "user_message" && run.status === "completed" && run.replyMessageId) {
  ... her words ...
  continue;
}
items.push({
  sourceKey: `run:${run.runId}:${run.status}...`,
  kind: "run",
  ...
});
```
`production-web-push.ts:452-472`
```ts
const title = await this.#title(item.threadId);
...
title: unconfirmed ? ... : failed ? ... : WEB_PUSH_TEXT[locale].completed,
body: title ?? WEB_PUSH_TEXT[locale].untitled,
```
`production-web-push.ts:971-987`

**建议**：先决定语义：用户消息叫起、但没有任何非内部回复的运行，应该完全静默，还是允许“已完成”。按现有 ADR/规格，建议对 `startedBy === "user_message"` 且 `replyMessageId === null` 的情况跳过运行完成推送；如果确实要保留“已完成”，应在规格里改清楚并补一条“仅有内部回复”的用例。

**分类**：读代码证实的代码行为与规格冲突；是否应该沉默属于产品决定。

### 3. 中：运行完成推送仍包含子线程，标题又取自首条 owner 消息且未排除 internal，可能把内部标题推到手机

**文件:行**：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:731-740`；`apps/agent-service/src/production-thread-titles.ts:61-73`

**问题**：`listFinishedRuns` 只用 `NOT EXISTS (... origin = 'think')` 排除旧的 think 线程，没有排除主对话/子线程体系里的子线程。子线程运行如果进入这里，会走普通运行完成推送，标题来自 `threadTitle`。而自动标题生成只跳过 `origin === "think"` 和主对话，取的是该线程第一条 `role='owner' AND status='committed'` 的消息，没有 `internal = 0` 条件。若以后内部消息（尤其是内部 owner 消息）用于子线程任务说明，标题可能直接由内部内容生成，再通过运行完成推送显示在锁屏上。这一条的后半段是推测，因为当前还没有生产代码写 internal=1 的 owner/agent 消息；但“SQL 没排除子线程”和“标题取首条 owner 消息且不看 internal”是读代码证实的。

**证据**：
```sql
AND NOT EXISTS (SELECT 1 FROM threads hidden
  WHERE hidden.id = runs.thread_id AND hidden.origin = 'think')
```
`sqlite-web-push-operations.ts:734-735`
```ts
const messages = await this.options.threads.listMessages(ownerId, agentId, threadId, 0, 20);
const first = messages.find(
  (message) => message.role === "owner" && message.status === "committed",
);
```
`production-thread-titles.ts:70-73`

**建议**：运行完成推送应只针对主对话，或按规格显式排除子线程；自动标题生成应跳过 `internal === true` 的 owner 消息，避免内部任务说明变成可推送的标题。补充“子线程完成不推送”和“internal owner 消息不能成为标题”的测试。

**分类**：SQL 与标题来源读代码证实；“内部标题会被推到锁屏”是推测，依赖未来写入 internal owner 消息。

### 4. 低：service-main 的 internal 传递和 Apple/companion 推送路径没有自动检查

**文件:行**：`apps/agent-service/src/service-main.ts:3068-3073`；`test/integration/production-web-push.test.ts:838-876`；`test/integration/push-channels.test.ts:514-556`

**问题**：本次改了三处源码，但自动检查只覆盖了其中两处：SQL 的 `reply.internal = 0` 和 `#content` 的 `message.internal === true`。`service-main.ts` 把仓库里的 `internal` 传给推送适配器这一处没有被测试覆盖；新 Web Push 用例是直接伪造 `readMessage` 返回 `internal: true`，不会发现 service-main 某天漏传 `internal` 的回归。iPhone/APNs 路径虽然复用同一个 `#content`，但 `push-channels.test.ts` 没有对应的 internal 用例。因此“反向用例会失败”只对两个直接改动成立，不能保护整条读取链路。

**建议**：增加一条使用真实 SQLite 仓库和真实 `readMessage` 适配器的用例，或至少对 service-main 的适配逻辑做单元测试；iPhone/APNs 路径加一条 internal 消息不推送的用例，确认 companion 的 `contentOf` 也拦得住。

**分类**：读代码证实（通过 diff 与现有测试范围核对）。

## 侧重检查

- **错误路径**：`readMessage` 返回 `undefined`（消息已删/读取失败/非 agent）和现在新增的 `internal === true` 都返回 `{ expired: true }`，`#deliver` 会记 `expired` 而不发送，见 `production-web-push.ts:625-627`、`:885`。这是读代码证实的。
- **不合规范或不可信输入**：`internal` 只来自数据库列 `INTEGER NOT NULL ... CHECK (internal IN (0, 1))`（迁移 `20261124212416_main_thread.sql:9`），不是外部请求直接传入；SQL 使用绑定参数，没有新注入面。读代码证实。
- **安全与泄露**：Web Push、Mac placement、Apple/companion 最终都经过 `contentOf → #content`，所以 `internal` 守卫对这几条路都生效。仍有两个绕过点值得关注：运行完成推送的标题路径（意见 3），以及当前 internal 助手消息根本不存在导致守卫无法在生产中生效（意见 1）。前者部分为推测。
- **资源耗尽**：只多了一个子查询条件，没有新增循环、无界集合或额外重试；没有发现资源耗尽风险。读代码证实。
- **不可撤销操作**：internal 推送被记为 `expired`，即永久不再发送该条通知；这符合“不能推到手机”的目标，但没有发现删除数据等不可撤销副作用。
- **规则/说明文档与代码一致**：作者关于“PR 631 已把子线程往来、工具步骤标成内部”的说法与当前代码不符（意见 1）；退回“已完成”的选择与 ADR 0285/规格不一致（意见 2）；规格要求排除子线程，SQL 没有排除（意见 3）。`prompt-prefix` 规则不受影响。

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 本次 diff 只改推送侧的读取、选择和过期判断，没有碰系统提示、工具定义、历史消息、资料块或遮盖逻辑；模型请求仍只在末尾追加，新增的 `internal` / `replyMessageId` 都不会进入模型请求。依据 `prompt-prefix.md` 第 4、6、8、10 条，本改动没有触碰这些路径。
2. **同一段文字会不会在不同请求里变成不同字节？不会。** `internal` 是数据库里确定的 0/1；`replyMessageId` 用 `ORDER BY reply.sequence DESC LIMIT 1` 选出，顺序确定；没有新增依赖前后文的遮盖、时间字段或无序集合。推送内容按 locale/时间格式化是原有行为，与本改动无关，也不属于模型请求。
3. **有没有对应的自动检查，反向用例是否会真的失败？部分有。**
   - `sqlite-web-push.test.ts` 新插入 `inner-b`（sequence 4，internal=1），若去掉 `AND reply.internal = 0`，`replyMessageId` 会变成 `inner-b`，断言 `said-b` 失败，因此这个反向用例真的会失败。
   - `production-web-push.test.ts` 新用例伪造 `readMessage` 返回 `internal: true`，若去掉 `message.internal === true` 守卫，内部正文会被推送，断言只剩“这一条照常推。”会失败，因此这个反向用例也真的会失败。
   - 但没有自动检查覆盖 `service-main.ts` 的 internal 传递、仅有内部消息时的运行完成兜底、子线程运行，以及 Apple/APNs 的 internal 路径（见意见 2、3、4）。
4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `internal`：产生于 `sqlite-thread-operations.ts:964-967`，由 `service-main.ts:3068-3073` 复制到推送适配器，消费于 `production-web-push.ts:885`。类型是 `true | undefined`，两端一致；目前没有其他消费者。
   - `replyMessageId`：产生于 `sqlite-web-push-operations.ts:722-726`，类型定义在 `packages/application/src/ports/web-push.ts:88` 为 `string | null`，消费于 `production-web-push.ts:452-461`；`null` 会进入运行完成兜底分支，类型上能接受，但兜底语义与规格冲突（意见 2）。没有发现其他消费方。
   - 另一个前提问题：`internal` 的写入端目前只存在于 `admitOwnerMessage`（role=owner），没有任何生产代码写入 internal 的 agent 消息，所以“`internal` 的每个使用方都能接受”在类型上成立，但当前生产数据不会走到这些分支（意见 1）。
