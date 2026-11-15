# PR 541 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中 — 调用方传入取消信号时，`runTimeoutMs` 完全失效。production-think-worker.ts 原第 89 行 `signal ?? AbortSignal.timeout(...)`，传入信号时不加超时；已核对成立，改成 AbortSignal.any 合并并补用例；触发：调用方传入长生命信号（服务关闭信号）调用 runOnce(signal)，且运行器不响应信号；后果：runTimeoutMs 不生效，运行器挂起则 runOnce 永不返回、条目停在 thinking
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 中 — `worth.secretRef` 只校验格式，没有和 `secretReferences` 及用途对账。strict-configuration.ts 只有 safeReference，importDuplicates 有 assertIdentitySecretReference；已核对成立，补对账和 missing-secret 反向用例；触发：上线配置的 worth.secretRef 写错或没声明为 model-auth 用途；后果：启动不报错，接线后运行时才解析失败；与 importDuplicates 的对账不一致
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低 — 取消信号被当成判断失败，条目以 `failed` 终态结束，之后无法再处理。production-think-worker.ts 判断失败一律 settle failed；已核对成立，取消时返回 aborted，条目留在 thinking 由 recoverStalled 重试，补用例；触发：服务关闭等取消信号在判断阶段触发；后果：条目被记 failed 终态，同来源同版本不会再入队
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低 — 新提示词没有加入 `TRUSTED_PROMPT_TEXTS`，与规则文件说法不一致。trusted.ts 模块列表没有 think；已核对成立，加入并跑 prompt 相关测试通过；触发：think 提示词不在 TRUSTED_PROMPT_TEXTS 清单；后果：与 prompt-prefix 规则说法不符，暂无实际漏遮
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 低 — 关键错误路径缺少自动反向用例，第 1 条问题不会被现有测试抓到。think-worker.test.ts 原无这些用例；已补长生命信号超时、取消、超长原因代码三条，响应体超限等仍未测，属低；触发：无超时、取消、长生命信号的反向用例；后果：第 1 条缺陷不会被测试抓到
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低 — 运行器返回的 `reasonCode` 没有和存储层 64 字符上限对账。sqlite-think-inbox-operations.ts 限 64 字符，工人原样传入；已核对成立，工人截断到 64 并补用例；触发：运行器返回超过 64 字符的 reasonCode；后果：finish 抛错，成功的一轮被记成 failed
- 7（deepseek-v4.1-flash）成立，会出错，低：### 7. 低 — HTTP 错误或声明超限时没有取消响应体。think-worth-decision.ts 抛错前无 body.cancel；已核对成立，两处补 cancel；触发：判断服务返回非 2xx 或声明超限；后果：响应体未取消，连接多存活到 GC
