# 先给结论

iPhone 端不该做成“第二个 Himawari”，也不该做成“一直开着的录音机”。它应该成为 Himawari 的**身体**：耳朵、眼睛、位置感、手和嘴；大脑、记忆权威、规则、决策记录和执行仍在主人租的服务器上。这样才符合愿景里的“同一个 Agent、所有表面”，也才不会把“感知”做成新的数据黑箱。

我认为比 Andy 两个例子更重要的产品判断是：

> **感知能力的上限不取决于能录多少，而取决于“录到的东西能不能变成可审计、可纠正、可删除的记忆和决策”。** 所以 iOS 端的第一优先级不是“更多麦克风”，而是“同意、端侧预处理、来源引用、待确认、决策记录、删除传播”这条信任链。

---

# 一、方案依赖的前提

每条都附来源和原话。仓库内文件用 `文件:行`，外部资料用网址。

**P1. 原则冲突时的顺序是用户主权最高。**
来源：`docs/product-vision.md:55`
原话：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

**P2. 主动必须收益大于打扰。**
来源：`docs/product-vision.md:60`
原话：“预判必须建立在已有记忆与明确偏好之上，且预判的收益必须大于打扰我的成本。”

**P3. 愿景明确要求“在环境里，不在对话框里”。**
来源：`docs/product-vision.md:87`
原话：“在环境里，不在对话框里 — 它存在于实验室、住所、战甲之中，能感知现场、能直接动手，而不只是回答问题。”

**P4. 不得把 Himawari 描述为本地优先，数据由主人控制，可以在主人租的服务器上。**
来源：`AGENTS.md:15`
原话：“‘自有优先、数据自持’……不得把 Himawari 描述为本地优先。”

**P5. 存入记忆的内容必须能被模型看到。**
来源：`docs/adr/0193-memory-is-visible-to-the-model.md:27`
原话：“Andy 2026-11-09 定的产品原则：‘存入记忆的内容必须能被模型看到’。”

**P6. 发给模型的内容只能在末尾追加，每轮会变的值只能放最后一条消息。**
来源：`.claude/rules/prompt-prefix.md:27-29,35,67`
原话：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”“每轮都会变的内容只放在最后一条用户消息里。”“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”“后台调用也是固定的在前、会变的在后。”

**P7. 现有记忆只从主人打字的消息里抽取。**
来源：`apps/agent-service/src/production-memory-capture.ts:720`
原话：`if (!source || source.sourceType !== "user_message" || source.threadId !== threadId) return;`

**P8. 运行来源类型目前只有三种。**
来源：`packages/application/src/ports/run-execution-source.ts:26`
原话：`readonly sourceType: "user_message" | "schedule" | "external_event";`

**P9. 记忆候选必须在主人原话里逐字核对到引用；待确认记忆转正必须有主人自己的原话。**
来源：`apps/agent-service/src/production-memory-capture.ts:130-138`，`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59`
原话：`quoteFromOwnerMessage` 要求归一化后的引用是主人消息的子串且长度达到下限；ADR 0179：“转正必须有主人自己的原话。”

**P10. 待确认记忆只当线索，不登记提醒和人物。**
来源：`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:54`
原话：“待确认记忆不登记提醒和人物（跳过提交后的副作用）。”

**P11. 主动检查目前只有 Gmail 一个来源。**
来源：`packages/application/src/ports/proactive-checks.ts:4`
原话：`export type ProactiveSource = "gmail";`

