---
status: superseded
document_type: adr
decision_status: superseded
supersedes: "docs/adr/0082-mobile-pwa-push-before-native-app.md"
superseded_by: "docs/adr/0229-native-apple-clients-and-device-api.md"
date: "2026-10-26"
---

# ADR 0089：所有推送只走网页推送，删掉 Bark；生产入口用 himawari.siyi.win，只用 Cloudflare 邮箱验证码登录

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0082](0082-mobile-pwa-push-before-native-app.md) 定了手机端先做主屏网页应用（PWA，Progressive Web App：加到主屏幕后像 App 一样全屏打开的网页）和网页推送（Web Push：服务器经浏览器厂商的推送服务把通知送到设备，网页关着也能收到），不做原生 iOS App。它的第 5 条让已写好的 Bark（一个开源 iOS 推送 App）先过渡推送记忆提醒，第 3 条把锁屏显示多少正文留到设计时再问。

之后 Andy 追问为什么还要 Bark：

- 用户原话，2026-10-26T14:38Z：“那既然这样的话，为什么不直接就设计成设计成网页推送呢？所有的推送都通过网页推送，为什么一定要加入 Bark 呢？”
- 用户原话，2026-10-26T14:39Z：“直接等网页推送 / 直接做这个，一步到位，你必须好好设计！”

