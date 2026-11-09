## 结论（按严重度）

### 1. 中低：`classification_lower` 会盖过工具/模型等变更，导致“提示和工具不变”的前提不成立，却仍沿用旧规则版本

- 文件:行：`packages/application/src/services/thread-prompt-bundle-service.ts:87-92`、`:245-254`、`:263-270`
- 问题：`promptBundleChange` 先判断数据分级，再判断工具集/模型/推理强度/回答语言。因此当一次 resolve 同时“分级降低 + 工具集合变了（或模型/强度/语言变了）”时，`origin` 会被定为 `classification_lower`。而 `#create` 无论 origin 是什么，都会用**当前 candidate** 的系统提示和工具，以及**当前 input.identity** 的 toolNames/modelRef 等写入新记录，只是把 `redactionRuleset` 换成上一份的旧版本。也就是说，新记录可能已经换了请求开头，却仍沿用旧遮盖规则。
- 证据：
  ```ts
  87:  if (CLASSIFICATION_RANK[classification] < CLASSIFICATION_RANK[record.dataClassification])
  88:    return "classification_lower";
  89:  if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";
  ```
  ```ts
  245:      identity: {
  246:        ...input.identity,
  247:        redactionRuleset: this.#rulesetFor(origin, latest),
  248:      },
  249:      systemPrompt: await protect(
  250:        candidate.systemPrompt,
  ...
  254:      tools: await protect(candidate.tools, "application/json", "thread-prompt-bundle-tools"),
  ```
  ADR 的说法（`docs/adr/0188-recognize-passwords-without-a-separator.md:58`）：“因数据分级降低而换新时，提示和工具不变，所以沿用上一份记录的版本”。代码并没有验证“提示和工具不变”，这个前提在混合换新时不成立。
- 影响：头已经变化时，本来可以安全地升级到当前规则（缓存反正已失效），现在却继续用旧规则，削弱新消息的遮盖；同时新记录的 origin 只记为 `classification_lower`，看不出同时发生了工具/模型变化。不是前缀追加性的问题，而是安全与文档一致性问题。
- 建议：只有在“新记录实际复用了上一份的 systemPrompt/tools 且 identity（工具名/模型/强度/语言）与 latest 相同”时才沿用 `storedRuleset(latest)`；否则写 `EGRESS_RULESET_CURRENT`。或者把 `promptBundleChange` 的优先级改成工具/模型变更优先，并另想办法保留 `classification_lower` 的事实。

### 2. 低：`storedRuleset` 的“非法值按 1”“高于当前按当前”两个分支没有自动检查

- 文件:行：`packages/application/src/services/thread-prompt-bundle-service.ts:23-28`；测试 `test/integration/thread-prompt-bundles.test.ts:334-353`
- 问题：作者说法第 1 条声称读出的版本“不是 1 以上整数按 1，高于当前版本按当前版本”，但现有用例只覆盖了“字段缺失 → 1”（`json_remove`），没有覆盖非整数、`<1`、`NaN`/字符串、以及 `> EGRESS_RULESET_CURRENT` 的 `Math.min` 截断。grep 全仓 `redactionRuleset`/`json_set` 未见相关用例。
- 证据：
  ```ts
  23: function storedRuleset(record: ThreadPromptBundleRecord): number {
  24:   const stored = record.identity.redactionRuleset;
  25:   if (stored === undefined || !Number.isSafeInteger(stored) || stored < 1)
  26:     return LEGACY_REDACTION_RULESET;
  27:   return Math.min(stored, EGRESS_RULESET_CURRENT);
  28: }
  ```
  测试只做到第 347 行 `expect(again).toMatchObject({ generation: 1, redactionRuleset: 1 })`（缺字段）。
- 建议：在集成测试里用 `json_set` 分别写入 `0`、`1.5`、`"2"`、`999`，断言读回为 1、1、1、`EGRESS_RULESET_CURRENT`；并加一条“写入 999 后不换新、不改字节”的用例。当前 `create` 只校验 `>=1` 的整数、不设上限（`sqlite-thread-prompt-bundle-operations.ts:158-160`），读取侧的截断是唯一防线，更值得测。

### 3. 低（推测）：`classification_lower` 且 `latest` 为空时静默退回当前版本

