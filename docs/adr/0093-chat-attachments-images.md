---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
covers: "scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0093：附件支持图片，交给能看图的模型

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [图片怎么从浏览器到模型](#image-path)
- [Pi 复用与 Himawari 负责的部分](#pi-reuse)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0090 的附件一节](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0090-chat-ui-v6-answer-and-composer.md#attachments)让附件按钮能读 PDF、Office 和文本文件，图片先拒绝，等 Andy 决定是否加一个能看图的模型。2026-10-27 他在选择卡片“附件里的图片怎么处理？”上选了：

> 加一个看图模型

查证时发现不一定要另加模型：

- 生产用的文字模型 `deepseek/deepseek-v4.1-flash`，在 Vercel AI Gateway（Himawari 调模型用的中转服务）公开的模型列表 `https://ai-gateway.vercel.sh/v1/models` 里，输入类型写的是 `["text","image","pdf"]`；它的供应商列表 `/v1/models/deepseek/deepseek-v4.1-flash/endpoints` 里每一家的图片单价都是 0，即看图不另收费。2026-10-27 读取。
- Pi（Himawari 底层的 Agent 框架，固定版本 `@earendil-works/pi-ai` 0.84.2）已经能把图片发给模型：`dist/api/openai-completions.js` 把用户消息里的图片转成 `image_url` 内容；`dist/api/transform-messages.js` 在模型的 `input` 不含 `image` 时，把图片换成文字“(image omitted: model does not support images)”。`AgentSession.prompt()` 有 `images` 参数。
- Himawari 没用上这些：发给 Pi 的只有文字，生产配置里模型的 `input` 只写了 `["text"]`。

[ADR 0048](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md) 记着 Andy 的原话“禁止使用oepnai的模型，文本模型只能使用deepseek/deepseek-v4.1-flash”，备用也只能给同一个模型换供应商，不能换模型。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **图片交给现在的主模型看。** 生产配置里 `deepseek/deepseek-v4.1-flash` 的 `input` 改成 `["text","image"]`，带图的那一轮照常用它回答。不另加第二个模型，少一次调用，也守住 ADR 0048。
2. **能加的图片：** PNG、JPG、WebP、GIF（GIF 只取第一帧），原图最大 20 MB，和其他附件合计每条消息最多 10 个。iPhone 的 HEIC 照片和 SVG 暂不支持，并提示原因。
3. **浏览器先压缩：** 长边超过 1568 像素就按比例缩小，再存成 JPG（质量 0.85，透明处填白）；1 MB 以内、不用缩小的 PNG、JPG、WebP 原样保留。压缩后仍超过约 1.1 MB 时依次把长边缩到 1200、900 像素再试。
4. **输入框和聊天记录：** 输入框上方图片显示成 46 像素的方形缩略图，右上角是移除按钮，悬停显示名字和大小（[v6 原型](../assets/control-center/2026-10-26-v6/index.html)里的样式）。发出去的消息里，图片在正文上方显示成 132 像素的方形缩略图，其他文件仍是文件卡片。
5. **模型看不了图时如实说明：** 网页从模型列表知道每个模型能不能看图。选中的模型看不了图而草稿里有图片时，输入框下方写“某某模型看不了图片，这一条里的图片会被略过”。发出去后由 Pi 把图片换成“图片已略过”的文字，这一轮照常回答。
6. 新文字都有中文、英文、日文三种。

[↑ 返回阅读导航](#contents)

<a id="image-path"></a>

## 图片怎么从浏览器到模型

- **上传：** 新增 `POST /api/payload/v1/image`。登录、防伪造请求（CSRF）和幂等检查与 `/api/payload/v1/attachment` 相同；内容必须是 `data:image/png|jpeg|webp|gif;base64,…` 形式的文字，最多 150 万字符（请求体上限 2 MiB），其他内容（包括 SVG，因为它能带脚本）一律拒绝。加密保存的内容类型是 `text/x-himawari-image`。
- **消息里只带引用：** 和其他附件一样，消息正文后面加一行 `<file name="名字" ref="引用" bytes="大小" kind="image"/>`。消息合同和数据库都不改。
- **缩略图：** 刚上传的图片直接用浏览器里已有的数据；刷新后或看旧消息时，网页通过已有的 `POST /api/payload/v1/text/read` 读回图片（这个接口现在也允许读 `text/x-himawari-image`，上限 150 万字节，其他内容类型仍然拒绝），每张图片只读一次。控制中心的安全策略本来就允许 `img-src 'self' data:`，不用放宽。
- **发给模型：** 上下文投影（把对话整理成发给模型的内容的那一步）读到当前这条消息里的图片引用时，取出并解密，交给 Pi 的 `prompt.images`；正文里那一行换成 `<image name="名字" index="第几张"/>`，让模型知道图片在哪里、叫什么。内容类型不是图片、或读不出来时写“[附件无法读取]”。历史消息里的图片不再重发，只留 `<image name="名字"/>`；同一段对话接着聊时，Pi 自己保存的会话记录里本来就有之前发过的图片。

[↑ 返回阅读导航](#contents)

<a id="pi-reuse"></a>

## Pi 复用与 Himawari 负责的部分

- 复用 Pi：`AgentSession.prompt()` 的 `images` 参数和 `ImageContent` 格式；`openai-completions` 把图片发给模型的代码；模型 `input` 里的 `image` 声明；模型看不了图时自动把图片换成文字说明。Himawari 不自己拼模型请求。
- Himawari 负责：浏览器里的压缩、上传接口、加密保存和所有者检查、按引用取出图片放进这一轮、缩略图，以及告诉网页每个模型能不能看图（模型列表多一个 `images` 字段，取自 Pi 模型的 `input`）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **另加一个看图模型（例如 `alibaba/qwen3.7-flash`，每百万 token 输入 0.03 美元、输出 0.13 美元）：** 先让它把图片读成文字描述，再交给 DeepSeek 回答。主模型不支持图片时这是唯一办法；但它本身也是一个文本模型，和 ADR 0048 “文本模型只能用 DeepSeek V4.1 Flash”冲突，还多一次调用（估计慢 1 到 3 秒，未测量），描述会丢掉细节，还要多维护一套模型配置。主模型的公开资料写着能看图，所以先不加；上线后如果实测供应商拒收图片，再按 Andy 的选择改成这条路，带图的那一轮自动改用它并在回答下方写明。
- **图片原始字节直接存成二进制：** 省掉约三分之一的 base64 体积；但现有的加密保存、幂等和读取都是按文字设计的，Pi 要的也正是 base64，改成二进制要多一套接口，收益不大。
- **服务端压缩图片：** 能统一处理 HEIC 等格式；但要在服务端装图片库、解析不受信任的文件。和 ADR 0090 的附件一样，留在用户自己的浏览器里做。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：截图、照片、图表可以直接贴进对话问；不加新模型，费用只多出图片占的输入 token。
- 风险已核对，但还没实测：DeepSeek 官方视觉指南（`https://api-docs.deepseek.com/guides/vision`，2026-10-27 读取）写明 `deepseek-flash` 收图片，支持 “JPEG, PNG, GIF, and WebP”，图片 token “are billed together with your text tokens”，每张缩放后约 1024 token 封顶；网关供应商列表里 digitalocean、fireworks、morph、deepseek、runware、deepinfra 这几家的标签都带 `vision`。按 digitalocean 的输入价每百万 token 0.30 美元算，一张图约 0.0003 美元。真实请求还没跑过，**上线后必须用一张真图实测一次**（云端会话没有网关密钥）。
- 上线要做的事：生产机 `/etc/himawari/config.json` 里主模型的 `input` 加上 `"image"`（[配置模板](../../scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json)已经改了）。不改的话，网页会如实提示“看不了图片”，图片被略过，不会出错。
- 还没做的：扫描件 PDF、旧版 .doc/.xls/.ppt 仍在 [BL-20261026-012](../backlog/BL-20261026-012-attachments-images-pdf-office.md)；预览面板里看图片仍在 [BL-20261026-013](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-013-file-preview-images-pdf-html.md)。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0048：改用 Vercel AI Gateway，文本模型只用 DeepSeek V4.1 Flash](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md)
- [ADR 0090：对话界面 v6 第二期（附件）](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0090-chat-ui-v6-answer-and-composer.md#attachments)
- [ADR 0091：对话界面 v6 第三期](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0091-chat-ui-v6-file-preview-and-sidebar.md)
- [控制中心 v4 设计 Spec 的附件图片增补](../execution/specs/2026-09-15-control-center-v4-design.md#v6-attachment-images)
- [案例 28：回答下方一行和附件](../engineering-casebook.md#case-answer-line-attachments)
- [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md]
