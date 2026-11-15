## 复核范围

- 读了增量 `87e20cc..03175ce` 的代码、文档和测试（即 `4e9e2aad7` 的修复内容），并沿证据读了 `production-proposals.ts`、`owner-scope-authorization.ts`、`action-rules.ts`、`sqlite-owner-proposal-operations.ts`、`sqlite-thread-operations.ts`、`production-thread-titles.ts`、`apps/control-center/src/memory.ts` 等旧代码。
- 没有运行测试或 lint（当前环境只允许读取和 `git diff/log/show/blame/status`），结论以读代码为准。
- 仓库外的 `proposal-run-trigger-plan.md`、`prompt-prefix.md` 未读到，相关部分标「未核实」。

## 上一轮意见核对

- **#1 全文展示**：后端已把 `task_text` 证据放进 `proposals.snapshot`，但经过网关 `ProductionProposalControl` 时按 UTF-16 截断，且仓库内没有客户端渲染这类证据；只算部分修好。
- **#2 external_event 写操作被拒**：行为没改，只改了效果句和文档；仍会被当成外部内容拒绝非读取动作。
- **#4 任务正文固定 private**：已修，`classificationWithIdentifiers(parsed.text, "private")` 会升级为 `sensitive`。
- **#3 崩溃留空对话/永远未知**：没有代码修复，只写进文档；行为仍在。
- **#5 重新提议降低“读全文/外部内容”标记**：没有修；仍可被第二次提议覆盖。
- **#6 编号歧义、basis 未排序**：已修，改为排序后的 JSON 数组；仍有 `localeCompare` 的残余风险。
- **#8 readBack 只看存在**：没有代码修复，只把文档里的 `succeeded` 重新定义成“已受理”；运行已失败/取消仍会算成功。

## 按严重度排列的意见

### 1. 高：`task.run` 一律记成 `external_event`，授权层把这次运行当成外部内容，所有非读取动作被直接拒绝

文件：`apps/agent-service/src/production-task-proposals.ts:154-155`、`apps/agent-service/src/owner-scope-authorization.ts:243-252`、`packages/application/src/rules/action-rules.ts:237-239`

问题：主人同意“交给她去办一件事”后，处理方固定用 `triggerSource: "external_event"` 开运行。授权层对任何 `external_event` 运行都写入 `external_event` 外部内容标记，内置规则 `refuseBackgroundAfterExternalContent` 对 `action_kind != "READ" && target_type != "managed-task" && run_source != "user_message"` 直接 refuse。结果是这类任务运行只能读、查，任何写入、发送、花钱、删除都拒绝，连“整理待办并保存”也会失败。上一轮 #2 只把效果句和文档改成“写入会被拒绝”，没有改变行为。

证据（读代码证实）：

```ts
// production-task-proposals.ts:154-155
await commands.admitOwnerMessage({
  triggerSource: "external_event",
```

```ts
// owner-scope-authorization.ts:247-250
const marks = this.#options.externalContent;
if (!marks) return source.sourceType === "external_event" ? ["external_event"] : [];
if (source.sourceType === "external_event")
  await marks.mark(invocation.runId, "external_event");
```

```ts
// action-rules.ts:237-239
'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
outcome: "refuse",
```

建议：如果“主人已同意”应当被当成受信来源，新增一个独立来源（例如 `owner_approved_proposal`）或一个授权事实，只把真实外部内容标成 external content；如果产品决定这类任务只能读，就在提议入口直接拒绝明显需要写入的任务，或让首页/提议明确写“只能查”，并避免把“运行已受理”显示成“任务已办成”。补一个“任务需要写操作时会被拒”的反向测试。

### 2. 高：同一 pending 提议被再次提议时，仍可把“读全文/外部内容”标记降级

