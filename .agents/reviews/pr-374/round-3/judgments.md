# PR 374 第 3 轮复核判定

| 编号 | 判定 | 严重度 | 处理 |
| --- | --- | --- | --- |
| R3-1 | 成立 | low | ADR 说按主人，代码按主人加 agent；已改 ADR 文字 |
| R3-2 | 成立 | low | 会记三条，ADR 没写这个例子；已补 |
| R3-3 | 不成立 | - | ADR 0214 决定 3 和后果一节写明写入失败时忽略、不影响对话，和既有的 selection_limit_reached 截断记录同一做法；第 1 轮已补失败注入用例证明对话照常 |
| R3-4 | 不成立 | - | 生产代码没有任何地方设置 characterBudget（grep 只有 owner-profile-service.ts 的声明和默认值 2000），只有测试会传，limit 为 0 不可达 |

可以更好（不改，列给 Andy）：去重查询按 rowid 倒序会扫描该主人全部 context_truncation 记录，记录很多时可加 (owner_id, agent_id, kind, reason_code) 索引，要改表结构，留待以后。
