# PR 338 第 3 轮复核判断

这一轮没有成立的中、高“会出错”意见。

## 会出错（低，已修）

- r3-1（模型判中，线程判低）：担心生产 custom 消息带 `details` 会误拒。读 Pi 源码 `dist/core/messages.js` 的 `convertToLlm`：custom 消息只转成 `{ role: "user", content, timestamp }`，`details` 不参与比较，所以不会误拒。测试已改成生产用的 `himawari.background.command` 和 `details: { taskRef }`，通过。
- r3-2（低）：同一用例加反向分支：内存里有 custom 消息、Pi 没存这条条目时，捕获报 `PI_CONTINUATION_PREFIX_INVALID`。
- r3-3（低）：Gitleaks 门禁用例里被移除的那条改成完整的 `published-synthetic-fixture`；临时去掉门禁里的过滤后，用例报 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`。保留 synthetic-secret 由 `withoutRemovedDependencies` 的直接单测覆盖。
- r3-4（低）：测试名改为“before Pi validates them”。

## 可以更好（不改，列给 Andy）

- r3-5：每个工具检查点对整段前缀多做两次转换和序列化。

## 不成立

- r3-6：`convertToLlm` 只丢掉 `excludeFromContext` 的 bashExecution（Himawari 不产生这种消息），compactionSummary、branchSummary、custom 都转成 user 消息保留。
- r3-7：user、assistant、toolResult 条目由 `appendMessage` 存同一个对象，键序相同；custom 由 `convertToLlm` 按固定键序新建。值为 undefined 的属性服务方也收不到，比较模型可见内容时本来就应忽略。
- r3-8：实施时改的正是适配器的 `SettingsManager` 里的 `retry`，用例确实失败；provider 流的 `maxRetries: 0` 是服务方 SDK 一层的重试，与 Pi 的自动重试和 `context_edit` 无关。
