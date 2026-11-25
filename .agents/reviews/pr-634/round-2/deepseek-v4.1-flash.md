本轮检查过的范围：`cf81398..eb5d3d1` 的增量（`ManageStrings.swift`、苹果设备设计文档、评审记录）、上一轮两条意见对应的代码与文档，以及增量/基线改动产生的值及其直接使用端：`M.notificationsTitle`、`deliveryGroup`、`TuningKind.delivery`、demo 场景 ID、`runPolicy.deliveryTiming` 退役键、`MAC_PRESENCE_WINDOW_SECONDS`、新迁移元数据、`delivery_timing` 决策种类、三个被删的网关操作。结论：上一轮意见 1 已修好；意见 2 只修好了第 1095 行，第 909 行仍有残留。未发现新的代码级错误。

### 1. 低：设计文档仍把已废弃的 `delivery-timing.test.ts` 列为待建测试
`docs/execution/specs/2026-11-11-apple-device-body-design.md:909`
问题：上一轮意见 2 说“引用已删除的测试”，作者只改了第 1095 行；第 909 行仍把 `delivery-timing.test.ts` 列在“到 2026-11-25 还没有建”的五个文件里，并要求后续 PR“要么建这个文件”。ADR 0285 已删除送达时机判断，这个测试不该再建。
证据（读代码证实）：第 909 行原文含“`test/integration/device-limits.test.ts`、`device-connection.test.ts`、`perception-deletion.test.ts`、`perception-origin-gate.test.ts`、`delivery-timing.test.ts` 这五个文件还没有建……要么建这个文件”。同时 `test/integration/delivery-timing*.test.ts` 不存在，新的验收行（第 1095 行）已改指向 `packages/application/test/web-push-gate.unit.test.ts` 和 `test/integration/push-channels.test.ts`。
建议：把 `delivery-timing.test.ts` 从清单删掉，把“五个文件”改成“四个文件”，或明确写“送达时机的用例已按 ADR 0285 删除，不再建”。

### 2. 低：设计文档的新值表仍说 `delivery_timing` 由“各自的服务”产生
`docs/execution/specs/2026-11-11-apple-device-body-design.md:929`
问题：表里仍写决策记录新类别 `delivery_timing` 的产生处是“各自的服务”，但本 PR 已删掉写这种记录的唯一代码；现在只剩旧记录可读。
证据（读代码证实）：`packages/application/src/ports/decision-ledger.ts:43` 和 `:77` 仍登记 `delivery_timing` 种类与结果，`packages/gateway-contracts/src/contracts-v2.ts:2140`、控制中心翻译、`daily-review.ts` 仍认识它；但 `recordDeliveryTiming`、`TIMING_DEFER_REFS`、`deferredByTiming` 已全仓无引用（grep 无结果），`apps/agent-service/src/production-web-push.ts` 也不再写这类记录。
建议：把“产生处”改成“不再产生，只保留读取/导出旧记录”，避免后续实现误以为还要写这种记录。

### 3. 低：新验收行把“正在看 Himawari 时不弹推送”归到 ADR 0285 决定第 4 条，来源不准
`docs/execution/specs/2026-11-11-apple-device-body-design.md:1095`
问题：第 4 条讲的是删掉替主人做决定的小判断（含 ADR 0273 的推送延后判断），“正在看 App 不弹”在 ADR 0285 里是决定第 6 条；代码里的服务器端抑制另有来源。
证据（读代码证实）：`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:38`（决定 4）只说删推送延后判断、程序按安静时段延后；`:40`（决定 6）才写“Andy 正在 App 里看主对话时由 App 不弹出”。`test/integration/push-channels.test.ts:694` 仍验证“Himawari 在屏幕上时不发送”，说明行为还在。
建议：来源改成“ADR 0285 决定第 4、6 条”，或把“正在看 App 不弹”单独指向 ADR 0229 决定第 5 条 / ADR 0089 决定第 4 条。此条的“来源归属错误”含推断成分，但两段 ADR 原文是直接读到的。

**侧重检查**

