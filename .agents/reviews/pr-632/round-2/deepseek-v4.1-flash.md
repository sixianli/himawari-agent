范围：本轮只核对增量 `5e67644..a83a06e`（7 个文件），并顺藤跟到增量引用到的产生端/使用端。受工具限制未运行测试，因此“作者称 98 条测试通过”本身未核实；以下结论均来自读代码。

## 上一轮意见 1 核对（不是新意见）

**已改好。** 服务端生产端 `apps/agent-service/src/owner-scope-authorization.ts:178` 生成的 intent id 以 `owner-scope:` 开头；服务端 `apps/agent-service/src/owner-allowances.ts:90-91` 对其它前缀返回 `ALLOWANCE_ACTION_ASKS_EVERY_TIME`，`set()` 在 `:198-199` 抛错、`match()` 在 `:313` 直接不命中；网页端 `apps/control-center/src/run-approval.ts:153` 同样条件下只给 `["once"]`，卡片 `run-approval-card.tsx:245` 只有 `choices.length > 1` 才渲染范围选项。编码/文件意图的 id 分别是 `coding:`（`production-coding-workflow.ts:285,296`）和 `file-read:`（`production-file-read-workflow.ts:282`），因此确实被排除。上一轮“存得下但永远不生效”的问题在新数据上不会再发生。

推测（未核实）：修复不清理修复前已写入的 `owner-allowance:` 记录；若该 PR 的旧版本曾在某个环境写入过编码/文件 allowance，设置页仍会列出但永不命中。鉴于功能在同一未合入 PR 内，默认没有生产数据。

## 意见

### 1、低、范围资格规则在服务端和网页各写一份，未来容易再次“两端不一致”
文件:行：`apps/agent-service/src/owner-allowances.ts:84-92`，`apps/control-center/src/run-approval.ts:146-156`
问题：是否允许保存/展示范围的决定被复制成两份（花钱、凭证、本人到场、id 前缀）。目前两端逐项一致，但这不是本次缺陷的根治方案；以后只改一端，就会出现“网页给了选项、服务端拒存”或反过来的错配，和 I-73 那类“产生端/使用端只认一边”是同构风险。
证据：
```
// owner-allowances.ts
if (intent.estimatedCostMicros > 0 || intent.actionKind === "PURCHASE_OR_FUNDS")
  return "ALLOWANCE_SPENDING_ONCE_ONLY";
...
if (!intent.id?.startsWith(APPROVAL_ALLOWANCE_INTENT_PREFIX))
  return "ALLOWANCE_ACTION_ASKS_EVERY_TIME";
```
```
// run-approval.ts
intent.estimatedCostMicros > 0 ||
intent.actionKind === "PURCHASE_OR_FUNDS" ||
intent.credentialOrAccessChange ||
intent.deterministicFactCodes.includes("owner_presence_required") ||
!intent.intentId.startsWith(APPROVAL_ALLOWANCE_INTENT_PREFIX)
```
建议：让服务端在 `approval.snapshot` 里直接返回可用的 `allowanceOptions`（或显式的 `allowanceEligible`/`allowancePath`），网页只渲染服务端给的值，删掉网页侧重复判定。若保留现状，至少加一条自动检查：对每条已存储的 allowance，用其来源 intent 回放 `match()` 必须命中，防止再出现“设置页可见但永不生效”。当前不是现存 bug，属可维护性与复发风险（推测）。

### 2、低、缺少直接覆盖 `match()` 拒绝非 owner-scope 意图的反向用例
文件:行：`test/integration/tool-action-registry.test.ts:1661-1688`（只测 `set`），`apps/agent-service/src/owner-allowances.ts:310-313`
问题：新增的服务端反向用例只断言 `set()` 抛 `ALLOWANCE_ACTION_ASKS_EVERY_TIME`；网页反向用例断言不显示 `.approval-scope`。没有用例直接验证“即使数据库里存在一条编码/文件 allowance，`match()` 也不命中”。
证据：`match` 的守卫与 `set` 共用同一函数：
```
if (allowanceNotOffered(intent)) return undefined;
```
建议：补一条用例，构造一条以 `coding:` 为 id 的 intent 与一条同 `scopeKey` 的已启用 allowance，断言 `match()` 返回 `undefined`。这能直接守住“已经写坏的数据也不会被用”的边界。

## 侧重检查

