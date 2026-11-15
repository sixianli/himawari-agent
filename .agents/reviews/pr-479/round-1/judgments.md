# PR 479 第 1 轮复核判断

| 编号 | 意见 | 判断 | 依据和处理 |
| --- | --- | --- | --- |
| 1 | 慢请求日志写出带密钥的路径 | 成立，会出错，中高 | `packages/platform-node/src/http-gateway-server.ts` 的 `finish` 用原始 `request.url`。改为报路由模板（`request.routeOptions.url`），流式路径判断仍看原始路径。新用例 `[P5-B] reports a slow request by its route…`（`packages/platform-node/test/http-gateway-server.contract.test.ts`），去掉修改时失败、改后通过。 |
| 2 | 已撤销的接入仍占 200 个名额 | 成立，会出错，中高 | `sqlite-mcp-connection-operations.ts` 的计数加 `status <> 'revoked'`。`mcp-connections-store.test.ts` 加：暂停的仍算、撤销后能再建一个、再建又满。去掉修改时失败。 |
| 3 | capabilities / pushPolicy 只存不用 | 部分成立 | capabilities 是 ADR 0242 决定 10 里给向导选步骤用的“对方能做什么”，不是权限，这部分不成立。pushPolicy 成立：网关会收下不生效的 `direct`。改为新建和修改只收 `ask`（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`），“直接存”随任务 C 接上。组合测试加新建和修改成 `direct` 都被拒的用例，去掉修改时失败。 |
| 4 | 规则提议没有独立限频，“被限流”定义不对 | 部分成立 | 独立限频按 coding-tasks.md 属任务 C（“任务 C 做限频时往里记”）。定义不对成立：三种语言的定义改成“被限流”含读取和推送、不含规则提议；规则提议括号里写“超过每分钟上限被拒”；每分钟上限一行改成“读取和推送”。 |
| 5 | 地址接口缺 Sec-Fetch-Site 时放行 | 不成立 | 跨站页面读不到没有 CORS 头的响应；不发这个头的只有非浏览器客户端，它已持有主人会话 cookie。 |
| 6 | 名称和请求体上限没有当前用量 | 成立，低 | 名称显示现有最长名字的字数（组合测试和浏览器测试断言）；请求体注明不单独记录、只显示上限；ADR 补注同步改。 |
