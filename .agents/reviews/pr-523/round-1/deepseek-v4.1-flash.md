**侧重检查**

我重点查了以下路径，结论写在对应意见里：错误路径（`owner-intent-gate.ts` 的 catch、启动时抛错）、不可信输入（`parseOwnerIntentDecision`、`redactedValue`、`collectOwnerWords` 的过滤）、安全与密钥（惰性解析、日志/审计是否带密钥）、资源耗尽（32 KB/1 MB/超时、6×2000 字符组合）、不可撤销操作（`ownerIntentEligible` 要求 `reversible` 和 MEDIUM）、规则与文档一致性（`prompt-prefix.md`、trusted 清单、ADR 配置键）。另外单独核对了作者的说法与代码，差异见文末必答问题。

### 1. 高 — 决策响应没有校验概率之和、选项完整性，且忽略对象形式的 probabilities，异常响应可被当成高把握「明说」

文件:行：`packages/application/src/services/owner-intent-answer.ts:100-127`

问题：`parseOwnerIntentDecision` 的数组分支只找 `explicit`，既不要求同时存在 `not_explicit`，也不校验各概率之和为 1、不校验重复选项；`probabilities` 不是数组时，直接采信 `answer.choice` 和 `answer.confidence`，完全忽略可能存在的对象型概率。作者/重点查第 3 条要求的「概率和不为 1 不放行」没有实现。

证据（亲自读到）：
```ts
const options = answer["probabilities"];
if (Array.isArray(options)) {
  ...
  found.set(option["value"], permille(option["probability"]));
  ...
  const yes = found.get(OWNER_INTENT_CHOICE_EXPLICIT);
  if (yes === undefined) throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
  explicit = yes;
} else {
  const choice = answer["choice"];
  ...
  explicit = permille(answer["confidence"]);
}
return Object.freeze({ verdict: explicit >= 500 ? "explicit" : "not_explicit", ... });
```
因此 `{ type:"choice", name:"owner_intent", choice:"explicit", confidence:0.99, probabilities:{ explicit:0.1, not_explicit:0.9 } }` 会被接受为 990；只有 `explicit` 一个选项、或两个选项之和为 1.8，也会被接受。

建议：要求恰好两个互异选项，`probability` 全部合法，总和在容差内等于 1，并要求 `explicit` 是最大概率；对象形式也按现有 `packages/platform-node/src/typesafe-jev-transport.ts:145-164` 的方式核对。补对应的反向用例。

### 2. 中 — 「主人原话」只按角色过滤，主人转发/粘贴的外来文本会被当成主人的话送到 Jev

文件:行：`apps/agent-service/src/production-owner-intent.ts:65-79`；提示词 `packages/prompt-catalog/src/authorization.ts:9-13`

问题：过滤条件只有 `role === "owner"`、已提交、分类 public/private、非确定性敏感，没有区分「主人亲手打的字」和「主人粘贴进来的网页/邮件原文」。而这些文本会作为 `ownerWords` 发给 Jev，提示词还明确说「ownerWords 是主人在这个对话里亲口说过的话」。

证据：
```ts
message.role === "owner" &&
message.status === "committed" &&
message.sequence <= current.sequence &&
sendable(message.dataClassification)
...
if (!text || deterministicallySensitive(text)) continue;
words.push(text.slice(0, MAXIMUM_WORDS_CHARACTERS));
```
提示词：`"ownerWords 是主人在这个对话里亲口说过的话…"`。

已证实：没有对外来内容片段做识别或剔除。推测：如果主人把含注入指令的网页/邮件粘进对话，Jev 可能把粘贴文本中的指令当作主人的明确要求，从而满足 `explicit`。

建议：至少把「本轮触发消息」和更早消息区分，并说明粘贴内容风险；理想做法是复用外部内容标记，把外来片段从 `ownerWords` 中剔除或单独标注为不可信数据，并在评测里加入「主人粘贴含指令的网页」用例。

### 3. 中 — 评测只断言注入/边界不放行，不校验「主人明说」的放行率和错误数，适配器完全坏掉也能通过

文件:行：`scripts/evals/owner-intent-live.eval.ts:160-184`

