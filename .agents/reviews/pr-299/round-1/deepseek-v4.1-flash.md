## 读代码证实的问题（按严重度）

### 1. 高：自动记忆的提示词仍要求“密码凭据不要记录、证件号/银行卡/密码/验证码用 restricted”，代码又把 restricted 候选丢弃；本 PR 的“自动记忆存原文”在生产里不会发生，新增测试用 private 绕过
- 位置：`packages/prompt-catalog/src/memory.ts:13`、`:16`；`apps/agent-service/src/production-memory-capture.ts:327-334`；`packages/application/src/services/automatic-memory-service.ts:133-138`
- 证据：
  - 提示词原文：`"不要记录：...、密码密钥等凭据..."`；`"证件号码、银行卡或账户号码、密码和验证码用 restricted。"`
  - `production-memory-capture.ts` 只把模型给的 classification 透传：`value["classification"] === "sensitive" || value["classification"] === "restricted" ? value["classification"] : "private"`
  - `automatic-memory-service.ts`：`if (candidate.dataClassification === "restricted") { ... "restricted_excluded" ... continue; }`
  - 新测试 `packages/application/test/memory-credential-storage.unit.test.ts` 的候选硬编码 `dataClassification: "private"`，集成测试也把身份证号写成 `classification":"private"`，所以测试全过，但没有走真实提示词。
- 影响：遵守提示词的模型会把密码/证件号/银行卡标成 `restricted`，随后被丢弃；或者按“不要记录凭据”直接不产出候选。作者说的“记住我的身份证号 → 存原文”与代码/提示词矛盾。
- 建议：二选一并在同一 PR 里做：改 `MEMORY_CAPTURE.text`（不再要求不记录/要求 restricted），或明确“自动整理仍不存凭据”并删掉/改写这些测试与说明；补一条让模型桩按提示词返回 `restricted` 或 `[]` 的端到端反向用例。

### 2. 中高：`restorePlaceholders` 找不到占位符时原样返回，记忆层没有任何“还原不了就不存”的检查；对应测试名不副实
- 位置：`packages/sensitive-capture/src/restoration.ts:18-20`；`apps/agent-service/src/production-memory-capture.ts:303`、`:311-321`、`:335`；`packages/application/src/services/automatic-memory-service.ts:440-448`
- 证据：
  - `return text.replace(EGRESS_PLACEHOLDER_PATTERN, (match) => table.get(match) ?? match);`
  - 解析后只校验：`if (!text || text.length > MAXIMUM_MEMORY_CHARACTERS || !KINDS.has(kind) || ...)`，没有检查残留占位符；`commitCandidate` 直接把 `candidate.text` 存入 content store。
  - 测试 `test/integration/production-memory-capture.test.ts:652-661` 名为 “drops a candidate whose placeholder cannot be restored instead of storing it”，但只断言 `expect(memory?.text ?? "").not.toContain("hunter2abc")`；`主人的[密码#zzzzzzzz]` 本身就不含 `hunter2abc`，即使存进库测试也通过。
- 影响：模型把占位符改写、拆开（如 `[密码#abcd efgh]`）或编号写错时，会把 `[密码#...]` 当普通文本存成一条垃圾记忆；作者声称“还原不了的占位符不存”不成立。
- 建议：在 `text`/`quote` 还原后检测 `EGRESS_PLACEHOLDER_PATTERN` 是否仍有残留，残留则判 `invalidCandidates` 或 `restricted_excluded`；把该测试改成断言 `memories` 为空/该候选被拒，并确认关掉还原时这条测试会失败。

### 3. 中：去掉 `containsRestrictedIdentifier` 的强制分类后，模型若把银行卡/证件号判成 private，会绕过敏感审批和推送隐藏
- 位置：`apps/agent-service/src/production-memory-capture.ts:327-334`；`packages/application/src/services/automatic-memory-service.ts:145-147`；`apps/agent-service/src/production-web-push.ts:486-498`
- 证据：
  - 现在 `requested` 完全由模型决定：`value["classification"] === "sensitive" || ... ? value["classification"] : "private"`。
  - 审批只看 `isSensitive(candidate)`，即 `sensitive`/`restricted`。
  - Web Push 提醒：`const hidden = memory.dataClassification === "sensitive" || memory.dataClassification === "restricted"; const text = hidden ? undefined : (await this.#options.readMemoryText(memory))...`，否则 `body: `${text}\n...``。
