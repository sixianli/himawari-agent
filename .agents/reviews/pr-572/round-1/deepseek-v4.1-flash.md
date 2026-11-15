## 作者说法核对（读代码证实）

- “纯显示字段、不改授权判断/撤回/存储”：基本属实。改动只在只读 `grant.detail` 快照构造和合约里，未改授权、撤回、持久化。
- “label 取自 `authorization.getApproval(...).display.displayTitle`”：代码确实如此，但主要审批路径的 `displayTitle` 是 `null`，见意见 1。
- “审批卡找不到或没有 display 时 label 为 null，不抛错”：符合代码（`governance-gateway-adapter.ts:546-550,585`）。
- “到期日取 `expiresAt` 前 10 个字符（UTC 日期）”：代码确实是 `slice(0, 10)`（`grant-detail-lines.ts:64`）。UTC 只对本身就是 canonical UTC 的输入成立；一次性授权的审批/意图路径有 canonical UTC 校验（`action-policy-service.ts:153-154`），长期授权 `GrantService` 只校验晚于现在（`grant-service.ts:64`），未强制 UTC。
- “没有代码注释；合约夹具和 control-center 夹具已同步”：属实。
- “测试覆盖……”：两个单测和集成测试断言属实，但都是正向用例，且没有覆盖真实授权形状下 `exactResourceRef` 与 `resourceIdentities` 重叠的情况，见意见 2、5。

---

### 1. 【高】label 在主要审批路径上恒为 null，手机页显示不出“当时答应的那句话”

**文件:行**：`packages/application/src/services/governance-gateway-adapter.ts:585`；`apps/agent-service/src/production-approval-display.ts:80-82`；`apps/agent-service/src/production-file-read-services.ts:59-64`；`apps/agent-service/src/production-runtime-tools.ts:695`；`apps/agent-service/src/production-device-action-authorization.ts:34`

**问题**：`label` 只取 `display.displayTitle`，但生产环境的工具审批展示构造器把 `displayTitle` 固定写成 `null`，真正可读的内容放在 `bodyPreview`。因此对 bash/write/edit/read/web 等编码工具审批，`label` 永远为 null；对经 `production-runtime-tools.ts:695` 的 owner-scope 工具，连 `display` 都不传。只有设备动作审批设置了 `displayTitle`。

**证据（读代码证实）**：

```ts
// governance-gateway-adapter.ts:585
label: sourceApproval?.display?.displayTitle ?? null,
```

```ts
// production-approval-display.ts:80-82
return {
  displayTitle: null,
  bodyPreview: body === null ? null : approvalBodyPreview(body, maximum),
```

```ts
// production-device-action-authorization.ts:34
displayTitle: intent.title[locale] ?? null,
```

集成测试所用的审批本身也没有 `display`（`test/integration/governance-control-center.test.ts:244-262`），所以测试无法发现这个映射问题。

**建议**：明确“那句话”到底是标题还是内容。若要显示审批内容，应使用 `displayTitle ?? bodyPreview`（或 `bodyPreview` 首行/摘要），或在上游创建审批时真正写入 `displayTitle`；若退回 `bodyPreview`，注意其上限是 2001，而当前 `label` 合约上限是 301，需要同步调整。补一条带真实 `display` 的适配器测试。

---

### 2. 【中】范围项数把同一资源算两次，真实授权会显示错误数量

**文件:行**：`packages/application/src/services/grant-detail-lines.ts:25-30`；`packages/application/src/services/governance-gateway-adapter.ts:847-849`；`packages/application/src/services/action-policy-service.ts:145`；`packages/gateway-contracts/test/gateway-v2.fixture.ts:1509-1510`

**问题**：`resourceCount()` 把 `exactResourceRef`、`resourceIdentities`、`resourcePrefixes` 直接相加。但一次性授权的构造逻辑把 `exactResourceRef` 设为 `intent.resourceRef`，同时把 `resourceIdentities` 设为 `intent.resourceRefs`；而意图校验要求 `resourceRefs` 必须包含 `resourceRef`。所以同一个资源至少被计两次，`范围：N 项` 会偏大。

**证据（读代码证实）**：

```ts
// grant-detail-lines.ts:25-30
function resourceCount(input: GrantDetailInput): number {
  return (
    (input.exactResourceRef === null ? 0 : 1) +
    input.resourceIdentities.length +
    input.resourcePrefixes.length
  );
}
```

```ts
// governance-gateway-adapter.ts:847-849
exactResourceRef: current.intentSnapshot.resourceRef,
resourcePrefixes: [],
resourceIdentities: current.intentSnapshot.resourceRefs,
```

