# 方案：Himawari 每次请求模型的代码（D1）改回 Pi 官方写法

先说明职位：仓库在 2026-11-10 刚合入 ADR 0203（把这次替换登记为偏离 D1，且“待 Andy 定”）。本方案针对的就是 D1 那一行，与 ADR 0198 当年只比较 `before_agent_start` 一条路不重复。

---

## 一、方案依赖的前提

### 读代码或来源证实的

P1. Pi 官方链路里，`createAgentSession` 装的 `agent.streamFn` 就是“每次请求先 `buildRequestOptions`（把重试/超时/`before_provider_headers` 钩子拼进选项），会话请求再 `cacheWarmer.start(...)`，最后 `modelRuntime.streamSimple(model, context, requestOptions)`”，并把该 streamFn 用 `markRuntimeStreamFunction` 登记。
来源：https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/src/core/sdk.ts （`createAgentSession` 内 `streamFn: async (model, context, options) => { const requestOptions = buildRequestOptions(options); if (options?.sessionId === sessionManager.getSessionId()) { cacheWarmer.start({...}) } return modelRuntime.streamSimple(model, context, requestOptions); }`；随后 `markRuntimeStreamFunction(agent.streamFunction, modelRuntime)`）。1.5.1 与此一致（材料核对过 dist，1.5.1 该处无实质变化）。

P2. Himawari 现在并没有把官方 streamFn 完全“扔掉”：替换函数里 `admitPiStream` 的最内层还是调用被替换前捕获的官方 streamFn（`pi-runtime-adapter.ts:1617` 捕获 `originalStreamFunction`，`admitPiStream` 里 `await original(model, transcript, …)`，`pi-runtime-adapter.ts:1085-1092`）。也就是说今天真正的结构是“官方 streamFn 外面套了一层”，只有“拦截不放行”的路径才不进官方层。

P3. 请求头的改写不是 Himawari 手拼字符串，而是构造 pi-ai 的 `Context{systemPrompt, tools, messages}`（`himawariRequestContext`，`pi-runtime-adapter.ts:652-667`），再交给 pi-ai 官方的 `normalizeContext`（`pi-runtime-adapter.ts:20` 导入、`:975` 使用）序列化成开头 system 消息。头部字节由 pi-ai 官方代码写出。

P4. 扩展钩子是“fail-open”：`context` / `context_with_system` 钩子抛错只 `emitError` 记录，请求照常用未改的消息继续发。
来源：https://raw.githubusercontent.com/earendil-works/pi/v1.5.1/packages/coding-agent/src/core/extensions/runner.ts （`emitContext` 内每个 handler `catch (err) { this.emitError({...}) }`，消息列表保持不变继续返回）；文档同样写“report it but honor the handler's output”（1.5.1 `docs/extensions.md`，context_with_system 一节）。

P5. `context_with_system` 的官方定位是“整个请求开头归它”：原话 “The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request.”（1.5.1 `docs/extensions.md`，context_with_system 一节），且“a `systemPrompt` forced from `before_agent_start` is still projected onto the request afterwards”——钩子返回后，Pi 还会把 `before_agent_start` 强制的 systemPrompt 再投影到请求上。

P6. 注册服务方是进程级共享的：`configured-model-binding.ts:367-394` 在 `initializeRuntime` 里对整个 binding 注册一次 `ProviderConfig`（`api: first.api`，即 openai-completions）；`ModelRuntime` 被多个会话共享，Himawari 另用每会话 Proxy 包一层（`pi-runtime-adapter.ts:639-650`），`createAgentSession` 每次运行传入的是这个 per-run Proxy（`:1558`）。准入需要的 per-run/per-session 状态（ownerId/runId/executionLease、回放、`suspended`、`toolProgress.blocked`）只存在于适配器闭包里，不存在于注册服务方能看到的 `(model, context, options)` 里——`options` 里没有 runId（sdk.ts 直接把 ` requestOptions` 透传）。

