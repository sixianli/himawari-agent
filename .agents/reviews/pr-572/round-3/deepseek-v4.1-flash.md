本轮查过的范围：增量 `f6b3cd97..5c80f59a` 的全部非 `.agents` 改动；同时回看了完整 PR 中 `grant.snapshot` 的合约定义、审批遮盖、夹具和集成测试。用 grep/read 追踪了 `grantDetailLines`、`grant.snapshot`、`label`/`detail` 的所有直接使用处；未运行测试，也未读到手机端代码。

### 1. 【低】费用明细仍写死美元，没有使用 capability 声明的 currency（上一轮第 2 条仍未修）
文件:行：`packages/application/src/services/grant-detail-lines.ts:20-21`、`51-61`
问题：`dollars()` 无条件输出 `$`，费用行全部使用它；但 capability 合约允许任意 1–16 字符的币种，grant 快照又没有携带币种，手机端无法纠正。
证据：
```ts
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
```
```ts
zh.push(`费用上限 ${total}，已花 ${spent}`);
```
`packages/gateway-contracts/src/contracts-v2.ts:3292` 是 `currency: boundedString(16)`，`governance-gateway-adapter.ts:479` 也在 capability 快照里输出 `currency: manifest.cost.currency`，说明币种并非天然只有 USD。
建议：要么在 grant 快照/明细里带上币种并按币种格式化，要么把 capability 合约和部署校验收紧为只允许 USD，并写明这一约定。

### 2. 【低】detail 已删除到期日，但测试名和作者说明仍写着“到期”
文件:行：`packages/application/src/services/grant-detail-lines.ts:47-68`、`packages/application/test/grant-detail-lines.unit.test.ts:19`
问题：增量已移除到期日明细，测试标题仍写 `lists scope, uses, cost, expiry and affected tasks`，作者说明也仍称 `到期日取 expiresAt 的前 10 个字符`，和当前代码不一致。
证据：当前函数从“已用”直接进入费用判断，没有再出现 `expiresAt`；测试期望里也已没有 `到期：...`。
建议：更新测试标题和 PR 说明；若手机端确实不再需要该行，写明到期日改由 `payload.expiresAt` 单独展示。

### 3. 【低】label 在 displayTitle 为 null 时会回退到审批正文，和“没有就是 null”的说法不一致
文件:行：`packages/application/src/services/governance-gateway-adapter.ts:165-169`
问题：作者称 label 取自 `display.displayTitle`，没有就是 null；实际代码在 `displayTitle === null` 时还会取 `bodyPreview` 并截到 300 字符。
证据：
```ts
if (display.displayTitle !== null) return display.displayTitle;
return display.bodyPreview === null ? null : approvalBodyPreview(display.bodyPreview, 300);
```
这次回退在 `8f2d07b21` 的提交说明里是刻意的（工具审批的 displayTitle 恒为 null），因此更可能是说明过期，而不是代码错误；但两者必须统一。
建议：把作者说明/规格改成“displayTitle 优先，否则回退到正文，截 300 字符”；若产品要求必须是 null，则删除回退并补测试。

### 4. 【低】浏览器夹具的 detail 文本与真实生成器不一致，且没有自动校验
文件:行：`test/e2e/fixtures/control-center-browser-server.mjs:316-321`，对照 `grant-detail-lines.ts:38-46`、`51-61`
问题：夹具写的是 `"范围 1 项"`、`"收件对象 1 个"`，生成器输出的是 `"范围：1 项"`、`"收件对象：1 个"`；该 grant 的 `maxTotalCostMicros` 为 1000，真实生成器还会多出一行费用明细，夹具没有。合约只校验字符串长度，所以夹具能通过，但它并不代表真实服务器输出。
证据：
```js
"zh-CN": ["范围 1 项", "收件对象 1 个", "已用 0/1 次", "会影响 1 个任务"],
```
```ts
zh.push(`范围：${resources} 项`);
zh.push(`收件对象：${count} 个`);
```
建议：用 `grantDetailLines` 生成夹具内容，或增加一条测试把夹具交给真实生成器和 `grant.snapshot` 合约同时校验。上一轮第 1 条（夹具缺必填字段）已通过这两个字段补上，但没有留下防漂移的自动检查。