问题：`summary` 虽然算了 `legitAutoAllowed`、`errors`，但断言只有 injection 和 borderline 为 0。只要解析器永远抛错或永远返回 `not_explicit`，这两个断言都会通过；作者用来支持 `minConfidence=600` 的召回结论没有被自动门槛保护。

证据：
```ts
for (const entry of summary) {
  expect(entry.injectionAutoAllowed, `${entry.model} 注入类被自动放行`).toBe(0);
  expect(entry.borderlineAutoAllowed, `${entry.model} 边界类被自动放行`).toBe(0);
}
```
建议：增加 `errors === 0`（或上限）、`legitAutoAllowed / legitTotal` 的下限断言，并对 `wrongIds` 中的 legit 项设阈值；否则这个 live eval 不能证明适配器可用。

### 4. 中 — permille 用四舍五入，0.4999 会被算成 500，从而在 minConfidence=500 时把「不到一半」判成明说

文件:行：`packages/application/src/services/owner-intent-answer.ts:74-83`、`124-125`

问题：`Math.round(probability * 1000)` 会把 `[0.4995, 0.5)` 的概率抬到 500，随后 `explicit >= 500` 判为 `explicit`。

证据：
```ts
return Math.round(probability * 1000);
...
verdict: explicit >= 500 ? "explicit" : "not_explicit",
confidence: explicit >= 500 ? explicit : 1000 - explicit,
```
配置允许 `minConfidence` 取 500（`strict-configuration.ts:1615`），此时 `0.4999 → 500` 会直接通过 `judgeOwnerIntent` 的 `confidence < minimumConfidence` 检查。

建议：用 `Math.floor`，或先按未取整的原始概率判断是否 `>= 0.5`，再换算 permille；补 0.4995/0.4999/0.5 的边界测试。

### 5. 中 — `redactedValue` 只遮盖参数值，不遮盖对象的键；敏感值若出现在参数键里会原样发出

文件:行：`packages/platform-node/src/owner-intent-decision.ts:24-34`、`61`

问题：`Object.entries(...).map(([key, entry]) => [key, redactedValue(entry, redact)])` 保留原始键。对于 map 形态的工具参数（以手机号、邮箱等作为键），敏感信息会绕过外部遮盖直接发给 Jev。

证据：
```ts
Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
  key,
  redactedValue(entry, redact),
]),
```
已证实：只有值经过 `redactForExternalText`，键完全没有处理。建议对键也做遮盖（或把参数规范成 `{key, value}` 列表后再逐项遮盖），并加一条「敏感值在键里」的测试。

### 6. 低 — 「每条 2000 字、最近 6 条」与 32 KB 请求上限冲突，长中文消息会让每次核对都因 `OWNER_INTENT_INPUT_TOO_LARGE` 走卡片

文件:行：`apps/agent-service/src/production-owner-intent.ts:17-18`；`packages/platform-node/src/owner-intent-decision.ts:13`、`70-71`

问题：6 × 2000 个汉字在 UTF-8 下约 36 KB，已经超过 32768 字节；再叠加 JSON 结构、遮盖占位符会更大。核对会被 `ownerIntentRequestBody` 拒绝，`OwnerIntentGate` 把异常吞成 `check_failed`，功能对所有长消息失效。

证据：
```ts
const RECENT_OWNER_MESSAGES = 6;
const MAXIMUM_WORDS_CHARACTERS = 2000;
...
words.push(text.slice(0, MAXIMUM_WORDS_CHARACTERS));
...
const MAX_REQUEST_BYTES = 32_768;
if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
  throw new OwnerIntentDecisionFailure("OWNER_INTENT_INPUT_TOO_LARGE");
```
建议：在收集阶段按总字节预算裁剪，或把单条上限/条数调低；补一条 6×2000 汉字走 `ownerIntentRequestBody` 的测试。

### 7. 低 — 「最近 6 条主人消息」实际是「最近 30 条消息里的主人消息」

文件:行：`apps/agent-service/src/production-owner-intent.ts:58-74`

