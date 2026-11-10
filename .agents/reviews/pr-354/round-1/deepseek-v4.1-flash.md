## 复核发现（按严重度）

### 1. 中｜`packages/runtime-pi/test/tool-batch-state.unit.test.ts:82,95,107`：新增代码超过行宽，`format:check` 会失败
- **已读代码证实。** 这三行把原来多行的假会话对象压成了一行，例如：
  - `const session = { sessionManager, messages: f.session.messages, getToolDefinition: f.session.getToolDefinition } as unknown as AgentSession;`
  - `{ sessionManager: unstored, messages: f.session.messages, getToolDefinition: f.session.getToolDefinition } as unknown as AgentSession,`
- 仓库 `biome.json:14-17` 规定 `"lineWidth": 100`，`package.json:73` 的 `format:check` 是 `biome format .`，`package.json:27` 的 `check:steps` 第一项就是它。`.agents/reviews` 被排除，但这个测试文件没有被排除。
- `git diff --check` 只查空白，不查格式化，所以不能说明这里通过。
- **建议：** 对这三个文件运行 `npm run format` 或按 Biome 格式拆行，再跑 `npm run format:check`。

### 2. 低｜`docs/pi-development-guide.md:354`：D5 偏离表与 ADR/代码不一致
- **已读代码证实。** 表格仍写着：
  - “`continue`、`hasQueuedMessages` 和读工具的执行方式（`executionMode`）在 `docs/sdk.md` 里没有会话层接口，需要另查”
- 但同一行的位置列已写“读历史和工具已在 2026-11-10 改成 `session.messages`、`session.getToolDefinition`”，代码也确实在 `pi-tool-batch-continuation.ts:75` 使用 `session.getToolDefinition(call.name)`；`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:38,48` 也把 `getToolDefinition` 当作会话接口并作为决定依据。
- **建议：** 把“读工具的执行方式……需要另查”改为“读工具执行方式用 `session.getToolDefinition`”，只保留 `continue`、`hasQueuedMessages` 等仍未改的部分。

### 3. 低｜`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:40`：D2/D3 测试引用不完整
- **已读代码证实。** 前提 5 说“审批写在工具 `execute` 里、存快照后结束运行（D2）……已有测试”，引用的是 `pi-tool-batch-continuation.compat.test.ts` 的两个用例。这两个用例中的受控工具确实在 `execute` 里调用 `capturePiToolBatch` 并抛 `PRODUCT_SUSPENDED`（`pi-tool-batch-continuation.compat.test.ts:66-68,238-240`），也确实覆盖“回放回答、新建会话续跑”。
- 但它们使用的是测试自定义工具，没有经过 `PiAgentRuntimeAdapter.createTool` 里的 `tools.preflight` / `reconciliation.suspend`。真正覆盖适配器审批挂起的是另一个测试：`pi-runtime-adapter.compat.test.ts:2494` 起，尤其 `2521-2557` 的 `preflight` 和 `awaiting_approval`。
- 因此“D2/D3 已有真实 Pi 测试”这个结论本身成立，但 ADR 只引用续跑协议测试，容易让人以为适配器的审批路径也被这两个测试覆盖。
- **建议：** 在前提 5 同时引用 `pi-runtime-adapter.compat.test.ts` 的 “suspends and resumes a generic side-effect tool” 用例，或明确说明前者覆盖协议、后者覆盖适配器。

### 4. 待核实｜`packages/runtime-pi/src/pi-tool-batch-continuation.ts:27,75`：`getToolDefinition` 与“活动工具”是否完全等价
- **推测，未能在本检出证实 Pi 源码。** 旧代码在 `session.agent.state.tools` 里找，新代码在 `session.getToolDefinition(call.name)` 里找。ADR 前提 4 用“把全部工具名交给 Pi、仓库没有 `setActiveToolsByName`”论证二者等价；仓库这一半我已核对：
  - `pi-runtime-adapter.ts:1561`：`tools: descriptors.map(({ name }) => name)`
  - 全仓库 grep `setActiveToolsByName` 只命中 ADR 本身。
- 但“已注册但未激活的工具、隐藏内置工具是否也出现在 `_toolDefinitions`”取决于 Pi 1.5.0 源码，本检出没有 `node_modules`，无法核对 ADR 引用的 `agent-session.js` 第 1123–1125 行和 `tool-definition-wrapper.js` 第 11 行。
- **风险：** 若 `getToolDefinition` 查询的是全局注册表而不是本次活动工具集合，模型输出一个已注册但未激活的工具名时，`runsInParallel` 可能把它算进并行批次，从而改变 `parallel` 快照标志和 `checkedBatch` 的结果数量校验。正常 Himawari 工具都在 `tools` 列表里，所以风险低；但这是一个未覆盖的反向路径。
- **建议：** 加一个真实 Pi 测试：注册一个工具但不放入活动工具列表，确认 `runsInParallel` 与旧逻辑一致；或者把查询限定在本次下发的工具名集合内。

---

## 未核实项

