---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
covers: "apps/control-center/index.html, apps/control-center/src/chat-layout.css, apps/control-center/src/components/answer-footer.tsx, apps/control-center/src/components/chat-composer.tsx, apps/control-center/src/components/memory-page.tsx, apps/control-center/src/components/memory-panel.tsx, apps/control-center/src/review-v4.css"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0096：手机对话页：避开 iPhone 底部横条、去掉灰色横条、回答下方一行只留必要信息

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [灰色横条和贴底的原因](#root-causes)
- [参考过的资料和开源项目](#references-checked)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)
- [后续说明（2026-10-28）](#follow-up-2026-10-28)

<a id="context"></a>

## 背景

2026-10-27 13:24（日本时间），Andy 在 iPhone 上把 Himawari 加到主屏幕后打开（这种从主屏幕打开、不带浏览器地址栏的网页叫 PWA，渐进式网页应用），截图并用语音提了六条意见。协调者整理后原话要点如下：

1. 回答下面那一行太乱，不要显示模型名：用户在输入框里已经选过模型了。
2. 复制只留图标，不要文字。截图上“复制”两个字被挤成了竖排。
3. 不要在对话里展开记忆内容，只给一句简短提示和一个链接，点了跳到记忆页，看到写入的是哪一条。
4. 去掉输入框上方那条难看的深灰色横条。
5. 输入框离手机底边太近。
6. 发送按钮太丑：“你就不能改成和电脑端一样吗？而且……你设计的好看一点”。

原型 <https://claude.ai/artifact/BGa1vxG7DHy9GQKBQLatSS> 上 Andy 批注记忆提示“一块再放小一点。现在太大了，有点太抢用户的注意力了”，改成一行小字后，13:49 回复“最新的这一版本原型我审核通过了”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **回答下方一行只留“复制图标、⋯、用时 · 时刻 · token 数”。** 不再显示模型名，手机和电脑都一样。这一条改变了 [ADR 0090](0090-chat-ui-v6-answer-and-composer.md#decision) 第 1 条里“模型 · 用时 · 时刻 · N tokens”的写法，其余不变。复制按钮只有图标，读屏软件读“复制回答”，鼠标悬停仍提示“只复制上面的回答正文，不含来源和文件”。按钮不再被压缩，所以不会再挤成竖排。
2. **记忆只给一行小字。** 回答下方显示书签图标和“记下了 N 条新记忆 · 查看”，12px 灰字，没有边框和强调色。点这一行打开设置里的记忆页，并把这一轮记下的那几条放在最上面：标“刚记住”，写“来自对话‘标题’，时刻 记下”，可以直接编辑或删除。其余记忆照原样显示。侧栏的“记忆”入口打开时不带这一段。
3. **对话区不能横向拖动。** 对话区（`.chat-scroll`）明确设为 `overflow-x: hidden`。代码块、表格这些本来就宽的内容各自在自己的框里横向滚动，不受影响。
4. **避开 iPhone 的刘海和底部横条。** 网页的 `viewport` 加 `viewport-fit=cover`，整页铺满屏幕，再用 `env(safe-area-inset-*)`（浏览器给出的“被刘海、圆角、底部横条挡住的宽度”）给页面上、左、右留边，给输入框下方留出底部横条的高度再加 8px。侧栏抽屉、右侧详情和外观面板的顶部位置也加上同样的上边距。
5. **发送按钮改成圆形。** 电脑和手机都是 34px 的圆；手机上点按区域是 44px（苹果建议的最小点按尺寸），圆在中间。没写内容时是浅灰底灰色箭头，可以发送时是深色底白色箭头，正在回答时同一个圆里显示停止方块。箭头和方块改成图形，不再用文字字符“↑”“■”。读屏名称仍是“发送”和“停止”，发布走查测试依赖这两个名字。
6. 新加的文字都有中文、英文和日文。

[↑ 返回阅读导航](#contents)

<a id="root-causes"></a>

## 灰色横条和贴底的原因

- **贴底（已由代码确认）。** `apps/control-center/index.html` 的 `viewport` 没有 `viewport-fit=cover`，CSS 里输入框也没有用 `env(safe-area-inset-bottom)`。手机样式里给输入框留下边距的规则（`chat-layout.css` 的 `margin: 0 12px 12px`）又被后加载的 `review-v4.css` 的 `.composer { margin: 12px auto 0; }` 盖掉，下边距实际是 0。所以输入框贴着屏幕底边，被 iPhone 底部横条挡住一部分。
- **灰色横条（推断，未在 iPhone 上实测）。** 横条正好在对话区底边、和对话区一样宽，粗细和颜色与 iOS 的滚动条一致。对话区只写了 `overflow-y: auto`，按 CSS 规则，另一方向写的是 `visible` 时会被当成 `auto`（见下面 MDN 的引文），所以只要有一点内容比屏幕宽，对话区就能横向拖动，iOS 就在底边显示横向滚动条。当时回答下面那一行比屏幕宽：Chromium 里测到 token 数的右边到了 399px，屏幕宽 390px。内容只比屏幕宽一点点，所以滚动条几乎和屏幕一样长。这台机器上只有 Chromium，没有 iOS 的 Safari 内核，所以没能在真机内核上复现；修法是把对话区横向滚动关掉，同时去掉那一行的超宽内容。上线后需要在 iPhone 上看一次。

[↑ 返回阅读导航](#contents)

<a id="references-checked"></a>

## 参考过的资料和开源项目

- WebKit 官方博客《Designing Websites for iPhone X》：`viewport-fit` 默认是 `auto`，“Content is automatically inset within the display's safe area”（内容自动缩进到安全区里）；要铺满整屏需要设 `viewport-fit=cover`，再用安全区变量给内容留边。<https://webkit.org/blog/7929/designing-websites-for-iphone-x/>
- MDN 的 `overflow` 页：“`overflow-x`: as specified, except with `visible`/`clip` computing to `auto`/`hidden` respectively if one of `overflow-x` or `overflow-y` is neither `visible` nor clip”。<https://developer.mozilla.org/en-US/docs/Web/CSS/overflow>
- Open WebUI（开源的 AI 对话网页）src/app.html 的 `viewport`：`width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content`。<https://github.com/open-webui/open-webui/blob/main/src/app.html>
- LibreChat（另一个开源 AI 对话网页）client/index.html 同样用 `apple-mobile-web-app-status-bar-style` 为 `black-translucent`。<https://github.com/danny-avila/LibreChat/blob/main/client/index.html>

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **不加 `viewport-fit=cover`，只给输入框加固定下边距（例如 34px）**：在没有底部横条的手机和电脑上会多出一截空白，而且不同机型横条高度不同。不选。
- **只去掉超宽内容，不关对话区横向滚动**：这次的超宽来自回答下面那一行，但以后别的元素超宽还会出现同样的横条。对话区本来就不该横向滚动，所以两处都改。
- **记忆提示保留可展开的灰框**：Andy 明确要“不要在对话里显示记忆内容”，并说灰框“太抢用户的注意力”。不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：手机上输入框离开底部横条；不再出现横向滚动条；回答下面一行一眼能看完；记忆提示不抢注意力，点一下就能看到、改、删刚记下的那条。
- 代价：模型名不再出现在回答下方。想知道某一轮实际用了哪个模型，要展开过程区看。
- 灰色横条的原因是推断，见[灰色横条和贴底的原因](#root-causes)；第十五版上线后在 iPhone 上确认。
- 测试：`apps/control-center/test/answer-footer.unit.test.ts` 改为检查回答下方没有模型名、复制按钮的读屏名称；`test/memory-interactions.unit.test.ts` 检查记忆提示文字、点“查看”带上那条记忆的编号、记忆页把它放在最上面并能删除。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0090-chat-ui-v6-answer-and-composer.md]
- [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md#v7-phone-chat-page]
- [SOURCE: docs/engineering-casebook.md#case-ios-safe-area-scrollbar]
- 原型：<https://claude.ai/artifact/BGa1vxG7DHy9GQKBQLatSS>
- 实现截图：[docs/assets/control-center/2026-10-27-v7/](../assets/control-center/2026-10-27-v7/SHA256SUMS)
- 代码：`apps/control-center/index.html`、`apps/control-center/src/components/answer-footer.tsx`、`apps/control-center/src/components/memory-panel.tsx`、`apps/control-center/src/components/memory-page.tsx`、`apps/control-center/src/components/chat-composer.tsx`、`apps/control-center/src/chat-layout.css`、`apps/control-center/src/review-v4.css`

[↑ 返回阅读导航](#contents)

<a id="follow-up-2026-10-28"></a>

## 后续说明（2026-10-28）

本记录不改动上面的决定。[ADR 0105](0105-ui-batch-2026-10-28-show-what-the-owner-needs.md) 把回答下方一行里的用时和 token 移回过程区，这一行只留操作（复制、从这里开新对话），时刻悬停才显示，触屏设备上一直淡淡显示。不显示模型名、安全区留边、一行记忆说明和圆形发送按钮等其余决定继续有效。

[↑ 返回阅读导航](#contents)
