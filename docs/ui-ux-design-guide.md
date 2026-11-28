---
status: active
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "AGENTS.md, clients/apple/scripts/check-design.mjs, clients/apple/scripts/design-baseline.json, clients/apple/App/UITests/AccessibilityAuditTests.swift, clients/apple/App/UITests/accessibility-baseline.json, .github/workflows/apple.yml, assets/brand/himawari/v3/logo-sunflower-disc.svg, scripts/check-brand-assets.mjs, scripts/check-design-sources.mjs"
verified_at: "79412439"
---

# Himawari 苹果客户端设计规范

<a id="contents"></a>

这份文档管 iPhone、Apple Watch、Mac 三个 App 的界面和交互，记四样东西，供协调者和以后每个做界面设计的线程参考：

- **好的设计规范**：从下面两类例子里总结出的规则，改界面时照着做。
- **优秀设计**：Andy 批准过、而且明确说喜欢的设计。
- **不良设计**：做出来后被 Andy 指出、或被检查拦下的问题，写清原因和改法。
- **自动检查**：规范里已经变成程序检查的部分，每项写明用哪条命令或哪个作业来查，拦下什么问题；还要靠人看的部分也列在那里。

规则没写到的情况，照苹果当前版本的《Human Interface Guidelines》（苹果官方的界面设计规范，<https://developer.apple.com/design/human-interface-guidelines>）和下面的[总原则](#attention-first)判断（[Andy 定的长期规则](../.claude/rules/owner-standing-rules.md#apple-clients-follow-the-hig)）。网页已决定删除（[ADR 0309](adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md)），网页的设计和规则不是 App 设计的依据，也不拿来对照；它们的历史只在 git 里。`npm run check:design-sources` 拦下设计文档和规则里又把网页当依据的写法。

文档由 Andy 在 2026-10-29 提出：“任何我们遇到的 UI 和 UX 的问题，都记入到本项目的 UI UX 设计的‘不良设计’中，而把我们确定下来的、我很喜欢的设计记入本项目的‘优秀设计’中，并维护一个适合本项目的《好的设计规范》”。规则编号沿用原来的编号，网页那部分删掉后留下空号，别的文件按编号引用的仍然有效（例如“第 70 条”）。

