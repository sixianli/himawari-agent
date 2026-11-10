适配层代码已核对大部分偏离条目。现在核对规范引用的规则与 ADR 文件是否存在、锚点是否一致。
规则文件都存在且锚点一致。继续核对 prompt-prefix 规则内容与 ADR 0165/0198/0023 的相关说法。
再核对 ADR 0023 的说法和文档校验脚本是否存在。
最后核对 pi-and-workspace.md 中被引用的原话。
# PR 353 复核报告（独立复核，对照代码逐条核对）

## 侧重检查（先写：走过的流程与结论）

我走的流程：模拟“后来的编码代理要在 Pi 上加一个接入点”这一条最普通的使用路径：

1. 入口 AGENTS.md 新增段落（本次 diff 加在第 103 行附近）→ 链接 `docs/pi-development-guide.md` 与 ADR 0203，两个文件都存在；
2. 规范第一节规则 → 引用 `../.claude/rules/prompt-prefix.md` 的 `#rules`、`#append-only`、`#compaction`、`#before-you-change` 和 `proposal-premises.md`，全部存在且锚点（`<a id>`）对得上；
3. 第三节“官方写法”表里“Himawari 现状”列 → 逐条对照 `packages/runtime-pi/src` 代码（见下文“读代码证实的”）；
4. 第五节偏离表 D1–D7 → 逐条对照 `pi-runtime-adapter.ts` 等文件；
5. 出口：第六节“要偏离时怎么做” → 引用 prompt-prefix 第八节（改动前先问自己），锚点存在。

结论：这条流程上所有文件、锚点、引用条号都对得上。**没有自动检查覆盖的部分**：规范“现状”列与代码的一致性、偏离表与代码的一致性、官方原文行号——这些只能靠人工/模型复核；链接、锚点、表格、ADR 编号有 `check:docs-links`、`check:instruction-links`、`check:markdown-tables`、`check:adr-numbers` 等检查（`.agents/instructions/document-governance.md:28`），但本复核环境不能执行命令，未核实它们通过。

## 发现（按严重度从高到低）

### 1. 低 | docs/pi-development-guide.md:58、101 | “扩展不放在磁盘上”的表述与适配器能力不完全一致

- 证据：guide 第 58 行“扩展不放在磁盘上，而是以 `extensionFactories`……的形式交给 `DefaultResourceLoader`”；第 101 行“关掉磁盘上的扩展……自己的扩展从 `extensionFactories` 传入”。但适配器同时传了磁盘扩展路径：`pi-runtime-adapter.ts:1426-1431` 有 `additionalExtensionPaths: authorizedPaths(resources.extensionPaths, ...)`、`additionalSkillPaths`、`additionalPromptTemplatePaths`。
- 缓解事实：生产组装入口没有接 `resources` 端口（`apps/agent-service/src/production-run-composition.ts:403-431` 构造 `PiAgentRuntimeAdapter` 时无 `resources`），生产走 `EMPTY_RESOURCES`（`pi-runtime-adapter.ts:1281-1284`），所以生产现状确实是“不放磁盘上”。但适配器具备从磁盘加载授权扩展的能力，规范通篇没提。
- 建议：在“建会话”一节补一句：适配器支持经授权的磁盘扩展路径（`additionalExtensionPaths` 等），生产入口未接该端口、留空；避免后来代理读到适配器代码时以为发现“未登记的现状”。
- 定性：读代码证实的差距，非硬伤。

### 2. 低 | docs/pi-development-guide.md:344（D5 行）| 偏离表漏了 `session.agent.continue()` / `hasQueuedMessages()`

- 证据：D5 行“做了什么”只列“`agent.steer`、`agent.abort()`、读 `agent.state.messages`”。代码里还有同样属于“绕过会话直接用底层 Agent”的调用：`pi-runtime-adapter.ts:1237-1239`（`session.agent.hasQueuedMessages()`、`session.agent.continue()`）和 `:1788`（`if (restored) await session.agent.continue()`）。
- 影响：规范第 336 行要求“升级 Pi 时逐条重查第五节”，按表重查会漏掉这两处底层调用；且规范“运行中插消息”一节（第 281 行）只说“不得直接调 `session.agent.steer()`”，没提 `continue`。
- 建议：D5 行的“做了什么”补上 `agent.continue()` / `agent.hasQueuedMessages()`，或在 D3 行注明审批续跑通过 `agent.continue()` 实现。
- 定性：读代码证实的漏项（是否算“偏离”取决于官方是否有等价接口，离线未核实）。

### 3. 信息 | 官方原文引用全部未核实

- guide 引用的 `docs/extensions.md` 行号、原话（如第 973 行“Can block.”）、`docs/settings.md` 第 21 行 1.5.1 `cacheWarming` 默认值、`pi-durable` 标为实验性（D3 行）、`ctx.modelRegistry` 原话等，均取自 `@earendil-works/pi-coding-agent@1.5.1` npm 包。复核环境不联网、包也不在检出里，**未核实**。这不违背作者自己的声明（作者声明 3 已说明），但后续代理照做前应按规范第二节的方法自行核对。

## 读代码证实的（作者说法逐条核对）

以下均已亲自读到对应代码：

