结论：方案的方向基本正确——在发送点统一裁决、按“通知”而不是“设备”延后、审批和 Muse 告警硬保护，这些都和 ADR 0212 的教训一致。但现在这份方案还不能直接实施：有 7 个高严重度问题会让现有功能回归或让新值在消费端直接被拒绝，而且“延寿”这条反向用例按方案描述其实不会失败。下面先列已核实的，再列推测/未核实的。

## 证实的（读源码和仓库文档）

### 高

**1. 新增的 `web_push` 决策记录会进入每日回顾，并且会被网关契约拒绝**

- 问题：`sqlite-decision-ledger-operations.ts:510-524` 的 `listReviewPool` 条件是 `(kind <> 'proactive' OR ...)`，新增的 `web_push` 行会被选进每日回顾池；`daily-review.ts:340-346` 把它变成候选，`daily-review.ts:251-260` 的 `ledgerGroup` 让它落到 `other`，`daily-review.ts:604-618` 又会把 `other` 放进 `folded.items`。但网关 `proactive.review.snapshot` 的 `kind` 枚举 `contracts-v2.ts:534-544`、`560-563` 没有 `web_push`，只要有一条 `web_push` 记录，整个回顾快照就会校验失败。500 条池上限还可能把真正的 proactive/记忆决策挤出去。
- 证据：`sqlite-decision-ledger-operations.ts:510-524`、`daily-review.ts:340-346`、`daily-review.ts:251-260`、`daily-review.ts:604-618`、`packages/gateway-contracts/src/contracts-v2.ts:534-544`。
- 建议：`listReviewPool` 明确排除 `kind = 'web_push'`（机械延后不需要模型回顾），并加一条“写入 `web_push` 后每日回顾不包含它、快照仍通过校验”的用例；如果确实要展示，必须同时补 `proactiveReviewKinds`、i18n、分组和上限。

**2. 决策链看不到 `web_push`，也没有入口能打开它**

- 问题：`production-decision-chain.ts:98` 只把 `proactive` 和 `rule_review` 当作“记录规则”的种类；`web_push` 会得到 `rules: not_applicable`，即使 `inputs.ruleIds` 里写了规则 id 和修订号也不会显示。更根本的是，决策列表只有 `kind = 'proactive'`：`sqlite-proactive-operations.ts:1012-1022`、`proactive-overview.ts:130`，控制中心 `proactive-reminders.tsx:711` 只渲染这份列表，所以没有任何地方能打开 `web_push` 记录的抽屉。
- 证据：`apps/agent-service/src/production-decision-chain.ts:98`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:1012-1022`、`packages/application/src/services/proactive-overview.ts:130`、`apps/control-center/src/components/proactive-reminders.tsx:711`。
- 建议：把 `web_push` 加入 `rulesRecorded`，并提供一个真实入口（例如设置页“延后记录”或推送反馈里的“为什么延后”）；同时更新 `docs/execution/specs/2026-11-09-decision-record-write-convention.md:26,39`，那里现在写的是“其他种类写空 ruleIds”。

**3. 新的 `push_quiet_hours` 规则会让数据导出直接失败**

- 问题：`data-export/rules.ts:52-58` 的 `STORED_KINDS` 是手工白名单，`storedRuleProblem` 在 `rules.ts:121` 对不在白名单里的规则返回“不认识的规则”；`ruleKind` 依赖 `rule-version.ts:33-39` 的 `KIND_BY_ID`，`wording` 在 `rules.ts:177-192` 也没有新分支。开关一打开，`data/rules.jsonl` / `RULES.md` 的导出和导入都会被这道检查拒绝。
- 证据：`packages/persistence-sqlite/src/data-export/rules.ts:52-58`、`109-124`、`177-192`；`packages/application/src/rules/rule-version.ts:18-39`、`110-171`。
- 建议：把 `push_quiet_hours` 加进 `RULE_KINDS`、`KIND_BY_ID`、`rebuild`、`STORED_KINDS`、`KIND_LABELS` 和 `wording`；增加“打开开关后导出再导入”的 `check:data-export` 用例。方案的 I-73 清单只写了 `rule-version` 和三语 i18n，漏了 `data-export/rules.ts`。

**4. 规则求值抛错会中止整个发送轮次，审批和 Muse 的“硬保护”也挡不住**

- 问题：`RuleJudge.decide` 在 `rule-judge.ts:29-37` 里直接 `#compile(...).evaluate(...)`；`compileRuleExpression` 会因表达式非法抛错（`rule-expression.ts:109-131`），`evaluate` 会因字段缺失/类型不对抛错（`rule-expression.ts:136-157`）。`production-web-push.ts:405-427` 的 `#deliver` 循环没有逐条 try/catch，异常会冒到 `#run` 的整轮 catch（`production-web-push.ts:234-241`、`287-313`）。方案把审批/Muse 的保护放在“裁判之后丢弃”，所以一条坏规则会在保护生效前就抛错，连带审批、Muse、任务完成全部发不出去。
- 证据：`packages/application/src/rules/rule-judge.ts:29-37`、`packages/application/src/rules/rule-expression.ts:109-157`、`apps/agent-service/src/production-web-push.ts:405-427`。
- 建议：在调用裁判之前用代码硬跳过 `approval`、`muse_outage`、`unknown`（以及未来未登记的 `push_class`），直接照发；每条通知的闸门调用包在 try/catch 里，失败按“放行发送并记录 `web_push.gate_failed`”处理；加一条“坏规则/缺字段规则存在时审批仍照发”的反向用例。“未知前缀不会命中”不能只靠规则表达式自觉。

