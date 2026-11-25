---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md"
date: "2026-10-30"
covers: "apps/agent-service/test/production-http-composition.unit.test.ts, apps/control-center/test/app-interactions.unit.test.ts, test/integration/owner-settings-sync.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0122：主人的每一项账户设置都存在服务器上，带版本号，旧设备不能覆盖新值

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [盘点结果](#inventory)
- [决定](#decision)
- [与 ADR 0110 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30 09:35（日本时间），Andy 说：“我一直都是在设置里开启网络搜索的，为什么到了手机写个设置就没有了，我要求所有的用户设置，必须能在各端同步（现在虽然只有手机和电脑的网页版。）”

网页搜索开关本身存在服务器上，它失效的原因是开关绑定了模型配置的摘要，第十九版换主模型后开关就悄悄作废，这一项由审批线程处理（I-29 一带）。本线程负责其余全部设置：逐项盘点存在哪里、各端是否一致、改配置会不会被悄悄重置。

[ADR 0110](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md) 第 3 条已经把称呼、界面语言、主题色（强调色）搬到服务器（表 `owner_preferences`，迁移 0063，事故 I-16），但当时只搬了这三项。

[↑ 返回阅读导航](#contents)

<a id="inventory"></a>

## 盘点结果

按 main `309db34` 的代码逐项核对，网页上一共 13 项主人能改的设置。

| 设置 | 改之前存在哪里 | 各端一致 | 本 ADR 之后 |
| --- | --- | --- | --- |
| 主题（浅色、深色、跟随系统） | 只在浏览器本地存储（localStorage，浏览器给每个网站留的一小块存储） | 否，新设备默认深色 | 服务器 |
| 称呼、界面语言、强调色 | 服务器 + 本地缓存 | 是，但旧设备重新连上会整套覆盖新值，另一台设备改了要刷新才看到 | 服务器，带版本号，切回前台重读 |
| 对话用的模型和思考深度 | 哪里都不存，刷新回到默认 | 都是默认 | 服务器 |
| 允许网页搜索 | 服务器，绑定模型配置摘要 | 是，但改配置会作废 | 审批线程处理 |
| 记忆“每次对话都带”开关 | 服务器 | 是 | 不变 |
| 主动提醒开关、安静时段、重要发件人、Gmail 连接 | 服务器 | 是 | 不变 |
| 推送通知开关和通知种类 | 服务器，按设备分开 | 按设备 | 不变：浏览器的通知授权本来就是每台设备单独给 |
| 侧栏收起、过程区展开 | 不存，界面临时状态 | — | 不变 |
| 未发送的草稿 | 浏览器本地，按设备 | 否 | 不变 |

另有“界面密度”和两个“栏宽”字段存在本地，但网页上没有任何地方能改，本 ADR 删掉它们。除搜索开关外，服务器上的设置都只按“主人 + 助手”保存，没有绑定任何配置摘要，换模型配置不会重置（代码阅读结论，见下面第 4 条的测试）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

Andy 在 2026-10-30 09:49（日本时间）的选择卡上选了方案 A。

1. **账户级设置全部存服务器。** 表 `owner_preferences` 加四列（迁移 0067）：`theme`、`model_ref`、`thinking_level`、`revision`。`owner.preferences.read` 返回六项设置加版本号 `revision`；`owner.preferences.set` 必须带 `expectedRevision`，和服务器当前版本号不同就拒绝（`PORT_CONFLICT`），相同才写入并把版本号加一。浏览器本地只留这份设置的缓存，用来在连上服务器前先画出页面。
2. **旧设备不能覆盖新值。** 网页记下上次和服务器对齐时的版本号。断线时改的设置在重新连上后：服务器版本号没变，就补发；服务器版本号已经变了（别的设备改过），就以服务器为准，丢掉这次断线时的改动。在线时改设置撞上别的设备刚改过，网页重读服务器，把自己这次改的那几项放在服务器最新值上面再存一次，两边改的不同项都保留。
3. **切回前台就重读。** 网页在 `visibilitychange`（页面从后台回到前台时浏览器发的事件）时重读一次服务器设置，所以拿起手机就能看到电脑上刚改的值，不需要新的推送通道。
4. **门槛（事故 I-16 第二次）。**
   - `test/integration/owner-settings-sync.test.ts`：网页源码里只有 `app.tsx` 能碰浏览器存储；`browser-storage.ts` 里每个存储键都必须在“设备状态”或“服务器设置的缓存”白名单里；网页的每一项设置都必须在 `SHARED_OWNER_PREFERENCE_FIELDS` 里，服务器协议必须接收并返回其中每一项。以后谁加一个只存本地的设置，这个测试就失败。
   - `apps/control-center/test/app-interactions.unit.test.ts` 的五条 `[I-16]`：第一台设备改称呼、强调色、主题和模型后，清空本地存储再打开必须看到同样的值；断线设备的旧改动不能盖掉服务器上更新的值；没送到的改动在服务器没变时补发；两台设备同时改不同项都保留；切回前台读到别的设备的改动。
   - `apps/agent-service/test/production-http-composition.unit.test.ts` 的 `[I-16] keeps every owner setting when the model configuration changes`：经真实 HTTP 入口存下六项设置，换一套主模型配置重启服务，再读回来必须一字不差。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0110 的关系

本 ADR 修改 [ADR 0110 的决定](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md#decision)第 3 条：存服务器的设置从三项扩到六项；“没送到服务器的本地改动下次打开先补发，不被旧值盖掉”改为“服务器版本号没变才补发，变了就以服务器为准”，因为原来的做法会让断线的旧设备把整套旧值推上去，盖掉别的设备后来改的值。ADR 0110 的其余决定不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 做什么 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A 账户级设置全部上服务器 | 主题和模型选择也上服务器，加版本号，切回前台重读；推送、草稿、侧栏留在设备上 | 任何一端改，另一端拿起来就是同一个值；手机仍可只收提醒、电脑不收 | 一个迁移；主题选“深色”后手机也变深色，想各端不同要选“跟随系统” | 采用（Andy 选定） |
| B 只补主题 | 只把主题上服务器并修覆盖问题 | 改动最小 | 换模型后刷新仍回默认 | 不采用 |
| C 连设备级也统一 | 在 A 之上，推送通知种类、侧栏收起也全账户统一 | 完全“一份设置” | 做不到“手机收提醒、电脑不收”；电脑收起侧栏会让手机也收起；推送授权仍要每台设备点 | 不采用 |
| 冲突时按每项的时间戳合并 | 每项设置各带修改时间，新的赢 | 断线时的改动也可能保留 | 各设备时钟不准时会选错；断线多久后的改动算“新”说不清 | 不采用，用版本号 + 服务器为准 |
| 改完立刻经实时通道推给另一端 | 走现有的服务器推送事件流 | 两台设备同时开着时立刻生效 | 要改事件流协议和服务端发布点 | 暂不做，切回前台重读已覆盖“拿起手机就对”的场景 |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：Andy 在任何一端改主题、称呼、语言、强调色、模型和思考深度，另一端下次拿起来就是同一个值；旧设备不会再把新值盖回去；以后新加的设置如果只存本地，测试直接失败。
- 代价：数据库迁移 0067（只加列，旧版本仍能读）；上线后第一台打开网页的设备会把自己的主题写到服务器（服务器上原来没有主题），另一台设备会跟着变，Andy 需要时在设置里改一次即可。
- 已存的模型如果以后从配置里去掉，网页显示并使用配置的主模型，但服务器上保留原来的选择，模型回来后自动恢复，不会被悄悄清掉。
- 未验证：没有在真 iPhone 和电脑上同时开着验收，需第二十一版上线后 Andy 实际试。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 事故：[I-16](../incidents-and-gates.md)
- 面试案例：[案例 66](../engineering-casebook.md#case-settings-everywhere)
- 设计规范：[docs/ui-ux-design-guide.md](../ui-ux-design-guide.md)
- [ADR 0105](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md)、[ADR 0110](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md)、[ADR 0107](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0107-every-incident-gets-an-automatic-gate.md)
- 业界做法：[MDN If-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Match)、[Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)、[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)

[↑ 返回阅读导航](#contents)
