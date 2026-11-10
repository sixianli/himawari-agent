## 一、读代码证实的问题

### 1. 中：所有“退回 Pi 默认请求”的路径都静默，无法确认压缩请求是否真的命中缓存

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1491`、`packages/runtime-pi/src/compaction-prefix.ts:11-17,51-54,61`
- 问题：钩子异常、理由不是 manual/threshold、拆分轮、切点找不到、历史对不上、没有上一次请求、窗口放不下，全部无声退回。代码里没有任何日志或指标记录“这次压缩用了共享开头还是默认请求”，也没有记录退回原因。作者说“出错就退回默认，不影响对话”，但这次改动的目的就是缓存收益；如果线上因为消息格式差异一直退回，成本会悄悄回到全价，只有单条纯文本用例 `[COMPACT-2]` 能发现部分回归。
- 证据：
  - `pi-runtime-adapter.ts:1491-1498`：
    ```ts
    pi.on("session_before_compact", (event) => {
      try {
        compactionPrefix = compactionPrefixMessages(event);
      } catch {
        compactionPrefix = undefined;
      }
      return undefined;
    });
    ```
  - `compaction-prefix.ts:11-17`：
    ```ts
    if (event.reason !== "manual" && event.reason !== "threshold") return undefined;
    if (event.preparation.isSplitTurn) return undefined;
    ...
    if (cut <= 0) return undefined;
    ```
  - `compaction-prefix.ts:53-54`：
    ```ts
    if (history.length !== prefix.length || !isDeepStrictEqual(history, prefix)) {
      return undefined;
    }
    ```
- 建议：至少写一条日志或计数（如 `compaction.prefix.shared/fallback` 和原因码），并把它纳入现有缓存监控。否则 ADR 里“每次压缩省约 $0.14、每月省不到 $0.3”的收益无法用生产数据核实。

### 2. 中：新路径的自动检查不完整，反向用例不一定在阻断门里

- 文件：`package.json:27,55-56`、`scripts/check-prompt-prefix.mjs:10,37-47`、`packages/runtime-pi/test/compaction-prefix.unit.test.ts`
- 问题：
  1. `compaction-prefix.unit.test.ts` 属于 `unit` 项目，`npm run check` 的 `check:steps` 并不运行它；`check:prompt-catalog` 也只点名了别的测试。按仓库的交付模式，真正阻断提交的是 `npm run check`，所以“对不上/窗口放不下/没有上一次请求”的反向用例不会在本地阻断门里运行。
  2. `check:prompt-prefix` 只要求 `[I-66]` 至少 8 条通过，而该 describe 下已有约 30 条用例；删掉 `[COMPACT-2]` 仍会满足 `passed.length >= 8`。也就是说这道门没有点名锁住这次新增的关键用例。
  3. `compactionPrefixMessages` 的 manual/threshold/overflow、isSplitTurn、cut<=0 分支完全没有测试；`[COMPACT-2]` 只用了纯文本两轮对话，没有工具调用/工具结果。真实长对话里工具消息格式是否仍能通过 `isDeepStrictEqual`，未覆盖。
- 证据：
  - `scripts/check-prompt-prefix.mjs:10`：`const REQUIRED = 8;`
  - `scripts/check-prompt-prefix.mjs:43-47`：只比较 `passed.length < REQUIRED` 和失败列表，不检查具体用例名。
  - `compaction-prefix.unit.test.ts:34-47` 有对不上/窗口反向用例，但它们不在 `check:prompt-prefix` 里。
  - `prompt-prefix.compat.test.ts:981-1025` 的 `[COMPACT-2]` 只用 `第一问/第二问/第三问` 纯文本。
- 建议：把 `REQUIRED` 提高或直接断言 `[COMPACT-2]` 存在且通过；把 `compaction-prefix.unit.test.ts` 加进 `npm run check`；补一条带工具调用/工具结果的压缩兼容用例，以及 `compactionPrefixMessages` 各退回分支的单测。

### 3. 中低：说明文档与代码不一致（同一提交里就有互相矛盾的说法）

- 文件：`docs/adr/0207-compaction-request-reuses-conversation-head.md:51`、`docs/pi-development-guide.md:270`、`docs/adr/0165-freeze-the-request-head-per-conversation.md:90`、`docs/kv-cache-guide.md:21,87`
- 问题：
  1. ADR 0207 写“拆分轮、溢出、对不上、放不进窗口各自没有单独的用例”，但同一提交新增的 `compaction-prefix.unit.test.ts:34-47` 已经给了“对不上/窗口/没有上一次请求”的反向用例。作者说明里也说“对不上、窗口放不下、没有上一次请求各有反向用例”。文档与代码/提交说明不一致。
  2. `docs/pi-development-guide.md:270` 仍说“要自己出摘要……用 `session_before_compact` 返回 `compaction`”，而 ADR 0207 明确把“自己在钩子里发请求并返回摘要”列为放弃的做法；实际实现是只观察、返回 `undefined`。
  3. `docs/adr/0165...:90` 仍写“适配器只改写对话请求……压缩请求原样放行”，这在本次改动后已经不成立；ADR 0207 没有引用/说明它修改了 ADR 0165 第 7 条。
  4. `docs/kv-cache-guide.md:21` 要求修好已知差距后把它从“已知差距”移走，但第 87 行仍保留“（已修，见第 13 条）”；同时第 61、87 行都漏掉了 ADR 里明确列出的“没有上一次普通请求”这一退回条件。
- 证据：
  - ADR 0207:51：“拆分轮、溢出、对不上、放不进窗口各自没有单独的用例……”
  - `compaction-prefix.unit.test.ts:34-47`：`REVERSE: gives up when the history differs...`、`REVERSE: ... do not fit the window`。
  - `pi-development-guide.md:270`：“……用 `session_before_compact` 返回 `compaction`。”
  - `adr/0165...:90`：“……压缩请求原样放行……”
- 建议：更新 ADR 0207 的测试段；把 `pi-development-guide` 的例子改成指向 ADR 0207 的只观察改写做法；在 ADR 0207 关联文档里明确它修订了 ADR 0165 第 7 条；按 kv-cache-guide 自己的维护规则处理“已知差距 1”。

### 4. 低：新提示词条目的 `usedBy` 指错文件

- 文件：`packages/prompt-catalog/src/runtime.ts:241`
- 问题：`usedBy: ["packages/runtime-pi/src/pi-runtime-adapter.ts"]`，但实际使用在 `packages/runtime-pi/src/compaction-prefix.ts:3,59,68`。现有检查只看 `usedBy` 是否包含 `egress-context.ts`，不会发现这个错误，但清单会误导后续维护者。
- 证据：`runtime.ts:241` 与 `compaction-prefix.ts:3`。
- 建议：改成 `["packages/runtime-pi/src/compaction-prefix.ts"]`。

### 5. 低：`lastRequest` 记录的是“尝试过”的请求，而不是“成功发给模型”的请求

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1648`
- 问题：`lastRequest` 在 `admitPiStream` 之前就赋值；之后还可能因为 `suspended || unknownTool`、准入失败、窗口检查等直接返回失败。若手动压缩发生在一次失败请求之后，摘要请求会复用一个模型从未见过的开头：内容本身不危险，但不可能命中缓存，且会让“沿用上一次普通请求”的说法失真。
- 证据：
  - `pi-runtime-adapter.ts:1644-1649`：
    ```ts
    const context =
      shared ??
      summaryContext ??
      himawariRequestContext(requested, systemPrompt, requestTools);
    if (!summaryContext && context) lastRequest = { context, options };
    if (shared) options = sharedSummaryOptions(options, lastRequest?.options);
    ```
  - 后续 `1653-1659` 才检查 `context`、`suspended/unknownTool`、工具循环，再进入 `admitPiStream`。
