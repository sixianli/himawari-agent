## 读代码证实的

### 1. 中：范围标题允许换行/制表符，但快照 `title` 校验拒绝控制字符，仍可能让整个设置页读不到（上一轮第 3 条未改好）
文件:行：`apps/agent-service/src/owner-allowances.ts:222`；`packages/gateway-contracts/src/contracts-v2.ts:2657`、`3415-3424`；`packages/gateway-contracts/src/validation.ts:109-111`

问题：存范围时标题直接取 `approval.display.displayTitle`，未过滤控制字符；而记忆/规则快照对 `allowances[].title` 使用 `boundedString(120)`，明确拒绝 `\t`、`\n`、`\r`。只要有一条这样的同意，`memory.rules.snapshot` 整包校验失败，设置页（也是唯一能收回该同意的入口）读不到，形成持续故障。第 5 轮指出后，增量没有碰这一行，也没有改契约。

证据：
```
owner-allowances.ts:222  title: (approval.display?.displayTitle ?? intent.operation).slice(0, TITLE_LIMIT),
contracts-v2.ts:2657     title: boundedString(120),
validation.ts:109-111    [...input].some((character) => { const code = character.charCodeAt(0);
                           return code < 0x20 || code === 0x7f; })
contracts-v2.ts:3423     return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
```
最后一行说明 `displayTitle` 的校验允许 `\t/\n/\r`，两端校验确实不一致。`production-device-action-authorization.ts:34` 是产生非空 `displayTitle` 的路径（`intent.title[locale]`）。

建议：在 `set` 存标题时统一做与 `boundedString` 一致的清洗（去掉 C0/DEL），或把快照 `title` 放宽为 `approvalDisplayText(120)`；加一条带 `"\n"` 标题的用例，断言快照仍能解析。

### 2. 中低：并发收回与再次同意时，`set` 正常返回，但新同意既不在设置列表也不生效，记录还留着 `enabled: true`（上一轮第 4 条只修好一半）
文件:行：`apps/agent-service/src/owner-allowances.ts:230-246`；`test/integration/tool-action-registry.test.ts:1811-1815`

问题：增量通过“`match` 必须在索引里”关闭了“已生效但设置里看不到”这个危险方向，这点有效。但作者自己新加的测试恰好制造了相反方向的静默不一致：第二次 `set` 的 `#index` 因键已存在而不提交，随后并发 `revoke` 删掉索引并把记录置为 disabled，接着 `set` 又把记录写回 `enabled: true` 并正常返回 id；最终该同意不在索引、也不会命中，但 `set` 没有抛错，前端因此不会显示 `chat.allowance.failed`，主人以为“几天内都行”已经保存。数据库里还留下一条 `enabled: true` 的孤儿记录。

证据：
```
owner-allowances.ts:230  await this.#index((keys) => [...keys, key]);
owner-allowances.ts:236    record.value["allowFor"] === input.allowFor
owner-allowances.ts:239    await this.#commit(key, record?.revision ?? null, { ...value, ... }, ...)
owner-allowances.ts:246  return id;
test:1811  takeBackDuringRead = () => allowances.revoke(id);
test:1812  await allowances.set({ approvalRequestId: "approval:x", allowFor: "days", days: 3 });
test:1814  expect(await allowances.list()).toEqual([]);
test:1815  expect(await allowances.match(intent as never)).toBeUndefined();
```
（`set` 正常完成，没有断言抛错；记录被重新写成 enabled 由 `revoke` 先把 enabled 置 false、随后 `set` 的检查走 commit 分支推得。）

建议：`set` 在记录提交后重新核对索引是否仍包含该键；若被并发收回，要么抛冲突让 UI 提示“范围未保存”，要么把记录也 CAS 回 disabled，避免孤儿 `enabled: true`。补一条断言 `set` 报错或记录最终 disabled 的用例。

### 3. 低：批量同意时范围选项仍只按第一条审批计算（上一轮第 2 条未改）
文件:行：`apps/control-center/src/components/run-approval-card.tsx:49`、`58-60`、`132-143`

