# PR 569 第 4 轮复核材料

第 3 轮成立的“会出错”已改：停服清回收站（`purgeExpiredTrash`）在删除事务里再查一次对话，对话还在且状态不是 `trashed`（例如用同一幂等键重建的新对话）就跳过，不再整份删掉；新增 `#deleteLocked`、`#threadStillGone`，测试在 `test/integration/sqlite-governed-deletion.test.ts`。请核对这个增量：回收站里的对话（包括上次派生文件没删完、记录停在“未完成”的）仍会照常清除，`deleteImmediately` 的其他用法行为不变。
