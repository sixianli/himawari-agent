# PR 454：iOS 第 9A 批（设备动作的登记、队列、设备策略和结果回报，服务器部分）

## 问题和目标

第 5 批（本 PR 的基线）给了模型 `device_action` 这个固定工具，但服务器没有地方把动作交给设备。这一批做服务器这一半：动作怎样登记、怎样排队送到设备、设备怎样回报结果、主人怎样按设备关掉某个动作。设计在 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 第 12 节。iPhone 上真正执行动作是另一批，不在本 PR。

## 约束

- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）：`device_action`、`perception_read` 两个工具的定义是固定文字，加动作不得改它们；现在能做什么由 `describe` 的结果告诉模型。
- 模型给的参数不可信：给主人看的明细和风险等级必须按服务器手里的数据（设备同步来的镜像）算。
- 结果不确定的动作绝不能重做，只能让设备读回核实。
- 统一授权出口还没合并：授权放在端口后面，生产只放行低风险的读取类动作。
- 设备策略只有主人本人（设备确认钥匙签名）能改，网页不能改。
- `packages/persistence-sqlite` 只能从 `packages/application` 主入口做类型导入，值导入只能走子路径导出。
- 不写代码注释；不用关键词表理解用户意思。

## 作者的说法（请核对，不要直接采信）

1. 登记表外的动作名、参数不合格式（含多余字段）、要改的对象在设备镜像里找不到，三种情况都不建 `device_actions` 记录（`packages/application/src/services/device-action-service.ts` 的 `request`）。
2. 同一次工具调用（`run_id` 加 `tool_call_id`）重放返回原记录；同一台设备上指纹相同的动作还在“等主人、排队、已送达、结果未知”时不建第二条（`packages/persistence-sqlite/src/sqlite-device-action-operations.ts` 的 `insert`）。
3. 状态只能按 `DEVICE_ACTION_TRANSITIONS` 走；设备只能回报自己的、已送达的动作；结果未知的动作只接受带读回的成功或失败（`report`）。`claim` 对结果未知的动作只发 `verify`，不会再发 `perform`。
4. 生产的授权实现 `ReadOnlyDeviceActionAuthorization` 只放行“读取类、低风险、不需要本人在场”的动作；其余记成被拒，原因 `approval_not_connected`，不会进队列。
5. 需要本人在场的动作，授权端口说允许但没有证明本人在场时，记成被拒（`owner_presence_unproven`）；`decide` 里同样检查。
6. `home.control` 对类别不在 `HOME_ROUTINE_CATEGORIES` 里的配件（门锁、车库门、安防、认不出的类别）算人身安全、要本人在场；类别取自设备镜像，不取模型参数。
7. 设备策略只有带确认钥匙签名的设备请求能改（`packages/platform-node/src/device-api-routes.ts` 的 `POST actions/policy` 用 `authenticated.confirmed`）；改动写决策记录；策略关掉的动作在建动作时被拒，已排队的同名动作一并作废。
8. 设备被取消配对后拿不到队列：`claim` 的查询要求设备是 active，迁移里的触发器把排着的作废、已送达的转成结果未知。
9. `describe` 的结果只取决于登记、配对设备和设备策略，按名字排序；`perceptionToolDescriptors()` 的输出没变。
10. 迁移 `0097_device_actions.sql` 重建 `decision_ledger` 及依赖表时不丢任何已有行（做法照抄 0095），并新增种类 `device_action`。
11. 动作的参数和结果存成受保护的载荷，导出时走和其他文字一样的导出策略；`device_actions`、`device_policies` 都进数据导出。
12. 事件流的 `device.actions` 帧不带事件编号，不影响设备按游标续传（`packages/platform-node/src/device-action-hub.ts` 的 `withDeviceActionSignals`）。

## 已知没做

推送叫醒不在线的设备（端口 `DeviceActionOpenRequestPort` 已留，没接）；统一授权出口和主人点头（`decide` 在生产里还没有调用方）；设备端自己再查策略和真正执行；取消配对时作废的动作不单独写决策记录；`reminder.create` 这个名字指苹果“提醒事项”，和提议方案里 Himawari 自己的提醒同名，待设计线程定是否改名。
