CLAIM|1|一致|clients/apple/Sources/HimawariCore/Listening/ListeningSession.swift:81|手机一直在听|if case .listening = state { return true }
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:140|认出 Himawari 的名字就把这句话当成口头指令|return names.match(text).map { ($0.text, $0.name, $0.saysMoreThanTheName) }
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:120|发给服务器|let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
CLAIM|4|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|`clients/apple` 里 `NameCall.match` 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|5|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。|Andy 2026-10-28 14:12（日本时间）回复“了解，那就做我们现在能做的”，并在 14:40 审核方案（[方案网页](https://claude.ai/artifact/D8yqNywjecV3fEzMvRaN1y)），批准时提了五条修改：真模型层必须把“今天”固定住；#6 必须证明读到了文件结尾；裁判分两层并先校准；趋势至少两条用例下降才标红；拆成两个合并请求（PR）。他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|6|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`|export function decideVoiceCommand(
CLAIM|7|一致|packages/platform-node/src/device-api-routes.ts:942|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里|device.post("/messages", async (request, reply) => {
CLAIM|8|一致|packages/platform-node/src/device-api-routes.ts:976|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|9|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409|return options.sendJson(reply, 409, {
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:979|409 `VOICE_COMMAND_UNCONFIRMED`|error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
CLAIM|11|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数：`packages/platform-node/src/perception-service.ts` 里的 `reserveModelCost(scope, amountMicros)`|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|12|一致|packages/platform-node/src/perception-service.ts:226|用的是 `perception.model_cost.daily` 这项上限|key: "perception.model_cost.daily",
CLAIM|13|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|14|一致|scripts/check-egress-redaction.mjs:103|发往外部服务前必须遮敏感值|["packages/platform-node/src/voice-addressee-decision.ts", ["redactForExternalText"]],
CLAIM|15|一致|scripts/check-egress-redaction.mjs:217|并在 `scripts/check-egress-redaction.mjs` 里登记|if (ALLOWED_EXTERNAL_EGRESS_FILES.get(relative)?.includes(name)) {
CLAIM|16|一致|package.json:62|`npm run check:egress-redaction`|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|17|一致|scripts/check-egress-redaction.mjs:226|会拦下没登记、没遮的外部出口|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|18|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:115|手机把整句原话发给服务器|text: message.text,
CLAIM|19|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:117|手机把认出的名字发给服务器|voice: spoken.voice,
CLAIM|20|一致|packages/application/src/services/voice-command.ts:22|认出的名字（`heardName`，最多 64 个字符）|export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;
CLAIM|21|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:31|按住说话（`hands_on`）不带名字|self.heardName = trigger == .handsOn ? nil : heardName.map(Self.normalizedHeardName).flatMap { $0.isEmpty ? nil : $0 }
CLAIM|22|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（`hands_on`）也不经判断|if (request.trigger === "hands_on") return "addressed";
CLAIM|23|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:136|手机把两句用换行连起来当整句（“向日葵\n几点了”）|return ("\(calledName.text)\n\(trimmed)", calledName.name, !trimmed.isEmpty)
CLAIM|24|一致|packages/prompt-catalog/src/perception.ts:484|问法固定在提示词目录 `voice.addressee-question`|id: "voice.addressee-question",
CLAIM|25|一致|packages/platform-node/src/voice-addressee-decision.ts:67|输入是 `{assistantName, heardSentence}` 这个 JSON|assistantName: redactForExternalText(input.heardName, options).text,
CLAIM|26|一致|packages/platform-node/src/voice-addressee-decision.ts:58|问题是一道是非题|{ type: "predicate", name: QUESTION_NAME, instructions: VOICE_ADDRESSEE_QUESTION.text },
CLAIM|27|一致|packages/platform-node/src/device-api-routes.ts:981|这条调用不进任何对话，系统提示、工具和历史都不变|const addressed = options.addressee
CLAIM|28|一致|packages/application/src/services/voice-addressee.ts:22|“是”的概率不低于门槛（默认 0.7）|yesAtLeastPermille: 700,
CLAIM|29|一致|packages/application/src/services/voice-addressee.ts:23|不高于门槛（默认 0.3）|noAtMostPermille: 300,
CLAIM|30|一致|packages/application/src/services/voice-addressee.ts:85|不执行，409 `not_addressed`；手机不弹询问，回到收听|if (permille <= configuration.noAtMostPermille) return "not_addressed";
CLAIM|31|一致|packages/application/src/services/voice-addressee.ts:86|中间……不执行，409 `addressed_unsure`|return "addressed_unsure";
CLAIM|32|一致|packages/application/src/services/voice-addressee.ts:131|超时（默认 1.5 秒）、失败、回答的模型不是请求的那个……不执行，409 `addressed_unsure`|return outcome ?? "addressed_unsure";
CLAIM|33|一致|packages/application/src/services/voice-addressee.ts:101|手机没说认出了哪个名字、整句超过 1024 个字符：不执行，409 `addressed_unsure`|if (request.heardName === null || [...request.text].length > configuration.maximumCharacters)
CLAIM|34|一致|packages/application/src/services/voice-addressee.ts:24|超时（默认 1.5 秒）|timeoutMs: 1500,
CLAIM|35|一致|packages/application/src/services/voice-addressee.ts:26|整句超过 1024 个字符|maximumCharacters: 1024,
CLAIM|36|一致|packages/application/src/services/voice-addressee.ts:141|感知每日模型费用到上限：不调用 Jev，409 `addressed_budget`|return "addressed_budget";
CLAIM|37|一致|packages/platform-node/src/voice-addressee-decision.ts:74|每次请求都带 `zeroDataRetention: true`|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|38|一致|packages/platform-node/src/voice-addressee-decision.ts:67|名字和整句都经 `redactForExternalText` 遮掉验证码一类的敏感值|assistantName: redactForExternalText(input.heardName, options).text,
CLAIM|39|一致|packages/application/src/services/voice-addressee.ts:91|判断结果……存在内存里|readonly #remembered = new Map<string, Map<string, Remembered>>();
CLAIM|40|一致|packages/application/src/services/voice-addressee.ts:105|判断结果按“设备 + 这句话的编号 + 触发方式 + 名字 + 去标点后的文字”|const key = JSON.stringify([
CLAIM|41|一致|packages/application/src/services/voice-addressee.ts:27|默认 10 分钟|cacheSeconds: 600,
CLAIM|42|一致|packages/application/src/services/voice-addressee.ts:28|每台设备 64 条|cacheEntriesPerDevice: 64,
CLAIM|43|一致|packages/application/src/services/voice-addressee.ts:112|正在判断时同一句又来，等同一个结果|if (known) return (await known.judged) ?? "addressed_unsure";
CLAIM|44|一致|packages/application/src/services/voice-addressee.ts:126|判断失败的不存，重试时再问|if (device.get(key)?.judged === judged) device.delete(key);
CLAIM|45|一致|packages/application/src/services/voice-addressee.ts:25|每台设备每分钟最多判断 20 次|perDevicePerMinute: 20,
CLAIM|46|一致|packages/platform-node/src/strict-configuration.ts:1576|`runPolicy.voiceAddressee` 写模型名、key 的引用、单价，以及两个门槛、超时、防刷次数、字数上限、缓存时长和条数|rejectUnknown(input, [...keys, "model", "secretRef", "inputMicrosPerMillionTokens"], field);
CLAIM|47|一致|apps/agent-service/src/production-http-composition.ts:1707|没有这一项时服务器不调用任何模型，所有认出名字的指令都按 `addressed_unsure` 先问主人，不会直接执行|if (!model || !configuration)
CLAIM|48|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:168|主人点“是”就按原有的确认路径以 `hands_on` 重发|voice: VoiceEvidence(trigger: .handsOn, speakerScore: pending.message.voice.speakerScore, inputRoute: pending.message.voice.inputRoute, inEar: pending.message.voice.inEar, loudnessScore: pending.message.voice.loudnessScore)
CLAIM|49|一致|clients/apple/Sources/HimawariCore/ListenEval/ListenEvalObservation.swift:134|手机评测记录里带上认出的名字|return ListenEvalCall(nameHeard: true, request: request, prepared: prepared, heardName: heardName)
CLAIM|50|一致|scripts/evals/listening-addressee-live.eval.ts:23|`scripts/evals/listening-addressee-live.eval.ts` 用生产同一个判断调用把每句问一遍|const decision = new VoiceAddresseeDecision({
CLAIM|51|一致|packages/platform-node/src/voice-addressee-decision.ts:86|先按字数估算费用|const characters =
CLAIM|52|一致|scripts/evals/listening-addressee-live.eval.ts:34|超过 `EVAL_CONFIRM_COST` 就一次都不发|if (estimate > CAP_USD * 1e6)
CLAIM|53|一致|scripts/evals/listening-score.mjs:345|`scripts/evals/listening-score.mjs --addressee` 只对通过认人门槛的句子|(observation) => CALL_PURPOSES.has(observation.clip.purpose) && executes(observation, gates),
CLAIM|54|一致|scripts/evals/listening-score.mjs:366|按不同门槛组合出表|for (const yes of ADDRESSEE_YES_LEVELS)

外部网站的内容（Vercel/TypeSafe 接口、价格、零保留条款和实测延迟费用）以及 openWakeWord 的目标未在仓库内核对；方案中纯属设计取舍、尚无对应代码的表述未按现状核对。
