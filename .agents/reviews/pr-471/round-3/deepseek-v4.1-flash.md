# 复核结论

## 一、按严重度排列的问题

### 1. 中 — 提交里混入了两个本机调试脚本，作者说法里没有提到

**文件：** `scripts/.dep-tmp.mjs:1-17`、`scripts/.dep2-tmp.mjs:1-21`

**问题：** 本轮提交 `ef38009` 新增了两个以 `.` 开头的临时脚本，不在作者列出的三项修改里，内容是本机复现用的调试代码：写死仓库绝对路径、`spawn` 测试服务器、用绝对路径 `import` 仓库外文件、循环跑 Playwright。它们没有被任何脚本或 CI 引用，属于误提交。

**证据（我亲自读到的行）：**

```js
// scripts/.dep-tmp.mjs
3: const repo = "/home/user/himawari-agent";
5: const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], { cwd: repo, ... });
```

```js
// scripts/.dep2-tmp.mjs
3: const repo = "/home/user/himawari-agent";
15: if (mode === "route") await p.route("**/api/control-center/v1/config", ...);
```

提交信息与 diff 都显示这两个文件在 `6884ab7..ef38009` 新增；作者的说法只列了 `scripts/test-browser-page-errors-browser.mjs`、`test/tooling/browser-page-errors.test.mjs`、`docs/incidents-and-gates.md` 三项，与代码不一致。

**建议：** 从该 PR 删除这两个文件（必要时把 `.dep*-tmp.mjs` 加入 `.gitignore`），并检查提交时是否漏看了 `git add .`。

---

### 2. 中 — 新增的 WebKit「在途请求必须不报」断言与既有事故记录冲突，可能重新引入「时过时不过」

**文件：** `scripts/test-browser-page-errors-browser.mjs:73-78`、`:129-131`

**问题：** 场景 `same-origin-fetch-in-flight-while-reloading` 现在把 `webkitReports` 固定为 `false`，并在 WebKit 上断言原始错误里不能出现页主机：

```js
73:      {
74:        name: "same-origin-fetch-in-flight-while-reloading",
75:        target: pageOrigin,
76:        start: "before-reload",
77:        webkitReports: false,
78:      },
...
129:    if (engine !== "webkit") continue;
130:    if (entry.rawBlocked.includes(entry.expectedHost) !== entry.webkitReports)
131:      throw new Error(`PAGE_ERROR_FILTER_WEBKIT_BEHAVIOR_CHANGED:${entry.name}`);
```

但 `882eac20a` 的提交说明记录的是相反现象：WebKit 对「还在途的同源 fetch」在 20 轮 reload 中 3 轮报同类错（约 15%），且「请求在途是这些用例的常态」。I-97 也自己写明「和 882eac20a 说明里『在途请求』的推断不同」。如果 882 的观测对这唯一的 pending `/slow` 请求同样成立，这条新断言会让 webkit CI 以约 15% 的概率变红；作者只跑了 5 次，在 15% 概率下「5 次全过」本身约有 44% 概率，不能排除。

这不是说断言一定错（作者声称 WebKit 26.5 上 5 次通过，我未运行验证），而是它把修复工作从「过滤误报」变成了「要求浏览器复现一次偶发内部行为」，与本次要解决的稳定性目标相冲突。

**建议：** 真浏览器用例只断言过滤契约（换页期间同源错误被放过、跨源保留、无端口不放行），不要硬断言 WebKit「必须报/必须不报」；若坚持锁定该行为，至少多轮循环并保存原始消息作为证据，且失败时不要把整个 webkit 任务判红。**（WebKit 实际是否偶发：未核实/推测）**

---

### 3. 低 — I-97 对守卫覆盖范围的描述与代码不一致

**文件：** `docs/incidents-and-gates.md:130`；`test/tooling/browser-page-errors.test.mjs:136-140`；`scripts/ci/browser-observation.mjs:84`；`scripts/test-browser-page-errors-browser.mjs:82`

**问题：** 文档写「`scripts/` 下除收集函数外任何直接监听 `pageerror` 的脚本都拒绝」，但扫描测试的允许名单里除收集函数外还有两个直接监听 `pageerror` 的文件：`ci/browser-observation.mjs`（第 84 行 `page.on("pageerror", ...)`，只作证据）和 `test-browser-page-errors-browser.mjs`（第 82 行 `tab.on("pageerror", ...)`，用于对比 raw/filtered）。这不是功能错误，但「各门槛的实际覆盖范围」的表述比实际更绝对。

