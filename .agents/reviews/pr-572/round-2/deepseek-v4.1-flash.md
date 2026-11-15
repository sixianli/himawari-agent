本轮查过的范围：`c99430e..f6b3cd9` 增量、`9fa3f97..f6b3cd9` 整份 PR 改动；重点读了 `governance-gateway-adapter.ts`、`grant-detail-lines.ts`、`contracts-v2.ts`、`approval-display.ts`、grant/approval 相关 port 与服务、合约夹具、control-center 夹具、control-center 客户端、浏览器 e2e 夹具与验收脚本，以及 `prompt-prefix.md`、`incidents-and-gates.md` 的 I-73。未运行测试，也未核实仓库外的手机端。

## 侧重检查

- 错误路径：`getApproval` 在 SQLite 中查不到时经 `parseRecord` 返回 `undefined`（`sqlite-durable-operations.ts:1999-2004,276-278`），因此“来源审批卡找不到时 label 为 null、不抛错”成立；但损坏的审批记录（如 `displayTitle` 带非法控制字符）会让整个 `grant.snapshot` 校验失败，与 `approval.detail` 一致，不是本次新增的独有问题。
- 不合规范输入：`approvalBodyPreview` 会替换控制字符并遮盖，`grantLabel` 二次调用后仍能通过 `approvalDisplayText(301)`；主要不合规点在浏览器 e2e 夹具缺少新增必填字段（见意见 1）。
- 安全：Grant 快照的数据分级取 `grant.scope.maxDataClassification`，正常授权路径与审批 intent 的分级一致；新增的跨对象读取未校验来源审批卡归属（见意见 3）。
- 资源耗尽：只多一次 `getApproval` 和已有数组的遍历，没有新增无界循环或不可撤销写入。
- 规则/文档一致性：`prompt-prefix` 与 I-73 已核对；作者关于 label 的说法与代码不一致（见意见 4），费用币种说法也与 capability 的 `currency` 能力不一致（见意见 2）。
- 未核实：手机端如何消费 `label`/`detail`（不在本仓库）；是否所有生产 capability 都实际使用 USD（只看到类型允许任意币种）。

### 1. 【中高】浏览器 e2e 的 grant 快照缺少新增必填字段，授权详情页会被契约校验拒绝

文件:行：`test/e2e/fixtures/control-center-browser-server.mjs:286-317`、`:1723-1725`；`packages/gateway-contracts/src/contracts-v2.ts:3362-3363`；`packages/gateway-contracts/src/validation.ts:192-197`；`apps/control-center/src/gateway-client.ts:271-274`；`scripts/qualify-control-center-browser.mjs:761-783`。

问题：`grantSnapshotSchema` 现在要求 `label` 和 `detail` 必须存在，但浏览器 e2e 夹具里的 `grant-active` 对象没有这两个键；`handleGovernanceQuery` 又原样返回该对象。控制中心收到响应后统一走 `gatewayV2MessageSchema.parse`，`object()` 对每个键要求 `Object.hasOwn`，因此会报 `missing required field`，打开 Grant 详情页会显示错误而不是记录详情，浏览器验收里的撤销流程也会卡在等待 `task-dependent-01`。

证据：
```js
// test/e2e/fixtures/control-center-browser-server.mjs:286-317
const grants = new Map([
  ["grant-active", {
    grantId: "grant-active",
    ...
    affectedTaskRefs: ["task-dependent-01"],
    generatedAt: now,
  }],
]);
// :1723-1725
case "grant.detail": {
  const grant = grants.get(message.payload.grantId);
  return grant ? governanceSnapshot("grant.snapshot", grant) : null;
}
```
```ts
// contracts-v2.ts:3362-3363
label: nullable(approvalDisplayText(301)),
detail: grantDetailSchema,
// validation.ts:192-193
for (const key of expectedKeys) {
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
// gateway-client.ts:271-272
function parsedResponseBody(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
// qualify-control-center-browser.mjs:761-763
await page.goto(`${baseUrl}/authorizations/grant-active?view=details`);
await waitForConnected(page);
await waitForText(page.getByRole("main"), "task-dependent-01");
```

