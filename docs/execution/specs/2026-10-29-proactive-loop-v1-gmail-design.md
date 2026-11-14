---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-10-29"
---

# 系统主动提醒 v1 第一刀：Gmail 只读提醒设计规格

**审阅状态：已批准。** 2026-10-29 00:12，Andy 对最终版方案给出“有条件批准”，提出的 7 条意见都已写入；00:21 他对“日上限后只停模型、不停规则”回复“④ 同意”。决定记在 [ADR 0106](../../adr/0106-proactive-loop-v1-gmail-read-only.md)。方案全文（可批注）：<https://claude.ai/artifact/9pZqvjubwdLZNFpdRCoFCw>。可点原型：<https://claude.ai/artifact/2TCqHHjpJcMaYLyCVA3tD6>，截图基线：`docs/assets/control-center/2026-10-29-v10/`。

<a id="contents"></a>

## 阅读导航

- [目标](#goal)
- [来源](#source-context)
- [范围](#scope)
- [一次检查的流程](#flow)
- [判断规则和地板规则](#rules)
- [推送](#push)
- [上限](#limits)
- [数据](#data)
- [页面和设置](#ui)
- [连接 Gmail 和授权凭证](#connect)
- [出错处理](#errors)
- [验收标准](#acceptance)
- [验证方式](#verification)
- [实现说明](#implementation)

<a id="goal"></a>

## 目标

Himawari 每 15 分钟自己看一次 Andy 的新邮件（Gmail，只读），找出三类内容放进侧栏的“提醒”页：要他做的事、截止时间，以及他可能没注意到的关键信息。只有要紧又快到期的才推送。每次检查不管有没有提醒，都在决策记录里记一行，Andy 可以评价这次判断说得对不对。邮件正文不发给模型，Gmail 里的任何东西都不改。

[↑ 返回阅读导航](#contents)

<a id="source-context"></a>

## 来源

- 愿景：[SOURCE: docs/product-vision.md]
- ADR：[SOURCE: docs/adr/0106-proactive-loop-v1-gmail-read-only.md]
- 推送反馈：[SOURCE: docs/adr/0102-record-push-notification-feedback.md]
- 提醒页和设置四页：[SOURCE: docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md]
- 每个后台任务自己的上限：[SOURCE: docs/backlog/BL-20261028-002-per-task-budget-for-unattended-work.md]

[↑ 返回阅读导航](#contents)

<a id="scope"></a>

## 范围

- 包含：
  - Gmail 只读连接和断开
  - 每 15 分钟检查一次
  - 规则筛选、模型判断、地板规则
  - 推送
  - 单次上限和每日上限
  - 两张新表（`proactive_decisions`、`source_insights`）
  - 提醒页上的邮件条目和没提醒的邮件
  - 决策记录页
  - 设置“通知”和“工具与权限”里的新项
- 不包含：
  - 写 Gmail：发信、回信、归档、标已读、打标签
  - 把正文和附件发给模型
  - 实时位置
  - Gmail 以外的邮箱
  - Pub/Sub 即时推送
  - 读日历：权限现在一起申请，第二刀才用
  - 天气场景：放在第二刀

[↑ 返回阅读导航](#contents)

<a id="flow"></a>

## 一次检查的流程

1. **取新邮件。** 定时任务每 15 分钟触发一次。第一次连接时只看最近 3 天的收件箱；之后用 Gmail 的 `history.list`（按上次的历史编号只取新变化）。返回 404 说明历史编号已过期，这时重新看最近 3 天。
2. **整理格式。** 每封邮件整理成各来源共用的格式：来源、发件人、标题、正文（Gmail 完整格式取回；取不到时退回 Gmail 一行摘要）、附件名、原文链接、时间、`message_id`、`thread_id`、Gmail 分类。已经处理过的 `message_id` 直接跳过。
3. **规则先筛（0 费用）：**
   - 只有垃圾邮件跳过。Andy 自己发出的邮件也送模型（标 `sentByOwner`），但不套地板规则（[ADR 0159](../../adr/0159-gmail-check-reads-full-body-and-the-owners-own-mail.md)）。被 Gmail 归为推广、社交、论坛的邮件不再跳过，和其他邮件一样送模型（[ADR 0158](../../adr/0158-bring-related-memories-into-gmail-checks.md)）。
   - 摘要里有验证码、卡号、密码的，先遮盖再发送，不再整封跳过（[ADR 0146](../../adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md)）。
   - Andy 自己发出的邮件由模型判断：只有明确的将来承诺才生成提醒；最新一封自己发的邮件被判为忽略且有把握时，才把对应条目标成“你已回复”。
4. **模型判断。** 剩下的邮件按批交给模型，模型看发件人、标题和正文（单封最多 16000 字、每批最多 64000 字，超出时保留开头和结尾；密码、卡号等可识别的敏感信息先遮盖）。每封给出：结果（四选一）、有把握 / 拿不准、待办一句话、截止时间、优先级（高中低）、给 Andy 看的一句原因。模型调用走 Pi 运行时（`packages/runtime-pi`），每次检查实际花的钱记在 `proactive_decisions.cost_micros`（单位是百万分之一美元），每日上限按这一列当天的合计来算；不走对话用的用量账本，原因见[实现说明](#implementation)。
5. **地板规则**，见[判断规则和地板规则](#rules)。
6. **写结果和推送。** 写 `source_insights` 和 `proactive_decisions`，再按[推送](#push)决定是否推送。

[↑ 返回阅读导航](#contents)

<a id="rules"></a>

## 判断规则和地板规则

模型给出的四种结果：

| 结果 | 提醒页怎么显示 | 什么时候推送 |
| --- | --- | --- |
| 要你做事 | 待办一句话 + 截止时间 + 优先级，按截止时间分组 | 高优先级且 48 小时内截止 |
| 值得知道 | 一句关键信息，放在“值得知道”组 | 不推送 |
| 可能重要，请看原信 | 写明为什么可能重要，附“打开原信” | 命中地板时推送 |
| 不用管 | 不显示，只进决策记录，头 14 天进没提醒的邮件 | 不推送 |

**地板规则**在模型判断之后、推送之前执行，是 0 费用的确定规则：

- 命中以下任一条就算命中地板：
  1. 发件人地址或域名在“重要发件人名单”里。名单由 Andy 在设置里维护，初始放入银行和信用卡、学校、入管局和区役所、求职相关公司、移动宽带、手机卡。
  2. 发件域名以 `go.jp`、`lg.jp`、`ac.jp`、`ed.jp` 结尾。
  3. 标题或摘要里有中日英三语的金钱词，例如 收费、扣款、入账、付款、退款、账单、請求、引落、振込、入金、返金、invoice、payment、refund。
- 命中地板时，模型结论不得低于“值得知道”。模型判为“不用管”的，强制改成“值得知道”，决策记录的原因写“地板规则抬升”。
- 命中地板且模型给“拿不准”时，强制为“可能重要，请看原信”。
- 模型可以往高判，不能往低判穿过地板。

[↑ 返回阅读导航](#contents)

<a id="push"></a>

## 推送

- 复用 `production-web-push.ts`，增加一种推送来源。点开推送后直接落到提醒页对应那一条并高亮。
- 一次检查有多封要推，就合成一条。
- 落在不推送时段（多段、按星期设，默认 23:00–07:00）里的，顺延到时段结束，再合成一条。
- Andy 正开着 Himawari 网页时不弹推送（沿用现有规则）。
- 同一封信只推一次。
- 推送和决策记录之间用 `push_source_key` 关联，送达、点开和划掉都记在 `web_push_feedback`（ADR 0102）。

[↑ 返回阅读导航](#contents)

<a id="limits"></a>

## 上限

- **单次检查：** 最多 0.1 美元、3 分钟。超了就停，剩下的下次接着看，记一条“到上限”。没有新邮件时花费是 0。
- **每天累计：** 默认 1 美元，在生产配置文件里改，界面不显示费用。到上限后：
  - 当天不再调模型，记一条“到上限（日）”。
  - 0 费用的规则检查照常跑，命中地板的邮件直接以“可能重要，请看原信”进提醒页。
  - 提醒页显示一条红色“今天已到费用上限”。
  - 次日 0 点（JST）自动恢复。
  - 对话不受影响。
- 读失败只记“失败”和失败在哪一步，不推送，15 分钟后照常再看，不连续重试。

[↑ 返回阅读导航](#contents)

<a id="data"></a>

## 数据

迁移 `0062_proactive_checks` 新建六张表：设置、连接、决策记录、内容条目、已处理邮件、待发推送；下面列出 Andy 能在页面上看到的两张。都不存邮件正文。提炼出的待办和关键信息按现有的受保护数据方式加密存储。每次检查发给模型的完整提示词（含这批邮件的发件人、标题、正文，已遮盖密码和卡号）和模型的每段回答，也以加密形式随这一行保存（迁移 0070 的 `decision_ledger_payloads`，见 [ADR 0147](../../adr/0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)），用来解释这次为什么开口；清除记录或断开 Gmail 时一并删除。不自动删除，Andy 可以在设置“数据”里全部删除。

**`proactive_decisions`：每次检查一行**

| 字段 | 记什么 |
| --- | --- |
| `scenario`、`checked_at` | 哪个场景（现在只有 `gmail`）、什么时候检查 |
| `counts` | 新邮件几封、规则跳过几封、交给模型几封、各种结果几封、地板抬升几封 |
| `verdict` | 推送 / 没提醒 / 顺延 / 失败 / 到上限 / 到上限（日） / 要你处理 |
| `reason` | 给 Andy 看的一句话 |
| `push_source_key` | 对应的推送，关联 `web_push_feedback` |
| `cost_micros`、`duration_ms` | 这次实际花的钱（百万分之一美元）和时间（毫秒） |
| `owner_rating` | Andy 的评价：做对了 / 不该做 / 该做没做（数据库里存的值仍是 useful / unneeded / missed） |

**`source_insights`：每条有结果的内容一行**

| 字段 | 记什么 |
| --- | --- |
| `source`、`thread_id`、`last_message_id` | 来源和线程，（`source`，`thread_id`）唯一 |
| `result`、`floor_raised` | 四种结果之一，以及是否被地板规则抬升 |
| `summary`、`due_at`、`priority` | 待办或关键信息、截止时间、优先级 |
| `status` | 待处理 / 你已回复 / 完成 / 不再提醒 |
| `decision_id`、`owner_rating`、`reviewed_at` | 来自哪次检查、Andy 的评价、何时在没提醒的邮件里看过 |

已处理邮件另存一张表，以 `message_id` 唯一，防止重复判断、重复花钱。老线程有新回复时，更新 `source_insights` 里的原条目，不新增条目。

指标计算：

- 命中率和多余提醒率沿用 ADR 0102 的定义。
- 漏提醒指 Andy 对一条“没提醒”的记录点了“该做没做”。
- 漏提醒率只在已审样本内计算：分母是没提醒的邮件里被点过“看完了”的条目数，加上 Andy 在提醒检查记录里评价过的条目数。页面上同时显示分母。

[↑ 返回阅读导航](#contents)

<a id="ui"></a>

## 页面和设置

以基线 v10 为准，建在 ADR 0105 已批的界面上，不新增页面。

| 地方 | 加什么 |
| --- | --- |
| 侧栏“提醒”页 | 邮件待办按截止时间归入现有分组；新增三组：“可能重要，请看原信”“没有截止日期”“值得知道”。每条可点“完成”“不再提醒”“打开原信”，推送过的有“做对了 / 不该做” |
| 提醒页右上角 | “提醒检查记录”：30 天内主动提醒总次数、恰当的提醒、多余提醒数，漏提醒（你查过的邮件里）（附已审数）；每次检查一行，没提醒的可点“该做没做” |
| 提醒页底部（上线头 14 天） | 一行“今天判为不用管的 N 封”，展开只列发件人和标题，每条可点“该做没做”，整份点“看完了”后计入已审数。14 天后停掉、改随机抽查还是继续，由 Andy 决定 |
| 设置 · 通知 | “系统主动提醒”开关；不推送时段（多段、星期几） |
| 设置 · 工具与权限 | “连接的应用”列表，一个应用一行：Gmail（只读）的连接和断开，展开看“会读什么、发给谁”；重要发件人名单 |
| 设置 · 数据 | 全部删除“系统主动提醒记录” |

颜色规则：

- 红色表示要你处理：已到期、今天截止、高优先级、授权失效、今天到费用上限。
- 琥珀色表示看一眼，或者出过状况但已自己恢复：可能重要请看原信、读取失败后会重试、到上限。
- 紫色只表示可以点。
- 其余用黑色和灰色。
- 提醒检查记录里没提醒的行整行淡化。

不显示模型名、token、费用。中、英、日三种语言都要做，电脑和手机都要排版。

[↑ 返回阅读导航](#contents)

<a id="connect"></a>

## 连接 Gmail 和授权凭证

- Andy 在 Google Cloud 建一个自用应用：
  - 打开 Gmail 和日历接口，只申请 `gmail.readonly` 和 `calendar.readonly`。
  - 状态设为“正式”，但不提交审核。
- 然后在设置“工具与权限”点“连接 Gmail”，在 Google 的“未经验证”提示页点继续。
- refresh token（Google 发的长期登录凭据）只存在生产机上，用 `secretReferences` 提供的密钥加密。密钥和凭证在同一台机器上，整机被攻破时加密挡不住；只有 Andy 一个人用，接受这个风险。
- 为什么设成“正式”：“测试”状态的应用 7 天就要重新授权。设成“正式”可以避开这个问题，但这是从文档推出来的，还没实测，验收第 8 天实测。如果第 8 天仍失效：
  - 暂停系统主动提醒，只在 Andy 问时读；
  - 把应用改回“测试”，每周重新授权一次，直到查明原因。
- 断开时，在 Google 那边撤销授权，并删掉所有提炼结果。
- 第一刀的代码不调用日历接口。

[↑ 返回阅读导航](#contents)

<a id="errors"></a>

## 出错处理

| 情况 | 系统怎么做 |
| --- | --- |
| Gmail 接口超时或 5xx | 记“失败”和失败在哪一步，不推送，15 分钟后照常再看 |
| `history.list` 返回 404 | 重新看最近 3 天，靠两层唯一约束保证不重复 |
| 授权被撤销或失效 | 记“要你处理”。提醒页顶部出现红色“重新连接”。暂停检查，等 Andy 重新连接 |
| 模型返回格式不对或没答完 | 模型每批最多看 8 封邮件。答案被截断或读不懂时，先把这批对半拆小再问；答出多少就收多少，没答到的邮件下次再看，不整批作废。拆到单封还是不行，才记“失败”，不推送，邮件下次重看（`message_id` 尚未标为已处理）。失败的原因分开记录：模型调用失败（`MODEL_FAILED_…`、`MODEL_CALL_ERROR`）、没答完（`MODEL_NOT_COMPLETED`）、答案被截断（`MODEL_OUTPUT_TRUNCATED`，输出用满了额度）、读不懂（`MODEL_OUTPUT_INVALID`），决策记录里按原因显示不同的话（I-40） |
| 单次或每日上限 | 见[上限](#limits) |

[↑ 返回阅读导航](#contents)

<a id="acceptance"></a>

## 验收标准

前 9 条用固定时钟和假邮件在测试里自动跑。模型判断一律用 `ScriptedModelPort`（按剧本返回固定结果的假模型）注入，只检查程序行为，跑 100 次必须 100 次通过。后 5 条在生产上用 Andy 的账号、真网页、真 iPhone 做。

1. 已知今天是 11/4，一封发票写着“11/5 前付款”，模型给出高优先级和截止日：推送一条。
2. 推广邮件：和其他邮件一样送模型，并带上搜到的相关记忆。摘要含验证码的邮件：遮盖后发送。垃圾邮件：被规则跳过，不调模型，花费为 0。
3. 区役所来信，摘要只有“请查看附件”：结果是“可能重要，请看原信”，并推送。同样的摘要来自朋友：只进提醒页，不推送。
4. 去重：
   - Andy 在 Gmail 回过的信，条目自动标“你已回复”。
   - `history.list` 返回 404 时重新只看 3 天，不重复推送、不重复生成条目。
   - 老线程的新回复更新原条目。
5. 单次上限调到 0.0001 美元：记“到上限”、不推送、下次接着看，对话不受影响。
6. 不推送时段：
   - 时段里判断要说的，在时段结束时合成一条发。
   - 关掉开关后不读、不记录、不推送。
7. 地板规则：
   - 一封摘要平淡的银行来信，剧本模型判“不用管”：最终结果是“值得知道”，决策记录写着“地板规则抬升”。
   - 同一封信，剧本模型给“拿不准”：最终结果是“可能重要，请看原信”。
8. 每日上限调到极低：
   - 当天不再调模型，记一条“到上限（日）”，提醒页有红色提示。
   - 之后来的银行信仍以“可能重要”出现。
   - 对话照常；第二天自动恢复。
9. 没提醒的邮件：
   - 只含发件人和标题，不含摘要和正文。
   - 点“看完了”之前，已审数不变。
   - 测试里检查第一刀没有调用日历接口。
10. 用 Andy 的账号授权成功，第 8 天仍能读。
11. 点“断开”后，Google 账号的第三方访问列表里已没有 Himawari，提炼结果已删除。
12. iPhone 收到一条真实推送，点开后落到那一条，决策记录显示“你点开了”。
13. 提醒页、决策记录、两个设置页，在中英日三种语言、电脑和手机上都和基线 v10 一致。
14. 上线后先让模型在生产上跑一条最简单的命令，确认聊天功能没被改坏。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## 验证方式

- 按 fast 模式交付：跑相关测试、`npm run check`、`npm run build`。GitHub Actions 已关（ADR 0092），这三项就是质量关。
- 模型判得准不准，不放进这道关。它由两处衡量：
  - Jarvis Test 的真模型层，只记分、不拦截；
  - 上线第一周 Andy 对真实提醒的评价。
- 第一周把实际花费报给 Andy。现在每封邮件花多少钱还没测量。

[↑ 返回阅读导航](#contents)

<a id="implementation"></a>

## 实现说明

2026-10-29 后台 PR 按本规格实现时定下的几处做法，界面 PR 和上线按这里来。

- **费用怎么记。** 对话用的用量账本（`model_budget`）要求每次模型调用挂在一个正在执行的对话 Run（一次对话回合）下面，后台检查没有 Run。所以检查时给模型调用单独发一个只在本次有效的编号 `proactive:<调用编号>`，费用取模型返回的实际花费，写进 `proactive_decisions.cost_micros`。模型调用仍然经过 Pi 的 `PiModelTransport` 和现有的 `TrustedModelProviderAdapter`（负责取密钥、检查数据能不能发出），只是不经过对话账本。
- **推送用哪一类。** 复用已有的“提醒”类推送，来源键是 `proactive:<推送编号>`，所以手机上关掉“提醒”类推送也会关掉邮件推送。点开后打开 `/?reminder=<条目编号>`，由界面 PR 落到提醒页对应那一条并高亮。
- **Gmail 代码放在哪。** 读取和授权在 `packages/platform-node/src/gmail-source.ts`，没有新建单独的包，免得多一套构建和依赖配置。
- **生产配置。** 在 `/etc/himawari/config.json` 的 `runPolicy.proactive` 里写：`modelRef`（用哪个模型，必须允许私密数据，并且 `api` 是 `openai-completions`；TypeSafe 这类只做判定的专用模型启动时就会被拒）、`gmail.clientId`、`gmail.clientSecretRef`（指向 `secretReferences` 里 `purpose` 为 `google-oauth-client` 的一项），可选 `intervalMs`（默认 900000，即 15 分钟）、`bodyCharactersPerMail`（默认 16000）、`bodyCharactersPerBatch`（默认 64000）、旧往来邮件的四个上限 `relatedMailsPerMail`（默认 6，0 表示不找）、`relatedCharactersPerRelatedMail`（默认 2000）、`relatedCharactersPerMail`（默认 12000）、`relatedRequestsPerCheck`（默认 300，见 [ADR 0180](../../adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md)）、（旧配置里的 `perCheckCostMicros` 仍可读，但不再起作用，单次检查没有费用上限）`perCheckMs`（默认 180000，即 3 分钟）、`dailyCostMicros`（默认 1000000，即 1 美元）、`backoffThreshold`（连续被忽略几次后降频，默认 3，范围 0 到 10，0 表示不降频，见 [ADR 0184](../../adr/0184-back-off-ignored-proactive-pushes.md)）。没有这一节时系统主动提醒完全不启动，界面也不显示相关入口。体验版实例不写 `gmail`，改写 `demoInbox`（`ja` 或 `en`），读的是示范收件箱而不是 Gmail，见 [ADR 0236](../../adr/0236-trial-users-get-demo-memories-and-a-fake-inbox.md)。
- **Google 里要填的回调地址。** 固定为网站地址加 `/api/proactive/v1/google/callback`，生产机是 `https://himawari.siyi.win/api/proactive/v1/google/callback`。Andy 建 OAuth 客户端时把它填进“已获授权的重定向 URI”。Himawari 的登录 Cookie 是 `SameSite=Strict`，从 Google 跳回时浏览器不会带上它，所以回调发现没有登录信息时，先返回一张只做跳转的页面，由本站页面带着 `return=1` 再访问一次回调，这一次浏览器会带上 Cookie；如果仍然认不出主人，就跳到设置页显示“连接失败”（I-31）。
- **连接流程。** 设置里的“连接 Gmail”打开 `/api/proactive/v1/google/start`，服务生成一次性的 `state`（防止别人伪造回调，10 分钟有效，只认发起连接的同一台已登录设备），跳到 Google；Google 回到回调地址后，服务换取 refresh token、读出账号邮箱、加密保存，第一次连接时自动打开“系统主动提醒”，然后跳回 `/?settings=apps&gmail=connected`（失败是 `failed`，Andy 在 Google 页点了取消是 `denied`）。
- **网页接口。** 查询 `proactive.overview.read`；命令 `proactive.settings.set`（开关、不推送时段、重要发件人）、`proactive.insight.respond`（完成、不再提醒、恢复、评价）、`proactive.decision.rate`、`proactive.audit.respond`（看完了、该做没做）、`proactive.source.manage`（断开 Gmail、删除全部记录）、`proactive.backoff.restore`（恢复被降频的一类提醒）。

[↑ 返回阅读导航](#contents)
- **界面怎么落地（2026-10-28 界面提交）。**
  - 提醒页把邮件条目和记忆提醒放进同一组分组：已到期、今天、可能重要请看原信、未来 7 天、以后、没有截止日期、值得知道。到期和今天截止的条目整行红底，“可能重要”整行琥珀底。
  - 快照里每个条目多一个 `pushReaction`（推送后你点开了是 `opened`，划掉了是 `dismissed`，没推送或还没反应是空），条目下方据此显示“推送过 · 你点开了”。
  - 点推送打开 `/?reminder=<条目编号>`：网页读完这个参数就从地址栏去掉，打开提醒页，把那一条滚到中间并高亮约 2.6 秒。Google 授权回来的 `/?settings=apps&gmail=connected|failed|denied` 也一样，打开设置的“工具与权限”，在“连接的应用”上方说明结果。
  - “连接 Gmail”“重新连接”直接跳到 `/api/proactive/v1/google/start`。“断开”和“全部删除”先在页内确认，不用浏览器弹窗。
  - 不推送时段用 `HH:MM` 文本框，离开输入框或按回车才保存；格式不对、开始和结束相同、一天都没选时，只在页内提示，不保存。
  - 重要发件人名单点“管理”后一行一个，支持完整地址和 `@域名`，格式不对的项不让保存。
  - 样式单独放在 `apps/control-center/src/proactive.css`。
