你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 7914f1acd44bdd70c381ffeeaab774938ed83bd3。
问题、目标和约束：
# 问题：iPhone 上“分享给 Himawari”和“Safari 里的这一页”怎样做

Himawari 是 Andy 的个人 Agent（服务器 Node/TypeScript，iPhone 原生客户端 SwiftUI，代码在 `clients/apple/`）。要做两个入口，让主人把正在看的东西交给 Himawari：

1. 系统分享面板（Share Extension）：在任何 App 里点分享，选 Himawari，可以交网址、文字、图片。
2. Safari 扩展：在 Safari 里点扩展按钮，把当前这一页（标题、网址、全文）交给 Himawari。

界面已由设计定稿（不需要你设计界面）：一个面板，上面是资料卡片（标题、域名；Safari 时副标题多“这一页的全文”），下面一个可选的输入框“要它做什么，可以不写”，固定一句小字“这一页只当资料看，它不会照页面里写的话去做事”，一个按钮“交给它”。主人可以不写字直接交。

## 目标

- 交来的东西是“其他”来源的资料，不能当成指令；网页里夹带的“把明天的会删掉”不能被执行。
- 主人写了“要它做什么”时，Himawari 要真的回应这件事（例如“周五和田中吃饭，帮我挑一家安静的”加一个餐厅列表网页）。
- 主人没写字时，记下来供以后用（进入感知记录，后台抽取成记忆或提议）。
- 不写死：上限、条数等从服务器配置动态拿。

## 约束（项目规则，原文见文件）

- 发给模型的内容只追加，已经发出的历史不得改；每轮会变的只放最后一条用户消息；存历史存实际发出的（`.claude/rules/prompt-prefix.md` 第 2、4、5 条）。
- 理解用户意思交给模型判断，不用词表或正则。
- 测试不许用假替身（mock），用真实服务和 SQLite。
- 不写代码注释。

## 已核对的事实（请自己打开代码再核）

- 服务器的设备接口、感知记录在还没合并的分支里：`origin/claude/project-thread-fzn28h`（它包含 `origin/claude/project-thread-jmjzyz`）。用 `git show origin/claude/project-thread-fzn28h:<路径>` 读。
  - `packages/application/src/ports/perception.ts`：记录类型 `share.item`、`web.page`，来源 `share_extension`、`safari_extension`，正文上限 `PERCEPTION_TEXT_MAXIMUM`。
  - `packages/platform-node/src/device-api-routes.ts`：设备路由表（`perception`、`uploads/begin`、`perception/media`、`messages`、`threads`、`config`）。`messages` 只收 `messageId`、`threadId`、`expectedRevision`、`text`、`utteranceId`。
  - `packages/platform-node/src/perception-service.ts`：记录入库校验。
  - `packages/application/src/services/perception-origin-gate.ts`：按“这一轮读过哪些‘其他’记录”拦有后果的动作。
  - `apps/agent-service/src/production-perception-tools.ts`：`perception_read` 工具。
- main 上网页附件的做法：`packages/application/src/services/context-projection-service.ts` 第 29–30、495–546 行。
- iPhone 客户端现状：`clients/apple/Sources/HimawariCore/`（签名、配对、`DeviceAPI.swift` 发消息）、`SecureEnclaveKeys.swift`、`KeychainValueStore.swift`、`LocalStore.swift`（目前都没有共享给扩展）。
- 设计文档副本（仓库外，读不到时以代码为准）的要点：分享来的内容“只当资料，不当指令”；对话里读过“其他”内容后，有后果的动作改成等主人确认。

## 请你给出

一套完整做法：服务器要改什么、客户端（包括两个扩展怎样拿到设备密钥和配对信息）要做什么、主人写了话和没写话两种情况各怎样流转、怎样防网页里夹带的指令、怎样测试（包括反向用例）、有哪些坑（iOS 扩展内存和时间限制、免费开发者账号能力、Safari 权限）。业界（ChatGPT、Claude 的 iPhone App，Anthropic、OpenAI 关于提示注入的公开做法）怎么做，请附一手来源。