P7. 压缩和分支摘要不走 Agent 循环，而是直接把 `this.agent.streamFunction` 发请求（pi 1.5.1 `dist/core/agent-session.js`，`compact(..., this.agent.streamFunction, ...)` 及 `streamFn: this.agent.streamFunction` 两处），摘要提示是 Pi 自带的 SUMMARIZATION_SYSTEM_PROMPT。Himawari 靠 `session.subscribe` 的 `compaction_start/end` 设标志再换回 Pi 的摘要提示（`pi-runtime-adapter.ts:1622`、`1664-1667`、`669-678`）。

P8. `agent.session` 的摘要鉴权按 streamFunction 身份分三路：官方 runtime streamFn 命中 WeakMap 时**不预解析凭据**（Pi 注释原话：“Summaries sent through them must not pass pre-resolved credentials”，agent-session.js:50-58，为修 #11520）；被替换的函数不在 WeakMap 里，落到第三路去 `modelRuntime.getAuth(model)` 做一次额外凭据查找。

P9. 现有测试对 streamFunction 的依赖点：生产代码只有 `pi-runtime-adapter.ts:1617/1621` 两处；测试里有 `pi-runtime-adapter.compat.test.ts:207/425`、`model-accounting.unit.test.ts:171`、`pi-tool-batch-continuation.compat.test.ts:146/289`、`runtime-event-contract.unit.test.ts:113` 直接读写/stub `agent.streamFunction`。

P10. 检查门槛现状：`npm run check:prompt-prefix`（`scripts/check-prompt-prefix.mjs`）用真实 Pi 适配器+真实出口遮盖对回环服务逐字节比前缀，带反向用例（改写历史、系统提示带每轮变化的值、关掉冻结、请求中间出现 system 消息；另有 503 同轮不重发、下一轮仍以第一轮开头、工具分歧一次 requests 都不发）——见 `.claude/rules/prompt-prefix.md:74`、`docs/incidents-and-gates.md:103`（I-66）。

P11. 缓存预热当前处于休眠：`SettingsManager.inMemory` 没设 `cacheWarming`，模型也没填 `promptCache`，所以从不预热，且预热治理是偏离 D7，不在本题范围（`docs/pi-development-guide.md:330-332, 356`）。

P12. 出口遮盖的图例是拼在 `context.systemPrompt` 末尾的固定常量（`egress-context.ts:15-21`），回复占位符还原在流出口（`egress-context.ts:42-108`）；遮盖后的历史照原样存、每次发送重遮（`.claude/rules/prompt-prefix.md:36`，规则第 5 条）。

### 推测（未被来源直接证实，实施时要验证）

S1. 训练材料里“替换 streamFunction 会绕过缓存预热”一句：按 P2，今天的链路只要真发了请求就会进官方 streamFn，预热 `cacheWarmer.start` 仍会被调到；被真正绕开的只有“ riot 不放行”的路径（那本来也不该预热）。结合 P11（预热休眠），这一条与“要不要改”关系不大，但我没有在 1.5.0 dist 上逐行核实 `options.sessionId` 是否真的会传入 streamFn options——实施时用一条测试锁住即可。

S2. `ModelRuntime.streamSimple` 的确切签名（收 `Context` 还是 `TranscriptContext`、`stream` 与 `streamSimple` 的分工）。今天的 `admitPiStream` 把 `Context` 型的 `transcript` 传给官方 streamFn，官方原样透传给 `modelRuntime.streamSimple`，说明该接口吃的就是这种形状；但 1.5.x 的 `dist/types.d.ts` 我未逐行读，标“未核实”。

S3. D6 提到的双份系统提示（`systemPromptOverride` + `before_agent_start`）为 Pi 内部什么机制服务（如压缩的 token 估算读 `getSystemPrompt()`），我没有读到出处，标“未核实”。

---

## 二、方案本身（推荐路径）

**一句话：职责一项都不删、接入点不引入新机件，只把“整包替换”改成“在 Pi 自己委派给模型的边界上包一层”——删除对 `session.agent.streamFunction` 的赋值，把同一组职责挂到每次运行的会话级 `modelRuntime` 代理的 `streamSimple` 上，让官方 streamFn 原样活在外面。**

### 2.1 目标结构

改后的每个模型的请求链：

