# PR 549 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1（低）新测试没有走真正的出包路径，清单或 touched 推导变化时会漏报。test_make_packet.py 原用例直接调 rebuilds_keeping_rows 且写死 tables；已改成经 migration_ledger("HEAD",82,83) 走 preserved_tables 与 touched 推导
- 2（deepseek-v4.1-flash）成立，可以更好：### 2（低）摘要不再是逐字节绑定，`strip()` 的语义与文档里的“内容摘要”不完全一致。放行条件忽略首尾空白，ADR 0086 第 51 行原写“内容摘要”不严；已改为“去掉首尾空白后的内容摘要”；函数内 strip 由 read_text 用例守住
