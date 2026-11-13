本次只读代码和 git 历史，未运行浏览器或测试。先说明一个会直接影响结论的事实：**你给的基准 `dd5c48d` 不是 HEAD 的祖先**。HEAD `1049b9122` 的父提交是 `e4df6f6d`，而 `dd5c48d` 是更晚的 main；因此 `git diff dd5c48d..HEAD` 除了本 PR 的 13 个文件，还把 main 上新合入的 PR 反向回退了。对应的三点 diff `git diff dd5c48d...HEAD` 才是本 PR 的 13 文件。下面分开写。

## 一、读代码证实的问题（按严重度）

### 1. 高：按给定基准看，这个改动会回退大量无关的 main 提交，包括会改变发给模型内容的部分

- 位置：git 历史，`package.json`/`packages/prompt-catalog/*`
- 问题：作者说“本 PR 只动前端和测试脚本”。对照实际父提交 `e4df6f6d` 成立；对照你给的 `dd5c48d` 不成立：两点 diff 有 354 个文件，而三点 diff 只有 13 个。
- 证据：
  - `git show --no-patch --pretty=raw HEAD`：`parent e4df6f6d...`
  - `git log --oneline dd5c48d..HEAD` 只有 `1049b9122` 一条，说明 `e4df6f6d` 已包含在 `dd5c48d` 里，`dd5c48d` 比 PR 的父提交更新。
  - `git diff --stat dd5c48d..HEAD` 有 354 个文件；`git diff --stat dd5c48d...HEAD` 只有 13 个文件。
  - 两点 diff 里实际出现 `packages/prompt-catalog/src/chat.ts` 删除一行、`packages/prompt-catalog/src/memory.ts` 删除 28 行、`packages/application/src/services/owner-profile-service.ts` 回退议程逻辑；这些都会改变系统提示或最后一条用户消息里的资料块。
- 建议：评审和合入必须用 `e4df6f6d..HEAD` 或三点 diff；如果目标分支确实是 `dd5c48d`，这个分支需要先 rebase/合并 main，不能按当前两点 diff 合入。

### 2. 中：过滤条件用的是 host，不是同源；同 host 不同 scheme 的跨源错误会被放过

- 位置：`scripts/browser-page-errors.mjs:3-10`，关键一行是 `scripts/browser-page-errors.mjs:7`
- 问题：作者说“host 与 page.url() 的 host 相同”就放过，代码确实如此；但“真正的跨源错误仍被拦下”不完全成立。`URL.host` 不含协议，`https://example.com` 页面会放过 `/example.com/...` 的 `http://example.com` 跨源错误。
- 证据：
  - `scripts/browser-page-errors.mjs:7`：`return new URL(page.url()).host === host;`
  - `scripts/browser-page-errors.mjs:1` 只从消息里取 host。
- 建议：至少要比较 origin，或把期望 origin 传给 watcher；如果 WebKit 消息确实只有 host、没有 scheme，应明确记录这是“同 host”而不是“同源”的近似，并补一条同 host 不同 scheme 的反向用例。

### 3. 中：同一脚本里仍保留“按文字一刀切放过 access control checks”的旧过滤，跨源错误可绕过

- 位置：`scripts/qualify-control-center-browser.mjs:1013-1025`
- 问题：PR 的目标是“不按文字一刀切放过 WebKit 的 access control 报错”，但 `expectedOfflineBrowserError` 仍只看消息里有没有 `access control checks` 和四个路径字符串，不看 host/origin。像 `/evil.example/api/gateway/v2/queries due to access control checks.` 会被当作预期离线错误过滤掉。
- 证据：
  - `scripts/qualify-control-center-browser.mjs:1013-1020`：`error.includes("access control checks") && ["/api/gateway/v2/events", ...].some((path) => error.includes(path))`
  - `scripts/qualify-control-center-browser.mjs:1023-1025`：`browserErrors.filter((error) => !expectedOfflineBrowserError(error))`