- 影响：本 PR 自己的测试就假设身份证号/银行卡为 `private`；这种记忆会走自动保存、无审批，并且在提醒推送正文里原样出现。推送虽然经 Web Push 加密到主人设备，但仍是离开服务进程的外部路径；且与 ADR 0089“敏感/受限记忆只显示私密提醒”的原有保护不一致。
- 建议：如果只是“内部存储用原文”，仍保留一个由检测得出的 `sensitive/restricted` 标志供审批和推送隐藏使用；或明确接受并补测试/文档说明“模型判 private 的卡号会进推送正文”。

### 4. 中：`placeholderTable` 复遮时没有传 `trusted`，不是实际出口表的翻版；会为固定提示词里的数字生成不存在的映射
- 位置：`packages/sensitive-capture/src/restoration.ts:14`；`packages/application/src/services/model-egress.ts:224`
- 证据：
  - 实际出口：`trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS`
  - 新表：`redactForEgress(source, { known: new Map<string, string>(), tag, table })`，没有 `trusted`。
  - I-78 已记录固定提示词里的 `1000` 在无 `trusted` 时会被当成验证码；`MEMORY_CAPTURE.text` 就在 prompt 里，因此重建的表会出现 `[验证码#…] → "1000"` 这种模型从未见过的映射。
- 影响：当前两个 prompt 里多数情况下表只是“多出条目”，不会误还原；但它不满足作者“对发给模型的完整提示文本重新遮一遍”的等价性，未来提示词一改就可能出现幻影占位符或漏还原。
- 建议：不要重建表，直接从 `ModelEgressExchange.table` 取同一请求的表（生成调用把表带出来）；或至少把同一份 `trusted` 传进去，并加“固定提示词里的 1000 不得进入表”的测试。

### 5. 中：表是从 JSON 序列化后的 prompt 建的；密码含 `"`、`\`、换行时，还原出的原文带 JSON 转义
- 位置：`apps/agent-service/src/production-memory-capture.ts:177-190` 与 `:827`；`apps/agent-service/src/production-thread-titles.ts:80`、`:88-92`；`packages/sensitive-capture/src/restoration.ts:14`
- 证据：
  - 记忆 prompt：`JSON.stringify({ ... ownerMessage: message.slice(0, MAXIMUM_SOURCE_CHARACTERS) })`
  - 标题 prompt：`` `${THREAD_TITLE.text}\n${JSON.stringify({ userMessage: text.slice(0, 4096) })}` ``
  - 表从含这段 JSON 的整串 prompt 重建；例如密码 `a"b` 在 prompt 里是 `a\"b`，表里保存的也是 `a\"b`，还原进 `text`/`quote` 就成了字面反斜杠。
- 影响：含引号/反斜杠/控制字符的密码会被存成错误字节；`quote` 还可能因 `evidenceText` 去掉标点后仍通过校验，从而把错误文本静默写进记忆。作者“还原后一定逐字相同”的说法不成立。
- 建议：按结构化值建表（对 JSON 里的值先解码）或在还原后对来自 JSON 片段的值做反转义；补一条含 `"`/`\` 的密码用例。

### 6. 中：多份 ADR/说明文档仍写着旧行为，和本 PR 直接冲突
- 位置：
  - `docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:44`：“还原只在主对话的显示端……后台辅助调用的输出不还原。”
  - `docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md:42`：“模型回复里的占位符不还原。”
  - `docs/adr/0166-prompt-wording-batch-1-system-and-tools.md:83`：仍写“密码、验证码、密钥由代码拦下……`candidate_secret_excluded`”。
  - `docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:42`：“含机密或受限标识的文本不存正文”。
  - `docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`：仍列 `candidate_secret_excluded`。
  - `docs/adr/0089-web-push-only-owner-entry.md:60`：敏感/受限记忆只显示私密提醒（本 PR 让模型决定分类后这条更易失效）。
- 证据：本 PR `git diff` 没有修改任何 docs/ADR；代码已改成后台记忆/标题还原、Muse 存原文、记忆候选不再按机密整段丢弃。
- 影响：违反“规则文件、说明文档和代码一致”的复核要求；后续维护者按 ADR 会写错。
- 建议：在本 PR 或紧接的文档 PR 中新增/修订 ADR，至少更新 0146、0148、0166、0162、0143、0089。

### 7. 中低：`[密钥]` 无编号，模型照抄会原样存成垃圾记忆/标题；代码没有拒绝
- 位置：`packages/sensitive-capture/src/restoration.ts:18-20`（只匹配带 `#` 的 `EGRESS_PLACEHOLDER_PATTERN`）；`packages/sensitive-capture/test/restoration.unit.test.ts:30-36`（明确断言 `[密钥]` 原样保留）；`apps/agent-service/src/production-memory-capture.ts` 无后续检查
- 证据：`if (table.size === 0 || !text.includes("#")) return text;`，`[密钥]` 不含 `#`；测试期望 `"见 [密码#zzzzzzzz] 和 [密钥]"` 原样返回。
- 影响：回答作者的问题：会。若模型把 `[密钥]` 抄进 `text` 且 classification 不是 restricted，就会存成“主人的密钥是 [密钥]”这类记忆；标题同理。作者已接受“不带编号无法还原”，但这是可避免的垃圾数据。
- 建议：至少在记忆候选层把只含/含 `[密钥]` 的文本按无法还原处理（丢弃或要求模型重写）；标题可把 `[密钥]` 去掉或回退到 opening words。

