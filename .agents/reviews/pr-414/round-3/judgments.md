# PR 414 第 3 轮复核判断（DeepSeek，被复核的提交 d2dd9c28）

- r3-1（一次性词表不完整）：成立，中高。词表补不全是追着例子跑，改成结构性做法：“别提醒我”这一族说法单独不算长期，必须同时带反复出现的时段词（夜里、晚上、周末、每天、at night 等）才算；并补“明天、暂时、先别、目前、tomorrow”等一次性词。production-memory-capture.test.ts 补正反向断言（“别提醒我”“明天别提醒我”“暂时别提醒我”“先别提醒我”“明天晚上别提醒我”均为否，“晚上别提醒我”“周末别打扰我”“don't remind me at night”为是）。
- r3-2（逐分钟扫描）：成立，低。zonedParts 改为复用 Intl.DateTimeFormat（按时区缓存，最多 64 个），上一轮已改成同类只判断一次。
- r3-3（读不懂只认 type 字段）：成立，低。unreadablePushRule 改看整份参数文本是否含 push 规则类型名；单测补两个用例。
- r3-4（迁移契约 3/8）：不成立。consolidation-hold-migration.contract.test.ts 的 dump 对 source_insights、proactive_processed_messages、decision_ledger_payloads、proactive_push_backoff、muse_reference_entries 等表迁移到最新版本后逐行比较，已运行通过（本 PR 改了它的规整规则使其容忍 web_push）。
- r3-5（回放说明）：成立，低。rule_set 说明写明 push_quiet_hours 没有回放；提示词清单摘要同步。

三轮复核仍有中高意见（第 1 轮 5 条、第 2 轮 3 条、第 3 轮 1 条，数量逐轮减少，第 3 轮只剩词表覆盖这一条，已改成结构性做法）。按 Andy 的规则，三轮没过先停下报告他，由他决定再复核一轮还是直接合并。累计费用 1.01 美元。