**P12. 记忆“跳到原话”依赖 `sourceRefs` 在来源对话里匹配主人消息。**
来源：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:39`，`apps/agent-service/src/production-memory-control.ts:112-124`
原话：“服务端按来源对话分组，用 `sourceRefs` 在那个对话里匹配 Andy 说的消息。”代码里 `earliestSourceMessage` 先看 `sourceThreadId`，再用 `sourceRefs` 匹配 `contentRef`。

**P13. 原生 App 的重新评估条件已经出现：后台感知是网页做不到的能力。**
来源：`docs/adr/0089-web-push-only-owner-entry.md:66`
原话：“原生 App 只在下面任一条件出现时重新评估：需要锁屏小组件、灵动岛、Siri 深度整合或后台感知这类网页做不到的能力。”

**P14. 原生 App 可以在前台开始录音后继续后台录音，但系统会显示橙色胶囊；后台恢复和长期存活没有保证。**
来源：Apple 开发者论坛 <https://developer.apple.com/forums/thread/776949>
原话：“we allow apps that start an audio recording session in the foreground to continue recording indefinitely in the background. That's visible to the user as the orange pill in the status bar.” 同帖有开发者报告后台约 30 秒后停止，苹果未回复；2026 年也有 iOS 26.5 约 50 秒被 SIGKILL 的报告（后者是论坛用户报告，未核实为普遍行为）。

**P15. 录音必须明确同意并有明显提示；后台服务只能用于本来用途。**
来源：App Store Review Guidelines <https://developer.apple.com/app-store/review/guidelines/>
原话：“2.5.4 Multitasking apps may only use background services for their intended purposes: VoIP, audio playback, location, task completion, local notifications, etc.”；“2.5.14 Apps must request explicit user consent and provide a clear visual and/or audible indication when recording, logging, or otherwise making a record of user activity.”

**P16. iOS 26 起有端侧长音频转写；语言支持要在运行时查。**
来源：<https://developer.apple.com/documentation/speech/speechanalyzer>，<https://developer.apple.com/documentation/speech/speechtranscriber>
原话：SpeechAnalyzer “Analyzes spoken audio content in various ways and manages the analysis session.” 可用性 `iOS: 26.0.0 -`。SpeechTranscriber “Use the `isAvailable` or `supportedLocales` properties to see if the current device supports the speech-to-text models.” 中文、日文是否在真机可用，未核实。

**P17. 端侧 Foundation Models 只在支持 Apple Intelligence 的设备上可用。**
来源：<https://developer.apple.com/documentation/foundationmodels>
原话：“To use Apple Foundation Models, people need a device that supports Apple Intelligence.”

**P18. 后台静默推送是低优先级，不保证送达，也不应超过每小时两三条。**
来源：<https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app>
原话：“The system treats background notifications as low priority: you can use them to refresh your app’s content, but the system doesn’t guarantee their delivery. In addition, the system may throttle the delivery of background notifications if the total number becomes excessive. … don’t try to send more than two or three per hour.”

**P19. 位置后台能力有边界：显著位置变化可唤醒 App，但用户关掉后台刷新就收不到。**
来源：<https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/LocationAwarenessPG/CoreLocation/CoreLocation.html>，<https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background>
原话：“Significant-change location updates require an authorization status of `kCLAuthorizationStatusAuthorizedAlways`.” “When a user disables the Background App Refresh setting … the significant-change location service doesn’t relaunch your app.”

**P20. Live Activity 必须由用户在 App 前台发起，不能当后台常驻服务。**
来源：<https://developer.apple.com/videos/play/wwdc2023/10184/>
原话：“A Live Activity can be requested when your app is in the foreground.” “Your app should only request a Live Activity after discrete user action.”

**P21. App Intents 可以把 App 动作接到 Siri、Spotlight、快捷指令、Action Button、Widget、Live Activity 和 Focus。**
来源：<https://developer.apple.com/documentation/appintents>
原话：“Make content and actions discoverable by Apple Intelligence and support system experiences like Siri, Spotlight, Shortcuts, and widgets.” “People can configure Apple Pencil or the Action button on iPhone to perform your app’s actions when pressed.”

**P22. MacBook 上不得运行 Himawari 测试，MacBook 只用于编辑、审查和提交。**
来源：`AGENTS.md:117`，`.agents/instructions/test-and-production-hosts.md:8`
原话：“绝不在 MacBook 上运行 Himawari 测试。” “MacBook 只用于编辑、审查和提交；发现那里有这类进程在运行时要停止它。”

**P23. 按量付费只用低价模型，代码不得写死 `anthropic/`、`openai/` 开头的模型名。**
来源：`.claude/rules/owner-standing-rules.md:18`
原话：“按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。代码和评测脚本里不得写死 `anthropic/`、`openai/` 开头的模型名。”

**P24. 界面上的数字和判断词要有可验证定义，功能要有正向和反向验收。**
来源：`.claude/rules/owner-standing-rules.md:33-34`
原话：“界面上给 Andy 看的每个数字和判断词……都要有可以验证的定义和门槛”；“反向验收是给一个不该命中、不该触发的输入，期望结果为空或不触发。”

**P25. I-73 的教训：只检查改动本身不够，要检查“清单里的 id 能不能通过后端校验”。**
来源：`docs/incidents-and-gates.md:112`
原话：“双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’。”

**P26. 规则是硬性设定，不是记忆。**
来源：`AGENTS.md:17`
原话：“Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试。”

**P27. “不许写死能动态获取的值”是本次任务约束。**
来源：本次材料·约束。仓库里未找到完全对应的原文；不把它当作仓库规则引用，只作为方案约束。

---

# 二、方案

## 2.1 一句话方案

**iOS 原生 App = Himawari 的感官、在场和手；服务器 = 唯一的大脑、记忆权威、规则和决策记录。** App 做六类能力，加一层系统底座：

1. **在场**：随叫随到的对话与系统入口。
2. **环境感知**：用户发起的“在场会话”，端侧预处理，事件级上传。
3. **情境信号**：位置、运动、日历、联系人、健康、照片。
4. **时机与投递**：锁屏通知、可操作通知、Live Activity、Widget、Focus。
5. **行动与验证**：在手机上批准、查看任务、核实结果、把外部输入送进 Himawari。
6. **主权与信任**：同意、感知账本、记忆收件箱、原话回看、删除/导出、决策解释。
7. **底座**：身份、Keychain、APNs、离线队列、加密、可观测性、构建与分发。

这里的“能力全貌”不是功能清单，而是按**Agent 的身体部位**分类。每一类都必须加深四样护城河之一：记忆图谱、规则手册、长尾工具库、决策记录；否则不做。

## 2.2 六类能力与愿景的对应

| 能力类别 | 具体形态（类别级，不按单个功能） | 服务的原则 | Jarvis Test | 让哪个指标变好 | iOS 实际能做到什么程度 |
|---|---|---|---|---|---|
| **A. 在场与随叫随到** | 按住说话/流式语音对话、Siri/App Intents、Action Button、控制中心、分享扩展、锁屏小组件、实时活动、离线草稿 | 原则 5“一个 Agent，所有表面”；原则 6“感知、执行、验证” | #2 跨表面连续性；#7 不在场推进；#11 决策可解释 | 每周需要我介入的分钟数；任务完成验证率 | 前台语音、端侧转写、TTS、App Intents 可用；Live Activity 必须前台发起；Siri 自由对话未核实 |
| **B. 环境感知** | 用户发起的“在场会话”；端侧 VAD、转写、说话人识别、媒体播放检测、去标识；事件级上传 | 特征 2“在环境里”；原则 3“记忆即产品”；原则 6 | #3 主动拦截；#9 遗忘与纠正传播；#10 打扰与门槛校准 | 记忆回忆准确率；主动提醒命中率/误扰率；记忆纠正一次生效率 | 前台开始录音后可后台继续，橙色胶囊；长期存活无保证；说话人识别未核实；重启后不自动开麦 |
| **C. 情境信号** | 语义地点（到家/到公司/到健身房）、运动类型（骑行/步行/跑步/开车）、日历、联系人、健康、照片/相机 | 原则 3；原则 4 | #3；#10 | 命中率/误扰率；记忆回忆准确率 | 显著位置变化、CLMonitor/CLServiceSession、CMMotionActivity、EventKit、Contacts、HealthKit；全部要授权，且受后台刷新限制 |
| **D. 时机与投递** | APNs 通知、可操作通知、Live Activity、Widget、Focus、静默/摘要/提醒/打断分级 | 原则 4“预判收益 > 打扰成本”；原则 2“行动有边界” | #3；#7；#10；#11 | 命中率/误扰率/已审漏报率；每周介入分钟数；决策可解释率 | 通知与实时活动可用；后台静默推送低优先级、限流、不保证；锁屏正文可做隐私取舍 |
| **E. 行动与验证** | 在手机上批准/拒绝、查看任务进度、核实结果、分享内容、拍照/扫描、Siri 触发例程 | 原则 2；原则 6 | #5 权限不扩大；#6 状态判断纪律；#8 失败透明 | 任务完成验证率；单位任务成本与延迟 | 手机只做批准与观察；执行在服务器；高风险操作要 LocalAuthentication；不在手机上跑工具 |
| **F. 主权与信任** | 同意管理、感知账本、记忆收件箱、原话回放、删除/导出、决策解释 | 原则 1“主权与忠诚”；原则 3 | #9；#11；#12 可携带 | 决策可解释率；记忆纠正一次生效率 | Keychain/Data Protection、端侧音频、服务器文本、Files 导出；不是本地优先 |
| **G. 校准** | 一键评价“有用/打扰/漏报”、决策记录、每周曲线 | 原则 4；#10 | #10 | 命中率/误扰率/已审漏报率（附样本量） | 通知动作、App 内评价；没有定义的数不显示 |

### A. 在场：让主人“不打字也能用”

- **语音对话**：按一下说话，端侧转写，文字进入当前 Thread，和打字是同一条消息、同一份记忆。这样 #2 跨表面连续性成立：在网页开始的任务，手机上接着做，不复制上下文。
- **系统入口**：App Intents 把“问 Himawari”“记一下”“提醒我”“今天怎么样”接到 Siri、Shortcuts、Spotlight、Action Button、控制中心和 Widget。
- **分享与相机**：分享扩展把链接、文本、图片、PDF 送进 Himawari；相机/相册用于拍收据、票据、白板，先端侧 OCR，再决定上传什么。
- **实时状态**：Live Activity 显示“Himawari 正在处理”“明天游泳判断已出”“有一条待确认记忆”，但**只在用户发起或服务器事件后显示**，不做常驻广告牌。
- **离线**：只排队“主人的输入”和“待上传的观察”，不在本地批准行动、不在本地创建任务。与 PRD “浏览器离线只保留草稿”一致。

### B. 环境感知：把“一直听着”改写成“可恢复的在场会话”

这是最重要、也最需要克制的部分。

**产品定义**：不是“后台常驻麦克风”，而是“主人在场时主动开启的一段感知会话”。会话有开始、有结束、有可见指示、有自动过期；系统杀掉后不假装还在听。

**端侧流水线**：
1. VAD 只留人声，前补 1 秒、静音 2 秒结束、不足 1 秒丢弃、单段最长 5 分钟（参考 TaoSheng 的好做法，不照抄它的安卓实现）。
2. 媒体播放检测：手机外放音乐/视频时跳过，避免把电视里的“我喜欢骑车”记成主人。
3. 端侧转写（SpeechAnalyzer/SpeechTranscriber，iOS 26+；低版本退化到 SFSpeechRecognizer 或只做 VAD）。
4. 说话人识别：先做“主人声纹登记”，把片段分成 `owner / knownPerson / unknown / media`；识别不确定时降低置信度，**不确定的片段不能当主人原话**。iOS 上说话人识别/声纹的实际可用性未核实；sherpa-onnx 的 iOS 可用性也未核实。
5. 端侧事件抽取：在支持 Apple Intelligence 的设备上，用 Foundation Models 把一段对话压成“事件摘要 + 候选待办/提醒/偏好”，并做去标识；不支持时，只上传主人片段和抽取式摘要，或跳过对话模式。
6. 默认上传内容：**主人自己的话 + 端侧事件摘要**；默认不上传旁人逐字稿、不上传原始音频、不上传通讯录全量。需要完整对话时，作为显式选项，加密上传，单独保留期限。

**为什么这样设计**：
- Andy 的例子“同学说要不要周末吃饭”，不需要把同学的逐字稿上传到模型；端侧摘要“朋友提议周末一起吃饭，主人答应”就够了。这样既满足产品目标，又把旁人数据留在手机上。
- “我喜欢骑公路车”必须来自主人自己的片段，并且逐字引用；旁人的话不能当主人的偏好证据。
- 如果端侧摘要不可用，对话模式退化为“只记主人自己的话”；不会为了功能而把旁人音频传到第三方。

**iOS 的真实边界**：
- 后台音频只能从前台开始的会话继续；系统显示橙色胶囊；苹果论坛说可以持续，但 2026 年有 30–50 秒被系统杀掉的报告，**不能承诺“一直听着”**。
- 打断恢复要在 `.ended` 检查 `shouldResume` 再恢复（<https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions>）；后台能否可靠恢复未核实。
- 重启后不自动开麦；被用户强杀后也不自动恢复。App 要显示“感知已停止，点此恢复”，而不是假装还在听。
- 如果主人要真正的“永远在听”，iOS 不是合适的硬件；那时应讨论专用挂坠/硬件，而不是把手机伪装成常驻麦克风。

### C. 情境信号：不追求“全量位置”，追求“语义地点和运动”

- **位置**：用显著位置变化、`CLMonitor`、`CLServiceSession`、`CLBackgroundActivitySession`、区域/访问事件，不做持续 GPS。只上传“到家/到公司/到健身房/离开某地”这类语义事件，不上传原始坐标轨迹。用户关掉后台刷新时，感知会停，App 要如实显示。
- **运动**：`CMMotionActivityManager`、`CMPedometer` 识别骑行、步行、跑步、开车；这直接服务“我喜欢骑公路车”这类记忆和“现在在骑车吗”的情境判断。权限是 Motion & Fitness。
- **日历/联系人**：EventKit 读日历，Contacts 做本机匹配；不上传整本通讯录，只上传主人明确相关的人。日历事件里的参与人、地点、时间可以进入“情境摘要”，但敏感事件仍按现有分级和审批。
- **健康**：HealthKit 的锻炼、睡眠、心率，opt-in；后台交付不保证实时。它服务“每周至少一次长有氧”这类目标和游泳判断。
- **照片/相机**：PHPicker、VisionKit、AVFoundation；用户发起，先端侧 OCR/分类，再决定上传文本还是图片。

### D. 时机与投递：让“开口”发生在对的地方

- **服务器决定是否开口、何时开口、以什么级别开口**；手机只负责送达和收集反馈。
- **APNs**：只发不透明引用或最小正文；App 收到后用已认证的 HTTPS 从主服务器取内容；需要锁屏正文时，用 Notification Service Extension 取回并用设备密钥解密。不要把完整记忆正文交给 APNs。
- **可操作通知**：锁屏上可以“确认记忆”“稍后”“不是这样”“有用/打扰/漏报”；高风险批准要解锁 + LocalAuthentication。
- **Live Activity / Widget / Focus**：显示“正在处理”“待确认”“今日简报”，并和 Focus/勿扰联动；安静时段、每日上限由服务器执行。
- **校准闭环**：每一次开口和沉默都进决策记录；主人在通知上点一下评价，就回写 `ownerRating`。没有样本量的命中率/误扰率不显示。

### E. 行动与验证：手机是批准器和观察窗，不是执行器

- 任务执行、工具调用、模型路由都在服务器；App 不在本地跑工具、不持有模型密钥。
- App 负责：批准/拒绝、查看任务步骤和失败原因、核实结果、把外部输入（分享、相机、语音）送回服务器。
- 高风险操作（钱、不可逆删除、公开发布、凭据、生产）仍然逐次确认，且要解锁；不能因为“在手机上点了一下”就降低风险。
- 失败时显示“失败在哪一步、已完成什么、还剩什么”，不把未验证说成完成（#8）。

### F. 主权与信任：感知越强，这个表面越重要

- **同意管理**：首次安装的解释、每次会话的明确开始、橙色胶囊、App 内持续状态、可随时停止；按地点/时间段设置“允许开启”，但自动开始只能通过用户点通知/快捷指令，不能后台偷开。
- **感知账本**：这次会话录了什么、上传了什么、生成了什么记忆/提醒、用了哪个模型、花了多少、删了什么。每一项可点开。
- **记忆收件箱**：待确认记忆/提醒，显示原话、说话人、置信度、来源会话；可以接受、编辑、拒绝、删除。
- **原话回看**：如果音频还在本机，可以播放那一段；跨设备只显示文本和“本机音频已删除”。这比伪造“原话”诚实。
- **删除传播**：删除一次会话，删除本机音频、服务器观察文本、由它推导出的记忆/提醒/索引；决策记录保留不含正文的墓碑。删除一条记忆，走现有纠正传播；如果它来自某次感知，提供“同时删除来源会话”的选项。
- **导出**：通过 Files/分享导出记忆、规则、决策记录；敏感/受限内容按现有导出规则处理。

## 2.3 手机端和服务器端怎样分工

**手机端（感官与手）**
- 采集：麦克风、位置、运动、日历、联系人、健康、相机、分享。
- 端侧处理：VAD、转写、说话人、媒体检测、去标识、事件摘要。
- 本地证据：加密保存原始音频/声纹，默认只在本机，按期限删除。
- 同意与指示：开始时明确同意、橙色胶囊、状态、停止、删除。
- 传输：幂等上传，离线队列；只传观察包，不传模型密钥。
- 展示：对话、通知、实时活动、记忆收件箱、决策解释、任务状态。

**服务器端（大脑与权威）**
- 接收观察包，写观察存储；服务器时间只做接收记录，不进入模型可见文本。
- 运行后台侧调用：事件抽取、记忆抽取、感知检查；固定指令在前，数据在后。
- 写记忆、待确认项、提醒候选、决策记录；执行纠正传播和删除。
- 主动检查：现有 Gmail 检查照旧；新增“感知检查”侧调用读最近观察摘要和记忆，输出 `act/know/check/ignore`。
- 推送：注意力预算、安静时段、每日上限、APNs 发送。
- 执行：工具、任务、外部行动；手机只批准和观察。

**数据流（目标态）**

```text
iPhone 感知会话
  → 端侧 VAD/转写/说话人/媒体检测/去标识/事件摘要
  → ObservationEnvelope（文本、说话人、时间、地点语义、同意范围、来源 ID）
  → 主人服务器 /observations（幂等、鉴权、加密存储）
  → 后台侧调用1：事件抽取（固定指令 + 观察数据）
  → 后台侧调用2：记忆抽取（固定指令 + 主人原话片段 + 已有记忆）
  → 后台侧调用3：感知检查（固定指令 + 最近观察摘要 + 相关记忆 + 规则）
  → 记忆/待确认项/提醒候选/主动决策
  → 决策记录（含 observationId、segmentId、quote、模型、提示词版本、成本）
  → 通知/收件箱/记忆页/每周曲线
