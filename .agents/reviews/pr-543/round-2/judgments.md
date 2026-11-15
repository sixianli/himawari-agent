# PR 543 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1【中】审批回应的幂等重放会跳过 `onApprovalResolved`，定向 reconcile 仍可能丢失。governance-gateway-adapter.ts 早退分支原先不调用 onApprovalResolved；已在早退分支补调用；新增 production-approval-arbitration.test.ts 重试用例，去掉修复后该用例失败；触发：审批回应已被处理后客户端或崩溃恢复重试（走幂等早退），且同时有 100 条以上等待中的设备动作，刚批准的排在第 101 条之后；后果：回调丢失，那条已批准的动作要等前面的处理完才放行，不丢数据不放行错误动作；判低理由：需要重试加 100 条以上并发等待才触发，只是延迟
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2【中低】`DeviceActionResolution.reasonCode` 仍被丢弃，所有非批准结局都记成 `owner_denied`。与第 1 轮意见 5 相同，沿用原判：正常路径不触发，修需新增 reason 码和 prompt-catalog 文案，超出本 PR；代码未变；触发：批准后审批记录消失或来源不可用等异常路径；后果：动作被记成 owner_denied，原因标签不准，不影响放行与否；判低理由：只在异常路径触发且只是原因标签不准，不影响放行与否
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3【低】上一轮意见 4 只是改善了用例意图，未覆盖 `DeviceActionService` 到生产授权的真实接线；新回调本身也没有自动检查。第 1 轮意见 4 的延续：生产行为符合 ADR 0257，只是装配缺少端到端覆盖；回调的重放路径已由新增用例覆盖；触发：有人把回调参数写错或改动装配；后果：测试不报警，生产行为本身没错
- 4（deepseek-v4.1-flash）成立，可以更好：### 4【低｜推测】`sideEffect` 对需要审批的 READ 动作会写成 `reversible`/`irreversible` 而不是 `none`。当前不可达：ReadOnlyDeviceActionAuthorization 放行所有 READ，注册表里 READ 动作没有 ownerPresence，不会进入审批快照；模型自己标为推测；建议不改
