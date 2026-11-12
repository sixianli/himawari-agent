# PR 454 第 3 轮：对第 2 轮修改的复核

问题、目标、约束同第 1 轮材料（`.agents/reviews/pr-454/briefs/b2a560461af4-code-review.md`）。这一轮请先看 `f0563fd15` 之后的增量。

## 作者的说法（请核对，不要直接采信）

1. `DeviceActionService.request` 的重放分支：命中的记录在排队或结果未知时调用 `delivery.announce`；设备编号或动作名和这次请求不同，返回参数无效，不返回旧记录。
2. `insert`、`report` 失败后的载荷清理即使自己出错，上抛的仍是原来的错误。记录已提交时，外键 `ON DELETE RESTRICT` 使载荷删不掉。
3. `forget`（`actions/open` 用）一次最多把 `limit` 条已送达的动作转成结果未知，并最多返回 `limit` 条待读回的；`limit` 取 `actionClaimBatch`。每条被转换的动作都写一条决策记录。没轮到的已送达动作保持原状，到期后由 `settleDue` 转成结果未知。
4. `DeviceActionStorePort.forget` 的返回值改成 `{ forgotten, pending }`，仓库里只有 `DeviceActionService.reopen` 一个调用方。

## 之前判为不成立、这一轮不必重提的

终态动作的保留期（列给 Andy 定）；策略变更不能收回已送达的动作（第 9B 批）；旧记录的指纹（这张表是本 PR 新建的，没有旧记录）。理由见各轮的 `judgments.md`。
