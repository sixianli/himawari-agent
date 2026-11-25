---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-25"
---

# 苹果客户端界面基线第 4 版

这个目录是 iPhone App 下一版照着做的界面，取自在线原型第 64 版（第一排在第 66 版加了一屏）（<https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme>，2026-11-25）。规则写在[详细设计的“主对话和她的页面”](../../../execution/specs/2026-11-11-apple-device-body-design.md#main-chat)和[设计规范的“苹果客户端”一节](../../../ui-ux-design-guide.md#apple-clients)；图和文字对不上时以文字为准，并告诉设计线程。2026-11-16 起手表和 Mac 暂停，这一版只有 iPhone。第 3 版（`../2026-11-12-v3/`）只作参考，里面的“今天”页、底部页签栏、对话列表、提议和“告诉你一声”都不做了。

## 目录里有什么

- `01` 到 `09`：一排画板一张图，一倍清晰度，每部手机宽 390 点。从上到下就是打开 App 后的顺序。要量准确的数值，看 `tokens.json` 和 `source/`。
- `tokens.json`：颜色、圆角、尺寸、字号、图标线宽，浅色深色两套，加上她的头像和选项两段。客户端的数值只从这里来。
- `source/`：原型的源文件、画板清单 `canvas.json` 和向日葵标志 `_blob/sun.svg`。源文件要在在线原型里才能打开，单独用浏览器打不开；放在这里是为了查数值和留底。
- 内容都是示例数据。图是在“减弱动态效果”下截的，所以头像的生长和柔光是静止的样子；动效的定义在 `tokens.json` 的 `avatar` 一段。

## 每张图是什么，Andy 看过没有

“看过”指 Andy 看过这一排并定了方向；“补画”指设计线程后来画的，Andy 没有逐屏看过（[ADR 0258](../../../adr/0258-each-apple-device-plays-to-its-strength.md) 决定第 9 条：补画的屏由设计线程照已认可的样子定）。

| 图 | 画的是什么 | 源文件 | Andy 看过没有 |
| --- | --- | --- | --- |
| `01-chat.png` | 主对话：她的头像、可点的选项、点了以后、后台在办和子线程、展开子线程的往来、同意卡片、锁屏 | `NextChat.dc.html` | 看过（2026-11-24 22:29：“按推荐”；2026-11-25 00:06 选头像样式：“我选这一个”）；第 6 屏“展开往来”是第 66 版照 Andy 2026-11-25 的要求补画（子线程之间的往来默认收起，想看能展开） |
| `02-chatmore.png` | 主对话的其他状态：没发出去、没连上、过程行、回答里的格式、点“+”、按住说话、听写、和她说话，最后是过程行的图标 | `NextChatMore.dc.html` | 前面几屏看过（同上）；按住说话、往上滑、听写和“和她说话”的三屏（在听、她在说、说完了）共六屏是第 62 版补画 |
| `03-lists.png` | 她的页面，和它下面的定时、同意过的事、用量和上限 | `NextLists.dc.html` | 看过（同上） |
| `04-memory.png` | 她记得的：记忆、一条记忆的详情、主题页、昨晚整理了什么、回收站、规则 | `NextMemory.dc.html` | 看过（同上）；内容跟记忆方案 v3 走 |
| `05-vault.png` | 保险箱：列表、加一项、从“密码”导入、一项的详情、用到才问、网站对不上、锁屏、批准页、丢手机换钥匙 | `NextVault.dc.html` | 补画；第 63、64 版照保险箱方案 v5 重画，保险箱线程核对过和方案对得上 |
| `06-settings.png` | 通知（只剩安静时段）、隐私、删掉感知记录、设备 | `NextSettings.dc.html` | 看过（同上） |
| `07-senses.png` | 让她感知：位置、日程、健康、相册、分享过来的 | `NextSenses.dc.html` | 从第 3 版改样式搬过来，内容没变 |
| `08-ears.png` | 收听、随身麦克风、让她看屏幕 | `NextEars.dc.html` | 从第 3 版改样式搬过来，内容没变 |
| `09-pairing.png` | 第一次打开：配对 | `NextPairing.dc.html` | 从第 3 版改样式搬过来，内容没变 |

## 和第 3 版相比，`tokens.json` 改了什么

- 去掉“今天”页和页签栏用的值：`home` 一段，`icon.todayTab`、`icon.newChat`、`icon.todayTop`、`icon.tab`，`type.todayTop`、`type.tabLabel`、`type.emptyTitleNewChat`，`size` 里的 `tabBarHeight`、`tabBarWidth`、`fadeTabBar`、`tabBarReserve`、`emptyMarkNewChat`、`newChatGlowRadius`，`radius.tabBar`。
- `icon.speak` 由 `microphone` 改成自己画的声波（全套里唯一自己画的图标），`speakSize` 22、`strokeSpeak` 2.2；新增 `icon.dictate`（`microphone`）和 `icon.attach`（`plus`）。
- 新增 `avatar` 一段：头像的位置和大小、忙时的生长（ADR 0283）和柔光、平时和“减弱动态效果”时的样子、下面“后台在办”那一条。
- 新增 `options` 一段：她那条话下面的选项。
- 新增 `chat` 一段：主对话顶上的渐隐（头像下面有没有“后台在办”那一条，高度不同，两种都给了）、回答里的格式（段落间距、列表、表格；引用和代码块原型没画，不给数值，由设计线程定）、点“+”的面板、语音的声波条、说话途中那条气泡的透明度。
- 新增 `her` 一段：她的页面的大头像、himawari 字样和带图标方块的行。
- 第 3 版漏掉、第 2 版有、这一版还用得上的值补回来，数值照抄第 2 版：`senses`、`handover`（分享过来的）两段（`handover` 里只有分享面板那几项在第 4 版原型里画了，其余沿用第 2 版，见它的 `note`），`type.rowAction`、`type.senseTitle`、`type.senseTime`，`size.pillSmall`，`icon.todayRow`（设备动作的行也在用，名字留到改外壳时再改）。
- `colorUse` 只放“用途名对颜色名”：原先误放在里面的 `successRing`、`highlight` 两句说明挪到 `colorNotes`，否则生成 Swift 常量的 `clients/apple/scripts/make-design-tokens.mjs` 报 `DESIGN_TOKEN_COLOR_USE_UNKNOWN`。
- 新增颜色 `onSpeak`（speak 深色圆底上的图标，深色模式 #e4e4e1）：原型源文件在这里用 `onText`，深色模式下声波按钮看不见，以 `tokens.json` 为准。
- 新增颜色 `glyph` 和用途名 `iconTile`（对 `highlight`）：列表行前面的浅金图标方块，见[设计规范第 54 条](../../../ui-ux-design-guide.md#apple-clients)。
- `avatar`、`options`、`chat`、`her` 这几段 `make-design-tokens.mjs` 现在还不读，不会生成 Swift 常量；做到这些页面时再把它们接进生成器。
- `avatar.wordmarkGap` 是 3（2026-11-25 按原型源文件改正，原先误写成 4）。
- 原有颜色的值一个没动，新增的只有上面的 `onSpeak`、`glyph`。

代码现在读的是第 2 版（`clients/apple/scripts/check-design.mjs` 的 `TOKENS_SOURCE`）。和第 2 版相比，这一版除了上面去掉的“今天”页和页签栏的值，还去掉了暂停的 Mac 和手表用的值：`mac`、`watch` 两段，`type` 里 `mac`、`watch` 开头的字号，`opacity.watchPressed`、`opacity.watchHalo`，以及没有页面再用的 `type.upcomingTime`、`icon.whyChevron`。
