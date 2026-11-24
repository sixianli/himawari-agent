---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-10"
---

# Pi 二次开发规范

<a id="contents"></a>

Himawari 的模型调用、Agent 循环（模型一步步调用工具的那套流程）、工具和会话都建在 Pi 上。Pi 是 Earendil 公司开源的 Agent 框架，官方仓库 <https://github.com/earendil-works/pi>，npm 包名以 `@earendil-works/pi-` 开头。这份规范写的是：在 Pi 上加功能、改行为时，每类需求官方推荐怎么写，以及什么情况下才允许不照官方写。

Andy 在 2026-11-10 要求写这份规范，原话是“让 AI coding agent 以后在开发 Himawari agent 的时候有一个参考，避免它在开发的时候自己胡乱发挥”，并要求“附上官方推荐的一些写法。除非是官方自己也没有好的解决方案，或者他们自己有缺陷的时候，我们才根据需求灵活发挥，但是呢，这种灵活发挥的地方，要把方案做出来，然后给我看看”。对应的决定见 [ADR 0203](adr/0203-follow-pi-official-extension-patterns.md)。

- [一、必须遵守的规则](#rules)
- [二、怎样查官方写法](#how-to-look-up)
- [三、每类需求的官方写法](#official-patterns)
- [四、Himawari 自己负责的部分](#himawari-owned)
- [五、现有的偏离（未经 Andy 批准，不得照抄或扩大）](#current-deviations)
- [六、要偏离时怎么做](#how-to-deviate)

<a id="rules"></a>
## 一、必须遵守的规则

1. **先查官方，再动手。**凡是动到会话、工具、工具调用前后的拦截、系统提示、发给模型的请求、模型服务方、压缩、往运行中插消息、中止，先读 Pi 官方文档和官方示例的原文（[怎样查](#how-to-look-up)），找到对应的官方写法。不得凭记忆、凭训练数据或凭二手文章决定写法。
2. **官方有写法就照官方写。**[第三节](#official-patterns)列的是已经核对过的官方写法；新需求不在表里时，按第 1 条去查，查到了就照写，并把它补进表里。
3. **只有两种情况允许不照官方写：**官方没有能满足需求的写法，或者官方写法有缺陷（例如等审批要等几个小时，而官方的拦截只能让进程一直挂着等，服务重启就丢了）。这时必须先按[第六节](#how-to-deviate)出方案，Andy 同意后才能写进代码和这份规范。
4. **现有偏离不是范本。**[第五节](#current-deviations)列的是代码里已经存在、还没经 Andy 批准的偏离。新代码不得照抄它们，也不得在它们上面继续加东西；要动它们，先出方案。
5. **只有 `packages/runtime-pi` 能导入 Pi。**这条来自 [Pi 优先与工作区约定](../.agents/instructions/pi-and-workspace.md#workspace-contract)：“只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包”。
6. **发给模型的内容只追加。**任何写法都不能违反 [.agents/instructions/prompt-prefix.md](../.agents/instructions/prompt-prefix.md)。官方写法和这条冲突时（例如官方让 Pi 自己每轮重算系统提示），按第 3 条处理。[第三节](#official-patterns)里标着“官方示例原样，Himawari 不得照抄”的代码只用来说明钩子长什么样。
7. **照官方写不等于不用先出方案。**动到模型调用和路由、Agent 循环、权限和授权、记忆系统这类核心特性，即使用的是官方写法，仍按 [Andy 定的长期规则](../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features)“大改动先出方案、讨论后再动工”，Andy 同意后才动工。

<a id="how-to-look-up"></a>
## 二、怎样查官方写法

- **两个版本都看。**锁定版本写在 `packages/runtime-pi/package.json`（2026-11-10 是 1.5.0）；最新版本用 `npm view @earendil-works/pi-coding-agent version` 查（2026-11-10 是 1.5.1）。写代码以锁定版本的接口为准，同时读最新版本的文档：两者说法不同的地方，在方案或提交说明里写出来，升级 Pi 时一并处理。不读比锁定版本更老的文档。
- **拿原文的方法。**npm 包里自带文档和示例，和发布版本逐字一致。锁定版本和最新版本各拉一份（下面以 2026-11-10 的 1.5.0 和 1.5.1 为例，动手时换成当时的版本号）：

  ```bash
  mkdir -p "$SCRATCH/pi-docs" && cd "$SCRATCH/pi-docs"
  for v in 1.5.0 1.5.1; do
    npm pack @earendil-works/pi-coding-agent@$v @earendil-works/pi-agent-core@$v @earendil-works/pi-ai@$v
  done
  for f in *.tgz; do mkdir -p "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done
  ```

  `diff -r` 两个版本的 `docs/` 就能看出最新版改了哪些说法。

  `SCRATCH` 指会话自己的临时目录，不要解到仓库里。`pi-coding-agent` 包里有 `docs/`（官方文档）、`examples/extensions/`（扩展示例）、`examples/sdk/`（嵌入用法示例）；`pi-agent-core` 包的 `README.md` 讲底层 Agent 循环；`pi-ai` 包的 `README.md` 和 `dist/types.d.ts` 讲模型请求选项。在线版本在 <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs>。
- **最常用的几份：**
  - `docs/extensions.md`：扩展能挂的全部事件和 `pi.*` 方法；
  - `docs/sdk.md`：在自己的 Node 进程里嵌入 Pi（Himawari 就是这样用的）；
  - `docs/custom-provider.md`：接模型服务方；
  - `docs/compaction.md`：压缩；
  - `docs/settings.md`：所有设置及默认值；
  - `examples/extensions/` 下与需求同名或相近的示例，例如 `permission-gate.ts`（拦截危险命令）、`custom-compaction.ts`（自己写压缩摘要）、`tool-override.ts`（替换内置工具）、`provider-payload.ts`（看和改发给服务方的请求体）。
- **引用时写清出处：**包名和版本、文件、行号或章节锚点，再引一句原话。另一个 Claude 的总结、项目记忆不算出处（[方案的前提](../.claude/rules/proposal-premises.md)）。

<a id="official-patterns"></a>
## 三、每类需求的官方写法

下面的示例摘自官方文档或示例，删掉了原有注释；出处里的行号对应 `@earendil-works/pi-coding-agent@1.5.1` 包，写代码前按[怎样查](#how-to-look-up)再对一遍锁定版本。Himawari 是“嵌入”用法：自己的扩展以 `extensionFactories`（扩展工厂函数，传给资源加载器的一组函数，每个函数收到 `pi` 对象并在上面挂事件）的形式交给 `DefaultResourceLoader`；示例里的 `pi.on(...)` 写在工厂函数里。

| 需求 | 官方写法 | Himawari 现状 |
|---|---|---|
| [建会话](#pattern-session) | `createAgentSession` + 内存版设置和资源加载器 | 照官方 |
| [恢复历史](#pattern-history) | 用装好条目的 `SessionManager` 建会话 | 照官方 |
| [加工具、换内置工具的执行位置](#pattern-tools) | `customTools` / `pi.registerTool`；内置工具用 `create*ToolDefinition` 加 `operations` | 照官方 |
| [工具执行前拦截或改参数](#pattern-tool-call) | `tool_call` 事件返回 `{ block: true }` | 部分照官方，审批是[偏离 D2](#current-deviations) |
| [改工具结果](#pattern-tool-result) | `tool_result` 事件返回补丁 | 照官方 |
| [系统提示](#pattern-system-prompt) | 资源加载器给初始提示；`before_agent_start` 改 | 照官方 |
| [每次请求前改上下文](#pattern-context) | `context` 改消息；`context_with_system` 接管整个请求开头 | 用了：隐藏扩展 `himawari-request-head` 生成冻结开头，见[偏离 D1](#current-deviations)；隐藏扩展 `himawari-tool-result-clearing` 成批清理旧工具结果（prompt-prefix 规则第 14 条） |
| [看或改发给服务方的请求](#pattern-provider-hooks) | `before_provider_request`、`after_provider_response`、`before_provider_headers` | 照官方 |
| [接模型服务方](#pattern-provider) | `registerProvider`，协议相同就复用 Pi 的流式实现；自定义取密钥时用完整 `Provider` 的原生认证（`createProvider` + `registerNativeProvider`） | 照官方；认证声明见 [ADR 0205](adr/0205-pi-native-provider-auth.md) |
| [单次后台模型调用](#pattern-direct-call) | `modelRuntime.stream` / `ctx.modelRegistry.complete`，用 `fetch`、`onPayload` 选项 | 照官方 |
| [压缩](#pattern-compaction) | 设置开关；`session_before_compact` 自己出摘要 | 用内置压缩；摘要请求经[偏离 D1](#current-deviations) 改开头 |
| [运行中插消息](#pattern-steer) | `pi.sendMessage` / `session.sendCustomMessage`，`deliverAs` 选时机 | 照官方；只有审批续跑那一轮绕到底层，见[偏离 D5](#current-deviations) |
| [结束前补一步](#pattern-settle) | `agent_before_settle` 返回条目并要求续一轮 | 没用 |
| [中止](#pattern-abort) | `session.abort()`；扩展里用 `ctx.signal` | 照官方；只有工具内部绕到底层，见[偏离 D5](#current-deviations) |
| [重试、缓存预热等设置](#pattern-settings) | `SettingsManager.inMemory({...})` | 重试照官方；缓存预热锁在 `streaming`、模型不填缓存寿命，见[偏离 D7](#current-deviations) |

<a id="pattern-session"></a>
### 建会话

出处：`docs/sdk.md` 第 100 行起“Each boundary can be supplied explicitly”，示例 `examples/sdk/12-full-control.ts`。

```typescript
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});
const { session } = await createAgentSession({
  cwd,
  agentDir: "/tmp/my-agent",
  model,
  thinkingLevel: "off",
  modelRuntime,
  resourceLoader,
  tools: ["read", "bash"],
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
});
```

Himawari 在 `packages/runtime-pi/src/pi-runtime-adapter.ts` 用 `DefaultResourceLoader` 并关掉 Pi 自动发现的扩展、技能、提示模板、主题和上下文文件（`noExtensions`、`noSkills` 等），自己的扩展从 `extensionFactories` 传入。适配器还接受 `resources` 端口给出的磁盘路径（`additionalExtensionPaths`、`additionalSkillPaths`、`additionalPromptTemplatePaths`）：2026-11-10 仓库里只有这个端口的接口定义，没有实现，生产入口也没有接，传的是空列表；适配器自己只检查路径非空、不重复，不检查路径在不在允许的目录里。扩展路径上的文件会被 Pi 当代码加载，所以以后接这个端口的改动必须先出方案，写清授权怎么做：至少把路径解析成真实路径（跟随符号链接）后检查在允许的目录里、是普通文件、按真实路径去重，交给 Pi 的是解析后的真实路径，允许的目录别人不能写，适配器侧在加载前再查一次（`docs/sdk.md` 第 112 行“Inline extension factories can be supplied through `DefaultResourceLoader`”）。用完调用 `session.dispose()`。

<a id="pattern-history"></a>
### 恢复历史

出处：`docs/sdk.md` 第 40 行：“`SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.”

做法：`SessionManager.inMemory(cwd, { id }, entries)` 或先 `SessionManager.inMemory(cwd, { id })` 再 `appendMessage`、`appendCompaction`，然后把它传给 `createAgentSession`。不得给 `session.agent.state.messages` 赋值。

<a id="pattern-tools"></a>
### 加工具、换内置工具的执行位置

出处：`docs/extensions.md` 第 2180 行“Custom Tools”、第 2391 行“Remote Execution”。内置工具的执行可以换成自己的实现（例如在沙箱里读文件），参数说明、截断和结果格式仍用 Pi 的：

```typescript
const localRead = createReadTool(cwd);
pi.registerTool({
  ...localRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const operations: ReadOperations = {
        readFile: (path) => sshReadBuffer(ssh, path),
        access: (path) => sshExec(ssh, `test -r ${path}`).then(() => {}),
      };
      return createReadTool(cwd, { operations }).execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

嵌入用法里用 `createAgentSession({ customTools, tools, noTools })` 传工具（`docs/sdk.md` 第 100 行起）。Himawari 的 `packages/runtime-pi/src/governed-coding-tools.ts` 用 `create*ToolDefinition` 加 `operations`，照的就是这个写法。长输出用 Pi 的 `truncateHead` / `truncateTail`（`docs/extensions.md` 第 2451 行“Output Truncation”）。

<a id="pattern-tool-call"></a>
### 工具执行前拦截或改参数

出处：`docs/extensions.md` 第 973 行“tool_call”：“Fired after `tool_execution_start`, before the tool executes. **Can block.**”；示例 `examples/extensions/permission-gate.ts`。

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command as string;
  if (dangerousPatterns.some((p) => p.test(command))) {
    return { block: true, reason: "Dangerous command blocked" };
  }
  return undefined;
});
```

- `event.input` 可以就地改，改完不再校验（原话“No re-validation is performed after your mutation”）。
- `{ block: true, terminate: true }` 让这一批工具结束后不再请求模型。
- 被拦下的调用不会执行工具；要观察它，用 `tool_execution_end` 事件。
- 这个钩子只能当场决定或当场等。要等人批准几个小时、服务中途可能重启的情况，官方没有可靠写法，见[偏离 D2](#current-deviations)。
- 新增的“直接拒绝、不需要等人”的规则（例如硬规则），用这个钩子写，挂在一个隐藏的内联扩展里。
- 顺序：`tool_call` 先于工具的 `execute` 运行，官方原话“Mutations to `event.input` affect the actual tool execution”（`docs/extensions.md` 第 984 行），所以在这里改了参数，Himawari 在 `execute` 里做的权限判断（[偏离 D2](#current-deviations)）看到的是改后的参数。仓库里还没有测试锁住这一点，第一次在 `tool_call` 里改参数的改动要补上。

<a id="pattern-tool-result"></a>
### 改工具结果

出处：`docs/extensions.md` 第 1040 行“tool_result”：“Handlers can return partial patches (`content`, `details`, `structuredContent`, `isError`, or `usage`); omitted fields keep their current values”。

```typescript
pi.on("tool_result", async (event, ctx) => {
  return { isError: true };
});
```

<a id="pattern-system-prompt"></a>
### 系统提示

出处：`docs/extensions.md` 第 615 行“before_agent_start”；`docs/sdk.md` 第 32 行“`session.systemPrompt` is read-only”。

Himawari 的写法：资源加载器的 `systemPromptOverride: () => frozenSystemPrompt` 给初始提示，不再在 `before_agent_start` 里重复返回（偏离 D6 已删除，[ADR 0208](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md)）；发出请求的开头由 `himawari-request-head` 扩展的 `context_with_system` 钩子生成（D1 第 3 步，[ADR 0208](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#step-3-record)）。

官方示例在 `event.systemPrompt` 后面拼“本轮”的额外说明（`docs/extensions.md` 第 615 行起），Himawari 不得照抄：每轮会变的内容放在最后一条用户消息里（[prompt-prefix 规则第一节](../.agents/instructions/prompt-prefix.md#order)）。官方说明：改 `systemPromptOptions` 里的分节时，Pi 只追加一条补丁；直接返回 `systemPrompt` 会整段替换，换了就“a cache miss when it changes”。Himawari 的系统提示按对话冻结（[ADR 0165](adr/0165-freeze-the-request-head-per-conversation.md)），所以只用冻结的那一份，不每轮改。

<a id="pattern-context"></a>
### 每次请求前改上下文

出处：`docs/extensions.md` 第 815 行“context”、第 829 行“context_with_system”。

**下面是官方示例原样，Himawari 不得照抄：**它按条件删掉、截掉已经发过的历史，违反 [prompt-prefix 规则第 4 条](../.agents/instructions/prompt-prefix.md#append-only)。在 Himawari 里用这两个钩子，只能在列表末尾追加；要缩短历史只能走压缩，唯一例外是 [prompt-prefix 规则第 14 条](../.agents/instructions/prompt-prefix.md#compaction)的成批清理旧工具结果（隐藏扩展 `himawari-tool-result-clearing`，[ADR 0285](adr/0285-one-main-thread-subthreads-and-one-inbox.md) 第 8 条）。

```typescript
pi.on("context", async (event, ctx) => {
  return { messages: event.messages.filter((m) => !shouldPrune(m)) };
});

pi.on("context_with_system", async (event, ctx) => {
  const cut = findCutIndex(event.messages);
  const head = getCurrentSystemMessage(event.messages.slice(0, cut));
  return { messages: head ? [head, ...event.messages.slice(cut)] : event.messages.slice(cut) };
});
```

`context` 收到的是去掉 system 消息的历史，只改历史；`context_with_system` 收到含开头 system 消息的完整列表，原话“The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request”，规则是第 0 条必须是 system 消息。

<a id="pattern-provider-hooks"></a>
### 看或改发给服务方的请求

出处：`docs/extensions.md` 第 864 行“before_provider_request”、第 883 行“after_provider_response”。

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));
});
pi.on("after_provider_response", (event, ctx) => {
  if (event.status === 429) console.log("rate limited", event.headers["retry-after"]);
});
```

返回 `undefined` 不改请求体，返回别的值就替换。1.5.1 新增说明：对“接着上一次回答继续”的服务方（OpenAI Codex WebSocket、Anthropic 消息线程），请求体可能只含新增部分。

<a id="pattern-provider"></a>
### 接模型服务方

出处：`docs/custom-provider.md` 第 7 行“Choose the smallest integration”、第 51 行“Register a compatible endpoint”、第 164 行“Reuse a supported streaming API”。

```typescript
pi.registerProvider("acme", {
  name: "Acme AI",
  baseUrl: "https://api.acme.example/v1",
  apiKey: "$ACME_API_KEY",
  api: "openai-completions",
  models: [{ type: "chat", id: "acme-chat", name: "Acme Chat", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
});
```

- 服务方协议和 Pi 已支持的一样（Magpie、Vercel AI Gateway 都是 OpenAI Chat Completions），就复用 Pi 的实现，原话“This is safer than copying a stream implementation because it preserves Pi’s message conversion, tool handling, usage accounting, cancellation, and compatibility behavior”。
- 只有协议 Pi 不支持时才自己写 `streamSimple`（第 176 行“Implement `streamSimple` only when no existing API implementation can represent the service”），而且必须调用 `onPayload`、`onResponse`、`onProviderStreamEvent` 并传递中止信号（第 174 行起）。
- 需要自定义取密钥方式时，用完整 `Provider` 的原生认证（第 126 行“Use native provider authentication when the integration needs stored credentials, custom resolution, ...”）。
- 模型的 `promptCache` 不填，Pi 就不做缓存预热（第 149 行“Leave them unset to disable cache warming for that retention tier”）。

Himawari 的写法在 `packages/runtime-pi/src/configured-model-binding.ts` 的 `initializeRuntime`：`ModelRuntime.create` 后用 `createProvider`（`auth.apiKey` 的 `check`/`resolve`，`api: openAICompletionsApi()`）构造完整服务方，再 `registerNativeProvider`，见 [ADR 0205](adr/0205-pi-native-provider-auth.md)。

<a id="pattern-direct-call"></a>
### 单次后台模型调用

出处：`docs/extensions.md` 第 1224 行：“Use `ctx.modelRegistry.streamSimple(model, context, options)` ... or `complete(model, context, options)` ... Use these instead of `pi-ai/compat` streaming functions, which cannot see extension provider registrations.”；请求选项见 `@earendil-works/pi-ai@1.5.1` 的 `dist/types.d.ts`（`fetch`、`onPayload`、`onResponse`、`signal`）。

整理记忆、判断邮件这类不在会话里的调用，Himawari 走 `packages/runtime-pi/src/pi-model-transport.ts`（`binding.modelRuntime.stream(...)`，用 `fetch` 选项包一层出口遮盖）。新的后台调用一律走这个入口，不得直接调 `ctx.modelRegistry.complete`，因为那样会跳过 Himawari 的准入、预算和出口遮盖。

<a id="pattern-compaction"></a>
### 压缩

出处：`docs/compaction.md`；`docs/extensions.md` 第 534 行“session_before_compact”；示例 `examples/extensions/custom-compaction.ts`。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, signal } = event;
  const summary = await summarize(preparation.messagesToSummarize, preparation.turnPrefixMessages, signal);
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
});
```

- 什么时候压缩由设置决定：`contextTokens > contextWindow - reserveTokens`（`docs/compaction.md`“When It Triggers”）。
- 让压缩请求沿用原对话的开头（[prompt-prefix 规则第 13 条](../.agents/instructions/prompt-prefix.md#compaction)）已按 [ADR 0207](adr/0207-compaction-request-reuses-conversation-head.md) 做：`session_before_compact` 只观察、返回空，由模型运行库的包装改写 Pi 自己发出的摘要请求。真要自己出摘要，用 `session_before_compact` 返回 `compaction`；官方示例里的 `ctx.modelRegistry.complete` 在 Himawari 里要换成 Himawari 自己的模型调用入口，理由见[单次后台模型调用](#pattern-direct-call)。
- 返回 `{ cancel: true }` 取消这次压缩。

<a id="pattern-steer"></a>
### 运行中插消息

出处：`docs/extensions.md` 第 1627 行“pi.sendMessage”；`docs/sdk.md` 第 62 行“Prompting”。

```typescript
pi.sendMessage(
  { customType: "my-extension", content: "Message text", display: true },
  { triggerTurn: true, deliverAs: "steer" },
);
```

`deliverAs: "steer"` 在当前这轮工具跑完、下一次请求模型之前送达；`"followUp"` 等整轮结束；`"nextTurn"` 等下一次用户输入。会话外部用 `session.sendCustomMessage(message, options)`，用户消息用 `session.steer()` / `session.followUp()`。不得直接调 `session.agent` 上的方法（`steer`、`continue`、`hasQueuedMessages` 等）或读写 `session.agent.state`，现有的这类调用见[偏离 D5](#current-deviations)。

<a id="pattern-settle"></a>
### 结束前补一步

出处：`docs/extensions.md` 第 663 行“agent_before_settle”：“the final actionable boundary: it can append session entries and request one continuation”。

```typescript
pi.on("agent_before_settle", async (event, ctx) => {
  if (addedReviewReminder) return;
  addedReviewReminder = true;
  return {
    entries: [...event.entries, { type: "custom_message", customType: "review-reminder",
      content: "Review the final diff before replying.", display: false }],
    continue: true,
  };
});
```

无条件返回 `continue: true` 会死循环，必须有条件。

<a id="pattern-abort"></a>
### 中止

出处：`docs/sdk.md` 第 70 行：“`abort()` stops the active operation and waits for the session to become idle.”；`docs/extensions.md` 第 1230 行“ctx.signal”。

会话外部用 `await session.abort()`。工具和扩展内部不能等会话空闲（会自己等自己），用传进来的 `signal` 或 `ctx.signal` 让正在做的事停下。

<a id="pattern-settings"></a>
### 重试、缓存预热等设置

出处：`docs/settings.md`（全部设置和默认值）。

```typescript
SettingsManager.inMemory({
  compaction: { enabled: true },
  retry: { enabled: false, maxRetries: 0 },
  cacheWarming: "streaming",
});
```

- 自动重试 Himawari 关着（[ADR 0198](adr/0198-upgrade-pi-to-1-5-0.md#decision) 第 7 条）。模型请求层的重试开着：传给 pi-ai 的 `maxRetries: 2`、`maxRetryDelayMs: 10000`，只重发同一份请求、不碰历史（[ADR 0245](adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md)）。
- 缓存预热（`cacheWarming`，Pi 定时补发一个只要 1 个输出 token 的请求，让服务方的缓存不过期）：1.5.0 默认 `"streaming"`，1.5.1 默认改成 `"idle"`，空闲时最多续 30 分钟。补发的请求会花钱。升级 Pi 时必须先看 `CHANGELOG.md` 里改了哪些默认值。
- 预热要保留，不能因为 Himawari 管不到费用就关掉（Andy 2026-11-10）。官方的管法：模型配置写 `promptCache`（服务方缓存能存几秒，没写的模型不预热，`docs/models.md` 第 106 行）；每次预热前 Pi 发 `cache_warming_decision` 事件（`docs/extensions.md` 第 912 行），第 929 行原话“Return `{ action: "warm" }` or `{ action: "stop" }` to override”，Himawari 在这里按自己的预算决定；预热的用量 Pi 记成一条 `cache_warm` 会话条目并发出 `entry_appended` 事件（1.5.1 `dist/core/cache-warmer.js` 第 188 行）。Himawari 现在把 `entry_appended` 列为忽略的事件（`pi-runtime-adapter.ts` 的 `KNOWN_IGNORED_EVENTS`），用量表的来源也只有 `model-port`、`agent-stream` 两种（`packages/application/src/ports/model-usage.ts`），所以记预热用量要在 D7 的方案里一起改：事件映射（从忽略列表拿掉还要加处理分支，否则会报未知事件）、用量的类型、持久化校验和迁移里的 `CHECK`。预热请求由 Pi 直接重放上一次请求（1.5.0 `dist/core/cache-warmer.js` 第 238 行），不经过 Himawari 替换的请求函数，所以没有准入、预算和用量记录；但它沿用那次请求的选项（1.5.0 `dist/core/sdk.js` 第 199、269 行把选项原样存下），D1 第 2 步之后，预热器调用的是每次运行的模型代理，遮盖和密钥在代理里现加，所以不会绕开遮盖，但预热请求也会先走审批回放的判断（[ADR 0208 第 2 步记录](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#step-2-record)）。但这些 `fetch` 是为一次请求做的，例如走 Vercel 网关时，一个成功的响应之后不允许再发（上一次是 408、409、429 或 5xx 的拒绝时最多再发 2 次，见 [ADR 0245](adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md)），再发就报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`（`packages/runtime-pi/src/gateway-observation.ts`），预热重放会失败；D7 的方案要给预热单独准备能重复用、仍走遮盖的 `fetch`，并用“连续两次都遮盖、都带密钥”的测试锁住。
- DeepSeek 不需要预热：缓存自动开启，不用之后“usually within a few hours to a few days”才清掉（<https://api-docs.deepseek.com/guides/kv_cache>）。Himawari 每次运行（处理一条用户消息的整个过程，中间可以多次请求模型）新建 Pi 会话、跑完关掉（`pi-runtime-adapter.ts` 的 `session.dispose()`），会话一关预热就停，所以两次运行之间的空闲预热现在跑不起来。
- 现状（[ADR 0206](adr/0206-pi-deviations-d5-insertion-and-d7-cache-warming.md)）：Himawari 显式写 `cacheWarming: "streaming"`，升级 Pi 不会被新默认值带走；注册给 Pi 的模型都不填 `promptCache`，所以不预热，`configured-model-binding.compat.test.ts` 的 `[D7]` 用例锁住这一点。要加 5 分钟缓存的模型，先按上一条出整套方案（预算、遮盖、用量）。

[↑ 回到阅读导航](#contents)

<a id="himawari-owned"></a>
## 四、Himawari 自己负责的部分

下面这些 Pi 不负责，由 Himawari 自己写（来自 [Pi 优先与工作区约定](../.agents/instructions/pi-and-workspace.md#pi-first-development-principle)）：权限与审批、数据分级与披露、密钥句柄和主机密钥来源、受保护的载荷、持久状态与审计、产品层面的模型选择和备选、预算执行，以及 Gateway、Worker、记忆的集成。

这些功能接到 Pi 上时，接入点仍按[第三节](#official-patterns)的官方写法选：例如拦截用 `tool_call`，执行位置用 `operations`，观察请求用 `before_provider_request`。“这是 Himawari 自己的功能”不是绕开官方接入点的理由。

<a id="current-deviations"></a>
## 五、现有的偏离（未经 Andy 批准，不得照抄或扩大）

2026-11-10 对照 1.5.1 文档核查的结果，同日 Andy 回“按建议”后的状态写在最后一列。每一条都要出方案交 Andy 定：要么改成官方写法，要么由 Andy 批准保留并写进 ADR。批准前，新代码不得照抄，也不得在上面加功能。状态改变时更新这张表。

| 编号 | 位置 | 做了什么 | 对应的官方写法 | 为什么没照官方 | 状态 |
|---|---|---|---|---|---|
| D1 | `pi-runtime-adapter.ts` 的 `governedModelRuntime`（每次运行的 `ModelRuntime` 代理，重写 `streamSimple`；原为 `session.agent.streamFunction = ...`） | 替换 Pi 每次请求模型的函数：换成冻结的系统提示和工具、准入和预算、出口遮盖、审批续跑时回放已有回答、识别压缩请求 | 请求开头用 `context_with_system`；准入、遮盖、还原放进注册的服务方（复用 `openai-completions`，外面包一层）；观察用 `before_provider_request` | [ADR 0198](adr/0198-upgrade-pi-to-1-5-0.md#options) 只比较了 `before_agent_start` 一条路，没比较 `context_with_system` 和服务方包装 | Andy 2026-11-10 同意方案，分三步实施，第 1 步（D6）、第 2 步（把 `streamFunction` 赋值改成每次运行的模型代理）已完成（[ADR 0208](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#step-2-record)），第 3 步（开头走 `context_with_system`）已完成（[第 3 步记录](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#step-3-record)）；准入、预算、遮盖还原、审批回放、拒发仍在每次运行的模型代理上 |
| D2 | `pi-runtime-adapter.ts` 的 `createTool` 里调 `tools.preflight`、`reconciliation.suspend` | 权限判断和等审批写在工具的 `execute` 里，等审批时存快照、结束这次运行 | `tool_call` 拦截（`permission-gate.ts`） | 官方拦截只能在进程里当场等；审批要等几小时、服务可能重启（[ADR 0023](adr/0023-durable-hitl-execution.md)）。ADR 0023 写于 Pi 0.x，没写和 `tool_call` 的比较 | Andy 2026-11-10 批准保留（[ADR 0204](adr/0204-handle-pi-deviations-d2-d3-d5.md)） |
| D3 | `pi-tool-batch-continuation.ts` | 审批后续跑：存会话条目和那次回答，续跑时回放 | 官方没有稳定写法；`pi-durable` 标为实验性 | [ADR 0023](adr/0023-durable-hitl-execution.md)、[ADR 0198](adr/0198-upgrade-pi-to-1-5-0.md#decision) | Andy 2026-11-10 批准保留（[ADR 0204](adr/0204-handle-pi-deviations-d2-d3-d5.md)） |
| D4 | `configured-model-binding.ts` 的 `initializeRuntime`（原 `pi-runtime-adapter.ts` 的 `sessionModelRuntime`） | 已关闭：原来用 Proxy 改写 `hasConfiguredAuth`；现改为完整 `Provider` 的原生认证（`check` 回“已配置”、`resolve` 只从 `credential` 取密钥，来源唯一靠空凭据库），见 [ADR 0205](adr/0205-pi-native-provider-auth.md) | 完整 `Provider` 原生认证（`createProvider` + `registerNativeProvider`） | — | 已改回官方写法；升级 Pi 时重查 `[D4]` 测试 |
| D5 | `pi-runtime-adapter.ts` 审批续跑的 `session.agent.continue()`、续跑那一轮里“工具循环已停止”提示的 `agent.steer`、一轮结束后的补跑循环（`agent.hasQueuedMessages()` + `agent.continue()`）、工具内部的 `agent.abort()`（读历史和工具、其余插消息和中止已在 2026-11-10 改成 `session.messages`、`session.getActiveToolNames`、`session.getToolDefinition`、`session.sendCustomMessage`、`session.abort()`） | 绕过会话直接用底层 Agent | 会话层没有“不加新消息、接着跑”和查底层队列的接口；`session.abort()` 会等会话空闲 | 续跑若改成 `sendCustomMessage(..., { triggerTurn: true })`，模型会多看到一条合成消息；续跑那一轮里会话不算运行中，`sendCustomMessage` 会直接写进历史；Pi 收尾前有一次 `await` 间隙，落进去的后台通知要补跑；工具里等不到会话空闲 | Andy 2026-11-10 批准保留（[ADR 0204](adr/0204-handle-pi-deviations-d2-d3-d5.md)、[ADR 0206](adr/0206-pi-deviations-d5-insertion-and-d7-cache-warming.md)） |
| D6 | `pi-runtime-adapter.ts` 的 `himawari-system-prompt` 扩展（已删除） | `before_agent_start` 返回系统提示，D1 又在请求前换一次 | 二选一 | 扩展已删除，D1 仍保留；删除前后和合入 D4 后各做过一次逐字节对比，请求不变（[ADR 0208](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#decision) 第 1 步） | D6 已改回官方（[ADR 0208](adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md)） |
| D7 | `pi-runtime-adapter.ts` 的 `SettingsManager.inMemory` 和模型配置 | 已显式设 `cacheWarming: "streaming"`；模型都不填 `promptCache`，所以从不预热，也就没接预热的预算判断和用量记录 | 模型填 `promptCache`；`cache_warming_decision` 按预算回 `warm` 或 `stop`；`cache_warm` 条目记进用量表（见[设置](#pattern-settings)） | 生产只有长时间缓存的 DeepSeek，不需要预热；加 5 分钟缓存的模型之前必须先做整套 | 设置已锁定，整套等加短缓存模型时先出方案（[ADR 0206](adr/0206-pi-deviations-d5-insertion-and-d7-cache-warming.md)） |

<a id="how-to-deviate"></a>
## 六、要偏离时怎么做

1. 写出前提：官方文档和示例的原文（包名、版本、文件、行号、原话），说明官方写法具体缺什么。
2. 写出至少两个办法，其中一个必须是“照官方写，接受它的缺点”，比较各自的代价。
3. 写清它会不会改变模型已经见过的请求开头（[prompt-prefix 规则第八节](../.agents/instructions/prompt-prefix.md#before-you-change)）。
4. 交 Andy 看。他同意后：新开一份 ADR 记下决定，在[第五节](#current-deviations)加一行，并加一条测试，让 Pi 升级后官方行为一变就失败。
5. 升级 Pi 时，逐条重查第五节：新版本官方补上了的，改回官方写法。

[↑ 回到阅读导航](#contents)
