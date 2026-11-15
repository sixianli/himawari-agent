## 读代码证实的意见

### 1、中高、并发到达的同一句不会合并，会重复问 Jev、重复预留费用
文件：`packages/application/src/services/voice-addressee.ts:111-126`
问题：材料说“正在判断时同一句又来，等同一个结果”，但缓存要等 `await reserve` 之后才写入，两个并发相同请求都会先穿过缓存检查。
证据（读代码证实）：
> `const known = device.get(key);`
> `if (known) return (await known.judged) ?? "addressed_unsure";`
> `if (!this.#admit(...)) return "addressed_unsure";`
> `if (!(await this.#options.reserve(...))) return "addressed_budget";`
> `const judged = this.#judge(input, configuration);`
> `device.set(key, { judged, at });`

两个并发请求会各自 `#admit`、各自 `reserve`、各自调用一次模型；随后 `device.set` 互相覆盖。若一个成功、另一个失败，失败一方执行 `device.get(key)?.judged === judged` 时可能删掉成功方的缓存，导致下一次重试重新判断。
建议：在任何 `await` 之前按 key 写入一个共享的 in-flight Promise（或先占位再在内部做 reserve/judge），所有调用者等同一个 Promise；失败结果在 Promise 解析后统一移除。补一条 `Promise.all` 同请求只调用一次 `probability`、只预占一次费用的测试。

### 2、中、Jev 响应先整段读入内存，之后才检查大小，外部响应可耗尽内存
文件：`packages/platform-node/src/voice-addressee-decision.ts:111-113`
问题：`MAX_RESPONSE_BYTES` 的检查发生在 `response.text()` 已经读完整个响应之后；没有先看 `content-length`，也没有边读边计数。现有 `memory-import-duplicate-decision.ts:93-110` 已经采用流式读取并在超限时 `reader.cancel()`，这里的写法更弱。
证据（读代码证实）：
> `const text = await response.text();`
> `if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)`
> `  throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_RESPONSE_TOO_LARGE");`
建议：照 `memory-import-duplicate-decision.ts` 的做法，先检查 `content-length`，再流式累计字节，超过 64 KiB 立即取消读取并报错。补一条“响应超过上限”的反向测试。

### 3、中、生产环境里手机旁路麦克风的“听到名字”永远到不了 Jev
文件：`packages/calibration/src/thresholds.ts:85-96`、`apps/agent-service/src/production-http-composition.ts:1512`、`packages/application/src/services/voice-command.ts:53-54,71-74`
问题：`VOICE_COMMAND_AMBIENT_GATE.defaultThreshold = VOICE_GATE_NEVER`（1001），而生产组装写死 `voiceGates: () => DEFAULT_VOICE_GATES`，没有从评测/配置接入 ambient 门槛。`passes` 用 `score >= threshold`，分数最高 1000，所以 `ambient_name` 永远返回 `speaker_unconfirmed`，在到达 `addressee` 前就被拒。实际只有 `hands_on` 和 AirPods 路径能用到 Jev。
证据（读代码证实）：
> `export const VOICE_GATE_NEVER = VOICE_SCORE_MAX + 1;`
> `defaultThreshold: VOICE_GATE_NEVER,`
> `voiceGates: () => DEFAULT_VOICE_GATES,`
> `return score !== null && score >= thresholdFor(gate, null);`
> `case "ambient_name": return passes(gates.ambientCommand, evidence.speakerScore) ? ... : { accepted: false, reason: "speaker_unconfirmed" };`

`OWNER_SPOKEN_GATE` 同样是 1001，所以生产里 `origin` 也永远不会是 `owner_spoken`。如果这是“评测校准前先全部问主人”的有意默认，请在 ADR/材料里写明；如果不是，这就是“手机一直听”主场景未接通。
建议：把 voice gates 做成 `runPolicy` 配置项，或把评测推荐门槛接入生产；补一条生产组装测试，断言 `ambient_name` 在默认配置下会走到 `addressee`（或明确断言当前故意不走）。

