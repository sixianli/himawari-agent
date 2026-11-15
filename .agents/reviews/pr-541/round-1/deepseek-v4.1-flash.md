复核范围：`git diff 283d392..a45e148` 的 25 个文件，另读了 `production-think-inbox.ts`、SQLite 的 think-inbox 操作、`owner-intent-decision.ts`、`voice-addressee-decision.ts`、`prompt-prefix.md`、`trusted.ts` 及提示词/配置测试。没有运行测试，测试结论来自读代码。

### 1. 中 — 调用方传入取消信号时，`runTimeoutMs` 完全失效
文件：`apps/agent-service/src/production-think-worker.ts:86-90`

问题：运行器的超时只在与 `signal` 同时不存在时才生效；一旦调用方传入信号（例如服务关闭用的长生命信号），`runTimeoutMs` 根本不参与。

证据：
```ts
const run = await this.#options.runner.think({
  entry,
  summary,
  signal: signal ?? AbortSignal.timeout(this.#options.runTimeoutMs),
});
```
同一文件的判断调用是正确的合并写法（`production-think-worker.ts:129`）：
```ts
signal ? AbortSignal.any([signal, timeout]) : timeout,
```
项目里同类运行也有正确写法：`production-run-memory.ts:319-320`。

影响：未来的运行器若不响应信号而挂起，`runOnce` 永不返回，条目一直停在 `thinking`；由于 `maintain()` 也在 `runOnce` 里，下一次维护也不会发生，不是等 30 分钟就能恢复，而是直到进程退出。

建议：改成同样合并：
```ts
signal: signal
  ? AbortSignal.any([signal, AbortSignal.timeout(this.#options.runTimeoutMs)])
  : AbortSignal.timeout(this.#options.runTimeoutMs),
```
并补一条“回环桩不返回、传入长生命信号”的反向用例。

（读代码证实。）

### 2. 中 — `worth.secretRef` 只校验格式，没有和 `secretReferences` 及用途对账
文件：`packages/platform-node/src/strict-configuration.ts:1426-1427`、`2200-2206`；测试 `packages/platform-node/test/startup-configuration.unit.test.ts:1958`

问题：新配置的密钥引用能被启动校验接受，即使它没有在 `configuration.secretReferences` 里声明，或用途不是 `model-auth`。同类配置 `importDuplicates` 有这道对账。

证据：新代码只做 `safeReference`：
```ts
secretRef: safeReference(input["secretRef"], `${field}.secretRef`),
```
而 `importDuplicates` 在全局校验里有：
```ts
if (runPolicy?.importDuplicates)
  assertIdentitySecretReference(
    secretReferences,
    runPolicy.importDuplicates.secretRef,
    "model-auth",
    "configuration.runPolicy.importDuplicates.secretRef",
  );
```
新测试甚至用一个未声明的引用并期望成功：
```ts
const worth = { model: "typesafe-ai/jev", secretRef: "think-worth-key" };
...
expect(parsed?.worth).toMatchObject(thinkInbox.worth);
```
`importDuplicates` 的测试则明确把 `{ ...base, secretRef: "missing-secret" }` 列为必须失败（`startup-configuration.unit.test.ts:2246-2256`）。

影响：上线配置写错密钥引用时启动不会报错，等工人接线后才会在运行时解析失败；这正是 I-73 那类“两端校验只看了一端”的缺口。

建议：在 `parseProductConfiguration` 里给 `runPolicy.thinkInbox.worth.secretRef` 增加 `assertIdentitySecretReference(..., "model-auth", ...)`，并把测试改成使用已声明的 `model-auth` 引用，另加 `missing-secret` 反向用例。

（读代码证实。）

### 3. 低 — 取消信号被当成判断失败，条目以 `failed` 终态结束，之后无法再处理
文件：`apps/agent-service/src/production-think-worker.ts:77-83`；`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:204-241`、`124-134`

问题：判断阶段任何 `AbortError` 都被归为 `worth_unavailable` 并写成 `failed`。`failed` 是终态：`finish` 只把 `thinking` 改成终态，`recoverStalled` 只重扫 `thinking`；同一来源同一版本再次入队会命中唯一键返回 `duplicate`，不会重新排队。因此一次优雅关闭或调用方取消就可能永久丢掉一件待处理的事。

