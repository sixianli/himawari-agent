---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "test/integration/sqlite-sandbox-execution-v2.test.ts, test/integration/thread-run-lifecycle.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0140：提前收尾只用于没有可恢复结果的“结果未知”轮次

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0127](0127-settle-unknown-result-run-once-resources-released.md)（提交 `1704efc`）让“结果未知”（诊断码 `RUNTIME_TOOL_RESULT_UNKNOWN`）的轮次，在它用到的沙箱都释放后立刻收尾，不再等命令自己的截止时间。

`1704efc` 合并后，`main` 上 62 条集成测试失败（`test/integration/sqlite-sandbox-execution-v2.test.ts` 58 条，`test/integration/thread-run-lifecycle.test.ts` 4 条）。第 63 条 PG-12 是云端容器缺浏览器路径，不是代码问题。用 `1704efc^` 和 `1704efc` 各跑一遍相关用例：前者通过，后者失败（二分，数据坐实）。

原因：恢复循环 `pump()` 先收尾过期的轮次，后认领“迟到结果恢复”。提前收尾让已经有结果、或者结果丢了但系统有办法补救的轮次，在恢复接手之前就被判失败。收尾的候选查询和收尾时的检查还不一致：夹具里命令记录的截止时间与轮次截止时间不同，收尾检查拒绝并抛出 `Expired Run is not ready for authenticated settlement`。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. 提前收尾的条件加上“不属于迟到结果恢复”：直接复用恢复自己的判断 `SANDBOX_TOOL_RESULT_RECOVERY_SQL`，不另写一套。能恢复的轮次，仍交给恢复。
2. 提前收尾同时要求这一轮没有未决的模型调用（状态 `reserved`、`started`、`unknown`），和恢复一致；模型结果未知的轮次仍等到截止时间。
3. 提前收尾后的轮次，页面不再显示“重试清理”按钮：没有东西需要清理（`thread-execution-state.ts`）。
4. `RUN_EXPIRED_RECONCILIATION_SQL` 从 `sqlite-run-resource-guard.ts` 移到 `sqlite-sandbox-tool-result-recovery.ts`，避免两个文件互相引用。
5. `thread-run-lifecycle.test.ts` 的两条 R2-D3 测试改成新行为：没有可恢复结果的未知轮次，截止时间之前就收尾，诊断码保留 `RUNTIME_TOOL_RESULT_UNKNOWN`。
6. 仓库规则 `.claude/rules/owner-standing-rules.md` 增加“独立判断，不盲从”一条。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- **撤销 `1704efc`**：Andy 明确要求这次上线必须带上提前收尾，用户收到“没有完成”推送晚 30 分钟的问题仍然存在。
- **只改测试夹具，让截止时间一致**：58 条会变绿，但恢复仍会被抢先，掩盖了真问题。
- **在候选查询里加“计划截止时间与轮次一致”**：轮次截止时间存在加密的冻结输入里，数据库查询读不到。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 门槛：`test/integration/sqlite-sandbox-execution-v2.test.ts` 的 58 条“迟到结果恢复”用例（正向：能恢复的轮次不被提前收尾）和 `before-deadline` 用例（反向：没有可恢复结果的轮次提前收尾）。把第 1 条去掉，前者失败。
- 未验证：生产上那条“命令退出信息没记下来”的轮次，会不会因为带有流结束记录（`sandbox-stream-end`）被判为可恢复而仍等 30 分钟。恢复判断只对前台命令、`srt` 或容器后端生效；上线后用同样的场景看一次。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- 事故：[I-51](../incidents-and-gates.md#incidents)、[I-05](../incidents-and-gates.md#incidents)
- [ADR 0127：结果未知且资源已释放时立即收尾](0127-settle-unknown-result-run-once-resources-released.md)
- 案例：[案例 76](../engineering-casebook.md#case-unknown-settle-vs-late-recovery)

[返回目录](#contents)