### 4、中、缺少 addressee 时路由默认按“已叫它”执行，是 fail-open
文件：`packages/platform-node/src/device-api-routes.ts:974-985`
问题：`options.addressee` 不存在时直接返回 `"addressed"`。材料说“没有这项配置时……一律 addressed_unsure”，但这是组合层显式传了 fallback 才成立；路由本身的默认值是执行，不是不执行。
证据（读代码证实）：
> `const addressed = options.addressee ? await options.addressee({...}) : "addressed";`
> `if (addressed !== "addressed") return options.sendJson(reply, 409, {...});`
建议：默认改成 `"addressed_unsure"`，或把 `addressee` 设为必填并在启动时拒绝缺失；补一条不传 `addressee` 时返回 409 的测试。

### 5、中、预算/存储错误没有转成 409，而是冒成 500，语音指令会静默消失
文件：`packages/application/src/services/voice-addressee.ts:115`、`packages/platform-node/src/device-api-routes.ts:974-975`
问题：`#judge` 只包住模型调用；`reserve`（`perception.reserveModelCost`）抛错时不会返回 `addressed_unsure`/`addressed_budget`，而是从 `decide`、`addressee` 一路抛出，最终是 500。客户端 `deliver` 的 `catch` 只会回到收听，用户看不到任何提示。这与“判断失败一律走不执行/409”的约定不一致。
证据（读代码证实）：
> `if (!(await this.#options.reserve(this.#options.model.estimateMicros(input)))) return "addressed_budget";`
> `const addressed = options.addressee ? await options.addressee({...}) : "addressed";`
建议：在 `decide` 内捕获 `reserve` 与 `configuration()`/`estimateMicros` 的异常并返回 `addressed_unsure`（或单独的预算失败），路由层再兜底把意外错误转成 409；补 `reserve` 拒绝的测试。

### 6、中低、`POST /utterances/partial` 没有按设备限流，可持续触发外部嵌入调用
文件：`packages/platform-node/src/device-api-routes.ts:1185-1206`、`apps/agent-service/src/production-http-composition.ts:1666-1673`
问题：该接口每次调用都会预留感知模型费用并执行一次 `embedQuery`；只有每日预算上限兜底，没有像 Jev 那样的“每设备每分钟 N 次”。一个已配对设备可以高频调用，最多把当天 `perception.model_cost.daily` 烧完，并让服务持续向嵌入服务发请求。
证据（读代码证实）：
> `if (!options.prefetch) return options.sendJson(reply, 200, { prepared: false, reason: "unavailable" });`
> `await options.prefetch.prepare({ authentication, deviceId, utteranceId, text });`
> `if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text)))) return { prepared: false, reason: "limit_reached" };`
> `const prepared = await prefetch.queue.prepare(..., (query) => prefetch.embedQuery(query));`
建议：为 partial 增加每设备每分钟次数/最小间隔上限，或复用 `runPolicy` 中的防刷配置；在达到上限时返回 `prepared:false` 且不预留费用、不调用嵌入。

### 7、低、判断请求把固定的 `questions` 放在可变的 `input` 之后，不符合“固定在前”
文件：`packages/platform-node/src/voice-addressee-decision.ts:55-75`
问题：请求体顺序是 `model → input（可变）→ questions（固定指令）→ providerOptions`。规则 15 要求后台调用“先放固定的指令，再放这次的数据”；现有 `memory-import-duplicate-decision.ts:34-64` 正是 `questions` 在前、`input` 在后。这里把固定问题放在可变输入之后，若网关按前缀缓存，固定部分无法命中。
证据（读代码证实）：
> `return JSON.stringify({ model, input: [...], questions: [...], providerOptions: ... });`
建议：改为 `questions` 在前、`input` 在后，与现有判断调用一致；补一条序列化后键顺序/字节的测试。

