CLAIM|1|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:370|认出 Himawari 的名字就把这句话当成口头指令发给服务器|            await command(request, heard: heard, evidence: SpokenTrigger.evidence(for: context, speakerScore: score, heardName: heardName))
CLAIM|2|找不到|-|最初的做法是只看名字前面最多 4 个字，来猜这句话是不是在叫它|-
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|`clients/apple` 里 `NameCall.match` 现在不限制名字前面的字数|        for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|4|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|按位置猜意思也违反了“理解意思交给模型”（ADR 0249）|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|5|一致|packages/platform-node/src/voice-addressee-decision.ts:5|本项目经 Vercel AI Gateway（Vercel 的模型网关）调用它|export const VOICE_ADDRESSEE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
CLAIM|6|一致|packages/platform-node/src/strict-configuration.ts:1593|key 在配置 `runPolicy.voiceAddressee.secretRef` 里指定|    secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
CLAIM|7|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|ADR 0103 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|Andy 2026-10-28 14:12（日本时间）回复“了解，那就做我们现在能做的”，并在 14:40 审核方案（[方案网页](https://claude.ai/artifact/D8yqNywjecV3fEzMvRaN1y)），批准时提了五条修改：真模型层必须把“今天”固定住；#6 必须证明读到了文件结尾；裁判分两层并先校准；趋势至少两条用例下降才标红；拆成两个合并请求（PR）。他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|8|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`|export function decideVoiceCommand(
CLAIM|9|一致|packages/platform-node/src/device-api-routes.ts:976|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它|          const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409 `VOICE_COMMAND_UNCONFIRMED`|            return options.sendJson(reply, 409, {
CLAIM|11|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数：`packages/platform-node/src/perception-service.ts` 里的 `reserveModelCost(scope, amountMicros)`|  async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|12|一致|packages/platform-node/src/perception-service.ts:226|用的是 `perception.model_cost.daily` 这项上限|      key: "perception.model_cost.daily",
CLAIM|13|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|      if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|14|一致|scripts/check-egress-redaction.mjs:102|发往外部服务前必须遮敏感值，并在 `scripts/check-egress-redaction.mjs` 里登记|    ["packages/platform-node/src/voice-addressee-decision.ts", ["redactForExternalText"]],
CLAIM|15|一致|scripts/check-egress-redaction.mjs:224|`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口|          `${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|16|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:140|手机把整句原话和认出的名字一起发给服务器|        return names.match(text).map { ($0.text, $0.name, $0.saysMoreThanTheName) }
CLAIM|17|一致|packages/application/src/services/voice-command.ts:22|`heardName`，最多 64 个字符|export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;
CLAIM|18|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:31|按住说话（`hands_on`）不带名字|        self.heardName = trigger == .handsOn ? nil : heardName.map { String($0.prefix(Self.heardNameMaximumCharacters)) }.flatMap { $0.isEmpty ? nil : $0 }
CLAIM|19|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（`hands_on`）不经判断|    if (request.trigger === "hands_on") return "addressed";
CLAIM|20|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:136|只喊名字、几秒内再说要求时，手机把两句用换行连起来当整句|                return ("\(calledName.text)\n\(trimmed)", calledName.name, !trimmed.isEmpty)
CLAIM|21|一致|packages/prompt-catalog/src/perception.ts:484|问法固定在提示词目录 `voice.addressee-question`|  id: "voice.addressee-question",
CLAIM|22|一致|test/integration/device-voice-command.test.ts:205|输入是 `{assistantName, heardSentence}` 这个 JSON|                    assistantName: "Himawari",
CLAIM|23|一致|test/integration/device-voice-command.test.ts:206|输入是 `{assistantName, heardSentence}` 这个 JSON|                    heardSentence: "Himawari，帮我把明天的会改到下午",
CLAIM|24|一致|packages/platform-node/src/voice-addressee-decision.ts:58|问题是一道是非题|      { type: "predicate", name: QUESTION_NAME, instructions: VOICE_ADDRESSEE_QUESTION.text },
CLAIM|25|一致|test/integration/device-voice-command.test.ts:186|不放时间，不放前一句|  it("carries out a call to Himawari, wherever the name sits, and sends the model nothing else", async () => {
CLAIM|26|一致|packages/application/src/services/voice-addressee.ts:22|“是”的概率不低于门槛（默认 0.7）|  yesAtLeastPermille: 700,
CLAIM|27|一致|packages/application/src/services/voice-addressee.ts:84|“是”的概率不低于门槛时提交对话|  if (permille >= configuration.yesAtLeastPermille) return "addressed";
CLAIM|28|一致|packages/application/src/services/voice-addressee.ts:23|不高于门槛（默认 0.3）|  noAtMostPermille: 300,
CLAIM|29|一致|packages/application/src/services/voice-addressee.ts:85|不高于门槛时不执行，409 `not_addressed`|  if (permille <= configuration.noAtMostPermille) return "not_addressed";
CLAIM|30|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:74|手机不弹询问，回到收听|    public var asksOwner: Bool { self != .notAddressed }
CLAIM|31|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:366|这句照常作为感知记录|            await upload(heard)
CLAIM|32|一致|packages/application/src/services/voice-addressee.ts:86|中间结果不执行，409 `addressed_unsure`|  return "addressed_unsure";
CLAIM|33|一致|packages/application/src/services/voice-addressee.ts:24|超时（默认 1.5 秒）|  timeoutMs: 1500,
CLAIM|34|一致|packages/application/src/services/voice-addressee.ts:131|超时、失败时不执行，409 `addressed_unsure`|      return outcome ?? "addressed_unsure";
CLAIM|35|一致|packages/platform-node/src/voice-addressee-decision.ts:32|回答的模型不是请求的那个时不执行，409 `addressed_unsure`|    throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_MODEL_MISMATCH");
CLAIM|36|一致|packages/application/src/services/voice-addressee.ts:102|手机没说认出了哪个名字时不执行，409 `addressed_unsure`|      return "addressed_unsure";
CLAIM|37|一致|packages/application/src/services/voice-addressee.ts:26|整句超过 1024 个字符时不执行，409 `addressed_unsure`|  maximumCharacters: 1024,
CLAIM|38|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:168|主人点“是”就按原有的确认路径以 `hands_on` 重发|            voice: VoiceEvidence(trigger: .handsOn, speakerScore: pending.message.voice.speakerScore, inputRoute: pending.message.voice.inputRoute, inEar: pending.message.voice.inEar, loudnessScore: pending.message.voice.loudnessScore)
CLAIM|39|一致|packages/application/src/services/voice-addressee.ts:141|感知每日模型费用到上限时不调用 Jev，409 `addressed_budget`|      return "addressed_budget";
CLAIM|40|一致|packages/platform-node/src/voice-addressee-decision.ts:74|每次请求都带 `zeroDataRetention: true`|    providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|41|一致|packages/platform-node/src/voice-addressee-decision.ts:67|发出前，名字和整句都经 `redactForExternalText` 遮掉验证码一类的敏感值|              assistantName: redactForExternalText(input.heardName, options).text,
CLAIM|42|一致|packages/application/src/services/voice-addressee.ts:91|判断结果存在内存里，不写数据库|  readonly #remembered = new Map<string, Map<string, Remembered>>();
CLAIM|43|一致|packages/application/src/services/voice-addressee.ts:105|判断结果按“设备 + 这句话的编号 + 触发方式 + 名字 + 去标点后的文字”存放|    const key = JSON.stringify([
CLAIM|44|一致|packages/application/src/services/voice-addressee.ts:27|缓存默认 10 分钟|  cacheSeconds: 600,
CLAIM|45|一致|packages/application/src/services/voice-addressee.ts:28|每台设备缓存 64 条|  cacheEntriesPerDevice: 64,
CLAIM|46|一致|packages/application/src/services/voice-addressee.ts:112|正在判断时同一句又来，等同一个结果|    if (known) return (await known.judged) ?? "addressed_unsure";
CLAIM|47|一致|packages/application/src/services/voice-addressee.ts:126|判断失败的不存，重试时再问|      if (device.get(key)?.judged === judged) device.delete(key);
CLAIM|48|一致|packages/application/src/services/voice-addressee.ts:25|每台设备每分钟最多判断 20 次|  perDevicePerMinute: 20,
CLAIM|49|一致|packages/application/src/services/voice-addressee.ts:113|超过每分钟次数按 `addressed_unsure` 处理|    if (!this.#admit(request.deviceId, at, configuration)) return "addressed_unsure";
CLAIM|50|一致|apps/agent-service/src/production-http-composition.ts:1718|费用算进感知每日模型费用上限|        reserve: (micros) => perception.reserveModelCost(scope, micros),
CLAIM|51|一致|packages/application/src/services/voice-addressee.ts:140|判断前按字数预留费用|    if (!(await this.#options.reserve(this.#options.model.estimateMicros(input))))
CLAIM|52|一致|packages/platform-node/src/voice-addressee-decision.ts:90|字数当 token 数，偏保守|    return Math.ceil((characters * this.#options.inputMicrosPerMillionTokens) / 1_000_000);
CLAIM|53|一致|packages/platform-node/src/perception-service.ts:226|不新增用量记录用途|      key: "perception.model_cost.daily",
CLAIM|54|找不到|-|不改表|-
CLAIM|55|一致|packages/platform-node/src/strict-configuration.ts:1576|`runPolicy.voiceAddressee` 写模型名、key 的引用、单价，以及两个门槛、超时、防刷次数、字数上限、缓存时长和条数|  rejectUnknown(input, [...keys, "model", "secretRef", "inputMicrosPerMillionTokens"], field);
CLAIM|56|一致|apps/agent-service/src/production-http-composition.ts:1709|没有这一项时服务器不调用任何模型，所有认出名字的指令都按 `addressed_unsure` 先问主人，不会直接执行|      request.trigger === "hands_on" ? "addressed" : "addressed_unsure";
CLAIM|57|一致|clients/apple/Sources/HimawariCore/ListenEval/ListenEvalObservation.swift:134|手机评测记录里带上认出的名字|                return ListenEvalCall(nameHeard: true, request: request, prepared: prepared, heardName: heardName)
CLAIM|58|一致|scripts/evals/listening-addressee-live.eval.ts:23|`scripts/evals/listening-addressee-live.eval.ts` 用生产同一个判断调用把每句问一遍|    const decision = new VoiceAddresseeDecision({
CLAIM|59|一致|scripts/evals/listening-addressee-live.eval.ts:34|先按字数估算费用，超过 `EVAL_CONFIRM_COST` 就一次都不发|    if (estimate > CAP_USD * 1e6)
CLAIM|60|一致|scripts/evals/listening-score.mjs:345|`scripts/evals/listening-score.mjs --addressee` 只对通过认人门槛的句子按不同门槛组合出表|    (observation) => CALL_PURPOSES.has(observation.clip.purpose) && executes(observation, gates),
CLAIM|61|找不到|-|只看名字前面最多 4 个字|-

未核对的部分：Vercel/TypeSafe 外部文档、价格、零保留说明与实测数字，以及 Andy 的聊天原话，均不在仓库内，无法离线核实。旧“4 字规则”在给定基线 9a1c165 中不存在（该基线还没有 Listening 目录），因此两处旧做法按基线判为找不到。