**5. 同一通知多设备时，第一台设备延后后其余设备仍可能在本轮被发送**

- 问题：`listDue` 是“每条通知 × 每台设备”的行（`sqlite-web-push-operations.ts:326-334`），`#deliver` 按 entry 循环且只缓存了 `contents`，没有按 `sourceKey` 缓存闸门结果（`production-web-push.ts:404-427`）。如果第一台设备的 entry 判定延后并更新了 outbox，本轮已经取出的其他设备 entry 仍会在内存里继续走到 `#send`，静默期承诺就破了；同时会重复尝试写决策记录。
- 证据：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:326-334`、`apps/agent-service/src/production-web-push.ts:404-427`。
- 建议：每轮按 `sourceKey` 只裁决一次，命中延后就把该 `sourceKey` 的所有 entry 一起跳过；outbox 更新和决策写入放在同一事务里；加“两个订阅、第一台触发延后、第二台不得发送”的用例。

**6. “去掉延寿反向用例会失败”不成立：邮件提醒和任务完成本来就有 24 小时窗口**

- 问题：`REMINDER_WINDOW_MS = 6h` 只在 `production-web-push.ts:304` 过滤 `reminders.listDue`（到点提醒），到点提醒的 outbox 过期才是 `remindAt + 6h`（`production-web-push.ts:331`）。邮件主动提醒的过期是 `readyAt + PROACTIVE_WINDOW_MS`（24h，`:20`、`:367`），任务完成是 `finishedAt + RUN_WINDOW_MS`（24h，`:22`、`:356`）。方案的第一条规则只管 `mail_reminder` 和 `run_result`，23:30 到 07:00 的邮件/任务根本用不到“6 小时延长到静默结束”；把延寿代码删掉，按方案描述的测试仍会通过。
- 证据：`apps/agent-service/src/production-web-push.ts:19-22`、`304`、`331`、`356`、`367`；`packages/application/src/services/proactive-mail-check-service.ts:1591-1601`。
- 建议：要么明确本步不做 6 小时延寿、只测规则延后；要么把第一条规则改成作用于 `scheduled_reminder`（真正有 6 小时窗口的那类），并用一个原始 `expires_at < defer_until` 的到点提醒/夹具行做“去掉延寿必须失败”的反向用例。现在写“实际只有这两类延寿”与代码不符。

**7. 闸门没有加载规则和清除延后的具体链路**

- 问题：`ProductionWebPushOptions` 没有任何读取规则或设置的依赖（`production-web-push.ts:153-174`），`service-main.ts:2205-2279` 构造时也没传。现有 `readSettings` 只返回 `quietHours` 和 `importantSenders`（`sqlite-proactive-operations.ts:249-268`），`ownerRuleStore.list` 只返回 `owner:` 前缀的规则（`sqlite-owner-rule-operations.ts:83-93`），新的 `push_quiet_hours` 两者都不在。方案说“规则写入/撤销/开关变化时清空 defer_until”，但 `proactive.settings.set`（`production-proactive.ts:626-639`）没有 web push store，且 `rule_book_rules` 还会被记忆触发器改状态/修订号（`0087_rule_book_memory_link.sql:301-400`），应用层清不掉。
- 证据：`apps/agent-service/src/production-web-push.ts:153-174`、`apps/agent-service/src/service-main.ts:2205-2279`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:249-268`、`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:83-93`、`0087_rule_book_memory_link.sql:301-400`。
- 建议：新增一个只读 `readPushRules` 端口（或把 push 规则纳入 `ProactiveSettings` 并在 `ruleBookFor` 里构造）；在迁移里给 `rule_book_rules` 加触发器，任何 INSERT/UPDATE/DELETE 都把该 owner/agent 的 `defer_until` 清空，覆盖设置写入、`rule_undo`、记忆触发的 `needs_review`；加“记忆改动规则后延后项立刻重新裁决”的用例。

