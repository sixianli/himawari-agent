# 会话页面：停止未经严格确认、执行记录已删除

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)第二项（ITE-26）的界面部分和第三项（ITE-27）的一部分，要求见 [Spec 的界面必须说清的状态](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#mode-disclosure)。

## 用词

| 用词 | 意思 |
| --- | --- |
| SRT | 在宿主上限制单个进程能访问哪些文件和网络的进程级沙箱（依赖包 `@anthropic-ai/sandbox-runtime`） |
| `process_group_gone` | 释放记录的清理依据之一：任务进程组已全部消失，但离开进程组的后代不被跟踪，所以叫“停止未经严格确认” |
| 运行清单（run inventory） | 一轮对话（Run）名下全部执行记录、排队记录的一次性读取结果，页面状态由它算出 |
| 删除标记 | 删除旧未确认记录时写在 `deletion_tombstones` 表里的记录，见[删除命令的记录](../p3-legacy-purge-01/README.md) |
| 原因码（`reasonCode`） | 网关返回给页面的状态说明代码，页面按它选择显示文字 |

## 改了什么

- 运行清单新增 `deletedPlans`：SQLite 读取这一轮对话的 `sandbox_execution` 删除标记，取出原执行计划（[`sqlite-sandbox-execution-operations.ts`](../../../../../packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts)）。
- 资源投影（[`thread-execution-resources.ts`](../../../../../packages/application/src/services/thread-execution-resources.ts)）：
  - 已释放且清理依据为 `process_group_gone` 的资源，原因码由 `RESOURCE_RELEASE_CONFIRMED` 改为 `RESOURCE_STOP_NOT_STRICTLY_CONFIRMED`。
  - 被删除的记录显示为新状态 `record_deleted`，原因码 `EXECUTION_RECORD_DELETED`，不算未释放资源；已准入但执行记录已删除的排队行跳过。
- 页面状态（[`thread-execution-state.ts`](../../../../../packages/application/src/services/thread-execution-state.ts)）：上述两种情况下，工具步骤保留自己的完成或失败状态，只换原因码；被停止的一轮对话里有这种释放时，整体原因码为 `RUN_STOPPED_NOT_STRICTLY_CONFIRMED`。网关合同的状态枚举没有改。
- 控制中心（[`execution-view.ts`](../../../../../apps/control-center/src/execution-view.ts)）：简体中文、英文、日文三种文字，分别显示“停止未经严格确认”“执行记录已删除”，并在被停止的一轮对话下说明离开进程组的程序可能仍在运行、修改文件或联网。“执行记录已删除”的原因码不以 `RESOURCE_` 开头，所以页面不会在它前面补“已完成”。

## 自动测试

| 层 | 测试 | 结果 |
| --- | --- | --- |
| 真实 SQLite 与投影 | [`sqlite-sandbox-execution-v2.test.ts`](../../../../integration/sqlite-sandbox-execution-v2.test.ts) 新增 2 项：真实写入流程释放为 `process_group_gone` 后原因码正确；真实记录变为 `lost` 后用删除命令的同一实现删除，运行清单读回 `deletedPlans`，投影为 `record_deleted` 且不再挡住释放；原有的严格释放仍是 `RESOURCE_RELEASE_CONFIRMED`。[`thread-resource-projection.test.ts`](../../../../integration/thread-resource-projection.test.ts) 用生产准备流程产生的真实已准入排队行，确认删除标记存在时排队行被跳过，不存在时仍显示未确认 | [`integration.log`](integration.log)：5 个文件 257 项通过（含删除命令和其他受字段新增影响的测试） |
| 页面状态与文字 | [`thread-execution-state.unit.test.ts`](../../../../../packages/application/test/thread-execution-state.unit.test.ts) 新增 2 项，[`execution-view.unit.test.ts`](../../../../../apps/control-center/test/execution-view.unit.test.ts) 新增 1 项并扩展 1 项 | [`unit.log`](unit.log)：55 项通过 |
| 真实浏览器 | [`test-execution-chain-browser.mjs`](../../../../../scripts/test-execution-chain-browser.mjs) 的执行状态场景末尾新增一步：后端返回停止未经严格确认、一个步骤的记录已删除；检查整体文字、含义说明、两个步骤各自的文字，刷新后仍然正确 | [`browser-chrome.log`](browser-chrome.log) 和 [`browser-chrome/result.json`](browser-chrome/result.json)：已安装的 Google Chrome，12 个场景通过，其中 8 个执行状态场景（宽度 320、390、1024、1440 × 明暗）都含新步骤；截图如 [`state-1440-light-stop-not-strict.png`](browser-chrome/state-1440-light-stop-not-strict.png)、[`state-320-dark-stop-not-strict.png`](browser-chrome/state-320-dark-stop-not-strict.png) |

- 功能实现前，新增或扩展的 4 项单元测试和 5 项集成测试全部失败，原因都是新行为不存在（文字仍为“完成”、下一步提示仍为原提示、运行清单没有 `deletedPlans`、投影没有新状态）；原有的严格释放断言照常通过。
- 浏览器测试由用户在本机终端运行：`node scripts/test-execution-chain-browser.mjs chrome test/qualification/evidence/isolated-tool-execution/p3-ui-state-01/browser-chrome`，运行前由 Claude 执行了 `npm run build:browser`（前端包 gzip 后共 179,111 字节，上限 184,320 字节）。浏览器通过隔离的 HTTP 测试服务器取得后端状态，没有调用真实模型，也没有经过真实 Worker。
- 代码版本：提交 `d8f697f` 加本次改动（即本证据所在提交）。`npm run typecheck`、`npm run lint`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志里本机沙箱打印的、与测试无关的 `failed to copy trust settings` 行已去掉。

## 未验证的部分

- 在 macOS 上，SRT 工具调用正常结束后的释放依据也是 `process_group_gone`，所以这类步骤会显示“已完成 · 停止未经严格确认”；这是按 ADR 0033 如实显示，没有用真实产品路径在浏览器里走过一遍。
- ITE-27 其余部分（当前模式、仍在运行的后台或服务类程序、严格模式下不可用的工具）尚未实现。
- 删除命令还没有在真实数据库上执行。
