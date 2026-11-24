---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-12"
---

# 苹果客户端界面基线第 3 版

这个目录是 iPhone、Apple Watch、Mac 客户端界面现在照着做的一版，取自在线原型第 46 版（<https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme>，2026-11-12）。规则写在[详细设计的“界面照哪一版做”](../../../execution/specs/2026-11-11-apple-device-body-design.md#ui-baseline)和[设计规范的“苹果客户端”一节](../../../ui-ux-design-guide.md#apple-clients)；图和文字对不上时以文字为准，并告诉设计线程。

## 目录里有什么

- `01` 到 `11`：单屏的图，390 × 844 点，两倍清晰度（手表那张是 860 × 420 点）。
- `12` 到 `27`：一块画板一张图，一倍清晰度，画板上每部手机宽 390 点。要量准确的数值，看 `tokens.json` 和 `source/`。
- `tokens.json`：颜色、圆角、尺寸、字号、图标线宽，浅色深色两套。客户端的数值只从这里来。
- `source/`：原型的源文件和画板清单 `canvas.json`。它们要在在线原型里才能打开，单独用浏览器打不开；放在这里是为了查数值和留底。
- 内容都是示例数据。

## 每张图是什么，Andy 看过没有

“认可”指 Andy 看过这一屏并说了可以；“补画”指设计线程后来画的，Andy 没有逐屏看过（2026-11-12 他定了补画的屏由设计线程照已认可的样子定，见 [ADR 0258](../../../adr/0258-each-apple-device-plays-to-its-strength.md) 决定第 9 条）。

| 图                                      | 画的是什么                                                                                 | 源文件                 | Andy 看过没有                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `01-today.png`                          | “今天”页首屏                                                                               | `Main.dc.html`         | 认可（2026-11-12 17:43：“可以，我看了，就先这样吧。这一版原型先这样”）                                                     |
| `02-chat-list.png`                      | 对话列表                                                                                   | `Main.dc.html`         | 认可（2026-11-12：“可以，就按照最新版原型做”），之后换成了选定的图标                                                       |
| `03-chat.png`                           | 一个对话                                                                                   | `Main.dc.html`         | 同上；之后改了两处，见下面“认可之后改过的地方”                                                                             |
| `04-memory.png`、`05-memory-detail.png` | 记忆页、一条记忆                                                                           | `Main.dc.html`         | 同 `02`                                                                                                                    |
| `06-search.png`                         | 搜索                                                                                       | `Main.dc.html`         | 同 `02`                                                                                                                    |
| `07-settings.png`                       | 设置                                                                                       | `Main.dc.html`         | 同 `02`                                                                                                                    |
| `08-voice.png`                          | 按下圆钮说话                                                                               | `Main.dc.html`         | 同 `02`                                                                                                                    |
| `09-pairing.png`                        | 第一次配对                                                                                 | `Pairing.dc.html`      | 同 `02`                                                                                                                    |
| `10-lock-screen.png`                    | 锁屏通知和收听状态                                                                         | `LockScreen.dc.html`   | 同 `02`；之后改了按钮上的字                                                                                                |
| `11-watch.png`                          | 手表四屏                                                                                   | `Watch.dc.html`        | 同 `02`；之后改了一个按钮的字                                                                                              |
| `12-today-states.png`                   | “今天”页六种状态：首屏、就地展开、定完一件、往下滑、没有要管的事、完整的感知记录           | `TodaySun.dc.html`     | 认可（和 `01` 同一次）                                                                                                     |
| `13-pairing-flow.png`                   | 配对的后几步和出错时                                                                       | `PairingFlow.dc.html`  | 补画                                                                                                                       |
| `14-chat-states.png`                    | 对话的各种状态                                                                             | `ChatStates.dc.html`   | 补画                                                                                                                       |
| `15-approvals-and-reminders.png`        | 全部审批、一件审批的详情、处理过的、提醒记录                                               | `TodayMore.dc.html`    | 补画                                                                                                                       |
| `16-memory-more.png`                    | 改记忆、来源、规则、整理记忆                                                               | `MemoryMore.dc.html`   | 补画                                                                                                                       |
| `17-settings-more.png`                  | 设置里的各页                                                                               | `SettingsMore.dc.html` | 补画                                                                                                                       |
| `18-himawari-self.png`                  | 设置里“Himawari 自己”一组                                                                  | `HimawariSelf.dc.html` | 补画。派出去的帮手、代码和文件夹、服务器明细这三页 iPhone 上不做（ADR 0258 决定第 3 条），画板上已拿掉，服务器只留一行状态 |
| `19-senses.png`                         | 让 Himawari 感知                                                                           | `Senses.dc.html`       | 补画                                                                                                                       |
| `20-each-device.png`                    | 每一端做什么：iPhone、手表、Mac、随身麦克风，和它们怎么接力                                | `Roles.dc.html`        | 补画（照 Andy 2026-11-12 20:52 说的各端分工画的）                                                                          |
| `21-proposals.png`                      | 它的提议在各端的样子                                                                       | `Proposals.dc.html`    | 补画                                                                                                                       |
| `22-gaps.png`                           | Safari 里交给它、本事的停用和重新启用、随身麦克风、让它看屏幕                              | `Gaps.dc.html`         | 补画                                                                                                                       |
| `23-listen.png`                         | 收听和随口叫它、晚上不打扰                                                                 | `Listen.dc.html`       | 补画                                                                                                                       |
| `24-small.png`                          | 八处小的：隐私两行、设备改名、码失效、连服务器前确认、规则提议、用量的总量、来源原文、停了 | `Small.dc.html`        | 补画                                                                                                                       |
| `25-tell.png`                           | “告诉你一声”和“之后要告诉你的”                                                             | `Tell.dc.html`         | 补画                                                                                                                       |
| `26-dark.png`                           | 深色版五屏                                                                                 | `Dark.dc.html`         | 补画；颜色是 Andy 认可过的那一套深色                                                                                       |
| `27-process-row.png`                    | 对话里“它正在做什么”那一行和 40 个动作图标                                                 | `LoopSteps.dc.html`    | 认可（2026-11-12：“这四十个图标我很喜欢，设计风格我很喜欢”）；之后改了做完那一行的写法                                     |

## 认可之后改过的地方

这几处是 Andy 认可之后、设计线程按后来定下的规则改的，改动都小，版式没动：

- 提议的否定按钮统一写“不用”（原来首页、锁屏、手表上写“不改”）。依据是 Andy 2026-11-12 21:23 同意的提议方案：否定按钮全系统只有这一个词。
- 审批的肯定按钮写会发生的事：对话里那张卡由“同意”改成“发出去”。锁屏上要本人在场的那一条由“看内容再发”改成“看内容再定”。
- 过程行做完后那一行由“看了日历、路线、天气 · 8 秒”改成“做了 4 件事 · 8 秒”，4 就是点开后列出的步数。`../2026-11-12-process-row/` 里那张图画的还是旧写法，以这里的 `27` 为准。
- 顶部淡出改成从屏幕顶到 102 点是实心底色，102 到 134 淡到透明。
- 回答的字重由 500 改成 400（宋体-简没有 500 这一档，画出来和原来一样）。

## 和第 2 版相比，`tokens.json` 改了什么

- `size.fadeTop` 由 110 改成 134，新增 `size.fadeTopSolid` 102。
- `size.pairingMark` 由 140 改成 148，新增 `size.markDiscRatio` 0.92（向日葵花盘占框的比例）。
- `type.answer` 的字重由 500 改成 400；新增 `type.wordmark`、`type.todayTop`。
- `icon` 新增 `todayTab`、`newChat`、`speak`、`speakSize`、`strokeSpeak`、`expand`、`collapse`、`todayTop`。
- 颜色新增 `successRing`（“正在感知”绿点的外圈）和 `highlight`（来源原文页里标出被引用的那句话），浅色深色各一个值。别的颜色一个没动。
- 新增 `home` 一段：“今天”页的边距、间距和左上角那片光。

## 不照着做的文件

`source/` 里这几个文件只作记录，不照着做：

- `Mac.dc.html`：旧的 Mac 菜单栏，已被 `Roles.dc.html` 取代。
- 当时给 Andy 选的几块候选画板，括号里是选定的结果：`IconChoices.dc.html`（列表图标选了 Tabler 线条款）、`TabIcons.dc.html`（“今天”用日历带当天几号，“新对话”用对话气泡加号）、`StepIcons.dc.html`（过程行七个图标）、`TodayHero.dc.html`（选了丁）、`TodayBrand.dc.html`（字样选了衬线斜体）、`FuseIcon.dc.html`（“在设备上做”选了 2）。选定的结果都已经画进上面各张图里。