### 中

**8. 决策记录的确定性 id 没有 owner/agent，可能被别的 scope 静默吞掉**

- 问题：方案说 id 由 `source_key + 延后目标时刻 + 规则引用` 哈希；`insertLedgerRow` 是 `ON CONFLICT (id) DO NOTHING`（`sqlite-decision-ledger-operations.ts:126-134`），而 `decision_ledger.id` 是全局主键（`0069_decision_ledger.sql:2`）。`muse-channel` 的 source_key 只有 `muse-channel:<outageStartedAt>`（`production-web-push.ts:373`），不同 owner/agent 可能完全相同；规则引用也可能相同。一个数据库里只要出现两个 scope（测试、导入、未来多人库），后写入的那条会被静默丢弃。当前如果严格一库一 owner 不会触发，但代码的契约是 `owner_id + agent_id` 复合作用域。
- 证据：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:120-134`、`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:2`、`apps/agent-service/src/production-web-push.ts:373`。
- 建议：哈希输入加入 `ownerId`、`agentId`（最好也加入 outcome），并加“两个 scope 产生两条记录”的测试。

**9. 设置开关存在哪里、怎么 retire 规则，方案没有落到现有写入端**

- 问题：`proactive_settings` 在 `0086_rule_book.sql:54-60` 之后只剩 `enabled`；静默时段和重要发件人在 `rule_book_rules`。`writeRule` 永远写 `status='active'`（`sqlite-proactive-operations.ts:341-365`），`ownerRule.setStatus` 只接受 `owner:` 编号（`sqlite-owner-rule-operations.ts:7,77-81,167-196`），所以“关开关=规则置 retired”没有现成路径。`readSettings` 也不读取 `push_quiet_hours`。另外我核实了 `check:settings-scope`：它只检查带 `endpoint/device_label/client_id/subscription_id` 的设备表列，`proactive_settings` 是账号级表，不会被它拦；这里不需要新增 settings-scope 规则，但需要明确账号级存储。
- 证据：`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:54-60`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:249-268`、`271-339`、`341-365`、`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:7,77-81,167-196`、`scripts/check-settings-scope.mjs:11-27`。
- 建议：最简单是把开关状态直接由 `push_quiet_hours.status` 派生（`active`=开，`retired`=关），不再加设置列；若要加列，明确加在 `proactive_settings` 并扩展 `ProactiveSettings`、`readSettings/writeSettings`、`proactive.settings.set` 契约、概览快照和控制中心。无论哪种，都要给非 `owner:` 规则一条设置用的 setStatus/retire 路径，并更新 `test/integration/rule-book-store.test.ts` 里对设置对象的精确断言。

**10. “延后到 T”没有落到决策记录，网页看不到 T**