```ts
// action-policy-service.ts:145
!intent.resourceRefs.includes(intent.resourceRef) ||
```

合约夹具也直接展示了同样的重叠：

```ts
// gateway-v2.fixture.ts:1509-1510
exactResourceRef: "resource:article-01",
resourceIdentities: ["resource:article-01"],
```

**建议**：按去重后的 union 计数，例如 `new Set([...exact ? [exact] : [], ...identities, ...prefixes]).size`；如果 `exactResourceRef` 和前缀是不同粒度、确实想分别显示，则文案要改，不能笼统写“项数”。补一条真实一次性授权形状的单测。

---

### 3. 【中】`grant.snapshot` 新增必填字段会破坏旧严格客户端

**文件:行**：`packages/gateway-contracts/src/contracts-v2.ts:3326-3331,3362-3363`；`packages/gateway-contracts/src/validation.ts:186-197`；`packages/gateway-contracts/src/client-capabilities.ts:238`

**问题（读代码证实）**：`label` 和 `detail` 被加为 `grant.snapshot.payload` 的必填字段；本仓库的 `object()` 解析器明确拒绝未知字段。仓库内 control-center 已同步夹具，但手机端代码不在本仓库。若手机端仍用旧版严格 schema，服务器升级后每个 `grant.detail` 都会因 `label`/`detail` 是未知字段而解析失败。`docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md:83` 也写明不兼容变化必须使用新 schema version。

**证据**：

```ts
// contracts-v2.ts:3362-3363
label: nullable(approvalDisplayText(301)),
detail: grantDetailSchema,
```

```ts
// validation.ts:187-189
for (const key of Object.keys(record)) {
  if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
}
```

**推测（未核实）**：手机端是否与服务器同版本发布、是否存在仍在运行的旧客户端，我无法从本仓库确认。如果要求手机和服务器必须同版本上线，这是可接受但必须明确的发布约束。

**建议**：明确这是一次需要同步升级客户端的合约变更，或按“冻结合约”规则提升 schema version / 做版本协商；至少加一条“旧解析器拒绝新字段”的兼容性说明或测试，避免再次出现 `unknown field` 类事故。

---

### 4. 【低】费用行硬编码美元，忽略 capability 声明的 currency

**文件:行**：`packages/application/src/services/grant-detail-lines.ts:21-23,52-62`；`packages/gateway-contracts/src/contracts-v2.ts:3292`；`packages/application/src/services/governance-gateway-adapter.ts:471-472`；`packages/application/src/services/capability-lifecycle-service.ts:85-86`

**问题**：`dollars()` 无条件输出 `$`，但 capability manifest 的 `cost.currency` 是自由字符串（`boundedString(16)`），生命周期校验只检查金额非负，没有限制必须是 USD。grant 记录本身不携带 currency，所以详情页无法知道该用哪种货币。

**证据（读代码证实）**：

```ts
// grant-detail-lines.ts:22
return `$${(micros / 1_000_000).toFixed(2)}`;
```

```ts
// contracts-v2.ts:3292-3293
currency: boundedString(16),
maxMicrosPerInvocation: integer(0),
```

**推测**：当前生产能力和夹具都用 USD，所以现实影响可能很小；但合约允许非 USD，因此“显示美元”不是合约保证。

**建议**：把 capability 的 `currency` 带进 grant 快照/detail 输入并按货币格式化；若系统实际只支持 USD，则在能力注册/授权创建时校验并写明。

---

### 5. 【低】新字段只有正向用例，label 分支和范围去重没有能失败的反向用例

**文件:行**：`packages/application/test/grant-detail-lines.unit.test.ts:19-46`；`test/integration/governance-control-center.test.ts:494-509`；`packages/gateway-contracts/test/gateway-v2.fixture.ts:1528-1533`

**问题**：新单测只覆盖“全部项”和“空范围/费用/任务”，且第一条用例把 `exactResourceRef` 设为 `null`，正好绕过了意见 2 的重叠问题；集成测试的审批没有 `display`，只断言了“会影响 1 个任务”，没有验证 `label` 的取值或 null 回退；合约夹具里的 `label` 是手写的，不是适配器真实产出的。因此意见 1 和意见 2 的缺陷都能在现有测试下通过。

**建议**：补以下用例：
- 审批 `display.displayTitle` 有值 → `label` 等于该值；
- 审批不存在/无 `display`/`displayTitle` 为 null → `label` 为 null；
- 真实一次性授权形状（`exactResourceRef` 同时在 `resourceIdentities` 中）→ 范围只计一次；
- 非 USD 能力或明确拒绝非 USD；
- 可行的反向用例：超长 `label`、`detail` 行含控制字符、非 canonical 时间戳等应由合约拒绝。

