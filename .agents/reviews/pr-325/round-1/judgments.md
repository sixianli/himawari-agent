# PR 325 第 1 轮复核逐条判断

复核提交 157812090bd6（经 Magpie，两个模型都跑，花费 0.2116 美元）。

“会出错”的中高意见是 D1、G1：被删的 `session.revoke` 仍留在 `packages/integration-github` 的一个测试里，运行时会解析失败；D2、G2：新检查抓不到“约定里删了、代码和测试里还在用”的残留。两条都成立，已修改，需要第 2 轮复核。机器可读的版本在 `verdicts.jsonl`。

| 编号 | 意见 | 类别 | 判断 |
|---|---|---|---|
| D1、G1 | 测试仍用已删的 `session.revoke` | 会出错（中高） | 测试改成 `grant.revoke`，integration-github 全部测试通过。 |
| D2、G2 | 检查看不到已删操作的残留引用 | 会出错（中高） | 新增 `ci/operations-removed.json`（26 个名字），检查它们不得回到约定，也不得再以 `type: "名字"` 或 `case "名字"` 出现；加了反向用例。 |
| D3、G7 | 0085 缺旧数据迁移测试 | 会出错（低） | 新增 `memory-reminder-cancelled-migration.contract.test.ts`：旧的待办和已忽略提醒原样保留，接受 `cancelled`，拒绝没有时间的 `cancelled`，两个索引在，外键检查为空。 |
| D4、G3、G4 | 页面清单和 ADR 文字不一致 | 会出错（低） | ADR 补写页面状态；任务页保留 `github.monitor.set_state`，会话与设备页靠原生设备入口显示。 |
| D5、G6 | 目录描述过时 | 会出错（低） | 已改。死的 `inbox.digest` 界面文案不动（i18n 不在检查范围，不影响行为）。 |
| D6 | 已取消的提醒还能被再安排 | 会出错（低） | 已取消的提醒只接受再次取消，其余返回 `MEMORY_REMINDER_CANCELLED`，加了测试。 |
| G5 | 检查的判定偏松 | 可以更好 | 不改，列给 Andy。 |
