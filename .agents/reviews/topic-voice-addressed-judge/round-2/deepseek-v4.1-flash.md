# 审核结论

这份方案不能按现状实施。方向可以讨论，但它在**值契约、数据库、测试门槛、客户端确认路径、成本和延迟**上有阻断问题；并且多个关键前提引用的文件/ADR 在当前提交 `ec69d4e62` 不存在，按项目规则不能作为依据（`.claude/rules/proposal-premises.md:9-13`）。

---

## 证实的

### 高

**1. 新用途 `voice-addressee` 过不了数据库 CHECK，I-73 会重演**
- 问题：方案只写“加进 `MODEL_USAGE_PURPOSES`”。TS 白名单会接受，但 `model_usage_observations.purpose` 在数据库里还有硬编码 CHECK；新值不在其中。`INSERT OR IGNORE` 可能直接丢掉这一行，用量静默不记账。
- 证据：`packages/application/src/ports/model-usage.ts:3-13`；`packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:6-11`；`packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:88-93`；`packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-35,85-106`。I-73 的教训正是“清单里的 id 能通过后端校验吗”（`docs/incidents-and-gates.md:112`）。
- 建议：新增迁移重建 `model_usage_observations`，把 `voice-addressee` 写进 CHECK，并在 `migration-engine.ts` 注册；加一条“`MODEL_USAGE_PURPOSES` 中每个值都能被真实 SQLite 接受”的契约测试；同步控制中心的 `sensitive.purpose.*` 标签（`apps/control-center/src/i18n/message-ids.ts:1295-1303`、`apps/control-center/src/components/sensitive-interceptions.tsx:99-107`）。

**2. 默认 thinking 模式 + 16 token 上限，判不出 JSON，费用/延迟估算失效**
- 问题：DeepSeek V4.1 Flash 默认是 thinking 模式；方案却按 10 个输出 token 估价，并只给 16 token。思考 token 会先吃掉预算，严格 JSON 很可能被截断，程序一律当 `unsure`——安全，但功能基本不可用；实际费用也可能比方案高一个量级。现有 `proactiveModel` 还把推理模型的输出预算设为 `maxOutputTokens * 2`，且只在 `generateTitle` 里关思考。
- 证据：DeepSeek 官方价目页：“THINKING MODE: Supports both non-thinking and thinking (default) modes”（https://api-docs.deepseek.com/quick_start/pricing）；`apps/agent-service/src/production-model-composition.ts:500-526`（`reasoningOutputTokens: limits.maxOutputTokens * 2`，未传 `disableThinking`）、`:666-675`（只有标题生成关思考）、`:449-499`（判断调用没有每调用 temperature）。
- 建议：明确走非思考模式（`disableThinking: true` 或等价配置）；输出上限至少 32–64，并启用 JSON 输出；先用小样本实测截断率和延迟；按实测重估费用，超过 0.5 美元先问 Andy（`.claude/rules/owner-standing-rules.md:16-17`）。

**3. “半句提前判”按现有协议和端口实现不了，缓存键也对不上**
- 问题：`/utterances/partial` 只接受 `utteranceId` 和 `text`，没有 `voice`/`heardName`/trigger；`UtterancePrefetchPort.prepare` 也只收这三个字段。方案却要在这半句上做和最终句相同的“名字 + trigger”判断。另外 `settle` 返回 `void`，现有路由把“半句和最终句是否相同”的结果丢掉了，无法直接复用判断。方案把最终判断缓存在 `messageId` 上，而项目已批准设计用 `utteranceId` 关联半句、最终消息和感知记录。
- 证据：`packages/platform-node/src/device-api-routes.ts:934-945`（partial 白名单）、`:110-122`（端口输入）、`:1416-1418`（`settle` 丢弃结果）；`packages/memory-engine/src/query-prefetch.ts:124-158`（复用规则在 `settle` 内部）；`docs/execution/specs/2026-11-11-apple-device-body-design.md:383`（三处靠同一个“这句话的编号”对上）。
- 建议：二选一：给 partial 增加经过校验的 `voice`/`heardName`，或第一版只判最终句；把 `UtterancePrefetchPort.settle` 改为返回判断结果；缓存键统一用 `设备 + utteranceId + 规范化文字摘要 + 名字 + trigger`；对同一 utterance 的多次 partial 加序号，防止旧判断覆盖新判断。

