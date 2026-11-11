# PR 374 第 1 轮复核判定

| 编号 | 模型 | 判定 | 严重度 | 处理 |
| --- | --- | --- | --- | --- |
| D1 | deepseek-v4.1-flash | 成立 | medium-high | 约定说其余字段会被丢掉、只走 append，和代码不符，后来的人会照错的约定写 |
| D2 | deepseek-v4.1-flash | 成立 | medium-high | ADR 写“置顶永不挤掉”而这条不进档案块也不计入 pinned，文档说法比代码宽 |
| D3 | deepseek-v4.1-flash | 成立 | low | 现有正反向用例都通过，漏检；已补 0/100/2000/2001 边界并验证误写时失败 |
| D4 | deepseek-v4.1-flash | 成立 | low | 会再记一条；这是有意的，但 ADR 没写明，已补写 |
| D5 | deepseek-v4.1-flash | 成立 | low | 可能拿错“最新”的一条，多记或少记一条；已改为按 rowid 取最后写入 |
| D6 | deepseek-v4.1-flash | 成立 | low | 只记一条，subjectRef 指向第一次；这是有意的（档案按主人），ADR 已写明 |
| D7 | deepseek-v4.1-flash | 成立 | low | 不再记一条；ADR 已写明这个上限 |
| G1 | glm-5.3-flash | 成立 | low | 同 D7，ADR 已写明 |
| G2 | glm-5.3-flash | 成立 | low | 没有测试证明对话照常；已补失败注入用例 |
| G3 | glm-5.3-flash | 成立 | low | 同 D5，已改 rowid |
| G4 | glm-5.3-flash | 成立 | low | 旧记录字数是第一次的值；ADR 已写明 |
| G5 | glm-5.3-flash | 不成立 | - | context-formation.test.ts 的替身只用于没有档案服务的老用例，去重和叠加行为由 decision-ledger.test.ts 的真实 SQLite 用例覆盖，不是缺陷 |