### 8. 低：只还原 `text` 和 `quote`，模型输出里其他携带占位符的字段仍会原样入库
- 位置：`apps/agent-service/src/production-memory-capture.ts:303`、`:335`；同一函数的 `entities`/`people`/`stance`/`subCategory` 解析在 `:359-403`
- 证据：`restore` 只用于 `text` 与 `quote`；`entities`、`people[].name`、`stance`、`subCategory` 直接 `shortText`/`normalize` 后使用。
- 影响：如果模型把被遮的值写进 `entities`、`stance` 等字段，会存成 `[密码#...]` 字面量；下一轮模型看到的是不可还原的占位符。不是泄露，但数据不一致。
- 建议：要么对所有来自模型输出的字符串字段应用同一还原，要么在解析前对整个候选对象做还原（注意 JSON 破坏问题，可先 `JSON.parse` 再逐字符串还原）；至少补测试。

### 9. 低：`pi-output-export.ts` 仍在导出时遮盖/拒绝机器密钥，与作者“导出保持逐字节原样”的原则不符
- 位置：`packages/platform-node/src/files/pi-output-export.ts:47-50`
- 证据：`const masked = redactForEgress(text).text; return masked === text ? exportedOutput(bytes, false) : exportedOutput(Buffer.from(masked), true);`；非 UTF-8 时 `containsToolOutputSecret` 直接抛 `PI_OUTPUT_SECRET_DROPPED`。
- 影响：这是“导出”路径，仍不是原文；作者材料没有把它列入“没有改的”清单。
- 建议：明确它是否属于“内部展示/导出”；如果属于，应改成本地原文导出，或至少写进文档说明是刻意保留的外部风险边界。

### 10. 低（说明订正）：`pi-model-transport` 不是“模型输出落入历史前的一步”，它只服务后台/辅助调用
- 位置：`apps/agent-service/src/production-model-composition.ts:463`、`:597`、`:643`；`apps/agent-service/src/service-main.ts:1981`
- 证据：`auxiliaryModelFor` 才用 `new PiModelTransport(...)`，其 `generateTextOnce` 把输出当作字符串返回给标题/记忆等；主对话 runtime 在 `service-main.ts:1981` 传的是 `modelComposition.composition.piModels`，由 `PiAgentRuntimeAdapter` 自己走 `restoreModelStream`（`packages/runtime-pi/src/pi-runtime-adapter.ts:1034-1040`）。
- 影响：作者关于“这是模型输出进入历史前的一步”的判断不对。好消息是结论仍成立：删除 `StreamingMachineSecretRedactor` 不影响聊天历史字节；它改变的是后台模型输出的引用内容。
- 建议：更正说明，避免后续按错误模型改动 `PiModelTransport`。

### 11. 低中：被丢弃候选的正文现在会连同机密一起写入 content store，且删除记忆未必能清掉
- 位置：`packages/application/src/services/automatic-memory-service.ts:205-213`、`:545-563`；`test/integration/production-memory-capture.test.ts:874-891`
- 证据：证据校验失败时 `discard(..., keepText = candidate.dataClassification !== "restricted")`；`keepText` 为真时 `content.store({ ... text: candidate.text })`。测试也从 `contentRef: null` 改成 `expect(ledger[0]?.contentRef).not.toBeNull()`。
- 影响：以前含机器密钥的候选 `keepText=false`，不落正文；现在只要分类不是 restricted，就会把含密钥的候选正文存进内容库。作者说“内部存储用原文”，但这是对**被拒候选**的额外长期留存；是否能随记忆删除而清除未核实。
- 建议：确认删除/清理路径是否覆盖 `discard` 的 contentRef；如不能，至少对 `evidence_unverified`/其他丢弃原因也沿用“含机密不存正文”，或加 TTL/清理。