**4. 没有确定性自动门槛；现有语音测试会被改坏；付费评测不是门槛**
- 问题：方案把 judge 加进 `/messages` 后，现有 `airpods_name`/`ambient_name` 用例不再直接 200，但测试 harness 没有注入 judge，测试会打真模型或失败。方案只有付费评测，没有 `npm run check` 门的单测/集成测试，也没有项目要求的 `release-walkthrough` 反向用例。
- 证据：`test/integration/device-voice-command.test.ts:64-110`（期望 200）；`test/fixtures/device-api-harness.ts:323`（没有 judge stub）；`.claude/rules/incident-gates.md:14-17`；`.claude/rules/owner-standing-rules.md:34`（判断类功能发布验收必须有反向用例）；ADR 0106 决定 9：“自动测试里的模型判断一律用 `ScriptedModelPort` 注入固定结果”（`docs/adr/0106-proactive-loop-v1-gmail-read-only.md:50`）。
- 建议：加 `ScriptedModelPort` 驱动的单测/集成测试：yes 执行、no 不执行、unsure 409、超时/失败/额度用尽当 unsure、畸形输出/提示注入当 unsure、同 messageId 复用、不同文字不复用、确认路径绕过 judge、partial/最终复用、缓存上限。再把它接入 `npm run check`，并加 `release-walkthrough` 反向场景（电视/旁人叫名字不执行、unsure 会询问）。

**5. `voice.heardName` 没有进入服务端契约，也没有边界；所有消费端都要逐个核对**
- 问题：现在 `voice` 是严格白名单，`parseVoiceEvidence` 只认 5 个键。方案说“两端同时改”，但没有列出服务端 `VOICE_KEYS`、解析器、`VoiceEvidence` 类型、测试和客户端编码器；也没有限制 `heardName` 的长度/字符集。设备自报的名字只是提示，不能当权限或可信事实。现有评测里的 `call.heardName` 还是布尔值，和新字段同名会混淆。
- 证据：`packages/platform-node/src/device-api-routes.ts:108`（`VOICE_KEYS`）、`:126-145`（`parseVoiceEvidence`）；`packages/application/src/services/voice-command.ts:13-19`（`VoiceEvidence`）；`scripts/evals/listening-score.mjs:158,197`（把 `heardName` 当布尔值）。
- 建议：在 `VOICE_KEYS`、`parseVoiceEvidence`、`VoiceEvidence`、iOS 编码器、所有测试里同时改；`heardName` 加长度/字符集上限（例如 1–64 字符），名字触发必填、`hands_on` 可空；服务端用配置里的唤醒名做规范化或至少校验，不把设备自报的名字当授权；评测里的布尔字段改名或保持独立。

**6. 新提示词没有登记清单/快照：`check:prompt-catalog` 会失败**
- 问题：方案只说“放进 `packages/prompt-catalog`”。`prompt-manifest.json` 要求每个条目有 sha256、`changedIn` 和原因；`trusted.ts` 会把新文字纳入固定文字清单；`usedBy`、parser、golden 快照、三语文案都要同步。漏一项 `npm run check:prompt-catalog` 就红。
- 证据：`apps/agent-service/test/prompt-catalog.unit.test.ts:181-205`（`PROMPT_MANIFEST_MISSING`/`PROMPT_MANIFEST_STALE`）；`packages/prompt-catalog/src/entry.ts:59-75`；`package.json:58`；`packages/prompt-catalog/prompt-manifest.json` 现有条目的格式。
- 建议：新增 `voice.addressed-judge` 条目，写清 `id`、`purpose`、`usedBy`（新增的 judge 服务文件）、`layer: "background"`、`output: "json"`、`parser`；更新 manifest 和 golden/固定样本；加 `[I-78]` 出口遮盖测试，确认新固定文字原样发出、不被误遮。

