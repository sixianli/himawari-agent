# PR 356 第 3 轮复核判断

被复核的提交是 9be98ede，只有 DeepSeek。三条意见都是低，都成立，都已改。

| 编号 | 判断 | 处理 |
| --- | --- | --- |
| r3-ds-1 | 成立，低：ADR 把手工验证写得像自动用例 | ADR 改为“手工验证过 maxTokensField；自动反向用例改的是 maxTokens” |
| r3-ds-2 | 成立，低：文档说 resolve 能分辨来源 | ADR 决定 2 和规范表改为“只从 credential 取密钥，来源唯一靠空凭据库” |
| r3-ds-3 | 成立，低：假 runtime 不再记录 auth | 假 runtime 记录 provider.auth，原有“注册内容不含 SECRET”的断言重新覆盖认证对象 |
