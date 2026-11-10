（本轮已达到工具步数上限，以下结论只基于已读到的内容；未读到的文件与 Pi 1.5.x 源码均标「未核实」。）

## 一、证实的

### 高：方案对现有代码的定位与行号基本准确，但「文档覆盖」这一条被高估了

- 严重度：高
- 问题：方案多处把正确性押在 `npm run check:prompt-prefix` 上，但该检查的覆盖清单里没有「不在运行中的工具循环停止提示」和「删除补跑循环」这两条路径，方案也没有为它们新增阻断用例。
- 证据：`pi-runtime-adapter.ts:1383` 有 `appendLoopStopped`，`:1456` 有 `if (toolProgress.blocked) appendLoopStopped();`；`.claude/rules/prompt-prefix.md:74` 列出的 `check:prompt-prefix` 覆盖范围是「工具调用、搜索结果、银行卡号遮盖、附件长文本、每轮变化的记忆和时间、运行环境说明只在变化时发，以及按对话冻结」，并明确说「换新的各种条件、运行中压缩后补发运行环境说明」由另外三个测试覆盖，**不在这一步里**；清单里没有工具循环停止、更没有「排队消息续跑」。
- 建议：为第 1 条新增真实 Pi 用例：在非运行态触发 `appendLoopStopped`，断言下一条请求的最后一条消息是这条提示且历史前缀逐字节不变；为第 4 条新增「挂起/未知工具/失败/中止/工具循环卡住/取消」六种 `canContinue=false` 状态的反向用例，断言不会自动续跑。只保证「check 必过」不足以锁住这两条。

### 中：方案引用的复核材料在当前检出里不存在

- 严重度：中
- 问题：待审方案说「问题、约束和已核对的事实同 `.agents/reviews/topic-pi-d5-d7/briefs/plan-1.md`；两个模型各自的方案在 `.agents/reviews/topic-pi-d5-d7/round-1/`」，但这些路径在本次提交中读不到。凡以 brief 为「已核对事实」的结论都无法复核。
- 证据：`read` 该路径返回 `File not found`；`glob .agents/reviews/topic-pi-d5-d7/**/*` 返回 `No files found`；`git show --stat HEAD` 只列了 `pr-354` 的复核材料。
- 建议：把这些材料随方案一起提交，或在本方案里重述关键事实。否则落实时会出现「按 brief 定的前提」与仓库实际不一致。

### 中：ADR 0204 已覆盖 D5，方案又新开 ADR 0206，存在重复/冲突风险

- 严重度：中
- 问题：本次合并已经新增 `docs/adr/0204-handle-pi-deviations-d2-d3-d5.md`，标题就包含 D5；方案又要求写 ADR 0206 记录 D5。两份 ADR 若结论不一致，后人不知道以哪份为准。ADR 0204 正文我未读，具体是否已对 D5 下结论「未核实」。
- 证据：`git show --stat HEAD` 显示新增 `docs/adr/0204-handle-pi-deviations-d2-d3-d5.md`；方案「文档」节写「ADR 0206：D5 插消息改官方写法……」。
- 建议：先读 ADR 0204；若它已处理 D5，则修订 0204 而不是新开 0206，或明确 0206 只补充哪几条并互相链接。

## 二、推测（需按建议核实，未核实前不应动工）

### 高：第 4 条删除 `#continueForSteeredNotices` 会移除 Himawari 自己加的停止闸

- 严重度：高
- 问题：现循环是 `while (canContinue() && session.agent.hasQueuedMessages())`，`canContinue` 覆盖挂起、未知工具、失败、中止、工具循环卡住、取消。方案打算「Pi 会把排队消息跑完」就整段删掉。若 Pi 的 `_startRun` 只是无条件 drain 队列，那么这些本来该停的状态会变成继续发请求：多花模型调用、在循环卡住时反复续跑，最坏是无限追加——属于资源/费用耗尽风险。方案只写「逐一核对」，没有给出核对项与对应的自动用例。
- 证据：`pi-runtime-adapter.ts:1232-1237` 的 `#continueForSteeredNotices` 与 `while (canContinue() && session.agent.hasQueuedMessages())`；`:1802` 的调用点带 `canContinue` 闭包。Pi 1.5.0 `dist/core/agent-session.js` 的 `_handlePostAgentRun`/`_startRun` 行为**未核实**（方案自称在 1862–1900 行，我无法打开确认）。
- 建议：默认保留循环。只有在真实 Pi 测试里逐状态证明「Pi 的 drain 也尊重同样的停止条件、且不多发一次请求」后，才允许删除；删除时至少保留一个「最多续跑 N 次」的上限作为兜底。把六种状态各写成会失败的反向用例。

