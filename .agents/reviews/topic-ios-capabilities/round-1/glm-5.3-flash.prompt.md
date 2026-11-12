你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6d70648373f50390c4818a5c29accd9a193cdb23。
问题、目标和约束：
# 问题：Himawari 如果有一个 iOS 原生 App，它应该给 Himawari 带来哪些能力

## 问题

Himawari 现在是跑在主人（Andy）租的服务器上的个人 Agent，主人通过网页和它打字对话，手机上只有加到主屏幕的网页加推送。Andy 在考虑做 iOS 原生 App，并要求从产品经理的高度回答：**结合 Himawari 的使命和愿景（`docs/product-vision.md`，请先通读），iOS 端到底应该具备哪些能力、怎样接入 Himawari，这些能力各自怎样服务于最终愿景。**

Andy 举过两个例子，只是例子，不是需求的全部，不要陷在例子里：
- “让手机一直听着周围环境……同学说‘要不要周末一起出去吃饭’，Himawari 就可以生成一个待办或者提醒。”
- “我和朋友说最近我喜欢骑公路车到处去游玩……Himawari 在后台听到之后判断出原来我喜欢骑自行车，然后把这个点记到记忆里面去。这就是我所说的环境感知：它通过感知我周遭的环境，更深地去了解我。”

他的原话：“我不是说陷到某一个具体功能里面去，你得从一个产品经理的高度去思考，这些功能怎么服务于最终的项目愿景。”愿景是《钢铁侠》里贾维斯那样的个人 Agent。

请从问题本身出发回答：
1. iOS 端应该具备的能力全貌（按能力类别，不按单个功能），每类对应愿景的哪条原则、哪条 Jarvis Test 或指标，能让哪个指标变好。
2. 每类能力在 iOS 上实际能做到什么程度（查苹果官方文档，写明接口名和限制；查不到的标“未核实”）。
3. 手机端和服务器端怎样分工，感知到的东西怎样进入现有的记忆、主动检查、决策记录，怎样保证可靠、可解释、可删除。
4. 哪些能力不该做或不该放在 iOS 端，为什么。
5. 各能力之间的依赖关系和建议的建造顺序。

## 目标

1. iOS 端让 Himawari 更接近愿景：更了解主人、更会挑时机、在主人身边随叫随到、能把事办成。主人不打字、不操作时，这些也在发生。
2. 主人用的是 iPhone，没有安卓手机。他愿意付苹果开发者计划 99 美元/年。
3. 主人不会用 AI 编程工具，功能必须在产品内自己完成（装好 App 后不需要他写配置、跑命令）。
4. Andy 要求：思考激进一点，不要把开发量、开发周期当作顾虑或取舍理由；按目标最高的那一版来设计。仍然有效的取舍只有：花钱、法律和隐私、可靠性、和现有规则冲突。

## 约束（来源都在仓库里，可自行打开核对）

- 原则冲突时的顺序：“用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率”（`docs/product-vision.md:55`）。原则 4：“预判的收益必须大于打扰我的成本”（`docs/product-vision.md:60`）。Jarvis 特征 2：“在环境里，不在对话框里……能感知现场”（`docs/product-vision.md:87`）。
- 不得把 Himawari 描述为本地优先；数据由主人控制，可在主人租的服务器上（`AGENTS.md`“产品愿景”）。
- 存入的记忆必须能被模型看到（ADR 0193）。
- 发给模型的内容只能往后追加，固定的在前、会变的在后；后台调用也是固定指令在前、本次数据在后（`.claude/rules/prompt-prefix.md` 第 1、2、15 条）。
- 只能用低价模型：按量付费只用 DeepSeek V4.1 Flash 这类；代码里不得写死 `anthropic/`、`openai/` 开头的模型名（`.claude/rules/owner-standing-rules.md`“钱和模型”）。
- 不许写死能动态获取的值（清单、阈值、语言列表、模型列表）。
- 界面上的数字和判断词要有可验证的定义；界面功能要有正向和反向验收（同上文件“界面上的数字和验收”）。
- 规则是硬性设定，不是记忆（`AGENTS.md`“产品愿景”第 4 点）。
- 绝不在 MacBook 上运行 Himawari 测试（`AGENTS.md`“测试主机和生产主机”）。iOS App 只能在 Mac 上用 Xcode 构建，这一点和现有规则怎样相处需要方案回答。
- 录到的不只是主人，还有没有同意过的旁人。

## 已核对的现状（main 6d70648）

