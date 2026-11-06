现在核对方案里引用的业界来源。
# 独立复核结论

先说核对方式：读了 `redaction.ts`、`model-egress.ts`、`production-memory-capture.ts`、提示词目录（含 `entry.ts` 固定/模板 API）、现有 egress/遮盖测试、门槛与事故清单、敏感拦截页与数据库操作、`ModelEgress` 全部构造与调用点（生产装配、Pi 传输层）；并用 webfetch 核对了方案引用的 Google、Presidio 两个一手来源。下面先写「侧重检查」，再按严重度列出问题，最后回答必答问题并给修改后的方案。

---

## 侧重检查

我走的流程：「Andy 在网页发一句话」这一条最普通的链路，从入口到出口逐段标注覆盖情况：

1. **入口 → 运行组合**（`apps/agent-service` production-*）：由 `check:prompt-prefix`（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`，含 3 条反向用例）和 `test/integration/production-http-composition-process.test.ts` 的 `[PR-A]/[PR-B]` 覆盖。✅
2. **出口遮盖**（`model-egress.ts`）：`wrapFetch` → `#prepare` → `#redactorFor` → `maskRequest` → 每个字符串 `redactForEgress`（model-egress.ts:189-219、220-237）。聊天路径有覆盖；**后台调用的遮盖没有任何测试锁「固定指令被当成外来内容」的场景**（`memory.caption` 这种）——`[SI-2]`（`packages/runtime-pi/test/pi-model-transport.unit.test.ts:506`）只锁记录与拦截，不锁「这 cate 一类文字不该被遮」。这正是事故本身，I-78 门槛候选位置。⚠️ 无覆盖
3. **拦截记录 → 页面**：reportEgress（recorder.ts:63-81）→ 去重键含 purpose（`sqlite-sensitive-interception-operations.ts:61-73` 证实）→ `where()`（`sensitive-interceptions.tsx:99-116`）。组件测试 `[SI-4]` 覆盖了 chat、无标题对话、embedding、后台无 thread 四种；**「threadId 非空 + 后台 purpose」正是本次 UI 要改的显示分支，现有测试没有任何用例走到它**（`sensitive-interceptions.unit.test.ts:65` 只有 chat 的「对话「标题」· 你的话」）。⚠️ 无覆盖
4. **整理记忆链路**：`ProductionMemoryCapture.#capture` → `memoryCapturePrompt`（production-memory-capture.ts:124-148，证实 `MEMORY_CAPTURE.text` 与 JSON 是 `\n` 拼接）→ `service-main.ts:1919-1931` 的 generate → `production-model-composition.ts:554-638 generateTextOnce` → `auxiliaryModelFor(threadId=request.threadId, purpose)`（:455-583）→ `PiModelTransport` → `egress.exchange`（`pi-model-transport.ts:313`）。audit 侧的记忆凭据排除有直接单测（memory-credential-exclusion），但**整条 background 链没有端到端遮盖断言**。⚠️
5. **`ModelEgress` 的所有构造点**：生产只有 `apps/agent-service/src/production-model-egress.ts:76` 一处（证实）；另一个是测试装配。所以「清单从生产构造点接入」在物理上是可锁死的，这是门槛设计的关键前提（下面第 2 条要用）。
6. 顺手证实方案的关键叙述：`memory.capture` 固定文字里「密码和验证码用 restricted。」到下一行「confidence 是 0 到 1000 的整数」之间只有约 31 个字符，`redaction.ts:65-68` 的 40 字符窗口确实会把 `1000` 判成验证码；`DIGIT_RUN`/窗口/例外（尾号、日期、格式化数字，redaction.ts:256-266）与方案描述一致。

---

## 问题（按严重度从高到低）

### 一、证实的

**1.（高）方案漏掉文档与代码的一致性改动**
`.claude/rules/prompt-prefix.md` 第 5 条：「出口遮盖是唯一的例外：……遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同」；第 11 条结尾：「排在点名消息前面的消息不受影响」。修复后遮盖的确定性多了一个输入——构建内的提示词目录清单；「/key 轮换」类一次失效也会多一种来源。规则是 AGENTS.md 里的硬规则（AGENTS.md:43），`docs/kv-cache-guide.md` 第 97 行同步描述这段。
建议：随改动更新两份文档的第 5/11 条（写明「受信区间不检查、不提供关键词，清单在构建内固定」），并在 I-78 条目里把门槛写成可运行的命令。否则会出现 I-06 那种「改了代码没同步文档」的状态遗留。

