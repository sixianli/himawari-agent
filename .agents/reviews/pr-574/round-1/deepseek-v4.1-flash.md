没有发现高严重度问题。以下两条是读代码证实的问题，另有推测单独列出。

### 1 中 测试没有逐项锁定 kind/storageUnit，反向用例缺失

- 文件:行：`test/integration/production-delivery-timing-control.test.ts:137`、`test/integration/think-settings.test.ts:242`
- 问题：送达时机只对 `busyAtLeastPermille`、`timeoutMs`、`perMinute` 三个 key 断言具体映射；想一想只对第 0、2、6、10 项断言。其余 key 在送达时机只检查“值属于允许集合”，在想一想则完全没有检查 `kind`/`storageUnit`。若把 `macPresenceSeconds` 误映射成 `ms`，或把 `expiresAfterHours` 误映射成 `min`，现有测试仍会通过。也没有反向用例证明合约会拒绝非法的 `kind`/`storageUnit`。
- 证据：送达时机的“全集合法性”只做集合成员检查：

  ```ts
  for (const entry of payload.items) {
    expect(["ratio", "duration", "count"]).toContain(entry.kind);
    expect(["permille", "ms", "s", "count"]).toContain(entry.storageUnit);
  }
  ```

  想一想的断言只覆盖少数下标：

  ```ts
  expect(snapshot.payload.items[0]).toMatchObject({ kind: "ratio", storageUnit: "permille" });
  expect(snapshot.payload.items[2]).toMatchObject({ kind: "count", storageUnit: "count" });
  expect(snapshot.payload.items[6]).toMatchObject({ kind: "count", storageUnit: "count" });
  ```

- 建议：把 `DELIVERY_TIMING_VALUE` 和 `THINK_SETTING_UNIT_VALUE` 的期望值写成表驱动的完整断言，逐个 key 对照；再加反向用例，把 `kind` 改成 `"percent"`、`storageUnit` 改成 `"seconds"`，断言 `gatewayV2MessageSchema.parse` 抛出 `ContractValidationError`。这样才能真正证明改动和校验都锁住了。

### 2 中 架构文档和 ADR 的字段清单没有同步，违反同提交更新要求

