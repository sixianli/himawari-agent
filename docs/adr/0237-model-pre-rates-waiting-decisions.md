---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0237：模型先给待打分的决策预评，单独存放，一致率够高才减少要 Andy 打分的条数

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

「每天打分」是 Andy 在网页「提醒」页里给 Himawari 的决策打分的地方：读完邮件提醒了没有、没存下的记忆该不该存、整理记忆对不对，每条选“有用 / 不需要 / 漏了”。每条决策是表 `decision_ledger` 的一行，也就是一条决策记录（见 [ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）。打分要花 Andy 的时间，而产品愿景把 Andy 的审核带宽列为实际瓶颈。

实施清单 P4-8 要求：模型先给每条待打分的决策评一次，预评单独记录、绝不写进 Andy 的打分；周报给出模型和 Andy 的一致率；一致率到门槛后，「每天打分」只给 Andy 看模型拿不准或和以往打分冲突的那些；这种自动减少默认关闭、门槛可配、有测试。

业界做法：用模型代替人打分之前，先拿人评过的样本量出“模型和人一致的比例”，一致率要显著高于随手猜，才把模型的判断用在人看不到的地方（[Zheng 等，Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) 用人和模型的一致率衡量裁判模型；[Cohen 的 kappa](https://en.wikipedia.org/wiki/Cohen%27s_kappa) 扣掉了碰巧一致的部分）。样本少时比例的误差很大，所以用置信区间的下限而不是点估计做门槛（[Wilson 区间](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)）。被隐藏的那部分里仍随机留一部分给人看，用来持续抽查，这是选择性预测和人在回路系统的常见做法。

<a id="premises"></a>

## 前提

1. 原则顺序：`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”
2. 审核带宽是瓶颈：`docs/product-vision.md:196`，“实际瓶颈正是我的审核带宽（打分、确认、批准）。”
3. Andy 在 2026-11-11 本线程的任务块里写明：预评“单独记录，绝不写进你的打分”；自动减少“默认关闭，门槛可配，并有测试”；模型调用走统一出口，提示词登记进目录。
4. Andy 在本线程回复“按照你的建议来做”，采纳了：一致率门槛 90%、按 Wilson 下限比较、预评默认开启并每天最多 50 条、“模型必须比瞎猜更准”、抽查 20%、网页周报也显示一致率。
5. 默认值写在代码里：`packages/calibration/src/prereview.ts:20-22`，`DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE = 800`、`DEFAULT_PREREVIEW_AGREEMENT_PERMILLE = 900`、`DEFAULT_PREREVIEW_AUDIT_PERMILLE = 200`；`packages/application/src/services/review-prereview.ts:41-49`，`enabled: true`、`dailyLimit: 50`、`reduction` 里 `enabled: false`。
6. 提示词登记在目录：`packages/prompt-catalog/src/review.ts:48`，`export const REVIEW_PREREVIEW = fixedPrompt({`。

<a id="decision"></a>

## 决定

1. **单独一张表。**新表 `decision_prereviews`（迁移 0091）存每次预评：对应哪条决策记录或哪封邮件、属于哪类决策、模型评了什么、把握多大（0 到 1000）、和 Andy 以往打分是否冲突、用的模型和提示词版本、文字的 SHA-256 摘要、费用和耗时。失败的调用也存一行（`status = failed`），带费用。这张表不许改（触发器拦下 UPDATE），只在它所属的决策记录或邮件记录被删掉时随之删除。Andy 的打分仍只在 `decision_ledger.owner_rating` 和邮件记录里，预评从不写那里。依据前提 1、3。
2. **发给模型的内容不带 Andy 的打分。**提示词先放目录里的固定文字，最后一行放这条决策的类别、可选评价、记忆类别和遮盖过敏感信息的文字。Andy 已打的分不在请求里。文字看不到（受限内容、没有原文）的条目不预评。
3. **花费有上限，失败有退避。**每次定时检查后最多预评 `perRun` 条，每天最多 `dailyLimit` 次尝试、`dailyCostMicros` 费用；尝试次数和费用都从表里数，重启不会重置。模型已经回答、但读历史或写结果失败时，也写一行失败记录带上这次的费用；连失败记录也写不进时，只在内存里退避。失败的条目 24 小时内不再试。预评模型不允许其数据级别的条目（例如模型只允许 private、条目是 sensitive）不预评、不落失败行、不占 `perRun` 名额和每日次数，只在运行结果里计数；同一条目 24 小时内进程内不重复读取原文，模型放开级别后下一次检查就会评它（[PR 501](https://github.com/sixianli/himawari-agent/pull/501)）。失败原因只记形如 `MODEL_FAILED:...` 的代码，其他错误文字一律记 `unknown`，以免把条目原文带进这张只存元数据的表。还没被 Andy 评过的条目先评。
4. **一致率和门槛。**只拿服务当前用的（模型，提示词）版本比较，提示词版本号 `promptId` 由目录里的固定文字和每类决策的可选评价一起算出摘要，可选评价变了版本号也变。隐藏用最近 `windowDays` 天内做出的决策的配对，周报用这一周内做出的决策的配对，两者都按决策时间取窗口、用同一个版本，只是窗口长短不同，所以周报上的门槛结论是“按这一周的配对”，不一定和隐藏时的结论相同。“会被隐藏”的配对是：模型评“有用”、把握不低于 800、和以往打分不冲突。这些配对里和 Andy 一致的比例，Wilson 下限要不低于 90%，并且要高于 Andy 在这类决策里评“有用”的比例的 Wilson 上限，也就是比“全当有用”这种猜法更准。依据前提 2、4。
5. **自动减少。**默认关闭。只隐藏模型有把握评“有用”的条目，也就是模型认为 Himawari 做对了的那些；模型有把握评“不需要”或“漏了”的仍然给 Andy 看，因为那是模型认为 Himawari 做错了，正需要 Andy 确认和纠正。一致率门槛最高只能配到 99.9%：样本有限时 Wilson 下限永远到不了 100%，配 100% 等于永远不开。打开后，只在过了门槛的那类决策里隐藏“会被隐藏”的条目；隐藏前再算一次文字摘要，和预评时不同就不隐藏；按条目键的哈希固定留 20% 给 Andy 抽查。「每天打分」顶部写明这次有几条被模型挡下了。依据前提 1：自动减少只省 Andy 的时间，不替他做决定，他随时能关。
6. **周报。**周报脚本和网页周报都加“模型预评一致率”：每类决策的预评数、拿不准数、配对数、一致率和区间、kappa、平衡准确率、“会被隐藏”配对的一致情况、门槛结论，以及来自旧版本的预评条数。周还没结束时不给比例。历史记录升到 v4，仍能读 v3。

<a id="options"></a>

## 放弃的做法

- **把预评写进 `decision_ledger` 的新列。**省一张表，但一旦写错列就会冒充 Andy 的打分，违反前提 3。
- **只看点估计的一致率。**样本少时 10 条全对也会显示 100%，门槛形同虚设。
- **不留抽查。**隐藏开始后就再也拿不到“会被隐藏”的那部分的新配对，一致率会停在开启那一刻，模型变差也看不出来。
- **命令行周报读产品配置。**`scripts/calibration-report/report.mjs` 只读数据库，不读产品配置，门槛按默认值算，版本取窗口里最新的那一版；网页周报按产品配置和服务当前的版本。两者在配置改过默认值时会不同，命令行报告里写出了它用的门槛数字。
- **提示词版本号包含遮盖规则的版本。**遮盖规则在代码里，没有独立的版本号；改了遮盖规则而固定文字和可选评价没变时，新旧预评仍算同一版本。
- **配对时再核对文字摘要。**一致率按预评当时的文字算，文字后来被改的条目仍参与配对；这一点只影响统计，不影响隐藏（隐藏前会核对）。为了不在每次读周报时重读全部原文，暂不核对。

<a id="consequences"></a>

## 后果

- 每天最多 50 次低价模型调用，费用计入模型用量表，用途记为 `review-prereview`。
- 只跑一个服务实例：同一条目同时被两个实例预评时，可能一条成功、一条失败各留一行，统计只看成功的行。
- 提示词文字或可选评价改了，`promptId` 跟着变，旧版本的预评不再参与一致率，需要重新积累配对；周报会写出旧版本的条数。
- 自动减少默认关闭，Andy 需要在配置里打开 `runPolicy.proactive.reviewPrereview.reduction.enabled` 才生效。

<a id="verification"></a>

## 验证

- `test/integration/review-prereview-production.test.ts`：真实 SQLite，经 `ProductionProactive` 走完预评、上限、失败退避、自动减少的正反向、级联删除。
- `test/integration/review-prereview-browser.test.ts`：真实浏览器里「每天打分」的提示和周报卡片，各有反向用例。
- `test/integration/data-export.test.ts`：预评随数据导出导入往返，没有口令时不导入。
- `packages/calibration/test/prereview.unit.test.ts`、`packages/application/test/review-prereview.unit.test.ts`：门槛、抽查、提示词不带打分。

[↑ 回到阅读导航](#contents)
