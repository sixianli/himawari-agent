## 总体结论

本 PR 只改文档和指令文件，没有改运行时代码，因此**运行时发给模型的请求没有变化**。但指南本身有几处会误导后续编码代理，最严重的是示例代码直接违反 `prompt-prefix` 的只追加规则，以及“现有偏离”表不完整、官方写法与“大改动先出方案”的关系没写清。作者说法 1、2 不能完全成立；说法 3 因离线无法核实。

## 读代码证实的问题

### 1. 高：`context` / `context_with_system` 示例会删除、重排已发历史，违反 `prompt-prefix` 第 4 条

- 文件:行：`docs/pi-development-guide.md:187-194`、`docs/pi-development-guide.md:198`
- 问题：指南把官方示例原样放出来，示例本身是在过滤和裁剪历史；后面却写“这两个钩子都只能在末尾加，不能改已发过的内容”。后续代理很可能直接照抄示例。
- 证据：

```ts
pi.on("context", async (event, ctx) => {
  return { messages: event.messages.filter((m) => !shouldPrune(m)) };
});

pi.on("context_with_system", async (event, ctx) => {
  const cut = findCutIndex(event.messages);
  const head = getCurrentSystemMessage(event.messages.slice(0, cut));
  return { messages: head ? [head, ...event.messages.slice(cut)] : event.messages.slice(cut) };
});
```

  同页第 198 行写“这两个钩子都只能在末尾加，不能改已发过的内容”，而 `.claude/rules/prompt-prefix.md:35` 明确规定“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”。示例与规则直接冲突。
- 建议：把这两个示例明确标成“只展示钩子形状，不能照抄”；或者改写为只追加的版本。至少在示例代码上方加入醒目警告，不能只靠后文一句说明。

### 2. 高：`before_agent_start` 示例在系统提示里加“for this turn”内容，会改请求开头

- 文件:行：`docs/pi-development-guide.md:174-179`
- 问题：示例向系统提示追加本轮文字；如果按注释“for this turn”只在部分轮次追加，就会改变已发请求的系统提示开头；即使每轮都追加，也与“系统提示按对话冻结”的要求不一致。
- 证据：

```ts
pi.on("before_agent_start", async (event, ctx) => {
  return { systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn..." };
});
```

  第 179 行又说“Himawari 的系统提示按对话冻结……只返回冻结的那一份，不每轮改”。示例和说明互相矛盾。`.claude/rules/prompt-prefix.md:41-43` 要求同一对话沿用第一次发出的字节，只有列出的换新条件才换新。
- 建议：示例改为返回冻结的 `systemPrompt`，或明确说明“Himawari 里禁止照抄这段追加逻辑；每轮变化的内容应追加为最后一条用户消息”。

### 3. 中：指南和 AGENTS 的“官方有写法就照官方写”没有接上 `owner-standing-rules` 的大改动审批

- 文件:行：`docs/pi-development-guide.md:27-29`、`AGENTS.md:103`、`.claude/rules/owner-standing-rules.md:25-28`
- 问题：指南只说“偏离官方”要先出方案，没有说“即使是官方写法，只要动到核心特性，仍要先出方案”。后续代理可能把“官方有写法”当成绕过 Andy 审批的理由。
- 证据：
  - `docs/pi-development-guide.md:27`：“官方有写法就照官方写。”
  - `AGENTS.md:103`：“官方有写法就照官方写；只有官方没有好写法或官方写法有缺陷时才能自己设计，而且要先出方案给 Andy 看。”
  - `.claude/rules/owner-standing-rules.md:25-28`：“大改动先出方案、讨论后再动工……动到项目的核心特性，例如记忆系统、模型调用和路由、Agent 循环……方案先和 Andy 讨论，他同意之后才能改代码、改文件或开 PR。”
- 建议：在指南第一节和 `AGENTS.md` 那句后面明确加一句：“照官方写不豁免 `owner-standing-rules` 的大改动审批；动到模型调用、Agent 循环、权限等核心特性时仍先出方案。”这样作者说法 2 才成立。

