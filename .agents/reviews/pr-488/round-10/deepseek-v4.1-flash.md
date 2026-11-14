## 结论

本轮（`edee0632..6409606d0`）改动集中在测试工具、资格脚本和事故文档，**未发现阻断级或中高危问题**；作者的核心说法与代码一致：`sandbox-production-browser.mjs` 确实改用了 `collectPageErrors`，资格目录的两条扫描确实清空了允许名单，启动扫描确实从“出现函数名”收紧为“出现调用”。下面是低严重度的残留问题、未核实项和四个必答问题。

---

## 读代码证实的发现（按严重度）

### 低：门槛仍是原始文本匹配，注释/字符串/自定义同名函数都能满足“已调用”
- 文件:行：`scripts/browser-page-errors.mjs:72-76`；`test/tooling/browser-page-errors.test.mjs:194-209`
- 问题：本轮把“只 import 不调用”修掉了，但判定仍是整份源码的正则搜索。`// collectPageErrors(page)`、字符串里的同名文字，或本地 `function collectPageErrors() {}` 都会让文件通过，实际没有接入任何页面错误收集。反向夹具只覆盖了 import-only 与 `launchPersistentContext`，没有覆盖这些同类绕过。
- 证据：
  ```js
  // scripts/browser-page-errors.mjs:72
  if (
    /\.launch(?:PersistentContext|Server)?\(/u.test(source) &&
    !/\b(?:watchPageErrors|collectPageErrors)\s*\(/u.test(source)
  )
  ```
  测试新增夹具只到这一种：
  ```js
  // test/tooling/browser-page-errors.test.mjs:194
  await writeFile(
    path.join(root, "imported.mjs"),
    'import { collectPageErrors } from "./browser-page-errors.mjs";\nawait chromium.launch();\n',
  );
  ```
  另外，`browser-page-errors.mjs` 自身的第 73 行正则字面量就包含 `.launch(?:...` 的文本，会命中自己的启动扫描；现在仅因它同时定义了 `watchPageErrors(` / `collectPageErrors(` 才没被自己判为违规。
- 建议：至少加 `commented.mjs`（只出现注释/字符串）和 `defined.mjs`（只定义同名函数）两个反向夹具；若要保持轻量，先去掉注释和字符串再做匹配，或改成“从 `browser-page-errors.mjs` 导入并调用”的双条件检查。

### 低：`.launchServer(` 分支没有任何测试，`.launchPersistentContext(` 只有负例
- 文件:行：`docs/incidents-and-gates.md:130`；`test/tooling/browser-page-errors.test.mjs:198-209`
- 问题：文档声称识别 `.launch(`、`.launchPersistentContext(`、`.launchServer(`，但测试只验证了 `chromium.launchPersistentContext` 会被报出，没有任何 `launchServer` 用例，也没有“调用收集函数后应放行”的正例。若以后误删 `Server` 分支或收窄正则，现有测试不会失败。
- 证据：
  ```js
  // test/tooling/browser-page-errors.test.mjs:199
  await writeFile(
    path.join(root, "persistent.mjs"),
    "await chromium.launchPersistentContext(dir);\n",
  );
  ```
  文档：
  > 启动了浏览器（`.launch(`、`.launchPersistentContext(`、`.launchServer(`）却没有调用 `watchPageErrors(` 或 `collectPageErrors(` 的脚本也拒绝
- 建议：补 `launchServer` 的违规夹具，以及 `launchServer(...); collectPageErrors(page);` 的放行夹具。

### 低：启动正则在 `.launch` 与括号之间不容忍空白，与调用正则不一致
- 文件:行：`scripts/browser-page-errors.mjs:73-74`
- 问题：调用判定允许 `\s*\(`，启动判定却要求 `.launch(` 紧邻。合法写法 `chromium.launch ({ ... })` 会被漏判，门槛静默失效。现有脚本都写成 `.launch(`，所以目前没有实际误判。
- 证据：
  ```js
  /\.launch(?:PersistentContext|Server)?\(/u.test(source) &&
  !/\b(?:watchPageErrors|collectPageErrors)\s*\(/u.test(source)
  ```
- 建议：改成 `\.launch(?:PersistentContext|Server)?\s*\(`，并补一个小夹具。