- 建议：把 `lastRequest` 改名为 `lastAttemptedRequest`，或者只在确认会发出请求后再记录；若保留现状，在 ADR/规则里写明“上一次尝试的请求”。

## 二、推测 / 未核实

1. **非 ASCII 估算是否真的“保守”未核实。** `compaction-prefix.ts:28` 用 `text.length / 1.2` 估算非 ASCII token；常见 CJK 分词器可能接近 1 token/字符，若实际高于估计，窗口检查会放过超窗口的摘要请求。缓解因素是共享前缀是上一次已成功请求的子集，且还有 4096 余量，但没有接近窗口的测试。**建议按目标模型 tokenizer 实测一次，或加一条接近窗口的用例。**
2. **摘要请求是否可能被误判成普通请求，或普通无工具请求被误判成摘要。** 判断依赖 `himawariSummaryContext` 的“无工具 + 首条 system 是字符串”启发式（`pi-runtime-adapter.ts:683-691`），而 `compacting` 只在 `compaction_end` 复位（`1754-1764`）。若 Pi 某条错误/中止路径没有发出 `compaction_end`，同一次运行内后续的无工具普通请求理论上可能被改写成“切点前缀 + 总结指令”。**未复现，属于错误路径推测；建议用显式的“这是 Pi 的摘要请求”标记，而不是仅凭无工具判断，并补反向用例。**
3. **工具调用/工具结果历史能否通过 `isDeepStrictEqual` 未核实。** `[COMPACT-2]` 只有纯文本；`convertToLlm` 与 `lastRequest.messages` 在工具消息上的字段是否完全一致没有测试。若不一致，真实长对话会静默退回默认请求。
4. **`sessionId`/`cacheRetention` 在生产请求选项中是否确实存在未核实。** d4 黄金请求显示正常请求带 `session_id`/`x-session-affinity`，说明方向合理；但测试夹具读不到请求选项，`sharedSummaryOptions` 只有 helper 单测，没有集成断言。
5. **summary 响应里的工具调用是否会被执行未核实。** 按 ADR 的前提，Pi 的摘要走 `completeSummarization`/`streamSimple`，不执行工具；没有本地 node_modules 可对照 Pi 1.5.0 源码。若成立，则“给摘要请求带工具”不会产生不可撤销副作用。
6. **新 manifest sha256 是否正确未核实。** 我不能运行测试；`apps/agent-service/test/prompt-catalog.unit.test.ts:300-319` 会计算 `sha256(JSON.stringify(segments))` 并与清单比对，若作者不是用 `PROMPT_MANIFEST_WRITE` 生成，CI/`npm run check` 会拦下。
7. **追加消息的 `timestamp` 取自最后一条历史消息（`compaction-prefix.ts:69`）**，因此不同压缩请求里这条消息的元数据可能不同；它只在最后一条消息里，不影响共享前缀，但如果 provider 真的序列化 timestamp，只会让最后一条消息无法命中，不影响前面的缓存。

