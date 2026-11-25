## 复核结论

本轮增量（`f789146..e70f4c5`）只改了 `apps/control-center/src/thread-control-center.tsx`（12 行）和 `apps/control-center/test/thread-interactions.unit.test.ts`（新增 55 行），另外 4 个是复核记录文件。上一轮两条“会出错”意见都已修好；增量没有发现新的中/高严重度问题，只有一条低严重度的时序残留。

### 1. 低 · `setMainLookupSettled(false)` 放在 `useEffect` 里，依赖变化后的第一次渲染仍会先显示输入框，可能丢焦点

文件: `apps/control-center/src/thread-control-center.tsx:352-385`、`:1838-1839`

问题：重查主对话的“未定”状态是在 `useEffect` 里才重置的，而该 effect 在 commit 之后才跑。依赖（`client`/`configuration`/`active`）变化的当次渲染仍用旧的 `mainLookupSettled === true` 计算 `openingMain`；如果上一次查到失败（`mainThreadId` 为 null），这一次渲染会先把输入框渲染出来，随后 effect 才置 false 并再次渲染把它藏掉。也就是说第 4 轮意见 2 的“输入框提前出现”只被缩到一个 render 的窗口，并未在同一 render 内消除；若输入框当时正被聚焦，随后会被卸载而丢焦点。

读代码证实的：
```tsx
351: const [mainLookupSettled, setMainLookupSettled] = useState(false);
352: useEffect(() => {
353:   if (!active || !client || !configuration) return;
354:   setMainLookupSettled(false);
...
380: const openingMain =
381:   !selectedThreadId &&
382:   !page &&
383:   !route.status &&
384:   Boolean(client && configuration) &&
385:   (!mainLookupSettled || mainThreadId !== null);
...
1838: {openingMain ? null : (
1839:   <ChatComposer
```
`useEffect` 本身保证在 paint 之后执行，所以依赖变化的首次渲染一定用的是旧 state。

推测：真实用户要在一个 render 内点进输入框才会看到闪烁；要丢焦点还需要恰好在输入时发生 `client`/`configuration` 重建（生产里 `configuration`、`client` 都是 `useState`，不常变）。影响低。

建议：不要把“这次查的是不是已经落定”做成事后重置的 state，而是同步派生。例如以 `client`/`configuration` 的身份或一个自增的 lookup key 记录“已查完的是哪个 key”，渲染时用 `settledKey !== lookupKey` 直接当作未定；effect 的 finally 再把 `settledKey` 设为当前 key。这样依赖一变，本次渲染就会藏起输入框，不会有一帧窗口。注意保留 `!disposed` 的迟到回答保护。

---

## 上一轮意见核对

- **意见 1（中高，发送仍会无超时地查主对话）已改好。** 发送路径的主对话查询现在带 `AbortController` 和 `READ_DEADLINE_MILLISECONDS`（`thread-control-center.tsx:1231-1238`）；超时经 `catch` 走 `settleOutgoing(null)` 保留草稿，`finally` 释放 `submissionLock`（`:1266-1273`）。`gateway-client.ts:478-483` 确实把 `signal` 传给 `fetch`，超时能真正打断请求；`thread.main` 是只读查询，重试不会重放写入。新增 `[PR634-R4-1]`（测试文件 `:1995-2022`）覆盖“超时→报错、草稿保留、锁已释放可重试”。
- **意见 2（低，`mainLookupSettled` 不复位）已改好主体，但留有上面的低严重度窗口。** effect 现在在开始时置 `false`（`:354`），迟到回答也加了 `!disposed`（`:364`、`:372`），`[PR634-R4-2]`（测试文件 `:2023-2049`）覆盖“失败后重查→重查未答前不显示输入框，答完再跳主对话”。复位本身生效，问题是复位发生在 effect 阶段而不是依赖变化的同一 render。

## 作者说法核对

