---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0102-record-push-notification-feedback.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0143-decision-ledger-for-model-gate-decisions.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0155-decision-record-observation-and-weekly-report-page.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0182-record-proactive-implicit-signals.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0187-weekly-gap-lines-and-cases-against-muse.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0195-show-the-whole-chain-of-one-decision-record.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0197-one-page-for-one-email-decision.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0214-record-profile-truncation-and-keep-pinned-memories.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0237-model-pre-rates-waiting-decisions.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/calibration/src/thresholds.ts, apps/agent-service/src/production-observation.ts, apps/agent-service/src/production-gap-cases.ts, packages/application/src/services/ledger-observation.ts"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0302：决策记录和校准

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [全系统一本决策记录](#ledger)
  - [依据链](#chain)
  - [推送和主人的反应](#signals)
  - [观察期和校准周报](#calibration)
  - [模型预评](#prereview)
  - [Muse 数据怎样收进来](#muse-intake)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

Himawari 每做一个判断（提醒不提醒、记不记、整理时改不改、截掉哪些记忆），都要能事后查到依据、给主人打分、算出命中率。这些做法原来分散在十一份 ADR 里（0102、0143、0147、0154、0155、0162、0182、0187、0195、0197、0214、0237）。这份 ADR 只写现在为真的做法。规则怎样参与判断见 [ADR 0301](0301-the-owners-rule-book.md)。旧文全文在 `supersedes` 列的固定提交链接里。

<a id="decision"></a>

## 决定

<a id="ledger"></a>

### 全系统一本决策记录

- 所有判断写进同一张表 `decision_ledger`，每行有种类 `kind`（主动检查、记忆候选、整理、上下文截断、检索降级、外部读取、规则重审、记忆重审、推送延后等）、结果、原因码、对象和输入。
- 输入只放编号（记忆编号、规则编号、邮件编号），不放正文；正文只存加密引用。
- 决策记录和它对应的改动写在同一个数据库事务里：记录写不进，改动也不生效。
- 上下文截断（包括档案块放不下）和检索降级只在真正发生时写；同一组被挤掉的记忆只记一次（`appendIfChanged`）。主人打开“每次对话都带上”的记忆不会因为字数被挤掉。
- Gmail 检查每次调用模型的提示词和回答的加密引用记在 `decision_ledger_payloads`，和决策同一事务写入；其他不需要回看的模型调用，结束就删掉留下的加密内容。
- 决策记录的种类和结果写在表的检查约束里，新加种类要用迁移重建这张表。写法约定见[决策记录写入约定](../decision-record-write-convention.md)。

<a id="chain"></a>

### 依据链

- 只读查询 `decision.chain.read` 给一条决策读出完整依据链：判断、规则（按版本）、邮件计数、记忆。记忆显示现在的内容，并标明决策之后改过没有；有体量上限，超出时标明被截断。
- `decision.email.read` 用一页展示一封邮件的判断和依据链。
- 控制中心在提醒检查记录每一行有“依据”按钮，打开抽屉。

<a id="signals"></a>

### 推送和主人的反应

- 每条至少送达一台设备的推送写一行 `web_push_feedback`（发了什么、发到几台、主人是否点开或划掉），不存推送正文。
- 点开、撤销、回复三种信号写进 `decision_signals`，和原动作同一事务。信号只记不用：不拿它改门槛、规则或推送行为。

<a id="calibration"></a>

### 观察期和校准周报

- 服务每 15 分钟写心跳，并对过去的每一天做检查（服务一直在运行、Gmail 检查按时写了记录、记忆没有暂停、整理和决策记录对得上、已检查过的日子没有少记录等），结果只追加（`apps/agent-service/src/production-observation.ts`）。
- 校准周报（`npm run report:calibration` 和网页周报）按决策种类算命中率、多余提醒率、已审漏报率，三个数同一个分母，只代表主人评过的样本。样本少于 5 条时写“样本不足”，不出百分比，绝不写 0%。
- 每天打分时，主动检查一组按配置的比例混入“沉默”的决策（没提醒的），让漏报也能被评到。
- 主人手记的 Muse 提醒条目存在单独的表 `muse_reference_entries`，可以指向同一封邮件；周报按同一封邮件逐封对照，列出 Muse 做对而 Himawari 没做到的案例。差的区间跨 0 或样本不足时只写“分不出差别”或“样本不足”，不写“追平”“落后”。

<a id="prereview"></a>

### 模型预评

- 模型先给待打分的决策预评，存在单独的表 `decision_prereviews`，不带主人已打的分。有花费上限和失败退避。
- 预评和主人打分的一致率够高时，才可以少让主人打一些“模型有把握认为做对了”的条目；这个自动减少默认关闭。模型认为做错的仍然给主人看。

<a id="muse-intake"></a>

### Muse 数据怎样收进来

[ADR 0309](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md) 决定第 10 条：不再对标 Muse，这条接收通道连同存储、周报对照和网页 Muse 页整条删除；删除前现行代码仍按下面。

- Muse 的提醒记录经 `POST /api/muse-intake/v1/batch` 自动送来，两层认证：边缘层用 Cloudflare Access 的服务令牌，应用层再要求单独的应用密钥。配置 `runPolicy.museIntake.enabled` 为真才注册这条路径，否则是 404。
- 只有 Muse 自己能证明的来源（系统记录、聊天记录、由它们推出的）参与数字，其他只存档。含机密的文字不存正文。
- 按批次序号去重，整批重发回“重放”；同一条内容不同进冲突表，不覆盖。距上一批超过 3 小时推一次“Muse 通道中断”，一次中断只推一次。
- 能读到 Gmail 邮件编号的条目，自动和 Himawari 处理过的同一封邮件配对，不要主人介入。“清除 Muse 数据”只删自动收到的条目和它们的评价，手工记的保留。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 每类判断各记一张表：查依据要翻好几处，周报也算不到一起。
- 在决策记录里存正文：会把敏感内容复制一份到另一张表。
- 用推送信号自动调门槛：信号含义不清（没点开不等于不该提醒），只当观察。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 每个判断都能查到依据和当时用的那一版规则。
- 打分和命中率有固定定义，样本少时不出数字。

[返回目录](#contents)
