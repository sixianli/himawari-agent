## 结论摘要

合并本身基本按作者所述执行：`scripts/browser-page-errors.mjs` 及 `qualify-control-center-browser.mjs`、`test-control-center-v4.mjs` 等冲突文件确实取了 main（PR 471）的版本；`docs` 的 I-101 门槛也确实改成了 PR 471 的用例名。但我确认有两类问题：合并丢掉了一个原有门槛，且事故清单出现重复/过时记录。

---

## 读代码证实的发现

### 1. 中 — 合并丢掉了“启动浏览器的脚本必须调用 watchPageErrors/collectPageErrors”的门槛

- 位置：`test/tooling/browser-page-errors.test.mjs:164-167`，`scripts/browser-page-errors.mjs:50-60`
- 问题：现在的“浏览器测试脚本一律经 browser-page-errors.mjs 收页面报错”只检查有没有“直接监听 pageerror”，并不检查浏览器脚本是否真的调用了收集函数。一个启动浏览器、但完全不收页面报错的脚本可以通过。

  证据（当前实现）：

  ```js
  // test/tooling/browser-page-errors.test.mjs:164-166
  it("[webkit-teardown] 浏览器测试脚本一律经 browser-page-errors.mjs 收页面报错", async () => {
    const scripts = path.resolve(import.meta.dirname, "../../scripts");
    expect(await findDirectPageErrorListeners(scripts, allowedDirectListeners)).toEqual([]);
  ```

  ```js
  // scripts/browser-page-errors.mjs:54-58
  if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;
  ...
  if (directPageErrorListener.test(await readFile(file, "utf8"))) offenders.push(relative);
  ```

  合并前 `63e59f` 的用例还包含这条（来自 `git diff 63e59f..742e10b -- test/tooling/browser-page-errors.test.mjs` 中被删除的代码）：

  ```js
  it("[webkit-teardown] 启动浏览器的脚本都调用 watchPageErrors，除非明确列为只观察或只截图", () => {
    const missing = browserSources().filter((path) => {
      const source = readFileSync(join(repositoryRoot, path), "utf8");
      return (
        /\.launch\(/u.test(source) &&
        !OBSERVE_ONLY.has(path) &&
        !/watchPageErrors|collectPageErrors/u.test(source)
      );
    });
    expect(missing).toEqual([]);
  });
  ```

  合并后确实存在“启动浏览器但既没用 `watchPageErrors` 也没用 `collectPageErrors`”的脚本：
  - `scripts/demo/record-email-decision.mjs:71`：`const browser = await chromium.launch(...)`
  - `scripts/render-brand-assets.mjs:25`：`const browser = await chromium.launch(...)`
  - `scripts/test-control-center-visual-v4.mjs:257`：`const browser = await chromium.launch({ channel: "chrome" })`

  这三个在旧门槛里被明确列进 `OBSERVE_ONLY`，所以当前没有实际违规；问题是旧门槛能拦住“以后新增的浏览器检查脚本完全不收页面报错”，现在拦不住。用例名和 I-101 的文字“一律经 browser-page-errors.mjs 收页面报错”也高于实际检查能力。

- 建议：恢复 `/.launch\(/` + `watchPageErrors|collectPageErrors` 的断言，并把上述三个截图/记录脚本显式放进允许名单；或者把用例名和 I-101 描述改成“不直接监听 pageerror”。

### 2. 低 — I-97 与 I-101 重复记录同一 WebKit 事故，I-101 根因已过时

- 位置：`docs/incidents-and-gates.md:130`（I-97）、`docs/incidents-and-gates.md:136`（I-101）
- 问题：PR 471 的提交 `1049b9122` 加的是 **I-97**，PR 488 的提交 `8e6d6e1e9` 加的是 **I-101**。合并后两行同时存在，但描述的是同一类 WebKit 换页误报。

  证据：
  - I-97（`:130`）写“已确认……三个原因叠在一起”，并给出 `test/tooling/browser-page-errors.test.mjs`、`scripts/test-browser-page-errors-browser.mjs`、`qualifyStartupFocusKept` 门槛。
  - I-101（`:136`）仍写“部分确认……为什么从 12:27 起稳定出现（之前能过）没有查清”，并且说“这个脚本和另外 6 个浏览器检查脚本没有用它”；合并后当前树里除允许名单外，所有浏览器检查脚本都已改用 `collectPageErrors`/`watchPageErrors`，这句话已不成立。

  作者说法“main 上刚合入的 PR 471 也修了 WebKit 换页误报（I-101）”与代码/提交记录不一致：PR 471 对应的是 I-97。

- 建议：把 I-101 合并进 I-97，或明确标注 I-101 为重复/被取代，并更新 I-101 的根因和现状；作者说明里的 I-101 应改为 I-97。

### 3. 低 — `test/qualification/` 不再被扫描

- 位置：`test/tooling/browser-page-errors.test.mjs:165`
- 问题：合并前 `browserSources()` 扫描 `scripts/*.mjs` 和 `test/qualification/*.mjs`；合并后只扫描 `scripts/`。`test/qualification/sandbox-production-browser.mjs:18` 仍有：

  ```js
  page.on("pageerror", (error) => errors.push(error.message));
  ```

  这个文件在旧门槛里本来就在 `OBSERVE_ONLY` 中，所以不是当前失败点；但整个 `test/qualification/` 目录从此不再受“不得直接监听 pageerror”的门槛约束。

- 建议：如果保留“一律”语义，把 `test/qualification` 加入扫描并显式豁免该文件；否则在用例名和 I-101 中说明只覆盖 `scripts/`。

### 4. 低 — I-101 门槛写“全部 `.mjs`”，代码实际扫描 `.mjs/.js/.ts`