### 4. 中：“现有偏离”表 D5 漏了直接使用底层 Agent 的路径

- 文件:行：`docs/pi-development-guide.md:344`、`packages/runtime-pi/src/pi-runtime-adapter.ts:1237-1238`、`packages/runtime-pi/src/pi-runtime-adapter.ts:1788`、`packages/runtime-pi/src/pi-tool-batch-continuation.ts:74`
- 问题：D5 只列了 `agent.steer`、`agent.abort()`、读 `agent.state.messages`，但代码还直接调用了 `session.agent.continue()`、`session.agent.hasQueuedMessages()`，以及读取 `session.agent.state.tools`。这些同属“绕过会话直接用底层 Agent”，没有登记，偏离表不完整。
- 证据：

```ts
// pi-runtime-adapter.ts:1237-1238
while (canContinue() && session.agent.hasQueuedMessages()) {
  await session.agent.continue();
```

```ts
// pi-runtime-adapter.ts:1788
if (restored) await session.agent.continue();
```

```ts
// pi-tool-batch-continuation.ts:74
const tools = session.agent.state.tools;
```

  而 `docs/pi-development-guide.md:344` 的 D5 只写“`agent.steer`、`agent.abort()`、读 `agent.state.messages`”。
- 建议：把 `agent.continue()`、`agent.hasQueuedMessages()`、`agent.state.tools` 补进 D5；如果其中某些是官方认可的 API，也要在表中写明依据。不要维持“7 处已完整”的说法。

### 5. 中：查官方文档的命令只拉 1.5.1，没有拉锁定的 1.5.0，和“两个版本都看”冲突

- 文件:行：`docs/pi-development-guide.md:36`、`docs/pi-development-guide.md:41`、`docs/pi-development-guide.md:58`、`docs/adr/0203-follow-pi-official-extension-patterns.md:48`
- 问题：正文要求同时读锁定版本 1.5.0 和最新版 1.5.1，但给出的 `npm pack` 命令只下载 1.5.1。后续代理很可能只看到 1.5.1 的接口和行号，却要写 1.5.0 的代码。
- 证据：
  - `docs/pi-development-guide.md:36`：“写代码以锁定版本的接口为准，同时读最新版本的文档。”
  - `docs/pi-development-guide.md:41`：`npm pack @earendil-works/pi-coding-agent@1.5.1 @earendil-works/pi-agent-core@1.5.1 @earendil-works/pi-ai@1.5.1`
  - `docs/pi-development-guide.md:58`：“出处里的行号对应 `@earendil-works/pi-coding-agent@1.5.1` 包。”
  - `docs/adr/0203-follow-pi-official-extension-patterns.md:48`：“查官方写法时同时读锁定版本和最新版本的文档……以锁定版本的接口写代码。”
- 建议：命令同时拉 1.5.0 和 1.5.1，或明确写出“锁定版本没有该示例时应怎样核对”。出处最好分别标 1.5.0 和 1.5.1 的行号，避免把 1.5.1 的行号当成锁定版本。

### 6. 中低：没有自动检查覆盖指南内容和“7 处偏离”的准确性

- 文件:行：`.agents/instructions/document-governance.md:28`、`package.json:27`、`test/tooling/docs-links.test.mjs:32-48`、`test/tooling/adr-numbers.test.mjs:30-47`、`docs/pi-development-guide.md:336`
- 问题：现有检查只查链接、锚点、表格列数、ADR 编号、词表等；没有检查“指南说的代码位置和做法是否仍成立”“官方示例是否违反 `prompt-prefix`”“偏离表是否漏了底层调用”。本 PR 也没有新增测试。
- 证据：
  - `document-governance.md:28` 列出的是 `check:docs-links`、`check:adr-numbers`、`check:markdown-tables` 等。
  - `docs-links.test.mjs:32-48` 有缺文件、缺锚点的反向用例；`adr-numbers.test.mjs:30-47` 有重号、错误文件名的反向用例；这些能保证链接/编号，但不保证内容。
  - `docs/pi-development-guide.md:336` 只写“状态改变时更新这张表”，没有强制检查。
