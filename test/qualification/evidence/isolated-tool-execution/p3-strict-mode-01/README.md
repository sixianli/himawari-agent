# 严格模式下拒绝走 SRT 的工具

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)中“严格模式下所有工具走容器”一项（ITE-25），规则见 [Spec 的两种执行模式](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#modes)。

## 用词

| 用词 | 意思 |
| --- | --- |
| 严格模式 | 配置里写了 `taskEnvironments` 段时，所有工具都必须在每轮对话专用的容器里运行 |
| SRT | 在宿主上限制单个进程能访问哪些文件和网络的进程级沙箱（依赖包 `@anthropic-ai/sandbox-runtime`），默认模式用它运行工具 |
| 准入 | 工具调用真正派发给 Worker 之前，Agent 核对授权并写下执行记录的一步 |
| 旧版文件读取 | 安装声明里没有逐项写明执行后端（`operationBindings`）的文件读取，只能走 SRT |
| 子任务 | Worker 在一次工具调用里再发起的调用（delegation），目前只能走 SRT |

## 改了什么

- 准入（[`production-sandbox-services.ts`](../../../../../apps/agent-service/src/production-sandbox-services.ts)）：严格模式下，后端是 `srt` 的操作、旧版文件读取、Worker 发起的子任务，都在准入的第一步以 `SANDBOX_STRICT_MODE_UNAVAILABLE` 拒绝，不写执行记录，不调用容器，也不改用 SRT。SRT 模式下拒绝容器工具沿用已有实现（`SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE`）和已有测试，没有改。
- 工具结果（[`production-runtime-tools.ts`](../../../../../apps/agent-service/src/production-runtime-tools.ts)）：这次拒绝记为“未派发、失败”，原因码 `SANDBOX_STRICT_MODE_UNAVAILABLE`；告诉模型这是严格模式的限制，不要改用其他方式执行同样的操作，并告知用户。
- 页面状态（[`thread-execution-projection.ts`](../../../../../packages/application/src/services/thread-execution-projection.ts)、[`thread-execution-state.ts`](../../../../../packages/application/src/services/thread-execution-state.ts)）：把这个原因码加入允许显示的原因码名单，否则页面只会显示通用的“尚未派发”。
- 控制中心（[`execution-view.ts`](../../../../../apps/control-center/src/execution-view.ts)）：简体中文、英文、日文分别显示“严格模式下不可用”“Unavailable in strict mode”“厳格モードでは使用できません”。

## 自动测试

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| [`production-task-environment-route.test.ts`](../../../../integration/production-task-environment-route.test.ts) 新增 2 项 | 严格模式下，后端为 `srt` 的操作和旧版文件读取经生产准入流程被拒绝；v2 准入记录、旧版执行记录、任务环境记录都读回为空；容器生命周期一次也没被调用 | [`integration-route.log`](integration-route.log)：8 项通过（用户在本机终端运行，因为夹具要在 `/tmp` 下建目录，Claude 的命令沙箱不允许） |
| [`production-sandbox-lineage.test.ts`](../../../../integration/production-sandbox-lineage.test.ts) 新增 1 项 | 严格模式下，Worker 发起的子任务在查找父任务之前就被拒绝，子任务的执行记录读回为空，容器生命周期没被调用 | [`integration.log`](integration.log)：与下一行合计 204 项通过 |
| [`thread-run-lifecycle.test.ts`](../../../../integration/thread-run-lifecycle.test.ts) 表格新增 1 行 | 真实 SQLite 里保存的“未派发、原因码 `SANDBOX_STRICT_MODE_UNAVAILABLE`”工具结果，经页面投影后，步骤状态为“未派发”，原因码原样保留 | 同上 |
| [`production-runtime-tools.unit.test.ts`](../../../../../apps/agent-service/test/production-runtime-tools.unit.test.ts) 新增 1 项 | 准入抛出这个错误时，结果为未派发、失败、原因码正确，给模型的说明提到严格模式且要求不要改用其他方式；重复执行返回同一结果，没有发给 Worker | [`unit.log`](unit.log)：135 项通过（含下两行和三种语言文字完整性测试） |
| [`thread-execution-state.unit.test.ts`](../../../../../packages/application/test/thread-execution-state.unit.test.ts)、[`execution-view.unit.test.ts`](../../../../../apps/control-center/test/execution-view.unit.test.ts) | 原因码能进入页面状态；页面文字映射正确 | 同上 |
| 真实浏览器：[`test-execution-chain-browser.mjs`](../../../../../scripts/test-execution-chain-browser.mjs) 执行状态场景新增一步 | 一轮对话里 `bash` 步骤被严格模式拒绝：步骤显示“严格模式下不可用”，不显示“完成”，刷新后仍然正确 | [`browser-chrome.log`](browser-chrome.log) 和 [`browser-chrome/result.json`](browser-chrome/result.json)：已安装的 Google Chrome，12 个场景通过，其中 8 个执行状态场景（宽度 320、390、1024、1440 × 明暗）都含这一步；截图如 [`state-320-dark-strict-mode-unavailable.png`](browser-chrome/state-320-dark-strict-mode-unavailable.png) |

- 功能实现前，新增的测试全部按预期失败：严格模式下 SRT 工具和旧版文件读取仍被准入；子任务报的是“父任务不可用”；页面投影把原因码换成通用的 `TOOL_NOT_DISPATCHED`；页面没有对应文字。
- 相关回归：`production-sandbox-lineage`、`thread-run-lifecycle`、`production-sandbox-queue-reentry`、`sqlite-sandbox-execution-v2`、`workspace-boundaries` 共 637 项通过。
- 浏览器测试通过隔离的 HTTP 测试服务器取得后端状态，没有经过真实 Agent Service 或 Worker。运行前由 Claude 执行了 `npm run build:browser`（前端包 gzip 后共 179,189 字节，上限 184,320 字节）。
- 代码版本：提交 `9d0568e` 加本次改动（即本证据所在提交）。`npm run typecheck`、`npm run lint`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志去掉了终端颜色控制字符和本机沙箱打印的 `failed to copy trust settings` 行。

## 完整 npm test

第一次（提交 `80cf668`，作废）：由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-80cf668`。contracts 379、unit 2050、e2e 3、pi-compat 130 全部通过；integration 1834 项中 1 项失败，报告在 [`npm-test-80cf668-failed.tar.gz`](npm-test-80cf668-failed.tar.gz)。

- 失败的是 [`workspace-boundaries.test.ts`](../../../../integration/workspace/workspace-boundaries.test.ts) 的 “limits Agent imports to risk-reducing sandbox control”：测试期望的导出名单比代码实际导出多了 `processGroupPresent`、`readJobHostStartEvidence`、`readProcessStartToken` 三项。
- 原因：这次运行打包的是 `80cf668`，运行期间 Claude 提交了下一项改动 `fa3fef3`，其中修改了这份测试名单。测试读到的是新名单，拿去和 `80cf668` 的旧代码比较，于是不符。这是运行期间改动工作区造成的，不是 `80cf668` 的缺陷，这次结果不作为 `80cf668` 的验证。

第二次（提交 `7f9ad63`，通过）：由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-7f9ad63`，全部通过：contracts 379、unit 2060、integration 1842、e2e 3、pi-compat 130，报告在 [`npm-test-7f9ad63.tar.gz`](../p3-srt-crash-01/npm-test-7f9ad63.tar.gz)。`7f9ad63` 包含本次提交 `80cf668`，之后的两个提交分别是[同一次开机崩溃后释放](../p3-srt-crash-01/README.md)和完整测试忽略 `.DS_Store`，所以这次结果也覆盖本次提交。

## 未验证的部分

- 没有用真实 Docker 和真实 Worker 走一遍严格模式；容器路线的真实安装资格尚未完成。
- 严格模式下仍有未完成的 SRT 占用时（例如切换模式前留下的），这类记录的释放沿用已有恢复流程，本次没有新增测试。
- 会话里显示当前模式、仍在运行的程序、严格模式下有哪些工具不可用的清单（ITE-27 其余部分）尚未实现；本次只让被拒绝的那一步如实显示原因。