1. **基本属实。** 三个 `delivery_timing.settings.*` 从 `contracts-v2.ts`、`client-capabilities.ts`、Apple `ClientCapabilities.swift` 移除；iPhone 的 `.delivery` 调节页（`TuningModels.swift`、`TuningPages.swift`、`SettingsRootView.swift`、`ManageDemo.swift`）移除；`push.delivery-timing-question` 从提示词源和 manifest 移除；`WebPushStorePort.recordDeliveryTiming`、`deferredByTiming`、`TIMING_DEFER_REFS` 及相关存储操作删除；评测脚本/数据集/夹具删除；新迁移 `20261125010802_drop_delivery_timing_settings.sql` 删除该表。全仓 grep 未发现这些名字在代码里的残留消费者（只剩 ADR 0273 等历史文档）。
2. **属实。** `packages/application/src/ports/decision-ledger.ts:43`、`:77` 仍保留 `delivery_timing` 类别及四种结果，`contracts-v2.ts:2140` 仍列出该类别；只删除了写该记录的代码。
3. **属实。** `strict-configuration.ts:1874-1889` 把 `deliveryTiming` 放进 `RETIRED_RUN_POLICY_KEYS` 并写入 `retiredKeys`；`service-main.ts:906-912` 遍历 `retiredKeys` 写 `configuration.key_retired`；`startup-configuration.unit.test.ts:337-348` 验证接受并忽略。生产配置留着该键不会起不来。
4. **属实。** `mac-placement.ts:8` 新增 `MAC_PRESENCE_WINDOW_SECONDS = 300`（原 `DELIVERY_TIMING_DEFAULTS.macPresenceSeconds` 默认确为 300），`service-main.ts` 改用它；测试 `mac-presence-window.test.ts:21-23` 断言 `OwnerPresence.shortestServerWindow`（实际为 30）`<=` 该值。
5. **代码层面属实。** 删除推送时机判断后，`production-web-push.ts` 里 `decision.action === "deliver"` 直接放行；安静时段仍由 `PushGate` 处理。`push-channels.test.ts` 里“在看 App 时不发”的用例（`:694`）和“gate 延后/放行”的用例（`:1106`、`:1135`）仍在，只删了 timing 专属用例。未实际运行测试。
6. **净结果属实，但“main 新加”无法按此基准证实。** 以 011f 为基准读 `DemoScenes.swift`，`.her` 系列在基准文件里已经存在；增量只删掉了 `.notifications`/`.notificationsEdit` 并保留 `.her` 系列。最终结果与描述一致，只是“main 新加”在本基准上看不出来。

## 侧重检查

- **错误路径：** 发送时主查询超时 → `catch` 保留草稿、`mutationStatus` 置 rejected、`finally` 释放锁；超时是只读查询，不会留下服务端写入。已读代码证实（`thread-control-center.tsx:1226-1273`）。
- **不合规范/不可信输入：** 生产配置里遗留的 `runPolicy.deliveryTiming` 被接受并忽略（`strict-configuration.ts:1774` 白名单 + `:1874-1889`）；迁移清单 `alters/removes` 与 `scripts/migration-conflicts/analyze.mjs:224-258` 的校验口径一致（`removes: ["{}"]` 对应被删表 SQL 里的 `DEFAULT '{}'`）。已读代码证实。
- **安全/隐私：** 删掉的正是把主人感知状态发给外部判断模型的侧调用，同时从 `check-egress-redaction.mjs` 的允许出口和必须遮盖清单里移除；删除方向对隐私是收紧。已读代码证实。
- **资源耗尽：** 发送前的 `thread.main` 查询现在有 15 秒上限，`submissionLock` 在 `finally` 必然释放；`setMainLookupSettled(false)` 不会成为 effect 依赖，实测依赖 `client`/`configuration` 都是 `useState`，不会因 state 更新形成自激循环。已读代码证实（`app.tsx:191`、`:209`、`:304-309`）。
- **不可撤销操作：** 新迁移 `DROP TABLE delivery_timing_settings` 不可撤销，会丢弃主人改过的调节值；这是功能退役的有意代价，且没有动 `decision_ledger`/`decision_signals`/`web_push_feedback`，旧决策记录仍可读。回滚只能靠数据库恢复（通用风险，非本改动特有）。
- **规则/文档/代码一致性：** ADR 0273 已标 `superseded`，ADR 0285 标 `active`；spec/plan 已改成“不再产生、只读旧记录”；提示词 manifest 无悬挂条目；增量没加代码注释。已读代码证实。

## 必答问题

