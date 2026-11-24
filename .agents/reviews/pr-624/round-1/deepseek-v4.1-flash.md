### 1、中、`handover` 多数字段在 README 指认的第 4 版源文件里找不到对应画面

文件：`docs/assets/apple-clients/2026-11-25-v4/README.md:43`、`tokens.json:250-269`、`source/canvas.json:47-53`、`source/NextSenses.dc.html:397-400`

问题：README 说“`handover`（分享过来的）……这一版还用得上的值补回来”，但第 4 版 `canvas.json` 里这项只有“7 让她感知：位置、日程、健康、相册、分享过来的”，`NextSenses.dc.html` 最后一屏也只有“从别的 App 分享过来”的底部面板。该面板能对上 `buttonFontSize`/`cardPadding`/`closeIcon`/`fieldMinHeight`/`fieldPadding`/`fieldRadius`/`noteInset`/`sheetGap`；但 `heroGap`、`heroIcon`、`heroTitleSize`、`heroTop`、`doneIcon`、`outcomeGap`、`pageGap`、`popupFieldMinHeight`、`stepsGap`、`stepsPadding` 在该文件里没有对应画面或数值（我搜 `steps/outcome/hero/做完了/已交给` 未命中；唯一 `84px` 是画板宽度 `2584px`）。这违反本次约束“数值必须能在 v4 的 `source/*.dc.html` 里找到；原型没画的写明由设计线程定”。

证据（读代码证实）：`NextSenses.dc.html:400` 的分享面板只有 `padding: 14px 16px`、`min-height: 96px`、`border-radius: 22px`、`padding: 14px 16px`、`gap: 18px`、`font-size: 17px` 等；没有 hero/steps/outcome 结构。`canvas.json:49` 标题只写“分享过来的”。`tokens.json:250-269` 却收了整套第 2 版 `handover`。

建议：给这些没有第 4 版依据的字段标注“沿用第 2 版”或“由设计线程定”，并只把能对上分享面板的字段说成“按第 4 版”；否则应补第 4 版源文件依据。`icon.todayRow`、`size.pillSmall`、`type.rowAction` 也只能证明与第 2 版相同，未在第 4 版 `source/` 中逐项找到，建议同样注明。

### 2、中、新增的 `chat`/`her` 不会进入生成的 Swift 常量，README 和提交标题说法过度

文件：`clients/apple/scripts/make-design-tokens.mjs:93-105`、`clients/apple/Sources/HimawariDesign/Generated/DesignTokens.swift:182,196`、`tokens.json:270-320`、`README.md:15`

问题：`generate()` 只处理 `glass`、`radius`、`size`、`icon`、`processRow`、`opacity`、`home`、`pairing`、`scanner`、`senses`、`handover`、`mac`、`watch`、`type`；没有 `chat`、`her`、`avatar`、`options`。本次新加的 30 多个 `chat` 值和 15 个 `her` 值会被静默忽略，生成的 `DesignTokens.swift` 里没有 `Chat`/`Her`，Swift 里也搜不到任何 `DesignTokens.Chat/Her/Avatar/Options`。因此 README 第 15 行“客户端的数值只从这里来”和提交标题“能直接生成 Swift 常量”只对一部分段成立；后续页面照 `tokens.json` 写会找不到常量。

证据（读代码证实）：`make-design-tokens.mjs:93-105` 的 `scalars(...)` 清单没有 Chat/Her/Avatar/Options；`DesignTokens.swift` 有 `Senses`、`Handover`、`Mac`、`Watch`，没有 `Chat`/`Her`。

建议：要么把 `chat`/`her` 接进生成器并加断言，要么在 README 明确写“这两段暂不进 Swift，等生成器支持”，不要把它们描述成已经可用的唯一数值来源。

### 3、中、`chat.headerFade` 与第 4 版主对话源不一致，并和旧 `size.fadeTop` 重复

文件：`tokens.json:272-273`、`tokens.json:92-93`、`source/NextChat.dc.html:78`、`source/NextChatMore.dc.html:130`、`README.md:41`