**怎么用。** 改界面之前先读完[好的设计规范](#rules)。交付时，把这次遇到的新问题补进[不良设计](#bad)，把 Andy 新批准的设计补进[优秀设计](#good)；新问题如果能归纳成一条新规则，也补进规范，编号接着最大的往下排。批准的原型和截图在 `docs/assets/apple-clients/` 下。

目录：

1. [好的设计规范](#rules)
2. [优秀设计](#good)
3. [不良设计](#bad)
4. [自动检查](#gates)

<a id="rules"></a>

## 好的设计规范

每条规则后面括号里是它的出处：Andy 的原话、事故编号（见[事故与门槛清单](incidents-and-gates.md)）或 ADR（架构决策记录，记下一个长期决定和理由的文档）。

<a id="attention-first"></a>

### 总原则：主人的注意力最宝贵


**只在合适的地方，展示合适的、有必要的信息。** 主人的注意力很宝贵，页面上每多一样东西，都会从真正重要的信息那里分走一点注意力。判断一样东西要不要放上页面，不看它“对不对、有没有用”，只看“站在主人的角度，他此刻是不是足够需要它”。下面所有规则都从这一条来；规则没写到的情况，按这一条判断（2026-11-03，Andy：“设计 UI/UX 里面的设计原则就是：只在合适的地方，展示合适的、有必要的信息……用户的注意力是很宝贵的，不要用一些无关的信息去抢占用户的注意力”）。

做设计和交付原型前，对页面上的每一样东西过一遍：

- **他此刻要不要？** 不是主人下一步要用的，不放。
- **放在这里对不对？** 该在别处出现的，挪到它作用的地方旁边。
- **已经出现过了吗？** 同一个信息、同一句话、同一个日期只出现一次。
- **是说明还是内容？** 说明文字收进点开才看到的一层，默认不显示。
- **他能直接看懂吗？** 名字自己说清是关于什么的，不要他自己翻译。
- **他会被打扰吗？** 不抢眼的信息不用醒目的颜色、动画或常驻提示。

[↑ 返回目录](#contents)


<a id="apple-clients"></a>

### 苹果客户端

这一节管 iPhone、Apple Watch、Mac 上的 App。批准的原型和截图在 `docs/assets/apple-clients/` 下，说明在[详细设计的“界面照哪一版做”](execution/specs/2026-11-11-apple-device-body-design.md#ui-baseline)。

35. **动画只在表达状态时才动，并尊重系统“减弱动态效果”。** iPhone 聊天页顶部的小圆标志空闲时以回答时十分之一的速度慢慢长新种子（`SunflowerMark` 的 `idling`，和 ADR 0308 第 3 条首页大图的速度一致），Himawari 在回答时改为呼吸；其余地方的标志一律静止；系统开启“减弱动态效果”时，所有位置变化的动画都不启动（[ADR 0126](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0126-sunflower-mark-grows-233-seeds.md)、[ADR 0308](https://github.com/sixianli/himawari-agent/blob/1bc2b8886e7af7292d87642d057a78c8788860d7/docs/adr/0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md)）。
53. **App 的每一页都用原生界面做，按手机的用法重新设计，不把网页嵌进来，也不照搬网页的布局**（Andy 2026-11-12：“你不会要跟我说你是直接把网页迁移到 ios app 吧？”；[ADR 0247](adr/0247-apple-clients-are-fully-native-with-a-capability-table.md)）。
54. **iPhone、Apple Watch、Mac 三个 App 的图标一律是线条，不填色，不加底色块；每个图标用 SF Symbols 还是 Tabler 线条款，照 Andy 圈定的那一个。** Andy 2026-11-26 13:25 在新旧对照图上逐个圈选，原话：“图标这里，我用红框框出来的都是我想要的。页面这里可以用这种向日葵金色去描图标的线条，但是不要往里面填充颜色。我不喜欢视觉不一致的地方”。大多数用 SF Symbols；他圈了旧图标的用 Tabler Icons（MIT 许可的开源图标）线条款，线宽 1.6（60 点以上的大图标 1.3），和 SF Symbols 的常规粗细看起来一样粗。他圈的 SF Symbol 本身带实心部分的（沙漏、飞机、走路、照片）换成 Tabler 线条款。只有输入条右下角深色圆钮里的停止和暂停、小圆点用实心。颜色：“她的页面”和它下面各页的列表行，图标用向日葵金（`glyph`）描线，占一列固定宽度（`her.rowSymbolWidth`），各行文字左边对齐；对话里的过程行、输入条、附件面板，图标颜色跟旁边的字走，输入条右下角的实心圆钮（声波、发送、停止）和主按钮一样用文字色（`text`）做底、`onText` 做图标，浅色下是深底浅图标，深色下是浅底深图标（2026-11-28 在 GitHub 上跑出的真机模拟器截图里，深色下原来的近黑圆钮压在深色输入栏上几乎看不见）。大小随动态字体放大（`Icon` 里用 `@ScaledMetric`，最多放到 xxxLarge，免得撑破固定大小的圆钮）；小箭头、发送和关闭用半粗。服务端发来的过程行图标名（`activityIcon`）不变，由 App 换成对应图标，认不出的名字用 `puzzlepiece`。哪个名字用哪个 SF Symbol 写在 `clients/apple/Sources/HimawariDesign/Icon.swift` 的 `IconName.symbol`，哪些改用 Tabler 写在 `IconName.tabler`；Tabler 的图片由 `clients/apple/scripts/make-icons.mjs` 按 `clients/apple/scripts/icons.json` 生成。依据：Apple《Human Interface Guidelines》的 [SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)。
55. **导航和按钮是浮在内容上的一层玻璃，颜色用得少。** 顶上她的头像、返回钮、输入条都浮在内容上面，内容从下面滚过去；卡片不描边，靠浅灰底和柔和阴影分层，阴影只投在卡片的底形上，不投在卡片里的字和图标上（SwiftUI 的 `.shadow` 加在整张卡片上时会给里面每个字都描一圈影子，字发虚、无障碍审计判对比度不够；代码里用 `hmRaised`，`check-design.mjs` 的 `content-shadow` 规则拦下别的写法）；按钮是胶囊形，只有主按钮是实心的文字色；向日葵金只用在能点的字、带动作的选项、“要你同意”、“她的页面”列表行的线条图标（第 54 条）上（Andy 2026-11-12 要求按苹果现行的 iOS 设计规范做，“简洁、优雅、有设计感”；批准“可以，就按照最新版原型做”）。
56. **回答正文用衬线字：英文和数字是苹果系统自带的 New York，中文是随 App 打包的思源宋体（Noto Serif SC）；其他文字都用苹果的系统字，英文 SF Pro，中文苹方。** 2026-11-26 起曾改为全部用系统字、不用宋体（Andy 原话：“对话的字体换成苹果官方的字体”）。2026-11-27 Andy 发来 Claude App 的截图，问“主对话聊天的字体可以用图中的这种字体吗？”，又说“尽可能还原图中这种字体，我很喜欢这套字体”，所以 Himawari 回答的段落、标题、列表和引用改成两种衬线字叠用：先用 New York，New York 没有的中文字和中文标点交给思源宋体。系统宋体（Songti SC）在 iPhone 上不是预装字体，要联网按需下载，下载完之前只能先显示苹方，所以改为打包思源宋体的常规和半粗两种字重，只保留 GB2312 字符集的 7445 个字，两个文件合计约 5.6MB；不在这 7445 个字里的生僻字由系统用苹方补上。代码块和行内代码仍是等宽字，自己发的消息气泡仍是 SF Pro 和苹方。字号仍按 `.body` 文本样式跟着系统“动态字体”（系统设置里调的文字大小）放大缩小；其他地方，设计 token 的字号等于某个文本样式的默认大小时（17 是 `.body`、15 是 `.subheadline`、13 是 `.footnote` 等），代码直接用那个文本样式。`npm run check:apple-design` 会拦下自定义字体（`.custom(…size:)`、`UIFont(name:)`）和衬线字（`design: .serif`），只放行回答正文的字体文件 `AnswerFont.swift` 里的系统衬线。“她的页面”顶上的 himawari 字样是标志图片，不是文字，不受这条约束。依据：Apple《Human Interface Guidelines》的 [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)；思源宋体的许可是 SIL Open Font License 1.1，许可全文随字体放在 App 里，“关于”页列出了它。
57. **对话里“它正在做什么”只占一行。** 这句话由 Himawari 自己写，说的是事（“正在查周五早上的新干线”），不是工具名；图标由 Himawari 从固定的 40 个动作图标里挑，没有合适的用“别的工具”那一个。换了一件事就在原地换，不往下堆。进行中是字上慢慢扫过一道光，图标不动、不转圈；没成功时用平常的话说出来并接着做下一步，不用红色；要主人同意时，这一行下面出一张同意卡片（第 67 条）；做完后这一行就不留在对话里，长按那条回答选“看看 Himawari 做了什么”能看每一步（Andy 2026-11-26 试 build 145：“做完的事还显示‘✓ 做了 1 件事’”“去掉时间”）；没做成收成一行“没做成”，主人按了停收成一行“停了”，都不写用时，点开看每一步。系统开启“减少动态效果”时那道光不动（Andy 2026-11-12：“这四十个图标我很喜欢，设计风格我很喜欢”“同意图标由 himawari 自己从这 40 个里面挑”；图在 `docs/assets/apple-clients/2026-11-12-process-row/`）。
58. **要主人本人在场的操作（改规则、删记忆、改设置、导出、移除设备这些），点下去直接出面容识别，不另弹一个要再点一次的确认框。** 对话里的日常操作（发消息、改名、置顶、归档等）和“往少的方向”的操作（关掉或暂停感知、暂停记忆、暂停提醒、让正在跑的一轮停下）不用面容；哪个操作算哪一种，以详细设计的客户端能力表为准（随 2026-11-12 批准的原型定，[ADR 0247](adr/0247-apple-clients-are-fully-native-with-a-capability-table.md)）。
59. **Andy 说“学某个 App 的设计”，学的是视觉和组件（按钮、输入条、列表、设置页、字体），不动功能和页面结构，除非他明说**（Andy 2026-11-12：“学组件和 ui，不是说功能”）。
60. **图标、配色这类看眼缘的事，拿不准就一次并排给几套让 Andy 选，不一版一版地试**（Andy 2026-11-12：“多做几套出来给我选”）。
61. **触感每一下都有固定的含义，而且看场合。** 主人的手引起的事和 Himawari 的事分开；回答逐字出来时不震；录音和收听时不震；主人正看着时只有“等你点头”震；手表戴着就只在手表上震；设置里能调三档。页面不直接调震动，只报发生了什么事，由共用的一处决定震不震、怎么震（Andy 2026-11-12：“触感要做的智能、体贴一些”；事件表见[详细设计的“触感”](execution/specs/2026-11-11-apple-device-body-design.md#haptics)）。
62. **每一端只做它最擅长的事，不把别的端的页面搬过来。** iPhone 管提醒、随时对话、刷脸点头和各种感官；手表只有一眼看完、一两下做完的事；Mac 常驻菜单栏，管主人眼前的东西和这台 Mac 上的文件，不做聊天窗口和管理页；要看完内容才能定的事，手表上只给“在 iPhone 上看”。一件事只在一处响，哪一端定了，其他端一起收走（Andy 2026-11-12：“每一端都有各自的优势，那就把这个优势做到最好，其他不必要的功能就可以直接拿掉”；[ADR 0258](adr/0258-each-apple-device-plays-to-its-strength.md)）。2026-11-16 起手表和 Mac 暂停，只做 iPhone。
63. **打开就是一个主对话，不放问好、日期这类装点的字。** 灵动岛正下方居中浮着一个毛玻璃小圆（直径 56 点，系统 `.ultraThinMaterial`，里面是 46 点的向日葵），消息从它后面滚过去；没有顶栏的底、himawari 字样和深色圆底。点小圆打开她的页面，记忆和设置都从那一页进；没有底部页签栏、“今天”页、对话列表和“新对话”。她在忙（正在回答，或后台有事在办）时标志从中间一点点伸出小点，没有暖光；平时不动；系统开了“减弱动态效果”时全部静止。页面上的每个数字都要说得出数的是什么（Andy 2026-11-12：“像日期、问好这些完全没有必要”；2026-11-24 20:06：“打开就是一个主对话，没有新建线程这个入口，只有一个主对话”；2026-11-25 00:06 在六种头像样式里选了这一种：“我选这一个”；2026-11-26 02:00 看了毛玻璃小圆的原型后定稿：“可以，就按照这版来做吧”，01:48：“不要背后的一团暖光”）。
64. **一屏只有一个实心的主按钮。** 要主人定的事给两个等宽的按钮，肯定的在右、实心（会删东西的除外，见第 80 条），上面写的是会发生的事（“改到 9:40”“发出去”），不写“好”“确定”“同意”。否定的按钮写不做的那件事（“不发”“不订”）。例外是同意卡片：要做的事已经写在卡片正中，按钮管的是上面选的那个范围，所以写“不要”和“同意”。她那条话下面的选项不算按钮：带动作的选项本身就写会发生的事（“回复 田中：周四 15:00 可以”），最后一个是“不用了”。同一屏有几件事时，只有最要紧的那一件用实心按钮，其余的用浅底按钮。
65. **要再多看一点就在原地展开，不另弹一页把同一句话和同一对按钮再显示一遍。** 展开和收起用朝下、朝上的箭头；› 只用在进下一层（Andy 2026-11-12 看到底部弹层里四个一样的按钮：“好丑啊……好没有设计感”）。
66. **界面不按事情的种类写死。** 主对话的选项、同意卡片和通知上，一件事都按“一句话、明细、肯定按钮、否定按钮、来源、要不要本人在场”这一个样子画；没见过的种类照这个样子显示。服务器多一种事，界面不用跟着改（Andy 2026-11-12：“而不是一套固定死的工作流”；[ADR 0258](adr/0258-each-apple-device-plays-to-its-strength.md)）。
67. **Himawari 自己想到的事就是主对话里她的一句话。** 有可点的下一步时，下面竖排几个选项：只是接着问的白底细边；带具体动作的浅金底、左边一个发送图标，按钮字由服务器按真实收件人和内容生成，点一次就执行；最后一个灰字“不用了”；点过的变成主人的一条话，上面一行小字“选了”；有了更新的消息，旧的选项变灰。要主人同意的是一张同意卡片：“要你同意”和来源、程序写的真实动作和明细、四个范围（只这一次、这件事里、几天内、以后都行，花钱只能只这一次）、“不要”和“同意”。不再有“提议”和“告诉你一声”两种样子（ADR 0285 决定第 5 条；名字见[词表](glossary.md#terms)第 23 到 26 行）。
68. **深色只换颜色，版式、字号、间距和浅色一样。** 颜色只用 `tokens.json` 里批准过的那一套，不为某一屏新造颜色；跟系统的外观走，App 里不另设开关。
69. **画新的一屏之前，先打开已认可的那几屏和 `tokens.json` 对一遍。** 同一个位置的东西（顶上头像、输入条和右下角声波圆钮、按钮高度）在每一屏都一样；补画的屏在基线的说明里标明“设计线程补画”，和 Andy 逐屏看过的分开。
70. **能用系统组件就用系统组件；自绘的组件，点击区域、按下的反馈和无障碍都要和系统组件一样好。**
    - 系统有现成的就用系统的：分段切换用 `Picker` 的 `.segmented` 样式，列表用 `List`，开关用 `Toggle`，菜单用 `Menu` 和 `.contextMenu`，弹层用 `.sheet`，左滑操作用 `.swipeActions`，搜索用 `.searchable`。只能换系统允许换的颜色和字体，不另画一个外观相似的组件。
    - 只有系统组件做不出已经定稿的设计时才自绘，并且在说明里写清楚原因。
    - 字体只用系统字，见第 56 条。
    - “她的页面”往下推进去的每一页都用系统导航栏：系统返回钮、标题、边缘右滑返回；记忆页是大标题，往下拉出现 `.searchable` 搜索栏。不再用自己画的玻璃返回钮加隐藏导航栏，因为隐藏导航栏后边缘右滑返回会失效。
    - 自绘组件要达到下面四条：
      1. 整块都能点，点中区域至少 44×44 点。字小时，把点击区域放大到整块（`contentShape`），不只是文字那一块。代码里按钮一律用 `.buttonStyle(.pressable)`（整块可点、按下变暗），`npm run check:apple-design` 会拦下 `.plain` 和 `.borderless` 这两种只有字能点的样式。
      2. 选中和没选中，不只靠颜色深浅区分，要一眼就能看出来：系统分段切换那样浮起一块的底，或者字重、颜色一起变；浅色和深色下都要看得清。
      3. 按下时有反馈：按下时变暗或缩一点，松手才触发；手指移开就取消。
      4. 无障碍：VoiceOver 读得出名字和状态（例如“记住的事，已选中，第 1 项，共 2 项”）；跟着动态字体放大，字放大后点击区域也跟着变大；“减弱动态效果”打开时不播动画。
    - 没接通、没做完或只是摆设的按钮和入口不放出来，做好了再放。
    - 每份规划稿写明每个能点的东西用哪个系统组件；自绘的写明原因。每次验收在正反向之外再加三条：点边缘、不点在字上也能触发；选中项在浅色和深色截图里都一眼认得出；VoiceOver 读出的名字和状态对。
    - 依据：Apple《Human Interface Guidelines》的 [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)（点击区域至少 44×44 点）、[Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。起因是 Andy 2026-11-26 9:32 看了记忆页的切换后说：“这里的写个选中的 tab 按钮不够明显，而且，只有准确的点击在文字上的时候才会触发切换，你必须按照 ios app 的 ui ux 开发最佳实践来开发各种组件 ui 给我极致的 ux 体验”；9:34 看了记忆页右上角的搜索钮：“这里这个按钮有必要存在吗？如果有就做到可用，好用，再放出来给我用！”

<a id="apple-hig"></a>

#### 照苹果最新 HIG 做的通用要求

下面几条是把苹果《Human Interface Guidelines》（HIG，苹果官方的界面设计规范）现行版本落到本项目的写法，2026-11-26 按 Andy 的要求整理（原话：“iOS watchOS macOS 的 app 的 ui 和 ux 必须遵守和践行 apple 最新的开发规范，包括不限于各种组件的设计，页面的设计，各用户的交互方式等等”）。每条标明出处：**【官方】**是 HIG 或苹果开发者文档、WWDC（苹果每年的开发者大会）原文写的；**【社区】**是开发者社区公认的做法，不是苹果的规定，附来源。核对 HIG 时用的是各页 2026-11-26 的线上版本，各页最近一次改版日期写在括号里。和上面第 53 到 70 条冲突时以这里为准；能机器检查的，写明是哪道门槛（见[自动检查](#gates)的苹果客户端几行），不能的进[苹果客户端验收清单](#apple-acceptance)。

71. **页面怎么进出照系统的走。** 推进去的一层用系统导航栏：标题、系统返回钮、边缘右滑返回都由系统给，不隐藏导航栏再自己画返回钮。弹层用 `.sheet`，能往下滑关掉；一次只开一个弹层，关掉一个再开下一个；只看不改的弹层用系统的关闭钮，要保存改动的才用“完成”，并且和“取消”配对；“取消”“完成”“返回”三个不同时出现。【官方】[Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)（2026-03-24）、[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)。门槛：`hidden-navigation-bar`。
72. **玻璃（Liquid Glass，iOS 26 起系统控件用的半透明材质）只用在浮在内容上的那一层。** 导航栏、工具条、输入条、顶上的小圆这类控件层可以用；滚动的内容（消息、卡片、列表行）里不用；不在玻璃上再叠一层玻璃。系统组件自带玻璃，不另加底色；自绘控件要玻璃时用系统的 `.glassEffect`，不自己调半透明颜色冒充，而且少用。玻璃上的字和图标用单色，颜色只留给真正要强调的（例如“要你同意”）。【官方】[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)（2025-09-09）、[Color](https://developer.apple.com/design/human-interface-guidelines/color)（2025-12-16）、[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)。门槛：无，进验收清单。
73. **所有字都跟系统的“动态字体”（Dynamic Type，用户在系统设置里调的字号）走。** 字号一律用 `.hmType(...)`（底下是系统文本样式，见第 56 条），不写 `.font(.system(size:))`；和字号一起变大才看得清的尺寸（图标、行高）用 `@ScaledMetric`。字放到最大的辅助字号时，重要的字不截断，横排挤不下就改竖排（`ViewThatFits`）。正文默认 17 点，最小 11 点；不用 Ultralight、Thin、Light 这几档细字重。【官方】[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)（2025-12-16）、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（2025-06-09）。门槛：`fixed-font`、`custom-font`、无障碍审计的 `dynamicType` 和 `textClipped`。iPhone App 不给动态字体封顶，最大的辅助字号也照样放大。
74. **字和底色的对比度，浅色、深色都要够。** 17 点及以下的字至少 4.5:1，18 点以上或粗体至少 3:1；状态不能只靠颜色区分，还要有形状、图标或字重的变化；打开系统的“增强对比度”“降低透明度”时也要看得清。【官方】[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)。门槛：`text-contrast`（`tokens.json` 里正文用的字色对 `bg`、`surface` 达到 4.5:1）、无障碍审计的 `contrast`（真屏幕上量）。
75. **点击区域至少 44×44 点，控件之间留够空。** 苹果 Buttons 页写的是按钮的点击区域至少 44×44 点；Accessibility 页的表把 iOS 控件写成默认 44×44、最小 28×28，本项目按 44 执行。有边框的控件之间留约 12 点，没边框的约 24 点。【官方】[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)（2025-12-16）、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。门槛：`plain-button`、无障碍审计的 `hitRegion`。
76. **VoiceOver（读屏）和语音控制能用到每一个功能。** 只有图标的按钮必须有 `accessibilityLabel`；选中、开关这类状态由系统控件自带的特征读出来，自绘的用 `.accessibilityAddTraits` 补上；纯装饰的图 `accessibilityHidden(true)`；一行里的几段字合成一个元素（`accessibilityElement(children: .combine)`）。手势（点按、长按、滑动）做的事，屏幕上必须另有按钮，或者加 `accessibilityAction`。能点的东西用 `Button`，不用 `.onTapGesture`（点按手势不会告诉读屏“这是按钮”）。【官方】[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（“Offer alternatives to gestures”）、[VoiceOver](https://developer.apple.com/design/human-interface-guidelines/voiceover)；“用 Button 不用点按手势”是【社区】做法，见 SwiftLint 的 [accessibility_trait_for_button](https://realm.github.io/SwiftLint/accessibility_trait_for_button.html) 规则。门槛：`gesture-without-button`、无障碍审计的 `sufficientElementDescription`、`trait`、`elementDetection`。
77. **外观跟系统走，App 里不设浅色深色开关。** 第 68 条已写；同时检查深色加“增强对比度”“降低透明度”下的样子。【官方】[Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)。门槛：`app-color-scheme`、无障碍审计在深色下再跑一遍。
78. **动效有目的、短、能打断。** 常用操作不加多余动画；不让人等动画播完才能继续；系统开了“减弱动态效果”时，自动播放和重复的动画（缩放、位移、景深变化、模糊进出）换成淡入淡出或不动。【官方】[Motion](https://developer.apple.com/design/human-interface-guidelines/motion)（2025-09-09）、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。门槛：无，进验收清单。
79. **触感按系统定的含义用，能关。** 系统控件（开关、选择器）自带的触感不再重复加；自己加的只配合离散的事件，不长时间震；页面只经 `Haptics.shared.report` 报事件（第 61 条）。【官方】[Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)。门槛：`direct-haptics`。
80. **按钮有按下的样子，会删东西的不当主按钮。** 自绘按钮一定有按下状态（`.pressable`）；一屏里最可能点的那个用突出样式；删除这类不可挽回的操作用 `role: .destructive`（系统红），即使它最常被点也不做成实心主按钮，这一点优先于第 64 条“肯定的在右、实心”。【官方】[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)。门槛：`plain-button`；删除不做主按钮进验收清单。
81. **常用组件照 HIG 对应页的细则。** 分段切换在 iPhone 上不超过约 5 段，段名用名词，同一个控件里全用字或全用图标；开关的开和关一眼能分；菜单项用动词开头，点了还要再填东西的末尾加“…”；搜索边打字边出结果，占位字说明能搜什么；列表点一行要有选中反馈。【官方】[Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)、[Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)、[Menus](https://developer.apple.com/design/human-interface-guidelines/menus)（2026-06-08）、[Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)（2026-06-08）、[Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)。门槛：无，进验收清单。
82. **不用到时自己消失的界面传达要紧的事。** 提示条、气泡这类定时消失的东西，只用来说“已复制”这种不看也不要紧的话；要主人知道或决定的事，留在原处等他自己关。【官方】[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（“Minimize use of time-boxed interface elements”）。门槛：无，进验收清单。
83. **系统控件的位置用系统的图标。** 返回、关闭、分享、搜索、更多这类系统控件，用系统按钮自带的 SF Symbols（苹果的系统图标库），不换成别的图标；第 54 条按 Andy 圈定换的图标只用在 Himawari 自己的内容上（过程行的 40 个动作图标、“她的页面”列表行、输入条）。【官方】[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)（“Prefer system-provided symbols”）、[Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)（“Use SF Symbols wherever possible”）。门槛：无，进验收清单。
84. **门槛要能挡住后来者，已有的问题单独记账。** 新规则上线时已经存在的违规，记在登记表里并写明原因，新代码不许再增加；修好一处就把登记的数量减下来：代码检查不减就失败；无障碍审计在真模拟器上跑，同一场景每次数出的问题会差一两个，所以不减只在 CI 上给出警告（`A11Y_AUDIT_STALE`），由看到警告的线程把数字改小。审计超时会自动重跑一次，两次都超时记为 `auditDidNotFinish`。这是 SwiftLint 0.55 起的 `--baseline` 用法（【社区】，[SwiftLint 0.55.0 发布说明](https://github.com/realm/SwiftLint/releases/tag/0.55.0)）。本项目的两张登记表：`clients/apple/scripts/design-baseline.json`（代码检查）和 `clients/apple/App/UITests/accessibility-baseline.json`（无障碍审计）。
85. **主对话里你和她的话都是 IM 那样的气泡。** Andy 2026-11-26 原话：“回复我的消息和我发的消息你都必须做成 IM 那种体验最好的消息气泡的感觉！”对标苹果“信息”App。
    - 她的气泡靠左、浅灰底（token `color.bubble`），最宽到离屏幕右边 40 点；你的气泡靠右、向日葵金色底配白字（底用 `color.bubbleOwner`，字用 `color.onBubbleOwner`，对比度约 5:1，深浅两种外观同色），最宽是屏幕宽的 78%。照苹果“信息”App 自己的气泡用主题色；Andy 2026-11-28 问“为什么在浅色主题的时候，用户发的消息要用黑色背景呢？”后从墨色底改过来。气泡里的引用用同一个白色，不再调淡，竖条也用白色，免得金色竖条在金色底上看不见。两边都离屏幕边 16 点。
    - 圆角 20，连续圆角，不带尾巴（Andy 2026-11-28 定：“把这个消息的小尾巴去掉”）。同一人连着说的几条算一组，组里的气泡隔 2 点，换人隔 14 点。两条话隔 15 分钟以上，中间插一行居中的 12 点灰字时间。分组和时间在 `BubbleLayout` 里先算好，不在每一行的 `body` 里算。尺寸都在 `tokens.json` 的 `chat.bubble`。
    - 过程行、她话下面的选项、同意卡片都在气泡外面，和气泡左对齐。回答里有列表、表格、代码框、引用或标题时，气泡撑到最宽；代码框和表格在气泡里横向滚动，不撑破气泡。
    - 长按整个气泡出菜单，预览就是气泡本身的圆角形状（`.contentShape(.contextMenuPreview, …)`）。她的回答还没出第一个字时不放空气泡，也不放“正在输入”的三个点，“她在忙”只由顶上小圆表达。
    - 滚到最上面时，第一条从小圆下方开始：顶部留白是安全区加 6 加 56 加 12（`tokens.json` 里 `chat` 下 `puck` 的 top、size、contentGap）。

86. **全 App 只有一种强调色：向日葵金。** 开关、选中、“开着”“连着”这类状态字和对勾，iPhone、Mac 和分享面板一律用向日葵金（token `color.sun`，浅色 #9a6200 在白底上 5.1:1、深色 #f2bb4f 在卡片底 #2a2a2a 上 8.2:1，都可以当字用），不用系统默认的绿或蓝。做法是在每个界面的最外层设一次 `.tint(Color.hmSun)`，系统开关和按钮自己跟着变，页面代码里不再单独给开关上色。Andy 2026-11-26 试 build 145 的原话是开关和“连着”都是绿色，要求全 App 统一主题色。【官方】[Color](https://developer.apple.com/design/human-interface-guidelines/color)。门槛：`HimawariDesign` 里删掉了绿色的状态色（[删之前的 `Palette.swift`](https://github.com/sixianli/himawari-agent/blob/e6cf891642639c205adb5c23adec91eca8f98486/clients/apple/Sources/HimawariDesign/Palette.swift)），页面代码写不出绿色状态色。
87. **规则不放在记忆页里。** 规则是 Andy 给 Himawari 定的硬设定，每次都照做（[产品愿景](product-vision.md) v2.2 起），不是记忆：记忆页只列记住的事，搜索也只搜记忆；规则在 Himawari 页里单独一页“规则”（Mac 侧栏同样一项，`RulesPage`）。本来就是设置的规则（例如勿扰时段）只在对应的设置页里显示，规则页按服务端在那个设置里返回的规则编号把它们拿掉，不在客户端按类型写死。规则详情里“你的原话”和规则本身一字不差时不再重复一遍。做法对照 ChatGPT 和 Claude：两家都把“你自己写给助手的指示”和“助手从对话里记下的东西”分成设置里并排的两项，指示不放进记忆列表（ChatGPT 在 Settings → Personalization 下分 Custom instructions 和 Memory，见 [Custom instructions](https://help.openai.com/en/articles/8096356-chat-preferences-for-chatgpt)、[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)；Claude 在 Settings → Your Claude 下分 preferences 和 memory，见 [chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)）。起因是 Andy 2026-11-26 试 build 145 时说记忆页里放“规则”不对（反馈第 26、30 条）。
88. **Himawari 页只放 Himawari 自己的东西，设置单独一页。** iPhone 上的 Himawari 页分两组：“Himawari 知道的”（记忆、规则、文件、评测）和“Himawari 能替你做的”（定时、连接、别的 agent、允许的事、保险箱）；称呼、模型、通知、隐私、设备、导出、关于收进最下面一行“设置”，点进去是系统导航的下一页（`HerPage` 的 `settingsPage`）。Andy 2026-11-28 在 build 145 设计稿里选的方案 B（见[优秀设计](#good)表）。记忆那一行只写记忆条数，规则数写在规则那一行。

<a id="apple-acceptance"></a>

#### 苹果客户端验收清单

机器查不了的条目，由 iOS 规划线程在每次验收时逐条看，并把结果写进验收记录；每条都要在浅色和深色、默认字号和最大辅助字号下各看一次。

- [ ] 每个能点的东西用的是哪个系统组件，规划稿里写了；自绘的写了原因（第 70 条）。
- [ ] 点能点的东西的边缘、不点在字上也能触发；选中项在浅色和深色截图里一眼认得出（第 70 条）。
- [ ] 打开 VoiceOver，每个能点的东西读出的名字和状态对；手势能做的事，屏幕上另有按钮或在读屏的“操作”里（第 76 条）。
- [ ] 推进去的页能边缘右滑返回；弹层能往下滑关掉，同时只有一个弹层（第 71 条）。
- [ ] 玻璃只出现在控件层，滚动内容里没有玻璃，玻璃上没有再叠玻璃（第 72 条）。
- [ ] 最大辅助字号下，重要的字没被截断，布局没有叠在一起（第 73 条）。
- [ ] 打开“减弱动态效果”后，自动和重复的动画不再缩放、位移（第 78 条）。
- [ ] 打开“增强对比度”和“降低透明度”后字都看得清（第 74、77 条）。
- [ ] 会删东西的按钮是红色、不是实心主按钮（第 80 条）。
- [ ] 分段、开关、菜单、搜索、列表符合第 81 条；要紧的事没有用定时消失的提示（第 82 条）。
- [ ] 返回、关闭、分享、搜索这些位置用的是系统图标（第 83 条）。

[↑ 返回目录](#contents)

<a id="good"></a>

## 优秀设计

Andy 批准并明确表示喜欢的设计。每行的原型链接是当时批注的可点原型，截图基线在 `docs/assets/apple-clients/` 下对应版本。


| 日期 | 设计 | 出处 | 好在哪里 |
| --- | --- | --- | --- |
| 2026-11-15 | 标志减到 55 颗种子，所有尺寸同一个点数，种子按比例放大；iPhone、Mac、手表的桌面图标也是这个花盘 | Andy 在五档点数对比里选“55 粒”，[ADR 0283](https://github.com/sixianli/himawari-agent/blob/383003adb908eda96f097796905caaa5a4b705dd/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md) | 16px 下也能看出一粒粒种子，螺旋仍在 |
| 2026-11-25 | 标志按显示大小取种子数：28pt 及以下 21 粒、29 到 46pt 34 粒、47 到 56pt 55 粒、57 到 72pt 89 粒、更大 144 粒；点多时每粒变小，长满一盘总是约 16 秒 | Andy：“放大的情况下使用点多一点的 logo，缩小的情况下使用点少一点的 logo”，[ADR 0308](https://github.com/sixianli/himawari-agent/blob/1bc2b8886e7af7292d87642d057a78c8788860d7/docs/adr/0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md) | 不同大小的标志里每粒点看起来一样大，像字体的光学尺寸。例外：主对话顶部毛玻璃小圆里的 46pt 标志用 89 粒，粒数写在 `chat.puck` 的 `seeds`，忙时在 62 到 89 粒之间来回（Andy 11-26 原话：“把这里的 logo 换成点多的”） |
| 2026-11-12 | iPhone App 原型：底部浮动玻璃页签栏（今天、对话、记忆），右下角单独一个向日葵圆钮随时说话，搜索和设置在右上角；“今天”页从问候、等点头的事、提醒到时间线；Himawari 说的话用衬线字（2026-11-26 起改用系统字，见第 56 条）；浅色深色两套 | Andy：“可以，就按照最新版原型做”；原型 <https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme>，基线 `docs/assets/apple-clients/2026-11-12-v2/` （2026-11-24 起改成一个主对话，见最后一行） | 按手机的用法重新设计，没有照搬网页；颜色少，层次靠玻璃和阴影 |
| 2026-11-12 | App 图标用 Tabler Icons 线条款：单色、线宽 1.6、不加底（2026-11-26 起大多数改用 SF Symbols，Andy 圈中的几个仍用 Tabler，见第 54 条） | Andy 在四套线条图标里“选择 D” | 简洁，和苹果系统图标是一路；不靠颜色抢眼 |
| 2026-11-12 | 对话里的过程行：40 个动作图标分七组（想和记、日程和消息、出门、上网和文件、动手做、设备和感知、结果），一次一行，进行中字上扫过一道光，等点头是唯一的向日葵金 | Andy：“这四十个图标我很喜欢，设计风格我很喜欢”；图 `docs/assets/apple-clients/2026-11-12-process-row/` | 主人长时间看的就是这一行：一眼知道它在做哪类事，又不吵 |
| 2026-11-12 | “今天”页：左上角一朵细画的向日葵加衬线斜体的 himawari 字样，没有问好和日期；最要紧的一件最大（一句话、来源、两个等宽按钮），其余的事收在一张分组卡片里，再往下是“接下来”和一行感知状态；右下角圆钮是麦克风 | Andy：“可以，我看了，就先这样吧。这一版原型先这样”（在线原型第 32 版）；基线 `docs/assets/apple-clients/2026-11-12-v3/`（2026-11-24 起“今天”页拿掉，见下一行） | 打开就知道哪件事要他定；一个装点的字都没有，品牌只靠左上角那一处 |
| 2026-11-25 | iPhone 打开就是一个主对话：灵动岛下方一个毛玻璃小圆里是她的向日葵（2026-11-26 取代原来的深色圆底、himawari 字样和暖光），点小圆进她的页面；她忙时标志从中间伸出小点；输入条右下角声波是和她说话；她的话下面竖排可点的选项，要同意的事是主对话里的同意卡片；没有页签栏、“今天”页、对话列表和“新对话” | Andy 2026-11-24 22:29：“按推荐”（去掉今天页等三项）；23:44 嫌箭头入口“没有设计感”后改成头像；2026-11-25 00:06 在六种头像样式里“我选这一个”；原型 <https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme>，基线 `docs/assets/apple-clients/2026-11-25-v4/`，[ADR 0258](adr/0258-each-apple-device-plays-to-its-strength.md)、ADR 0285 | 主人只看一个地方；入口就是她本人，不占一条底栏；忙不忙看头像就知道 |
| 2026-11-25 | 列表行（她的页面和它下面各页）的图标放进浅金圆角方块，对话里的图标仍不加底 | 原型从第 53 版起列表行就是方块底，Andy 2026-11-24 看过说“按推荐”；和 11-12 的“不加底”对不上，由设计线程按原型定 | 像 iPhone 设置 App，一眼分出每一行是什么；对话里不加，免得抢她说的话 |
| 2026-11-28 | 浅色主题下标志最新长出来的几粒种子用主题深金 `#9a6200`（对白底 4.96:1），其余种子和深色主题不变；标志放在深色圆底上时（Himawari 页头像、聊天头像）仍按深色取色 | Andy 在 build 145 设计稿<https://claude.ai/artifact/9fNkQNTLzZMYBostVkA3HN>里选推荐方案 A | 原来的浅黄 `#ffecaa` 对白底只有 1.15:1，“慢慢长出来”的那几粒看不见；用主题色不另造新颜色 |
| 2026-11-28 | App 图标和苹果端标志改成 105 粒、一色金：所有种子同一种金色，只靠大小区分里外，最新几粒浅金；浅色主题种子用琥珀 `#d27c12`。大标志（57pt 以上）和主对话顶部小圆用 105 粒，小标志仍是 21、34、55 粒 | Andy 在图标候选页选“105 粒，用 H 这一套风格”，看过动效后说“这一套我很喜欢，就这么做”，[ADR 0314](adr/0314-app-icon-and-apple-mark-use-105-seeds-in-one-gold.md) | 金色白底只有 1.9:1，琥珀色 3.08:1 才看得清；小尺寸点太多会挤 |
| 2026-11-28 | iPhone 和 Mac 的桌面图标一律深底金花：深色底上一朵向日葵花盘，不加字、不加渐变，浅色和深色外观同一张 | Andy 在同一份设计稿里选推荐方案 A | 和 App 深色主题、灵动岛一致，在什么壁纸上都显眼 |
| 2026-11-28 | Himawari 页方案 B：只放 Himawari 自己的东西，分“Himawari 知道的”（记忆、规则、文件、评测）和“Himawari 能替你做的”（定时、连接、允许的事、保险箱）两组，通知、隐私、设备、称呼、模型等收进最下面一行“设置” | Andy 在同一份设计稿里选方案 B | 一页一个主题，设置不和 Himawari 的东西混在一起 |

[↑ 返回目录](#contents)

<a id="bad"></a>

## 不良设计

做出来后被 Andy 指出、或被检查拦下的问题。“对应规则”指向上面的[好的设计规范](#rules)。

| 日期 | 问题 | 原因 | 改法 | 对应规则 |
| --- | --- | --- | --- | --- |
| 2026-11-15 | 233 颗种子的标志缩到 24px 以下只剩一团点，看不出是向日葵；苹果端 App 在桌面上没有图标 | 点数是按大图选的，没在小尺寸下看过；苹果工程里没有 App 图标资源集和图标名设置 | 减到 55 颗、每颗放大；新建 `Brand.xcassets` 并由测试检查三端都设了图标（[ADR 0283](https://github.com/sixianli/himawari-agent/blob/383003adb908eda96f097796905caaa5a4b705dd/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md)） | 35 |
| 2026-11-12 | App 设计里把不常用的页面做成嵌网页 | 为省开发量；App 里要另外登录一次、打开慢、离线看不了 | 全部原生 | 53 |
| 2026-11-12 | App 设置页的图标连换三版都被否：手画的双色细线、暖色底上的实心图标、从网页搬来的圆润图标 | 自己手画、上色加底显得浮夸；把网页的造型直接搬到 App；一次只给一版 | 换成现成的线条图标库，四套并排给 Andy 选 | 54、60 |
| 2026-11-12 | Andy 让“学习 Claude iOS App 的设计”，结果把页签栏去掉、改了页面结构 | 把“学设计”理解成学功能和结构 | 恢复三个页签和“今天”页，只重做组件 | 59 |
| 2026-11-12 | “今天”页顶上放了问好和日期，占掉最上面的一大块 | 照一般 App 首页的习惯加的，没有问“这行字帮他定什么” | 去掉，左上角只留向日葵和字样 | 63 |
| 2026-11-12 | 点“看明细”弹出一张底部面板，里面把同一句话和同一对按钮又显示一遍，一屏四个一样的按钮 | 把“多看一点”做成了另开一层 | 就地展开，用上下箭头 | 65 |
| 2026-11-12 | Mac 端第一版是把 iPhone 的页面放大再做一遍，外加收听和定时截屏 | 没有先问“这一端比别的端强在哪” | 重新设计成常驻菜单栏的六样事（2026-11-26 起改做完整的原生 Mac App，[ADR 0309](adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md) 第 13 条） | 62 |
| 2026-11-12 | 后补的几块画板和已认可的首页不一致：今天页又带了问好，深色另配了一套颜色，右下角圆钮有的画成向日葵 | 画新屏时没有打开已认可的屏和 `tokens.json` 对照 | 把首页版式抽成各画板共用的一份，深色改回批准的数值，圆钮统一成麦克风（在线原型第 42 版） | 68、69 |

[↑ 返回目录](#contents)

<a id="gates"></a>

## 自动检查

规范里能自动检查的部分，已经变成程序检查。规则写进本文不算完成，能检查的要落成检查（[ADR 0107](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0107-every-incident-gets-an-automatic-gate.md)）。

| 检查 | 命令 | 拦什么 |
| --- | --- | --- |
| 设计依据不用网页 | `npm run check:design-sources`（`scripts/check-design-sources.mjs`，用例在 `test/tooling/design-sources-check.test.mjs`） | 本文、`docs/assets/apple-clients/` 下的说明、`AGENTS.md`、`.claude/rules/` 和 `.agents/instructions/` 里又把网页的代码、原型或规范当依据 |
| 标志资源 | `npm run check:brand`（`scripts/check-brand-assets.mjs`） | `assets/brand/himawari/v3/logo-sunflower-disc.svg` 和代码里画种子的数学（`brand-seeds.ts`）不一致 |
| 苹果客户端页面代码 | `npm run check:apple-design`（`clients/apple/scripts/check-design.mjs`，用例在 `test/tooling/apple-design-check.test.mjs`） | iPhone、手表、Mac 的页面代码里：写死的颜色和尺寸、直接调震动、`.plain` 和 `.borderless` 这种只有字能点的按钮（第 70 条）、点按和长按手势没有读屏能用的替代（`gesture-without-button`，第 76 条）、隐藏系统导航栏（第 71 条）、App 自己定浅色深色（第 77 条）、不跟动态字体放大的字号（`fixed-font`，第 73 条）、系统字以外的字体（`custom-font`，第 56 条）；用 `.containerRelativeFrame(.vertical)` 把页面内容锁成一屏高、长页面滑不到底（`screen-height-lock`，事故 I-123）；`tokens.json` 里正文字色在浅色、深色下对底色不到 4.5:1（`text-contrast`，第 74 条）；生成的令牌文件过期。已有的违规记在 `clients/apple/scripts/design-baseline.json`，超出数量、修好后不减数量、没写原因都失败（第 84 条） |
| 苹果功能 UI 测试 | CI 的 `apple/iphone` 作业，每个改了苹果客户端的 PR 都跑（`clients/apple/App/UITests/ChatComposerTests.swift`、`SettingsPagesTests.swift`、`SensesPageTests.swift`、`PerceptionDeletionTests.swift`、`BackgroundWorkTests.swift`、`ShareToHimawariTests.swift`、`ChatMessageMenuTests.swift`、`ChatOptionsTests.swift`、`AttachSheetTests.swift`、`ApprovalsTests.swift`）；哪个功能由哪条测试操作，记在 `clients/apple/ui-test-map.json`，`npm run check:ui-test-map` 检查 | 在示例场景里真打字、真点、真滑：打字出现发送钮、只有空格不出现；没连上的聊天提示没连上，连上的不提示；Himawari 页每一行点开都有页面、能回来（先试左边缘右滑，再试返回钮或下滑）；每个设置页用系统最大字号打开都能滑到最后一行；感知页每一行点开都有页面、能回来；位置“一直允许”开关能点、系统没给时不会自己变成开；删感知记录先问再删、取消不删；后台在办的胶囊有事才出现、子线程能点开能回来、往来记录能展开收起；分享面板交之前能打字、交过之后不能再改，分享入口开关能关能开；长按回答能回复、复制、选择文字；点了消息里的一个选项，其他选项就点不了；附件面板能关能再打开；等你同意的列表能在“等你同意”和“处理过的”之间切，点开一条能看到为什么问你 |
| 苹果无障碍审计 | CI 的 `apple/iphone-accessibility` 作业（`clients/apple/App/UITests/AccessibilityAuditTests.swift`），不在 `npm run check` 里，需要 Mac 上的 Xcode 和 iPhone 模拟器；不在 PR 上跑，也不在推送到 `main` 时跑，每天 03:00 JST 定时跑一次，只在上次审计以后 `main` 改了 `clients/apple/`、`.github/workflows/apple.yml` 或 `scripts/ci/apple-scope.mjs` 时才跑（由 `apple/changes` 作业判断，说不清时照跑），也可以在 GitHub 的 Actions 页面对任一分支手动运行 `Apple` 工作流；`main` 上失败时 `apple/claim` 在改了苹果客户端的 PR 上留言请它的线程认领（[ADR 0292](adr/0292-how-ci-runs-now.md#runners)） | 从 `DemoScenes.swift` 读出全部静态示例场景，场景按顺序分成三份，在同一次运行里一份接一份跑，好让 `main` 同时只占一台 Mac（[ADR 0292](adr/0292-how-ci-runs-now.md#runners)）。每个场景用苹果的 `performAccessibilityAudit`（[WWDC23 Perform accessibility audits for your app](https://developer.apple.com/videos/play/wwdc2023/10035/)）在浅色下跑全部审计项，再切到深色只跑对比度（两遍各截一张图算平均亮度，浅色那一遍本身偏亮而深色那一遍不比它暗就失败，防止深色审计其实在浅色画面上跑，见事故清单 I-121）：对比度不够、点击区域太小、没有名字的元素、读屏特征不对、字不跟动态字体变、字被截断。没有在最大辅助字号下再跑一遍：试过一次，审计在大字号下超时跑不完。已知问题按“场景、浅色或深色、审计项”计数，记在 `clients/apple/App/UITests/accessibility-baseline.json` 并写原因；某一格的问题比登记的多，作业失败；比登记的少，作业给出警告，提醒把数字改小 |
| 苹果截图比对 | Mac 上 `clients/apple/scripts/ui-review.sh --check`，不在 CI 里 | 每个示例场景浅色、深色截图和 `clients/apple/Tests/Snapshots/iPhone-390/` 逐像素比，差异超过 0.05% 失败。没放进 CI：快照是在 Andy 的 Mac 上拍的，GitHub 机器的 Xcode 和模拟器版本不同，字的渲染会有细微差别，放进去会常常误报；字跟不跟动态字体变、字有没有被截断，由上面的无障碍审计查；最大辅助字号下的样子按验收清单人工看 |

机器查不了的条目，见[苹果客户端验收清单](#apple-acceptance)。

[↑ 返回目录](#contents)