**证据：**

```js
136:  const allowed = new Set([
137:    "browser-page-errors.mjs",
138:    "ci/browser-observation.mjs",
139:    "test-browser-page-errors-browser.mjs",
140:  ]);
```

```js
// scripts/ci/browser-observation.mjs
84:    page.on("pageerror", (error) => {
```

**建议：** 把 I-97 改成「除收集函数和两处有意的例外（证据记录、raw/filtered 对比）外」，并写清这两个例外的理由，避免后续按文档误判。

---

### 4. 低 — 关键新检查缺少反向夹具

**文件：** `test/tooling/browser-page-errors.test.mjs:134-150`；`scripts/qualify-control-center-browser.mjs:1013-1028`

**问题：** 新增的守卫正则本身有正/反向单测（可确认会失败），但「扫描整个 `scripts/` 目录」这条用例只断言 `offenders === []`，没有注入一个违规文件的夹具；如果 `readdir`、`allowed` 或路径拼接失效，它会静默通过。同样，断网阶段收紧后的 `expectedOfflineBrowserError`（要求 `/<fixtureHost><四个路径>`）没有独立单测，写错主机/路径时只有真浏览器阶段才会发现。

**证据：**

```js
143:  for (const entry of entries) {
...
148:    if (directPageErrorListener.test(await readFile(file, "utf8"))) offenders.push(relative);
149:  }
150:  expect(offenders).toEqual([]);
```

```js
1014:    const expectedOfflineBrowserError = (error) =>
1015:      error.endsWith(" due to access control checks.") &&
1016:      [ ... ].some((path) => error.startsWith(`/${fixtureHost}${path}`));
```

**建议：** 扫描用例临时写入一个含 `page.on("pageerror")` 的文件并断言被报告；把离线错误判定抽成可单测函数，补「错误主机」「错误路径」「正确主机+路径」三类用例。

---

## 二、推测 / 未核实

- **格式检查风险（推测）：** `.dep-tmp.mjs` / `.dep2-tmp.mjs` 行宽远超 `biome.json` 的 `lineWidth: 100`。如果 Biome 扫描隐藏文件，`npm run format:check` 会失败（`biome.json` 的 `includes` 是 `**`，没有显式排除）。我没有运行检查，未核实。
- **`webkitReports: false` 的可观测性（推测）：** 若 WebKit 的错误在本页 `waitForTimeout(200)` 之后或 `tab.close()` 之后才到，`raw` 不会包含它，断言会「空过」，即测试通过但没有真正证明行为。
- **`afterSequence: 0` 的端到端行为：** 我核对了契约和夹具（见下），但没有实际运行浏览器。

---

## 三、侧重检查

- **错误路径 / 资源耗尽：** 读了 `scripts/test-browser-page-errors-browser.mjs:25-38`、`:116-119`。`server.close()` 后立即 `closeAllConnections()` 会触发 `/slow` 响应的 `close`，从而 `clearTimeout`；`finally` 里先关 context 再关两个服务器，正常路径和 `other` 监听失败的回滚路径都有清理。未发现泄漏；`closeAllConnections` 需要 Node ≥18.2，项目要求 ≥22.22.3，满足。**结论：该改动正确。**
- **不可信输入 / 安全：** 读了 `scripts/browser-page-errors.mjs:1-12`。错误消息来自浏览器，正则只接受 `/主机/路径 ...`，页面地址解析失败时返回 `false`（保守记录），主机与端口比较不涉及协议（文档已承认残余风险）。**结论：没有新增可被页面内容利用的放行路径（测试夹具场景，不是产品代码）。**
- **误提交 / 仓库卫生：** 见问题 1，`scripts/.dep*.mjs` 含写死的外部绝对路径和 `spawn`，是本次最明确的可疑项。
- **不可撤销操作：** 改动只涉及测试脚本、UI 焦点和文档，没有删除/覆盖用户数据的操作。
- **规则、文档与代码一致性：** I-97 的端口残余风险、断网四路径、焦点用例与代码一致；守卫例外描述不一致（问题 3）；提交内容与作者说法不一致（问题 1）。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会，且本改动根本不涉及模型请求。** 本次 diff 的文件只有 `scripts/`、`test/tooling/`、`docs/incidents-and-gates.md` 和 `apps/control-center/src/app/app-shell.tsx`（浏览器 UI 的 `useEffect`→`useLayoutEffect`），没有任何提示词、工具定义、历史组装、出口遮盖相关文件被改。因此「只在末尾追加」「每轮变化的值放最后一条消息」这些性质未被触碰，既不改善也不破坏。我没有运行 `check:prompt-prefix`，这一点未核实。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 改动没有修改任何序列化、遮盖或模型请求字段。新增的 `pageErrorFilter`/`sameOrigin`/`expectedHost`/`webkitReports` 只进入浏览器测试报告；其中的主机列表用了 `.sort()`，同一次运行内确定，端口跨运行变化，但这些值都不进入模型请求。没有新增时间字段或无序集合到模型输入。

