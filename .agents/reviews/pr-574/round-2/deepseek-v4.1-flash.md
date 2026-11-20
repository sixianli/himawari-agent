本轮查过：`841f2ac..172c242` 的增量（只有 `test/integration/think-settings.test.ts` 和复核记录）；`1ca0ccd..172c242` 的完整改动（两个设置服务、两个字段映射、合约 schema、夹具、两份集成测试、架构文档）；并跟到 `packages/application` 的设置定义、送达时机配置、ADR 0273 和相关规格。上一轮复核记录在稀疏工作树里没有、`git show` 又被记录路径规则拒绝（`REVIEW_GIT_REFUSED records-path`），所以无法逐条对照上一轮意见；只能从提交 `841f2ac`、`172c` 的 diff 看出改了什么。测试和 typecheck 未实际运行，结论来自代码阅读。

### 1. 低：送达时机快照的新字段没有同步到 ADR 的字段清单

- 文件: `docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:132`
- 问题: 代码已经让送达时机快照每一项多返回 `kind` 和 `storageUnit`，但 ADR 仍只列旧字段；本轮架构文档只补了“想一想”的字段，送达时机没有对应段落，文档和代码不一致。
- 证据: ADR 原文仍写：“查询 `delivery_timing.settings.read`，返回 `delivery_timing.settings.snapshot`：每一项的 `key`、`value`……`minimum`、`maximum`、`overridden`……以及整体 `revision`。” 而 `apps/agent-service/src/production-delivery-timing-control.ts:65-66` 实际返回：
  ```ts
  kind: DELIVERY_TIMING_VALUE[key].kind,
  storageUnit: DELIVERY_TIMING_VALUE[key].storageUnit,
  ```
- 建议: 在 ADR 0273 追加新字段和值域，或新增一段“契约扩展”记录；否则下一批实现手机设置页时按旧 ADR 会漏掉这两个字段。

### 2. 低（推测）：`perMinute` 的新类型元数据丢失“每分钟”量纲

- 文件: `apps/agent-service/src/delivery-timing-copy.ts:235`
- 问题: `perMinute` 实际存储的是“每分钟次数”，但新增的机器可读字段是 `kind: "count"`、`storageUnit: "count"`。手机若按本 PR 的 `kind`/`storageUnit` 直接选显示格式，只能知道“个数”，不能知道“每分钟”；现有本地化 `unit`（如“次/分钟”“/min”）仍带分母，但新字段本身不足以区分速率和普通计数。
- 证据: `perMinute: { kind: "count", storageUnit: "count" },`；同一文件 `delivery-timing-copy.ts:70` 的文案是 `unit: "次/分钟"`。作者约束也明确把 `perMinute` 当“个数”。
- 建议: 这是设计风险而非已证实的显示错误（仓库里还没有消费该字段的手机设置页代码）。若要彻底避免，给这类速率单独的 `storageUnit`（如 `countPerMinute`）或额外 `period`/`scale` 字段；若维持 `count`，应在契约或文档里明确客户端必须结合 `unit` 文案显示分母，并用测试锁住。

**读代码证实的**

- 两个值映射本身完整：`THINK_SETTING_UNIT_VALUE` 覆盖 `THINK_SETTING_UNITS` 的 8 个值（`production-think-settings.ts:156-165`），`DELIVERY_TIMING_VALUE` 覆盖 `DeliveryTimingConfiguration` 的全部 12 个 key（`delivery-timing-copy.ts:231-244`）。
- 服务器实际产生的取值都能通过合约枚举：`think` 只产生 `permille/count/h/min/s/d`，`delivery` 只产生 `permille/ms/s/count`；`contracts-v2.ts:560-561` 的枚举包含这些值，`contracts-v2.ts:571-572`、`903-904` 两处都使用该枚举。
- 夹具和集成测试同步了字段：`gateway-v2.fixture.ts:453-454`、`658-659`；送达时机测试逐项核对全部 12 个 key（`production-delivery-timing-control.test.ts:137-165`），想一想测试按 unit 逐项核对全部 11 项（`think-settings.test.ts:250-264`）。
- `172c` 的增量只是把测试里的快照类型补上 `unit/kind/storageUnit`，修复了 `841f2ac` 引入的类型检查失败；该增量没有产生新的运行时值，也没有发现新错。

