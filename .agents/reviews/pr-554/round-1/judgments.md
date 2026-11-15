# PR 554 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高：陌生人上下文打开首页会自动换取主人会话，反向用例变成竞态。app.tsx:222 配置加载失败走 recoverBrowserEntry，browser-entry.ts:56 createBrowserSession；product-path-harness.ts:868-880 对每个请求注入断言；ab35b8a14 在 goto 前拦截 sessions 并断言 stranger.cookies() 为空，已消除该路径；触发：陌生人上下文打开首页，SPA 配置请求 401 后用 front 代理注入的 Access 断言自动 POST /api/identity/v1/sessions 换会话，之后 fetch 导出接口返回 200；后果：反向验收用例不再是无会话请求，结果取决于时序，可能偶发失败或让反向验证失效；只影响验收测试，不影响生产
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 中：已登录分支把整个导出包读进浏览器内存，最多 512 MiB。原 archive() 对所有响应读正文；ab35b8a14 改为 status===200 时不读正文，已登录分支只用 status 和 contentType；触发：已登录分支 archive() 对 200 响应也 arrayBuffer() 读完整 zip；后果：验收环境数据包很大时浏览器内存或超时；验收数据集很小，只是多余的读取；判低理由：验收数据集小，最多多读一个小 zip，只影响测试