- 问题：`DecisionInputs` 只持久化 `memoryIds/ruleIds/batchId/resultMemoryIds` 等（`sqlite-decision-ledger-operations.ts:144-160`），`decision-record-write-convention.md:35` 也明确说其他种类经 `insertLedgerRow` 只落四个键。方案只写 `inputs.ruleIds` 和 `outcome=deferred`，没有 `deferUntil`；决策链最多显示“延后”，显示不出“延后到 07:00”。outbox 的 `defer_until` 在发送/清理后就没了。
- 证据：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:126-168`、`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`、`39`。
- 建议：在 `DecisionInputs` 增加 `deferUntil`（如需要再加 `pushSourceKey`），同时改 `insertLedgerRow`、`validateLedgerWrite`、数据导出 schema、写入约定文档和决策链测试；否则“网页看得懂”无法验收。

**11. 24 小时上限的“超过按原过期”语义会让静默期直接发送，或需要明确丢弃**

- 问题：方案 1.6 说 `defer_until` 距当前超过 24 小时就“按原过期”。如果实现成“不延后”，闸门在静默期会直接走到 `#send`，等于在静默期推送；如果实现成“丢弃”，又没有对应的记录和状态。多段静默或跨周末时 `quietUntil` 可以超过 24 小时，这是可达路径。
- 证据：方案文本 1.6；`quietUntil` 的循环上限 8 跳见 `packages/application/src/services/proactive-rules.ts:230-259`。
- 建议：明确二选一并写测试，例如“超过 24 小时按 24 小时封顶继续延后，并记录 `defer_capped`”，或者“超过 24 小时记 `expired`、不发送”；不要留下“按原过期但其实会发送”的中间状态。

**12. 第一条规则和 ADR 0212 的触发条件不一致，且 `mail_reminder` 部分是重复的**

- 问题：ADR 0212:65 说等“第一条真会作用于另外四类的规则（例如主人说‘夜里别提醒我’）”一起做；本方案的第一条规则是设置页开关，且明确把“夜里别提醒我”留到以后。它确实是一条真规则，但没有实现 ADR 写作时举例的那条用户路径。另一个问题是邮件主动提醒在创建时已经由 `quietEnd` 延后到静默结束（`proactive-mail-check-service.ts:1591-1601`），只有在“静默时段在邮件 ready 之后被改长”等边缘情况下，`push_delivery` 的 `mail_reminder` 部分才会额外起作用；正常夜里没有第二条效果。
- 证据：`docs/adr/0212-hard-rules-step2-amount-field-and-push-suppression.md:65`、`packages/application/src/services/proactive-mail-check-service.ts:1591-1601`、`apps/agent-service/src/production-web-push.ts:358-368`。
- 建议：要么把第一条规则改成真正作用于 `scheduled_reminder`（同时解决 ADR 说的 6 小时问题），要么在 ADR 0212 中明确“设置开关也算第一条规则”，并把 `mail_reminder` 从这条规则里去掉或写清楚它只在设置变化时生效，避免做出一个看起来有用、实际重复的开关。

**13. 迁移“加一种 kind”的实际工作量被低估，且先例引用错了**

