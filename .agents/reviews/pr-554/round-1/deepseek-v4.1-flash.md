## 侧重检查

- **认证、不可信输入、错误路径**：核对了 `production-data-export.ts:464-499` 的 400/401/403/404/429/500 分支。401 只在 `authenticateHttpRequest` 失败或 owner 不匹配时出现；同源 `fetch` 会带 `Sec-Fetch-Site: same-origin`，不会误走 403。`content-type` 被明确设为 `application/zip`，另有测试逐字断言，未发现 charset 问题。
- **资源耗尽**：新代码在已登录分支也会把完整 zip 读入浏览器内存，最大 512 MiB，见下方第 2 条。
- **规则/文档与代码一致性**：作者说“只改这一个场景”“不涉及模型请求”与 diff 相符；“断言不变”基本相符，但新代码新增了读取已登录响应的整个正文，这不是断言变化，却是新的资源行为。
- **未核实**：未运行任何测试；`.agents/reviews/pr-554/briefs/brief-round1.md` 在 diff 中显示为二进制，`git show` 被仓库规则拒绝，未读到其内容，只能以你给出的作者说法为准。

## 意见

### 1. 高：陌生人上下文打开首页会自动换取主人会话，反向用例变成竞态

**文件:行**：`test/integration/product-path-browser.test.ts:5955-5958`

**问题**：`strangerPage.goto("/")` 不是“没有会话”的稳定状态。该测试的前端在配置请求 401 时会自动用前端注入的 Cloudflare Access 断言换取会话；因此“陌生人”可能在实际 fetch 之前就变成已登录主人，导致本应 401 的断言偶尔/必然变成 200，或者只能在“抢在自动登录完成之前”时通过。

**证据（读代码证实）**：
- 新测试先打开首页再 fetch：
  ```ts
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(`${installation.origin}/`);
  const refused = await archive(strangerPage);
  expect(refused.status).toBe(401);
  ```
- 首页启动时会加载控制中心配置，失败后进入身份恢复：
  ```ts
  void loadRuntimeConfiguration(window.fetch.bind(window))
    .then(...)
    .catch(async (failure: unknown) => {
      const next = await recoverBrowserEntry({
  ```
  （`apps/control-center/src/app.tsx:222-266`）
- 恢复流程在 `cloudflare-access` 模式下会直接创建会话：
  ```ts
  await createBrowserSession(fetchImplementation, deviceLabel);
  ```
  （`apps/control-center/src/browser-entry.ts:56-58`）
- 创建会话就是同源 POST，并由服务端设置会话 cookie：
  ```ts
  await fetchImplementation("/api/identity/v1/sessions", {
    method: "POST",
    credentials: "same-origin",
  ```
  （`apps/control-center/src/gateway-client.ts:99-110`；服务端设置 cookie 见 `packages/platform-node/src/identity-gateway.ts:1066-1082`）
- 测试 harness 的 front 代理给**每个**请求都注入有效的 Access 断言：
  ```ts
  headers: { ...request.headers, "cf-access-jwt-assertion": assertion },
  ```
  （`test/fixtures/product-path-harness.ts:868-880`）

**推测**：实际结果取决于 `page.evaluate` 的 fetch 与 SPA 自动换取会话之间的时序。快机器上可能 fetch 先到，测试“碰巧”通过；慢机器或自动登录更快时会返回 200 并失败。即使通过，也不是在验证一个真正的无会话请求。

**建议**：不要在陌生人上下文启动 SPA。可改为先导航到同源的非 SPA 文档（例如 `/api/identity/v1/method` 返回 JSON 的地址）再 `page.evaluate` fetch；或在陌生人 context 中拦截 `/api/identity/v1/sessions` 阻止自动登录；或在 fetch 前断言 `await stranger.cookies()` 中没有 `himawari_session`。另一种更贴近原意的方式是继续用 `context.request`，但把 URL 指向 `https://127.0.0.1:${installation.frontPort}` 并显式设置 `Host: agent.example.test`，这样既不执行页面 JS，也不依赖 Node 解析假域名。

