# PR 446 第 3 轮逐条判断

被复核的提交：c7285bea（相对第 2 轮的 e9c00e39 看增量）。只跑 DeepSeek。这一轮没有中、高严重度的“会出错”意见。

## 会出错，低（已改，用 --accept-low 记账）

- ds-2 “过滤在 LIMIT 之前”没有反向用例：成立，模型给“中低”，判低。理由：模型自己确认 SQL 是对的，缺的是防回归的测试，现有代码不会给出错误结果。补用例「still lists a later reminder as upcoming when due ones alone would fill the upcoming limit」：upcomingLimit 为 1，一条已到点但期限更早的提醒加一条未来的提醒；过滤若在 LIMIT 之后，取到的唯一一行是已到点那条，结果为空，用例失败。
- ds-4 诊断里的错误名没有断言：成立。在编号超长那条用例里断言来源失败回调收到的错误 name 都是 HOME_ITEM_ID_NOT_SHOWABLE。memoryId 和 sourceThreadId 两个分支不补用例：这两个编号由 `packages/domain/src/identifiers.ts` 的 createMemoryId、createThreadId 生成，写入时就限制在 128 个机器字符以内，构造不出过不了合约的值，检查是防御性的。

## 可以更好（已改）

- ds-3 worker 分发处的类型漏了 remindAfter：只影响类型，运行时行为不变（模型自己写明）。补上这一行。

## 不成立（对本 PR 而言）

- ds-1 提醒编号生成端可以超过 128、记忆页没有过滤：说的是本 PR 之前就有的情况。`production-memory-capture.ts` 的 `reminder:` 加记忆编号、`contracts-v2.ts` 里记忆页 reminders 和 upcoming 的 `reminderId: machineString`、`memory.reminder.respond` 的同一约束，都在 main 上，本 PR 没有动。本 PR 新增的首页对这种提醒的处理是有意的：不显示，并在 incompleteSources 里说明，用例「leaves out a reminder whose id is longer than the contract carries…」用 160 个字符的编号覆盖了“超过 128”这一类（129 到 137 走的是同一个分支）。生成端该限制编号长度，这是提醒写入的问题，汇报里单列给 Andy，不在本 PR 改。
- ds-5 作者列的调用方漏了 owner-profile-service.ts：是复核材料里的说法不全，不是代码问题。模型自己核对后确认它不传 remindAfter、结果不变，也就确认了发给模型的 owner-agenda 内容没有变化。
