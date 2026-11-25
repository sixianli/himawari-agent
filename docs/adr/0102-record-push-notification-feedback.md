---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-28"
---

# ADR 0102：记录每条推送通知的发出和 Andy 的反应，为打扰校准积累数据

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [怎么从记录算出命中和误扰](#analysis)
- [比较过的方案](#options)
- [业界做法](#industry)
- [Pi 复用与 Himawari 负责的部分](#pi-reuse)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[产品愿景](../product-vision.md#jarvis-test) 的 Jarvis Test 第 10 条要求：“连续 30 天统计主动提醒的命中率与误扰率，命中率上升、误扰率下降，趋势可量化”；护城河第 3 样“主动性的校准数据”也只能靠长期记录积累。评审（[ADR 0101](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0101-adopt-product-vision-v2-1.md)）指出系统现在不记录“发了哪条提醒、Andy 怎么反应”。Andy 2026-10-28 14:12（日本时间）对这条建议回复：“同意”。

现状（读代码确认）：

- 网页推送（[ADR 0089](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md)，服务器经浏览器厂商的推送服务把通知送到 Andy 开了通知的设备）有三类：到期记忆提醒（reminder）、等待审批（approval）、任务完成或失败（run）。
- 发送队列表 `web_push_outbox` 和每台设备的发送记录表 `web_push_attempts`（迁移 0058）记下了“发给哪台设备、成没成功”，但队列在过期 7 天后连同发送记录一起删掉，所以留不住 30 天。
- 设备上的后台脚本（`apps/control-center/public/sw.js`，Service Worker：浏览器在页面关着时也能运行的脚本）只在点通知时打开对应页面，不告诉服务器“点了”；划掉通知时什么都不做。

<a id="decision"></a>

## 决定

1. **新表 `web_push_feedback`（迁移 0061）**：每条至少送达一台设备的通知一行，不随发送队列删除。字段：
   - 发了什么：`kind`（三类之一）、`source_ref`（来源编号，例如提醒或审批的编号）、`thread_id`（对应的对话，没有则为空）、`source_key`（队列里的唯一键）；
   - 通过什么发：`channel`，现在只有 `web_push`；
   - 什么时候、发到几台：`first_sent_at`（第一次送达时间）、`devices`（送达的设备数）；
   - Andy 的反应：`opened_at`（第一次点开）、`dismissed_at`（第一次划掉）；
   - `tag`：通知上带的短编号（来源键的哈希，和推送服务的 `Topic` 相同），设备只回报这个编号，不回报内容。
2. **不存通知正文。** “内容摘要”用类型 + 来源编号 + 对话编号表示，需要时按编号回查原始提醒或对话；正文本来就以加密方式另存，在这张表里存明文会违反原则 1“我的信息只在完成任务所必需的范围内被使用和披露”。
3. **什么时候写**：送达记录在“这台设备发送成功”的同一个数据库事务里写入；一台设备重复记一次成功不会把设备数加两次；被“页面正开着”压下、过期、失败的通知不算打扰，不写。
4. **反应怎么回报**：
   - 点开：设备上的后台脚本在打开页面的地址后加 `?push=<tag>`；页面加载后发命令 `push.feedback.record`，再用 `history.replaceState` 把这个参数从地址栏去掉。走页面而不是后台脚本直接发请求，是因为页面已经登录、带着授权编号，后台脚本没有。
   - 划掉：后台脚本在 `notificationclose` 事件里把 `{tag, 时间}` 存进浏览器缓存 `himawari-push-feedback`；下次打开或切回 Himawari 网页时，页面一并回报，成功后删掉缓存。
   - 每次最多回报 50 条；同一条通知的点开和划掉各只记第一次；回报的时间限制在“首次送达”到“服务器当前时间”之间，防止设备时钟不准或伪造。
5. **保留期**：不自动删除。按每天几条通知估计一年几千行，每行只有编号和时间（大小未测量）；Owner 或 Agent 删除时随之删除。
6. **本次不做界面**：只开始积累数据。统计页面要先出原型、经 Andy 批准（[设计基线规则](../../AGENTS.md#approved-web-design-baselines)），记在 [BL-20261028-004](../backlog/BL-20261028-004-proactive-notification-feedback-log.md) 的后续里。

<a id="analysis"></a>

## 怎么从记录算出命中和误扰

“回复”不另存，用对话消息表现算：通知发出后，Andy 在对应对话里发出的第一条消息时间。只读查询（可在生产机上运行，不改数据）：

```sql
SELECT f.kind, f.first_sent_at, f.devices, f.opened_at, f.dismissed_at,
  (SELECT min(m.committed_at) FROM thread_messages m
    WHERE m.owner_id = f.owner_id AND m.thread_id = f.thread_id
      AND m.role = 'owner' AND m.committed_at > f.first_sent_at) AS replied_at
FROM web_push_feedback f
WHERE f.first_sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
ORDER BY f.first_sent_at;
```

建议的初始定义（30 天后按数据再调，改定义时追加到本 ADR）：

- **命中**：送达后 24 小时内点开，或在对应对话里回复。
- **误扰**：划掉且没点开、没回复；或 24 小时内没有任何反应。
- 反应时延 = `opened_at − first_sent_at`。

<a id="options"></a>

## 比较过的方案

- **延长 `web_push_outbox` 的保留期，在上面加反应字段**：改动最少；但队列表的职责是“待发和重试”，过期清理是它的功能，混进统计会让清理规则变复杂，而且队列里还有没送达的条目。不采用。
- **每个反应一行的事件表**：最灵活；但现在只有两种反应、每种只要第一次，事件表要再聚合一次才能算命中率。不采用；以后反应种类变多（例如通知上的按钮）再拆。
- **后台脚本直接用 `fetch` 回报**：点开时不用等页面；但后台脚本没有页面的授权编号，要么新开一个免授权的接口，要么把授权编号存进缓存，两者都放宽了现有的命令授权。不采用。
- **把通知标题和正文存进表里方便看**：查起来直观；但违反原则 1，而且提醒正文属于记忆内容，本来就加密存放。不采用。
- **采用的方案**：独立的反馈表，一条通知一行；点开经页面地址回报，划掉经浏览器缓存回报，都走现有的已授权命令通道。

<a id="industry"></a>

## 业界做法

以下页面 2026-10-28 打开核对。

- Google Analytics 的自动事件表（[GA4 automatically collected events](https://support.google.com/analytics/answer/9234069)）给 Firebase 推送记 `notification_receive`（“when a notification sent by FCM is received by a device when the app is in the background”，仅 Android）、`notification_open`（“when a user opens a notification sent by FCM”）、`notification_dismiss`（“when a user dismisses a notification sent by FCM”，仅 Android）。Himawari 的“送达 / 点开 / 划掉”与这三项对应，也同样接受“划掉只在部分平台能拿到”。
- MDN 对 `notificationclose` 的说明：“fires when a user closes a displayed notification spawned by ServiceWorkerRegistration.showNotification()”，并标注 “Limited availability”。[MDN notificationclose](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclose_event)
- MDN 浏览器兼容数据（[mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) 的 `api/ServiceWorkerGlobalScope.json`）：`notificationclose` 在 Chrome 50、Firefox 44、macOS Safari 16 起支持，iOS Safari 标为不支持；`notificationclick` 的 iOS Safari 也标为不支持。所以 Andy 主要用的 iPhone 很可能报不出“划掉”，点开能否回报要上线后在 iPhone 上实测一次。

<a id="pi-reuse"></a>

## Pi 复用与 Himawari 负责的部分

网页推送和它的反馈完全是 Himawari 自己的产品功能（Pi 是 Himawari 所基于的开源 Agent 框架，管模型和工具循环，不管通知），本次不涉及 Pi，也不改 Pi。

<a id="consequences"></a>

## 后果

- 好处：从上线那天起开始积累 Jarvis Test 第 10 条要的数据；数据只有编号和时间，不含内容。
- 代价：iPhone 上“划掉”大概率拿不到，误扰主要靠“24 小时没反应”判断，会把“看到了但不需要点”的通知也算作误扰；这是已知偏差，30 天后看数据再调定义。
- 迁移号：本表用 0061，因为 0060 已由文件交付功能占用（`0060_thread_artifacts.sql`，已随 PR #68 合进 main）；迁移编号必须连续。
- 后续：统计页面和命中定义的复核，写在 [BL-20261028-004](../backlog/BL-20261028-004-proactive-notification-feedback-log.md)。上线验收时在 iPhone 上点开一条通知，确认 `opened_at` 有值。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md#jarvis-test]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0101-adopt-product-vision-v2-1.md]
- [SOURCE: docs/backlog/BL-20261028-004-proactive-notification-feedback-log.md]
- 工程案例库：[案例 38](../engineering-casebook.md#case-push-feedback)

[返回目录](#contents)
