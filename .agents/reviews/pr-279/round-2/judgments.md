# 第 2 轮（提交 f1ce4916，只看增量）线程逐条判断

- r2-ds-1 start 清掉取消标记：成立，中高（模型：中）。已改：标记不再被清，停止后 start 以 PROACTIVE_REPLAY_STOPPING 拒绝；用例在旧写法下最终状态是 finished，会失败。
- r2-ds-2 service.deleteRun 生产无调用方：成立，低。依据：只有测试调用；标注界面 PR 接入。已改：不再把它称作“生产修复”，PR 说明与汇报写明是预留入口；schema-catalog 同第 1 轮。
- r2-ds-3 删行后释放的崩溃窗口：不成立。依据：这个顺序与现有 removeSource/clearRecords 完全一致（先返回引用再由调用方释放）；先删 payload 会被 ON DELETE RESTRICT 挡住，顺序是必须的。
- r2-ds-4 范围比较用字符串：成立，低。已改：用 Date.parse 比较。同条里“Gmail after: 下界严格”只影响等于下界的一封，没有错误结果，不改。
- r2-ds-5 新测试覆盖不足：成立但属“可以更好”。依据：我临时写了 ProductionProactive.stop() 在回放卡住时调用的用例，用现在的代码通过（已实际运行，未提交）；范围外邮件的用例本来就在（“drops mail outside the asked range”）。