- 记忆只从主人打字的消息里抽取：`apps/agent-service/src/production-memory-capture.ts:720` 写着 `source.sourceType !== "user_message"` 就返回；运行来源类型只有 `"user_message" | "schedule" | "external_event"`（`packages/application/src/ports/run-execution-source.ts:26`）。抽取策略 `memory-capture:v5`，每轮后台抽取（ADR 0142）。
- 抽取出的候选要在主人原话里逐字核对到引用（`quoteFromOwnerMessage`，同文件 130 行）；低分但核对到原话的新候选存为“待确认记忆”，只当线索、不当事实；转正必须有主人自己的原话（ADR 0179 决定第 1、6 条）。
- 记忆带来源引用 `sourceRefs`，界面能“跳到原话”（ADR 0186）。记忆有人物登记（`knownPeople`，同文件 104–112 行）。
- 主动检查目前只有 Gmail 一个来源：`export type ProactiveSource = "gmail"`（`packages/application/src/ports/proactive-checks.ts:4`）；每次开口或沉默都记账。
- 手机端现状：只有加到主屏幕的网页应用加网页推送（ADR 0089）；没有原生 App，没有录音、语音转文字（ADR 0082 背景一节）。ADR 0082 决定第 6 条：需要“后台感知”这类网页做不到的能力时重新评估原生 App。
- 生产是一台主人租的 Linux 云主机，无 GPU。

## 查到的一手资料

- iOS 加到主屏幕的网页应用一到后台或锁屏就丢麦克风（WebKit Bug 236509 <https://bugs.webkit.org/show_bug.cgi?id=236509>）。
- 原生 App：苹果技术支持 Quinn：“we allow apps that start an audio recording session in the foreground to continue recording indefinitely in the background. That's visible to the user as the orange pill in the status bar.”（<https://developer.apple.com/forums/thread/776949>）。同帖有开发者 2026-01 报告后台约 30 秒后停，无苹果回复。打断后的恢复：苹果文档要求在 `.ended` 时检查 `shouldResume` 再恢复（<https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions>）；后台能否可靠恢复录音未核实。
- 审核指南 2.5.4、2.5.14（<https://developer.apple.com/app-store/review/guidelines/>）：后台服务只能用于本来用途；录音要明确同意并有明显提示。只装在自己手机上不经过审核。
- iOS 26 的 SpeechAnalyzer / SpeechTranscriber：手机端长音频转文字（<https://developer.apple.com/videos/play/wwdc2025/277/>）；支持的语言用 `SpeechTranscriber.supportedLocales` 在运行时查（<https://developer.apple.com/documentation/speech/speechtranscriber>）；第三方文章称首发含中文、日文，未在真机核实。
- sherpa-onnx（Apache-2.0）README 称支持 iOS 和 Swift，含说话人识别、分段（<https://github.com/k2-fsa/sherpa-onnx>）；iOS 上的实际可用性未核实。
- 开源参考 TaoSheng（<https://github.com/0xCoach/TaoSheng>，MIT，只有安卓，提交 d82cc55）。它的流程：前台服务常驻收音 → 音量门槛加 Silero VAD 只留人声（前补 1 秒、静音 2 秒结束、不足 1 秒丢弃、一段最长 5 分钟）→ 手机外放媒体时跳过 → 攒批转写 → 本机声纹（CAM++）认出“我”和熟人 → 大模型把带编号的原话整理成“事件”和 7 类“提取项”（待办、约定、备忘、灵感、关键信息、决定、知识）→ 提取项先待确认，用户接受或忽略 → 每天推给用户自己的 Agent。提示词在 `app/src/main/assets/prompts/digest.md`：给日历表不让模型自己算日期；“拿不准就不算。一段对话里通常 0～2 条待办”；近 60 天被忽略的条目回传给模型归纳“不再提取同类”；后来听到“发了”给待办挂“可能做完了”；媒体内容一律不提取；每项记着依据的原话行。重启后不自动开麦，要用户点通知。Andy 的要求是学它的好做法，不是再做一个它。
- 同类产品多为专用硬件：Limitless 挂坠 2025-12 被 Meta 收购后停售；Bee（亚马逊）、Omi（开源）、Plaud。
- 法律：加州刑法 632 条要求机密谈话所有人同意；中国民法典 1033 条禁止未经同意窃听他人私密活动；日本谈话参与者自己录音一般不违法（后者只有二手来源）。主人现在在日本。
