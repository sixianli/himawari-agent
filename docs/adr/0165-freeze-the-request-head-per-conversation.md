---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# ADR 0165：按对话冻结最终发给服务方的系统提示和工具

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的拍板](#owner-decisions)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法](#industry)
- [检查](#checks)
- [上线影响](#rollout)
- [没有处理的部分](#open-questions)

<a id="context"></a>

## 背景

模型服务方会缓存请求开头完全相同的部分（KV 缓存，即服务方对重复出现的开头内容做的缓存，命中的部分不用重新计算，更快也更便宜）。[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md) 规定：已经发给模型的内容不得改动，只能在末尾追加。

[ADR 0164](0164-move-changing-values-out-of-the-request-head.md)（第二步 PR-A）已经把工作目录、命令清单、服务商名这类每轮会变的值挪进最后一条消息。但每次运行（run，即处理主人一条消息的一次完整执行）仍按当时的配置重新拼出系统提示和工具定义：上线了新的提示词文字、改了配置里的系统指令、开关联网搜索、换了模型，进行中的对话下一轮的请求开头就和上一轮不同，整段按全价重算。本 ADR 记录第二步 PR-B：按对话冻结。PR-A 和 PR-B 一起上线。

[返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的拍板

2026-11-04（JST，日本标准时间）Andy 对第二步方案第 2 版的六个问题拍板。下面是方案文件“Andy 的拍板”一节记下的原文（方案文件在协调线程的工作区，不在仓库里）：

1. 两个 PR 一起上线：同意。
2. 工具集合变了：选 (a)，换新一次并留记录。
3. 压缩后不自动换新。
4. 句柄工具：先在日志里测量。
5. 运行环境块：只在第一轮、内容变化时、压缩之后发。
6. 显式换新：只做命令行 `thread.prompt.rebuild`。

本 PR 落实第 2、3、4、6 条；第 5 条由 PR-A 落实，本 PR 补上它留下的“同一次运行中途压缩”的缺口；第 1 条决定了本 PR 上线时进行中的对话缓存失效一次。

2026-11-05（JST）Andy 对本 ADR 原先列在“没有处理的部分”的一项拍板。问题是“同名工具的参数结构变了，也算换新条件。建议：算。”，Andy 的原话是“这里按照你的建议来”。它落实在[决定](#decision)第 2 条。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **冻结什么**：适配器（`packages/runtime-pi/src/pi-runtime-adapter.ts`）组好请求之后、交给 Pi 发给服务方之前，冻结两样东西，按原样存字节，以后不从字段重新拼：
   - 完整的系统提示字符串（身份说明、配置里的系统指令、回答语言规则、能力边界、本轮任务规则，加上工具的 `promptSnippet` 和 `promptGuidelines` 拼出的两段）；
   - 完整序列化的工具数组（每个工具的 `name`、`label`、`description`、`parameters`、`promptSnippet`、`promptGuidelines`、`constrainedSampling`，顺序不变）。

   出口层接在系统提示末尾的占位符说明（`packages/runtime-pi/src/egress-context.ts`）不在冻结内容里，它是固定文字，每次请求照样接上。存取走 application 层的端口 `RuntimePromptBundlePort`（`packages/application/src/ports/thread-prompt-bundles.ts`），由 `ThreadPromptBundleService`（`packages/application/src/services/thread-prompt-bundle-service.ts`）实现。

2. **冻结记录由哪些输入决定**：工具名的有序列表、模型（`modelRef`）、推理强度、回答语言偏好（上下文里 `answer-locale` 那条系统规则的 `ref`）。任何一项和冻结时不同，就换新一次（代数 generation 加一），并写 trace（运行的追踪事件）`prompt.bundle.invalidated`，带原因。只有提示词文字本身变了（上线了新文字、改了配置里的系统指令）**不换新**，老对话继续用冻结的那份，新对话才用新文字。（[ADR 0188](0188-recognize-passwords-without-a-separator.md) 起，记录的 `identity_json` 还带发给模型的遮盖规则版本 `redactionRuleset`，它不参与是否换新的判断；换新时写当前版本。）

   **同名工具的参数结构变了也换新**（2026-11-05 Andy 拍板，见 [Andy 的拍板](#owner-decisions)）：工具名的有序列表不变时，`ThreadPromptBundleService` 再把冻结的工具数组和本轮拼出的工具数组按工具名逐个比 `parameters`（工具参数的 JSON Schema，即描述参数格式的标准结构），有一个不同就换新一次，原因是 `tool_schema_changed`。比较之前先去掉只是说明文字的关键字（`title`、`description`、`examples`、`$comment`），`required`（必填参数名的列表）按名字排序，再按键名排序序列化，所以：
   - 只改了参数的说明文字、标题，或者对象里键的先后顺序变了，**不换新**，和只改提示词文字一样，只有新对话才用新文字；
   - `properties`（参数名到参数结构的对照表）里的参数名照原样比较，新增一个叫 `description` 的参数也会换新；`const`、`enum`、`default` 的值照原样比较；
   - 同一份参数结构每轮比出的结果都相同，不会每轮都换新。

   比较只在运行开始、还没钉住代数时做；已钉住的运行照旧用钉住的那一代。授权句柄工具不在冻结记录里，它们的参数变化不影响这条。

   回答语言偏好这一项目前在生产上永远是空的：生产的运行策略不产生 `answer-locale` 系统规则（`apps/agent-service/src/production-run-policy.ts` 返回 `policies: []`，也不给 `answerLocalePolicy` 赋值），对话里存的回答语言偏好不进发给模型的内容，系统提示里的回答语言规则是固定文字。所以现在改对话的回答语言偏好既不改变请求，也不换新，这是对的。以后生产把这条规则接进系统提示时，它的 `ref` 会进到这一项，改语言就会换新一次，不用再改冻结的代码。

3. **执行时用当前的工具描述符**：工具的处理函数照旧来自当前运行。冻结的工具数组里每个工具名都必须在当前描述符里找得到；找不到时，在运行开始时换新（原因 `tool_missing`），在一次运行中途（已钉住的代数）找不到就让这次运行失败（`RUNTIME_PROMPT_BUNDLE_TOOL_MISSING`），不把调不动的工具发给模型。

4. **授权句柄工具**不进冻结记录。它们包括：名字以 `authorized_` 开头、由一次性授权句柄带来的工具（`capabilityHandleRef` 不为空）；`execution_task_start`；以及只因为这次运行持有任务句柄才出现的 `execution_task_status`、`execution_task_output`、`execution_task_cancel`（没有开启可转后台的 `bash` 时，这三个工具只在有任务句柄的运行里出现；开启了 `bash` 时它们每次运行都在，照常冻结）。生产的工具列表（`apps/agent-service/src/production-runtime-tools.ts` 的 `listAuthorized`）给后两类工具打上 `handleBound` 标记，适配器按 `capabilityHandleRef` 和这个标记分出句柄工具，不按名字判断。运行开始时有这类工具，就接在冻结的工具后面；这一轮工具层不同，缓存会断一次，但冻结记录不变，下一轮没有句柄时请求开头回到冻结的那份，不会换新。每次出现都写一行诊断日志 `prompt.bundle.handle_tools`（带 `runId`、代数、句柄工具个数），用来测量出现频率（第 4 条拍板）。

5. **存储**：迁移 `0077_thread_prompt_bundles.sql` 新建 `thread_prompt_bundles` 表：
   - 主键 `(owner_id, agent_id, thread_id, generation)`，外键指向 `threads`，对话删除时级联删除；
   - 系统提示和工具数组各存一个加密 payload（`payloads` 表里的加密内容，沿用现有的信封加密），列 `system_prompt_ref`、`tools_ref` 以 `ON DELETE RESTRICT` 指向 `payloads`，所以删除保护的外键检查（`sqlite-governed-deletion.ts` 的 `#payloadReferenced`）自动把它们算作“仍被引用”；对话删除时 `#threadPayloadRefs` 把这两列也列入要删的 payload；
   - 另记两份指纹（sha256），读出时核对，不一致就拒绝使用；
   - `identity_json` 记第 2 条的四项输入（另有 [ADR 0188](0188-recognize-passwords-without-a-separator.md) 的遮盖规则版本，不参与是否换新的判断），`origin` 记这一代是怎么来的（`new_thread`、`rollout`、`tool_set_changed`、`tool_missing`、`tool_schema_changed`、`model_changed`、`thinking_level_changed`、`answer_locale_changed`、`classification_lower`、`rebuild_requested`），`created_by_run_id` 记建它的运行；
   - 换新时旧记录标上 `superseded_at`，不删；
   - 部分唯一索引 `thread_prompt_bundles_one_current` 保证一个对话同时只有一份没被换掉的记录。同一对话第一次并发运行时，写入在一个 `BEGIN IMMEDIATE` 事务里重读最新代数，代数和调用方看到的不同就不写、把已有的那份交回，所以只会建一份；
   - 登记进 `packages/persistence-sqlite/src/schema-catalog.ts`。

6. **什么时候换新**：新对话；第 2 条的输入变了，或冻结工具的参数结构变了；显式命令 `thread.prompt.rebuild`。**换新只在运行开始时生效**：运行第一次取冻结记录时，把用到的代数写成这个运行的一条加密“钉住”记录（运行的 payload 工件，`operationKey` 为 `thread-prompt-bundle-pin:v1`）。同一个运行之后的重试、审批后续跑、结果恢复都读这条钉住记录，用同一代，不会因为中途换新触发 `RUNTIME_CONTINUATION_BINDING_CHANGED`。续跑身份哈希里原来的“系统指令”改为“实际使用的系统提示和冻结的工具数组”。

7. **压缩**：默认不换新（第 3 条拍板）。Pi 的压缩请求用的是它自己的摘要系统提示、不带工具（`compaction.js` 里的 `SUMMARIZATION_SYSTEM_PROMPT`），本来就和对话请求不共开头；适配器只改写对话请求（带工具数组的请求），压缩请求原样放行，冻结记录不受压缩影响。

8. **没有对话的运行**（`threadId` 为空，例如主动检查、后台任务）：不冻结，照旧每次重新拼，不写任何记录。

9. **数据分类**：冻结内容按建它的那次运行的分类加密，不重新加密成更低的分类。遇到分类比冻结记录低的运行，按这个运行的分类和当前配置重新拼一份，作为换新一次（`classification_lower`）。分类比冻结记录高的运行直接用冻结的那份。

10. **上线时进行中的对话**：不回填。每个对话上线后第一次运行时建第 1 代；已经有历史的对话记为 `origin = "rollout"`，新对话记为 `new_thread`。上线前已经挂起、上线后续跑的运行没有钉住记录，不冻结、照旧重新拼，但续跑身份哈希的组成变了，这些续跑会以 `RUNTIME_CONTINUATION_BINDING_CHANGED` 失败（见[上线影响](#rollout)）。上线前开始、被上线重启打断的运行不会重新调用模型：运行协调器把它们转到“核对外部结果”（`packages/application/src/services/run-coordinator.ts` 的 `interrupted` 分支），所以不会出现同一个运行前后用两套请求开头的情况。

11. **生产开关**：配置 `runPolicy.freezeThreadPrompts` 设为 `false` 时不冻结，行为和以前一样（默认冻结）。它用于出问题时退回，以及端到端测试的反向用例。

12. **显式换新命令**：`himawari-admin thread prompt rebuild --config <配置> --thread <对话> --reason <原因> --operator <操作人> --confirm REBUILD_PROMPT_<对话>`（`apps/admin-cli/src/thread-command.ts`）。它在服务停止时运行（和其他改数据库的管理命令一样要拿到状态目录锁），把当前那一代标为已换掉，记下原因和操作人；下一次运行开始时建新一代，trace 的原因是 `rebuild_requested`，并带上原因和操作人。对话还没有冻结记录时拒绝（`THREAD_PROMPT_BUNDLE_NOT_FOUND`）。

13. **PR-A 留下的两件事**：
    - **同一次运行中途压缩**：Pi 在上下文超长时会压缩历史后继续这次运行（`compaction_end` 事件带 `willRetry: true`）。这时如果保留下来的消息里已经没有运行环境说明，适配器用 `agent.steer` 追加一条 `himawari.runtime-environment` 自定义消息补上（和工具循环停止用同一种追加方式），它会随原生历史存下；“之前发过没有”的判断（`runtime-environment-block.ts` 的 `previousRuntimeEnvironment`）认得这种消息，下一轮内容没变就不再重发。压缩发生在运行收尾（`willRetry: false`）时不追加，避免为一条说明多付一次模型调用；下一轮按 PR-A 的规则在最后一条消息里重发。
    - **审批后续跑的系统提示**：原因是续跑时 Pi 不经过 `before_agent_start`，它在每次请求前把系统提示换回自己的默认版本（`agent-session.js` 里 `prepareNextTurnWithContext` 用 `_systemPromptOverride ?? _baseSystemPrompt`，后者带 “Current working directory: …”）。现在适配器在每次对话请求发出前统一换成本次运行实际使用的系统提示（冻结的那份，或没有冻结时重新拼的那份），续跑的第一次请求和普通轮次一致。`pi-runtime-adapter.compat.test.ts` 的 “preserves loop detection across approval” 用例改为要求两者相同。

14. **辅助调用的披露边界**：标题生成、记忆整理这类辅助调用的披露授权引用仍是 `RuntimeRequest.systemInstructionRef`（`apps/agent-service/src/production-model-composition.ts` 的 `allowedDisclosureRef`），它来自每次运行冻结的运行输入，本 PR 没有改它，也没有让辅助调用读冻结记录，所以辅助调用的披露范围不变。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **在中间层用字段拼出冻结内容**（方案第 1 版）：存的是拼之前的字段，以后拼法一变，同一份记录拼出的字节就不同。改为在最终请求的边界上存最终字节。
- **只冻结第一次的工具集合，永不换新**：对话中途开了联网搜索，模型调不到新工具（方案审核意见）。Andy 选了换新一次（第 2 条拍板）。
- **固定一个“工具超集”，能不能用写在运行环境说明里**（第 2 条的选项 (b)）：缓存最稳，但模型会看到暂时不能用的工具并去试。没有选。
- **压缩后自动换成当前版本**：老对话能自动拿到提示词修复，代价是每次压缩后多失效一次。没有选（第 3 条拍板）；修复靠显式换新。
- **句柄工具改成固定的 `authorized_execute`**：要动授权协议并评测调用准确率；先测量（第 4 条拍板）。
- **把钉住的代数写进续跑记录**：只覆盖审批续跑，覆盖不到运行崩溃后的重试；改为每个运行一条钉住记录。
- **回填进行中的对话**：PR-A 本来就改了系统提示，进行中的对话无论如何要失效一次，回填没有收益。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Anthropic 的 Claude Code 压缩时沿用原来的系统提示和工具：“When we run compaction, we use the exact same system prompt, user context, system context, and tool definitions as the parent conversation.”（<https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/>）恢复的旧对话保留当时的系统提示：“System prompt: the next request reads this layer from the cache, unless a resumed conversation kept a system prompt that is now out of date.”（<https://code.claude.com/docs/en/prompt-caching>）本 PR 同样让老对话保留冻结时的系统提示，提示词修复只对新对话生效，必要时显式换新。
- 同一文档说明换模型时整段重算：“Switching models recomputes the entire request even when the content is identical.” 所以换模型时顺便换新没有额外代价。

[返回阅读导航](#contents)

<a id="checks"></a>

## 检查

- 端到端：`test/integration/production-http-composition-process.test.ts` 的三条 `[PR-B]` 用例，用安装好的真实服务、真实 SQLite，抓 `/v1/chat/completions` 的原始请求体：
  - 两轮之间改了配置里的系统指令并重启服务：第二轮请求的开头（系统提示和工具）和第一轮逐字节相同，且以第一轮为前缀；数据库里只有第 1 代。
  - 反向：同一场景把生产开关 `freezeThreadPrompts` 关掉，第二轮的开头带着新指令、和第一轮不同，没有冻结记录。
  - 中途开启联网搜索：下一轮请求的工具里有 `web_search`，第 1 代被标为已换掉、第 2 代原因是 `tool_set_changed`；再下一轮开头和第 2 代一致。再把主模型换掉，第 3 代原因是 `model_changed`。两次换新各有一条 `prompt.bundle.invalidated` trace。
- 数据库和策略层：`test/integration/thread-prompt-bundles.test.ts`（真实 SQLite，经过 SQLite 工作线程和直接执行两种方式）覆盖新对话建第 1 代、只改提示词文字不换新、`rollout`、运行内钉住（工具集合变了同一运行仍用旧代，续跑用同一代）、换新留下旧记录和 trace、换模型、分类变低、显式换新、并发首次运行只建一份、没有对话和上线前挂起的运行不建记录、对话删除时连同 payload 一起删除。两条 `[tool-schema]` 用例覆盖参数结构变了换新一次（原因 `tool_schema_changed`，带 trace，下一轮沿用新一代）；只改工具说明、参数说明、标题或键的顺序不换新；新增一个名叫 `description` 的参数仍换新。反向：去掉参数结构的比较，两条用例都失败；改成不排序、不去说明文字的直接比较，只改说明和键顺序的那条失败（第 2 轮就换新）。
- 适配器层：`packages/runtime-pi/test/prompt-prefix.compat.test.ts`（`check:prompt-prefix` 的一部分，真实 Pi 加本机回环服务）新增：系统指令变了、冻结时请求逐字节只追加；反向：不冻结时第 1 条消息被改写；句柄工具接在冻结工具后面并写测量日志；任务管理工具随任务句柄出现又消失时，冻结的工具名不变、不换新（反向：适配器不认 `handleBound` 时，三轮的工具名不同）。`apps/agent-service/test/production-runtime-tools.unit.test.ts` 检查生产的工具列表只在没有开启 `bash` 时给三个任务管理工具打标记，`execution_task_start` 总是打标记。`packages/runtime-pi/test/runtime-environment-block.unit.test.ts` 和 `pi-runtime-adapter.compat.test.ts` 覆盖运行中压缩后补运行环境说明（`willRetry` 为真才补；反向：去掉补发后用例失败）。
- 命令行：`apps/admin-cli/test/thread-prompt-rebuild-cli.unit.test.ts` 覆盖确认串、原因和操作人落库、没有冻结记录时拒绝、参数不全时拒绝。

[返回阅读导航](#contents)

<a id="rollout"></a>

## 上线影响

- **进行中的对话失效一次**：PR-A 改了系统提示，PR-B 上线后每个对话第一次运行建第 1 代，这一轮请求开头和上线前不同（第 1 条拍板已接受）。之后上线新的提示词文字、改配置里的系统指令，都不再让老对话失效。
- **老对话看不到提示词修复**：安全或正确性修复要对老对话生效，必须对相关对话执行 `thread.prompt.rebuild`。上线说明里要写明。
- **挂起中的运行**：上线前已经在等审批或等结果的运行，续跑时没有钉住记录，不冻结；续跑身份哈希的组成也变了（“系统指令”换成“实际使用的系统提示和冻结的工具”），这些续跑会以 `RUNTIME_CONTINUATION_BINDING_CHANGED` 失败，和 ADR 0164 记下的影响相同。上线前要确认没有挂起的运行，或接受这些运行失败、由主人重新发起。
- **数据库迁移**：新增迁移 77，只建表和索引，不改已有数据；上线包会带上迁移步骤。
- **加密密钥**：冻结内容和其他 payload 一样用信封加密，轮换 payload 加密密钥时旧密钥要留着才能读出冻结记录，否则这些对话的运行会失败（`RUNTIME_PROMPT_BUNDLE_*`），需要对它们显式换新。指纹存的是明文的 sha256，和加密密钥无关。
- **遮盖密钥轮换**：出口层遮盖用的密钥轮换后，同一段文字遮成的字节变了，所有对话的请求开头都会失效一次；冻结内容存的是遮盖之前的明文，所以冻结记录本身不受影响。写进运维手册的事项留给上线时处理。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有处理的部分

- **句柄工具的频率**：上线后看 `prompt.bundle.handle_tools` 日志；占比高的话另出方案改成固定的 `authorized_execute`。
- **挂起的续跑仍会被工具说明文字的改动挡住**：续跑身份哈希里仍有当前的工具描述符（含说明文字），和本 PR 之前一样。上线只改了工具说明文字时，冻结记录不换新，但挂起中的运行续跑会以 `RUNTIME_CONTINUATION_BINDING_CHANGED` 失败。
- **提示词规则文件**：`.agents/instructions/prompt-prefix.md` 没有提到冻结。建议的补充写在交付报告里，改规则要 Andy 同意。
- **生产开关的位置**：`freezeThreadPrompts` 放在 `runPolicy` 里，改它要重启服务；以后如果要按对话开关，再另行设计。
