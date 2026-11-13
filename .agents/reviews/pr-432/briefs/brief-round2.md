# PR 432 第 2 轮作者说明（增量）

第 1 轮 7+5 条意见的处理见 round-1/judgments.md。本轮改动（相对第 1 轮复核的提交）：
- 无条件展开的清单也检查：被别的分支抢走路由报 OPERATION_ROUTED_TO_OTHER_HANDLER，处理方代码缺失报 OPERATION_HANDLER_MISSING。
- 找不到 installedGatewayV2Operations 数组报 OPERATIONS_ADVERTISING_MISSING；控制中心清单缺失或解析为空报 OPERATIONS_INVENTORY_MISSING / OPERATIONS_INVENTORY_UNPARSED。
- installedNames 只取真正进了 installedOperations 的清单；删掉死代码，文件读取走缓存。
- 恢复两条既有测试的精确断言，新增 4 组用例；单测 25 条通过，真实仓库检查通过。
- ci/operations-pending.json 说明补上“已声明未安装”。

必答问题第 1 条（请求开头）：只动开发期检查脚本、测试和待办清单，不触碰任何发给模型的内容。