证据：
```ts
const verdict = await this.#decide(entry, source.describe, summary, signal).catch(
  (error: unknown) => {
    this.#options.onFailure?.(entry.id, error);
    return undefined;
  },
);
if (verdict === undefined) return await settle("failed", "worth_unavailable");
```
`finish` 的 SQL 只匹配 `status = 'thinking'`；`recoverStalled` 的恢复 SQL 只处理 `status = 'thinking'`。

影响：这不一定是作者有意接受的“失败就不想”，但“调用方取消”不是判断服务失败；如果未来工人把服务关闭信号传进来，关闭时正在判断的条目会被标成 `failed` 而不是留待重试。

建议：区分超时和取消（例如检查 `signal?.aborted` 或 `AbortError`），取消时不要写 `failed`，留给 `recoverStalled` 重试（或增加明确的“放回队列”路径）；至少在 ADR 里写明这一取舍。

（取消路径和 `failed` 终态是读代码证实；未来调用方会传长生命关闭信号是推测。）

### 4. 低 — 新提示词没有加入 `TRUSTED_PROMPT_TEXTS`，与规则文件说法不一致
文件：`packages/prompt-catalog/src/trusted.ts:12-15`；`packages/prompt-catalog/src/think.ts:3`

问题：规则 `prompt-prefix.md:55` 说提示词目录里不少于 24 个字符的固定文字由 `TRUSTED_PROMPT_TEXTS` 清单保护，但 `trusted.ts` 手工列出的模块里没有新增的 `think`。

证据：
```ts
export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [background, chat, evaluation, mail, memory, perception, review, runtime, tools].flatMap(
    (module) => Object.values(module),
  ),
);
```
没有 `think`，而 `think.ts` 的 `THINK_WORTH_QUESTION.text` 是一整段固定文字。

影响：目前 Jev 请求把这段文字放在 `questions.instructions` 里直接发送，不经过出口遮盖，所以没有实际的漏遮；但它不在文档所说的“固定文字清单”里，属于规则和代码不一致。以后若这段文字进入需要遮盖的路径，或提示词里加入数字/“验证码”类词，就会被当成外来内容处理，可能改变遮盖结果。

建议：把 `think` 加进 `trusted.ts`，或在 ADR/规则里说明为什么后台判断指令不进入这个清单。

（读代码证实清单遗漏；功能影响目前没有。）

### 5. 低 — 关键错误路径缺少自动反向用例，第 1 条问题不会被现有测试抓到
文件：`test/integration/think-worker.test.ts:177-216`；`packages/platform-node/test/think-worth-decision.unit.test.ts:88-106`

问题：现有测试覆盖了“服务 503”“运行器抛错”“不想/不确定”“正常提议”，但没有覆盖判断超时、调用方取消、读摘要抛错、`finish` 抛错、响应体超过 1 MiB。因此作者说的“超时后一定走不想”没有自动用例；第 1 条 `runTimeoutMs` 失效也不会有测试失败。

证据：`think-worker.test.ts` 最后一个用例只覆盖：
```ts
expect(await run.runOnce()).toMatchObject({ outcome: "failed", reasonCode: "think_failed" });
expect(await run.runOnce()).toEqual({ status: "idle" });
```
适配器测试覆盖 HTTP 错误、畸形响应和请求超限，但没有响应超限：
```ts
expect(() =>
  thinkWorthRequestBody("typesafe-ai/jev", { ...request, summary: "字".repeat(40_000) }),
).toThrow("THINK_WORTH_INPUT_TOO_LARGE");
```

建议：补反向用例：判断桩永不返回 + 短 `requestTimeoutMs`；判断中途 `controller.abort()`；运行器永不返回 + 长生命 `signal` + 短 `runTimeoutMs`；`payloads.get` 抛错；`store.finish` 抛错；返回超过 1 MiB 的响应体。

（读代码证实测试缺失。）

### 6. 低 — 运行器返回的 `reasonCode` 没有和存储层 64 字符上限对账
文件：`apps/agent-service/src/production-think-worker.ts:12-15`、`91`；`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:205-208`

问题：`ThinkRunner` 允许返回任意字符串 `reasonCode`，工人直接交给 `finish`；存储层只允许最长 64 个字符。未来运行器若返回更长的原因代码，`finish` 会抛错，外层 `catch` 把一次已经成功的运行改记成 `failed`/`think_failed`。

