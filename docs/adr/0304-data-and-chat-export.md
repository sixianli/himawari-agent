---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0200-portable-export-of-memories-and-decisions.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0233-rule-book-joins-the-data-export.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0235-chat-history-export.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0289-data-export-v5-drops-owner-proposals.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/persistence-sqlite/src/data-export/export.ts, apps/admin-cli/src/data-command.ts"
verified_at: "25bf70417f1e982afea4a04437b43ca13dbf8d11"
---

# ADR 0304：记忆、规则和聊天记录的导出

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [记忆、规则和决策记录：能导出也能导入](#data-export)
  - [聊天记录：只导出](#chat-export)
  - [机密怎样处理](#secrets)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

愿景要求主人的数据“拿得走”。导出的格式和规矩原来分散在四份 ADR 里（0200、0233、0235、0289），每次加一类数据就升一次格式版本。这份 ADR 只写现在为真的做法。旧文全文在 `supersedes` 列的固定提交链接里。

<a id="decision"></a>

## 决定

<a id="data-export"></a>

### 记忆、规则和决策记录：能导出也能导入

- 格式 `himawari.data-export.v6`（v6 起不再含 Muse 对照条目），一个文件夹：`manifest.json`（格式、迁移序号、每个文件的字节数、行数、SHA-256、各类条数、扣留数和没导出的项）；`data/*.jsonl`（键排序的规范 JSON，一行一条：记忆连同它的历史、来源、人物和置顶，人物，导入批次，整理记录，决策记录，规则和规则的全部历史版本）；`schema/*.schema.json`；给人读的 `MEMORY.md`、`memory/<类别>.md` 和 `RULES.md`。
- 导出范围：在用、已归档、回收站里的记忆；正在删除和已验证删除的不导出，只在清单里计数。
- 导入只往空库里导：目标库的记忆和规则表必须为空，全部在同一个事务里原样写入。旧版本格式的文件整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`），不做半套导入。
- 导入前校验清单、字节数、哈希、每行对照 JSON Schema、规则编号不重复、历史修订号递增等。
- 网页记忆页的按钮叫“导出记忆和规则”。

<a id="chat-export"></a>

### 聊天记录：只导出

- 格式 `himawari.chat-export.v1`，和记忆导出并列、互不改动：`data/threads.jsonl`（一个对话一行，消息嵌在里面）、每个对话一个给人读的 Markdown 文件、索引 `CHATS.md`。
- 进行中、已归档、回收站里的对话都导出；附件只导出清单（名字、大小、类型），不带文件本体。

<a id="secrets"></a>

### 机密怎样处理

- 一段文字认出密码、密钥、证件号这类值时，明文层放遮盖后的文字；遮盖后仍像机密就放占位符，标为扣留，原文只进口令加密的封存文件 `sealed/sealed.enc`（scrypt 派生密钥加 AES-256-GCM）。没设口令时，扣留的原文不导出。
- 决策记录里模型的输入输出等证据默认不导出，只在 `--with-evidence` 并设了口令时进封存文件。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 往已有数据的库里合并导入：重复和冲突无法确定地处理，宁可只导入空库。
- 兼容读取旧格式：旧格式缺规则等数据，导入后会悄悄少一块。
- 聊天记录也做导入：没有需求，导入会牵出对话历史和模型历史的一致性问题。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 主人随时能把记忆、规则和聊天记录整份拿走，人能读，程序能校验。
- 每加一类要导出的数据，格式版本加一，旧版本的导出文件不能再导入。

[返回目录](#contents)