文件：`apps/agent-service/src/production-task-proposals.ts:265-268`、`apps/agent-service/src/production-proposals.ts:384-390`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:158-186`

问题：提议编号只由任务说明和 basis 算出，不含 `externalContentSeen`/来源。第一次从外部内容提出时 `requiresFullRead=true`、`origin=external_content`；之后同一个 text+basis 从普通上下文再次提议，`proposeTaskRun` 会算出 `requiresFullRead=false`，存储层刷新 pending 行时又直接覆盖 `origin` 和 `requires_full_read`。这样外部内容引出的提议可以在用户没读全文的情况下重新变成普通提议并被同意。上一轮 #5 没有修好。

证据（读代码证实）：

```ts
// production-task-proposals.ts:265-268
requiresFullRead:
  long || context.externalContentSeen === true || context.origin === "external_content",
```

```ts
// production-proposals.ts:385-390
const origin: OwnerProposalOrigin =
  input.externalContentSeen === true ? "external_content" : input.origin;
...
const requiresFullRead =
  input.requiresFullRead === true ||
  (origin === "external_content" && !(handler !== undefined && isAction(handler)));
```

```sql
-- sqlite-owner-proposal-operations.ts:161-164, 180
UPDATE owner_proposals SET expires_at = ?, origin = ?, thread_id = ?, summary = ?,
  effect = ?, type = ?, source_ref = ?, source_version = ?,
  version = version + CASE WHEN fingerprint = ? THEN 0 ELSE 1 END, fingerprint = ?,
  evidence_ref = ?, requires_full_read = ?, requires_presence = ?,
...
input.requiresFullRead ? 1 : 0,
```

建议：把 `requires_full_read`、`requires_presence` 和 `origin` 做单调合并：已有 pending 行一旦是 `external_content`/要求全文阅读，后续刷新不能降级；或者把来源与 `externalContentSeen` 也纳入新的提议编号，让“不同来源”变成不同提议。补一个“先外部内容、后普通上下文重复提议”的反向测试。

### 3. 中：`task_text` 全文展示并不等于执行字节，非 BMP 字符还会被网关截掉一半

文件：`apps/agent-service/src/production-task-proposals.ts:197-203,250-263`、`apps/agent-service/src/production-proposal-control.ts:65-71`、`apps/agent-service/src/production-proposals.ts:195-205`、`packages/gateway-contracts/src/validation.ts:102-118`

问题：`chunks()` 按 **code point** 每 500 个切分，但网关 `shownText` 按 **UTF-16 code unit** 截到 500。一个由 emoji 或其他非 BMP 字符组成的 500 字符分片有 1000 个 UTF-16 单元，`shownText` 只保留约 250 个字符，余下内容主人看不到；而 `requiresFullRead` 仍要求先读全文。还有两个不一致：`shownText` 会把换行/控制字符换成空格并去掉 bidi 控制符，而 `taskRunMessage` 只在执行时替换 `<<<`/`>>>`；证据里显示的是未替换、未清洗的原文。文档说“主人读全文时看到的就是执行时用的字节”，这不成立。

证据（读代码证实）：

```ts
// production-task-proposals.ts:197-202
function chunks(text: string, size: number): string[] {
  const characters = [...text];
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += size)
    parts.push(characters.slice(start, start + size).join(""));
```

```ts
// production-proposal-control.ts:70
text: item.text === null ? null : shownText(item.text, 500) || null,
```

```ts
// production-proposals.ts:201
if (kept.length + character.length > maximum) break;
```

```ts
// validation.ts:106-111
input.length > maximum ||
[...input].some((character) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
})
```

测试 `shows the owner the whole task text, in pieces the gateway accepts` 只检查 `box.list()` 的原始 evidence（`[...part].length <= 500`），没有走 `ProductionProposalControl.query`，所以即使网关截掉半个 emoji 文本它也会通过。这是典型的“两端长度规则不一致”。

建议：按网关的 UTF-16 预算切分（或直接调用同一套 `shownText`/`boundedString` 逻辑，留出余量），并在 `ProductionProposalControl.query` 上补一个包含 emoji、换行和 `<<<` 的端到端测试；文档要么改掉“看到的就是执行时用的字节”，要么在展示层保留可核对的原文。

### 4. 中：执行失败或进程崩溃会留下空对话和永久 `failed`/`unknown` 的提议，同一个提议不能再办

文件：`apps/agent-service/src/production-task-proposals.ts:147-170`、`apps/agent-service/src/production-proposals.ts:674-695,575-602`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:156-157,429-440`

