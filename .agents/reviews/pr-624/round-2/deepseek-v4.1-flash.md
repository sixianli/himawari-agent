## 结论范围

本轮只看 `7b6f99ab..9bb9de01` 的增量：`README.md`、`tokens.json`、`2026-11-11-apple-device-body-design.md`、`ui-ux-design-guide.md`，以及同批复核记录（记录文件读不到，见下）。对照读了 `make-design-tokens.mjs`、`check-design.mjs`、`test/tooling/apple-design-check.test.mjs`、第 2/3 版 `tokens.json`，以及 `source/` 下的 `NextChat`、`NextChatMore`、`NextLists`、`NextSenses`、`NextMemory`、`NextSettings`、`NextEars`。没有运行 `node`（工具只允许读和 git），生成器是否读通是按代码逐行核对的。

## 上一轮意见核对

- 问题 3：只改好一半。新增 `headerFadeWithBackground`/`Solid` 与 `NextChat` 的 186/156 对得上，`chat.note` 也把 140/110 和 134/102 分开了；但规范里的主界面淡出仍写 102/134，见下面第 1 条。
- 问题 1：改好了。`handover.note` 列的 8 个字段都能在 `NextSenses` 最后一屏找到对应值：sheet `gap:18`、关闭图标 18、卡片/输入框 `padding:14px 16px`、输入框 `min-height:96`、`border-radius:22`、说明 `padding:0 8px`、按钮 `font-size:17`；其余字段明确写“沿用第 2 版”。
- 问题 5：改好了。`quoteBar`、`quoteGap`、`codePadding` 已从 `chat` 删除，全仓搜索没有引用；README 和 `chat.note` 都改成“不给数值，由设计线程定”。

## 意见

### 1、中、规范里的主对话顶部淡出仍写 102/134，与第 4 版源文件和新的 `chat.note` 冲突

文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:206`；`docs/assets/apple-clients/2026-11-25-v4/tokens.json:279-283`

问题：第 1 轮问题 3 只改了 tokens，没有改规范这一句。规范说主界面顶部“实心到 102 点、102 到 134 淡到透明”，并点名 `size.fadeTopSolid`、`size.fadeTop`；但第 4 版主对话源文件是 186/156，无“后台在办”的主对话状态是 140/110，134/102 反而出现在 `NextSettings` 这种带返回按钮的页面。新 `chat.note` 也把 `size.fadeTop` 归给“子线程这类带返回按钮的页面”。实现者按规范做会取错值。上一轮问题 3 没有完全改好。

证据：

- 规范：“顶部的淡出：从屏幕顶到 102 点（顶上头像的下沿附近：头像从 52 点起、高 48 点，`tokens.json` 的 `avatar`）是实心的底色，102 到 134 淡到透明（`tokens.json` 的 `fadeTopSolid`、`fadeTop`）。”
- `tokens.json`：“有那一条时用 headerFadeWithBackground、headerFadeWithBackgroundSolid（原型第 1 排，NextChat.dc.html）；子线程这类带返回按钮的页面用 size.fadeTop、size.fadeTopSolid”。
- `NextChat.dc.html:78`：`padding: 186px 20px 116px`、`height: 186px; background: linear-gradient(to bottom, var(--bg) 156px, transparent)`。
- `NextChatMore.dc.html:131`：`height: 140px; ... var(--bg) 110px`。
- `NextSettings.dc.html:78`：`height: 134px; background: linear-gradient(to bottom, var(--bg) 102px, transparent)`，同屏有 `aria-label="返回"`。

建议：把规范这句改成三种情况（有/无“后台在办”用 `chat.headerFade*`，带返回按钮用 `size.fadeTop*`），或至少不再把 102/134 说成主对话的淡出。

### 2、低、规则仍说“对话里的图标颜色跟旁边的字走”，没有写 speak 按钮的 `onSpeak` 例外

文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:205`；`docs/ui-ux-design-guide.md:142`；`tokens.json:174`；`README.md:45`

问题：新增 `onSpeak` 的理由就是不能跟 `onText`/文字色走，否则深色下看不见；但规范/设计规则仍写“对话里的图标颜色跟旁边的字走、不加底”。按字面实现，浅色下文字色 `#252921` 和 speak 底色 `#252921` 相同，声波会消失。README 写“以 `tokens.json` 为准”，但没有看到对应的设计线程确认记录（记录文件我读不到，标未核实）。

证据：

- 规范 205：“对话里的图标颜色跟旁边的字走、不加底”。
- 设计规则 142：“对话里（过程行、输入条、选项）的图标颜色跟它旁边的字走，不上色、不加底色块”。
- `tokens.json` 174：“onSpeak：speak 深色圆底上的图标（声波、发送、停止）…原型源文件里用的是 onText，深色模式下图标和圆底几乎一样黑，看不见，以这里为准”。
- `tokens.json:7,22`：light `text` 与 `speak` 都是 `#252921`。

