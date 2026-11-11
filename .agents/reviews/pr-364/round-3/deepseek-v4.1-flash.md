已核对增量 `b38398d2..2f114c40`：确实只有 ADR 0210 的文字和复核记录变了，代码与测试未变；再按 `1b8c306c..2f114c40` 核对了整段 PR。

## 读代码证实的问题

### 1. 中：规则 12 要求的总输入费用比较仍未做，而改动会让压缩更频繁

- 文件:行：`docs/adr/0210-cap-compaction-trigger-at-200k-per-model.md:57,59`；`.claude/rules/prompt-prefix.md:59`；`docs/kv-cache-guide.md:67`
- 问题：ADR 自己承认总输入费用没有实测，但规则 12 要求“比较压缩前后的总输入费用，不能只看命中率”。这次改动明确会让压缩“更早、更频繁发生”，所以这不是可以略过的细节。
- 证据：
  - ADR 0210:57：“压缩事件提前了：历史替换、整段缓存失效和原始上下文被摘要取代都会更早、更频繁发生”
  - ADR 0210:59：“压缩质量和总输入费用是否更好还没实测；付费评测等 Andy 同意后再做。”
  - 规则第 12 条：“是否值得压缩，要比较压缩前后的**总输入费用**，不能只看命中率”
- 建议：上线前补一次压缩前后总输入费用的对比；若确实要带着未测量的风险上线，至少在 ADR 里写明 Andy 对“未测量”的明确豁免，并保留可快速回退的配置/开关。

### 2. 中：`check:prompt-prefix` 的门槛没有按名称锁定新的 `[COMPACT-4]`

