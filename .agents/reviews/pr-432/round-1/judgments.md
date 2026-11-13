# PR 432 第 1 轮判断

复核的提交是 HEAD（合入 main 之后）。两个模型都确认：本 PR 只动开发期检查脚本、测试和待办清单，不碰任何发给模型的内容。

## 会出错
- ds1、gl2（中高）成立：无 `options.X` 条件的清单原先整段跳过路由和处理方检查。已改：这类清单里的操作若被某个分支抢走，报 `OPERATION_ROUTED_TO_OTHER_HANDLER`；处理方代码缺失照样报错。新增用例“checks an unconditional list for a stolen route and a missing handler”。
- ds2（中高）成立：找不到 `installedGatewayV2Operations` 数组时整个公布检查被跳过。已改：有网关而没有这个数组报 `OPERATIONS_ADVERTISING_MISSING`；用例已补。
- gl1（中高）成立：`installedNames` 把没装进网关的清单也算作已安装。已改成只取真正进了 `installedOperations` 的清单；无网关时为空集合。
- ds4（低）成立：新增分支缺测试。已补 `OPERATION_LIST_NOT_IN_GATEWAY`、精确 `===` 路由、无条件清单、缺公布数组、缺清单文件的用例。
- ds5（低）成立：清单缺失或解析为空时静默。已改：报 `OPERATIONS_INVENTORY_MISSING` / `OPERATIONS_INVENTORY_UNPARSED`，有用例。
- ds6（低）部分成立：`ci/operations-pending.json` 的说明漏了“已声明未安装”，已改。ADR 0192 描述的是当时的状态，说法在当时为真，不改；本检查的新增行为由 PR 描述记录。
- gl4（低）成立：两条既有用例被放宽成 `toContain`。已恢复成 `toEqual`，写出完整的错误列表。
- PR 描述里“新增 11 条反向用例”不准确（模型两边都指出），已改成实际数字。

## 可以更好（不改，列给 Andy）
- ds3：处理方检查只看全仓后端是否出现该名字的字面量。PR 描述写的就是“处理方代码里要有这个操作名”，说法为真；更严的做法要解析处理分支，复杂度高。建议不采纳。
- ds7：每个文件读两遍。已顺手用缓存读一次，行为不变。
- gl3：路由分支配对依赖文件顺序，当前真实代码不触发。建议不采纳，假设已写进作者说明。

## 不成立
- gl5：ADR 0192 描述的是当时的状态，见 ds6。
