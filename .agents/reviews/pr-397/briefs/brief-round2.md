# PR 397 第 2 轮作者说明

第 1 轮复核意见和逐条判断见 `.agents/reviews/pr-397/round-1/judgments.md`。本轮只看 c93e342f 之后的修改（11d223a8）：

- `scripts/ci/run-share.mjs`：get 在复制或重算摘要出错时删掉目标再抛出；collect 对缺失写标准错误。
- `scripts/operations/ci-runner/install-runner.sh`：组不存在而共享目录已存在时以 71 拒绝。
- 测试：run-share 新增“复制中途出错不留半份”；policy 新增 download-artifact 禁令的真实 SHA 反向用例；ci-runner-scripts 新增拒绝接管的用例。
- 文档：ADR 0238（重跑整轮、共享目录可写范围、矩阵输出的文档原话）、运维手册排错表、事故清单 I-93。

请核对：
1. 修改是否真的修好第 1 轮成立的意见，有没有引入新问题。
2. 第 1 轮判为不成立的 ds-1（矩阵输出合并）、ds-4（运行目录权限非原子）理由是否站得住。
3. 拒绝接管的退出码 71 是否和安装脚本里已有的退出码冲突，回滚路径是否仍然正确。