---

## 侧重检查

- **错误路径**：`getApproval` 找不到、审批不是 governed、`display` 缺失、`displayTitle` 为 null 都走 `label: null`（`governance-gateway-adapter.ts:546-550,585`），未抛错。若 `displayTitle` 本身超长/含控制字符，`approvalDisplayText(301)` 会让整个 `grant.snapshot` 解析失败；这不是本次新增的独有风险，`approval.snapshot` 同样会失败。
- **不合规范/不可信输入**：`label` 是唯一来自审批的自由文本，合约限制 1–301 个字符且拒绝控制字符；`detail` 全部由数字和固定文案生成，不含资源/收件人原文，不会把原始引用暴露给手机。`expiresAt.slice(0,10)` 对非 UTC 偏移输入会取到当地时间日期，长期授权路径未强制 canonical UTC。
- **安全**：未发现越权。grant 先按 owner/agent 过滤（`governance-gateway-adapter.ts:516-530`）；`getApproval` 虽未再次校验 scope，但正常创建路径要求 `grant.sourceApprovalRequestId === current.id`（`approval-service.ts:80-81`），跨 owner 读取只在存储被破坏时才有可能。
- **资源耗尽**：每个 `grant.detail` 多一次 `getApproval` 读取；`grantDetailLines` 只遍历已有 scope 数组，没有新增无界循环或全表扫描。未发现 DoS 风险。
- **不可撤销操作**：本改动纯读取，没有写存储、撤回或外部副作用。
- **规则/文档一致性**：没有触碰 prompt 组装、出口遮盖或历史存储，`prompt-prefix.md` 的只追加规则不受影响。但与“冻结 wire contract / 不兼容变化用新 schema version”的既有约定存在张力，见意见 3；新字段也没有对应文档更新。

---

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动只在 Gateway 只读查询 `grant.detail` 的返回快照里加字段（`packages/application/src/ports/gateway.ts:106-112`；`agent-gateway-v2-service.ts:43-45`），没有进入系统提示、工具定义、历史消息、资料块或遮盖路径。发给模型的内容仍只在末尾追加；这次实际上没有追加任何模型内容。每轮会变的 `uses`、`spentCostMicros`、受影响任务数只出现在 API 响应里，不在模型请求中。

2. **不会让模型请求里的同一段文字变成不同字节。** 该字段不进入模型请求。就 API 响应而言，`label` 来自审批时冻结的 `display.displayTitle`；`detail` 由固定的 grant 状态生成，没有当前时间、随机值或无序集合参与输出顺序（`affectedTaskRefs` 用 `localeCompare` 排序，但只取 `length`，顺序不影响文本）。同一 grant 状态下输出确定。唯一需要注意的“会变”是使用次数/已花费用/受影响任务数随真实状态变化，这是展示语义，不是缓存前缀。

3. **有正向自动检查，但新行为的反向用例不足，不能证明“反向用例真的会失败”。** 已存在：`grant-detail-lines.unit.test.ts` 两条正向用例、合约兼容夹具解析、集成测试对“会影响 1 个任务”的断言。缺少：`label` 有值/为 null 的适配器测试、真实 grant 形状下的范围去重测试、非 USD 测试、针对新字段长度/控制字符的负向测试。意见 2 的 bug 正好说明现有测试没有覆盖真实形状。

4. **逐个值核对结果：**
   - `label`：产生于 `governance-gateway-adapter.ts:585`，消费于 `contracts-v2.ts:3362` 的 `nullable(approvalDisplayText(301))`，与审批 `displayTitle` 的既有校验一致；夹具已同步；control-center 能解析，手机端未核实。**值本身能通过两端校验，但语义在多数路径为 null，见意见 1。**
   - `detail`：产生于 `grant-detail-lines.ts`，消费于 `contracts-v2.ts:3326-3331,3363`，格式为三个语言键、每行 1–300 字符且无控制字符；夹具和集成测试已同步。**格式两端一致，但“范围项数”计算错误，见意见 2；货币格式见意见 4。**
   - `expiresAt` 日期：产生于 `slice(0,10)`，消费为普通字符串，长度远低于 300；一次性授权路径的输入有 canonical UTC 校验，长期授权路径未强制，见作者说法核对。
   - 没有新增 id、配置键、清单项或新的序列化结构；`grant` 的授权判断、撤回、存储格式均未改变。
