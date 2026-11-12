## 复核结论（PR 410 / 115aa81）

改动共 1 个提交、1 个文件（`test/integration/proactive-production.test.ts`），只给 `[PG-12]` strict-cookie 用例（test/integration/proactive-production.test.ts:615，确实是三条 `[PG-12]` 用例中的第二条，第 447、662 行是另外两条）的 `chromium.launch` 加了预装路径回退。作者的说法我逐条核对过：六个同类浏览器测试确实有完全相同的写法（decision-email-browser.test.ts:78-81 等 6 处），只改测试文件、不动产品代码，均属实。

### 问题清单（按严重度）

**低 · test/integration/proactive-production.test.ts:631 — 硬编码路径第 9 份拷贝，无共享常量、仓库内无文档**
- 证据（读代码证实）：`/opt/pw-browsers/chromium` 现在在 9 处重复硬编码：本文件、6 个浏览器集成测试、`scripts/check-layout-audit.mjs:413`、`scripts/demo/record-email-decision.mjs:68`。我 grep 了全部 docs，没有任何文档提到这个路径或“容器预装浏览器”这一约定（`docs/ui-ux-design-guide.md:249` 只提到 `HIMAWARI_CHROMIUM_PATH` 环境变量，针对另一个脚本）。
- 建议：把“解析 Chromium 可执行文件”提成一个共享辅助函数放进 `packages/testing`（本文件第 42 行已经从 `@himawari-agent/testing` 导入 `ScriptedModelPort`，有现成入口），至少消掉 8 份拷贝；或在某处文档记录该容器约定。
- 推测：若容器镜像改了路径，需要人肉同步 9 处，且没有任何自动检查能发现不同步。

**低 · test/integration/proactive-production.test.ts:632-634 — 空字符串环境变量的语义是“回落到 Playwright 默认解析”，而不是“用 bundled”**
- 证据（读代码证实）：`HIMAWARI_CHROMIUM_PATH=""` 时 `??` 不触发（空串非 nullish），`executablePath` 为 `""`，随后 `executablePath ? { executablePath } : {}` 因空串为假走 `{}`，即默认解析——在缺浏览器的容器里会回到原报错。我核对了 6 个同类测试（如 decision-email-browser.test.ts:79-81），语义逐字相同，所以这是沿用既有模式，不是本 PR 新引入。
- 建议：可改为 `process.env[...] || (existsSync(bundled) ? bundled : undefined)`，但要 7 处一起改才有一致性；单独改本文件反而制造分叉，故本 PR 保持现状可接受。

**信息 · 回退分支本身没有自动检查**
- 证据（读代码证实）：改动落在测试文件内部，`existsSync(bundled)` 为真/假两个分支都没有任何测试去验证（也不可能在本机 CI 验证容器路径）；仓库内也没有校验 `/opt/pw-browsers` 与容器实际安装位置一致的机制。
- “反向用例会失败吗”：会——这正是本 PR 的动机本身：改前在云端容器里该用例报 `Executable doesn't exist`，说明集成测试（`npm test` / `test:integration`，integration 项目被 `scripts/ci/check-coverage.mjs:73` 和 `scripts/ci/check-policy.mjs:35` 纳入）确实会抓住缺浏览器的情况。但“ bundled 路径在容器里真的存在且能启动”这一点我无法在本仓库核实（见下）。

**未核实（推测）**
- 容器里 `/opt/pw-browsers/chromium` 是否真以符号链接存在、以及 `chromium.launch({ executablePath: <完整版 chromium> })` 在该 Playwright 版本（1.62.1）默认 headless 下能正常跑——我无法运行命令、无法上网。旁证是 6 个同类测试用同一写法且作者称已通过；另外 `scripts/ci/check-policy.mjs:37` 的 CI 安装命令是 `install --only-shell chromium`（只装 headless shell），而报错路径正是 `chromium_headless_shell-1234`，与“容器只缺对应版本的 headless shell、只有完整版 chromium”的故事吻合。

### 侧重检查（测试覆盖 / 文档与代码一致性 / 一条普通流程的走查）

**流程**：`npm run test:integration` → vitest `integration` 项目 → `proactive-production.test.ts` 的 `[PG-12]` strict-cookie 用例 → `setup()` 起 SQLite + 服务（不碰浏览器）→ `connect(h)` 走 `app.inject`（不碰浏览器）→ 起 fake Google 服务器 → **`chromium.launch`（改动处）** → 注入 `SameSite=Strict` Cookie → 点 `#continue` 跨站跳回回调 → 断言落到 `gmail=connected` → 再验证登出场景。
- 有覆盖：整个 OAuth 回调链路、Strict Cookie 行为（这是 I-31 的门槛，docs/incidents-and-gates.md:69 记为“已落门槛”）。
- 无覆盖：`chromium.launch` 的可执行文件解析分支（即本 PR 的改动本身）；此外该文件跑在 `scripts/proactive/repeat-acceptance.sh:14-18` 的重复验收里，该脚本不受本改动影响。
- 文档与代码一致性：本 PR 没有对应文档条目需要更新——`/opt/pw-browsers` 约定在 docs 中无记载（见上第 1 条），这是缺口而不是不一致。I-31 门槛文档（docs/incidents-and-gates.md:69）描述的行为与测试现状一致，无需改。

### 必答问题逐条回答

1. **不会。** 读代码证实：diff 只改了测试里 `chromium.launch` 的可执行文件来源（proactive-production.test.ts:631-634）。该测试的模型侧用的是 `ScriptedModelPort`（第 41 行导入，脚本化应答），不向任何真实模型发请求；改动的值（浏览器路径）不进入系统提示、工具定义、历史或遮盖结果。发给模型的内容没有变化，谈不上“只在末尾追加”。
2. **不会。** 读代码证实：改动没有引入任何序列化、遮盖或顺序依赖。唯一的非确定值是 `executablePath`（依赖 `existsSync` 和环境变量），但它只决定测试用哪个浏览器二进制，不进入任何发出去的字节。
3. **部分有。** 该文件本身是集成测试，在 `npm test` / `test:integration` / CI coverage 中运行（scripts/ci/check-coverage.mjs:73、check-policy.mjs:35）；“缺浏览器会失败”的反向用例就是本 PR 修复前的真实失败，检查有效。但回退逻辑的两个分支本身无测试、路径常量与容器实际状态的吻合无校验（读代码证实，见上）。
4. **能接受，有一处结构性弱点。** 逐个核对：① `HIMAWARI_CHROMIUM_PATH`——已有 6 个测试和 3 个脚本使用，文档（docs/ui-ux-design-guide.md:249）记载其用法，两端一致；② `/opt/pw-browsers/chromium`——只在本文件内 `existsSync` + `launch` 消费，无跨端校验问题，但它是第 9 份硬编码拷贝、无共享常量、无文档（低严重度，见上）；③ `existsSync` 导入——无其他消费方，无风险。没有发现类似 I-73 那种“改动的值过不了另一端校验”的问题。