- 错误路径与退役配置：`runPolicy.deliveryTiming` 仍在允许键里（`packages/platform-node/src/strict-configuration.ts:1774`），并由 `RETIRED_RUN_POLICY_KEYS`（`:1881-1888`）收进 `retiredKeys`；启动时 `apps/agent-service/src/service-main.ts:906-912` 写 `configuration.key_retired`。`packages/platform-node/test/startup-configuration.unit.test.ts:337-348` 覆盖“接受并忽略”。没有发现会让生产配置起不来的路径。
- 不可信输入/安全：本增量只加一个静态 Swift 字符串，没有引入外部输入、路径、密钥或新的网络出口。基线改动反而删除了 `push.delivery-timing-question` 这个 background 外部调用（`packages/prompt-catalog/src/perception.ts` 原 `layer: "background"`、`usedBy: delivery-timing-decision.ts`）及其 `redactForExternalText` 登记，减少外发面。
- 资源耗尽：Mac 在场窗口固定为 `apps/agent-service/src/mac-placement.ts:8` 的 300 秒，实际接入在 `apps/agent-service/src/service-main.ts:741`；`clients/apple/Sources/HimawariCore/OwnerPresence.swift:92` 假定 30 秒，`test/tooling/mac-presence-window.test.ts:22` 断言 30 ≤ 300。没有新增无界循环或队列。
- 不可撤销操作：新迁移 `packages/persistence-sqlite/src/migrations/20261125010802_drop_delivery_timing_settings.sql:1` 直接 `DROP TABLE delivery_timing_settings`，会不可恢复地删掉主人改过的送达时机值；这是 ADR 0285 和作者说法 1 明确要删的表，且未触碰被冻结的决策记录表。元数据 `alters: ["delivery_timing_settings"]`、`removes: ["{}"]` 与旧表 `DEFAULT '{}'` 及 `scripts/migration-conflicts/analyze.mjs` 的检查口径一致。
- 文档/规则一致性：除上面三条外，第 965 行“Mac 在场窗口固定 300 秒”与代码一致；第 1095 行引用的两个测试文件都存在；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:177` 的“配置和设置表已删除”与代码一致。
- Swift 编译路径：恢复的 `M.notificationsTitle`（`ManageStrings.swift:368`）与原删除行完全一致（`git diff 011f58..eb5d3` 对该文件只剩 `deliveryGroup` 被删）；两个使用点 `HerPage.swift:89`、`NotificationsPage.swift:13` 都按 `String` 使用；`deliveryGroup`、`TuningKind.delivery`、`19-settings-more-4-notifications` 已无引用。

**必答问题**

1. **会不会改变模型已见过的请求开头？** 本增量（Swift 字符串 + 文档）不涉及，不改任何发给模型的内容。基线改动里删掉的 `push.delivery-timing-question` 是独立的 background 判断调用，不在主对话系统提示、工具定义或历史消息里；我没有发现它改变主请求前缀。主提示装配本身这轮未重读，标“未核实”。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。增量是静态常量；基线改动只是删除依赖外部遮罩的送达判断和相应外发，不会引入依赖前后文的遮盖、时间字段或无序集合。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 增量修复的编译问题由现有 Apple CI 覆盖：`.github/workflows/apple.yml:32-42` 在 macOS 上跑 `swift test` 并 `xcodebuild build`，`HimawariManage` 是被编译和测试的目标，缺 `M.notificationsTitle` 会失败。仓库没有专门的“`M.*` 引用必须有定义”静态检查，也没有文档测试路径检查，所以第 909 行的残留不会被自动抓到。反向用例方面：安静时段的 `REVERSE` 用例存在（`packages/application/test/web-push-gate.unit.test.ts:99-112`），正在看 App 的抑制用例存在（`test/integration/push-channels.test.ts:694-707`）；但没有一条反向用例专门断言“不再按主人状态延后”，若以后有人重新引入这类延后，现有用例未必会失败。测试未实际运行（本机无 Swift/未跑 vitest），标“未运行”。
4. **每个改动值的使用端都能接受吗？** 逐个核对过：`M.notificationsTitle` 的两个使用端都接受 `String`；`deliveryGroup`、`TuningKind.delivery`、旧 demo 场景 ID 已无使用端；`runPolicy.deliveryTiming` 的解析端接受并忽略、启动端能消费 `retiredKeys`；`MAC_PRESENCE_WINDOW_SECONDS` 被服务启动端和测试消费；新迁移的 `alters`/`removes` 符合迁移分析器；`delivery_timing` 决策种类仍被类型、契约、翻译和旧记录读取端接受；三个被删网关操作在契约、能力表和 Swift 生成清单中均已移除且无残留引用。没有发现两端校验不一致。
