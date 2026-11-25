# PR 636 复核材料

只改一个测试：test/integration/memory-numbers.test.ts 的第一条用例，先跑“记忆编号迁移之前的全部迁移”，而不是“去掉记忆编号迁移的全部迁移”。

作者说法：
1. loadBundledMigrations 按排序位置给新式迁移分配 sequence，所以从中间去掉一条会让后面的迁移序号错位，applyMigrations 报 Expected migration sequence 117, received 118；main 合进 20261124212416_main_thread 后这条测试因此变红。
2. 取前缀后，先建的库正好停在编号迁移之前，再跑全部迁移时只补编号迁移和它之后的迁移，测试仍然验证“迁移前已有的记忆按记录时间编号”。
3. 不改生产代码，不改任何发给模型的内容。
