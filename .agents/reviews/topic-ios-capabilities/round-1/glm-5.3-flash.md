我先读愿景文档、规则文件和关键 ADR，弄清现状后再设计方案。
再核对两个跨端校验点：网关对 Host/Origin 的检查（原生 App 的请求和网页不同），以及 ADR 0186 的合成引用前缀在三处的一致性锁。
最后核对三个我要引用的苹果官方接口页面，确认名称和链接真实存在。
ASWebAuthenticationSession 的路径不对，换 AuthenticationServices 框架路径再试一次。
# iOS 原生 App 能力方案（独立设计稿）

## 一、方案依赖的前提

**产品与规则（仓库内，读代码/文档证实）**

1. 原则裁决顺序：「原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。」——`docs/product-vision.md:55`
2. Jarvis 特征 2：「在环境里，不在对话框里——它存在于实验室、住所、战甲之中，能感知现场、能直接动手，而不只是回答问题。」——`docs/product-vision.md:87`
3. 原生 App 的重新评估条件已被触发：「需要锁屏小组件、灵动岛、Siri 深度整合或后台感知这类网页做不到的能力」时重新评估；Andy 现在点名要环境感知，条件成立。——`docs/adr/0082-mobile-pwa-push-before-native-app.md:56`（superseded，但被 `0089:66` 第 7 条原样保留，仍是现行决定）
4. 记忆抽取只认主人打字：「`if (!source || source.sourceType !== "user_message" || source.threadId !== threadId) return;`」——`apps/agent-service/src/production-memory-capture.ts:720`
5. 待确认记忆机制已存在：低分候选带原话引用存为 tentative，只当线索；转正必须带主人原话并逐字核对。——`docs/adr/0179:54`（决定 1、6）
6. `sourceType` 枚举的消费点比想象多：`packages/gateway-contracts/src/contracts.ts:68`（`enumeration(["user_message","schedule","external_event"])`）、`packages/application/src/ports/run-execution-source.ts:26`、`packages/application/src/ports/context-projection.ts:15`、`packages/application/src/services/unified-trigger-ingestion-service.ts:13`、`packages/application/src/services/durable-background-work-service.ts:65`、`packages/application/src/services/context-formation-service.ts:48`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1582`（只有 `user_message` 和 `external_event` 会建对话线程）、加上 720 行的记忆抓取门。
7. 合成来源引用前缀在三处锁定：「`memory-content:reminder:`」写在 `apps/agent-service/src/production-reminder-writer.ts:188`（产生端）、`apps/control-center/src/memory-source.ts:3`（页面）、`test/integration/memory-source-report.test.ts:31`（一致性锁测试），并被 ADR 0186 第 6 条的条数分类依赖。
8. 网关对变更请求的边界断言：`assertMutationBoundary` 要求 Host 与 Origin 都等于 `publicOrigin` 且 `sec-fetch-site == same-origin`（`packages/platform-node/src/http-gateway-server.ts:257-261`）；会话创建另有同款检查（`identity-gateway.ts:951-955`）。
9. 记忆跳到原话的匹配条件：只匹配线程里 `role = owner`、已提交的消息；不在线程里的来源走「来源已不可查」等分类。——`docs/adr/0186:39-44`
10. 发给模型的内容：固定的在前、会变的在后；后台调用「先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值」；列表/JSON 顺序必须固定；遮盖必须确定。——`.claude/rules/prompt-prefix.md:27-28、51-52、67`
11. 规则是硬性设定不是记忆；不得把 Himawari 描述为本地优先。——`AGENTS.md:15-17`
12. 按量付费只用低价模型、不写死 `anthropic/`、`openai/` 模型名。——`.claude/rules/owner-standing-rules.md:18`
13. 界面数字要有可验证定义、要正向+反向验收。——`.claude/rules/owner-standing-rules.md:33-34`
14. 绝不在 MacBook 上运行 Himawari 测试。——`AGENTS.md:117`
15. 护城河之一是决策记录（主动性校准数据），账本已记录每次开口/沉默与主人评价。——`docs/product-vision.md:124`、`packages/application/src/ports/proactive-checks.ts:77-89`（`ProactiveDecision.ownerRating`）、`:17`（`ProactiveRating = "useful" | "unneeded" | "missed"`）

**iOS 能力边界（一手来源，本次或材料已核实）**

16. 网页应用后台即丢麦克风（WebKit Bug 236909）：<https://bugs.webkit.org/show_bug.cgi?id=236509>——环境感知在网页上做不到，只能原生。
17. 苹果技术支持 Quinn：「we allow apps that start an audio recording session in the foreground to continue recording indefinitely in the background. That's visible to the user as the orange pill in the status bar.」——<https://developer.apple.com/forums/thread/776949>。同帖 2026-01 有开发者报告后台约 30 秒后停、无苹果回复；**后台录音的可靠性未核实**。
18. 打断后恢复：苹果要求在 `AVAudioSession.interruptionNotification` 的 `.ended` 分支检查 `shouldResume`——<https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions>。
19. 端上长音频转写：iOS 26 SpeechAnalyzer / SpeechTranscriber（<https://developer.apple.com/videos/play/wwdc2025/277/>）；支持语言用 `SpeechTranscriber.supportedLocales` 运行时查（<https://developer.apple.com/documentation/speech/speechtranscriber>）。中文首发为第三方说法，**未在真机核实**。
20. App Store 审核指南 2.5.4（后台模式只能用于本来用途）、2.5.14（录音要明确同意、要有明显指示）：<https://developer.apple.com/app-store/review/guidelines/>。自装不经审核。
21. `ASWebAuthenticationSession` 存在（本次 fetch 核实：<https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession>）；App Intents（<https://developer.apple.com/documentation/appintents>，已核实）；`AVAudioSession.Category.playback` 存在（已核实）。APNs、WidgetKit、CoreLocation 的页面未逐个 fetch——**标未核实**，接口名取自常识，动工前须核对。
22. 开源参照 TaoSheng（MIT，安卓）：<https://github.com/0xCoach/TaoSheng>。只学做法：VAD 分段、行号引用、待确认条目、忽略回传归纳、媒体不提取。**照抄提示词不是需求。**

---

## 二、方案本身

一句话：**App 不是第二个 Himawari，是一双耳朵和一块表盘**。一切理解、记忆、决策仍在服务器那一个权威 Agent 上；App 只做三件事——感知（端上转写）、显示（推送/小组件/评价）、证明（每条记忆能跳回环境原话）。

### 能力全貌（按类别，对应愿景条目）

**A. 入口与连续性（第一批做）**
- App 外壳 + 登录：`ASWebAuthenticationSession` 打开 `himawari.siyi.win` 的 Cloudflare 验证码页，拿回会话；**不新增第二种登录门**（ADR 0089 决定 4 只有一道门，保持）。请求显式携带 `Origin` 头（见风险 3）。
- 同一对话页：App 内就是网页那套线程 UI 的原生版，接同一网关；任务/上下文跨表面连续（原则 5、Jarvis #2）。
- APNs 推送：注册设备、走 APNs 投递，与现有网页推送**共用同一套唯一来源键去重**（ADR 0089 决定 5 的「同一件事不重复推」扩展到两条通道）；锁屏显示规则沿用 0089 第 5 条（敏感记忆只显示「你有一条私密提醒」）。
- Siri / 快捷指令：App Intents 暴露「问 Himawari」「记一笔」，接服务器同一入口。
- 使指标变好：「每周需要我介入的分钟数」（介入点从打开网页变成点通知）；Jarvis #2。

**B. 环境感知（第二批，核心增量）**
- 端上：前台开录音会话常驻后台（橙点可见，符合 2.5.14）；音量门槛 + 端上 VAD 切段（学 TaoSheng：静音 2 秒结束、不足 1 秒丢弃、单段上限）；手机在放媒体（音乐/视频）时跳过（`AVAudioSession` 的其他输出与 `isOtherAudioPlaying` 可查）；端上 SpeechTranscriber 转写，**原始音频不落地不外发**，转写完即弃；设备上可选声纹只用于区分「主人/他人」，声纹模型和声纹数据永不离开手机。
- 端上转写语言：启动时用 `SpeechTranscriber.supportedLocales` 动态查，列出可选项让 Andy 选，**不写死语言清单**（符合「不许写死能动态获取的值」）。
- 上传：每段转写文字 + 归属（主人/他人/未知）+ 端上时间戳 + 幂等键，排队上传（后台受限时回前台补传或 APNs 唤醒）；网络失败本地队列重试。
- 服务器：分段存进新表（数据、不是对话消息）；新后台服务做抽取 side-call，产出候选走 **ADR 0179 的待确认记忆管线**：引用逐字核对到分段内归属为主人的行，存 tentative、带来源引用；不自动转正。
- 服务于：Jarvis 特征 2「能感知现场」；原则 3（记忆图谱多一个来源维度）；量化指标「主动提醒命中率」（主动检查可用 tentative 当线索，ADR 0179 已建好这个通路）；「决策可解释率」。

**C. 校准数据采集（随 A、B 一起做，不单独排期）**
- 通知上直接放「有用 / 不需要」按钮（UNUserNotificationCenter 的交互通知，接口名未核实），点击写回现有决策记录的 `ownerRating`（`proactive-checks.ts:87`）；环境感知产出的待确认记忆在 App 里显示「确认 / 忽略」，忽略的进 ADR 0179 已有的账本。
- 服务于：3.4.4 校准主权、Jarvis #10（命中率/误扰率有数据）、Jarvis #11。

**D. 可解释与可删除**
- 每条环境来源的记忆带合成引用 `memory-content:ambient:<segmentId>`；记忆详情新增类别「环境分段创建」，点击打开分段详情（不是线程消息，跳转目标改为分段页）。
- 分段可整批删除：删除一个时间段的环境分段 = 删分段数据 + 删由它推出的记忆（Jarvis #9 纠正传播已有机制）；设备上原始音频不留存。
- 服务于：用户主权（最高优先级）、Jarvis #9、#11。

**E. 现场信号（最后做，最谨慎）**
- CoreLocation「始终」授权，只上报离散事件（到宅/离家/到校），不上报轨迹；作为主动检查的时机输入（例：离家前才推「带伞」）。
- 先做事件后做时机判断，因为原则 4 要求「预判的收益必须大于打扰我的成本」，需要 C 类先攒出误扰率数据来校准。

### 手机/服务器分工

| | iPhone | 服务器 |
|---|---|---|
| 录音、VAD、转写、声纹归属 | 全部端上 | 无 |
| 分段存储、抽取、记忆、主动、决策记录 | 无 | 全部 |
| 推送投递 | APNs（新增通道） | 网页推送（现有）+ 投递循环 |

可靠性：分段幂等键 + 服务器去重（`unified-trigger-ingestion-service` 已有 `idempotencyKey`，复用）；设备本地队列断网不丢；抽取是后台 side-call，失败不影响对话。
可解释：候选必须带分段内行号引用（学 TaoSheng），对不上引用的丢弃记账本。
可删除：分段是服务器上主人数据的一部分，纳入「可完整迁移、备份与删除」（`product-vision.md:39`）。

---

## 三、考虑过但不选的做法

1. **扩 `RunExecutionSource.sourceType` 加 `"ios_ambient"`**：不选。该枚举有 8 处消费点（前提 6），其中 `sqlite-thread-operations.ts:1582` 决定建不建线程、`contracts.ts:68` 是硬校验——漏核一处就是 I-73 的复刻。环境分段不进对话线程，复用 `external_event`（它本来就是「外部适配器送来的事件」）+ 分段表内自有类型字段即可，枚举一字不动。
2. **让环境抽取复用 `production-memory-capture.ts` 的管线**：不选。720 行的门 `sourceType !== "user_message"` 正是「记忆只来自主人打字」的实现；给它加新分支会同时改主对话抽取的调用内容（`memory-capture:v5` 提示词），牵连主路径评测（ADR 0142）。另开独立后台服务，提示词独立、可单独评测。
3. **App 内做本地记忆库/端上小模型**：不选。违反「单一权威源」与「不得描述为本地优先」（`AGENTS.md:15`），也违反原则 7（进化要可审计——端上是盲区）。
4. **APNs 取代网页推送**：不选。网页推送对 Mac/其他浏览器仍有用；双通道共用来源键去重即可，删旧通道是一次「会删东西的上线」，无必要。
5. **旁人声纹上传服务器比对**：不选。原则 1「我的信息只在完成任务所必需的范围内被使用和披露」+ 旁人未同意；声纹只在端上用。
6. **通话录音（CallKit）**：不选。法律风险最高（多法域同意要求，材料已列），审核也最敏感，且 Andy 的场景是线下对话。
7. **一步到位做 Always-on 定位 + 健康数据**：放到 E 类最后。不是开发量考虑，而是原则序：没有 C 类的误扰率数据之前，位置触发的主动推送必然是「收益说不准、打扰确定有」。

---

## 四、风险和反例

1. **后台录音被打断后恢复不了**（Quinn 帖里 30 秒停的报告）：反例 = Andy 开会两小时，App 实际只录了前 30 秒，其他话全丢，且丢得无声无息。对策：App 内显示「本日有效监听时长」（数字要有定义：有转写产出的会话时长）；恢复按苹果文档在 `.ended` + `shouldResume` 处理；**未核实的部分动工前先在真机测**。
2. **旁人隐私与法域**：在日本，参与者自己录音一般不违法（二手来源，未核实）；加州刑法 632、中国民法典 1033 要求同意。对策：转写只在本机、只当线索、记录里对非主人发言默认不进记忆候选（只有归属为主人的行才作引用证据）；App 前台有录音指示、后台有橙点，满足 2.5.14。**这条是「花钱、法律和隐私」里唯一真可能一票否决的，需 Andy 拍板接受旁人风险后才能开 B 类。**
3. **网关边界断言会挡住原生 App**（本次读代码发现的最硬的跨端校验缺口）：`assertMutationBoundary` 要求 `sec-fetch-site == same-origin`，原生 URLSession 不发这个头，App 的所有变更请求都会被 4xx 拒掉，且报错形式会是「消息发不出去」级别（同 I-73 症状）。方案：App 显式带 `Origin` 与 `sec-fetch-site: same-origin` 头过现有断言，**网关代码不改**；但这是把 CSRF 边界的「浏览器才会发这些头」假设换成「客户端自证」，安全含义变弱了（任何持有会话的原生进程都能伪造），需要 Andy 拍板。反向核对的教训来自 I-73：双模型复核只看 diff、没问「清单里的 id 能过发送校验吗」——本方案的等价问题是「App 的请求能过 `assertPublicHost`/`assertMutationBoundary`/`assertSessionCreationOrigin` 三处吗」，答案是：不改就过不了。
4. **环境记忆虚增「来源已不可查」**：如果不给 ADR 0186 的分类逻辑加「环境分段创建」类，所有环境来源记忆会落入「来源已不可查」，把界面上的数字变成谎言（违反界面数字规则）。对策见门槛 [iOS-3]。
5. **双推送**：APNs 和网页推送同时在线时同一件事弹两次。对策：投递循环按唯一来源键判重，判重表里记录「哪些通道已投」，两个通道共用一张表。
6. **待确认记忆被当事实说出口**：环境来源的候选置信度天然更低（声纹归属是推断）。对策：环境候选的「原话证据」门槛加严——引用必须核对到**归属为主人**的行（他人行不作证据）；提示词固定说明沿用 ADR 0179 的 `tentative-note` 写法。

---

## 五、需要人拍板的取舍

1. **旁人录音的法律与隐私**：接受「在主人身边录到未同意的旁人」这个前提吗？接受的边界是什么（只端上处理？他人行永不入候选？）。
2. **网关边界头**：接受 App 显式携带 `Origin`/`sec-fetch-site` 头（网关不改）吗？还是要求出正式方案改网关为原生客户端开一条显式通道？
3. **「主人自己的原话」的定义扩展**：ADR 0179 决定 6 要求转正必须核对到「主人本次消息」里的原话。环境分段里**归属为主人的转写行**算不算？声纹归属有错认率，建议：算，但只有环境候选走这条定义，且永不自动转正、只有 App 里手动点「确认」才转正。这是对 ADR 0179 的一次正式修订，只有 Andy 能定。
4. **测试主机规则的边界**：「绝不在 MacBook 上运行 Himawari 测试」按字面覆盖 iOS App 的 XCTest，但 iOS App 物理上只能在 Mac 构建和测。建议：把规则改写为「Himawari 服务器端测试不在 MacBook 上跑；iOS 工程的构建与 XCTest 在 Mac 或 macOS CI runner 上跑，服务器集成测试照旧在云」。改的是 Andy 定的规则原文，只有他能批。
5. **B 类是否等 iOS 26 真机核实**（SpeechTranscriber 中文质量、后台录音恢复）再开工，还是先按「录音→端上转写失败则丢弃并计数」的降级版上线。

---

## 六、证实与推测分开

**读代码或来源证实的**：上面第一节的全部前提；网关三个断言的存在与内容（`http-gateway-server.ts:257-261`、`identity-gateway.ts:951-955`，实读）；`sourceType` 8 处消费点（grep 实读）；`memory-content:reminder:` 三处锁（grep 实读）；记忆抓取门 720 行（实读）；`ProactiveRating` 与 `ownerRating` 字段（实读）；App Intents、ASWebAuthenticationSession、`AVAudioSession.Category.playback` 页面（本次 fetch）。

**推测（动工前须核实）**：后台录音被打断后能否可靠恢复（Quinn 帖 2026-01 反例，未核实）；SpeechTranscriber 中文质量与设备覆盖（第三方说法）；sherpa-onnx 在 iOS 的实际可用（材料已标未核实，本方案主用系 API、sherpa-onnx 只是声纹备选）；APNs 交互通知与 WidgetKit 接口名（常识，页面未 fetch，标未核实）；TaoSheng 的分段参数（2 秒静音等）照搬到日语/中文环境的效果；声纹归属的错认率；风险 3 里「App 显式带头后安全等价」的论证需要复核。

---

## 七、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本方案对模型可见面的全部改动都是后台 side-call：环境分段抽取按规则 15 排列——固定的抽取指令在前、本批分段数据在中、当前时间在最后（`.claude/rules/prompt-prefix.md:67`）；不改系统提示、不改工具定义、不改任何已发历史。环境来源的记忆进入对话的唯一通路是现有的「本轮选中的记忆」注入位，它按规则 2（`:28`）本来就只在最后一条消息里（ADR 0104 已确立），每轮会变的值不进请求头。对话路径上唯一会被模型看到的新固定文字是待确认说明，而它只出现在工具返回值里（ADR 0179 决定 3 已核过这个性质），且没有待确认记忆时返回值逐字节不变——本方案沿用同一性质。发给模型的内容仍然只在末尾追加。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会，前提是落实三条：①分段送模型时按「startTime 然后 segmentId」固定排序，JSON 键序固定，不依赖数据库返回顺序（规则 10，`:51`）；②时间戳只出现在 side-call 的数据段尾部，不进指令；③转写文字是外来内容，照常过出口遮盖，遮盖是确定的（规则 11，`:52`）——同一段转写在不同请求里被遮成的字节相同，因为遮法只取决于它自己和它前面的内容，分段数据只在一次请求里出现，天然满足。声纹标记、设备 id、幂等键是标识符，不进提示。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有，四道，每道都写明反向用例（把守卫去掉时必须失败才算数）：
- [iOS-1] 分段抽取证据校验：候选引用必须逐字命中归属为主人的行（复用 `quoteFromOwnerMessage` 同款算法，`production-memory-capture.ts:130`）。反向用例：给一条引用对不上任何主人行的候选，断言被丢弃且账本记「原话未核实」；把校验短路后这条用例失败。
- [iOS-2] 分段上传幂等：同 `idempotencyKey` 重放只抽取一次。反向用例：重放同一分段，断言不产生第二条候选；去掉去重后失败。
- [iOS-3] 新合成引用前缀 `memory-content:ambient:` 的三处一致锁：仿 `memory-source-report.test.ts:31` 现有写法，锁定页面、脚本、写入端、ADR 0186 分类四处同值。反向用例：只改页面不改写入端，断言测试失败。
- [iOS-4] 推送去重：同一来源键经网页推送与 APNs 各投递一次的用例断言只送达一次；去掉共用判重表后失败。
- 另有现有门槛自动覆盖：`npm run check:prompt-prefix`（多轮前缀逐字节比对，本方案不动对话头，应保持全绿）；`check:glossary` 覆盖新界面词；界面数字（监听时长、条数）按 owner-standing-rules 要求附正向+反向验收。

**4. 改动产生或修改的每个值，两端核对了吗？**
逐个值列：
- `sourceType` 枚举：**不新增值**，复用 `external_event`。产生端：App 分段上传经 `unified-trigger-ingestion-service`（`idempotencyKey`、`sourceProofRef` 已有字段）。消费端：`sqlite-thread-operations.ts:1582` 会为 `external_event` 建线程——注意：环境分段**不该进对话线程**，所以它不走 trigger 准入建线程的路径，而是直接写分段表，`sourceType` 只用于运行来源记账；这个选择正是为了避免 `contracts.ts:68` 的 enumeration 校验和 8 处消费点连锁改动。
- `memory-content:ambient:` 前缀：产生端（新分段记忆 writer）、消费端（`memory-source.ts:3` 的页面分类、`memory-source-report.mjs` 脚本、ADR 0186 第 6 条条数定义）四处同改，[iOS-3] 锁定。不改则数字虚增「来源已不可查」。
- 抽取 side-call 的提示词：新目录条目，按 I-78 现状要登记进固定文字清单（`prompt-prefix.md:53`），否则会按外来内容被遮盖检查误伤。
- APNs 设备记录（token、设备语言）：产生端 App 注册端点；消费端投递循环 + ADR 0089 的唯一来源键判重表（[iOS-4]）。设备语言沿用 0089 第 5 条「按设备开启通知时的界面语言取固定文字」，不写死语言清单。
- 网关请求头（`Origin`、`sec-fetch-site`）：产生端 App HTTP 层；消费端 `http-gateway-server.ts:257-261` 与 `identity-gateway.ts:951-955` 两处断言。**不改代码时 App 必须同时满足这两处**，漏一处就会复刻 I-73「清单里的 id 过不了发送校验」的教训——本方案已把两处都核过。
- 「主人环境原话」的新定义（待确认转正证据来源扩展）：产生端分段抽取服务；消费端 ADR 0179 决定 6 的两道关（逐字核对 + 与记忆文字共享 token）。修订须经 Andy 拍板（第五节 3）。
