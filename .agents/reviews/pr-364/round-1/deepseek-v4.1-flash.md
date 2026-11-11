我先看改动范围和关键文件。
## 复核范围与限制

- 已按 diff 只读核对源码、测试、ADR、规则和交付配置。没有修改文件，也没有运行测试。
- 仓库当前检出目录没有 `node_modules`（glob 无匹配），**Pi 1.5.0 的 `SettingsManager`/`getCompactionSettings` 内部实现无法直接读**，相关部分标为“未核实”；提交说明称 458 个测试、38 个 prompt-prefix 测试通过，我未亲自复跑。

## 发现（按严重度）

### 1. 中高：窗口 200001–216383 时，触发点反而比 Pi 默认更晚，且 reserveTokens 可低到 1

- 位置：`packages/runtime-pi/src/compaction-prefix.ts:82-84`
- 问题：只判断 `contextWindow > COMPACTION_TRIGGER_CAP_TOKENS` 就设覆盖。Pi 默认预留是 16384（测试 `prompt-prefix.compat.test.ts:1278-1280` 断言 `128_000` 窗口默认 `reserveTokens === 16_384`）。因此对窗口 `W`：
  - Pi 默认触发点 = `W - 16384`
  - 改后触发点 = `W - (W - 200000)` = `200000`
  - 当 `200001 ≤ W < 216384` 时，`W - 16384 < 200000`，本改动把压缩**推迟**了，最坏 W=200001 时从 183617 推迟到 200000，`reserveTokens = 1`。
- 证据：
  - `compaction-prefix.ts:83`：`const reserveTokens = model.contextWindow - COMPACTION_TRIGGER_CAP_TOKENS;`
  - `compaction-prefix.ts:84`：`return reserveTokens > 0 ? { ... } : {};`
  - 测试只覆盖 128K 和 1M，没覆盖 200001/210000/216384：`prompt-prefix.compat.test.ts:1275-1281`。
- 影响：这违背“封顶”的意图，并在窗口刚过 20 万时把预留压到 1 token；生产 `maxTokens` 可到 32768（`production-shape-config-template.json:88`），请求在触发前就可能没有输出余量，容易走向溢出恢复而不是正常压缩。
- 建议：只在“Pi 默认触发点已经高于 200K”时才覆盖，例如：
  - `if (contextWindow - 16384 <= CAP) return {};` 或
  - `reserveTokens = Math.max(contextWindow - CAP, 16384)`（若还考虑输出预算，可用 `Math.max(contextWindow - CAP, maxTokens, 16384)`）。
  - 增加 200001、210000、216383、216384 的边界用例，断言触发点不晚于 200K。

### 2. 中：作者称“窗口来自 Magpie 模型清单，不写死”与代码不符

- 位置：
  - `docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:34,42`
  - `apps/agent-service/src/production-magpie-models.ts:176`
  - `apps/agent-service/src/production-magpie-models.ts:241-249`
  - `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:59-60,87`
  - `apps/agent-service/src/production-model-composition.ts:239`
- 问题：ADR 说模型窗口已经由 Magpie 清单动态取得。但：
  - `production-magpie-models.ts:176`：`if (!primary || primary.provider !== "magpie" || primary.baseUrl === undefined) return unchanged;` 生产模板的主模型是 `vercel-ai-gateway`（模板第 59-60 行），此时 Magpie 扩展整个跳过。
  - 即使主模型是 Magpie，`production-magpie-models.ts:241-249` 的 `adjusted` 只改 `reasoning`/`thinkingLevels`，**没有用 `own.contextWindow` 覆盖 primary 的 `contextWindow`**。
  - 生产窗口实际来自静态配置：模板 `:87` 写 `"contextWindow": 1000000`，实例 `andy-production.json:21` 也是 `"contextWindow": 1000000`，再经 `production-model-composition.ts:239` 传入 Pi。
