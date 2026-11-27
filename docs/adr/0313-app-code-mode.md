---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-27"
implementation: in_progress
covers: "apps/agent-service/src/production-app-tools.ts, apps/agent-service/src/app-code-runner.ts, apps/agent-service/src/production-runtime-tools.ts, apps/agent-service/src/owner-scope-authorization.ts, packages/prompt-catalog/src/apps.ts"
verified_at: "df9b61fae"
---

# ADR 0313：连接的应用支持 Code Mode：模型写代码调工具，每次要先问的调用在那一步停下

<a id="contents"></a>

## 阅读导航

- [两个问题的回答](#answers)
- [前提](#premises)
- [决定](#decision)
  - [模型怎样用](#use)
  - [代码在哪里跑、怎样调到工具](#run)
  - [运行中怎样拦下来问 Andy](#approval)
  - [超时、拒绝、出错和结果](#outcomes)
- [和大厂不同的地方](#differences)
- [后果](#consequences)

<a id="answers"></a>

## 两个问题的回答

**大厂怎么做。** Code Mode 指不让模型一个一个地调用工具，而是把工具变成一组函数，让模型写一段代码，代码里调用这些函数、处理中间结果，只把最后的输出交回模型。Cloudflare 的 Code Mode 把 MCP 服务器的工具说明转成 TypeScript 接口，代码在一个断网的隔离环境里跑，函数调用经内部通道回到 Agent 去调真工具，隔离环境里没有任何密钥；要批准的调用在那一步暂停，批准后“重放”同一段代码：已经做过的调用直接返回记下的结果，不再执行，拒绝则结束这次运行、不撤销之前做过的调用。Anthropic 的 “code execution with MCP” 和 API 里的 Programmatic Tool Calling 做法相同：代码每调用一个工具就暂停，把调用交给客户端，客户端给回结果后代码继续；直接调用和代码调用同时存在，由模型按任务选择，官方指引是三步以上相互依赖的调用、或者只要汇总结果的大批数据时用代码，单次调用直接调。

**这样做是不是根治。** 是。现在模型每调一次应用工具，结果都整段进入上下文，再由模型决定下一步；连续十几步的工作（例如“把这周所有带 bug 标签的 issue 汇总、给每个建一个子任务”）要往返十几轮，中间结果全部占上下文。这次把 Code Mode 做成 `app_action` 的第三个动作，审批仍走同一个权限出口，并且精确到代码里的每一次调用，不是给整段代码放行。

<a id="premises"></a>

## 前提

1. Cloudflare：“the Agents SDK will fetch the MCP server's schema, and then convert it into a TypeScript API”；“The sandbox is totally isolated from the Internet”；“These APIs are backed by RPC invocation which calls back to the agent loop”；“The AI cannot possibly write code that leaks any keys”（[Code Mode](https://blog.cloudflare.com/code-mode/)）。
2. Cloudflare 的暂停和恢复：“Approval resumes the same script through replay. Completed calls return recorded results instead of running again.”；“Issue connector calls sequentially when an execution can pause.”；拒绝“Rejects one pending action and terminates the execution … It does not roll back earlier actions.”；每个待批准的调用带序号 `seq`（[Durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)，[API reference](https://developers.cloudflare.com/agents/api-reference/codemode/)）。
3. Cloudflare：“MCP error results become thrown connector errors.”；执行默认超时 60000 毫秒，输出按约 6000 token 截断，“all the output logs are passed back to the agent”（同上）。
4. Anthropic：“When a tool function is called, code execution pauses and the API returns a `tool_use` block.”；适合“Running multi-step workflows with three or more dependent tool calls”和只要汇总的大批数据，不适合“Making simple single-tool invocations”；工具出错时“Claude's code receives this error and can handle it appropriately”（[Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)）。
5. Anthropic：“Agents need the flexibility to choose between code execution and inference based on the task at hand.”（[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)）；“the agent only sees what you explicitly log or return”（[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)）。
6. 现有的应用工具是一个固定的 `app_action`，定义不随接了哪些应用而变，能用什么由 `describe` 告诉模型（`.agents/instructions/prompt-prefix.md` 第 7 条：“`app_action` 的定义同样是固定文字，不随连接了哪些应用、应用有哪些工具而变”）。
7. 要先问的调用：权限出口冻结意图，返回“等批准”，主人同意后同一个工具调用重放时放行；意图编号由运行、工具调用编号、能力和参数摘要算出（`apps/agent-service/src/owner-scope-authorization.ts` 第 169–174 行，`APPROVAL_ALLOWANCE_INTENT_PREFIX` 加 `digest([invocation.runId, invocation.toolCallId, invocation.capabilityRef, inputDigest])`）。
8. 每人一台的电脑由 `UserComputers.exec` 执行命令，网络只放行调用给的网址，什么都不给时全部拒绝（[ADR 0298](0298-where-tools-run.md#user-computers)：“没有调用在跑时全部拒绝”）。
9. 已经发出但没确认结果的外部动作只对账，不自动重发（[ADR 0299](0299-tool-calls-and-command-lifecycle.md#approval)：“已经发出但没确认结果的外部动作进入 `reconciling_external_result`，只对账，不自动重发”）。
10. ADR 0311 第 6、7 条：只有配置里标了信任的官方服务器上自称只读的工具直接用，其余一律先问（`docs/adr/0311-connecting-apps-through-remote-mcp.md` 第 70–71 行）。

<a id="decision"></a>

## 决定

<a id="use"></a>

### 模型怎样用

1. `app_action` 加第三个动作 `run`，参数 `code` 是一段 JavaScript 异步函数体。代码里用 `await apps.<应用>.<工具>(参数)` 调工具，用 `return` 交回结果，`console.log` 的内容也交回。不新增工具，工具集合仍然只有一个 `app_action`；改了它的参数结构，按 [按对话冻结](../../.agents/instructions/prompt-prefix.md#stable) 的规则，只在新对话里生效。
2. 用 `run` 还是 `call` 交给模型判断，程序不设步数门槛。工具说明照 Anthropic 的指引写：要连着调好几个工具、后一步依赖前一步，或者只要汇总大批数据时用 `run`；一次调用就够时用 `call`。
3. 工具的函数签名动态生成：`describe` 给每个工具多返回一行 `code`，由对方服务器当时给的参数结构（JSON Schema）现算出的 TypeScript 签名，例如 `apps.github.create_issue(input: { title: string; body?: string }): Promise<string>`。不写死任何应用的接口。

<a id="run"></a>

### 代码在哪里跑、怎样调到工具

4. 代码在主人自己的 gVisor 电脑里用 Node 运行，不给任何网址，所以断网；电脑里没有应用的令牌和客户端密钥。没有配电脑（配置里没有 `runPolicy.userComputers`）时 `run` 报 `APP_CODE_UNAVAILABLE`，`call` 照常可用。
5. 调用回到服务器照 Cloudflare 的“重放”做：每次在电脑里从头运行代码，带上已经做完的调用及其结果。代码按顺序调用，第 n 次调用如果已经有记录，就直接拿到记下的结果；遇到第一个没有记录的调用，运行器停下，把应用、工具、参数交回服务器。服务器检查、需要时问 Andy、调用真工具、记下结果，再从头运行，直到代码结束。每次运行都是一次普通的 `exec`，没有长连接，服务器重启或等批准等上几个小时都不影响。
6. 记下的每次调用都用工具调用编号、序号和这次调用的应用、工具、参数摘要做键，存在这次运行的记录里。重放时第 n 次调用和记录对不上（例如代码里用了随机数或当前时间，第二次算出了别的参数），这次运行以 `APP_CODE_NOT_REPEATABLE` 结束并告诉模型要让代码每次走同样的路；已经做过的调用不重做。

<a id="approval"></a>

### 运行中怎样拦下来问 Andy

7. 代码里的每一次调用都单独过权限出口，规则和 `call` 一模一样（前提 10）：要先问的调用在那一步停下，iPhone 上的确认卡写“应用 · 工具名”和这一次的参数；同意后重放到这一步才真正调用。意图编号在原来的算法上加上这次调用的序号和参数摘要，所以同一段代码里的第二次写操作是一张新卡，前一次的同意不会被它用掉，不会出现整段代码一次放行。
8. 已有的“这次任务 / 几天 / 一直”授权照原来的规则对每次调用单独生效。

<a id="outcomes"></a>

### 超时、拒绝、出错和结果

9. 拒绝：照 Cloudflare，Andy 拒绝某一步，这次运行就结束，不撤销之前已经做过的调用；结果里列出已经做过的调用（应用、工具、有没有出错），模型照实告诉 Andy。
10. 超时：每次在电脑里运行的期限是这个工具调用自己的期限（`executionDeadlineAt`，由运行配置给出），不另设数字；超时报 `APP_CODE_TIMEOUT`。等批准的时间不算在里面，等批准按原来的确认卡有效期处理。
11. 结果不明：一次调用已经发给应用、还没记下结果时服务器出事，重放到这一步时不重发，以 `APP_ACTION_FAILED` 结束，按前提 9 只对账（提示模型先用只读的工具查现状）。
12. 工具出错：应用说没做成（`isError`）时，代码里这次调用抛出错误，代码可以自己接住处理（前提 3、4）；工具名不对、应用没连接也一样抛出错误，说明原因。
13. 结果：工具在代码里返回应用给的文字（多段文字连在一起）。模型只看到代码 `return` 的值和 `console.log` 的输出，再加上调用了哪些工具的清单；总长度沿用 `call` 现有的上限截断。应用返回的内容仍算外来内容。

<a id="differences"></a>

## 和大厂不同的地方

- 代码跑在每人一台的 gVisor 电脑里，不是 V8 隔离环境或服务方的容器：Himawari 已经有这台电脑，断网和不放密钥的效果相同。
- 函数返回文字而不是结构化对象：和 Anthropic 一致（“returns a string”），Cloudflare 返回结构化结果。MCP 工具多数只给文字，代码里需要时自己 `JSON.parse`。
- 只读工具照 ADR 0311 的规则，用户自己加的应用在代码里同样每次先问，比大厂严，不是新的取舍。

<a id="consequences"></a>

## 后果

- 好处：多步的应用工作一次做完，中间结果不进上下文，省 token；审批精确到每次调用。
- 代价：每多一次调用就多从头跑一遍代码（每次是一次 `exec`）；代码必须每次走同样的路，用随机数或当前时间决定调用参数的代码会被拦下。
- 要跟进：电脑在生产上跑起来、在真实应用上验收后，去掉 `implementation: in_progress`。