```
Agent.request
  → agent.streamFn（Pi 官方原样：buildRequestOptions、cacheWarmer.start、
                    Agent 级 onPayload/onResponse/onProviderStreamEvent）
    → 会话级运行时包装 W（原 streamFunction 替换函数整体下移到这里）
        1. compacting 识别（P7）→ himawariSummaryContext
        2. himawariRequestContext：换冻结的系统提示和工具（P3，经 pi-ai normalizeContext 序列化）
        3. 硬守卫：已暂停 / 结果未知 / toolProgress.blocked / 工具分歧 → failedPiStream，不发
        4. 审批续跑 takeReplay()（restorePiToolBatch 存的答案）
        5. admitPiStream（准入 permit、markStarted、settle/markUnknown、出口遮盖 exchange+
           restoreModelStream、用量、网关选项、每请求取密钥、maxRetries 0、窗口耗尽检查）
      → binding.modelRuntime.streamSimple → 注册的 openai-completions 内置实现 → fetch
```

落点：`pi-runtime-adapter.ts` 里，现在的 `sessionModelRuntime(binding)`（:639）扩成 `createSessionRuntime(binding, () => state)`——一个 `get(target,"streamSimple")` 被会话闭包覆盖的 Proxy，其余属性照旧转发（顺路保住 D4 的 `hasConfiguredAuth` 语义，D4 本身不动）。`state` 是个可变引用格，装 `request`、`systemPrompt`、`requestTools`、`restored`、`suspended`、`unknownTool`、`toolProgress`、`compacting`。创建顺序上的小坑：`restored` 在 `sessionFactory` 之后才赋值（:1618 次），所以闭包一律经 `state` 惰性读取，不能在构造时取值。

### 2.2 逐项职责的归属

| 职责 | 放哪 | 官方写法缺口 |
|---|---|---|
| 压缩识别 + 换 Pi 摘要提示 | W 内保留（同 P7） | Pi 官方允许用 `session_before_compact` 自出摘要，但要自己再开一条模型调用链；现有标志方案字节行为已锁，先不动 |
| 冻结头（系统提示+工具） | W 内保留（P3：靠 pi-ai 官方 `normalizeContext` 写头部字节） | `context_with_system` 可以做（P5），但钩子 fail-open（P4）、工具声明编码要自己复刻；见“不选” |
| 工具分歧 / 暂停 / 循环保护 → 一次请求都不发 | W 内保留 | **官方（钩子）做不到 fail-closed（P4）；注册服务方也做不到（P6 无会话状态）。这是必须保留自写的核心理由** |
| 审批续跑回放（不调模型） | W 内保留 | 官方无稳定写法（偏离 D3 独立处理） |
| 准入/预算、出口遮盖、每请求密钥、maxRetries 0、用量、网关 | W 内沿用 admitPiStream 原代码 | 官方注册服务方での包装（custom-provider.md “Reuse a supported streaming API”）方向正确，但装不下 per-run 准入（P6） |
| 观察请求/回复 | `himawari-provider-observer`（before_provider_request / after_provider_response）不动 | 照官方（P5 相邻钩子，1.5.1 docs 864 行起） |
| 系统提示三份写法 | 不动（`resourceLoader.systemPromptOverride` + `before_agent_start` 照官方），D6 另议 | — |
| 重试关停 | 双保险：settings `retry:{enabled:false,maxRetries:0}` 已在（:1405-1412）+ W 强制 `maxRetries:0` | 照官方+强制 |

唯一的功能性代码改动：`admitPiStream` 最内层调用的对象从“捕获的官方 agent.streamFn”换成“转发 `target.streamSimple`（binding 运行时）”。sdk.ts 官方 streamFn 会先跑 `buildRequestOptions`（把 `transformHeaders`→before_provider_headers 钩子、identity、timeoutMs 拼进去），所以 W 收到的 options 已是官方整理过的形状，比自己现在“改完再喂给官方 streamFn 再整理一次”还少一轮。

### 2.3 对缓存/预热/凭据的净变化（都是推断出来的净收益，收益小但真实）