### 低：“文件里调用过一次”不等于“每个 page 都被收集”（既有残留）
- 文件:行：`scripts/browser-page-errors.mjs:72-76`；`scripts/check-layout-audit.mjs:525-526, 664-666`
- 问题：门槛只看文件级文本，任意一处调用即可放行整个文件。现有 `check-layout-audit.mjs` 的 `selfTest` 页面就没有 `watchPageErrors`，只有主审计页面有；这类文件仍会通过扫描。不是本轮引入，但本轮修改的正是“调用判定”，所以影响仍存在。
- 证据：
  ```js
  // scripts/check-layout-audit.mjs:525
  async function selfTest(browser) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  ```
  ```js
  // scripts/check-layout-audit.mjs:664
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  watchPageErrors(page, (error) => problems.push(`${where}: PAGE_ERROR ${error.message}`));
  ```
- 建议：把收集动作封装成创建页面时的统一入口，或至少接受这是静态门槛的已知边界并写进 I-97 的门槛描述。

### 低（推测性影响）：资格脚本从“任意 pageerror 都算失败”变成“放过一类换页期 access-control 错误”
- 文件:行：`test/qualification/sandbox-production-browser.mjs:18,140`；`scripts/browser-page-errors.mjs:7-18,31-34`
- 问题：该脚本现在用 `collectPageErrors`，会过滤“主框架换页期间、同主机同端口的 `/… due to access control checks.`”。代码行为已确认；但该脚本用的是 Chromium，而这条文案是 WebKit 的，Chromium 正常不会产生，因此实际漏报概率很低。严格说，资格脚本原先“任何页面错误都让 `assert.deepEqual(errors, [])` 失败”的保证，变成了“除这一窄类之外都失败”。
- 证据：
  ```js
  // scripts/browser-page-errors.mjs:9
  function blockedSameOriginFetch(page, message) {
    ...
    return url.port !== "" && url.host === host;
  }
  ```
  ```js
  // scripts/browser-page-errors.mjs:31
  page.on("pageerror", (error) => {
    if (replacing && blockedSameOriginFetch(page, error.message)) return;
    onError(error);
  });
  ```
- 建议：若想保持资格脚本的严格性，可直接用 `watchPageErrors` 并在 Chromium 下不启用过滤；或加注释/测试说明该过滤在 Chromium 上不会命中，避免以后误以为它被完全“无过滤”保护。

---

## 推测 / 未核实

- **无法运行 vitest、check:incident-gates、format:check、biome**：工具限制只允许读文件与 git 命令，环境里也只允许 git 子命令，因此作者“13 通过、各项检查通过”的结论未独立执行验证。测试文件里确实是 13 个 `it`（`test/tooling/browser-page-errors.test.mjs`），与“13 通过”数量一致。
- `.agents/reviews/pr-488/round-9/` 的 judgments、verdicts 不在稀疏检出里，`git show` 对该记录路径被拒，无法核对“第 3 条证据目录也被扫描判为可以更好，不改”的原话。
- `launchServer` 在仓库中没有任何实际使用，无法用现有脚本验证它是否会被误判。
- 历史资格证据 `test/qualification/evidence/.../frozen-inputs.json` 里保留了 `sandbox-production-browser.mjs` 的旧 SHA-256；修改该文件后这些记录与当前树不再一致。我未找到任何脚本会重新校验这些冻结摘要，因此判断为历史记录自然漂移，不是运行门槛；是否有仓库外流程重跑该证据未核实。

---

## 侧重检查

