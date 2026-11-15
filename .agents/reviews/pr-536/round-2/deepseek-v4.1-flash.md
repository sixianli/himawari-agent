**本轮查过的范围**

- 对比了 `git diff 75dd7d0..e7e853e` 的全部增量，并用 `git diff 8fc09d2..e7e853e` 对照完整改动。
- 读了 `.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/policy.test.mjs`、`docs/runbooks/ci-vps-runner-runbook.md`、`scripts/operations/ci-runner/prepare-arm.sh`，以及证据指向的 `test/tooling/safari-panel.test.ts`、`test/fixtures/chromium-launch.ts`、`scripts/ci/run.mjs`、`scripts/check-layout-audit.mjs`。
- `git grep` 被环境策略拒绝，改用 `grep`/`read` 对当前工作区（即 `e7e853e`）检索。
- 没有运行测试，因此作者说的测试条数只能标「未核实」。

### 1. 低：找不到 `scripts/ci/run.mjs` 时 Chromium 顺序校验直接放行，static/tooling 的执行入口又没有别的断言固定

- 文件: `scripts/ci/check-policy.mjs:613-621`，参见 `scripts/ci/check-policy.mjs:706-715`
- 问题: `run < 0 || install < run` 让“工作流里根本没有 `scripts/ci/run.mjs` 步骤”也满足顺序条件。只有 `tests` 在 706-715 被要求必须有一个精确的 run.mjs 步骤；`static` 和 `tooling` 没有。把执行步骤改成不含 `scripts/ci/run.mjs` 的包装脚本后，Chromium 安装即使排在检查之后，新校验也不会报错。当前 `ci.yml` 不满足这个绕过条件，所以不是现网故障，但上一轮说的“门槛可被绕过”仍留了一个低风险入口。
- 证据:
  ```js
  const run = job.steps.findIndex((step) => step.run?.includes("scripts/ci/run.mjs"));
  assert(install >= 0, `Job runs browser tests without installing Chromium: ${check.id}`);
  const step = job.steps[install];
  assert(
    (run < 0 || install < run) &&
  ```
  以及只有 tests 有的固定执行命令断言：
  ```js
  if (check.id === "tests") {
    const executions = job.steps.filter((step) => step.run?.includes("scripts/ci/run.mjs"));
    assert(executions.length === 1 && ... executions[0].run === '...run.mjs --check tests...');
  ```
- 建议: 对 `chromiumChecks` 要求 `run >= 0`，并像 `tests` 一样固定 `static`/`tooling` 的执行命令；补反向用例：删掉或改名 `static`、`tooling` 的 run.mjs 步骤时也必须失败。

### 2. 低：Chromium 步骤显式写 `continue-on-error: false` 会被误判成“有条件”

- 文件: `scripts/ci/check-policy.mjs:592-595`、`:617-620`
- 问题: 通用步骤校验允许 `continue-on-error` 是 `undefined` 或 `false`；Chromium 专用校验只允许 `undefined`。因此在 Chromium 安装步骤上显式写 `continue-on-error: false`（语义上仍是失败即失败）会被报成 `Chromium must install unconditionally before the checks run`。当前 `ci.yml` 没有写这个字段，所以现阶段不影响 CI。
- 证据:
  ```js
  assert(
    step["continue-on-error"] === undefined || step["continue-on-error"] === false,
    `Step can hide failure: ${check.id}`,
  );
  ```
  ```js
  step.if === undefined &&
    step["continue-on-error"] === undefined,
  ```
- 建议: 删掉 Chromium 块里的 `continue-on-error` 条件（通用检查已经覆盖），或改成 `step["continue-on-error"] !== true`；顺便加一条“显式 false 应通过”的用例。

### 3. 低（推测）：Runbook 把“缺系统库”的失败位置指向 Chromium 安装步骤，可能与实际失败阶段不符

