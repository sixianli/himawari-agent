CLAIM|1|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:348|手机一直在听|guard case let .listening(_, mode, _) = session.state else { return }
CLAIM|2|一致|clients/apple/Sources/HimawariListen/ListeningController.swift:370|认出 Himawari 的名字就把这句话当成口头指令发给服务器|await command(request, heard: heard, evidence: SpokenTrigger.evidence(for: context, speakerScore: score, heardName: heardName))
CLAIM|3|一致|clients/apple/Sources/HimawariCore/Listening/NameCall.swift:30|clients/apple 里 NameCall.match 现在不限制名字前面的字数|for (index, name) in names.enumerated() where folded.contains(name) {
CLAIM|4|一致|packages/application/src/services/voice-command.ts:65|原有的证据门槛（AirPods 三项核对）|if (evidence.inputRoute !== "airpods")
CLAIM|5|一致|packages/application/src/services/voice-command.ts:72|原有的证据门槛（声音像不像主人）|return passes(gates.ambientCommand, evidence.speakerScore)
CLAIM|6|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|按位置猜意思也违反了“理解意思交给模型”（ADR 0249）|理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|7|一致|packages/platform-node/src/voice-addressee-decision.ts:5|本项目经 Vercel AI Gateway（Vercel 的模型网关）调用它|export const VOICE_ADDRESSEE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
CLAIM|8|一致|packages/platform-node/src/strict-configuration.ts:1593|key 在配置 runPolicy.voiceAddressee.secretRef 里指定|secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
CLAIM|9|找不到|-|Andy 同意它和生产算记忆向量用的是同一把 key|-
CLAIM|10|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。来源：ADR 0103 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。
CLAIM|11|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 packages/application/src/services/voice-command.ts 的 decideVoiceCommand|export function decideVoiceCommand(
CLAIM|12|一致|packages/platform-node/src/device-api-routes.ts:942|POST /messages|device.post("/messages", async (request, reply) => {
CLAIM|13|一致|packages/platform-node/src/device-api-routes.ts:976|在 packages/platform-node/src/device-api-routes.ts 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|14|一致|packages/platform-node/src/device-api-routes.ts:978|不通过就回 409|return options.sendJson(reply, 409, {
CLAIM|15|一致|packages/platform-node/src/device-api-routes.ts:161|返回 VOICE_COMMAND_UNCONFIRMED|export const VOICE_COMMAND_UNCONFIRMED_CODE = "VOICE_COMMAND_UNCONFIRMED" as const;
CLAIM|16|一致|packages/platform-node/src/perception-service.ts:222|感知每日模型费用上限已有现成的预留函数：packages/platform-node/src/perception-service.ts 里的 reserveModelCost(scope, amountMicros)|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|17|一致|packages/platform-node/src/perception-service.ts:226|用的是 perception.model_cost.daily 这项上限|key: "perception.model_cost.daily",
CLAIM|18|一致|apps/agent-service/src/production-http-composition.ts:1735|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|19|一致|scripts/check-egress-redaction.mjs:226|发往外部服务前必须遮敏感值，并在 scripts/check-egress-redaction.mjs 里登记|`${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
CLAIM|20|一致|package.json:62|npm run check:egress-redaction 会拦下没登记、没遮的外部出口|"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs",
CLAIM|21|一致|packages/application/src/services/voice-command.ts:22|heardName，最多 64 个字符|export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;
CLAIM|22|一致|packages/platform-node/src/device-api-routes.ts:175|按住说话（hands_on）不带名字|if (heardName !== undefined && (trigger === "hands_on" || !isHeardName(heardName))) return null;
CLAIM|23|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（hands_on）也不经判断|if (request.trigger === "hands_on") return "addressed";

决定、后果、业界做法和前提 5–7 中属于方案新增或外部资料的说法（提示词、零保留、缓存、防刷、费用、评测脚本、接口与定价等）未作为现状核对；生产配置不在仓库，无法核实 key 与记忆向量共用，基线 a87954e 也没有找到“最初按位置猜”的旧 NameCall 文件。
