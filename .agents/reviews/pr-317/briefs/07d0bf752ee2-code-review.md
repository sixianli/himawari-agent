# PR 317 材料：CI 提速收尾——编号冲突与测试文件拆分

目标：只复核测试和文档改动，没有产品代码改动。
1. 把 ADR 0181 的编号冲突改为 ADR 0189（重命名并更新所有链接）。
2. 把 `test/tooling/opencode-review.test.mjs` 拆成三个文件（`opencode-review.test.mjs`、`opencode-review-merge-gate.test.mjs`、`opencode-review.fixtures.mjs`），目的是让两个并行 worker 能均分耗时。
3. `test/tooling/review-delegate.test.mjs` 的 git revert 加了 `-c user.name/-c user.email`，因为 CI 机器没有 git 身份。

作者说法：拆分前后在 Hermes 上跑过，测试名称集合一致，0 失败 0 跳过（164/164）。
重点请查：拆分有没有丢测试用例、共享夹具有没有变成顺序依赖、ADR 链接是否全部更新、有没有改变测试的断言含义。
这个改动不会改变模型已经见过的请求开头（只改 CI 测试和文档）。
