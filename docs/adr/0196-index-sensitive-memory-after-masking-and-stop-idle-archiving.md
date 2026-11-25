---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
---

# ADR 0196：敏感记忆遮盖后进检索目录，停掉“久不用就归档”

> 2026-11-24 补：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 决定记忆不再标“敏感”，敏感记忆遮盖后再进检索目录这一条随标记一起去掉；发给模型前遮盖密码、密钥、验证码照旧。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0193](0193-memory-is-visible-to-the-model.md) 让模型能看到 sensitive（敏感）记忆，但留了两处没做：

1. 检索目录不收敏感记忆。记忆检索有两条路：按意思找（向量，即把文字算成一串数字后比相似度）和按词找（全文检索，把文字拆成词存进一张词表）。敏感记忆只有向量，没有词表条目，也不存实体（记忆里提到的人名、地名等名字）；敏感的事件段（某天某段对话的摘要）同样没有词表条目，因此第一次算向量失败后永远补不上。
2. 记忆整理会把“半年没用、重要度低、不属于规则/身份/关系/健康/财务”的记忆自动归档，归档后模型就看不到了。这和 Andy 2026-11-09 定的原则“存入记忆的内容必须能被模型看到”冲突。

Andy 在方案 v3 上同意的 C：“上线时一次性恢复因闲置被归档的记忆并重建索引，先报数量、先备份。”

<a id="premises"></a>

## 前提