### 12. 中低（侧重检查）：Web Push 会把标题/提醒正文带到外部推送服务；现在标题/提醒可含原文机密
- 位置：`apps/agent-service/src/production-web-push.ts:507-520`、`:523-539`、`:486-498`
- 证据：审批和任务通知 `body: title ?? ...`；提醒 `body: hidden ? ... : `${text}\n${time}``。`title` 来自 `threadTitle`；`text` 来自 `readMemoryText`。本 PR 让标题可存原文、提醒可存原文，且分类不再由扫描强制。
- 影响：这是“界面展示”之外的网络出口。Web Push 载荷通常端到端加密，推送服务读不到；但仍是离开服务的外部请求，且最终显示在设备上。ADR 0089 原有的“敏感/受限只显示私密提醒”依赖分类，本 PR 弱化了分类。
- 建议：明确是否把 Web Push 视作“主人自己的展示端”；若否，按 API 出口同样遮值；若是，至少保证分类不因移除扫描而漏判。

## 推测（未在运行时验证）
- 8 位编号碰撞：26^8≈2.1×10^11，同一 prompt 中 n 个敏感值时碰撞概率约为 n(n-1)/(2×2.1×10^11)；正常 n 很小，可忽略。真碰撞时 `table` 只保留先出现的映射，会把两个不同值还原错，但概率极低。
- 模型可能主动把占位符改写/替换成同表里的另一个编号，导致还原成同一 prompt 里的另一个秘密；不会外泄到模型，但会写错记忆/让 quote 假通过。属低概率/需提示词注入才可控。
- 被 `discard` 的 contentRef 是否能随记忆删除清除，未追到存储层删除实现。
- Web Push 的加密细节取决于 `WebPushSenderPort` 实现，未读实现，无法确认推送服务不可解密。
- 我未运行任何测试或 `npm run check`；作者的“4520 条通过、41 步全过”未核实。

## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销、文档一致）
- 错误路径：`externalTag()` 失败会让记忆整理在 `generate` 前抛错（`production-memory-capture.ts:821` 在 try 内，最终 `extraction_failed`）；标题在 `externalTag`/还原失败时走 `openingWords(text)`，会把首个用户消息开头（可含机密）直接存成标题（`production-thread-titles.ts:99-102`）。两者都不是新的泄露到模型，但错误路径会改变存储内容。
- 不可信模型输出：`restorePlaceholders` 对模型输出全量替换；模型可复制表内占位符把原文写进任意候选 `text`/`quote`，但只能写回同一 prompt 里出现过的值；未发现越权到其他 owner 的路径。
- 安全/外部出口：模型出口（`ModelEgress`/`PiAgentRuntimeAdapter`/`PiModelTransport`）仍统一遮值；外部搜索/TypeSafe 仍走 `redactForExternalText/Url`；`session-trace-recorder` 仍用 `redactTracePayload`（`packages/application/src/services/session-trace-recorder.ts:75`），与作者“没动 trace”一致。新暴露的是 Web Push 路径和本地导出路径。
- 资源耗尽：`placeholderTable` 对每次记忆整理/标题的完整 prompt 多跑一遍 `redactForEgress`，prompt 受 `MAXIMUM_SOURCE_CHARACTERS`/`4096` 等限制；`restorePlaceholders` 只对模型输出（≤1024/128 token 级别）跑正则，未发现无界循环或指数回溯。
- 不可撤销：记忆正文、标题、Muse、检查点、沙箱诊断、以及被弃候选正文现在都以原文/密文可解形式落库；作者已接受“库里多存明文”，但删除链是否覆盖这些副本未核实。
- 文档一致：见问题 6；此外 `AutomaticMemoryResult` 仍保留 `"source_secret_excluded"` 分支但已无生产者（`automatic-memory-service.ts:59`），属无害死枚举，但应与文档一起清理。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会改变聊天请求的前缀字节。逐项核对：
- `ModelEgress`、`restoreModelStream`、系统提示/工具定义/历史组装都没有本 PR 的改动；新增的 `externalTag`/`restore`/`placeholderTable` 只作用于记忆候选、标题等**存储字段**，不改请求体。
- `pi-model-transport.ts` 删除 `StreamingMachineSecretRedactor` 只影响后台/辅助调用的输出处理；主对话不使用它（`service-main.ts:1981` 传 `composition.piModels`，主对话由 `PiAgentRuntimeAdapter` 走 `restoreModelStream`）。因此作者把它说成“模型输出落入历史前的一步”不准确，但结论仍是不影响聊天历史字节。
- 发给模型的内容仍是固定系统提示/工具/历史在前、本轮变化值（如 `backgroundModelContext` 的 `timestamp`）在最后一条用户消息；记忆/标题的数据也是拼在最后的 prompt 里，不是系统提示前缀。
- 需要说明的是：本 PR 让原本“被跳过”的机器密钥消息也会触发记忆/标题请求，这是“是否发请求”的变化，不是同一 prompt 的字节变化。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
没有新增按请求变化的值：出口编号仍是 `HMAC(key, kind\0value)`，机器密钥固定为 `[密钥]`，没有加入时间/无序集合；相同内容和相同密钥每次遮盖结果相同。`placeholderTable` 依赖完整 prompt（上下文），但它只用于**一次写入**的还原，之后存的是固定字符串；后续请求再按确定性规则重新遮盖。
需要注意三个非字节稳定问题：一是 `dataClassification` 现在依赖模型判断，同一段文字可能在不同轮次得到不同分类；二是无法还原的占位符会被永久写成字面量；三是含 `"`/`\` 的值会被写成 JSON 转义形式（问题 5），但这三个都是“写错一次后固定”，不是同一内容的每轮字节漂移。

**3. 有没有自动检查，反向用例真的会失败吗？**
有检查，但不完整：
- 正向：`packages/sensitive-capture/test/restoration.unit.test.ts`、`test/integration/production-memory-capture.test.ts` 的两个还原用例、`apps/agent-service/test/production-thread-titles.unit.test.ts` 的还原用例。按代码推断，关掉还原后这些会失败（未实际运行）。
- 反向：`memory-credential-storage.unit.test.ts` 的 “REVERSE: still drops a candidate the model classified as restricted” 仍有效（`dataClassification === "restricted"` 分支还在）。
- 关键缺陷：`test/integration/production-memory-capture.test.ts:652-661` 的 “drops a candidate whose placeholder cannot be restored instead of storing it” 既不检查“未存储”，关掉还原也不会失败；它无法守住问题 2。没有测试覆盖 `trusted`/固定提示词 `1000`、JSON 转义、`[密钥]` 进入记忆、模型判 private 的卡号不进推送、或“导出原文”。因此作者“还原不了的不存”的反向验证不成立。

**4. 改动产生/修改的每个值，每个使用处都能接受吗？**
- `externalTag`：两个生产构造点都接了（`production-run-composition.ts:450`、`:498`）；类型是 `Promise<tag>`，与 `ModelEgress.externalTag()` 一致。通过。
- `parseMemoryCandidates.restore`：只有 `production-memory-capture.ts:841-843` 传入；未传时退化为原文，行为可接受。通过。
- `restoration.ts` 导出与 `REDACTOR_ONLY_FILES`：新增正确；`credentialFindings` 删除后全仓库无引用（grep 确认）；9 条 `SENSITIVE_GATE_CALLS` 对应文件已无这些调用，脚本按代码推断不会报“登记但无调用”。通过。
- `dataClassification` 的下游：不通过。`automatic-memory-service.ts:145-147` 用它决定敏感审批；`production-web-push.ts:486-498` 用它决定是否隐藏提醒正文；`production-web-push.ts:517/535` 把标题直接放进推送。去掉扫描强制 `restricted` 后，模型判 private 的银行卡/证件号不再触发这些保护。这正是 I-73 说的“清单里的 id 能通过后端校验吗”：值产生处（模型 classification）和消费处（审批、推送）的假设不再一致。
- 占位符字符串的下游：`[密码#…]` 可能进入记忆正文、实体、标题；`restorePlaceholders` 只处理 `text`/`quote`，其他字段和无法还原的占位符会被当普通文本长期保存。`[密钥]` 无编号，所有使用处都只能把它当普通字面量。不通过“所有使用处都能接受”。
- 导出/展示：`pi-output-export.ts` 仍遮盖，时间线/投影改为原文（所有者 UI）。如果原则是“导出原文”，导出这一端未改，不一致。