```

**感知进入现有系统的三条通道**
1. **记忆通道**：主人原话 → 新的环境记忆抽取入口 → 待确认记忆 → 主人确认/在聊天里重复 → 正式记忆。正式记忆能被模型看到（ADR 0193），并带 `sourceRefs`/观察来源。
2. **行动通道**：事件摘要 + 主人答应 → “待确认提醒/待办”收件箱项 → 主人确认 → 真正的提醒/任务。**不要**把待确认记忆直接挂提醒，因为 ADR 0179 明确待确认记忆不登记提醒。
3. **主动通道**：现有 Gmail 检查会召回环境记忆；新增感知检查侧调用读最近观察摘要，按同一套注意力预算决定开口/沉默，写决策记录。第一阶段**不要**急着把 `ProactiveSource` 从 `"gmail"` 扩成多值；那会牵动网关契约、SQLite、导出 schema、界面文案和测试。先用独立的感知收件箱/决策类型，等价值验证后再统一。

## 2.4 可靠、可解释、可删除

**可靠**
- 客户端生成 `observationId`，上传幂等；服务器按 ID 去重，重复上传不重复记忆。
- 一次转写、存一次、永不重转；纠正作为新记录，不改旧观察。
- 观察包分块：现有记忆抽取单条消息有 6000 字符上限（`production-memory-capture.ts:49,193`），长会话必须按事件窗口切分，不能截断掉关键原话。
- 失败可见：转写失败、上传失败、模型失败、推送失败都显示“未处理/待重试”，不静默丢。
- 预算：每次会话/每天有模型调用和成本上限；超限排队并告诉主人，不无限调用。

**可解释**
- 每条记忆/提醒/主动开口都能回答：来自哪次观察、哪一段、谁说的、原话是什么、置信度多少、命中了哪条规则、用了哪个模型、提示词版本、成本、主人评价。
- 决策记录新增 `perception` 类型（或先用独立感知账本），记录采集决策、记忆决策、提醒决策、主动决策。
- 语音原话在本机可回放；跨设备至少能看到文本和来源会话。

**可删除**
- “删除这次会话”：本机音频、服务器观察文本、派生记忆/提醒/索引、相关缓存；决策记录保留无正文墓碑。
- “删除这条记忆”：走现有纠正传播；提供“同时删除来源会话”。
- “删除所有环境感知数据”：批量删除并验证搜索/索引为空。
- 不重写已经发出去的聊天历史；如果观察从未进入聊天线程（本方案默认如此），删除不会碰请求开头。
- 备份/恢复点按现有 PRD 的 30 天退出承诺处理。

## 2.5 哪些能力不该做，或不该放在 iOS 端

**不该做**
- 不做隐藏的常驻录音、不做自定义唤醒词、不承诺“一直在听”。iOS 不保证，法律也不允许偷偷录。
- 不把原始音频默认上传到服务器或第三方 ASR；不在第三方模型上跑环境音频。
- 不做“本地优先”或“手机是记忆权威”；手机只是感官和缓存。
- 不在手机上跑主模型、工具执行、模型路由、权限判断。
- 不把环境逐字稿塞进聊天历史；那会污染对话、破坏来源引用、还可能改变请求开头。
- 不为环境感知直接扩 `ProactiveSource` 而不改所有消费者；那是 I-73 的翻版。
- 不做持续 GPS 轨迹、不默认上传整本通讯录、不默认读全部健康数据。
- 不默认录旁人；不在要求所有人同意的司法辖区无同意录音。
- 不做 Android、不做 Watch 优先；Watch 是后置可选项。
- 不做完整 Web UI 复刻；复杂设置、导出、深度 Trace 可以继续用网页，但日常使用必须 App 内自足。
- 不用静默推送保证实时同步；不依赖后台 fetch 保证“随叫随到”。
- 不自动执行发消息、购买、发布、删除等不可逆动作。

## 2.6 依赖关系与建议建造顺序

这里的分期只为依赖和风险，不因为开发量缩水。

**P0 底座（所有能力的前提）**
- 身份：复用现有 Cloudflare Access/会话，App 用 `ASWebAuthenticationSession` 登录，Keychain 保存；设备绑定、远程撤销。
- APNs：设备 token 注册、服务器发送、通知权限、通知服务扩展、可操作通知。
- 对话与语音：按住说话、端侧转写、TTS、当前 Thread 连续。
- 分享扩展、相机/相册输入。
- 记忆收件箱、决策解释、删除/导出、感知账本的空壳。
- 构建与分发：Ad Hoc/TestFlight 内部；Xcode 构建；iOS 测试用 mock 后端。
- **规则冲突处理**：新增 ADR/修改 `test-and-production-hosts.md`，明确“iOS 客户端构建与 Swift/模拟器测试可以在 Mac 上跑；不得在 Mac 上跑 Himawari 服务端测试、集成测试或生产模型调用”。

**P1 观察与情境（低风险，先打通来源）**
- `ObservationEnvelope`、服务器接收、观察存储、来源引用、删除传播。
- 位置语义地点、运动类型、日历、联系人（只读、按需）、健康（opt-in）。
- 记忆来源的新 `provenanceKind`：支持“来源是观察”而不只是“来源是消息”；更新记忆页“跳到原话”的判定。
- 这一阶段不采环境音频，先把“来源、删除、可解释”跑通。

**P2 主人独白的在场模式（中等风险）**
- 用户发起的会话、橙色胶囊、端侧 VAD/转写、媒体检测、自动停止、重启不自动开麦。
- 只上传主人片段和端侧摘要；环境记忆默认待确认。
- 环境记忆抽取：原话逐字核对、短于 8 字不自动存、待确认不挂提醒。
- 决策记录：采集决策、记忆候选决策。

**P3 对话模式与旁人同意（高风险，法律前置）**
- 主人声纹登记、说话人识别；识别不确定不当主人原话。
- 旁人同意流程：每次会话明确确认、可见/可听提示、按司法辖区禁用、敏感场所自动暂停。
- 端侧事件摘要 + 待确认提醒/待办收件箱。
- 感知检查侧调用：最近观察摘要 + 相关记忆 + 规则 → 开口/沉默；先不扩 `ProactiveSource`。

**P4 时机与校准**
- 可操作通知、Live Activity、Widget、Focus、安静时段、每日上限。
- 一键评价回写决策记录；命中率/误扰率/已审漏报率曲线；没有样本量不显示。

**P5 行动与验证**
- 任务状态、失败原因、结果核实、审批、Siri 例程、分享/相机输入。
- 高风险 `LocalAuthentication`；权限不扩大（#5）。

**P6 可选**
- Apple Watch、专用硬件、Siri AI 深度整合、更多端侧模型。
- 只有在 iOS 的后台限制被证明不可接受时才讨论专用硬件，不把手机方案说成“永远在听”。

**依赖关系**
- P0 → P1 → P2 → P3 → P4/P5。
- P1 的情境信号可以与 P2 并行；P3 依赖法律政策、说话人识别和待确认收件箱；P4 依赖 P2/P3 的事件；P5 依赖 P0/P4。
- 记忆来源的 `provenanceKind`、删除传播、确定性渲染必须在 P2 之前完成，否则环境记忆会变成新的“来源不可查”。

---

# 三、考虑过但不选的做法及原因

1. **继续只做 PWA + Web Push + Siri 快捷指令。**
   不选。ADR 0089 第 66 条已经把“后台感知”列为重新评估原生 App 的条件；WebKit 的后台麦克风问题（材料给出的 WebKit Bug 236509）和后台传感器限制让它做不到愿景里的“在环境里”。可以作为降级路径保留，但不是目标态。

2. **做一层 WKWebView 套壳原生 App。**
   不选。拿不到后台音频、传感器、App Intents 的全部能力；审核上还容易被认为只是“repackaged website”（ADR 0082 背景里提到 4.2）。解决不了核心问题。

3. **后台常驻录音 + 原始音频上传服务器。**
   不选。电池、流量、隐私、法律风险都高；服务器无 GPU，第三方 ASR 又违反低价/数据自持；而且 iOS 不保证常驻。端侧处理 + 事件级上传更符合愿景。

4. **把环境逐字稿写进当前聊天 Thread。**
   不选。会污染对话、把旁人话当主人话、破坏记忆原话引用、还可能改变请求开头。环境感知应该是后台侧调用，不是聊天历史。

5. **把环境记忆直接自动存成正式记忆。**
   不选。ASR 会错、说话人会错、媒体会误判；默认待确认，主人确认或再次在聊天里说才转正。这是原则 3“记忆可靠性”优先于效率。

6. **把待确认记忆直接挂提醒。**
   不选。ADR 0179 明确待确认记忆不登记提醒；环境待办应走独立的“待确认提醒/待办”收件箱，确认后再创建。

7. **第一阶段就把 `ProactiveSource` 从 `"gmail"` 扩成 `"gmail" | "ios_ambient"`。**
   不选。它牵动 `proactive-checks.ts`、`contracts-v2.ts`、`sqlite-proactive-operations.ts`、`data-export/schemas.ts`、控制中心文案和测试；I-73 的教训就是“清单里的 id 能不能过后端校验”。先做独立感知收件箱，等价值验证后再统一。

8. **用 iCloud/CloudKit 同步记忆或音频。**
   不选。违反“自有优先、数据自持”；数据会落到第三方平台。服务器仍是唯一权威。

9. **自定义唤醒词“Hey Himawari”。**
   不选。iOS 后台限制、电池、误唤醒、隐私都吃亏；用用户发起的会话 + Siri/App Intents/Action Button 更诚实。

10. **在手机上跑主模型或完整 Agent 循环。**
    不选。模型质量、成本、设备支持都不合适；Himawari 的差异化在 harness，不在端侧模型。端侧模型只做预处理/去标识/摘要。

11. **先上 App Store。**
    不选。主人自己用，Ad Hoc/TestFlight 内部就够；App Store 要审核，2.5.4/2.5.14 会审查后台音频和录音提示；TestFlight 每 90 天要重传。等要分发给别人再走审核。

12. **为“永远在听”直接做专用硬件。**
    暂不选。可以作为 iOS 限制被证明不可接受后的备选；当前先用 iPhone + 可恢复会话，避免过早进入硬件、充电、佩戴和旁人观感问题。

---

# 四、风险与反例

1. **Andy 的“同学说周末吃饭”在默认“只记主人”模式下不会发生。**
   反例：主人在场，但没有开启对话模式，朋友的话被丢弃，Himawari 不会生成待办。这不是 bug，是隐私默认；要生成这类待办，必须开对话模式并确认旁人同意。

2. **“让手机一直听着”在重启/强杀/低电量/后台刷新关闭时不成立。**
   反例：手机夜里重启，早上没有感知；App 必须显示“未在听”，不能假装有数据。iOS 2026 年还有后台 30–50 秒被杀的论坛报告，不能承诺常驻。

3. **ASR 会把“公路车”听成“公交车”。**
   反例：嘈杂环境里，原话看起来逐字匹配，但其实是错字；如果自动存成正式记忆，之后所有主动判断都错。默认待确认 + 置信度 + 原话回放是必要的。

4. **说话人识别会把朋友的话当成主人说的。**
   反例：两个声音相近的人，朋友说“我喜欢骑车”，被记成主人的偏好。识别不确定时不能当主人原话；对话模式必须能人工纠正来源。

5. **电视/播客里的“我喜欢骑车”会被误记。**
   反例：手机外放视频，VAD 认为是人声。需要媒体播放检测、音频路由判断、置信度门槛；TaoSheng 的“外放媒体时跳过”是必须学的，不是可选项。

6. **旁人隐私和司法辖区。**
   反例：主人在加州或中国开启对话模式，录到没有同意的旁人；这可能违反当地法律（具体条文未核实，方案按最保守处理）。必须按辖区禁用/要求确认同意；日本参与者录音的合法性也只有二手来源，未核实。

7. **把观察 ID 塞进 `sourceRefs` 会让“跳到原话”全部失效。**
   反例：`earliestSourceMessage` 先看 `sourceThreadId`，再用 `sourceRefs` 匹配消息；观察没有 thread message，每条环境记忆都会显示“来源已不可查”。必须先加 `provenanceKind`/`sourceObservationId` 并改记忆页。

8. **`sourceId` 有 128 字符上限。**
   反例：用长 base64 或把整段 JSON 塞进 ID，`machineString` 校验会拒绝（`packages/gateway-contracts/src/validation.ts:49-59`）。用短前缀 + UUID，并加契约测试。

9. **`knownPeople` 按 `updatedAt` 排序，会让同一段文字在不同请求里字节不同。**
   反例：`production-memory-capture.ts:794-797` 按 `updatedAt` 排序；联系人改名后，同一观察重新抽取，提示词顺序变了。环境侧调用要按稳定 ID 排序，不要按更新时间。

10. **待确认记忆不能挂提醒，环境待办会无处可去。**
    反例：朋友约饭，主人说“好呀”，只有 2 个字，达不到 8 字原话门槛；如果硬塞进记忆，会被原话校验拒绝；如果挂到待确认记忆的提醒，又违反 ADR 0179。必须新做“待确认提醒/待办”收件箱。

11. **新增 `ProactiveSource` 或 `decision.kind` 漏改导出 schema，数据导出会整份失败。**
    反例：`data-export/schemas.ts` 的 `enumOf(["gmail"])` 和决策类型枚举是硬校验；漏一处，导出/导入测试就炸。这正是 I-73 要防的。

12. **后台推送不保证送达。**
    反例：主人到家，服务器想推“明天游泳判断”，APNs 静默推送被限流；不能把“到达”当保证。用户可见的提醒用 alert push；同步用前台/后台 fetch + 本地状态补。

13. **删除不彻底，环境数据会“复活”。**
    反例：删了记忆，但观察文本还在，下一次抽取又生成同一条记忆；或者索引/缓存还在。删除必须级联到观察、索引、提醒和缓存，并留墓碑防复活。

14. **成本/电量失控。**
    反例：每 5 分钟一次模型抽取，深夜也在跑；或端侧 ASR 常驻耗电。需要按会话/按天预算、静音时段、低电量策略；具体数字要有定义，不能拍脑袋显示。

15. **把环境观察放进系统提示或工具定义。**
    反例：为了“让模型一直知道”，把最近观察写进系统提示；这会让每个对话的请求开头变化，违反只追加规则。必须放最后一条消息或后台侧调用。

---

# 五、需要 Andy 拍板的取舍

1. **环境感知默认模式**：默认“只记主人自己的话”，还是默认“对话模式”？
   我建议默认只记主人；对话模式每次显式开启并确认旁人同意；在要求所有人同意的辖区默认禁用。

2. **原始音频是否离开手机**：默认只在手机本地加密保存，还是加密上传到主人服务器以便跨设备回放？
   我建议默认只在本地；服务器只存文本、时间、来源和置信度。跨设备回放是可选加密上传。

3. **环境记忆是否允许高置信度自动转正**：全部先待确认，还是高置信度直接正式记忆？
   我建议全部先待确认，直到主人在记忆收件箱确认或在聊天里重复；ASR/说话人错误代价太高。

4. **主动检查是否第一阶段就统一来源**：先做独立“感知收件箱”，还是直接扩 `ProactiveSource`？
   我建议先独立；等感知数据证明有价值，再做统一迁移和完整消费者矩阵。

5. **APNs 正文策略**：锁屏只显示“你有一条消息”，还是显示解密后的摘要？
   我建议默认只显示不透明引用/最小标题，App 打开后取正文；需要锁屏摘要时用通知服务扩展解密。

6. **分发方式**：Ad Hoc/TestFlight 内部，还是直接 App Store？
   我建议 Ad Hoc/TestFlight；主人自己用不需要审核，也避免 TestFlight 90 天和审核风险。要给别人用再走 App Store。

7. **Mac 构建/测试规则例外**：是否修改“绝不在 MacBook 上运行 Himawari 测试”，允许 iOS 客户端 Xcode 构建、Swift 单元测试和模拟器 UI 测试？
   我建议改，但明确边界：只用 mock 后端，不跑服务端测试、不跑生产模型调用。若不愿改，备选是 Xcode Cloud 或专用 Mac mini，涉及花钱。

8. **最低设备/系统**：环境感知要求 iOS 26 + Apple Intelligence 设备，还是支持更老 iPhone 的降级模式？
   我建议 iOS 26 为完整体验，老设备降级为“只做 VAD + 主人手动输入/服务器文本抽取”，不承诺环境感知完整体验。

9. **每日成本/电量上限**：每次会话、每天模型调用和电量的上限是多少？超限是排队还是停止？
   我建议按天预算 + 超限排队并通知；具体阈值放 `packages/calibration`，不写死在代码里。

10. **观察文本/音频保留期限**：默认 7 天、30 天还是永久？
    我建议原始音频本机 7 天、观察文本 30 天、记忆按现有记忆保留规则；删除立即生效，备份 30 天内退出。需要 Andy 定。

---

# 六、读代码/来源证实的，和推测的

## 已证实

- 记忆只从 `user_message` 抽取：`production-memory-capture.ts:720`。
- 来源类型只有三种：`run-execution-source.ts:26`。
- 原话核对和待确认规则：`production-memory-capture.ts:130-138,348-361`；ADR 0179 决定 1、6。
- 待确认记忆不登记提醒/人物：ADR 0179:54。
- 主动检查只有 Gmail：`proactive-checks.ts:4`；网关、SQLite、导出 schema 都硬编码 `"gmail"`：`contracts-v2.ts:388,593`、`sqlite-proactive-operations.ts:28`、`data-export/schemas.ts:199,253,273`。
- 记忆“跳到原话”依赖 thread message + `sourceRefs`：ADR 0186:39、`production-memory-control.ts:112-124`、`memory-source.ts:23-25`。
- 请求的每轮上下文（时间、记忆块、主人消息）都在最后一条消息：`pi-runtime-adapter.ts:623-641`；记忆在 `contextBlocks`：`context-formation-service.ts:646-653`；触发内容在 `prompt`：同文件 `683-688`。
- `sourceId`/`payloadRef` 走 `machineString`，上限 128、字符集 `[A-Za-z0-9._:-]`：`gateway-contracts/src/contracts.ts:69-73`、`validation.ts:49-59`。
- 记忆 `sourceRefs` 单条上限 512：`contracts-v2.ts:20,1194`；导出 schema 里 `sourceType` 是 `text(1,512)`：`data-export/schemas.ts:113`。
- `knownPeople` 按 `updatedAt` 排序：`production-memory-capture.ts:794-797`。
- 记忆抽取单条消息上限 6000 字符：`production-memory-capture.ts:49,193`。
- 后台音频前台启动可继续、橙色胶囊：Apple 论坛 776949。
- 录音同意和明显提示：App Store 2.5.4/2.5.14。
- SpeechAnalyzer/SpeechTranscriber iOS 26、运行时查语言：Apple 文档。
- Foundation Models 需要 Apple Intelligence 设备：Apple 文档。
- 后台静默推送低优先级、限流、不保证：Apple 文档。
- 显著位置变化需要 Always 授权、后台刷新关闭就收不到：Apple 文档。
- Live Activity 前台发起、用户动作后使用：WWDC 讲义。
- App Intents 接 Siri/Shortcuts/Action Button 等：Apple 文档。
- MacBook 不得跑 Himawari 测试：`AGENTS.md:117`、`test-and-production-hosts.md:8`。

## 推测 / 未核实

- iOS 26 上 SpeechTranscriber 的中文、日文在 Andy 的真机上是否可用、质量如何。
- iOS 上说话人识别/声纹（含 sherpa-onnx CAM++）的实际可用性、功耗和准确率。
- Foundation Models 在 Andy 的 iPhone 型号和语言上是否可用；端侧事件摘要的质量。
- 后台音频在 Andy 的 iPhone/iOS 版本上能持续多久；打断后能否可靠恢复。
- Siri AI / 自由对话能开放到什么程度；App Intents 之外的 Siri 深度整合。
- APNs 实际到达率、通知服务扩展的取数/解密体验。
- Cloudflare Access 在原生 App 里的登录体验（`ASWebAuthenticationSession`）是否顺畅。
- 日本、加州、中国等具体法律条文的原文和适用；本方案按保守原则设计，不构成法律意见。
- 端侧 ASR/摘要的耗电、发热、模型下载体积。
- 环境感知带来的模型成本、每天能处理多少分钟对话。
- App Store 对“后台音频 + 环境感知”的具体审核尺度；Ad Hoc 不经过审核，但仍受开发者协议和法律约束。

---

# 七、逐条回答必答问题

## 必答问题 1：这个改动会不会改变模型已经见过的请求开头？

**结论：按本方案，不会。** 但前提是必须遵守下面四条；任何一条破了，就会改变。

1. **环境感知走后台侧调用，不写进聊天系统提示、工具定义和已有历史。**
   事件抽取、记忆抽取、感知检查都是独立侧调用：固定指令在前，本次观察数据在后，最后才是当前时间这类每次会变的值。依据 `.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后。”