- `agent.session` 摘要鉴权走上官方第 2 支（P8），不再做一次多余的凭据查找，也不会从 Pi 凭据库里意外摸到东西——与“密钥不进 Pi 凭据库”的硬约束更一致（Himawari 的 InMemoryCredentialStore 是空的，`configured-model-binding.ts:372`）。
- 官方 streamFn 每次恢复原样，Pi 升级时去风险最大化：以后 Pi 改 streamFn 内部（ warmer、鉴权路由、选项整理），Himawari 自动跟上，不再有一份“复制的 streamFn 形状”要追。
- 若未来 D7 打开预热：预热重放会经 `P.streamSimple` 进 W（sdk.ts 构造 CacheWarmer 用的是传给 createAgentSession 的 runtime，即这个 Proxy），从而**自动获得准入和遮盖**——比今天的“重放绕过替换函数、沿用旧 fetch”更好；代价是 W 无法区分 warm 和真请求，计量要加来源标记（见风险 R4）。

### 2.4 需要改的文件和测试

| 文件 | 改什么 |
|---|---|
| `packages/runtime-pi/src/pi-runtime-adapter.ts` | 删 ：1617-1651 替换；`sessionModelRuntime` 扩成带 `state` 闭包 `streamSimple` 覆盖；`admitPiStream` 签名把 `original: PiStreamFunction` 换成 runtime 转发 |
| `pi-runtime-adapter.compat.test.ts`、`model-accounting.unit.test.ts`、`pi-tool-batch-continuation.compat.test.ts`、`runtime-event-contract.unit.test.ts` | stub 点从 `agent.streamFunction` 改到注入的会话级 runtime（P9 列出的行号） |
| `test/prompt-prefix.compat.test.ts`（`check:prompt-prefix` 的 [I-66] 用例） | 不改断言；原样跑——它驱动真实适配器，字节等价与否它说了算 |
| 新增 | ①“升级即失败”断言：会话请求必须且只经过一次 W 的准入入口（Pi 不再委派 modelRuntime.streamSimple 时立刻红）；②压缩/分支摘要请求也走 gate.begin 的计数断言；③W 的头部字节复核反例（见 R1） |
| `docs/pi-development-guide.md` D1 行、`docs/architecture-v0.1.md:454`、新 ADR | 记录决定与出处（sdk.ts streamFn 委派边界；custom-provider.md “Reuse a supported streaming API”） |

---

## 三、考虑过但不选的做法

**A. 按 D1 表格里拟的“官方写法”整体照搬：头部用 `context_with_system`，准入/遮盖放进注册服务方。**
不选的原因，一半真缺口、一半需修正：
- 钩子 fail-open（P4）：工具分歧、暂停、循环保护要求“该发的边缘一次请求都不发”，在钩子里只能“返回错误消息列表硬着头皮发出去”或者根本拦不住——这是官方写法满足不了的需求，正是 ADR 0203 第 2 条允许自设计的情形。
- 注册服务方装不下准入（P6）：`(model, context, options)` 里没有 ownerId/runId/lease，审批续跑的 per-session 状态也进不去。要硬做就得在进程里维护“当前运行”的全局登记簿，比现在的闭包更危险。
- 修正后的写法：**头部仍由 W 用 pi-ai 官方 `normalizeContext` 写**（P3——头部字节本来就是 pi-ai 官方序列化，不是 Himawari 手拼的），准入/遮盖从“注册服务方”下移到“会话级 runtime 包装”。这不是放弃官方边界，而是把边界从“ pi.registerProvider（进程级）”对准到“你传给 `createAgentSession` 的 modelRuntime 的 streamSimple（Pi 官方委派点，sdk.ts 原文）”这个 Pi 真正会调的东西上。

**B. 头部改写迁到 `context_with_system` 钩子（更“官”一层）。**
不选的原因：①即使钩子正常返回，Pi 还会把 `before_agent_start` 的 forceSystemPrompt 再投影一次（P5），两层改头部的叠加行为要逐版本核对，字节风险高；②钩子返回的是 TranslcriptContext 消息列表，冻结的工具声明要按 Pi 的内部会话编码写进第 0 条 system 消息——复刻内部编码绕开了 pi-ai 官方序列化，恰恰更容易在升级时变错字节；③ fail-open（P4）意味着它只能当“尽力而为”，真正的不变量还是得在能拒发的 W 里再验一遍。既然终验在 W，就不必引入第二处写头部的代码。

