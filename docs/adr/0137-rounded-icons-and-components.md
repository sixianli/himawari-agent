---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "apps/control-center/src/components/glyphs.tsx, apps/control-center/src/rounded.css, apps/control-center/test/glyphs.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0137：全站图标和组件改用“圆润”造型：双色填充图标，浮起的卡片，胶囊按钮

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0136](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0136-soft-line-icons-and-components.md) 按方案 4“柔线”改了全站，还没合并上线。Andy 随后要看“如果所有组件按方案 1 圆润重新设计，整个界面是什么样”，线程在真实页面上换样式截了全部 13 个页面。2026-10-31 Andy 在[按自有品牌风格重做 iPhone 和 Mac 界面](#references)线程回复：“我很喜欢这一套设计方案。你必须把这一套所有的图标和组件继续完善，画得完美一点，然后把整套 UI 的设计风格应用到整个应用的 UI 里面，任何地方都要保持设计风格一致。包括图标在内，如果哪里需要加新图标，设计时必须以这一套风格为基础。”

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

采用方案 1“圆润”，替换方案 4“柔线”。原型和截图存为新基线 `docs/assets/control-center/2026-10-31-v15/`（`rounded-prototype.html` 第一节是方案 1，`glyph-sheet.png` 是全部图标在 20 像素和 44 像素下、浅色和深色里的样子）。规则：

1. **图标**：每个图标由两层组成，一层是半透明的浅色底形（浅色主题 24%、深色主题 26% 的不透明度），上面一层是实心的细节或 2 到 3.2 像素的圆头线条。不带底形的只有两类：勾、叉、箭头、加号、三个点、三条横线、停止方块这些随文字或在按钮里出现的小记号，以及照原型画成三个实心圆点加连线的“分出对话”。全部 59 个图标在 `apps/control-center/src/components/glyphs.tsx` 一个文件里，每一层的填色写在图标自己身上，页面上别处的样式改不掉。
2. **颜色**：侧栏入口、过程区的工具图标和文件类型小块里的图标用向日葵金色（浅色 `#c9870a`，深色 `#efb23c`）；其余图标跟文字同色。主题色和红、琥珀色的含义（规则 21）不变。
3. **组件不描边，靠底色和阴影分层**：侧栏（电脑上）、文件卡片、记忆卡片、提示条、菜单、弹窗浮在页面上，带柔和阴影；按钮一律胶囊形，主按钮是文字色实心，次要和危险按钮是浅灰底；选中的对话、侧栏入口、你发的消息气泡用浅灰底；分段选择和标签页是浅灰槽里浮起一块白色；开关是 51×31 的 iOS 式开关，打开是绿色；输入框和搜索框是浅灰底、无边框。深色主题里阴影看不出来，浮起的东西额外加一圈很淡的亮边。
4. **输入框**：一行高的胶囊，左边加号、中间文字、右边模型名和圆形发送按钮；手机上模型名放到第二行，让一行能放下提示文字。
5. **顶栏按钮**：回到圆形，白底带阴影，仍是左右两组、各自独立（规则 12 不变）。
6. **手机**：侧栏是离屏幕边 8 像素的浮动卡片，点外面的遮罩关闭（第 46 条，规则 42）；设置等弹窗从屏幕底部弹出，顶上有一条拖动条。
7. **尺寸**：小控件圆角 12 到 14 像素，卡片 18 像素，弹窗和输入框 26 像素，写成 `apps/control-center/src/rounded.css` 里的变量，这个文件最后加载。
8. **以后新增图标**：照 `glyphs.tsx` 里已有图标的画法，先画半透明底形，再画实心细节，放进同一个文件，不在组件里另画。
9. **自动检查**：`npm run check:layout` 用三个新检测换掉柔线的两个：`OUTLINED_CONTROL`（按钮、开关、标签页、卡片、输入框、弹窗出现了描边）、`GLYPH_FILL_LOST`（图标的底形或实心层被页面样式改成了空心）、`ICON_OUTSIDE_GLYPH_SET`（看得见的 24 格图标不是从 `glyphs.tsx` 来的）；`TEXT_GLYPH_ICON` 保留。自检页面各放一个反例。`apps/control-center/test/glyphs.unit.test.ts` 检查每个图标的每一层都自带填色、该有底形的都有底形。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保留柔线**：Andy 看过圆润的全站效果图后改选圆润。
- **只把柔线的颜色和圆角调一调**：Andy 此前已指出“换个颜色不就是换个主题吗”，图标画法和组件形状必须跟着换。
- **在截图用的临时样式上直接交付**：效果图是在页面上临时覆盖样式和图标做的，靠强制优先级压住旧样式，图标是运行时替换的；正式实现把图标写进组件、样式写进 `rounded.css`，去掉了这些临时手段。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- ADR 0136 被本 ADR 取代；[soft-line.css](https://github.com/sixianli/himawari-agent/blob/91d9b0896874b0e73c3cfadfc765c957305ab17d/apps/control-center/src/main.tsx) 改名为 `rounded.css` 并重写，line-icons.tsx 换成 `glyphs.tsx`。v14 基线作废，只留作历史。
- 圆润在 iPhone 和 Mac 真机上都还没看过；上线后需要 Andy 在手机上看一次侧栏、输入框和设置弹窗。
- 文件预览里 Excel 的工作表标签仍模仿 Excel 本身（规则 27），不按圆润改。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0136](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0136-soft-line-icons-and-components.md)：被本 ADR 取代的柔线方案
- [网页设计规范](../ui-ux-design-guide.md)：规则 12、23、41、42
- 讨论线程：按自有品牌风格重做 iPhone 和 Mac 界面（项目线程）；全站效果图 <https://claude.ai/artifact/Nc3DnUvMVun86kYsvzWDD8>

[↑ 返回阅读导航](#contents)
