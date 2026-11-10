现在我来验证一下 Pi 1.5.0 内部机制的相关说明：
仓库内没有 node_modules，无法核实 Pi 1.5.0 内部（ADR 前提 1–3）。继续核对提示词目录门槛和 [COMPACT-2] 的注册情况：
## 侧重检查

我走的流程：普通多轮对话（第 1 轮小、第 2 轮大）→ Pi 在第 3 轮运行中触发自动压缩 → 摘要请求在 `governedModelRuntime` 回调里被改写或退回 Pi 默认 → `admitPiStream`（预算准入、出口遮盖、clamp 检查、用量记录）→ `compaction_end` 清状态 → 下一轮。

- 覆盖到的路径：请求头冻结与只追加的回归全家（`[I-66]` 系列及 REVERSE 用例）、压缩请求发得出去/失败上报（`[COMPACT-1]` 两条）、改写后摘要请求的形态（`[COMPACT-2]`）、用量 purpose。
- 没有覆盖的代码路径（读代码证实）：
  - `compactionPrefixMessages` 的所有退路分支（pi-runtime-adapter.ts:698 `overflow`、`isSplitTurn`；703 `cut <= 0`；706 空消息）——没有任何用例直接进入。
  - `sharedSummaryContext` 的窗口估算退路（pi-runtime-adapter.ts:723）——无用例。
  - `cacheRetention`/`sessionId` 重接（pi-runtime-adapter.ts:1688-1698）——没有任何断言。
  - `lastRequest` 被同会话其他模型调用覆盖后压缩对不上而退回——行为安全但无测试。
- 关键的环境限制：本检出不带 node_modules，Pi 1.5.0 内部（`completeSummarization`、`cacheRetention: "none"`、`<conversation>` 序列化、`session_before_compact` 事件形状、`convertToLlm`/`buildSessionProjection` 的语义）全部**未核实**，只能以 ADR 前提和基线上已通过的 `[COMPACT-1]` 断言（prompt-prefix.compat.test.ts:941-947）间接采信。

## 发现的问题（按严重度）

**1.（中）docs/adr/0207-compaction-request-reuses-conversation-head.md:79 — ADR 和作者说明声称“`[COMPACT-1]` 里的拆分轮用例覆盖退路”，与代码不符。**
证据：全仓 grep `isSplitTurn|拆分轮` 只命中适配器源码（pi-runtime-adapter.ts:695、698），没有任何测试构造过拆分轮；`[COMPACT-1]` 两条用例（prompt-prefix.compat.test.ts:911、955）是无工具调用的三轮对话，其摘要请求走 Pi 默认形式（941-947 断言 `tools` 为 undefined、含 `<conversation>`），“为什么退回”在测试里看不出来（可能是 cut<=0（703）或 Pi 内部估计，未核实）。
建议：要么补一条真正构造 `isSplitTurn`（或溢出）的用例锁住退路，要么把 ADR、规则文件措辞改成“退回默认的场景由 [COMPACT-1] 间接覆盖”。

**2.（中低）packages/runtime-pi/src/pi-runtime-adapter.ts:722-723 — 窗口估算漏掉系统提示、工具定义和追加的指令本身。**
证据：`const estimated = history.reduce((total, message) => total + estimateTokens(message), 0); if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;` 只数 history 消息。改写后的摘要请求带完整冻结系统提示（含占位符图例）和完整工具定义，且 ADR 自己承认工具结果不再截断 2000 字符、请求“可能比原来大”。估算偏小时会放行一个超窗请求，被 admitPiStream 的 clamp（1071-1076）或服务方拒绝 → `PI_COMPACTION_FAILED`（1809-1813）；而这正是 Pi 默认请求（截断、小系统提示）本可成功的边缘场景。效果方向：把一次本可成功的压缩变成失败的，对话继续膨胀。
建议：估算时把系统提示+图例、工具和指令一并计入；或 clamp 失败时对这个摘要请求退回 Pi 默认再试一次，而不是直接判压缩失败。

**3.（低）packages/runtime-pi/test/prompt-prefix.compat.test.ts:1013-1022 — `[COMPACT-2]` 是解析后结构相等（`toEqual`），不是 ADR 和作者所说的“逐字节相同”，且完全没碰请求选项。**
证据：断言只用 `toEqual` 和 `toMatchObject`；同文件现成的 `findPrefixBreak`（helpers/prompt-prefix.ts:33-58）会做原始字节前缀比较并检查 messages 以外的所有顶层字段，这里没有使用；`cacheRetention`/`sessionId` 沿用（pi-runtime-adapter.ts:1688-1698）无任何断言。键序变化或选项没传对都不会被抓住（风险低，因为请求体由同一条序列化路径生成，但与“逐字节”的说法不匹配）。
建议：补 `expect(findPrefixBreak(normal 原始 body, summary 原始 body)).toEqual({ where 由摘要比普通短决定或 message-changed … })`形式的断言（要允许 summary 少掉被压缩掉的消息），并断言摘要请求的选项字段。

