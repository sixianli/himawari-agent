## 结论先行

本轮（`ddb4bd39` + `6ecc811a`）确实只改了 `AGENTS.md`、`docs/pi-development-guide.md` 和 `.agents/instructions/pi-and-workspace.md`（`git diff --stat 02c78c52..6ecc811a` 中无运行时代码）。作者列的 7 条改动基本都能在 diff 里找到。下面按严重度列出发现的问题。

---

## 读代码证实的问题

### 中：D5 偏离清单仍漏掉 `pi-tool-batch-continuation.ts` 读 `agent.state.messages`

- 文件:行：`docs/pi-development-guide.md:352`
- 问题：本轮补了 `pi-tool-batch-continuation.ts` 读 `agent.state.tools`，但同一文件还直接读 `session.agent.state.messages`，D5 的“位置”列没有列出来，只把读 `state.messages` 归到 `pi-runtime-adapter.ts`。这与该表“列出所有绕过会话层直接用底层 Agent 的位置”的目的不一致。
- 证据：
  - `packages/runtime-pi/src/pi-tool-batch-continuation.ts:37`：`const messages = session.agent.state.messages;`
  - 同文件 `:74`：`const tools = session.agent.state.tools;`
  - 指南 `docs/pi-development-guide.md:352`：`| D5 | pi-runtime-adapter.ts 里的 ... 读 agent.state.messages；pi-tool-batch-continuation.ts 读 agent.state.tools |`
- 建议：把 `pi-tool-batch-continuation.ts` 的“读 `agent.state.messages`”也写进 D5 的位置列，避免下一轮复核或升级 Pi 时漏查。

### 低：`AGENTS.md` 新句子的“见下文”方向写反

- 文件:行：`AGENTS.md:103`
- 问题：新加的句子写“见下文 Andy 定的长期规则”，但“Andy 定的长期规则”一节在 `AGENTS.md:62`，位于该句上方。读者从第 103 行往下找不到。
- 证据：
  - `AGENTS.md:103`：`...（见下文 Andy 定的长期规则）。...`
  - `AGENTS.md:62`：`## Andy 定的长期规则`
- 建议：改成“见上文”或直接写成 `[Andy 定的长期规则](AGENTS.md#owners-standing-rules)` 这类锚点链接。该错误不会被 `check:docs-links` 抓到，因为它不是链接，只是普通文字。

### 低：“经授权的磁盘路径”可能夸大适配器自身的校验

- 文件:行：`docs/pi-development-guide.md:106`
- 问题：新句子说“适配器还接受经授权的磁盘路径（`additionalExtensionPaths`、`additionalSkillPaths`、`additionalPromptTemplatePaths`，来自 `resources` 端口）”。但适配器里的 `authorizedPaths` 只校验“非空字符串、无重复”，并不校验路径是否真的被授权；授权完全依赖可选的 `resources` 端口。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:739-746`：`if (paths.some((path) => typeof path !== "string" || path.trim().length === 0)) ... if (new Set(paths).size !== paths.length) ... return [...paths];`
  - 同文件 `:1281-1284`：`this.#dependencies.resources?.resolveAuthorized(...) ?? Promise.resolve(EMPTY_RESOURCES)`
  - `apps/agent-service/src/production-run-composition.ts:403-450` 构造 `PiAgentRuntimeAdapter` 时没有传 `resources`，所以生产当前确实是空列表。
- 建议：把措辞改成“路径由 `resources` 端口授权；适配器只校验非空和去重；2026-11-10 生产没有接该端口”。这样以后真接上该端口时，读者不会误以为适配器本身会做权限判断。

### 低（测试缺口）：`tool_call` 先于 `execute` 的顺序断言没有自动检查

- 文件:行：`docs/pi-development-guide.md:161`
- 问题：新增的“`tool_call` 先于工具的 `execute` 运行，在这里改了参数，Himawari 在 `execute` 里做的权限判断看到的是改后的参数”是一条与权限相关的行为断言。仓库里没有测试验证“`tool_call` 改参数后 `preflight` 看到改后的参数”；升级 Pi 后这条说法可能悄悄失效。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:2029` 用 `arguments: safeArguments(parameters)` 构造 invocation；
  - 同文件 `:2050` 调 `this.#dependencies.tools.preflight(invocation)`；
  - 搜索 `packages/runtime-pi/test` 未发现对 `tool_call` 改参数后 `preflight` 收到新参数的用例。
- 建议：在 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 或 `prompt-prefix.compat.test.ts` 加一条：注册一个改 `event.input` 的 `tool_call` 扩展，断言 `preflight` 收到改后的参数；再加一条反向用例，改成危险参数后必须被 `preflight` 拒绝。只有这样才能保证文档里的顺序断言有代码兜底。

---

## 推测 / 未核实

