# PR 455 第 4 轮：第 3 轮的修改、按来源清除和断开、合入最新 main

问题、目标和约束同第 1 轮（`.agents/reviews/pr-455/briefs/43de0dc71882-code-review.md`）。前三轮的逐条判断在 `.agents/reviews/pr-455/round-<n>/judgments.md`。

这一轮的增量（从第 3 轮复核的提交 4bc381ce5 起）有四部分：

1. 第 3 轮 4 条低意见的修改（提交 2c86f90aa）。
2. 设计线程定的“清除记录和断开只管点名的那个来源”（提交 92a330138）：降频表 `proactive_push_backoff` 加 `source` 列、主键带上来源；`clearRecords` 带来源，只删这个来源的提醒条目、已处理条目、降频状态、判断记录和模型输入输出，推送里只拿掉这个来源的条目；`removeSource` 只清这个来源的降频状态。
3. 补回决策记录的 `memory_review` 和 `rule_review` 结果值（提交 7756764a9；合入 main 后这部分被新迁移取代）。
4. 合入最新 main（提交 b3f2f0049）。main 改了迁移规则：编号用 14 位时间戳，决策记录的种类和结果值放在 `decision_ledger_kinds`、`decision_ledger_outcomes` 两张参照表里，由触发器校验；改已有的表要在同名 `.meta.json` 里声明（`.agents/instructions/migrations.md`）。原来占位的 `0097_proactive_source_registry.sql` 删掉，按 main 现在的表定义重新生成 `packages/persistence-sqlite/src/migrations/20261114172143_proactive_source_registry.sql`。合并冲突的解决也在这个提交里。main 自己带进来的文件不用复核，只看本 PR 自己的代码和它们是否对得上。

## 作者的说法（请核对，不要直接采信）

1. 新迁移重建的 9 张表，除来源名约束（`source`、`scenario`、`mail_source` 从 `IN ('gmail')` 换成名字格式检查）和降频表新加的 `source` 列外，表、索引、触发器的定义和 main 现在的完全相同，包括 main 新加的 `decision_ledger_known_kind_insert/update` 触发器；每张表的行原样搬过去，降频表的旧行来源填 `gmail`。`.meta.json` 声明了 6 张改动的表和去掉的 `'gmail'` 取值，`npm run check:migration-conflicts` 通过。
2. 迁移契约测试 `keeps every decision kind and outcome the ledger accepted before` 迁移前从 `decision_ledger_outcomes` 读出每一对种类和结果值各插一行（含 `memory_review`、`rule_review` 的 `cleared`、`web_push`），迁移后一行不少。
3. 合入后，Gmail 判断请求和 main 新加的单号提取请求同 main 上用同一段测试生成的对照逐字节相同（`test/fixtures/proactive-gmail-request.golden.json` 已在 main 上重新生成）。
4. 主动检查每一轮先做 main 新加的规则复核（`reviewRules`），再按来源逐个检查（`#runSources`），关掉的来源跳过。
5. main 把邮件里的单号改由模型提取后通过 `references` 传给 `related`；这个分支把 `references` 加进了 `ProactiveMailReader.related` 的输入，Gmail 读取器和演示邮箱都照传。
6. 三个新操作 `proactive.sources.read`（读）、`proactive.source.settings.set`（改）、`proactive.source.switch_off`（收紧）登记进客户端能力表，Swift 清单由脚本重新生成。
7. 清除一个来源的记录或断开一个来源，另一个来源的提醒条目、已处理条目、降频状态、判断记录、连接都不变（测试 `clearing the records of one source, or disconnecting it, leaves the other source alone`）。
