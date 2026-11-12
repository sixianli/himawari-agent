## 读代码证实的发现

### 1. 中｜test/integration/proactive-production.test.ts:631-634
**问题：** 回退条件只判断 `/opt/pw-browsers/chromium` 是否存在，没有判断 Playwright 自己的默认浏览器是否可用。因此，在任何同时存在这两个浏览器的主机上，这个用例都会从固定版本的 Playwright Chromium 切换到未固定版本的系统 Chromium；这与作者“不改变其他环境的行为”的说法不一致。这个用例专门验证 SameSite Strict cookie 的浏览器行为，换成另一版本 Chromium 后，可能以不同的浏览器语义通过，降低这条回归测试的可信度。

**证据：**
```ts
const bundled = "/opt/pw-browsers/chromium";
const executablePath =
  process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
```
仓库里 CI/测试主机原本是让 Playwright 用自己下载的固定浏览器：`scripts/ci/check-policy.mjs:36-38` 用 `install --only-shell chromium`，`scripts/ci/quality-policy.mjs:248` 把 `PLAYWRIGHT_BROWSERS_PATH` 指向 `.ci-output/browsers`，`docs/runbooks/test-host-operations-runbook.md:73` 也要求把 `PLAYWRIGHT_BROWSERS_PATH` 指向本任务目录。只要这些主机上另外存在 `/opt/pw-browsers/chromium`，新代码就会优先用后者。

**建议：** 只在 Playwright 默认可执行文件确实不存在时才回退，例如先查 `existsSync(chromium.executablePath())`，存在就用默认值；或者把容器里的浏览器目录通过 `PLAYWRIGHT_BROWSERS_PATH`/环境变量配置好，避免测试代码硬编码。若坚持当前写法，应把“只在云端容器生效、其他环境不变”从作者说法里去掉。

### 2. 低｜test/integration/proactive-production.test.ts:631-634
**问题：** `existsSync` 只证明路径存在，不证明它是可执行文件、也不是目录。如果 `/opt/pw-browsers/chromium` 是目录、悬空链接目标之外的错误文件或没有执行权限，代码仍会把它交给 `chromium.launch`，失败信息会从“找不到浏览器”变成较难定位的启动错误。

**证据：** 同上三行，`existsSync` 后没有 `statSync().isFile()`、`access(X_OK)` 或 playwright 自带的路径验证。

**建议：** 解析路径时至少确认是普通文件且可执行；或使用 Playwright 的 `executablePath()`/`validateHostRequirements` 一类现有机制。更好的做法是把解析逻辑集中到一个测试辅助函数，供现有七处调用。

### 3. 低｜改动本身（只有测试文件变化）
**问题：** 新增的回退分支没有对应的自动检查或反向用例。正常 CI 使用 `.ci-output/browsers`，按仓库配置不会走到 `/opt` 分支；这个分支只在特定容器里被执行。也就是说，如果以后有人改错回退顺序或路径，普通 CI 不一定发现。

**证据：** `git diff --stat` 只有 `test/integration/proactive-production.test.ts` 一个文件；新分支只在 `existsSync(bundled)` 为真时执行。现有六个同类测试也只是重复同一段内联逻辑，没有共享解析器。

**建议：** 抽一个 `resolveChromiumExecutable()` 辅助函数，用临时目录做单元测试，覆盖：环境变量优先、默认浏览器优先/回退、路径不存在、路径是目录、环境变量为空字符串。这样反向分支也能自动验证。

### 4. 低｜test/integration/proactive-production.test.ts:632-634
**问题：** `??` 只把 `null`/`undefined` 当作缺失。如果容器把 `HIMAWARI_CHROMIUM_PATH` 设成空字符串，`executablePath` 会变成 `""`，随后三元判断为假，直接调用 `chromium.launch({})`，不会回退到 `/opt/pw-browsers/chromium`。

**证据：**
```ts
process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
...
chromium.launch(executablePath ? { executablePath } : {});
```
空字符串不是 nullish，但也不是真值，两个判断组合起来会跳过回退。这是“不依赖环境变量也能通过”目标上的一个边界缺口；是否在目标容器里实际发生，未核实。

**建议：** 对空字符串做归一化，例如 `const fromEnv = process.env["HIMAWARI_CHROMIUM_PATH"]?.trim();`，为空时继续尝试默认/回退路径。

