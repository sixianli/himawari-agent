---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-08"
---

# ADR 0187：校准周报并列 Muse 命中率和多余提醒率两条差距线，每周列出 Muse 做对而 Himawari 没做到的案例

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [上线步骤](#rollout)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 PA-4（Andy 2026-11-08 写，同日同意变更清单和“标记表等 PA-6 的迁移合并后再加”的安排）。Andy 要求 Himawari 的主动提醒做到和 Muse 一样好，差距用决策记录（数据库表 `decision_ledger`，记录系统每次拿主意的那张表，[ADR 0143](0143-decision-ledger-for-model-gate-decisions.md)）里的数据量化。Muse 的提醒按 Gmail 邮件编号和 Himawari 对同一封邮件的判断配对（[ADR 0162](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)，迁移 0079），周报“Muse 对照”一节已按邮件分四个桶。缺的是：把差距变成两个可比较的比例，以及在样本小、数字分不出胜负时仍能看到具体做错的案例。

动手前对着代码核对的现状（main 01873f5）：

- 配对（迁移 0079）和观察信号（迁移 0080，[ADR 0182](0182-record-proactive-implicit-signals.md)）都已在 main。
- 统计在 `packages/calibration`，网页周报和命令行报告共用；这次只在这个包里加统计。
- 仓库里没有 Backlog 捕获脚本，它在 Andy 的文档治理技能里；运行中的 Himawari 也不改仓库。所以“进 Backlog”分两段：Himawari 只标记和导出，另有每周定时的开发会话读取导出、建 Backlog 文件并开 PR（定时会话不在本 ADR 范围）。

产品愿景的取舍依据：用户主权优先，所以案例是否进 Backlog 只由 Andy 点按钮决定，导出接口只读，也不持有能写仓库的凭据；记忆可靠性次之，所以统计只用 Andy 评过的邮件，样本不足就不下结论。

<a id="decision"></a>

## 决定

1. **两条差距线**（`packages/calibration` 的 `summarizeGap`）：只用配对到同一封邮件、且 Andy 评过 Himawari 判断的邮件。“该提醒”= 提醒了且评“做对了”，或没提醒且评“该做没做”；“不该提醒”= 提醒了且评“不该做”，或没提醒且评“做对了”。命中率 = 该提醒的邮件里这一方提醒了的占比；多余提醒率 = 不该提醒的邮件里这一方提醒了的占比；差 = Muse − Himawari。每个比例带 95% Wilson 区间（命令行 Markdown 报告里逐侧列出；网页上只显示两侧比例和差的区间），差带同一批邮件的配对差区间（Newcombe 1998 方法 10，对相关系数的连续性修正与原文一致：差值大于 n/2 才减 n/2、介于 0 与 n/2 之间记 0、为负原样保留）。记忆不和 Muse 比，不做记忆的差距线。
2. **不下结论的规则**：任一分母少于最小样本数（5），或差的区间跨 0，网页和报告只写“样本不足，只看案例”或“区间跨 0，分不出差别”，不写“追平”“落后”。区间不含 0 时才写哪一方的比例更高。周报写明偏差：真值只来自 Andy 评过的邮件。
3. **案例清单**：入选条件是逐封比较里“只有 Muse 提醒”（Himawari 判断为不用管或跳过）且（Muse 的时机和内容都被评对，或 Andy 给 Himawari 评了“该做没做”）。每条带 Muse 的标题和文字、Himawari 的判断和理由、取回的相关记忆数和读到的往来邮件数。同一封邮件在一周里有多条 Muse 条目时只出一个案例（取最早的一条，和差距线的按邮件配对口径一致）。归因标签由程序按那封邮件所在那次检查的读取记录判定（读取状态是整次检查级的，同一次检查里的几封邮件会得到相同的“没读全”或“没取到”），不调模型，顺序固定：没读全（往来邮件读取为部分或失败）→ 没取到（记忆检索为关闭、部分或失败）→ 没记住（检索正常但这封邮件取回的记忆为空）→ 判断错。“没记住”分不清是没存还是存了没匹配上，界面和文档都这样写。
4. **稳定编号**：案例编号 = `gap_` + 邮件编号哈希的前 20 位十六进制（不含 Muse 条目编号：Andy 重新评价 Muse 条目会换条目编号，编号若含它，已加入 Backlog 的标记就对不上了），同一封邮件的案例永远是同一个编号，也不暴露邮件编号。
5. **数据读取**：决策记录端口新增只读的 `readGapCandidates`（Muse 已提醒且配对的条目，连同对应的 Himawari 判断、评价、理由和读取记录）；案例在 `apps/agent-service/src/production-gap-cases.ts` 里按上面的规则筛选和归因，文字经现有的加密载荷读取。周报快照新增 `gap`（差距线，整周结束后才有）和 `gapCases`（案例，带是否已标记）。
6. **“加入 Backlog”按钮只做标记**：命令 `proactive.gapcase.mark`（payload：案例编号、周的结束日、是否标记）。标记时服务端重算那一周的案例找到该编号，把案例快照加密存成载荷，在新表 `gap_case_marks`（迁移，主键 owner + agent + case_id）记一行；再点一次取消，删行并释放载荷。重复标记不重复写。
7. **只读导出接口**：`GET /api/gap-cases/v1/export`，返回所有已标记案例，每条带稳定编号、周范围、归因标签，以及按仓库现有 Backlog 条目写法预填的 `title`、`summary`（背景）、`why`（为什么）、`origin`（来源案例）。鉴权复用 Muse 推送那一套：`Authorization: Bearer` 令牌（哈希后恒时比较，认证通过 30 次/分钟、认证失败 60 次/分钟限流）加外层 Cloudflare Access 服务令牌。限流和比较抽成 `BearerGate`，两处共用，不另写一套。令牌是单独一把：在 `runPolicy.museIntake` 里加可选的 `gapExportSecretRef`，用途 `gap-export`，这样 Muse 推送的令牌读不了导出。未鉴权返回 401 空体。某条标记读不出、解不开或结构不对时跳过该条，不让整个导出失败；导出体里的 `skipped` 写明跳过了几条，如果所有标记都读不出（多半是密钥或存储出了问题）就返回 500 而不是空清单。周报里某段 Muse 文字解不开时，只是那一段显示为没有留存，不影响整页和其他案例。预填文字先遮盖来源再拼装截断，避免敏感值被截断边界切开后漏遮。已知局限：取消标记或清除数据时，数据库已改而快照释放失败（或进程恰好在两步之间崩溃）会留下孤儿快照，沿用现有清除路径同样的先改库后释放写法，暂无待释放记录；案例候选读取有 1000 条硬上限，超过后清单静默截断（差距线不受影响）。“清除 Muse 数据”会一并取消所有已标记案例并释放它们的快照（用户说清除就必须真清除；三种语言的确认文案都写明）。导出里的 `origin` 周范围写到周的最后一天（窗口结束边界是排他的，减 1 毫秒再转日期）。输出前所有预填文字经 `sensitive-capture` 的出口遮盖（密码、验证码、银行卡号、证件号、机器密钥）。
8. **不新增任何发给模型或嵌入服务的请求**，所以不涉及统一出口、提示词目录和请求前缀冻结；也不动敏感识别规则。
9. 界面用词按词表：“误扰率”是词表里的旧叫法，改称“多余提醒率”（对应“多余的提醒”）。

<a id="options"></a>

## 放弃的做法

- **由 Himawari 直接写 Backlog 文件或调用文档治理脚本**：生产服务器要拿到能改代码仓库的权限，还要在产品里复制一套 Backlog 的写法。
- **让模型判案例的归因**：多一次模型调用，结论不可复现；现有读取记录已能判定四类。
- **用 Muse 自己的时机/内容评价当“该提醒”的真值**：Muse 的评价只覆盖 Muse 提醒过的条目，没提醒的邮件没有真值，命中率会算偏。
- **导出和 Muse 推送共用同一把令牌**：Muse 一端也能读到案例内容。多一把令牌只多一次配置。
- **把标记存进现有的表**：会把两种数据混在一起，也没法在取消标记时单独释放载荷。

<a id="rollout"></a>

## 上线步骤

上线后按下面做，之后每周定时的开发会话才能读到导出：

1. 在生产机密钥目录（权限 0700，文件 0600）放一个至少 32 字符的随机令牌，在 `/etc/himawari/config.json` 的 `secretReferences` 加 `{"ref":"gap-export","version":"v1","purpose":"gap-export","scope":"agent"}`（四项缺一不可），并在 `runPolicy.museIntake` 加 `"gapExportSecretRef":"gap-export"`。
2. 在 Cloudflare 的 Zero Trust 里给路径 `api/gap-cases/v1/export`（主机 `himawari.siyi.win`）加一条 Service Auth 策略，并建一个 Service Token（名字写 `gap-export`），做法同 Muse 推送的 `muse-intake`（见 [Muse 自动接收运行手册](../runbooks/muse-intake-runbook.md)）。
3. 把两样东西交给每周定时的开发会话：Cloudflare 的 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`，以及应用令牌。
4. 实测：不带头请求被拦；只带 Cloudflare 两头返回 401 空体；三样都带返回 200 和 `{"schema":"himawari-gap-cases.v1","cases":[...]}`。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `packages/calibration/test/gap-lines.unit.test.ts`：真值规则；样本不足不下结论；样本够且区间不含 0 才给方向；两边一样好时区间跨 0 不下结论；配对差区间的两端；案例入选的正反用例；归因顺序。
  - `test/integration/gap-cases.test.ts`：真实数据库和真实加密载荷里，只列 Muse 做对而 Himawari 没提醒的邮件、归因正确、编号稳定；标记后出现在导出并带预填内容、取消后消失、重复标记不重复；未鉴权（无头、令牌错、方案错）一律 401 空体；标记不存在的案例被拒；导出里的密码被遮盖；周报 Markdown 含“Muse 差距线”且不写“追平”“落后”。
  - `apps/control-center/test/weekly-report.unit.test.ts`：差距线和案例清单在网页显示；样本不足时写“只看案例”；没有案例时不出现按钮；点按钮发出命令、已标记状态显示、失败时提示并保持原状。
  - `packages/platform-node/test/startup-configuration.unit.test.ts`：`gapExportSecretRef` 必须指向用途为 `gap-export` 的密钥；指向 Muse 令牌或不存在的引用被拒绝。
  - `packages/persistence-sqlite/test/migration-engine.contract.test.ts` 等迁移序号测试更新。
- 已知局限：
  - 差距线只覆盖配对且 Andy 评过的邮件，样本偏向有 Muse 条目、Andy 愿意评的邮件。
  - 案例清单每周最多 50 条，网页只显示当周；已标记的案例留在导出里，直到 Andy 取消。
  - 标记时存的是当时的案例快照，之后评价变化不会改已标记案例的内容。
  - 周报按 Muse 条目发生的时间归周。
- 定时开发会话、Backlog 文件的生成和 PR 不在本 ADR 内。导出可以在 P5-1（MCP server）完成后换成 MCP 只读工具，本次不做。

<a id="references"></a>

## 关联文档

- [ADR 0143：决策记录](0143-decision-ledger-for-model-gate-decisions.md)
- [ADR 0162：Muse 数据的接收方式](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)
- [ADR 0182：主动提醒的观察信号](0182-record-proactive-implicit-signals.md)
- [Muse 自动接收运行手册](../runbooks/muse-intake-runbook.md)

[返回目录](#contents)