建议：在规范/规则里补一句：输入条右下角深色 speak 圆底上的图标用 `color.onSpeak`，不跟旁边文字；并把这次偏离原型的决定记到设计线程。

### 3、低、README 说“颜色一个没动”，但增量新增了两个颜色

文件:行：`docs/assets/apple-clients/2026-11-25-v4/README.md:49`；`README.md:45-46`；`tokens.json:25-26,49-50`

问题：同一节前面刚写“新增颜色 `onSpeak`”“新增颜色 `glyph`”，结尾又写“颜色一个没动”，自相矛盾。第 3 版 tokens 里确实没有 `onSpeak`、`glyph`。

证据：

- README 45：“新增颜色 `onSpeak`…”。
- README 46：“新增颜色 `glyph` 和用途名 `iconTile`…”。
- README 49：“颜色一个没动。”
- 第 3 版 `tokens.json` 的 `color.light` 只有 `successRing`、`highlight`，没有 `glyph`/`onSpeak`。

建议：改成“原有颜色值一个没动，新增 `onSpeak`、`glyph` 两个颜色”。

### 4、低、第 4 版 tokens 能否被生成器读通没有自动检查，`colorUse` 反例也没测

文件:行：`clients/apple/scripts/check-design.mjs:20`；`test/tooling/apple-design-check.test.mjs:73-85,110,169`；`clients/apple/scripts/make-design-tokens.mjs:54`

问题：本次改动的核心目标之一是“第 4 版 `tokens.json` 能被 `make-design-tokens.mjs` 读通”，但现有检查只读第 2 版；测试用手写的小对象和临时第 2 版文件，没有任何测试真正加载第 4 版 `tokens.json`。`DESIGN_TOKEN_COLOR_USE_UNKNOWN` 这个反例也没有测试断言；以后有人往 `colorUse` 写入不存在的颜色名，直到手工运行生成器才会发现。

证据：

- `check-design.mjs:20`：`export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";`
- 测试 fixture 只有 `bg`、`fill` 等几个颜色（73-85 行），临时目录写的是 `2026-11-12-v2/tokens.json`（110、169 行）。
- 生成器 54 行：`throw new Error(\`DESIGN_TOKEN_COLOR_USE_UNKNOWN ${name}\`)`，但测试里没有对应 `toThrow`。

建议：加一条测试直接读 `2026-11-25-v4/tokens.json` 调 `generate`/`generateCss`；再加一条反例，把 `colorUse` 指向不存在的颜色并断言抛 `DESIGN_TOKEN_COLOR_USE_UNKNOWN`。

### 5、低、“她的页面和它下面各页的列表行都用 34 方块”说得太宽，源文件里仍有 26 无底图标；26 也从规则里消失了

文件:行：`docs/ui-ux-design-guide.md:142`；`tokens.json:143`；`source/NextSenses.dc.html:375`；`clients/apple/Sources/HimawariSenses/SensesView.swift:90`

问题：新规则说“她的页面”和它下面各页的列表行都用 34 点方块、19 点图标，同时删掉了原来的“列表行里 26 点”。但 `NextSenses`（从设置里的隐私进，属于她下面各页）的列表行仍是内联 26 点图标、没有 `.tile`；`icon.listRow: 26` 也仍被 `SensesView`、`HandoverSheet` 等代码使用。规则和源文件/代码不一致，后续做感知、分享、设置页时容易按错的尺寸做。

证据：

- 设计规则：“她的页面”和它下面各页的列表行前面，图标放在 34 点的圆角方块里（圆角 10，底色用途名 `iconTile`，图标 19 点、颜色 `glyph`…）。
- `NextSenses.dc.html:375`：`<div class="card rows"><div class="r"><svg aria-hidden="true" width="26" height="26"…`（没有 `class="tile"`）。
- `tokens.json:143`：`"listRow": 26`。
- `SensesView.swift:90`：`Icon(icon, size: DesignTokens.IconSize.listRow)`。

建议：把规则收窄成实际用方块的页面（`NextLists` 那几页），并保留“其他列表行 26 点”的说明，或逐页列出；不要把“它下面各页”一概而论。

### 6、低、`colorNotes` 把 `glyph` 说成只用于列表行方块图标，源文件还用它做 chip/tag 文字

文件:行：`tokens.json:173`；`source/NextChat.dc.html:69,73`；`source/NextMemory.dc.html:281,285`

问题：`colorNotes.glyph` 只写“列表行图标方块里的图标颜色”，但源文件里 `--glyph` 同时用于 `.chip.amber` 和 `.tag` 的文字颜色。以后页面用到 chip/tag 时，注释会误导人以为不能用这个颜色。数值本身没错，属于说明不全。