2. **如果要把观察送进聊天，只能作为新一轮的最后一条消息。**
   现有实现里，每轮的时间、记忆块、主人消息都在 `turnPrompt` 的最后一条消息里，系统提示是分开的：`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`。记忆块来自 `contextBlocks`：`packages/application/src/services/context-formation-service.ts:646-653`；触发内容在 `prompt`：同文件 `683-688`。所以“观察摘要/相关记忆”放这里，只改最后一条消息，不改开头。

3. **每轮会变的值只在最后一条消息里。**
   包括：本次观察文本、`capturedAt`、语义地点、说话人标签、记忆召回结果、当前时间、工具状态。不得把设备 ID、时区、服务商名、额度、版本号、哈希写进系统提示或工具定义。依据 `.claude/rules/prompt-prefix.md:28`。

4. **不新增模型可见工具，或接受一次性换新。**
   如果新增一个“观察检索”工具，工具集合变了，按 ADR 0165/规则第 6 条，这个对话的请求头会换新一次，旧缓存从头重算。**本方案建议不新增工具**，用最后一轮的观察摘要；这样老对话的开头不变。若将来一定要加，只对新对话生效，并明确告诉 Andy 这次换新的代价。

**例外与边界**
- 改提示词目录文字：只对新对话生效；老对话冻结（`prompt-prefix.md:43`）。
- 一次性回填历史（例如把过去的环境记忆塞进老对话）：会改变开头；本方案不做。
- 删除/纠正记忆：只影响未来的召回（最后一条消息），不改已发历史；如果观察从未进入聊天线程，删除更不会碰请求开头。

