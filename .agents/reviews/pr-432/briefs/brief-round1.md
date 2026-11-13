# PR 432 作者说明

问题：scripts/check-operations.mjs 只查“已安装清单里的名字在契约里”。没有路由分支的已安装命令会落到 searchAuthorization.set 被拒，现有检查发现不了。

目标：检查契约、已安装清单、生产网关路由分支、处理方四处一致；控制中心清单声明的操作要么已安装，要么在 ci/operations-pending.json 有理由；都从代码动态读取，带反向用例。

约束：不改表、不改产品运行代码、不改发给模型的内容；只动 scripts/check-operations.mjs、test/tooling/operations-check.test.mjs、ci/operations-pending.json。

已核对的事实：
- 真实仓库跑检查通过；手工把 production-approval-gateway.ts 里 workspace.copy. 的分支改名后，检查报 3 条 OPERATION_NOT_ROUTED。
- 单测 21 条通过，新增 11 条反向用例。
- 新查出 10 个已声明未安装的操作（capability.* 7 个、grant.* 3 个），已写进待办清单并说明理由。
- 路由分支用“先匹配先生效”解析 `query.type`/`command.type` 的 startsWith 或 === 条件，配对其后第一个 options.X。

必答问题第 1 条（请求开头）：本改动只是开发期检查脚本和测试，不触碰任何发给模型的内容。
