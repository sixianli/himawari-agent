# PR 386 第 1 轮判断

- r1-1、r1-2（中，成立，两个模型都提）：测试只有两条 active 规则，排序、已撤销不列、待重新确认照常列、已知类型但参数不合法都没被锁住。集成测试改为在开库前直接写五行 `rule_book_rules`：一条 active（更新时间最晚，排序用例）、一条 needs_review（更新时间最早，断言 `enforced: true`）、一条 retired（断言不出现）、一条类型不认识、一条参数不全。数据库按更新时间倒序返回，用例断言按编号排序，删掉排序后失败；把 `includeRetired` 改成 true 后 retired 那条会出现，用例失败。
- r1-3（不成立，模型标中）：规则参数（词语、发件域名）随静态令牌对外。持有同一令牌的程序本来就能用 `find_memories` 读到这条规则的出处记忆（规则类记忆，原话），参数没有扩大暴露面；ADR 0219 已写明这个入口的令牌就是主人的全部只读权限。分令牌、按程序授权是 P5-3 的范围。
- r1-4、r1-5（低，成立，两个模型都提）：对外给的是存储的原始参数，不是执行时归一化后的参数。改为对能执行的规则再过一遍 `parseOwnerRuleParameters`，给解析后的参数；用例存 `@ISA.go.jp `，断言对外是 `isa.go.jp`。
- r1-6、r1-7（低，成立）：一行规则让 `enforceableOwnerRule` 抛出非 `RuleTypeError`（例如例子和表达式不符）时整本规则手册失败。改为逐条捕获，这条标 `enforced: false`、不给参数，其他规则照常列出。ownerRules 整体读取失败仍让整次失败，和 settings 一样（同一个 SQLite），不另加用例。
- r1-8（不成立）：作者关于 `format:check`、`check:secrets` 在 main 上失败的说法未核实。已在干净的 main 949d2fa9 上实跑两步，均失败（evals/owner-rule/*.json 没格式化；scripts/evals/owner-rule-live.eval.ts 的 authorization-bearer），本 PR 不碰这些文件。
