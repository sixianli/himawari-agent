本轮查过：`git diff d8e58862..441238034` 全量、`git diff 05c9838e..441238034` 增量、第 3 轮两条意见涉及的 `run-approval-card.tsx` / `thread-control-center.tsx` 及其修复提交、`owner-allowances.ts`、契约、服务端路由、网页设置页、集成与单元测试、PR635 的推送与 iOS 震动增量。增量本身只有 PR635 合并、复核记录和 iPhone 震动修复，没有触碰 PR632 的授权代码；未重读与证据无关的旧代码。

### 1. 中：批量同意时范围选项仍然只按第一条审批计算，第 3 轮意见 1 没有改好
文件:行：`apps/control-center/src/components/run-approval-card.tsx:49`、`:58-60`、`:132-148`；`apps/control-center/src/run-approval.ts:100-113`
问题：卡片仍用 `group[0]` 计算可选范围；而“一起同意”的分组键不含 `actionKind`、`estimatedCostMicros`、`credentialOrAccessChange`、`deterministicFactCodes`，所以一批里可能混有“能存范围”和“只能这一次”的审批。用户为整批选“以后都行”后，先批准全部，再逐条尝试存范围，部分成员失败时只能在同意之后看到 `chat.allowance.failed`。这正是上一轮说的“部分成员可能要在同意之后才发现范围存不下”。
证据（读代码证实）：
```ts
49:  const snapshot = group[0] ?? null;
...
58:  const choices: readonly ApprovalAllowFor[] =
59:    snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];
```
```ts
100:  const kind = (approval: RunApproval) => {
101:    const intent = approval.payload.intent;
102:    return JSON.stringify([
103:      intent.capabilityRef,
104:      intent.capabilityVersion,
105:      intent.operation,
106:      intent.sideEffect,
107:      intent.disclosure,
108:      [...intent.recipientRefs].sort(),
109:      intent.dataClassification,
110:      approval.payload.recentAuthenticationRequired,
111:    ]);
112:  };
```
```ts
132:      let allowanceSaved = true;
133:      if (decision === "approved" && chosen !== "once")
134:        for (const approval of group) {
...
141:          if (result?.status !== "accepted" && result?.status !== "replayed")
142:            allowanceSaved = false;
...
148:      if (!allowanceSaved) setError(message("chat.allowance.failed"));
```
建议：把可选范围改成整组审批的交集（每条 `approvalAllowanceChoices` 都包含的范围才显示），或在 `approvalsDecidedTogether` 的分组键里加入 `estimatedCostMicros`、`credentialOrAccessChange`、`actionKind`、`deterministicFactCodes`，把资格不同的审批拆开；不要先批准再发现存不下。并补一条“混合批次”的自动用例。

### 2. 低-中：范围记录先落库、索引后写，索引失败时授权已生效但用户被告知“没保存”，设置里也看不到、收不回
文件:行：`apps/agent-service/src/owner-allowances.ts:230-246`、`:280-328`；`apps/control-center/src/components/run-approval-card.tsx:132-148`
问题：`set()` 先把 `enabled: true` 的范围记录提交，再更新 `owner-allowances:index`。`match()` 不读索引，直接按 `scopeKey + threadId` 算出记录键读取；`list()` 只遍历索引。因此如果索引提交失败，命令整体报错，网页显示“范围没保存”，但实际上范围已经生效，会继续放行同样的动作；这条范围不在设置列表里，主人无法从界面看到和收回。
证据（读代码证实）：
```ts
230:    await this.#retry(async () => {
231:      const record = await this.#read(key);
...
238:      await this.#commit(
239:        key,
240:        record?.revision ?? null,
241:        { ...value, recipients: [...value.recipients] },
242:        "authorization.owner_allowance.set",
243:      );
244:    });
245:    await this.#index((keys) => [...keys, key]);
246:    return id;
```
```ts
318:    for (const threadId of threads) {
319:      const key = `${KEY_PREFIX}${allowanceId(scopeKey, threadId)}`;
320:      const record = await this.#read(key);
...
322:      if (!record || !value || value.enabled !== true || value.scopeKey !== scopeKey) continue;
```
```ts
281:    const index = await this.#read(INDEX_KEY);
```
建议：把记录和索引放进同一个状态事务；或先写索引再写可用记录；或让 `match()` 也要求该键在索引中。无论哪种，都要保证“界面说没保存”时权限绝不生效，并补一条索引写入失败的反向用例。

