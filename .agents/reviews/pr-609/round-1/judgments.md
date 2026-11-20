# PR 609 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1、高、同根因的另一个 [P5-3] 用例仍走不带密钥的地址，改动后大概率仍然失败。test/integration/production-http-composition-process.test.ts:2137-2161 仍用裸路径并断言年份；apps/agent-service/src/production-mcp-read.ts:615-617 裸路径返回空 clientId，:771-782 不注册工具；已改为先 seedMcpConnection 再用带密钥地址；触发：CI 跑 [P5-3] Cloudflare Access 受众用例：用不带密钥的 /api/mcp/v1 调 tools/call today_context；后果：裸路径不注册工具，响应里没有年份，断言失败，CI 仍红
- 2（deepseek-v4.1-flash）成立，可以更好：### 2、中、测试直接写 `mcp_connections`，复制了生产的哈希与字段规则，后续容易漂移。该测试是对预构建安装包的黑盒进程测试，不导入 apps 源码；直接写库并复用同一哈希规则是有意为之，当前值通过迁移约束（20261115113156_mcp_connections.sql）。生产改哈希时单元测试和这条会同时红，不会静默通过。建议不采纳
- 3（deepseek-v4.1-flash）成立，可以更好：### 3、低、集成用例只有正例，没有验证「无接入记录或密钥错误时列不出工具」。错误密钥 404、裸路径无工具的反向覆盖已在 apps/agent-service/test/production-http-composition.unit.test.ts:985-996；本 PR 只修测试与现状不符，集成层加反例是锦上添花。建议不采纳
