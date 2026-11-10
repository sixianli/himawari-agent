# PR 359 第 1 轮复核处理

费用 0.2038 美元（两个模型）。

## 会出错（都是低，已改）
- A3 / B1：`deferredPiStream` 吞掉异常。给外层异步函数补 `.catch`；测试「does not call the model when native history cannot be persisted」加断言：历史写入失败时事件流以 `runtime.failed` 结束、没有 `runtime.completed`。诊断码变粗只影响错误路径，请求字节不变，判低。
- A5：ADR 0208 决定第 2 条写 `cacheWarming: "off"`、整条声明比对，与代码不符（代码按 ADR 0206 锁 `"streaming"`，整条声明比对放第 3 步）；`architecture-v0.1.md` 还写“被替换的原 streamFunction”。都已改。

## 可以更好（不改，列给 Andy）
- A1：预热请求现在会过代理，会先消耗审批续跑的一次性回放。核对 Pi 的 `cache-warmer.js` 第 239 行，预热器调用的是传入的 `ModelRuntime`，所以结论成立；但没有模型配 `promptCache`，预热不会触发，现在不出错。已在 ADR 0208 第 2 步记录和指南 D7 一段写成“打开预热前必须处理”。
- A2：代理只重写 `streamSimple`。第 2 步之前会话里的 `stream`、`complete` 同样不经替换函数，没有变坏；会话关了扩展。已在 ADR 里写明。
- A4：新接缝缺专项测试。已有真实 Pi 的压缩、审批续跑、黄金请求会穿过新路径；专项用例列为后续。
- B3：预热从“绕过治理”变为“进治理”，已写进上面 A1 的记录。
- A6、A7、B2：推测，复核者读不到 Pi 的 dist；本线程已读 dist（`sdk.js`、`agent-session.js`、`cache-warmer.js`），无函数身份比较、无 `instanceof ModelRuntime`，不成立。A7 会话关了扩展，不会触发。
