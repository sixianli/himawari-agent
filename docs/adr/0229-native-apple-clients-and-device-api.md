---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
amended_by: "docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md"
---

# ADR 0229：做 iPhone、Apple Watch、Mac 的原生客户端，设备走专用接口、设备密钥和苹果推送

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-words)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0089](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md) 定的是：不做原生 iOS App，网页之外只用网页推送（Web Push：服务器经浏览器厂商的推送服务把通知送到设备）。它的第 7 条留了重新评估的条件，其中一条是“需要锁屏小组件、灵动岛、Siri 深度整合或后台感知这类网页做不到的能力”。

2026-11-11 Andy 要把 Himawari 做成“全能的 personal agent”：能听、能看、知道他此刻在做什么、能在他的设备上直接动手。这些能力网页做不到：网页应用一到后台就丢麦克风（前提 4），也拿不到位置轨迹、健康数据、通讯录和日历。所以重新评估的条件已经出现。

这份 ADR 只管三件事：做不做原生客户端、设备怎样连到服务器、提醒怎样送到设备。设备采集到的东西怎样存、怎样变成记忆，由 [ADR 0230](0230-perception-records-and-memories-inferred-from-perception.md) 管。每个接口、每张表、每道检查的细节在[详细设计](../execution/specs/2026-11-11-apple-device-body-design.md)里。

状态说明：Andy 2026-11-11 21:32（日本时间）看过要点后说“那这样，我们先做，等需要我开的时候，我再开”（“开”指苹果开发者账号），本 ADR 随即改为 `accepted`，ADR 0089 标成已被取代。

