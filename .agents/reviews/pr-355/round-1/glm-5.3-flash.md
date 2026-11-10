## 复核结论（按严重度排列）

### 中 · `docs/adr/0205-adopt-pi-official-request-head-and-session-runtime-wrapper.md:49`、`docs/pi-development-guide.md:355`
**问题**：「删除前后 83 条请求体逐字节相同（`cmp` 无差异）」这一关键经验断言没有任何可复现的证据留在仓库里——没有金样请求体、没有对比脚本、没有运行记录。它被写进了 ADR（“第 1 步完成”的唯一证据）和规范 D6 行（“请求逐字节不变”），复核者无法验证。
**证据**：ADR 第 49 行原文「删除前后用同一组 26 个多轮用例各抓一遍真实请求体，83 条请求体逐字节相同（`cmp` 无差异）」；仓库中 `.agents/reviews/topic-pi-official-request/round-2/deepseek-v4.1-flash.md` 在 diff 里只有 1 字节且未随 sparse checkout 检出，双模型复核记录也不完整。
**建议**：把逐字节对比固化为可复现工件（如 `__request_golden__` 金样目录 + 测试，参照 ADR 0161 的做法），或在 ADR 附上可重跑的脚本与命令。

### 低 · `docs/pi-development-guide.md:174-185`
**问题**：「系统提示」一节仍把 `pi.on("before_agent_start", () => ({ systemPrompt: frozenSystemPrompt }))` 写成「Himawari 的写法」，而本次提交恰好删除了这个用法。同一提交只改了第 72 行表格的「现状」列，正文没跟上。
**证据**：第 179-183 行原文「Himawari 的写法（系统提示按对话冻结，每轮返回同一份字节）：`pi.on("before_agent_start", () => ({ systemPrompt: frozenSystemPrompt }));`」；对照被删的 `pi-runtime-adapter.ts` 旧代码块（diff -7 行）。
**建议**：该节改为资源加载器 `systemPromptOverride` 的写法，注明 D6 已并入 ADR 0205。

### 低 · `docs/adr/0205...md:34` vs `packages/runtime-pi/package.json:11`
**问题**：前提 1 引用 `pi-coding-agent@1.5.1` 的文档行号，仓库实际固定 `1.5.0`。ADR 自己注明「(1.5.0 同)」，规范第 63 行也声明按锁定版本再核对，属可接受的引用方式，但直接照抄行号有漂移风险。
**证据**：`"@earendil-works/pi-coding-agent": "1.5.0"`。
**建议**：无需改动，保持「写代码前按锁定版本再对一遍」的惯例即可。

---

## 读代码证实的（与推测/未核实分开）

**证实：**
- 作者依据 1：`pi-runtime-adapter.ts:1422-1423` `systemPrompt: ""` + `systemPromptOverride: () => systemPrompt`，与被删扩展用的是**同一个闭包变量** `systemPrompt`（1319-1324 构建，扩展旧代码 `() => ({ systemPrompt })` 也是它）→「同一份提示」成立。
- 作者依据 2：`himawariRequestContext`（652-667）只从 `requested.messages` 读工具名（做一致性检查）和非 system 历史；systemPrompt 一律用冻结变量；system 角色消息全部过滤。工具不一致直接 `PI_REQUEST_TOOLS_DIVERGED`（1621）。Pi 自己的开头内容进不了发出的请求。
- 审批续跑不受影响：`capturePiToolBatch(active, ..., systemPrompt)`（1529-1534）存的是适配器变量，恢复时 `piToolBatchSessionManager(continuation.batch, systemPrompt, ...)`（1512）与 `PI_CONTINUATION_SYSTEM_PROMPT_CHANGED` 校验（`pi-tool-batch-continuation.ts:156-157`）比较的两端都是适配器变量，与 `before_agent_start` 无关。
- 适配器内没有任何读 `session.systemPrompt` 的代码（grep `packages/runtime-pi/src` 证实）。
- 26 个用例数属实：`prompt-prefix.compat.test.ts` 恰有 26 个 `it()`，含 6 条 REVERSE；该文件在本次 diff 中未改动，基线与 HEAD 同一套用例。
- `check:prompt-prefix` 存在且是 `npm run check` 的一步（`package.json:55`、`scripts/check-prompt-prefix.mjs`、`.claude/rules/prompt-prefix.md:74`）。
- 无测试引用 `before_agent_start`（grep 全部 `*.test.ts` 无匹配），删扩展不会使断言失效。