### 高：第 2、5 条把 `agent.abort()` 换成 `session.abort()`，与方案自己「工具内必须用 agent.abort」的定案矛盾，可能死等

- 严重度：高
- 问题：方案「已定部分」说工具运行中 `session.abort()` 要等会话空闲、等不到，所以保留 `agent.abort()`；但第 2 条后台命令完成通知的失败回调、第 5 条存历史失败的失败回调，方案都改成 `session.abort()`，却没证明这两处一定不在运行中的工具回调里。若它们在运行中触发，`session.abort()` 等待的正是它要中止的那次运行，可能一直等不到空闲（死锁/挂起）；即使不 await，也会让 `.catch` 返回的 promise 悬着。
- 证据：`pi-runtime-adapter.ts:1659` 现为 `.catch(() => session.agent.abort())`，方案改为 `session.abort()`；`:1691` 现为 `void pending.catch(() => session.agent.abort())`，方案改为 `session.abort()`；而 `:1389-1390` 运行中分支保留 `.catch(() => active.agent.abort())`。
- 建议：先确认两处回调的运行态。无法证明「一定不在运行中」就保持 `agent.abort()`；若确实是非运行态，也应在代码里注释状态假设并加一个「在运行中触发该失败路径」的回归测试。禁止在运行路径上改为 `session.abort()`。

### 高：第 3 条把消息对象直接传给 `sendCustomMessage`，与第 1 条传字符串的用法不一致，可能类型不对

- 严重度：高
- 问题：现代码是 `session.agent.steer({ role: "custom", ...environment, timestamp: Date.now() })`，`environment` 是 `runtimeEnvironmentAfterCompaction` 返回的消息对象；方案改成 `session.sendCustomMessage(environment, { deliverAs: "steer" })`。而第 1 条现存的 `sendCustomMessage(toolLoopStoppedMessage(), ...)` 传的是字符串。两处第一个参数类型不同，至少一处与 Pi 的签名不符。若 `sendCustomMessage` 期望字符串/文本类型，把整个消息对象传进去会类型错、被静默转成 `[object Object]`，或丢掉 `customType`。这正是 I-73 那类「产生方与使用方没对校验」的问题。
- 证据：`pi-runtime-adapter.ts:1702` `session.agent.steer({ role: "custom", ...environment, timestamp: Date.now() })`；`:1389` `sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer" })`。`sendCustomMessage` 签名的确切定义**未核实**（未读 Pi dist 与适配器 import）。
- 建议：读 Pi 的 `sendCustomMessage` 定义，确认入参是字符串还是对象，并把 `environment.content`、`customType`、必要的 metadata 明确映射；补一个「补发消息内容与 `runtimeEnvironmentMessage` 生成的 content 相同」的断言，而不只断言「最后一条是这条说明」。

### 高：第 1 条非运行态「只加历史、不开新一轮」在「跑完 dispose」的会话生命周期下可能丢消息

- 严重度：高
- 问题：方案 D7 自己说「每次运行新建会话、跑完 dispose」。如果 `appendLoopStopped` 的非运行分支确实是在本轮已结束后才执行，那么往一个即将 dispose 的会话历史里追加消息，很可能在下一次请求前就被丢弃，模型永远看不到「工具循环已停止」。旧写法 `agent.steer` 至少可能把消息排到下一次运行。这不仅是位置问题，而是功能丢失。
- 证据：`pi-runtime-adapter.ts:1392` 现为 `active.agent.steer({ ... })`；`:1456` 的调用在工具进度 guard 里。会话是否在本轮后立即 dispose、dispose 是否会保留刚追加的消息**未核实**。
- 建议：确认非运行分支实际可达性；若在「会话将 dispose」时可达，改用能留下记录且能触达下一次请求的通道（例如显式持久化/事件），并加测试「本条提示必须出现在下一次请求的历史里」。若不可达，删掉这段死代码比改写法更安全。

### 中：第 4 条还会改变多条排队消息的投递顺序/合并方式

