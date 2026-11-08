# 代码复核：PR4「去掉整段拦下：内部存储和展示用原文，占位符还原」

基线 `9f75931` → `65b2d9f`，27 个文件。以下结论全部来自我亲自读到的代码；未核实处已标注。

## 发现（按严重度从高到低）

### 1.（中高）「还原不了的占位符不存」没有实现，测试用例名与断言不符
- 文件：`apps/agent-service/src/production-memory-capture.ts:303,335`、`test/integration/production-memory-capture.test.ts:646-659`
- 证据：`parseMemoryCandidates` 里 `restore` 只是 `text.replace(EGRESS_PLACEHOLDER_PATTERN, m => table.get(m) ?? m)`（`restoration.ts:16-19`），**还原失败时占位符原样保留，没有任何“还原不了就丢弃候选”的检查**。作者引用的测试名是 "drops a candidate whose placeholder cannot be restored instead of storing it"，但断言只有 `expect(memory?.text ?? "").not.toContain("hunter2abc")`——该候选（confidence 990、explicit、private、quote 能对上原话）会走 `auto_committed`（`automatic-memory-service.ts:190-197`），把 `主人的[密码#zzzzzzzz]` 照存入库，断言是**空洞通过**的。
- 后果：表格漏项时（见第 4、7 条），带占位符的垃圾记忆静默入库，且没有任何告警。
- 建议：还原后若文本仍命中 `EGRESS_PLACEHOLDER_PATTERN`，按 invalid 候选丢弃或至少写审计；同时把该测试断言改为「memories 为空」。

### 2.（中）生产装配的 `externalTag` 接线零测试覆盖，断了也不会有任何用例失败
- 文件：`apps/agent-service/src/production-run-composition.ts:450,498`
- 证据：全库只有这两处给生产代码接 `externalTag`；所有测试（`test/integration/production-memory-capture.test.ts:212`、`apps/agent-service/test/production-thread-titles.unit.test.ts:247`）都是**自己注入 tag**，删掉这两行接线全部测试仍绿。消费端对 `externalTag === undefined` 静默跳过还原（`production-memory-capture.ts:821`、`production-thread-titles.ts:88-90`），无日志无指标。这正是 I-73 的教训：只测了两端，没把「清单里的 id 能过发送端校验」这条链连起来测。
- 建议：加一个经 `createProductionRunComposition` + `createProductionModelEgress` 的端到端用例（用真实 egress 的 tag，而不是测试自造的 `captureTag`），断言占位符被还原。

### 3.（中低）文档与代码矛盾：W-07b 和 PRD 仍声称「凭据不进记忆」
- 文件：`docs/adr/0166-prompt-wording-batch-1-system-and-tools.md:83`、`docs/prd-v0.2.md:71,152`
- 证据：ADR 0166 写「密码、验证码、密钥由代码拦下……命中就按 `candidate_secret_excluded` 丢弃」；PRD 写「密码、API Key……必须在调用模型、**记忆提取和记忆后端**之前被排除」。本 PR 恰好删除了这两个行为（`automatic-memory-service.ts`、`production-memory-control.ts`），但没有改任何文档（diff 里无 docs 文件）。`candidate_secret_excluded`、`source_secret_excluded` 这两个审计结果码也已从代码消失。
- 建议：更新 ADR 0166 的 W-07b 段落（标注被本 PR 取代）和 PRD 相应条目，否则下一个按文档复核的人会当成缺陷修回来。

### 4.（低）还原表从 JSON.stringify 过的 prompt 重建：含引号/反斜杠/换行的值还原出来不是逐字节原文
- 文件：`apps/agent-service/src/production-memory-capture.ts:175-191`、`production-thread-titles.ts:80`
- 证据：`memoryCapturePrompt` 把主人消息放在 `JSON.stringify({...ownerMessage: message...})` 里，标题提示同理。egress 遮盖和 `placeholderTable` 看到的都是**转义后**的串，表中存下的 original 也是转义形式（`redaction.ts:285` 的 `original` 是正则匹配到的转义值）。含 `"` 或 `\` 的密码还原回标题/记忆正文后是 `\"` 字样，不是原文。含此类值的 `quote` 与主人原话比对会失配 → 候选被丢（方向安全，不误存），标题则会存进转义残片。
- 建议：对表中 original 做 JSON 反转义，或文档记一条已知限制。

### 5.（低）含机器密钥的标题现在会进入 web push 通知 body
- 文件：`apps/agent-service/src/production-web-push.ts:517,535`、`production-thread-titles.ts:97-100`
- 证据：Run 结束/待审批通知的 `body: title ?? untitled`；标题此前被 `assertMachineSecretFree` 挡住（本 PR 删除，且新增测试断言“含密钥的标题照存”）。缓解：web push 载荷用 `aes128gcm` 端到端加密给主人浏览器（`packages/platform-node/src/web-push-sender.ts:61`），推送服务看不到明文，收件人只有主人。这与 Andy 原则不冲突，但这是本 PR 把新类别值（机器密钥）接上的唯一一条**外部通道**，值得 Andy 显式确认。
- 建议：可选地在通知 body 里不放标题原文，或确认后记录该决定。

### 6.（信息）死代码与 README
- `packages/sensitive-capture/src/machine-secrets.ts:189,217` 的 `machineSecretHoldStart`、`StreamingMachineSecretRedactor` 在 src 里已无调用方（`pi-model-transport.ts` 不再用），README 仍介绍它们。按 Andy 原则可留待后续清理。

