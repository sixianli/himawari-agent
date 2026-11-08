# PR 286 第 1 轮复核逐条判断

复核提交 b736475。两个模型各提出一条中严重度意见（D1、G1），都成立，已修改，要再复核一轮。其余低严重度的 D2、D4、D5、G2、G3 成立并已修改；D3、G4 属于“可以更好”，不改。

| 编号 | 模型原话 | 成立 | 类别 | 判断 |
|---|---|---|---|---|
| D1 | 新测试没有真正覆盖被改的服务器处理器，旧写法回退时新测试仍会通过 | 是 | 会出错（中、高） | 反向用例只证明旧读法错，没锁住假服务器不能改回去。已在 `request-body-decoding.test.ts` 加源码扫描用例（假服务器源码不得出现 `body += chunk`，至少两处 `readRequestBody(request)`），并带反向用例。 |
| D2 | 两个处理器改成 Promise 后没有拒绝处理 | 是 | 会出错（低） | 加了 `answerFailedRead`，读取或解析失败时回 500。 |
| D3 | `readRequestBody` 无长度上限 | 是 | 可以更好 | 只用于测试自己的回环假服务器，发送方是被测产品，请求体约 20 KB。 |
| D4 | 真实 HTTP 用例没有断言真的分成两段 | 是 | 会出错（低） | `readRequestBody` 加可选 `onChunk`，用例断言块数不少于 2。 |
| D5 | I-82 对 `isAgentRequest` 的描述少了 `role === "system"` | 是 | 会出错（低） | I-82 的门槛一栏已写完整。 |
| G1 | `isAgentRequest` 没有任何直接测试和反向用例 | 是 | 会出错（中、高） | 抽到 `test/fixtures/agent-request.ts`，加直接用例和反向用例（旧过滤器会把背景请求算进去）。 |
| G2 | provider stub 没有 catch | 是 | 会出错（低） | 同 D2。 |
| G3 | `prompt-prefix.md` 对 PR-A/PR-B 抓取方式的说明与代码不一致 | 是 | 会出错（低） | 已改成“用真实服务和 SQLite，并在测试自建的 HTTPS 模型桩里收齐字节后抓取原始请求体来比对”。 |
| G4 | 夹具补的 `egress` 与生产仍有两处可选参数差异 | 是 | 可以更好 | 列给 Andy：要不要把夹具对齐生产的 recorder 和 egressThreadOf。 |
