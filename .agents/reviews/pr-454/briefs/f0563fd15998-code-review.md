# PR 454 第 2 轮：对第 1 轮修改的复核

问题、目标、约束同第 1 轮材料（`.agents/reviews/pr-454/briefs/b2a560461af4-code-review.md`）。这一轮请先看 `b2a560461` 之后的增量。

## 作者的说法（请核对，不要直接采信）

1. `deviceActionFingerprint` 现在把列表参数排序后再算；同一组列表值不论顺序，指纹相同。校验后的参数本身仍保留原顺序，交给设备和显示给主人的不变。
2. `DeviceActionService.request` 在登记查找、参数校验、目标解析之前，先用 `readInvocation` 按 `run_id` 加 `tool_call_id` 查原记录，有就直接返回它的结果。
3. `store.insert`、`store.report` 抛错时，刚保存的参数或结果载荷会被删掉；没有抛错的路径行为不变。
4. `DEVICE_ACTION_TRANSITIONS`、`deviceActionTransitionAllowed` 已删除，仓库里没有别处引用；状态转换只由 `sqlite-device-action-operations.ts` 里各条 SQL 的 `WHERE state` 条件决定。第 1 轮材料的说法 3 里“按 `DEVICE_ACTION_TRANSITIONS` 走”作废。
5. 调用登记表外的动作名时，`availableActions` 只列设备支持且设备策略没关掉的动作。

## 第 1 轮判为不成立、这一轮不必重提的

终态动作的保留期（列给 Andy 定，不在本 PR）；策略变更不能收回已送达的动作（设备端复查是第 9B 批）。理由见 `.agents/reviews/pr-454/round-1/judgments.md`。