**7. 前提里的关键来源不存在；Apple 论文被误读**
- 问题：方案反复引用 ADR 0249 第 28 行、`clients/apple/.../NameCall.swift`、`SpokenCommand.swift`、`apps/agent-service/src/auxiliary-judgment.ts`、`.agents/reviews/topic-voice-addressed-judge/round-1/`。当前提交没有 `clients/`，ADR 最高到 0242，没有 `auxiliary-judgment.ts`，也没有那个 review 目录。也就是说，“4 字规则属于意图判断、必须删”和“judgeWithModel 失败重问一次/judgeOrDefault”都没有可核实的来源。Apple 论文的 20–40% 误唤醒下降来自**联合建模上一句 + ASR 不确定性并做 LoRA/分类头微调**，不是零样本提示；论文自己的 PromptOnly 在 n=1 时 FAR 46.7%，带上一句的 1-1 组合 FAR 74.7%。
- 证据：`.claude/rules/proposal-premises.md:9-13`；`docs/adr/` 目录最高 `0242`；Apple 论文 https://arxiv.org/html/2411.00023v2 原话：“this approach yields large gains (20-40% reduction in false alarms at 10% fixed false rejects) due to the joint modeling of the previous speech context and ASR uncertainty”，以及 Table 2 的 PromptOnly FAR 46.7%/74.7%；Amazon 文章 https://www.amazon.science/blog/alexa-do-i-need-to-use-your-wake-word-how-about-now 原话：“combines features from the ASR system's decoding graph, acoustic embeddings, and embeddings of the ASR system's 1-best hypothesis”——这是声学 + ASR 特征的 DNN，不是“文字交给 LLM”。
- 建议：把不存在的前提标为“未核实”，重新找当前提交里的真实来源；不要用 Apple 论文为“零样本小模型提示”背书。要么做分类器/少量微调并实测，要么保留现有的声学/声纹门槛，把模型判断只当额外过滤；评测里加入“无模型、仅声学门槛”的基线。

**8. 把判断缓存放进 `product_state_records`：无 TTL、无文字绑定、还会推高 authority revision**
- 问题：方案说“不加新表”，用现有 `product_state_records` 按设备 + messageId 存判断。这张表是产品状态/配置的持久表，没有 TTL 和清理；每条命令一行会永久增长，还会进入数据导出、备份和迁移对比。`authority_revision` 触发器会在任何行新增/修改时加一，等于每次语音判断都推进全局授权版本。更严重的是，键只有 messageId，没有文字摘要：同一个 messageId 如果被客户端用修正后的文字重发，会套用旧文字的判断。
- 证据：`packages/persistence-sqlite/src/migrations/0003_product_state_transaction_expand.sql`；`packages/persistence-sqlite/src/migrations/0056_authority_revision.sql:98-110`；`scripts/delivery-mode/make-packet.py:33`（迁移对比表包含 `product_state_records`）；`packages/platform-node/src/device-api-routes.ts:884-895`（messageId 只用于幂等后缀）。
- 建议：不要用 `product_state_records` 做缓存。复用 `QueryPrefetch` 那种有 TTL、条数、字节上限的内存缓存，或新增专用缓存表并带清理；键用 `设备 + utteranceId + 规范化文字摘要 + 名字 + trigger`；写入顺序规定为“判断 → 持久化缓存 → 提交对话”，缓存写失败按“不执行”处理（fail closed）。

**9. 预算可被 partial/新 messageId 放大，形成成本和可用性 DoS**
- 问题：方案在 `/utterances/partial` 上判断，也在 `/messages` 上判断；partial 接口没有语音证据、没有每句调用上限，任何已配对设备或电视持续说话都可能触发大量判断。每日感知模型费用上限默认只有 1 美元；一旦被耗尽，主人真实命令会全部变成 `addressed_unsure`，只能逐个点确认。方案按“每天 300 次、约 2 倍”估算，没覆盖恶意的 partial/新 messageId。
- 证据：`packages/application/src/ports/usage-limits.ts:58-64`（`perception.model_cost.daily` 默认 1,000,000 micros = $1）；`apps/agent-service/src/production-http-composition.ts:1407-1414`（每次 partial 都预留费用）；`packages/platform-node/src/device-api-routes.ts:934-945`（partial 没有语音/频率限制）。
- 建议：加每设备/每 utterance 的判断次数上限、partial 去重、按规范化文字缓存、速率限制；额度用尽返回一个单独的原因（不要和普通 unsure 混在一起）；考虑给语音判断单独预算（这正是方案里要 Andy 定的第 2 项）。

