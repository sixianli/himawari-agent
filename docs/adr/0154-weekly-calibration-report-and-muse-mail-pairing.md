---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-02"
covers: "packages/persistence-sqlite/test/decision-ledger-migration.contract.test.ts, test/integration/calibration-report.test.ts, test/integration/decision-ledger.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0154：每周校准周报，并让 Muse 对照条目指向具体的一封邮件

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[产品愿景](../product-vision.md)的 Jarvis Test 第 10 条要求统计所有由模型做出的门槛决策的命中率、误扰率和已审漏报率，并附样本量。[ADR 0143](0143-decision-ledger-for-model-gate-decisions.md) 已把这些决策和你的评价（做对了、不该做、该做没做）记进决策记录表，也建了 Muse 对照条目表，但没有任何东西把它们统计成一份可以逐周比较的报告。

Muse 对照条目表只有一个指向「一次 Gmail 检查」的 `paired_decision_id`，而一次检查可以包含多封邮件，所以认不出「Muse 和 Himawari 说的是同一封邮件」。主分支上也没有任何程序自动写这一列。

<a id="decision"></a>

## 决定

1. **一条命令生成校准周报：** `npm run report:calibration -- --db=<product.sqlite>`。只读打开数据库，输出一页 Markdown，写入 `evals/calibration/reports/<结束日期>.md`，并把结果追加一行到 evals/calibration/history.jsonl。窗口默认是最近 7 天，以日本时间当天 0 点为界（结束日不含）。
2. **指标定义：** 样本 n = 窗口内做出的、你评过价的某一类决策的条数。命中率 = 做对了 ÷ n；误扰率 = 不该做 ÷ n；已审漏报率 = 该做没做 ÷ n。三个数同一个分母，只代表你评过的样本。每个数附 95% Wilson 区间和已评条数。
3. **样本不足：** n 小于最小样本数（默认 5，参数 `--min-samples` 可改）时写「样本不足（n 条）」，不出百分比，绝不写 0%。决策类型清单从数据里读，不写死。
4. **历史记录沿用检索评测的做法：** 追加式 JSONL，带 schema 名、提交号、记录时间；下一次运行时与更早的一周比较。同一窗口数据没变就不重复追加。
5. **迁移 0073：** Muse 对照条目表加可空列 `paired_message_id`（Gmail 邮件编号，同一邮箱内唯一，长度 1 到 256）。写入接口 `recordMuse` 加可选的 `pairedMessageId`；「Muse 没提醒」的条目可以只写邮件编号，不再强制写决策编号。
6. **「与 Muse 对照」按同一封邮件逐封比较：** 条目写明邮件编号的，连到 `proactive_processed_messages`，得到 Himawari 对那封邮件的判断（要你做事、值得知道、请看原信算「提醒了」；不用管算「没提醒」；没有这封邮件的记录单列）和你的评价。统计两边都提醒、只有 Muse 提醒、只有 Himawari 提醒、两边都没提醒（你记了 Muse 没提醒、Himawari 也判为不用管）的封数，各桶相加等于配对的邮件数。没写邮件编号的条目单列「未配对」，并显示配对率，不混进逐封比较。Muse 提醒的时机对和内容对的占比用全部提醒条目算，附样本量和区间。
7. **自动配对不在本次范围：** 本版只提供接口和周报，条目里的邮件编号靠手工写入；按发件人、标题、时间窗找候选，再交你确认的自动配对，等 Muse 自动接收端合并、看到 Muse 实际发来哪些字段后另做。（2026-11-07：已由 [ADR 0162](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md) 第 8 条按 Muse 发来的 Gmail 邮件编号自动配对实现，不需要人工确认。）

<a id="options"></a>

## 放弃的做法

- **只按同一天比较：** 不是同一封邮件，达不到「对同一件事」的对照。
- **一开始就让模型判断是不是同一件事：** 邮件内容敏感，要多发给模型；确定的编号可用时没必要猜。
- **把会话编号当作配对键：** 一串往来邮件共用一个会话编号，不能确定是哪一封。
- **合成邮件增加样本量：** 另开线程出方案；合成数据不进本报告的真实命中率。

<a id="consequences"></a>

## 后果

- 门槛：`test/integration/calibration-report.test.ts`（用真实迁移建表的数据库，三项指标和区间与手算一致；没有评价时写「样本不足」；Muse 逐封比较和未配对；历史追加和与上周对比；反向用例：窗口外的决策不计入、未知参数和多个所有者被拒）；`packages/persistence-sqlite/test/decision-ledger-migration.contract.test.ts`（迁移 0073 保留已有条目、拒绝空编号和过长编号）；`test/integration/decision-ledger.test.ts`（邮件编号读写和旧形状仍被拒）。
- 报告只比较你记过 Muse 条目的邮件，样本偏向有提醒的一侧；Himawari 提醒过而你没记 Muse 条目的邮件，和没人记的两边都沉默的邮件，都不在其中。
- 时间窗口按 UTC 毫秒加 Z 的时间字符串比较；库里出现别的格式时命令报错，不出可能错窗口的报告。历史文件里损坏的行会被跳过并提示，不会让命令失败。
- 主分支上目前没有让你记 Muse 条目并指定邮件的界面或自动接收端，所以真实数据在录入入口出现前多半显示「样本不足」。
- 评价沿用决策记录里的三个值，不改界面。

<a id="references"></a>

## 关联文档

- [ADR 0143：决策记录与 Muse 对照条目表](0143-decision-ledger-for-model-gate-decisions.md)
- [产品愿景](../product-vision.md)（Jarvis Test 第 10 条）
- [词表](../glossary.md)