读代码证实：夹具对象确实没有 `label`/`detail`；响应确实会走 schema 解析；浏览器验收脚本确实会访问该 Grant 详情页；`scripts/ci/browser.mjs:90` 会调用该验收脚本。
推测：本轮未实际运行浏览器验收，但按上述解析逻辑会失败。

建议：给该夹具补上合法的 `label` 和 `detail`（撤销后的对象也要保留）；更好的做法是增加一道检查，把浏览器/control-center 的所有治理快照夹具都过一遍 `gatewayV2MessageSchema`，避免以后再漏。这个缺口来自新增必填字段的上一提交，不是本轮 `8f2d07b21` 新增，但本轮增量没有覆盖它。

### 2. 【低】费用明细硬编码美元，没有使用 capability 声明的 currency（上一轮第 4 条未修）

文件:行：`packages/application/src/services/grant-detail-lines.ts:21-22,52-63`；`packages/application/src/ports/capabilities.ts:128`；`packages/application/src/services/governance-gateway-adapter.ts:479`。

问题：`dollars()` 无条件输出 `$`，而 capability 的 `cost.currency` 是任意字符串，Grant 快照又有 `capabilityRef`。如果某个 capability 使用 JPY/CNY，手机页会把金额显示成美元，属于错误展示。

证据：
```ts
// grant-detail-lines.ts:21-22
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
```
```ts
// capabilities.ts:128
readonly currency: string;
// governance-gateway-adapter.ts:479
currency: manifest.cost.currency,
```

读代码证实：金额符号是写死的；Grant 快照和 `GrantDetailInput` 都没有币种字段。
推测：当前仓库里见到的生产/测试 manifest 多为 USD，所以实际影响取决于是否存在非 USD capability；类型上完全允许。上一轮已指出，本轮增量没有修，也没有非 USD 的反向用例。

建议：把 capability 的 `currency` 传入 `grantDetailLines`，或不在明细里输出货币符号、只输出金额与 ISO 币种；补一条非 USD 单测。

### 3. 【低】读取来源审批卡时没有校验归属，跨 scope 的审批显示可能被带入 Grant 快照

文件:行：`packages/application/src/services/governance-gateway-adapter.ts:554-558`（对照 `:359-367`）。

问题：`#approvalSnapshot` 会校验审批的 `ownerId`/`agentId`，但新增的 `#grantSnapshot` 直接 `getApproval(grant.sourceApprovalRequestId)`，不校验该审批是否属于当前 Owner/Agent。只要某条本 scope 的 Grant 的 `sourceApprovalRequestId` 指向了别的 Owner 的审批，`label` 就会把那条审批的 `displayTitle`/`bodyPreview` 带出来。

证据：
```ts
// :554-558
const approvalRecord = await this.#dependencies.authorization.getApproval(
  grant.sourceApprovalRequestId,
);
const sourceApproval =
  approvalRecord !== undefined && governedApproval(approvalRecord) ? approvalRecord : undefined;
```
```ts
// :359-361，同一个适配器对 approval.detail 是有归属校验的
if (
  approval.ownerId !== this.#dependencies.ownerId ||
  approval.agentId !== this.#dependencies.agentId
)
```

读代码证实：这里确实没有归属校验。
推测：正常写路径（`#respondApproval`、自动复核、policy authorization）都从同一审批创建 Grant，暂时没有找到可由外部输入制造“跨 Owner 引用”的可达路径；因此按加固问题而非已可利用漏洞报告。

建议：使用前校验 `sourceApproval.ownerId/agentId` 与当前配置或 Grant 的归属一致，不一致就按无审批卡处理（`label: null`）。

### 4. 【低】作者说法与代码不一致：displayTitle 为空时不是 null，而是二次遮盖/截断后的正文

文件:行：`packages/application/src/services/governance-gateway-adapter.ts:164-169`。

问题：作者说“label 取自审批卡的 displayTitle，没有就是 null”，但代码在 `displayTitle === null` 时回退到 `approvalBodyPreview(bodyPreview, 300)`。这意味着主工具审批路径现在能显示正文（这正是上一轮意见 1 的修复），但与说明不一致。另一点是回退时会对已经遮盖/截断过的 `bodyPreview` 再跑一次 `approvalBodyPreview`，在 `bodyPreview` 原本超过 300 字符时，label 与审批页的 `bodyPreview` 不是同一字节。