问题：`snapshot = group[0]`，`choices` 只由第一条审批决定；随后对整组逐条 `setApprovalAllowance`。若第一条是“只这一次”的审批，整组都看不到范围选项；若第一条可存范围而后面某条不可，后面那条会静默失败，最后只显示一个笼统错误，且这些动作仍只批准一次。增量没有改这里。

证据：
```
run-approval-card.tsx:49  const snapshot = group[0] ?? null;
run-approval-card.tsx:58  const choices = snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];
run-approval-card.tsx:132 if (decision === "approved" && chosen !== "once")
run-approval-card.tsx:134   for (const approval of group) {
run-approval-card.tsx:140     }).catch(() => null);
```

建议：按整组可选项求交集来展示，或逐条按各自能力决定是否显示/保存；对不支持的条目给出明确提示。补一条混合批次（第一条和第二条可存范围能力不同）的用例。

### 4. 低：首开等待 `thread.main` 仍无超时，请求挂住时输入框一直不出现（上一轮第 1 条未改）
文件:行：`apps/control-center/src/thread-control-center.tsx:352-366`、`369-374`、`1754-1755`、`1822`

问题：`queryThread` 没有超时，只有组件卸载时 `abort`。只要请求既不 resolve 也不 reject，`finally` 不执行，`mainLookupSettled` 保持 false，`openingMain` 为真，首屏一直显示骨架且 `ChatComposer` 不渲染。增量没有改这里。

证据：
```
thread-control-center.tsx:355 client.queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
thread-control-center.tsx:364   .finally(() => { if (!controller.signal.aborted) setMainLookupSettled(true); });
thread-control-center.tsx:374   (!mainLookupSettled || mainThreadId !== null);
thread-control-center.tsx:1754  {openingMain || (!detail && selectedThreadId && !shownOutgoing) ? (<ThreadLoadingSkeleton .../>)
thread-control-center.tsx:1822  {openingMain ? null : (<ChatComposer .../>)}
```

建议：给 `thread.main` 查询加超时（`AbortSignal.timeout` 或定时器兜底设置 settled），超时后仍显示输入框；补一条挂起请求的用例。

## 推测

### 5. 低（推测）：已收回的同意可被重放的 `approval.allowance.set` 重新启用
文件:行：`apps/agent-service/src/owner-allowances.ts:230-246`；`packages/application/src/services/governance-gateway-adapter.ts:81-90`、`642`

问题：正常 `revoke` 后记录 `enabled=false`，但之后任何一次同 `approvalRequestId` 的 `set` 都会重新 `#index` 并提交 `enabled: true`，没有“该审批已被收回”的标记。`approval.allowance.set` 又不在 `GOVERNANCE_COMMAND_TYPES` 中，`GovernanceGatewayV2ControlPlane.execute` 直接转给 delegate，客户端带来的 `idempotencyKey` 对这个命令不生效。若存在 HTTP 重试或重放，就能把已收回的同意重新变成有效。网页每次生成新的随机 idempotencyKey，正常点击不会重放，所以标为推测。

证据：
```
governance-gateway-adapter.ts:81 const GOVERNANCE_COMMAND_TYPES = new Set([... "approval.respond", ...]);
governance-gateway-adapter.ts:642 if (!isGovernanceCommand(input.command)) return this.#dependencies.delegate.execute(input);
owner-allowances.ts:236  record.value["enabled"] === true && ...  // disabled 时继续走 commit
owner-allowances.ts:239  { ...value, ... }                        // enabled: true
```

建议：给范围记录加“已收回/已消费”的单向状态（收回后 set 必须拒绝），或把 `approval.allowance.set` 纳入收据去重并绑定审批决定时间；加一条“收回后重放 set 不得再命中”的反向用例。

## 侧重检查

