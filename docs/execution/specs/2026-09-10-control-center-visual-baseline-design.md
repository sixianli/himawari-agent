---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# Himawari Agent Web 与 Logo 设计基准 v1

## 目标

保存用户已经确认的 Logo、最新聊天原型和交互效果，作为后续 Web 重构的直接参照，避免开发过程中丢失原始设计。用户于 2026-09-10 明确确认喜欢这版 Logo 和最新原型的界面与交互，并要求先将其保存到项目。

本次完成设计资料保存；Web 重构尚待实施，因此本 Spec 保持 active。原型展示设计意图，不代表正式页面、模型或工具链已按此实现。

## 来源上下文

- 控制中心的业务、三语与无障碍要求：[SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- Thread、消息与 Run 语义：[SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]
- 用户在本次设计对话中提供现有控制中心截图、Codex 深色界面截图和向日葵照片，并逐次确认设计；本版本保存最后确认的结果。
- 交互研究参考：[Codex 项目与对话组织](https://learn.chatgpt.com/docs/projects)、[Claude Code 桌面界面](https://code.claude.com/docs/en/desktop)、[Cursor Agent](https://cursor.com/docs/agent/overview)。深色配色直接参考用户提供的 Codex 截图。

## 范围

本基准包含品牌图片、聊天布局、输入区、Thread 导航、流式输出、每轮 thinking 摘要与工具记录、计时、状态、模型选择、明暗主题和主题色，以及审批和断线场景的交互示例。

本次不改变正式控制中心，不重新定义 Gateway、Pi、审批、数据披露或持久化合同，也不把所有管理页面的完整功能视为已经设计或实现。后端合同继续由相关产品文档负责。

## 已确认资源

### Logo

- [独立 Logo 图标](../../../assets/brand/himawari/v1/logo-symbol-light.png)：1254 × 1254，带浅色背景的 RGB PNG。
- [品牌展示图](../../../assets/brand/himawari/v1/logo-identity-board.png)：1536 × 1024，含字标、深色、单色及应用图标示意。
- [资源说明](../../../assets/brand/himawari/README.md)：说明用途、格式和衍生资源边界。

两张 PNG 保留用户确认时的原始字节，没有裁切、重新生成、描摹或改色。设计采用简洁的金色花瓣与深色花心；品牌金色和可切换的界面主题色分别管理。展示图不是一组已经切出的透明素材；本版本不包含透明 PNG 或 SVG。

### 交互原型

- [直接打开原型](../../assets/control-center/2026-09-10-v1/index.html)：可直接在浏览器中打开的单文件 HTML，已内嵌图标和原导出器的固定依赖，支持离线使用。
- [原始可编辑片段](../../assets/control-center/2026-09-10-v1/source.html)：逐字节保存对话中最后确认的原型，供阅读和追溯；它不是单独打开的完整页面。
- [文件校验清单](../../assets/control-center/2026-09-10-v1/SHA256SUMS)：保存本版本两张 Logo、原型、效果图及第三方许可的 SHA-256。
- [第三方许可](../../assets/control-center/2026-09-10-v1/THIRD-PARTY-NOTICES.txt)：离线导出所内嵌的 Lucide 与 Floating UI 许可原文。

打开 `index.html` 即可体验，不需要安装依赖、启动 Agent、登录 Codex 或启动 Web 服务。刷新会回到示例初始状态；它不保存真实对话。原型中的花形图标仍是设计时的占位图标，最终品牌以单独确认的 Logo 图片为准。

### 对应效果图

以下截图均从本仓库保存的 `index.html` 重新打开后截取，记录相同设计在不同状态下的样子。

| 场景 | 效果图 |
| --- | --- |
| 深色桌面与本轮记录 | [desktop-dark.png](../../assets/control-center/2026-09-10-v1/screenshots/desktop-dark.png) |
| 浅色桌面 | [desktop-light.png](../../assets/control-center/2026-09-10-v1/screenshots/desktop-light.png) |
| 明暗主题与主题色 | [theme-picker.png](../../assets/control-center/2026-09-10-v1/screenshots/theme-picker.png) |
| 模型与思考深度 | [model-picker.png](../../assets/control-center/2026-09-10-v1/screenshots/model-picker.png) |
| 正在使用工具 | [tools-running.png](../../assets/control-center/2026-09-10-v1/screenshots/tools-running.png) |
| 多轮过程保留 | [turn-history.png](../../assets/control-center/2026-09-10-v1/screenshots/turn-history.png) |
| 等待审批 | [approval.png](../../assets/control-center/2026-09-10-v1/screenshots/approval.png) |
| 断线与草稿 | [offline-draft.png](../../assets/control-center/2026-09-10-v1/screenshots/offline-draft.png) |
| 手机聊天 | [mobile-dark.png](../../assets/control-center/2026-09-10-v1/screenshots/mobile-dark.png) |
| 手机主题菜单 | [mobile-theme-picker.png](../../assets/control-center/2026-09-10-v1/screenshots/mobile-theme-picker.png) |

## 设计

### 外观

界面主题只有 Light 和 Dark。主题色独立提供紫罗兰、海蓝、青绿、琥珀、玫瑰与石墨六种选择，作用于超链接、焦点及选中标记。切换主题色时保持中性背景与正文配色，成功、等待和错误等语义颜色单独管理。原型初始为 Dark 与紫罗兰。

深色基准取自用户提供的 Codex 截图：

| 用途 | 颜色 |
| --- | --- |
| 主背景 | `#1e1e1e` |
| 侧栏 | `#262626` |
| 输入框 | `#2c2c2c` |
| 选中与抬高表面 | `#343434` |
| 正文 | `#d4d4d4` |
| 侧栏文字 | `#bababa` |
| 默认深色链接 | `#d38ce2` |

字体采用 macOS 系统字体优先的栈，含 `SF Pro Text`、`SF Pro Display`、`PingFang SC` 及系统回退；正文使用舒适的字重和行距。截图无法证明 Codex 的确切字体配置，这里记录的是已确认原型的实际选择。

### 聊天与过程

- 聊天是主区域。Thread 位于左侧，以可读标题及置顶、日期分组组织；身份编号、修订等技术详情按需打开。
- 输入区位于底部，附件、执行模式、模型与思考深度就近选择；Enter 发送，Shift Enter 换行。
- 每轮回答带轮次标识，并保留该轮的 thinking 摘要、工具名称、用途、输入、输出、耗时与状态。后续轮次不覆盖前一轮的记录；记录可以逐条展开。
- 正在执行时显示当前阶段和具体工具。回答流式出现；向上阅读时暂停自动跟随，并提供回到最新消息的入口。
- 区分执行中、等待确认、已停止、已完成和连接中断；工作时间与等待确认的时间分别显示。停止操作后保留已出现的本轮内容。
- 模型和思考深度在输入区选择；执行中换模型时，当前轮继续使用原模型，新选择从下一轮生效。列表是演示选项，正式产品应以实际配置为准。

thinking 在此指可以提供给界面展示的过程摘要。正式接入必须依据模型实际返回且允许展示的内容与真实工具事件，不能由前端编造缺失过程。所有演示消息、工具命令与结果均不构成真实执行证据。

### 错误与等待交互

审批示例显示目标、操作与范围，提供允许一次、拒绝及详情入口；等待期间单独计时。断线示例保留草稿并显示状态待同步，恢复后核对结果。原型的批准与重连只演示界面变化，不创建真实授权、不访问示例站点。

## 核对方式

1. 打开原型，查看初始已完成的对话，展开 thinking 与 `read`、`edit`、`bash` 记录。
2. 点击外观按钮，依次切换 Light、Dark 与主题色，检查背景、文字和链接的关系；打开输入区模型菜单查看深度选择。
3. 点击左侧“整理本周的项目进展”，观察 thinking、`read`、`bash` 和流式回答；继续发送第二条消息，确认第一轮记录仍可查看。
4. 点击“查阅接口迁移文档”，体验等待审批；点击“检查远程工作区”，输入草稿并重连，观察状态与草稿。
5. 缩窄窗口，核对侧栏展开、聊天输入和主题菜单；效果图记录桌面 1280 × 820 与手机 320 × 820 的查看状态。

## 保存与验证

保存时使用原导出器生成完整文档，提取内层页面以便直接打开，并仅在导出容器中设置中文语言、内嵌依赖与禁止联网的 CSP。`source.html` 的内容完整存在于 `index.html`，外观和交互逻辑未改写。内嵌版本为 Lucide `1.17.0`、Floating UI Core `1.7.3` 与 DOM `1.7.4`。

保存时已在 Ego Browser 中以本地文件打开，并启用浏览器离线模式验证：初始页面渲染了 39 个图标，无外部资源请求；主题菜单提供 2 种主题和 6 种主题色；模拟执行经过 `read` 与 `bash` 后完成，第二轮停止时第一轮仍保留 4 条过程记录；重连后输入的草稿仍在；320 像素宽度下页面未产生横向溢出。

两份 HTML 是已确认的演示快照，包含原型代码与内嵌第三方依赖，已通过 `biome.json` 的精确路径例外排除自动格式化和 lint。它们不进入应用构建，不作为待部署产品源码；冻结内容通过以下校验清单核对。

从仓库根目录运行以下命令，可检查冻结资源是否发生变化：

```bash
shasum -a 256 -c docs/assets/control-center/2026-09-10-v1/SHA256SUMS
```

效果图用于人工比较，不替代正式浏览器、无障碍或后端验收。后续实现仍须验证真实流式事件、恢复和审批合同；本次保存不产生这些资格证据。

## 后续版本维护

此版本是原始参照，开发时通过根目录 `AGENTS.md`、README 和控制中心体验 Spec 均可找到。不要在功能开发或自动格式化时覆盖 `v1` 的图片、原型和效果图。需要调整设计时，先展示变化，经用户确认后另存新版本，并记录与此版本的关系；旧版仍保留用于比较。
