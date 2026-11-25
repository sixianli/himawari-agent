# PR 614 复核材料

## 问题和目标

ADR 0286（docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md）第 3 条：主模型要能搜旧对话原话、打开旧对话前后原文。本 PR 是第 1 步的上半：按“轮”（主人一句话加她后面的回答）给对话建检索索引，并在生产里每次主人那轮跑完后顺带索引。搜索和打开的模型工具在下一个 PR，本 PR 不改发给模型的任何内容。另外两个提交只加文档和评测证据（ADR 0286、设计说明、记忆清单格式实测数据）。

## 约束

- 上线前的旧对话会全部删除（Andy 2026-11-24 定），不为旧数据做兼容或回填策略。
- 索引表不存正文，正文从 thread_messages 的加密载荷读；删对话（threads 行）要级联删索引行和 fts5 行。
- 只搜 origin='owner'、status='open' 的对话；回收站恢复后能再搜到；think 后台对话不搜不打开。
- 嵌入只送嵌入模型允许的密级（embeddableClassifications），不允许的不进补向量队列。
- 生产索引走原有的嵌入准入（embedWithin），每轮一个独立槽位。
- 迁移只加不改，不用 meta 文件。
- 代码不写注释（项目规则）。

## 作者的说法（请核对）

1. 删除 threads 行会经外键级联删掉 conversation_turns 行，触发器删掉 conversation_turn_terms 行。
2. 一个对话的最后一轮还没结束时（后面还会追加 agent 消息），下一次 indexDue 会把这一轮按同一个 id 重新索引并覆盖，不会产生重复行；水位（listBehind）能推进到含 restricted 消息的轮。
3. 向量检索只保留相似度不低于 minimumSimilarity 的结果，按词和按意思两路用 RRF 合并。
4. ProductionMemoryEpisodes 里索引失败只走 onFailure，不影响每日摘要那条路；stop() 后不再开始新的索引。
5. service-main 本机向量追赶的循环在没有可补的轮时退出，不会死循环。

## 请重点看

- packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts 的 SQL（listBehind、search、upsert 覆盖 fts5 行）。
- packages/memory-engine/src/conversation-turns.ts 的分轮、水位和分页（window）。
- apps/agent-service/src/production-memory-episodes.ts、service-main.ts 的接线。