- 位置：`docs/incidents-and-gates.md:136`，`scripts/browser-page-errors.mjs:54`
- 证据：文档写“扫描 `scripts/` 下全部 `.mjs`”，代码是：

  ```js
  if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;
  ```

- 建议：把文档改成 `.mjs/.js/.ts`。

---

## 推测 / 未核实

- **未核实**：作者说 `vitest browser-page-errors 12 通过`、`check:incident-gates`、`lint`、`format:check` 通过。我没有运行测试，只确认了该文件确实有 12 个 `it`（第 40、49、61、73、85、95、103、112、120、143、164、169 行），以及 `check:incident-gates` 只校验路径存在、不校验用例名是否存在（`scripts/check-incident-gates.mjs:65-70`）。
- **推测**：`watchPageErrors` 在 `framenavigated` 时清掉 `replacing`（`scripts/browser-page-errors.mjs:28-30`），如果 WebKit 的 pageerror 在导航完成之后才送达，同源误报可能重新被记录。这是真实浏览器时序问题，本机无 WebKit，无法证实；作者称 100 多次 0 失败。
- **未核实**：仓库为稀疏检出（约 63% 文件），`scripts/` 下未检出的文件我无法用 grep 覆盖；当前可见文件中直接监听 `pageerror` 的只有允许名单里的 `scripts/browser-page-errors.mjs`、`scripts/ci/browser-observation.mjs`、`scripts/test-browser-page-errors-browser.mjs`。

---

## 侧重检查

- **不可信输入/错误路径**：`webkitBlockedFetchMessage` 有首尾锚定，`new URL(page.url())` 抛错时返回 `false`（照常记录），不会静默放过；`expectedOfflineTransportError` 要求完整后缀和主机前缀。未发现注入或绕过。
- **资源耗尽**：`qualifyPageErrorFilter` 只在本机 `127.0.0.1` 的临时端口起两个 HTTP server，`finally` 里 `context.close()` + `server.closeAllConnections()`；`/slow` 的 3 秒定时器在连接关闭时清理。未见明显泄漏。
- **安全**：新增报告字段 `pageErrorFilter`、`startupFocus` 只包含本机夹具页面的错误文本和元素信息；没有外部网络、密钥或不可信 HTML 执行。
- **不可撤销操作**：本次增量没有删除、覆盖或迁移生产数据。
- **规则/文档/代码一致性**：发现 I-97/I-101 重复、I-101 根因过时、用例名和文档“一律”表述超过实际检查范围。
- **取值消费端**：新增的 `pageErrorFilter` 写进 `browser.json`；消费端 `scripts/ci/browser.mjs:20-59` 的 `browserCounts` 只读取命名过的字段，不拒绝未知字段，`browserReportFiles` 只按文件类型收集，未发现会拒绝新字段的地方。`startupFocus` 嵌在 `v4Journeys` 内，未被其他代码校验。
- **I-101 事故 id**：在清单内唯一，`check:incident-gates` 的结构检查可通过；`test/tooling/browser-page-errors.test.mjs` 与 `scripts/test-run-approval-browser.mjs` 两个路径都存在。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。增量 `63e59f..742e10b` 只动浏览器验收脚本、`app-shell.tsx` 的焦点副作用和事故文档；基础 PR 的非合并部分只动 CI、复核工具和请求体解码，没有改系统提示、工具定义、历史消息或产品出口遮盖。发给模型的内容仍然只在末尾追加，每轮变化的值仍放在最后一条消息里。依据：[prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules)。

2. **同一段文字会不会在不同请求里变成不同字节？**
   产品侧未发现。新增的页面报错过滤只依据当前页面 URL 和错误文本，规则确定；`findDirectPageErrorListeners` 对结果排序，测试输出确定。基础 PR 里 `scripts/model-review/gateway.mjs:590,623,770`、`scripts/model-review/opencode-review.mjs:884,908,2195,2456`、`test/tooling/opencode-review.fixtures.mjs:64` 的 `setEncoding`/`Buffer.concat` 是在**接收**请求体和子进程输出时修正 UTF-8 解码，消除 U+FFFD 随机截断，不会让发给模型的内容变成不同字节。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：`test/tooling/browser-page-errors.test.mjs` 共 12 个用例；第 143-162 行在临时目录放入 `page.on("pageerror", ...)` 和 `page.once("pageerror", ...)`，如果检测正则失效，该反向用例会失败；`scripts/test-browser-page-errors-browser.mjs` 在真实浏览器里核对“同源换页放过、跨源照常记录”。但作者说的“把 `test-run-approval-browser.mjs` 换回直接监听”是手工反向验证，不是常驻测试；被删掉的“启动浏览器必须调用收集函数”也没有自动检查了。实际测试未运行，以上只核实了测试结构。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `pageErrorFilter`：只在 `scripts/qualify-control-center-browser.mjs:338` 产生、`:1034` 写入 `browser.json`；消费端 `scripts/ci/browser.mjs:20-59` 不校验未知字段，可接受。
   - `startupFocus`：只在 `scripts/test-control-center-v4.mjs:162,256` 产生并嵌进 `v4Journeys`，没有其他校验者。
   - `allowedDirectListeners`：只在测试内部使用，名称与 `scripts/` 下相对路径一致（含 `ci/browser-observation.mjs`）。
   - I-101：清单内唯一，门槛引用的两个路径都存在，`check-incident-gates` 的结构检查能通过；但文档把扫描范围写成“全部 `.mjs`”与代码 `.mjs/.js/.ts` 不一致，且与 I-97 重复。
   - 未发现类似 [I-73](../../docs/incidents-and-gates.md#incidents) 那种“清单里产生、后端校验拒绝”的两端不一致。