问题：`execute` 先 `commands.create` 建对话，再 `commands.admitOwnerMessage` 开运行；两步不在同一事务。若第二步失败，提议记成 `failed`，已经建好的空对话不会回收；若进程在 `store.claim` 之后、`execute` 写入执行原样之前崩溃，恢复逻辑找不到执行原样，直接把提议标成 `unknown`。之后 `store.propose` 对任何 `exec_status != 'not_started'` 的同一提议返回 `closed`，所以同一个提议不能重试，只能换说明或换 basis。上一轮 #3 只是把这一点写进文档，行为没改。

证据（读代码证实）：

```ts
// production-task-proposals.ts:147-159
const created = await commands.create({
  ...
});
await commands.admitOwnerMessage({
  triggerSource: "external_event",
  ...
```

```ts
// production-proposals.ts:674-689（失败路径）
} catch (error) {
  const ref = await this.#recordExecution(proposalId, { original: null, ... reason: ... });
  await store.moveExecution({ ..., to: "failed", ... });
```

```ts
// production-proposals.ts:586-598（恢复时找不到执行原样）
if (!handler || !isAction(handler) || !basis || !execution) {
  await store.moveExecution({ ..., to: "unknown", ... }).catch(() => undefined);
  continue;
}
```

```ts
// sqlite-owner-proposal-operations.ts:157
if (existing && existing.execStatus !== "not_started") return "closed";
```

建议：把建对话和 admit 收进可回滚的单元，或在 `execute` 失败时把刚建的空对话归档/删除；恢复逻辑应能根据 payload/对话/消息/运行是否存在判断是否真的没有产生副作用：没有副作用就允许同一提议重新执行（execute 的幂等键已经足够安全），而不是永久 `unknown`。补一个“create 成功、admit 抛错”和“claim 后进程崩溃”的失败注入测试。

### 5. 中：`readBack` 只查消息和运行是否存在，运行已失败或取消仍判 `succeeded`

文件：`apps/agent-service/src/production-task-proposals.ts:176-189`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1737-1754`

问题：`readBack` 只比较 `runId` 和 `contentRef`，不看 `run.status`。`listRuns` 返回所有状态，所以运行在第一轮读回前已经 `failed`/`cancelled` 也返回 `matches`。上一轮 #8 的代码问题仍在；这次只是把文档里的 `succeeded` 改成“运行已经建立并被受理”。如果产品要的语义是“已经开始办”，这仍然不符合；如果接受“已受理”，至少不应该把这个内部状态叫 `succeeded`。

证据（读代码证实）：

```ts
// production-task-proposals.ts:186-188
const hasRun = snapshot?.runs.some((run) => run.runId === made.runId) === true;
const hasMessage = snapshot?.messages.some((item) => item.contentRef === made.contentRef);
return hasRun && hasMessage ? "matches" : "differs";
```

```sql
-- sqlite-thread-operations.ts:1743-1752
SELECT r.id AS runId, r.revision, r.status, ...
FROM runs r ...
WHERE r.owner_id = ? AND r.agent_id = ? AND r.thread_id = ?
```

建议：把执行结果命名成 `accepted`/`started`，或在 `readBack` 里至少检查运行在本次读回时是否存在且不是 `failed`/`cancelled`，并把运行最终状态暴露给调用方；补一个“运行在 readBack 前被取消”的测试。

### 6. 中：新增的 `task_text` 证据在仓库内没有消费者；现有客户端也拿不到 `fullReadToken`

文件：`apps/control-center/src/memory.ts:186-192,322-330`、`apps/control-center/src/components/rule-receipt.tsx:99-104`、`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:132-133`

问题：后端把全文放进 `evidence`，但 `control-center` 的 `MemoryModel` 只是把 `proposals` 存起来，唯一读它的是规则回执，不渲染 proposal evidence；Apple 客户端只有生成的 `proposals.read/proposal.respond` 能力声明，没有 proposal UI。并且 `respondProposal` 永远发送 `fullReadToken: null`，`proposals.read` 永远用 `{open: null}`，没有任何仓库内客户端调用 `open` 拿 token。也就是说，`requiresFullRead` 的提议（包括这次新增的 `origin=external_content`）在仓库内 UI 无法同意。仓库外是否还有客户端：未核实。

证据（读代码证实）：

```ts
// memory.ts:188
.query(queryMessage(configuration, "proposals.read", { open: null }))
```

```ts
// memory.ts:322-330
respondProposal: ({ proposalId, version, fingerprint }, action) =>
  send("proposal.respond", () => ({
    proposalId,
    expectedVersion: version,
    fingerprint,
    action,
    recentAuthenticationRef: null,
    fullReadToken: null,
  })),