- 建议：让这里复用 `blockedSameOriginFetch` 的 host/origin 判断，或至少要求 host 是当前页面的 host；补一条“路径匹配但 host 是 evil.example 的错误必须让测试失败”的反向用例。

### 4. 中：新用例只复现“pagehide 里才发起的请求”，与 882eac20a 记录的“在途请求”根因不一致

- 位置：`scripts/test-browser-page-errors-browser.mjs:38-55`；历史证据 `git show 882eac20a`
- 问题：作者说法 1 是“WebKit 只对页面卸载期间才发起的请求记这条错误；在途请求被取消不记”。但 882eac20a 的提交说明明确写：“WebKit 在页面被重新加载/跳转时，对还在途的同源 fetch 记一条……错误”“页面在 pagehide 里主动 abort 也不能避免”“请求在途是这些用例的常态”。新用例是在 `pagehide` 里才 `fetch()`，没有复现“请求早已在途，然后 reload”的情形。
- 证据：
  - `scripts/test-browser-page-errors-browser.mjs:49-55`：
    ```js
    addEventListener("pagehide", () => {
      fetch(url, { method: "POST" }).catch(() => {});
    });
    await tab.reload();
    ```
  - `git show 882eac20a` 的提交说明：“WebKit 在页面被重新加载/跳转时，对还在途的同源 fetch 记一条……错误”。
- 建议：加一个“先发出慢请求，再 reload”的场景，断言该同源错误被放过；如果实际证明在途请求确实不报错，也应在事故记录里写清楚与 882 证据的差异，而不是只留一句结论。

### 5. 低：静态守卫只匹配 `.on("pageerror")`，没有覆盖 `waitForEvent`、`.once`、`.addListener`

- 位置：`test/tooling/browser-page-errors.test.mjs:104-120`；反例 `scripts/qualify-control-center-browser.mjs:380`
- 问题：作者说“拒绝新的直接监听”。当前守卫只匹配 `.on(`，而 `qualify-control-center-browser.mjs` 仍在用 `page.waitForEvent("pageerror")` 直接等页面报错，守卫不会报它。
- 证据：
  - `test/tooling/browser-page-errors.test.mjs:118`：`if (/\.on\(\s*["']pageerror["']/u.test(...))`
  - `scripts/qualify-control-center-browser.mjs:380`：`const receivedError = page.waitForEvent("pageerror");`
- 建议：如果“直接监听”包括 `waitForEvent`，扩展正则；如果不包括，就在注释/文档里说明这一处是故意等待注入错误，避免守卫和说法不一致。守卫本身也缺少“放一个违规夹具必须失败”的反向用例。

### 6. 低：真浏览器“每个引擎正反都核对”的说法在 Chromium/Firefox 上可能是空转

- 位置：`scripts/test-browser-page-errors-browser.mjs:64-82`
- 问题：只有 WebKit 要求 `rawBlocked` 里必须出现预期 host；Chromium/Firefox 如果根本不产生 `access control checks` 的 pageerror，`rawBlocked` 和 `recordedBlocked` 都是空数组，比较自然通过，不能证明“跨源仍被记录”。
- 证据：
  - `scripts/test-browser-page-errors-browser.mjs:74-82`：`if (engine !== "webkit") continue;` 之后才检查 `SCENARIO_NOT_REPRODUCED`。
- 建议：非 WebKit 也注入一个合成的同格式 pageerror（或直接对收集函数做单元测试），确认跨源消息不会被吞；否则把公开说法改成“WebKit 上做真实复现，其他引擎做基本收集一致性检查”。

### 7. 低：测试里的 HTTP server 在 `newContext()` 抛错时不会关闭，正常路径的 close 也没 await

- 位置：`scripts/test-browser-page-errors-browser.mjs:28-32, 61-65, 85-89`
- 问题：`const context = await browser.newContext();` 在 `try` 外面；如果这里抛错，两个 server 不会关闭。`page.close()`/`other.close()` 也没有被 await。
- 证据：
  ```js
  const context = await browser.newContext();
  const cases = [];
  try { ... } finally {
    await context.close();
    page.close();
    other.close();
  }
  ```
