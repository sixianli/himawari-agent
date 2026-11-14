CLAIM|1|一致|clients/apple/scripts/listen-eval/README.md:3|iOS 第 8 批“让它听”|第 8 批“让它听”的四项评测：认人、口头指令、转文字、抢跑。认人和转文字都在 Mac 上用系统自带的本机转文字（SpeechAnalyzer）和 FluidAudio 声纹模型跑，不调对话模型，不花钱。
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/ListeningSession.swift:81|手机一直在听|        if case .listening = state { return true }
CLAIM|3|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:370|认出 Himawari 的名字就把这句话当成口头指令发给服务器|            await command(request, heard: heard, evidence: SpokenTrigger.evidence(for: context, speakerScore: score, heardName: heardName))
CLAIM|4|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|clients/apple 里 NameCall.match 现在不限制名字前面的字数|        for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|5|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|按位置猜意思也违反了“理解意思交给模型”（ADR 0249）|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。全面体检找出的一批判断仍靠词表猜意思：待确认规矩的引用是否真的在说同一件事、邮件里的订单号、评测题干有没有泄题。设计线程的整合方案（两个低价模型各出方案、互相审核、线程核对代码后整合）把它们拆成任务 T1 到 T6，Andy 同意，其中“每轮自动召回不加每轮模型调用”。本 ADR 记 T1 到 T4：共用的判断辅助、待确认规矩的确认裁判、邮件单号抽取、评测防泄露。分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。邮件“涉钱”规则（T7）见 [ADR 0248](0248-money-floor-follows-the-models-judgement.md)。
CLAIM|6|一致|packages/application/src/services/voice-command.ts:65|AirPods 三项核对|      if (evidence.inputRoute !== "airpods")
CLAIM|7|一致|packages/application/src/services/voice-command.ts:67|AirPods 三项核对|      if (evidence.inEar !== true) return { accepted: false, reason: "airpods_not_in_ear" };
CLAIM|8|一致|packages/application/src/services/voice-command.ts:68|AirPods 三项核对|      if (!passes(gates.airpodsNear, evidence.loudnessScore))
CLAIM|9|一致|packages/application/src/services/voice-command.ts:72|声音像不像主人|      return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|10|一致|packages/platform-node/src/voice-addressee-decision.ts:5|本项目经 Vercel AI Gateway（Vercel 的模型网关）调用它|export const VOICE_ADDRESSEE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
CLAIM|11|一致|packages/platform-node/src/strict-configuration.ts:1573-1593|key 在配置 runPolicy.voiceAddressee.secretRef 里指定|    secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
CLAIM|12|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|13|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 packages/application/src/services/voice-command.ts 的 decideVoiceCommand|export function decideVoiceCommand(
CLAIM|14|一致|packages/platform-node/src/device-api-routes.ts:942|POST /messages 在 packages/platform-node/src/device-api-routes.ts 里|      device.post("/messages", async (request, reply) => {
CLAIM|15|一致|packages/platform-node/src/device-api-routes.ts:976|POST /messages 在 packages/platform-node/src/device-api-routes.ts 里调用它|          const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|16|一致|packages/platform-node/src/device-api-routes.ts:978-980|不通过就回 409 VOICE_COMMAND_UNCONFIRMED|              error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
CLAIM|17|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数：packages/platform-node/src/perception-service.ts 里的 reserveModelCost(scope, amountMicros)|  async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|18|一致|packages/platform-node/src/perception-service.ts:229|用的是 perception.model_cost.daily 这项上限|      limit: this.#limit(settings, "perception.model_cost.daily"),
CLAIM|19|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|      if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|20|一致|scripts/check-egress-redaction.mjs:226|发往外部服务前必须遮敏感值，并在 scripts/check-egress-redaction.mjs 里登记|          `${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|21|一致|package.json:62|npm run check:egress-redaction 会拦下没登记、没遮的外部出口|    "check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|22|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:23|heardName，最多 64 个字符|    public static let heardNameMaximumCharacters = 64
CLAIM|23|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:31|按住说话（hands_on）不带名字|        self.heardName = trigger == .handsOn ? nil : heardName.map(Self.normalizedHeardName).flatMap { $0.isEmpty ? nil : $0 }
CLAIM|24|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（hands_on）不经判断|    if (request.trigger === "hands_on") return "addressed";
CLAIM|25|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:10|[SOURCE: docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md]|# ADR 0103：Jarvis Test 前三条用两层评测：确定性层拦退步，真模型层每条跑 3 次、两层裁判记分
CLAIM|26|一致|docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md:10|[SOURCE: docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md]|# ADR 0146：送给任何外部模型的文字，先统一遮盖敏感信息
CLAIM|27|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:11|[SOURCE: docs/adr/0230-perception-records-and-memories-inferred-from-perception.md]|# ADR 0230：设备感知到的东西存成感知记录，不拼进对话；主人亲口说的才能直接成为记忆和提醒
CLAIM|28|一致|docs/product-vision.md:8|[SOURCE: docs/product-vision.md]|# Himawari Agent — 产品愿景、核心原则与差异化

未核对的部分：Vercel、TypeSafe、openWakeWord 等外部网站与第三方产品的说法，以及方案里属于新增或修改而非现状的描述；仓库中没有需要到基线提交 a87954eeeb7361a67d3f5c50598d9232325caa69 里查的已删旧代码原句。
