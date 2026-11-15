查过范围：`cfc33b0..0ed9999` 全量增量；`12e9094..0ed9999` 的 PR 552 相关文件；上一轮可见的两个修复提交 `b4bf80a`、`8eee973`；PR 551 合并进来的代码只核对了与本 PR 的交互点（ операции 清单、网关分发、contracts/capability/CI、导入）。`.agents/reviews/pr-552/*` 被工具拒绝读取，所以上一轮判断记录本身没有读到，按当前代码和提交历史核对。

结论：本轮增量里 PR 552 的送达时机实现没有新的代码改动；`0ed9999` 只改了测试里的类型断言。未发现高、中严重度问题。以下为低严重度意见。

### 1（低）作者说“不涉及发给模型的内容”，但改动会改变送达时机判断模型收到的 facts
文件: `apps/agent-service/src/production-delivery-timing.ts:89-120`、`packages/platform-node/src/delivery-timing-decision.ts:50-76`、`packages/application/src/services/delivery-timing.ts:153-210`
问题: 新增的 holder 让每次判断都用最新设置重算感知窗口；窗口决定哪些感知记录进入 facts，而 facts 会被序列化进送达时机模型的 `input_json`。因此修改“多新算新”这类数值，确实会改变发给该模型的内容。
证据（读代码证实）:
```ts
const configuration = options.configuration();
const windows = [
  ["speech.utterance", configuration.speechFreshSeconds],
  ...
];
return judge.decide({ pushClass, facts: ownerStateFacts(records, nowMs, configuration) });
```
以及：
```ts
ownerReports: input.facts.map(({ signal, value, secondsAgo }) => ({ ... }))
```
建议: 修正作者说法或 ADR 说明。应写成“不新增模型调用、主对话提示不变；但会改变送达时机判断模型唯一一条 user 消息里的事实集合”。这不是多轮前缀违规：指令固定，易变值都在唯一/最后一条消息里。

### 2（低）缺少“没有 holder 时操作不安装、改值真正作用到运行中 web push”的端到端检查
文件: `test/integration/production-delivery-timing-control.test.ts:74-84`、`apps/agent-service/src/service-main.ts:2786-2868`、`apps/agent-service/src/service-main.ts:3343`
问题: 集成测试里的 `changed` 只是把结果写进本地变量 `effective`，没有经过真实 `DeliveryTimingHolder`；也没有测试 `createProductionHttpComposition` 在传入/不传入 `deliveryTimingSettings` 时是否分别安装/不安装这两个操作。
证据（读代码证实）:
```ts
changed: (overrides) => {
  effective = applyDeliveryTimingOverrides(DELIVERY_TIMING_DEFAULTS, overrides);
},
```
真实接线是：
```ts
deliveryTimingHolder = new DeliveryTimingHolder(timingConfiguration, (...).overrides);
...
...(deliveryTimingHolder ? { deliveryTimingSettings: deliveryTimingHolder } : {}),
```
建议: 增加一个组合级测试：不传 `deliveryTimingSettings` 时已安装操作清单没有这两个操作；传入真实 holder 后改值，下一次 web push `#timed` 使用新的 `configuration()`。

### 3（低）作者“只有配置了 runPolicy.deliveryTiming 才创建 holder”的说法不完整
文件: `apps/agent-service/src/service-main.ts:2786-2868`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:135`
问题: 代码里 holder 创建还嵌在 `webPushConfiguration && webPushSecret && episodeProtector` 条件内；只配置 deliveryTiming、没有可用网页推送时不会创建 holder，也不会安装操作。ADR 已写明这一点，但作者概述只提了 `runPolicy.deliveryTiming`。
证据（读代码证实）:
```ts
if (webPushConfiguration && webPushSecret && episodeProtector) {
  ...
  if (timingModel && timingConfiguration)
    deliveryTimingHolder = new DeliveryTimingHolder(...)
}
```
建议: 只改作者说法/PR 描述，代码与 ADR 一致，不需要改行为。

以上三条均为读代码证实。未实际运行测试（工具限制）；“反向用例会失败”是按代码路径推断，不是实测。

## 侧重检查

- 错误路径：未知 key、`constructor`、越界值、旧 revision、非主人 actor、非法 scope 都有拒绝路径；持久化层非法时间/非安全整数/非法 key 形状也会拒绝。
- 不合规范输入：网关 schema 用 `integer(0)`、`machineString`、可空整数；控制类用 `Object.hasOwn` 和范围检查；SQL 全参数化。
- 安全：改操作要求 `actorType === "owner"` 且 scope 与配置一致；读只读本配置的 owner/agent；新表按 owner/agent 级联删除；设置中无密钥。
- 资源耗尽：控制类只允许 11 个已知 key；送达时机读取窗口仍受 `READ_PAGES * READ_LIMIT` 上限约束。持久化层本身不限 key 数量，但生产写入口只有控制类，未发现外部放大路径。
- 不可撤销操作：设置可用 `value=null` 恢复默认，revision 防止旧设备覆盖新值，没有破坏性操作。
- 规则/文档一致性：ADR 与代码基本一致；发现上面第 1、3 条作者说法不一致。迁移 `delivery_timing_settings.updated_at` 没有像 `think_settings` 那样加 GLOB 格式约束，但应用层 `validTime` 强制 ISO，当前没有绕过写入口，未作为意见。

## 必答问题

1. **主模型请求开头：不涉及。** 本 PR 不新增模型调用、不改系统提示/工具定义/历史消息/遮盖结果；送达时机判断模型是单次请求，指令固定，facts 在唯一一条 user 消息里。注意它确实会改变该消息里的 facts（见意见 1），但不是“前缀被改写”。
2. **同一段文字不同字节：对主模型无影响。** 网关快照里的 `generatedAt`、`revision` 会变，持久化 JSON 的 key 顺序也可能随编辑历史变化，但这些不进模型请求。送达时机 facts 仍走现有 `sequentialPlaceholderTag`，占位符按本次出现顺序编号；如果 facts 中有会被遮盖的值，窗口变化导致前面 fact 增减时，同一值的占位符理论上可能变化。这是现有机制，实际触发条件未构造验证。
3. **自动检查：覆盖较充分，但有一处缺口。** holder 有越界/未知旧值的反向用例；控制集成测试有越界、未知 key、`constructor`、旧 revision、非主人、非对象 JSON 的反向用例。去掉相应过滤/校验时这些断言会失败。缺口是“安装门槛”和“控制类→真实 holder→web push deadline”的组合级检查（见意见 2）。
4. **新增值的直接使用端：逐个核对后两端一致。** `delivery_timing.settings.read/change/snapshot` 在控制类、`contracts-v2`、`client-capabilities`、审批网关分发、route options 已安装清单、`ci/operations-pending.json` 中拼写一致；快照字段与 schema、fixture 一致；变更字段 `expectedRevision/key/value` 与 schema、控制类、SQL 操作一致；`delivery_timing_settings` 表列与 SQL、迁移、schema catalog 一致；`deliveryTimingSettings()` 的 repository/durable/IPC 操作名一致；11 个配置键与 `DELIVERY_TIMING_DEFAULTS/RANGES`、严格配置解析一致；`resultRef` 格式也符合 `machineString` 允许的 `[A-Za-z0-9._:-]`。PR 551 合并进来的 `think.settings.*` 也按同一方式核对，未发现与本 PR 冲突。
