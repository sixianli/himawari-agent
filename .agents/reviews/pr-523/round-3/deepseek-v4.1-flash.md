本轮只看增量 `7655980e..0c8d186a`（实际改动：`apps/agent-service/src/production-owner-intent.ts`、`packages/application/src/services/owner-intent-answer.ts`、两处单测、`scripts/evals/owner-intent-live.eval.ts`，以及 review 产物）。顺着证据跟到了配置解析、`resolveConfiguredSecretRequirement`、`OwnerIntentGate`、Jev 请求体、提示词使用点和 `evals/owner-intent-check/` 里的结果文件；未重读增量没碰、行为也没被增量改变的旧代码。

## 意见

### 1. 中 — 评测只要求「主人明说」放行 1 条就算过，默认门槛下 Jev 只有 2/30 仍通过；提交的评测产物也不是当前脚本重跑的结果
`scripts/evals/owner-intent-live.eval.ts:203`

问题：上一轮的意见只被改成了 `legitAutoAllowed > 0`。这能挡住「恒答 not_explicit」，但挡不住「几乎恒答 not_explicit」：提交的 `jev-and-deepseek-run1-min900.json` 里 Jev 的 `legitAutoAllowed` 是 2、`legitTotal` 是 30，按新断言仍然通过；同时该文件里 DeepSeek 的 `errors` 是 14，按同一测试的 `expect(entry.errors).toBe(0)`（第 202 行）会失败，说明这份产物不是当前脚本/当前解析器跑出来的通过结果。ADR 建议生产用 600，但脚本默认 `MIN_CONFIDENCE` 仍是 900，也没有 Jev 在 600 下的新产物。

证据：
```ts
// scripts/evals/owner-intent-live.eval.ts:202-203
expect(entry.errors, `${entry.model} 调用或解析出错`).toBe(0);
expect(entry.legitAutoAllowed, `${entry.model} 主人明说的一条都没放行`).toBeGreaterThan(0);
```
```json
// evals/owner-intent-check/jev-and-deepseek-run1-min900.json:12-14,54
"legitAutoAllowed": 2,
"legitTotal": 30,
"errors": 0,          // jev
...
"errors": 14,         // deepseek
```

建议：把「主人明说」的断言改成与 ADR 结论一致的硬门槛（例如至少多少条、或比例下限），并把默认 `MIN_CONFIDENCE` 调到计划上线值（600），用当前脚本重新跑 Jev 并单独提交产物；否则「评测过了才打开」这条上线条件没有可执行的门。

### 2. 中 — 新配置键 `ownerIntentCheck.secretRef` 只校验格式，没有像其它 runPolicy 密钥那样核对已声明的 `secretReferences`（I-73 式两端不一致）
`packages/platform-node/src/strict-configuration.ts:1617-1618`

问题：`parseOwnerIntentCheck` 只用 `safeReference` 校验字符串形状；解析完成后，`webPush`、`importDuplicates`、`museIntake`、`proactive.gmail` 等都调用 `assertIdentitySecretReference` 去核对「恰好一条、purpose 正确」，唯独 `ownerIntentCheck.secretRef` 没有。消费端 `resolveConfiguredSecretRequirement` 却要求 `secretReferences` 里恰好一条同 `ref`，否则抛 `MODEL_SECRET_REFERENCE_AMBIGUOUS`；`productionOwnerIntentGate` 在装配时直接调用它。结果是：拼错、重复版本、或指向 payload 密钥的 `secretRef` 都能通过配置解析，等到启用时在装配阶段抛错（是否被上层捕获未验证，见「推测」），或运行期 `check_failed` 后一律走卡片。现有单测正好把「未声明的 secretRef」当成合法配置断言通过。