- 问题：`rule_review` 不是在 `0069_decision_ledger.sql:5` 或 `0091_decision_prereviews.sql` 里加的；它是在 `0087_rule_book_memory_link.sql:17-25` 重建 `decision_ledger` 时加的，而且 0087 同时重建了 `source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`、`muse_reference_entries` 等依赖表。方案只写“重建 CHECK”，没有列出这些依赖和 FK 处理，实际迁移风险比描述大。
- 证据：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5-9`、`0087_rule_book_memory_link.sql:17-25`、`1-15`、`0091_decision_prereviews.sql:1-46`。
- 建议：迁移方案按 0087 的模式列出所有要搬的依赖表和外键顺序；或者重新评估“单独 `web_push_gate_decisions` 表”的取舍（方案已拒绝，但需要把 0087 级别的迁移成本写进决策）。

### 低

**14. 其他消费端和文档**

- `production-mcp-read.ts:267-271` 的 `ruleParameters` 对 `push_quiet_hours` 会返回 `{}`，MCP 规则列表看不到时段；`ruleBookFor`/`production-overview` 是否包含新规则需要明确。
- `production-web-push.ts:523-539` 的 run 分支只查线程标题存在，没有像审批那样重验内容；方案风险里说的“`#content` 重验”对任务不成立，实际只有 24 小时上限。
- 如果直接复用 `quietHoursExamples` 给 `push_quiet_hours`，例子 facts 没有 `push_class`，`evaluate` 会抛“字段缺失”（`rule-book.ts:344-375`、`rule-expression.ts:136-157`）；必须单独写带 `push_class` 的正反例。
- `web_push_outbox` 目前不在数据导出里（`packages/persistence-sqlite/src/data-export/` 没有 web_push 表），所以 I-73 清单里的“`defer_until/defer_rule_refs` 数据导出”这一项不必做；真正要改的是 `decision_ledger` 的导出。
- 文档一致性：`docs/execution/specs/2026-10-26-web-push-design.md:112` 仍写“到期后 6 小时”；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:26` 的 kind 列表；`packages/persistence-sqlite/src/schema-catalog.ts:765-770`、`807-812`、`835-840` 的表描述；`docs/agent-rulebook-inventory.md:181` 的 C-5/H-8；这些都不会被现有检查强制失败，但会和代码不一致。
- 业界方向：方案引用的 Apple、Android、Slack 三条一手文档与“静默时延后、关键通知可穿透”一致（未重新抓取）：[Apple Focus](https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios)、[Android 勿扰](https://support.google.com/android/answer/9069335)、[Slack 暂停通知](https://slack.com/help/articles/214908388-Pause-your-Slack-notifications)。这条不构成对具体实现的反对。

## 推测/未核实

- “最终方案文档第 4 步全文”不在仓库里，我无法核对；方案对它的引用按未核实处理。
- “0093 目前被 P5-3 PR A 占用”在仓库里没有 0093 迁移文件，只有方案的项目记忆；按未核实处理。当前仓库最新迁移确实是 0092（`git log` 头 `075dd4a6`）。
- `RuleJudge` 在坏规则下抛错是读代码得出的（不是实际运行复现）；但 `compileRuleExpression` 和 `evaluate` 的抛错路径是明确的。
- 如果生产确实严格“一人一数据库文件”，第 8 条的跨 owner 冲突当前不会发生；但 `decision_ledger` 和测试都按 owner/agent 复合作用域设计，导入也会构造多 owner，所以仍建议加进 id。

## 侧重检查

- **错误路径**：查了坏规则/缺字段规则（`rule-expression.ts:136-157`）、审批/Muse 保护位置（方案 1.2）、`#deliver` 无逐条 catch（`production-web-push.ts:405-427`）、内容失效（`production-web-push.ts:438-540`）、24 小时上限（方案 1.6）、重试进入静默（`#record` 的 `next_attempt_at`）。结论：第 4、11 条需要在实现前定死。
- **不合规范或不可信输入**：查了 `source_key` 前缀映射、`push_class`、静默时段设置校验（`sqlite-proactive-operations.ts:271-300`）、规则表达式限制（`rule-expression.ts:10-99`）、`defer_rule_refs`、决策 id。结论：`unknown` 靠表达式不命中不是代码保证；`defer_rule_refs` 需要 JSON/长度约束；id 需要 owner/agent。
- **安全**：查了决策记录是否可能跨 scope 静默丢失（第 8 条）、决策记录是否含正文（`insertLedgerRow` 只写 id/JSON，不含正文，OK）、规则 id 注入（规则表达式只允许字面量和字段，OK）、导出是否泄露（`DecisionInputs` 只写 id，OK）。
- **资源耗尽**：查了每 10 秒/每设备重复裁决（第 5 条）、`listDue` 的 `SEND_BATCH`（`sqlite-web-push-operations.ts:314-350`）、决策记录进入每日回顾池（第 1 条）、`quietUntil` 最多 8 跳（`proactive-rules.ts:230-259`）、决策行增长（确定性 id 可以抑制同一状态，但规则频繁变更会增长）。结论：主要是第 1、5 条。
- **不可撤销的操作**：查了 `decision_ledger` 的 `ON CONFLICT DO NOTHING`、`rule_book_history` 的不可修改触发器（`0086_rule_book.sql:25-31`）、outbox `prune`（`sqlite-web-push-operations.ts:568-579`）、规则 retire。结论：没有新的不可逆删除；但决策记录一旦写入不能改，所以 id 冲突和 T 字段要在写入前定好。
- **规则/文档一致性**：查了 ADR 0212、决策记录写入约定、`schema-catalog`、`agent-rulebook-inventory`、web push 设计规格。结论：有多处会过时，见第 14 条。

