### 1. 高：删掉 `M.notificationsTitle` 会让苹果端编译失败

**文件:行**：`clients/apple/Sources/HimawariManage/ManageStrings.swift:367-368`（删除处）、`clients/apple/Sources/HimawariManage/HerPage.swift:89`、`clients/apple/Sources/HimawariManage/Settings/NotificationsPage.swift:13`

**问题**：本 PR 删除了 `M.notificationsTitle`，但合并进来的 main 的 `.her` 系列仍在同一模块里引用它。`HerPage.swift` 和 `NotificationsPage.swift` 都没有被删除，也没有改成别的文案，因此 Swift 编译会报“找不到 `M.notificationsTitle`”。这与作者说法 6“保留 main 新加的 .her 系列场景”直接矛盾：场景保留了，但它依赖的文案被删了。

**证据**（已读代码证实）：
- `HerPage.swift:89`：
  `HerRow(icon: .bell, title: M.notificationsTitle, subtitle: M.quietSummary(hours))`
- `NotificationsPage.swift:13`：
  `SheetHeader(title: M.notificationsTitle, leading: .back, action: back)`
- `ManageStrings.swift:367-368` 当前直接从 `off` 跳到 `thinkTitle`，`git diff` 显示删除的是：
  `-    static var notificationsTitle: String { ... }`
- `ManageDemo.swift:86-87` 也保留了 `.herNotifications` 场景并进入 `her([.notifications])`。

**建议**：保留 `notificationsTitle` 定义，只删除确实不再使用的 `deliveryGroup`。如果目标是彻底删除该页面，就必须同时删除 `HerPage` 的 `.notifications` 分支、`NotificationsPage`、`ManageDemo` 的 `.herNotifications`，但这与“保留 .her 系列”的目标冲突，不应这样做。

### 2. 低：设计文档仍说送达时机窗口“可配置”，并引用已删除的测试

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:615`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:1095`

**问题**：代码已经把 `macPresenceSeconds` 改成固定 `MAC_PRESENCE_WINDOW_SECONDS = 300`，并删除了送达时机设置表和配置解析；但设计文档仍写“多久算过期（默认，可配置）”，验收表仍指向已删除、且从未建立的 `test/integration/delivery-timing.test.ts`。这会让后续实现误以为这些值还有配置入口。

**证据**（已读代码证实）：
- `docs/execution/specs/2026-11-11-apple-device-body-design.md:615`：
  `| 状态 | 从哪来 | 多久算过期（默认，可配置） |`
- `docs/execution/specs/2026-11-11-apple-device-body-design.md:1095`：
  `| 送达时机：... | test/integration/delivery-timing.test.ts | 第 2 层 |`
- 代码侧 `apps/agent-service/src/mac-placement.ts:8`：`export const MAC_PRESENCE_WINDOW_SECONDS = 300;`

**建议**：把该节改成固定值，或明确标注“已被 ADR 0285 取代，仅保留历史设计”；把已删除的测试引用改成实际存在或计划新建的测试文件。

### 3. 低：退役键只测了解析，没测启动日志和真实启动

**文件:行**：`packages/platform-node/test/startup-configuration.unit.test.ts:337-349`、`apps/agent-service/src/service-main.ts:907-912`

**问题**：新用例只调用 `parseProductConfiguration`，验证 `deliveryTiming` 被忽略并出现在 `retiredKeys`；作者说法 3 的“启动时写 `configuration.key_retired`”没有任何自动检查。如果日志循环、事件名或 `writeServiceDiagnostic` 出错，测试不会失败；也没有反向用例确认没有退役键时不会写这条日志。

**证据**（已读代码证实）：
- 测试只断言：
  `expect(policy?.retiredKeys).toEqual(["deliveryTiming"]);`
  `expect(policy && "deliveryTiming" in policy).toBe(false);`
- `service-main.ts:907-912`：
  `for (const key of configuration.runPolicy?.retiredKeys ?? [])`
  `writeServiceDiagnostic(errorOutput, {`
  `component: "agent-service",`
  `event: "configuration.key_retired",`
  `key: \`runPolicy.${key}\`,`
  `});`

**建议**：补一条启动/组合层用例，带旧配置启动成功并断言写出 `configuration.key_retired`；再补一条不带旧键时不写该日志的反向用例。

**读代码证实的**：
- `deliveryTiming` 已从 `RunPolicyConfiguration` 和解析器删除，但允许列表仍接受该键，并转成 `retiredKeys`。
- 删除的 `delivery_timing.settings.read/snapshot/change` 已同步从 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、网关 fixture、客户端能力表和生成的 Swift 能力表中移除。
- `push.delivery-timing-question` 已从 `prompt-catalog` 和清单移除，`DELIVERY_TIMING_QUESTION` 不再被引用。
- 推送闸门中安静时段延后仍在 `web-push-gate.ts`，`production-web-push.ts` 中“正在看 App 就不发”的 `visible` 判断仍在。
- 新迁移只 `DROP TABLE delivery_timing_settings`，没有改 `decision_ledger`、`decision_signals`、`web_push_feedback`；`schemaCatalog` 对应条目已删。
- 全局搜索未发现删除符号的残留代码引用。