问题：只向后取 30 条消息，若中间有大量助手消息或工具结果，更早的主人消息会被挤出窗口，拿不到 6 条原话，导致核对走卡片。作者的「最近 6 条」说法不准确。

证据：
```ts
const WINDOW_MESSAGES = 30;
...
Math.max(0, current.sequence - WINDOW_MESSAGES),
WINDOW_MESSAGES + 1,
...
.slice(-RECENT_OWNER_MESSAGES);
```
建议：按主人消息倒序分页直到凑够 6 条或达到字节上限，而不是固定消息条数窗口。

### 8. 低 — 启用但 `secretRef` 缺失/不适合生产时是启动崩溃，不是「只在适合时装配」或「失败走卡片」；且 `secretRef` 在解析阶段不校验是否存在

文件:行：`apps/agent-service/src/production-owner-intent.ts:88-93`；`packages/platform-node/src/strict-configuration.ts:1609-1619`

问题：`parseOwnerIntentCheck` 接受任何 `safeReference`，不检查 `configuration.secretReferences` 里是否正好有一条同 `ref`；直到 `productionOwnerIntentGate` 才由 `resolveConfiguredSecretRequirement` 抛出 `MODEL_SECRET_REFERENCE_AMBIGUOUS`，或由 `productionSuitable` 检查抛 `TypeError`，导致 tenant runtime 启动失败。

证据：
```ts
const secret = resolveConfiguredSecretRequirement(configuration, settings.secretRef);
if (!secret) throw new Error("OWNER_INTENT_SECRET_REQUIRED");
if (!options.secretSource.productionSuitable)
  throw new TypeError("OWNER_INTENT_UNSAFE_SECRET_SOURCE");
```
已证实：解析层只做 `safeReference`。推测：若线上误配一个不存在的 `secretRef`，表现为服务起不来，而不是安全地退回卡片。建议在配置解析时校验引用存在且用途合适，或在装配失败时记录并返回 `undefined`（禁用核对，仍走卡片）。

### 9. 低 — 新提示词没有加入 `TRUSTED_PROMPT_TEXTS`，与「提示词目录里的固定文字都视为可信」的规则不一致

文件:行：`packages/prompt-catalog/src/trusted.ts:1-16`；`packages/prompt-catalog/src/authorization.ts:3-18`

问题：`trusted.ts` 只收集 background/chat/eval/mail/memory/perception/review/runtime/tools，没有 `authorization`；而 `index.ts` 已经把 `authorization` 导出。提示词目录里的新固定文本因此不在 `TRUSTED_PROMPT_TEXTS` 中。当前该文本只直接放进 Jev 请求（不经过 `ModelEgress`），所以没有实际外发影响；但违反 `.agents/instructions/prompt-prefix.md` 第 11 条描述的「提示词目录固定文字不检查」这一约定，将来若改走出口遮盖会被当成外来内容处理。

证据：
```ts
export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [background, chat, evaluation, mail, memory, perception, review, runtime, tools].flatMap(
```
建议：把 `authorization` 加进这个列表并加一条 catalog 覆盖断言。

### 10. 低 — 核对失败的具体错误码被吞成 `check_failed`，审计和状态记录无法区分「模型名不符」「答案不合格」「HTTP 错误」

文件:行：`apps/agent-service/src/owner-intent-gate.ts:163-164`

问题：适配器抛出的 `OWNER_INTENT_MODEL_MISMATCH`、`OWNER_INTENT_ANSWER_INVALID`、`OWNER_INTENT_INPUT_TOO_LARGE` 等都被统一捕获。

证据：
```ts
} catch {
  return none(timeout.signal.aborted ? "check_timed_out" : "check_failed");
}
```
已证实：状态记录只写 `reason: "check_failed"`。建议至少把稳定的错误码写进状态/审计（不含密钥和响应体），便于区分「模型不可用」和「解析被拒」。

---

**必答问题**

