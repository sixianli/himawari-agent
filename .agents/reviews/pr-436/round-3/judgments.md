# PR 436 第 3 轮判断

## 会出错 · 中、高（已改）
- d1 重置旧提议时先删旧载荷再写新载荷，写失败留下没有依据的待采纳行。属实。改：先写载荷再写表，任何一步失败都把原载荷写回、状态不动。测试：`keeps the old basis and the old state when writing the new basis fails`（还原源码后失败）。
- d2 规则经别的路径生效后，同参数的旧待采纳提议还留在列表里占名额。属实。改：规则生效时把同参数的待采纳提议一并标成已采纳。测试：`takes waiting proposals for the same rule off the list once that rule is enforced`（还原源码后失败）。

## 不成立
- d3 迁移 0095 回退会让应用过中间版本的库启动失败：0095 只存在于本分支，没有合并、没有上线，没有持久库应用过它。

## 可以更好（不改，列给 Andy）
- d4 提议表没进数据导出。d5 上限配到 200 以上时列表只回 200 条。d6 已处理的提议行和载荷不清理。d7 载荷读取不做结构校验。d8 原话里的双向控制符不过滤。

文档：`docs/architecture-v0.1.md` 的写入顺序说法已按代码更新。