**2.（高）门槛「走生产路径」的装配点没有写死，可能测了个假链路**
方案第 3 节说「有人从生产调用点撤掉清单时，正向用例就会失败」，但生产 `ModelEgress` 的清单是在构造时注入的；测试如果自己 `new ModelEgress(...)`，撤掉生产装配永远不红。要真的锁住，测试必须走 `createProductionModelEgress`（`apps/agent-service/src/production-model-egress.ts:64-88`，生产唯一构造点）或整条 production-http-composition（`[PR-A]` 模式）。
另外「放进 `check:egress-redaction`」不合适：它是静态源码扫描脚本（`scripts/check-egress-redaction.mjs`，product 红线检查），不是 vitest；运行性门槛应挂进 `check:prompt-catalog`（本来就是 vitest 命令，package.json:44）或新起一个 `check:egress-gate`。方案说「实施时选最贴近的一个」，但这个判断本身能直接下，不必留白。

**3.（中）`redactForEgress` 是多趟原地替换，方案没写受信区间在不同趟之间怎么跟得上**
`redactForEgress` 的 `text` 会被 machine secrets（redaction.ts:208-213）、password（:215）、confidence 等（:222-266）逐趟替换，长度一直在变。方案说「先在输入里找出清单中每段文字的出现位置」——如果按原始 input 的偏移去套已突变的 text 会错位；「known 两阶段 + 每段缝隙独立跑原规则」与现有 6 条规则的顺序怎么组合，方案只有一句描述。
建议：把实现写成「在原始 input 上定位区间 → 切出缝隙子串 → 对每段缝隙跑一份现在这个完整流程（含 machine secrets、password 等全部规则）→ named-earlier 在全局末尾统一替换」，这就是两阶段语义最稳妥的落地，也顺便保证「同一位置取最长、不重叠」这类边界只算一次。并补一条「带机密标记的输入含受信文字」的用例（现有 `[MACHINE_SECRET_REDACTED]` 标记摘除会改变文本），方案里没考虑这种输入。

**4.（中）「对请求开头的影响」里后台调用那句写反了**
方案说「整理记忆每次都是独立请求，本来就没有跨请求的缓存可以丢」。DeepSeek 的 KV 缓存是自动跨请求的（官方文档：「The disk-based KV Cache of DeepSeek API is automatically activated」，https://api-docs.deepseek.com/guides/kv_cache ；OpenAI 同理但没有显式 cache_key 则按前缀匹配，https://developers.openai.com/api/docs/guides/prompt-caching），`memory.capture` 的固定指令前缀是**所有整理记忆请求共用**的：修复前所有请求共享同一个「1000 已被遮」的前缀（每次都命中），修复后这一整批前缀 miss 一次，之后重新命中。方向和范围和方案写的不一样，值得改成准确的说法，Andy 决定时也才看得出影响面是一次性的、波及所有整理记忆调用。

**5.（低）「工具定义里的固定文字都自动生效」这句不准确**
`maskRequest` 对 `DEFINITION_KEYS`（tools/functions/tool_choice/response_format，model-egress.ts:368）整个跳过，工具定义**根本不经遮盖**（:444-445）。把 `tools.web-fetch` 加入受信清单没有害处（同一文字也会出现在工具结果里，tool_result 路径是真的会被遮的），但「覆盖面」这项应该改述为「工具定义本来就不遮」，避免下一位读方案的人以为遮盖在工具定义上工作。

**6.（低）`[SI-4]` 现有用例会被 UI 改动牵动**
`apps/control-center/test/sensitive-interceptions.unit.test.ts:65` 断言 chat 行「对话「家里网络设置」 · 你的话」。聊天显示保持不变所以这条可以不破，但必须**在该文件新增**「对话「标题」· 起对话标题」和「对话「标题」· 整理记忆」用例（方案只说「Playwright 或组件测试」，点名这里有现成测试文件更省事）。

### 二、推测的（无法从代码全书核实，标明来源）

**7.（低）向量检索「启用与否结果一样」只在记忆文本不含目录片段时成立**
`redactEmbeddings` 把每段输入按 `embedding_input` 遮盖（model-egress.ts:459-469）。如果一条记忆的正文恰好逐字含有一段 ≥24 字符的目录文字，修复会让它从「遮住数字」变成「不遮」——不是缓存问题，是**已入库向量和之后新建的查询向量用两套规则算的**，相似度会偏。概率极低（要记忆正文逐字命中整段指令），但如果真的发生，症状是「那条记忆再也搜索不到」，还比较难查。建议在 risk 一节记一句，档期上可以接受不修。

**8.（低）「已发历史里贴过整段固定指令」**
方案自己已标注「需要主人恰好贴过提示词原文，无法从代码核实」。逻辑链路我从代码确认了成立：历史存遮盖前原文（规则第 5 条），清单不含旧文字时整体按旧方式检查、字节不变；含旧文字时隔点变一次。维持「需 Andy 确认」的处理。

### 三、证实方案里「对的、可以放心照做」的部分