**未核实（Pi dist 不在检出内，node_modules 未随仓库检出，也不能运行命令）：**
- 作者依据 3 / ADR 前提 4：压缩和分支摘要用 Pi 自带 `SUMMARIZATION_SYSTEM_PROMPT`、与 `before_agent_start` 无关（`compaction.js`、`agent-session.js` 读不到）。间接证据一致：prompt-prefix 规则第 13 条明写 Pi 压缩「系统提示也换成它自己的一份」；`[COMPACT-1]` 用例（`prompt-prefix.compat.test.ts:841-880`）断言摘要请求 `messages[0].content` 含 `context summarization assistant`。
- `DefaultResourceLoader` 运行时是否真正采纳 `systemPromptOverride`（选项在 TS 类型里，typecheck 能挡错名，但运行时行为读不到 dist）。
- 「83 条逐字节相同」「npm run check:prompt-prefix 通过」：无法运行验证。
- 压缩触发阈值估算是否读 `session.systemPrompt`：读不到 Pi 内部。若读，删除前后值相同（同一字符串经 override 提供），估算不变；若 override 未被采纳则可能变空——此项风险依赖上一条未核实项。

---

## 侧重检查

走了一条最普通的使用流程（一次普通对话轮）：投影 → `systemPrompt` 构建（1319-1324）→ 资源加载器（1413-1509，含 `systemPromptOverride`）→ `prehydrateSession`/续跑 SessionManager（1511-1515）→ `createAgentSession`（1547）→ `streamFunction` 替换（1614）→ `himawariRequestContext`（652-667）→ `admitPiStream` → 传输层。整条链路上被删扩展唯一可能的影响点是 Pi 侧 `session.systemPrompt` 的消费方——适配器路径全部用冻结变量，**无测试覆盖的路径**是 Pi 内部（压缩阈值估算、摘要提示来源），见上「未核实」。测试覆盖方面：本次删除没有新增任何测试，完全依赖既有 26 用例门 + 作者手工字节对比；文档一致性上发现 pattern-system-prompt 节过期（低严重度第 2 条）。

---

## 必答问题逐条回答

1. **不会改变已见请求开头。** 发出的请求开头由替换后的 `streamFunction` 用冻结 `systemPrompt` + `requestTools` 重建（1614-1617），system 消息被过滤，Pi 自己的开头不进请求；本次改动只删除一个返回闭包常量的钩子，是纯减法，仍是只在末尾追加，每轮变化的值（时间、资料、运行环境）仍只在最后一条消息（机制未被本 diff 触碰）。
2. **不会。** 删除不产生任何新值，被删钩子返回的是闭包内冻结常量，无时间、无前后文依赖、无集合顺序问题。
3. **部分有。** 既有 26 用例（含 6 条 REVERSE）+ `check:prompt-prefix` 仍原样运行，守住「只追加」；但没有针对本次删除的新断言，「删除前后逐字节相同」未固化为可复现检查。且要注意：即使将来有人加回一个内容不同的 `before_agent_start` 提示，`check:prompt-prefix` 也抓不到——因为开头总是被 streamFunction 覆盖。
4. **能接受。** 本改动只「删除」不「新增」：被删的扩展名 `himawari-system-prompt` 与监听在全仓库只剩文档引用（guide:355、ADR:28/49），无代码消费方；续跑校验两端都用适配器变量，一致；Pi 内部对 `session.systemPrompt` 的任何使用拿到的字符串不变（同一变量经 override 提供，前提是 override 被采纳——未核实）。
5. **特别问题**：审批续跑（`agent.continue()`/D3 回放）不受影响（证据见上）；压缩触发阈值估算——适配器侧无影响，Pi 内部未核实但删除前后输入值相同；读取 `session.systemPrompt` 的地方——适配器内没有，Pi 内部未核实。