[返回阅读导航](#contents)

<a id="owner-words"></a>

## Andy 的原话

都是 2026-11-11（日本时间）在“设计环境感知和 iOS App”线程里对方案的批注。

- 范围：“同意 iPhone，我还有 Apple Watch，还有 Mac，我可能还会随身带一个麦克风，对吧？就是做到极致啊！”
- 取代旧决定：“同意取代，不做原生客户端，站外只用网页推送这一条”
- 测试规则：“同意改写”
- 方向：“这是我的个人产品，我想做得激进一点……我希望它是一个我的全能 AI personal agent。”
- 传输：“我不知道 WebSocket 的方案是不是最好的……找一个最好的实现出来”
- 给别人用：“客户端分两个版本：完整版本我自己用，然后上架给 App Store 的版本给别人用。还是说你有其他更好的方式”
- 以后的 Mac 端：“现在要做 iOS，以后可能会做 macOS 的 App 端”
- 老对话缓存失效一次：“我还是那句话，做到极致。我不管以前的老规则怎么样”
- 口头指令：“我戴着 AirPods Pro 对吧，难道我还得手去摁一下我的耳机，才能唤醒 Himawari 吗？”（据此改了 ADR 0230 决定第 4 条）
- 开工：“那这样，我们先做，等需要我开的时候，我再开”

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 多种设备是同一个 Agent 的感官。来源 `docs/product-vision.md` 原则 5 原话：“多接入、多感知都是同一个权威 Agent 的不同感官。”
2. 原则冲突时的顺序。来源同文件原话：“用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率”。
3. 现行决定留了重新评估的条件。来源 [`0089-web-push-only-owner-entry.md`](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md) 决定第 7 条原话：“原生 App 只在下面任一条件出现时重新评估：需要锁屏小组件、灵动岛、Siri 深度整合或后台感知这类网页做不到的能力”。
4. 原生 App 在前台开始录音后可以在后台一直录；网页应用做不到。来源苹果技术支持在开发者论坛的回答 <https://developer.apple.com/forums/thread/776949> 原话：“we allow apps that start an audio recording session in the foreground to continue recording indefinitely in the background.”（这句话线程读到过，另一个模型复核时被验证页挡住，动工前再核一次。）
5. 服务器现在只接受浏览器里同源页面发来的修改请求。来源 `packages/platform-node/src/http-gateway-server.ts:261` 原话：`header(request, "sec-fetch-site") !== "same-origin"`，不满足就拒绝。
6. 已经有不经过浏览器的入口先例：Muse 推送入口用 Cloudflare 服务令牌（Cloudflare 发给程序用的一对编号和密钥，带在请求头里就能通过登录门）加应用自己的密钥。来源 `docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md` 决定第 1 条原话：“两层认证。边缘层用 Cloudflare Access 的服务令牌（Service Auth 策略，请求头 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`）”“应用层再要求 `Authorization: Bearer <应用密钥>`”。MCP 入口早先也是这个做法（ADR 0219），现已由 ADR 0227 改成只认 Cloudflare Access 的登录凭证，不拿它当先例。
7. 网页收服务器消息用的是一条带编号、带心跳、能断线续传的事件流。来源 `packages/platform-node/src/http-gateway-server.ts:194` `SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8"`；`:1115` `request.query.afterCursor ?? header(request, "last-event-id")`；`:428` `heartbeatFrame`。
8. 这条事件流每发一个事件都重新核对身份。来源同文件 `:463`、`:497` 原话：`readonly revalidate: () => Promise<void>;`、`await input.revalidate();`。
9. 工具集合一变，老对话下一轮会重建一次请求开头。来源 `packages/application/src/services/thread-prompt-bundle-service.ts:89` 原话：`if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";`。
10. 审批只接受两个值，高风险审批要有近期身份验证的凭据。来源 `packages/gateway-contracts/src/contracts.ts:97` `decision: enumeration(["approved", "denied"])`；`packages/application/src/services/approval-service.ts:73` `current.recentAuthenticationRequired &&`。
11. 苹果推送（APNs，苹果把通知送到设备的服务）的快慢由优先级决定，后台静默推送会被限流。来源 <https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns> 原话：“Specify `10` to send the notification immediately.”“Notifications with `apns-priority 5` and `apns-priority 1` might get grouped and delivered in bursts… may also get throttled… and in some cases, not delivered.”
12. 有后台模式的 App 在后台可以像在前台一样用普通网络连接；系统代传只支持从文件上传。来源 <https://developer.apple.com/documentation/foundation/downloading-files-in-the-background> 原话：“Apps that declare appropriate background modes can use default URL sessions and data tasks, just as if they were in the foreground.”“Only upload tasks from a file are supported”。
13. Cloudflare 所有套餐都支持 HTTP/3，但到源站那一段不是。来源 Cloudflare 文档原话：“HTTP/3 is available to all plans”“HTTP/3 connection to the origin is not yet supported”（线程在调研时读到，网址和上下文见 `/mnt/project-files/ambient-sensing/transport-research.md`）。
14. 苹果系统自带 HTTP/3，不通时自动退回。来源苹果技术说明 TN3102 原话：“you will see the protocol fall back to `h2` or `http1.1`”。
15. 多通道比单条连接在后台有大传输时快。来源开源项目 Cindy（提交 `58169050`）`docs/agent-net-plan.md` 第 2.1 节的实测：空闲时两种方式延迟都是 44 毫秒；后台有大传输时单条连接形态涨到 246 毫秒，多通道 51 到 74 毫秒。这是它在一台 Mac 上的模拟链路，不是 Himawari 的实测。
16. HTTP 请求签名有现成标准。来源 RFC 9421 <https://www.rfc-editor.org/rfc/rfc9421.html> 原话：“This document describes a mechanism for creating, encoding, and verifying digital signatures or message authentication codes over components of an HTTP message.”参数 `created`：“Creation time as a UNIX timestamp value of type Integer.”`nonce`：“A random unique value generated for this signature as a String value.”算法名 `ecdsa-p256-sha256`。
17. 本 ADR 之前的规则不许在 MacBook 上做任何构建（这一句已按决定第 8 条随本 ADR 改写，下面引的是改写前的原话）。来源 `.agents/instructions/test-and-production-hosts.md` 第 8 行改写前的原话：“绝不在用户的 MacBook 上运行 Himawari 测试：不做构建，不跑 `npm run check`、`npm test`、任何 Vitest 项目或产品路径资格验证。”
18. 每个人一个只属于自己的 Himawari；一套程序、一个网址、每人一个数据库文件。来源 `docs/adr/0234-one-program-per-person-database-file.md` 决定第 2 条原话：“只跑一套程序，每人一个数据库文件。”第 5 条原话：“登录：一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。”（它取代了 ADR 0083 的“每人一个独立实例”。）

未核实、所以本 ADR 不依赖的：苹果安全芯片（Secure Enclave）里生成的密钥不能导出，这一点线程没读到原文；TestFlight 的人数和有效期、不公开上架、日本的第三方应用商店，线程读的是搜索结果摘录。它们列在详细设计的[还没核实的事](../execution/specs/2026-11-11-apple-device-body-design.md#unverified)里，动工前读原文。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

本 ADR 取代 ADR 0089。ADR 0089 里仍然有效的内容原样保留，写在下面第 9 条；改动的是“不做原生 App”“只用网页推送”“只有浏览器能往服务器写”这三点。

依据的原则：愿景原则 5（多感知是同一个 Agent 的感官）和原则 6（感知当下、把事办成）。它和原则 2（边界与可逆性）之间的取舍是：给服务器多开一个写入口，换来设备能力；用每台设备自己的密钥、逐台吊销、动作走现有审批来守住边界。

1. **做原生客户端，一共四样设备。** iPhone、Apple Watch、Mac 各有原生 App，是三种要配对的设备；随身麦克风经蓝牙接到 iPhone 或 Mac，它没有自己的密钥，不单独配对，算那台设备上的一个采集来源。它们是正式客户端，不是实验。苹果开发者计划（99 美元/年，每年续）先不开：头几步用 Andy 自己的 Apple ID 免费装到他的手机上，做到苹果推送那一步、确认离不开它时再请 Andy 开（Andy 2026-11-11：“我们先做，等需要我开的时候，我再开”）。
2. **设备是身体，大脑只在服务器。** 设备负责采集、显示和执行；记忆、规则、决策记录、调用大模型做判断，只在服务器。设备上可以有只读缓存（最近的对话、记忆页的副本），不放第二份可写的记忆。这样四样设备和网页上永远是同一个 Himawari。
3. **聊天和语音用原生界面做，不常用的页面嵌网页。** 聊天主界面、输入框、语音对话用苹果原生界面。记忆页、规则、设置、用量明细嵌现有网页，保证和电脑上一致。嵌入的网页用设备凭据向服务器换一个短期的网页会话，不自己保管长期凭据。
4. **设备走单独的一组接口 `/api/device/v1/`，不经过浏览器那套同源检查。**
   - 每台设备配对时在自己的安全芯片里生成两把 P-256 密钥：设备密钥（平时签请求）和确认密钥（每次用都要面容或解锁，给高风险审批和换网页会话用）。服务器只存两把的公钥。配对由 Andy 在已登录的网页上发起（网页显示一个 10 分钟有效、只能用一次的配对码），设备扫码后，Andy 还要在网页上对着设备名点一次确认，设备才可用。
   - 单次请求按 RFC 9421 用这把密钥签名，覆盖方法、主机名、路径、查询参数、正文摘要，带创建时间和一次性随机值，服务器拒绝过期和重复的签名。
   - 交给苹果系统代传的文件可能拖几天才发出，不能用这种限时的签名；它们用另一种上传凭据：事先向服务器申请，绑定设备和文件摘要，只在上传路径上有效，只能用一次。
   - 可以在网页上逐台吊销，立即生效：这台设备的连接最迟在下一次心跳时被掐断，设备上的本地缓存被清掉。
   - Cloudflare 那一层给这组路径配服务令牌，和 Muse 推送入口同样的做法（前提 6）。服务令牌是几台设备共用的，只当进门的第一道门，不当设备身份。
   - 设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等），不是网页能做的全部。多人时，“设备编号对应哪个人”放在共用层的一张设备索引表里（只有编号、配对码的哈希和人，不含私人内容），做法和 ADR 0234 决定第 5 条把 Gmail 授权记录放共用层一样；名册的内容不变。App 里嵌的网页要另换一个短期网页会话，换的时候必须用确认密钥签（主人本人当场解锁）；所以只拿到设备密钥、主人不在场时，做不了改规则、删记忆、导出这些事。
   - 不采纳“让 App 伪造浏览器请求头走现有接口”：那等于把同源检查变成客户端自称。
5. **连接用 HTTP/3 多通道，传输层做成可以整个换掉。**
   - 一条一直开着的连接：下行是现有事件流（前提 7）原样接上来，上行每条消息各走一条通道。回答的文字和审批走高优先级通道，照片、音频、屏幕走低优先级通道。
   - 断线续传沿用事件编号；设备发的每条消息带唯一编号，服务器只认一次；心跳间隔由服务器下发；连接有最长寿命；编号太旧时整份重新取。
   - 连接建立时验证一次设备签名，之后像现有事件流一样持续核对设备是否仍有效（前提 8）。
   - 设备只收到和它有关的事件。
   - 动工第一步在 Andy 的手机上实测三种方式：HTTP/3、单条 WebSocket（对照）、手机直连生产机的 QUIC；另外测一遍现有网页作基线。直连要在生产机开一个对外的 UDP 端口，属于改权限边界，只有实测明显更快时才拿数字来问 Andy。同一步测出生产机离日本一个来回多少毫秒。
   - 连接不在时：感知记录攒成文件交给系统代传（前提 12）；服务器找设备走苹果推送。
6. **提醒改走苹果推送，网页推送留给浏览器。**
   - 三种推送类型：主人看得见的通知（优先级 10）、刷新小组件、刷新锁屏实时活动。有时效的事不依赖后台静默推送（前提 11）。
   - 通知上带按钮：“有用 / 打扰”“同意 / 不用 / 稍后”。每个按钮带一个只有服务器能解开的一次性凭据，绑定审批编号、审批内容的版本、设备和有效期；过期、重复、内容变了都无效。“稍后”只收起通知，不改审批状态。
   - 每个设备动作单独登记“要不要主人本人在场”。要的，审批必须在设备上用面容或解锁确认，由此产生近期身份验证的凭据（前提 10）；不靠风险档位来决定，因为现有审批只在最高一档才要求它。口头确认不能用于这类审批。
   - 同一件事在苹果推送和网页推送之间只到一处，沿用现有的来源键去重。小组件和实时活动的刷新不参与这个去重。
7. **动手：模型那边只有一个固定存在的设备工具 `device_action`。** 用参数区分动作；没有可用设备时由执行端回答“没有可用设备”；设备支持哪些动作由工具的“describe”动作当场返回，不写进工具定义。这样配对、断开设备和以后加新动作，都不会让请求开头变化。
   - 加这个工具（以及 ADR 0230 的 `perception_read`）的那次上线，每个老对话在它的下一轮会重建一次请求开头（前提 9），缓存失效一次。Andy 已同意。为了只发生一次，这两个工具和这套设计用到的全部新提示词文字在同一个版本里上线。
   - 每个动作带服务器生成的唯一编号，设备存下来去重；回报丢了记为“结果未知”，不自动重做，只读回核实；模型换个编号再调同样的动作也不重做。
   - 每个动作绑定设备、动作类型、有效期；走现有权限和审批；Mac 上打开文件、操作别的 App 只在 Andy 设置过的目录、App 和网址名单内（名单存在服务器上，服务器和设备各判一次），并且要主人本人在场。
8. **测试规则改写。** 改成：服务器端的构建、检查和测试照旧不在 MacBook 上跑；iPhone、手表、Mac 客户端的构建、单元测试和安装，在 Andy 的 Mac 上用 Xcode 做。这一条随本 ADR 一起改 `AGENTS.md`、`.agents/instructions/test-and-production-hosts.md` 和 `.agents/instructions/delivery-mode.md`。
9. **从 ADR 0089 原样保留的。**
   - 生产入口是 `himawari.siyi.win`，经 Cloudflare Tunnel；浏览器只用 Cloudflare 邮箱验证码这一道门（ADR 0089 第 3、4 条）。
   - 不用 Bark，不用 Telegram 机器人（第 2 条的后半）。
   - 推送规则（第 5 条）对两条通道都适用：锁屏上显示多少内容、正在看 Himawari 时不推、同一件事不重复推、通知固定文字按设备语言。苹果推送的内容经苹果的服务器，所以锁屏规则里“敏感或受限的只显示一句提示”同样适用于它。
   - 网页里“按住说话”保留；iPhone 快捷指令问 Himawari 的入口由原生 App 的 Siri 入口代替（第 6 条）。
10. **给别人用：同一份代码，按发布渠道出不同的包。** Andy 自己用开发者账号直接装，带全部能力；家人朋友走 TestFlight；公开发布走 App Store 或只凭链接安装的不公开上架，只带审核通得过的那部分；Mac 端官网直接下载。哪个包带哪些感官由编译开关定。别人的包和 Andy 的一样靠扫码配对：二维码里带服务器地址，所有人共用一个网址，服务器按设备找到是谁（前提 18）。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- ChatGPT 和 Claude 的手机 App 是原生界面的对话入口加语音，要用户打开、主动说话；不在后台感知用户，也不按用户状态挑推送时机。这一条是线程的判断，没有逐个找一手来源。界面和传输照它们的做法（原生界面、流式出字、语音边生成边读）；感知这块是它们没做的。
- 开源项目 Cindy 第一代用单条 WebSocket 加应用层的编号、确认和重放，第二代因为大传输会挡住交互而换成多通道传输（前提 15）。从它学的做法：多通道分优先级；“重连后对账”当主路径；判断连接死没死看有没有任何有效消息进来；每个队列有上限；传输层可以整个换掉。没有照搬它自研的 UDP 传输：它那样做是因为它的“服务器”是用户家里的电脑，要打洞，Himawari 有公网服务器。
- OpenAI 对“手机直接连实时语音模型”建议用 WebRTC。那类模型是按量付费的贵模型，和“禁用贵模型”冲突，本方案不用；传输层可换，以后有便宜的实时语音模型时再接。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **继续只做网页应用。** 拿不到后台麦克风、位置、健康、通讯录，也没有小组件和通知按钮。和 Andy 定的方向不符。
- **只做 iPhone。** Andy 明确要手表、Mac 和随身麦克风；它们各有 iPhone 做不到的事（手腕收音、Mac 上一直看屏幕、麦克风不间断）。
- **单条 WebSocket。** 所有东西排一个队，全天上传感知数据时回答要排在后面。留作实测的对照。
- **自研 UDP 传输或直接照搬 Cindy 第二代。** 拥塞控制、加密握手都要自己维护，没有上游修 bug；Himawari 不需要打洞。
- **让 App 用浏览器的登录会话。** 设备在后台过不了邮箱验证码；一个会话泄露等于全部权限；不能逐台吊销。
- **每个动作一个工具，或者按配对的设备增减工具。** 每次配对、断开都会让所有对话的请求开头重算。
- **在手机上放第二个大脑（本地模型自己决定、本地可写记忆）。** 会出现两个各说各话的 Himawari，违反“单一权威源”。
- **只上架 App Store 一个版本。** 全天录音、整本通讯录要逐项过审核，Andy 自己用的版本会被最严的那一档限制住。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：Himawari 有了感官、嘴和耳、手；提醒可以带按钮，能及时送到；以后加 Mac 端不用再开新入口。
- 代价：
  - 服务器多了一个能写数据的入口，安全依赖设备密钥、服务令牌和吊销。
  - 加工具的那次上线，每个老对话缓存失效一次。
  - 多了一套 Swift 代码和它的测试，只能在 Andy 的 Mac 上构建。
  - 每年 99 美元；TestFlight 的包每 90 天要发新版（未核实的数字，见前提末尾）。
  - 苹果推送的内容经过苹果的服务器，所以沿用锁屏规则，正文不放进推送。
- 未验证：HTTP/3 经 Cloudflare 在 Wi-Fi 和蜂窝切换时连接断不断；Cloudflare 到生产机那一段会不会让大传输挡住回答；在听的时候后台连接能不能一直保持；手表能不能自己直连服务器。都在详细设计的真机清单里。
- 随这份 ADR 一起改的文档：ADR 0089 已标成被取代；`AGENTS.md`、`.agents/instructions/test-and-production-hosts.md`、`.agents/instructions/delivery-mode.md` 按决定第 8 条改写（已随本 ADR 的提交改好，合并后生效）。`docs/runbooks/` 下两份操作手册里不许在 MacBook 上构建和跑测试的句子（`test-host-operations-runbook.md` 的“Mac 只用来编辑、审查、提交”，`agent-tooling-runbook.md` 的同类句子）等切回完整模式时重新封存，在那之前以指令文件为准。更早的 ADR 里“开发 Mac 不跑测试、不做构建”的说法（ADR 0041 到 0047、0056、0063、0073、0092 等）对服务器端照旧成立；对苹果客户端，以本 ADR 决定第 8 条为准。
- 工程案例：做完第一批（地基）后写进案例库，题目是“为什么从‘不做原生 App’改成四样设备”。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md]
- [SOURCE: docs/adr/0234-one-program-per-person-database-file.md]
- [SOURCE: docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md]
- [SOURCE: docs/adr/0165-freeze-the-request-head-per-conversation.md]
- [SOURCE: docs/adr/0230-perception-records-and-memories-inferred-from-perception.md]
- [SOURCE: docs/execution/specs/2026-11-11-apple-device-body-design.md]
- [SOURCE: docs/product-vision.md]
- 方案和调研（不在仓库里）：`/mnt/project-files/ambient-sensing/integrated-plan.md`、`transport-research.md`、`verified-apis.md`、`device-test-list.md`
- 两个模型的方案和审核原文：`.agents/reviews/topic-ios-capabilities/`
