# PR 575 复核材料

问题：第二十九次上线（a4ef1ccd）S1–S7 全部通过，在 S8_READBACK 以 TWENTYNINTH_MAINTENANCE_HISTORY_ROW_CHANGED:model_budget_accounts 停下。根因是 S8 拿 S3 保存的副本，和新服务启动后已经在写的生产库逐行比对；新服务正常结算预算（sqlite-model-budget-operations.ts:1207 updateAccount）就会让比对失败。随后 deploy.sh 自动回滚，但 Andy 已经选了“失败不回滚，保留现场”。

Andy 原话（cmsg_01EE1hey9cboYNfwFnBv5dgr57gFLC1LwkkuA5Tm38FypH）：“线上的数据不用管，线上的数据不重要……请你以最快的速度去上线”。

做法：
1. andy-production.json 新增 historyComparison {mode:"off", reason, authorizedBy, release:"twentyninth"}，只对 twentyninth 这个标签生效，换了标签就拒绝。关闭时 S3、S7、S8 的历史逐行比对和出包的 PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 拒绝都跳过，证据里记录关闭和依据；schema、账本、摘要、服务健康等其他检查照常。
2. deploy.sh 新增 HIMAWARI_DEPLOY_ON_FAILURE 或包参数 ON_DEPLOY_FAILURE（keep/rollback），andy-production 默认 keep。S2_STOP 之后失败时不跑 rollback.sh、不跑 release-cleanup，结果记为 failed-kept。
3. 更新 delivery-mode.md，新增事故 I-108。

请特别查：
- 关闭时还有没有哪个比对点会失败：S3_COPY51、S7 迁移前后、S7_SWITCH_START、S8、S9 恢复、tidyDatabaseSidecars、finalize、封存，以及读这些证据字段的地方。
- 开关能不能被别的版本意外继承。
- keep 模式下，失败后服务处于什么状态；脚本的退出码和结果行，调用方（包括 Mac 上的操作流程）能不能正确识别。
- 上线前就失败（S2 之前）的路径，行为有没有变。
- 新参数的占位符在所有模板文件里是否都会被替换。
