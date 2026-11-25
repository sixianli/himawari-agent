---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "AGENTS.md, scripts/check-layout-audit.mjs, test/e2e/fixtures/control-center-browser-server.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0110：10-29 界面第二批：低级错误由检查来找，设置跨设备一致，分出的对话看得见来源

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [和早先决定的关系](#relation)
- [比较过的方案](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [关联文档](#references)
- [后续](#follow-up)

<a id="context"></a>

## 背景

Himawari 网页（Andy 日常聊天用的网页，代码在 `apps/control-center`）第十八版上线后，Andy 在 2026-10-29 逐条发了第二批界面意见，编号 23–41，04:01 UTC 说“提完了”。这批意见里多数是低级错误：设置弹窗被撑出屏幕、提醒页空状态三行对不齐、中文界面出现“Thu, October 29”、一打开设置关闭按钮就带描边、系统深色下拉菜单。第 27 条原话：“你能不能整体的查一下，然后不要我。不要我一个一个的去找这种低级的错误。”另外几条是功能缺口：手机上设的称呼电脑上看不到（第 24 条）、分出的新对话是空的（第 28 条）、文件页没有自己上传的文件（第 32 条）。

Claude 做了可切换的原型（<https://claude.ai/artifact/95YzWPGTgew76Yg7NMFqWa>，三语、演示数据）。Andy 15:24 JST 前后逐条批注：第 24 条选 B、第 25 条选 A、第 28 条选 A、第 34 条选 A，都写“同意”；第 33 条改选 A，并补充“两个按钮的悬浮胶囊可不可以不要连在一起？你不担心用户会误触吗？”；第 30 条要求更简：“无需展示命令的细节，如果用户感兴趣的话点击‘命令详情’查看”；第 26 条要求“列出允许访问网络的域名，不要写死某个厂商的名字”；第 27 条的全站自查写“这里的处理方式我很喜欢”，并要求维护项目的《好的设计规范》。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **低级视觉错误由每次提交都跑的真浏览器检查来找。** `scripts/check-layout-audit.mjs`（`npm run check:layout`，是 `npm run check` 的一步）把网页 10 个页面在中英日三语、1280 和 390 两种宽度、浅色深色下打开，共 120 种组合，发现横向滚动、元素超出屏幕、按钮被挡住、文字被挤成竖排、文字截断没有省略号、浏览器原生下拉框、没点过就出现焦点描边、中日界面里的英文月份星期和 AM/PM，就失败。它每次运行先用一页故意做坏的页面自检。
2. **设计规范成为改界面前必读的文档。** [docs/ui-ux-design-guide.md](../ui-ux-design-guide.md) 记规则、Andy 批准并喜欢的设计、遇到过的不良设计；[AGENTS.md](../../AGENTS.md#approved-web-design-baselines) 要求改界面前读、交付时补。
3. **主人的设置存在服务器上。** 称呼、界面语言、主题色存进新表 `owner_preferences`（迁移 0063），网页经 `owner.preferences.read` / `owner.preferences.set` 读写；没送到服务器的本地改动下次打开先补发，不被旧值盖掉。
4. **分出的新对话显示来源。** 对话摘要带上 `sourceThreadId` 和 `sourceWatermark`；新对话把原对话到分出那一轮为止的内容颜色稍淡地显示在分隔线上方，顶部写“从「原标题」第 N 轮分出 · 打开原对话”，侧栏这一行有分支图标。
5. **顶栏是左右两组彼此分开的悬浮圆按钮，标题居中，设置挪到侧栏底部。** 左边是列表（手机或侧栏收起时）和新对话；右边是本对话的文件和后台命令（只显示运行中的命令数）和“⋯”（重命名、置顶、归档）。侧栏在电脑上收起时，顶栏右边临时显示设置按钮。
6. **文件页列出主人上传的文件。** 上传的图片和文件进文件页，标“我上传的”，可单独筛选；提取成文字的 PDF、Word、Excel、PowerPoint 以 `.txt` 文本列出，名字如实写明（迁移 0064）。
7. **只显示主人需要的。** “运行命令”展开后只显示成没成功和“查看输出”，命令本身、工具名、时间点和原始参数收进“命令详情”；联网搜索的说明列出服务器配置里真正会收到数据的网址，不写厂商名；文件预览只显示内容，元信息收进“文件信息”；没发过消息的空对话不进侧栏。
8. **控件统一。** 页面自己画下拉菜单；按钮提示用页面自己的提示框；保存按钮没改动时禁用；焦点描边只给键盘用户；日期时间数字全部跟着界面语言。

[↑ 返回阅读导航](#contents)

<a id="relation"></a>

## 和早先决定的关系

- [ADR 0100](0100-conversation-more-panel-files-and-background-commands.md) 定了标题栏只有一个“更多”按钮，并且先不列上传文件。本 ADR 把这个按钮改成文件夹图标，旁边加一个“⋯”对话操作菜单（Andy 选的顶栏方案 A），并把上传文件列进全局文件页（ADR 0100 记下的后续项）。“更多”面板本身（文件和后台两个标签、按轮分组）不变，不加堆放内部运行信息的通用面板这条基线规则继续有效。
- [ADR 0105](0105-ui-batch-2026-10-28-show-what-the-owner-needs.md) 第 4 条写“称呼只存在浏览器里”，本 ADR 第 3 条替换它；第 1 条“回答下方只放操作”不变，其中“从这里开新对话”的文字改为“分出新对话”。其余决定不变。
- 两份旧 ADR 只有部分内容被替换，保持 `active`，在各自末尾加一条指向本 ADR 的后续说明。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **找低级错误：靠截图人工看 / 靠浏览器自动检查。** 人工看已经失败过：第一批交付时也截了三语图，第二批仍有一半是低级错误。选自动检查。代价是 `npm run check` 多约 80 秒，且需要 Playwright 的 Chromium。视觉对齐和“该不该显示”仍要人看，检查不管。
- **称呼同步（第 24 条）：A 只同步称呼 / B 称呼、语言、主题色都同步。** Andy 选 B。
- **分出的新对话（第 28 条）：A 原内容全部显示、颜色稍淡 / B 收成一行，点开才看。** Andy 选 A，因为第一眼就能看出带上了什么。
- **顶栏（第 33 条）：A 两侧悬浮按钮 / B 极简（新对话 + 更多）/ C 标题下拉 + 新对话。** Claude 推荐 C，Andy 选 A，并要求按钮彼此分开防误触。没做到的部分：对话内容从屏幕最上面开始、往上滚时在按钮下淡出。为了不动刚修好的手机安全区（I-14），顶栏仍占一行，只去掉了底边线和背景条。
- **运行命令（第 30 条）：A 命令加结果 / B 再加输出最后 3 行。** Andy 批注要比 A 更简，命令本身也收起。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- MDN `:focus-visible`（2026-10-29 打开）：“when a button is clicked using a pointing device, the focus is generally not visually indicated … focus styles are not required when the user knows where they are putting focus, such as when they use a pointing device such as a mouse or finger”。焦点描边只给键盘用户按这个做。<https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible>
- W3C WAI-ARIA 编写实践 Listbox 模式（2026-10-29 打开）：“A listbox widget presents a list of options and allows a user to select one or more of them.”，下箭头“Moves focus to the next option.” 自己画的下拉菜单按这个模式给 `role="listbox"` 和方向键。<https://www.w3.org/WAI/ARIA/apg/patterns/listbox/>
- ChatGPT 网页有“在新对话中分支”，新对话里能看到并往回翻原来的内容；这是原型阶段对 ChatGPT 网页的观察。OpenAI 帮助中心的更新说明一页本次打开返回 HTTP 403，未核对一手文档。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：低级视觉错误在提交前就被拦下，不再要 Andy 一个个找；换设备设置一致；分出的对话看得出带上了什么、从哪里来。
- 代价：`npm run check` 变长约 80 秒；检查依赖测试用的假服务器（`test/e2e/fixtures/control-center-browser-server.mjs`），假服务器没有的页面（通知设置）查不到，假服务器和真实服务器不一样时也会漏，I-17 就是这样漏掉的，所以这次把假服务器的分出行为改成和真实服务器一样。
- 未验证：没有在真 iPhone 上看顶栏和分出的对话；“运行命令”的新样式没有在真浏览器里看过，因为假服务器没有工具步骤。
- 后续：第 31 条 docx 预览由预览选型线程实现（pdf.js、docx-preview、ExcelJS 自绘）；记忆页（第 36、40、41 条）由记忆页设计线程实现。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 设计规范：[docs/ui-ux-design-guide.md](../ui-ux-design-guide.md)
- 截图基线：`docs/assets/control-center/2026-10-29-v11/`（含原型 `prototype.html`）
- 事故：[I-15、I-16、I-17、I-18](../incidents-and-gates.md)
- 面试案例：[案例 52](../engineering-casebook.md#case-ui-batch-1029)
- PR #99
- [ADR 0100](0100-conversation-more-panel-files-and-background-commands.md)、[ADR 0105](0105-ui-batch-2026-10-28-show-what-the-owner-needs.md)、[ADR 0107](0107-every-incident-gets-an-automatic-gate.md)

[↑ 返回阅读导航](#contents)

<a id="follow-up"></a>

## 后续

- 2026-10-30：[ADR 0122](0122-every-owner-setting-on-the-server-with-revision.md) 修改本 ADR 第 3 条：存服务器的设置从称呼、界面语言、主题色三项扩到加上主题、模型、思考深度共六项；“没送到的本地改动下次打开先补发”改为“服务器版本号没变才补发，变了以服务器为准”。其余决定不变。

[↑ 返回阅读导航](#contents)