**4.（低）docs/kv-cache-guide.md 第 13 条标“做到”、已知差距第 1 条改“已修”——对不上窗口时会退回 Pi 默认这一退路属实（代码 723），但“对不上”的判定依赖上一次普通请求恰好还保留着切点前缀；若压缩发生在本会话第一个请求前（如恢复 continuation 后立刻压缩，`lastRequest` 为 undefined，717）或两请求之间有别的模型调用，改写落空属预期，行文无歧义，可接受；仅提示这点在文档“做到”的表述下容易被读成“总是命中”。**

未核实清单（不是问题，是边界）：Pi 1.5.0 内部行为（前提 1-3、`<conversation>` 标记、事件形状、钩子与模型调用的先后顺序）、manifest 中新条目 sha256 是否等于 `JSON.stringify(entry.segments)` 的 sha256（门槛在 apps/agent-service/test/prompt-catalog.unit.test.ts:300，会被 `npm run check:prompt-catalog` 拦，但我无法在此计算复核）、全部测试实际可跑通、`estimateTokens`/`normalizeContext` 的纯度。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会（读代码证实）。普通请求上 `shared` 恒为 undefined，`context = shared ?? summaryContext ?? himawariRequestContext(...)`（1683-1686）与基线逐表达式等价，`lastRequest` 只记录不改写。压缩请求仅在 `isDeepStrictEqual(history, prefix)`（719）成立时发出，其内容是 `{...lastRequest, messages: [前缀..., 末尾指令]}`（724-734）——系统提示、工具、前几条历史全部复制自上一次普通请求，每轮会变的只有末尾追加的指令消息；随后的 `withPlaceholderLegend`（egress-context.ts:15-21，只改系统提示，系统提示本身来自 lastRequest）和出口遮盖（规则第 5/11 条：遮法只取决于它自己和前面的内容）对两种请求同构且对前缀稳定，所以发给模型的字节仍是“已发字节 + 末尾追加”。唯一依赖外部的环节是 Pi 侧 `convertToLlm` 输出与历史存取同构（719 的逐条比较能否成立），由 `[COMPACT-2]` 实证、Pi 内部未核实。

**2. 会不会让同一段文字在不同请求里变成不同的字节？** 不会（读代码证实）。唯一新增的动态值是末尾指令的 `timestamp`，取自 `history.at(-1)?.timestamp ?? 0`（731），是对话历史的确定函数；指令文本是提示词目录固定文字（sha 有清单门槛）；无集合遍历、无新时间字段；遮盖按规则第 11 条对前缀稳定，切点后消息被移除不影响前面消息的遮法。风险仅在 Pi 未核实的 `convertToLlm`/`normalizeContext` 纯度。

**3. 有没有对应的自动检查、反向用例会不会失败？** 部分。`npm run check:prompt-prefix`（package.json:55 → scripts/check-prompt-prefix.mjs）会跑 `[COMPACT-2]`：脚本的 `-t "\\[I-66\\]"` 过滤靠 describe 标题匹配，[COMPACT-2] 属于该 describe 故被包含；REQUIRED=8 是下限，新增不破坏。撤掉改写后该用例应当失败（静态推理：Pi 默认摘要 `tools` 为 undefined、含 `<conversation>`，1021 和 1016 会失败）——未实际运行验证。但改写的各条退路（overflow、split turn、cut<=0、窗口估算、选项沿用）没有任何专门或反向用例，见问题 1。

**4. 新产生的每个值，两端的校验都对得上吗？** 逐项：① `runtime.compaction.summary-instruction`：产自 prompt-catalog/src/runtime.ts:237，消费仅 pi-runtime-adapter.ts:730；清单门槛存在于 `check:prompt-catalog`，sha 我无法计算（未核实，但门槛会拦错值）。② `purpose: "other"`：产自 pi-runtime-adapter.ts:1724，类型端 `MODEL_USAGE_PURPOSES` 含 `"other"`（application/src/ports/model-usage.ts:3-12）；缓存命中率告警 `lowCacheHitRate` 明确排除非 chat（model-usage.ts:49），与 ADR“不混进对话命中率告警”一致。③ `cacheRetention`/`sessionId` 沿用：只在有值时透传（1692-1697），上次没有就不传，消费端是 Pi/服务方（Pi 内部行为未核实）。④ 扩展名 `himawari-compaction-prefix`：仅注册处使用，`hidden: true`，无其他消费方。⑤ `compactionPrefix`/`lastRequest`/`compacting` 均为请求内闭包局部状态，`compaction_end` 清理（1807-1808），无跨请求泄漏。与 I-73 教训相关的“清单 id 过后端校验”一类风险在此项改动中不存在越界值。
