# PR 460 第 2 轮代码复核：逐条判断

只用 DeepSeek。会出错的只有 1 条低（测试在特殊宿主上假失败），其余是可以更好。

| 编号 | 意见 | 处理 |
| --- | --- | --- |
| ds-1 | 一个调用方即使同时保留 `await Promise.all(list.map((entry) => realpath(entry)))`，只要文件里也有新函数的 import 和调用，这个用例仍然通过。 | 已改：用例标题改为“the four changed fixtures”；字符串匹配只能防整体改回，行为级验证要 ARM 真机，列给 Andy |
| ds-2 | 默认 `/lib64` 用例用 `realpath` 判断“是否存在”，与实现的 `lstat` 语义不一致，特殊宿主上会假失败 | 已改：改用 lstat（只有 ENOENT 当作不存在）决定期望值 |
| ds-3 | 作者说法“单元测试 8 个”与当前文件不符 | 已知：现在是 9 个，PR 描述已按 9 个写 |
| ds-4 | 已静态导入 `realpath`，测试里仍多次动态导入 | 已改：用静态导入的 realpath |
