# PR 455 第 2 轮代码复核：逐条判断

模型：opencode-go/deepseek-v4.1-flash。复核的提交：74c64574，增量从 9d499a3b0 起。这一轮没有中、高严重度的“会出错”意见，4 条低的都已修改并补测试，不再触发第 3 轮。

## 会出错，低（已修改）

1. **提议入口同步抛错**（模型：中，线程判低）。成立。触发：以后接上的提议入口在 receive 里同步抛错；生产没有接提议入口，现有输入触发不了。后果：决策记录已经提交，这次 run() 以异常结束走 onFailure，不丢数据。修改：`packages/application/src/services/proactive-mail-check-service.ts` 把调用放进 `Promise.resolve().then(...)`。测试：`a proposal entry that fails or never answers does not hold up the check` 加了同步抛错的接收方。
2. **每次检查上限最大 10000，存储只收 500 条**（模型：中，线程判低）。成立。触发：上限改到 500 以上且一次检查真的读到 500 条以上；Gmail 读取器一次最多 300 条（模型自己写明今天不会触发）。后果：这一次检查的记录被拒、游标不前进、下次重试，不写错数据。修改：`packages/application/src/ports/proactive-sources.ts` 新增 `PROACTIVE_ITEMS_PER_CHECK_MAXIMUM = 500`，Gmail 的每次检查上限最大值用它，登记时每次检查上限的最大值超过它就拒绝；存储层的 `MAX_INPUT_IDS` 改成引用同一个常量，两边不会再对不上。测试：`refuses a source without a trust mark, with a bad name, or registered twice` 加了最大值 501 被拒。
3. **程序条目的 dueAt、deliverAt 不校验**（模型：低）。成立。修改：`recordProactiveProgramEntry` 要求两者是 null 或标准 ISO 时间（和存储层同一种判断），否则返回 entry_invalid。测试：`a program entry is not recorded twice...` 加了三种不合格的时间。
4. **每天上限是事务外读的**（模型：低）。成立。触发：写入的同时主人正好调低上限；后果：最多多记一条。修改：`onlyIfNew` 不再带 perDay，`record` 在事务里自己读当前设置。“今天”的起点仍由调用方算（存储层不知道主人的时区），跨零点那一瞬间可能按前一天算，后果同样是最多多记一条。并发用例 `two writers racing...` 仍通过。

## 可以更好（不修改）

5. **“2000 个字符”按 UTF-16 代码单元计**。成立，可以更好：上限的作用是防止存进过大的内容，按代码单元计只会更严，不改变任何合法输入的结果；只是材料里的措辞。
6. **用常量拼 SQL**。成立，可以更好：`GMAIL_SOURCE.name` 是冻结的字面量 "gmail"，拼出来的 SQL 和原来逐字相同（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts`）；模型自己写明没有实际注入。

## 不成立

7. **clear_records 清全部来源，文档或界面要写明**。不成立。模型自己引了设计文档 `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md` 写明“删除全部记录”，并写“作者说法与文档一致”；这个 PR 不改网页，登记表里也只有 Gmail 一个来源。
