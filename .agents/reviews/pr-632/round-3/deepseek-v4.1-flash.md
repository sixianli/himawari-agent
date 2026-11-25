工具步数已到上限，下面是仅根据已读代码写出的结论；未运行测试，未读到的部分标「未核实」。

## 复核范围与材料核对

- 本轮读了：`8b6b962..05c9838` 的文件清单与统计、`05c9838` 的完整改动、`a83a06e..05c9838` 的文件清单；PR 632 的 `owner-allowances.ts`、`owner-scope-authorization.ts`、`production-approval-gateway.ts`、`production-memory-control.ts`、`service-main.ts`、`production-http-composition.ts`、网页 `run-approval*.ts*`、`memory.ts`、`rule-receipt.tsx`、`memory-page.tsx`、契约、夹具和新增测试。没有重读目标分支里已存在的 CI/iPhone/memory_open/main-thread 后端全量代码。
- 重要：作者材料写的是 PR 632（同意范围），而 `8b6b962..05c9838` 的实际产品改动是 PR 632 的同意范围代码加 `05c9838` 的网页主对话首开修复。`a83a06e..05c9838` 这个“增量”里还含大量已经在基准 `8b6b962` 里的目标分支代码（CI、iPhone、`memory_open`、主对话后端）。判断“本 PR 是否改工具定义/系统提示”时必须区分这两段。
- 上一轮成立的“会出错”意见为“没有”，因此不存在“这条改好了没有”的逐条核对。

### 1. 中：批量同意时范围选项只按第一条审批计算，部分成员可能要在同意之后才发现范围存不下

文件: apps/control-center/src/components/run-approval-card.tsx:49、58-60、132-143；apps/control-center/src/run-approval.ts:95-114

问题：卡片用 `group[0]` 计算整组可选范围，然后把同一个 `chosen` 依次发给组内每条审批。但 `approvalsDecidedTogether` 的同类条件只比较工具、操作、副作用、外发范围、收件人、分级和是否需重新认证，不比较 `estimatedCostMicros`、`credentialOrAccessChange`、`deterministicFactCodes` 里的 `owner_presence_required`、`intentId` 前缀，也不比较设备目标。组内因此可能混入“只给只这一次”的成员。结果是：用户选了“以后都行”，审批全部已通过，之后某条成员的范围保存被服务端拒绝，界面才报 `chat.allowance.failed`；反过来，第一条不合格时整组都不会显示本可给合格成员的范围选项。

证据：
- `const snapshot = group[0] ?? null;`
- `const choices: readonly ApprovalAllowFor[] = snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];`
- `if (decision === "approved" && chosen !== "once") for (const approval of group) { const result = await setApprovalAllowance({... snapshot: approval, allowFor: chosen }).catch(() => null); ... }`
- `kind` 数组中没有 `estimatedCostMicros`、`credentialOrAccessChange`、`deterministicFactCodes`、`intentId` 或设备目标。

证实：范围拒绝不会被放大成越权，因为每条 `setApprovalAllowance` 会重新校验并只影响保存范围；`approval.respond` 已把一次性同意做完。
推测：组内混合资格是否真会发生，取决于运行时能否在同一轮产生“同工具同操作但存在/花费/凭证条件不同”的多条审批；我没有构造出完整端到端场景，标为“可能”。

建议：对整组取各成员可选范围的交集，或按资格拆组显示；为“混合组”补一条测试，断言不会出现“先全部通过、再部分范围失败”的静默不一致。

### 2. 低-中：首开等待 `thread.main` 期间没有超时，请求挂住时输入框一直不出现

文件: apps/control-center/src/thread-control-center.tsx:352-374（配合 `05c9838` 中 `openingMain ? null : <ChatComposer>` 的条件）

问题：`openingMain` 在 `!mainLookupSettled` 时为真；只有请求 `finally` 后才置 `mainLookupSettled`。`client.queryThread` 没有超时，若该请求一直不返回，`openingMain` 长期为真，输入框一直不渲染，用户无法输入；原来的旧逻辑至少一直有输入框。若请求在 `active/client/configuration` 不变的情况下失败一次，也不会因网络重连自动重试（`connection` 不在依赖里）。

证据：`const openingMain = ... Boolean(client && configuration) && (!mainLookupSettled || mainThreadId !== null);`；`.finally(() => { if (!controller.signal.aborted) setMainLookupSettled(true); });`