证据：
```ts
function grantLabel(approval: GovernedApprovalRequest | undefined): string | null {
  const display = approval?.display;
  if (!display) return null;
  if (display.displayTitle !== null) return display.displayTitle;
  return display.bodyPreview === null ? null : approvalBodyPreview(display.bodyPreview, 300);
}
```

读代码证实：`displayTitle` 为空时确实会回退到正文，不是 null。
推测：二次遮盖通常不会再改变已遮盖文本；二次截断在 `bodyPreview` 超过 300 字符时确定会发生，但默认工具审批的正文上限也是 300，只有配置调大正文上限时才会明显不同。

建议：把作者说明改成“优先 displayTitle，否则取冻结正文的前 300 字符”；如果希望 label 与审批页完全一致，可以直接使用已冻结的 `bodyPreview`，只在超过契约上限时截断，并补一条 displayTitle 非空和正文超长的用例。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动集中在 Gateway 只读快照、纯函数明细生成、合约 schema 和测试夹具，不在系统提示、工具定义、历史消息或模型请求组装路径上。新增的 `maskSensitiveText` 调用只用于 UI 的 `label`，不是出口遮盖。没有值被追加到请求末尾，也不存在“每轮会变的值进入最后一条消息”的问题，因为本改动完全不碰模型请求。手机端如何消费（未核实，仓库内没有客户端代码）。

2. **同一段文字会不会在不同请求里变成不同字节？** 就这些新字段而言不会：`resourceCount` 的 Set 只取 `.size`，不迭代输出；`detail` 三语数组按固定顺序 push；`dollars`/`slice(0,10)`/固定文案都是确定性的；`label` 是冻结审批卡 display 的纯函数，`maskSensitiveText` 也只依赖输入文本。没有新增时间、随机数或无序集合输出。唯一的跨字段差异是意见 4 的 `label` 与 `approval.detail` 的 `bodyPreview` 可能不同（同一底层文本、不同字段），不是同一字段在不同请求间变化。

3. **有没有对应的自动检查，反向用例会不会真的失败？** 有，且两条上一轮修复的反向用例从代码上会失败：旧 `resourceCount` 对 `exactResourceRef` 与 `resourceIdentities` 同一值会算出 2，新增单测期望 1；旧 `grantLabel` 在 `displayTitle: null` 时返回 null，新增集成测试期望 300 个 `x` 加 `…`。但覆盖有缺口：浏览器 e2e 夹具没同步（意见 1，浏览器验收会失败）；非 USD 费用没有反向用例；来源审批卡完全缺失、`displayTitle` 非空路径没有专门用例。本轮未实际执行测试，以上是读代码判断。

4. **每个新值的产生端和使用端都能接受吗？** 逐项核对：
   - `grant.snapshot.payload.label`：产生端 `grantLabel` 最多产生 301 个 Unicode 码点（`approvalBodyPreview(...,300)` 或已受审批 schema 限制的 `displayTitle`），消费端 `nullable(approvalDisplayText(301))` 正好接受 1–301 字符；合约夹具和 control-center JSON 夹具已更新。**缺口**：浏览器 e2e 夹具没有 `label`，必填校验会拒绝（意见 1）；仓库外手机端未核实。
   - `grant.snapshot.payload.detail`：产生端 `grantDetailLines` 生成的三语行都远短于 300 字符，消费端 `array(boundedString(300))` 接受；合约夹具和 control-center 夹具已更新。**缺口**：同一个浏览器 e2e 夹具没有 `detail`（意见 1）。
   - `grantDetailLines` 导出函数：使用端只有 `governance-gateway-adapter.ts:594` 和新增单测，没有遗漏的调用方。
   - 配置键、标识、序列化格式：没有新增配置键或标识；没有修改现有序列化格式，只是给 `grant.snapshot` 增加字段。
   - `ResourceCount` 的去重：对当前 Gateway 暴露的 governed grant，`resourcePrefixes` 在主写路径都是空数组，`exactResourceRef` 通常也出现在 `resourceIdentities` 中，因此按字符串去重能修正上一轮的双计数；跨“精确引用/前缀”命名空间的语义歧义目前没有可达数据触发（推测，未找到非空 prefixes 的 governed grant 写入路径）。
   - 费用币种：消费端能接受字符串，但语义上把任意币种都当 USD（意见 2）。
