# P1 持久资源核查调度

本批基线 `5f7a415`。在原恢复记录和生产 Run 循环中加入资源核查调度，Schema 43 保留历史记录并设置旧 writer 屏障；不增加模型调用、工具重放或执行授权。

## 已验证行为与证据

- [循环缺口复现](loop-red.log)：资源扫描未被调用，三个新增调度/关闭用例失败；[修复后循环回归](loop.log) 12 项通过。资源检查等待期间，无关 Run 扫描继续；单个资源扫描不可重入，服务关闭取消并有限等待。
- [相关回归](consumers.log)：9 个文件、319 项通过。覆盖终态及结果待核实 Run 的独立发现、事务比较、未绑定预约禁止启动、等待与实际开始分开、失败暂停、后续新停止义务、分页越过暂停/其他宿主、次数及并发上限、取消与迟到回调、数据库重开和充分证明释放。
- Schema 42→43 使用有数据的数据库与真实迁移引擎，保留历史恢复、claim 和 migration ledger，旧 writer 被拒绝。旧记录只补空的下一核查时间；只读 CLI 的新动作/时间字段有数据库字节不变断言。
- 生产路径使用真实 SQLite、受保护 artifact、认证 UDS、安装字节核查及真实测试子进程退出。原 Grant 撤销后仍能进行有限清理，释放后停止标记仍阻止启动；宿主状态和平台资格为受控输入，不是任意进程树资格。
- 排定但未开始的核查不增加次数，不虚构开始/期限。已接纳释放而恢复元数据滞后时，结束等待且不新增宿主调用。业务结果/效果仍按原记录保留，资源释放不推断工具成功。

## 失败记录的解释

`scheduling-initial.log` 使用了已经关闭的 fixture repository；`scheduling-second.log` 把可选的 `workspaceBlocked` 当作未绑定预约必填字段，并使用超过 30 秒上限的测试期限。改为真实重开 repository、独立 SQL 读回 active claim 和合法期限后，[第三次执行](scheduling-third.log) 14 项通过。

[扩展夹具失败](scheduling-expanded.log) 来自未绑定预约的候选 plan 尚无最终 fingerprint；证明改用实际入库 plan。[迁移与扩展测试](migration-and-scheduling.log) 还发现测试同时开启两个独占 repository，以及给 released 观察保留不允许的 reasonCode 字段；分别改成先关闭再重开和按资源合同构造观察。[修正后调度测试](scheduling-final-candidate.log) 28 项通过。以上为夹具问题，不报告为产品缺陷，也未放宽资源释放断言。

[类型检查初次结果](typecheck-final.log) 拒绝一个可能为空的测试 revision。现已明确检查 running 状态后才使用它；修改发生在标准集成测试运行前，产品构建输入未改变，变更时间与唯一文件记录在 [输入冻结记录](input-freeze.json)。

## 验证命令与范围

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project integration test/integration/sandbox-resource-recovery-scheduling.test.ts test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/workspace-lifecycle-audit.test.ts test/integration/production-sandbox-scope.test.ts test/integration/sandbox-control-evidence.test.ts --project unit apps/agent-service/test/production-run-dispatch-loop.unit.test.ts --project contracts packages/persistence-sqlite/test/migration-engine.contract.test.ts packages/persistence-sqlite/test/model-budget-migration.contract.test.ts packages/persistence-sqlite/test/run-checkpoint-migration.contract.test.ts
npm run typecheck
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p1-recovery-scheduling-01
```

当前后台装配随生产 Run 循环运行。未启用该循环的服务模式仍只有原启动登记，需要后续补齐；完整业务错误分类、结果交付恢复、页面下一动作及平台资格继续按 Plan 验收。本批未执行生产迁移或部署。

## 最终验证

- [标准构建](standard-ci-build-result.json)全部 8 项通过，产物摘要 `f96250542e108012a73279d772f53258ad54d6c37cd4cf96eee8eacddb3de5d6`。
- [标准测试](standard-ci-result.json)为 244 个文件、3,802 项全部通过，零失败、零跳过；[分组结果](standard-test-projects.json)记录每个进程正常退出。[本地汇总](standard-ci-local-summary.json)为 `local_passed`，hosted gate 未执行。
- [输入复核](freeze-check-final.json)确认修正测试类型之后的 1,092 个代码、测试和配置输入未再改变。测试读取当前工作树；CI 元数据中的 `testedSha` 是本批开始时的 HEAD，不能单凭该字段把结果归到尚未包含本批修改的旧提交。
- [修正后类型检查](typecheck-corrected.log)、[最终任务范围格式/lint](scoped-lint-final.log)、[边界/覆盖映射/不变量/秘密扫描/CI policy](static.log)、[严格文档检查](docs-final.log)通过。五份 Runbook 完成语义核对、治理工具封存和检查，见[运行维护文档记录](runbooks.log)。
- [全库 check](full-check.log)仍在原有两份未跟踪原型 `verify.cjs` 的格式处失败；未修改这些文件，不将任务范围检查称为全库通过。
- [文档链接检查](doc-links.json)核对本地目标存在与显式锚点唯一性；未进行阅读器点击验证。

日志仅清除行尾空白和末尾多余空行；失败日志保留。Architecture、Plan 和五份 Runbook 已更新，原 Spec、ADR 及 Worker 工具合同没有变化。