**C. 完全保留现状（D1 原样、Andy 批准保留）。**
不选的原因：与 ADR 0203 的方向（偏离要么改官方、要么入 ADR）不冲突，但没有收益也没有成本差——今天结构上 “官方 streamFn 在内层”（P2），替换外层并不绕开什么（与材料里“绕过缓存预热”的说法相反，见 S1），所以改回官方边界代价低；而“整包替换内部函数”在 Pi 升级时最脆（agent-session/sdk 内部一改就断），是规范里点名要收敛的对象。

**D. 用 Pi 官方 `streamSimple`（pi-ai/compat）自身当准入点（替换函数改调 `streamSimple` 而不是 original）。**
不选：那样 streamFn 内建的 per-session 委派、 warmer、摘 要鉴权路由全部被踩回“第三方流函数”路径——比现在倒退。

---

## 四、风险和反例

- R1（字节风险，最高优先）W 收到的 transcript 理论上与今天完全相同（官方 streamFn 对 context 不改字节，只整理 options）。反例请求头部进入 pi-ai 内置 openai-completions 的序列化分支后与今天不一致 → `check:prompt-prefix` 的 messages 逐字节比较会红。对策：大改造一次提交只动接缝不动内容函数（`himawariRequestContext`/`withPlaceholderLegend`/`restoreModelStream` 原封不动）；跑 `npm run check:prompt-prefix` 全量反向用例。
- R2（fail-open 残余）钩子层引入的任何异常仍会 fail-open，但 W 是最后闸门：建议 W 里加“头部字节复核"——`getCurrentSystemPrompt(transcript)` 必须逐字节等于冻结 `systemPrompt`（含遮盖图例后），不符即 failedPiStream 不发。反例：未来有人在 `himawari-system-prompt` 扩展里拼了动态时间 → 钩子层改了头部 → W 闸住，一次请求都不发（而不是发出个错误）。
- R3（重放路径时序）`restored` 在建会话后才赋值（:1618）。反例：闭包在构造时抓值 → 拿到 `undefined` → 审批续跑真的发了一次模型请求且印进历史。对策：闭包一律惰性读 `state`，`prompt-prefix` 的 503/重放用例加一条“续跑首次流调用零 fetch”断言。
- R4（未来与 D7 的互扰）打开预热后 warm 重放进 W，无法与真请求区分：计量会把 warm 记成 chat、ordinal 会推进。这是行为变化（今天 warm 完全无关），但方向更安全（有准入、有遮盖）。已与 P11 对照：预热当前休眠，D7 未定之前不存在差距；D7 方案里要单独给 warm 选择 `purpose/source` 标记。
- R5（影子 stub）依赖 `agent.streamFunction` 的测试（P9）若漏改，会出现“测试在 stub 旧接缝、生产走新接缝"的假绿。对策：把 4 个测试文件的 stub 点全部迁移并 grep 一遍 `streamFunction` 归零（生产代码里只应剩 0 处）。
- R6（签名对齐，S2）`modelRuntime.streamSimple` 的参数形状未逐字核实，实施第一步用类型检查+一条回环冒烟确认，不匹配就退回用 `binding.modelRuntime.stream`（Himawari 后台路径同一形状）。

---

## 五、需要人拍板的取舍

1. **接受“会话级 runtime 包装”作为批准过的偏离形态**（代替 D1 现在的“整包替换内部函数”）——规范第五节的偏离表要按本方案改写为“官方委派边界 + 批准的偏离"一行， Andy 签字。
2. **头部归属要不要也迁到 `context_with_system`**：我建议不迁（理由三节 A/B）；若 Andy 更看重“钩子拥有请求开头”的官方语义，可以把 W 的头部复核保持在，钩子层做同样换头——两边字节一致时行为等价，但多一层投影交互要逐版本核对。
3. **D6（双份系统提示）是否随 D1 一起收敛**：改完后 `before_agent_start` 的返回对线上字节已无影响（W 会覆盖），它只服务 Pi 内部状态（S3 未核实）。保守做法是留在下次出 D6 方案时一起定。
4. **D7 打开预热时，warm 请求是否允许占用正常准入通道**（R4）：本方案使其自动获得准入+遮盖，Andy 可以选择加 warm 标记（好计量）或禁止预热期间另开准入。