线程写了[设计文档](https://claude.ai/artifact/5WezX9kCNWhdpU7ttck7BG)和[界面原型](https://claude.ai/artifact/E1BP6KR7gqYrXkgEcxqghv)，列出 5 件要 Andy 拍板的事。Andy 2026-10-26 在设计文档上逐条批注：

- 第 1 条（入口网址，原推荐 `app.siyi.win`，旁注 `himawari.siyi.win` 现在是 Hermes 测试机），用户原话，15:11Z：“生产用这个域名，hermes测试环境换一个别的域名”
- 第 2 条（原推荐两道门：Cloudflare 邮箱验证码，再加现有的密码和验证器），用户原话，15:12Z：“两道门太复杂了，只用这一道行不行？”
- 第 3 条（锁屏上显示多少内容），用户原话，15:14Z：“同意”
- 第 4 条（只在没在看 Himawari 时推送），用户原话，15:14Z：“同意”
- 第 5 条（Bark 代码是否删除），用户原话，15:14Z：“同意删除”

代码事实（`main` 提交 `0b8f6df`）：

- Bark 推送在 `apps/agent-service/src/production-reminder-push.ts`，配置项 `runPolicy.reminderPush`。按项目记录（2026-10-26 00:08 Andy 说“Bark 先不做”），生产配置从没写过这一项，所以 Bark 从未开启；没有这一项时推送循环不会启动（`apps/agent-service/src/service-main.ts`）。它只推记忆提醒，去重只记在内存里，服务重启后会重发。
- Himawari 只认一个网址（配置项 `publicOrigin`）：每个请求的 Host 头、每个修改请求的 Origin 头都必须等于它（`packages/platform-node/src/http-gateway-server.ts` 的 `assertPublicHost`、`assertMutationBoundary`）。
- 登录方式已有两种：内置的密码加验证器（`identity.kind: "built-in"`，生产现在用它），和 Cloudflare Access 方式（`identity.kind: "cloudflare-access"`：每个请求都核对 Cloudflare 签发的 `cf-access-jwt-assertion` 签名和绑定过的身份，见 `packages/platform-node/src/identity-gateway.ts`）。后者 2026-09 在 Hermes 上用过，前端两种都支持（`apps/control-center/src/app.tsx`）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

本 ADR 取代 ADR 0082。ADR 0082 的第 1、4、6 条原样保留，写在下面第 1、6、7 条；改动的是推送通道、锁屏规则、入口网址和登录方式。

1. **现在不做原生 iOS App，不开通 99 美元/年的苹果开发者计划。**（同 ADR 0082 第 1 条）
2. **所有推送只走网页推送，不用 Bark。** 三类事都经网页推送送到设备：到期的记忆提醒、等 Andy 审批、一轮任务完成或失败。删掉 Bark 的代码、配置项 `runPolicy.reminderPush` 和它的测试；Backlog 项 BL-20261026-007（在生产打开 Bark）以“不做”关闭。也不用 Telegram 机器人：机器人对话存在 Telegram 云端。
3. **生产入口用 `himawari.siyi.win`。** 生产机装 Cloudflare Tunnel（生产机主动连出，不开对外端口），把这个网址转到本机 `127.0.0.1:8400`；Hermes 测试机先改用另一个域名（推荐 `himawari-test.siyi.win`），让出 `himawari.siyi.win`。生产的 `publicOrigin` 改成 `https://himawari.siyi.win`，手机和电脑都用这个网址；用 ssh 隧道打开网页的方式随之停用。这一条改变了 [ADR 0083](0083-isolated-instance-per-person-with-owner-entry.md) 第 4 条末尾“他的电脑仍可以用 ssh 隧道”。Cloudflare 故障时，由 Mac 远程会话把 `publicOrigin` 和登录方式临时改回本机地址和内置登录。切换等第十三版上线后、Hermes 上没有测试在跑时做。
4. **生产只用一道门：Cloudflare 邮箱验证码。** Access 规则只放行 Andy 的邮箱，登录保持 30 天。Himawari 的 `identity.kind` 改为 `cloudflare-access`，把 Cloudflare 身份绑定到现有的主人（Owner），对话和记忆不动；不再要求密码和验证器，但它们的记录保留，供切回时用。前提：Andy 的 Gmail 开着两步验证，因为邮箱成了唯一的钥匙。
5. **推送规则。**
   - 锁屏内容：普通记忆提醒显示原文和时间；审批和任务只显示对话标题（审批加风险级别）；数据分级为“敏感”或“受限”的记忆只显示“你有一条私密提醒”。回答正文和审批的具体操作不上锁屏。
   - 不打扰：任何设备上有 Himawari 页面正显示在前台时不推送。页面在前台时每 30 秒告诉服务器一次，服务器 45 秒内收到过就不推。
   - 同一件事不重复推：每条通知有唯一来源键，发过就记进数据库，服务重启后也不重发。
   - 三种语言：通知的固定文字按设备开启通知时的界面语言（中文、English、日本語）取，提醒原文和对话标题保持写入时的语言。
   - 推送内容用苹果声明式网页推送（Declarative Web Push）的 JSON 格式，iOS 18.4 起系统自己就能弹出；其他浏览器由后台脚本（service worker）解析同一份 JSON。后台脚本不缓存页面和数据。
6. **语音先做两个入口。** 网页里“按住说话”，以及 iPhone 快捷指令让 Siri 一句话问 Himawari。开工前先查 Pi 和现有模型网关能否做语音转文字和朗读。（同 ADR 0082 第 4 条）
7. **原生 App 只在下面任一条件出现时重新评估：** 需要锁屏小组件、灵动岛、Siri 深度整合或后台感知这类网页做不到的能力；网页推送实测两周不可靠；别人的实例超过 5 人且普遍觉得主屏网页难用。（同 ADR 0082 第 6 条）

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只用网页推送（选中）**：一条通道、一套代码；点开直接进 Himawari 对应页面；内容按 RFC 8291 加密，推送服务看不到；0 元，不需要苹果开发者账号。iPhone 上只有加到主屏幕后才收得到（iOS 16.4 起）。
- **Bark 过渡、网页推送上线后再删（ADR 0082 原方案）**：当天就能收到记忆提醒；但要维护两套推送代码，Andy 要装 Bark、配两把密钥，点开进的是 Bark 不是 Himawari，还依赖 Bark 的公共服务器。Andy 选择一步到位，不采用。
- **登录两道门（Cloudflare 验证码 + 密码和验证器）**：Cloudflare 规则配错时还有第二道；但每次换设备要登两次。Andy 认为太复杂，不采用；改为要求 Gmail 两步验证，实际仍是两重保护。
- **生产用新域名 `app.siyi.win`、Hermes 不动**：不用动测试机；Andy 选择生产用更好记的 `himawari.siyi.win`，不采用。
- **代码同时认两个网址（Cloudflare 网址和本机隧道地址）**：电脑能继续走 ssh 隧道；但多约半天工作量，同一台电脑会有两套推送订阅、两份通知。不采用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：推送只有一条路，点开就是 Himawari；手机和电脑同一个网址、同一次登录；不用写新的登录代码。
- 代价：生产对公网多了一个入口，安全完全依赖 Cloudflare Access 规则和 Gmail 账号；Cloudflare 故障时要手动切回；Hermes 的网址要改，用到旧网址的 Runbook 要跟着改。
- 未验证：iPhone 上网页推送和声明式推送的实际到达率；Cloudflare Access 是否会挡住浏览器取 manifest 和后台脚本（挡住时只给这三类公开文件加不检查登录的规则）；`cloudflare-access` 方式下高风险审批前“最近登录过”的检查在生产配置里怎么设。
- 后续：
  - Backlog [BL-20261026-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md)（入口）和 [BL-20261026-005](../backlog/BL-20261026-005-home-screen-web-app-and-web-push.md)（主屏应用和推送）按本 ADR 更新；[BL-20261026-007](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-007-enable-bark-reminder-push-in-production.md) 以“不做”关闭。
  - 实现规格见 [网页推送实现规格](../execution/specs/2026-10-26-web-push-design.md)。
  - 设置页“通知”等前端改动等“重构整个用户界面”线程第一期合入 `main` 后再做。
- 2026-10-27 实施记录（日本时间，本 ADR 的决定不变）：
  - 网页推送随第十四版上线；11:39 生产推送开启。12:54 生产入口切为只用 Cloudflare 邮箱验证码登录，Access 只放行 Andy 的邮箱。Hermes 改用 `himawari-test.siyi.win`。
  - 11:53 的第一次切换失败，停服约 9 分钟，见[工程案例 30](../engineering-casebook.md#case-login-switch-outage) 和 [BL-20261027-008](../backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md)。
  - 上面“未验证”里的 manifest 一项已有结论：从外网取 `/manifest.webmanifest` 和 `/sw.js` 返回 200。
  - Andy 在 iPhone 主屏应用上收到了测试通知。三类真实推送等其余真机项见 [BL-20261027-009](../backlog/BL-20261027-009-web-push-real-device-acceptance.md)；到达率在 BL-20261026-005 里于 2026-11-09 核对；[BL-20261026-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md) 已完成。
  - 高风险审批前“最近登录过”的检查在生产配置里怎么设，仍未验证。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]
- [SOURCE: docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]
- [SOURCE: docs/execution/specs/2026-10-26-web-push-design.md]
- [SOURCE: docs/engineering-casebook.md#case-web-push-only]
- 设计文档：<https://claude.ai/artifact/5WezX9kCNWhdpU7ttck7BG>
- 界面原型：<https://claude.ai/artifact/E1BP6KR7gqYrXkgEcxqghv>
- [SOURCE: docs/adr/0095-silent-session-exchange-behind-cloudflare-access.md]（第 4 条“一道门”在网页上的实现：过了验证码自动进入）

[↑ 返回阅读导航](#contents)