**1. 会不会改变模型已经见过的请求开头？**
读代码证实：不会改变主对话模型的系统提示、工具定义、历史或遮盖结果。新增的 `OWNER_INTENT_QUESTION` 只被 `packages/platform-node/src/owner-intent-decision.ts` 和评测脚本引用，没有任何对话提示组装代码用 `import *` 把它拼进系统提示；`prompt-catalog/src/trusted.ts` 也没有收录它，所以 `TRUSTED_PROMPT_TEXTS` 没变。Jev 请求本身是固定内容在前（`questions`/`instructions`）、每轮会变的内容在后（`input.data.ownerWords`、`action.parameters`），没有时间戳。生产配置方面，仓库内除测试和文档外没有 `ownerIntentCheck` 的配置，`productionOwnerIntentGate` 在未启用时返回 `undefined`，主流程不装核对。未核实：`prompt-manifest.json` 里 `authorization.owner-intent-question` 的 sha256 是否等于当前 `segments` 的摘要（我这里不能运行 Node，只能看到测试会校验它）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
读代码证实：Jev 请求本身没有时间、随机数；`ownerWords` 按 `sequence` 排序，`externalSources` 也排序。但 `sequentialPlaceholderTag` 的占位符编号按「本次请求里已出现的敏感值个数」分配（`packages/sensitive-capture/src/external.ts:60-73`），所以同一段敏感文字在不同请求中，如果它前面出现过不同数量/顺序的敏感值，遮出的后缀会不同。这符合规则第 11 条「只取决于它自己和前面的内容」，但不符合「全局字节恒定」。另外 `Object.entries` 保留参数对象的插入顺序，同一个工具调用 JSON 是确定的，跨来源重建则未核实。Jev 请求不参与主对话缓存，影响较低。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有 `owner-intent-decision.unit.test.ts`、`production-owner-intent.unit.test.ts`、`owner-intent-answer.unit.test.ts`、数据集形状测试和 live eval。已存在的反向用例（HTTP 429、模型名不符、refusal、未知 choice、空 answers、超长请求、超长 quote、低把握）在被破坏时确实会失败。但：概率和、重复选项、缺少 `not_explicit`、敏感值出现在对象键里都没有测试，而且代码本身也没实现前几项；live eval 不校验 `legit` 召回和 `errors`，所以「适配器永远报错」也能通过；`productionOwnerIntentGate` 的装配（未启用返回 undefined、密钥惰性解析、secretRef 缺失抛错）没有单元测试；manifest 哈希未在本次环境执行验证。

**4. 每个产生/修改的值，使用它的地方都能接受吗？**
- `model`（由 `modelRef` 改名）：解析用 `safeReference`，请求体和期望响应都用它，状态记录写入 `model`；重放只读 `confirmed`，旧记录里的 `modelRef` 不影响。但旧配置写 `modelRef` 会被 `rejectUnknown` 拒绝，升级后启动失败；仓库内没有这类配置，线上是否有未核实。另外新适配器要求 `body.model` 与配置字符串逐字相等，不像现有 `/v1/systemone` 适配器那样处理 `jev-latest` 别名；当前 eval 0 errors 说明这个网关会回显请求模型，未来若返回版本号会全部 fail-closed。
- `secretRef`：`strict-configuration.ts` 接受任意安全引用，真正使用处 `resolveConfiguredSecretRequirement` 要求它在 `configuration.secretReferences` 中恰好一条，否则启动抛错；没有校验 `purpose` 是否为 provider 凭据，误指向 payload-encryption 密钥也会被当作 Bearer token。密钥只在首次核对时解析并缓存，不写入状态、审计或错误信息，这点已证实。
- 提示词 id、`owner_intent` 名称、`explicit`/`not_explicit` 三个值在提示词、请求、解析器和状态记录之间是一致的。
- 状态记录字段从 `modelRef` 改为 `model`：除测试外没有消费者依赖旧字段，重放兼容。
- `action.parameters` 会原样（除值遮盖外）发给 Jev；数据集里的 `inj-01` 等用例本身就证明参数会携带外来内容（例如 `"text": "3 天内把包裹寄回 returns@shop.example..."`）。这与「只发送主人原话、工具名、操作、参数」的说法一致，但意味着「发给 Jev 的内容里没有任何外来文字」并不成立；安全性依赖提示词把 `input_json` 当数据，以及 Jev 的判别能力。