- 文件:行：`docs/architecture-v0.1.md:438`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:132`、`.agents/instructions/document-governance.md:21`
- 问题：架构文档仍写 `think.settings.read` 返回“现值、默认值、最小、最大、单位、是否改过，以及名称、说明和单位名称”，没有 `kind`/`storageUnit`；ADR 0273 也仍只列 `key`、`value`、`defaultValue`、`minimum`、`maximum`、`overridden`、`revision`。仓库规则明确要求“当一项改动让一份反映当前事实的文档明显出错时，在同一个提交里改正它”。提交说明写 `Docs: deferred (fast mode)`，但快速模式推迟的是 Runbook 封存，不是当前事实文档的更新。
- 证据：架构文档原文只列到“单位、是否改过”；ADR 0273 第 132 行同样没有新字段；规则原文：

  > 当一项改动让一份反映当前事实的文档明显出错（PRD、架构文档、仍有效的规格或计划、某份 Runbook 的步骤）时，在同一个提交里改正它。

- 建议：本提交内更新 `docs/architecture-v0.1.md` 的字段清单；ADR 0273 可按其既有追加节补一段“追加（2026-11-15）：显示方式与存储单位”，或新建一份小 ADR 说明新增字段，避免改写原决定。

## 推测

- `packages/gateway-contracts/src/contracts-v2.ts:560-572` 只分别校验 `kind` 和 `storageUnit` 的枚举，没有校验两者组合。像 `kind: "ratio", storageUnit: "ms"` 这样的无意义组合目前能通过合约。服务端当前只会产生正确组合，所以不是已证实的生产缺陷；但如果手机端按“kind + storageUnit”直接驱动格式化和步进器，后续客户端实现最好只接受明确组合，或由合约补上组合校验。
- 快照字段是新增的必填字段。仓库里只有两个产生点，均已更新，因此当前不会失败；但共享 schema 是严格对象，若将来还有别的代码路径手工构造这两个快照，或者新客户端配旧服务端，会因缺字段/未知字段失败。仓库内没有苹果端读取这两个快照的实现，无法核实真机端兼容性。

## 侧重检查

- **错误路径**：`THINK_SETTING_UNIT_VALUE[definition.unit]` 和 `DELIVERY_TIMING_VALUE[key]` 都是表查询；两个表的 TypeScript 类型分别以 `ThinkSettingUnit` 和 `keyof DeliveryTimingConfiguration` 做穷举，当前不会出现 `undefined` 后读 `.kind` 的运行时错误。没有新增抛错或拒绝路径。
- **不合规范/不可信输入**：新增字段都是服务器输出，不进入 `think.settings.change` / `delivery_timing.settings.change` 的入参校验；没有新增可被客户端控制的取值。跨字段组合校验缺失，见“推测”。
- **安全**：没有新增凭据、权限判断或数据暴露；只是给已有数值附加显示元数据。
- **资源耗尽**：只是对现有的 11 项/12 项循环追加两个常量字段，没有新增无界循环、缓存或 I/O。
- **不可撤销操作**：没有新增写路径，`change` 的存储和版本逻辑未被修改。
- **规则/文档一致性**：`prompt-prefix.md` 不受影响；架构文档和 ADR 0273 存在上述漂移。

## 作者说法核对

- “送达时机按 key 映射、覆盖全部 12 个 key”：成立，`DELIVERY_TIMING_VALUE` 正好 12 项。
- “想一想按已有 unit 映射”：成立，`THINK_SETTING_UNIT_VALUE` 覆盖 `THINK_SETTING_UNITS` 的 8 个值。
- “送达时机响应一种语言、想一想三种语言，本 PR 不改”：成立，代码路径未变。
- “没有代码注释、合约夹具已同步”：成立；两个快照夹具各更新了一个代表项。
- “不改校验”需要限定为“不改数值范围校验”：快照合约现在把 `kind`/`storageUnit` 设为必填，属于响应合约校验收紧，旧快照载荷若缺这两个字段将无法通过当前 schema。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `delivery_timing.settings.snapshot` 和 `think.settings.snapshot` 的网关响应里追加字段；没有碰系统提示、工具定义、历史消息或遮盖逻辑。依据 `prompt-prefix.md:27-28`（会变的值只放最后一条用户消息）、`:36`（已发内容只追加）：这里的快照不是发给模型的内容，新增字段不进入请求前缀。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。`kind` 和 `storageUnit` 都由常量表按 `key`/`unit` 纯映射得到，不依赖时间、随机数、请求顺序或前后文；同一设置每次序列化结果相同。快照里的 `generatedAt` 本来就会变，但它不是模型请求内容。依据 `prompt-prefix.md:53`（JSON 键顺序、列表顺序固定）。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有正向检查：两个集成测试会解析真实快照，合约夹具 round-trip 也会要求新字段存在。反向检查目前没有：没有用例把非法 `kind`/`storageUnit` 交给合约并断言失败，所以“反向用例会失败”这一点目前无法证实。建议补上第 1 条中的负向用例。
4. **每个新值的产生处和使用处两端都能接受吗？** 服务端能。产生处是 `delivery-timing-copy.ts:223-244` 和 `production-think-settings.ts:148-165`；使用处是 `production-delivery-timing-control.ts:65-66`、`production-think-settings.ts:238-239`；接收处是 `contracts-v2.ts:560-572`、`:903-904`。送达时机产生的 `permille/ms/s/count` 和想一想产生的 `permille/s/min/h/d/count` 都在合约枚举内，类型也逐项穷举。两个快照都经 `gatewayV2MessageSchema.parse` 在集成测试里验证。手机端实际消费代码不在本仓库，未核实。依据 [I-73](../../docs/incidents-and-gates.md#incidents)：不能只检查改动本身，要看清单里的每个值能否通过使用端校验；这里服务端两端已核对，客户端端到端尚未核实。