**10. AirPods 路径也加判断，和已批准设计冲突，破坏 hands-free**
- 问题：已批准设计说“戴着 AirPods 叫名字，程序核对三样都满足就当指令”，这是第一天就要能用的免手操作；方案却对 `airpods_name` 也做一次文本模型判断。判断超时/失败/额度用尽都会把它变成“要我做吗”，恰好破坏了这个场景的核心体验；而且 AirPods 的声学门槛本来是最强的，模型在这里收益最小。
- 证据：`docs/execution/specs/2026-11-11-apple-device-body-design.md:375-379`（AirPods 三样满足就当指令；没戴耳机才靠声纹，达标前回问）、`:794`（对应测试）；方案第 2 条写“只对 `airpods_name` 和 `ambient_name` 两种触发做”。
- 建议：第一版只判断 `ambient_name`，或只在声学/声纹分数处于边缘时判断；`airpods_name` 保留现有三样检查直接执行。把“AirPods 路径是否加判断”作为评测单独一组，用数据决定。

### 中

**11. `not_addressed` / `addressed_unsure` 的客户端语义没有定义**
- 问题：方案对 `no` 和 `unsure` 都返回 409。现有客户端如果对所有 409 都走 `askFirst`，电视/旁人提到名字也会不停问主人；如果客户端对 409 自动重试，又会因为“同 messageId 复用判断”无限拿到同一个 409。方案只写了服务端原因，没有写客户端如何区分、是否重试。
- 证据：`packages/platform-node/src/device-api-routes.ts:868-877`（409 结构）；方案引用 `SpokenCommand.swift:70`，但该文件不在当前检出，无法核实。
- 建议：客户端按 reason 分支：`not_addressed` 静默丢弃（感知记录照存），`addressed_unsure` 才弹询问；这两种都不自动重试。加客户端侧和接口侧的契约测试。

**12. “同一条消息不重判”和“确认后执行”很可能互相卡死（推测，需客户端核实）**
- 问题：方案说同 messageId 重发直接复用第一次结果。如果主人点“要我做吗”后客户端用同一个 messageId 重发，服务端会再次返回缓存里的 `addressed_unsure`/`not_addressed`，永远执行不了。如果用新 messageId 但仍是 `ambient_name`，模型可能再次 unsure。方案没有定义“主人已确认”这一信号。
- 证据：方案第 2 条缓存规则；`packages/platform-node/src/device-api-routes.ts:884-895`（幂等键由 messageId 派生）；客户端文件缺失。
- 建议：明确确认路径：主人确认后用新的 messageId + `trigger: "hands_on"`（或一个绑定 utteranceId 的签名确认标志）提交，服务端跳过 judge；确认提交时调用 `recordCommandUtterance` 恰好一次；加“确认后一定能执行”的集成测试。

**13. “给不给前一句”自相矛盾；同一句会因上下文不同产生不同字节/判断**
- 问题：方案第 2 条先说提示词包含“同一段收听里前一句，按 Apple 论文”，紧接着说“第一版只给这一句，前一句作为评测对照”。如果给前一句，同一句当前话在不同上下文下字节不同、判断也可能不同，缓存就不能只按当前句做键。
- 证据：方案第 2 条两处文字；Apple 论文摘要（前一句 + ASR 不确定性才是 20–40% 的来源）。
- 建议：第一版明确只给当前句，并删掉“按 Apple 论文给上一句”的表述；如果以后加前一句，缓存键必须包含前一句的规范化摘要，并在评测中单独报告增益和成本。

**14. 费用估算在 thinking 模式下不成立，评测可能超过 0.5 美元**
- 问题：方案按 10 个输出 token 估“评测约 0.04 美元”。如果默认 thinking，1000 次判断的输出可能是几十万 token，费用会超过 0.5 美元；按项目规则“费用说不准时按会超过处理”，应先问 Andy 并设上限。
- 证据：DeepSeek 价目页（同上）；`.claude/rules/owner-standing-rules.md:16-17`。
- 建议：先关思考，再按 32–64 输出 token 重算；先跑 20–50 句的付费试点量截断率和实际费用，再决定全量评测；评测脚本要有实时累计和硬上限（ADR 0109 的做法）。