### 8、低、客户端与服务端对 `heardName` 的字符计数和禁止字符不一致
文件：`clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:31`、`packages/platform-node/src/device-api-routes.ts:180-188`
问题：客户端用 Swift `String.prefix(64)`（按字素/Character 计数），服务端用 `[...value].length`（按 Unicode 码点计数）并额外拒绝 `\p{Cc}`、`\p{Cf}`。一个含组合字符或 ZWJ 的合法名字，客户端可能截到 64 个 Character 后发送，服务端却按码点超过 64 或含 Cf 而返回 400，而不是材料约定的 `addressed_unsure`。
证据（读代码证实）：
> `self.heardName = trigger == .handsOn ? nil : heardName.map { String($0.prefix(Self.heardNameMaximumCharacters)) }...`
> `const length = [...value].length;`
> `length <= VOICE_HEARD_NAME_MAXIMUM_CHARACTERS && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)`
建议：两端统一计数口径（都按码点或都按字素），并统一禁止字符；服务端对“名字不合法”返回 `addressed_unsure` 而不是 400，或在客户端提前过滤。补跨端用例。

### 9、低、egress 登记里重复加入了已经存在的 “AI Gateway decision request”
文件：`scripts/check-egress-redaction.mjs:74-80`
问题：`EXTERNAL_EGRESS_PATTERNS` 中出现了两条完全相同的 `AI Gateway decision request`（第 76 行和第 79 行）。功能上只是重复扫描，不会失败，但说明登记时没有核对现有清单；后续维护者会误以为新增了模式。
证据（读代码证实）：
> `{ name: "AI Gateway decision request", pattern: /\/decisions[`"']/u },`
> ...
> `{ name: "AI Gateway decision request", pattern: /\/decisions[`"']/u },`
建议：删掉重复项，并在 `test/tooling/egress-redaction-check.test.mjs` 增加“模式名不得重复”的自检。

### 10、低、材料中的测试数量与提交说明不一致
文件：提交 `5ca7c49c9` 的说明
问题：材料说“60 个相关测试文件 1354 条通过”；同一提交说明写的是“共 45 个文件全部通过”，并明确写“`production-http-composition-process` 没跑”。两者至少有一个不准确。
证据（读代码/提交说明证实）：
> 提交说明：“共 45 个文件全部通过（含 device-voice-command 里 Jev 九条）；production-http-composition-process 要预先构建的安装包，没跑，留给合并队列。”
建议：在材料里引用一次真实运行记录（命令、时间、通过数），并明确生产组装测试是否已经补跑；不要把 45 和 60 混用。

### 11、低（部分是推测）、客户端把所有非空 ownerScore 都标成 `speaker: owner`，与 `origin` 可能矛盾
文件：`clients/apple/Sources/HimawariCore/Listening/UtteranceFlow.swift:115`、`packages/calibration/src/thresholds.ts:72-83`、`packages/platform-node/src/perception-service.ts:446-449`、`packages/prompt-catalog/src/perception.ts:321`
问题：客户端只要 `ownerScore != nil` 就写 `HeardSpeaker(kind: .owner, score: ...)`，即使分数很低。服务端 `origin` 走 `ownerSpoken` 门槛，而该门槛在生产默认 1001；于是记录可能同时是 `"speaker":"owner"` 和 `"origin":"other"`。提取提示词把 `speaker` 解释为“主人”、`origin` 解释为“系统确认是主人本人说的”。如果提取模型更信任 `speaker`，旁人的话可能被记成主人的记忆。
证据（读代码证实）：
> `speaker: speech.ownerScore.map { HeardSpeaker(kind: .owner, score: $0) } ?? HeardSpeaker(kind: .unknown, score: nil)`
> `defaultThreshold: VOICE_GATE_NEVER,`
> `ownerVoiceQualified: isOwnerSpoken(speakerScore, this.#options.voiceGates?.()),`
> `"speaker"（"owner" 主人、...）、"origin"（"owner_spoken" 表示系统确认是主人本人说的...）`
推测：这一矛盾是否真的导致错误记忆，取决于提取提示词对 `speaker`/`origin` 的权重；我没有运行模型，无法确认。建议：客户端把未过门槛的分数改成 `unknown`，或服务端在 `score` 低于 owner 门槛时把 `speakerKind` 降为 `unknown`；至少让 `speaker` 与 `origin` 语义一致，并补低分用例。