```

建议：要么在同一个 PR/后续 PR 里接上“打开全文拿 token → 同意时带 token”的客户端流程并渲染 `task_text`，要么在 UI 能完成之前不要对 `origin=external_content` 的任务强制 `requiresFullRead`（否则提议永远无法被同意）。这不影响当前“还没有来源调用 `proposeTaskRun`”的现状，但一旦接上来源就会立刻暴露。

### 7. 低：线程标题生成会把程序抬头当成用户任务，标题兜底会取“这是主人在 2026-11-14 …”

文件：`apps/agent-service/src/production-task-proposals.ts:87-92`、`apps/agent-service/src/production-thread-titles.ts:63-67,80-81,101,160-164`、`packages/prompt-catalog/src/background.ts:10`

问题：任务运行的第一条 owner 消息前面被加了一段程序抬头。线程标题生成取第一条 owner 消息并把它当用户任务交给标题模型；模型失败/输出无效时，兜底 `openingWords` 直接截前 24 个字符，结果会是“这是主人在 2026-11-14 00…”，而不是任务本身。标题模型即使成功，也可能被抬头干扰。

证据（读代码证实）：

```ts
// production-thread-titles.ts:64-67
const first = messages.find(
  (message) => message.role === "owner" && message.status === "committed",
);
if (!first) return;
```

```ts
// production-thread-titles.ts:101
title = openingWords(text);
```

```ts
// production-thread-titles.ts:160-163
function openingWords(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/gu, " "));
  const opening = characters.slice(0, FALLBACK_TITLE_LENGTH).join("").trim();
```

建议：标题生成时跳过程序抬头，直接在第一条消息里单独标记任务正文，或让任务运行的消息在标题生成时使用一个去抬头的副本；补一个标题模型失败的兜底测试。

### 8. 低：`proposalId` 仍用 `localeCompare` 排序，跨 locale 或排序相等时同一集合可能得到不同编号

文件：`apps/agent-service/src/production-task-proposals.ts:232-240`

问题：`localeCompare` 依赖运行环境的 locale/ICU；不同主机或不同 locale 下同一个 basis 集合可能排出不同顺序，导致同一任务+同一批依据得到不同 `proposalId`。更隐蔽的是，两个不同的 `kind`/`ref` 在某些 collation 下可能比较为 0，`Array.sort` 是稳定排序，输入顺序不同就会保留不同顺序，也破坏“按集合算编号”。

证据（读代码证实）：

```ts
const basis = input.basis
  .map(({ kind, ref }) => ({ kind, ref }))
  .sort((a, b) =>
    a.kind === b.kind ? a.ref.localeCompare(b.ref) : a.kind.localeCompare(b.kind),
  );
const proposalId = `task:${createHash("sha256")
  .update(JSON.stringify([text, basis.map(({ kind, ref }) => [kind, ref])]))
```