- 误报本身：`memory.capture` 第 16→17 行距离约 31 字符，「1000」会被遮，是 `redaction.ts:65-68/256-266` 在生产路径的真实行为。
- 「扫描显示单独检查只有 memory.capture 被遮」：目录里其他 4 位以上数字（`8601`、legen 里的 `1111`）离关键词都不够近或被「尾号」例外豁免，与方案结论一致。
- 「known」两阶段设计的理由：现有测试 `egress-himawari-text.unit.test.ts` 第一个用例就是锁这个例外（`ownerPart/` 对比），方案改法不会破它；`DONE known.length ≥ 6` 的 `KNOWN_VALUE_MINIMUM_LENGTH`（redaction.ts:57）也解释了「1000」为什么不会被记成 known 引发的二次连锁。
- 双模型意见裁决里我额外核实的三条：`memory-episode-${index}` 确实在进入 egress context 前已被归一（`model-usage.ts:58-63`、调用点 `service-main.ts:1923`），DeepSeek 的意见确实不成立；模型构成里 `policy.systemInstruction` 确实来自部署配置（`production-run-policy.ts:102-116`），GLM「按 role 跳过 system」的误检风险确实存在；`packages/application` 确实已依赖 `@himawari-agent/prompt-catalog`（package.json:26），装配不需要新依赖。
- 两个一手来源引用准确：Google 排除规则原话「A `Dictionary` object, which contains a list of strings to exclude from the results.」（https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-rules ，并且那里还有 `ExcludeByHotword`——「发现值在距离某关键词 X 字符内则排除」，和这个 bug 同型）；Presidio 原话逐字吻合（现版 https://github.com/data-privacy-stack/presidio/blob/main/docs/tutorial/13_allow_list.md ）。
- I-78 编号可用：当前最大编号是 I-77（docs/incidents-and-gates.md:115）。

---

## 如果由我来定，这份方案这样改

方案主体（受信区间 + 三阶段语义 + 真生产路径门槛 + 只改页面不改数据）是对的，我保留；修改五处：

1. **文档一起改**：prompt-prefix 第 5/11 条和 kv-cache-guide 写明第三个确定性输入（构建内清单）；I-78 落门槛时门槛一栏写实际的命令名。
2. **门槛装配锁死**：测试必须经过 `createProductionModelEgress` 或 production-http-composition 的真实链路；挂进 vitest 命令（`check:prompt-catalog` 里加一项即可），不挂在静态脚本上。
3. **实现写成缝隙切分**：原始 input 上定位区间 → 缝隙各自走现流程 → named-earlier 全局末尾统一替换；加「含机密标记 + 受信文字」的用例。
4. **影响陈述改准**：后台调用共享固定前缀，所以是「一批 miss 一次后重新命中」；向量入库那个边角也写进 risk。
5. **覆盖面改述**：工具定义本来就不遮，受信清单对它的作用只体现在工具结果路径。

### 必答问题

1. **会不会改变模型见过的请求开头？** 组合层不动、仍是末尾追加、每轮变化值仍在最后一条消息——这些不变。但「遮盖结果」这一条例外会让部分已发内容的字节变一次：整理记忆等后台请求共用的固定前缀（整批 miss 一次）、老对话贴过的固定文字片段、聊天里紧挨占位符说明尾端的数字。正好落在规则第 5 条允许的例外里，Andy 确认一次即可。
2. **同一段文字会不会不同请求不同字节？** 不会，前提是方案里两处必须写死：清单在构建内固定、顺序按长度+字典序；「known」分两阶段、跨缝隙统一替换（方案已说明并有意接在规则 11 上）。改目录文字只影响新对话/新请求，老对话按旧方式检查、字节不变。
3. **有自动检查吗？反向用例会失败吗？** 设计上有：正向锁「目录每个条目』填示例』整段原样发出且无拦截」、锁「memoryCapturePrompt』confidence 是 0 到 1000』原样发出」、锁空清单时被遮。但我要补两条硬性要求：测试必须走生产 `ModelEgress` 构造点（否则撤掉装配红不了），命令要挂在 vitest 而不是 `check:egress-redaction` 静态脚本上。
4. **每个产生的值消费端都接得住吗？** 能：`trusted` 选项唯一消费方是 `ModelEgress` 的 per-string redactor；`trustedPromptTexts()` 唯一消费方也是它；`application` 已依赖 prompt-catalog、`sensitive-capture` 不新增依赖（保持 check:egress-redaction 的边界）；I-78 是下一个空编号；页面三语文案齐全（zh-CN.ts:1201-1208 等）、`message id` 集合在 `MESSAGE_PURPOSES` 与 message-ids.ts 里都对；去重键已含 purpose（sqlite-sensitive-interception-operations.ts:61-73）；`memory-episode-*` 的归一链路（model-usage.ts:58-63 → service-main.ts:1923）也扣得上。唯一例外是 `tools.web-fetch` 的目录文字在工具定义路径上根本不到位（DEFINITION_KEYS 跳过），方案应把这句话写准。
