# PR 286 第 3 轮复核逐条判断

复核提交 038d032 之后的 HEAD。连续第三轮有“会出错”（中、高）意见（D1），按规则改完不再复核，停下报告 Andy。

| 编号 | 模型原话 | 成立 | 类别 | 判断 |
|---|---|---|---|---|
| D1 | 扫描正则只认 `X += chunk;`，漏掉同样是逐块字符串化的写法 | 是 | 会出错（中、高） | 正则改为 `request.on("data", …)` 回调后 200 字符内出现 `+=` 即报（不依赖变量名、分号、`.toString`），只看接收请求的变量，不误伤子进程输出；反向用例加了三种写法。I-82 的文字写的是两个文件，不再说更宽的话。 |
| D2 | `product-path-harness.ts` 的扫描 `minimumReadCalls` 为 0 | 是 | 会出错（低） | 改成至少要有一处 `readRequestBody` 或 `Buffer.concat(`。 |
| D3 | `chatReply` 仍用旧的“首条 system”判断 | 是 | 会出错（低） | 改用 `isAgentRequest`；本地 10 个用例通过。 |
| D4 | `isAgentRequest` 绑定提示词目录常量 | 是 | 可以更好 | 两者相等，漂移会先让 `pi-model-transport.unit.test.ts` 失败。 |
| D5 | `.catch` 会吞掉成功处理器里的错误 | 是 | 可以更好 | 变成被测产品收到 500，并非静默。 |
| D6 | 新门禁放在 integration，`npm run check` 不跑 | 是 | 可以更好 | 列给 Andy：是否挪进 `npm run check`。 |
| D7 | 真实 HTTP 分块测试依赖 50ms 定时器 | 是 | 会出错（低） | 改为服务端收到第一块后客户端才发第二块，不再靠定时器。 |
| D8 | 另一个假模型服务器 `opencode-review.test.mjs` 仍逐块解码 | 是 | 可以更好 | 它是复核脚本自己的测试桩，不是 Himawari 的模型桩；列给 Andy。 |
