CLAIM|1|一致|docs/adr/0244-hard-rules-step4-unified-push-gate.md:31|发送闸门（[PR 414](0244-hard-rules-step4-unified-push-gate.md)）让主人自己定的“不推送时段”规则判断一次发还是延后|第 4 步让所有推送经过同一个闸门（发送前用规则手册里的规则判断一次“现在发，还是延后”），并加一种主人规则 `push_quiet_hours`（静默延后）。
CLAIM|2|一致|apps/agent-service/src/production-web-push.ts:569|主人正在看 Himawari 时不弹推送|await this.#record(entry, now, "suppressed", null);
CLAIM|3|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:447|设计里早就有这一块（[苹果设备身体设计](../execution/specs/2026-11-11-apple-device-body-design.md#10-送达时机)的“10. 送达时机”）|## 10. 送达时机
CLAIM|4|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:464|紧急的立刻送|1. 紧急的（现有规则判定的高优先级，例如 48 小时内截止的要你做事）：立刻送，用“时效性通知”级别。
CLAIM|5|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:465|不紧急的在主人忙时延后到状态结束或最晚送达时间，先到哪个算哪个|2. 非紧急的：主人在日程中、在和人说话、在睡觉、在开车时，延后到状态结束或最晚送达时间，先到哪个算哪个。每种提醒的最晚送达时间登记在来源上。
CLAIM|6|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:466|状态不知道就按现有时段规则办|3. 状态是“不知道”：按现有时段规则办，不额外延后。
CLAIM|7|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:467|正在看 Himawari 就不弹推送|4. 正在看 Himawari：不弹推送，在 App 或网页里显示。
CLAIM|8|一致|packages/application/src/services/web-push-gate.ts:78|发送闸门对审批、缪斯故障和未知类别不延后|if (PUSH_RULE_PROTECTED_CLASSES.includes(input.pushClass)) return DELIVER;
CLAIM|9|一致|packages/application/src/services/web-push-gate.ts:18|`PUSH_RULE_PROTECTED_CLASSES`，含 `approval`、`muse_outage`、`proposal`、`unknown`|export const PUSH_RULE_PROTECTED_CLASSES: readonly PushClass[] = Object.freeze([ "approval", "muse_outage", "proposal", "unknown", ]);
CLAIM|10|一致|packages/application/src/ports/decision-ledger.ts:43|决策记录已有类别 `delivery_timing`|"delivery_timing",
CLAIM|11|一致|packages/application/src/ports/decision-ledger.ts:77|结果只有 `delivered`、`deferred`、`deadline_reached`、`shown_in_app`|delivery_timing: ["delivered", "deferred", "deadline_reached", "shown_in_app"],
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:41|决策记录表只允许 `memory_candidate` 这一类带“把握”（`confidence_permille`）|CHECK ( kind = 'memory_candidate' OR (category IS NULL AND confidence_permille IS NULL AND inferred IS NULL) ),
CLAIM|13|一致|packages/application/src/ports/perception.ts:128|感知记录里已有 `speech.utterance`|"speech.utterance": recordType("hearing", "required", {
CLAIM|14|一致|packages/application/src/ports/perception.ts:161|感知记录里已有 `motion.activity`|"motion.activity": recordType("body", "none", {
CLAIM|15|一致|packages/application/src/ports/perception.ts:148|感知记录里已有 `health.sample`|"health.sample": recordType(
CLAIM|16|一致|packages/application/src/ports/perception.ts:211|感知记录里已有 `context.focus`|"context.focus": recordType("surroundings", "none", {
CLAIM|17|一致|packages/application/src/ports/perception.ts:201|感知记录里已有 `context.connectivity`|"context.connectivity": recordType("surroundings", "none", {
CLAIM|18|一致|packages/platform-node/src/perception-service.ts:446|字段由写入处校验|const evidence = validatePerceptionFields(definition.evidence, record["evidence"]);
CLAIM|19|一致|packages/application/src/ports/perception.ts:266|日历事件的设备镜像类型（`DEVICE_MIRROR_KINDS.calendar_event`）已定义|calendar_event: Object.freeze({
CLAIM|20|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:55|发往外部服务前必须遮敏感值并在 `scripts/check-egress-redaction.mjs` 登记|4. 发往外部服务前必须遮敏感值，并在 `scripts/check-egress-redaction.mjs` 里登记；`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口。
CLAIM|21|一致|packages/platform-node/src/delivery-timing-decision.ts:5|Jev 经 Vercel AI Gateway 调用|export const DELIVERY_TIMING_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
CLAIM|22|一致|packages/platform-node/src/delivery-timing-decision.ts:55|是非题回答“是”的概率|{ type: "predicate", name: QUESTION_NAME, instructions: DELIVERY_TIMING_QUESTION.text },
CLAIM|23|一致|packages/platform-node/src/delivery-timing-decision.ts:75|带 `zeroDataRetention: true`|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|24|一致|packages/platform-node/src/perception-service.ts:231|模型费用算进感知每日模型费用上限|key: "perception.model_cost.daily",
CLAIM|25|一致|packages/platform-node/src/perception-service.ts:227|`packages/platform-node/src/perception-service.ts` 的 `reserveModelCost`|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|26|一致|scripts/evals/delivery-timing-live.eval.ts:6|评测脚本 `scripts/evals/delivery-timing-live.eval.ts` 用生产同一个类 `DeliveryTimingDecision`|import { DeliveryTimingDecision } from "../../packages/platform-node/src/delivery-timing-decision.ts";
CLAIM|27|一致|evals/delivery-timing/result.json:2|问真的 Jev|"model": "typesafe-ai/jev",
CLAIM|28|一致|test/fixtures/delivery-timing-eval/dataset.json:2|数据集 `test/fixtures/delivery-timing-eval/dataset.json` 共 40 条：20 条主人在忙（开车、骑车、跑步、车载连接、睡着、专注、和人说话及组合），20 条不忙（静止、走路、醒着、一个人、专注关、没连车及组合）|"cases": [
CLAIM|29|一致|evals/delivery-timing/result.json:5|每条问 2 遍，共 80 次|"runs": 2, "calls": 80,
CLAIM|30|一致|evals/delivery-timing/result.json:7|0 次出错|"errors": 0,
CLAIM|31|一致|evals/delivery-timing/result.json:13|中位约 0.2 秒|"medianMilliseconds": 202,
CLAIM|32|一致|evals/delivery-timing/result.json:14|最终问法这一版约 0.003 美元（`result.json` 的 `estimatedUsd`）|"estimatedUsd": 0.003354
CLAIM|33|一致|evals/delivery-timing/first-prompt-result.json:4|第一版问法的结果记在 `evals/delivery-timing/first-prompt-result.json`|"threshold": 700,
CLAIM|34|一致|evals/delivery-timing/first-prompt-result.json:8|门槛 0.7 下，忙的 40 次里判出 29 次|"busyTotal": 40, "busyDeferred": 29,
CLAIM|35|一致|evals/delivery-timing/first-prompt-result.json:10|不忙的 40 次里误延后 0 次|"clearTotal": 40, "clearDeferred": 0,
CLAIM|36|一致|evals/delivery-timing/first-prompt-result.json:12|漏掉的是只有车载连接、骑车、跑步、只有睡着这几类|"wrongIds": [ "busy-carplay-1", "busy-carplay-2", "busy-cycling", "busy-running", "busy-asleep-1", "busy-asleep-2" ],
CLAIM|37|一致|evals/delivery-timing/first-prompt-result.json:68|概率 0.21|"probability": 0.21,
CLAIM|38|一致|evals/delivery-timing/first-prompt-result.json:88|概率 0.63|"probability": 0.63,
CLAIM|39|一致|packages/prompt-catalog/src/perception.ts:602|现用问法（把开车、骑车、跑步、连着车、睡着、和人说话、专注模式逐项写明，也写明静止、走路、醒着、一个人、没开专注不算忙）|Answer yes when interrupting the owner with this notification right now would be unwelcome, which is the case when a report shows the owner is driving, cycling or running, is connected to a car, is asleep, is talking with other people, or has a focus mode on. Answer no when nothing shows the owner is busy: standing still, walking, awake, alone, or no focus mode.
CLAIM|40|一致|evals/delivery-timing/result.json:8|门槛 0.7 下，忙的 40 次全部判出|"busyTotal": 40, "busyDeferred": 40,
CLAIM|41|一致|evals/delivery-timing/result.json:10|不忙的 40 次误延后 0 次|"clearTotal": 40, "clearDeferred": 0,
CLAIM|42|一致|evals/delivery-timing/result.json:551|最低 0.94|"probability": 0.94,
CLAIM|43|一致|evals/delivery-timing/result.json:321|最高 0.53|"probability": 0.53,
CLAIM|44|一致|apps/agent-service/src/production-apple-push.ts:105|审批照旧用“时效性”级别，不判断|: input.kind === "approval" ? "time-sensitive" : "active",
CLAIM|45|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|ADR 0103 的红线在这一处再放开一格|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|46|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|违反 [ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)（意思交给模型，不写词表）|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|47|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:90|用对话模型（DeepSeek、GLM）判断：要写提示让它输出 JSON，再解析，延迟约 1 秒，比 Jev 贵（ADR 0264 同样的理由）|**用 DeepSeek 或 GLM 这类对话模型判断。**要写提示让它输出 JSON，再解析，失败的情况更多；每次约 0.000045 和 0.000035 美元，比 Jev（约 0.000025 美元）贵；延迟约 1 秒，Jev 实测约 0.2 秒。Andy 定判断类优先用 Jev。
CLAIM|48|一致|apps/agent-service/src/production-web-push.ts:31|延后后通知的有效期顺延，但总寿命仍不超过 48 小时，和发送闸门的规则一样|const PUSH_TOTAL_LIFE_MS = 48 * 3_600_000;
CLAIM|49|一致|packages/application/src/ports/decision-ledger.ts:77|`shown_in_app` 这个结果没有写入处|delivery_timing: ["delivered", "deferred", "deadline_reached", "shown_in_app"],
CLAIM|50|一致|docs/adr/0255-model-scores-urgency-of-home-items.md:11|首页的紧急度打分见 [ADR 0255](0255-model-scores-urgency-of-home-items.md)|# ADR 0255：首页上等主人定的事由模型打要紧度并存住，审批另由模型写一句话和同意按钮上的字
CLAIM|51|找不到|-|评测和生产共用同一把 key|-

Andy 的原话、数据集“自己写的/问法照类别调”、Vercel/TypeSafe 的零保留合同、iOS 通知级别和手机真机表现等无法从仓库核实，未在 CLAIM 中判为一致；其中“评测和生产共用同一把 key”已按找不到列出。“决定”和“这一版没做”里多数是方案要新增或修改的行为，按题目要求未当作现状逐条核对。
