# PR 451 第 3 轮：对第 2 轮意见的修改

第 2 轮（提交 5e7c378b5）没有中、高的意见，下面是对几条低严重度意见的修改。请只看增量。

## 作者的说法（请核对，不要直接采信）

1. 数据导入的记忆出处校验现在在 dry-run 返回之前执行，dry-run 和正式导入都会拒绝（`packages/persistence-sqlite/src/data-export/import.ts`）。
2. 要主人确认的设备动作没拿到确认时，返回错误码 `DEVICE_ACTION_CONFIRMATION_REQUIRED` 和新的固定说明 `tools.result.device-action.unconfirmed`；没有接下发时仍是 `DEVICE_ACTION_UNAVAILABLE`。
3. 口头指令编号的分批是纯函数 `commandUtteranceBatches`，去重、排序、每批不超过 1000。
4. 详细设计新值清单里入口检查的范围改成了实际的四种动作。
5. 测试新增：已删除的感知记录不能当新出处、已记过的出处更新时不再查、两处编号格式一致、dry-run 拒绝坏出处。

## 约束

和前两轮相同。