- 建议：把 `newContext()` 放进 `try`，用 `await new Promise((resolve) => server.close(resolve))` 关闭；这是测试代码的资源泄漏，不影响产品。

## 二、推测 / 未核实

1. **WebKit 实际 message 是否一定以 `/host/` 开头，未核实。** 新正则 `^\/(?<host>[^/\s]+)\/` 要求消息以斜杠开头；而 882eac20a 的历史说明写的是 “Fetch API cannot load … due to access control checks.”。如果 Playwright 暴露的 message 仍带这个前缀，新过滤不会生效。新真浏览器用例在 WebKit 上应该能发现，但本次没有运行；且它的 `blockedHosts` 用 `message.split("/")[1]`，遇到 `http://` 形式也会解析错。建议在单元测试里同时覆盖“带 Fetch API 前缀”和“只有路径”的格式，并明确实际 WebKit 格式。
2. **作者说“改前 Chromium、WebKit 各 5/5 失败，改后各 40/40 通过”未核实。** 我只确认了 `qualifyStartupFocusKept` 已接入 `qualifyControlCenterV4`，没有运行浏览器。
3. **`.claude/rules/prompt-prefix.md` 在当前稀疏检出中不存在（`glob` 无结果），规则原文未核实。** 只能从 `docs/kv-cache-guide.md:96` 和 `docs/architecture-v0.1.md:454` 读到“只追加、每轮会变的值只在最后一条消息”的引用。
4. **`requestfailed` 是否在所有取消路径上都能清掉 `replacing`，未核实。** 代码只清 `request === replacing` 的那一个请求；若某次导航既不 `requestfailed` 也不 `framenavigated`，`replacing` 会一直保留，之后同 host 的 access-control 错误都会被吞。属于低概率边界。

## 三、侧重检查

- **错误路径**：`page.url()` 解析有 `try/catch`，非法 URL 返回 false（`scripts/browser-page-errors.mjs:6-10`）；非主框架导航、导航请求失败后窗口关闭已有反向单测（`test/tooling/browser-page-errors.test.mjs:79-94`）。结论：这些路径基本覆盖。
- **不合规范/不可信输入**：`pageerror.message` 是页面 JS 可控字符串，当前只要在导航期间形如 `/本页host/... due to access control checks.` 就会被吞；恶意/错误页面可以借此隐藏一个同格式错误。测试脚本运行的是自有 fixture，风险低，但这是“按文字隐藏错误”的固有弱点。建议至少校验 error.name/stack 或改为基于请求事件关联。
- **安全**：新测试的两个 HTTP server 只绑定 `127.0.0.1`，跨源请求只访问本机随机端口，不涉及外部网络、密钥或生产数据。结论：没有发现安全边界扩大。
- **资源耗尽**：测试会创建两个 server、三个 page 和一个 context；正常路径会关闭，但存在上面第 7 条的泄漏窗口。没有无限重试或长时间阻塞。
- **不可撤销操作**：本次改动只涉及前端焦点和测试脚本，没有生产写操作、删除或迁移；`useLayoutEffect` 只影响 UI 焦点。
- **规则/文档与代码一致性**：`docs/incidents-and-gates.md:130`（I-97）说“页面卸载期间才发起的同源请求”，与 882eac20a 的“在途请求”证据不完全一致；文档说“不按文字一刀切”，但 `qualify-control-center-browser.mjs:1013` 仍有按文字放过的旧逻辑。这两处已列为上面的问题 3、4。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**按实际提交 `e4df6f6d..HEAD`：不会。** 13 个文件里只有 `apps/control-center/src/app/app-shell.tsx` 是产品代码，且只是把路由标题聚焦从 `useEffect` 改为 `useLayoutEffect`（`app-shell.tsx:100-104`），不涉及系统提示、工具定义、历史消息或遮盖结果；其余是测试/文档。模型请求仍然只在末尾追加，每轮变化值的位置没有变化。
**但按你给的 `dd5c48d..HEAD`：会。** 两点 diff 会删除 `packages/prompt-catalog/src/chat.ts` 的一条主动提示、删除 `memory.agenda.*` 模板并回退 `owner-profile-service` 的议程组装，这会改变系统提示/最后一条用户消息。这个 diff 不能当成本 PR 的改动使用。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**按实际 PR：不会。** 没有改提示词、遮盖、日期或排序逻辑。新测试里的随机端口、200ms 等待、`pageErrorFilter` 报告字段都只存在于测试报告，不进模型请求。
按给定基准的两点 diff 会回退议程排序和日期辅助函数，但那是无关 main 提交的回退，不是本 PR 的设计。