- ADR 0204 前提 2、3 引用的 Pi 1.5.0 源码行号（`session.messages` getter、`getToolDefinition`、`executionMode` 包装）无法在本检出核对，因为当前是 sparse checkout，`node_modules/@earendil-works/pi-coding-agent` 不存在。相关行为只能由 `pi-compat` 测试间接证明，我没有运行测试。
- `session.messages` 的返回类型是否与 `previousFileConflict` 的参数类型 `AgentSession["agent"]["state"]["messages"]` 完全兼容、`getToolDefinition` 是否存在于公开类型中，需要 `npm run typecheck` 验证；本次未运行。
- 前提 1 的聊天消息 ID 属于外部记录，仓库内无法核对。

---

## 侧重检查

- **错误路径**：`getToolDefinition` 返回 `undefined` 时新代码仍返回 `false`，与旧逻辑一致（`pi-tool-batch-continuation.ts:75-76`）。但“未注册/未知工具名”没有新增测试。
- **不可信输入**：`assistant.content` 里的 `call.name` 来自模型输出。旧代码只查活动工具，新代码查会话注册表；若两者范围不同，恶意或异常模型输出可能改变 `parallel` 判定。属于上述待核实项，未见直接安全后果。
- **资源耗尽/不可撤销操作**：本次改动只读消息和工具定义，没有新增执行、写入、网络或持久化操作；`parallel` 只是续跑快照中的布尔值，不直接触发工具执行。
- **规则/文档一致性**：D5 文档表述已过时（发现 2）；D2/D3/D5/D6/D7 的状态列与 ADR 0204 的决定基本一致；ADR 0204 的链接和锚点存在。
- **请求前缀**：改动没有新增系统提示、工具定义、历史消息或遮盖逻辑的变化。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（在 `session.messages` 确实等价于 `agent.state.messages` 的前提下）。改动只是读取路径替换：历史捕获 `pi-runtime-adapter.ts:1680`、压缩后运行环境判断 `:1701`、文件冲突检查 `:2009`，以及续跑模块 `pi-tool-batch-continuation.ts:35`。没有新增或重排发给模型的消息，没有新增每轮变化值；新算出的 `parallel` 只写入续跑快照，不进入模型请求。因此“只在末尾追加、变化值在最后一条消息”这一规则没有被这个改动破坏。若 `session.messages` getter 与底层消息列表不等价，则历史捕获内容可能变化，这一点依赖上文的未核实项。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。没有新增时间字段、随机值、无序集合或依赖后文的遮盖。`structuredClone`、`filter`、`JSON.stringify` 的输入仍是同一批消息；`getToolDefinition` 只是按名字查表，结果是确定的。`parallel` 布尔值也不参与模型请求序列化。

3. **有没有对应自动检查，反向用例真的会失败？**
   有部分覆盖：`pi-tool-batch-continuation.compat.test.ts` 用真实锁定版 Pi 覆盖 `session.messages` 和 `getToolDefinition`；`[NL-1]` 要求并行自定义工具得到 `parallel: true`，若 `getToolDefinition` 查不到已注册工具，该断言会失败；顺序工具用例也要求恢复时拒绝 `parallel` 快照。`pi-runtime-adapter.compat.test.ts:2494` 起还覆盖了真实 Pi 下的审批挂起/续跑。
   但缺少“已注册但未激活/隐藏工具”的反向用例，也缺少直接断言 `session.messages` 与旧 `agent.state.messages` 等价的测试。另外，当前测试文件的新代码会触发 `format:check` 失败，这是一个实际会失败的反向检查。

4. **每个改动值的生产者和消费者两端都能接受吗？**
   - `session.messages`：生产者是 Pi 的会话 getter；消费者是 `pi-runtime-adapter.ts:1680,1701,2009` 和 `pi-tool-batch-continuation.ts:35`。前两处接受消息列表，`previousFileConflict` 接受与 `AgentSession["agent"]["state"]["messages"]` 同形的数组；类型是否完全兼容未运行 typecheck，未核实。
   - `getToolDefinition`：生产者是 `AgentSession`；消费者只有 `pi-tool-batch-continuation.ts:75`，只读 `executionMode`，并显式处理 `undefined`。单元测试的假会话只返回 `read`，生产路径使用真实会话。
   - `BatchSession` 字段变更：全仓库调用 `capturePiToolBatch` / `restorePiToolBatch` 的地方只有适配器和两个测试文件，测试假会话已同步补 `messages`、`getToolDefinition`；没有发现遗漏的旧 `agent` 调用方。
   - `parallel` 标志：生产在 `pi-tool-batch-continuation.ts:59`，消费在 `checkedBatch` 和 `restorePiToolBatch`；两端都调用同一个 `runsInParallel`，快照版本仍是 `pi-tool-batch.v3`，序列化格式未变。跨会话恢复时依赖恢复会话的工具注册表与捕获时一致；Himawari 两处用同一批 descriptors 建会话，正常情况下成立，但上述“未激活工具”边界未覆盖。

**总体结论：** 未发现会改变请求前缀或字节确定性的直接问题；主要可落地的缺陷是测试文件未格式化（会使 `npm run check` 失败）以及 D5 文档表述过时。Pi 源码层面的“行为完全不变”在本检出无法独立证实，且“注册但未激活/隐藏工具”的等价性缺少自动反向用例。