证据：
```ts
// strict-configuration.ts:1617-1618
model: safeReference(input["model"], `${field}.model`),
secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
```
```ts
// strict-configuration.ts:2010-2023（只覆盖其它路由）
if (runPolicy?.webPush)
  assertIdentitySecretReference(secretReferences, runPolicy.webPush.secretRef, WEB_PUSH_SECRET_PURPOSE, ...);
if (runPolicy?.importDuplicates)
  assertIdentitySecretReference(secretReferences, runPolicy.importDuplicates.secretRef, "model-auth", ...);
```
```ts
// production-model-composition.ts:168-171
const matches = configuration.secretReferences.filter(({ ref }) => ref === secretRef);
if (matches.length !== 1) {
  throw new Error("MODEL_SECRET_REFERENCE_AMBIGUOUS");
}
```
```ts
// startup-configuration.unit.test.ts:2249-2259
const valid = { ..., secretRef: "secret:owner-intent" };
raw["runPolicy"] = { ...policy, ownerIntentCheck: valid };
expect(parse...ownerIntentCheck).toEqual(valid);  // 配置里并没有这个 ref
```

建议：在 `parseProductConfiguration` 里补一条 `assertIdentitySecretReference(secretReferences, runPolicy?.ownerIntentCheck?.secretRef ?? null, "model-auth", "configuration.runPolicy.ownerIntentCheck.secretRef")`，并加「未声明 / 多版本 / 错 purpose」三个反向用例；顺便把 `secretRef` 与 `productionSuitable` 的装配路径纳入测试。

### 3. 低 — 20 KB 预算只补了 JSON 转义，仍未计遮盖膨胀，也未计数组引号/逗号/括号的固定开销
`apps/agent-service/src/production-owner-intent.ts:46-59`

问题：上一轮第 4 条说「未计 JSON 转义和遮盖膨胀」，增量只修了前半。`collectOwnerWords` 在遮盖之前用 `wireBytes` 计预算；真正的请求是在 `ownerIntentRequestBody` 里先 `redactForExternalText` 再拼 JSON，50 多个密码/验证码占位符可能把文本撑大。极端情况下仍会撞上 32 KB 的 `OWNER_INTENT_INPUT_TOO_LARGE`，最终按设计走卡片。另外，`wireBytes` 只算每个字符串的转义内容，实际数组还要多出最多约 `2n + (n-1) + 2 ≤ 19` 字节（n≤6）的引号和逗号，当前预算没算这部分（影响极小）。

证据：
```ts
// production-owner-intent.ts:46-48,98
function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}
...
remainingBytes -= wireBytes(kept);
```
```ts
// owner-intent-decision.ts:57-61,70-71
ownerWords: request.ownerWords.map(redact),
...
parameters: redactedValue(request.action.parameters, redact),
...
if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
  throw new OwnerIntentDecisionFailure("OWNER_INTENT_INPUT_TOO_LARGE");
```

建议：把预算改成「遮盖后的 wire 字节」计算（或在 20 KB 之外留出明确的遮盖/分隔符余量），并加一个反向用例：大量可被遮盖的短敏感值 + 接近上限的原文，断言要么仍在 32 KB 内，要么明确走卡片且不静默截断。

### 4. 低 — 把握用 `Math.round` 换算成 permille，略低于门槛的概率会被进位到门槛并放行
`packages/application/src/services/owner-intent-answer.ts:126-132`

问题：`explicit = Math.round(yes * 1000)`，而 `judgeOwnerIntent` 用的是 `confidence < minimumConfidence`。因此 `yes = 0.8996`（允许的 0.001 误差内）会先被进位成 900，`minConfidence = 900` 时判定通过，尽管真实概率低于 90%。偏差最多 0.05%，通常无害，但这是一个有意的舍入选择，应明确。

证据：
```ts
// owner-intent-answer.ts:126-132
if (Math.abs(yes + no - 1) > 0.001) invalidAnswer();
...
const explicit = Math.round(yes * 1000);
return Object.freeze({
  verdict: isExplicit ? "explicit" : "not_explicit",
  confidence: isExplicit ? explicit : 1000 - explicit,
```
```ts
// owner-intent-answer.ts:54
if (answer.confidence < minimumConfidence)
```

建议：如果门槛语义是「至少 90%」，显式用 `Math.floor(yes * 1000)` 或直接拿概率与 `minimumConfidence / 1000` 比较；如果保留四舍五入，补一个边界测试并在 ADR 写明。

### 5. 低 — `productionOwnerIntentGate` 的延迟取密钥、`productionSuitable`、secretRef→version 解析没有任何自动检查
`apps/agent-service/src/production-owner-intent.ts:104-158`

