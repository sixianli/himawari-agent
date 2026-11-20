---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-26"
---

# ADR 0091：对话界面 v6 第三期：文件卡片、右侧文件预览、侧栏分组和新对话问候

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [文件内容从哪里来](#file-source)
- [Pi 复用与 Himawari 负责的部分](#pi-reuse)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

第一期（[ADR 0087](0087-chat-ui-v6-process-timeline.md)）做了过程区和标志，第二期（[ADR 0090](0090-chat-ui-v6-answer-and-composer.md)）做了回答下方一行和输入区。v6 原型（`docs/assets/control-center/2026-10-26-v6/index.html`，里面的文件、对话和数字都是演示数据）上剩下的是回答下方的文件卡片、右侧文件预览、侧栏和新对话页，作为第三期。Andy 在 2026-10-26 对文件预览的批注原话：

> 一个文件预览这一个窗口，嗯，就是我希望针对不同文件能使用合适的打打开这种文件的工具啊。虽然我不知道我怎么描述，但是我想要的是一个很好的展示效果。就比如说，如果这个文件是一个 Markdown 文件的话，就是它能像在一个美丽的 Markdown 阅读 APP 里面打开的效果那样，那样优美的显示效果。

他还先后批注过文件卡片放在哪里，最后的结论是“文件整个 response 的文件放在这里，我同意，我同意放在这里，而不是放到那个 response 里面”，即卡片放在回答下面，不放进正文。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **回答下方的文件卡片。** 一轮里用“写文件”（`write`）和“改文件”（`edit`）工具成功写出的每个文件，在回答下方（来源之后）显示一张卡片：类型小标（MD、CSV、TS……）、文件名、类型、行数，改过的文件再加绿色“+N”和红色“−N”行。同一个文件在一轮里先写后改只算一张卡片。点卡片在右侧打开预览，再点一次关闭；打开的那张卡片描边变成强调色并写“已打开”。
2. **右侧预览按文件类型选显示方式。**
   - Markdown：像阅读软件一样排版，正文限宽、字号和行距放大，标题分层、引用左侧有色条、表格和代码框排好版；有两个以上二级标题时顶部有固定的目录，点了跳到那一节。可切到“原文”。
   - CSV、TSV：显示成表格，表头和行号固定不动，数字列右对齐，能相加的数字列在底部算出合计（百分比列不加）。可切到“原文”。
   - 代码和其他文本：带行号的源码视图。
   - 改过的文件多一个“改动”页，逐行显示删掉的（红底）和加上的（绿底）。
   - 网页文件这一期先显示源码，并写明“渲染后的效果以后再做”。
   - 顶部有“放宽预览”、复制文件内容和关闭；Esc 也能关闭。手机宽度下预览铺满整屏。
3. **侧栏。** 置顶之外的对话按最后更新时间分成“今天”“昨天”“更早”三组（按浏览器本地日期，空组不显示）；“新建对话”“搜索对话”下面加“记忆”入口，打开设置里的记忆页。
4. **新对话页。** 中间是大号葵盘标志，花盘慢慢转（90 秒一圈，系统开了“减少动态效果”时不转），下面按浏览器本地时间问“早上好”“下午好”“晚上好”，再写“今天想做些什么？”。原来那句“从一个问题，或一件想完成的事开始”删掉，输入框里的提示语已经说了能做什么。
5. **顺手修的缺陷。** 回答和预览里的 Markdown 勾选清单原来每项显示两个勾选框（列表项和勾选框各画了一次），改成只画一次。
6. 所有新文字都有中文、英文、日文三种。

[↑ 返回阅读导航](#contents)

<a id="file-source"></a>

## 文件内容从哪里来

- 预览不读服务器上的路径。“写文件”工具调用时的参数里本来就有路径和全文（`{ path, content }`），“改文件”的参数里有每处改动的原文和新文（`{ path, edits: [{ oldText, newText }] }`），这些参数已经作为每一步的记录发给浏览器（过程区展开某一步时就能看到）。浏览器从记录里取出这些参数：写文件直接用全文；之后的改文件把每处原文替换成新文，得到最终内容；如果没有全文（这一轮只改不写），只显示改动。
- 行数和“+N −N”由浏览器逐行比较原文和新文（最长公共子序列）算出，和“改动”页显示的一致。
- 每条记录的参数最多保留 64K 字，超过的被截断后不再是合法的 JSON。这时卡片照常显示（文件名从截断的文字里取），预览里写明“这个文件超过 64K 字，记录里没有存下完整内容，预览不了”。
- 用命令（例如运行脚本）生成的文件、图片、PDF 不在任何工具参数里，这一期不显示卡片，见[后果](#consequences)。

[↑ 返回阅读导航](#contents)

<a id="pi-reuse"></a>

## Pi 复用与 Himawari 负责的部分

- 复用：Pi Coding Agent 的 `write` 和 `edit` 工具定义了参数的形状（`path`、`content`、`edits[].oldText`、`edits[].newText`），Himawari 原样记录工具参数，不另起一套“产出文件”的协议，也不改 Pi。
- Himawari 负责：从记录里认出这一轮写了哪些文件、算出最终内容和逐行改动，以及卡片和预览的界面。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **新加“按对话读工作目录文件”的接口：** 能显示任何文件（图片、PDF、命令生成的文件、超过 64K 字的文件），也是主流产品的做法；但要做这段对话的权限检查、只读、限大小，是一块带安全审查的后端工作。Andy 的选择卡片还没回答前，按推荐先做不需要后端的文本类文件，接口记成待办 [BL-20261026-013](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-013-file-preview-images-pdf-html.md)。
- **网页文件用 `iframe srcdoc` 直接渲染：** 实现最简单；但控制中心的安全策略是 `default-src 'none'; style-src 'self'`，没有 `frame-src`，内嵌页面会继承这条策略（[W3C CSP Level 3 第 7.8 节](https://www.w3.org/TR/CSP3/)：“Documents loaded from local schemes will inherit a copy of the policies in the source document”，并点名 srcdoc 文档），网页自带的样式会被挡掉，显示出来反而是错的。正确做法是单独一个隔离的预览地址，同样放进 BL-20261026-013。
- **代码高亮：** 原型里代码有颜色；产品现在没有高亮库，这一期只做行号，避免为一个视觉细节引入新依赖。
- **卡片里的“+N”把新写的行也算进去：** 先写后改的文件会显示成“+5 −1”，和“改动”页里看到的“+2 −1”对不上。改成只数改动页里的增删行。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：不改服务端就能看到 Himawari 写出的 Markdown、表格和代码，Markdown 的阅读效果接近阅读软件；每轮写了什么文件、改了多少行一眼可见。
- 代价：命令生成的文件、图片、PDF 和超过 64K 字的文件看不到内容；网页只能看源码；侧栏“今天/昨天”按浏览器所在时区算。
- 后续：[BL-20261026-013](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-013-file-preview-images-pdf-html.md)（读文件接口、图片和 PDF 预览、网页隔离渲染）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0087：对话界面 v6 第一期](0087-chat-ui-v6-process-timeline.md)
- [ADR 0090：对话界面 v6 第二期](0090-chat-ui-v6-answer-and-composer.md)
- [控制中心 v4 设计 Spec 的 v6 第三期增补](../execution/specs/2026-09-15-control-center-v4-design.md#v6-file-preview-and-sidebar)
- [v6 原型](../assets/control-center/2026-10-26-v6/index.html)
- [案例 28：回答下方一行和附件](../engineering-casebook.md#case-answer-line-attachments)
- [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md]
