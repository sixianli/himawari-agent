### 1. 中 · 主对话查询超时后回到的输入框，发送时仍会无超时地查主对话，可能永远停在“发送中”

文件:行：`apps/control-center/src/thread-control-center.tsx:356-359`、`1190`、`1206-1209`、`1228-1232`、`1265-1266`

问题：本次改动给首次 `thread.main` 查询加了 15 秒超时，超时后输入框确实会回来；但用户随后点发送时，`submitDraft` 又直接调用一次 `thread.main`，没有传 `AbortSignal`，也没有复用这个 deadline。如果服务端仍处于“查主对话不返回”的状态，这次提交会永远不 settle：`submissionLock` 一直是 `true`、`mutationStatus` 一直是 `pending`，界面上的发出消息也一直不算失败，用户不能重试。这正好是本次修复让用户重新到达的路径。

证据（读代码证实）：

```ts
// 352-359：首次查询有 15 秒 deadline
const controller = new AbortController();
...
const deadline = window.setTimeout(
  () => controller.abort(READ_DEADLINE_EXCEEDED),
  READ_DEADLINE_MILLISECONDS,
);

// 1190：提交开始就上锁
submissionLock.current = true;

// 1206-1209：发送时先把输入框清空（origin 为 null 时不写 storage）
if (!pendingSubmission) {
  setDraft("");
  if (origin) storage.saveDraft(draftKey, "");
}

// 1228-1232：这里的 thread.main 没有 signal/deadline
if (!origin) {
  setMutationStatus("pending");
  const snapshot = await client.queryThread(
    threadQueryMessage(configuration, "thread.main", {}),
  );

// 1265-1266：只有这一句 await 真正结束才会解锁
} finally {
  submissionLock.current = false;
}
```

`gateway-client.ts:472-484` 确认 `queryThread` 只有传入 `signal` 才会中止请求，而这里没有传。

推测：服务端在 15 秒后仍然不返回，提交时的同一查询也会不返回。这个后果是我按代码推出来的，没有运行测试验证。

建议：把首次查询的 deadline/AbortController 抽成同一套有界读取，`submitDraft` 查 `thread.main` 也使用它；超时或中止时恢复 `submissionLock`、清掉 `mutationStatus`、保留草稿并显示错误。补一条“首次查询超时 → 发送 → 发送查询也不返回”的自动化用例。

### 2. 低 · `mainLookupSettled` 一旦置真就不复位，effect 重跑时输入框会提前出现，主对话返回后仍会被换掉

文件:行：`apps/control-center/src/thread-control-center.tsx:350-351`、`371`、`379-384`、`1764`、`1832-1835`

问题：`mainLookupSettled` 只会在 `.finally` 里置 `true`，代码里没有任何地方把它重置为 `false`。如果第一次主对话查询失败/超时（`settled = true`、`mainThreadId = null`），之后因为 `active`、`client`、`configuration` 或 `onUnauthorized` 变化让 effect 重跑，新的查询还没回来时 `openingMain` 就已经是 `false`，输入框会提前显示；一旦新查询成功，`mainThreadId` 被设置，导航到主对话后 `ChatComposer` 的 key 从 `composer:new` 变成 `composer:thread-main`，输入框仍会被换掉、丢焦点。这正是第 3 轮想避免的那类问题，只是触发条件更窄。

证据（读代码证实）：

```ts
// 350-351：状态只初始化一次
const [mainThreadId, setMainThreadId] = useState<string | null>(null);
const [mainLookupSettled, setMainLookupSettled] = useState(false);
...
// 371：只会置真
if (!disposed) setMainLookupSettled(true);
...
// 379-384：settled 为真且 mainThreadId 为 null 时 openingMain 为 false
const openingMain =
  !selectedThreadId &&
  !page &&
  !route.status &&
  Boolean(client && configuration) &&
  (!mainLookupSettled || mainThreadId !== null);

// 1832-1835：openingMain 为 false 就渲染输入框，key 随 thread 变化
{openingMain ? null : (
  <ChatComposer
    key={`composer:${selectedThreadId ?? "new"}`}
```

推测：只有“先失败、再重跑 effect、第二次成功”的组合才会发生；是否常见取决于外层是否在重连/重新认证时换 `client` 或 `configuration`，我没有在仓库里找到它会换的证据。

建议：在新的查询开始时把本轮状态重置为“未完成”（例如 effect 开头 `setMainLookupSettled(false)`，或用一个按查询轮次递增的 pending 标记），让 `openingMain` 在第二次查询返回前继续遮住输入框；补一条“第一次失败、换 client 后第二次成功”的测试。另外 `.then` 里也没有检查 `disposed`，晚到的成功响应仍会写 `mainThreadId`，建议一并加上守卫。

**侧重检查**

查过并给出结论的路径：

