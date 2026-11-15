# PR 578 复核材料

问题：上线第 8 步 S8（新服务启动之后的读回）把生产库和 S3 保存的数据库副本逐行比对，规定“上线前已有的行不能删、列不能变”。新服务启动后会合法地改老行，所以 S8 拦过两次上线：第十一次（recovery_json）和第二十九次（I-108，model_budget_accounts）。第二十九次给了一个只对该版本有效的一次性开关（PR 575），下一个版本会重新被拦。

目标：找到根因并修掉，不打补丁、不做一次性豁免。

做法（Andy 2026-11-15 同意，消息 cmsg_01EE1hey9cboYNfwFnBv5dgrYWwNxFFj8F6VYrAWGtGRVM）：
1. 历史数据只在服务停着时比较：S3/S7 按表摘要比、迁移前后比、S7 切换脚本启动前再比一次、出包拒绝迁移改历史表、S9 恢复后比。这些不改。
2. S8 不再逐行比对启动后的生产库和 S3 副本（删 compareHistoryRows、verifyHistoryAgainstRecoveryPoint、startupRecoveryColumns），S8 其余检查不变。
3. 删掉第二十九次的一次性开关整套机制（实例文件 historyComparison、出包参数 HISTORY_COMPARISON*、维护脚本和 S7 切换脚本里的分支）；实例文件再带 historyComparison 就拒绝出包。onDeployFailure=keep 不变。
4. 新 ADR 0279，I-108 关闭，更新 P-readback-design.md 和 delivery-mode.md。

约束与已核对的事实：
- 这个改动不碰发给模型的上下文。
- 12 张历史表里运行中的服务会合法 UPDATE/DELETE 其中 7 张的老行（见 ADR 0279 前提 2）。
- 回滚、S6 验收、keep 模式不变。

请特别查：
- 去掉 S8 的逐行比对以后，还有没有别的地方读 s8-history-preserved.json、history 字段或被删的函数，或者依赖开关占位符 __PKT_HISTORY_COMPARISON__、__PKT_HISTORY_COMPARISON_JSON__ 没被替换。
- 启动前的静止点比较（S7 切换脚本、S7_CATALOG_UPGRADE）是否确实覆盖了迁移和能力升级对历史的改动，有没有漏洞。
- verify-fixtures.mjs 改完后原有的夹具（读 S0、摘要比较）是否仍然有效，计数字段 count(...) 有没有被别处依赖。
- 删开关会不会让 PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 对下一个版本的迁移产生新的误拦。
