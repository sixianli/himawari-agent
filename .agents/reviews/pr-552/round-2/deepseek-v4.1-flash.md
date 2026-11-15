我先看这两个 diff 的范围，再核对上一轮意见和增量。
增量只有 review 记录文件。先确认这一点，再读 review 记录内容。
上一轮的 review 记录在稀疏检出中不可读，git 也拒绝读取 records 路径。改为直接核对整份 PR 代码，重点看增量基线下已包含的修复和最终行为。
## 本轮范围

- `git diff 7386224a29f5b00ee28ee9851d666544c023fa78..dd54ef116fb7e99b0c6be778d543c2ed60f94e87` 只有 `.agents/reviews/pr-552/low-fix-refusals.jsonl` 和 `usage.jsonl` 两个记录文件，`-- apps packages test ci clients docs` 没有差异；本轮增量没有代码改动。
- 上一轮记录在稀疏检出中不存在，`git show` 也被拒绝，无法逐条核对上一轮意见。可核对的是 `b4bf80a`：读接口改成用 `deliveryTimingOverrideValue` 过滤旧值，并加了反向测试；这个低问题看起来已修好。
- 本轮重读了：控制类、holder/判断源、`service-main` 装配、HTTP/审批网关路由、v2 合约、客户端能力表、SQLite 端口/迁移/schema catalog、`ci/operations-pending.json`、ADR 0273 和相关测试。没有运行测试（工具限制），反向用例的失败结论来自 diff 推演。

## 意见

### 1、低：核心“改后立即生效”的生产装配链路没有自动检查

**文件:行**：`test/integration/production-delivery-timing-control.test.ts:75-84`、`apps/agent-service/test/production-delivery-timing.unit.test.ts:114-134`、`apps/agent-service/src/service-main.ts:2774-2856`、`apps/agent-service/src/production-http-composition.ts:1562-1572`

**问题**：现有测试只直接构造 `ProductionDeliveryTimingControl`，并用一个测试内的 `changed` 回调模拟生效；没有测试从 `service-main`/`createProductionHttpComposition` 走真实装配，也就没有检查“只有 holder 存在时才安装两个操作”“命令后真实的 `ProductionWebPush`/`DeliveryTimingJudge` 读到新值”。

**证据**：
```ts
// test/integration/production-delivery-timing-control.test.ts:75-84
new ProductionDeliveryTimingControl({
  configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
  defaults: DELIVERY_TIMING_DEFAULTS,
  store: repository.deliveryTimingSettings(),
  clock: { now: () => now },
  changed: (overrides) => {
    effective = applyDeliveryTimingOverrides(DELIVERY_TIMING_DEFAULTS, overrides);
  },
});
```
```ts
// apps/agent-service/test/production-delivery-timing.unit.test.ts:131-133
expect(source.configuration().motionFreshSeconds).toBe(300);
holder.apply({ motionFreshSeconds: 60 });
expect(source.configuration().motionFreshSeconds).toBe(60);
```
第二条测试只检查 `source.configuration()`，没有调用 `source.judge()`，所以“判断真正使用新窗口”也没有被测到。`service-main.ts:2847-2856` 的 holder 创建和 `3331` 的传入、`production-http-composition.ts:1562-1572` 的控制类构造都只靠代码阅读确认。

**建议**：加一条经过 `startTenantRuntime` 或 `createProductionHttpComposition` 的测试：配置/不配置 `runPolicy.deliveryTiming` 与 web push 两种组合，断言两个操作是否出现在已安装清单；再通过真实网关命令改值，断言真实 web push 的最晚送达时间或 `source.judge()` 选择的事实确实变化。

### 2、低：作者说“只配 deliveryTiming 就创建 holder”，代码还要求 web push、密钥和 episode 保护