- 严重度：中
- 问题：手写循环是「一条/一批 → continue → waitForIdle」串行；Pi 的 `_startRun` 若一次 drain 多条，多条 custom 消息的先后、是否合并进同一请求可能与现在不同。虽然仍是追加，但模型看到的消息序列不同，若这些提示含「停止」「重试」等语义，行为会变。
- 证据：`:1237` 的循环结构；Pi drain 顺序**未核实**。
- 建议：针对「同一轮内产生两条以上 steer 提示」加用例，断言最终历史顺序与结果符合预期。

### 中：D7 的 `cacheWarming` 键名/取值和「配置写不进去」都未验证，测试可能保护不到

- 严重度：中
- 问题：方案要在 `SettingsManager.inMemory` 写 `cacheWarming: "streaming"`，但没核对这个键名、取值 `"streaming"/"idle"` 在该版本是否被读取；若键写错会被静默忽略，D7 等于没做。测试只断言「模型注册表里没有任何模型带 `promptCache`」，但没证明配置/覆盖层也无法注入 `promptCache`；一旦有别的入口能写，测试通过而预热仍可能发生。
- 证据：方案 D7 第 1、2 条。`SettingsManager.inMemory`、`cacheWarming`、`promptCache` 在代码中的实际定义**未核实**（未读配置层与 Pi 1.5.x）。
- 建议：读 Pi 的设置 schema 与默认值，确认键名与版本；测试改为「注册表与最终生效配置里都没有 `promptCache`」，并断言设置的 `cacheWarming` 值被 Pi 实际读到（例如通过暴露的配置快照），而不是只看源码里写了。

### 中：`Date.now()` 被移除本身不改变前缀，但「每秒变化的值必须在最后一条消息」需要按新路径重新证明

- 严重度：中
- 问题：现在时间戳在 steer 消息里（`:1702`），按规则只要求它位于最后一条消息即可。换 `sendCustomMessage` 后 Pi 会自行打时间戳，位置通常仍在末尾；但方案没有说明 `sendCustomMessage` 是否会把消息插在某个 `context_edit`/工具结果之前。若插入点不是末尾，就会违反 `prompt-prefix.md:28`。
- 证据：`.claude/rules/prompt-prefix.md:28`「每轮都会变的内容只放在最后一条用户消息里」；`:35-36` 的 append-only 及例外；`:1702` 现有 `timestamp: Date.now()`。
- 建议：保留方案里「补发后紧接的那次请求的最后一条消息是这条说明」的测试，并额外断言该消息是整个 `messages` 的最后一项，而不是只在「补发请求」这一层成立。

### 低：延迟/重复发送期间 `sendCustomMessage` 的失败处理不对称

- 严重度：低
- 问题：第 1 条保留 `.catch(() => active.agent.abort())`，第 2 条改 `session.abort()`，第 5 条也改 `session.abort()`。同一类「消息入队失败」的回退策略不一致，日后难维护。
- 证据：`:1389-1390`、`:1659`、`:1691`。
- 建议：抽一个按「当前是否在运行中」选择 abort 通道的小函数，并统一错误日志，避免三处各写各的。

## 三、侧重检查

- 错误路径：查了四处 `.catch`/`void pending.catch`（`:1389-1390`、`:1659`、`:1691`）。发现第 2、5 条改成 `session.abort()` 与「运行中会等待空闲」的定案冲突，是本次最可能引入挂起/死锁的地方。建议保留 `agent.abort()` 直到能证明非运行态。
- 不合规范/不可信输入：`toolLoopStoppedMessage()` 与 `runtimeEnvironmentAfterCompaction` 的文本会进入历史。若其中拼接了工具名或环境变量等外来内容，需确保是确定性文本、不含每轮变化值、不会被当成用户指令注入。具体内容**未核实**，建议读这两个函数并加确定性断言。
- 安全：本次改动不新增外部输入面；主要风险是 abort 通道选择导致会话卡死（可用性）和删除停止闸导致费用/请求量放大。
- 资源耗尽：第 4 条删掉 `canContinue` 闸后，若 Pi 无条件 drain，存在循环续跑/无限追加风险（高，推测）。必须用六种停止状态的反向测试兜住，或保留上限。
- 不可撤销操作：`abort` 与「存历史失败」路径改动会直接影响已持久化内容与运行中的请求；第 5 条改 `session.abort()` 若悬空，可能掩盖存历史失败。建议保持原 `agent.abort()` 并把失败显式记录。
- 规则/文档/代码一致性：`prompt-prefix.md` 的检查覆盖清单不含本次两条关键路径（证实）；方案引用不存在的 brief/round-1（证实）；ADR 0204 与 0206 的 D5 归属重复（证实存在，内容未核实）。另外 `prompt-prefix.md:84` 明确要求「会改变已发开头就停下出方案」，方案对此的论证依赖未核实的 Pi 队列语义。