### 3. 有没有对应的自动检查，反向用例会真的失败吗？

- 守卫正则：`test/tooling/browser-page-errors.test.mjs:114-132` 有 5 个正向、3 个反向写法；该文件属于 `tooling` 测试项目（`ci/policy.json:193-197`），在 `policy`/`coverage` 里跑。去掉 `prependOnceListener` 或把 `waitForEvent` 算进去，测试会失败——**这一点成立。**
- 扫描整个 `scripts/` 的用例没有注入违规文件的夹具，逻辑坏掉时会空过（问题 4）。
- 真浏览器断言在 `qualify-control-center-browser.mjs:338` 调用并于 `:129-131` 抛错，确实接入了 browser CI；但 `webkitReports: false` 是经验性断言，且没有反向夹具（问题 2）。
- `closeAllConnections`/清计时器、断网错误收紧均无专门单测。
- **结论：** 单元级反向用例有效；端到端和清理逻辑的覆盖不完整。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐个核对：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `sameOrigin` / `expectedHost` / `webkitReports` | `test-browser-page-errors-browser.mjs:107-109` | 同文件 `:121-131`，返回 `:133`，写入报告 `qualify-control-center-browser.mjs:1036` | 只用在本模块断言和报告；`scripts/ci/browser.mjs:19-59` 的 `browserCounts` 只读已知键，不拒绝额外字段，**可接受** |
| `pageErrorFilter`（报告新字段） | `qualify-control-center-browser.mjs:1036` | `scripts/ci/browser.mjs:100-104` 读 `browser.json` 后调 `browserCounts` | 无严格 schema，额外字段被忽略，**可接受** |
| `directPageErrorListener` | `browser-page-errors.test.mjs:114-115` | 同文件 `:125`、`:131`、`:148` | 测试内部常量，**可接受** |
| `afterSequence: 0` | `test-control-center-v4.mjs:80` | 夹具 `control-center-browser-server.mjs:1969`（`sequence > afterSequence`）；契约 `packages/gateway-contracts/src/thread-contracts-v3.ts:309`（`integer(0)`） | 契约允许 0；`messageWatermark` 从 0 递增到 1（`:2070`、`:2099-2103`），所以返回 1 条消息，**可接受** |
| `fixtureHost` 前缀 | `qualify-control-center-browser.mjs:1013` | 同文件 `:1021` 对比 WebKit 错误串 | 与 `test-browser-page-errors-browser.mjs:4` 的格式假设一致；比原条件更严，但据 882 的事故记录错误串确实以 `/主机` 开头，**可接受（未跑真浏览器）** |
| `.dep-tmp.mjs` / `.dep2-tmp.mjs` | 本轮新增 | 无任何引用 | **不应存在** |

---

## 五、对作者说法的核对

- 「场景改用显式字段 `sameOrigin` / `expectedHost` / `webkitReports`」：**属实**（`:107-109`）。
- 「WebKit 上四种情况都断言（前三种必须报、卸载前已发出的请求必须不报）」：**代码属实**（`:129-131`），但第四条的合理性见问题 2，未核实。
- 「服务器关闭时 `closeAllConnections`，慢请求在连接关闭时清计时器」：**属实**（`:25-30`、`:35-36`）。
- 「守卫正则加 `prependOnceListener` 并抽成常量，补正向五种、反向三种」：**属实**（`:114-132`）。
- 「I-97 写明端口规则残余风险、各门槛实际覆盖范围」：**残余风险属实**，但覆盖范围表述与 allowlist 不一致（问题 3）。
- 作者说「本轮修改」只列三项，**实际还提交了两个 `.dep` 调试文件**（问题 1）。