## 如果由我来改，我会这样改这份方案

1. **保留 `#deliver` 发送点裁决**，但在裁判前把 `approval`、`muse_outage`、`unknown`、未登记的 `push_class` 直接归为“保护/放行”，完全不调用裁判；每条通知的裁判包 try/catch，失败放行发送并记诊断。这样审批和 Muse 的硬保证才是代码保证，而不是“裁判之后再丢弃”。
2. **把延后放在独立的 `web_push_defers` 表**（`owner_id, agent_id, source_key, defer_until, rule_refs, rules_revision, decided_at`，外键到 outbox，`ON DELETE CASCADE`），`listDue` 用 `NOT EXISTS` 排除。它比给 outbox 加两列更容易做“规则变化清空”和“新设备到手”的语义，也让 `prune` 自动清掉。若坚持加列，至少要加 SQL CHECK、索引和端口方法。
3. **用数据库触发器清空延后**：给 `rule_book_rules` 加 INSERT/UPDATE/DELETE 触发器，任何规则变化（包括 0087 的记忆触发器和 `rule_undo`）都清空该 scope 的 `web_push_defers`。不要依赖 `ProductionProactive` 跨服务调用 `ProductionWebPush`。
4. **每轮按 `sourceKey` 只裁决一次**，命中延后就把该 sourceKey 的所有设备 entry 跳过；outbox/defer 更新和决策写入放同一事务；加双设备用例。
5. **决策记录要么完整支持，要么不进决策记录**：如果进现有 `decision_ledger`，就加 `web_push` kind、`deferUntil` 字段、owner/agent 进 id、`rulesRecorded` 支持、排除每日回顾、补 `proactiveReviewKinds`/decision chain/数据导出/写入约定；如果不想动这么多消费端，就承认它是“通知投递日志”，放进独立表并从 settings/推送反馈里展示，不要伪装成决策记录。
6. **第一条规则重新选**：本步若目标是 ADR 0212 的 6 小时问题，就做 `scheduled_reminder`；若只做设置开关，就在 ADR 里明确“这是设置规则，不是一句话规则”，并把 `mail_reminder` 从规则里去掉，避免与现有 `quietEnd` 重复。
7. **测试矩阵按“会失败”设计**：坏规则仍发审批、双设备只延后一次、多 owner 不冲突、`defer_until` 被记忆触发器清空、开关打开后数据导出/导入、每日回顾不含 `web_push`、`push_class` 未知放行、跨 24 小时封顶。特别是“去掉延寿”要用原始过期时间早于 T 的到点提醒或夹具行，不要用本来就有 24 小时的邮件/任务。
8. **同步文档**：ADR 0212（第一条规则的触发）、决策记录写入约定（kind 和 ruleIds 语义）、`schema-catalog`（outbox、decision_ledger、proactive_settings）、`agent-rulebook-inventory`（C-5/H-8）、web push 设计规格的 6 小时描述。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会，前提是严格不扩 `RULE_TYPES`、不改 `packages/prompt-catalog`、不把新规则塞进系统提示。`rule_set` 的 `type.enum` 由 `RULE_TYPES` 生成（`production-owner-rules.ts:149-171`），新闸门/`push_class` 不会动它；`push_quiet_hours` 存在 `rule_book_rules`，被 `ruleBookFor`/MCP/概览读取，不是系统提示；通过 `rule_list`/`memory.rules.read` 返回时是工具结果，属于追加的历史，不是请求开头。每轮会变的 `defer_until`、T、决策 id 都不进请求；仍然是“只在末尾追加，每轮会变的值只在最后一条消息里”。建议保留 `check:prompt-prefix` 并加一条断言：`rule_set` 的 `type.enum` 不含 `push_delivery`/`push_quiet_hours`。依据：`.claude/rules/prompt-prefix.md:31-35`、`:84-88`。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