**所以回答两问**：
- “发给模型的内容是不是仍然只在末尾追加？”——是。感知数据只作为新的侧调用输入，或作为新一轮最后一条消息；不改系统提示、工具定义、历史。
- “每轮会变的值是不是都在最后一条消息里？”——是。观察、时间、地点、记忆召回、当前状态都在最后一条消息；后台侧调用按“固定指令在前、数据在后”排列。

## 必答问题 2：这个改动会不会让同一段文字在不同请求里变成不同的字节？

**结论：默认不会，但有五个高风险点；不处理就会。**

会变的来源：
1. **重新转写同一段音频**：ASR 每次输出可能不同。规则：一次转写、存一次、永不重转；纠正作为新版本/新记录，不覆盖旧观察。
2. **时间字段**：`receivedAt`、服务器当前时间、相对时间（“5 分钟前”）每次渲染都变。规则：模型可见只用存储下来的 `capturedAt`（UTC 规范化为一次），不用 `receivedAt`/当前时间；相对时间一次算成绝对时间并存储。
3. **无序集合/数据库顺序**：记忆、人物、观察片段、候选列表都必须固定排序。现有代码里 `knownPeople` 按 `updatedAt` 排序（`production-memory-capture.ts:794-797`），联系人更新后同一观察的提示词字节会变；环境侧调用要按稳定 ID 排序。JSON 键顺序也要固定（`prompt-prefix.md:51`）。
4. **说话人标签/聚类 ID**：每次聚类生成的 `speaker-1/2` 可能不同。规则：用稳定的 `personId` 或本次会话内按首次出现顺序固定下来的标签；同一观察重渲染时不变。
5. **遮盖/同意撤回**：如果根据后文或后来的同意状态重新遮盖旧观察，同一段文字会变成不同字节。规则：遮盖只依赖当前观察和固定密钥/固定规则；删除/撤回不重写历史，只从未来上下文移除；同一观察的遮盖结果存储一次，后续复用。