### 3. 有没有对应自动检查，反向用例真的会失败吗？

有，但完整程度不一致：
- `test/tooling/browser-page-errors.test.mjs:67-77` 的新反向用例在旧的“只按后缀”实现下会失败：旧的会吞掉 `crossOrigin` 和 `otherHost`，期望是三条都记录。
- `test/tooling/browser-page-errors.test.mjs:104-120` 的静态守卫在改动前会列出直接监听 `.on("pageerror")` 的文件，能反向失败；但它没有“临时放一个违规文件必须失败”的夹具，且漏掉 `waitForEvent`。
- `scripts/test-browser-page-errors-browser.mjs` 的正反用例如果过滤缺失或过宽会失败；但 Chromium/Firefox 可能没有真实事件，仅有 WebKit 强制复现。
- `qualifyStartupFocusKept` 是针对焦点的真浏览器用例，作者称旧 `useEffect` 下会失败；仓库里没有对应的提交前反向夹具，我也没有运行，无法确认。
- `afterSequence: 0` 本身只是测试修正，没有专门的“后端不接受 0 就失败”的自动检查，但契约和持久化校验确认 0 合法。
- 另外，`test/tooling/browser-page-errors.test.mjs` 没有被任何 `npm run check:...` 步骤点名；它由完整 tooling/coverage 测试运行，不在快速 `npm run check` 的 51 步里。事故记录写“已落门槛”时，最好区分这两个门。

### 4. 每个新值/字段两端都能接受吗？

- `afterSequence: 0`：产生于 `scripts/test-control-center-v4.mjs:80`；网关契约 `packages/gateway-contracts/src/contracts.ts:117` 和 `packages/gateway-contracts/src/thread-contracts-v3.ts:309` 都是 `integer(0)`，持久化 `packages/persistence-sqlite/src/sqlite-thread-operations.ts:1497,1557` 要求 `Number.isSafeInteger` 且 `>= 0`。两端接受。
- `pageErrorFilter`：产生于 `scripts/qualify-control-center-browser.mjs:338,1035`；使用方 `scripts/ci/browser.mjs:19-58` 的 `browserCounts` 只读固定字段，忽略额外字段；报告聚合按文件收集，没有发现严格 schema 拒绝。两端接受。
- `startupFocus`：产生于 `scripts/test-control-center-v4.mjs:154,256`；只被塞进报告，没有下游严格校验。接受。
- 静态守卫的 `allowed` 路径：`scripts/../` 相对路径由 `path.relative` 生成，和实际文件名 `browser-page-errors.mjs`、`ci/browser-observation.mjs`、`test-browser-page-errors-browser.mjs` 对得上。
- `webkitBlockedFetchMessage` 的 `host`：只在 `scripts/browser-page-errors.mjs:4-7` 和测试的 `blockedHosts` 使用；两端都假设消息形如 `/host/path due...`。这个格式假设是最大未核实点。

**总体结论**：按真实 PR 提交，代码改动方向合理，主要风险不是“改了模型内容”，而是过滤规则仍是基于文本和 host 的近似、旧文字过滤没有一起收紧、以及新浏览器用例没有覆盖 882 记录的“在途请求”场景。按你给的基准直接合并则不可接受，必须先修正对比基准。
