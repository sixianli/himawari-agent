CLAIM|1|一致|clients/apple/Sources/HimawariCore/Listening/ListeningSession.swift:91|iOS 第 8 批“让它听”：手机一直在听|state = .listening(since: at, mode: .full, downgrade: nil)
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:120|认出 Himawari 的名字就把这句话当成口头指令|return .command(request: request.text, heard: heard, touched: start == .ownerTouched, heardName: request.name)
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:120|把这句话当成口头指令发给服务器|let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
CLAIM|4|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:23@484bd83aff402449ef791a10e665b79297a2fe9c|最初的做法是只看名字前面最多 4 个字，来猜这句话是不是在叫它|guard before.count <= Self.leadingAllowance else { continue }；static let leadingAllowance = 4
CLAIM|5|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|clients/apple 里 NameCall.match 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|6|一致|packages/platform-node/src/strict-configuration.ts:1576|key 在配置 runPolicy.voiceAddressee.secretRef 里指定|rejectUnknown(input, [...keys, "model", "secretRef", "inputMicrosPerMillionTokens"], field);
CLAIM|7|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据|Andy 2026-10-28 14:12（日本时间）回复
CLAIM|8|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|来源是 ADR 0103 第 38 行，原话是 Jev 只许判合成评测数据，不许用于判 Himawari 的真实个人数据|Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。
CLAIM|9|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 packages/application/src/services/voice-command.ts 的 decideVoiceCommand|export function decideVoiceCommand(
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:942|POST /messages 在 packages/platform-node/src/device-api-routes.ts 里|device.post("/messages", async (request, reply) => {
CLAIM|11|一致|packages/platform-node/src/device-api-routes.ts:976|device-api-routes.ts 里调用 decideVoiceCommand|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|12|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409|return options.sendJson(reply, 409, {
CLAIM|13|一致|packages/platform-node/src/device-api-routes.ts:979|错误码是 VOICE_COMMAND_UNCONFIRMED|error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
CLAIM|14|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数 reserveModelCost(scope, amountMicros)|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|15|一致|packages/platform-node/src/perception-service.ts:226|用的是 perception.model_cost.daily 这项上限|key: "perception.model_cost.daily",
CLAIM|16|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|17|一致|scripts/check-egress-redaction.mjs:226|发往外部服务前必须遮敏感值，并在 scripts/check-egress-redaction.mjs 里登记|出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs
CLAIM|18|一致|package.json:62|npm run check:egress-redaction 会拦下没登记、没遮的外部出口|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|19|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|按位置猜意思也违反了“理解意思交给模型”（ADR 0249）|理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|20|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:23@484bd83aff402449ef791a10e665b79297a2fe9c|只看名字前面最多 4 个字|guard before.count <= Self.leadingAllowance else { continue }；static let leadingAllowance = 4

未核对：Vercel、TypeSafe、openWakeWord 等外部资料、价格与实测延迟，以及评测脚本的实际运行结果。旧的四字规则在基线 d5ef899 中没有对应文件，证据取自本 PR 引入它的提交 484bd83af。