---

## 六、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。发给模型的内容仍只在末尾追加：历史仍由 Pi 从 `SessionManager` 条目按只追加方式投影（sdk.ts 建 agent 用 `existingSession.messages`），Himawari 这次改动不碰历史写入路径；每轮变化的值（时间、资料、运行环境）本来只在最后一条消息（`turnPrompt`，:610-629），本次改动新增/传递的只是 options 层的 `maxRetries/fetch/onPayload`，不进消息体。同一路径上，请求头（冻结提示+工具+遮盖图例）每次由同一份冻结值生成（P3/P12），每轮相同的字节；压缩请求开头仍由 Pi 自带摘要提示构成（P7），属 prompt-prefix 规则第 12 条压缩例外。系统提示与工具依然按对话冻结（`himawariRequestContext` 与 `bundle` 未动）。`check:prompt-prefix`（P10）继续逐字节锁定。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。这次没有新增任何进请求内容的值：没有带时间字段、没有依赖后文的遮盖改动、没有无序集合（工具顺序仍来自 bundle 的固定 JSON，:1315/1327；遮盖沿用不变密钥+不变前缀的确定性规则，规则第 11 条）。会字变的依旧是那条 last message 的老路，本次不改。唯一要守的是 R1：接缝搬迁期间 pi-ai 序列化代码不能被复刻——本方案刻意不复刻。

**3. 改动有没有对应自动检查、反向用例真会失败吗？**
有，且这是方案的可强制部分：`npm run check:prompt-prefix`（属于 `npm run check`）用真实适配器+真实出口遮盖驱动新缝路，字节断言和反向用例（改写历史、系统提示带变化值、关掉冻结、请求中间 system 消息、503 不重发、工具分歧一次不发）原样适用——它们驱动的是“真实适配器”，不是被替换的函数，所以反向用例语义不变、breaker 断点仍在 ask 层。准 入不漏记由 `npm run check:real-admission` 和适配器契约测试守护；本次新增三条：准入计数反例（R5 不迁移 stub 就会红）、升级即失败断言（R6 语义上由 R5 兜底：Pi 换掉委派边界时，新增断言红）、W 头部复核反例（R2，手工造一个头部漂移注入必须被拒发）。反向用例失败与否不由人认定，由这三道门的脚本自动判定。

**4. 每个产生/修改的值，所有使用方能接受吗？**
沿 I-73 的教训逐个核对（产生处 → 使用处 → 两端校验）：
- `permit / invocationId`：`gate.begin` 产生，`settle/markUnknown/usage.record` 直接消费（:1018-1038、:1093-1118）——本次原样平移，不新增字段，不改形状。
- `logicalSlot`（来自适配器依赖 `logicalSlot(request, ordinal)`）与 `streamOrdinal`:非 chat 请求沿 `usagePurpose: "other"`（:1649）保持原语义；ordinal 推进点唯一（替换函数所在处），平移后不重复。
- `systemPrompt / requestTools`：`promptBundles.resolve` + `frozenDefinitions` 产生，三处消费——(a) W 生成请求头（与冻结宣称一致，identity 哈希 ：1336-1347 又把它们锁回续跑校验 `RUNTIME_CONTINUATION_BINDING_CHANGED`）；(b) `getCurrentTools` 分歧复核（:659-661）成立；(c) I-73 的那种“清单 id 过不过下游校验”：冻结工具名必须等于 Pi 可执行工具名——已由现有 guard 保证不是“双模型复核看 diff”的自嗨。
- `maxRetries:0` 双保险（settings+强制）→ pi-ai 重试层消费，prompt-prefix 的 503 用例反向锁住“打开重试就失败”。
- `fetch / onPayload 链 / secret`：egress.exchange（ownerId/agentId/threadId 传入）+ provider observer 的 `before_provider_request` 观察点都留在 W 里，遮盖与观察两个使用方都没有被新缝漏掉。
- 新引入的“每会话运行时覆盖"值：无对外标识、无新配置键、无新清单项，所以没有需要新建的合约；映射失败路径的 error code（`PI_REQUEST_TOOLS_DIVERGED` 等）字符串不变，消费方（adapter 事件映射 + 测试）不需要改。