- 文件:行：`packages/application/src/services/thread-prompt-bundle-service.ts:268`
- 问题：`if (origin === "classification_lower" && latest) return storedRuleset(latest); return EGRESS_RULESET_CURRENT;`。按当前 `#current` 的构造，`classification_lower` 只可能来自 `latest ? promptBundleChange(latest, ...)`，所以 `latest` 一定有值（见下必答 1）。但这是一个“看起来可达、实际不可达”的兜底：一旦将来重构让 origin 从别处传入，就会把旧对话悄悄升到当前规则，改变已发字节。不是现存 bug，属于防御性写法不一致。
- 证据：`:196-200`
  ```ts
  196: let origin = latest
  197:   ? promptBundleChange(latest, input.identity, input.request.dataClassification)
  198:   : input.hasHistory
  199:     ? "rollout"
  200:     : "new_thread";
  ```
- 建议：改成显式的 `if (origin === "classification_lower")` 并在无 `latest` 时抛错/断言，或让 `#rulesetFor` 只在 `latest` 存在时被调用，避免无意的静默升级。

### 4. 低：新用例只断言返回值，未断言新记录里持久化的 `redactionRuleset`

- 文件:行：`test/integration/thread-prompt-bundles.test.ts:317-332`
- 问题：用例通过 `#open` 读回的 `redactionRuleset` 判断，若 `#create` 把该字段写成 `undefined`（被 `storedRuleset` 当 1 读）也会通过；它并没有验证“沿用上一份版本”确实写进了 generation 2 的 `identity_json`。同时该用例名写的是“only the data classification drops”，但代码对“分级降低 + 其它变化”同样走这条路径（见第 1 条）。
- 证据：用例只写 `expect(lowered).toMatchObject({ generation: 2, redactionRuleset: 1 })` 和第 325-328 行的 origin 断言，没有像第 287-291 行 `rulesetOf` 那样查 `identity_json`。
- 建议：补一条 `rulesetOf(resource, 2) === 1`；并补“同时换工具+分级降低”的用例来钉住第 1 条期望行为。

---

## 读代码证实的 vs 推测

- 已读代码证实：第 1、2、3 条中的控制流和测试覆盖情况；`storedRuleset` 各分支逻辑；`latestRow` 不按 `superseded_at` 过滤（所以 `latest` 不会因手工换新而消失）；`redactionRuleset` 的两端（生产/存储校验/读取/消费）均见下文必答 4。
- 推测：第 1 条的实际触发频率（需要同一 run 同时分级降低且工具/模型变化）；第 3 条属于不可达路径的假设性风险；无法运行测试，所有“会失败/会通过”的判断均按代码推演，未执行。

---

## 侧重检查

