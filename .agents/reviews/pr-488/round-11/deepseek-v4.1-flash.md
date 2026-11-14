# PR 488（60455a86..0aed68069）独立复核

结论先行：本次增量里**没有发现高严重度的功能性缺陷**；合并冲突文件的处理基本正确，新门槛能工作。下面按严重度列出问题，再给合并核对、侧重检查和必答问题。

---

## 一、读代码证实的问题

### 【中】新加的真浏览器过滤断言依赖时序，可能重新引入 WebKit 抖动
- 文件:行：`scripts/test-browser-page-errors-browser.mjs:103`、`129-131`；`scripts/browser-page-errors.mjs:9-18`
- 问题：过滤判定用**报错发生那一刻**的 `page.url()`，而新资格用例只等固定 200ms 就断言 WebKit“前三种情况确实报错”。换页过程中 `page.url()` 可能已经是 `about:blank` 或新地址，`url.port !== ""` 不成立；或者报错晚于 200ms。任一情况都会让 `recordedBlocked` 与期望不一致并抛 `PAGE_ERROR_FILTER_MISMATCH` / `PAGE_ERROR_FILTER_WEBKIT_BEHAVIOR_CHANGED`，等于把刚修掉的 WebKit 换页抖动又加回 CI。
- 证据：
  - `browser-page-errors.mjs:12-14`：`const url = new URL(page.url()); return url.port !== "" && url.host === host;`
  - `test-browser-page-errors-browser.mjs:103`：`await tab.waitForTimeout(200);`
  - `test-browser-page-errors-browser.mjs:129-131`：`if (entry.rawBlocked.includes(entry.expectedHost) !== entry.webkitReports) throw new Error("PAGE_ERROR_FILTER_WEBKIT_BEHAVIOR_CHANGED:...")`
- 建议：不要在报错时刻再读 `page.url()`，在开始换页前记下页面 origin/host 传给 watcher；把固定 `waitForTimeout(200)` 改成 `expect.poll`/`waitForEvent` 带超时的等待；对“WebKit 一定报错”的断言给出可重试次数或独立的稳定性依据。
- 说明：代码事实是“用了固定睡眠 + 实时 `page.url()`”；“真的会抖”属于推测，本机未跑 WebKit 复现。

### 【低】启动门槛只做文本匹配，不能证明“真正调用了收集函数”
- 文件:行：`scripts/browser-page-errors.mjs:63-78`（判定在 72-75）；`test/tooling/browser-page-errors.test.mjs:171-177`
- 问题：只要文件里任意位置出现 `watchPageErrors(`/`collectPageErrors(` 就放行；注释、字符串、函数定义（`export function collectPageErrors(`）都能满足。也不能保证收集的是被 launch 的那个 page/context（一个文件 launch 多个 browser 只收一个也算通过）。这与提交说明“要求真正调用收集函数”只部分相符。
- 证据：
  - `browser-page-errors.mjs:73-74`：`/\.launch(?:PersistentContext|Server)?\s*\(/u.test(source) && !/\b(?:watchPageErrors|collectPageErrors)\s*\(/u.test(source)`
  - 测试反向只覆盖了 `import { collectPageErrors } ...` 不调用（`test/tooling/browser-page-errors.test.mjs:194-197`），没有覆盖注释/定义/多 page 的情况。
- 建议：至少排除注释与函数定义（或要求 `name(` 出现在非 import/非 function 声明处）；在 I-97 文字里把“真正调用”降级为“源码中出现调用形态”，避免文档过度承诺。

### 【低】扫描器会匹配自身源码，靠耦合才不误报
- 文件:行：`scripts/browser-page-errors.mjs:37`、`73`
- 问题：`findUnwatchedBrowserLaunches` 扫描 `scripts/browser-page-errors.mjs` 时，第 73 行正则源码里的 `\.launch(` 本身会命中启动正则；它现在没被报出，只因为同文件第 37 行有 `export function collectPageErrors(` 满足了第二条件。将来把 `collectPageErrors` 移走或改名，这个从不启动浏览器的文件会被误报。
- 证据：`browser-page-errors.mjs:73` 的源码含字面量 `\.launch(`；`browser-page-errors.mjs:37` `export function collectPageErrors(page, errors = []) {`
- 建议：显式跳过扫描器文件自身（或在扫描时排除当前实现的文件），不要依赖“它恰好定义了收集函数”。

