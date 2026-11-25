---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0106：主动闭环 v1 第一刀：Gmail 只读，每 15 分钟检查，地板规则兜底，每次判断都记决策日志

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[产品愿景 v2.1](../product-vision.md) 要 Himawari 主动替 Andy 盯事，Jarvis Test 第 3 条（主动拦截）和第 10 条（打扰要有收益）还没有任何实现。仓库里也没有“主动闭环”这个任务的定义，由线程起草方案，Andy 逐条批注后定稿。方案全文（Claude Doc）：<https://claude.ai/artifact/9pZqvjubwdLZNFpdRCoFCw>；可点原型：<https://claude.ai/artifact/2TCqHHjpJcMaYLyCVA3tD6>。

过程中 Andy 的关键原话（日本时间）：

- 10-28 23:00 批注：“我希望可以完全接入我的gmail，然后主动帮我看邮件，管理邮件中的待办事项，管理邮件的优先级，管理邮件中我可能没有注意到的关键信息”；单次上限“0.1美元，3分钟”；不推送时段“像iphone的专注模式或者睡眠模式一样”可自由设置。
- 10-28 23:06 在选择卡上选“按你的推荐来”：第一刀 Gmail 只读，天气放第二刀。
- 10-28 23:18 批注：“如果通过标题和gmail自带的一行摘要无法判断但这个邮件可能很重要的话，可以提醒用户去查看原邮件”。也就是正文不发给模型。
- 10-29 00:12 审核意见“有条件批准”，提出 4 条必改和 3 条建议（地板规则、自动验收不调真模型、日累计费用上限、漏报审计、凭证残余风险、日历权限取舍、去重约束）。10-29 00:21 对“日上限后只停模型、不停规则”回复“④ 同意”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **第一刀只做 Gmail，只读。** 只申请 `gmail.readonly`，同时申请第二刀才用的 `calendar.readonly`。提前申请日历权限是有意取舍：少打断 Andy 一次授权。第一刀的代码不读日历，测试检查没有调用日历接口。不发信、不归档、不打标签。
2. **每 15 分钟检查一次。** 第一次连接只看最近 3 天；之后用 `history.list` 只取变化，返回 404 时重新看 3 天。不用 Pub/Sub 即时推送。
3. **模型只看发件人、标题和 Gmail 自带的一行摘要，不看正文和附件。** 摘要含验证码、卡号或密码的不发模型。（2026-11-01 更新：验证码等改为遮盖后发送，见 [ADR 0146](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md)；模型除邮件外还会看到搜到的相关记忆，邮件正文仍不发，见 [ADR 0158](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md)；促销、社交、论坛不再整类跳过。）模型给四种结果之一（要你做事 / 值得知道 / 可能重要，请看原信 / 不用管），同时给“有把握 / 拿不准”。
4. **地板规则。** 模型判断之后、推送之前，用 0 费用的确定规则检查。命中以下任一条就算命中地板：发件人在 Andy 维护的“重要发件人名单”里；发件域名是 `go.jp`、`lg.jp`、`ac.jp`、`ed.jp`；标题或摘要里有中日英三语的金钱词。命中地板时，结论不得低于“值得知道”；模型拿不准时强制为“可能重要，请看原信”；被抬升的都在决策日志里写明。名单里的发件人即使被 Gmail 归为推广，也照常判断。“公司类”不能用规则判断，所以由名单代替。
5. **推送只给两种结果。** “要你做事”在高优先级且 48 小时内截止时推送；“可能重要”在命中地板时推送。一次检查合成一条；不推送时段（多段、按星期，默认 23:00–07:00）里的顺延到时段结束；Andy 正开着网页时不弹。
6. **两层上限。** 单次检查最多 0.1 美元、3 分钟。每天累计默认 1 美元，在生产配置里改，界面不显示费用（ADR 0105）。到日上限后当天不再调模型，记一条“到上限（日）”，0 费用的规则检查照跑，命中地板的直接以“可能重要”进提醒页，提醒页显示一条红色提示，次日 0 点（JST）恢复；对话不受影响。这是 [BL-20261028-002](../backlog/BL-20261028-002-per-task-budget-for-unattended-work.md) “每个后台任务自己的上限”的第一个实现。
7. **决策日志。** 新表 `proactive_decisions` 每次检查一行，新表 `source_insights` 每条有结果的内容一行。`source_insights` 用 `source` 列区分来源，以后接 Notion、Slack、Outlook 只加读取包。去重分两层：已处理邮件按 `message_id` 唯一；提醒条目按（`source`，`thread_id`）唯一，老线程有新回复时更新原条目。都不存正文。
8. **漏报要审计。** 上线头 14 天，提醒页底部每天一份“今天判为不用管”清单，只列发件人和标题。Andy 点“看完了”后才计入已审数。漏报率标为“已审样本内”，并显示已审数。14 天后怎么办由 Andy 决定。
9. **自动验收不调真模型。** 自动测试里的模型判断一律用 `ScriptedModelPort` 注入固定结果，只检查程序行为，必须 100 次 100 次通过。模型判得准不准由 Jarvis Test 真模型层（只记分）和上线第一周 Andy 的评价衡量。
10. **授权凭证。** refresh token（Google 发的长期登录凭据）只存在生产机上，用现有密钥引用（`secretReferences`）提供的密钥加密。残余风险如实记下：密钥和凭证在同一台机器上，整机被攻破时加密挡不住；只有 Andy 一个人用，接受这个风险。应用设为“正式但未审核”，避开“测试”状态 7 天失效（这一点是从文档推出来的，第 8 天实测）。如果第 8 天仍失效，就暂停主动检查、只在 Andy 问时读，同时改回“测试”状态，每周重新授权，直到查明原因。
11. **界面基线 v10。** 提醒页上的 Gmail 条目和抽查清单、决策记录、设置“通知”和“工具与权限”的新项，截图和原型存为 `docs/assets/control-center/2026-10-29-v10/`。颜色只表达含义：红色=要你处理，琥珀色=看一眼或已自愈的状况，紫色=可点，其余黑灰。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **第一刀先做“明天的安排 × 天气”。** 规则简单、成本低，但 Andy 更看重邮件，“只做截止日期还不够”。所以天气放到第二刀。
- **把正文前 4000 字发给模型。** 判断更准，但 Andy 要求只发标题和摘要，判断不了的给“可能重要，请看原信”。按原则 1 只在必需范围内披露，选后者。
- **用 Pub/Sub 即时推送。** 更及时，但要额外开 Google Cloud 服务；对一个人的邮箱，每 15 分钟一次已经够用。
- **只设单次上限。** 挡不住“每轮都重判旧邮件”这类缺陷全天持续花钱。所以加了日累计上限。
- **日上限后完全停止检查。** 这样地板规则也停了，会漏掉当天的银行信。Andy 同意只停模型。
- **只按 `message_id` 唯一。** 这和“老线程有新回复时更新原条目”矛盾，因为每个新回复都有新的 message id。所以分两层。
- **提醒放在设置页或记忆页。** Andy 否决；按 ADR 0105，放在侧栏独立的提醒页。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Claude 的 Google Workspace 连接器：“only accesses your data when you explicitly ask”（<https://support.claude.com/en/articles/10166901-use-google-workspace-connectors>），也就是用户问了才读。
- Meta AI 连接 Gmail：“won’t download your whole inbox”（<https://www.meta.com/help/artificial-intelligence/1687253048996149/>），按任务搜索。
- ChatGPT Pulse：连上 Gmail 后每晚在后台读一次，第二天早上给简报。OpenAI 官方页返回 HTTP 403，这条取自报道，未核对原文。
- Google：“测试”状态的应用 “is issued a refresh token expiring in 7 days”（<https://developers.google.com/identity/protocols/oauth2#expiration>）。增量同步用 `history.list`（<https://developers.google.com/workspace/gmail/api/guides/sync>）。
- Horvitz《Principles of Mixed-Initiative User Interfaces》（CHI 1999）：“Autonomous actions should be taken only when an agent believes that they will have greater expected value than inaction for the user”。