1. **请求开头是否变化：不涉及本轮增量。** 增量只改网页控制台的查询与渲染，不碰系统提示、工具定义、历史或遮盖。就整个 PR 而言，删除的 `push.delivery-timing-question` 是 `layer: "background"` 的独立侧调用提示词（`packages/prompt-catalog/src/perception.ts` 原 `usedBy` 指向已删除的 `delivery-timing-decision.ts`），不进入对话历史，也不参与冻结的对话系统提示/工具；已有对话的冻结开头不动，新对话也不含它。**未核实**固定文字遮盖清单的实现细节；推测其文字从未进入历史，故不会改变已发内容的遮盖字节。
2. **同一段文字是否会在不同请求里变成不同字节：不涉及。** 增量没有新的序列化格式、没有时间字段、没有集合顺序问题；被删掉的恰好是原来带 `nowMs`、按事实判断送货时机的侧调用。迁移和 Mac 在线窗口都是固定值。
3. **自动检查与反向用例：有，且按代码推断反向用例会失败。** 增量两条新用例在移除修复后必然失败：`R4-1` 若没有发送超时，`thread.main` 的 mock 永不 reject，`THREAD_READ_DEADLINE_EXCEEDED` 不会出现且 `mutate` 不会调用；`R4-2` 若没有 `setMainLookupSettled(false)`，重查未答时输入框仍在，`toBeNull()` 失败。整个 PR 还有 `startup-configuration.unit.test.ts:337-348`（退役键）、`mac-presence-window.test.ts:21-23`（窗口关系）和迁移冲突门禁。**未运行测试**，上述“会失败”是按测试与实现逻辑推断的，不是执行结果。另：本轮没有看到专门验证“旧 `delivery_timing` 决策记录仍能读出”的自动用例，这一点属**未核实**，不算错误。
4. **产生/修改的每个值与直接使用端：都能接受。**
   - `MAC_PRESENCE_WINDOW_SECONDS = 300`：产生于 `mac-placement.ts:8`，使用于 `service-main.ts` 的 `windowMilliseconds` 和 `test/tooling/mac-presence-window.test.ts:5,22`；测试用 `<=` 接受。
   - `retiredKeys` 值 `"deliveryTiming"`：产生于 `strict-configuration.ts:1881-1889`，使用于 `service-main.ts:907-912`（拼成 `runPolicy.deliveryTiming`）和 `startup-configuration.unit.test.ts:347`；两端接受。
   - 被删的 `delivery_timing.settings.*`：生产端已无注册，消费端（contracts、client capabilities、Apple 生成文件、演示数据）同步删除；全仓 grep 无代码残留。
   - `deferredByTiming`/`recordDeliveryTiming`/`TIMING_DEFER_REFS`：从 port、durable 适配器、SQLite web/apple push 操作中成对删除，全仓 grep 无残留。
   - 决策类别 `delivery_timing`：保留在 `decision-ledger.ts:43,77` 与 `contracts-v2.ts:2140`，只删写入路径，旧记录读取端可接受。
   - 迁移清单 `alters: ["delivery_timing_settings"]`、`removes: ["{}"]`：由 `aligns` 分析器消费，`removes` 与老迁移里 `DEFAULT '{}'` 的字面量相符。
   - 本轮增量的值：没有新增导出函数、配置键、字段或序列化格式；只是复用了 `READ_DEADLINE_EXCEEDED`，其 `message` 最终进入 `<code>{error}</code>`（`thread-control-center.tsx:1478-1480`），显示端接受任意字符串。

## 本轮查过的范围

- 精读增量两个代码文件及对应 diff：`thread-control-center.tsx`、`thread-interactions.unit.test.ts`。
- 为核对上一轮意见，跟进读了 `gateway-client.ts` 的 `queryThread/request`、`messages.ts` 的 `threadQueryMessage`、`app.tsx` 的 `client/configuration` 来源。
- 为核对作者说法，读了整份 PR 的关键 diff 与当前代码：`strict-configuration.ts`、`service-main.ts`、`production-web-push.ts`、`production-approval-gateway.ts`、`production-http-composition.ts`、`contracts-v2.ts`、`client-capabilities.ts`、`decision-ledger.ts`、`mac-placement.ts`、`startup-configuration.unit.test.ts`、`mac-presence-window.test.ts`、`push-channels.test.ts`、SQLite web/apple push 操作与新迁移及 `meta.json`、`scripts/migration-conflicts/analyze.mjs`、`DemoScenes.swift`、Apple `Tuning*`/`SettingsRootView`/`OwnerPresence.swift`、ADR 0273/0285。
- 未重读的旧代码：`delivery-timing.ts` 等已删除文件只看了基准版本以确认默认值；未运行任何测试、构建或迁移；未阅读本轮以外的全部 PR 文件。