### 【低】launch 识别漏掉解构/别名调用
- 文件:行：`scripts/browser-page-errors.mjs:73`
- 问题：`const { launch } = chromium; await launch()`、`someBrowser["launch"]()` 这类写法不会被识别。当前仓库没有这种写法（`grep` 只看到 `.launch(`），但门槛覆盖面被文档描述得比实际宽。
- 证据：`browser-page-errors.mjs:73` 只匹配 `.launch...(`。
- 建议：在文档里注明这是 `.launch(` 形态的启发式；如要更强，可加对 `launch(` 裸调用的检查并配允许名单。

### 【低】门槛范围不覆盖 `test/integration/*-browser.test.ts`
- 文件:行：`docs/incidents-and-gates.md:130`；`test/integration/product-path-browser.test.ts:943` 等
- 问题：文档写的是“扫描 `scripts/` 和 `test/qualification/`”，代码也一致；但仓库里还有多处启动浏览器的集成测试（`product-path-browser.test.ts` 有 7 处 `chromium.launch(`，`test/fixtures/chromium-launch.ts:13,17`），完全不在门槛里，且这些文件没有 `pageerror` 收集。它们都是 chromium，不是本次 WebKit 事故的直接对象，所以属范围限制而非回归。
- 证据：`test/integration/product-path-browser.test.ts:943` `const fixtureBrowser = await chromium.launch({`；该文件对 `pageerror|watchPageErrors|collectPageErrors` 的搜索结果为空。
- 建议：在 I-97 或门槛说明里明说“只覆盖 scripts 与 qualification，集成浏览器测试不在内”，避免以后误以为覆盖率已含全部浏览器启动。

### 【事实核对】作者对提交的分组与代码不完全一致
- `edee06325` 被写成“恢复门槛”的提交之一，但 `git show --stat edee06325` 只有 `.agents/reviews/pr-488/round-8/verdicts.jsonl`，是复核账本，不含门槛代码。
- `a73728fa3` 的提交说明仍写“三个脚本和 sandbox-production-browser.mjs 列入允许名单”，但后续 `6409606d0` 已把 sandbox 改用 `collectPageErrors` 并从允许名单删除；最终代码与最终 I-97 文字是对的，提交说明是旧话。

---

## 二、推测/风险（未复现）

- WebKit 在不同版本/机器上是否稳定产生 “access control checks” 报错不确定；`test-browser-page-errors-browser.mjs:54-72` 把 `webkitReports: true` 写死，WebKit/Playwright 升级或环境差异可能让资格脚本本身变红。文档只记录了一个版本（WebKit 26.5 / Playwright 1.62.1）。
- `expectedOfflineTransportError` 只接受 `/<host><path> ` 或 `/<host><path>?` 开头、固定后缀结尾（`scripts/browser-page-errors.mjs:42-47`）。真浏览器用例用 `blockedHosts` 只校验后缀，没有把真实消息喂给它；若 WebKit 消息带前缀/额外字段，只会表现为资格脚本失败，单测发现不了。
- 扫描用 `readdir(root, { recursive: true })` 两遍、两目录共四遍，逐文件 `readFile`（`browser-page-errors.mjs:51,64`）。当前规模没问题，但 `scripts/` 继续膨胀时会变慢；不是功能缺陷。

---

## 三、合并与冲突核对（已证实）

- 6 个冲突浏览器脚本与 `test/qualification` 的最终内容**逐字等于 main**：`git diff 6a6d2ce6f..0aed68069 -- scripts/check-layout-audit.mjs scripts/test-file-preview-browser.mjs scripts/test-execution-chain-browser.mjs` 为空；其余冲突脚本也无差异。
- `git diff 6a6d2ce6f..HEAD` 只剩本 PR 自己的东西：`browser-page-errors.mjs` 追加 18 行门槛、测试追加 52 行、`docs/incidents-and-gates.md` 5 行，以及分支原有的 CI 文件。没有发现本 PR 在冲突文件里被 main 覆盖掉的其他改动；`check-layout-audit.mjs`、`test-file-preview-browser.mjs` 都仍是 `watchPageErrors`。
- `I-101` 行已删除，`I-97` 并入第 3 次；`docs/incidents-and-gates.md` 中已无其他 `I-101` 引用。`scripts/check-incident-gates.mjs` 对 `count>=3` 要求 `已落门槛`，I-97 正是 `已落门槛`；门槛列里反引号路径都存在。
- `a73728fa3` 曾把 `sandbox-production-browser.mjs` 放允许名单，`6409606d0` 已改成 `collectPageErrors` 并删除该允许名单，最终 `test/tooling/browser-page-errors.test.mjs:176-177` 对 `test/qualification` 用空允许集，二者一致。

---

## 四、侧重检查

