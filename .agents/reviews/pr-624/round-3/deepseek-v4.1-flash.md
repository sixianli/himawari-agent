## 本轮查过的范围

- 增量：`git diff 9bb9de0..9458e6e`（9 个文件，实质改动是 4 个文档文件）。
- 整体：`git diff 075c8d4..9458e6e`，重点看 `tokens.json` 的颜色、`colorUse`、`colorNotes`、`chat`、`her`。
- 对照：v4 / v3 / v2 的 `tokens.json`，`clients/apple/scripts/make-design-tokens.mjs`、`check-design.mjs`、`test/tooling/apple-design-check.test.mjs`，以及 v4 `source/` 下的 NextChat、NextChatMore、NextLists、NextSenses、NextEars、NextMemory、NextVault。

## 意见

### 1、低、第 54 条把 onSpeak 的原因写成“浅色下和圆底同色看不见”，与 tokens 和 README 的“深色模式”相反

- 文件:行：`docs/ui-ux-design-guide.md:142`
- 问题：规则本身要求 speak 圆底上的图标用 `onSpeak` 是对的，但给出的理由写反了。真正看不见的是深色模式，不是浅色模式。
- 证据：
  - 指南原文：“只有输入条右下角深色圆底（`speak`）上的图标（声波、发送、停止）用 `onSpeak`，不跟字走，**否则浅色下和圆底同色看不见**。”
  - `tokens.json:43` 深色 `onText` 是 `#1e1e1e`，`tokens.json:46` 深色 `speak` 是 `#0c0c0c`，两者几乎一样黑；`tokens.json:49` 的 `onSpeak` 是 `#e4e4e1`。
  - 反观浅色：`tokens.json:19` 的 `onText` 是 `#fcfcfb`，`tokens.json:22` 的 `speak` 是 `#252921`，对比足够，不会“同色看不见”。
  - `tokens.json:174` 的 `colorNotes.onSpeak` 和 `README.md:45` 也都写的是“深色模式下……看不见”。
- 建议：把“浅色下”改成“深色下”，与 `tokens.json` 的 `colorNotes` 和 README 对齐。

### 2、低、第 4 版 tokens 的“能被 make-design-tokens 读通”没有自动检查

- 文件:行：`clients/apple/scripts/check-design.mjs:20`；`test/tooling/apple-design-check.test.mjs:110-113,133,169-173`
- 问题：本次目标之一是第 4 版 `tokens.json` 能被生成器读通，但现有检查仍指向第 2 版；没有任何测试加载第 4 版 tokens，也没有测试专门覆盖 `DESIGN_TOKEN_COLOR_USE_UNKNOWN` 这个反向用例。以后若有人再把说明放回 `colorUse`，CI 不会失败。
- 证据：
  - `check-design.mjs:20`：`export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";`
  - 测试夹具反复写入的是 `docs/assets/apple-clients/2026-11-12-v2/tokens.json`（如 `test/tooling/apple-design-check.test.mjs:112`、`:133`、`:171`）。
  - 用 grep 查 `2026-11-25-v4`，测试目录没有命中；只出现在文档里。
- 建议：加一个直接读 v4 `tokens.json` 调 `generate()` / `generateCss()` 的测试；再加一个构造坏 `colorUse`、断言抛 `DESIGN_TOKEN_COLOR_USE_UNKNOWN` 的反向用例。这样作者声称的“读通”才有回归保护。

## 上一轮意见核对

- 第 1 条（中高，主对话淡出仍写 102/134）：已改好。`docs/execution/specs/2026-11-11-apple-device-body-design.md:206` 已分成三种：110/140、156/186、102/134。对照源文件，`NextChatMore.dc.html:131` 是 `height: 140px; background: linear-gradient(to bottom, var(--bg) 110px, transparent)`；`NextChat.dc.html:78` 是 `height: 186px; ... 156px`；与 `tokens.json:279-283` 一致。
- 第 5 条（中高/低，34 方块说得太宽、26 从规则里消失）：已改好。指南 `142` 行已写明“感知、收听两排……仍是 26 点、不加底……（`icon.listRow`）”。源文件 `NextSenses.dc.html:375` 的列表行图标确实是 `width="26" height="26"`、无 `tile` 底；`NextEars.dc.html:489`、`519` 也仍有 26 点无底图标。`tokens.json:143` 的 `icon.listRow` 是 26。
- 第 2 条（低，规则没写 speak 的 `onSpeak` 例外）：已补上，但理由写反，见意见 1。
- 第 3 条（低，README 说“颜色一个没动”）：已改好。`README.md:49` 现在是“原有颜色的值一个没动，新增的只有上面的 `onSpeak`、`glyph`。”对照 v3/v4，v3 已有 `successRing`、`highlight`，本次新增的确实只有 `onSpeak`、`glyph`。
- 第 6 条（低，`colorNotes` 把 `glyph` 说窄了）：已改好。`tokens.json:172-173` 已补上 `chip.amber`、`tag`、`opt.act`。源文件 `NextChatMore.dc.html:118` 的 `.opt.act` 用 `var(--tile)`，`:122` 的 `.chip.amber` 和 `:126` 的 `.tag` 同时用 `var(--tile)` 和 `var(--glyph)`，两端对得上。