## 四、如果由我来定，我会怎样改这份方案

1. 先补材料与事实：把 `topic-pi-d5-d7` 的 brief/round-1 提交进仓库；读并引用 Pi 当前安装版本的 `sendCustomMessage`、`steer`、`_startRun`、`_handlePostAgentRun` 真实源码，替换掉「1862–1900 行」这类无法复核的引用；确认 ADR 0204 是否已管 D5，避免 0206 重复。
2. D5-1：先证明非运行分支可达且消息不会随会话 dispose 丢失；不可达就删死代码，可达就选能触达下一次请求的通道。不要只把 `steer` 换成 `sendCustomMessage` 就宣称等价。
3. D5-2/D5-5：保持 `agent.abort()`，除非有测试证明回调一定非运行态；禁止在运行路径用 `session.abort()`。三处 abort 统一成一个基于运行态选择的辅助函数并记录日志。
4. D5-3：按 `sendCustomMessage` 的真实签名映射 `environment.content`/`customType`，不要直接传消息对象；测试同时断言「内容正确」和「位于 messages 末尾」。
5. D5-4：默认保留 `#continueForSteeredNotices`；只有真实 Pi 测试在六种 `canContinue=false` 状态下都证明 Pi 自身会停、且不多发请求时才删除，并保留最大续跑次数兜底。
6. D7：核实 `cacheWarming` 键名/取值与版本默认；测试改为断言最终生效配置无 `promptCache`（含所有配置覆盖入口），并验证 `cacheWarming` 确实被 Pi 读取。
7. 检查：在 `check:prompt-prefix` 或对应的真实 Pi 测试里新增本次两条路径的正向与反向用例，确保「改错会失败」。

### 必答问题逐条回答

1. 会不会改变模型已见过的请求开头？——**按「只追加」原则，方案设计的四处都应只往末尾追加，理论上不改已发前缀；但这点未被证实。** 第 1 条在非运行态「直接加历史」可能因会话 dispose 变成丢失（不是改前缀，而是消息根本没被看到）；第 4 条删除补跑循环可能改变多条排队消息的投递时机/顺序，虽然仍是追加，但下一请求的末尾内容与有无会变。每轮变化值（`Date.now()`）当前就在 steer 消息里，改后由 Pi 生成、仍应在最后一条；需用测试断言它确实是 `messages` 最后一项。依据 `prompt-prefix.md:28,35-36`，以及 `:1702`/`:1237`/`:1392` 的现状。Pi 队列语义**未核实**。
2. 会不会让同一段文字在不同请求里变成不同字节？——方案本身没有引入依赖后文遮盖、时间字段外泄或无序集合；`Date.now()` 只影响最后一条消息，按规则允许。风险在第 4 条：若 Pi 一次 drain 多条排队消息、顺序与手写循环不同，模型看到的消息序列会变；以及 `sendCustomMessage` 自行生成的时间戳格式需确认只在末尾。**未核实**。
3. 有没有对应自动检查、反向用例真的会失败？——**部分有，关键两条缺。** 第 3 条有真实 Pi 测试，第 4 条有「测试不过就保留」；但第 1 条非运行分支没有专门用例，`check:prompt-prefix` 的覆盖清单（`prompt-prefix.md:74`）也不含工具循环停止与续跑；D7 的测试只查注册表，查不到配置层。反向用例只覆盖了改写用户消息、系统提示含变化值、关冻结、中间 system 消息，**不覆盖**本次的「非运行追加」「删除补跑闸」。
4. 每个产生/使用的值两端都能接受吗？——逐个待核：`sendCustomMessage` 在 `active`/`active.agent`/`session` 上的存在性与签名（第 1 条与第 3 条第一个参数类型不一致，最可疑）；`environment` 对象形状与 `sendCustomMessage` 入参的映射；`deliverAs:"steer"` 的合法取值与 `triggerTurn` 默认行为；`cacheWarming` 键名与 `"streaming"` 取值是否被 Pi 读取；`toolLoopStoppedMessage()` 返回类型。以上均**未核实**。建议按 I-73 的方式，对每个值列出「产生处 → 使用处 → 校验处」三列逐一核对后再改。
