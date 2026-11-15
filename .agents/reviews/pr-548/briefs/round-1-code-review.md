# PR 548 第 1 轮：设备动作可撤销

## 问题和目标

设备动作做完后，首页底部要给“撤销”。Andy 定的方案（9B 批）：撤销不经模型，服务器用设备回报的原样（evidence.before）排反向动作，反向动作照样走统一审批出口和本人在场判断，读回后记已撤销；API 要说明哪些动作能撤。

## 约束

- 不新增表，不改迁移；不涉及模型调用和发给模型的内容。
- 反向动作走现有的设备动作请求（授权、审批、读回、记录都不另起一套）。

## 作者的说法（请核对，不要直接采信）

1. `device-action-registry.ts`：登记项可带 `undo(args, evidence)`，返回反向动作或 null。`calendar.create`（evidence.eventId）→`calendar.delete`；`calendar.delete`（evidence.before；单次删除不撤）→`calendar.create`；`calendar.update`、`contact.update`（evidence.before 里要有所有改过的字段）→改回去。其余动作没有 undo。
2. `device-action-service.ts`：`undo({device, actionId})` 要求原动作 succeeded、属于这台设备、能算出合法的反向参数；用固定的 toolCallId `undo:<原动作号>` 和原动作的 runId 发起 `request`，所以重放返回同一个结果、同一动作只能撤一次；`ownerInitiated` 使 `readUntrustedContent` 为 false（主人亲自点的撤销不因那一轮读过外来内容而被直接拒，但统一审批仍按那一轮的外来内容标记询问）。
3. `views()` 每条加 `undo`：`none/available/pending/done/failed`（失败的反向动作不重试）。
4. 路由 `POST actions/undo`：404 不是这台设备的动作，409 撤不了，成功返回 `{id,state}`。
5. 测试夹具 `device-api-harness.ts` 把审批回应后的回调接到 `reconcile`；新增用例包括设备经 `home/act` 点同意（动作进队列）和点不同意（被拒）。

## 不必评的

推送唤醒（下一个 PR）；PR 543 已审过并判过的各条（reasonCode 被丢、幂等重放不走回调、回调接线）；设备端 evidence 的实际内容（由 9B 的客户端实现，约定写在 PR 说明里）。
