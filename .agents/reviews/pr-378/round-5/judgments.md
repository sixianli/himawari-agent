# PR 378 第 5 轮复核判断

复核提交 f7aa5499，只用 DeepSeek（deepseek-v4.1-flash）。逐条判断写在同目录的 `verdicts.jsonl`。

## 会出错：中、高（本轮没过，已改，送第 6 轮）

- r5-1 进行中标记读不懂时评测永久停摆。
  - 改法：每次运行写自己的标记文件（`in-progress-<时间>-<随机编号>.json`），先写临时文件再改名。
  - 改法：读不懂或字段不合规的标记按“花光整周上限”计，开始时间取文件修改时间；满 7 天删掉。
  - 改法：新运行不覆盖旧标记，修掉了“旧标记被覆盖、它的花费从 7 天累计里消失”的问题。
  - 测试：`production-real-eval.unit.test.ts` 的 “counts an unreadable marker as a run that spent the whole weekly cap”、“keeps the marker of an earlier unfinished run when a new run starts”。
- r5-2 调用凭据释放失败时 payload 不释放；`prepare` 写完 prompt 后申请密钥句柄失败时 prompt 留下。
  - 改法：两个释放改成 `try/finally`。
  - 改法：`production-model-composition.ts` 的 `prepare` 申请句柄失败时删掉刚写的 prompt payload，所有主动调用（邮件判断等）一起受益。
  - 测试：“still releases the payloads when releasing the call authority fails”，“[P4-5] releases the stored prompt when a proactive call cannot get its secret handle”（变异验证过：去掉删除这一步，测试失败）。
- r5-3 题干删除失败后永久孤立。
  - 改法：删不掉的编号记进运行记录的 `undiscarded`，下次运行开头重删，还删不掉就带到下一次。
  - 测试：“keeps going and still skips the version when the unkept question text cannot be deleted” 扩展为三次运行：两次删不掉，第三次删掉。

## 会出错：低（已改或写进 ADR）

- r5-4 跨进程不互斥：生产只有一个服务进程，ADR 后果已写明，不加锁。
- r5-5 `once` 崩溃后等 7 天：有意设计（不知道花了多少就按花光算），ADR 后果写明。
- r5-6 “一点”：前面有时段词或后面跟“钟、整、半、几分”才算钟点；补了正反例，变异验证过。
- r5-7 标记字段校验：`capMicros` 必须非负，`startedAt` 必须是规范 ISO，不合规按读不懂处理。
- r5-9 文档：案例 87 拒答题改为“可以出”、补 `response_invalid` 例外和“一点”规则；ADR 补删除重试，“不超过预估”改为“通常不超过”，说明遮盖占位符的影响。

## 不成立

- r5-8 `budget_exceeded` 挡 7 天：周上限按 7 天累计，放不下下一次调用就是本周额度用完，这是设计；ADR 后果补了一句。

## 未核实部分

- 作者说明里的失败测试：本轮实测 `production-model-composition.unit.test.ts` 9 条、`model-payload-cleanup.unit.test.ts` 4 条失败，在不含本次改动的 f7aa5499 上同样失败（云端容器里 Pi 运行时配置失败），与本改动无关。
