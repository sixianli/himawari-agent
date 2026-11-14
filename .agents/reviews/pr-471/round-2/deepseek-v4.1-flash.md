## 结论（按严重度）

### 1. 中 — 新增的 in-flight 场景无法证明文档宣称的“在途请求不报”
- 文件:行：`scripts/test-browser-page-errors-browser.mjs:55`、`:98-100`、`:103`；`docs/incidents-and-gates.md:130`
- 问题：I-97 写“卸载前已发出、被取消的请求不报……新用例逐次核对”，但该场景对 WebKit 明确跳过了“报错确实出现”的断言，而且同源场景的预期值会把本机 host 从 `rawBlocked` 里删掉。因此 WebKit 报或不报，测试都通过，无法区分“没报”与“报了但被过滤”。
- 证据（亲自读到）：
  ```js
  { name: "same-origin-fetch-in-flight-while-reloading", target: pageOrigin, inFlight: true },
  ...
  const expectedRecorded = entry.name.startsWith("same-origin")
    ? entry.rawBlocked.filter((host) => host !== pageHost)
    : entry.rawBlocked;
  ...
  if (engine !== "webkit" || entry.name.includes("in-flight")) continue;
  ```
  若 WebKit 报出该错误，`rawBlocked=[pageHost]`、`recordedBlocked=[]`、`expectedRecorded=[]`，仍然通过；若完全不报，也通过。
- 建议：给该场景单独的断言（例如 WebKit 上要求 `!entry.rawBlocked.includes(pageHost)`，或明确记录“报了就应被放过”而不是“必然不报”），并据此改写 I-97 的措辞；否则删掉“新用例逐次核对”的结论。

### 2. 中低 — 文档把“地址不带端口”的用例记到了真浏览器脚本名下，实际只有假 Page 单测
- 文件:行：`docs/incidents-and-gates.md:130`、`scripts/test-browser-page-errors-browser.mjs:51-56`、`test/tooling/browser-page-errors.test.mjs:79-87`
- 问题：I-97 的证据列写 `scripts/test-browser-page-errors-browser.mjs`“每个引擎在真浏览器里核对……页面地址不带端口时不放过”。该真浏览器脚本的四种场景都基于 `http://127.0.0.1:${port}`，没有“无端口”场景；无端口用例只在 vitest 的 `Page` 假对象里。
- 证据（亲自读到）：真浏览器场景列表只有 `same-origin-fetch-started-while-reloading`、`cross-origin-fetch-started-while-reloading`、`cross-origin-fetch-on-stable-page`、`same-origin-fetch-in-flight-while-reloading`；无端口断言在：
  ```js
  page.url = () => "https://himawari.example/threads";
  ...
  expect(errors).toEqual([sameHost]);
  ```
- 建议：把 I-97 中的“页面地址不带端口时不放过”移到 `test/tooling/browser-page-errors.test.mjs` 的覆盖说明里，或在真浏览器脚本里真的加一个默认端口/无端口场景。

### 3. 低 — 守卫正则没有正向对照，且仍可被 `prependOnceListener` 绕过
- 文件:行：`test/tooling/browser-page-errors.test.mjs:128-133`
- 问题：测试只扫描真实 `scripts/` 目录，而这些脚本都已经改用收集函数；即使正则被改坏，扫描结果仍是空数组，测试照样通过。另外只覆盖 `on/once/addListener/prependListener`，Node `EventEmitter` 还有 `prependOnceListener`，直接监听不会被拒绝。
- 证据（亲自读到）：
  ```js
  /\.(?:on|once|addListener|prependListener)\(\s*["']pageerror["']/u
  ```
  没有任何用 `.once("pageerror")`、`.addListener("pageerror")` 或 `.prependOnceListener("pageerror")` 的夹具来证明正则会命中。
- 建议：在临时目录或内存字符串上对四种（含 `prependOnceListener`）写法逐条断言会被判为 offender，并保留一个不匹配的对照；同时补上 `prependOnceListener`。

### 4. 低 — “带端口”规则并不能证明同源；“一个端口只对应一种协议”的说法不成立
- 文件:行：`scripts/browser-page-errors.mjs:7-8`
- 问题：代码只比较 `url.host === host`，`url.host` 包含端口但从不比较协议。`http://host:port` 的页面仍会放过 `https://host:port` 的拦截报错。要求端口只是排除了“URL 没写端口时无法比较”的情况，并没有建立同源。
- 证据（亲自读到）：
  ```js
  const url = new URL(page.url());
  return url.port !== "" && url.host === host;
  ```
- 建议：不要用“端口决定协议”作为理由。若要收紧，可把夹具的已知 origin/协议传入匹配函数；若做不到，至少在文档里写明“同 host:port 的跨协议报错仍会被放过”的残余风险。当前测试全用 `http://127.0.0.1:<port>`，所以实际影响有限。

