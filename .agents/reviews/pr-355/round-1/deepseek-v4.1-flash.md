# 复核结论

先说明：本次只用了 read、grep、glob 和 git diff/log，**没有执行测试**；凡是“测试通过”的说法，我都只能核对测试内容，不能验证运行结果。作者列出的方案和依据已逐条对照代码。

## 按严重度排列

### 1. 严重度：中 — 与已生效的 ADR 0204 直接冲突，且未声明取代
**文件：行**：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:5,49`；`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:65,72`

**问题**：ADR 0204 明确把“D6 单独先改”列为放弃的做法；ADR 0205 却把“单独删除 D6”作为已完成的第一步，并在 front matter 写 `supersedes: ""`，没有声明取代或修订 ADR 0204。两份 ADR 同日、同为 `accepted`，结论互相矛盾。

**证据**：
- ADR 0204:65：`**D6 单独先改。**去掉请求函数里那次替换就是在改 D1；去掉 before_agent_start 会改变 Pi 会话里记下的系统提示，它被哪些路径用到（例如压缩）要和 D1 一起查清，本 ADR 没有查。`
- ADR 0204:72：`D5 剩下的部分、D6、D7、D1、D4 仍不得照抄。`
- ADR 0205:49：`1. **D6：删掉 himawari-system-prompt 扩展。** ... 第 1 步完成`
- ADR 0205:5：`supersedes: ""`

**建议**：要么在 ADR 0205 明确写“取代 ADR 0204 中关于 D6 的放弃条目”，并同步更新 ADR 0204 的状态/引用；要么补充 ADR 0204 要求的调查（Pi 会话里记下的系统提示被哪些路径读取），再合并。文档一致性不能靠口头“Andy 同意”留在两份相反 ADR 里。

---

### 2. 严重度：中 — 作者依据 2 和 ADR 的关键表述与代码不符
**文件：行**：`packages/runtime-pi/src/pi-runtime-adapter.ts:1615-1617`；`pi-runtime-adapter.ts:669-677`；ADR 0205:49

**问题**：作者说“替换函数总是用冻结的 `systemPrompt` 重建请求开头”“现在的替换函数从不读 Pi 的开头，只读 Pi 声明的工具名”。这在**压缩请求**上不成立：`compacting` 为真时走 `himawariSummaryContext(requested)`，它直接读取 Pi 传进来的第一条 system 消息作为 `systemPrompt`。因此“从不读 Pi 的开头”是错的，依据 2 也不准确。

**证据**：
- `pi-runtime-adapter.ts:1615-1617`：
  ```ts
  const summaryContext = compacting ? himawariSummaryContext(requested) : undefined;
  const context =
    summaryContext ?? himawariRequestContext(requested, systemPrompt, requestTools);
  ```
- `pi-runtime-adapter.ts:671-675`：
  ```ts
  const [first, ...rest] = requested.messages;
  if (first?.role !== "system" || typeof first.content !== "string") return undefined;
  return {
    systemPrompt: first.content,
  ```
- ADR 0205:49：`现在的替换函数从不读 Pi 的开头，只读 Pi 声明的工具名做一致性检查`

**建议**：把表述改成“对话请求不读 Pi 的 system 开头；压缩请求读取 Pi 的第一条 system 消息”。这不必然推翻“删除 D6 后请求字节不变”的结论，但证据链必须按真实代码描述，尤其是压缩请求也包含在 83 条对比里。

---

### 3. 严重度：中低 — 这次删除没有对应的自动检查，反向用例不会失败
**文件：行**：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:841-883,3438-3503`；`pi-runtime-adapter.ts:1614-1617`

**问题**：现有测试只检查“最终请求体是否满足前缀规则/压缩摘要是否用 Pi 摘要提示”，并不检查 `himawari-system-prompt` 扩展是否还存在。因为替换函数本来就会用冻结的 `systemPrompt` 重建对话请求，**即使把扩展加回去，这些测试仍然会通过**。所以这次删除没有“删掉它会失败”的反向用例；作者说的 83 条逐字节对比是一次性的 `cmp`，仓库里没有留下可重复的脚本或断言。

**证据**：
- 测试 [COMPACT-1] 只断言摘要消息：`expect(parsed.messages[0].content).toContain("context summarization assistant");`（`prompt-prefix.compat.test.ts:877`）
- 审批续跑测试只断言前后系统提示相同：`if (sameSystemPrompt) expect(last.systemPrompt).toBe(first.systemPrompt);`（`prompt-prefix.compat.test.ts:302`，由 3438 起的用例调用）
- 全仓 grep `before_agent_start`，测试文件中没有引用；仓库也没有 `himawari-system-prompt` 的测试断言。

**建议**：至少加一条可重复的检查，例如断言适配器给 `DefaultResourceLoader` 的扩展清单里不再包含 `himawari-system-prompt`，或加一个“注入一个会改系统提示的 `before_agent_start` 扩展，对话请求仍必须是冻结开头”的用例，用来锁住“对话请求不依赖 Pi 开头”的边界。若能接受，把 83 条对比做成脚本或测试快照，而不是只在 ADR 里写 `cmp`。

---

### 4. 严重度：低 — 文档把“手工对比过”写成已完成的强证据
**文件：行**：`docs/pi-development-guide.md:355`；`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:73`

**问题**：“请求逐字节不变”“第 1 步已有逐字节证据”在仓库里没有可复核的产物；而且 D6 行写“已改回官方”，但 D1 行仍明确说明 `session.agent.streamFunction = ...` 整包替换，请求开头仍不是官方生成。单看 D6 这句话成立，放在一起容易被读成“请求开头已照官方”。

**证据**：
- `docs/pi-development-guide.md:355`：`| D6 | ...（已删除） | ... | 二选一 | 已删除，请求逐字节不变 | 已改回官方 ... |`
- `docs/pi-development-guide.md:350`：D1 仍为 `替换 Pi 每次请求模型的函数`
- ADR 0205:73：`第 1 步已有逐字节证据`

**建议**：把“请求逐字节不变”限定为“本次手工对比的 26 个用例/83 条请求”，并注明不是提交到仓库的自动检查；D6 状态改为“扩展已删除，D1 仍保留”，避免与 D1 行冲突。

---

### 5. 严重度：低 — ADR 前提引用的 Pi 版本与锁定版本不一致，且无法在仓库内核实
**文件：行**：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:34`；`packages/runtime-pi/package.json:10-11`

**问题**：ADR 前提 1 引用 `@earendil-works/pi-coding-agent@1.5.1 docs/extensions.md`，仓库实际锁定 `1.5.0`；ADR 只说“1.5.0 同”，但仓库里没有 `node_modules`，无法核对 1.5.0 的 `docs/extensions.md`、`runner.js`、`compaction.js`、`agent-session.js` 原文。前提 4 的“分支摘要”也没有测试或代码证据。

**证据**：
- `package.json:10-11`：`"@earendil-works/pi-ai": "1.5.0"`、`"@earendil-works/pi-coding-agent": "1.5.0"`
- ADR 0205:34：`@earendil-works/pi-coding-agent@1.5.1 docs/extensions.md 第 831 行 ...（1.5.0 同）`

**建议**：把 ADR 的出处统一到锁定的 1.5.0，或明确写“1.5.1 文档，1.5.0 未逐行核对”；“分支摘要”这一条补上仓库内可核对的依据或标为未核实。

---

## 读代码证实的

1. **删除内容本身只有一个 `before_agent_start` 处理器**：diff 显示被删的扩展是 `pi.on("before_agent_start", () => ({ systemPrompt }));`，没有其他副作用。
2. **资源加载器确实提供了同一份提示**：`pi-runtime-adapter.ts:1423` `systemPromptOverride: () => systemPrompt,`；而删除的扩展闭包返回的也是外层的同一个 `systemPrompt` 变量，两者字节来源相同。
3. **对话请求的 system prompt 和工具由替换函数重建**：`himawariRequestContext` 返回 `systemPrompt`、`tools`，并过滤掉 Pi 消息里的 system（`pi-runtime-adapter.ts:652-667`）。
4. **审批续跑走的是同一个替换函数**：`session.agent.continue()` 在 `pi-runtime-adapter.ts:1238` 和 `1778`，随后模型请求仍由 `streamFunction` 在 `1614` 处接管；`before_agent_start` 在 `continue()` 路径本来就不触发（ADR 0084/0165 也这样写）。
5. **压缩请求确实有独立分支**：`pi-runtime-adapter.ts:1615` 的 `compacting ? himawariSummaryContext(requested)`；测试 `prompt-prefix.compat.test.ts:877` 断言摘要系统提示包含 `context summarization assistant`，说明压缩使用 Pi 的摘要提示，而不是 Himawari 的对话系统提示。
6. **历史捕获会过滤 system 消息**：`pi-runtime-adapter.ts:1673` `session.messages.filter((message) => message.role !== "system")`，所以即使 Pi 会话里的 system 提示有变化，也不会进入产品保存的历史。
7. **续跑快照保存和校验的系统提示是外层变量**：`pi-runtime-adapter.ts:1512`、`1533` 传入 `systemPrompt`；`pi-tool-batch-continuation.ts:19` 存储、`:111` 校验类型、`:156` 比较 `checked.systemPrompt !== systemPrompt`。删除扩展不会改变这些值。
8. **身份哈希也使用同一个 `systemPrompt` 变量**：`pi-runtime-adapter.ts:1336-1347`，因此 pending continuation 的身份不会因为删除扩展而变化（前提是 Pi 内部没有额外改写这个变量，见未核实部分）。
9. **Himawari 代码没有读取 `session.systemPrompt`**：全仓 grep 只在文档里出现 `session.systemPrompt`，源码中没有读取点；代码里读的是 `requested.messages`、`first.content`、`session.messages` 等。
10. **测试文件确实有 26 个 `it` 用例**，与作者说的“26 个用例”一致；但 83 条请求体的 `cmp` 结果无法从仓库确认。

## 推测或未核实

- **Pi 内部是否把 `before_agent_start` 的返回写进 `session.systemPrompt`、以及压缩阈值估算是否读它**：未核实。仓库没有安装 `@earendil-works/pi-coding-agent` 源码，无法直接读 `agent-session.js` / `compaction.js` / `runner.js`。从代码可见的事实是：旧扩展返回的字符串和新 `systemPromptOverride` 返回的是同一个变量，所以只要 Pi 是“替换”而不是“拼接/加工”，值应当相同；如果是拼接或额外分节，则未核实。
- **“分支摘要”是否也走 Pi 自带摘要系统提示**：未核实。仓库测试只覆盖 `[COMPACT-1]` 的压缩摘要，没有“分支摘要”用例；ADR 0204 也明确说这些路径“本 ADR 没有查”。
- **83 条请求体逐字节相同**：未核实。没有可重复脚本、快照或提交到仓库的对比产物；我未运行测试。
- **`.agents/reviews/...` 的评审记录内容**：未核实。git diff 把它们标为 binary，且工作区用 read/glob 找不到这些路径；无法据此确认 Andy 的“同意”原话及评审细节。

---

## 侧重检查

- **错误路径**：删除的扩展没有错误处理逻辑，删除它不会新增抛错点。对话请求的失败关闭仍在 `pi-runtime-adapter.ts:1621`（context 不合法则 `PI_REQUEST_TOOLS_DIVERGED`）、`:1622-1623`（暂停/未知工具则拒发）；未发现这次删除改变了这些路径。
- **不合规范或不可信输入**：被删代码不解析外部输入；系统提示仍来自 `systemPromptOverride` 和冻结 bundle，未新增不可信输入面。
- **安全**：没有改动遮盖、密钥、准入或观察点；删除的是重复的系统提示注入路径，未发现扩大暴露面。
- **资源耗尽**：无新增循环、缓存或无界分配。
- **不可撤销操作**：删除代码本身可回滚；pending 审批续跑依赖的快照系统提示字符串在代码层面与删除前相同，未发现需要迁移的字段。若 Pi 内部确实把钩子结果加工后写入 `session.systemPrompt`，则跨版本恢复旧 continuation 的行为未核实。
- **规则/文档与代码一致性**：发现两处实质问题：ADR 0204 与 ADR 0205 对“能否单独做 D6”的结论冲突；ADR 0205 与作者依据 2 对“替换函数从不读 Pi 开头”的表述与 `himawariSummaryContext` 代码不符。其余文档修改（架构文档去掉 `before_agent_start`）与代码一致。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会因为这次删除而改变。对话请求开头仍由 `himawariRequestContext` 用冻结的 `systemPrompt` 和冻结工具重建；会变的时间、材料、主人消息仍由 `turnPrompt` 放在最后一条用户消息里（`pi-runtime-adapter.ts:1614-1643`、`:652-667`、`:1780` `session.prompt(turn, ...)`）。删除的扩展只是重复设置同一份系统提示。需要保留的限定是：**压缩请求不是“只追加”**，它走 Pi 自己的摘要系统提示且工具为空（`pi-runtime-adapter.ts:1615`、`himawariSummaryContext`），这是既有设计，不是本次删除引入的；但作者“替换函数总是用冻结 systemPrompt”的说法对压缩请求不成立。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

不会由这个改动引入。删除是静态的，没有新增时间、随机数、无序集合或依赖后续内容的遮盖。系统提示仍来自冻结 bundle 或确定性的 `productSystemPrompt`；`systemPromptOverride` 与原扩展引用同一个 `systemPrompt` 变量。未发现新的字节不确定性来源。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

没有专门针对这次删除的自动检查。现有 `prompt-prefix.compat.test.ts` 的 26 个用例覆盖前缀追加、压缩摘要和审批续跑，但即使把 `himawari-system-prompt` 扩展加回去，这些用例仍会通过（因为对话请求由替换函数覆盖）。作者说的 83 条逐字节对比是手工 `cmp`，仓库里没有对应脚本或快照；反向用例“重新加入扩展必须失败”不存在。因此这次删除本身没有被测试锁住。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

删除没有产生新值。涉及的关键值核对如下：
- `systemPrompt`：产生点仍是 `bundle?.systemPrompt ?? productSystemPrompt(...)`（`pi-runtime-adapter.ts:1319-1324`）；使用点包括 `systemPromptOverride`（`:1423`）、`himawariRequestContext`（`:1617`）、续跑快照（`:1512`、`:1533`）、身份哈希（`:1336-1347`）。删除前后这些值都来自同一个变量，使用方不需要变化。
- continuation 里的 `systemPrompt`：`pi-tool-batch-continuation.ts:19` 保存、`:111` 校验、`:156` 严格比较。旧快照保存的也是同一个外层 `systemPrompt`，所以新代码能接受旧待审批快照——这一结论基于代码相等性；Pi 运行时行为未核实。
- 扩展清单项：仓库内没有代码读取扩展名称或索引，删除 `himawari-system-prompt` 不改变另外两个扩展的相对顺序，未发现使用方不接受。
- 文档状态值：ADR 0204/0205 的 `decision_status` 与“D6 能否单独做”的结论互相冲突，这是本次改动最需要修正的“使用方不接受”的地方。

**对作者四条依据的核对**：依据 1 正确（`systemPromptOverride` 已提供同一份提示）。依据 2 的结论对对话请求成立，但“总是/从不读 Pi 开头”的表述被压缩分支代码推翻。依据 3 的压缩部分有测试支持，分支摘要未核实。依据 4 的 26 个用例数量正确，83 条 `cmp` 结果未核实且没有提交为自动检查。
