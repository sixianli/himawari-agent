# P2 未准入队列的当前执行权绑定

## 验证边界

本批验证的是：调用方已经取得合法的当前 Run 租约时，原未消费队列可更换 Worker boot 或产品 fence，保留原批准、Handle、目标、期限和队列顺序，至多产生一次准入和派发。

这不等于 Agent 崩溃后的整轮自动恢复。当前 `runtime_running` checkpoint 仍进入结果核对，`RuntimeContinuationService` 仍拒绝旧 fence 的恢复记录。生产 Run 包装层在 Pi 工具列表读取前调用绑定服务，但尚未打通这两处上游入口。原 Plan 的跨 boot/fence 完整待办仍未勾选。

## 实现与证据

- Schema 44 保留原队列 JSON，追加不可修改的绑定历史；旧 schema 43 writer 被最低写入版本阻止，原迁移历史不变。
- 一个 immediate 事务核验当前 Authority Lease、Run Lease、零回执/零准入、原 Grant/Handle 及 CAS revision，并更新 Handle fence 和绑定。更新失败全部回滚。绑定不消费次数、不占用工作区。
- 生产 Sandbox 服务重新读取受保护原 Scope 并验证目标；RuntimeTools 用原请求的旧 authority 校验逻辑调用摘要，以当前已验证绑定派发。已准入记录只能返回历史结果。
- 存储回归覆盖旧绑定、取消、准入、目标/期限改变、撤销、到期、已用 Handle、旧租约、CAS 竞争、写入失败、数据库重开及一次消费。
- `production-sandbox-queue-reentry.test.ts` 使用真实持久仓库、Grant/Handle、受保护 artifact 和 Authority/Run Lease 接口；Worker transport 是受控替身，fixture 的 Run 从合法 `context_formed` 开始，明确不模拟崩溃的 Pi Run。独立真实 Pi 循环测试检查包装层先执行绑定回调，再读取工具列表；两条测试不能合称完整重启 E2E。

## 失败与修正

新增接口前的测试确认绑定入口缺失；“deadline 改变”初版错误地使用原截止时间，修正为原期限加一秒后验证拒绝。摘要验证初版把完整 RPC scope 当作 authority，导致摘要多出字段；修正为原三个 authority 字段。重启 fixture 初版沿用旧父调用注册表，正确触发 peer 变化拒绝；改为重建注册表。真实 Run Lease 切换检查暴露原 fixture 没有可派发 checkpoint，这也揭示完整崩溃恢复入口仍未实现；服务层测试明确建立合法 checkpoint，未修改生产拒绝规则。该 checkpoint 的 Payload 也必须由真实受保护 artifact 写入，不能填不存在的引用。

迁移检查捕获未更新的 schema catalog、历史测试的最新版本断言、只读核查脚本版本上界；均按 Schema 44 更新，没有删除断言或放宽旧 writer。

## 运行结果

[标准构建](standard-build-result.json)通过，用时 179,415 ms；[完整标准测试](standard-test-result.json)通过 249 文件、4,010 项，零失败、零跳过，用时 746,315 ms。最终结果来自同一版源码，未拼接旧候选测试。[1,016 个冻结输入](frozen-inputs.json)均未变化；报告的 `testedSha=59634ba…` 是带本批未提交改动的运行基线，不能解释为只测试了该提交。

定向结果包括 315 项存储/迁移消费者、8 项队列生产服务、8 项真实 Pi 包装层顺序、125 项服务单元测试及其他授权、只读核查与兼容测试。类型、任务范围 Biome、边界/覆盖/不变量/秘密/CI policy 通过；5 份 Runbook 已静态封存，严格文档检查零警告。全库格式/lint 仍仅被两份原有未跟踪原型 `verify.cjs` 阻断。新增文档链接的文件目标与锚点已静态检查，未声称实际点击验证。

[原始日志归档](raw-logs.tar.gz)包含 35 份首次失败和修正后的实际日志，逐文件回读验证原始字节一致。[验证摘要](verification.json)保留范围限制。筛选测试的 skipped 表示未选中的用例，不是删除或禁用测试。没有执行真实模型调用、生产迁移或远端变更。