- 建议：至少加一条工具检查，核对偏离表里的关键标识（`streamFunction`、`tools.preflight`、`reconciliation.suspend`、`hasConfiguredAuth`、`SettingsManager.inMemory` 等）仍能在 `packages/runtime-pi/src` 找到；更强的话，把“复制官方示例后 `check:prompt-prefix` 必须失败”做成反向用例。否则这张表会随时间腐烂。

### 7. 低：说“扩展不放在磁盘上 / 关掉磁盘上的扩展”，但代码允许加载授权的外部扩展、技能和提示模板

- 文件:行：`docs/pi-development-guide.md:58`、`docs/pi-development-guide.md:101`、`packages/runtime-pi/src/pi-runtime-adapter.ts:1426-1431`
- 问题：指南把 Himawari 的扩展模型描述成只有内联 `extensionFactories`；代码还给 `DefaultResourceLoader` 传了 `additionalExtensionPaths`、`additionalSkillPaths`、`additionalPromptTemplatePaths`。
- 证据：

```ts
noExtensions: true,
noSkills: true,
noPromptTemplates: true,
...
additionalExtensionPaths: authorizedPaths(resources.extensionPaths, "extensionPaths"),
additionalSkillPaths: authorizedPaths(resources.skillPaths, "skillPaths"),
additionalPromptTemplatePaths: authorizedPaths(resources.promptTemplatePaths, "promptTemplatePaths"),
```

- 建议：改成“产品自带扩展用内联工厂；授权资源仍可通过 additional*Paths 从磁盘加载”，并说明 `noExtensions` 与 additional paths 的实际关系。不要写成绝对的“扩展不放在磁盘上”。

## 推测 / 未核实

- 官方文档原文和行号（`docs/extensions.md` 第 973、1040、615、815、829、864、883、1224、1627、663、1230 行；`docs/sdk.md` 第 32、40、62、70、100、112 行；`docs/custom-provider.md` 第 7、51、126、149、164、172、174、176 行；`docs/settings.md` 第 21 行）无法在当前离线环境核实。如果这些原文或行号有误，指南的官方写法部分就会失真。
- `cacheWarming` 在 1.5.0/1.5.1 的默认值、以及 `cacheWarming: "off"` 是否是合法值，未能核实。D7 和第三节设置说明都依赖这一点。
- `session.messages` 是否是官方推荐的替代属性，未能核实；D5 的“对应官方写法”可能不准确。
- `context_with_system` “第 0 条必须是 system 消息”的规则，以及 `before_provider_headers` 等事件是否存在，未能核实。
- `additionalExtensionPaths` 在 `noExtensions: true` 时是否仍会加载外部扩展，取决于 Pi 语义；我只证实代码传了这些参数，没有证实最终加载行为。
- ADR 0203 编号是否和未合并 PR 的 ADR 冲突，离线只能确认当前检出里没有重复（当前只有 0200 和 0203），未合并 PR 未核实。

## 侧重检查

我重点看了错误路径、不可信输入、安全、资源耗尽、不可撤销操作，以及规则/文档/代码一致性：

- **错误路径和不可信输入**：`tool_call` 示例说明 `event.input` 可就地改且改完不再校验（`docs/pi-development-guide.md:151`）。这个提醒是对的，但指南没有说明它与 D2 的 `tools.preflight` 的顺序关系；代码里 preflight 在工具 `execute` 内（`pi-runtime-adapter.ts:2050`），如果以后在 `tool_call` 里改参数，preflight 看到的是改后的参数。这个交互值得补一句，否则新规则可能绕过原有审批判断的预期。
- **安全**：D4 的 Proxy 只改写 `hasConfiguredAuth`，其他方法绑定原 runtime（`pi-runtime-adapter.ts:639-649`），指南描述基本准确；它确实让 Pi 认为密钥已配置，真实密钥在每次请求时才解析（`pi-runtime-adapter.ts:1050-1080` 附近）。这是既有风险，本 PR 没有改变。
- **中止和不可撤销操作**：代码确实在工具内部直接调 `agent.abort()`（`pi-runtime-adapter.ts:1575、1596、1608`），D5 已登记；指南说“工具内部不能等会话空闲”，与代码意图一致。
- **资源耗尽**：`agent_before_settle` 示例有“无条件 `continue: true` 会死循环”的警告，方向正确。`npm pack` 下载和解包只写临时目录，没有发现直接写仓库或删文件的指令。
- **规则/文档一致性**：主要问题就是上面第 1、2、3、4、7 条；其中第 1、2 条是“规范让代理照抄的示例”与现有硬规则冲突，风险最高。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