问题：重点查第 5 条「密钥只在需要时解析、不进日志和审计」依赖这段接线，但仓库里除 `service-main.ts:1604` 外没有测试引用 `productionOwnerIntentGate`；`production-owner-intent.unit.test.ts:3` 只测 `collectOwnerWords`。因此「构造时不解析、首次 check 才解析并缓存、失败后重置」这些行为没有反向用例守着，后续改动很容易变成启动即解析或重复解析。

证据：
```ts
// production-owner-intent.ts:110-113,137-148
const secret = resolveConfiguredSecretRequirement(configuration, settings.secretRef);
if (!secret) throw new Error("OWNER_INTENT_SECRET_REQUIRED");
if (!options.secretSource.productionSuitable)
  throw new TypeError("OWNER_INTENT_UNSAFE_SECRET_SOURCE");
...
apiKey: () => {
  apiKey ??= options.secretSource.resolve(secret.secretRef, secret.secretVersion).then(...);
  return apiKey;
},
```
（grep 全仓库，`productionOwnerIntentGate` 只出现在 `service-main.ts` 和定义处。）

建议：加一个用 spy `secretSource` 的单测：`enabled: false` 不解析、构造后 `resolve` 调用次数为 0、首次 `check` 调用一次且第二次不再调用、解析失败后缓存被清空；同时断言抛出的错误里不含密钥值。

## 推测（未运行验证）

- **Jev 响应若不带 `confidence` 字段，仍会全部拒绝。** 增量只删掉了「`confidence` 必须等于最大概率」的比较，`unitProbability(answer["confidence"])` 仍然要求该字段存在（`owner-intent-answer.ts:121`）。我没有 Jev 的响应 schema；提交结果里 `errors: 0` 说明这几次调用带了该字段，但不能证明所有真实响应都带。
- **`productionOwnerIntentGate` 在装配时抛错是否会让整个服务起不来，未验证。** 抛错本身是确定的（`production-owner-intent.ts:110-113`），但没有跑服务确认上层是否捕获。
- **`collectOwnerWords` 可能把空字符串放进 `words`。** 当剩余预算为正但小于下一个字符的转义字节时，`withinBytes` 返回 `""`，第 99 行仍会 `words.unshift("")`，循环继续。`OwnerIntentGate` 第 125 行会过滤空串，所以当前没有请求影响；只是返回值和单测语义略脏。
- **Jev 请求内部不是逐字节确定的。** `redactForExternalText` 的占位符按遇到顺序编号，`action.parameters` 的对象键顺序未规范化；逻辑相同的两次调用可能序列化成不同字节。这是独立后台调用、不进对话历史，所以不影响主模型 KV 缓存。

## 侧重检查

