---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0089-web-push-only-owner-entry.md"
date: "2026-10-26"
---

# ADR 0082：手机端先做主屏网页应用和网页推送，暂不做原生 iOS App

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-26 12:48 Andy 问：要不要开发一个 iOS App 客户端，有没有必要。项目愿景要求 Himawari 在命令行、桌面、网页、手机、语音上是同一个 Agent（One agent, every surface）；项目也是 Andy 应聘 AI Application / AI Agent Engineer 的作品，速度优先；Andy 不想在外围服务上花钱。

线程读了当前 `main`（提交 `8f1783d`）的代码，查到手机端缺的是三件事：

- **手机在外面连不上。** 生产只监听 `127.0.0.1:8400`，只能先建 ssh 隧道再打开；[ADR 0081](0081-isolated-instance-per-person.md#decision) 写的是 Andy 自己继续走 ssh 隧道。
- **网页关了就收不到提醒。** 控制中心的记忆提醒用浏览器 `new Notification()`，只有网页标签页开着时才弹（`apps/control-center/src/components/memory-panel.tsx` 的 `MemoryReminders`）。另有 Bark 推送（Bark 是一个开源的 iOS 推送 App）：提交 `f73b0b7`（2026-10-25）已经把到期记忆提醒在服务器上用 Andy 自己的密钥 AES-256 加密后经 Bark 推到 iPhone，随第十次上线进了生产，但生产没有配置 `runPolicy.reminderPush` 和推送密钥，所以没开（`apps/agent-service/src/production-reminder-push.ts`）。
- **不能用嘴说。** 代码里没有录音、语音转文字或朗读。

此外：控制中心没有 manifest（网页应用说明文件，写图标、名称、全屏打开方式）和 service worker（网页后台脚本）；服务端内容安全策略是 `default-src 'none'` 且没有 `manifest-src`，浏览器会拒绝加载 manifest（`packages/platform-node/src/http-gateway-server.ts`）；前端 gzip 总体积 195773 / 196608 字节，只剩约 0.8 KB（`scripts/check-control-center-build.mjs`）；[PRD v0.2](../prd-v0.2.md) 把原生 iOS 客户端和站外消息投递列为本版不做。

线程查了一手资料（引文见[评估文档](https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS)和[工程案例库对应案例](../engineering-casebook.md#case-mobile-client)）：

- WebKit：iOS/iPadOS 16.4 起，加到主屏幕的网页应用可以申请推送，“You do not need to be a member of the Apple Developer Program to use it”；iOS 18.4 起有声明式网页推送（推送消息自带标题、正文和点开后的网址，不依赖后台脚本）。
- RFC 8291：网页推送内容加密，能防止推送服务“inspection, modification, and forgery”。
- Apple：开发者计划 99 美元/年；免费账号装到设备上的 App 7 天后过期；苹果技术支持在开发者论坛确认推送能力只属于付费会员；TestFlight 每个版本 90 天后失效；审核规则 4.2 要求 App 不只是“a repackaged website”。
- 业界：Claude、Gemini、Perplexity 都有原生 App，卖点是跨设备同步和实时语音；自托管的 Open WebUI 用 PWA（Progressive Web App，加到主屏幕后像 App 一样全屏打开的网页应用）；同样是自托管 Gateway 的 OpenClaw 有原生 iPhone App，用来给 Gateway 提供摄像头、定位和语音唤醒，并推荐先接 Telegram。

线程推荐了下面的方案。2026-10-26T13:05Z Andy 在决定卡片上选了“按推荐走（同意 1–7 条）”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **现在不做原生 iOS App，不开通 99 美元/年的苹果开发者计划。**
2. **第一步：给生产开一个手机能直接打开的 HTTPS 入口。** 用 Cloudflare Tunnel（生产机主动连出去，不开对外端口）加 Cloudflare Access（只放行名单里的邮箱），和 ADR 0081 给别人实例用的入口是同一套做法。Andy 自己的手机也走这个入口；电脑上仍可以用 ssh 隧道。这改变了 ADR 0081 决定第 4 条“Andy 自己的实例继续走 ssh 隧道”，由 [ADR 0083](0083-isolated-instance-per-person-with-owner-entry.md) 取代 ADR 0081 记录。开工条件：第十三版上线后稳定运行。
3. **第二步：控制中心做成能“添加到主屏幕”的网页应用，并加网页推送。** 推送三类事：到期记忆提醒、任务完成、等 Andy 审批。优先用声明式网页推送。锁屏上显示多少正文在设计时再问 Andy。开工条件：第一步的入口在 iPhone 上实测能登录；前端先省出约 1–2 KB 体积，或经 Andy 同意调高体积上限。
4. **第三步：语音先做两个入口。** 网页里“按住说话”，以及 iPhone 快捷指令让 Siri 一句话问 Himawari（快捷指令用 Cloudflare Access 服务令牌过登录门，令牌只开放这一个接口）。说的话进同一个对话、同一份记忆。不做一直在听的唤醒词。开工前按 Pi 优先原则先查 Pi 和现有模型网关能否做语音转文字和朗读。
5. **过渡期先打开已写好的 Bark 记忆提醒推送。** Andy 在 iPhone 装 Bark，Claude 备份后在生产配置 `runPolicy.reminderPush` 和推送密钥并重启服务。网页推送上线后再决定留不留 Bark。不用 Telegram 机器人做通道：机器人对话存在 Telegram 云端。
6. **原生 App 只在下面任一条件出现时重新评估：** 需要锁屏小组件、灵动岛、Siri 深度整合或后台感知（定位、健康数据）这类网页做不到的能力；网页推送实测两周不可靠；别人的实例超过 5 人且普遍觉得主屏网页难用。届时再比较 Swift 原生和 Expo 跨平台，并重新问 Andy。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **主屏网页应用 + 网页推送（选中）**：0 元，和网页同一份代码、同一次上线，推送内容加密；粗估 3–5 天，加入口 0.5–1 天（均未测量）。做不到锁屏小组件、灵动岛、Siri 直接调用应用内功能、后台持续录音或定位。
- **原生 iOS（Swift）**：能用全部系统能力；但要 99 美元/年才有推送和 TestFlight，要把对话、审批、记忆页重写一遍，每次接口改动两边改，只能在 Mac 上构建，TestFlight 每 90 天重传。粗估 6–10 周到功能对齐（未测量）。暂缓。
- **跨平台（React Native / Expo / Flutter）**：可复用 `packages/gateway-contracts` 的 TypeScript 类型，另带安卓；苹果的费用、期限和审核一样不少，小组件等仍要写 Swift。粗估 4–8 周（未测量）。暂缓。
- **只开 Bark 推送**：代码已在生产，约 15 分钟配置即可，内容端到端加密；但只推记忆提醒，点开进的是 Bark，依赖 Bark 公共服务器。作为过渡采用。
- **Telegram 机器人**：双向聊天方便，Manus、OpenClaw 都用；但 Telegram FAQ 说普通聊天是服务器-客户端加密并存在 Telegram 云端，Andy 的记忆和对话会留在第三方服务器上，不符合“数据留在我手里”。不采用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：0 元补齐手机端的连接、锁屏提醒和语音；所有入口仍是同一个后端、同一份记忆；过渡期当天就能在锁屏收到记忆提醒。
- 代价：生产多一个经 Cloudflare 的对外入口，安全依赖 Access 规则和内置登录两道门；前端体积要先腾地方；iOS 上网页推送只在加到主屏幕后可用。
- 未验证：iPhone 上网页推送和声明式推送的实际到达率；Cloudflare Access 服务令牌在快捷指令里的用法；Pi 是否已有可用的语音能力。
- 后续：四项工作分别记在 Backlog 项 [BL-20261026-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md)（入口）、[BL-20261026-005](../backlog/BL-20261026-005-home-screen-web-app-and-web-push.md)（主屏网页应用和推送）、[BL-20261026-006](../backlog/BL-20261026-006-voice-entry-hold-to-talk-and-siri-shortcut.md)（语音）、[BL-20261026-007](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-007-enable-bark-reminder-push-in-production.md)（打开 Bark）；PRD v0.2 的提醒范围已在同一提交里更新；架构文档在实现入口和推送时再改。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/prd-v0.2.md]
- [SOURCE: docs/adr/0081-isolated-instance-per-person.md]
- [SOURCE: docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]
- [SOURCE: docs/engineering-casebook.md#case-mobile-client]
- 评估文档：<https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>

[↑ 返回阅读导航](#contents)