1. 词表只收 public 和 private：`packages/memory-engine/src/hybrid-memory-provider.ts:18`，`const LEXICAL_CLASSIFICATIONS = new Set<DataClassification>(["public", "private"]);`（本决定之前的 main）。
2. 实体和事件段词表同样只收这两档：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:148`，`const INDEXED_ENTITY_CLASSIFICATIONS = new Set(["public", "private"]);`。
3. 事件段补算向量只挑有词表条目的段：同一文件第 1398 行，`JOIN memory_episode_terms t ON t.rowid = e.rowid`。
4. 闲置归档：`packages/memory-engine/src/consolidation.ts:47`，`const DECAY_IDLE_DAYS = 180;`；第 453 行，`return this.#revise(id, "archive", memory, null, { status: "archived" });`。
5. 服务启动时会把没有索引或索引版本落后的记忆重新排队建索引：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1483`，`AND (i.memory_id IS NULL OR i.memory_revision != m.revision`；`apps/agent-service/src/service-main.ts:1197`，`await memory.requeueProjection(unindexed);`（这段循环在配了嵌入模型时运行，生产配了 Qwen 嵌入模型）。
6. 建索引的后台每秒处理一条：`apps/agent-service/src/production-memory-worker.ts:44`，`await this.#service.runProjectionBatch(1);`。
7. 词表是明文的 SQLite 全文表，记忆正文是加密存的；所以进词表的词等于把这部分内容以明文写到磁盘上。
8. 界面上的“撤销”会把这条整理决定记成主人评价“不需要”：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:347`，`UPDATE decision_ledger SET owner_rating = 'unneeded', rated_at = ?`。

<a id="decision"></a>

## 决定

1. **词表、实体、事件段词表收 public、private、sensitive 三档**，restricted（受限）仍不收。
2. **建词表之前先遮盖，再丢掉像密钥的词**（`maskForIndex`，在 `packages/sensitive-capture/src/secret-like.ts`）。
   - 先用出口遮盖的固定规则集、不带对话上下文（`maskSensitiveText`）遮盖：认得出的密码、验证码、卡号、证件号、密钥换成“[密码]”这类占位文字。
   - 规则认出的值（`findSensitiveValues`），在同一段文字里再出现时也去掉。出口遮盖只在“密码：”后面那一处认出值，后面单独再写一次的同一个值认不出来（例如“Wi-Fi 密码：sunflower，客人来了就告诉他 sunflower”）。规则交出来的值常带着上下文：“密码是sunflower。客人来了”里认出的值是整段 `sunflower。客人来了`，`password=hunter2x` 认出的是整串。所以每个值原样和其中每一段由英文字母、数字和常见符号组成的串（去掉首尾的句点、感叹号、问号）一起去掉，两者都只取 4 个字符以上的；额外取的段不含中文，免得把正常的话从词表里删掉；但原样的值如果带着中文后文（例如 `sunflower。客人来了`），同样一整段再出现时会整段去掉。代价是值里夹着的普通英文词（例如 `abc:hello:xyz` 里的 `hello`、私钥块里的 `BEGIN`）在这条记忆的词表里也被去掉，按意思仍能搜到。出口遮盖的密码规则遇到紧跟 `[` 的值不认（为了不重复遮盖自己的占位），所以再把原文里的方括号换成空格认一遍，“密码是[sunflower]”这类写法也能去掉。代价是密码关键词后面紧跟的方括号说明（例如“密码：[由系统自动生成]”）也会被当成值，在这条记忆的词表里去掉，按意思仍能搜到：宁可多删，不让秘密进明文词表。去掉时按整词匹配：值的首尾是英文字母、数字或下划线时，前后不能紧挨同类字符（`test` 不会删掉 `contest` 里的那段）。只有遮盖自己留下的占位（`[密码]`、`[验证码]`、`[证件号]`、`[密钥]`、`[银行卡 尾号1111]` 这五种）里面不动，正文里普通的方括号照常检查。
   - 再按空白和标点切出英文数字串，整串像密钥的去掉，然后才拆词；拆完的每个词再查一遍。整串查是因为拆词会把 `abcd-efgh-ijkl-mnop-qrst-uvwx` 这类带分隔符的长串拆成几个短词，每段单看都不像密钥。
   - “像密钥”（`looksLikeSecretToken`）：6 位以上的纯数字、24 个字符以上的英文数字串、8 个字符以上同时有字母和数字的串。这道是给规则没认出来的格式兜底，例如关键词写在后面的“hunter22 是新密码”。代价是手机号、订单号、`iphone15` 这类词按词搜不到，按意思仍能搜到；不含英文字母的日期、时间（`2026-11-09`、`14:30:00`）不受影响；带 `T`、`Z` 的 ISO 时间戳（例如 `2026-11-09T10:00`）会被当成像密钥的串去掉，按词搜不到。纯字母的密码（例如关键词写在后面的 `sunflower`）兜不住，只能靠遮盖规则。
   - 这几步对三档都做，不只对 sensitive：词表是明文，private 记忆里的秘密同样不该写成明文。
3. **实体在记忆提取时过滤。**模型给出的实体名，如果上一条的处理会改动它，就丢掉（`isSafeToIndex`，在 `apps/agent-service/src/production-memory-capture.ts`）。这里说的实体只指记忆的 `attributes.entities`：提取是目前唯一写入非空 `attributes.entities` 的地方，其余写入者（主人手动改记忆、提醒、整理产生的推断）都写空实体。存储层不做这一步：SQLite 在独立线程里直接跑源码，`@himawari-agent/sensitive-capture` 的入口在那里加载不了（`check:source-mode-imports` 管的同一类问题）；以后新增写实体的地方，要同样先过 `isSafeToIndex`。模型给出的人物名（`people[].name`、别名）写进人物表 `memory_people`，不进词表，不在这一条的范围内。
4. **停掉闲置归档。**记忆整理不再因为久没用到就归档；合并重复、新事实取代旧事实这两种归档保留。“归档”这个动作类型留在库里，因为旧记录还在用它。
5. **一次性维护命令 `himawari-admin memory reindex --config <路径> --operator <人>`**，上线时在服务停止状态下运行：
   - 不带 `--confirm` 时只报数：要恢复的闲置归档条数、现有索引条数、在用记忆条数，并提示先备份（`himawari-admin backup create`）。
   - 带 `--confirm REINDEX_MEMORY_<agentId>` 时，在一个事务里：恢复“动作是闲置归档、没撤销过、之后没被改过（版本号仍等于归档后的版本）”的记忆，并把那条整理改动标为已撤销；合并重复产生的归档不动；然后清空这个 Agent 的记忆索引。
   - 服务再启动时，按前提 5 的现有逻辑把所有没有索引的记忆重新排队，按新规则建词表和向量。配置校验要求必须有且只有一个嵌入模型（`packages/platform-node/src/strict-configuration.ts:1281`），所以这段重建循环在启用记忆的服务里一定会跑；全是确定性测试模型的配置不启用记忆，索引用不上。
   - 重跑不会多恢复或误恢复（第二次恢复 0 条），但会再清一次索引：服务下次启动要把全部记忆的向量再算一遍，多花一次嵌入费用，期间检索结果变少。所以只在上线时跑一次。
   - 恢复不写“主人评价不需要”：这是 Andy 对整个功能的决定，不是他对某一条的评价。所以恢复之后，决定账本（`decision_ledger`）里那条归档决定没有主人评价，变更表里这条归档标了已撤销，记忆本身回到在用：账本只说明当时做过这个决定，不代表记忆现在的状态。

<a id="industry"></a>

## 业界怎么做

GitHub 的密钥扫描在“已知服务方格式”之外另加两层兜底：“Expand detection to secrets that aren't tied to a specific service provider”（通用模式）和 “Use AI to detect unstructured secrets like passwords”（[About secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning)）。本决定照这个思路：先用已知格式规则遮盖，再用“长得像密钥”的通用规则兜底；不用模型判断，因为建索引在后台批量跑，每条都调模型太贵。

<a id="options"></a>

## 放弃的做法

- **敏感记忆仍只靠向量。**按词找能找到向量找不到的专有名词（人名、药名），而敏感记忆里正多这类词（例如“青霉素”）。只靠向量会让敏感记忆比普通记忆更难被找到。
- **只对 sensitive 遮盖。**private 记忆里也可能出现规则能认出的秘密，词表又是明文，分档处理没有好处。
- **服务启动时自动恢复归档。**Andy 要求“先报数量、先备份”，所以做成要人确认的命令。
- **在维护命令里直接重算词表。**维护命令不带模型和解密能力，重算要读加密正文、调嵌入模型；交给服务启动后已有的重建流程，不另写一套。
- **旧的敏感实体补回。**旧代码根本没存敏感记忆的实体，没有东西可补；新提取的记忆会带上。按 Andy“不用管以前的聊天记录”，不为旧数据另想办法。旧的敏感事件段同理，没有词表条目，不补。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/memory-consolidation.test.ts` 的 `[RULE-memory-visible]`：真实 SQLite 里敏感记忆按词“青霉素”能查到；正文里没有关键词、遮盖规则认不出的串 `x9Kq2mVb7Lp4Wz` 查不到（靠“像密钥”兜底）；敏感记忆的实体能读回；整理不再归档半年没用的记忆。
  - `test/integration/memory-episodes.test.ts` 的 `[RULE-memory-visible]`：敏感事件段按词能找到、只放行 private 时找不到、嵌入失败后能补算向量。
  - `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts`、`packages/sensitive-capture/test/secret-like.unit.test.ts`、`apps/agent-service/test/production-memory-evidence.unit.test.ts`：遮盖、重复出现的密码、关键词在后的密码、带分隔符的长串、卡号只留尾号、实体过滤。重复值的第一次出现紧贴标点、省略号或后文、秘密在值的中间段、验证码重复、`password=` 形式的重复、占位里的尾号、普通方括号里的秘密、“密码是[sunflower]”、`contest` 和值里的中文后文不被误删也各有用例。去掉遮盖、去掉重复值处理、去掉取段、去掉整词匹配、把占位放宽成任意方括号、去掉方括号重认、去掉整串检查，各自至少有一条用例失败。
  - `apps/admin-cli/test/memory-reindex-cli.unit.test.ts`：先报数、不确认不改；只恢复没被改过的闲置归档、不动合并归档；清空索引后这些记忆都在“待建索引”名单里；重跑恢复 0 条。
- 上线步骤：停服务 → `himawari-admin backup create` → `himawari-admin memory reindex`（报数，把数量报给 Andy）→ 带 `--confirm` 再跑一次 → 启动服务。重建期间（约每秒一条）检索结果会少，几百条记忆约几分钟建完；重建要重算全部向量，嵌入费用按几百条短文本计，远低于 0.5 美元。
- 词表里不再有手机号、长订单号、带数字的型号这类词，按词搜不到它们；按意思搜不受影响。
- 记忆页“已归档”的说明改为“整理时判断为过时或重复，回答时不再用”。
- 记忆的日期给模型（第 3 个 PR）、凭证占位符编号（第 4 个 PR）另做。

<a id="references"></a>

## 关联文档

- [ADR 0193：存入记忆的内容必须能被模型看到](0193-memory-is-visible-to-the-model.md)
- [ADR 0183：只在数据离开时遮盖](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
- [ADR 0185：密码、密钥标敏感而不是丢弃](0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md)
- 代码：`packages/sensitive-capture/src/secret-like.ts`、`packages/memory-engine/src/segmentation.ts`、`packages/persistence-sqlite/src/sqlite-memory-maintenance.ts`、`apps/admin-cli/src/memory-command.ts`

[返回目录](#contents)