- 证据：`production-model-composition.ts:239`：`contextWindow: descriptor.contextWindow,`；`production-magpie-models.ts:176` 早退。
- 影响：当前 1M 值恰好正确，所以功能上还能算对；但“动态、不写死”的承诺不成立。以后服务方窗口变化或配置过期时，代码不会自动跟随 Magpie 清单。
- 建议：修正 ADR 前提和决定第 2 条，明确主模型的窗口来自静态配置；如果确实要动态，则应在 `expandConfigurationWithMagpieModels` 里把 primary 的 `contextWindow` 也从 `own` 条目更新，并单独核对 Vercel 主模型没有 Magpie 清单可用时的来源。

### 3. 中：生产接线点没有被测试覆盖，删掉 adapter 里的调用测试仍会全绿

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1463-1471`，`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1269-1274`
- 问题：`[COMPACT-4]` 直接调用 `compactionModelOverrides`，再自己建 `SettingsManager`；它没有经过 `PiAgentRuntimeAdapter`，也没有断言 `createAgentSession` 收到的 `settingsManager`。如果把 `pi-runtime-adapter.ts:1465` 的 `modelOverrides: compactionModelOverrides(binding.model)` 删掉，测试仍然通过。
- 证据：
  - 生产接线：`compaction: { enabled: true, modelOverrides: compactionModelOverrides(binding.model) },`（`pi-runtime-adapter.ts:1465`）
  - 测试自行构造：`SettingsManager.inMemory({ compaction: { enabled: true, modelOverrides: compactionModelOverrides(model) } }, ...)`（`prompt-prefix.compat.test.ts:1271-1274`）
- 影响：这个改动唯一的生产效果是一行接线；目前没有自动检查证明这一行存在且用了正确的 `binding.model`。
- 建议：用 `createSession` 注入 spy，断言 `options.settingsManager.getCompactionSettings(binding.model).reserveTokens`；或做一条端到端自动压缩用例，让 1M 窗口在约 20 万 token 时触发。至少加一个“去掉 1465 行会失败”的反向断言。

### 4. 中低：实际生产的 `provider/id` 键形状没有被测试

- 位置：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1275`，`packages/runtime-pi/src/compaction-prefix.ts:84`
- 问题：测试用的是 `{ provider: "deepseek", id: "v4.1-flash" }`，键为 `deepseek/v4.1-flash`。生产主模型实际是 `provider: "vercel-ai-gateway"`、`id: "deepseek/deepseek-v4.1-flash"`（模板 `:59-60`），键会是 `vercel-ai-gateway/deepseek/deepseek-v4.1-flash`；Magpie 路径则是 `provider: "magpie"`，模型 id 如 `opencode-go/deepseek-v4.1-flash`（见 `apps/agent-service/test/production-magpie-models.unit.test.ts:153`）。测试从未覆盖带斜杠的真实模型 id。
- 证据：`compaction-prefix.ts:84` 用 `` `${model.provider}/${model.id}` `` 拼键；测试 `:1275` 用的是简单 id。
- 影响：如果 Pi 内部就是同样的字符串拼接，则没问题；如果 Pi 会对键做分割/解析，带多个斜杠的真实 id 可能匹配不上。这一点我**未核实**（`node_modules` 不可读）。按 I-73 的教训，这正是“清单里的 id 能不能通过后端校验”的同类风险。
- 建议：用生产真实形状做一条 `[COMPACT-4]` 断言；同时在无法读 Pi 源码时，至少让真正由 Pi 的 `getCompactionSettings` 解析这条用例覆盖 `vercel-ai-gateway/deepseek/deepseek-v4.1-flash` 和 `magpie/opencode-go/deepseek-v4.1-flash`。

### 5. 低：ADR 说“同一窗口的别的模型不受影响”，测试没有真正验证