**15. `temperature: 0` 在现有 `proactiveModel` 上调不了**
- 问题：方案要求 temperature 0，但 `proactiveModel` 不接受 temperature，只有整个 model composition 的全局 `temperature` 选项；给 judge 单独设 0 需要扩展接口，不能假设现成可用。
- 证据：`apps/agent-service/src/production-model-composition.ts:449-499`（`auxiliaryModelFor` 未传 temperature）、`:351-355`（全局 temperature）、`:500-526`（`proactiveModel` 的参数只有 maxOutputTokens/requestTimeoutMs/purpose）。
- 建议：给 `proactiveModel` 或新的辅助调用入口增加每调用 `temperature`/`disableThinking`/输出上限，并确保只影响这条独立调用，不影响主对话请求头。

**16. 长文本和 `heardName` 没有输入上限，单次判断可能被放大**
- 问题：`/messages` 的 `text` 上限是 64KB；方案把整句原话发给 judge，没有单独限制判断输入。一个很长的消息会让 judge 的输入 token 暴涨，费用和延迟都不可控；`heardName` 也没有长度限制。
- 证据：`packages/platform-node/src/device-api-routes.ts:107`（`MESSAGE_TEXT_MAXIMUM = 64 * 1024`）、`:863-865`；`parseVoiceEvidence` 没有对 `heardName` 的长度检查。
- 建议：给 judge 输入单独设上限（例如 512–1024 字符），超过时截断并标记或直接返回 `unsure`；`heardName` 限制 1–64 字符并校验字符集。

**17. `no` 路径的感知记录和 `utteranceId` 跳过逻辑没有接上**
- 问题：`/messages` 本身不创建感知记录，记录来自 `/perception`；当前只有提交成功后才调用 `recordCommandUtterance`。方案说“全量收听模式下这句照常当感知记录存下”，但没有说明 `no`/`unsure`/确认后如何保证记录存在、如何让感知抽取在确认执行后跳过同一条记录。
- 证据：`packages/platform-node/src/device-api-routes.ts:926-930`（只在成功提交后记录）；`packages/platform-node/src/perception-service.ts:1244-1251`；已批准设计 `apple-device-body-design.md:383`（靠同一个编号去重）。
- 建议：明确设备在三种路径都发送同 utteranceId 的 `/perception`；确认执行后调用 `recordCommandUtterance`，让感知抽取跳过；`no` 不调用，保留为普通感知记录；加集成测试。

**18. 判断调用的数据分级和披露策略没有写清**
- 问题：主对话目前把设备消息硬编码为 `private`；judge 也把整句发给模型。如果这句话含密码/健康/财务信息，出口遮盖会遮值，但判断结果可能因此变成 `unsure`；同时需要确认 judge 使用的模型是否允许 `private`（或更高）分级。
- 证据：`packages/platform-node/src/device-api-routes.ts:920`（`dataClassification: "private"`）；`production-model-composition.ts:510-513`（`proactiveModel` 只检查允许 `private`）；`packages/application/src/services/model-egress.ts`。
- 建议：judge 复用主对话的数据分级/披露规则；对敏感输入做“遮盖后判断”的专门测试；在敏感信息拦截记录里用 `voice-addressee` 标明这是另一次模型接收。

---

## 推测 / 未核实

1. **确认路径会被同 messageId 缓存卡死**：客户端 `SpokenCommand.swift` 不在当前检出，无法确认它确认后是否复用 messageId、是否改成 `hands_on`。按方案文字和现有 409 语义，风险很高，必须核实。
2. **客户端是否对所有 409 都 `askFirst`**：`SpokenCommand.swift:70` 无法核实；如果它不按 reason 分支，`not_addressed` 也会弹询问。
3. **全量收听是否已把同一条 `speech.utterance` 上传**：客户端不在仓库，无法确认 `no` 路径一定已有感知记录。
4. **`product_state_records` 的写入是否需要 authority/lease**：方案没有说明用哪个仓储入口；现有表有 authority revision 触发器和迁移对比约束，是否需要额外事务/权限未核实。
5. **生产模型配置是否已经关闭 thinking**：当前 `proactiveModel` 没有关，但具体模型 descriptor 可能因 provider 不同而不同；按 DeepSeek 官方默认值，风险成立。
6. **方案引用的 ADR 0249、`NameCall.swift`、`auxiliary-judgment.ts`、`.agents/reviews/...`**：当前提交均不存在，相关前提“未核实”。

