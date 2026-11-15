CLAIM|1|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:96|手机一直在听|public var isListening: Bool {
CLAIM|2|一致|clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:120|认出 Himawari 的名字就把这句话当成口头指令|return .command(request: request.text, heard: heard, touched: start == .ownerTouched, heardName: request.name)
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:120|发给服务器|let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
CLAIM|4|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|`clients/apple` 里 `NameCall.match` 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|5|一致|packages/application/src/services/voice-command.ts:65|原有的证据门槛（AirPods 三项核对|if (evidence.inputRoute !== "airpods")
CLAIM|6|一致|packages/application/src/services/voice-command.ts:72|声音像不像主人|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|7|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`|export function decideVoiceCommand(
CLAIM|8|一致|packages/platform-node/src/device-api-routes.ts:976|`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|9|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409|return options.sendJson(reply, 409, {
CLAIM|10|一致|packages/platform-node/src/device-api-routes.ts:161|`VOICE_COMMAND_UNCONFIRMED`|export const VOICE_COMMAND_UNCONFIRMED_CODE = "VOICE_COMMAND_UNCONFIRMED" as const;
CLAIM|11|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数：`packages/platform-node/src/perception-service.ts` 里的 `reserveModelCost(scope, amountMicros)`|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|12|一致|packages/platform-node/src/perception-service.ts:226|用的是 `perception.model_cost.daily` 这项上限|key: "perception.model_cost.daily",
CLAIM|13|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|14|一致|scripts/check-egress-redaction.mjs:221|发往外部服务前必须遮敏感值|`${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`
CLAIM|15|一致|scripts/check-egress-redaction.mjs:226|并在 `scripts/check-egress-redaction.mjs` 里登记|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`
CLAIM|16|一致|package.json:62|`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|17|一致|packages/application/src/ports/configuration.ts:433|key 在配置 `runPolicy.voiceAddressee.secretRef` 里指定|readonly secretRef: string;
CLAIM|18|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。来源：ADR 0103 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”

未核实：决定部分属于方案拟新增或修改的行为，未作为现状逐条核对；Vercel、TypeSafe、openWakeWord 等外部网站和第三方产品资料未读；旧做法的历史实现在基线提交中没有找到可引用的原文。
