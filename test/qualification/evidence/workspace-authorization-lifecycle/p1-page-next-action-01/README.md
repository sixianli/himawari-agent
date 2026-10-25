# P1 页面下一步指引与业务失败分类

日期：2026-09-23 UTC。范围是 P1 页面安全提示及可核验的命令失败说明；不是 P1 全部完成证据。

## 改动

- `apps/control-center/src/execution-view.ts` 根据持久化 `ThreadExecutionState` 和真实 `availableActions` 选择下一步提示；不会自动重试、推断资源已释放或声称文件回滚。
- `apps/control-center/src/components/execution-process.tsx` 展示提示；英文、简体中文、日文文案同步更新。
- 明确未派发、等待核验、停止后已有结果、部分成功后失败与普通失败分别使用各自已有状态。`SANDBOX_COMMAND_EFFECT_UNVERIFIED` 表示命令已失败但没有证明工作区未变，页面告知用户先检查工作区。
- `apps/agent-service/src/production-sandbox-tool-result.ts` 仅在已知命令非零退出且效果为 `not_asserted` 时给出上述安全原因码；不会把失败改成成功，也不会把部分效果编成确定事实。
- `apps/agent-service/test/production-sandbox-tool-result.unit.test.ts` 覆盖错误命令、成功命令及固定文件操作，防止把固定文件失败误归类为命令部分效果；Agent 层另测失败结果对模型的安全提示。
- `test/integration/sqlite-sandbox-execution-v2.test.ts` 新增真实 Shell 写文件后以退出码 7 结束的 SQLite 结果回归，在 `worker` 和 `direct` 两种执行模式中验证失败原因及持久交接。

<a id="verification-2026-09-23"></a>

## 验证

- 通过：Agent 服务定向单测 76 项（`production-sandbox-tool-result.unit.test.ts` 与 `production-runtime-tools.unit.test.ts`）。
- 通过：`thread-execution-state.unit.test.ts` 25 项，覆盖安全原因码持久状态投影。
- 通过：`execution-view.unit.test.ts` 28 项，覆盖页面阶段、错误原因、安全下一步和进度延迟。
- 通过：`job-host.unit.test.ts` 与 `job-host-main.unit.test.ts` 共 56 项，覆盖总期限、IPC 无进展后的停止请求、独立清理宽限及不得把 SRT reset 当作树清理证明。
- 通过：完整 `sqlite-sandbox-execution-v2.test.ts` 集成文件使用 Vitest 单 worker 线程池执行，190/190 项通过，包含 `worker`、`direct` 两种模式。第一次红测暴露夹具身份/断言问题，修正后全文件回归通过；原始输出见 [`raw-logs.tar.gz`](raw-logs.tar.gz) 中的 `sqlite-sandbox-execution-v2.log`。
- 通过：Biome 对 17 个改动 TS/TSX 文件的定向检查退出码为 0；工具报告 59 条可选字面键风格提示，没有自动改写。
- 通过：Control Center Vite 生产构建及仓库 `build:browser` 检查通过；此前 `parse.fastpaths` 错误未在重跑中复现。
- 未验证：`thread-interactions.unit.test.ts` 的 DOM 断言未到达。单独使用单 worker `threads` 池仍在 60 秒 worker 初始化期限触发启动错误，0 项测试。
- 未完成：`npm run typecheck` 首个 TypeScript 项目 180 秒无输出后被有界执行器停止；没有类型检查通过或类型诊断结论，原始输出见 [`typecheck-rerun.log`](typecheck-rerun.log)。
- 通过：受影响的 authority-transfer、backup-restore、Hermes upgrade 和 install-start-stop 正式 Runbook 均重新封存并通过静态合同检查。仓库 strict 文档检查仍报告四个预先存在、未跟踪且由用户持有的 `* 2.md` 副本 hash 过期；它们已原样保留。
- 通过：`npm run check:ci-policy` 在按 `package-lock.json` 锁定的 YAML 2.8.3 官方 tarball 恢复本地依赖后通过，覆盖 308 个文件及六个 Vitest 项目。失败根因是旧安装目录中的模块文件带 macOS `dataless` 标记，导致 Node 实际加载的导出不完整；仓库清单和脚本无需改动。
- 未完成：`npm run check:secrets` 扫描 tracked 与未跟踪文件，超过 120 秒仍无输出后停止；没有扫描结果，不能按通过处理。原始终端未输出可保存的 findings 或报告。

<a id="revalidation-2026-09-25"></a>

## 2026-09-25 复验