- 文件:行：`scripts/check-prompt-prefix.mjs:8-10,26-27,43-47`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1222,1269`
- 问题：新用例虽然会被 `-t "\[I-66\]"` 跑到，但门槛只要求任意 `[I-66]` 用例通过 8 条；该 describe 里已有 30 条以上 `[I-66]` 用例，删掉或跳过 `[COMPACT-4]` 仍然会通过。ADR 0210:44 把它写成门槛的一部分，但实际上没有按名称固定。作者已在本轮说明中承认这一点，但本轮仍未修。
- 证据：
  - `const TAG = "[I-66]";`
  - `const REQUIRED = 8;`
  - `..."-t", "\\[I-66\\]"...`
  - `if (passed.length < REQUIRED)`
  - 新用例所在的 describe 是 `describe("[I-66] [COMPACT-2] ...")`，用例名是 `it("[COMPACT-4] ...")`
- 建议：在 `check-prompt-prefix` 里再加一次 `-t "\\[COMPACT-4\\]"` 并要求至少两条通过；或对 `[COMPACT-4]` 做按名称的存在性检查。仅靠 `REQUIRED=8` 不能保护这条新行为。

### 3. 低：ADR 0129 对压缩阈值的旧描述已与当前代码不一致

- 文件:行：`docs/adr/0129-compaction-summary-not-fed-to-memory-engine.md:26`
- 问题：该 ADR 仍把“模型窗口 − 16384”写成 Pi 当前自动压缩的行为。加入 ADR 0210 后，大窗口模型已改为在 20 万附近触发。
- 证据：
  - ADR 0129:26：“Pi 在对话超过「模型窗口 − 16384」token 时自动压缩（`compaction: { enabled: true }`，`packages/runtime-pi/src/pi-runtime-adapter.ts`）”
  - ADR 0210:42：“Pi 默认触发点（窗口减 16384）已经不高于 20 万的模型不设覆盖……窗口不超过 216384 的模型不动”
  - `packages/runtime-pi/src/compaction-prefix.ts:84-88`：大窗口返回 `reserveTokens = contextWindow - 200000`
- 建议：按仓库已有做法，在 ADR 0129 加一句“后续：压缩触发点见 ADR 0210”，不必改动 0129 的决定本身。

## 推测 / 未核实

- Pi 1.5.0 的 `compaction.md`、`chunk-44DLKSKE.js` 和 `SettingsManager` 实现不在本检出中，无法独立验证 `shouldCompact`、默认预留 16384、`getCompactionSettings` 的行为；这些只能依赖测试和作者说明。
- 未运行测试（工具限制）。“撤掉适配器接线会让 runtime-event-contract 用例失败”是从代码推出来的：不接线时 1M 窗口的 reserve 会是默认 16384，而不是期望的 800000。
- “超过 20 万的老对话下一轮就触发一次压缩”依赖 Pi 的具体时序；从适配器每轮创建新 session 看，新设置下一轮会生效，但“下一轮就触发”没有实际运行验证。
- Magpie 新增模型的 `contextWindow` 来自远程清单，ADR 前提 3 说“当前是静态配置”主要适用于主模型；对可选的 Magpie 模型并不完全准确，但不影响本次阈值逻辑。

## 侧重检查

- **不合规范/不可信输入**：`compactionModelOverrides` 对 `contextWindow` 做了 `Number.isSafeInteger(...) && > 0` 检查；上游 `configured-model-binding.ts:111-114,230` 也用 `assertPositiveInteger` 拒绝非正整数。0、负数、NaN、非整数都不会生成覆盖，不会产生负 reserve。
- **资源耗尽**：超大 `contextWindow` 不会把触发点推到无穷大，反而仍算出触发点 200000；但压缩更频繁会增加摘要模型调用和费用，见上面第 1 条。没有发现新的无限循环或内存增长路径。
- **安全**：没有新增日志、密钥或用户可控字符串拼接；覆盖对象只作为 Pi 的内存设置键值，不进入模型内容。
- **不可撤销操作**：压缩会替换模型可见历史，但产品侧仍保留原始消息；这是规则第 4 条允许的压缩例外。改动没有新增删除历史的行为。
- **规则/文档一致性**：ADR 0210 第 42 条的 216384 边界与代码一致；第 57 条对压缩频率的说明与代码一致；ADR 0129 的旧阈值描述不一致；规则 12 的总输入费用要求仍未满足。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮增量只是 ADR 文字，不改变任何请求字节。整段 PR 的代码只改“什么时候压缩”：正常轮次仍然只在末尾追加，新增的 `reserveTokens` 是会话设置，不是系统提示、工具定义或历史消息。压缩触发时历史会被替换，这是规则第 4、12 条允许的成批压缩例外；ADR 0210:57 已明确承认老对话下一轮可能发生一次压缩。每轮会变的值没有新增到请求头，压缩阈值按模型固定，不放在最后一条消息里。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。`compactionModelOverrides` 是纯函数，只依赖 `provider`、`id`、`contextWindow`，没有时间、随机数或无序集合；返回对象只有一个键。`contextWindow` 若因模型清单更新而变，属于配置变化，不是同一段文字被非确定地序列化。没有新增遮盖或历史改写逻辑。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有两条 `[COMPACT-4]`：`prompt-prefix.compat.test.ts:1269` 用 `SettingsManager` 验证大窗口 200k、其他模型不受影响、小窗口/0/200001–216384 不覆盖、216385 得 16385；`runtime-event-contract.unit.test.ts:399` 验证适配器实际把带斜杠的 `vercel-ai-gateway/deepseek/deepseek-v4.1-flash` 解析为 800000。这些断言在实现被改坏时会失败。但门槛本身没有按名称锁定 `[COMPACT-4]`，删除该用例不会让 `check:prompt-prefix` 失败，这是实际的测试保护缺口。

4. **改动产生的每个值，使用它的地方都能接受吗？**
   - `COMPACTION_TRIGGER_CAP_TOKENS`（`compaction-prefix.ts:75`）：被 `compaction-prefix.ts:84,87` 和测试 `prompt-prefix.compat.test.ts:1276,1298` 使用，数值类型一致。
   - `reserveTokens`（`compaction-prefix.ts:87`）：交给 Pi 的 `SettingsManager`，测试验证 1M 窗口得到 800000、216385 得到 16385、216384 及以下得到默认 16384。
   - 覆盖键 `${provider}/${id}`（`compaction-prefix.ts:86`）：被适配器 `pi-runtime-adapter.ts:1465` 传入 Pi；测试覆盖了普通 id 和带斜杠 id。
   - `contextWindow`：生产配置/Magpie 清单产生，先经 `configured-model-binding.ts:111-114,230` 校验为正的安全整数，再由 `compaction-prefix.ts:83-87` 使用。
   - `PI_DEFAULT_RESERVE_TOKENS = 16_384`（`compaction-prefix.ts:76`）：与测试断言的 Pi 默认值一致；但这是硬编码的 Pi 1.5.0 默认值，Pi 升级后需要重新核对（未核实项）。

   两端校验整体能对上；唯一明确的使用侧缺口是上面第 2 条的“门槛不按名称固定”。
