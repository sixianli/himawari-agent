# 编码任务：规则时效交给模型判断（一个 PR）

设计线程：[用模型判断"别提醒我"是一次还是长期](#cmsg_01EE1hey9cboYNfwFnBv5dgrUna2etysJuZsffaL4vv3oQ)。方案以 `/mnt/project-files/rule-scope/integrated-plan.md`（定稿）为准，讨论记录在分支 `claude/project-thread-wpeowm` 的 `.agents/reviews/topic-rule-scope/`。

## 开工条件和顺序

1. **PR 414 合进 main 之后才开**，从当时的 main 开分支。
2. 和 P4-1（ADR 0232，规则加 `suspended` 状态）动同一批文件（`rule-types.ts`、`production-owner-rules.ts`、`enforceableOwnerRule`）：P4-1 已合就在它之上做；没合就先做，告诉 P4-1 线程 `enforceableOwnerRule` 的签名改了。
3. **不改表**（到期时刻存规则参数 JSON），不进改表排队。
4. **上线必须和 PR 414 同一次**：`rule_set` 参数结构改了，老对话只重建一次缓存。PR 414 若已先上线，开工前停下回报设计线程。
5. ADR 号向协调者要（新 ADR：词表退场、两读者核对、到期字段；修订 ADR 0213 决定 5、ADR 0244 决定 5）。

## 要做的

1. `rule_set` 加 `scope`（`standing` / `until` + 当地时间），`SET_ARGUMENTS`、工具定义 `required`、工具描述、提示词目录清单和固定样本同步。外部 agent 路径和旧提议没有 `scope` 时按长期处理。
2. 核对：配置项（开关、模型引用、Jev 概率门槛默认 0.85、超时默认 10 秒、到期上限默认 366 天），支持 Jev（复用 `TypeSafeJevTransport` 的接法）和对话模型两种；只在 `inferred=false` 时调用；输入限原话前后约 2000 字、走出口遮盖和数据分级；`evidence` 子串核对；处理拒答；用量用途 `rule-scope`。
3. 判定表照方案第三节第 2 小节；偏好（`soft`）同样走。删除词表、`isStandingQuote`、`containsMarker`，改 `scripts/evals/owner-rule-live.eval.ts`。
4. `RuleRecord.expiresAt`：`parseOwnerRuleParameters` 校验并收紧顶层键；解析和执行分开，`unreadablePushRule` 不把过期当读不懂；`RuleJudge.decide` 接收判断时刻，推送闸门逐分钟用候选分钟；邮件检查、MCP 读取、`rule_list` 用当前时刻；出处记忆 `validTo` 同步；过期不占 32 条上限、去重当作不存在、重新确认返回“已到期，请重新说”；提议编号含到期时刻。
5. 网页契约只加字段（`expiresAt`、`expired`）；回执卡、记忆页、`rule_list`、决策记录依据、数据导出（含“正在执行”计数）显示到期；三种语言文案。
6. 测试照方案第五节，含全部反向用例和 Playwright。
7. 实测评测：三种配置（只用主模型、加 Jev、加对话模型）各跑 3 次，**跑前在项目聊天报预计费用（预计合计不到 0.1 美元），评测用哪个 key 先问 Andy**；结果写进 ADR，按结果定生产配置。

## 规矩

- 推理强度 medium。不许写死，能动态获取的一律动态；代码不写注释。
- 合并前按 `.agents/instructions/model-review.md` 做代码复核；复核累计预计超 1 美元先问。
- 完成后回报设计线程。
