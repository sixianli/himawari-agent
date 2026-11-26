---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-26"
implementation: in_progress
covers: "packages/platform-node/src/device-api-routes.ts, apps/agent-service/src/production-http-composition.ts, apps/agent-service/src/production-mcp-connections-control.ts, apps/control-center/src/**, clients/apple/Sources/HimawariCore/Pairing.swift"
verified_at: "54b438b2cbb11b5748e8b1ae187d014fe141200d"
---

# ADR 0309：App 用通行密钥直接登录，网页整体删除

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
  - [登录和设备](#sign-in)
  - [网页独有的功能搬到 App](#move)
  - [外部 agent 接入改标准 OAuth](#mcp-oauth)
  - [Mac App](#mac)
  - [服务器状态](#status)
  - [顺序](#order)
- [比较过的方案](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

2026-11-26 Andy 问：为什么 iPhone App 要扫网页上的二维码才能配对？Meta 的 Muse 只有 iOS App，难道要先装电脑端再扫码？同一天他在决策卡“网页端以后怎么定位？”上选了“以后整个去掉网页”。

查下来，扫码的根因是 App 自己不会登录：证明“这是 Andy 本人”的入口只在网页上，手机只能借网页发的二维码进门，扫完还要回网页点确认。Muse、Claude、ChatGPT 的 iOS App，以及自托管的 Home Assistant、Bitwarden，都是在 App 里直接登录，不需要第二台设备（[Claude 帮助中心](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)、[Home Assistant 入门](https://companion.home-assistant.io/docs/getting_started/)、[Bitwarden 自托管客户端](https://bitwarden.com/help/change-client-environment/)）。

方案讨论记录在 Claude Docs 的“iPhone 直接登录方案”和“去掉网页、全搬到 iPhone 的迁移方案”两份文档里，Andy 在文档评论和线程里逐项定了下面的决定。

<a id="premises"></a>

## 前提

1. 配对码只能在网页登录后生成：`packages/platform-node/src/device-api-routes.ts` 的 `pairing-codes` 路由先调用 `managed(request)`，它走 `webAuthenticate`。
2. 二维码里装着服务器地址、一次性配对码，以及可选的 Cloudflare 门禁通行证：同一路由拼出的 `himawari-pair:` 内容里有 `origin`、`code` 和 `pairingAccessFields` 给的 `clientId`、`clientSecret`。
3. 设备在安全芯片里生成设备密钥和确认密钥，服务器只存公钥（[ADR 0229](0229-native-apple-clients-and-device-api.md#decision) 决定第 4 条）。
4. 东京生产机前面开着 Cloudflare Access：2026-11-26 16:40 从外网请求 `https://himawari.siyi.win/`，返回 302 跳到 `cloudflareaccess.com` 登录页；`/api/device/v1/config` 返回 403；`/api/mcp/v1` 返回 401。
5. 主人设置已经都存在服务器上（[ADR 0122](0122-every-owner-setting-on-the-server-with-revision.md)），搬页面不用搬数据。
6. Claude 的自定义连接器支持 MCP OAuth 的“客户端说明文件”和动态登记两种客户端登记方式（[Claude 连接器认证文档](https://claude.com/docs/connectors/building/authentication)）。Muse 支持哪种，官方文档里没找到，编码时先实接一次。

<a id="decision"></a>

## 决定

<a id="sign-in"></a>

### 登录和设备

1. **只用通行密钥登录，没有密码和验证码。** 通行密钥（passkey）是存在 iCloud 钥匙串里、用面容 ID 或触控 ID 解锁的登录凭据，iPhone 和 Mac 之间自动同步。FIDO 联盟的注册模式允许只用标识加通行密钥建账号（[FIDO 设计指南](https://fidoalliance.org/design-guidelines/patterns/new-account-creation-with-a-passkey/)），NIST SP 800-63B-4 把同步的通行密钥算作防钓鱼的第二级认证（[NIST](https://pages.nist.gov/800-63-4/sp800-63b/syncable)）。App 要声明关联域名，服务器在自己域名下放 `apple-app-site-association` 文件（[Apple：Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)）。
2. **第一次进门和找回都用一次性设置码。** 设置码由服务器上的管理命令生成，只能用一次、限时，用完作废；在 App 里输入后当场创建通行密钥。找回只有这一条路，只有能登进服务器的人做得到，不比通行密钥弱（FIDO 警告找回方式比登录弱会拖垮整套安全，[FIDO 白皮书](https://fidoalliance.org/wp-content/uploads/2025/03/Passkeys-The-Journey-to-Prevent-Phishing-Pt3.pdf)）。
3. **登录即登记设备。** App 登录前就生成两把设备密钥，登录请求带上两把公钥和设备名；验过通行密钥后服务器直接把这台设备登记为可用。删掉二维码、配对码和网页上的“确认设备”。
4. **服务器地址预置进安装包**，由出包流程从仓库变量注入，不写进代码；App 里留一个不显眼的“换服务器”入口。
5. **设备列表在 App 里**：能看所有已登录设备、移除别的设备（要面容 ID，用确认密钥签）、“退出登录”移除本机并删本机密钥。新设备登录后，其他已登录设备收到一条推送。
6. **Cloudflare 门禁**：App 用到的地址（登录、设备接口、关联域名文件、Gmail 和 MCP 的授权回调）从门禁里放行，由 Himawari 自己的通行密钥和设备签名把关。网页删掉后整个站不再需要门禁。门禁通行证不编进安装包。

<a id="move"></a>

### 网页独有的功能搬到 App

7. **Gmail 连接**：App 向服务器要授权地址，用系统授权弹窗 `ASWebAuthenticationSession` 打开谷歌登录，谷歌跳回服务器存令牌，再跳回 App。谷歌不允许在 App 内嵌网页里登录（[Google 开发者博客](https://developers.googleblog.com/en/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)，[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)）。
8. **个人设置**：模型选择（选项从服务器读）、称呼搬到 App；语言和深浅色跟随系统；网页的主题色不搬。
9. **数据导出和记忆导入**：导出由服务器打包、App 下载后用系统存文件弹窗保存；导入用系统文件选择器或分享扩展，导入前先给预览和条数。
10. **Muse 对照数据整条删除**：不再对标 Muse，`/api/muse-intake/v1/batch` 接收、存储、周报对照和网页 Muse 页一起删（取代 [ADR 0302](0302-decision-records-and-calibration.md) 里“Muse 数据怎样收进来”一节）。Muse 往 Himawari 写记忆走外部 agent 接入，不受影响。
11. 网页上其余还没在 App 里的页（每周报告、邮件判断页、文件库、归档对话、主动提醒设置、拦下的敏感内容、外部提议、判断链条）由 iOS 规划线程逐页定搬还是删，再进编码。

<a id="mcp-oauth"></a>

### 外部 agent 接入改标准 OAuth

12. 外部 agent 接入是核心功能（愿景：Himawari 是记忆中心），完整搬到 App。接法改成 MCP 规范的授权方式（[MCP 授权规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)）：所有 agent 填同一个 MCP 网址；服务器公布受保护资源说明，自己当授权服务器，支持“客户端说明文件”，也保留动态登记给还不支持的客户端；对方发起接入时 iPhone 收到推送，面容 ID 同意才发令牌。接入后在 App 里能设最多读到多私密的记忆、存进来要不要确认、暂停、撤销。这取代 [ADR 0307](0307-external-agents-and-the-memory-hub.md#entry) 第 2、3、6、9 条（Cloudflare 登录、在网页上建接入、路径里的接入密钥）。

<a id="mac"></a>

### Mac App

13. 做完整的原生 Mac App，和 iPhone 同时开发（取代 2026-11-16“macOS 暂停”）。登录、对话、记忆、设置、外部 agent 接入的核心代码和 iPhone 共用；界面照苹果界面规范的 Mac 写法（侧栏加内容的窗口、菜单栏、快捷键、设置窗口），先由 iOS 规划线程出设计。不拿 iPhone App 直接放到 Mac 上跑（Andy：“不要老是去想那些打补丁的方案”）。
14. Mac App 照 iPhone 的做法在 GitHub 的 macOS 机器上编译，用 Mac 版 TestFlight 分发和安装，不依赖 Andy 的 Mac；Mac 的 CI 作业只在动到苹果客户端代码时运行。

<a id="status"></a>

### 服务器状态

15. 运维页（workers、host-workspaces、health-deployment）不搬。出事靠告警主动通知：现有心跳检查的邮件照留，加一条 iPhone 推送。App 的“关于”下面加一页只读的服务器状态：版本、上次上线、上次备份、后台执行程序是否正常、磁盘剩余，每个数字写清定义，没有就不显示。

<a id="order"></a>

### 顺序

16. 先做登录（第 1 到 6 条），再删网页上和 App 重复的页；个人设置、Gmail、外部 agent 接入、导出导入和服务器状态互不依赖，可以并行；Mac App 和它们同时做。**最后一步才删整个网页**（`apps/control-center`、网页会话 Cookie 和防伪造校验、Cloudflare 登录换取、网页布局检查、[ADR 0295](0295-web-chat-interface.md) 和网页设计规范里只属于网页的部分），前提是 iPhone 和 Mac App 都能完整替代网页。删完用一台新装的 iPhone 从零走一遍：登录、连 Gmail、接一个外部 agent、导出，全程不碰网页。
17. 从现在起不再给网页加功能。

<a id="options"></a>

## 比较过的方案

- **保留扫码，只把二维码换成手动输配对码**：仍然要先开网页，是表面修补，不采用。
- **第一次用密码加验证码登录，之后改通行密钥**：密码和验证码只用一次，之后一直闲着，却还是能被猜、被钓鱼的一扇门。不采用。
- **用 Apple 登录（Sign in with Apple）**：一样要第一次绑定，还把身份交给苹果账号；通行密钥由 Himawari 自己的服务器验证，更符合“自有优先、数据自持”。不采用。
- **把 Cloudflare 门禁通行证编进安装包**：安装包能被拆出来，通行证等于公开。不采用。
- **iPhone App 直接在 Apple 芯片 Mac 上跑**：不写新代码，但窗口是手机尺寸，不是 Mac App。Andy 否决。
- **外部 agent 保留“每个 agent 一条带密钥的网址”**：能用，但不是 MCP 规范的做法，要手动拷网址。改成标准 OAuth。

<a id="consequences"></a>

## 后果

- 好处：装 App 就能用，不需要电脑；没有密码可被猜或钓鱼；只维护 App 一套界面；外部 agent 按标准接入，Claude 等客户端直接认。
- 代价：[ADR 0027](0027-built-in-owner-authentication.md) 的密码加验证器账号、网页会话和 Cloudflare 登录适配器在最后一步随网页一起删，那时删掉 ADR 0027 和 0295，并改掉引用它们的 Runbook 和架构文档；改 Cloudflare 门禁要 Andy 在后台操作一次或给线程一个有权限的令牌；设备全丢时找回要线程在服务器上跑管理命令。
- 这次同时改的旧文档：[ADR 0229](0229-native-apple-clients-and-device-api.md#decision) 决定第 4 条的配对方式、[ADR 0258](0258-each-apple-device-plays-to-its-strength.md) 决定第 2 条“第一台设备的配对和手机丢了以后的移除都靠网页”、ADR 0302 的 Muse 接收一节、ADR 0307 第 2、3、6、9 条，各加一句指向本 ADR。
- 要跟进：`.agents/instructions/test-and-production-hosts.md` 里“苹果客户端在 Andy 的 Mac 上用 Xcode 构建”一条与第 14 条冲突，由协调者附 Andy 原话后改。
