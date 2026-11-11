# 代码复核：PR 364 第 1 轮（057ab98）

## 发现（按严重度从高到低）

### 1. 中低 · packages/runtime-pi/src/compaction-prefix.ts:83 — 窗口略高于 20 万时，覆盖反而把压缩触发点推迟、预留小于 Pi 默认

**证据（读代码证实）**：
```ts
const reserveTokens = model.contextWindow - COMPACTION_TRIGGER_CAP_TOKENS;
return reserveTokens > 0 ? { [`${model.provider}/${model.id}`]: { reserveTokens } } : {};
```
只要窗口 > 200 000 就设覆盖。对窗口在 (200 000, 216 384] 的模型，`reserveTokens = 窗口 − 200 000 < 16 384`：
- 触发点是 `contextTokens > 200 000`，比 Pi 默认的 `窗口 − 16 384`（例如 21 万窗口时是 193 616）**更晚**，与“封顶在 20 万、更早压缩”的意图相反；
- 窗口 200 001 时 `reserveTokens = 1`（作者问 4）：触发条件变成 `contextTokens > 200 000`，距溢出只剩 1 个 token 余量，估算稍有偏差就直接落进溢出恢复而不是阈值压缩。
当前生产模型（DeepSeek V4.1 Flash，窗口来自 Magpie 清单，见 production-magpie-models.ts:74）不受影响，所以只是边界缺陷。
**建议**：`reserveTokens` 小于 Pi 默认预留（16 384）时不设覆盖，即窗口 ≤ `COMPACTION_TRIGGER_CAP_TOKENS + 16_384` 时不覆盖；并给 `[COMPACT-4]` 补一条窗口 200 001 / 210 000 的反向用例。

### 2. 中低 · packages/runtime-pi/src/pi-runtime-adapter.ts:1465 — 适配器接线没有任何测试覆盖

**证据（读代码证实）**：`compactionModelOverrides` 全仓只有两个使用点：adapter 第 1465 行和测试 prompt-prefix.compat.test.ts:1272。`[COMPACT-4]`（1270–1282 行）只测“给定 model → SettingsManager 解析出什么”，**不经过适配器**。而门禁 `npm run check:prompt-prefix` 用的会话模型窗口是 100 000（prompt-prefix.compat.test.ts:355），永远走不到覆盖分支。把第 1465 行的 `modelOverrides: compactionModelOverrides(binding.model)` 删掉，现有全部测试仍通过。
**建议**：在 pi-runtime-adapter 的测试里加一条大窗口模型（如 1 000 000）触发压缩的用例，断言覆盖生效；或至少断言创建 SettingsManager 时传入了覆盖。

### 3. 低 · docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:46 — ADR 对测试的描述与测试本身矛盾

**证据（读代码证实）**：ADR 决定第 4 条写“验证……**同一窗口的别的模型不受影响**……”，但测试 prompt-prefix.compat.test.ts:1277 是：
```ts
expect(resolve({ provider: "deepseek", id: "other", contextWindow: 1_000_000 })).toBe(800_000);
```
即同一窗口、不同 provider/id 的模型**同样被覆盖**（也封顶在 20 万），并非“不受影响”。如果 ADR 想说“键按模型区分、不会互相串”，措辞应改；照字面读是错的。
**建议**：改为“同窗口的其他模型键独立、各自也被封顶”。

### 4. 未核实项（本环境限制，非缺陷指控）

- Pi 侧事实全部**未核实**：本检出没有 `node_modules/@earendil-works/pi-coding-agent`（glob 全仓无结果），无法读到 `compaction.md`、`chunk-44DLKSKE.js` 的 `shouldCompact`、`getCompactionSettings` 的键格式与 `SettingsManager.inMemory` 对 `modelOverrides` 的 schema 校验。ADR 前提 1/2 引用的这些内容我无法对照。
- `[COMPACT-4]` 用 Pi 自己的解析器做往返（构造覆盖 → `getCompactionSettings(model)` 解析），设计上能抓住键格式和 schema 问题，但我在此环境**无法运行**，无法证实它通过。

## 侧重检查

