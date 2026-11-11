# PR 413 第 1 轮判断

复核的提交是 82cc2ef2；ds1 指出的问题在复核期间已由设计线程提出并在 931412f5 修掉，这一轮判断照常记录。

## 会出错
- ds1（高，中高）成立：start_here 的 today 段（提醒正文、对话摘要）不受读取上限管。931412f5 起 reminders 和 summaries 来源带上限参数；反向用例：sensitive 提醒、sensitive 摘要在默认上限下不出现，去掉过滤用例失败（已验证）。
- ds3（中，中高）成立：决策记录写入约定只写了 today_context。已改 docs/execution/specs/2026-11-09-decision-record-write-convention.md 第 45 行。ADR 0219 的“三个只读工具”和 ADR 0242 的缺席由设计线程在 PR 411 的 ADR 0242 里处理（本 PR 不含 ADR 文件，清单 changedIn 只写编号）；这一点在 PR 描述里写明。
- ds4（低）成立：规则摘要截断提示指向 find_memories。新增 mcp.start-here-rules-omitted 指向 rule_book，start_here 描述写准“profile 和 rules 超预算会截断”。
- ds7（低）成立：readCeiling 类型去掉 restricted。

## 不成立或可以更好
- ds2、gl3：遮盖整批一起遮是 ADR 0219 决定 4，设计线程已确认保留；两个模型指出的“跨字段牵连 profile 字节”是已接受的行为，反向用例 [P5-A] 守着。
- ds5：auto 的上限用例现在构造 6 条相关记忆，删掉 Math.min 用例失败（已验证）；非布尔 auto 用例证明的是 schema 拒绝，处理器里不可达的校验已删。
- ds6：version 只代表 profile 正文，工具描述没有别的承诺。
- ds8：推测，没有测量。
- gl1：find_memories、today_context、rule_book 仍是原级别，任务 B 统一，PR 描述已写明。
- gl2：needs_review 的规则在 rule_book 里 enforced 为真，摘要与之一致。
- gl4、gl5、gl6、gl7：建议补测或提取函数，不改变行为，列给 Andy。
