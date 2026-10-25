# P2 原队列恢复的真实 Worker 验收

[对应 Plan](../../../../../docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-queued-worker-proof)。本批补充上批已实现恢复行为的真实执行验证，未修改产品源码、Schema、依赖或权限规则。

导航：[已验证的行为](#已验证的行为) · [复现](#复现) · [验证结果与复用边界](#验证结果与复用边界) · [开发失败与复用经验](#开发失败与复用经验)

## 已验证的行为

[原生产恢复测试](../../../../integration/production-queued-run-restart.test.ts)在 macOS 显式开启 live 模式后，复用真实 ActionPolicy、Approval、授权预约、SQLite、Run dispatcher 与 Pi 批次恢复；通过 ProductionExecutionWorker、Payload UDS、真实 JobHost/SRT 和构建版 Pi runner 保存 `queued.txt`。

- 原调用排队时文件不存在、没有派发，批准和原额度预约已持久保存。
- 数据库重开、boot/fence 和 Run 租约更换后，两个生产 dispatcher 竞争，只有一个成功取得任务；没有重问同一批准，模型只调用一次，已完成的前序工具不重放。
- 独立文件读回为 `queued`；Worker 只产生一个 `work.result`。同一请求重放以及旧 fencing token 请求之后，内容、inode、mtime、ctime 均不变；旧请求准确得到 `WORKER_STALE_FENCE`。
- 独立 SQLite 查询证明原队列 JSON、顺序、期限不变，原预约由 reserved 变为 committed，Grant 与 Handle 各消费一次；未知 Run 不再成为可派发候选。
- macOS 不能证明任意后代已全部停止，因此仍为 `workspaceBlocked=true`、没有永久释放回执，Run 保持 `reconciling_external_result`。文件存在不代表资源已经获得释放证明。
- 关闭 Worker/Payload 服务后，测试独立查询短宿主目录与 Payload socket 目录，均返回 ENOENT。

执行消息走实际 Worker 的进程内端口，Payload 和资源事实走真实 UDS。模型是固定 Faux provider，owner 决定由测试直接提交真实 ApprovalService，安装资格仍为受控夹具；未模拟 Worker、JobHost、文件效果或结果回传。未杀掉操作系统 Agent 进程，未验证登录页面、完整安装资格、Linux 或付费 provider。

## 复现

在可运行 macOS SRT 的宿主上使用现有构建与 Vitest：

```sh
npm run build:node
HIMAWARI_LIVE_SANDBOX_PROBE=1 npx vitest run --config vitest.workspace.ts --project integration test/integration/production-queued-run-restart.test.ts -t 'coding=true.*resume' --testTimeout=240000
```

此命令只选中一个真实配置，另外 9 项显示 skipped 是筛选结果。默认 CI 仍收集并执行原来的 10 个确定性用例。本批没有降低校验强度或增加生产重试；真实配置用 300 秒执行期限、240 秒测试上限和 60 秒 Payload RPC 上限，普通用例的时间上限不变。完整安装包哈希独立测得约 9.56 秒，真实链路需要在多个边界重新校验，不能沿用普通夹具的 30 秒测试预算。

真实夹具使用构建文件的实际摘要和文件身份、短控制目录及真实时钟。Pi 继续提供工具定义、Operations 和顺序工具批次；Himawari 的既有实现负责授权、预约、恢复身份与受控文件保存，没有新增 Pi 协议。

## 验证结果与复用边界

- 最终真实路径通过：`himawari-queued-live-runtime-10.log`，1 项选中、9 项未选中，测试用时 69.85 秒。全部文件、额度、重复拒绝与目录清理断言均通过。
- 共享夹具的全部 6 个消费者文件、85 项通过；额度预约专项 6 项通过，覆盖未派发退款、撤回 Handle、回执与消费原子提交、重开幂等，以及拒绝不确定退款。它们与历史全套存在重叠，不能相加宣称新增测试总数。
- 本轮 Node 构建、最终类型检查、任务范围 Biome、边界、覆盖映射、不变量、秘密扫描、CI policy 通过。
- 全库 `npm run check` 在两份原有未跟踪原型 `verify.cjs` 的格式检查失败；全库 lint 同样有这两份文件的 `noInnerDeclarations` 错误，并输出 1,732 条 info。本批没有修改它们，不能报告全库 check 通过。
- 复用[上一批完整 4,024 项与标准构建](../p2-queued-run-restart-01/README.md)。[组合验证记录](verification-composition.json)逐项回读 1,024 个原冻结输入，仅共享 fixture 与原恢复测试改变，另新增 live Worker fixture；产品源码、构建、依赖、全局 setup 和配置均未变。消费者测试后仅调整 live 分支的旧请求构造与清理断言，由最终真实运行覆盖，不重新执行无关全套。

严格文档检查与任务差异检查结果见组合记录。原始日志和两个独立前置诊断脚本保存于 [raw-logs.tar.gz](raw-logs.tar.gz)，归档后逐文件读回校验字节与 SHA-256，未覆盖历史证据。

## 开发失败与复用经验

原始失败日志保留，未把夹具失败算作产品缺陷或成功验收：

1. 最初筛选未匹配用例；随后低估完整安装摘要成本，普通测试上限不足。测量实际摘要耗时后才采用单独 live 预算。
2. 最初选择 bash，但当前构建没有已安装的 `pi-tools/bin/bash`。本批目标是恢复后的一次文件效果，改用已有准备式 `write`，未额外安装解释器或修改产品能力。
3. 未绑定资源调用 journal reader 的诊断方式不正确，改用 admission reader；失败日志保留。
4. `runtime-06` 的临时本地诊断定位到 `JOB_HOST_NOT_READY`。独立复现确认原控制 socket 路径 156 字节，超过 100 字节上限；短目录为 79 字节。临时产品诊断已完全移除。
5. 短目录修正后，固定服务时钟与真实 JobHost 时间冲突；只改一侧后，Run 调度仍使用旧时间。真实配置统一使用当前时钟，普通配置保持确定性时钟。没有放宽观测新鲜度判断。
6. `runtime-09` 已产生真实文件，但拒绝用例改了消息 ID，先触发协议归属错误。最终保留原消息身份、仅改旧 fence，准确覆盖执行权检查；没有把断言弱化为“任意错误即可”。

后续接真实进程前，应一次检查构建入口、控制 socket 长度、各层时钟和协议身份；诊断应输出实际失败原因，再重跑对应路径。失败后反复执行完整恢复链会重复做安装校验，成本明显高于这些独立前置检查。此经验并入原 Plan 与原决策 TSV，不另建执行流程。