和它们相比，Himawari 的不同在三点：每 15 分钟检查、急事当场推送；每次要不要开口都记进日志，并用 Andy 的评价来校准；授权和提炼结果都在 Andy 自己的服务器上。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：
  - 有了第一个可以衡量的主动场景，命中率、误扰率和已审样本内的漏报率都能从日志里算出来。
  - 费用有两层上限。
  - 以后接新的来源，不用改判断、日志、推送和提醒页。
- 代价：
  - 只看标题和摘要，判断比看正文粗。
  - 地板规则会把一部分不重要的银行营销信抬到“值得知道”。
  - 头 14 天 Andy 每天要花一点时间抽查。
  - refresh token 和加密密钥在同一台机器上。
- 后续工作：
  - PR 2 做后台：`integration-gmail` 包、两张新表（迁移号合并前和 main 对齐）、规则和地板、上限、推送。
  - PR 3 做页面。
  - 上线后第 8 天验证授权没有失效。
  - 第一周把实际花费报给 Andy。
  - 14 天后由 Andy 决定抽查清单的去留。
  - 第二刀做天气。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [主动闭环 v1 第一刀设计规格](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md)
- [产品愿景](../product-vision.md)
- [ADR 0102 推送反馈记录](0102-record-push-notification-feedback.md)
- [ADR 0105 提醒页和设置四页](0105-ui-batch-2026-10-28-show-what-the-owner-needs.md)
- [案例 45](../engineering-casebook.md#case-proactive-gmail)

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](0234-one-program-per-person-database-file.md) 之后，第 10 条“只有 Andy 一个人用，接受这个风险”只对 Andy 自己的那一份成立。其他受邀的人各有自己的库和密钥，每人一把数据密钥，邀请时告知 Andy 技术上能读所有人的文件。本 ADR 的决定不变。