- 错误路径：`OwnerAllowances.set()` 依次校验 approval 存在/归属、`status === "approved"`、非 `policyAuthorization`、`allowanceNotOffered`、`days` 范围、`this_task` 必须有 threadId；`revoke()` 对不存在/非 `allowance:` 前缀返回 NOT_FOUND；`match()` 跳过 disabled/过期/scopeKey 不符的记录。上述校验读代码确认成立。
- 不可信输入：`approval.allowance.set` 的 payload 由契约校验（`contracts-v2.ts:268-275`：`allowFor` 枚举、`days` 为 1..90 的整数或 null）；服务端再校验一次 `days` 与 `allowFor` 组合。approval 以 `ownerId`/`agentId` 双重限定（`owner-allowances.ts:185-191`），不存在跨主人读取/写入。
- 安全与不可撤销：撤回写 `enabled: false` 并移出索引；已签发授权在使用时会复核 `product_state_records` 的 `enabled` 与 revision（`sqlite-durable-operations.ts:2229-2240`，并在 `resolveApproval:2159`、`consumeGrant:2258` 调用），与作者说法一致。
- 资源耗尽：增量没有引入新的循环或外部输入放大的分配；allowance 索引随主人批准的动作增长，撤回会移除，未见新增风险。
- 文档一致性：规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md` 的改动与“编码/文件走另一授权路径”相符；实际守卫更宽（所有非 `owner-scope:` 意图），但网页搜索/打开网页本来就因 `isSearch` 只给“只这一次”，没有发现文档与行为冲突。仅“这两类卡片”的措辞略不穷尽，不构成错误。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 增量只改授权/allowance 判定与网页选项，不碰系统提示、工具定义、历史消息、遮盖或请求组装；发给模型的内容仍然只在末尾追加，每轮变化的值没有新增到开头。此项对本次增量不涉及（整个 PR 的 diff 也未包含 prompt-catalog/工具定义改动）。
2. **不会让同一段文字在不同请求里变成不同字节。** 新增的 `APPROVAL_ALLOWANCE_INTENT_PREFIX` 是静态常量；allowance 的 `createdAt/expiresAt` 只存在设置页状态里，不进入模型请求；`actionScope` 对 recipients/targets 排序后摘要，本身是确定的。此项对本次增量不涉及。
3. **有自动检查，且反向用例在撤掉源码改动时会失败。** 服务端 `tool-action-registry.test.ts:1669` 增加 `{ id: "coding:x" } -> ALLOWANCE_ACTION_ASKS_EVERY_TIME`；不撤源码时 mock 的 `readScopedState` 会抛 “unexpected read”，与期望消息不符，测试失败。网页 `authorization-interactions.unit.test.ts:284-296` 断言 coding 审批没有 `.approval-scope`，撤掉 `run-approval.ts` 的前缀判断后该断言失败。唯一缺口是第 2 条意见指出的 `match()` 无直接反向用例。
4. **增量产生/修改的值逐个核对：两端都能接受。**
   - `APPROVAL_ALLOWANCE_INTENT_PREFIX = "owner-scope:"`：产生于 `contracts-v2.ts:266`；使用于 `owner-scope-authorization.ts:178`、`owner-allowances.ts:90`、`run-approval.ts:153`，三处语义一致，且通过 `index.ts:2` 的 `export *` 正常导出。它拼出的 intent id 仍是原来的值（只是把字面量换成常量），长度 75 字符、字符集含 `:`，满足 `approval.snapshot` 的 `machineString`（`validation.ts:51-61`，上限 128、允许 `._:-`）；审批记录整条 JSON 存库（`sqlite-durable-operations.ts:2071`），没有更严的数据库约束。审计键、approval 查找键等旧使用端行为不变。
   - 新错误码 `ALLOWANCE_ACTION_ASKS_EVERY_TIME`：只作为 `ApplicationPortError` 的 message 返回，直接使用端是测试；网页通过 `catch` 统一显示 `chat.allowance.failed`，不需要新增映射，也不进数据库或快照。
   - 本次增量没有新增/修改快照字段或网关命令；作者所说 `approval.allowance.set` 与生成的 iPhone 清单一致性属于上一轮范围，抽查确认命令已在 `ClientCapabilities.swift:85` 和 `client-capabilities.ts:124` 中，本次常量不是协议字段，无需重新生成。

**未核实**：测试实际运行结果、其它环境是否存在旧版本写入的无效 allowance、以及作者声称的 `typecheck/lint/validate_docs` 结果。