证据：
```ts
export interface ThinkRunResult {
  readonly outcome: "proposed" | "skipped";
  readonly reasonCode: string;
}
...
return await settle(run.outcome, run.reasonCode);
```
```ts
const reasonCode = this.text(input.reasonCode, 64, "reason code");
```

建议：把运行器的原因代码收窄成有限集合，或在工人里对长度做校验/截断，放在交给 `finish` 之前。

（代码路径证实；未来运行器会返回超长值是推测。）

### 7. 低 — HTTP 错误或声明超限时没有取消响应体
文件：`packages/platform-node/src/think-worth-decision.ts:79-82`

问题：非 2xx 和 `content-length` 超限时直接抛错，没有 `response.body?.cancel()`。同类 `voice-addressee-decision.ts:109-117` 在这两种情况下都会先取消 body。

证据：
```ts
if (!response.ok) throw new ThinkWorthDecisionFailure(`THINK_WORTH_HTTP_${response.status}`);
const declared = Number(response.headers.get("content-length") ?? 0);
if (declared > MAX_RESPONSE_BYTES)
  throw new ThinkWorthDecisionFailure("THINK_WORTH_RESPONSE_TOO_LARGE");
```
对照：
```ts
if (!response.ok) {
  await response.body?.cancel();
  throw new VoiceAddresseeDecisionFailure(...);
}
```

影响：可能让连接/流多存活到 GC；现有 `owner-intent-decision.ts` 也有同样写法，所以不是这次新引入的独有问题，但这是新出口，最好按更新的写法做。

建议：两处抛错前都 `await response.body?.cancel()`。

（读代码证实差异；实际泄漏程度是推测。）

## 侧重检查

- **错误路径**：判断失败/超时/取消/畸形响应都会走 `failed`；读摘要抛错走 `think_failed`；`finish` 抛错会重试一次，仍失败则条目留在 `thinking`，靠后续 `recoverStalled`（30 分钟后、最多 3 次）兜底；`onFailure` 回调自己抛错会让 `runOnce` 抛出并把条目留在 `thinking`。取消不是“留在 thinking”，而是第 3 条的终态 `failed`。
- **不可信输入**：Jev 响应的模型名、答案数、题型、题名、选项名、重复选项、概率范围、概率和、所选是否最大都有校验；`confidence` 只校验为 0 到 1，未和概率一致性对账，但代码不使用它，所以我不单列为问题。摘要/来源说明先遮盖再发；请求 32 KiB、响应 1 MiB 双向限流。
- **安全**：`zeroDataRetention: true` 有设置；两个字符串字段都过 `redactForExternalText`；提示词明确把 summary 当数据；本调用不带工具，注入最多影响“值不值得想”这个布尔判断。密钥引用配置的对账缺口见第 2 条。`baseUrl` 默认 HTTPS，测试可覆盖。
- **资源耗尽**：请求/响应大小有限制，判断有超时；运行器超时存在第 1 条的漏洞；非 2xx 响应体不取消见第 7 条。
- **不可撤销操作**：工人写 `proposed`/`skipped`/`failed` 都是终态；取消导致的 `failed` 不可重试，见第 3 条。没有其他删除/外发副作用。
- **规则和文档一致性**：新的提示词 id、清单项、解析器名、问题名和选项常量两端一致；`prompt-manifest` 摘要由 `prompt-catalog.unit.test.ts` 自动核对（哈希值未独立重算，标“未核实”）；`trusted.ts` 遗漏见第 4 条；ADR 0274 的输入字段与代码一致。
- **未核实**：没有运行任何测试；`prompt-manifest.json` 的 sha256 未重算；AI Gateway 是否真正执行 `zeroDataRetention` 无法从本地代码验证；ADR 的 `plan-claims` 结果未核实。

## 作者说法核对