**文件:行**：`apps/agent-service/src/service-main.ts:2774`、`2845-2856`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:135`

**问题**：作者的说法是“只有配置了 `runPolicy.deliveryTiming`（模型路线）才创建 holder 并把两个操作装进网关”。代码实际把 holder 创建放在 `if (webPushConfiguration && webPushSecret && episodeProtector)` 里面；没有 web push 配置、密钥或 episode 保护时，即使配了 `runPolicy.deliveryTiming` 也没有 holder，两个操作不会安装。

**证据**：
```ts
// service-main.ts:2774
if (webPushConfiguration && webPushSecret && episodeProtector) {
// service-main.ts:2847-2856
if (timingModel && timingConfiguration)
  deliveryTimingHolder = new DeliveryTimingHolder(
    timingConfiguration,
    (await pushRepository.deliveryTimingSettings().read({...})).overrides,
  );
```
ADR 本身写的是对的：
```md
// docs/adr/0273-...md:135
- 只有配置文件里配了 `runPolicy.deliveryTiming`（送达时机已启用）、并且网页推送（`runPolicy.webPush`、它的密钥和 episode 保护）可用时，这两个操作才会装进网关。
```

**建议**：修正 PR 描述/作者说法，使其与 ADR 和代码一致。若产品确实希望没有 web push 时也能在 App 里看/改这些值，需要把 holder 和操作安装移出 web push 条件，但那时要说明改完没有消费者，当前语义下不建议改代码。

### 3、低：作者说“不涉及发给模型的内容”，但 freshness 设置会改变模型收到的 ownerReports

**文件:行**：`apps/agent-service/src/production-delivery-timing.ts:89-120`、`packages/platform-node/src/delivery-timing-decision.ts:50-76`

**问题**：5 个 `*FreshSeconds` 设置决定哪些感知记录进入 `ownerStateFacts`，进而成为发给决策模型的 `ownerReports`；因此“不涉及发给模型的内容”这个说法不准确。它仍然不改变请求开头：固定指令在 `questions[].instructions`，动态事实只在唯一一条 user 消息里，所以不违反只追加规则。

**证据**：
```ts
// production-delivery-timing.ts:90-97
const configuration = options.configuration();
const windows = [
  ["speech.utterance", configuration.speechFreshSeconds],
  ["motion.activity", configuration.motionFreshSeconds],
  ["health.sample", configuration.sleepFreshSeconds],
  ["context.focus", configuration.focusFreshSeconds],
  ["context.connectivity", configuration.connectivityFreshSeconds],
];
```
```ts
// delivery-timing-decision.ts:53-69
questions: [
  { type: "predicate", name: QUESTION_NAME, instructions: DELIVERY_TIMING_QUESTION.text },
],
input: [{
  role: "user",
  content: [{
    type: "input_json",
    data: {
      notificationKind: input.pushClass,
      ownerReports: input.facts.map(({ signal, value, secondsAgo }) => ({...})),
    },
  }],
}],
```

**建议**：把描述改成“不改变系统提示、工具定义、历史或请求开头；只改变独立判断请求最后一条用户消息里的事实集合和 `secondsAgo`”。代码本身不需要改。

### 4、低：读取端不校验 overrides 的 JSON 类型，异常行会让查询/启动抛错

**文件:行**：`packages/persistence-sqlite/src/migrations/20261115031100_delivery_timing_settings.sql:4`、`packages/persistence-sqlite/src/sqlite-delivery-timing-settings-operations.ts:56-58`、`packages/application/src/services/delivery-timing.ts:62-63`

**问题**：表只保证 `json_valid(overrides)`，读取时直接把 `JSON.parse` 结果当成对象；如果库里出现合法 JSON 但不是对象的值（例如 `null`），`deliveryTimingOverrideValue` 里的 `overrides[key]` 会抛 `TypeError`，导致读接口或启动时 holder 初始化失败。正常通过本 PR 的写入路径不会产生这种值（写入的是 `JSON.stringify(next)`，`next` 是对象），所以需要外部写坏或旧数据才会触发。

**证据**：
```sql
-- migration:4
overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides)),
```
```ts
// sqlite-delivery-timing-settings-operations.ts:56-58
return Object.freeze({
  overrides: Object.freeze(JSON.parse(row.overrides) as Record<string, number>),
  revision: row.revision,
});
```
```ts
// delivery-timing.ts:62-63
const value = overrides[key];
const [minimum, maximum] = DELIVERY_TIMING_RANGES[key];
```

**建议**：`read` 解析后检查 `typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)`，不满足就返回空 overrides 或按端口错误处理；加一条插入 `overrides='null'` 的反向测试。

## 侧重检查

- **授权**：`ProductionDeliveryTimingControl.execute` 检查 `actorType === "owner"` 且 owner/agent scope 匹配（`production-delivery-timing-control.ts:72-81`）；网关层 `AgentGatewayV2Service.authorize` 校验认证 owner 和 subject，`ProductionThreadGatewayAccessPolicy` 校验 owner、agent 和活动会话（`production-http-composition.ts:534-543`）。未发现绕过。没有 recent-authentication 要求；这与 `owner.preferences.set` 现有做法一致，未列为缺陷，但值得产品确认。
- **非法输入**：超范围、未知 key、`constructor`、旧 revision、非 owner 都有测试；持久化另校验 key 形状、时间、revision、value 为非负安全整数。唯一没校验的是已存 JSON 的对象类型，见意见 4。
- **资源耗尽**：固定 11 项、范围有上限（最大延后 86400 秒、超时 10000 毫秒、每分钟 600 次），一次只读/写一行，没有用户可控的无限增长；未发现新的资源耗尽路径。
- **不可撤销操作**：只有覆盖和恢复默认，没有删除或不可逆写入；恢复默认是 `value: null`，可再次设置。
- **规则/文档一致性**：ADR 0273:132-135 与代码基本一致；作者摘要里的 holder 创建条件和“不涉及模型内容”两处与代码不一致，见意见 2、3。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这次改动不碰系统提示、工具定义、历史或遮盖规则；唯一的模型调用是独立的送达时机判断请求，固定指令在 `questions[].instructions`，会变的 `ownerReports` 和 `secondsAgo` 都在唯一一条 user 消息里（`delivery-timing-decision.ts:53-69`）。freshness 设置只改变哪些事实被选中，不把值塞进系统提示或更早位置，符合 `prompt-prefix.md:27-28`、`36` 的只追加/会变值放最后一条消息的要求。但作者“不涉及发给模型的内容”不准确，见意见 3。

2. **模型请求没有新增的字节不确定性。** 指令文字固定；`ownerStateFacts` 按固定顺序 push 事实；遮盖用请求内顺序确定的占位符，只依赖该条消息自身和前面的事实；动态的 `secondsAgo`、事实集合只在最后一条消息。快照里的 `generatedAt` 每次读取都会变，但这是网关响应的时间戳字段，不是模型输入；`items` 顺序由 `DELIVERY_TIMING_KEYS` 固定；数据库 JSON 的键顺序可能随写入顺序变化，但不暴露给客户端也不参与模型输入。因此不违反“同内容同字节”的模型侧要求。

3. **有自动检查，但只覆盖逻辑层，不覆盖生产装配。** 控制类的范围/未知 key/旧 revision/非 owner、持久化的 revision 冲突、holder 的即时应用、越界旧值读取时显示默认值都有测试。反向用例按 diff 推演确实会失败：例如去掉 `b4bf80a` 的过滤后，存 5 会显示 `value:5, overridden:true`，而测试期望 `300,false`；去掉 `Object.hasOwn` 后 `constructor` 会被写入。缺口是本轮意见 1 的生产装配和真实 web push 生效链路；我未能运行测试，结论是读代码推演。

4. **逐个核对后没有发现“产生端/使用端校验不一致”。** 具体检查了：
   - `delivery_timing.settings.read/change/snapshot` 在 `contracts-v2.ts` 的消息类型、schema、`gateway-v2.fixture.ts`、`client-capabilities.ts`、Swift `ClientCapabilities.swift`、`ci/operations-pending.json` 中的名字一致；`change` 的 `value` 两端都是 nullable 整数，snapshot 的 `value/default/min/max/revision` 都是非负整数，`generatedAt` 是 timestamp。
   - `DeliveryTimingSettingsStorePort` 的 `read/write` 形状与 SQLite adapter、`SqliteProductStateRepository.deliveryTimingSettings`、控制类和 `service-main` 的调用一致；持久化校验 key 形状/时间/revision/value，控制类校验已知 key、范围和 owner；两端合起来能接受控制类产生的值。
   - 新表 `delivery_timing_settings` 的列、主键、外键与 `sqlite-delivery-timing-settings-operations.ts` 的 SELECT/INSERT 一致；迁移会被 `loadBundledMigrations` 按时间戳自动发现；`schema-catalog.ts` 已登记。
   - `DeliveryTimingHolder` 的 `base/current/apply` 与 `createDeliveryTimingSource`、`DeliveryTimingJudge`、`ProductionWebPush.#timed` 的读取方式一致，都是通过 `current()`/`configuration()` 取当前值。
   - `DELIVERY_TIMING_DEFAULTS`/`DELIVERY_TIMING_RANGES`/`DELIVERY_TIMING_KEYS` 都是 11 项且 key 对齐；配置解析 `parseDeliveryTiming` 用同一组范围。

   唯一相关的问题是意见 4 的已存 JSON 形状，不是产生端与使用端的字段名/枚举不匹配。