证据：

- `tokens.json` 173：“glyph：列表行图标方块里的图标颜色（原型 CSS 里叫 --glyph）”。
- `NextChat.dc.html:69`：`.chip.amber{background:var(--tile);color:var(--glyph)}`；73 行：`.tag{…background:var(--tile);color:var(--glyph)…}`。
- `NextMemory.dc.html:281,285` 同样的用法。

建议：把注释改成“列表行方块图标、chip/tag 文字等 `--glyph` 用法”，或确认第 4 版不画 chip/tag。

## 侧重检查

- 错误路径：只查了生成器唯一的运行时错误路径 `parseColor`、`identifier`、`DESIGN_TOKEN_COLOR_USE_UNKNOWN`、`DESIGN_TOKEN_THEMES_DIFFER`。新增的 `onSpeak`/`glyph` 都是合法 6 位 hex，light/dark 键集合一致；`iconTile` 是合法标识符且目标 `highlight` 存在；`handover.note`、`chat.note`、`colorNotes` 要么不被读，要么被 `scalars` 按非数字跳过。按代码看不会触发错误（未实际运行）。
- 不合规范或不可信的输入：`tokens.json` 是仓内受控文件，不来自用户或网络。生成器把键名送进 Swift 前有 `identifier()` 白名单；新增键名和 `iconTile` 都通过。`handover.note` 不被输出，不会有字符串注入。未发现新的外部输入面。
- 安全：没有新增网络、认证、密钥或权限；没有把用户数据写进日志。未发现安全问题。
- 资源耗尽：只解析一个小 JSON 文件，没有循环放大或外部递归；本次 PR 本身不运行生成器。不涉及。
- 不可撤销的操作：纯文档/素材改动，没有删除、迁移、写生产数据。不涉及。
- 规则/文档/代码一致：发现第 1、2、3、5、6 条；第 4 条是缺少自动检查。第 4 版 tokens 与第 2 版逐字对比的 `senses`、`handover`、`type.rowAction`、`type.senseTitle`、`type.senseTime`、`size.pillSmall`、`icon.todayRow` 确实一致；`wordmarkGap:3` 与 `NextChat.dc.html:78`、`NextChatMore.dc.html:131` 的 `gap: 3px` 一致。

## 未核实 / 推测

- “原型从第 53 版起列表行就是方块底”是历史说法，仓库里只有第 64 版源文件，无法核实。
- “原型源文件在这里用 `onText`”这句：CSS 变量里 `dark --ontext:#1e1e1e`、`--speak:#0c0c0c` 已读到；“声波按钮实际取 `--ontext`”所在行是超长单行，读工具截断，未逐字看到该元素的 `color` 声明，标未核实。
- Andy 是否看过、是否同意 `onSpeak` 偏离原型，属外部记录，未核实。
- 未运行 `node`，所以“生成器读通”是静态核对结论，不是执行结果。
- 仓内 `.agents/reviews/pr-624/...` 记录文件被 git 拒绝（`REVIEW_GIT_REFUSED records-path`），没有读。

## 必答问题

1. 不涉及。这次只改设计素材、`tokens.json`、设计规范和详细设计文档，没有任何构造模型请求的代码或配置（系统提示、工具定义、历史消息、遮盖结果都没动），不存在“请求开头变化”或“每轮变值不在最后一条消息”的问题。
2. 不涉及。没有运行时序列化；`tokens.json` 是静态文件，不会因为请求前后文变成不同字节。新增颜色/尺寸只影响以后生成 Swift/CSS 常量，不影响模型请求。
3. 没有对应自动检查。现有测试只覆盖第 2 版和手写 fixture；第 4 版 `tokens.json` 是否能被生成器读、`colorUse` 指向不存在颜色时是否真的报错，都没有测试。见第 4 条。
4. 逐个核对：`onSpeak`、`glyph` 由 `make-design-tokens.mjs` 的 `generate`/`generateCss` 消费，`parseColor` 接受，light/dark 键一致；`iconTile` 由 `generate` 消费，目标是已存在的 `highlight`，名字合法且不与颜色名冲突；`colorNotes` 不被任何代码读；`handover.note` 是字符串，`scalars` 会跳过，不会生成 Swift/CSS；`chat.headerFadeWithBackground*` 因为 `chat` 段还没接进生成器，当前没有消费者；删掉的 `quoteBar`/`quoteGap`/`codePadding` 全仓无引用。直接使用端本身都能接受。不一致在文档层：规范淡出与 `chat.note` 冲突（第 1 条）、规则没写 `onSpeak` 例外（第 2 条）、README“颜色没动”与新增颜色矛盾（第 3 条）、列表行 26/34 的规则和源文件不一致（第 5 条）。