走的流程（普通一轮对话，从入口到结束）：
1. `pi-runtime-adapter.ts:1336` `models.resolve(request.modelRef)` → configured-model-binding.ts:337 返回 `binding`，其中 `binding.model` 是 Pi 运行时里注册的 Model 对象（configured-model-binding.ts:341、276–297：`id = descriptor.model`、`provider = descriptor.provider`、`contextWindow = descriptor.contextWindow`）；
2. `pi-runtime-adapter.ts:1463–1471` 创建 `SettingsManager.inMemory`，本次改动在此传入 `modelOverrides`；这是每次请求新建的设置对象，不进任何模型载荷；
3. `pi-runtime-adapter.ts:1690` 会话用同一个 `binding.model` 创建——Pi 内部解析覆盖用的模型对象与算覆盖键用的是**同一个对象**，键格式不一致的风险只剩“Pi 是否用 `provider/id` 拼键”这一条，归入未核实第 4 条；
4. 窗口来源：production-magpie-models.ts:74 从 Magpie 清单读 `context_window`，`positiveInteger` 过滤，descriptor 再经 `assertPositiveInteger`（configured-model-binding.ts:230）——两层校验一致，`compactionModelOverrides` 里的防御性检查（:82）是冗余但无害；
5. 压缩触发后：`session_before_compact`（:1496）→ `compactionPrefixMessages` → `governedModelRuntime` 回调（:1636–1648）`sharedSummaryContext(lastRequest.context, …, model.contextWindow, …)`。

**结论**：链路中 1–3、5 里的既有环节有测试覆盖（门禁、[COMPACT-2] 等），本次新增的“覆盖生效”环节（发现 2）没有；流程上没有发现其他未覆盖的新路径。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。**读代码证实**：diff 只动了 ADR/文档、compaction-prefix.ts 新增纯函数、adapter 的 SettingsManager 配置（:1465，不进模型载荷）、测试。系统提示、工具、历史、遮盖的组装代码一字未动；每轮会变的值仍在最后一条消息的既有机制里。压缩更早触发属于规则第 4/12 条已允许的成批压缩例外，且压缩本身本来就会使缓存整段失效一次。符合“只追加”。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。**读代码证实**：新增值（`COMPACTION_TRIGGER_CAP_TOKENS`、覆盖表）只进 SettingsManager，不进请求；覆盖表是单键对象、键由模型字段确定性地拼出，无时间字段、无顺序依赖。窗口值来自 Magpie 清单，若部署间变化只会改变*何时*压缩，不改变任一请求的字节。**推测**：Pi 触发判断（`contextTokens > 窗口 − reserve`）是确定性的，无未核实到的随机因素。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 部分有。**读代码证实**：`[COMPACT-4]`（prompt-prefix.compat.test.ts:1270–1282）用 Pi 自己的 `SettingsManager.getCompactionSettings` 做往返——若键格式错、schema 拒收或公式错，`1_000_000 − resolve(large) === 200_000` 会失败；小窗口/窗口 0 的反向用例直接断言覆盖为空，代码若给小窗口设覆盖即失败；REVERSE 用例（:1252–1267）覆盖了 `compactionPrefixMessages` 三种退回（与 compaction-prefix.ts:11–17 逐条对应）。**缺口**：adapter 接线无覆盖（发现 2）。**未核实**：测试能否在本环境通过（无 node_modules）。

**4. 每个产生/修改的值，两端都核过了吗？**
- `COMPACTION_TRIGGER_CAP_TOKENS`：产生于 compaction-prefix.ts:75，使用于 :83 和测试 :1276。两端一致。
- `modelOverrides` 配置键及 `provider/id` 键格式：产生于 :84（`binding.model.provider/id`，即 `"magpie/deepseek/deepseek-v4.1-flash"` 这类），消费方是 Pi `SettingsManager`。生产端模型对象（configured-model-binding.ts:276–297）与会话用的 `binding.model` 是同一对象，键一致；Pi 端解析格式**未核实**（无 node_modules），由 `[COMPACT-4]` 往返用例把守（能否通过未核实）。
- 窗口值：产生于 production-magpie-models.ts:74（Magpie 清单），经 configured-model-binding.ts:230 校验为正整数，使用于 :83 与共享摘要估算 :1645。两端校验兼容。
- ADR 0210 与 kv-cache-guide 变更行：ADR 决定部分与代码一致，唯“同一窗口的别的模型不受影响”一句与测试矛盾（发现 3）；kv-cache-guide.md:110 只是变更记录，无冲突。
- 作者核对请求 3：压缩更早触发对 I-92/ADR 0207 共享摘要窗口估算**无负面影响**——`sharedSummaryContext`（compaction-prefix.ts:56–61）按当前历史估算，历史更小则更易放得进窗口，共享开头更容易成立。“lastRequest 在准入前记录”**证实**：pi-runtime-adapter.ts:1664 赋值先于 :1669 `admitPiStream`。“窗口估算不计占位符说明”**证实**：:56–60 只计 systemPrompt、工具、指令和历史，这是改动前就有的现状，本次未变。
- 作者核对请求 4（窗口 200 001 → reserveTokens 1）：**不合理**，见发现 1。