“跨 locale 会不同/会有相等 tie”属于**推测**，我没有在不同 locale 下实际运行验证；但使用 locale 相关排序计算稳定标识本身不稳妥。

建议：用不依赖 locale 的码元比较（例如 `a < b ? -1 : a > b ? 1 : 0`，或对 `JSON.stringify` 后的字符串做字节比较），并补一个大小写/重音/特殊字符排序的测试。

## 侧重检查

- **无会话/未登录**：`ProductionProposalControl` 只在 `authentication.sessionId` 存在时传 session；`verify` 在 `session` 缺失时抛 `PROPOSAL_INVALID`，发生在 `store.claim` 之前，因此不会标成被取代、不会开运行。读代码证实，测试也覆盖了直接 `box.adopt` 的无会话路径；没有发现新错。
- **不可信任务文本/注入**：`neutralized` 只替换 `<<<`/`>>>`，能防止伪造同名块边界；但没有处理 bidi 控制符、零宽字符等格式字符。展示侧 `shownText` 会去掉 bidi 控制符并把 Cc 换成空格，执行侧 `taskRunMessage` 用原文（只替换 `<<<`/`>>>`），所以“主人看到的内容”和“模型执行的内容”可能不同。上一轮 #1 的“全文同意”因此仍不是严格意义上的逐字节核对。
- **审批**：`external_event` 必然写入外部内容标记，非读取、非 managed-task 动作直接 refuse，不会弹审批；这与文档一致，但也是意见 1 的功能后果。managed-task 动作是例外，写操作并非“一律拒绝”，效果句不够精确。
- **资源耗尽**：任务长度上限 2000 字符，证据最多 4 个 500 字符分片；重复提议会新建 basis payload 并在刷新时删除旧的 evidenceRef，`closed`/`limit_reached` 时也会删除新 payload；没有发现无界增长。
- **不可撤销操作**：`task.run` 的 `undo` 固定抛 `PROPOSAL_NOT_UNDOABLE`，符合作者说明；运行本身的写入已被外部内容规则挡住，所有者仍可取消运行/删除对话。这里没有发现新的不可撤销写操作，但“提议被收走、运行失败后不能重试同一提议”是意见 4 的问题。
- **SQL/迁移**：`triggers.source_type` 的 CHECK 确实包含 `external_event`（`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`）；`INSERT INTO triggers` 的 10 个占位符与 10 个参数一一对应；`source_id` 放的是 messageId，`readRunExecutionSource` 对非 `user_message` 不要求消息存在，`readContextSnapshot` 对 `external_event` 也按消息查找；没有发现缺少迁移或约束不接受的问题。
- **分类**：`classificationWithIdentifiers` 只会把 `private/public` 升为 `sensitive`，不会产生 `restricted`；payload 和 thread message 的 `dataClassification` 都接受 `sensitive`。如果主模型不允许 sensitive，运行会在 `RUN_POLICY_MODEL_DISCLOSURE_DENIED` 处失败，这是失败关闭，不是数据泄露。任务摘要仍写入 `owner_proposals.summary`（该表没有分类列，既有设计），本次没有把它纳入加密分类；值得产品确认。
- **内存捕获**：`production-memory-capture.ts:1087` 明确只处理 `sourceType === "user_message"`，因此这次 `external_event` 的任务对话不会被记忆捕获；如果产品期望“主人同意过的任务”进入长期记忆，这是一个下游缺口（推测产品意图，未核实）。
- **线程标题/首页**：首页 `listUnattendedRuns` 只按 `source_type != 'user_message'` 取，`external_event` 会出现在“正在做的”，普通主人消息不会；读代码和测试都证实。标题生成的问题见意见 7。
- **`external_agent` 来源**：`requiresFullRead` 只对 `external_content`/`externalContentSeen` 强制全文，`external_agent` 不强制；如果外部 agent 也被视为不可信，这一点需要产品确认（未核实设计意图）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本增量不碰系统提示和工具定义；任务运行开的是全新线程，第一条（也是唯一一条）owner 消息里含执行时算出的 `decidedAt`、`timeZone`、`proposalId`。这条消息只写一次，之后靠 `contentRef` 复用，不会用新的时间重写；因此对已有对话没有改写前缀，变化值只出现在新线程的第一条消息里。对同一提议的模型输入保持稳定。结论：**没有发现本次改动把会变的值追加到已有请求前缀之外，也没有改写历史消息/遮盖结果**；需要注意的只是标题生成会读这条带抬头的消息（意见 7），它不是主运行的前缀。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对同一个提议：不会。payload 写入有 `if (!(await payloads.get(id.contentRef)))` 保护，重试复用同一份字节；`chunks`、`neutralized`、排序后的 basis 都是确定性的。
   对不同提议：同一段任务说明可能因为不同的 `proposalId`/`decidedAt` 得到不同抬头，但它们属于不同新线程，不是同一请求的前缀。
   展示路径会被 `shownText` 改写（换行/控制符/非 BMP 截断），但这不是模型看到的字节。
   仍有一个**推测**风险：`localeCompare` 让编号依赖 locale，理论上可能让同一集合在不同环境产生不同编号；这不是文字字节变化，但会破坏幂等。
   结论：**模型输入层面没有引入新的跨请求字节不确定性；展示层与执行层确实不一致**。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有新增集成测试：external_event 首页出现、普通 user_message 不出现；重复同意只开一次；无会话拒绝且不开运行；撤销一律 `PROPOSAL_NOT_UNDOABLE`；外部内容必须读全文；敏感/普通任务分类；编号按集合稳定且不歧义。这些断言是真实的，按代码看如果行为被改回去会失败。
   但缺口明显：没有测试“网关实际返回的 evidence”是否能完整展示全文（现有测试直接读 `box.list()`，绕过了 `ProductionProposalControl` 的 UTF-16 截断和非 BMP 情况）；没有测试重新提议降级；没有测试执行中途失败/崩溃后的空对话和 `unknown`；没有测试 readBack 遇到已失败/已取消运行；没有测试标题兜底。
   所以：**已有的反向用例是真的，但覆盖不了这次最关键的“全文展示一致性”和错误恢复路径**。

