---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-10-26"
---

# 网页推送实现规格

**审阅状态：已批准。** Andy 2026-10-26 14:39Z 要求“直接做这个，一步到位，你必须好好设计！”；15:11–15:14Z 在[设计文档](https://claude.ai/artifact/5WezX9kCNWhdpU7ttck7BG)上逐条批注，5 件事全部定下，记在 [ADR 0089](../../adr/0089-web-push-only-owner-entry.md)。界面见[原型](https://claude.ai/artifact/E1BP6KR7gqYrXkgEcxqghv)。本规格把设计落到代码上。

## 阅读导航

- [目标与边界](#目标与边界)
- [术语](#术语)
- [整体流程](#整体流程)
- [数据库](#数据库)
- [推送密钥和配置](#推送密钥和配置)
- [三类推送来源](#三类推送来源)
- [发送规则](#发送规则)
- [通知内容](#通知内容)
- [网关命令和查询](#网关命令和查询)
- [主屏网页应用外壳](#主屏网页应用外壳)
- [设置页通知开关](#设置页通知开关)
- [生产入口切换](#生产入口切换)
  - [入口切换实施记录](#入口切换实施记录)
- [删除 Bark](#删除-bark)
- [取舍](#取舍)
- [验证](#验证)

## 目标与边界

- 三类事经网页推送送到 Andy 开过通知的每台设备：到期的记忆提醒、等他审批、一轮任务完成或失败；另有一条不打扰的“有建议等你看”（见[三类推送来源](#三类推送来源)里的第四类）。
- 网页关着、手机锁屏也能收到；点开直接进 Himawari 对应的对话或记忆页。
- 只要有一台设备正在看 Himawari，就不推送。
- 同一件事对同一台设备只推一次，服务重启后也不重发。
- 不做：原生 App；锁屏上的操作按钮（例如直接批准）；离线缓存。

[↑ 返回阅读导航](#阅读导航)

## 术语

- **网页推送（Web Push）**：服务器把加密消息发给浏览器厂商的推送服务（苹果、谷歌、Mozilla 各有一个），推送服务再送到设备。协议是 RFC 8030，内容加密是 RFC 8291，服务器身份证明是 VAPID（RFC 8292，用一对 P-256 椭圆曲线密钥签名）。
- **订阅（subscription）**：浏览器在 Andy 允许通知后生成的一组数据：推送地址（endpoint，一个推送服务上的 https 网址）和两把公开密钥（`p256dh`、`auth`），服务器用它们加密内容。
- **后台脚本（service worker）**：浏览器在网页关着时也能运行的一段脚本，本规格里它只负责弹通知和处理点击。
- **声明式网页推送（Declarative Web Push）**：苹果在 iOS 18.4 加入的格式。推送内容是一段约定好的 JSON，系统直接弹通知，不必唤醒后台脚本。
- **在看**：某台设备上 Himawari 页面显示在前台（`document.visibilityState === "visible"`）。

[↑ 返回阅读导航](#阅读导航)

## 整体流程

```text
 设备上的页面                        Himawari 服务                         推送服务
 ───────────                        ───────────                         ────────
 开通知 ── push.subscription.set ──▶ 存订阅
 在前台每 30 秒 ── presence.heartbeat ▶ 记在内存（45 秒有效）
                                    每 10 秒扫一遍三类来源
                                    新事 ─▶ 写进待推送表（只记来源，不记正文）
                                    逐台设备：在看？跳过；
                                              否则现取正文、加密、签名 ─────▶ POST endpoint
                                    按回应码记结果（成功/删订阅/重试/暂停）◀──── 201/404/410/429/5xx
 系统弹通知 ◀────────────────────────────────────────────────────────────── 送达
 点通知 ─▶ 打开 navigate 指向的页面
```

[↑ 返回阅读导航](#阅读导航)

## 数据库

迁移 `0058_web_push.sql`，变更集 `web-push`，阶段 `expand`，数据库版本 57 → 58。四张表都按 `owner_id`、`agent_id` 隔离。账号级的通知类别开关另存 `web_push_account_kinds`（迁移 0071）。

- `web_push_subscriptions`：一行一台设备。
  - 列：`subscription_id`、`endpoint`（https，最长 2048）、`p256dh`、`auth`、`locale`（`zh-CN`、`en`、`ja`）、`device_label`（最长 64，页面按浏览器信息生成，例如“iPhone 主屏应用”）、`notify_reminder`、`notify_approval`、`notify_run`（旧版按设备存的开关，迁移 0071 之后不再读取，开关以 `web_push_account_kinds` 为准，这三列等后续迁移删除）、`state`（`active` 或 `paused`）、`failure_code`、`created_at`、`updated_at`、`last_delivered_at`。
  - 同一推送地址只有一行（唯一索引 `owner_id, agent_id, endpoint`）；重复开通时更新密钥和语言。
  - `p256dh` 和 `auth` 是公开密钥，推送地址只能用来给这台设备发加密消息，所以明文存放，与其他状态表一样受数据库文件权限保护。
- `web_push_outbox`：待推送的事，一件事一行。
  - 列：`source_key`（主键内唯一，见[三类推送来源](#三类推送来源)）、`kind`（`reminder`、`approval`、`run`）、`source_ref`、`thread_id`、`created_at`、`expires_at`。
  - 只记“是哪件事”，不记通知正文；发送时现取正文，所以记忆被删除或审批已处理时自然不再推。
- `web_push_attempts`：一件事对一台设备的发送结果。
  - 列：`source_key`、`subscription_id`、`status`（`pending`、`sent`、`suppressed`、`expired`、`gone`、`failed`）、`attempts`、`next_attempt_at`、`last_code`、`updated_at`；主键 `owner_id, agent_id, source_key, subscription_id`。
  - `sent`、`suppressed`、`expired`、`gone`、`failed` 都是终态，终态不再发。
- `web_push_cursors`：来源读到哪里。目前只有一行 `source = 'finished-runs'`，记已结束 Run 读到的位置。

清理：已到期 7 天的待推送行和它们的发送结果，在每轮扫描时顺带删除，每轮最多删 200 行。

[↑ 返回阅读导航](#阅读导航)

## 推送密钥和配置

- 新命令 `himawari-admin push init-key --state-root <目录>` 生成一把 P-256 私钥，把 32 字节私钥（base64）写进 `<stateRoot>/secrets/web-push-vapid.v1`，文件权限 0600、独占创建、不跟随软链接；文件已存在就拒绝，不覆盖。命令只打印公开密钥和下一步要写进配置的内容，不打印私钥。
- 配置：

  ```json
  "secretReferences": [{ "ref": "web-push-vapid", "version": "v1", "purpose": "web-push", "scope": "agent" }],
  "runPolicy": { "webPush": { "secretRef": "web-push-vapid", "subject": "mailto:<Andy 的邮箱>" } }
  ```

  `subject` 必须是 `https://` 网址或 `mailto:` 地址（推送服务用它联系服务器主人），其他键一律拒绝。没有 `runPolicy.webPush` 时推送功能整体关闭，设置页显示“这台服务器没有开推送”。
- 私钥由现有的受限密钥文件读取（`RestrictedSecretFileSource`，要求恰好 32 字节），公开密钥在启动时由私钥算出，不单独存。
- 换密钥会让所有设备的订阅失效（推送服务按公开密钥认订阅）。换的办法是写 `v2` 文件、改配置、重启，然后每台设备重新开一次通知。

[↑ 返回阅读导航](#阅读导航)

## 三类推送来源

推送调度器每 10 秒扫一遍下面三类来源，把新事写进待推送表；写入和游标前进在同一个数据库事务里。

| 来源 | 怎么找 | `source_key` | 有效期 | 紧急程度 |
| --- | --- | --- | --- | --- |
| 记忆提醒 | `memoryReminders().listDue(now)`，只取到期不超过 6 小时的 | `reminder:<提醒 id>:<remindAt>` | 到期后 6 小时；被主人的“静默延后”规则延后时，延长到延后时刻之后 1 小时，从入队起最长 48 小时（[ADR 0244](../../adr/0244-hard-rules-step4-unified-push-gate.md)） | `high` |
| 审批 | `authorizationStore().listApprovals()`，只取 `pending` 且未过期的 | `approval:<审批 id>` | 审批的过期时间 | `high` |
| 一轮任务结束 | `runs` 表里状态变成 `completed` 或 `failed`、并且属于某个对话的 Run，按结束时间和 id 往后读；`cancelled` 不推，因为是 Andy 自己停的 | `run:<runId>:completed` 或 `run:<runId>:failed` | 24 小时；被主人的“静默延后”规则延后时，延长到延后时刻之后 1 小时，从入队起最长 48 小时（[ADR 0244](../../adr/0244-hard-rules-step4-unified-push-gate.md)） | `normal` |

- 第四类是待处理的提议（[IOS-4]）：只为最新一份待处理提议入队一条，`source_key` 是 `proposal:<提议 id>:<proposedAt>`，有效期是提议时间起 24 小时（按 `proposedAt` 算，不按入队时间），紧急程度 `normal`，负载带 `silent: true`，不计入角标，也不受“不推送时段”规则延后；正文是固定的一句话，不含提议内容。读提议失败时，已入队的照常发送。
- 不读对话事件表：成功的一轮在事件表里只有 `thread.message.commit_assistant`，事件行不带 Run id；普通失败也不一定写事件。`runs` 表的状态才是一轮结束的唯一记录。迁移给 `runs(owner_id, agent_id, updated_at, id)` 加索引。
- 读取位置是“结束时间|Run id”，第一次启动时从当前时刻开始，不补推历史。
- 审批记录里没有对话 id，通过它的 `runId` 找到所属对话。

[↑ 返回阅读导航](#阅读导航)

## 发送规则

- **在看就不推。** 发送前检查：任何设备 45 秒内发过 `presence.heartbeat` 且 `visible: true`，这件事对所有设备记 `suppressed`，以后也不再推。心跳只存在内存里；服务重启后 45 秒内视为没人在看。
- **去重。** 一件事对一台设备只要进了终态就不再发；判断靠 `web_push_attempts`，不靠内存。
- **过期。** 发送时已过 `expires_at` 的记 `expired`。审批已处理、记忆已删除或不再是 `active`、对话已删除，也记 `expired`。
- **推送服务回应：**
  - `201`、`202`：`sent`，更新订阅的 `last_delivered_at`。
  - `404`、`410`：订阅已失效，删除订阅行，这件事记 `gone`。
  - `413`：内容太大（正常不会发生，见下），记 `failed`。
  - `429`：按 `Retry-After` 等待（缺省 60 秒，最长 1 小时）后重试。
  - `5xx` 或网络错误：1、5、15 分钟后重试，第 4 次仍失败记 `failed`。
  - `400`、`401`、`403`：密钥或配置错了，订阅改为 `paused` 并记下 `failure_code`，设置页显示原因。密钥只能改配置再重启来修，所以服务每次启动后的第一轮扫描把 `paused` 的设备全部恢复为 `active`；Andy 重新开通知时也会恢复。
- **请求头。** `TTL` 等于距 `expires_at` 的秒数；`Urgency` 按上表；`Topic` 是 `source_key` 的 SHA-256 前 24 字节的 base64url（32 个字符），推送服务对同一 Topic 只留最新一条。
- **大小。** 加密前的 JSON 不超过 3 KB；正文超长时按字符截断并加“…”。
- 每轮最多发 50 条；单次请求 15 秒超时；同一时间只有一轮在跑。

[↑ 返回阅读导航](#阅读导航)

## 通知内容

推送内容用声明式网页推送 JSON：

```json
{
  "web_push": 8030,
  "notification": {
    "title": "…",
    "body": "…",
    "navigate": "https://himawari.siyi.win/threads/<对话 id>",
    "lang": "zh-CN",
    "tag": "<Topic>",
    "app_badge": "2"
  }
}
```

- `navigate` 用配置的 `publicOrigin` 拼成完整网址：任务和审批打开对应对话（`/threads/<对话 id>`），提醒打开记忆页（`/memory`）。
- 固定文字按账号的语言偏好取，没设置才用订阅记下的语言；提醒原文和对话标题保持写入时的语言。
- 主屏图标角标（`app_badge`）= 待审批数 + 6 小时内到期且还没处理的提醒数，每条通知都带最新值；为 0 时不带这个字段；提议通知是例外，不带角标。

| 类型 | 标题 | 正文 |
| --- | --- | --- |
| 普通提醒 | Himawari 提醒 / Himawari reminder / Himawari リマインダー | 提醒原文，换行后接时间（按 `runPolicy.timeZone` 和上面取到的语言格式化） |
| 敏感或受限提醒 | 同上 | 你有一条私密提醒 / You have a private reminder / 非公開のリマインダーがあります |
| 审批 | 等你审批 · 高风险 / Waiting for your approval · High risk / 承認待ち · 高リスク（风险级别按审批的最终风险，低、中、高、极高） | 对话标题 |
| 任务完成 | 已完成 / Done / 完了しました | 对话标题 |
| 提议 | 有一条建议等你看 / A suggestion is waiting for you / 提案が届いています | 不急，有空时看看。 / No rush. Take a look when you can. / 急ぎではありません。時間のあるときにどうぞ。 |
| 任务失败 | 没有完成 / Didn't finish / 完了できませんでした | 对话标题 |

- 对话还没有标题时用“新对话 / New chat / 新しいチャット”。
- 回答正文、审批要做的具体操作、记忆的其他字段都不上锁屏。

[↑ 返回阅读导航](#阅读导航)

## 网关命令和查询

网关协议 v2 新增 4 种消息，都只允许主人（`actorType: "owner"`）在本人范围内使用：

- `push.subscription.set`（命令）：`action` 为 `subscribe` 时带 `endpoint`、`keys.p256dh`、`keys.auth`、`locale`、`deviceLabel`，`subscriptionId` 为空；为 `unsubscribe` 时只带 `subscriptionId`，其余为空，这样在一台设备上也能移除另一台。设备 id 是 `web-push-` 加推送地址 SHA-256 十六进制的前 24 位，页面用同样的算法认出“这台设备”。要收哪几类（`reminder`、`approval`、`run`）不属于某台设备，是整个账号一份，存在 `web_push_account_kinds`（迁移 0071，默认三类全开；迁移时某一类在任何一台设备上是关的就记为关），由 `push.kind.set` 修改，任何一台设备改了所有设备立即一致。账号关掉的类别，调度器记为 `suppressed`（`WEB_PUSH_KIND_OFF`），之后再打开也不补发。通知文字的语言取账号的语言偏好（`owner_preferences.locale`），没设置时才用订阅时存的 `locale`。推送地址必须是 https 网址、最长 2048 个字符。重复提交同一幂等键返回同一结果。
- `push.kind.set`（命令）：`kinds`，账号要收的类别，整组替换。
- `push.test`（命令）：`subscriptionId`。立即给这台设备发一条“通知已开启 / Notifications are on / 通知がオンになりました”，不经过“在看就不推”，结果同步返回（成功或失败原因）。
- `push.status.read`（查询）→ `push.status.snapshot`：`available`（服务器是否配置了推送）、`publicKey`（base64url，页面订阅时要用）、`kinds`（账号要收的类别）、`subscriptions`（每台设备的 id、名称、语言、状态、失败原因、开通时间、最近送达时间；不返回密钥和推送地址全文，推送地址只返回主机名）、`generatedAt`。
- `presence.heartbeat`（命令）：`clientId`、`visible`。只更新内存，不写数据库、不进审计。

[↑ 返回阅读导航](#阅读导航)

## 主屏网页应用外壳

放在 `apps/control-center/public/`，构建时原样复制到网站根目录：

- `manifest.webmanifest`：名称 Himawari，`display: standalone`，`start_url` 和 `scope` 都是 `/`，深色背景色，图标 192、512 和可裁成圆形的 512（maskable）。
- `apple-touch-icon.png`（180×180）。图标用 Andy 2026-10-26 定下的葵盘标志：品牌素材 `assets/brand/himawari/v2/logo-sunflower-disc.svg`（由“重构整个用户界面”线程提交，合入 `main` 后再生成），放在深色圆角底上；品牌原文件不动。锁屏通知上显示的就是这个图标。
- `sw.js`：只处理两件事。收到推送时，内容里有 `notification` 就按它弹通知（不支持声明式推送的浏览器走这里）；点通知时，已有 Himawari 窗口就切过去并跳到 `navigate`，没有就新开。不拦截任何网络请求，不缓存页面和数据。

服务器（`packages/platform-node/src/http-gateway-server.ts`）：

- 在单页应用兜底路由之前，按原文件返回 `/sw.js`、`/manifest.webmanifest`、`/apple-touch-icon.png` 和 `/icons/*`；`.webmanifest` 的类型是 `application/manifest+json`。
- `sw.js` 和 `manifest.webmanifest` 加 `Cache-Control: no-cache`，让更新及时生效。
- 内容安全策略（CSP）加 `manifest-src 'self'` 和 `worker-src 'self'`。

[↑ 返回阅读导航](#阅读导航)

## 设置页通知开关

按[原型](https://claude.ai/artifact/E1BP6KR7gqYrXkgEcxqghv)做在 `apps/control-center/src/components/notification-settings.tsx`，浏览器一侧的订阅和在看信号在 `apps/control-center/src/web-push.ts`：

- 设置里新增“通知”一节。iPhone Safari 标签页里打开时，只显示“先加到主屏幕”三步说明，不显示开关。
- 三个类别各一个开关，默认全开；开关是账号级的，任何一台设备改了用 `push.kind.set` 只改那一类，所有设备一致，不发测试通知；设置页重新可见时重新读取。
- 点“在这台设备开启通知”：请求通知权限 → 注册 `sw.js` → 用 `publicKey` 订阅 → 发 `push.subscription.set` → 发一条测试通知。权限被拒时说明去哪里重新打开。
- 列出已开通的设备，能单台关闭或移除；`paused` 的设备显示原因。
- `index.html` 加 manifest、`apple-touch-icon` 和主屏应用的 meta。
- 页面显示在前台时每 30 秒发一次 `presence.heartbeat`，切到后台时立即发一次 `visible: false`。
- 删掉记忆页里只在标签页开着时才弹的 `new Notification()`，到期提醒由服务器推送；记忆页提醒栏改为一句说明和“通知设置”按钮。
- 三种语言的文字都进界面语言资源文件。

[↑ 返回阅读导航](#阅读导航)

## 生产入口切换

等第十三版上线后、Hermes 上没有测试在跑时，由 Mac 远程会话做；改配置和重启前要 Andy 在那个线程里打字确认，先备份 `/etc/himawari/config.json`。

1. Hermes 改用 `himawari-test.siyi.win`：改 Hermes 的 Cloudflare Tunnel 主机名和 Hermes 配置的 `publicOrigin`，更新 [Hermes 控制中心升级 Runbook](../../runbooks/hermes-control-center-upgrade-runbook.md) 里的网址。
2. 生产机装 `cloudflared`，建隧道把 `himawari.siyi.win` 转到 `127.0.0.1:8400`；Cloudflare Access 应用只放行 Andy 的邮箱，会话 30 天。`/manifest.webmanifest`、`/sw.js`、图标被 Access 挡住时，只给这几个路径加不检查登录的规则。
3. 生产配置：`publicOrigin` 改为 `https://himawari.siyi.win`；`identity.kind` 改为 `cloudflare-access`，把 Access 身份绑定到现有主人；写 `web-push-vapid` 密钥和 `runPolicy.webPush`。
4. 重启后用真实网页走一遍对话、搜索、记忆页、设置页，再在 iPhone 上加到主屏、开通知，验三类推送。
5. Cloudflare 故障时：远程会话把 `publicOrigin` 改回 `http://127.0.0.1:8400`、`identity.kind` 改回 `built-in`，重启，Andy 用 ssh 隧道打开。

<a id="入口切换实施记录"></a>

### 入口切换实施记录（2026-10-27）

以下时间为日本时间（JST）。各步由 Mac 远程会话线程在 Andy 打字授权后完成，网页推送随第十四版上线。

- 第 1 步：Hermes 已改用 `himawari-test.siyi.win`。Hermes 测试服务自 10-13 起启动失败、每 15 秒重启一次，和本次改名无关，由 Mac 线程跟进；Runbook 里的网址更新也由 Mac 线程跟进。
- 第 2 步：11:38 Andy 自己在生产机装好 `cloudflared` 隧道令牌；`https://himawari.siyi.win` 指向生产机。Access 只放行 Andy 的邮箱，会话 1 个月（不是原定的 30 天）。从外网看，首页跳到 Access 登录页，`/manifest.webmanifest` 和 `/sw.js` 返回 200。
- 第 3 步：11:39 推送开启（`secrets/web-push-vapid.v1`、`runPolicy.webPush`），`publicOrigin` 改为 `https://himawari.siyi.win`。登录切换第一次在 11:53 失败，停服约 9 分钟：原因是配置里 `publicMode` 还是关的，网页端口没开，整库回退又撞上镜像编号不一致。根因和修复见[工程案例 30](../../engineering-casebook.md#case-login-switch-outage) 和 [BL-20261027-008](../../backlog/BL-20261027-008-config-change-preflight-and-verified-rollback.md)。12:54 第二次切换成功，生产登录只用 Cloudflare 邮箱验证码（`identity.kind` 为 `cloudflare-access`）。
- 第 4 步：Andy 在 iPhone 上加到主屏、登录、开启通知，点“发送一条测试通知”后回复“收到了”。三类真实推送、锁屏文字、点开位置、角标、在看不推，以及 iPhone 上的对话、搜索、记忆页、设置页走查还没有确认，记在 [BL-20261027-009](../../backlog/BL-20261027-009-web-push-real-device-acceptance.md)。
- 已知问题：通过 Access 后，前端还要再点一次“登录”。这个问题由界面重构线程处理，不在本规格范围。

[↑ 返回阅读导航](#阅读导航)

## 删除 Bark

删掉 `apps/agent-service/src/production-reminder-push.ts`、它的测试、`service-main.ts` 里的启动和停止代码、配置项 `runPolicy.reminderPush` 和密钥用途 `reminder-push`。配置里再出现 `reminderPush` 时启动失败并指出这个键，避免以为它还在起作用。

[↑ 返回阅读导航](#阅读导航)

## 取舍

- **用 `web-push` 库（固定 3.6.7），而不是自己实现加密和签名。** 它是 Node 上最常用的网页推送库，处理了 RFC 8291 加密和 VAPID 签名的细节；只在一个适配文件里引入，换掉时只改一处。代价是多 5 个间接依赖。
- **待推送表只记来源，不记正文。** 数据库里不会多一份提醒原文或对话标题的明文；代价是每次发送要现取一次正文。
- **扫描而不是在每个写入点发事件。** 三类来源分散在记忆、审批、运行三处，扫描只读、不改它们的写入代码；代价是最多 10 秒延迟，一轮任务结束到手机响平均约 5 秒。
- **在看的判断放在内存。** 心跳每 30 秒一次，写数据库没有意义；代价是服务重启后 45 秒内可能多推一条。

[↑ 返回阅读导航](#阅读导航)

## 验证

- 数据库（`[WP-2]`）：迁移后表和索引存在；订阅按推送地址去重；待推送和发送结果的终态不被覆盖；游标与写入同一事务。
- 调度（`[WP-3]`）：三类来源各推一次且只推一次；重启后不重发；在看就记 `suppressed`；过期、已处理、已删除记 `expired`；各回应码的处理；敏感提醒的锁屏文字；三种语言。
- 发送（`[WP-4]`）：用一个本地假推送服务收请求，用订阅私钥解密出原 JSON，并核对 VAPID 签名、`TTL`、`Urgency`、`Topic`。
- 网关（`[WP-5]`）：4 种消息的结构校验、只许主人、幂等、状态查询不泄露密钥。
- 外壳（`[WP-6]`）：`/sw.js`、`/manifest.webmanifest` 的类型、缓存头和 CSP；后台脚本不拦截请求。
- 配置和删 Bark（`[WP-7]`）：`webPush` 的校验；`reminderPush` 被拒；`push init-key` 不覆盖已有文件、权限 0600。
- 真机：iPhone 主屏应用上收到三类推送、锁屏内容符合规则、点开进对的页面；在看时不推。2026-10-27 只确认了测试通知能到达（见[入口切换实施记录](#入口切换实施记录)），其余项见 [BL-20261027-009](../../backlog/BL-20261027-009-web-push-real-device-acceptance.md)。

[↑ 返回阅读导航](#阅读导航)
