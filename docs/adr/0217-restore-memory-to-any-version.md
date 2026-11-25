---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/control-center/test/memory-interactions.unit.test.ts, test/integration/production-memory-capture.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0217：记忆可以恢复到变化记录里的任何一版

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0113](0113-memory-history-events-and-stance.md) 给每条记忆加了只追加的变化记录表 `memory_history_events`（每次变化一行，存当时正文的加密快照，即一个 payload 引用：指向已加密存放的一段文字），种类里已有“换回”（`restored`）。但当时的“换回”只能撤销“被取代”：一条旧记忆被新记忆替换后，可以把旧记忆整条换回来；同一条记忆被改过几次以后，没有办法把正文回到其中某一版。任务 P3-7（Andy 2026-11-11 派）要求补上“恢复到任一版本”。

业界的通行做法是“恢复这一版”等于用旧内容生成一个新版本，旧历史全部保留，例如 [Google Docs 的版本历史](https://support.google.com/docs/answer/190843)。

<a id="decision"></a>

## 决定

1. 变化记录里每一行用表里已有的行号（SQLite 的 `rowid`）作版本编号 `historyId`，返回给网页；不加列，不加迁移。
2. 网关命令 `memory.mutate` 加动作 `restore_version`，带 `historyId`；其他动作的 `historyId` 必须是 `null`。
3. 只能恢复到“当前生效的那条记忆”（状态 `active`、没有被取代）。可选的版本包括这条记忆自己的旧版本，以及被它取代的旧记忆（沿 `superseded_by` 链往前任意多层，链上每一条都要仍是 `active`，已归档或已删除的旧记忆不算）的任一版本。
   - 那一版快照的分级和当前记忆相同时，正文直接指向那份快照，不复制、不重新加密。快照被多条记录引用时，删除其中一条记忆不会删掉这份正文：删除只清掉没有别处引用的正文（`sqlite-governed-deletion.ts` 的 `#deleteUnreferencedPayloadRows`），表上的外键也是 `ON DELETE RESTRICT`。
   - 那一版的分级比当前记忆低时，读出文字，按现有加密方式以当前记忆的分级另存一份新正文，因为保存时要求正文和记忆的分级一致。
4. 立场标签也回到那一版的值。主人亲自选了这一版，所以和手动修改一样，记成不是推断（`inference` 为 false）、把握 1000‰。版本号加 1，写一条“换回”历史，旧历史一条不删；向量索引照常重建。
5. 拒绝的情况：版本编号不存在或不属于这条链（`MEMORY_VERSION_NOT_FOUND`）；那一版和当前正文（按网页显示时的规整方式比较：控制字符换成空格、去掉首尾空白、只比前 2000 个字符，和网页判断要不要显示按钮的依据一致）、立场都相同（`MEMORY_VERSION_ALREADY_CURRENT`）；目标记忆不在生效状态（`MEMORY_VERSION_TARGET_NOT_CURRENT`）；那一版的分级比当前记忆高，例如旧版本是敏感、当前是普通（`MEMORY_VERSION_CLASSIFICATION_HIGHER`），因为复制过来等于把敏感文字降级。
6. 网页：当前记忆的变化记录里，每个文字或立场和现在不同的旧版本旁加“恢复到这一版”。被取代的旧记忆最后那一句仍是原来的“换回这个说法”（把整条旧记忆换回来），其余版本显示“恢复到这一版”。

<a id="options"></a>

## 比较过的方案

### 方案一：新增动作，服务端按版本编号取快照（采用）

- 好处：网页只传编号，正文由服务端从快照取，不会被客户端改；同一条记忆的版本不复制正文。
- 代价：网关契约多一个字段，所有 `memory.mutate` 调用都要带 `historyId`。

### 方案二：网页把那一版的文字当成一次手动修改发上来

- 好处：服务端几乎不用改。
- 代价：历史里记成“主人手动改”而不是“换回”；正文经客户端转一手，和快照不一定逐字一致；每次都复制一份新正文。

### 方案三：跨记忆恢复时一律复制一份新正文

- 好处：每条记忆的正文只归自己。
- 代价：同样的文字多存一份；删除逻辑本来就只清没有别处引用的正文，复制换不来额外的安全。

<a id="consequences"></a>

## 后果

- 好处：改错了可以回到任何一版，历史完整；不改表结构。
- 坏处：
  - 实体名（`memory_entities`，从正文里抽出的人名、地名，用于检索）不随恢复重算，和手动修改的现状一样，保留当前值。
  - 分级较低的版本需要另存时，如果保存失败（例如版本号冲突），这次新存的那份正文当场删掉；它若已被同时进行的另一次恢复用上，删除会被外键挡住，保持原样。
- 不改系统提示、工具定义、已发出的历史和提示词目录，也不碰敏感内容规则和决策记录；恢复后的正文和手动修改后的一样，只在之后的轮次按现有方式出现在追加的记忆内容里。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0113-memory-history-events-and-stance.md]
- [SOURCE: docs/product-vision.md]
- 测试：`test/integration/production-memory-capture.test.ts` 里带 `[P3-7]` 的用例，`apps/control-center/test/memory-interactions.unit.test.ts` 里带 `[P3-7]` 的用例
