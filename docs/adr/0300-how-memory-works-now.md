---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0075-self-built-memory-engine.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0113-memory-history-events-and-stance.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0123-cut-off-embedding-attempt-charged-at-its-ceiling.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0129-compaction-summary-not-fed-to-memory-engine.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0186-memory-jumps-to-the-owners-original-message.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0193-memory-is-visible-to-the-model.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0199-show-memory-dates-to-the-model.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0217-restore-memory-to-any-version.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0218-weekly-memory-checkup-in-daily-rating.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0222-retry-and-queue-failed-memory-capture.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0223-chat-memory-lookup-falls-back-to-keywords.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0224-memory-embedding-runs-on-the-host.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0240-capture-writes-in-one-transaction.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0260-memory-classification-on-the-server.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0262-memory-time-scope-comes-from-the-model.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0271-memory-import-duplicates-judged-by-the-model.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/memory-engine/src/hybrid-memory-provider.ts, packages/memory-engine/src/relevance.ts, packages/memory-engine/src/consolidation.ts, packages/memory-engine/src/time-scope.ts, packages/application/src/embedding-profiles.ts, packages/application/src/services/model-visibility.ts, packages/application/src/ports/memory-dates.ts, apps/agent-service/src/production-run-memory.ts, apps/agent-service/src/production-memory-capture.ts, apps/agent-service/src/production-memory-classification.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0300：记忆现在怎样工作

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [自研引擎，数据在主库](#engine)
  - [向量在本机算](#embedding)
  - [怎样找记忆](#retrieval)
  - [怎样记下记忆](#capture)
  - [整理和冲突](#consolidation)
  - [历史、恢复和出处](#history)
  - [主人在记忆页能做什么](#owner-page)
  - [给模型看的内容](#model-view)
  - [改了记忆，推出来的东西跟着重审](#downstream)
- [和 ADR 0286 的关系](#adr-0286)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

长期记忆的做法原来分散在二十四份 ADR 里（0075、0112、0113、0115、0123、0129、0179、0186、0193、0194、0196、0199、0217、0218、0220 到 0224、0232、0240、0260、0262、0271），后面的多次修正前面的。这份 ADR 只写代码里现在为真的做法。正在做的记忆重设计见 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md)，它做完的部分会改掉下面几条，见[和 ADR 0286 的关系](#adr-0286)。旧文全文在 `supersedes` 列的固定提交链接里。

嵌入（embedding）指把一段文字变成一串数字（向量），意思相近的文字向量也相近，用来按意思找记忆。

<a id="decision"></a>

## 决定

<a id="engine"></a>

### 自研引擎，数据在主库

- 记忆引擎是自研的（`packages/memory-engine`），不用 Mem0。数据全部在 SQLite 主库；检索索引是从正文派生的数据，随时可以重建（`himawari-admin memory reindex`）。
- Pi 的压缩摘要不进记忆；记忆只来自对话本身。

<a id="embedding"></a>

### 向量在本机算

- 嵌入模型按档案登记（`packages/application/src/embedding-profiles.ts`），每份写服务方、模型、维度、前缀和相关度门槛。生产默认用本机的 jina int8 模型，在服务进程里用 onnxruntime-node 计算，不出机器；外网的 Qwen3-8B 留作可选。
- 本机模型同样经统一出口（同一段遮盖和记账代码），按 0 成本记账。模型文件固定版本、按 sha256 校验。
- 索引里记的向量身份带上配方（模型、前缀、维度、文件哈希、遮盖规则版本）；任一项变了，旧向量自动算没建索引，后台重算。
- 模型还没加载好、或嵌入出错时，检索退回关键词和实体两路，不让整轮失败。每轮自动找记忆的向量请求 3 秒没回，这一轮就不带自动记忆直接回答，不重发、也不退回关键词；模型需要以前的信息时自己调用 `recall` 工具查（[I-114](../incidents-and-gates.md#incidents)）。`recall` 工具里的向量请求 3 秒没回仍重发一次。被掐断的那次按费用上限记账，重发用新的调用编号。

<a id="retrieval"></a>

### 怎样找记忆

- 三路检索：向量、FTS5 全文、实体，用倒数排名融合（RRF）合并，再按重要度、把握分、新近度加成排序。中文用 `Intl.Segmenter` 分词，关键词这一路不用单个汉字。
- 截断看相关分（相似度加上关键词和实体的加权），低于这份嵌入档案的门槛减去余量就不要。没有相关记忆就一条不带，过程区也不显示这一步。界面上“相关记忆”里的“相关”就是指达到这条截断线。
- 来源相同、正文几乎一样的记忆只留一条。
- 每轮自动带入的相关记忆不按条数或篇幅截：检索先取 20 条候选，过了截断线的都带（[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 第 6 条）。本机 jina 的聊天门槛 0.30 在这个条件下重测过（2026-11-25，评测集 `evals/memory-retrieval`）：主评测集命中 90%、精确率 81.8%、无关句带出 1 句，留出集命中 70%、无关句带出 0 句；降到 0.28 精确率掉 6 到 8 个点，0.25 主评测集无关句带出 4 句，所以维持 0.30。
- 搜记忆的时间范围只用模型在工具里填的日期（`requestedTimeScope` 校验日期真实存在），不用正则从问题里猜。
- 自动带入和档案里的记忆在正文后面带上日期（例如“（记于 2026-11-09）”“（2026-09-01 至今）”），格式固定，不写“三天前”这种每天会变的说法。
- 待确认的记忆默认不参加检索；主动检查可以带上它们当线索，并标明“系统推测、主人没确认”。

<a id="capture"></a>

### 怎样记下记忆

- 每轮对话后由后台抽取记忆。每条新记忆必须附主人原话引文，程序核对原文里确有这句才存。
- 抽取失败时同轮重试一次；再失败放进待补队列 `memory_capture_backlog`，下一轮补做一条，最多补 3 次。整轮写库在一个数据库事务里，出队和写记忆同时提交。
- 分数不够自动存入门槛、但有原话的新记忆，存成待确认记忆；转正必须有主人自己的原话。
- 手动添加和导入的记忆，类别由服务端的模型判断（`memory.classify.read`），不再判断是否敏感：含密码、密钥、验证码的存成 restricted，其他一律存成 private；导入时“是不是已经记着了”也由服务端的模型判断（`memory.import.duplicates.read`，用 Jev），不用词表。

<a id="consolidation"></a>

### 整理和冲突

- 整理记忆时，只有模型判“新说法明确取代旧说法”、留下的是更晚的那条、且它的把握分够自动存入门槛，才自动作废旧条。其他冲突让新条进待确认，旧条照常生效，等主人定。
- 每次整理改动记全依据（`memory_consolidation_change_basis`），和改记忆写在同一个事务里。
- 不再因为“久没用到”自动归档；合并重复、新事实取代旧事实这两种归档保留。

<a id="history"></a>

### 历史、恢复和出处

- 每条记忆的每次变化写一行只追加的历史（`memory_history_events`），带立场标签和主人原话摘录。对话被删除后摘录保留，来源显示“来源对话已删除”。
- 记忆可以恢复到变化记录里的任何一版（网关命令 `memory.mutate` 的 `restore_version`），恢复也写一条历史。
- 记忆详情能跳到来源对话里的那句原话；找不到的显示“来源已不可查”，提醒创建的和导入的单独归类，不算进“不可查”。

<a id="owner-page"></a>

### 主人在记忆页能做什么

- 每条记忆可以打开“每次对话都带上”（`memory_profile_pins`）；主人的选择优先于自动挑选。健康、财务、事件、其他四类不能置顶。档案总长 2000 字，连日期一起算。
- 每周记忆体检放进每天打分，和打分共用名额：两条说法不一样、很久没用过、把握不大、来源已不可查四类，确认、删除、合并都能撤销（`memory_checkup_items`）。

<a id="model-view"></a>

### 给模型看的内容

- 模型能看到什么由写在代码里的上限决定（`modelVisibleCeiling()`），受限（restricted）的永远不给模型。一次请求的分级取运行分级、本轮上下文和工具结果里最高的那一个。
- 建检索词表之前先遮盖密码、验证码、卡号、证件号、密钥，再去掉像密钥的长串（`maskForIndex`）。

<a id="downstream"></a>

### 改了记忆，推出来的东西跟着重审

- 改了或删了一条记忆，数据库触发器标出直接从它推出来的记忆，程序再沿依据链往下展开。
- 指向它的主人规则改成待重审，由模型重读来源后核对；对不上就暂停（`suspended`），暂停的规则不执行，在记忆页“改了记忆后待重审”一区等主人处理。

[返回目录](#contents)

<a id="adr-0286"></a>

## 和 ADR 0286 的关系

[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 定的方向正在分步编码。做完以后：主模型在聊天里自己存记忆，后台抽取、待补队列和确认裁判退役；不再标“敏感”、取消敏感审批，只有密码、密钥由程序拒存；每日摘要不再生成。到那时这份 ADR 里对应的几条要一起改掉，不另开新 ADR 去“部分取代”。

其中自动整理记忆这一处已经先改：模型标成“敏感”的健康、财务、证件号、银行卡号直接记成普通私人记忆，不再挂起等主人批准；含密码、密钥、验证码的（包括主人明说“记住”的）一律拒存，决策记录里也不留原文。2026-11-28 起（I-129），手动添加、导入、提醒、外部 agent 推送和同步也一样，不再判断“敏感”、不再要主人批准；改动前已经存成 sensitive 的记录照旧可读。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 用 Mem0：它只剩调用嵌入和存向量两件事，没有关键词检索，还另存一份记忆明文；它的新算法只新增、不更新不删除，和“能更正、能追溯”相反。
- 用关键词表或正则猜时间范围、猜类别、猜是否重复：已全部换成模型判断（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）。
- 拿不准的冲突直接作废旧条：会替主人删掉还成立的记忆。
- 久不用就归档：主人没说要删的记忆不该悄悄消失。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 记忆数据和向量都在主人自己的机器上。
- 找不到相关记忆时宁可一条不带，也不凑数。
- 记忆改了，推出来的记忆和规则会被标出来重审，不会悄悄带着旧依据继续生效。

[返回目录](#contents)
