# PR 446 第 1 轮逐条判断

被复核的提交：169a3c66。修改在下一个提交里。

## 会出错，中、高（已改，第 2 轮复核）

- ds-1 敏感分级被低估：成立。`packages/application/src/services/proactive-mail-check-service.ts` 封存提醒正文时用 `insight.dataClassification`，而 `apps/agent-service/src/production-home.ts` 的邮件条目写死 `private`；`upcoming` 没有分级字段。修改：`ProactiveSealPort.classificationOf` 读出封存时的分级，`readProactiveOverview` 的每条提醒带 `dataClassification`，首页邮件条目用它；`home.snapshot` 的 `upcoming` 每条加 `dataClassification`（取对应记忆的分级）。测试：`test/integration/home-feed.test.ts`「carries the classification…」。
- ds-2 外部提议编号让整页校验失败：成立。`apps/agent-service/src/production-mcp-memory-writer.ts` 的 `#submit` 对 `proposalId` 只校验长度，实测提交 `proposal ok/1` 成功，旧代码的 `home.snapshot` 过不了合约。修改：所有来源的条目在进列表前按合约检查 key 长度和四个编号字段，过不了的那一条不显示，来源写进 `incompleteSources` 并记诊断日志；写入端的校验不在本 PR 范围内改（它属于 P5 的 MCP 写入）。测试：「still answers when one entry has an id the contract cannot carry…」。
- ds-3、glm-4 到点提醒超出读取上限后又出现在“即将到来”：成立。修改：首页的 `upcoming` 排除所有 `remindAt <= now` 的提醒（`upcomingViews` 的 `notYetDue`），不再只靠已读出的那批编号。记忆页原有的 overview 行为不变。测试：「never lists a reminder that is already due as upcoming…」。
- ds-4 来源失败时角标数字偏小：成立，模型给“低中”，按中处理，因为界面上的数字必须有可验证的定义。修改：`HomeFeedService.awaitingCount()` 在任一等主人来源失败或自报不完整时返回 `undefined`，网页推送据此不带角标。测试：单元测试「names a source that failed…」「gives no badge number…」，集成测试同 ds-2 那条。

## 会出错，低（已改，随第 2 轮一起复核）

- ds-5 邮件提醒超过 500 条时少算：成立。触发：open 和 replied 的邮件提醒合计达到 `listInsights` 的上限 500。后果：件数少算且无提示。是否值得提醒要解密后才知道，数不出准确的超出数，所以改成如实说不完整：`readProactiveOverview` 返回 `insightsCapped`，邮件来源据此标 `incomplete`，`incompleteSources` 含 `mail`，角标不显示。测试：「says the mail source is incomplete…」。
- ds-6 不等主人的来源先返回同 key 时列表件数少 1：成立但现有来源触发不了（key 前缀互不重叠）。修改：`read()` 去重前把等主人的候选排在前面。测试：单元测试「counts an awaiting entry even when something that does not wait shares its key…」。
- ds-7、glm-2、glm-3 缺测试：成立。补了外部提议（含超过读取上限的件数）、整理结果的时间窗、超长文字和控制字符的集成用例。

## 可以更好（已改）

- ds-8 记忆页 overview 多读了 lead 文字：只影响开销，不改变返回内容。按 Andy “可以更好的直接改”，`conversationReviewViews` 加 `{ lead }` 选项，overview 传 `false`。

## 不成立

- ds-1c 响应外层的 `dataClassification` 沿用查询的值：这是本仓库所有网关快照的既有做法，不是本 PR 引入的，例如 `apps/agent-service/src/production-proactive.ts` 的 `proactive.overview.snapshot` 同样是 `...query` 后只改 `kind`、`type`、`actor`、`payload`，记忆页的 `memory.overview.snapshot` 也一样，它同样带敏感记忆文字。每条内容自己的分级才是客户端用的依据，本 PR 已让每条分级准确（ds-1）。要改外层分级的含义得所有快照一起改，另出方案。
- glm-1 已结束但后台占位未释放的运行显示为“正在做”：有意如此。`run_background_holds.released_at IS NULL` 表示这轮运行启动的后台任务还在跑，运行本身的状态已是 completed 只说明对话那一轮结束了。集成测试「shows unattended runs and failures…」里的 `run-background` 就是这个场景，占位释放且结果为 failed 的 `run-background-failed` 显示为出了问题。
- glm-5 非规范时间戳：不可达。`packages/persistence-sqlite/src/sqlite-proactive-operations.ts` 的 `time()` 用 `new Date(parsed).toISOString() === value` 校验，`record`、`saveConnection`、`markConnection` 写入前都过这一关。
- glm-6 来源失败日志可能带正文：模型自己标“未核实”，没有给出会带正文的具体错误。各来源抛出的是存储层和端口错误，文字是固定的英文短句。为了不依赖这一点，顺手把 `onHomeDiagnostic` 改成只记错误码或错误类名，不记 `message`。