**额外注意**
- `memoryCapturePrompt` 里的 `messageSentAt`、`ownerTimeZone`、`ownerMessage`（`production-memory-capture.ts:191-193`）是每次调用的数据；对同一观察必须用存储值，不能用“现在”。
- 模型输出本身（记忆候选文字）可能每次不同；这不是请求字节问题，但会造成重复记忆。用 `observationId + 候选键` 去重。
- 环境摘要如果依赖设备当前语言/时区，要在会话开始时固定，不随设备变化重算。

**回答**：只要做到“一次转写、存储值渲染、固定排序、固定遮盖、删除不改历史”，同一段文字在不同请求里就是同样的字节；否则会。方案里把这五条写成门槛。

## 必答问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

**有，而且反向用例必须真的失败。** 现有基础：
- `npm run check:prompt-prefix` 已经带反向用例：改写历史里的用户消息、系统提示带每轮变化的值、关掉冻结、请求中间出现 system 消息，检查必须报告失败（`.claude/rules/prompt-prefix.md:74`）。
- `npm run check:model-ref-contract` 是 I-73 的先例：清单生成出的每个引用都要过两个包的校验；去掉修复后 3 条失败。
- `npm run check:incident-gates` 拒绝“次数达到 3 却没有硬门槛”的条目。

