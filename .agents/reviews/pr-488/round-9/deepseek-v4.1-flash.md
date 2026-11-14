## 一、读代码证实的问题（按严重度）

### 1【中】`test/qualification` 的直接监听被默认放行，且文档漏写了这条例外
- 文件:行：`test/tooling/browser-page-errors.test.mjs:170`、`:177`
- 问题：直接监听扫描对 `test/qualification` 使用了 `qualificationObserveOnly`，这个集合包含 `sandbox-production-browser.mjs`。而该文件并非“只做观察”：它直接监听 `pageerror`，并在 `page.reload()` 后断言 `errors` 必须为空。
- 证据：
  - `test/tooling/browser-page-errors.test.mjs:170`：`const qualificationObserveOnly = new Set(["sandbox-production-browser.mjs"]);`
  - `test/tooling/browser-page-errors.test.mjs:177`：`expect(await findDirectPageErrorListeners(qualification, qualificationObserveOnly)).toEqual([]);`
  - `test/qualification/sandbox-production-browser.mjs:18`：`page.on("pageerror", (error) => errors.push(error.message));`
  - `test/qualification/sandbox-production-browser.mjs:129`：`await page.reload();`
  - `test/qualification/sandbox-production-browser.mjs:140`：`assert.deepEqual(errors, []);`
  - `docs/incidents-and-gates.md:130` 的直接监听例外只列了“收集函数本身、只做证据记录的 `scripts/ci/browser-observation.mjs` 和要对比原始与过滤结果的真浏览器用例”，没有列 `sandbox-production-browser.mjs`；该文件只在“启动浏览器”那句里被描述为“只做观察”。
- 影响：这正是本 PR 想恢复的那类“绕过 `watchPageErrors` 直接收 `pageerror`”的脚本。它当前用 `chromium` 可能不会触发 WebKit 误报，但门槛本身没有拦住它，且文档说法与代码不一致。
- 建议：把 `sandbox-production-browser.mjs` 改为经 `collectPageErrors` 收集（它现在用 chromium，改造成本低）；或至少在文档中明确它是“直接监听”的第二条例外，并把“只做观察”改成准确描述（它会断言零报错）。

### 2【中】启动浏览器门槛按“标识符是否出现在源码文本里”判定，存在假阴性
- 文件:行：`scripts/browser-page-errors.mjs:72`
- 问题：只要源码任意位置出现 `watchPageErrors` 或 `collectPageErrors` 字样就放行，包括 import、注释、字符串、未使用的变量。于是“只改调用处、保留 import”不会让门槛报出该文件，与作者描述的反向验证步骤不一致。
- 证据：
  - `scripts/browser-page-errors.mjs:72`：`if (/\.launch\(/u.test(source) && !/watchPageErrors|collectPageErrors/u.test(source))`
  - `scripts/test-mobile-composer-browser.mjs:8`：`import { collectPageErrors } from "./browser-page-errors.mjs";`
  - 同一文件 `:21` 才真正调用：`const errors = collectPageErrors(page);`
  - 同一文件 `:291` 启动浏览器：`browser = await (profile === "webkit" ? webkit : chromium).launch({`
  - 新增反向用例 `test/tooling/browser-page-errors.test.mjs:181-204` 只覆盖“完全没有该标识符”的文件，没有覆盖“只有 import 或注释”的情况。
- 影响：作者说“把收集调用改名，总门槛用例报出该文件并失败”。按当前实现，只有把 import 也一起改名才成立；只改调用处时 import 那一行仍会让正则命中，用例不会失败。
- 建议：改成匹配调用形态，例如 `/\b(?:watchPageErrors|collectPageErrors)\s*\(/`，并在反向用例中加一个“只 import 不调用”或“只在注释里出现”的夹具。若做 AST 检查更稳，但至少不要只靠子串。

### 3【低】`test/qualification/evidence` 下的 `.mjs` 会被扫描，不只是 `.log`
- 文件:行：`scripts/browser-page-errors.mjs:67`、`:64`
- 问题：作者说“evidence 目录的 `.log` 文件不会被误扫”，这一点对 `.log` 成立；但 evidence 目录里还有 `.mjs` 证据脚本，扩展名在白名单内，会被递归扫描并读取。当前这些文件没有 `.launch(` 或直接监听，所以测试能过；但以后往 evidence 里放带这些模式的归档脚本，会让门槛误报。
- 证据：
  - `scripts/browser-page-errors.mjs:67`：`if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;`
  - `scripts/browser-page-errors.mjs:64`：`const entries = await readdir(root, { recursive: true, withFileTypes: true });`
  - 实际存在：`test/qualification/evidence/runtime-history/*.mjs`、`test/qualification/evidence/workspace-authorization-lifecycle/**/*.mjs`（共 6 个）。
- 建议：扫描 `test/qualification` 时排除 `evidence/` 和 `fixtures/`，或在文档里写明 evidence 只在扩展名命中时才会被检查。

### 4【低】`.launch(` 只覆盖这一种写法，且会匹配注释/字符串
- 文件:行：`scripts/browser-page-errors.mjs:72`
- 问题：`launchPersistentContext`、`launchServer`、解构后的 `launch(...)` 都不会命中；反过来，注释或字符串里的 `.launch(` 会命中，造成误报。
- 现状：我在当前 `scripts/` 和 `test/qualification/` 中只查到 `.launch(`，没有发现上述变体，因此这是潜在问题，不是当前已发生的缺陷。
- 建议：至少把匹配放宽到 `launchPersistentContext|launchServer`，或改用 AST/正则同时要求左侧是浏览器类型对象。