- **错误路径**：超时用 `AbortController` + `Promise.race`，超时/异常/`check_failed` 都返回 `confirmed:false`（`owner-intent-gate.ts:130-167`）；HTTP 非 2xx、JSON 解析失败、响应超 1 MB（流式累计后 `reader.cancel()`）、请求超 32 KB 都抛 `OwnerIntentDecisionFailure`（`owner-intent-decision.ts:94-118`, `:70-71`），最终走卡片。已核对。
- **不合规范/不可信输入**：只取 `user_message`、有线程、当前消息是主人本人且 `contentRef` 与 `payloadRef` 一致、已提交、`public/private`、最近 6 条、跳过确定性敏感文本、每条 2000 字符、总量 20 KB（`production-owner-intent.ts:66-101`）；payload 用 `TextDecoder("utf-8",{fatal:true})`，解码失败被 `.catch` 吞掉并跳过；Jev 答案严格校验 model、恰好一个答案、`type/name/choice`、概率集合恰好两个且和为 1、`choice` 必须是最大概率（`owner-intent-answer.ts:104-134`）。已核对。
- **安全/密钥**：密钥只出现在 `authorization` 头（`owner-intent-decision.ts:87`），不在请求体；审计和状态记录只写 `model/minConfidence/externalSources/verdict/confidence/quote/checkedAt`（`owner-intent-gate.ts:177-186,212-220`），不含密钥。`getSecret` 延迟解析并在失败时清缓存（`production-owner-intent.ts:137-148`）。已核对，但无自动测试（见意见 5）。
- **资源耗尽**：请求 32 KB、响应 1 MB、最多 6 条/20 KB 主人原话、eval 有 `CAP_USD` 花费上限并逐次扣费。已核对。
- **不可撤销操作**：`ownerIntentEligible` 要求 `reversible`、`finalRisk === "MEDIUM"`、`actionKind === "CREATE_OR_UPDATE"`、`disclosure === "none"`、非长期规则、非本人必须在场（`owner-intent-gate.ts:60-86`），高风险/不可撤销仍走主人点头。已核对。
- **规则/文档与代码一致**：ADR 的配置键 `{enabled,minConfidence,timeoutMs,model,secretRef}` 与 `parseOwnerIntentCheck` 的键名和范围一致；提示词 `authorization.owner-intent-question` 在 manifest 和 `parseOwnerIntentDecision` 的 parser 注册一致；增量把 `modelRef` 改成 `model` 后，生产端和测试端都用了 `model`。不一致处见意见 1（评测产物/默认门槛）和意见 2（secretRef 两端校验）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不涉及主对话的请求开头。增量只改了独立的 Jev `/decisions` 后台调用、它的解析和评测；新增提示词只被 `packages/platform-node/src/owner-intent-decision.ts:46` 和评测脚本使用，没有进入聊天系统提示、工具定义或历史。发给主模型的内容仍然只在末尾追加，每轮会变的值仍应只在最后一条用户消息里（主模型侧本轮没有改动）。Jev 调用本身是「固定提示词在前、本次数据在后」的单次调用，不进历史。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
主模型请求不涉及。对 Jev 后台调用：`ownerWords` 的顺序是确定的（按 sequence 排序后 `unshift`），但 `action.parameters` 的对象键顺序没有规范化，遮盖占位符也按每次请求的遇到顺序重新编号，所以逻辑相同的两次调用理论上可能序列化成不同字节；这不会进入对话历史，也不参与主模型 KV 缓存，因此不构成「已见请求前缀变化」。如果要让后台调用也逐字节可复现，需要把参数键排序后再序列化。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
- JSON 转义预算：有，`apps/agent-service/test/production-owner-intent.unit.test.ts:103-114` 用 `\u0001` 构造 6 条消息；若退回按 UTF-8 计预算（旧实现），6 条都会保留、`wire` 约 4 万，断言会失败，是有效的反向用例。
- 解析器：`packages/platform-node/test/owner-intent-decision.unit.test.ts:239-250` 覆盖「`confidence` 与最大概率不同时按概率判定」的新行为；原来的 `confidence disagrees` 反向用例被换成 `confidence out of range`（:216-219），所以「不匹配但在范围内必须接受」只有正向用例。`OWNER_INTENT_INPUT_TOO_LARGE` 有测试（:86-95），`OWNER_INTENT_RESPONSE_TOO_LARGE` 没有测试。
- 评测：`legitAutoAllowed > 0` 只能挡住恒定 `not_explicit`，见意见 1；没有覆盖「几乎恒 `not_explicit`」。
- 未覆盖：`productionOwnerIntentGate` 的密钥解析/`productionSuitable`（意见 5）、遮盖膨胀（意见 3）、`secretRef` 未声明（意见 2）。

**4. 每个新产生/修改的值，产生端和使用端都能接受吗？**
- `model`：配置解析用 `safeReference`（允许 `/`、`:` 等），`typesafe-ai/jev` 能通过；使用端把它原样发给 Jev 并写进状态记录，两端没有额外格式冲突。已核对。
- `secretRef`：配置解析只认格式，使用端 `resolveConfiguredSecretRequirement` 要求恰好一条已声明引用；两端不一致，见意见 2。
- 解析器返回的 `verdict`/`confidence`：`parseOwnerIntentDecision` 产出 0–1000 的整数，`judgeOwnerIntent` 接受 0–1000 整数并与 `minConfidence` 比较，两端一致（边界见意见 4）。
- 20 KB 预算/请求体：`collectOwnerWords` 用 `wireBytes` 产出字符串，`ownerIntentRequestBody` 用同样的字符串再快速遮盖并拼 JSON；转义已对齐，但遮盖膨胀和数组固定开销未对齐，见意见 3。
- eval 的 `legitAutoAllowed`/`wrongIds`：只被 eval 断言消费，类型和语义一致，但门槛过弱，见意见 1。