- 不可信输入/错误路径：`set` 校验审批归属、`status === "approved"`、非 `policyAuthorization`、`allowFor/days`、`this_task` 需要 `threadId`（`owner-allowances.ts:185-213`），未发现可绕过；`revoke` 校验 id 前缀和记录存在（`261-269`）。发现标题控制字符端到端不一致（上第 1 条）。
- 安全/不可撤销操作：已发 grant 在使用前由 `sqlite-durable-operations.ts:2229-2241` 复核 `product_state_records` 的 `enabled` 与 `revision`，收回能拦住旧 grant；索引门让“记录有效但设置里没有”不再放行。遗留：静默丢弃新同意（第 2 条）、推测的重放复活（第 5 条）。
- 资源耗尽：`match` 现在每次判定都读取整份索引（`owner-allowances.ts:322`），`list` 读取全部键；过期条目只被过滤、不从索引清理，索引会随历史同意增长。属于低度增长问题，未发现单请求放大。
- 文档/代码一致：规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:419` 只写“存成状态记录、能在设置里看、随时撤销”，没有写“必须出现在索引里才生效”；新增的索引门和静默丢弃行为未写进文档。
- 并发时序：逐一推演 `set`/`revoke` 的索引与记录提交顺序；旧危险方向（有效但不可见）已关闭，相反方向（可见性/生效性一起丢失但 `set` 报成功）仍在。

## 必答问题

1. **请求开头是否改变**：不涉及。增量只改 `owner-allowances.ts` 的索引读取和一条集成测试（`git diff --stat 6af1d58..fdd3c2d` 仅这两个非记录文件），不触碰系统提示、工具定义、历史消息或遮盖；发给模型的内容仍只在末尾追加，每轮变化值仍在最后一条消息里。本 PR 未改 prompt 组装，但我没有重读 prompt 组装代码（未核实）。
2. **同一段文字是否可能变成不同字节**：不涉及模型输入。增量没有把时间/前后文相关值写进模型内容；索引写入本就 `sort()`（`owner-allowances.ts:164`），`actionScope` 对收件人和目标排序（`65-77`），新逻辑只影响授权判定。
3. **自动检查与反向用例**：有新增集成测试 `test/integration/tool-action-registry.test.ts:1753-1816`。去掉 `if (!listed.has(key)) continue` 后，该测试会读到 `enabled: true` 的旧记录并让 `match` 命中，因此 `undefined` 断言会失败——反向用例有效（按代码推理，未运行）。不足：没有断言 `set` 在并发收回时应报错、没有断言记录最终 `disabled`，也没有混合批量/控制字符标题/`thread.main` 超时的用例。
4. **值的生产端与使用端**：`match` 只在 `owner-scope-authorization.ts:359` 使用，`undefined` 已被正常处理；`#listedKeys` 为私有，只供 `list/match`。`allowances` 快照字段中，`allowanceId`（`allowance:` + 48 hex）、`allowFor`、`approvalRequestId`、`days`、`expiresAt`、`createdAt`、`operation`、`recipients`、`threadId` 两端校验一致；`memory.rule.respond` 的 `machineString target` 能接受 `allowance:...`，与 `revoke` 的前缀校验一致。唯一不一致是 `title`（见第 1 条）。`approval.allowance.set` 在契约、服务端、网页、fixture、生成的 iPhone 能力清单中一致（对照了 `contracts-v2.ts:268-275`、`client-capabilities.ts:124`、`ClientCapabilities.swift:85`、`gateway-v2.fixture.ts:1348-1353`）。

## 结论与复核范围

- 上一轮第 4 条（中高）：所述“已生效但索引里没有、设置里看不到”已改好；但同一并发会留下“`set` 报成功却什么都没保存、记录仍 `enabled: true`”的静默不一致（新第 2 条）。
- 上一轮第 1、2、3 条：增量没有修改对应代码，问题仍在（新第 4、3、1 条）。
- 这一轮实际查过：`git diff 6af1d58..fdd3c2d`（`owner-allowances.ts`、新增测试、评审记录）；并顺证据跟到 `owner-scope-authorization.ts`、`owner-policy-authorization.ts`、`sqlite-durable-operations.ts:2229-2241`、`production-approval-gateway.ts`、`production-memory-control.ts`、`contracts-v2.ts`（命令、快照、`approvalDisplayText`）、`run-approval.ts`、`run-approval-card.tsx`、`thread-control-center.tsx`、`governance-gateway-adapter.ts`。没有重读整个 PR 的旧代码。
- 未核实：`.agents/reviews/pr-632/...` 的评审记录因 git 限制 records 路径且稀疏检出没有该目录，未能独立读取；测试是否通过未运行（工具受限），只按代码推理。
