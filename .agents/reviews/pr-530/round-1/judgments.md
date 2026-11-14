# PR 530 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 低 | 反向用例标题写“依据或执行原样”，实际只覆盖依据，未覆盖执行原样和“两项都读不出=2”。test/integration/data-export-owner-proposals.test.ts:294-307 只把 basis 载荷标成 deleted_verified；export.ts:713-714 两项共用 ownerProposalText，现状行为正确，只是用例没覆盖 execution 和两项都丢，属测试可以更全，不是代码出错
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低 | `omitted` 原因只写“不能撤销”，漏了依据丢失会让动作提议无法采纳/执行；导入端把 `null` 当成“没有依据”。依据读不出的提议在来源库里同样读不到依据（production-proposals.ts:616-617 报 PROPOSAL_NOT_FOUND），导入后状态与来源一致，没有新增错误；清单原因写得不全属措辞和导入报告可以更细，不会让人做错事
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低 | “格式因此升到 v4”把 v4 归因于本次“读不出写空”的改动；本 PR 实际没改 `FORMAT_VERSION`，基线已是 v4。schemas.ts:5 已是 v4，git diff a87954e..HEAD 没有 schemas.ts；已改架构句，说明 v4 是提议箱进入导出时升的；触发：读 docs/architecture-v0.1.md:433 的人；后果：“因此”把升 v4 说成是读不出写空引起的，实际 v4 是 PR 527 加提议箱时升的，文字不准但不误导操作