[2026-09-23 的验证记录](#verification-2026-09-23)，其中未验证和未完成的几项已在本次复验中补上。本次复验基于提交 `c18b70a` 加上这批未提交的改动，原始日志按仓库惯例打包在 [`revalidation-2026-09-25/raw-logs.tar.gz`](revalidation-2026-09-25/raw-logs.tar.gz)，下文的“证据”列写的是包里的文件名；可用 `tar -xzf raw-logs.tar.gz` 解开查看。

复验前做的清理和修正：

- 删除了仓库里 60 个 iCloud 同步冲突时自动生成的副本文件（文件名末尾带“ 2”“ 3”等编号）。其中两个副本位于 Control Center 源码目录，是 09-23 类型检查失败和 Hermes 升级 Runbook 摘要不一致的原因：把这两个副本从提交 `4a46df3` 临时恢复后，Runbook 检查通过；再移走后又失败。
- `thread-interactions.unit.test.ts`（在模拟浏览器环境里渲染会话页面并检查页面内容的组件测试）中，“状态原因”一步在改了测试数据后只重新渲染、没有调用 `refresh()` 重新读取状态，所以页面上还是旧内容。这是测试本身写漏了一步，不是产品问题；补上 `await refresh();` 后通过。
- `test/integration/production-sandbox-queue-reentry.test.ts` 原来要求“执行前权限变化”场景一律返回笼统的 `WORKER_NOT_DISPATCHED`（未派发）。这批改动按计划把未派发细分成具体原因，其中能力被停用时返回 `WORKER_AUTHORIZATION_DENIED`（权限已失效），资源上限被收紧时返回 `WORKER_RESOURCE_CEILING_CHANGED`（资源上限已变化）。这两种场景的测试期望已按新合同改为具体原因码；“未派发”“不改审批历史”“不产生执行消息”等原有断言保持不变。逐个场景的实际返回值是临时记录下来核对的，核对后记录代码已撤掉。
- 已提交代码中两处格式和 lint（代码风格检查）问题单独修复在提交 `c18b70a`。

复验结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck`（TypeScript 类型检查） | 通过 | 包内 `check-final.log` |
| `check:boundaries`、`check:v0.2-coverage`、`check:v0.2-invariants`、`check:ci-policy` | 全部通过 | 同上 |
| `format:check` 与 `lint` | 各只有 1 个错误，都来自不属于本批、未被 Git 跟踪的 `docs/assets/control-center/2026-09-16-state-review/verify.cjs`，原样保留 | 同上 |
| `npm run check:secrets`（密钥泄露扫描） | 通过，扫描 3680 个文件 | 同上 |
| `npm run build`（完整构建） | 通过，用时 59 秒 | 包内 `build.log` |
| 全部 Vitest 测试项目一起运行 | 共 6141 项：6116 通过、14 失败、11 跳过；本批相关文件全部通过，包括 `thread-interactions.unit.test.ts` 41 项、`execution-view.unit.test.ts` 27 项、`production-runtime-tools.unit.test.ts` 73 项、`thread-execution-state.unit.test.ts` 25 项和 `sqlite-sandbox-execution-v2.test.ts` 190 项。失败原因见下一张表 | 包内 `all-projects.log` 与 `all-projects.json` |
| 修正后对失败文件重跑 | 队列重入测试 22 项、`prepare-file-mutation.compat.test.ts`、`gate-installation.test.mjs`、`main-confirmation.test.mjs` 通过；剩下 9 项失败的原因与下表一致 | 包内 `focused-rerun.log` |
| Hermes 升级 Runbook | 把本批新增段落里“DOM 尚未通过”的说法改成符合本次结果的描述后重新封存；静态合同检查通过，`validate_docs.py --strict` 0 警告 | [Hermes 升级 Runbook](../../../../../docs/runbooks/hermes-control-center-upgrade-runbook.md) |

全量运行中的失败都与本批改动无关，原因如下：

| 失败 | 原因 | 判断依据 |
| --- | --- | --- |
| `production-sandbox-queue-reentry.test.ts` 2 项 | 测试期望没跟上本批的原因码细分，已按上文修正 | 修正后 22 项通过 |
| `installable-node-services.test.ts`、`production-http-composition-process.test.ts` 整个文件未运行 | 这两个文件要求先由 `npm test` 生成安装产物并通过环境变量传入；本次没有运行 `npm test`，因为它需要先用 `npm run ci:tools` 下载固定版本的 CI 工具，这一下载没有获得授权 | 错误信息 `INSTALL_TEST_REQUIRES_PREBUILT_ARTIFACT` / `PROCESS_HTTP_TEST_REQUIRES_PREBUILT_ARTIFACT` |
| `prepare-file-mutation.compat.test.ts` 1 项 | 全部测试并行时机器负载高，用时 5041 毫秒，超过 5 秒默认超时 | 单独重跑通过 |
| `gate-installation.test.mjs`、`main-confirmation.test.mjs` 各 1 项 | 测试把解析过符号链接的真实路径和未解析的临时目录路径直接比较；macOS 上 `/var` 是指向 `/private/var` 的符号链接，所以 `TMPDIR` 不是真实路径时必然不相等 | 把 `TMPDIR` 设为真实路径后通过 |
| `toolchain.test.mjs` 1 项 | 治理工具目录 `tools/document-governance/` 里有被 `.gitignore` 忽略的本地文件：macOS 访达生成的 `.DS_Store`，以及运行 `runbook.py` 时 Python 自动生成的 `__pycache__`（字节码缓存）；检查要求目录里只有登记过的文件 | 在临时 `git worktree`（同一仓库的另一个干净检出目录）里对 `HEAD` 运行同一检查通过。`__pycache__` 已删除，`.DS_Store` 属于访达，保留 |
| `artifact.test.mjs` 7 项 | 需要 `HIMAWARI_CI_PYTHON` 指向 `npm run ci:tools` 下载的固定版本 Python，本机没有 | 错误信息 `ARTIFACT_LOCKED_PYTHON_REQUIRED` 及由此引起的空路径错误 |
| `artifact.test.mjs` 1 项 | 已提交代码原本就有的问题：提交 `dbbce3e`（2026-09-21）让打包脚本 `scripts/package-node-runtime.mjs` 编译 `rename-native.c`，但该测试的临时夹具（2026-09-15 编写）没有提供这个文件 | 本批没有修改 `scripts/` 和 `test/tooling/`；已作为单独任务提出，不在本批修复 |

未验证范围：没有运行 `npm test`（原因同上），因此标准 CI 流程里的安装产物测试没有覆盖；真实 Gateway→Worker→页面的联合路径和完整安装资格仍未验证。全量测试在 Claude Code 沙箱外运行，因为沙箱禁止部分测试直接写 `/tmp`（创建临时目录时报 `EPERM`，即“无权限”）。

## 脱离进程组的平台候选探针

[OrbStack 隔离探针](../p1-orbstack-probe-01/README.md)在 macOS 27.2 / OrbStack 2.2.3 上使用固定摘要 BusyBox 镜像、禁网容器和独立临时挂载目录。容器写入进程的进程组与 session 均不同于容器主进程；停止请求等待 2 秒后，Docker 状态独立读回 `exited / false / pid=0 / exitCode=137`，停止返回后的文件计数保持不变。该探针证明这是一个值得接入评估的候选，不证明产品 SRT/Job Host 已使用 Docker/OrbStack，也不证明产品已保存独立释放回执或完成完整安装资格。

启动 OrbStack 时，原有 `just-rag-postgres` 容器被 Docker 自动恢复。测试没有向它发送命令；在结束时对该容器执行了有 10 秒期限的正常停止，并确认 OrbStack 恢复为 `Stopped`。为保持 OrbStack 停止，探针拉取的约 2.2 MB BusyBox 镜像暂留在其镜像缓存中；没有删除其他镜像、容器或数据。项目文件之外的 OrbStack 配置、数据和日志未纳入提交。

## P1 边界

P1 页面下一步指引和命令失败效果提示已有定向单测及 SQLite 双执行模式目标回归，Control Center Vite 构建也通过。会话页面组件测试和 TypeScript 类型检查已在 [2026-09-25 复验](#revalidation-2026-09-25)中通过；真实页面联合验收仍未完成。当前产品仍运行现有 Mac SRT，后代写入探针仍证明脱离 `setsid` 的子进程可以在停止后继续写入，现有实现只能记 `cleanup=unknown` 并阻止冲突任务。OrbStack 候选尚未接入产品；严格 Plan 仍须在完成后通过产品 Job Host、独立释放回执及真实安装产物验证后才能勾选。当前 ADR 0025 仍明文维持 SRT 本地主机路线；把容器运行时接入此 P1 主链会改变已批准的执行后端与安装前提。继续前须由 Owner 明确选择是否批准此架构变化；在决定前，Plan 与 P1 勾选保持未完成。

Git Graph 的本地坏分支引用已更名修复；提交树及 pack 校验通过。原 pack 损坏判断已被后续核验证伪。Git Graph 面板是否需点击 Retry/重开未在 GUI 中观察。

进一步决策见[单一决策日志](../decisions.tsv)；阶段边界见[已归档的 P1 实施计划](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p1-next-action)；后续实施由[隔离执行实施计划](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#transfer)接续。