### 5【低】I-101 并入 I-97 时丢了“为什么 12:27 起稳定出现未查清”的限定
- 文件:行：`docs/incidents-and-gates.md:130`
- 问题：原 I-101 行写的是“部分确认……为什么从 12:27 起稳定出现（之前能过）没有查清”；并入 I-97 后该限定消失，而 I-97 标为“已确认”。若这个触发时刻仍未查清，新行的确认程度会比实际更强。
- 证据：`git diff` 中旧 I-101 行；新 I-97 行改为“已确认（云端容器复现……）”并加入“原记为 I-101”。
- 建议：在 I-97 行保留一句“12:27 这个起点仍未查清”，或明确写出 PR 471/488 已覆盖该触发条件。

## 二、推测/未核实

- 作者说“vitest browser-page-errors 13 通过”：我数到该文件正好 13 个 `it(`，数量一致；但没有运行测试，未核实实际结果。
- 作者说的真实反向验证（改 `test-mobile-composer-browser.mjs` 后用例失败）：受工具限制未复现；按代码推断只有连 import 一起改名才会失败（见第 2 条）。
- `.agents/reviews/pr-488/round-8/judgments.md`、`verdicts.jsonl` 在稀疏检出中不存在，无法读取内容，未核实。
- `test/qualification/evidence` 是否还有未检出到工作区的 `.mjs/.js/.ts`，未完全枚举；已检出的 6 个 `.mjs` 均无违规模式。

## 三、侧重检查

- 错误路径：`readdir`/`readFile` 失败会让用例直接 reject，不会静默放过；这是好事。但文本匹配带来的假阴性见第 2 条。
- 不合规范/不可信输入：只读仓库内文件，不执行被扫描内容，不做网络请求。`entry.isFile()` 会跳过符号链接，因此用符号链接指向仓库外/仓库内脚本可以绕过扫描；当前仓库未见这种用法，属低风险。
- 安全：新代码不读写密钥、不联网、不落盘；未发现新增敏感值。
- 资源耗尽：递归 `readdir` 并对所有 `.mjs/.js/.ts` 全量 `readFile`。当前范围小，但 evidence 目录增长会线性放大开销。
- 不可撤销操作：本改动没有；扫描是只读的，文档和复核记录只是提交内容。
- 规则/文档与代码一致性：
  - 扩展名描述 `.mjs、.js、.ts` 与正则 `\.(?:mjs|js|ts)$` 一致。
  - I-101 删除后，工作区内仅剩 I-97 行里一句“原记为 I-101”的说明，没有代码/测试/ADR 的悬空引用。
  - `check-incident-gates` 不要求编号连续，只查重复、格式和门槛文件是否存在；I-97 次数 3、状态“已落门槛”、门槛文件均存在，按代码可通过。
  - 发现的不一致见第 1、3、5 条。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。增量改动只涉及 `scripts/browser-page-errors.mjs`（CI 扫描函数）、`test/tooling/browser-page-errors.test.mjs`、`docs/incidents-and-gates.md` 和 `.agents/reviews` 记录；没有改系统提示、工具定义、历史消息、提示词目录或遮盖逻辑。新增函数只读仓库文件并返回相对路径，不进入发给模型的内容。复核记录是事后写入仓库的产物，不是 Himawari 请求的一部分。结论：仍只在末尾追加，没有新增每轮变化的值放进请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新代码没有引入时间、随机数、无序集合或前后文相关遮盖；`offenders.sort()`（`scripts/browser-page-errors.mjs:75`）保证输出顺序确定。文档和允许名单是静态值。未发现与模型请求字节相关的改动。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有。`test/tooling/browser-page-errors.test.mjs` 在 tooling 项目里，`ci/policy.json` 的 coverage 作业会跑 tooling，所以进入 CI。新增反向用例 `:181-204` 对“无收集调用”的文件确实会报出 `["bare.mjs","demo/nested.ts"]`；原有的直接监听反向用例也仍有效。缺口是：反向用例没有覆盖“只 import/只在注释里出现”这种当前实现会漏掉的情况（第 2 条），也没有自动证明“真实目录里删掉调用会失败”，只有作者的手工验证。

4. **改动产生或修改的每个值，两端都能接受吗？**
   - 新导出 `findUnwatchedBrowserLaunches`：只有 `test/tooling/browser-page-errors.test.mjs` 引用，签名和返回类型两端一致。
   - `screenshotOnlyLaunches` 的 3 个路径、`qualificationObserveOnly` 的 1 个路径都真实存在。
   - 但 `qualificationObserveOnly` 同时被用于“直接监听”和“启动浏览器”两种扫描，导致 `sandbox-production-browser.mjs` 获得双重豁免，且文档只把它写成启动扫描的例外（第 1 条）。
   - I-101 删除：工作区内没有代码/测试/ADR 引用；`check-incident-gates` 只查重复编号、格式和门槛文件存在性，不要求编号连续，因此可接受。
   - I-97 次数改为 3：`check-incident-gates` 对 `count >= 3` 要求状态属于“已落门槛/等 Andy/仓库外”，当前是“已落门槛”，且门槛路径都存在，可接受。
   - 文档中的扩展名列表与代码正则一致；文档对 `sandbox-production-browser.mjs` 的“只做观察”描述与代码的行为不一致。
