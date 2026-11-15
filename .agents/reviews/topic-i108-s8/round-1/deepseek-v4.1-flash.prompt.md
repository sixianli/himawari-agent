你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 f83e5eab3a6e7fd784c4b3b358790d692151b5a4。
本 PR 的基线提交是 3cbd77356f7f65db72d28ae15ee687fa4dd3e912（main 与 f83e5eab3a6e7fd784c4b3b358790d692151b5a4 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0279-history-is-compared-only-while-the-service-is-stopped.md（在提交 f83e5eab3a6e7fd784c4b3b358790d692151b5a4 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0279：上线时历史数据只在服务停着时比较，S8 不再逐行比对

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

上线的第 8 步 S8（新版本启动之后的读回）原来会把生产库和第 3 步保存的数据库副本逐行比较，规定“上线前已有的行不能删、列不能变”。运行中的服务本来就会改老行，所以它拦过两次上线，两次都是正常写入：第十一次是启动恢复改写 `sandbox_execution_records.recovery_json`，第二十九次（[I-108](../incidents-and-gates.md#incidents)）是服务结算预算改了 `model_budget_accounts`。第二十九次当时给 Andy 的临时办法是为这一次上线关掉整类历史比较，下一个版本会重新被拦。

Andy 2026-11-15 的要求：找根因，不打补丁，也不做一次性豁免。他同意本 ADR 的方案（原话“同意”，项目线程消息 `cmsg_01EE1hey9cboYNfwFnBv5dgrYWwNxFFj8F6VYrAWGtGRVM`）。本决定在产品愿景的裁决顺序里依据“边界与可逆性”：上线前的整库副本一直保留，真出事可以恢复。

<a id="premises"></a>

## 前提

1. 服务停着时，12 张历史表已经连续按“整表摘要完全相等”比较：`scripts/delivery-mode/packet-template/maintenance/P-readback-design.md` 的“历史不变的比较链”第 1 到 4 条，最后一次是 `scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py` 里换服务定义和启动新版本之前的 `if upgraded_state['history'] != state['history']: raise …SWITCH_HISTORY_CHANGED`。出包时迁移改历史表会被 `make-packet.py` 的 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 拒绝。I-108 里这些检查都通过了。
2. 运行中的服务合法地改和删这些表的老行：`packages/persistence-sqlite/src` 里对 `runs`、`threads`、预算两张表、模型调用记录、对话检查点、沙箱执行记录都有 UPDATE，`runs`、`threads`、`sandbox_execution_records` 另有 DELETE；[ADR 0277](0277-the-system-deletes-expired-think-threads.md) 的决定 2 还让服务启动后每小时删一次到期的“想一想”对话。12 张表里只有 4 张有 `revision` 列，没有可靠的按行写入时间。
3. 旧的 S8 逐行比对例外只有一处（`recovery_json`），其余列一变就 `HISTORY_ROW_CHANGED`（改前的 `maintenance-common.mjs` 的 `compareHistoryRows`）。

<a id="decision"></a>

## 决定

1. 历史数据只在服务停着时比较，规则不变：S3、S7 按表摘要比，迁移前后比，S7 切换脚本在启动新版本之前再比一次，出包时拒绝迁移改历史表，S9 恢复后和 S3 读回比。
2. S8 不再把启动后的生产库和 S3 数据库副本逐行比较，也不再写 `s8-history-preserved.json`。S8 保留其余全部检查：结构、迁移记录、完整性、外键、租约和 fencing token、能力登记、授权、S3 恢复点仍可核验，以及 S3 读回和 S7 读回相同。
3. 删掉第二十九次的一次性开关整套机制（实例文件的 `historyComparison`、出包参数、维护脚本和 S7 切换脚本里的分支）。实例文件再带 `historyComparison`，`make-packet.py` 以 `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED` 拒绝。
4. “新版本启动后代码是否写对”归产品测试负责，不由上线检查判断。

<a id="industry"></a>

## 业界怎么做

- GitHub gh-ost 的验证流程先停复制再比对：“When it is satisfied, it will issue a `STOP SLAVE`, stopping replication”，然后“We use `md5sum` on the entire dataset to confirm the test result.”（https://github.com/github/gh-ost/blob/master/doc/testing-on-replica.md ）。先静止，再整体比较。
- Flyway 的 `validate` 比对已执行迁移的名称、类型和校验和，文档里没有比表数据（https://documentation.red-gate.com/flyway/reference/commands/validate ）。
- Percona 的 pt-table-checksum 把校验放进复制流，在同一个写入顺序点上比较（“flow through replication to re-execute on replicas”，https://docs.percona.com/percona-toolkit/pt-table-checksum.html ）。
- 我没有找到哪个工具在服务继续接受写入时对整表做逐行相等比较。

<a id="options"></a>

## 放弃的做法

| 做法 | 放弃原因 |
| --- | --- |
| 给每张表写“服务可以改哪些列”的契约，S8 按契约比，并用测试对账代码里的 UPDATE | 仍然是在服务已经写库之后比较，分不清写对和写错（服务把预算算错，改的也是允许改的列），给人“老数据被保护着”的错觉；要永久维护契约和解析 SQL 的测试 |
| 按“最后写入时间”排除启动后写过的行 | 只有部分表有写入时间，而且由写入方自己填，被检查的一方决定自己是否免检 |
| 只比 5 张运行代码从不改的表 | 等于对另外 7 张表关掉检查，却仍在 S8 报告里写着“已比对” |
| 每个版本再开一次性开关 | 开关把停服时的比较也一起关掉，而那些比较在 I-108 里是通过的 |

<a id="consequences"></a>

## 后果

- 下一个版本可以正常出包，S8 不再因服务的正常写入失败。
- 新版本启动后的代码如果改坏老数据，上线检查不再拦。放弃它的理由：它在仓库记录里从没拦到过真问题，而且无法区分写对和写错。真出事时 S3 的恢复点（上线前的整库副本）仍保留，可以恢复。
- 门槛：`scripts/delivery-mode/test_make_packet.py` 的 `test_history_is_compared_only_while_the_service_is_stopped`、`test_the_instance_file_cannot_switch_history_comparison_off`、`test_history_fixtures_pass_in_a_packet_without_the_switch`。