证实：`finally` 是唯一解锁点；`useEffect` 依赖只有 `[active, client, configuration, onUnauthorized]`。
推测：是否真的挂住取决于浏览器/`fetch` 的超时；未核实网关层是否有统一超时。

建议：给 `thread.main` 查询加超时（或复用现有连接超时），超时后放回旧的“新建草稿/欢迎页”输入框；网络恢复时重试一次。补一条“查询永不返回”的反向用例。

### 3. 低：收回“已发出、还没用掉”的授权没有本 PR 专门的自动检查

文件: apps/agent-service/src/owner-allowances.ts:261-278；packages/persistence-sqlite/src/sqlite-durable-operations.ts:2229-2240、2251-2258；test/integration/tool-action-registry.test.ts:1540-1546

问题：作者说法 5 的后半句“已经发出、还没用掉的授权在用掉时被数据库拒绝”依赖已有的 `assertApprovalPolicyCurrent` 复核；代码确实在 `consumeGrant` 里复核 `product_state_records` 的 `enabled === true` 且 `revision` 未变。但本 PR 的新测试只覆盖了“收回后新的动作重新询问”，没有覆盖“授权已发出、收回后再消费该授权应失败”。因此反向用例没有真正证明这条承诺。

证据：
- `if (!row || row.revision !== source.revision || JSON.parse(row.valueJson).enabled !== true) this.fail("PORT_NOT_AUTHORITATIVE", "Owner policy revoked or changed");`
- `if (sourceApproval) this.assertApprovalPolicyCurrent(sourceApproval);`
- 新测试在 `await s.allowances.revoke(allowanceId);` 后直接发起第三个 `rule.set`，断言重新询问，没有先制造/消费既有 grant。

证实：机制存在且路径正确。
推测：无。

建议：在 `tool-action-registry.test.ts` 或 `device-action-approval.test.ts` 补一条：先产生一次范围授权生成 grant，不消费；调用 `revoke`；再消费该 grant，断言 `PORT_NOT_AUTHORITATIVE`。同时给“花钱/本人在场时 `match` 不命中”补独立用例，虽然它和 `set` 共用 `allowanceNotOffered`。

### 4. 低：作者“这个 PR 不改工具定义和系统提示”只对实际 PR 差异成立，对指定增量不成立

文件: packages/prompt-catalog/src/tools.ts:57-66；apps/agent-service/src/production-runtime-tools.ts:628-637；apps/agent-service/test/production-runtime-tools.unit.test.ts:1637、2186-2199

问题：`8b6b962..05c9838` 确实没有 `prompt-catalog`/工具定义改动，所以对 PR 632 来说说法成立。但按题目指定的增量 `a83a06e..05c9838` 看，里面有 `memory_open` 新工具和新结果文案：工具列表变成 `[...offered, toolResultRecallDescriptor(), ...conversations]`，测试锁定 `names.at(-1)` 为 `memory_open`、之前工具定义哈希不变，说明它是“末尾新增工具”，会让已有对话的工具集合变化一次。它属于目标分支已有内容，不是 PR 632 引入，但材料与增量范围不能混着说。

证据：
- `expect(names.at(-1)).toBe("memory_open");`
- `expect(createHash("sha256").update(JSON.stringify(descriptors.slice(0, -1))).digest("hex")).toBe(TOOL_DEFINITIONS_BEFORE_MEMORY_OPEN_SHA256);`

证实：代码与测试如此。
推测：无。

建议：复核结论中明确区分“PR 632 相对 8b6b962”与“分支相对 a83a06e 的增量”；不要把目标分支的 `memory_open` 说成本 PR 的改动，也不要用 PR 632 的“不改工具”去覆盖整个增量。

## 侧重检查

