# PR 497 第 7 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1 低 ADR 后果段对“复核账本格式不对”的处置自相矛盾。拆成两条：子进程没正常退出一条，账本格式不对一条；触发：读 ADR 后果段；后果：以为账本格式不对时既移出又不移出
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2 低 ADR 验证清单把新增用例归到了错误的测试文件。账本格式用例单列到 opencode-review-merge-gate.test.mjs 那一条；触发：读 ADR 验证清单；后果：去错的测试文件找账本格式用例
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3 低 新增 `REVIEW_RECORD_INVALID` 未写进操作说明，`--report` 也没有同样处理。model-review.md 第 6 步和流程卡错误表补上 REVIEW_RECORD_INVALID；--report 是给人看的汇报，不在队列路径上，不改；触发：线程合并前看到 REVIEW_RECORD_INVALID；后果：按错误表找不到办法，去问 Andy
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4 低 `REVIEW_RECORD_ERRORS` 中有一项到不了 catch，另外两项没有反向用例。去掉到不了的 VERDICTS_INVALID；触发：读 REVIEW_RECORD_ERRORS 以为 VERDICTS_INVALID 会走这里；后果：列表和实际可达的错误不符
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5 低（部分推测）从 CLI 模块导入常量，给合并队列引入了模块加载副作用。退出码常量挪到无副作用的 exit-codes.mjs，两边都从这里导入；一轮移出多个 PR 的情形写进 ADR；触发：review-models.json 坏了；后果：合并队列在导入阶段就失败
