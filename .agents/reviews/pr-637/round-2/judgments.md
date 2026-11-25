# PR 637 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1. 中高：`thread.option.choose` 不在客户端能力表，点选和本轮新增的幂等键在本机就被拒。沿用第 1 轮第 2 条原判：与上一轮同一意见，能力表这部分代码没改，模型没给新证据（它自己引用了材料里作者已知的过渡状态）。现在没有服务器会发 options，演示数据只在 DEBUG，生产里选项按钮画不出来，没有可达输入；服务器登记 thread.option.choose 时会重生成 ClientCapabilities.swift
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中：幂等键的端到端自动检查实际没跑，也没有覆盖 `ThreadOptionChooser`。沿用第 1 轮第 8 条原判：说的是测试覆盖缺口，不是错误结果；Package.swift:21 在 Linux 不建界面模块属实，ManageGatewayTests:58 的调用方 key 测试要在 Mac 跑；ThreadOptionChooser.swift:15 确实把 choiceKey 传进 ManageCommandOptions，当前代码行为正确
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 中低：NotificationRouter 的隔离修复没有类型检查或行为测试证据。模型自己确认 NotificationRouter.swift:39 的 nonisolated 修法方向正确、ListenSystemSurfaces.swift:82 的常量不可变，说的只是缺 Mac 编译和 presentation 的行为测试，属于验证缺口；第 1 轮判断已记 Mac 实际编译报错后修好，Mac 上再编一次由主线程交给 Andy 的 Mac 线程
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低：ADR 0258 仍写着客户端能力表是旧对应，和本轮代码不一致。docs/adr/0258-each-apple-device-plays-to-its-strength.md:108 原话属实，client-capabilities.ts:388 已是 approvals 对 chat；只是一句实现状态说明过期，查表即可看出，不会造成错误结果；触发：读 ADR 0258 决定第 3 条了解客户端能力表现状；后果：ADR 说能力表和生成的 Swift 还是旧的对应、待 iPhone 外壳 PR 改，而本 PR 已在 client-capabilities.ts:386-396 改好，读者可能以为还要再改一次
