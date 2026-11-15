# PR 543 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1【中低】`DeviceActionResolution.reasonCode` 仍被丢弃，审批阶段的所有拒绝都写成 `owner_denied`（上一轮意见 2 未修复）。沿用第 2 轮意见 2 的判断；device-action-service.ts:302-307 只传布尔值，sqlite-device-action-operations.ts:422-423 统一写 owner_denied；不影响是否放行；触发：批准后审批记录消失或来源不可用等异常路径；后果：动作被记成 owner_denied，原因标签不准，不影响放行与否；判低理由：第 1、2 轮已按同样理由判低，代码未变；只在异常路径触发且只是原因标签不准，修需新增 reason 码和文案，超出本 PR
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2【低】同幂等键的已完成回执重放仍不走 `onApprovalResolved`，新用例测的是不同 key。governance-gateway-adapter.ts:619 completedResult 早退不进 #mutate，不调回调，读代码证实；但 settle() 每次设备动作请求都会全量 reconcile，不会永久卡住；触发：同幂等键的已完成回执重放，且第一次定向回调失败并被吞掉；后果：定向 reconcile 丢失，等后续 settle() 全量 reconcile 放行，只是延迟
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3【低】回调到真实 `DeviceActionService` 的接线仍无自动检查（上一轮意见 3 仅部分修复）。沿用第 2 轮意见 3；production-http-composition.ts:1529-1530 接线读起来是对的，缺的是端到端用例，回调重放已有用例覆盖；触发：有人改错回调接线或装配；后果：测试不报警，生产行为本身没错
