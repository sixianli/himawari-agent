## 读代码证实的问题

### 中：新增用例没有被门槛固定住，删掉也不会让检查失败

`scripts/check-prompt-prefix.mjs:10` 仍是 `const REQUIRED = 8;`，而新增的 `[COMPACT-4]` 只是在已有 `[I-66]` describe 里多了一条通过项（`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1269`）。脚本按 `fullName.includes("[I-66]")` 过滤、只要求通过数不少于 8（`scripts/check-prompt-prefix.mjs:37-47`），所以把这条新用例整段删掉，门禁仍然通过。`runtime-event-contract.unit.test.ts:399` 的适配器接线用例也不被任何按名称或数量固定的门禁保护，只在 unit 项目里顺带运行。

证据：

```js
const REQUIRED = 8;
...
if (passed.length < REQUIRED)
```

建议：把 `REQUIRED` 提到 9，或按测试名白名单固定 `[COMPACT-4]`；同时为 `runtime-event-contract` 的 `[COMPACT-4]` 增加显式登记，避免以后被静默删除。

### 低：ADR 决定 2 与代码的边界不一致

`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:42` 写“窗口不超过 20 万的模型不设覆盖”，但代码实际是“窗口减去 Pi 默认预留 16384 后不超过 20 万才不设覆盖”：

```ts
if (model.contextWindow - PI_DEFAULT_RESERVE_TOKENS <= COMPACTION_TRIGGER_CAP_TOKENS) return {};
```

即实际不设覆盖的范围是 `contextWindow <= 216384`，不是 `<= 200000`。决定 4（第 44 行）提到了 216384 边界，所以整体不自相矛盾，但单读决定 2 会误解。

建议：改成“窗口减 Pi 默认预留 16384 后不超过 20 万（即窗口不超过 216384）的模型不设覆盖”，与代码一致。

### 低：ADR 后果对“不改变已发内容”的表述过于绝对

`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:57` 写“这个改动只影响‘什么时候压缩’，不改发给模型的任何已发内容”。正常轮次确实仍然只在末尾追加，但压缩本身会用摘要替换模型已经见过的历史；触发点从约 98 万提前到 20 万后，正在跨过 20 万的老对话会在更早的轮次发生一次历史替换和缓存整段失效。规则第 4 条把压缩列为允许的批量例外、第 12 条也允许压缩（`.claude/rules/prompt-prefix.md:35,59`），所以这不是违规，但“不改任何已发内容”容易让读者忽略这次提前发生的整段失效。

证据：`packages/runtime-pi/src/pi-runtime-adapter.ts:1465` 只改压缩设置；压缩事件本身由 Pi 触发，属于既有机制。

建议：在后果里补一句“正常轮次仍只追加；压缩事件提前，因此历史替换、缓存失效和原始上下文丢失都更早、更频繁”，并说明老对话上线后的第一次触发点会变化。

### 低：ADR 前提 3“每个模型写 contextWindow”不准确

`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:34` 写生产配置模板“每个模型写 `contextWindow`”。实际模板里 generation 模型 DeepSeek 有该字段（`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:87`），但 embedding 模型 `qwen-embedding` 没有（同文件 `98-121` 行）。这不影响 Pi 压缩路径，因为 embedding 不会进入 runtime-pi，但前提表述应准确。

建议：改成“每个 generation 模型写 `contextWindow`”。

### 低：规则第 12 条要求的“总输入费用比较”尚未完成

`.claude/rules/prompt-prefix.md:59` 明确要求比较压缩前后的总输入费用，不能只看单次摘要变小；ADR 第 59 行也承认“压缩质量和总输入费用是否更好还没实测”。这次把触发点从约 98 万降到 20 万，压缩会明显更频繁，属于规则第 12 条关心的“是否值得压缩”的核心问题。

建议：在默认启用前补上总输入费用对比，或明确把这次改动标为待验证/可回退配置；至少不要把“每次总结输入更小”当作已证实的净收益。

## 推测 / 未核实

- **Pi 源码不可用**：当前检出没有 `node_modules`，我无法独立核对 `getCompactionSettings` 如何解析 `modelOverrides` 键（尤其是模型 id 自带斜杠时）、`shouldCompact` 是否真的全部使用该值，以及默认预留是否恒为 16384。新增测试的设计看起来能覆盖这些点，但我没有运行测试，不能把作者“已实测”当作已验证。
- **测试模型形状与生产不完全一致**：`prompt-prefix.compat.test.ts:1275-1297` 传入的模型对象只有 `provider/id/contextWindow`，没有生产模型的 `maxTokens: 32768`、`api`、`name` 等字段。如果 Pi 的默认预留依赖 `maxTokens`，测试与生产会不一致。文档称默认是固定 16384，风险较低，但建议用生产形状的模型再跑一次边界。
- **类型检查未核实**：`getCompactionSettings` 是否接受这种窄对象、`SettingsManager` 是否在公开类型里暴露该方法，我无法在没有依赖的情况下确认；若签名要求完整 `Model`，新测试会 typecheck 失败。