- 位置：`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:44`，测试 `prompt-prefix.compat.test.ts:1277`
- 问题：`resolve({ provider: "deepseek", id: "other", contextWindow: 1_000_000 })` 是**再次用 “other” 模型自己生成覆盖**，所以它得到 `800_000` 只证明“每个模型各自算一次”，不能证明“一个模型的覆盖不会影响另一个模型”。
- 证据：测试每次都新建只含当前模型覆盖的 `SettingsManager`，没有“同一 settings 里放两个模型，再解析另一个”的场景。
- 影响：当前 helper 只返回一个键，所以实际风险很低；但 ADR 对测试能力的描述不准确。
- 建议：要么把 ADR 文字改成“键按 provider/id 精确生成”，要么增加同一 settings 中两个不同模型的解析用例。

### 6. 低：规则第 12 条要求比较总输入费用，ADR 只写了“未实测”

- 位置：`.claude/rules/prompt-prefix.md:59`，`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:55-58`
- 问题：规则要求“是否值得压缩，要比较压缩前后的总输入费用，不能只看命中率”。ADR 说“压缩质量和总输入费用是否更好还没实测”。对 1M 模型，触发点从约 98 万提前到 20 万，压缩频率约增加数倍，这不是纯收益；摘要调用本身也有成本。
- 影响：流程/文档与规则不一致，不是当前代码的功能错误。
- 建议：在 ADR 里补一个粗略的总输入费用估算（正常轮次 + 摘要轮次），或明确记录这是 Andy 已批准、暂不做费用比较的例外。

### 7. 低：`check:prompt-prefix` 的门槛没有锁定 `[COMPACT-4]`

- 位置：`scripts/check-prompt-prefix.mjs:10,43-47`
- 问题：`REQUIRED = 8`，而文件里带 `[I-66]` 的用例远多于 8 条；删掉 `[COMPACT-4]` 后门槛仍会通过。新增的 `REVERSE: the compaction hook...` 用例（`prompt-prefix.compat.test.ts:1252-1267`）测的是原有 `compactionPrefixMessages` 分支，不是这次压缩触发点的新功能。
- 影响：未来有人误删或漏跑 `[COMPACT-4]` 时，门禁不一定能发现。
- 建议：把 `REQUIRED` 提高到当前稳定数量，或按测试名白名单要求 `[COMPACT-4]` 必须存在。

## 侧重检查

- **不可信输入**：Magpie 的 `context_window` 先经 `positiveInteger` 校验（`production-magpie-models.ts:58-59,74`），`compactionModelOverrides` 又用 `Number.isSafeInteger` 和 `> 0` 拒绝 0、负数、小数、NaN（`compaction-prefix.ts:82`）。这一点读代码可确认，无注入风险。
- **安全/键注入**：键是 `provider/id` 的模板字符串，`provider` 被限制为 `vercel-ai-gateway` 或 `magpie`（`configured-model-binding.ts:199-208`），模型 id 来自配置/清单；对象键带固定前缀，不构成原型污染路径。
- **资源耗尽**：触发点提前会让摘要请求更频繁，每次仍可能携带最多约 20 万 token 的历史加系统提示和工具。没有新的数量上限或限流，成本/延迟风险存在；不过压缩本身仍受窗口和 Pi 流程约束，不是无限循环。
- **错误路径**：`compactionModelOverrides` 对无效窗口返回 `{}`，不抛错；`sharedSummaryContext` 放不进窗口时返回 `undefined`，回退 Pi 默认摘要请求（`compaction-prefix.ts:51-61`）。窗口刚过 20 万时，因 `reserveTokens` 过小，更容易走到“压缩太晚/溢出恢复”而非正常共享摘要。
- **不可撤销操作**：压缩会替换旧历史。提前到 20 万意味着旧对话会更早、更频繁地丢失原始细节；这是规则第 12 条允许的压缩，但本改动没有新增恢复路径或回滚机制。
- **规则/文档一致性**：发现两处明确不一致——ADR 的前提 3“窗口来自 Magpie 清单”与代码不符；ADR 对 `[COMPACT-4]`“别的模型不受影响”的描述强于测试实际覆盖。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- **普通请求：不会新增修改。** 新代码只改 `SettingsManager` 的 `compaction` 配置（`pi-runtime-adapter.ts:1463-1471`），没有触碰 `systemPrompt`、工具定义、历史消息或遮盖结果。每轮会变的值没有新增，仍然在最后一条用户消息里。
- **压缩请求：仍然只在末尾追加总结指令。** `compactionPrefixMessages` 在 threshold/manual、非拆分轮、能找到切点时才返回前缀（`compaction-prefix.ts:6-20`），溢出和拆分轮直接回退（`:11-12`）。
- **必须加限定的是“压缩更早发生”。** 对部署时已经超过 20 万 token 的旧对话，升级后下一轮就可能触发压缩，历史被摘要替换，下一请求开头按规则第 12 条整段失效。这不是本改动直接改写文本，而是把原本允许的压缩提前了；ADR 里“不改发给模型的任何已发内容”应改成“不直接改写请求内容，但会更早触发规则第 12 条的压缩重写”。

