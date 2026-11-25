---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "apps/control-center/src/spreadsheet-model.ts, apps/control-center/test/file-preview-info.unit.test.ts, apps/control-center/test/spreadsheet-model.unit.test.ts, packages/platform-node/src/http-gateway-server.ts, scripts/test-file-preview-browser.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0114：右侧文件预览在浏览器里直接显示 PDF、Word 和 Excel（pdf.js、docx-preview、ExcelJS），不在服务器上装 LibreOffice

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [安全和样式：在主站安全策略下怎么显示 Word](#csp)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 网页右侧的文件预览栏（[ADR 0091](0091-chat-ui-v6-file-preview-and-sidebar.md)、[ADR 0100](0100-conversation-more-panel-files-and-background-commands.md)）能显示 Markdown、CSV、代码、图片和网页；PDF 用浏览器自带的查看器嵌在内嵌框（iframe，网页里再嵌一个网页）里显示；模型写出的 Word（`.docx`）和 Excel（`.xlsx`）文件只显示“这种文件不能在这里预览，可以下载后打开”。

2026-10-29，Andy 在“今日日本新闻头条写入 Word”这一轮里点开生成的 `.docx`，看到的只有这句话（UI 第二批第 31 条）。他要求：“无论是 txt 或者是 pdf 或者是 word 文档或者是 excel，就是你去看一下开源的预览工具里面，显示效果最好、用户体验最好的是哪一些？然后给我看看效果吧，然后我再决定用哪一个。”

预览线程把 9 个方案放进同一个演示页，用同一批含中文、日文、英文的样例文件现场渲染，给 Andy 对比（[演示页](https://claude.ai/artifact/SynoPMSH6rM5K9QLLHbcKV)）。Andy 看完先问“LibreOffice 既然效果这么好为什么不用？”，听完代价后于 2026-10-29 15:41（日本时间）回复：“可以，那就按照你的推荐来做”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

- **PDF：** 用 pdf.js（Mozilla 的开源 PDF 渲染库，项目已经依赖 `pdfjs-dist` 6.4.299）在预览栏里逐页画到画布（canvas）上，按栏宽铺满，叠一层透明文字层让文字能选中复制；只有滚到附近的页才画。不再用浏览器自带的 PDF 查看器。
- **Word（`.docx`）：** 用 docx-preview 0.4.1 把文件转成带页面的网页，保留分页、页眉页脚、表格底色、图片，按栏宽整体缩放。
- **Excel（`.xlsx`）：** 用 ExcelJS 4.4.0 读文件，Himawari 自己画成网页表格（`apps/control-center/src/spreadsheet-model.ts` 和 `document-preview.tsx`），保留填充色、字体颜色和粗细、边框、合并单元格、列宽、行高、数字格式（百分比、千分位、货币符号、日期）、冻结的表头行和多个工作表；最多显示前 2000 行、100 列，超出时提示下载。
- **文本、Markdown、CSV、代码、图片、网页：** 保持原样。
- 三个库都只在打开对应文件时才下载（按需加载的代码块），不打开就不加载；文件仍只从本站读文件接口读取，不交给任何外部服务。
- 文档和表格的“纸面”在深色主题下仍是白底，和 Word、Excel 本身一致；外框、工作表标签和提示文字跟随主题。
- 文件超过 25 MB，或渲染失败时，显示三语提示，可以下载后打开。旧格式（`.doc`、`.xls`）和 PowerPoint 暂不预览。

这个决定依据[产品愿景](../product-vision.md)里的“自有优先、数据自持”（文件不出 Andy 自己的服务器和浏览器）和“不堆集成”（不为预览单独部署一个文档服务）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

演示页里实际跑过的方案和结论：

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| pdf.js 逐页渲染 | 采用（PDF） | 已在依赖里；手机和电脑外观一致，能跟随主题；浏览器自带查看器的外观、语言和手机表现都不受我们控制 |
| docx-preview | 采用（Word） | 四个 Word 方案里最像 Word；压缩后约 49 KB（构建实测 48,738 字节） |
| mammoth | 不用 | 故意丢掉颜色、字号、页眉和分页，只留结构，看起来不像“这个文件” |
| ExcelJS + 自己画表 | 采用（Excel） | 样式全、格式对、文字可选中；画表代码自己写（约 200 行） |
| @js-preview/excel | 不用 | 百分比和金额格式丢失（显示成 0.2142857、4510000.5）；画在 canvas 上不能选中文字；界面文字写死中文 |
| SheetJS 社区版 | 不用 | 不读颜色、字体、边框；新版只在 SheetJS 自己的网站发布，npm 上停在 0.18.5 |
| 服务器上用 LibreOffice 转 PDF，再用 pdf.js 显示 | 暂不用 | 见下 |

没有放进演示的：OnlyOffice 文档服务器（社区版 AGPL-3.0 许可证，要单独部署一个很重的服务）、Collabora Online（同样要单独部署）、Univer（导入 `.xlsx` 要一个“转换后端”）、`@cyntler/react-doc-viewer`（Word 和 Excel 交给微软的在线查看服务渲染，只支持公开网址，违背数据自持）。

**为什么不用 LibreOffice（Andy 追问过）：** 它的 Word 还原度最高，但：生产机上没有装，装上约 313 MB，还要另装中日文字体，属于生产机上的新下载；每个文件第一次打开要多等约 1.3 秒（云端容器实测三次 1.43、1.27、1.31 秒），要做缓存；它把 Excel 按 A4 打印页切开，窄栏里字很小，所以 Excel 仍要另一个方案；它在服务器上打开可能来自网上的文件，要放进不联网的沙箱里跑。样例里表头的浅蓝底色它也没转出来，docx-preview 保留了。以后要支持 `.doc`、`.ppt` 这类老格式时再考虑。

[↑ 返回阅读导航](#contents)

<a id="csp"></a>

## 安全和样式：在主站安全策略下怎么显示 Word

主站的内容安全策略（Content Security Policy，浏览器按它拒绝不允许的脚本和样式）是 `style-src 'self'`、`img-src 'self' data:`，不允许网页里内嵌的 `<style>` 和 `blob:` 图片地址。docx-preview 默认把样式写进 `<style>` 元素、把图片做成 `blob:` 地址，直接用会变成没有样式、没有图片的白板。做法：

- 让 docx-preview 把 `<style>` 写进一个不挂在页面上的元素，再把这些样式文本做成“可构造样式表”（`new CSSStyleSheet()` 后 `replaceSync`），挂到预览框自己的影子根（Shadow DOM，一块和主页面样式互不影响的独立区域）上。这样 Word 的样式只作用在预览框里，也不会影响 Himawari 自己的界面。
- 图片改用 `data:` 地址（`useBase64URL: true`），主站策略已允许。
- 关掉“替代内容块”（altChunk，Word 里嵌入的整段 HTML），因为 docx-preview 会把它放进一个继承主站来源的内嵌框；文档里的链接只保留 `http`、`https`、`mailto`，并在新标签页打开。
- Symbol、Wingdings 字体的项目符号字符（例如 U+F0B7）在没有这些字体的设备上会显示成方框，渲染前换成普通的圆点、方块等字符。

测试脚本 `scripts/test-file-preview-browser.mjs` 从 `packages/platform-node/src/http-gateway-server.ts` 读出生产安全策略原文，套到页面上，在 Chromium 和 WebKit（Safari 的内核，Playwright 自带版本）里各跑中、英、日三种语言 × 电脑宽 1280、手机宽 390 共 6 组：PDF 两页都画出来且文字层能读到“千葉県”，Word 页面底色、表格边框、图片和三个项目符号都在，Excel 标题填充色、`¥1,250,000`、`35.7%` 和两个工作表标签都对，页面不横向滚动，没有被安全策略拒绝的加载。WebKit 截图时 Playwright 会注入一段样式并被策略拒绝，这是测试工具自己的行为，脚本只在截图那一刻忽略这类报错。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：Andy 在电脑和手机上都能直接看模型写的 Word、Excel、PDF；外观统一，跟随三语和主题；不改服务器、不加新服务。
- 代价：首页脚本压缩后从 306,735 字节增加到 312,232 字节（预览组件和表格模型）；打开 Word 时另外下载约 49 KB，Excel 约 256 KB（ExcelJS，构建实测 255,576 字节），PDF 约 128 KB 加 worker。ExcelJS 最近一次发布是 2023-10，读文件部分稳定，但以后要留意替代品。
- Excel 的主题色按 Office 默认主题换算，用了自定义主题的文件颜色可能略有出入；图表、图片、条件格式不显示。Word 只在手动分页处分页，不支持目录域。
- 后续：WebKit 测试不等于真 iPhone，下一次完整版本上线后请 Andy 在手机上打开一个 Word 和一个 Excel 看一眼；`.doc`、`.xls`、`.pptx` 仍只能下载。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0091：文件预览和侧栏](0091-chat-ui-v6-file-preview-and-sidebar.md) [SOURCE: docs/adr/0091-chat-ui-v6-file-preview-and-sidebar.md]
- [ADR 0100：“更多”栏、文件和后台命令](0100-conversation-more-panel-files-and-background-commands.md) [SOURCE: docs/adr/0100-conversation-more-panel-files-and-background-commands.md]
- [文件交付和“更多”栏产物页实施计划](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/plans/2026-10-28-file-delivery-and-more-panel-plan.md) [2026-10-28-file-delivery-and-more-panel-plan.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/plans/2026-10-28-file-delivery-and-more-panel-plan.md)
- [产品愿景](../product-vision.md) [SOURCE: docs/product-vision.md]
- [工程案例库：案例 58](../engineering-casebook.md#case-file-preview) [SOURCE: docs/engineering-casebook.md#case-file-preview]
- 浏览器测试：`scripts/test-file-preview-browser.mjs`；单元测试：`apps/control-center/test/spreadsheet-model.unit.test.ts`、`apps/control-center/test/file-preview-info.unit.test.ts`
