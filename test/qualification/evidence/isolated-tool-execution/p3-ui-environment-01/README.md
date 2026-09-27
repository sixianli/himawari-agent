# 会话页面显示执行环境

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)中“界面说清当前状态”一项（ITE-27）的其余部分，规则见 [Spec 的界面必须说清的状态](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#mode-disclosure)，页面样式按用户批准的 [v5 增补：执行环境显示](../../../../../docs/execution/specs/2026-09-15-control-center-v4-design.md#v5-execution-environment)。

## 用词

| 用词 | 意思 |
| --- | --- |
| 默认模式 | 页面上对 SRT 模式的叫法：工具在宿主上的进程级沙箱（SRT，依赖包 `@anthropic-ai/sandbox-runtime`）里运行 |
| 严格模式 | 配置里写了 `taskEnvironments` 段时，所有工具都必须在每轮对话专用的容器里运行 |
| 仍在运行的程序 | 已经启动、还没有登记释放的后台任务（background）或服务（service）类工具调用，包括正在停止和停止尚未确认的 |
| 线程网关 v3 | 控制中心页面向 Agent Service 查询对话数据的接口（`/api/gateway/thread/v3/queries`） |
| 安装声明 | 安装时写好的每个工具操作该由哪个执行后端运行（`operationBindings`） |

## 改了什么

- 接口契约（[`thread-contracts-v3.ts`](../../../../../packages/gateway-contracts/src/thread-contracts-v3.ts)）：新增只读查询 `thread.execution_environment` 和回复 `thread.execution_environment_snapshot`。回复只含模式（`srt` 或 `strict`）、每个程序的所属对话、类别、工具名、开始时间，以及严格模式下不可用的工具和原因码；不含命令内容和内部编号，多出字段即拒绝。
- 数据库（[`sqlite-sandbox-execution-operations.ts`](../../../../../packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts)）：新增按 `job_id` 分页的只读列表 `listRunningPrograms`，只取同一所有者和 Agent 名下、已启动、类别为后台或服务、尚未登记释放的记录；不新增 migration。
- 汇总（[`thread-execution-environment.ts`](../../../../../packages/application/src/services/thread-execution-environment.ts)）：逐页读完，超过 1,000 个程序时报错而不是截断。
- 不可用的工具（[`production-execution-environment.ts`](../../../../../apps/agent-service/src/production-execution-environment.ts)、[`production-sandbox-services.ts`](../../../../../apps/agent-service/src/production-sandbox-services.ts)）：准入和列表共用同一条判断，严格模式下安装声明缺失或后端是 `srt` 的操作被列出，与准入实际拒绝的一致。
- 服务接线（[`production-http-composition.ts`](../../../../../apps/agent-service/src/production-http-composition.ts)、[`service-main.ts`](../../../../../apps/agent-service/src/service-main.ts)、[`http-gateway-server.ts`](../../../../../packages/platform-node/src/http-gateway-server.ts)）：服务传入执行环境时，页面配置里 `executionEnvironmentAvailable` 为真；没传时为假，查询被拒绝。
- 页面（[`execution-environment.tsx`](../../../../../apps/control-center/src/components/execution-environment.tsx)、[`thread-control-center.tsx`](../../../../../apps/control-center/src/thread-control-center.tsx)、[`thread-sidebar.tsx`](../../../../../apps/control-center/src/components/thread-sidebar.tsx)、[`review-v4.css`](../../../../../apps/control-center/src/review-v4.css)）：输入框上方的状态条（如“严格模式 · 2 个程序在运行”），点开是“执行环境”面板，分当前模式、仍在运行的程序、不可用的工具三段；按 Esc、点面板外或打开所属对话会关上。侧栏里有程序在运行的对话名字前显示灰色转圈标记，与“待你确认”红点同一位置，两者都有时显示红点；系统要求减少动画时标记不转。列表刷新后、每次点开状态条时重新读取；有程序在运行且页面可见时每 15 秒读一次。三种语言文字都已加入。
- 与效果图的差别：效果图里“要停止某个程序，打开它所属的对话，在那一轮的执行过程里操作。”这句提示没有放进页面，因为还没有核实每类程序都能从那一轮的执行过程停止，写上可能误导。

## 自动测试

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| [`thread-contracts-v3.contract.test.ts`](../../../../../packages/gateway-contracts/test/thread-contracts-v3.contract.test.ts) 新增 1 项 | 拒绝未知模式、前台类别、多出的 `command` 或 `jobId` 字段、空开始时间、未知原因码、带 `threadId` 的查询 | [`unit.log`](unit.log)：与下几行合计 926 项通过 |
| [`production-execution-environment.unit.test.ts`](../../../../../apps/agent-service/test/production-execution-environment.unit.test.ts) 新增 4 项 | 每个工具按自己的能力核对；内置 `read` 两个操作任一被拒即列出；编码工具启用 `read` 时不再核对内置 `read`；没有工具时为空 | 同上 |
| [`production-http-composition.unit.test.ts`](../../../../../apps/agent-service/test/production-http-composition.unit.test.ts) | 经真实 HTTP：配置声明为真、查询返回严格模式快照；重启后不传执行环境时声明为假、查询被拒绝 | 同上 |
| 控制中心单元测试（[`apps/control-center/test`](../../../../../apps/control-center/test)） | 三种语言文字的键一致且都能格式化（含新增占位符） | 同上 |
| [`sqlite-sandbox-execution-v2.test.ts`](../../../../integration/sqlite-sandbox-execution-v2.test.ts) 新增 1 项（直接和 worker 两种连接各跑一次） | 真实 SQLite 里放入受控运行、正在停止、停止未确认、已严格释放、进程组已消失、前台、未启动七类记录，列表恰好返回前三类；分页、非法分页、其他 Agent 读不到；汇总按页读完、超上限报错 | [`integration.log`](integration.log)：与下两行合计 218 项通过 |
| [`production-task-environment-route.test.ts`](../../../../integration/production-task-environment-route.test.ts) | 严格模式拒绝时报告的原因码与准入拒绝一致；容器操作、SRT 模式、未声明的操作都不报告 | 同上 |
| [`sandbox-v2-payload-broker.test.ts`](../../../../integration/sandbox-v2-payload-broker.test.ts) | 手写端口补上新方法后原有断言不变 | 同上 |
| 真实浏览器：[`test-execution-chain-browser.mjs`](../../../../../scripts/test-execution-chain-browser.mjs) 执行状态场景新增一步 | 未声明时没有状态条；严格模式两个程序时状态条文字、侧栏两个转圈标记（宽度 ≥ 1024）、面板三段内容和 4 个列表项；Esc 关闭且焦点回到状态条；点“打开所属对话：研究记录”跳到该对话并关闭面板；换成默认模式且没有程序后，点开状态条即刷新为“默认模式 · 没有程序在运行”，侧栏标记消失；刷新页面后仍然正确 | [`browser-chrome.log`](browser-chrome.log) 和 [`browser-chrome/result.json`](browser-chrome/result.json)：已安装的 Google Chrome，12 个场景通过，其中 8 个执行状态场景（宽度 320、390、1024、1440 × 明暗）都含这一步；截图如 [`state-1024-light-environment-strict.png`](browser-chrome/state-1024-light-environment-strict.png)、[`state-390-light-environment-strict.png`](browser-chrome/state-390-light-environment-strict.png)、[`state-1440-light-environment-default.png`](browser-chrome/state-1440-light-environment-default.png) |

- 功能实现前，新增测试按预期失败：契约不认识新查询（[`contracts-before.log`](contracts-before.log)）；数据库没有列表（[`integration-before.log`](integration-before.log)）；准入没有暴露拒绝原因（[`integration-route-before.log`](integration-route-before.log)）；不可用工具模块不存在（[`unit-environment-before.log`](unit-environment-before.log)）；页面配置没有声明（[`unit-http-before.log`](unit-http-before.log)，接线测试晚于实现写成，取证时临时换回提交前的两个接线文件）；页面找不到状态条（[`browser-chrome-before.log`](browser-chrome-before.log)）。
- [`production-http-composition-process.test.ts`](../../../../integration/production-http-composition-process.test.ts) 在已安装的 `service-main` 上断言配置声明为真、查询返回默认模式空快照；这项需要预先打包的安装产物，只在完整 `npm test` 里运行，已在下面的完整运行中通过（未跳过）。
- 浏览器测试通过隔离的 HTTP 测试服务器取得后端状态，没有经过真实 Agent Service 或 Worker。运行前由 Claude 执行了 `npm run build:browser`（前端包 gzip 后共 182,582 字节，上限 184,320 字节；入口脚本 151,158 字节，上限 153,600 字节）。
- 顺带修正：[`biome.json`](../../../../../biome.json) 把 v5 效果图的两个 HTML 文件加入与 v4 效果图相同的免检查名单，否则 `npm run lint` 失败。
- 代码版本：提交 `206f0f1` 加本次改动（即本证据所在提交）。`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志去掉了终端颜色控制字符和本机沙箱打印的 `failed to copy trust settings` 行。
- 重跑：`npm run build:browser && node scripts/test-execution-chain-browser.mjs chrome <输出目录>`；集成测试 `npx vitest run --config vitest.workspace.ts test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/production-task-environment-route.test.ts test/integration/sandbox-v2-payload-broker.test.ts`（夹具要在 `/tmp` 下建目录、监听本机端口）。

## 完整 npm test

提交 `d4a98ef`：由 Claude 在本机运行 `npm test -- --output .ci-output/npm-test-d4a98ef`，运行期间没有改动工作区，全部通过：contracts 380、unit 2064、integration 1847、e2e 3、pi-compat 130，报告在 [`npm-test-d4a98ef.tar.gz`](npm-test-d4a98ef.tar.gz)。托管的 GitHub 检查没有运行（`hosted gate: not_executed`）。`d4a98ef` 之前的一个提交 `60dbab9` 只把 v5 效果图加入免检查名单，也被这次运行覆盖。

## 未验证的部分

- 没有在真实 Docker 和真实 Worker 上看严格模式下的状态条；列表来自执行记录，为空不证明宿主上没有残留进程。
- 只在 Google Chrome 上跑了浏览器测试。
