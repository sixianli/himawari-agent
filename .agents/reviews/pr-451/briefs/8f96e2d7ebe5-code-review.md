# PR 451：iOS 第 5 批（两个固定工具、来历入口检查、感知抽取）

## 问题和目标

设备（手机、手表、Mac）会把听到的话、屏幕上的字、网页、短信交给服务器，存成感知记录（第 3 批，本 PR 的基线）。这一批让模型能读这些记录、能对设备提动作，并在后台把一段经历变成记忆和“可以替主人做的下一步”提议。设计在 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 第 7、8、12、15 节，任务在 `docs/execution/plans/2026-11-11-apple-device-body-plan.md` 的“第 5 批的任务”。

## 约束

- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）：两个工具的定义是固定文字；感知内容只能作为 `perception_read` 那一次调用的工具结果追加在末尾。
- 感知记录里别人说的话、屏幕上的字、网页是不可信的外部内容，只能当资料，不能当指令。
- 理解意思交给模型，不用关键词表；程序只做能确定核对的事（引用是否逐字出现、来历、上限）。
- 发给模型前必须过出口遮盖；每日费用上限 `perception.model_cost.daily` 必须拦得住。
- `packages/persistence-sqlite` 只能从 `packages/application` 做类型导入。

## 作者的说法（请核对，不要直接采信）

1. `perception_read` 读到来历不是主人自己的记录时，会给这一轮记一笔（`perception_run_reads`）。之后同一轮里建提醒、取消提醒、改规则、非读取的设备动作，执行前先过 `packages/application/src/services/perception-origin-gate.ts`：后台发起的一轮不执行，写一条种类 `proposal` 的决策记录并把想做的事交给提议入口；主人发起的一轮不执行，返回固定的说明文字。
2. 感知抽取（`packages/application/src/services/perception-extraction.ts`、`apps/agent-service/src/production-perception-extraction.ts`）按记录顺序只走一遍出口遮盖；模型给的每条记忆和提议都要带引用，引用必须在遮盖后或原文里逐字出现，否则丢弃并写决策记录；提议的可信标记只有这一次发给模型的记录全是主人自己说的才是 `owner`。
3. 一段经历抽取过以后，记录条数变了会重新抽取；同一条记忆、同一条提议不会因为重抽而重复写入。
4. 口头指令那句话（`perception_command_utterances`）抽取时跳过。
5. `memory_provenance.source_type` 只认登记过的类型；`perception` 类型的编号格式不对或指向不存在的记录，写入被拒。
6. 迁移 `0096_perception_extraction.sql` 的三张表（`perception_extractions`、`perception_command_utterances`、`perception_run_reads`）都不进数据导出。
7. 提议入口在生产里没有接，抽取和入口检查在没有入口时照常工作。

## 已知没做

主人发起的一轮“点一下确认”（现有审批接不到这类工具）；感知记录删除；设备动作真正下发；提议入口表。