**推测/未核实**：
- 没有运行 Swift 编译或任何测试；“编译失败”是根据源码中的符号引用推断的，但引用关系确定。
- 没有运行 `check:migration-conflicts`；从 `20261115031100_delivery_timing_settings.sql` 的 `DEFAULT '{}'` 看，`meta.json` 的 `"removes": ["{}"]` 应该能对上，但未实测。
- 没有验证旧版本回滚到已删表后的启动行为；迁移删表是不可逆的数据删除，回滚风险未核实。
- 没有验证旧客户端继续发送被删除的 `delivery_timing.*` 网关消息时会得到什么错误。

**侧重检查**：
- 配置错误路径：检查了 `strict-configuration.ts` 的 `parseRunPolicy` 和 `service-main.ts` 的启动日志。旧 `deliveryTiming` 对象整体被忽略，不会因为内部字段非法导致启动失败；但值完全不校验，属于有意的“接受并忽略”。
- 迁移与不可逆操作：检查了迁移 SQL、meta、`schema-catalog`、`sqlite-durable-operations`。除新迁移外没有代码再引用该表；删表会永久丢弃主人已存的送达时机设置，且不支持回滚恢复，属于已声明的产品取舍。
- 不可信输入/资源耗尽：删除送达时机判断同时删掉了后台模型调用、预算预留和每分钟限流，减少了外部调用和费用路径；没有新增解析不受信输入或新增外部请求的代码。
- 安全/遮盖：`delivery-timing-decision.ts` 从出口遮盖允许清单移除，因为文件已删除；删除的提示词文字不含数字或明显秘密模式，且不在对话历史中，理论上不会改变旧对话的遮盖字节。
- 文档一致性：计划文档已更新；ADR 0273 作为历史记录保留可以接受；但苹果端设计文档仍有“可配置”和已删测试的残留，见意见 2。

**必答问题**：

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 删除的是一次独立的后台“送达时机”模型调用及其提示词，不修改系统提示、工具定义、对话历史或追加内容的位置。`production-run-policy.ts:102-117` 的会话系统提示哈希只使用 `policy.systemInstruction`，不使用被删除的 `deliveryTiming` 或新增的 `retiredKeys`。发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息/工具结果里。删除提示词清单会影响出口遮盖的固定文字集合，但被删提示词不含秘密样式内容，也没有进入对话历史，因此没有发现会导致旧请求开头变化的路径。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有发现新引入的依赖前后文的遮盖、带时间的字段或无序列集合。固定 `MAC_PRESENCE_WINDOW_SECONDS = 300` 是常量；`retiredRunPolicyKeys` 按固定顺序过滤固定数组；迁移是静态 SQL。删除送达时机判断反而移除了按当下感知事实生成的模型输入。唯一的理论风险是提示词清单变化对出口遮盖的影响，但被删文字不含敏感数字，且不进入聊天历史，未发现实际影响。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   部分有：退役键有解析测试；Mac 在场窗口测试改成“App 假定窗口 ≤ 服务端窗口”，并在第一条测试里真正绑定 `MAC_PRESENCE_WINDOW_SECONDS`；推送“正在看 App 不发”仍有 `push-channels.test.ts:694` 的用例。缺口是：退役键的 `configuration.key_retired` 启动日志没有测试；迁移删表、旧配置真实启动、旧客户端调用被删除网关操作都没有反向用例。原送达时机的所有正反向用例随功能一起删除，这是合理的，但也就没有“确认不再被延后”的替代用例。未实际运行测试，所以不能断言这些反向用例在当前树上一定失败或通过。

4. **每个新值/被改值的所有使用方都能接受吗？**
   - `MAC_PRESENCE_WINDOW_SECONDS = 300`：产生于 `mac-placement.ts`，被 `service-main.ts:741` 乘以 1000 后传给 `MacPlacement.windowMilliseconds`，`DevicePresence.recent` 接受毫秒数；测试也使用它，没有发现不接受的消费方。
   - `retiredKeys`/`runPolicy.deliveryTiming`：产生于 `strict-configuration.ts`，被 `service-main.ts` 转成日志键 `runPolicy.deliveryTiming`；`RunPolicyConfiguration` 已有该可选字段，没有其他消费方依赖它。
   - 迁移删除 `delivery_timing_settings`：`schemaCatalog`、仓储端口、SQLite 操作类、网关控制、客户端能力表都已同步删除；全局搜索未发现其他使用方。
   - `delivery_timing` 决策记录种类：仍保留在 `DECISION_KINDS`、`DECISION_OUTCOMES`、控制中心 i18n 和 `daily-review.ts` 中，旧记录仍可读；只删除了写入代码。
   - 唯一明确不通过的是 Swift 文案符号 `M.notificationsTitle`：删除后仍有两个使用方，见意见 1。