本 PR 没有改代码，**运行时不会改变**模型已经见过的系统提示、工具定义、历史消息或遮盖结果；也没有新增每轮变化值。
但指南里的示例如果被后续代理照抄，会改变请求开头：

- `docs/pi-development-guide.md:187-194` 的 `context` / `context_with_system` 示例删除、裁剪历史；
- `docs/pi-development-guide.md:174-176` 的 `before_agent_start` 示例向系统提示追加“for this turn”文字。

因此不能回答“指南里的写法都只在末尾追加”。指南需要先修正示例或加“禁止照抄”的明确标注。依据 `.claude/rules/prompt-prefix.md:35` 和 `:41-43`。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

本 PR 本身不会：没有改序列化、遮盖、时间字段、集合顺序或模型请求组装。
但指南示例若被照抄，`context` 的 `shouldPrune`、`context_with_system` 的 `findCutIndex` 可以根据消息内容裁剪历史，导致同一段历史在后续请求里消失或位置变化；`before_agent_start` 的“for this turn”文字也会改变系统提示。这些都会破坏逐字节稳定的请求开头。D1、D7 只是登记现有代码，本 PR 没有执行修正。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有部分检查，但都不是针对本指南内容：

- `check:docs-links`：缺文件、缺锚点会失败；`test/tooling/docs-links.test.mjs:32-48` 有反向用例。
- `check:adr-numbers`：ADR 重号、文件名不合规、标题编号不符、ADR 链接缺失会失败；`test/tooling/adr-numbers.test.mjs:30-47、81-89` 有反向用例。
- `check:markdown-tables`、`check:instruction-links`、`check:glossary`：分别检查表格列数、指令链接、旧叫法。

但没有检查“指南的描述是否仍和代码一致”“7 处偏离是否完整”“官方示例是否违反 prompt-prefix”。本 PR 也没有新增测试。因此反向用例只能证明链接/编号/表格不会坏，不能证明指南内容正确。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对结果：

- **ADR 0203 编号和文件名**：文件存在，文件名 `0203-follow-pi-official-extension-patterns.md` 符合“四位编号-小写短名”，标题 `# ADR 0203：...` 与文件名一致；当前检出里没有重复的 0203。未合并 PR 是否已占用 0203 未核实。
- **链接和锚点**：指南、ADR 0203、`AGENTS.md`、`.agents/instructions/pi-and-workspace.md` 中指向彼此的相对路径都存在；我核对了 `#current-deviations`、`#workspace-contract`、`#premises`、`#options`、`#decision`、`#append-only`、`#before-you-change`、`#fixing-bugs-and-new-features`、`#pi-first-development-principle` 等锚点，均在对应文件中找到。
- **偏离编号 D1-D7**：编号唯一，指南和 ADR 0203 都写“7 处”，数量一致。但 D5 的语义覆盖不完整，见发现 4；因此“7 处”这个数字对得上，不代表内容完整。
- **配置键/清单项/序列化格式**：本 PR 没有新增运行时配置键或清单项；`cacheWarming` 只是文档建议，没有写进代码。`docs/pi-development-guide.md` 的 frontmatter 与现有 `docs/kv-cache-guide.md` 同类文档一致，没有 `document_type` 字段。
- **使用端**：`AGENTS.md` 和 `.agents/instructions/pi-and-workspace.md` 指向指南，指南指向 ADR 0203，ADR 0203 指回指南、ADR 0198、ADR 0023；这些路径都能解析。没有后端或代码会校验 D1-D7 这些纯文档标识，只有文档检查脚本会校验链接、锚点和 ADR 编号。
