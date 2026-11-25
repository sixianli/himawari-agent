---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "packages/persistence-sqlite/src/data-export/snapshot.ts, packages/persistence-sqlite/src/sqlite-recovery-point.ts, test/integration/data-export.test.ts, test/integration/sqlite-recovery-point.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# 记忆检索索引的威胁模型

<a id="contents"></a>

## 阅读导航

- [这份文档管什么](#scope)
- [索引里有什么](#what-is-stored)
- [防什么、不防什么](#threats)
- [自动检查](#checks)
- [改动时要守住的](#rules)

<a id="scope"></a>

## 这份文档管什么

Himawari 找记忆用三路：向量（把文字变成一串数字，按意思比较）、关键词（全文索引）、实体（人名、地名等）。这三路的数据合起来叫检索索引。记忆正文本身加密保存，但检索索引是从正文的明文算出来的。这份文档写清楚：索引会泄露什么、哪些情况下我们保证它不泄露、哪些情况不保证。决定来自 [ADR 0300](adr/0300-how-memory-works-now.md)。

[↑ 回到阅读导航](#contents)

<a id="what-is-stored"></a>

## 索引里有什么

| 数据 | 存在哪 | 是否加密 | 能泄露什么 |
| --- | --- | --- | --- |
| 记忆正文 | 表 `payloads`（大的放在 `data/payload-ciphertext/`） | 加密，密钥不在数据库里 | 拿不到密钥就读不出 |
| 记忆向量 | 表 `memory_search_index` 的 `embedding` 列 | 不加密 | 向量能部分反推出原文：有论文用反复修正的方法，把 32 个 token 以内的文字 92% 原样还原（[arXiv 2310.06816](https://arxiv.org/abs/2310.06816)） |
| 关键词索引 | 全文索引表 `memory_search_terms` | 不加密，入库前已遮盖凭证类内容 | 记忆里出现过的词 |
| 实体 | 表 `memory_entities` | 不加密 | 记忆里提到的人名、地名等 |
| 每日摘要的向量和关键词 | 表 `memory_episodes` 的向量列、`memory_episode_terms` | 不加密，关键词入库前已遮盖 | 同上 |
| 本机嵌入模型 | `<stateRoot>/models/` | 不加密 | 公开的模型权重，不含主人数据 |

所以，谁能拿到 `product.sqlite` 这个文件，谁就能从索引大致读出记忆说了什么，即使读不了加密的正文。

[↑ 回到阅读导航](#contents)

<a id="threats"></a>

## 防什么、不防什么

**防：备份泄露。**恢复点备份（`packages/persistence-sqlite/src/sqlite-recovery-point.ts`）把整库拷出来后，用单独的备份密钥加密成一个个对象文件，明文临时文件随即删掉。索引跟整库一起加密，拿到备份文件但没有备份密钥的人读不到向量和关键词。本机模型文件不进备份。

**防：导出泄露。**数据导出（`packages/persistence-sqlite/src/data-export/snapshot.ts` 的 `readSnapshot`）只导出记忆、历史、出处、实体、决策记录这些主人自己的数据，不导出向量和关键词索引，加密封存的那一份也不含。导出给别的系统用时，索引在对方那边按需重算。

**防：嵌入请求外传。**用本机模型时，主人的问题和记忆正文不再发给第三方（[ADR 0300](adr/0300-how-memory-works-now.md)）。选外网模型时，请求经统一出口先遮盖敏感信息再发出。

**不防：本机入侵。**能以服务账号或 root 身份读 `/var/lib/himawari/state` 的人，能直接读 `product.sqlite` 里的索引，也能在服务运行时读到内存里的明文。升级前留在本机的数据库副本（`data/pre-migration-*`、`.raw-restore-*-original`）同样带着索引，按“本机”对待。防这一类要靠主机本身的安全：只有 root 能登录、服务账号隔离、磁盘加密。索引加密不能解决它：服务要按向量比较，就得在本机持有解密密钥。

[↑ 回到阅读导航](#contents)

<a id="checks"></a>

## 自动检查

- `test/integration/sqlite-recovery-point.test.ts` 的 `[P3-1]` 用例：往库里写一个特征明显的向量、一个特征词和一份假的模型文件，做一次恢复点备份，备份目录的所有字节里都找不到这个向量、这个词和模型文件内容；同一个向量在原库文件里能找到（证明检查的东西确实存在）。
- `test/integration/data-export.test.ts` 的 `[P3-1]` 用例：给一条记忆写入向量和特征词，先确认源库里查得到它们，再导出，导出的所有文件加上解封后的封存内容里，都找不到这个向量（原样、base64、十六进制三种写法）、这个词和向量的模型名。

[↑ 回到阅读导航](#contents)

<a id="rules"></a>

## 改动时要守住的

- 导出新增任何表之前，先看它是不是从正文派生的索引；是的话不导出。
- 备份新增任何文件之前，确认它在加密对象里，或者是不含主人数据的公开文件。
- 任何把数据库或状态目录拷到本机以外的新做法（例如异地备份），都要先加密，并在这里补一条检查。

[↑ 回到阅读导航](#contents)