## 三、侧重检查

- **错误路径**：钩子异常被 catch 吞掉；`sharedSummaryContext` 的对不上/窗口条件静默返回 `undefined`；`sharedSummaryContext` 自身若抛出（例如不可序列化消息），会由 `deferredPiStream` 转成 “Model request failed”，不会静默改对话（`pi-runtime-adapter.ts:839-853`）。主要问题是缺少退回原因日志，见问题 1。
- **不合规范/不可信输入**：`session_before_compact` 的 `preparation`、`branchEntries` 来自 Pi；钩子用 try/catch 兜底，最坏退回默认。会话内容本身是旧的不可信输入，但已经在之前的正常请求里发送过；新增的末尾指令来自 prompt catalog 的固定文字，不是用户内容。
- **安全/隐私**：共享的系统提示、工具和历史都取自同一 `produce` 内的 `lastRequest`，不会跨 run/跨对话复用；出口遮盖对相同前缀是确定性的（同值同占位符），摘要请求重新走 `admitPiStream`，继续做遮盖和准入。新指令已进入 `TRUSTED_PROMPT_TEXTS`，`trusted-prompt-egress` 会逐条检查它原样发出。
- **资源耗尽**：每次压缩会 `buildSessionProjection`、`convertToLlm`、对每条消息 `JSON.stringify` 和 `isDeepStrictEqual`，是 O(整个切点前缀) 的一次性开销，没有新增持久状态；窗口检查有 4096 token 固定余量，但非 ASCII 估算的保守性未核实。
- **不可撤销操作**：摘要请求本身是只读模型调用；按设计不会执行工具。未能读到 Pi 1.5.0 的 `completeSummarization` 源码，这一点按“未核实”处理，不是已证实缺陷。
- **规则文件/文档一致性**：问题 3 列出的 ADR 0207 测试段、`pi-development-guide`、ADR 0165、kv-cache-guide 都与最终代码不一致。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 正常对话请求：不会。改动只是在 `governedModelRuntime` 里记录 `lastRequest`、在钩子里记录 `compactionPrefix`，没有修改 `himawariRequestContext` 或正常请求的 `messages`/`systemPrompt`/`tools`。
   - 摘要请求：它会复用上一次正常请求的前缀（系统提示、工具、切点前历史），然后**只在末尾追加**固定指令（`compaction-prefix.ts:62-72`）。它相对上一次完整请求是“前缀 + 新末条消息”，不是把新内容插到中间；这正是为了命中缓存。压缩后下一次正常请求开头会变短，这是规则第 12 条允许的压缩例外。
   - 每轮会变的值：总结指令是固定文字，放在最后一条消息；`sessionId`/`cacheRetention` 放在请求选项里，取自上一次普通请求，不是每轮新值。追加消息的 `timestamp` 取自历史最后一条，只在最后一条消息里，不影响共享前缀。结论：正常请求仍然只追加；摘要请求是“共享前缀 + 末尾指令”，没有把每轮变化值放进共享前缀。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   - 新增的总结指令是固定字符串，来源是 prompt catalog，没有时间、随机数或集合顺序。
   - 摘要请求的共享前缀直接复用 `lastRequest.messages` 的对象和顺序；出口遮盖对相同值和相同前文是确定性的（同一值映射到同一占位符），因此同一前缀在不同请求里应序列化成相同字节。
   - 需要保留：`sharedSummaryContext` 只用 `isDeepStrictEqual` 做结构化比较，不是逐字节比较；`[COMPACT-2]` 也是解析 JSON 后 `toEqual`。作者说“请求体由同一序列化路径生成”在纯文本场景成立，但工具消息场景未验证。**未核实的风险见“推测”第 3 条。**
   - 追加消息的 `timestamp` 可能随历史不同而变化，但它只在最后一条消息里，不会让共享前缀变成不同字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：`[COMPACT-2]` 在 `prompt-prefix.compat.test.ts`，由 `npm run check:prompt-prefix` 运行；按断言推断，撤掉改写后找不到“最后一条消息含 `Do NOT continue it`”的摘要请求，测试会失败（我没有运行测试，按代码推断）。
   - 有：`compaction-prefix.unit.test.ts` 的对不上/窗口/没有上一次请求反向用例，如果去掉对应条件会失败。
   - 但覆盖不完整：`compactionPrefixMessages` 的 manual/threshold/overflow、split turn、cut<=0 没有测试；`[COMPACT-2]` 没有工具调用历史，也没有“退回默认请求”的集成反向断言；这些反向单测不在 `npm run check` 里；`check:prompt-prefix` 只要求至少 8 条通过，不点名 `[COMPACT-2]`。所以“有检查”，但不足以证明真实生产条件（工具消息、长历史、各种退回路径）都被锁住。

