# PR 317 第 2 轮材料：复核第 1 轮中危意见的修改

上一轮（第 1 轮，提交 07d0bf752ee2）意见：拆成两个测试文件后，两个并行测试进程在 CI 冷 HOME 里可能同时安装 opencode，一个删掉另一个正在安装的目录。

本轮修改（请对照 `scripts/model-review/opencode-review.mjs` 的 `installBesideThenRename`、`installOpencode`）：
- 安装改为先装到各自的临时目录（`<缓存目录>.staging-<进程号>-<随机数>`），检查完整性后改名成正式缓存目录；改名失败但目标可执行文件已存在时复用已有的；临时目录最后一定删除。
- 重装路径（缓存损坏时）同样走这条。
- 新增 `test/tooling/opencode-review.test.mjs` 里两个进程同时安装的竞争用例。
- 另有低危修改：`docs/incidents-and-gates.md`、`.agents/instructions/model-review.md` 里门槛用例位置改为指向两个测试文件（只改文件名）。
- 本分支还合并了 main（`git diff` 里有 main 带来的无关改动，不需要复核）。

请只看第 1 轮提交之后本 PR 自己的改动（重点是上面第一、二条和新增的竞争用例），查：安装是否在两个进程同时进行时不会互相删除、失败路径有没有留下半成品目录、完整性检查有没有被绕过、新用例是否真的会在修改前失败。
作者说法：Hermes 上这几个测试文件通过（结果在 PR 里补）。
这个改动不会改变模型已经见过的请求开头（只改复核脚本的安装步骤、测试和文档文字）。
