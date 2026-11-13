你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 10d590b002e0ec61e9f66adef3e9f6d1b5e38880。
对比基准是 5e06602c1a8d4e5aef04e07585734e25e657c2ed，先运行 git diff 5e06602c1a8d4e5aef04e07585734e25e657c2ed..10d590b002e0ec61e9f66adef3e9f6d1b5e38880 看改动。
作者的说法（可能有错，请核对）：
# 复核材料：iOS 第 2 批客户端（clients/apple）

## 改了什么
新建 `clients/apple/`：Swift 包（HimawariCore、HimawariDesign、HimawariChat、HimawariManage 占位、HimawariShell）和 Xcode 工程 `App/Himawari.xcodeproj`；在 `docs/execution/plans/2026-11-11-apple-device-body-plan.md` 加“第 2 批的任务”。不改服务器代码、不改表、不改发给模型的任何内容。

## 目标和约束
- iPhone 原生 App：配对（扫二维码 → 安全芯片生成设备密钥和确认密钥 → POST /api/device/v1/pair → 等网页确认）、对话列表、聊天（发消息、断线续传、逐字输出）。
- 服务器侧接口在 PR 404（分支 claude/project-thread-xuqee1，提交 102f6248；文件 packages/platform-node/src/device-api-routes.ts、device-request-signature.ts、paired-device-service.ts）。约定：POST threads 正文只能有 {requestId, answerLocale: zh-CN|en|ja}，结果 thread.command_result 的 payload 里带 threadId，同一 requestId 重发返回同一 threadId；POST payloads/text {refs}（1–100 个、不重复）→ {items: {ref: {text, contentType, dataClassification} | null}}；GET threads/{id}?after=N 每次最多 200 条；GET threads/{id}/execution-stream 是单个对话的 SSE，事件名就是消息类型（thread.execution_text、thread.execution_changed），找不到对话时发 thread.execution_unavailable；GET stream 跳过的事件发 event: device.scanned 带 id。
- 签名按 RFC 9421，必须和 PR 404 的 verifyDeviceRequest 逐字一致；确认签名是同一签名基础的第二个标签 confirm，nonce 相同。
- 配对核对数字 = SHA-256("himawari-pairing-v1" ‖ 设备公钥 SPKI ‖ 确认公钥 SPKI) 前 4 字节大端 % 1000000，补零 6 位。
- 待发消息：同一条消息重发用同一个 messageId（服务器按 messageId 去重，返回第一次结果）；409 表示对话不可用，不再重试。
- 不许写注释；不许写死能从服务器拿的值（心跳间隔等来自 GET config）。
- 图标按设计线程决定用 Tabler Icons outline（MIT），由 clients/apple/scripts/make-icons.mjs 从 npm 包生成模板 SVG 进 Icons.xcassets，线宽常规 1.6、返回关闭加号小箭头 2.2；不用 SF Symbols。
- 界面照批准的原型 docs/assets/apple-clients/2026-11-12-v1/（PR 405 分支）；原型没画的状态等设计线程补图。

## 已核对的事实
- 云端 Linux 版 Swift 6.2.1 上 `swift test` 46 条全过；改坏签名基础或核对数字算法时相关测试会失败（已试）。
- Swift 签的请求（含 confirm 双标签）用 PR 404 的 verifyDeviceRequest 验过：通过；改查询参数、改正文、换确认公钥都被拒。
- 界面目标（SwiftUI）在云端无法编译，只能在 Andy 的 Mac 上用 Xcode 编译；请特别留意 SwiftUI / Swift 6 并发检查下可能编译不过的写法。

## 请重点看
1. 签名、续传、待发队列、缓存在断网、重连、吊销、时钟偏差时会不会出错或丢消息、重发重复。
2. 安全：密钥和服务令牌存放（钥匙串、ThisDeviceOnly、不进备份）、吊销后清本地数据是否彻底、配对码解析是否可被构造的二维码利用（例如把 origin 指到别的主机）。
3. Swift 6 严格并发和 iOS 26 SDK 下的编译问题。
4. 界面有没有写死本该从服务器拿的值、有没有“摆设”（能点但没功能的按钮）。