### 7.（信息）两个可接受的边界，建议注释写明
- tag 碰撞：占位符编号是 8 位小写字母（26⁸≈2.1×10¹¹），同一密钥下两个不同值碰撞时 `restorePlaceholders` 会静默还原成错值（`restoration.ts:16-17` 取表中任一匹配）。概率可忽略。
- 密钥两次获取：`externalTag()` 在 generate 前取一次 key（`model-egress.ts:524-526`），egress 发请求时再取一次（`:199`）；轮换恰好落在两步之间时还原表整体失配 → 占位符照存（静默降级，无泄漏）。

### 作者说法核对结果
- 证实：9 条登记删除、`restoration.ts` 入 `REDACTOR_ONLY_FILES`、`assertStorable` 只剩空检查、提醒只剩长度检查、Muse `storable` 简化、沙箱诊断原文入库（stderr 摘要测试仍断言无密钥）、Pi 流式不再用 `StreamingMachineSecretRedactor`、`restricted_excluded` 保留、quote 还原后才比对、`tentativeTexts` 为 main 逻辑且只在周围删拦截、`session-trace-recorder` 与 `pi-runtime-adapter` 的遮盖未动。
- 不符：「还原不了的占位符不存」未实现且测试断言空洞（见第 1 条）；「反向验证」只验证了测试自身的注入，未保护生产接线（见第 2 条）。

## 侧重检查（普通流程走查）

流程：主人发「记住我的密码: hunter2abc」→
1. 消息原文 protect 入库 → `ProductionThreadTitles.start`（`production-thread-titles.ts:76` 起）：prompt 由原文拼装 → generate（egress 遮盖发送）→ `placeholderTable(prompt)` 还原 → 裁剪校验 → 标题原文入库 → UI 与 web push（加密）。**有测试覆盖**（两个新用例）。
2. 空闲记忆整理（`production-memory-capture.ts:808` 起）：`memoryCapturePrompt` → generate（egress 遮盖）→ `placeholderTable(prompt)` → `parseMemoryCandidates` 逐字段还原 → quote 比对 → `AutomaticMemoryService`（restricted 丢、sensitive 审批、其余照存）。**有测试覆盖**（还原、restricted 反向、凭据照存）。
3. **无测试覆盖的路径**：`production-run-composition.ts:450,498` 的 externalTag 接线（第 2 条）；placeholderTable 与真实 `createProductionModelEgress` 遮盖的一致性——测试全用 `redactForEgress` 直接模拟并自造 tag，trusted 固定文字、跨消息 known 值、JSON 转义这些真实 egress 才有的差异没有用例（我逐条分析过：差异只会产生多余表项或漏还原，方向安全，但无测试背书）；`thread-checkpoint-service.ts`、`reflection-service.ts` 删拦截后没有新增「照存」用例（作者测试清单也没声称有，属删除行为，可接受）。
4. 时间线外发路径排查：投影只落本地库且 owner 隔离有断言（`thread-run-lifecycle.test.ts` other-owner 拒绝）；导出 `pi-output-export.ts` 仍遮（登记保留）；web push 只带固定文案+标题（加密）；未发现时间线原文发给第三方的路径。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？——不会。**
本 PR 所有删除都在「存储/展示」侧；两处还原只作用于 generate 返回值的解析字段（`production-memory-capture.ts:303,335`、`production-thread-titles.ts:88-93`），不在任何请求组装路径。`pi-model-transport.ts` 的改动只影响「流式输出落库」：现在存模型实际写出的原文。历史存的是遮盖前内容、发送时由 egress 确定性重遮（`model-egress.ts:219-245`），机器密钥遮成 `[密钥]`（`redaction.ts:300-304`）——与改动前存 `[MACHINE_SECRET_REDACTED]` 再被转成 `[密钥]` 的最终字节相同；删掉 flush 只是少一个 persist 分块，拼接内容不变。唯一的请求侧变化是含密钥的消息以前会被记忆整理整段跳过、现在会发（新增后台调用），不改任何已发内容的字节；每轮会变的值没有新增到请求头部。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会（除可忽略的碰撞）。**
`placeholderTable`/`restorePlaceholders` 对同一 prompt、同一密钥是纯函数（单测断言两次构建相同），无时间字段、无集合顺序依赖；还原结果只进存储字段，这些字段将来再入请求时仍按出口遮盖确定性遮盖。唯一非单射点是 8 位字母 tag 的碰撞（第 7 条），概率可忽略，建议注释说明。

**3. 有没有自动检查、反向用例会不会真失败？——部分有。**
有：`check-egress-redaction.mjs` 的 `findSensitiveGateViolations`（:261-301）会拦「未登记文件新增整段拦下调用」「登记与实际调用数不符」「登记了但已无调用」，把拦截加回去 `npm run check` 会失败；`restoration.ts` 已列入 `REDACTOR_ONLY_FILES` 限制 `redactForEgress` 调用面。缺：生产 externalTag 接线无任何反向保护（第 2 条）；「还原不了的占位符不存」的反向用例实际不成立（第 1 条）。

**4. 每个产生/使用的值两端都核对了吗？——核对过，两处例外。**
`externalTag`：产生端 `model-egress.ts:524-526`（`letters(sign(key, "kind\0value"))`）与 egress 发送时用的同一个 `placeholderTag`（`:221`），同一把 key，两端一致；消费端两处 + 装配端两处对齐，但断裂无感知（第 2 条）。`restore`/`EGRESS_PLACEHOLDER_PATTERN`：占位符生成格式（`redaction.ts:283`）与还原 pattern（`:61`）一致。`credentialFindings` 删除：全库无残留引用，登记同步删除，门禁两端自洽。`SENSITIVE_GATE_CALLS` 删 9 条：门禁有反向校验。例外：JSON 转义形式还原（第 4 条）是「值」语义上与逐字节原文目标不符；`[密钥]` 无编号、还原不了、会照存为字面量（作者已接受的代价，属实）。
