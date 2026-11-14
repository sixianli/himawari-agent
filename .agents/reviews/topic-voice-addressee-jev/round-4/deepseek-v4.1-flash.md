CLAIM|1|一致|clients/apple/Sources/HimawariCore/Listening/ListeningSession.swift:23|iOS 第 8 批“让它听”：手机一直在听|case listening(since: Date, mode: ListeningMode, downgrade: ListeningDowngradeReason?)
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:120|认出 Himawari 的名字就把这句话当成口头指令发给服务器|return .command(request: request.text, heard: heard, touched: start == .ownerTouched, heardName: request.name)
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30@c1100c382e88e15a7ea097517eba560d1073caf4|最初的做法是只看名字前面最多 4 个字，来猜这句话是不是在叫它|static let leadingAllowance = 4
CLAIM|4|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|`clients/apple` 里 `NameCall.match` 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|5|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|按位置猜意思也违反了“理解意思交给模型”（ADR 0249）|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|6|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。来源：ADR 0103 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|7|一致|packages/application/src/services/voice-command.ts:65|原有的证据门槛包含 AirPods 三项核对|if (evidence.inputRoute !== "airpods")
CLAIM|8|一致|packages/application/src/services/voice-command.ts:72|原有的证据门槛包含声音像不像主人|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|9|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`|export function decideVoiceCommand(
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:976|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|11|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409|return options.sendJson(reply, 409, {
CLAIM|12|一致|packages/platform-node/src/device-api-routes.ts:161|错误码是 `VOICE_COMMAND_UNCONFIRMED`|export const VOICE_COMMAND_UNCONFIRMED_CODE = "VOICE_COMMAND_UNCONFIRMED" as const;
CLAIM|13|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|14|不一致|packages/platform-node/src/perception-service.ts:218|`packages/platform-node/src/perception-service.ts` 第 218 行 `reserveModelCost(scope, amountMicros)`|settings(scope: PerceptionScope): Promise<PerceptionSettings> {
CLAIM|15|一致|packages/platform-node/src/perception-service.ts:226|用的是 `perception.model_cost.daily` 这项上限|key: "perception.model_cost.daily",
CLAIM|16|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|17|一致|scripts/check-egress-redaction.mjs:219|发往外部服务前必须遮敏感值|`${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
CLAIM|18|一致|scripts/check-egress-redaction.mjs:81|并在 `scripts/check-egress-redaction.mjs` 里登记|export const ALLOWED_EXTERNAL_EGRESS_FILES = Object.freeze(
CLAIM|19|一致|package.json:62|`npm run check:egress-redaction` 会运行该检查|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|20|一致|scripts/check-egress-redaction.mjs:224|`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|21|一致|packages/platform-node/src/strict-configuration.ts:1593|key 在配置 `runPolicy.voiceAddressee.secretRef` 里指定|secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
CLAIM|22|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:10|关联文档列出 docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md|# ADR 0103：Jarvis Test 前三条用两层评测：确定性层拦退步，真模型层每条跑 3 次、两层裁判记分
CLAIM|23|一致|docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md:10|关联文档列出 docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md|# ADR 0146：送给任何外部模型的文字，先统一遮盖敏感信息
CLAIM|24|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:11|关联文档列出 docs/adr/0230-perception-records-and-memories-inferred-from-perception.md|# ADR 0230：设备感知到的东西存成感知记录，不拼进对话；主人亲口说的才能直接成为记忆和提醒
CLAIM|25|一致|docs/product-vision.md:8|关联文档列出 docs/product-vision.md|# Himawari Agent — 产品愿景、核心原则与差异化

未核对的部分：外部网站和第三方产品的说法（Vercel、TypeSafe、Jev 的接口、价格、零保留实测等）、Andy 的原话与设计线程，以及“决定”“放弃的做法”“后果”里描述的本方案要新增的行为和评测做法。旧 4 字规则在基线 9a1c16589de8d8cb88c824dc77aab57d3ed66bd8 中没有 `clients/apple/Sources/HimawariCore/Listening/NameCall.swift`，因此改用本 PR 内仍含旧代码的提交 c1100c382e88e15a7ea097517eba560d1073caf4 核对。