---

## 侧重检查

- **错误路径**：检查了 judge 超时、模型失败、畸形 JSON、额度用尽、partial 乱序、同 messageId 重发、确认后重发、缓存写入失败。结论：超时/失败/畸形按 `unsure` 是安全的，但必须有自动测试；partial 乱序和确认路径目前没有设计；缓存写入失败必须 fail closed，不能“先提交再存”。
- **不合规范或不可信输入**：检查了 `heardName` 无边界/可伪造、64KB 长文本、partial 任意发送、电视/旁人提示注入、模型输出自然语言。结论：需要长度/字符集校验、服务端规范化名字、注入测试、partial 频率限制；不能把设备自报的 `heardName` 当可信事实。
- **安全**：检查了“用 LLM 当安全边界”的强度、缓存投毒、重试直到 `yes`、预算 DoS、出口遮盖、确认绕过、`hands_on` 绕过。结论：模型只能当额外过滤，不能替代声学/声纹门槛和现有权限；需要按 utteranceId+文字摘要缓存、速率限制、明确确认信号；不可逆操作仍走现有审批。
- **资源耗尽**：检查了 partial 放大、长文本、thinking token、无 TTL 缓存、每日 $1 额度。结论：这四项都会耗尽预算或存储；需要上限、TTL、去重、非思考模式。
- **不可撤销操作**：检查了 judge 通过后是否绕过现有权限、确认路径是否成为新绕过、`hands_on` 是否仍直接执行。结论：judge 只应决定“是否提交对话”，不能绕过 `ActionPolicy`；确认路径必须是已认证的主人动作，不能由任意客户端声称。
- **规则、文档和代码一致性**：检查了 `prompt-prefix`、I-73、I-78、owner rules、Apple device spec、prompt catalog、egress check、locale、release-walkthrough。结论：方案对“不改主对话请求头”的判断基本正确，但值契约和自动门槛不合格；前提来源缺失，Apple 论文被误读；与已批准 spec 的 AirPods 路径冲突。

---

## 如果由我来定，我会怎样改

1. **保留现有声学/声纹门槛作为主过滤**：`airpods_name` 三样满足直接执行；`ambient_name` 先过声纹门槛，认人未达标时回问。模型判断只作为 `ambient_name` 的额外过滤，或只在分数边缘时调用。不要一上来就给 AirPods 路径加模型。
2. **不要直接删 4 字规则**：先做 A/B/C 评测——A 现有 4 字规则 + 声学门槛；B 名字不限位置 + 声学门槛（无模型）；C B + 模型判断。只有 C 相对 B 在“误执行 0”的前提下显著提高执行率，才值得引入模型和成本。
3. **如果保留模型判断**：独立后台调用；固定指令在前、名字和整句在后、不放时间；非思考模式、temperature 0、JSON 输出、32–64 token 上限、1.5 秒超时；严格解析，其余一律 `unsure`；不重试（或只对网络超时重试一次）；失败/额度用尽一律不执行。
4. **缓存**：用有 TTL/条数/字节上限的缓存（复用 `QueryPrefetch` 思路），不要用 `product_state_records`；键用 `设备 + utteranceId + 规范化文字 SHA-256 + 名字 + trigger`；写入顺序“判断 → 存缓存 → 提交”，存失败不执行。
5. **确认路径**：`unsure` 返回 409 `addressed_unsure`，客户端弹询问；主人确认后用新的 messageId + `hands_on`（或绑定 utteranceId 的签名确认）提交，服务端跳过 judge，并调用一次 `recordCommandUtterance`。`not_addressed` 静默丢弃、保留感知记录、不重试。
6. **值契约一次改全**：`voice.heardName` 进 `VOICE_KEYS`/`parseVoiceEvidence`/`VoiceEvidence`/iOS/测试；`voice-addressee` 进迁移和所有 `MODEL_USAGE_PURPOSES` 消费端；prompt manifest/trusted/golden/`usedBy`/parser；三语 `sensitive.purpose.*`；任何新出口登记到 `check-egress-redaction`。
7. **门槛**：`ScriptedModelPort` 单测/集成测试覆盖所有分支；现有 `device-voice-command.test.ts` 和 harness 同步；加 `release-walkthrough` 反向场景；`npm run check` 全绿。付费评测只作为发布验收，不作为唯一硬门槛。
8. **费用**：先关思考、跑小样本试点实测输入/输出/延迟；按实测重估；评测用独立 key，实时累计并设硬上限，超过 0.5 美元先问 Andy。