问题：第 4 版主对话（`01-chat`，`NextChat.dc.html`）顶上的渐隐是 `height: 186px`、`linear-gradient(to bottom, var(--bg) 156px, transparent)`；token 的 `chat.headerFade`/`headerFadeSolid` 收的是 `NextChatMore.dc.html` 其他状态的 `140`/`110`。同时 v4 还保留着来自 v2 的 `size.fadeTop=134`、`fadeTopSolid=102`，现在同一个“顶上渐隐”有三套值，README 没说明哪个键对应哪一屏。若实现按 `chat.headerFade` 做 `01-chat`，会和原型差 46 点。

证据（读代码证实）：`NextChat.dc.html:78` 原文 `height: 186px; background: linear-gradient(to bottom, var(--bg) 156px, transparent)`；`NextChatMore.dc.html:130` 原文 `height: 140px; background: linear-gradient(to bottom, var(--bg) 110px, transparent)`；`tokens.json` 同时有 `fadeTop: 134`、`fadeTopSolid: 102` 和 `headerFade: 140`、`headerFadeSolid: 110`。

建议：明确主对话和“其他状态”各自使用哪个键；删除或更新过时的 `size.fadeTop`/`fadeTopSolid`，并在 README 写清来源屏。

### 4、低、没有针对第 4 版 `tokens.json` 的自动检查，反向用例不会失败

文件：`clients/apple/scripts/check-design.mjs:20`、`test/tooling/apple-design-check.test.mjs:104-140`、`make-design-tokens.mjs:52-57`

问题：`TOKENS_SOURCE` 和测试夹具仍指向第 2 版；没有任何测试对第 4 版 `tokens.json` 调用 `generate`/`generateCss`。如果把 `successRing`、`highlight` 两句说明重新放回 `colorUse`（原先的报错来源），`npm run check` 仍只读第 2 版并通过。目标“能被 `make-design-tokens.mjs` 读通”目前只靠人手运行，没有门槛。

证据（读代码证实）：`check-design.mjs:20` 为 `export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";`；测试第 104-140 行创建并写入的仍是 `docs/assets/apple-clients/2026-11-12-v2/tokens.json`；`make-design-tokens.mjs:52-57` 的 `DESIGN_TOKEN_COLOR_USE_UNKNOWN` 没有任何 v4 用例覆盖。

建议：增加测试直接 `generate(JSON.parse(readFileSync(v4)))` 和 `generateCss(v4)`；再加反向用例：`colorUse` 放入非颜色名必须抛 `DESIGN_TOKEN_COLOR_USE_UNKNOWN`。若支持 `chat`/`her`，再断言对应常量确实生成。

### 5、低、引用/代码块“没画、由设计线程定”，却仍写死了数值

文件：`tokens.json:271,279-281`、`README.md:41`

问题：`chat.note` 说“引用和代码块原型没画，由设计线程定”，但 `quoteBar: 3`、`quoteGap: 10`、`codePadding: 12` 已作为确定值写入。这些值无法从第 4 版 source 找到（`NextChat`/`NextChatMore`/`NextSenses` 的 CSS 里没有 quote/code 规则），也没说明是“设计线程已定的初值”还是占位。与“原型没画的写明由设计线程定”的口径不一致。

建议：在 `tokens.json` 或 README 中注明这三个值是“设计线程定的初值（日期/出处）”，或先不要给数值、只留说明。

### 6、低、`avatar.wordmarkGap` 从 4 改成 3 不会影响任何代码

文件：`tokens.json:204`、`README.md:45`、`source/NextChat.dc.html:78`、`make-design-tokens.mjs:93-105`

问题：源文件确实写的是 `gap: 3px`（`NextChat.dc.html:78`，`NextChatMore.dc.html:131` 也是 `gap: 3px`），改正数值本身没错；但 `avatar` 整段不被生成器处理，Swift 里也没有读取 `wordmarkGap` 的地方（grep 只在 `tokens.json`/README 命中）。所以这次“改正”只改文档，不会让 App 的间距变成 3。

建议：README 写明“仅基线文档修正，代码要等 `avatar` 段进生成器/页面实现才生效”，避免误以为实现已修好。

