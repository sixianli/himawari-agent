# PR 426 第 5 轮逐条判断

- ds-1（deepseek-v4.1-flash）「生成的 Swift `requiredTier` 没有使用 `tightenOpenKeys`」：成立，低，已改：生成的 `requiredTier(payloadKeys:payloadFlags:)` 自己过滤可忽略的键，并要求这些键都出现，和服务器端判断一致；手机端调用跟着改，手机端测试加了缺 kind 的用例。
- ds-2（deepseek-v4.1-flash）「缺 `kind` 的 `{enabled:false}` 也会被判为收紧」：成立，低，已改：`sameFlags` 要求可忽略的键必须出现。合约测试加了 `{ enabled: false }` 判为“改”的用例；去掉这一条件时该用例失败（判成 tighten）。
- ds-3（deepseek-v4.1-flash）「集成测试没断言 501」：部分成立，低，已改：补了 `statusCode` 为 501 的断言。真正关闭成功的路径由推送自己的测试覆盖，这条用例只验证分档和审计，没有在设备网关测试里另装推送端口。
- ds-4（deepseek-v4.1-flash）「推送设计文档仍写整组替换」：不在本 PR 范围，旧文案早于本 PR，本 PR 没有改推送合约；列给 Andy。