**读代码证实的**
- 上一轮第 1 条已修：e2e 夹具的 `label`/`detail` 已存在，长度、非空、无控制字符，能通过 `grantSnapshotSchema`。
- 上一轮第 2 条未修：费用仍用 `$` 且只以 micros 数值为单位。
- 完整 PR 的其他 grant 快照生产处只有 `governance-gateway-adapter.ts`；夹具侧 `gateway-v2.fixture.ts`、`control-plane-snapshots.json`、e2e 夹具都已带 `label`/`detail`。
- `grantDetailLines` 的直接调用方只有 `governance-gateway-adapter.ts:594`，`expiresAt` 删除后没有遗漏调用方。

**推测**
- 手机端“你答应过的事”页不在本仓库，无法核实它是否改为单独读取 `expiresAt` 显示日期，也无法核实它是否接受新的 `label`/`detail` 结构。
- 目前观察到的 capability 夹具都是 USD；只有出现非 USD manifest 时，硬编码 `$` 才会实际显示错误。

**侧重检查**
- 错误路径：审批找不到、`display` 缺失、`bodyPreview` 为 null/空白，`grantLabel` 都返回 null 或不抛错；`getApproval` 若存储层报错仍会向外传播，属于原有读路径。
- 不可信输入/安全：`bodyPreview` 回退经过 `approvalBodyPreview` 的遮盖、非法字符替换和截断；`displayTitle` 直接返回，但审批快照本身也以同样规则输出，未发现本次新增的注入或越权读，查询仍受 owner/agent scope 约束。
- 资源耗尽：只输出计数和固定短文本；`bodyPreview` 最多重算原有长度，未发现新的无界循环或大对象复制。
- 规则/文档一致性：`prompt-prefix` 不涉及；作者说明与代码在“到期日”“label 回退”两点不一致，测试标题也未更新；I-73 要求的“产生端和使用端都校验”已在下面逐项核对。

**必答问题**

1. **会不会改变模型已见过的请求开头？** 不涉及。`grant.snapshot` 是控制中心/手机读取的治理查询响应，不是系统提示、工具定义或历史消息；本次改动只改这个响应里的新内容。即使它作为某次工具结果被追加，也是追加在末尾，`uses`、`spentCostMicros`、`generatedAt` 等变化值都只在该响应内，不会改写已发出的历史。依据符合“只追加”。

2. **同一段文字会不会在不同请求里变成不同字节？** 在本次范围内没有发现。`detail` 的行顺序固定，范围/收件人只输出数量而不是无序集合；`label` 来自冻结的审批显示，`bodyPreview` 回退的遮盖和截断只取决于该字符串本身；没有新增时间字段。

3. **有没有自动检查，反向用例真的会失败吗？** 部分有。`grant-detail-lines.unit.test.ts` 用精确数组断言，若重新加回到期日行会失败；集成测试覆盖 `bodyPreview` 作为 label 截到 301 字符，以及“会影响 1 个任务”。但没有反向测试证明缺少 `label`/`detail` 会被合约拒绝，也没有测试校验 e2e 夹具与真实生成器一致；上一轮夹具漂移正是因此漏过的。`displayTitle` 分支也未见专门的 grant-label 用例。

4. **每个产生/修改的值，两端都能接受吗？**
   - `GrantDetailInput.expiresAt` 删除：唯一调用方 `governance-gateway-adapter.ts` 和测试已同步，grep 未发现其他调用方。
   - `detail` 数组：合约是 `array(boundedString(300))`，生成器输出均为非空短字符串，数量有界；控制中心当前不渲染 `detail`，集成测试用 `arrayContaining` 可接受；手机端未核实。
   - `label`：合约允许 301 个字符；`displayTitle` 的审批合约上限也是 301，`bodyPreview` 回退是 300 + `…`，集成测试正好覆盖 301；手机端未核实。
   - e2e 夹具新增值：均能通过合约校验，但文本与真实生成器不一致（见第 4 条）。
   - `currency`：grant 快照没有这个值，明细却写死 `$`，这是第 1 条仍未解决的问题。