**推测**

- `perMinute` 的量纲问题是否真的造成手机显示成“30 个”而不是“30 次/分钟”，取决于尚未实现的客户端；仓库里 Apple 侧只有操作能力清单，没有读取这些快照字段的代码，因此未核实。

**侧重检查**

- 错误路径、不合规输入：新增字段都是服务器根据固定 key/unit 生成的只读元数据；`think.settings.change` 和 `delivery_timing.settings.change` 仍只接收原来的 `key/value/expectedRevision`，没有把客户端传来的 `kind/storageUnit` 写入存储。`DELIVERY_TIMING_KEYS`、`THINK_SETTING_DEFINITIONS` 都是固定清单，映射查表不会接受用户输入。
- 安全：没有新增秘密、日志、网络调用或权限判断；快照仍是原有的设置查询路径。
- 资源耗尽：只增加固定大小的映射，循环上限仍是 11/12 项，没有新增无界遍历。
- 不可撤销操作：本次没有。
- 规则和文档一致性：`prompt-prefix.md` 相关规则未受影响；想一想架构文档已补字段，送达时机的 ADR 仍不一致（见意见 1）。
- 增量范围：`172c` 只改测试类型；`841f2ac` 的测试和文档修改看起来覆盖了“逐项核对”和“反向非法值”这两个方向，但上一轮意见记录不可读，无法逐条确认还有没有未带入的意见。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。这个改动只改 gateway v2 的设置快照，没有碰系统提示、工具定义、历史消息或遮盖逻辑。按 `prompt-prefix.md:36` 的规则，已发内容只能追加；按 `:27-28`，会变的值只能放最后一条消息。新字段没有进入模型请求路径：`ThinkSettingView` 只在 `production-think-settings.ts` 和测试中出现，`DELIVERY_TIMING_VALUE` 只在 `production-delivery-timing-control.ts` 中使用。发给模型的内容仍然只追加，没有新增每轮变化的值放进请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？** 新增字段不会。两个映射是静态对象，顺序由 `THINK_SETTING_DEFINITIONS` 和 `DELIVERY_TIMING_KEYS` 固定；`kind/storageUnit` 不依赖前后文、时间或请求语言。原有 `generatedAt` 仍是每次请求变化的时钟值，但它在快照里本来就有，不是这次新增，也不进入模型请求；送达时机的 `label/unit` 仍随请求的 `locale` 变化，这是原有行为。没有新的无序集合或遮盖依赖。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`think-settings.test.ts:265-269` 把 `kind` 改成 `"percent"`、`storageUnit` 改成 `"seconds"`，然后期望 `gatewayV2MessageSchema.parse` 抛错；合约用的是 `enumeration(["ratio","duration","count"])` 和 `enumeration(["permille","ms","s","min","h","d","count"])`，如果枚举被放宽到接受这些值，这个期望抛错的用例就会失败。送达时机没有单独写非法值反向用例，但它和想一想共用同一组 schema 枚举，且 `production-delivery-timing-control.test.ts:137-165` 逐项解析真实快照；映射若产生非法值，解析就会失败。未实际运行测试，以上是代码层面的判断。

4. **每个值的使用端都能接受吗？逐个核对。** 产生处是 `production-think-settings.ts:238-239` 和 `production-delivery-timing-control.ts:65-66`；使用端是 `contracts-v2.ts:571-572`、`903-904` 的校验、`gateway-v2.fixture.ts:453-454`、`658-659`、两份集成测试，以及 `ThinkSettingView` 的读取方。所有服务器产生的值都在合约枚举内，类型定义也覆盖了各自可能产生的值；`ThinkSettingView` 没有其他构造方。未发现产生端和校验端不一致。真正的手机设置页不在当前仓库实现范围内（Apple 侧仅有 `clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:116,123` 的操作清单），所以手机能否正确格式化显示未核实。