- **错误路径**：`findUnwatchedBrowserLaunches` / `findDirectPageErrorListeners` 的 `readFile` 失败会直接让测试失败，不会静默放行；`sandbox-production-browser.mjs` 的 `finally { await close(); }` 保持不变；`collectPageErrors(page, errors = [])` 每次调用生成新数组，不存在跨用例共享状态。未见新增吞错路径。
- **不合规范/不可信输入**：扫描器只把仓库源码当文本读取，不执行、不拼 shell；`blockedSameOriginFetch` 的 URL 解析在 `try/catch` 内。资格脚本的输入来自本机夹具，本轮没有新增外部输入。
- **安全**：没有新增网络、密钥、权限或用户数据处理。
- **资源耗尽**：扫描会递归进入 `test/qualification/evidence`，但只读取 `.mjs`/`.js`/`.ts`，当前没有大文件或死循环；测试临时目录用 `mkdtemp` 并在 `finally` 中 `rm`。
- **不可撤销操作**：本轮只改源码和文档；唯一“副作用”是历史证据中的源码摘要变旧（见上）。
- **规则/文档与代码一致性**：I-97 行已同步为 `.launch(`、`.launchPersistentContext(`、`.launchServer(` 且要求实际调用收集函数；仓库中已无残留的 `qualificationObserveOnly` 或“只做观察的 sandbox”说明；没有其它地方再引用 I-101。`check-incident-gates.mjs:13-70` 只按 `|` 拆列并用带斜杠的反引号路径做存在性检查，新增文字不含 `|`，新增反引号内容也不构成仓库路径，因此文档改动不会触发该门槛的路径校验错误。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本次增量只改 `scripts/browser-page-errors.mjs`、`test/tooling/browser-page-errors.test.mjs`、`test/qualification/sandbox-production-browser.mjs` 和 `docs/incidents-and-gates.md`，没有触及系统提示、工具定义、历史消息、资料块或遮盖。`collectPageErrors` 返回的 `string[]`、扫描正则和事故文档文本都不会进入模型请求。因此发给模型的内容仍只在末尾追加，每轮变化的值仍不在请求头。[prompt-prefix 规则第 4 条](../../.claude/rules/prompt-prefix.md#append-only)

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。改动没有涉及模型内容的序列化，也没有依赖前后文的遮盖或带时间的字段。扫描结果本身是确定性的：`findDirectPageErrorListeners` 和 `findUnwatchedBrowserLaunches` 都对 `offenders` 做 `sort()`（`scripts/browser-page-errors.mjs:60,78`）；`collectPageErrors` 的数组顺序取决于浏览器事件顺序，但它只用于测试断言和失败报告，不是模型可见内容。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，且已接入 CI：`ci/policy.json:20` 的 `policy` 检查运行整个 `tooling` 项目，`ci/policy.json:196-199` 的 tooling include 覆盖 `test/tooling/**/*.test.mjs`，所以该测试会在 policy 作业里执行。
反向用例确实能失败：
- `imported.mjs` 只 import 不调用，旧正则 `!/watchPageErrors|collectPageErrors/` 会把它当成“已收集”而放行，新用例期望它出现在违规列表，因此旧实现会失败；
- `persistent.mjs` 使用 `launchPersistentContext`，旧的 `/\.launch\(/` 不会匹配它，新用例期望它违规，旧实现同样会失败。
未覆盖的空洞是 `.launchServer(` 分支，以及“注释/字符串/自定义同名函数”这类绕过（见上面的低问题）。

**4. 每个改动值的使用方都能接受吗？**
逐个核对如下：
- `collectPageErrors(page)` 的返回值：产生处 `scripts/browser-page-errors.mjs:37-39` 返回 `string[]`；使用处 `test/qualification/sandbox-production-browser.mjs:18`、`:140` 的 `assert.deepEqual(errors, [])` 和 `:164` 的 `JSON.stringify({ ..., errors, ... })` 都接受字符串数组，与原来的 `errors.push(error.message)` 完全一致。
- 新 import `../../scripts/browser-page-errors.mjs`：文件存在；`qualify-production.mjs:85` 只在 `--browser-output` 且 `darwin` 时动态导入该资格脚本，运行在完整源码树中（`prepare-composition-source.py` 使用完整 source），不是只含 `probe-source` 的包内路径；未见断链。
- `new Set()` 空允许名单：两个扫描函数只调用 `.has(relative)`，空集合是合法输入。
- 新调用正则：只被 `findUnwatchedBrowserLaunches` 使用；我逐个核对了 `scripts/` 与 `test/qualification/` 下所有 `.launch` 出现处（`check-layout-audit.mjs`、`test-execution-chain-browser.mjs`、`qualify-control-center-browser.mjs`、`test-control-center-v4.mjs`、`render-brand-assets.mjs` 等），要么调用了收集函数，要么在截图/录像允许名单，未发现现有脚本被误判。
- 文档行：使用方 `scripts/check-incident-gates.mjs` 只校验列结构、状态、次数和反引号内带斜杠的仓库路径；新增文字未引入 `|`，也未引入新的路径 token，`I-97` 的 `count=3` 与状态 `已落门槛` 合法，`I-101` 已无其它引用。该行改动可被现有检查接受。