- 文件: `docs/runbooks/ci-vps-runner-runbook.md:186`，参见 `scripts/operations/ci-runner/prepare-arm.sh:49`、`.github/workflows/ci.yml:95,307`
- 问题: `prepare-arm.sh:49` 装的是 `playwright/cli.js install-deps chromium`，即系统库；CI 的安装步骤执行 `playwright install --only-shell chromium`，通常只负责下载浏览器。按 Playwright 的常见行为，缺系统库会在启动浏览器时失败，而不是在 `playwright install` 这一步失败。若 Playwright 1.62.1 也是这样，Runbook 会把排障指向错误的步骤。**未核实**：本轮不能运行 Playwright 或 CI，无法确认该版本的实际报错位置。
- 证据:
  ```sh
  PATH="$node_bin:$PATH" node "$work/pw/node_modules/playwright/cli.js" install-deps chromium
  ```
  ```yaml
  - name: 安装工具测试用的 Chromium
    run: .ci-output/tools/bin/node node_modules/playwright/cli.js install --only-shell chromium
  ```
- 建议: 在 ARM 机器上真跑一次“缺系统库”场景确认；按实际结果改成“启动 Chromium 的检查会报缺库”，或写明真正报错的步骤。

**上一轮意见与作者说法核对**

- 上一轮意见 1「只验证步骤存在，不验证顺序或条件」：主问题已改好。新增的断言确实检查了安装步骤排在第一个 run.mjs 步骤之前，并且 `if`/`continue-on-error` 不能出现；反向用例也覆盖了“移到检查后”和“加条件”。但留下了上面第 1、2 条的边界问题。
- 上一轮意见 2「ARM Runbook 只写 static 需要 Chromium」：已改好。Runbook 现在同时提到 static 布局检查和 tooling Safari 面板测试，步骤名与 `ci.yml:307` 一致；`prepare-arm.sh` 也确实安装 Chromium 系统库。
- 作者说“去掉新步骤报 `Job runs browser tests without installing Chromium: tooling`，加回后通过”：代码路径支持这个结论（`install === -1` 时先触发该断言），但我没有实际运行。
- 作者说“test/tooling/policy.test.mjs 948 条通过”：**未核实**，本轮不能运行测试。
- 作者说“不涉及发给模型的请求”：正确。增量只改 CI 工作流、策略脚本、测试和 Runbook，没有改提示词、工具定义、历史消息或遮盖逻辑。

**侧重检查**

- 错误路径：缺安装步骤、安装步骤排在检查后、安装步骤带条件，三条都有断言或反向用例；缺 `run.mjs` 时的顺序放行是残余缺口（发现 1）。
- 不合规范/不可信输入：新增校验只读取解析后的 YAML 字符串，没有把工作流内容拼进 shell；已有的 `${{ ... }}` 插值检查仍生效。
- 安全：没有新增 secret、token 或外部输入进入命令；安装命令是固定字符串。
- 资源耗尽：tooling 每次在 ARM 上下载 Chromium，和 static 作业现有做法相同，没有新增无界循环或并发放大。
- 不可撤销操作：没有。
- 规则/文档/代码一致性：Runbook 已补 tooling；`prepare-arm.sh` 与文档的“系统库”说法一致；只有“报缺库发生在哪一步”这一句可能不精确（发现 3，推测）。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量没有改任何组装模型请求的代码，没有新增系统提示、工具定义、历史消息或遮盖结果；因此不存在“只在末尾追加”或“每轮变化值是否在最后一条消息”的新风险。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。新增的值是固定数组、固定错误字符串和固定 YAML 命令，没有时间、随机数、数据库顺序或无序集合参与；也不影响模型请求的序列化。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`check-policy.mjs` 新增顺序/条件断言；`policy.test.mjs:771-794` 增加了 tooling 缺安装、移到检查后、加条件三个反向用例，按代码逻辑都会以预期消息失败。覆盖缺口是：没有直接测 `continue-on-error`，没有测 static/tests 的顺序，也没有测“删掉 run.mjs 后顺序被跳过”（发现 1）。测试实际执行结果本轮未核实。
4. **每个新值的使用端能否接受？** 核对结果：`chromiumChecks` 新增的 `tooling` 与 `jobIds`、实际 tooling 作业一致；`chromiumInstall` 与 `ci.yml:95/260/307` 的命令逐字一致；新错误字符串只被新测试断言使用；Runbook 新步骤名与 `ci.yml:307` 一致；测试里移动安装步骤后没有遗留旧的下标假设（原 `steps[1]` 已改成按内容查找）。唯一没有自动使用端的是 Runbook 文字本身。
