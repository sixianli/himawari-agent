---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-25"
---

# ADR 0075：自研记忆引擎，去掉 Mem0

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0005](0005-replaceable-memory-boundary.md) 决定通过产品自有的记忆端口使用外部记忆服务，并在“比较过的方案”里以“偏离 Agent 主体目标，重复成熟开源方案的工作”为由否决了自建完整记忆引擎。此后接入的是 Mem0 开源版 3.3.1。

2026-10-25 对 main（`d7b90f79`）的代码核对和调研（[方案文档](https://claude.ai/artifact/JULHuYEDYGdKHvbCNcp1T2)）发现：

- 提炼、去重、更新判断、把握分、敏感分级与审批、加密存储都已由 PR #16 和 PR #17 在产品里实现。Mem0 只剩两件事：调用嵌入接口、存向量。
- Mem0 3.3.1 的 SQLite 向量库检索是 `SELECT * FROM vectors` 后在 JavaScript 里逐条算余弦，没有关键词检索；它的向量库和历史库还各存一份记忆明文，删除时要另外核对。
- Mem0 2026 年 4 月的新算法改为“只新增、不更新不删除”，与 Himawari 需要的“能更正、能审批、能追溯”方向相反；README 公布的基准分数来自其付费云平台。

“成熟开源方案”的前提已不成立：真正决定记忆效果的结构（常驻画像、带有效期的事实、混合检索、后台整理）Mem0 开源版都没有，而这些都能在现有 SQLite 主库里实现。

用户 Andy 在 2026-10-25 的方案文档批注中同意去掉 Mem0，并要求四个阶段全部实施、不缩范围（“同意”“不用担心时间，我们全都要！”）。

<a id="decision"></a>

## 决定

1. 长期记忆由 Himawari 自研的记忆引擎实现，数据全部放在现有 SQLite 主库，去掉 `mem0ai` 依赖和 `packages/memory-mem0`。本决定取代 ADR 0005 中“不自建完整记忆引擎”的判断；ADR 0005 的其余决定（产品自有端口、所有触发源经同一上下文形成流程、注入内容进入 Session Trace）继续有效。
2. 引擎实现在 `packages/memory-engine`，通过 ADR 0005 的 `MemoryProviderProjectionPort` 接入，`DurableMemoryService`、投影任务、重试和审批流程不变。索引的存储由 `packages/persistence-sqlite` 提供，作为主库里的派生数据，可随时从加密正文重建。
3. 检索为向量、FTS5 全文、实体三路，用倒数排名融合（RRF）合并，再加重要度、把握分和新近度。中文用 Node 内置 `Intl.Segmenter` 预分词。向量存普通表的 BLOB 列，用 sqlite-vec 0.1.9 的标量函数在 SQLite 内暴力计算；扩展加载失败时退回 JavaScript 计算，嵌入服务不可用时退回全文加实体两路。
4. 嵌入模型继续用云端 Qwen3-Embedding-8B（经 Vercel AI Gateway），由产品自己的 OpenAI 兼容嵌入客户端调用，每次调用照旧经过模型准入和预算登记。维度默认保持 4096；只有评测集上 1024 维没有损失、且实测网关支持时才降维，配置改动单独进行。
5. 每条自动写入的新记忆必须附主人原话引文，由宿主程序核对原文中确有这句话才保存。每轮对话只保留一次提炼调用，其余整理放到夜间。
6. 实施按[设计规格](../execution/specs/2026-10-25-self-built-memory-engine-design.md#phases)的四个阶段推进；每个阶段过评测关口才上线，阶段一的关口是新引擎在中文评测集上不低于 Mem0 基线。

<a id="options"></a>

## 比较过的方案

### 继续用 Mem0 3.3.1

- 优点：不用改。
- 缺点：实际只用到嵌入调用和全表余弦；没有关键词检索；向量库和历史库各有一份明文要双写、要核对删除；新算法只新增不更新。

### Postgres + pgvector

- 优点：成熟、功能全。
- 缺点：要多跑一个数据库服务，违背“本地优先、单文件状态”；主库是 SQLite，需要大迁移。

### Graphiti + Neo4j / FalkorDB

- 优点：时序知识图做得最完整。
- 缺点：Python 服务加图数据库；每条消息多次模型调用。只借鉴其“有效期、失效不删”的设计。

### Letta 服务

- 优点：常驻记忆块和空闲整理现成。
- 缺点：自带一套智能体运行时，与 Pi 重复。只借鉴分段常驻档案和空闲整理。

### sqlite-vec 的 `vec0` 虚拟表

- 优点：同样数据量下比标量函数快约 1.7 倍（3 万条 1024 维实测 72 ms 对 120 ms）。
- 缺点：没加载扩展的连接读不了这张表，而恢复点等工具会逐表计数，主库里出现 `vec0` 表会让它们出错；稳定版也只有暴力检索。目前记忆量在千条以内，标量函数在 5 千条时约 17 ms。数据量真到几万条时再评估。

<a id="consequences"></a>

## 后果

- 正面：检索多了关键词和实体两路，向量服务挂了也能召回；记忆只存在一个加密主库里，向量库不再存明文，删除核对范围缩小；后续的有效期、情景、整理和主动提醒都能在同一个库里做。
- 负面：检索、打分和索引维护由我们自己负责，需要评测集持续验证；sqlite-vec 仍是 1.0 前版本，锁定 0.1.9。
- 后续：
  - 旧 Mem0 文件（`memory.storagePath` 下的 `vectors.sqlite`、`entities.sqlite`、`history.sqlite`）在本版本保留，方便回滚到旧版本；确认不再回滚后在下一次上线删除。
  - 配置里 `memory.adapter` 新值为 `himawari-sqlite`；旧值 `mem0-oss` 在过渡期仍可启动，含义相同，下一次改生产配置时换掉。

<a id="references"></a>

## 关联文档

- [ADR 0005：将长期记忆作为可替换外部能力](0005-replaceable-memory-boundary.md)
- [自研记忆引擎设计规格](../execution/specs/2026-10-25-self-built-memory-engine-design.md)
- [方案文档（Claude Doc，已批准）](https://claude.ai/artifact/JULHuYEDYGdKHvbCNcp1T2)
- [方案存档（全文和批注记录）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/specs/2026-10-25-self-built-memory-engine-proposal.md)