### 3. 低-中：首开等待 `thread.main` 仍然没有超时，请求挂住时输入框一直不出现，第 3 轮意见 2 没有改好
文件:行：`apps/control-center/src/thread-control-center.tsx:350-374`、`:1822-1823`
问题：`mainLookupSettled` 只在 `thread.main` 请求真正结束（成功或失败）后置为 true；请求挂住时永远是 false，`openingMain` 永远为 true，于是 `ChatComposer` 是 `null`，输入框一直不出现。`AbortController` 只在组件卸载时 abort，没有截止时间。05c9838 的改动把等待期间的输入框藏起来，避免先显示“新对话”输入框再切换，但没有解决“请求挂住”本身，反而让挂住时更明显地一直只有骨架。
证据（读代码证实）：
```ts
350:  const [mainThreadId, setMainThreadId] = useState<string | null>(null);
351:  const [mainLookupSettled, setMainLookupSettled] = useState(false);
352:  useEffect(() => {
...
355:    client
356:      .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
...
364:      .finally(() => {
365:        if (!controller.signal.aborted) setMainLookupSettled(true);
366:      });
...
369:  const openingMain =
370:    !selectedThreadId &&
371:    !page &&
372:    !route.status &&
373:    Boolean(client && configuration) &&
374:    (!mainLookupSettled || mainThreadId !== null);
```
```tsx
1822:          {openingMain ? null : (
1823:            <ChatComposer
```
建议：给这个查询加一个有界的超时（可复用 `READ_DEADLINE_MILLISECONDS` 的做法），超时后 `setMainLookupSettled(true)` 并让输入框出现；或者不要在“未完成的 Promise”上无限期隐藏输入框，只做有时限的加载状态。补一条请求永不返回的用例。

### 4. 低：范围标题的来源允许换行/制表符，但快照的 `title` 校验不接受控制字符，可能出现“已生效却无法在设置里显示、收回”的范围
文件:行：`apps/agent-service/src/owner-allowances.ts:222`；`packages/gateway-contracts/src/contracts-v2.ts:3415-3432`、`:2657`；`packages/gateway-contracts/src/validation.ts:102-119`
问题：`set()` 直接取 `approval.display.displayTitle` 截到 120 存入范围；审批快照的 `displayTitle` 校验明确允许制表符、换行和回车，但范围快照的 `title` 用的是 `boundedString(120)`，它会拒绝所有 `< 0x20` 的字符。若某个可存范围的审批标题含换行/制表符，`memory.rules.snapshot` 会通不过契约校验，设置页的规则/同意列表加载失败，主人看不到也收不回已生效的范围。
证据（读代码证实）：
```ts
222:      title: (approval.display?.displayTitle ?? intent.operation).slice(0, TITLE_LIMIT),
```
```ts
3415: const approvalDisplayText = (maximum: number): Schema<string> => ({
...
3423:        return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
```
```ts
2657:        title: boundedString(120),
```
```ts
109:        [...input].some((character) => {
110:          const code = character.charCodeAt(0);
111:          return code < 0x20 || code === 0x7f;
112:        })
```
推测/未核实：我读到当前可存范围的审批标题来源主要是设备动作的固定标题（`production-device-action-authorization.ts:34`）或 `displayTitle: null`（`production-approval-display.ts:81`），所以当前调用方可能不会触发；但两端校验确实不一致，一旦以后的可存范围审批使用多行标题就会出问题。
建议：存入前把 `\t\r\n` 和其他控制字符规范化掉，或让范围标题使用与审批标题一致的校验；补一条标题含换行的反向用例。

**侧重检查**