## 作者说法核对

- “补回的 senses、handover 等值与第 2 版逐字相同”：`senses` 的键和值逐项相同；`handover` 的**数值**也相同，但 v4 多了一个 `note` 字段，且键顺序不同，严格说不是整段“逐字相同”。
- “chat、her 两段量自 NextChatMore.dc.html、NextLists.dc.html”：`her` 与 `NextLists.dc.html:78` 对得上；`chat.headerFade` / `headerFadeSolid` 与 `NextChatMore.dc.html:131` 对得上；但 `chat.headerFadeWithBackground` / `headerFadeWithBackgroundSolid` 来自 `NextChat.dc.html:78`，不是 NextChatMore。`tokens.json:279` 自己写的也是 NextChat.dc.html，作者说法漏了这一处。
- “wordmarkGap 源文件是 gap: 3px”：已核实。`NextChatMore.dc.html:131` 和 `NextChat.dc.html:78` 的头像容器都是 `gap: 3px`，`tokens.json` 的 `wordmarkGap` 是 3。

## 侧重检查

- 错误路径：`make-design-tokens.mjs:52-56` 对 `colorUse` 的目标做 `lightNames` 校验；v4 的 `badge`、`streamingDot`、`iconTile` 三个目标都存在，`iconTile -> highlight` 能通过。`colorNotes` 不被生成器读取，不会触发 `DESIGN_TOKEN_COLOR_USE_UNKNOWN`。
- 不可信输入：本次增量是文档和 tokens 文本，没有新增外部输入解析。
- 安全：未新增可执行代码；新增的 `.agents/reviews/...` 是复核记录，未发现被应用代码读取，也未发现秘密。
- 资源耗尽：无新增循环、递归或大文件生成路径。
- 不可撤销操作：无。
- 文档与代码一致性：发现意见 1 的“浅色/深色”相反；其余第 1、5、2、3、6 条已修复。

## 读代码证实的

- `NextChatMore.dc.html:131`：`height: 140px; background: linear-gradient(to bottom, var(--bg) 110px, transparent)` 和头像容器 `gap: 3px`。
- `NextChat.dc.html:78`：`height: 186px; background: linear-gradient(to bottom, var(--bg) 156px, transparent)`。
- `NextLists.dc.html:78`：`padding: 58px 16px 40px`、`width: 76px`、`border-radius: 38px`、`font-size: 30px`、`width: 34px; height: 34px; border-radius: 10px`、`width="19" height="19" ... stroke-width="1.7"`。
- `NextSenses.dc.html:375`：列表行 `<svg width="26" height="26" ... stroke-width="1.6">`，没有 `tile` 容器。
- `NextChatMore.dc.html:118,122,126`：`.opt.act { background: var(--tile); ... }`、`.chip.amber { background: var(--tile); color: var(--glyph); }`、`.tag { background: var(--tile); color: var(--glyph); }`。
- `tokens.json:279-283` 的 `chat` 值、`:96-97` 的 `fadeTop`、`:143` 的 `listRow`、`:168` 的 `iconTile`、`:172-174` 的 `colorNotes` 均与上述源文件/生成器逻辑一致。

## 推测 / 未核实

- 没有实际运行 `node make-design-tokens.mjs`（工具限制），第 4 版“能读通”是按生成器分支逐段推出来的，未做实跑验证。
- `git log -S 'linear-gradient(to bottom, var(--bg) 110px'` 在历史上命中过 `NextVault.dc.html`。由于该文件正文是超长单行、read 在 2000 字处截断，我没读到这一处上下文，无法判断 NextVault 是否有“带返回钮的页面用 110/140”的例外；规范里“她的页面下面各页都用 102/134”这一点未逐屏核实。
- `.agents/reviews` 新增记录是否会被某个代理框架拼进模型请求，未核实；至少不在这批应用代码里。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本次增量只改文档和 `tokens.json` 文本，没有改系统提示、工具定义、历史消息或遮盖结果；新增的 `.agents/reviews` 是离线复核记录，不涉及产品请求“只在末尾追加”的规则。

2. **不会让同一段文字在不同请求里变成不同字节。** tokens 的值是静态字符串，JSON 键顺序固定，没有时间字段、随机值或依赖前后文的遮盖；文档增量也不参与请求序列化。

3. **没有对应的新自动检查；反向用例不会真的失败。** 见意见 2：`check-design.mjs` 和测试仍只读第 2 版，`DESIGN_TOKEN_COLOR_USE_UNKNOWN` 虽在生成器里有错误分支，但没有针对第 4 版或坏 `colorUse` 的测试。

4. **增量直接修改的值只有 `colorNotes` 文本和文档引用，没有代码消费端。** 新引用的 `chat.headerFade*`、`size.fadeTop*`、`icon.listRow`、`colorUse.iconTile`、`color.glyph`、`color.onSpeak` 在 `tokens.json` 中都存在；生成器对 `colorUse` 的校验能接受 `iconTile -> highlight`，`chat`/`her` 不被生成器读取这一点也与 README 一致。唯一的两端不一致是意见 1 的“浅色下”表述。
