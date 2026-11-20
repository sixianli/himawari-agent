CLAIM|1|一致|clients/apple/Sources/HimawariCore/Listening/ListeningSession.swift:23|iOS 第 8 批“让它听”：手机一直在听|case listening(since: Date, mode: ListeningMode, downgrade: ListeningDowngradeReason?)
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:120|认出 Himawari 的名字就把这句话当成口头指令发给服务器|return .command(request: request.text, heard: heard, touched: start == .ownerTouched, heardName: request.name)
CLAIM|3|找不到|-|最初的做法是只看名字前面最多 4 个字|-
CLAIM|4|找不到|-|名字在句尾时（“把会改到下午三点，Himawari”）会漏掉|-
CLAIM|5|找不到|-|只是提到它的话（“我跟你说，Himawari 昨天帮我订了会议室”）又会被当成在叫它、直接执行|-
CLAIM|6|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|`NameCall.match` 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|7|一致|packages/platform-node/src/strict-configuration.ts:1530|key 在配置 `runPolicy.voiceAddressee.secretRef` 里指定|secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
CLAIM|8|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|来源：[ADR 0103](0103-jarvis-test-live-evaluation-and-two-tier-judge.md) 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|9|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`|export function decideVoiceCommand(
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:969|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|11|一致|packages/platform-node/src/device-api-routes.ts:972|不通过就回 409 `VOICE_COMMAND_UNCONFIRMED`|error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
CLAIM|12|不一致|packages/platform-node/src/perception-service.ts:218|感知每日模型费用上限已有现成的预留函数：`packages/platform-node/src/perception-service.ts` 第 216 行 `reserveModelCost(scope, amountMicros)`|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|13|一致|packages/platform-node/src/perception-service.ts:222|用的是 `perception.model_cost.daily` 这项上限|key: "perception.model_cost.daily",
CLAIM|14|一致|apps/agent-service/src/production-http-composition.ts:1668|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|15|一致|scripts/check-egress-redaction.mjs:103|发往外部服务前必须遮敏感值，并在 `scripts/check-egress-redaction.mjs` 里登记|["packages/platform-node/src/voice-addressee-decision.ts", ["redactForExternalText"]],
CLAIM|16|一致|package.json:62|`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|17|一致|packages/application/src/services/voice-command.ts:22|手机把整句原话和认出的名字（`heardName`，最多 64 个字符）发给服务器|export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;
CLAIM|18|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:31|按住说话（`hands_on`）不带名字|self.heardName = trigger == .handsOn ? nil : heardName.map { String($0.prefix(Self.heardNameMaximumCharacters)) }.flatMap { $0.isEmpty ? nil : $0 }
CLAIM|19|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（`hands_on`）不带名字，也不经判断|if (request.trigger === "hands_on") return "addressed";
CLAIM|20|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:136|手机把两句用换行连起来当整句（“向日葵\n几点了”）|return ("\(calledName.text)\n\(trimmed)", calledName.name, !trimmed.isEmpty)
CLAIM|21|一致|packages/prompt-catalog/src/perception.ts:484|问法固定在提示词目录 `voice.addressee-question`|id: "voice.addressee-question",
CLAIM|22|一致|packages/platform-node/src/voice-addressee-decision.ts:64|输入是 `{assistantName, heardSentence}` 这个 JSON|assistantName: redactForExternalText(input.heardName, options).text,
CLAIM|23|一致|packages/platform-node/src/voice-addressee-decision.ts:65|输入是 `{assistantName, heardSentence}` 这个 JSON|heardSentence: redactForExternalText(input.text, options).text,
CLAIM|24|一致|packages/platform-node/src/voice-addressee-decision.ts:63|不放时间，不放前一句|data: {\n              assistantName: redactForExternalText(input.heardName, options).text,\n              heardSentence: redactForExternalText(input.text, options).text,\n            },
CLAIM|25|一致|packages/application/src/services/voice-addressee.ts:4|不执行，409 `not_addressed`|"not_addressed",
CLAIM|26|一致|packages/application/src/services/voice-addressee.ts:5|不执行，409 `addressed_unsure`|"addressed_unsure",
CLAIM|27|一致|packages/application/src/services/voice-addressee.ts:6|409 `addressed_budget`|"addressed_budget",
CLAIM|28|一致|packages/application/src/services/voice-addressee.ts:22|“是”的概率不低于门槛（默认 0.7）|yesAtLeastPermille: 700,
CLAIM|29|一致|packages/application/src/services/voice-addressee.ts:23|不高于门槛（默认 0.3）|noAtMostPermille: 300,
CLAIM|30|一致|packages/application/src/services/voice-addressee.ts:84|“是”的概率不低于门槛（默认 0.7）：提交对话|if (permille >= configuration.yesAtLeastPermille) return "addressed";
CLAIM|31|一致|packages/application/src/services/voice-addressee.ts:85|不高于门槛（默认 0.3）：不执行，409 `not_addressed`|if (permille <= configuration.noAtMostPermille) return "not_addressed";
CLAIM|32|一致|packages/application/src/services/voice-addressee.ts:24|超时（默认 1.5 秒）|timeoutMs: 1500,
CLAIM|33|一致|packages/application/src/services/voice-addressee.ts:101|整句超过 1024 个字符：不执行，409 `addressed_unsure`|if (request.heardName === null || [...request.text].length > configuration.maximumCharacters)
CLAIM|34|一致|packages/application/src/services/voice-addressee.ts:101|手机没说认出了哪个名字：不执行，409 `addressed_unsure`|if (request.heardName === null || [...request.text].length > configuration.maximumCharacters)
CLAIM|35|一致|packages/application/src/services/voice-addressee.ts:27|默认 10 分钟|cacheSeconds: 600,
CLAIM|36|一致|packages/application/src/services/voice-addressee.ts:28|每台设备 64 条|cacheEntriesPerDevice: 64,
CLAIM|37|一致|packages/application/src/services/voice-addressee.ts:105|判断结果按“设备 + 这句话的编号 + 触发方式 + 名字 + 去标点后的文字”存在内存里|const key = JSON.stringify([\n      request.utteranceId,\n      request.trigger,\n      request.heardName,\n      sameWords(request.text),\n    ]);
CLAIM|38|一致|packages/application/src/services/voice-addressee.ts:112|正在判断时同一句又来，等同一个结果|if (known) return (await known.judged) ?? "addressed_unsure";
CLAIM|39|一致|packages/application/src/services/voice-addressee.ts:126|判断失败的不存，重试时再问|if (device.get(key)?.judged === judged) device.delete(key);
CLAIM|40|一致|packages/application/src/services/voice-addressee.ts:25|每台设备每分钟最多判断 20 次|perDevicePerMinute: 20,
CLAIM|41|一致|packages/application/src/services/voice-addressee.ts:113|超了按 `addressed_unsure` 处理|if (!this.#admit(request.deviceId, at, configuration)) return "addressed_unsure";
CLAIM|42|一致|packages/platform-node/src/voice-addressee-decision.ts:74|每次请求都带 `zeroDataRetention: true`|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|43|一致|packages/platform-node/src/voice-addressee-decision.ts:64|发出前，名字和整句都经 `redactForExternalText` 遮掉验证码一类的敏感值|assistantName: redactForExternalText(input.heardName, options).text,\n              heardSentence: redactForExternalText(input.text, options).text,
CLAIM|44|一致|packages/application/src/services/voice-addressee.ts:115|感知每日模型费用到上限：不调用 Jev，409 `addressed_budget`|if (!(await this.#options.reserve(this.#options.model.estimateMicros(input))))\n      return "addressed_budget";
CLAIM|45|一致|packages/platform-node/src/strict-configuration.ts:1513|`runPolicy.voiceAddressee` 写模型名、key 的引用、单价，以及两个门槛、超时、防刷次数、字数上限、缓存时长和条数|rejectUnknown(input, [...keys, "model", "secretRef", "inputMicrosPerMillionTokens"], field);
CLAIM|46|一致|apps/agent-service/src/production-http-composition.ts:1642|没有这一项时服务器不调用任何模型，所有认出名字的指令都按 `addressed_unsure` 先问主人，不会直接执行|request.trigger === "hands_on" ? "addressed" : "addressed_unsure";
CLAIM|47|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:74|手机不弹询问|public var asksOwner: Bool { self != .notAddressed }
CLAIM|48|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:457|手机不弹询问，回到收听|case let .askFirst(reason) where !reason.asksOwner:\n                returnToListening()
CLAIM|49|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:168|主人点“是”就按原有的确认路径以 `hands_on` 重发|voice: VoiceEvidence(trigger: .handsOn, speakerScore: pending.message.voice.speakerScore, inputRoute: pending.message.voice.inputRoute, inEar: pending.message.voice.inEar, loudnessScore: pending.message.voice.loudnessScore)
CLAIM|50|一致|clients/apple/Sources/HimawariCore/ListenEval/ListenEvalObservation.swift:79|手机评测记录里带上认出的名字|public let heardName: String?
CLAIM|51|一致|scripts/evals/listening-addressee-live.eval.ts:23|`scripts/evals/listening-addressee-live.eval.ts` 用生产同一个判断调用把每句问一遍|const decision = new VoiceAddresseeDecision({
CLAIM|52|一致|scripts/evals/listening-addressee-live.eval.ts:34|先按字数估算费用，超过 `EVAL_CONFIRM_COST` 就一次都不发|if (estimate > CAP_USD * 1e6)
CLAIM|53|一致|scripts/evals/listening-score.mjs:525|`scripts/evals/listening-score.mjs --addressee`|const addressee = args.get("--addressee");
CLAIM|54|一致|scripts/evals/listening-score.mjs:345|只对通过认人门槛的句子|(observation) => CALL_PURPOSES.has(observation.clip.purpose) && executes(observation, gates),
CLAIM|55|一致|scripts/evals/listening-score.mjs:366|按不同门槛组合出表|for (const yes of ADDRESSEE_YES_LEVELS)\n    for (const no of ADDRESSEE_NO_LEVELS) {
CLAIM|56|找不到|-|只看名字前面最多 4 个字|-

没能核对的部分：基线提交 f6997c3b0bcb40946f6d69f7ad101b62263ae595 里没有 `clients/apple/Sources/HimawariCore/Listening` 目录，旧的最多 4 个字实现及其两个后果无法在基线中找到；方案里关于 Vercel、TypeSafe 等外部服务的说法不属于仓库现状，未核对。
