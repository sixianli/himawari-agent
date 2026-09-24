# P2 网络权限与实际撤销状态

本批按 [Plan 当前批次](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#current-batch-contract)实施。基线 `e0f2b8d`，使用 Node 22.22.3、SRT 0.0.75 和本机 Mac。标准构建与完整测试通过；本记录只覆盖下述行为，Plan 其他待办继续保留。

## 已建立的行为

- DNS 前、拨号前及已有连接周期均核对当前权限，拒绝过期/重放回复，核验超时关闭出口；原 Worker IPC 与 Payload UDS 不增加新服务。
- 实际构建 Worker 与 Job Host 先建立连接，再撤销操作 Grant 或目录授权；原调用输出通过持久回执独立解密读回，重复请求未重复执行。
- 目录撤销不修改操作 Grant，排队原计划不能绕过撤销续接；原队列与批准记录保持。
- 浏览器状态直接由实际 `ThreadExecutionProjection` 读取 SQLite，不在撤销后注入事件。目录联测经过 5 次状态查询，显示执行中→结果未确认，刷新后保持。见 [浏览器报告](browser-live-07/result.json)与[撤销后页面](browser-live-07/revoked-unknown.png)。Mac 本次取得停止结果耗时 432 ms，不能据此保证所有运行的延迟。
- `cleanup=unknown`、工作区仍占用，未把 Mac 主进程退出当作所有后代停止。真实受控期间尚无最终结果显示执行中，显式未知或观察过期继续未确认。

## 验证入口与边界

复用 `npm run build:node` 构建实际 Job Host；这是标准全套前验证生产路径所需的独立产物。普通定向集合 15 文件、220 项通过，另有类型和任务范围格式/lint。[标准构建报告](standard-build-result.json)与[标准测试报告](standard-test-result.json)保存原始报告副本：248 文件、3,968 项通过，零失败、零跳过。[既有 Chrome 回归](browser-regression/result.json)12 场景通过。边界、覆盖映射、不变量、秘密扫描、CI policy 和严格文档检查通过。全库格式/lint 的错误只来自原有未跟踪的 state-review、state-review-r2 两份 verify.cjs，本批定向格式/lint 通过。原始标准 CI 明细保留在仓库 .ci-output/p2-network-authority-01/；报告的 testedSha 是运行基线，实际输入还包含本批未提交实现，不能将它解释为仅测试该基线提交。

```sh
HIMAWARI_LIVE_SANDBOX_PROBE=1 HIMAWARI_QUALIFY_INSTALLED_RUNTIME="$PWD/dist/node-runtime" node packages/runtime-sandbox/scripts/qualify-production.mjs --v2 --revoke-directory --browser-output test/qualification/evidence/workspace-authorization-lifecycle/p2-network-authority-01/browser-next
```

操作 Grant 分支的[实际结果](action-live.json)与[页面报告](browser-action-01/result.json)也通过，本次观察停止结果耗时 734 ms；目录分支见[实际结果](directory-live.json)。两者均保留未知清理与必要占用。

将 `--revoke-directory` 换成 `--revoke-network` 检查操作 Grant。输出目录必须选择新的名称。探针只用合成权限、受控安装资格和临时文件，连接公开 npm registry，不调用模型或付费接口。浏览器沿用原导航/认证 HTTP 夹具，并把导航 Run 关联到实际 Run revision；没有放宽网关解析或版本一致性校验。执行状态、授权查询、Worker、Job Host、SQLite、输出读取使用真实产品实现；这不是完整生产登录、模型循环、全部工具行/审批红点或 Linux 平台资格。

## 失败与修正

- 原网络失败前测试的 dial 替身返回空值，错误来自 socket 清理，不能作为权限缺陷失败前证据。本轮补真实本地 socket 与正向连接控制，保留原失败日志。
- 实际联测发现“受控执行但无最终结果”被投影成未知。新增回归先通过 `phase=executing` 前置断言，再在页面结论断言失败；修复后连同显式未知、观察到期的边界通过。修复没有改变 v3 wire 枚举。
- 探针原竞争预约共享被撤销 Grant，无法再用它测试工作区释放；撤销场景改为独立读回占用，不把授权拒绝当作占用证据。未知结果的输出从原调用回执读回，不假定它有成功结果字段。
- 联测夹具修正了 Run 初始 revision、实际 revision 关联与浏览器先于 SQLite 的关闭次序。失败文件和原始 stderr 保留；这些错误不计作产品缺陷复现。

所有失败诊断与通过日志保存在本目录的原始归档中；临时数据库和运行目录清理后，浏览器报告与截图仍保留。已只读核对没有遗留本批 HTTP fixture/qualification 进程。
