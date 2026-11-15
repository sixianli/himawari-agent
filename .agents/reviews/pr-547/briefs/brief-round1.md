# 第 1 轮作者说明（上线包出包的保护规则放行 0083）

问题：上线出包被 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 0083_model_invocation_owner_lost.sql model_budget_allocations,model_invocation_identities` 拒绝。`scripts/delivery-mode/make-packet.py` 的 `migration_ledger` 对每个待上线迁移用正则检查它有没有 ALTER/DROP/UPDATE/DELETE/INSERT 上线后要保持不变的历史表。0083 把这两张表存到临时表、删掉、重建（新增 reason_code 取值 owner_lost）、再把所有行原样插回。31 个待上线迁移里只有它触发。

目标：只放行这个文件、这两张表的“存一份、删、重建、原样插回”写法；别的写法（别的迁移文件，或同一文件里对这两张表另外有 ALTER/UPDATE/DELETE/INSERT、缺少原样插回）仍被拒。

改动：`make-packet.py` 新增 `ROW_PRESERVING_REBUILDS`（文件名到表的白名单）和 `rebuilds_keeping_rows(file_name, sql, touched)`，`migration_ledger` 用它把“被放行的表”从 touched 里去掉；`test_make_packet.py` 新增用例。Andy 2026-11-15 项目聊天明确说生产数据不重要（之前只有他一个人用），要最快上线，同意放行。

事实（生产只读）：两张表 1425 和 1400 行，rowid 从 1 到行数连续，无进行中的调用；上线后 S7 本来就逐行比较历史表（含 rowid），不一致会自动回滚。

约束：只改出包脚本和它的测试；不改 deploy.sh、迁移文件、产品代码、发给模型的内容（不会改变模型已经见过的请求开头）。

请特别看：正则会不会放过不该放的写法（例如别的写操作混在同一文件、表名前缀相同的另一张表）；白名单是否真的限定到这个文件名。