- 主对话查询的超时、abort、401、卸载/依赖变化的清理：deadline 在 `finally` 和 cleanup 都会 `clearTimeout`，超时会进 `finally` 并置 `mainLookupSettled`；`disposed` 只挡住 `finally`，没挡 `.then`。
- 超时后的发送路径：见意见 1，`submissionLock`、草稿、重试都没有兜底超时。
- `openingMain` 与 `route.status`/`route.page`：`page` 来自 `route.page`（`settings` 被映射为 `null`），设置页由导航 effect 的 `route.page` 守卫拦住；查询失败/超时后 `openingMain` 变假，输入框回来；看代码未发现新的永久骨架屏路径。
- TalkAudio 的 AVFoundation 顺序：`setCategory → setAllowHaptics… → setActive` 正确（`TalkAudio.swift:22-24`）；新增行在 `setActive` 之前，不新增“激活后抛错导致会话不释放”的路径（`ChatTalkSession.begin` 在 `start()` 抛错时不会调用 `audio.stop()`，但这是既有问题）。
- `ios-audio-session-haptics.test.ts` 的新检查按文件全局 `lastIndexOf` 找 allow/category，跨函数时会偏宽松；对当前两个文件是有效的，去掉新增行会失败。
- 文档与代码一致性：`docs/incidents-and-gates.md` 引用的 `8183acf8d` 存在，内容与分支上的 `a9699f3cc` 相同；全仓 `setActive(true` 确实只有 `AudioCapture.swift` 和 `TalkAudio.swift`；设计文档第 10 节已经改成 ADR 0285 的说法；`macPresenceSeconds` 只剩历史 ADR 文本。
- 不可撤销操作：迁移 `DROP TABLE delivery_timing_settings` 会丢掉主人改过的送达时机设置，这是作者明确声明的功能删除的一部分；决策记录 kind/outcome 仍保留，未发现额外数据被删。
- 未核实：没有运行任何测试，也没有真机验证触感；只按源码和测试源码推理。

**必答问题**

1. 本次增量（`80df1d18b`、`a9699f3cc`、`dd195b674`，以及合并 `8b6b962f2` 带来的 PR 636 测试改动）都不组装模型请求，不改变系统提示、工具定义、历史或遮盖，所以不涉及“发给模型的内容只追加”。对基础 PR 634，我顺带核对了删掉的 `push.delivery-timing-question`：它是 `layer: "background"`，只被已删除的 `delivery-timing-decision.ts` 使用，不在对话冻结的系统提示/工具里；删除它不会改变任何已发对话请求的开头，也没有把每轮会变的值放进请求头。
2. 增量不会让同一段文字在不同请求里变成不同字节：UI、音频会话和文档都不参与模型请求序列化。基础 PR 的改动也是确定性的（`MAC_PRESENCE_WINDOW_SECONDS = 300` 是常量、`RETIRED_RUN_POLICY_KEYS` 顺序固定、迁移是静态 SQL），没有引入依赖前后文的遮盖、时间字段或无序集合。
3. 有对应检查：`thread-interactions.unit.test.ts:1965-1983` 的 `[PR634-R3-1]` 覆盖 `thread.main` 永不返回时 15 秒后输入框回来（去掉 deadline 时该断言会失败，按代码推理）；`1984-1994` 的 `[PR634-R3-3]` 覆盖设置页不自动跳主对话；`test/tooling/ios-audio-session-haptics.test.ts:36-61` 覆盖每一处 `setActive(true` 前必须有 allow（去掉 `TalkAudio.swift:23` 时 `allow = -1 > category` 不成立，测试失败）。这些测试分别属于 CI 的 unit 和 tooling 作业（`ci/policy.json` 的 include 与 `.github/workflows/ci.yml` 对应）。意见 1 的“超时后发送”没有自动检查；我未实际运行测试。
4. 增量没有新增导出函数、配置键、字段或序列化格式，只有测试名和复用的 `READ_DEADLINE_MILLISECONDS`/`READ_DEADLINE_EXCEEDED`（使用端就是同一个 `AbortController`）。基础 PR 里我逐个核对了值/使用端：`MAC_PRESENCE_WINDOW_SECONDS`（`mac-placement.ts:8` → `service-main.ts:120,741` 乘 1000 → `mac-placement.ts:44`；测试接受 number）；`retiredKeys`（`strict-configuration.ts:1881-1887` → `service-main.ts:907-912` 写 `configuration.key_retired` → 启动配置测试）；`delivery_timing` 决策种类（`decision-ledger.ts:43,77`、`contracts-v2.ts:2140`、`daily-review.ts:370`，旧记录仍可读）；迁移 meta 的 `"removes": ["{}"]`（对应被删表 `CREATE TABLE` 里的 `DEFAULT '{}'`，`scripts/migration-conflicts/analyze.mjs:224-258` 能接受）；`delivery_timing_settings` 没有残留消费者；`defer_rule_refs` 列仍在但新代码不读，旧的 `["delivery_timing"]` 值不会再被解释。未发现两端校验不一致。