### 2. 中：已登录分支把整个导出包读进浏览器内存，最多 512 MiB

**文件:行**：`test/integration/product-path-browser.test.ts:5946-5951`、`5960-5962`

**问题**：`archive()` 对任何响应都执行 `response.arrayBuffer()`。陌生人 401 时这是空正文，没问题；但已登录 200 时会把整个 zip 下载并保存在浏览器渲染进程内存中，而 `allowed.bytes` 根本没有被断言。旧代码只读取陌生人的 401 正文，从未读取已登录响应的正文。

**证据（读代码证实）**：
- 新 helper 无条件读取完整正文：
  ```ts
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes: (await response.arrayBuffer()).byteLength,
  };
  ```
- 已登录分支只使用 `status` 和 `contentType`：
  ```ts
  const allowed = await archive(page);
  expect(allowed.status).toBe(200);
  expect(allowed.contentType).toBe("application/zip");
  ```
- 导出包上限为 512 MiB：
  ```ts
  const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
  ```
  （`apps/agent-service/src/production-data-export.ts:39`）

**建议**：只在 401 分支读取正文验证 0 字节；已登录分支不要读取整个 zip，最多断言 `content-length`，或拆成两个 helper。这样也避免验收环境因大数据包出现内存或超时问题。

## 与作者说法的核对

- “只改这一个场景”：属实，diff 中代码只改了 `accept-export-requires-login`；另外新增了复核简报文件。
- “断言不变”：断言值本身未变；但已登录分支新增了读取完整正文，作者没有提到这一点。
- “陌生人上下文先 goto 首页再 fetch”：代码确实如此，但这正是第 1 条问题的来源。
- “不涉及模型请求”：属实，该场景不发送模型请求。
- “真实验证靠 Hermes”：未核实，本次未运行测试。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这是仅测试代码的改动，不涉及系统提示、工具定义、历史消息、遮盖或任何模型请求的组装。该场景不向模型发送请求；发给模型的内容仍然只在末尾追加、每轮变化的值仍在最后一条消息，这一改动没有触碰这些路径。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型请求。该场景没有模型请求，也没有比较导出的字节内容。导出 zip 本身含导出时间等非确定字段（`production-data-export.ts:42-52` 的 ZIP 时间、`exportId` 随机生成等），但这些从未进入模型请求，本次测试也没有对其做逐字节断言。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   该场景本身是自动检查，但被 `HIMAWARI_PRODUCT_PATH_E2E === "1"` 和环境变量门控（`product-path-browser.test.ts:54-55`），不在默认的 `npm run check` 里。反向用例名义上保留，但第 1 条中的自动登录会破坏它作为“无会话请求”的有效性，可能因竞态偶发通过或因自动登录先完成而失败。安全属性另有 `test/integration/data-export-http.test.ts:232-252` 覆盖匿名 401、其他 owner 401、跨站 403，但该测试不覆盖“浏览器打开首页后再请求”的这条路径。`test/tooling/release-walkthrough-coverage.test.mjs:84-99` 只检查场景名称和覆盖表，不检查场景行为，无法发现这个竞态。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   本次没有修改生产标识、配置键、清单项或序列化格式。测试新增的值是 helper 返回的 `status`、`contentType`、`bytes`，使用方只有本场景的三个 `expect`。我逐项核对了请求和响应两端：请求是无 `exportId` 的同源 GET，会进入 `buildNow()`；匿名请求返回 401 且空正文；已登录返回 200，服务端明确写 `content-type: application/zip`（`production-data-export.ts:491-494`），已有接口测试也逐字断言为 `application/zip`（`data-export-http.test.ts:167-173`）。因此 `contentType` 不会带 charset，`bytes === 0` 也成立。这里的值本身没有生产消费者，问题不在两端校验不一致，而在第 1 条的陌生人上下文并不稳定。
