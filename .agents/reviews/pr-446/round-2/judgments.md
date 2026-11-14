# PR 446 第 2 轮逐条判断

被复核的提交：e9c00e39（相对第 1 轮的 169a3c66 看增量）。只跑 DeepSeek。修改在下一个提交里。

## 会出错，中、高（已改，第 3 轮复核）

- ds-1 upcoming 的编号没有按合约检查：成立。`apps/agent-service/src/production-reminder-writer.ts` 的提醒编号是 `reminder:memory:reminder:owner:` 加命令的 idempotencyKey，后者合约允许 128 个字符，拼起来超过 `machineString` 的 128。修改：首页的 upcoming 也按合约检查三个编号字段，过不了的不显示，`incompleteSources` 写 `upcoming`（`HomeFeedService` 的 upcoming 回调改为返回 `{ items, incomplete }`）。测试：`test/integration/home-feed.test.ts`「leaves out a reminder whose id is longer than the contract carries…」，同一条用例里到点的那条因 key 超过 160 被丢，顺带覆盖 ds-5。写入端限制派生编号长度不在本 PR 改（属于提醒写入）。

## 会出错，低（已改，随第 3 轮一起复核）

- ds-2 `notYetDue` 在 LIMIT 之后过滤：成立。修改：`MemoryReminderStorePort.listUpcoming` 加可选的 `remindAfter`，条件下推到 SQL（`r.remind_at > ?`），首页不再为了排除而多读一次到点提醒。记忆页不传这个参数，行为不变。原有用例「never lists a reminder that is already due as upcoming…」仍然覆盖。
- ds-3 全是 replied 时误报不完整：成立。修改：达到上限时再读一次只含 open 的列表，只有 open 的数量本身达到上限、或比已读出的 open 多，才报不完整。测试：「says the mail source is incomplete…」先造 1 条 open 加 499 条 replied（不报），再加 1 条 open 使它被截掉（报）。
- ds-4 诊断日志丢了原因：成立。修改：丢条目时用的错误把 `name` 设成 `HOME_ITEM_ID_NOT_SHOWABLE`，日志记的就是它。
- ds-5 key 超长分支没有用例：成立，见 ds-1 的用例。

## 可以更好（不改）

- ds-6 上限 500 在应用层和 sqlite 各写一份：`packages/persistence-sqlite/src` 只能从 application 做类型导入，值导入会让子进程里的测试找不到模块，所以不能共用一个常量。两边不一致时的行为由上面那条集成用例拦住：sqlite 的上限调小，用例第二段读不到 500 行，就不会报不完整，用例失败。

## 模型标为推测、未核实的几条

- proposalId 写入端只校验长度：既有问题，第 1 轮 ds-2 已在读取端兜住，不在本 PR 改写入端。
- 封存内容被释放后分级回退成 private：模型自己说没找到会发生的路径。内容被释放后 `open()` 也读不出正文，条目没有敏感文字可显示。
- 没有专门断言 memory.overview 的 upcoming 不含分级：`test/integration/production-memory-capture.test.ts` 的 `[MP-1] rolls a yearly reminder forward…` 用 `toEqual` 断言 upcoming 的完整对象，修改过程中它确实因多出字段失败过一次。