### 2. 同一段文字会不会在不同请求里变成不同字节？

- **不会因为本改动新增这种问题。** `reserveTokens` 和 key 只在设置里，不进入请求；key 由 `provider/id` 确定生成，只有一个键，不存在集合顺序问题；没有新增时间字段或依赖后文的遮盖。
- **仍然存在的固有非确定性**：压缩摘要由模型生成，且触发时点取决于 token 计数，所以同一段旧文本是否还在请求里、是否已被摘要替换，会随触发时点不同。这不是本改动引入的“同一段文字被遮成不同字节”，但会让旧文本更早被摘要替换。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

- **有部分。** `[COMPACT-4]` 能验证 helper 和 Pi `SettingsManager` 的解析：若 helper 对 1M 返回空，`1_000_000 - 16384 ≠ 200000`，会失败；若对小窗口也设覆盖，`resolve(small) !== 16384`，会失败；若去掉窗口 0 的保护，`toEqual({})` 会失败。
- **反向用例不完整。** 新增的 `REVERSE: the compaction hook...` 只测原有 `compactionPrefixMessages` 分支，不保护这次改动；没有用例证明 `pi-runtime-adapter.ts:1465` 的接线存在；没有覆盖 200001–216383 这个失败区间；没有用生产真实 `provider/id` 形状。
- **门槛偏弱。** `check:prompt-prefix` 只要求至少 8 条 `[I-66]` 通过，删掉 `[COMPACT-4]` 也不会触发“测试缺失”。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

- `COMPACTION_TRIGGER_CAP_TOKENS`：只被 `compactionModelOverrides` 和测试使用，无外部校验问题。
- `reserveTokens`：使用方是 Pi `SettingsManager`/`getCompactionSettings`。测试用真实 `SettingsManager` 验证了合成模型能解析；但生产真实模型形状、Pi 内部实际使用的对象和窗口语义**未核实**。`200001` 时返回 1 是明确的边界缺陷（见发现 1）。
- `modelOverrides` 配置键：使用方是 Pi。测试证明合成键能被接受；生产键 `vercel-ai-gateway/deepseek/deepseek-v4.1-flash` 或 `magpie/opencode-go/...` 未被测试覆盖，存在带斜杠 id 的匹配风险（见发现 4）。
- `binding.model.contextWindow`：使用方是 `compactionModelOverrides` 和 Pi。值来自 `descriptor.contextWindow`（`configured-model-binding.ts:286`），而生产主模型的这个值来自静态配置（模板 `:87`、实例 `:21`、`production-model-composition.ts:239`），不是作者说的 Magpie 清单。左右两端类型/正整数校验都满足，但“动态来源”的说法不成立。
- ADR/说明文档：与代码存在两处不一致（窗口来源、测试覆盖“别的模型不受影响”），需要修正。