4. **改动产生或修改的每个值，使用它的一端都能接受吗？**
   - `triggerSource` → `sqlite-thread-operations.ts` 的 `source_type` 列；CHECK 允许 `external_event`，占位符/参数一致，`readRunExecutionSource`/`readContextSnapshot` 都能处理；通过网关的 owner 消息不设置它，默认仍是 `user_message`。接受。
   - `ProposalSession` → 只由 `ProductionProposalControl` 产生，只被 `verify`/`execute` 消费；缺 session 时 `verify` 先抛错，不会执行。接受。
   - `task_text` 证据 → 网关 schema 接受任意 `kind` 和 `boundedString(500)`，但 `ProductionProposalControl` 的 500 是 UTF-16 上限，`chunks` 的 500 是 code point，非 BMP 会被截断；仓库内 UI 也没有渲染它，且拿不到 `fullReadToken`。**这一端没有完全接受**，见意见 3、6。
   - 分类值 `sensitive` → payload 和 message 的 `dataClassification` 都接受；主模型若不允许 sensitive 会失败关闭。接受，但要注意配置。
   - `proposalId`/thread/message/run/contentRef → `PROPOSAL_ID_PATTERN` 接受 `task:<32 hex>`，thread/payload ref 也接受冒号；长度限制都够。接受。
   - `sourceProofRef` → 只写进 `triggers.source_proof_ref`，没有看到对它做 machineString 校验的消费端；冒号本身在 machineString 规则里也允许。接受（但仓库外是否另有校验未核实）。
   - 线程标题、记忆捕获 → 标题生成能读消息但会被抬头污染；记忆捕获对 `external_event` 直接跳过。下游能运行，但语义是否接受需要产品确认。