1. “判断失败、解析失败、超时、模型名不符一律不想，记 `failed`/`worth_unavailable`”：基本属实，模型名/HTTP/解析/请求超限/超时/取消都会走到这条路径。补充：读摘要失败是 `summary_missing` 或 `think_failed`，不是 `worth_unavailable`；取消也被归到这里，见第 3 条。
2. “中间带当不确定，记 `skipped`/`worth_unsure`”：属实，`judgeThinkWorth` 是 `>= yes` 想、`<= no` 跳过、其余不确定，且配置保证 `no < yes`。
3. “发给 Jev 的只有来源说明、一句概括、是否外部内容，且先过遮盖”：属实。`sourceKind` 没被序列化，序列化的数据只有 `source`、`summary`、`externalContent`，两个字符串都经过 `redactForExternalText`；固定题目和选项不算数据字段。
4. “运行器抛错时条目记 `failed`/`think_failed`，工人不抛出”：运行器抛错本身属实，工人会返回 `done`。但严格说“工人不抛出”不成立：`claimNext`、`clock.now()`、`onFailure` 回调抛错时 `runOnce` 仍会拒绝；`finish` 连续失败时条目会暂时留在 `thinking`（靠 `recoverStalled` 兜底）。
5. “工人一次只处理一条，每次先做维护”：属实，`maintain()` 在 `claimNext` 之前，且 `runOnce` 只处理一条。
- “没有任何调用方接入工人，合并后生产行为不变”：属实；全仓库只有测试引用 `ProductionThinkWorker`。配置解析和提示词目录新增只在测试/未来接线时生效。
- “配置测试覆盖”：有测试，但密钥引用测试把未声明的 `secretRef` 当合法值，见第 2 条。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这是新增的独立 Jev 请求，没有拼接任何对话历史，也没有改系统提示、工具定义、历史消息或主对话的遮盖；主模型看到的字节不受影响。新请求本身也是固定的在前：`questions.instructions` 是固定提示词，`input` 里的来源/摘要/外部标记是可变数据，符合“后台调用固定在前、会变的在后”。（依据：[prompt-prefix#rules](../../.agents/instructions/prompt-prefix.md#rules)）
2. **同一份完整输入会得到同样的字节，但同一段摘要单独看可能因前面的字段而不同。** JSON 键顺序、选项顺序、题目顺序都是写死的，没有时间戳、随机数或无序集合；`sequentialPlaceholderTag` 也是按遇到顺序生成。不过 `sourceDescription` 和 `summary` 共用同一个 `known`/`tag` 遮盖上下文（`think-worth-decision.ts:26-29,36-39`），所以同一段 `summary` 若换一个带不同秘密的 `sourceDescription`，占位符字母可能不同。这是“只依赖自己和前面内容”的遮盖，且每次调用是全新的独立请求，不涉及已发历史的字节变化；对 KV 缓存没有影响。
3. **有自动检查，但覆盖不完整。** 解析器单测有 12 组坏输入，配置测试有越界/缺字段/未知键反向用例，工人有 503、运行器抛错、不想/不确定用例，适配器有遮盖、HTTP 错误、畸形响应、请求超限用例，提示词清单有摘要校验。把解析器放宽或让配置接受非法值，这些反向用例会失败。缺口是：判断超时、取消、读摘要抛错、`finish` 抛错、响应超限都没有用例；第 1 条的运行器超时漏洞因此不会被发现；第 2 条的未声明密钥反而被测试当成合法值。manifest 哈希和测试是否实际通过未核实。
4. **大部分值两端一致，但有一个明确的缺口。** `think.worth-question` 的 id、manifest 项、`usedBy` 路径和 `parseThinkWorthDecision` 名称一致，且有目录测试；`think_worth`、`worth`、`not_worth` 在适配器和解析器共用同一组常量；`proposed`/`skipped`/`failed` 是 `finish` 接受的值，现有 reason code 都在 64 字符内；两个门槛的默认值和配置键名在 `parseThinkWorth`、`THINK_WORTH_DEFAULTS`、`judgeThinkWorth` 三处一致；`worth` 缺省时 `parseThinkInbox` 用展开保留其他字段。缺口有两处：`worth.secretRef` 没有和 `configuration.secretReferences`/`model-auth` 用途对账（第 2 条）；运行器返回的任意 `reasonCode` 没有和 `finish` 的 64 字符校验对账（第 6 条）。
5. **配置解析的缺省值和非法值处理正确。** 缺省是 700/300/15000；`yesAtLeastPermille` 只收 501–1000，`noAtMostPermille` 只收 0–499，`no < yes`，`requestTimeoutMs` 只收 500–120000；`worth` 缺省时 `thinkInbox` 其他字段不受影响。测试覆盖了这些默认值和多数非法值，但没有测 `worth` 与其他 `thinkInbox` 字段同时出现，也把未声明的 `secretRef` 当成合法值（第 2 条）。另外工人侧的 `worth.yesAtLeastPermille`/`noAtMostPermille` 是可选的原始数字，工人没有再校验 `no < yes`，只依赖上游配置解析保证。