- 错误路径：`storedRuleset` 对 `undefined`/非整数/`<1` 返回 1，对 `null`/布尔/字符串走 `Number.isSafeInteger` 返回 1；`identity` 为 `null` 时 `record.identity.redactionRuleset` 会抛原始 TypeError（与改动前 `record.identity.redactionRuleset ?? ...` 行为相同，非本轮引入）。未发现新崩溃点。
- 不合规范/不可信输入：`identity_json` 来自本机 SQLite，`fromRow` 只做 `JSON.parse` 不校验（`sqlite-thread-prompt-bundle-operations.ts:27-33`）；`create` 校验 `redactionRuleset` 为 `>=1` 安全整数但不设上限（`:158-160`），读取侧 `Math.min` 兜住，结论：两端可接受。
- 安全：`redactionRuleset` 传入口 `model-egress.ts:226-228` 和 `pi-runtime-adapter.ts:1567`，最终只用于 `redaction.ts:350-356` 的 `>= 2` 判断；生产者只会产出 1 或 `EGRESS_RULESET_CURRENT`，消费端不会因非法值放宽到“全不遮”。第 1 条是唯一会“继续用弱规则”的场景。
- 资源耗尽：本轮改动是纯同步常量和单字段读写，无循环/分配增长。
- 不可撤销操作：无。换新是插入新代并标记旧代，不删除旧记录。
- 规则/文档/代码一致性：ADR 0188:58 的“提示和工具不变”与代码不保证（第 1 条）；ADR 0188:59/60、ADR 0165、`docs/kv-cache-guide.md:60` 与本轮代码一致（字段在 `identity_json`、不参与换新判断、只有两条宽松规则按版本生效）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 不会，而且本轮是在**避免**一次会改变开头/历史的升级。改动只影响“分级降低换新时写回哪个 `redactionRuleset`”：从原来的当前版本改为上一份记录的版本。历史遮盖用的是同一版本，因此已发出内容的字节保持不变；本次请求仍是把新用户消息追加在末尾。每轮会变的值（时间、运行环境等）不在这个字段里，该字段是每对话恒定的版本号。
   - 唯一的例外不是本改动引入的：`classification_lower` 换新时 `#create` 会重新取当前 candidate 的系统提示/工具（`:249-254`），如果上游文本恰好也变了，头会变；但这与规则版本无关，且换新本来就允许重算。第 1 条建议把这种“头确实变了”的情况和“沿用旧版本”区分开。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 不会引入新的不确定性，反而消除了一个：以前分级降低会把规则版本从 1 升到 2，下一轮重遮历史时宽松密码写法会从原文变成占位符，历史字节改变；现在沿用旧版本，历史字节稳定。`storedRuleset` 只读一个常量字段配合编译期常量 `EGRESS_RULESET_CURRENT`，不依赖前后文、时间或无序集合。
   - 需注意（推测/部署层）：如果新旧代码进程并存（滚动部署/回滚），旧代码不看 `identity_json.redactionRuleset`、一律用当前版本，同一段历史仍可能被旧进程遮成不同字节。这是整个规则版本机制的上线代价，不是本 diff 的稳态行为。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：新用例 `test/integration/thread-prompt-bundles.test.ts:317-332` 在旧代码上会失败（旧逻辑 `classification_lower` 写 `EGRESS_RULESET_CURRENT`=2，断言要求 1）；`prompt-prefix.compat.test.ts:633-663` 的三条 `[ADR-0188]` 用例构成正向（旧版本不变、新对话从第一轮遮）+ 反向（中途切版本必须报告断开），且同一文件中 `[1,1,1]`/`[2,2,2]` 正向为 null，能证明反向不是误报。`missing field` 用例（`:334-353`）覆盖了缺字段分支。缺口：非整数、`<1`、高于当前值三个分支无用例（第 2 条）；“分级降低 + 工具/模型同时变”的混合场景无用例（第 1 条）；新用例未断言写入 DB 的值（第 4 条）。我未运行测试，结论按代码推演。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - 产生：`#rulesetFor`（`thread-prompt-bundle-service.ts:263-270`）只产出 `1` 或 `EGRESS_RULESET_CURRENT`；`#create` 写入 `identity_json`（`:245-248`）。
   - 存储校验：`sqlite-thread-prompt-bundle-operations.ts:158-160` 接受 `undefined` 或 `>=1` 的安全整数，2 能通过；序列化在 `:209-217`，缺省时不写字段。
   - 读取：`#open` 经 `storedRuleset`（`:272-282`）统一归一化，缺字段/非法/超高都处理。
   - 消费：`model-egress.ts:226-228` 把值作为 `ruleset` 传给 `redactForEgress`，最终 `redaction.ts:350-356` 只比较 `>= EGRESS_RULESET_FIRST_LOOSE_PASSWORDS(=2)`；`pi-runtime-adapter.ts:1567` 把 `bundle?.redactionRuleset` 传给 egress context。两端对 1/2/缺省都能接受，未发现类似 I-73 的“清单 id 过不了后端校验”。
   - 计算路径核对：`rollout→1`；`classification_lower→storedRuleset(latest)`；其它换新（含 `tool_set_changed`/`tool_missing`/`tool_schema_changed`/`model_changed`/`thinking_level_changed`/`answer_locale_changed`/`rebuild_requested`）`→当前`；缺字段/非法`→1`；更高`→当前`。`classification_lower` 时 `latest` 一定有值（`latest` 为空只会走 `rollout`/`new_thread`；冲突重试会 `latest = result.record`，`:208-213`），`&& latest` 只是冗余兜底（第 3 条）。唯一不满足“两端一致预期”的是第 1 条的混合换新场景。
