## 结论摘要

本轮 18b32a8a 只改文档与复核记录，没有改运行时代码。作者列出的四处修改都能在代码里找到对应事实，**未发现中、高严重度问题**；有两处低严重度的表述/流程问题，以及一条官方引用无法离线核实。

---

## 问题列表（按严重度）

### 低：`docs/pi-development-guide.md:106` — “授权由这个端口负责”容易被读成已有授权实现

**问题**：这句话描述的是接口契约，但仓库里只有 `PiRuntimeResourcePort` 的接口定义和适配器调用点，没有任何实现或生产装配；适配器自身只做类型、非空、去重检查，不做路径规范化、存在性、越界、数量或大小限制。若以后接上一个不严谨的实现，扩展/技能/提示模板路径会直接交给 Pi 加载，而扩展路径等于执行代码。

**证据**（亲自读到）：
- 文档原文：`……：授权由这个端口负责，适配器自己只检查路径非空、不重复；2026-11-10 生产入口没有接这个端口，传的是空列表……`
- `packages/runtime-pi/src/pi-runtime-adapter.ts:170-175` 只有接口：
  `export interface PiRuntimeResourcePort { resolveAuthorized(...): Promise<AuthorizedPiResources>; }`
- `packages/runtime-pi/src/pi-runtime-adapter.ts:1281-1284` 只是可选调用：
  `this.#dependencies.resources?.resolveAuthorized(...) ?? Promise.resolve(EMPTY_RESOURCES)`
- `packages/runtime-pi/src/pi-runtime-adapter.ts:739-747` 的 `authorizedPaths` 只检查 `typeof path !== "string"`、`path.trim().length === 0`、`new Set(paths).size !== paths.length`，随后原样返回 `[...paths]`。
- 全仓库搜索 `PiRuntimeResourcePort|resolveAuthorized|AuthorizedPiResources`，只命中接口、调用点和 `index.ts` 导出，没有实现。

**建议**：把“授权由这个端口负责”改成“当前仓库只有接口、没有实现；接线方必须先完成授权（含路径规范化/白名单），否则不得接线”，或让适配器自己也 fail closed（拒绝相对路径、`..`、不存在路径和超量路径）。

---

### 低：`docs/pi-development-guide.md:161` — “仓库里还没有测试锁住这一点”当前为真，但没有门槛保证它保持为真

**问题**：这句新增说明目前与代码一致，但仓库没有检查“文档声称无测试”与“后来是否补了测试”是否一致；`check:untested-claims` 只扫描提交消息，不扫描文档正文。以后有人新增测试或新增 `tool_call` 改参数逻辑，这句话会悄悄过期。

**证据**（亲自读到）：
- 目前唯一的 `tool_call` 处理器在 `packages/runtime-pi/src/pi-runtime-adapter.ts:1437-1440`，只做 `return { block: true, ... }`，不改 `event.input`；测试里搜不到 `pi.on("tool_call")`，也搜不到 `event.input` 的使用。
- `scripts/delivery-mode/test_untested_claims.py:25-28` 的规则针对的是提交消息里的 “没有测试/未覆盖” 等短语；`package.json:50` 的 `check:untested-claims` 运行的是这个测试。
- `scripts/check-docs-links.mjs` 只查链接和锚点，不查这类正文断言。

**建议**：保留这句话，但把它登记到可追踪的 backlog/事故清单，或在第一次实现 `event.input` 改参数时立即补一条“`tool_call` 在 `execute` 之前、`execute` 看到改后参数”的测试；仅写在指南里，没有机制提醒。

---

### 未核实：`docs/pi-development-guide.md:161` 引用的官方原话和行号

`docs/extensions.md` 第 984 行“Mutations to `event.input` affect the actual tool execution”无法在本仓库离线核对（仓库没有 Pi 官方文档副本，也没有 `node_modules`）。这不是代码不一致，只是**未核实**；引用格式本身符合指南自己“写清包名、版本、文件、行号或锚点”的要求。

---

## 读代码证实的与推测分开

**读代码证实的：**
- D5 新增“`pi-tool-batch-continuation.ts` 读 `agent.state.messages`”为真：`pi-tool-batch-continuation.ts:37` 读 `session.agent.state.messages`，`:74` 读 `session.agent.state.tools`；D5 原本已有的 `agent.state.tools` 也在同一文件。
- 适配器的路径校验确实只有类型、非空、去重：`pi-runtime-adapter.ts:739-747`，然后交给 `DefaultResourceLoader` 的 `additionalExtensionPaths` 等字段（`:1426-1431`）。
- 生产入口没有接 `resources` 端口：全仓库没有 `PiRuntimeResourcePort` 的实现，适配器使用可选依赖，缺省时回退到 `EMPTY_RESOURCES`（`:1281-1284`）。
- AGENTS.md 的“见上文”指向的 `#owners-standing-rules` 存在：`AGENTS.md:61` 有 `<a id="owners-standing-rules"></a>`，`:103` 是新链接。
- 仓库当前没有测试覆盖 `event.input` 的参数改写：全仓库只有文档示例和适配器的 `tool_call` 处理器，测试中没有 `pi.on("tool_call")` 或 `event.input`。