## 侧重检查

- **错误路径 / 不可信输入**：`compactionModelOverrides` 对 `NaN`、非安全整数、`<=0` 返回 `{}`（`compaction-prefix.ts:83`）；生产配置的 `contextWindow` 在 `packages/platform-node/src/strict-configuration.ts:380-385` 被限制为 `1..MAX_SAFE_INTEGER`，模型绑定层再次校验（`configured-model-binding.ts:230`），Magpie 清单的 `context_window` 也要求正安全整数（`production-magpie-models.ts:74`）。两端校验都能接受这个值。
- **安全 / 注入**：覆盖键由 `${provider}/${id}` 计算，provider 是枚举，vercel 的 model 固定（`configured-model-binding.ts:202`），Magpie id 经过现有 modelRef 约束（`production-magpie-models.ts:44-51`）。这是计算属性，不会造成原型污染；该键没有第二个消费者，因此不涉及 I-73 那种“清单 id 还要过后端校验”的跨契约问题。
- **资源耗尽**：极大 `contextWindow` 会产生很大的 `reserveTokens`，但仍是安全整数，Pi 的 `contextWindow - reserveTokens` 不会溢出，触发点始终是 20 万；Magpie 清单把窗口报小只会退回默认预留（更早触发），报大也只会按 20 万触发，不会出现“永不压缩”。不可信清单导致的“窗口与实际不一致”告警确实未做，ADR 已注明。
- **不可撤销操作**：更早压缩意味着原始上下文更早从模型可见历史中消失；产品层是否仍保留原始消息、能否恢复，我没有读到对应代码，标为未核实。该风险来自既有压缩机制，本次只是提前触发。
- **文档一致性**：除上面列出的 ADR 决定 2、后果、前提 3 外，`docs/kv-cache-guide.md:110` 的“封顶在 20 万 token”与代码一致；作者关于 216384/216385 边界、适配器接线用例、斜杠 id 用例的说法均能在代码中找到对应实现。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   正常轮次的请求组装没有被改：系统提示、工具定义、历史、遮盖逻辑都没有动，发给模型的内容仍然只在末尾追加，每轮变化的值仍然只在最后一条消息。唯一变化是“什么时候触发既有的压缩例外”：跨过 20 万后压缩会更早发生，于是模型可见历史会更早被摘要整段替换、缓存更早失效。这是规则第 4 条允许、第 12 条管辖的压缩，不是新增的逐轮开头变化；但 ADR 第 57 行“不改任何已发内容”的说法应修正。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。`compactionModelOverrides` 是纯函数，只依赖 `provider/id/contextWindow`，没有时间、随机数、无序集合或请求间状态；返回对象最多一个键。压缩摘要内容本身由模型生成，可能不同，但那是既有压缩流程，不是这次改动引入的。

3. **有没有对应的自动检查，反向用例会不会失败？**
   有两条：`prompt-prefix.compat.test.ts:1269` 用 Pi 自己的 `SettingsManager` 检查 100 万窗口、其他模型、小窗口、0、200001/210000/216384/216385 和带斜杠 id；`runtime-event-contract.unit.test.ts:399` 经适配器创建会话，检查传给 Pi 的设置对 `vercel-ai-gateway/deepseek/deepseek-v4.1-flash` 解析出 `reserveTokens=800000`。按代码推理：把守卫改回旧逻辑会让 200001/210000/216384 的 `{}` 断言失败；删掉适配器那一行接线会让 unit 用例得到 16384 而不是 800000 而失败；覆盖键漏掉 provider 会让带斜杠 id 用例失败。但我没有运行测试，且 `REQUIRED=8` 没有随新用例提高，删掉新用例不会触发门禁。

4. **每个值的使用方都能接受吗？**
   - `COMPACTION_TRIGGER_CAP_TOKENS=200000`：只用于该函数、测试和 ADR；unit 用例的 `800000` 字面量把它钉在 1M 窗口上，能防止常量被无意改掉。
   - `PI_DEFAULT_RESERVE_TOKENS=16384`：用于判断是否需要覆盖；`prompt-prefix.compat.test.ts:1286` 用 Pi 的 `getCompactionSettings` 断言小模型默认值就是 16384，Pi 默认值变化时测试会失败，这个重复值有保护。
   - 键 `${provider}/${id}`：使用方是 Pi 的 `SettingsManager`/`getCompactionSettings`；仓库内没有第二个消费者。带斜杠的 vercel 和 magpie id 都有用例，但我无法运行确认 Pi 的实际解析。
   - `reserveTokens`：当 `contextWindow > 216384` 时为正安全整数且小于窗口；测试经 Pi 解析接受。
   - `contextWindow`：静态配置端在 `strict-configuration.ts:380-385` 校验，Pi 绑定端在 `configured-model-binding.ts:230` 校验，Magpie 清单端在 `production-magpie-models.ts:74` 校验；生产模板 DeepSeek 为 1000000（`production-shape-config-template.json:87`），与 ADR 描述一致。
