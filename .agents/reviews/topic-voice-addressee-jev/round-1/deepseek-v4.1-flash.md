CLAIM|1|一致|packages/prompt-catalog/prompt-manifest.json:1157|iOS 第 8 批“让它听”|“reason”: “第 8 批：手机认出名字的口头指令，提交前问判断模型是不是在叫 Himawari”
CLAIM|2|找不到|-|手机一直在听，听到 Himawari 的名字就把这句话当成口头指令发给服务器|未找到 iPhone 端实现
CLAIM|3|找不到|-|原先手机用“名字前面最多 4 个字”来猜这句话是不是在叫它|未找到
CLAIM|4|找不到|-|名字在句尾时会漏掉|未找到
CLAIM|5|找不到|-|只是提到它的话（“我跟你说，Himawari 昨天帮我订了会议室”）又会被当成在叫它、直接执行|未找到
CLAIM|6|找不到|-|按位置猜意思也违反了“理解意思交给模型”|未找到
CLAIM|7|一致|packages/platform-node/src/voice-addressee-decision.ts:5|本项目经 Vercel AI Gateway 调用它|export const VOICE_ADDRESSEE_GATEWAY_BASE_URL = “https://ai-gateway.vercel.sh/v1”;
CLAIM|8|一致|packages/memory-engine/src/embedding.ts:19|生产已经用 Vercel AI Gateway 算记忆向量|export const AI_GATEWAY_BASE_URL = “https://ai-gateway.vercel.sh/v1” as const;
CLAIM|9|找不到|-|生产已经用它的同一把 key 算记忆向量|未找到生产 voiceAddressee 与 embedding 使用同一个 secretRef 的配置
CLAIM|10|一致|docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:38|2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。来源：ADR 0103 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”|他同时定了一条红线，原话：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”
CLAIM|11|一致|packages/application/src/services/voice-command.ts:57|原有的证据门槛在 packages/application/src/services/voice-command.ts 的 decideVoiceCommand|export function decideVoiceCommand(
CLAIM|12|一致|packages/platform-node/src/device-api-routes.ts:897|POST /messages 在 packages/platform-node/src/device-api-routes.ts 里调用它|const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
CLAIM|13|一致|packages/platform-node/src/device-api-routes.ts:900|不通过就回 409 VOICE_COMMAND_UNCONFIRMED|error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
CLAIM|14|一致|packages/platform-node/src/perception-service.ts:216|感知每日模型费用上限已有现成的预留函数：packages/platform-node/src/perception-service.ts 第 216 行 reserveModelCost(scope, amountMicros)|async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
CLAIM|15|一致|packages/platform-node/src/perception-service.ts:220|用的是 perception.model_cost.daily 这项上限|key: “perception.model_cost.daily”,
CLAIM|16|一致|apps/agent-service/src/production-http-composition.ts:1459|说半句时的抢跑也用它|if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
CLAIM|17|一致|scripts/check-egress-redaction.mjs:214|发往外部服务前必须遮敏感值，并在 scripts/check-egress-redaction.mjs 里登记|`${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
CLAIM|18|一致|package.json:56|npm run check:egress-redaction 会拦下没登记、没遮的外部出口|“check:egress-redaction”: “node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs”,
CLAIM|19|一致|packages/application/src/services/voice-command.ts:22|手机把整句原话和认出的名字（heardName，最多 64 个字符）发给服务器|export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;
CLAIM|20|一致|packages/platform-node/src/device-api-routes.ts:148|按住说话（hands_on）不带名字|if (heardName !== undefined && (trigger === “hands_on” || !isHeardName(heardName))) return null;
CLAIM|21|一致|packages/application/src/services/voice-addressee.ts:99|按住说话（hands_on）也不经判断|if (request.trigger === “hands_on”) return “addressed”;
CLAIM|22|找不到|-|只喊名字、几秒内再说要求时（先说“向日葵”，停一下再说“几点了”），手机把两句用换行连起来当整句|未找到 iPhone 端实现
CLAIM|23|一致|packages/prompt-catalog/src/perception.ts:503|问法固定在提示词目录 voice.addressee-question|id: “voice.addressee-question”,
CLAIM|24|一致|packages/platform-node/src/voice-addressee-decision.ts:65|输入是 {assistantName, heardSentence} 这个 JSON|heardSentence: redactForExternalText(input.text, options).text,
CLAIM|25|一致|packages/platform-node/src/voice-addressee-decision.ts:72|问题是一道是非题|{ type: “predicate”, name: QUESTION_NAME, instructions: VOICE_ADDRESSEE_QUESTION.text },
CLAIM|26|一致|packages/platform-node/src/voice-addressee-decision.ts:65|不放时间，不放前一句|heardSentence: redactForExternalText(input.text, options).text,
CLAIM|27|一致|packages/application/src/services/voice-addressee.ts:22|“是”的概率不低于门槛（默认 0.7）|yesAtLeastPermille: 700,
CLAIM|28|一致|packages/application/src/services/voice-addressee.ts:23|不高于门槛（默认 0.3）|noAtMostPermille: 300,
CLAIM|29|一致|packages/application/src/services/voice-addressee.ts:84|不低于门槛：提交对话|if (permille >= configuration.yesAtLeastPermille) return “addressed”;
CLAIM|30|一致|packages/application/src/services/voice-addressee.ts:85|不高于门槛：不执行，409 not_addressed|if (permille <= configuration.noAtMostPermille) return “not_addressed”;
CLAIM|31|一致|packages/application/src/services/voice-addressee.ts:24|超时（默认 1.5 秒）|timeoutMs: 1500,
CLAIM|32|一致|packages/application/src/services/voice-addressee.ts:86|中间：不执行，409 addressed_unsure|return “addressed_unsure”;
CLAIM|33|一致|packages/application/src/services/voice-addressee.ts:127|失败：不执行，409 addressed_unsure|return “addressed_unsure”;
CLAIM|34|一致|packages/platform-node/src/voice-addressee-decision.ts:32|回答的模型不是请求的那个：不执行|throw new VoiceAddresseeDecisionFailure(“VOICE_ADDRESSEE_MODEL_MISMATCH”);
CLAIM|35|一致|packages/application/src/services/voice-addressee.ts:101|手机没说认出了哪个名字、整句超过 1024 个字符：不执行，409 addressed_unsure|if (request.heardName === null || [...request.text].length > configuration.maximumCharacters)
CLAIM|36|一致|packages/application/src/services/voice-addressee.ts:26|整句超过 1024 个字符|maximumCharacters: 1024,
CLAIM|37|一致|packages/application/src/services/voice-addressee.ts:116|感知每日模型费用到上限：不调用 Jev，409 addressed_budget|return “addressed_budget”;
CLAIM|38|一致|packages/platform-node/src/voice-addressee-decision.ts:74|每次请求都带 zeroDataRetention: true|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|39|一致|packages/platform-node/src/voice-addressee-decision.ts:64|发出前，名字和整句都经 redactForExternalText 遮掉验证码一类的敏感值|assistantName: redactForExternalText(input.heardName, options).text,
CLAIM|40|一致|packages/application/src/services/voice-addressee.ts:109|判断结果按“设备 + 这句话的编号 + 触发方式 + 名字 + 去标点后的文字”存在内存里|sameWords(request.text),
CLAIM|41|一致|packages/application/src/services/voice-addressee.ts:27|默认 10 分钟|cacheSeconds: 600,
CLAIM|42|一致|packages/application/src/services/voice-addressee.ts:28|每台设备 64 条|cacheEntriesPerDevice: 64,
CLAIM|43|一致|packages/application/src/services/voice-addressee.ts:91|不写数据库|readonly #remembered = new Map<string, Map<string, Remembered>>();
CLAIM|44|一致|packages/application/src/services/voice-addressee.ts:112|正在判断时同一句又来，等同一个结果|if (known) return (await known.judged) ?? “addressed_unsure”;
CLAIM|45|一致|packages/application/src/services/voice-addressee.ts:126|判断失败的不存，重试时再问|if (device.get(key)?.judged === judged) device.delete(key);
CLAIM|46|一致|packages/application/src/services/voice-addressee.ts:25|每台设备每分钟最多判断 20 次|perDevicePerMinute: 20,
CLAIM|47|一致|packages/application/src/services/voice-addressee.ts:113|超了按 addressed_unsure 处理|if (!this.#admit(request.deviceId, at, configuration)) return “addressed_unsure”;
CLAIM|48|一致|packages/application/src/services/voice-addressee.ts:115|判断前按字数预留费用|if (!(await this.#options.reserve(this.#options.model.estimateMicros(input))))
CLAIM|49|一致|packages/platform-node/src/voice-addressee-decision.ts:90|字数当 token 数，偏保守|return Math.ceil((characters * this.#options.inputMicrosPerMillionTokens) / 1_000_000);
CLAIM|50|一致|packages/application/src/ports/model-usage.ts:3|不新增用量记录用途|export const MODEL_USAGE_PURPOSES = [
CLAIM|51|一致|packages/application/src/ports/configuration.ts:318|runPolicy.voiceAddressee 写模型名、key 的引用、单价|readonly secretRef: string;
CLAIM|52|一致|packages/platform-node/src/strict-configuration.ts:1405|写两个门槛、超时、防刷次数、字数上限、缓存时长和条数|rejectUnknown(input, [...keys, “model”, “secretRef”, “inputMicrosPerMillionTokens”], field);
CLAIM|53|一致|apps/agent-service/src/production-http-composition.ts:1431|没有这一项时服务器不调用任何模型|if (!model || !configuration)
CLAIM|54|一致|apps/agent-service/src/production-http-composition.ts:1433|所有认出名字的指令都按 addressed_unsure 先问主人|request.trigger === “hands_on” ? “addressed” : “addressed_unsure”;
CLAIM|55|找不到|-|保留 4 字规则|未找到
CLAIM|56|找不到|-|名字在句尾会漏，只是提到它又会误执行|未找到
CLAIM|57|找不到|-|按位置猜意思违反 ADR 0249|未找到 docs/adr/0249-*.md
CLAIM|58|一致|packages/platform-node/src/voice-addressee-decision.ts:99|听到的整句会经 Vercel 发给 TypeSafe|const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|59|一致|scripts/evals/listening-score.mjs:312|手机评测记录里带上认出的名字|if (typeof call.heardName !== “string” || call.heardName.length === 0) continue;
CLAIM|60|一致|scripts/evals/listening-addressee-live.eval.ts:5|scripts/evals/listening-addressee-live.eval.ts 用生产同一个判断调用把每句问一遍|import { VoiceAddresseeDecision } from “../../packages/platform-node/src/voice-addressee-decision.ts”;
CLAIM|61|一致|scripts/evals/listening-addressee-live.eval.ts:34|先按字数估算费用，超过 EVAL_CONFIRM_COST 就一次都不发|if (estimate > CAP_USD * 1e6)
CLAIM|62|一致|scripts/evals/listening-score.mjs:345|scripts/evals/listening-score.mjs --addressee 只对通过认人门槛的句子按不同门槛组合出表|(observation) => CALL_PURPOSES.has(observation.clip.purpose) && executes(observation, gates),

未能核对的部分主要是 iPhone 端行为（一直听、4 字规则、两句合并、弹窗确认等），仓库里没有 iOS 实现；ADR 0249 不存在；Jev 的外部价格、零保留政策、实测延迟和费用，以及生产 Jev 与记忆 embedding 是否确实共用同一把 key，也没有在仓库内读到可证明的内容。
