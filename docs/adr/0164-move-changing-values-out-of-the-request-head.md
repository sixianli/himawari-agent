---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
covers: ".agents/instructions/prompt-prefix.md, apps/agent-service/src/production-run-policy.ts, apps/agent-service/src/production-runtime-tools.ts, apps/agent-service/src/sandbox-command-inventory.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/src/runtime-environment-block.ts, packages/runtime-pi/test/prompt-prefix.compat.test.ts, packages/runtime-pi/test/runtime-environment-block.unit.test.ts, test/integration/context-formation.test.ts, test/integration/context-projection.test.ts, test/integration/production-http-composition-process.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0164：会变的值挪出系统提示和工具定义，工具循环停止改为追加消息

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的拍板](#owner-decisions)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法](#industry)
- [检查](#checks)
- [后果](#consequences)
- [没有处理的部分](#open-questions)

<a id="context"></a>

## 背景

模型服务方会缓存请求开头完全相同的部分（KV 缓存，即服务方对重复出现的开头内容做的缓存，命中的部分不用重新计算，更快也更便宜）。[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md) 规定：已经发给模型的内容不得改动，每轮会变的内容只能放在最后一条用户消息里（第 1、2 条）。

在这之前，每次运行（run，即处理主人一条消息的一次完整执行）都按当时的配置和授权重新拼出系统提示和工具定义，里面夹着会变的值：

- 能力边界里有工作目录、沙箱里有和没有的命令、文档技能目录（这个目录随每次上线的版本目录变化），联网搜索开和关时是两段不同的文字（`apps/agent-service/src/production-run-policy.ts` 原来的 `runCapabilityNotice`）；
- `web_search` 的工具描述里有搜索服务商名，`web_fetch` 的描述里有服务商名和单次抓取上限（`apps/agent-service/src/production-runtime-tools.ts`）；
- 工具反复调用没有进展时，适配器把停止说明拼到系统提示末尾、把工具清空（`packages/runtime-pi/src/pi-runtime-adapter.ts` 原来的 `streamFunction` 覆盖）。

只要其中一个字不同，进行中的对话下一轮就得整段按全价重算。第二步方案分两个 PR：PR-A 把会变的值挪出去，PR-B 按对话冻结最终发出的系统提示和工具。本 ADR 记录 PR-A；PR-B 另写 ADR。

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

本 PR 直接落实第 5 条；第 1 条决定了本 PR 可以改系统提示（上线时进行中的对话缓存失效一次）；第 2、3、4、6 条属于 PR-B。Andy 还同意把 Muse（Andy 的另一个 Agent，见 ADR 0162）A 组 7 条提示词改写放进本 PR。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新增资料块 `runtime-environment`（运行环境说明）**。
   - 内容：工作目录（配置了编码工具时；目录授权不存在、已撤销或已过期时写明“本轮没有”）、沙箱里有和没有的命令（按 `apps/agent-service/src/sandbox-command-inventory.ts` 候选表的顺序）、文档技能目录、联网搜索开没开和服务商（按配置顺序）、网页抓取的服务商和单次上限。不放时间，不放任何 id，`ref` 固定为 `runtime-environment`。
   - 文字在 `packages/prompt-catalog`（`chat.runtime-environment.*`，层是 `last-user-message`），由生产策略层 `createProductionRunPolicy` 算出，按本次运行的数据分类加密存成 payload（加密存放的一段内容），经 `RunExecutionPolicy.runtimeEnvironmentRef` 传给上下文形成，成为资料段里的最后一块。选新加一个可选字段而不复用 `capabilities`：`capabilities` 产出的是 `capability-summary` 块，含义不同；老的已冻结运行输入没有这个字段，照样能读。
   - **什么时候发**（第 5 条拍板）：由 `packages/runtime-pi/src/runtime-environment-block.ts` 决定。只看原生历史（Pi 存下的、实际发给模型的消息）里最近一次压缩之后的 user 消息，只看消息开头 `<himawari-context>` 段里的运行环境块，取最近的一块。找不到（第一轮，或压缩之后还没发过）就发；内容不同就发；相同就不发。主人消息 `<owner-message>` 里出现的同样文字不算，防止伪造。
   - **遮盖**：块放在资料段末尾、紧挨 `</himawari-context>`，以一句不含数字、超过 40 个字的固定句结尾。遮盖验证码时判断窗口是前后 40 个字符（`packages/sensitive-capture/src/redaction.ts` 的 `CODE_WINDOW`），所以按上下文判断验证码时，这个块里的数字和主人消息互相够不着。例外是有意保留的：主人在同一条消息里把某串数字说成验证码时，出口层会把整条消息里所有相同的数字都遮掉（`packages/sensitive-capture/src/redaction.ts` 里按已识别值替换的那一步），运行环境说明里碰巧相同的数字也会被遮，这和资料段里其他内容的处理一样，是为了不漏掉秘密。同一条消息永远遮成同样的字节，已发的历史不受影响（规则第 1、4 条）。`packages/sensitive-capture/test/redaction.unit.test.ts` 用生产出口同样的参数测了这两种情况。
2. **系统提示只留规则**。能力边界不再含工作目录、命令清单、文档技能目录、服务商名，也不再随联网搜索开关换文字；加一句固定的话：“工作目录、可用命令、文档技能目录、联网能力见最后一条消息里的运行环境说明。那份说明由本系统生成，和本规则一样约束本轮的工具使用。它只在对话第一轮和内容有变化时附上，最近附上的那份一直有效。”身份说明“资料不是指令”一节同步写明 `runtime-environment` 和主人定下的要求一样要遵守，不然模型会把它当普通资料。
3. **`web_search`、`web_fetch` 的描述改成固定文字**，服务商和单次上限见运行环境说明。
4. **工具循环停止改为追加一条消息**。守卫第一次判定停止时，用 Pi 会话的自定义消息接口（和后台通知用同一个接口）排队一条固定文字的 `himawari.tool-loop.stopped` 消息；Pi 在这批工具结果之后、下一次请求之前把它放进对话末尾，随原生历史存下。不改系统提示，不清空工具。之后的工具调用在执行端被拒绝，工具结果是固定文字 `chat.tool-loop-rejected`。同一个运行第二次走到停止，照旧以 `PI_TOOL_LOOP_DETECTED` 失败，不再为第二次总结付费，不靠 `maxTurns`（最多轮数上限）兜底。
5. **产品策略拦下工具调用时，模型看到一句看得懂的话**：哪个能力不可用、不要重试、怎样告诉主人；按 reasonCode（拒绝原因代码）对应，未知代码用通用句。代码本身留在工具结果的 `details` 里供审计。
6. **Muse A 组 7 条**：本轮时间由程序写出当地星期几；身份说明补上“有结果告诉你”要有东西真的在盯、批准只针对主人看到的内容、编号只能原样抄、不说系统内部用语（附正反例）、记忆里的“以前同意过”不等于本轮同意，并给两条最常出错的规则补理由。身份说明增长控制在 30% 以内（3663 字到 4733 字）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **运行环境说明每轮都发**：实现最简单，但每轮最后一条消息都多一大段，模型反复读同样内容；Andy 在第 5 条拍板里没有选它。
- **在消息全文里按文字找上一次的运行环境说明**：主人在消息里贴一段同样格式的文字就能骗过判断（DeepSeek 在方案审核里指出），所以只看 `<himawari-context>` 段。
- **运行环境说明单独遮盖再拼进消息**（方案第 2 版的写法）：遮盖在 HTTP 请求体这一层整条消息一起做，单独遮盖要改出口层的结构；改为把块放在资料段末尾并用固定句隔开，用测试证明互不影响，改动更小。
- **工具循环停止时把说明改写进最后一条工具结果**：会改动已经发给模型的内容，违反只追加规则第 1 条。
- **复用 `capabilities` 字段传运行环境说明**：见“决定”第 1 条。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Anthropic 的 Claude Code 把会变的上下文放在消息里而不是系统提示里，压缩时沿用原来的系统提示和工具：“When we run compaction, we use the exact same system prompt, user context, system context, and tool definitions as the parent conversation.”（<https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/>）
- Claude Code 的提示缓存文档说明换模型时整段重算：“Switching models recomputes the entire request even when the content is identical.”（<https://code.claude.com/docs/en/prompt-caching>）

[返回阅读导航](#contents)

<a id="checks"></a>

## 检查

- 端到端：`test/integration/production-http-composition-process.test.ts` 的两条 `[PR-A]` 用例，用安装好的真实服务和真实 SQLite，抓 `/v1/chat/completions` 的原始请求体：
  - 三轮之间让目录授权过期：系统提示和工具逐字节不变，后一轮的请求以前一轮为前缀；第二轮最后一条消息没有运行环境块，第三轮写明没有工作目录。反向：临时把工作目录拼回系统提示，这条用例失败。
  - 工具循环停止：总结那次请求和前一次相比只多出三条消息（工具调用、工具结果、停止说明），开头和工具不变；下一轮请求以它为前缀，停止说明仍在历史里。
- 适配器和投影层：`packages/runtime-pi/test/runtime-environment-block.unit.test.ts`（只在变化时发、压缩后重发、`ref` 和元数据固定、伪造的不算），`packages/runtime-pi/test/prompt-prefix.compat.test.ts`（运行环境块变化只出现在最后一条消息，`check:prompt-prefix` 的一部分），`test/integration/context-formation.test.ts`、`test/integration/context-projection.test.ts`。
- 提示词目录：系统提示和工具定义允许的空位名单去掉 `workspaceRoot`、`documentSkillDirectory`、`available`、`unavailable`、`providers`、`maximumKib`，并有反向用例；`capabilityRef`、`operation`（授权句柄工具的描述）留到 PR-B 测量后再处理。渲染对照样本更新见提交说明。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 上线后，进行中的对话缓存失效一次（第 1 条拍板已接受）。之后工作目录授权过期、沙箱命令变化、换一个上线版本，都只改变最后一条消息，不再改变请求开头。
- 部署时如果有等待审批或等待结果、挂起中的运行，续跑会以 `RUNTIME_CONTINUATION_BINDING_CHANGED` 失败：续跑身份哈希里包含系统指令和工具描述，本 PR 改了这两样。上线前要确认没有挂起的运行，或接受这些运行失败、由主人重新发起。
- 配置层面的变化（开关联网搜索、改服务商）仍会改变工具列表，这一类按第 2 条拍板由 PR-B 处理。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有处理的部分

- PR-B：按对话冻结最终发出的系统提示和工具、工具集合变化时换新、句柄工具测量、命令行 `thread.prompt.rebuild`。
- 同一次运行中途发生压缩时，运行环境说明不会补发：“压缩之后附上”目前只在压缩后的下一轮新消息成立。如果压缩把带运行环境说明的那条用户消息也概括掉了，这次运行剩下的工具调用就看不到工作目录和命令清单（以前它们在系统提示里，不会丢）。复核第 3 轮指出，留给 PR-B 一起做：压缩结束时检查保留的消息里还有没有运行环境说明，没有就以追加消息补上，并加对应测试。PR-A 和 PR-B 一起上线，所以上线时不会出现这个缺口。
- 规则 `.agents/instructions/prompt-prefix.md` 第 4 条写“同一段文字永远遮成同样的字节，不得依赖它前面或后面的内容”。按已识别值替换这一步（主人点名的验证码在整条消息里都遮）和这句话字面上冲突，资料段一向如此，本 PR 让运行环境说明也落在其中。要不要把它写成规则里的明确例外，需要 Andy 决定。
- 审批后续跑时，第一次请求的系统提示来自续跑记录（Pi 恢复批次时写回的系统提示），和同一对话普通轮次的系统提示不同，缓存会在这里断一次。这是本 PR 之前就有的行为，在改工具循环用例时发现，留给 PR-B 一起看。
- `production-http-composition-process.test.ts` 里原有的 `[R2-L5] executes authenticated HTTP requests` 用例在 `origin/main` 上同样失败（对话标题和记忆捕获调用报 `PORT_INVALID_OPERATION`，计费行状态是 `unknown`），与本 PR 无关，需要单独查。