- 错误路径：查了 `OwnerAllowances.set/revoke/list/match`。`set` 的合法输入检查较完整（owner/agent、`status === approved`、拒绝 `policyAuthorization`、拒绝花钱/凭据/本人在场、`days` 1..90），但发现索引失败后仍生效的问题（意见 2）。`revoke` 先写 `enabled: false` 再改索引，方向是安全的；索引失败最多留下不可见的旧键，`list` 读到 `enabled !== true` 会跳过。
- 不可信输入：`approvalRequestId` 来自 `machineString`；`allowFor` 来自契约枚举；`days` 有整数和范围校验；`revoke` 的 `target` 只接受 `allowance:` 前缀且用 owner/agent 作用域读记录，未发现越权。
- 安全与收回：读代码证实 `packages/persistence-sqlite/src/sqlite-durable-operations.ts:2239` 在用掉 grant 前会重读 `product_state_records`，要求 `revision` 未变且 `enabled === true`，所以“收回后已发出、还没用掉的授权会被数据库拒绝”的机制存在；但新增路径没有专门测试这条（见必答 3）。
- 资源耗尽：`owner-allowances:index` 对过期记录只跳过、不清除，`list()` 会遍历所有历史键；范围键受动作范围和对话限制，增长有限，暂未列为缺陷，但建议后续清理过期索引。
- 不可撤销操作：花钱被 `estimatedCostMicros > 0` 和 `PURCHASE_OR_FUNDS` 挡住；`days`/`always` 共用同一记录键，后一次选择会覆盖前一次（例如先“以后都行”，在外部内容场景被重新询问后选“几天内”，会把前者降级）。读代码看这是一条动作一条记录的设计取舍，未列为缺陷，但文档若承诺两种范围可并存，需要分开键。
- 规则文件/文档/代码一致性：规格 419 行的“写代码和读文件路径不查这些记录、服务端拒存”与 `APPROVAL_ALLOWANCE_INTENT_PREFIX` 的 id 前缀门一致；作者说法 2、3、5、6 的服务端行为与代码一致；作者说法 3 的“网页不显示范围选项”在混合批次下不成立（意见 1）。
- PR635 增量：`internal` 消息不推送的 SQL 过滤、`readMessage` 的 `internal === true` 判断、`service-main` 的映射、iOS `setAllowHapticsAndSystemSoundsDuringRecording` 及其测试，未发现新错；这些与 PR632 授权范围无关。

**必答问题**

1. 会不会改变模型已经见过的请求开头？不会。这个改动没有碰系统提示、工具定义、历史消息或遮盖逻辑；新增的 `allowances` 只出现在 `memory.rules.snapshot`（设置页）和服务端状态记录里，不进入模型请求；审批卡的范围选择也只是网页命令。发给模型的内容仍按 `.agents/instructions/prompt-prefix.md` 第 4 条只追加，每轮变化的值（`createdAt`、`expiresAt`）不进入模型可见文本。与本次增量无关的“仍然只在末尾追加”不受影响。

2. 会不会让同一段文字在不同请求里变成不同字节？对模型请求不涉及。新范围记录里的时间戳、接收人、目标都只在设置快照/状态记录中；写摘要用的 `recipients`、`targets` 都先排序，索引和列表也排序，序列化顺序是确定的。没有新增依赖前后文的遮盖。

3. 有没有对应自动检查，反向用例真的会失败？有，且我核对的关键反向用例确实能失败：网页“花钱只给只这一次”、`coding:` 前缀只给一次（`authorization-interactions.unit.test.ts`）；服务端非主人批准、`days: 0`、不同操作不命中（`tool-action-registry.test.ts`）；外部内容后 `always` 不算、`this_task` 仍算（工具与设备集成测试）；到期后不再命中且列表清空。缺口：第 3 轮的两条意见（混合批次、`thread.main` 挂住）没有测试；索引写失败时“已生效但显示没保存”没有测试；收回后“已经发出、还没用掉的 grant”被数据库拒绝这条机制没有新增反向用例；标题含控制字符的情况没有测试。

4. 每个产生/修改的值两端都能接受吗？逐项核对：`approval.allowance.set` 已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、客户端能力表、生成的 Swift、`PRODUCTION_APPROVAL_OPERATIONS`、HTTP 组合的操作清单和契约夹具；网页发送的 `allowFor`、`days: 7/null` 与服务端校验一致。`allowanceId` 为 `allowance:` 加 48 位十六进制，长度和字符集通过 `machineString`（上限 128），`list()` 去掉 `owner-allowance:` 前缀后与 `revoke()` 重建的键一致，`memory.rule.respond` 的 `target` 也接受；`allowances` 字段服务端总是输出（未安装时为 `[]`），网页读取并渲染，契约快照夹具已补。`OWNER_RULE_ACTIONS` 新增 `revoke` 后，契约、网页类型、服务端分支一致。**唯一发现的不一致是 `title`**（意见 4）。另外 `apps/control-center/test/correction-review.unit.test.ts` 里有一个不带 `allowances` 的 `memory.rules.snapshot` mock，但该用例没有安装 `memory.rules.read`，不会真的请求这个快照，因此不构成当前失败。