- **不可信/不合规输入**：扫描对象是仓库内 `.mjs/.js/.ts`；不读取网络或用户数据，无路径注入。正则均为线性，无明显 ReDoS。
- **错误路径**：`test-browser-page-errors-browser.mjs` 的 `listen` 失败会先关掉已开服务器（43-46），`try/finally` 关闭 context 和两个服务器（116-119）；临时目录在 `finally` 删除。错误路径处理正常。
- **资源耗尽**：四遍递归读文件 + 每个文件读两次；当前可接受，属于规模风险而非缺陷。每个场景 `waitForTimeout(200)`，不构成资源问题。
- **不可撤销操作**：只有 `mkdtemp`/`rm` 临时目录，无仓库或生产写操作。`browser.json` 多写的 `pageErrorFilter` 含原始报错字符串，但资格报告本来就含 `pageErrors`，不是新增泄露面。
- **安全**：只在 `127.0.0.1` 随机端口起测试服务器，无外部暴露；未引入密钥/凭据。
- **规则/文档/代码一致性**：I-97 的门槛描述与最终代码基本一致（扫描范围、允许名单、`launchPersistentContext/launchServer`、只 import 不算、四个路径、跨源/无端口用例）。不一致处见上：`a73728fa3` 旧提交说明、门槛“文本匹配不等于真正调用”、以及扫描范围不含集成浏览器测试。

---

## 五、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。`60455a86..HEAD` 只改了 `apps/control-center/src/app/app-shell.tsx`（UI 聚焦时序）、`scripts/*` 浏览器 QA、`test/*` 和事故文档；`packages/`、提示词、工具定义、历史存储、遮盖代码均未变。发给模型的内容仍是原来的排列，不存在新增的“每轮变化值”或“只在末尾追加”之外的变化。

2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型内容不会。改动不参与模型请求组装。就新工具值本身：扫描结果都 `sort()`；报告里的 `pageErrorFilter` 含当次运行原始报错，是资格证据而非模型输入；`expectedOfflineTransportError` 是纯函数。没有引入时间字段或无序遍历影响模型字节。

3. **有没有自动检查，反向用例会失败吗？** 有：`test/tooling/browser-page-errors.test.mjs` 13 个 `it`，覆盖直接监听各种写法、目录扫描、只 import 不调用、`launchPersistentContext`、`launchServer (`、跨源/无端口、四个路径。把脚本改回直接监听或去掉收集调用，`findDirectPageErrorListeners`/`findUnwatchedBrowserLaunches` 会返回该文件，用例 171-177 失败，逻辑成立。**未核实**：本环境不能运行 vitest，"13 通过"未独立验证；全量 `scripts/` 因稀疏检出（63%）不能完全确认没有会被误判的文件。另有两处反向缺口：没有用例模拟“真实 WebKit 消息格式变化”，也没有模拟“换页时 `page.url()` 已变为 about:blank”。

4. **每个产生/使用的值两端都能接受吗？** 逐项核对：
   - `pageErrorFilter`：产生于 `qualify-control-center-browser.mjs:338`，写入报告 `:1034`；唯一校验者 `scripts/ci/browser.mjs` 的 `browserCounts` 只读固定字段，不认识的新字段被忽略，接受。
   - `startupFocus`：产生于 `test-control-center-v4.mjs:162`，放进 `:256` 返回对象，随 `v4Journeys` 进报告；`browserCounts` 不校验该对象，接受。
   - `expectedOfflineTransportError`：导出后被 `qualify-control-center-browser.mjs:1013-1019` 与单测使用，签名/参数一致。
   - `findUnwatchedBrowserLaunches`：导出后被 `test/tooling/browser-page-errors.test.mjs:175,177,209` 使用；允许名单的相对路径 `browser-page-errors.mjs`、`demo/record-email-decision.mjs`、`render-brand-assets.mjs`、`test-control-center-visual-v4.mjs` 与目录实际相对路径一致。
   - `I-97` 合并 `I-101`：无遗留引用；`check-incident-gates` 对 `count=3` 的硬门槛要求已满足，引用的仓库路径都存在。
   - 唯一“两端不完全一致”的是说法而不是值：文档/提交称门槛证明“真正调用”，代码只能证明“出现调用形态”；`a73728fa3` 的 sandbox 允许名单说明已被后续提交作废。

**未核实项**：无法运行任何测试或门槛命令；`.agents/reviews/pr-488/round-10` 在稀疏检出中不可读，作者“第 10 轮只剩低意见”未核实；全量 `scripts/` 目录未完整呈现，无法百分百确认门槛不会误判未检出的文件。
