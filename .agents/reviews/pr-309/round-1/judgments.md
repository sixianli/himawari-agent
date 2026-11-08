# PR 309 第 1 轮复核逐条判断

复核提交 d911557a，基准 01873f5c，经 Magpie，DeepSeek 与 GLM 两个模型，本轮费用 0.1284 美元（累计 0.1284）。

“会出错”中高 6 条（实际 5 个问题，GLM 与 DeepSeek 有重复），低 4 条；其余不成立或“可以更好”。有中高，所以需要作者修改后复核第 2 轮。

## 必答问题：这个改动会不会改变模型已经见过的请求开头

两个模型都读代码后回答不会。降频判断发生在模型输出之后，`push_class` 和降频状态只进 SQLite 和界面快照，不进提示词、系统提示、工具定义或历史。线程自己没有发现相反证据。

## 会出错，中高（必须改）

| 编号 | 问题 | 依据 | 建议 |
|---|---|---|---|
| D1 / G2 | 没送达的推送（无订阅、发送失败）也被算成“被忽略” | `proactive-push-backoff.ts:44-52` 用 `COALESCE(feedback.first_sent_at, insight.updated_at)` 并 LEFT JOIN；`web_push_feedback` 只在发送成功时插入。已读代码核实。ADR 0184 第 66 行写的是不计这类推送 | 只统计有 feedback 行的推送，补反向用例 |
| D2 / G1 | 同一次推送含多条同域名提醒时，一次忽略被算成多次 | 同一次推送的所有 insight 共用同一个 `push_source_key`（`sqlite-proactive-operations.ts:866`），计数 SQL 逐行计数。已读代码核实 | 按 `push_source_key` 聚合，补反向用例 |
| D3 / G4 | 恢复与进行中的检查并发，旧 preview 写回台阶，恢复被覆盖 | preview 是独立读，写入在后面的 `record` 事务里；`execute` 不在 `#running` 锁内。调度是否真会并发作者要确认；确认前按中高处理 | 在写事务内重算，或写入带条件 |
| D4 | 断开 Gmail 不清 `proactive_push_backoff` | `removeSource` 的删除列表没有它，`clearRecords` 有。已读代码核实 | 断开时一并清除，ADR 写明生命周期 |
| D5 | `ignored_count` 无上限，表 CHECK `<= 1000`，超限使整个事务回滚 | 阈值从 0 改为 3 时历史忽略数可能超过 1000，主动检查会卡死；可达路径窄，拿不准按中高 | 写入前取上限，补用例 |

## 会出错，低（判低的理由见 verdicts.jsonl）

| 编号 | 问题 | 判低理由 |
|---|---|---|
| D6 / G3 | 原因码优先级使记录出现 `verdict=pushed` 加 `PUSH_SUPPRESSED`，与 ADR 的“silent”矛盾，也盖掉 `QUIET_HOURS` | 只影响一条记录的标签，不改变推送行为；ADR 与代码的矛盾要一并改 |
| D8 | `source_insights` 目录说明漏写新增的明文域名列 | 只是说明漏写 |
| D9 / G5 | 发件地址不含 `@` 时整串当域名明文入库 | 要上游解析出畸形地址，后果是显示含混 |

## 不成立

- D7（恢复后第一条推送被严格 `>` 漏计）：不成立。恢复把 `since_at` 设为恢复时刻，推送一定在其后发送；升台阶那次检查对该类是压制，不产生推送，没有可达输入使两者相等。
- D10（“点开清零”用例覆盖不到）：不成立。已点开那条在 25 小时后检查，去掉 `else if (row.openedAt !== null) break` 它会被算成忽略，2+1=3 触发降频，断言 `pushed` 会失败。

## 可以更好（不改，列给 Andy）

- D11：补一个从 schema 80 升级的合同测试。迁移是纯 ADD COLUMN 加新表，没有改写旧数据，现有合同测试已更新序号。
- D12：快照契约新增必填 `backoff`，滚动升级时新旧组件不兼容。agent-service 与 control-center 同包上线，契约严格校验是仓库既有做法。

## 另外两条模型提醒（不单列）

- 迁移后 `minimum_writer_sequence` 变 81，旧二进制回退会被拒绝，ADR 0184 没写这一点。线程建议作者顺手在 ADR 补一句，不单独算问题。