### 5. 低（推测）— 服务器关闭没有超时/强制断开，慢请求计时器也未清理
- 文件:行：`scripts/test-browser-page-errors-browser.mjs:25-27`、`:31-33`、`:92`
- 问题：`server.close()` 只等所有连接自然关闭，没有超时，也没有 `closeAllConnections()`；如果关闭 context 后仍残留 keep-alive 连接，测试会挂起而不是失败。`/slow` 的 `setTimeout` 也没有在请求中止时清理。
- 证据（亲自读到）：
  ```js
  function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
  }
  ...
  setTimeout(() => response.end("{}"), 3_000);
  ...
  await Promise.all([close(page), close(other)]);
  ```
  仓库其他脚本（如 `scripts/delivery-mode/.../probe-network-boundary.mjs:184-185`）先调用 `server.closeAllConnections()`。
- 建议：关闭前调用 `server.closeAllConnections()`，或给 `close` 加超时兜底；在请求 `close`/`aborted` 时 `clearTimeout`。这是基于代码的推断，未实际运行验证。

## 侧重检查

- **错误路径**：`listen(other)` 失败时会关闭 `page`，`finally` 也会关闭两个服务器，异常路径本身处理正确；但 `close` 无超时，存在挂起风险（见第 5 条，推测）。
- **不合规范/不可信输入**：`pageerror.message` 来自页面，可能被页面脚本伪造，从而在导航窗口内被当成 WebKit 误报过滤掉；该风险原本就存在，本改动把匹配范围收窄到 `/<host>/... due to access control checks.`，是收紧而非放宽。
- **安全**：新增服务器只绑定 `127.0.0.1:0`，不对外；未发现新的网络暴露。
- **资源耗尽**：每个引擎多一个 3 秒 `/slow` 请求和四个场景的 200ms 等待，开销可控；主要风险是第 5 条的关闭等待。
- **不可撤销操作**：本改动只涉及测试脚本和文档，没有不可撤销的生产操作。
- **文档与代码一致性**：发现第 1、2、4 条所述不一致；I-97 中“断网阶段的预期报错”实际是最终对全部 `browserErrors` 生效，不只断网阶段，属措辞不精确。
- **D1、D6**：未核实。`judgments.md` 与第 1 轮复核记录位于 `.agents/reviews/`，工具读取被拒绝（`REVIEW_GIT_REFUSED records-path`），且 sparse checkout 未包含该目录，无法确认 D1、D6 具体是哪两条、其判据是否成立。若 D1 指端口/协议问题，本轮“端口决定协议”的依据站不住（第 4 条）；若 D6 指在途请求，本轮文档依据没有被自动检查支撑（第 1 条）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改 `scripts/`、`test/`、`docs/`；全量对比里另含 `apps/control-center/src/app/app-shell.tsx` 的焦点副作用，同样不参与模型请求组装。没有系统提示、工具定义、历史消息、遮盖逻辑或序列化代码的改动；按 [prompt-prefix.md:27-35](../../.claude/rules/prompt-prefix.md#rules)，仍然只在末尾追加、每轮变化值不进请求头。未发现违反该规则的改动。
2. **不会让模型请求里的同一段文字变成不同字节。** 本改动没有触及模型请求序列化；`blockedHosts` 还做了 `.sort()`，场景顺序固定。需要区分的是测试证据：`browser.json` 里的 `pageErrorFilter.cases` 含随机端口和原始 error 文本，文件字节每次会变，但它不是模型输入；另外“是否过滤”仍依赖 `replacing`/`page.url()` 的事件时序，属于测试侧非确定性，不是模型请求的字节问题。
3. **有自动检查，但反向用例不完整。** 带端口守卫、跨源报错、无端口同主机报错都有单测反向用例，改坏会失败；但守卫正则没有正向夹具，改坏也不会被发现，且漏了 `prependOnceListener`；in-flight 场景没有对“WebKit 不报”做可失败的断言；`expectedOfflineBrowserError` 没有单元级反向用例，只在真浏览器里走到。
4. **新增值的使用端基本能接受，但需要逐一说明。** `pageErrorFilter` 只被写入 `browser.json`，消费端 `scripts/ci/browser.mjs:19-58` 的 `browserCounts` 只读固定键，未发现严格 schema 会拒绝新字段；`inFlight`、`/slow`、`fixtureHost`、`expectedOfflineBrowserError` 的产生和使用都在同一文件内且一致。风险点是断言逻辑依赖场景名字符串（`startsWith("same-origin")`、`includes("in-flight")`），改名会静默改变预期，建议改成显式字段。