### 7、推测、新增的计数字段若接入生成器会被当成 `CGFloat`

文件：`tokens.json:285,301-302`、`make-design-tokens.mjs:73-98`

问题：`attachTileColumns=3`、`talkBarsInInput=9`、`talkBarsOnTalkPage=13` 是“个数”而不是长度。现有 `scalars` 对 number 一律生成 `CGFloat`；将来把 `chat` 加进 `scalars`，这些值会变成 `CGFloat`，语义不对；若用于 `Array(repeating:count:)` 之类还需要 `Int`。

建议：接入时给这几个键单独的整数类型或分组，或在 README 标注它们是 count。

**侧重检查**

- 错误路径：按 `make-design-tokens.mjs` 的校验逐项推演 v4：`color.light`/`color.dark` 键集合相同，`colorUse` 的 `badge`/`streamingDot` 目标都存在，`shadow` 格式合法，`type` 新增项都是合法数组，`handover` 的两个 `[2]` 数组长度合法。静态推演不会抛错；但我不能运行 `node`，未实际执行。真正的问题是 `colorNotes`、`chat`、`her`、`note` 这些未知键会被静默忽略，写错也不会报错。
- 不合规范或不可信输入：`tokens.json` 是人工维护、没有 schema 校验；未知字段静默通过，值是否来自 v4 源文件也没有检查。
- 安全：这次只改文档素材，不涉及密钥、网络、命令执行或权限。
- 资源耗尽/不可撤销：没有运行时行为，改动可回滚。
- 规则、说明文档与代码一致：发现 README“唯一来源/能直接生成 Swift”与生成器实际支持的段不一致；README 的 `handover` 来源与第 4 版 source 不一致；改动没有对应自动检查；`wordmarkGap` 的修正没有代码消费方。
- 作者说法核对：`senses`、`handover` 与第 2 版逐字段相同——证实；`her` 全部数值与 `NextLists.dc.html:78` 对得上——证实；`chat` 只核实了 `headerFade` 来自 `NextChatMore`，其余因源文件行超长未逐项核实；`wordmarkGap` 源文件是 `gap: 3px`——证实；`colorUse` 报错原因——按代码逻辑证实，未运行。

**必答问题**

1. 不会影响模型已经见过的请求开头。这次 diff 只改 `docs/assets/apple-clients/2026-11-25-v4/` 下的 README 和 `tokens.json`；仓库里没有代码把这两个文件读进系统提示、工具定义、历史或遮盖流程，发给模型的请求仍是只追加，每轮会变的值仍在最后一条消息里。此结论基于仓库检索，未逐条审计所有请求组装代码。

2. 不会让同一段文字在不同请求里变成不同字节。`tokens.json` 是静态 JSON，生成器输出对颜色、尺寸等键使用 `sort()`，没有时间字段、无序集合或依赖前后文的遮盖；本次也没有改任何遮盖逻辑。

3. 这个改动没有对应的自动检查与反向用例。`check-design.mjs` 和测试都仍读第 2 版；即使 `colorUse` 重新出现非颜色名，CI 也不会在 v4 上失败。反向用例目前不会失败，因为根本没加载 v4。

4. 不是每个新值都有使用方接受。生成器能接受并已有人使用的：`size.pillSmall`（`Components.swift:70`、`TodayPage.swift:284`）、`icon.todayRow`（`Components.swift:135`、`DeviceActionViews.swift:92` 等）、`type.rowAction`/`senseTitle`/`senseTime`（`Components.swift:65`、`SenseItemScreen.swift:36`、`SenseDetailView.swift:243`）、`senses`/`handover`（`HimawariSenses`、`HimawariShare` 多处）；这些与第 2 版一致，生成器也处理得了。`colorUse` 的两个目标名合法，`colorNotes` 没有任何消费方。`chat`/`her`（以及既有的 `avatar`/`options`）没有生成常量、也没有使用点，所以这些值目前“能生成”不成立；`avatar.wordmarkGap` 的修正尤其没有任何代码读取。`chat`/`her` 里的 count 字段若接入现有 `scalars` 还会被当成 `CGFloat`（推测）。
