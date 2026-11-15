## 结论

这一轮对比 `83bbf307c..e38388570`，增量只改了 `test/integration/product-path-browser.test.ts` 的 3 行（新增 2 行、修改 1 行），其余是复核记录。上一轮两条意见中，第 1 条已实质修好；第 2 条已去掉 `arrayBuffer`，但还留有一个低严重度的资源问题。没有发现新的中、高严重度错误。

## 上一轮意见核对

- 第 1 条“陌生人打开首页自动换取主人会话”：已修好。`app.tsx:259-275` 的失败恢复会调用 `recoverBrowserEntry`，`browser-entry.ts:56-58` 再调用 `createBrowserSession`，`gateway-client.ts:104` 请求 `POST /api/identity/v1/sessions`，`identity-gateway.ts:1066-1082` 成功时会写会话 Cookie。增量在 `product-path-browser.test.ts:5956` 先用 `route.abort()` 拦掉这个精确路径，再在 `:5961` 断言陌生人上下文没有 Cookie，竞态被消掉。
- 第 2 条“已登录分支读入整个导出包”：已去掉浏览器端 `arrayBuffer`。现在 `:5950` 只有非 200 才读取响应体。仍有下面第 1 条的低严重度残留。

### 1. 低：已登录分支跳过 arrayBuffer 却没取消响应体，导出流仍留在后台

- 文件：`test/integration/product-path-browser.test.ts:5944-5952`
- 问题：200 分支直接返回 `bytes: -1`，既没有读取也没有取消/排空响应体。测试不再把整个包放进 JS 堆，但 HTTP 响应仍然存在；服务端在发响应头之前已经同步构建完整 archive，生产上限是 512 MiB（`apps/agent-service/src/production-data-export.ts:39`、`:98`）。该响应可能在整个后续测试期间继续占用连接/网络/服务端资源。
- 证据：`bytes: response.status === 200 ? -1 : (await response.arrayBuffer()).byteLength,`；紧随其后 `const allowed = await archive(page);`，没有 `response.body?.cancel()` 或 `AbortController`。
- 建议：读取完 `status`/`content-type` 后，对 200 响应显式 `await response.body?.cancel().catch(() => undefined)`，或到响应头后立即 abort；这样既保留断言，又能真正停止下载。
- 性质：代码事实是未消费、未取消；浏览器是否仍会缓冲大量字节、Hermes 上实际影响多大，未实测。

## 侧重检查

- **陌生人 401 是否可能是假阳性**：`identity-gateway.ts:636-657` 明确要求 `accessAssertion` 和 `sessionToken` 同时存在；测试前端代理会给每个请求注入合法 assertion（`product-path-harness.ts:871-878`），所以陌生人唯一缺的就是会话 Cookie。跨站来源会走 `production-data-export.ts:467` 返回 403 而不是 401。紧接着同一场景的已登录请求断言 200，说明不是服务整体故障造成的 401。
- **goto 首页是否可能重定向到别的源**：`http-gateway-server.ts:1702-1710` 的 `/` 直接返回静态 `index.html`，不检查登录、不重定向；页面 CSP 也允许 `connect-src 'self'`（同文件 `:366`）。相对路径 `fetch` 仍落在同一源。
- **content-type 是否会带 charset**：`production-data-export.ts:491-498` 显式 `header("content-type", "application/zip")`；集成测试 `data-export-http.test.ts:173` 也断言精确等于 `application/zip`，不会附加 charset。
- **自动换会话与重试**：拦截路径 `**/api/identity/v1/sessions` 与 `gateway-client.ts:104` 的实际请求路径完全一致，且 route 在 `goto` 前注册。拦截后应用会进入 `unreachable` 的 5 秒自动重试（`browser-entry-screen.tsx:19-29`），但每次会话创建仍被同一 route 拦下，不产生 Cookie。
- **资源耗尽/不可逆操作**：会话创建被拦住，不会在陌生人上下文留下服务端会话；唯一残留是上面未取消的导出响应。
- **规则/文档一致性**：ADR 0200 要求未登录 401、跨站 403、同源访问，当前代码与测试一致；增量没有改文档。

## 读代码证实的

- 陌生人自动换会话的真实链路存在，且增量已拦截该精确请求。
- 会话 Cookie 只在 `POST /api/identity/v1/sessions` 成功时设置（`identity-gateway.ts:1078-1082`）。
- 陌生人无 Cookie 时导出接口返回 401 且空响应体（`production-data-export.ts:469-471`）。
- `/` 在未登录时不会重定向，导出接口的 content-type 精确为 `application/zip`。
- `data-export-http.test.ts:232-251` 已有独立反向用例：匿名 401/0 字节、他人会话 401、跨站 403；去掉鉴权会失败。
- 200 分支没有取消响应体。

## 推测/未核实

- 浏览器在响应体未消费时实际缓冲多少、是否会在后台持续下载，未实测。
- Hermes 真实出包重跑结果未核实。
- 测试硬编码了 `**/api/identity/v1/sessions`。当前与前端完全一致；若以后会话创建端点改名，route 会静默失效，陌生人场景可能重新退化成 200/401 竞态。这不是当前错误，但属于跨文件耦合点。

## 必答问题

1. **是否改变模型已见过的请求开头**：不涉及。增量只改浏览器验收测试，没有改系统提示、工具定义、历史消息或遮盖结果，也没有构造模型请求。
2. **同一段文字是否会在不同请求里变成不同字节**：不涉及。新增的值只有测试内的 `-1` 哨兵和固定 route 通配符，不进入任何序列化内容。
3. **是否有对应自动检查、反向用例是否会失败**：有。该场景自身的 401、0 字节、0 Cookie 和 200/`application/zip` 断言会失败；另有 `data-export-http.test.ts:232-251` 的独立 401/403 反向用例。唯一缺口是新增的会话拦截 route 没有单独断言“确实命中”，依赖当前硬编码路径。
4. **每个新值的直接使用端是否接受**：`bytes` 字段只在场景内产生和断言；`-1` 不会被当真实字节数使用。route 通配符只交给 Playwright，已与 `gateway-client.ts:104` 的实际路径核对一致。`application/zip` 与 `production-data-export.ts:493` 及集成测试 `:173` 一致。没有新增导出函数、配置键、清单项或序列化格式。