- **无法读第 1 轮判断记录**：`git show 02c78c52:.agents/reviews/pr-353/round-1/judgments.md` 返回 `REVIEW_GIT_REFUSED records-path`，这些 `.agents/reviews` 文件在仓库里是二进制/加密形式。因此作者“第 1 轮意见和处理见 judgments.md”以及第 1 轮是否真正解决，我无法核实；只能核对代码和本轮 diff。
- **Pi 官方文档行号和原文**：本环境不能上网，也没有安装/解包 `@earendil-works/pi-*`，`docs/extensions.md` 第 615、815、829、973 行等说法只能算未核实。指南里关于 `tool_call` 在 `execute` 之前的顺序，代码侧能证明 `execute` 用 `parameters` 做 `preflight`，但“Pi 会把 `tool_call` 改过的 `input` 原样传给 `execute`”仍依赖 Pi 行为。
- **`npm pack` 两个版本都能拉到**：锁文件显示 `pi-agent-core`、`pi-ai`、`pi-coding-agent` 都有 1.5.0（`package-lock.json:933-948, 1019-1026`），但 1.5.1 是否存在对应三个包、npm 当前是否还能拉取，未联网核实。
- **提交说明里的检查结果**：`check:docs-links`、`check:markdown-tables` 等脚本确实存在（根 `package.json:31-55, 98-99`），但本环境不能运行，提交说明所称“全过”未核实。

---

## 侧重检查

- **错误路径 / 不可信输入**：`authorizedPaths` 只拒绝空路径和重复路径（`pi-runtime-adapter.ts:739-747`），不检查路径是否在允许目录、也不做规范化；如果以后把 `resources` 端口接到生产，磁盘上的扩展/技能/提示模板代码会被 Pi 加载执行。生产当前没接该端口（`production-run-composition.ts:403-450`），所以现在没有新增暴露面。建议指南把“授权由端口负责”写清楚。
- **安全**：`tool_call` 改参数后 `preflight` 使用 `safeArguments(parameters)`，且真正执行也使用同一个 invocation（`pi-runtime-adapter.ts:2029, 2050, 2082`），没有发现“权限检查看一套参数、执行看另一套参数”的分裂。但如果参数被改成非对象，`safeArguments` 返回 `{}`（`:293-296`），权限判断和实际执行都会看到空参数，不会绕过成危险参数，但会静默丢掉参数；这一点当前没有测试。
- **资源耗尽 / 不可撤销操作**：本轮只改文档，没有新增运行路径、重试、写操作或删除操作。
- **规则、说明文档和代码一致性**：
  - 新增的第 7 条与 `.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features` 一致（“大改动先出方案”）。
  - `prompt-prefix.md` 的“只追加、会变的值放最后、系统提示冻结”与指南新写法一致。
  - `AGENTS.md:103` 的“见下文”方向错误，见上文问题。
  - D5 的清单项与代码不完全一致，见上文问题。
  - ADR 0203 说“7 处现有偏离”，指南表格仍是 D1–D7 共 7 条，数量一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本轮 diff 只涉及 `AGENTS.md`、`docs/pi-development-guide.md`、`.agents/instructions/pi-and-workspace.md` 和复核记录，没有改 `packages/runtime-pi` 或任何运行时代码。发给模型的内容仍然由代码决定，本轮没有改代码。文档层面新增的 `before_agent_start` 示例明确要求返回冻结的系统提示，`context`/`context_with_system` 示例标注“不得照抄”，都在强化“只在末尾追加、每轮会变的值只放在最后一条消息里”的规则，而不是改变它。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会（本轮无运行时改动）。** 这是文档改动，不参与请求序列化。新增说明也明确要求系统提示按对话冻结、每轮返回同一份字节；没有引入时间字段、无序集合或依赖前后文的遮盖规则。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**本轮没有新增针对行为的自动检查。** 文档改动只受现有 `check:docs-links`、`check:instruction-links`、`check:markdown-tables`、`check:glossary` 约束；这些检查抓不到 `AGENTS.md:103` 的“见下文”方向错误，也抓不到 D5 清单漏项。新增的 `tool_call`→`execute` 顺序断言没有测试，更没有反向用例。建议补一条 compat 测试：`tool_call` 改参数后 `preflight` 必须看到改后的参数；反向用例改成危险参数后必须被拒绝。现有 `check:prompt-prefix` 的反向用例不属于本轮改动，且本环境不能运行，未核实其实际失败结果。

### 4. 改动产生或修改的每个值，使用它的一方都能接受吗？

**本轮没有新增标识、字段、配置键或序列化格式。** 唯一被修改的“清单项”是 D5。指南表格仍为 D1–D7 共 7 条，ADR 0203 第 4 条和第 70 行仍写“7 处”，数量一致；D5 的交叉链接 `#current-deviations` 有效。问题在于 D5 内容不完整：`pi-tool-batch-continuation.ts:37` 读 `agent.state.messages` 没有被列进去，而该文件已经因为 `state.tools` 被列在同一行，读者会误以为这个文件的底层状态读取只有 `state.tools`。除此之外，`packages/runtime-pi/package.json:10-11` 的锁定版本仍是 1.5.0，与指南“2026-11-10 锁定 1.5.0”一致；生产构造点确实没有传 `resources`，与指南第 106 行的说法一致。
