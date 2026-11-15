## 结论

这一轮我查的范围：`git diff da95a278..676472c` 的文件清单和其中 PR 539 相关文件的逐行增量；`git diff 7ea1a6b..da95a278` 里的 PR 539 实现（因为增量证据会指回旧代码）；ADR 0273 的两次文档修改；两份评测 JSON 的汇总；相关单测、集成测试、提示词清单、出口登记表和迁移约束。

结论：**上一轮没有“会出错”的意见需要验证**。PR 539 的代码文件在 `da95a278..676472c` 之间没有变化；这个增量只有审查记账、ADR 0273 的文档修改，以及一次 `origin/main` 合并。**没有发现中、高严重度问题**。发现 1 条低严重度的文档与代码不一致，来自合并进来的 main 改动，不是 PR 539 本身。

## 意见

### 1. 低：合并带入的 main 改动删除了固定说明 `tools.result.device-action.unconfirmed`，设计文档仍把它当作现行值

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:764`
- 问题：该行仍写“工具错误码 `DEVICE_ACTION_CONFIRMATION_REQUIRED` 和固定说明 `tools.result.device-action.unconfirmed`”，但合并后的提示词目录和代码里已经没有这两个值；这是增量合并带进来的一致性问题，属于 main 上的设备动作改动，不是 PR 539。
- 证据：增量 diff 删除了 `packages/prompt-catalog/src/perception.ts` 的 `TOOL_RESULT_DEVICE_ACTION_UNCONFIRMED`，也删除了 `packages/prompt-catalog/prompt-manifest.json` 的同名条目；`apps/agent-service/src/production-perception-tools.ts` 同时删除了 `export const DEVICE_ACTION_UNCONFIRMED_CODE = "DEVICE_ACTION_CONFIRMATION_REQUIRED";`。全仓库检索这两个标识，代码和清单里都没有引用，只剩上述文档一行。
- 建议：把该行改成现在的按原因码说明（`approval-not-connected`、`owner-denied`、`owner-presence-unproven` 等），或在文档里注明这段已被设备动作第 9A 批取代。因为来源是合并的 main，建议转给对应 PR/作者处理，不阻塞 PR 539。

## 侧重检查

**读代码证实的：**

- **错误路径**：模型超时、抛错、概率越界、预算预留失败、每分钟超限都返回 `deliver`；感知窗口读取超过 20 页会抛 `DELIVERY_TIMING_WINDOW_TOO_LARGE`，在 `production-web-push.ts:717` 被兜住并直接送；`recordDeliveryTiming` 写失败也走同一 catch，通知不会因为记录失败而丢。
- **不可信输入/安全**：发往 Jev 的只有推送类别和结构化事实；`motion.activity` 的来源值由 `packages/application/src/ports/perception.ts` 的 `oneOf("stationary", ..., "driving")` 校验，其余是布尔或固定枚举，没有把感知原文、位置或标题发出去。模型回复由 `deliveryTimingProbability` 校验模型名、唯一答案、谓词名和 0–1 范围；请求带 `zeroDataRetention: true`；`delivery-timing-decision.ts` 已登记在 `scripts/check-egress-redaction.mjs` 的两张表里，并实际调用 `redactForExternalText`。
- **资源耗尽**：每种信号最多 20 页 × 500 条，5 种并发读取；缓存最多 64 条；每分钟 30 次；响应最大 64 KiB；单次模型 2 秒超时；费用先预留。都有上限。
- **不可撤销操作**：送达时机只做延后和写账本，不删除通知；到期强制发送，没有不可撤销的副作用。
- **文档一致**：ADR 0273 增量改的三处我逐条对照了代码和评测：`#timed` 确实在 `production-web-push.ts:646`；`result.json` 的 `estimatedUsd` 是 0.003354，忙 40/40、闲 0/40、errors 0、中位 202ms；`first-prompt-result.json` 的漏判正是 carplay、cycling、running、asleep，概率 0.21–0.63。作者说"最低 0.94、最高 0.53"也与 `result.json` 相符。除上面那条设备动作文档外，没有发现新的文档与代码不一致。

**推测/未核实：**

- 每分钟 30 次限流是 `DeliveryTimingJudge` 实例内的内存数组计数；单进程下符合 ADR，多进程或重启后是否仍要算"每分钟 30 次"取决于部署方式，未核实。缓存同样只在进程内。
- 本环境只能读代码和跑指定的 git 命令，测试没有实际执行；下面的"反向用例"是读断言判断其有效性，没有跑绿/跑红的证据。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** PR 539 本身不会。base..da95 的提示词改动只是在 `prompt-manifest.json` 新增 `push.delivery-timing-question`，没有改任何已有系统提示、工具定义或历史消息；新的判断调用是独立的 `/decisions` 请求，指令加一条 user 消息，所有每轮会变的 `secondsAgo` 都在这条唯一的 user 消息里，不进入主对话前缀。增量的 main 合并只改了设备动作的工具结果文本（属于追加的历史内容）和确认行为，`device_action` 工具在 da95 就已存在，工具参数定义未变。因此仍然是"只在末尾追加，变化的字段在最后一条消息"。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新问法是静态文本并由清单哈希固定；事实顺序由 `ownerStateFacts` 固定为 speech → motion → sleep → focus → car_connection，值都是闭集枚举，遮盖结果不依赖前后文；唯一随时间变化的是 `secondsAgo`，它在独立判断请求自身的 user 消息里，而且缓存键故意不含它。没有依赖前后文的遮盖、时间字段或无序集合被写进共享前缀。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有：`packages/application/test/delivery-timing.unit.test.ts`（0.6995 送、0.7 延后；无事实不问；失败/预算/超时送；每分钟限流；同情况 5 分钟内只问一次）、`apps/agent-service/test/production-delivery-timing.unit.test.ts`（分页取最新）、`packages/platform-node/test/delivery-timing-decision.unit.test.ts`、`startup-configuration.unit.test.ts`（配置键和范围）、`test/integration/delivery-timing-source.test.ts`、`test/integration/push-channels.test.ts`（延后、到期发、拒绝/提议不判断、无事实不判断、失败/限流只报一次、前台不判断）、`prompt-output-contracts.unit.test.ts` 和 `check-egress-redaction.mjs`。这些反向断言在行为反转时应当失败；但本环境不能运行测试，**是否真的会红未实测**。ADR 文档修改本身没有自动检查，只能靠读文件核对。

4. **增量的每个值，使用端都能接受吗？** 增量没有产生或修改代码值，只有文档。PR 539 已有的值我按"产生处 → 使用处"核对了：`runPolicy.deliveryTiming` 由 `parseDeliveryTiming` 产生并校验 model/secretRef/价格和全部数值范围，`productionDeliveryTiming` 和 `service-main` 消费；`defer_rule_refs = ["delivery_timing"]` 由 `recordDeliveryTiming` 写、由 web push 和苹果伴侣两个读取路径按同一常量 `TIMING_DEFER_REFS` 认；账本 `delivery_timing` 的 `delivered`/`deferred`/`deadline_reached` 在 `20261114151212_perception_records.sql` 的 reference 表里有对应行；`timing_busy_<signals>`、`timing_clear`、`timing_deadline` 都满足 `^[a-z0-9_+]{1,64}$`（最长信号组合也小于 64）；提示词 id 在清单里有条目，parser 已登记。合并带入的 `device_action` 类别和结果在 `20261114172043_device_actions.sql` 里也有对应的 reference 行。唯一不匹配的是上面那条文档里被删掉的提示词 id，代码里已无使用端。
