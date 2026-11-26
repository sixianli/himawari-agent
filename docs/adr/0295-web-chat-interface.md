---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0095-silent-session-exchange-behind-cloudflare-access.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0087-chat-ui-v6-process-timeline.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0090-chat-ui-v6-answer-and-composer.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0091-chat-ui-v6-file-preview-and-sidebar.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0096-phone-chat-page-safe-area-and-quiet-answer-line.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0100-conversation-more-panel-files-and-background-commands.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0114-file-preview-pdf-word-excel-in-browser.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0137-rounded-icons-and-components.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md"
superseded_by: ""
date: "2026-11-26"
covers: "apps/control-center/src/execution-timeline.ts, apps/control-center/src/spreadsheet-model.ts, apps/control-center/src/components/glyphs.tsx, apps/control-center/src/rounded.css, apps/control-center/src/quiet-scrollbars.ts, packages/platform-node/src/http-gateway-server.ts, packages/platform-node/src/browser-thread-files.ts, packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts, scripts/check-layout-audit.mjs, scripts/check-control-center-build.mjs, scripts/render-brand-assets.mjs, docs/ui-ux-design-guide.md"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0295：网页对话界面的现行做法

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [过程区和回答下方](#process)
  - [附件](#attachments)
  - [模型写出的文件和后台命令](#files)
  - [文件预览](#preview)
  - [设置和分出的对话](#settings)
  - [手机](#phone)
  - [造型和标志](#look)
  - [过了 Cloudflare 验证后自动登录](#session-exchange)
  - [自动检查](#checks)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

网页对话界面（`apps/control-center`）的决定原来分散在十份 ADR 里：对话界面 v6 三期（0087、0090、0091）、手机页（0096）、“更多”栏（0100）、10-28 和 10-29 两批修改（0105、0110）、文件预览（0114）、圆润造型（0137）和 55 粒种子的标志（0283），后面的又改了前面的不少条。界面上的规则、Andy 批准过的设计和踩过的坑，已经逐条写在 [网页设计规范](../ui-ux-design-guide.md)；这份 ADR 只留下规范里没写、但会约束代码结构的决定，并把被改掉的部分去掉。旧文全文和当时的截图、原型说明在 `supersedes` 列的固定提交链接里。

2026-11-16 起客户端只专心做 iPhone，网页仍在用，改网页前照旧先读设计规范。

<a id="decision"></a>

## 决定

<a id="process"></a>

### 过程区和回答下方

- 过程区收起时一句话说做了什么和总用时，展开后每步只写这一步的耗时，最下面一行是 token 总数和“缓存命中 N%”（缓存读取 ÷（普通输入 + 缓存读取 + 缓存写入）），不显示费用。只有有内容可看的步骤才能展开。
- 时间由前端纯函数 `execution-timeline.ts` 从执行记录算出，服务端不另存一份。所有时刻用服务端记下的 `occurredAt`，不用浏览器收到事件的时间；Pi 适配器不把 `text_start`、`toolcall_start` 和其他增量合并，以便知道开始输出的准确时刻。
- token 数来自执行记录在每次模型调用结束时投影的 `runtime.usage`，不改执行记录合同。
- 步骤文字不由模型生成：每类步骤一个固定说法，后面跟真实数据（搜索词、文件名、条数）。
- 回答下方只放操作（复制、分出新对话），时刻悬停才显示，不显示模型名。复制只复制回答正文的 Markdown 原文。

<a id="attachments"></a>

### 附件

- 能加 PDF、Word、Excel、PowerPoint 和 UTF-8 文本文件，每个不超过 20 MB，一条消息最多 10 个；图片的做法见 [ADR 0093](0093-chat-attachments-images.md)。扫描件 PDF、旧版 Office 和其他二进制文件被拒绝并说明原因。
- 文件在浏览器里转成文字（PDF 用 pdf.js，Office 文件用 `fflate` 解压后取文字），超过约 25 万字截断并写明。解析不受信任的文件格式的风险留在用户自己的浏览器标签页里，服务端不装解析库。
- 文字经 `POST /api/payload/v1/attachment` 加密保存，登录、防伪造和幂等检查与消息正文相同。消息正文里每个文件只带一行 `<file name=… ref=… bytes=… kind=…/>` 引用，消息合同和数据库不改；标题生成和记忆提取也只看到这一行。
- 发给模型时，上下文投影只展开内容类型是附件的加密内容，解密绑定所有者和 agent；读不到时写“[附件无法读取]”，这一轮照常进行。

<a id="files"></a>

### 模型写出的文件和后台命令

- 产物登记表：模型写出或命令改出的每个文件一条记录（所属对话、轮次、来源工具或命令、路径、类型、大小、SHA-256、版本号、时间），同一路径再写一次就是新一版并存一份副本。卡片由登记表生成，不靠模型写；系统提示要求模型只写文件名、不写服务器路径。
- 读文件和下载接口在 Cloudflare Access 之后再验一次登录会话，只按登记表里的编号放行，不接受任意服务器路径。
- 模型写的网页文件一律在单独的预览域名里运行，只认短时有效、只对这一个文件有效的签名链接（`browser-thread-files.ts` 的 `previewOrigin`），拿不到主站的登录信息。
- 每段对话顶栏右边一个文件夹按钮，打开同一个栏，里面“产物”和“后台命令”两页，按轮次互相跳转；按钮上只显示正在运行的后台命令数。侧栏“文件”页跨对话列出 Himawari 做的文件和主人上传的文件（标“我上传的”）。后台命令最长跑 30 分钟，点“停止”不再确认。
- 不加堆放内部运行信息的通用面板。

<a id="preview"></a>

### 文件预览

- 预览在浏览器里画，不在服务器上装 LibreOffice：PDF 用 pdf.js 逐页画到画布并叠文字层，Word 用 docx-preview，Excel 用 ExcelJS 读出后由 `spreadsheet-model.ts` 画成表格（最多 2000 行、100 列）。三个库都按需加载，文件只从本站读文件接口读取。依据[产品愿景](../product-vision.md)的“自有优先、数据自持”：文件不出 Andy 自己的服务器和浏览器。
- Markdown 排版显示并带目录，CSV 显示成表格并给数字列合计，代码带行号，改过的文件多一个逐行“改动”页。超过 25 MB 或渲染失败时提示下载。

<a id="settings"></a>

### 设置和分出的对话

- 主人能改的每一项账户设置（称呼、界面语言、主题色等）存在服务端 `owner_preferences` 表，手机和电脑看到同一份；没送到服务器的本地改动下次打开先补发，不被旧值盖掉。设置只留主人会改的项。
- 分出的新对话带 `sourceThreadId` 和 `sourceWatermark`，顶部写明从哪段对话第几轮分出，并能打开原对话。

<a id="phone"></a>

### 手机

- `viewport` 带 `viewport-fit=cover`，用 `env(safe-area-inset-*)` 避开刘海和底部横条；对话区 `overflow-x: hidden`，宽内容各自在自己的框里横向滚动。
- 滚动条平时透明，正在滚动的区域临时加 `data-scrolling` 属性才上色（`quiet-scrollbars.ts`）。

<a id="look"></a>

### 造型和标志

- 全站一套“圆润”造型：图标是半透明底形加实心细节的双色图标，全部放在 `glyphs.tsx` 一个文件里，每层填色写在图标自己身上；组件不描边，靠底色和阴影分层，按钮是胶囊形；圆角等尺寸写成 `rounded.css` 里的变量。新图标照同样画法放进同一个文件。
- 标志是按黄金角排列的种子，种子数按显示大小取（小图点少、大图点多，见 [ADR 0308](0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md)）；首页大图和正在回答的标志会长新种子，系统开了“减少动态效果”时一律静止。网页标志、PWA 图标和苹果端的桌面图标都由 `render-brand-assets.mjs` 从同一份种子数学生成。
- 界面文字一律有中文、英文、日文三份。

<a id="session-exchange"></a>

### 过了 Cloudflare 验证后自动登录

- 登录方式是 `cloudflare-access` 时，网页读配置被拒（401、403）就自己调用一次换取接口拿 Himawari 登录，成功后直接进入对话，不要求点按钮。每次进入只自动换取一次，换取后仍被拒就停下来显示“暂时连不上”和“重试”。
- Cloudflare 登录过期时整页跳去 Cloudflare 的登录页。网络断开或服务在重启时显示“Himawari 暂时连不上”，5 秒后自动重试。这些页面不显示内部错误码，有中、英、日三种文字。
- 登录方式是 `built-in`（Himawari 自己的用户名、密码和验证器）时，仍显示登录表单。

<a id="checks"></a>

### 自动检查

- `npm run check:layout`（`check-layout-audit.mjs`）在真浏览器里把各页面按三种语言、两种宽度、浅色深色打开，发现横向滚动、元素超出屏幕、按钮被挡、文字被挤成竖排、浏览器原生下拉框、描边控件、图标不是来自 `glyphs.tsx` 等问题就失败，每次先用一页故意做坏的页面自检。
- `check-control-center-build.mjs` 不限前端体积，只报告；其余检查（不带调试映射、语言包分包、不许内联脚本和样式、不许 `eval`）保留。

<a id="rejected"></a>

## 放弃的做法

- 在服务器上解析附件或转换 Office 文件：要在服务端装解析库或 LibreOffice，不受信任的文件格式的风险也落到服务器上。
- 让模型写步骤说明、写文件卡片：会写错，也拿不出可验证的数字。
- 前端体积上限：挡住了正常的功能，体积改为只报告。
- 称呼等设置只存在浏览器里：换一台设备就不一样。

<a id="consequences"></a>

## 后果

- 界面上的具体规则以 [网页设计规范](../ui-ux-design-guide.md) 为准，这份 ADR 只管代码结构；规范里引用的旧 ADR 编号现在都指向这一份。
- 模型写的网页文件要单独配预览域名，没配时预览报“File preview origin is not configured”。