**推测/未来风险：**
- 如果以后有人实现了 `PiRuntimeResourcePort` 但授权不严，适配器不会兜底；`additionalExtensionPaths` 可以加载代码，`additionalSkillPaths`、`additionalPromptTemplatePaths` 可以注入模型可见内容。这是“未来接线”的风险，不是当前生产风险（生产传空）。

---

## 侧重检查

- **不可信输入 / 授权**：检查 `resources` 端口和 `authorizedPaths`。结论：适配器不负责授权，只做浅校验；当前没有实现、生产未接线，所以没有现实暴露；文档已部分披露，但“授权由端口负责”容易让人误以为已有实现。
- **错误路径**：`authorizedPaths` 对非字符串、空串、重复路径抛 `TypeError`；外层 `produce` 的 `catch` 会转成通用的 `PI_RUNTIME_ERROR`（`pi-runtime-adapter.ts:1897-1914`），不会把路径细节暴露给模型。未见新问题。
- **扩展加载 / 不可撤销操作**：`additionalExtensionPaths` 本质是加载可执行扩展代码；适配器没有数量、大小、路径边界限制。当前生产不使用，建议接线时在端口层强制边界。**推测性风险，非当前代码缺陷。**
- **资源耗尽**：本轮没有新增运行时循环、缓存、队列或文件写入；文档变更不产生资源消耗。
- **规则、说明文档和代码一致性**：核对了 `AGENTS.md`、`.agents/instructions/pi-and-workspace.md:20`、`docs/adr/0203-...md` 和 `docs/pi-development-guide.md`。新链接、锚点、D5 编号与代码一致；没有发现本轮引入的相反说法。
- **I-73 类“产生方/使用方校验不一致”**：本轮没有新增后端字段、清单 id、配置键或序列化格式；新增的标识只有文档锚点 `#owners-standing-rules`、`#current-deviations` 等，使用它们的检查是 `check:instruction-links` 和 `check:docs-links`，两端都能接受。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本增量只有文档和 `.agents/reviews` 记录，没有改系统提示、工具定义、历史消息、遮盖或序列化代码。新增的 `tool_call` 说明讲的是当前轮工具执行前的参数修改，不是改写已发送的历史；但以后真在 `tool_call` 里改参数时，仍需保证存下的工具调用字节不被重写，这一点指南没有展开，靠 `prompt-prefix` 规则兜底。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 文档变更不参与请求序列化；新增的锚点和文字不是模型输入。`resources` 路径数组也不是本次改动的运行时值，且 `authorizedPaths` 返回的是 `[...paths]` 的拷贝。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

- **AGENTS.md 的锚点链接**：由 `check:instruction-links` 覆盖，`scripts/check-instruction-links.mjs:7-12` 明确包含 `AGENTS.md`，`:64-69` 检查锚点；反向用例在 `test/tooling/instruction-links.test.mjs:46-54`，锚点消失会报 `INSTRUCTION_ANCHOR_MISSING`。
- **docs 指南的链接/锚点**：由 `check:docs-links` 覆盖（`package.json:99`），反向用例在 `test/tooling/docs-links.test.mjs:32-48`，文件或锚点缺失会失败。
- **表格列数**：D5 行仍是 6 列，与表头一致；`check:markdown-tables` 有反向用例（`test/tooling/markdown-tables.test.mjs:67-75` 等）。
- **正文内容断言**（D5 是否准确、“还没有测试”是否仍成立）：**没有自动检查**。提交消息称 fast-mode 检查通过，但我只能读代码，不能运行命令，实际运行结果**未核实**。

### 4. 每个新值的使用方都能接受吗？

**能，限于文档值。**
- `#owners-standing-rules`：产生于 `AGENTS.md:61`，使用于 `AGENTS.md:103`；`check:instruction-links` 接受。
- `#current-deviations`、`#pattern-tool-call` 等：产生和使用都在 `docs/pi-development-guide.md`；`check:docs-links` 接受。
- D5 编号：指南表格、`docs/pi-development-guide.md:78/80/289` 引用，以及 ADR 0203 的“7 处偏离”与 D1–D7 数量一致。
- ADR 编号 0203：`docs/adr/0203-...md` 唯一，标题编号一致。
- 没有新增后端/清单字段或配置键，因此 I-73 那类“清单 id 过不了后端校验”的问题不适用于本增量。
- 唯一与运行时值有关的是 `resources` 路径数组：适配器接受字符串数组并做非空/去重检查，但没有实现可供核对授权行为；这一点已在上面低严重度问题中说明。