## 未核实

- 没有运行 `tsc`、测试或 Swift 编译（本次工具只能读和看 git 历史），所以材料里的“tsc 通过、60 个文件 1354 条通过、9 条 Jev 集成测试通过”只能从代码和提交说明判断，不能确认实际全绿。提交说明本身写的是 45 个文件，且生产组装测试未跑。
- Mac 上的 SwiftUI/HimawariListen 编译未核实；Linux 只能验证 HimawariCore 的部分无法在此环境确认。
- `packages/prompt-catalog/prompt-manifest.json` 的 `voice.addressee-question` sha256 没有计算；仓库有 `prompt-catalog` 的 stale 检查，但未运行。
- Vercel/TypeSafe 真实返回的 `model` 字段是否恒为配置值、`zeroDataRetention` 是否真的被上游执行，未核实（ADR 已声明无法自行核实对方是否保留）。
- 生产部署配置是否已在仓库外加入 `runPolicy.voiceAddressee`：仓库内没有找到实际生产配置包含该项，未核实是否由部署系统另行注入。

## 侧重检查

- **错误路径/失败安全**：模型异常、超时、模型不匹配、无名字、超长句都会落到 `addressed_unsure`，已有集成测试覆盖；但 `reserve`/配置读取异常会冒成 500（意见 5），缺少 `addressee` 时默认执行（意见 4）。判断失败不会执行命令，这一点本身是守住的。
- **不可信输入**：`voice` 只接受白名单键，`trigger`/`inputRoute`/分数/`heardName` 都有校验，未知的 `owner`/`verdict` 字段会被 400 拒绝，测试覆盖了这些反向用例。设备配对后上报的 AirPods/inEar/loudness 是设备自报，服务器无法独立验证，这是原有信任模型，不是本批新增。
- **资源耗尽/成本**：Jev 有 20 次/分钟/设备和每日感知费用上限；查询抢占的 partial 接口没有设备限流（意见 6），并发重复判断会重复扣费（意见 1）；Jev 响应大小限制在缓冲之后（意见 2）。缓存条数/TTL/字节数都有上限。
- **安全/隐私出口**：发给 Jev 前调用 `redactForExternalText`，带 `zeroDataRetention: true`，并在 egress 检查中登记；登记模式有重复（意见 9）。整句仍会发给第三方，这是 ADR 明确接受的。
- **不可撤销操作**：本批没有新增删除/写文件等操作，只是让语音指令走原有提交路径；Jev 一旦判“是”会自动提交并执行，门槛 0.7 和证据门槛是主要保护。`not_addressed` 不会给主人覆盖机会，这是设计取舍。
- **规则/文档与代码一致**：ADR 0264 的默认值（0.7/0.3、1.5 秒、20 次、1024 字、10 分钟、64 条）与代码一致；但“并发同一句等同一个结果”“没有配置时一律 addressed_unsure”“手机一直听问 Jev”三处与代码有出入（意见 1、3、4）。
- **标识/字段/配置跨端**：`voice` 字段、触发方式、输入路线、拒因、`VOICE_COMMAND_UNCONFIRMED`、`/utterances/partial` 的请求/响应、`speaker.score` 两端基本能对上；`heardName` 计数口径不一致（意见 8），`runPolicy.voiceAddressee` 只有解析测试，没有生产组装路径测试。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
对话请求不会。新增的 Jev 调用是独立的 `/v1/decisions` 请求，不进入任何对话；`/messages` 在提交对话前先做判断，对话侧仍然只在末尾追加新用户消息，系统提示、工具定义、历史没有被改写。`[PR-A]` 集成测试也断言冷启动和半句抢占后对话请求除“本轮请求时间”外字节相同。需要注意两点：第一，`voice.addressee-question` 这个后台调用本身的固定问题排在可变 `input` 之后（意见 7），不符合后台调用“固定在前”的规则，但它不影响对话请求头；第二，`speaker.score`/`origin` 只影响感知记录及其后续工具结果，不会把每轮变化值放进系统提示或工具定义。结论：对话请求仍是只追加；侧调用顺序不规范。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
没有发现对话请求层面的非确定性。Jev 请求没有时间字段，数组和键顺序固定；同一 `(heardName, text)` 每次创建新的 `known`/`tag`，遮盖结果是确定的。但 `heardSentence` 的遮盖与同一请求里先处理的 `assistantName` 共享 `known` 和顺序标签，所以“同一句话 + 不同 heardName”可能遮出不同占位符；这属于规则允许的“依赖前面的内容”，但跨请求不保证同一句字节相同。`toLocaleLowerCase("und")` 依赖运行时 ICU 版本，同一部署内稳定，跨机器版本可能不同（推测）。结论：对话前缀没有发现问题；侧调用存在上下文相关遮盖，需要接受或改为每字段独立遮盖。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`startup-configuration.unit.test.ts` 覆盖配置必填/范围/未知键；`prompt-output-contracts.unit.test.ts` 覆盖 `voiceAddresseeProbability` 的坏模型、坏答案、概率越界；`device-voice-command.test.ts` 有 9 条 Jev 集成测试（0.5、HTTP 500、超时、模型不对、无名字、预算、限流、失败不缓存、缓存重试）；`device-prefetch.test.ts` 覆盖 partial；`listening-score.test.mjs` 覆盖评测打分；egress 检查和 prompt manifest 检查也在 `npm run check` 里。缺的自动检查有：并发同一句只调用一次（意见 1）、超大响应（意见 2）、没有 addressee/没有 voiceAddressee 配置的 fail-safe（意见 4）、`reserve` 抛错（意见 5）、partial 限流（意见 6）、`productionVoiceAddressee`/`createProductionHttpComposition` 的真实生产组装、`heardName` 跨端计数（意见 8）。反向用例是否真会失败：从代码看，删掉 addressee 调用、改错阈值、去掉 `redactForExternalText`，现有测试会失败；但本次没有实际运行，且提交说明明确说生产组装测试没跑，所以这一项只能算“代码上应该会失败”，不是运行证据。

