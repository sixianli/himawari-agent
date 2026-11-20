# PR 426 第 7 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. [中] Swift 规则只是与 TypeScript 文本快照一致，没有行为测试，二者仍是两份手写实现。两份实现的行为测试：Swift 侧 requiredTier 的测试在客户端 PR 里（ManageGatewayTests），列给 Andy，不在本 PR 改
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. [中] `memory.external.respond` 的新分档没有经过设备网关的端到端用例。已在 device-gateway 集成测试补：保留要确认签名且不留审计，全拒绝免面容并写收紧审计；触发：有人改动设备网关分档代码后让 memory.external.respond 的免面容判定失效；后果：没有端到端用例发现，只有纯函数测试；判低理由：只是测试缺口，现有分档逻辑本身正确，已补端到端用例
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. [中] `ownerSubject` 只对外部身份绑定生效；内置身份模式下需要近期验证的“改”会没有证据。内置身份部署里设备“改”拒绝（失败方向安全），生产用外部身份；是否支持属 PR 404 的范围，列给 Andy
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. [低] 首次连接 Gmail 的启用路径不再写入默认规则行，规则版本从 1 变成 0。已把两处首次启用恢复成原来的 writeSettings，只有 proactive.pause 用 setEnabled；触发：首次连接 Gmail 或演示邮箱启用主动检查；后果：默认规则行不再写入，规则版本为 0 而不是 1
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. [低] `check:client-parity` 不编译 Swift，缺少 `JSONValue.swift` 这类问题不会被自动检查发现。需要 Swift 编译环境，客户端 PR 在 Mac 上编译；列给 Andy