4. **改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
   - `runtime.compaction.summary-instruction` / manifest `sha256`：消费者是 `apps/agent-service/test/prompt-catalog.unit.test.ts` 的 `manifestProblems`，会检查 digest、reason、changedIn；如果 hash 不是按 `segments` 生成，检查会失败。我无法运行测试，hash 未核实。
   - `usedBy`：消费者是 prompt-wording 的 `unfrozenProblems`，它不会因为指向错文件而失败，但清单本身是错的（问题 4）。
   - `COMPACTION_SUMMARY_INSTRUCTION.text`：消费者是 `approximateTokens`、摘要请求末条消息、`TRUSTED_PROMPT_TEXTS` 和 `trusted-prompt-egress`。文本是固定 ASCII，不含日期/密码数字；trusted 和 manifest 检查会接受它（hash 待核实）。
   - `sharedSummaryOptions` 产生的 `sessionId`/`cacheRetention`：消费者是 Pi 的 `streamSimple`/provider header；单元测试只验证合并逻辑，集成测试读不到请求选项，所以生产端是否接受这两个值未核实。丢弃 Pi 的 `cacheRetention:"none"` 是有意的，但如果上一次普通请求没有这两个字段，摘要请求会不传它们——这与“沿用上一次普通请求的设置”一致。
   - `usagePurpose: "other"`：沿用已有值，`[COMPACT-1]`/`[COMPACT-2]` 已断言它出现在用量记录里。
   - `lastRequest`、`compactionPrefix`：只在同一 `produce` 内使用，生命周期正确；`compactionPrefix` 在 `compaction_end` 清空，`lastRequest` 不跨 run 复用。
   - `approximateTokens` 的窗口结果：只影响“是否共享”，最坏退回 Pi 默认请求；不会改变正常对话内容。
   - 新 ADR 编号 0207、backlog `record_state: "done"`、incidents I-92 行：本地文件/编号/格式看起来能被现有检查接受；ADR 0207 与 ADR 0165 的决定冲突未在文档中声明，见问题 3。
