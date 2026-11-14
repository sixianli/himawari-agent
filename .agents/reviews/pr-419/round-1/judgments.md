# PR 419 第 1 轮判断

被复核的提交：`670f9507`（`--base` 为 main 的 `44a0e332`）。两个模型都跑了（DeepSeek 0.0838、GLM 0.0709，累计 0.1547 美元）。两个模型都说读不到 `node_modules`，所以凡是依赖 pi-ai 内部行为的地方它们标了“未核实”；线程自己装了依赖，对着 pi-ai 的发行代码核对过。

## 成立，会出错，中、高（改了，要再复核）

- r1gl1（GLM：高）出口遮盖的“点名值”表跨重试残留，第二次重发把排在点名消息前面的同一个值也遮掉，和第一次字节不同。成立：在 `packages/application/test/model-egress.unit.test.ts` 新加的 `[RETRY-429]` 用例里复现了（改动前断言失败：第一次和第二次的请求体不同）。线程判中、高（边缘输入触发、不丢数据，但违反“重发字节相同”这个 ADR 的核心陈述，拿不准按中高）。改法：`packages/application/src/services/model-egress.ts` 的 `wrapFetch` 对“地址和请求体都与上一次完全相同”的请求直接沿用上一次遮盖后的请求体，不重新遮盖、不重复上报；ADR 0245 决定 6。反向用例：请求体不同时仍然各自遮盖。
- r1ds5、r1gl5（模型都标低）重试会重复累加敏感拦截记录的 `seen_count`。成立：`#prepare` 每次都 `#report`，SQLite 里 `seen_count = seen_count + excluded.seen_count`。线程判中、高（审计计数被放大，和 r1gl1 同一处根因）。同一个修改解决；用例同上，断言三次发送只上报一次。

## 成立，会出错，低（改了）

- r1ds3、r1gl2（模型：中）标题、邮件判断等后台调用仍是 `maxRetries: 0`，ADR 说“每个被拒绝的响应写日志”说宽了。线程判低：聊天主路径已修；后台路径走 `pi-model-transport.ts`，准入、用量、缓存预热是另一条路，记忆保存已有自己的同轮重试（ADR 0222）；触发只是后台调用遇到偶发 429，不会给出错误结果。ADR 0245 加决定 7 写明范围，决定 4 改成“聊天请求和压缩摘要请求里”。是否把重试扩到后台调用，列给 Andy。
- r1ds7（模型：低）ADR 0198 决定 7、开发指南、规则文档里还有“503 同一轮不会再发第二次请求”“网关只允许发一次”“另有两条用例”的旧说法。成立。ADR 0198 决定 7 加了指向 ADR 0245 的修订说明；开发指南改成“成功之后不允许再发，拒绝之后最多再发 2 次”；规则文档改成“另有几条用例”。

## 成立，可以更好（改了）

- r1ds2、r1gl3、r1gl7 反向用例没有断言失败码。`[ADR-0198]` 持续 503 用例现在断言 `PI_MODEL_UNAVAILABLE`，等待超限的反向用例断言 `PI_MODEL_RATE_LIMITED`；端到端通过，说明归类在真实的 pi-ai 报错文案上成立。（r1gl7 说把重试次数改回 0 反向用例照样通过，属实；区分力靠 `[ADR-0198]` 的请求数 5。）
- r1ds4、r1gl4 网关观察器对任何非 2xx 都放开且没有次数上限。改成只对 408、409、429、5xx 放开，最多重发 2 次，其余仍然只许一次；加两条反向用例。
- r1ds6 日志里头部文字没有长度上限、`hostOf` 不认带 `url` 的对象。头部截到 128 个字符，`hostOf` 认 `url`；新增 `provider-rejection-observation.unit.test.ts`。
- r1gl6 生产接线没有测试、`shouldRetry` 没断言。`shouldRetry` 和截断已在新的单元测试里断言；`service-main.ts` 的日志接线本身只有一行字段映射，层 3 的进程级测试在云端容器跑不了（要先有打好的上线包），不加。

## 不成立

- r1ds1（模型：中）“Server requested …s retry delay”的归类正则只认整数秒、状态码后必须有空白或冒号。不成立：pi-ai 的发行代码 `node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js` 第 25 行用 `Math.ceil` 生成整数秒，OpenAI SDK 的错误文字 `node_modules/openai/core/error.js` 第 28–32 行永远是 `<状态码> <正文>` 或 `<状态码> status code (no body)`，状态码后一定有空格；而且 `prompt-prefix.compat.test.ts` 的反向用例现在在真实 pi-ai 路径上断言了 `PI_MODEL_RATE_LIMITED`，通过。

## 其他说明

- 两个模型都问了“重试期间用户取消”：`provider-retry.js` 的 `abortableSleep` 接收 `signal` 并在中止时立即抛错（第 51–67 行），不是推测。
- DeepSeek 提到“失败的尝试不收费”没有证据：ADR 里已改成“被拒绝的响应没有生成内容，不记用量”。