- **D1**：`pi-runtime-adapter.ts:1617-1651` `session.agent.streamFunction = ...`，冻结系统提示/工具（1624）、准入（1635 admitPiStream）、出口遮盖（1049-1058 egress.exchange/wrapFetch）、续跑回放（1626-1627 takeReplay）、识别压缩请求（1622、1665 compacting）。D1 行描述逐项与代码一致。
- **D2**：`:2050` `this.#dependencies.tools.preflight(invocation)`、`:2099` `reconciliation.suspend(invocation, result.approval)`，在工具 `execute` 里。✓
- **D3**：`pi-tool-batch-continuation.ts` 存在，适配器 `:94-99` 导入 `capturePiToolBatch/restorePiToolBatch/piToolBatchSessionManager`，`:1518-1521` 续跑时重建 SessionManager。✓
- **D4**：`:639-650` `sessionModelRuntime` 用 Proxy 改写 `hasConfiguredAuth`。✓
- **D5**：`agent.steer`（:1392、:1705）、`agent.abort()`（:1390、:1575、:1596、:1608、:1659、:1691）、读 `agent.state.messages`（:108、:1680、:1701、:2009）——除发现 2 的漏项外描述准确。✓
- **D6**：`:1466-1470` `himawari-system-prompt` 扩展 `before_agent_start` 返回 `{ systemPrompt }`，D1 又在 streamFunction 里换一次。✓
- **D7**：`:1405-1412` `SettingsManager.inMemory` 只有 `compaction/retry/defaultTools`，无 `cacheWarming`；全 `src/` 无 `promptCache` 字段（grep 证实），与“靠模型没填 `promptCache` 才不预热”一致。✓
- **锁定版本 1.5.0**：`packages/runtime-pi/package.json:10-11` 确为 1.5.0，且确在第 10、11 行（ADR 0203 前提 4 的行号引用精确）。✓
- **建会话描述**：`DefaultResourceLoader` + `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`（:1413-1431）、`extensionFactories`（:1432）、`session.dispose()`（:1820）。✓
- **恢复历史**：`prehydrateSession`（:694-737）用 `SessionManager.inMemory(cwd, { id })` + `appendMessage`/`appendCompaction`，无给 `session.agent.state.messages` 赋值的地方。✓
- **工具**：`governed-coding-tools.ts:3-9、124-150` 用 `create*ToolDefinition` 加 `operations`。✓
- **服务方**：`configured-model-binding.ts:104` `ModelRuntime.create`、`:378` `registerProvider`、api `"openai-completions"`。✓
- **后台调用**：`pi-model-transport.ts:359-361` `binding.modelRuntime.stream(..., { fetch: ... })`，`egress.exchange` 包 fetch（:312-313）。✓
- **规则引用**：`pi-and-workspace.md:27` 原话逐字一致（“只能在 `packages/runtime-pi` 中导入……”）；锚点 `#workspace-contract`、`#pi-first-development-principle` 存在；prompt-prefix 各锚点存在，“规则第 13 条”“第八节”条号正确；ADR 0198 决定第 7 条确实写明关自动重试，且代码 `retry: { enabled: false, maxRetries: 0 }`（:1408）一致；ADR 0198 放弃的做法（第 70 行）确实只比较了 `before_agent_start` 一条路；ADR 0023（2026-09-07，Pi 0.x 时期）全文确实没有和 `tool_call` 的比较；`architecture-v0.1.md` 存在。ADR 0203 说 D1 属大改动引用 `owner-standing-rules.md#fixing-bugs-and-new-features`——锚点存在（:21），该节正文内容**未核实**（未读全文）。

**推测（未核实）**：所有官方文档原文与行号；`session.prompt(..., { source: "extension" })`（:1790-1792）是否算未登记的偏离——规范没提 `source` 参数，官方是否有对应说法未知，仅提示后续重查偏离表时可留意。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只有 5 个文件，全是文档和复核记录（`.md`），没有动 `packages/runtime-pi` 或任何组装请求的代码；发给模型的内容完全不变，仍然只追加。规范本身还重申了追加规则（guide 第 31、198 行），AGENTS.md/.agents 的改动影响的是编码代理的读文档行为，不影响 Himawari 运行时发给模型的字节。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动不产生任何运行时值；没有引入依赖前后文的遮盖、时间字段或无序集合。规范对后续改动也强制引用了 prompt-prefix 第四、八节。
3. **有没有对应的自动检查？** 部分：链接/锚点（`check:docs-links`、`check:instruction-links`）、表格（`check:markdown-tables`）、ADR 编号（`check:adr-numbers`）会拦这类文件错误；文档严格校验按规则须手动跑。但**没有**“偏离表与代码一致”“官方摘录行号正确”的自动检查，反向用例不适用（这些检查器本身就是按违反即失败设计的，本环境无法运行验证通过）。规范第六节要求“偏离批准后加一条 Pi 升级会失败的测试”是留给未来的要求，本次无代码改动、无测试，一致。
4. **每个新值的使用方都能接受吗？** 新引入的值：`docs/pi-development-guide.md` 文件路径、内部锚点（已逐一核对存在）、ADR 0203 编号（glob 全库无重复，`check:adr-numbers` 也会拦）、偏离编号 D1–D7（仅被 guide 和 ADR 0203 引用，无代码消费）、AGENTS.md 和 pi-and-workspace.md 里指向新文档的相对路径（已核对可解析）。所有链接的双端（产生处/使用处）核对一致，无后端校验问题。

总体结论：作者的三条说法基本成立——7 处偏离的位置和做法与代码一致（仅 D5 漏列两个底层调用、磁盘扩展描述不完整两处小瑕疵）；与现有规则的引用、条号、锚点核对无矛盾；官方原文出处按其声明属于未核实范围。未发现会让后来代理“照着做错”的硬伤。