## 推测（未核实）

- `/opt/pw-browsers/chromium` 是符号链接、以及设置 `HIMAWARI_CHROMIUM_PATH` 后容器里测试通过：无法在本次复核环境访问 `/opt`，也无法运行测试，未核实。
- 如果该路径实际指向目录或与 Playwright 1.62.1 不兼容的 Chromium，启动会失败或行为变化：由第 2 条推断，未实测。
- Hermes/其他测试主机是否也存在 `/opt/pw-browsers/chromium`：未核实。若存在，第 1 条的行为变化会发生在这些主机上。
- 执行 `/opt` 下固定路径的二进制本身引入的替换风险：取决于该目录的属主和权限，未核实。

## 作者说法核对

- “只改一个测试文件，不动产品代码”：**证实**。`git diff --stat` 只有该测试文件。
- “另外六个浏览器集成测试已有同样回退写法”：**证实**。`decision-chain-browser.test.ts:78-81`、`decision-email-browser.test.ts:78-81`、`memory-source-browser.test.ts:87-90`、`muse-reference-browser.test.ts:117-120`、`review-prereview-browser.test.ts:95-98`、`sensitive-interceptions-browser.test.ts:148-151` 都是同一写法。
- “不涉及发给模型的内容”：**证实**。diff 只改浏览器启动路径，没有系统提示、工具定义、历史或遮盖相关代码。
- “不改变其他环境的行为”：**不成立**。只要其他环境存在 `/opt/pw-browsers/chromium`，新代码就会改变浏览器选择；见第 1 条。
- “容器里预装浏览器在 `/opt/pw-browsers/chromium`（符号链接）、设环境变量时测试通过”：**未核实**，本次无法访问该路径或运行测试。
- “main 上一直红、本测试 16/16 通过”：**未核实**，本次不能运行测试。

## 侧重检查

- **错误路径：** 环境变量为空会跳过回退；路径存在但不是可执行文件会延迟到 `chromium.launch` 才失败；路径不存在时仍按原逻辑交给 Playwright 并报原错误，行为合理。见第 2、4 条。
- **不合规范/不可信输入：** `HIMAWARI_CHROMIUM_PATH` 的值仍被直接当作可执行文件路径，这是既有行为，本次没有新增校验。
- **安全：** 新代码固定执行 `/opt/pw-browsers/chromium`。若该目录对低权限账号可写，测试进程会执行被替换的二进制；容器权限未核实。测试环境隔离下风险低。
- **资源耗尽：** 浏览器成功启动后会由 `closers` 在 `afterEach` 关闭（`proactive-production.test.ts:180-183`）；启动失败时没有已分配资源，未发现新增泄漏。
- **不可撤销操作：** 无新增写操作、删除操作或外部副作用。
- **规则/文档一致性：** 这是测试文件改动，不触发 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md)；没有需要同步的规则文件。提交说明里的 `Layer-0-tests: none` 对只改测试的提交符合 ADR 0066。作者关于“其他环境不变”的说法与代码不一致，已在上面指出。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在测试里选择本机 Chromium 可执行文件，发给模型的内容仍在原逻辑中只在末尾追加；每轮会变的值也没有被移动到请求开头。`prompt-prefix` 规则不适用于这个改动。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增值只是本地文件系统路径选择，没有进入提示词、遮盖或序列化内容；不依赖时间、无序集合或请求上下文。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有正向检查：被修改的 PG-12 用例本身会在目标容器里验证回退。没有单独的反向用例；新分支在正常 CI 中按仓库配置不会被覆盖。移除回退后目标容器应该会失败，但本次未运行，无法确认“真的会失败”。建议按第 3 条补一个解析函数的反向测试。

4. **改动产生/修改的每个值，两端都能接受吗？** 产生两个值：`bundled`（固定字符串 `/opt/pw-browsers/chromium`）和 `executablePath`（字符串或 `undefined`）。使用端只有 `chromium.launch`：`executablePath` 非空时传入字符串，API 接受该类型；路径合法性只由文件系统和 Playwright 在启动时检查。这里没有像 I-73 那样的跨模块字段校验，但“容器里这个路径一定存在且可用”这个外部契约没有任何自动检查或文档记录，是本次改动的主要可靠性缺口。建议集中到一个解析器并增加测试。
