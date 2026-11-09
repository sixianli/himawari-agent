# PR 328 第 1 轮判断

| 编号 | 判断 | 依据和处理 |
| --- | --- | --- |
| ds-1、glm-1 | 成立，会出错，中高 | 写入约定写成所有种类都写 memoryByMail 等，实际 `insertLedgerRow`（sqlite-decision-ledger-operations.ts:115-120）只落四个键。已改约定：分 proactive 完整写入和其他种类四键两条路径，并写明现状 |
| ds-2 | 成立，会出错，低 | 写入端 1-256 任意字符，读取契约 machineString。已把读取契约放宽到 `boundedString(256)`，补用例（变异检查：改回后用例失败） |
| ds-3 | 成立，会出错，中高 | `readChain` 每次渲染新建，抽屉 effect 依赖它。已改成 ref，effect 只依赖 decisionId，补单测（变异检查：改回后失败） |
| ds-4 | 成立，会出错，低 | 抽屉只在依据完整时才写「无记录」，被截断时只显示「依据太多」；预算是否按推断过滤作为后续优化，不改行为 |
| ds-5 | 成立，会出错，低 | ADR 措辞改为「正文类字段」并列出范围；补两个用例（敏感取代记忆、敏感依据节点），变异检查通过 |
| glm-2 | 不成立 | `singleLine`（production-memory-control.ts:99-105）按 UTF-16 单元 `.slice(0, 2000)`，不是按码点，长度不会超过契约上限 |
| glm-3 | 成立，会出错，低 | 补了经真实 `createProductionApprovalGateway` 的用例（含未知记录被拒） |
| glm-4 | 可以更好 | 已顺手去掉 `as never`，scope 类型取自账本端口；不改变行为 |