**本方案要新增的门槛**
1. `check:observation-envelope`：观察包 schema 往返；未知 `speaker`/`consent` 枚举拒绝；缺同意拒绝；含原始音频拒绝；`sourceId`/`payloadRef` 长度和字符集通过 `machineString`；同一 `observationId` 重复上传只写一次。
2. `check:ambient-memory-quote`：主人原话能通过；旁人原话、跨片段拼接的原话、无原话、与原话无关的引用都必须失败。去掉“逐片段核对”或“主人片段过滤”后，反向用例必须失败。
3. `check:deterministic-render`：同一观察渲染两次字节相同；把 `receivedAt`、当前时间、按 `updatedAt` 排序、无序集合塞进去，测试必须失败。
4. `check:provenance`：观察来源的记忆能在记忆页显示“跳到原话/来源会话”；`sourceRefs` 里是观察 ID 而不是消息 ID 时，旧 `earliestSourceMessage` 不能误判；去掉 `provenanceKind` 后，页面必须显示“来源已不可查”，测试失败。
5. `check:deletion-propagation`：删除观察后，派生记忆、提醒、检索索引、缓存都不再返回；留墓碑；备份按 30 天规则。去掉级联后测试失败。
6. `check:perception-decision`：新增 `perception` 决策类型能被决策账本、导出 schema、界面文案、过滤器和指标接受；漏一个消费者就失败。这是 I-73 式的消费者矩阵。
7. `check:proactive-source`（如果最终扩 `ProactiveSource`）：生成所有来源值，逐一过 `proactive-checks.ts`、`contracts-v2.ts`、`sqlite-proactive-operations.ts`、`data-export/schemas.ts`、控制中心标签和测试；漏一个就失败。
8. **iOS 侧 XCUITest**：锁定屏幕/后台切换后橙色胶囊还在；媒体播放时跳过；静音自动停止；重启后不自动开麦；权限撤销后停止；离线队列去重；删除后本地音频和服务器文本都没了。
9. **真机验收**：正向——说“我最近喜欢骑公路车”出现带原话的待确认记忆；说“周末一起吃饭吧/好呀”出现待确认提醒。反向——电视播放同样的话不生成；旁人说的话不生成主人记忆；关掉麦克风权限不采集；删除会话后搜索不到。
10. **界面数字**：命中率、误扰率、已审漏报率、记忆纠正一次生效率都必须有定义、样本量和反向用例；没有定义不显示（`owner-stending-rules.md:33-34`）。