### 逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   如果按方案的本意实现——不动系统提示、不动工具定义、只把整句作为最后一条用户消息追加——已有对话的请求开头不变，新内容只在末尾追加，每轮会变的值（整句、名字、判断）都在最后一条消息或独立后台调用里，符合只追加规则。**但有两个前提必须守住**：不要把 judge 的结果或“是否叫它”写进系统提示/工具定义；新增提示词只进独立后台调用，不要混进主对话。新增 `prompt-catalog` 条目本身不会改老对话的冻结系统提示；但若实现时顺手改了已有条目或冻结工具，就会破坏前缀。`voice.heardName` 是设备请求字段，不进入模型请求，不影响前缀。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   主对话不会，前提是出口遮盖仍按现有确定规则执行、不引入时间/无序集合。judge 是独立调用：如果只给当前句和名字，输入字节对同一输入是确定的；如果加上“前一句”，同一句当前话会因上下文不同而不同字节、不同判断，必须按“当前句 + 前一句摘要”一起缓存。判断结果本身是模型输出，天然可能不同；方案用“同 messageId 不重判”只能挡住同一条消息，挡不住新 messageId 的重复请求。建议改为按 `规范化文字 + 名字 + trigger` 缓存，并关思考、temperature 0。`heardName` 还应服务端规范化，避免 `Himawari`/`himawari`/`ヒマワリ` 产生不同输入。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   目前没有足够的自动检查。方案只有付费评测和“评测报告里的硬门槛”，不是 `npm run check`，也不是 `release-walkthrough`。需要新增：`ScriptedModelPort` 的 yes/no/unsure/超时/失败/额度用尽/畸形输出/提示注入测试；`/messages` 的 409 reason、感知记录、`recordCommandUtterance` 测试；`voice.heardName` 白名单和边界测试；partial/最终复用和乱序测试；缓存复用/不同文字不复用/确认绕过测试；迁移测试；prompt catalog/egress/locale 检查；`release-walkthrough` 反向场景。反向用例必须在改前的代码上失败、改后通过，并写进提交说明；真实模型评测可以波动，不能当唯一硬门槛。

4. **每个产生或修改的值，使用它的地方都能接受吗？**
   不能，至少有三处已经证实不一致：
   - `voice-addressee` 只进 TS 白名单，数据库 CHECK 不接受（I-73 重演）。
   - `voice.heardName` 只写在方案里，服务端 `VOICE_KEYS`/`parseVoiceEvidence`/`VoiceEvidence`/测试和客户端编码器都没有列出；`heardName` 在评测里还是布尔值，存在同名冲突。
   - `not_addressed`/`addressed_unsure` 只定了服务端 reason，客户端 `SpokenCommand.swift` 的枚举、询问分支、重试策略没有定义。
   另外还要核对：1.5 秒超时的配置键及其校验/默认值/谁能改；新 prompt 的 manifest/trusted/golden/`usedBy`/parser；`sensitive.purpose.voice-addressee` 三语文案；任何新出口的 `check:egress-redaction` 登记；缓存键/TTL/清理；`recordCommandUtterance` 在确认路径的调用。建议加两条契约测试：`MODEL_USAGE_PURPOSES` 的每个值都能被真实 SQLite 接受；`voice` 的每个键都能被 `parseVoiceEvidence` 和客户端同时接受/拒绝。
