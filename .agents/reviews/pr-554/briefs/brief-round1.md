# PR 554 复核材料

问题：test/integration/product-path-browser.test.ts 的场景 accept-export-requires-login 用 Playwright 的 request.get 直连 https://agent.example.test，Node 自己解析 DNS，不受 chromium 启动参数 --host-resolver-rules 影响，Hermes 上线验收报 getaddrinfo ENOTFOUND，上线包被拒。

做法：改成在页面里 fetch 同源 /api/data-export/v1/archive（陌生人上下文先 goto 首页再 fetch；已登录用现有 page）。断言不变：陌生人 401 且 0 字节，已登录 200 且 content-type application/zip。

约束：只改这一个场景；断言强度不得降低；反向用例（陌生人被拒）必须保留。不涉及模型请求。作者在云端无法跑这个第 3 层测试，真实验证靠 Hermes 出包重跑。
请特别查：陌生人 fetch 是否会因没有 cookie 以外的原因返回 401（假阳性）、goto 首页是否可能在未登录时被重定向导致 fetch 同源变化、content-type 是否可能带 charset 参数。