**4. 每个产生/使用的值两端都能接受吗？**
- `voice` 的 `trigger`、`inputRoute`、`speakerScore`/`loudnessScore`（0-1000）、`inEar`、`heardName`：客户端编码键和服务端 `VOICE_KEYS` 一致，分数上限一致，测试确认 nil 字段被省略而不是发 null。
- 拒因 `not_addressed`/`addressed_unsure`/`addressed_budget`、`airpods_*`/`speaker_unconfirmed`：服务端字符串和客户端 `SpokenCommandRefusal` 枚举一致。
- `VOICE_COMMAND_UNCONFIRMED` 和错误体 `{error:{code,reason}}`：客户端 `DeviceAPIError.server` 已扩展 `reason`，测试覆盖。
- `/utterances/partial` 路径、`utteranceId` 模式、`{prepared,reason}`：两端一致；`PERCEPTION_UTTERANCE_ID_PATTERN` 允许 1-64，客户端 16 字节 base64url 能通过。
- `runPolicy.voiceAddressee`：严格解析能接受 `model`、`secretRef`、`inputMicrosPerMillionTokens` 及六个可调项，生产代码会读取；但仓库内没有实际生产配置样例，且没有生产组装测试。
- `prefetchSeconds`、`device.prefetch.cache.entries`、`device.prefetch.cache.bytes`：默认值、硬上限和网关合约清单都存在，能对上。
- `speaker.score`：客户端发送、服务端 `validatePerceptionFields` 接受并用于 `origin`；但 `speaker.kind` 与 `origin` 可能矛盾（意见 11），生产 owner 门槛默认永不过（意见 3）。
- `heardName` 64：两端都有上限，但计数口径/禁止字符不一致（意见 8）。
总体：主要标识和拒因两端能接受；真正的缺口是并发行为、fail-open 默认、生产 owner/ambient 门槛未接通，以及缺少生产组装验证。