不会影响模型文本。内部值要保证确定：`quietHoursExpression` 已经把 days 排序（`rule-book.ts:298-315`），`defer_rule_refs` 排序去重，决策 id 建议再把 owner/agent/outcome 加入哈希；注意 `readSettings` 的 SQL 没有 `ORDER BY`（`sqlite-proactive-operations.ts:239-248`），任何依赖规则顺序的拼接都要自己排序。`defer_until` 只来自 `quietUntil` 和设置，是确定的；不要用 `Date.now()` 直接进入规则或模型文本。遮盖没有变化，因为没有新的模型文本。

**3. 自动检查够不够？反向用例真的会失败吗？**

方向够，但覆盖不够。已计划 `[HR-4]`、`check:rule-registry`、迁移契约、`check:prompt-prefix`，但：
- “去掉延寿”按方案用邮件/任务 23:30→07:00 **不会失败**（两者本来 24 小时），必须换成到点提醒或把原始过期设到 T 之前。
- “去掉兜底”必须注入一条显式 `push_class == "approval"` 的测试规则，否则第一条规则根本不碰审批，守卫删掉也不会失败。
- 还缺：坏规则仍发审批、双设备只延后一次、多 owner 决策 id、记忆触发器改规则后重裁、`push_quiet_hours` 的导出/导入、`web_push` 不进每日回顾、`push_class` 未知放行。建议把这些都做成反向用例，并确认去掉修复后确实失败。

**4. 新值逐个核对生产端和使用端，两端的校验都能接受吗？**

大部分能，但方案清单不完整。逐个说：
- `push_delivery`：生产端 `RULE_GATES`（`field-catalog.ts:9`）、字段目录、`GATE_OUTCOMES`（`rule-book.ts:435-443`）、`rule-expression.ts:43-48`、`assertRuleShape`；消费端 `RuleJudge` 和测试。方案基本覆盖，但要加字段和测试。
- `push_class`：生产端 `RULE_FIELD_CATALOG` 和 `push_class` 映射；消费端生成规则、gate facts、例子。方案覆盖，但未知值要靠代码放行。
- `push_quiet_hours`：生产端 `RULE_IDS`/`rule-version.ts` 的 `KIND_BY_ID`/`rebuild`、`data-export/rules.ts` 的 `STORED_KINDS/KIND_LABELS/wording`、`production-mcp-read.ruleParameters`、`ProactiveSettings/readSettings/writeSettings`；消费端三语 i18n、决策链、数据导出、`check:data-export`。方案漏了 `data-export/rules.ts`、`readSettings`、`ruleParameters` 和 `ProactiveSettings`。
- `defer_until/defer_rule_refs`：生产端迁移/outbox/port；消费端 `listDue`、gate 更新、`prune`、数据导出（实际上 outbox 不导出，所以只需要 SQL CHECK、索引和端口方法）。方案清单里的“数据导出”应删掉或改成“决策记录的 deferUntil”。
- `web_push` kind：生产端 `DECISION_KINDS`、`DECISION_OUTCOMES`、`validateLedgerWrite`、`insertLedgerRow`、SQL CHECK 迁移、`listReviewPool`、`rulesRecorded`、`schema`；消费端 `contracts-v2` 的 `proactiveReviewKinds` 和 decision chain kind、i18n、calibration（建议不建组）、data-export `DECISION_SCHEMA`/import、`proactive.overview`/控制中心列表、`weekly.check`/`ledger-observation` 计数、写入约定文档、schema-catalog。方案说“六处”明显偏少；至少还要处理 `listReviewPool`、`rulesRecorded`、`proactiveReviewKinds`、`proactive.overview/listDecisions`。
- 原因码：方案没写具体值；`reason_code` 必须 1–64 字符（`0069_decision_ledger.sql:19`），先定一个如 `WEB_PUSH_DEFERRED_QUIET_HOURS` 并在两端的校验里测试。
- 开关：生产端 `proactive.settings.set`/`writeSettings`/`readSettings`；消费端网关契约、evolutive overview、控制中心、`check:settings-scope`（已核实账号级表不会被拦）。方案提到了网关/控制中心，但漏了 `writeSettings` 的调用点和 `rule-book-store` 的精确对象断言。