**反向用例是否真的会失败？**
要逐条证明：去掉修复后测试失败，恢复后通过。例如：
- 去掉 `sourceId` 的命名空间检查 → Gmail 的 `external_event` 也会进入环境记忆抽取，测试失败。
- 去掉“逐片段原话核对” → 跨片段拼接的原话通过，测试失败。
- 把 `knownPeople` 排序改回 `updatedAt` → 同一观察两次渲染字节不同，测试失败。
- 把 `receivedAt` 放进模型可见文本 → 两次渲染不同，测试失败。
- 漏改导出 schema 的 `perception`/`ios_ambient` → 导出/导入测试失败。
这些都要写进提交说明和事故门槛。

## 必答问题 4：改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能只看改动本身；要按 I-73 做“生产者 → 消费者矩阵”。** 本方案会碰到的值和消费者如下：

| 值 | 产生它的地方 | 使用它的地方 | 校验/风险 | 结论 |
|---|---|---|---|---|
| `sourceType` | 观察触发/侧调用 | `run-execution-source.ts:26`、`contracts.ts:68`、`context-formation-service.ts:48,784-786`、`context-projection-service.ts:734-736`、`sqlite-thread-operations.ts:1582` | 现有枚举只有 `user_message/schedule/external_event`；**不要新增第四种**，复用 `external_event` 或走侧调用 | 复用则全部接受；新增则要改 17 处，不做 |
| `sourceId` | 客户端观察 ID | `contracts.ts:69` 的 `machineString`；触发器/SQLite；导出 `sourceType` 字段 `text(1,512)`；决策记录 `inputs` | 上限 128、字符集 `[A-Za-z0-9._:-]`；用 `ios.observation.<uuid>`，长度约 50 | 可接受，但要加契约测试 |
| `payloadRef` / `sourceProofRef` | 客户端/服务器 | `contracts.ts:72-73` 的 `machineString` | 上限 128；用短前缀 + UUID | 可接受 |
| `observationId` | 客户端 | 观察存储、记忆 `sourceRefs`、决策记录、导出 | 记忆 `sourceRefs` 单条上限 512（`contracts-v2.ts:20`）；导出 `text(1,256)` 的地方要看 | 用 UUID；导出前确认长度 |
| `speaker` 枚举 | 端侧/服务器 | 服务器观察 schema、记忆抽取、界面、导出 | 未知枚举必须拒绝；`owner` 才可当原话 | 新值，要全链路测试 |
| `consent.mode` | App | 服务器接收、法律策略、界面、决策记录、导出 | `owner_only/dialogue`；缺同意拒绝 | 新值，要全链路测试 |
| `ProactiveSource` 新值（若选） | 主动检查 | `proactive-checks.ts:4`、`contracts-v2.ts:388,593`、`sqlite-proactive-operations.ts:28`、`data-export/schemas.ts:199,253,273`、控制中心文案/i18n、测试 | 漏一处就 I-73；导出会整份失败 | **第一阶段不扩**；要扩就做完整矩阵 |
| `decision.kind = perception`（若选） | 感知决策 | `data-export/schemas.ts:190-198` 枚举、决策账本 UI/i18n、过滤器、指标、测试 | 漏导出 schema 会失败 | 要么复用现有 kind，要么完整加 |
| 记忆来源 `provenanceKind` / `sourceObservationId` | 环境记忆 | 网关记忆快照、`production-memory-control.ts:112-124`、`memory-source.ts:23-25`、`memory-page.tsx:529-541`、导出 schema、ADR 0186 跳转 | 旧逻辑假设 `sourceRefs` 是 thread message 的 `contentRef`；不改会全部“来源已不可查” | **必须加**，这是本方案的关键值 |
| `placeId` | 端侧语义地点 | 观察存储、记忆、界面、导出 | 只传语义 ID，不传原始坐标；未知地点拒绝或显示“未命名地点” | 可接受，需地点注册表 |
| 提示词版本 `perception.*:v1` | 服务器 | 决策记录、审计、模型调用 | 不得写死模型名；模型引用走动态清单 | 可接受 |
| 阈值（置信度、每日上限、保留期限） | 校准包 | 端侧/服务器/界面 | 不写死在代码；放 `packages/calibration/src/thresholds.ts`，有定义和反向验收 | 可接受 |

**本方案已经发现的具体 I-73 式风险**
- `sourceRefs` 被 `production-memory-control.ts:112-124` 当成“来源对话里的消息内容引用”；观察 ID 进去会匹配不到，记忆页全部“来源已不可查”。必须加 `provenanceKind`，不能只改写入端。
- `ProactiveSource` 在端口、网关契约、SQLite、导出 schema、界面文案五处硬编码；只改端口会让导出/界面失败。
- `decision.kind` 在导出 schema 里是枚举；新增类型不改导出，导出会整份拒绝。
- `sourceId` 是 `machineString` 128 上限；长 ID 会在触发器准入被拒，不是“看起来能存就能用”。
- `knownPeople` 的 `updatedAt` 排序会让同一段文字字节变化；这不是消费者问题，但属于确定性门槛。
- 待确认记忆不登记提醒（ADR 0179），所以环境待办不能复用现有“记忆 + reminder”路径；否则会出现“界面显示有提醒、实际不触发”的两端不一致。

**结论**：每一个新值都要有“生产者 → 消费者”清单和契约测试；尤其是 `sourceRefs`/`provenanceKind`、`ProactiveSource`、`decision.kind`、导出 schema、`sourceId` 长度。只跑改动本身的单测不算完成。
