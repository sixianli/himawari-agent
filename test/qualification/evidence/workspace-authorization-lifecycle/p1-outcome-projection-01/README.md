# P1 产品结果证据与历史工具展示

基线 `afdf110`，沿用 Schema 43 和既有 Gateway 事件。生产展示投影应反映真实产品结果，不能将 Pi 的历史错误标志当作唯一事实来源。

## 复现与修复

[失败前结果](projection-red.log)：worker/direct 两种 SQLite 执行方式各有四项失败，共 8 项失败、8 项通过、118 项因名称过滤而跳过。失败分别为：文件冲突缺少未派发标记；产品失败没有错误码时被标完成；产品未知没有错误码时被标完成；未知结果被未派发错误码覆盖。另有未知与文件冲突并存、历史未知错误码及两种正常成功回归，保证优先级修复不扩大成功或重试判断。

[初轮修复后相关回归](projection-green.log)：Thread 生命周期完整集成测试与前端状态消费者单元测试，2 文件、152 项全部通过。新回归使用真实 SQLite、受保护 Payload、Trace 和生产 ThreadExecutionProjection；独立读取结果标记、工具 phase、内容和序号，重复读取保持不变，缺少真实执行起止时不生成时长。

固定 Pi 0.84.2 的 `ToolResultMessage.details/isError` 和原工具事件继续使用。已检查 canonical pi-mono 中对应类型与 emitToolExecutionEnd，以及安装版本的声明；没有修改 Pi、模型配置、工具调用或结果交付权限。Himawari 负责解释自己保存的 productOutcome 与安全原因，保留相互矛盾事实中的未知状态，不根据显示修复自动执行或重试。

补充审阅增加[矛盾结果回归](contradiction-red.log)，worker/direct 共 4 项失败：`succeeded` 与未派发错误码并存仍被显示为未派发。已明确停止旧候选版本的标准 CI 进程组，退出 143；[初轮运行记录](initial-run.json)、[初轮冻结](input-freeze-initial.json)和[初轮构建](initial-build-result.json)仅是历史证据，不作为最终通过结论。修复后矛盾结果也保留为未知，[最终相关回归](projection-final.log)为 2 文件、156 项全部通过。已独立确认旧验证及其遗留集成测试进程组均无成员，再重新冻结全部输入并使用新的 CI 输出目录。

## 验证入口

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/thread-run-lifecycle.test.ts -t 'preserves product outcome evidence'
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/thread-run-lifecycle.test.ts --project unit apps/control-center/test/execution-view.unit.test.ts
npm run typecheck
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p1-outcome-projection-02
```

[最终类型检查](typecheck-final.log)、[最终任务范围格式/lint](scoped-check-final.log)及[最终静态检查](static-final.log)通过。[最终标准构建](standard-ci-build-result.json)通过；[最终标准测试](standard-ci-result.json)为 244 文件、3,840 项全部通过，零失败、零跳过。[分组结果](standard-test-projects.json)正常退出，[本地汇总](standard-ci-local-summary.json)为 `local_passed`，hosted gate 未执行。[输入冻结](input-freeze.json)记录类型检查通过后的 1,092 个代码、测试和配置输入；CI testedSha 是基线 HEAD，实际测试工作树包括本批改动。

本批不修改页面布局或交互；前端对既有 not_dispatched/unresolved 标记的消费者回归通过，没有执行浏览器探索或真实 Gateway→Worker→浏览器联合验证。全部业务阶段、效果与下一动作仍按 Plan 验收。没有生产迁移、部署或付费模型调用。

[最终冻结复核](freeze-check-final.json)确认 1,092 个输入在最终验证期间未变。三个受影响 Runbook 已语义核对、封存和检查，见[记录](runbooks-final.log)；[严格文档检查](docs-final.log)通过。[本地链接检查](doc-links.json)验证目标存在和显式锚点唯一性，没有执行阅读器点击。全库 `npm run check` 仍仅由原有两份未跟踪原型格式问题阻断，见[日志](full-check.log)。本批 Architecture、Plan 和三个 Runbook 已更新，原 Spec、ADR、Pi 与 Gateway 协议不变。日志只清理行尾空白和末尾多余空行，失败证据保留。