- 不可信输入/权限：`OwnerAllowances.set` 以 `approvalRequestId` 从服务端审批库取记录，校验归属、`status === "approved"`、非 `policyAuthorization`，再按存储的 intent 计算范围；`days` 有 1..90 的整数校验；`revoke` 只接受前缀并只在当前 owner/agent 的 scoped state 读写。没有发现客户端能直接指定任意 scopeKey 或跨 owner 读写。
- 安全边界：范围保存只对 `owner-scope:` 前缀的 intent 开放，写代码/读文件路径（`coding:`、`file-read:`）被 `ALLOWANCE_ACTION_ASKS_EVERY_TIME` 排除，服务端与网页都只给“只这一次”，和文档一致。
- 不可撤销操作：本 PR 没有新增不可撤销操作；收回是 `enabled: false` 软关闭，记录保留。目标分支里的旧对话批量删除是 `8b6b962` 已有行为，不是本 PR 增量，未在本轮重新审查。
- 资源耗尽：`OwnerAllowances.list()` 按索引逐条 `readScopedState`，索引无数量上限；只有主人反复同意才能增长，风险低，未做进一步量化。
- 网页/服务端/契约一致性：`approval.allowance.set` 在 `GATEWAY_V2_MESSAGE_TYPES`、`CLIENT_CAPABILITY_TABLE`、生成的 Swift 能力清单、`PRODUCTION_APPROVAL_OPERATIONS`、网页 `commandMessage` 类型和测试夹具里一致；`memory.rules.snapshot.allowances` 在契约、服务端返回、网页读取、夹具里一致。未核实所有历史夹具/第三方生产者是否都补了必填 `allowances`（例如 `apps/control-center/test/correction-review.unit.test.ts:234` 的 mock 没有 `allowances`，但该用例没有打开 `memory.rules.read`，所以当前不触发）。
- 文档与代码：规格第 3 条新增的实现说明与代码基本一致；`写代码和读文件……服务端同样拒存` 由 intent 前缀检查支持。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** PR 632 本身不会：没有改系统提示、工具定义、历史消息或遮盖，只新增网页命令和设置快照。若把 `a83a06e..05c9838` 整个增量当成改动，则 `memory_open` 在工具列表末尾新增，会改变已有对话的工具集合，从而按规则第 6 条触发一次换新；它不在工具定义中间，之前哈希有测试锁住。每轮会变的 `memory_status`/当前时间只出现在追加的工具结果里，不在请求开头。依据 `.agents/instructions/prompt-prefix.md` 第 4、6 条。
2. **同一段文字会不会在不同请求里变成不同字节？** PR 632 不进入模型输入，不涉及。增量里的 `memory_open` 结果含随当前时间变化的 `status`，但它是末尾工具结果；记忆编号在插入时固定；同意列表按 `createdAt`/id 排序，不依赖对象遍历或数据库返回顺序。未发现会改写已发历史字节的路径。`actionScope` 用 `JSON.stringify` 依赖对象键顺序，但 owner-scope 的 `disclosure` 是字符串，当前路径未发现不稳定；其他来源未核实。
3. **有没有对应自动检查，反向用例是否真的会失败？** 有：网页范围选项、写代码/读文件只给一次、花钱只给一次、保存失败提示；服务端的非主人审批拒存、跨动作不共享、外部内容使“以后都行”失效、“几天内”到期、花钱/凭证/本人在场拒存；契约夹具和操作清单。缺口是第 3 条意见里的“已发出未消费 grant 被收回拒绝”，以及混合资格批次的 UI 行为。我没有运行测试，只读了用例和实现。
4. **每个产生/修改的值，使用它的地方都能接受吗？** 已逐个核对：`approval.allowance.set` 契约、网关操作清单、服务端 delegate、网页命令类型、客户端能力表、生成的 iPhone 能力清单、契约夹具一致；`allowances` 快照字段在契约里必填、服务端总返回数组、网页读取并渲染、夹具补齐；`allowanceId` 的 `allowance:<48位十六进制>` 在 set、快照、revoke、网页 `target` 之间自洽；新增的 `memory.rule.respond` 动作 `revoke` 在契约枚举和服务端分支都存在，且它和既有 owner-rule 动作共用命令但有前缀区分，未发现现有调用方误用。未核实：所有 `memory.rules.snapshot` 生产者和测试夹具、iPhone 端未来是否也会使用这个动作。

## 结论

PR 632 的 1–7 条作者说法，按 `8b6b962..05c9838` 的实际差异核对，均在代码中成立；没有发现高严重度的越权、跨收件人/设备放行或收回失效问题。主要遗留是批量同意的范围选项资格判断、首开等待主对话时缺少超时，以及“收回已发出授权”缺少专门反向用例。另需纠正材料把目标分支的 `memory_open` 等改动混入 PR 632 说法的问题。未完成：实际运行测试、全量 CI/iPhone 目标分支代码复审、所有快照夹具的穷尽核对。
