## 发现（按严重度）

### 高：同一条记忆里，被关键词认出的密码只遮第一次，之后重复出现的同一个值会进明文词表

文件：`packages/memory-engine/src/segmentation.ts:114-115`、`packages/sensitive-capture/src/redaction.ts:317-326,411-419,542-543`

问题：`indexableTerms` 调用 `maskSensitiveText(text)`，而 `maskSensitiveText` 固定是 `redactForEgress(input)`，不带 `tag`、`known`。`redactForEgress` 只有在 `tag !== undefined` 时才把识别出的密码/验证码记进 `known`（redaction.ts:317-326），后面的“点名值再遮”逻辑又要求 `known` 非空（redaction.ts:411）。因此同一段文本里第一次写成“密码是 hunter22”会被遮成 `[密码]`，后面单独出现的 `hunter22` 不会遮；而 `looksLikeSecretToken("hunter22")` 为 false（长度 8、数字 2，不满足 secret-like.ts:9-15），最终 `hunter22` 会作为词写进明文 FTS 表。

证据：
- `redaction.ts:317-326`：`const placeholder = ...; if (tag !== undefined) { ... if (rememberValue && known !== undefined ...) known.set(...) }`
- `redaction.ts:411`：`if (known !== undefined && known.size > 0) {`
- `redaction.ts:542-543`：`export function maskSensitiveText(input: string): string { return redactForEgress(input).text; }`
- `segmentation.ts:115`：`return indexTerms(maskSensitiveText(text)).filter(...)`
- `secret-like.ts:7-15` 的条件对 `hunter22` 不成立。

状态：读代码证实逻辑路径；具体 `Intl.Segmenter` 对 `hunter22` 的分词结果未实际运行，但连续字母数字按现有 `segmentWords` 会是 word-like。

建议：让 `indexableTerms` 在单段文本内建立一次性的 `known` 并配合 `tag`（或改 `maskSensitiveText` 内部记住已识别值并遮盖重复出现），避免占位符编号本身再进词表；补一条“密码是 hunter22，……hunter22……”的反向测试。

### 中高：带分隔符的长秘密会被分词拆成小段，逐段躲过 `looksLikeSecretToken`

文件：`packages/memory-engine/src/segmentation.ts:86-93,105-115`、`packages/sensitive-capture/src/secret-like.ts:3,7-15`

问题：`indexableTerms` 先 `indexTerms` 再用 `looksLikeSecretToken` 过滤“词”。`segmentWords` 用 `Intl.Segmenter` 按词切分，带 `-`、`.`、`/` 等分隔符的串会被拆成多段；`looksLikeSecretToken` 只检查每一段。例如 29 个字符的 `abcd-efgh-ijkl-mnop-qrst-uvwx`：整串长度 ≥24 本应命中，但拆成 4 个字母的段后每段都不命中；`maskSensitiveText` 也不会遮它（没有密码关键词），于是各段都写进明文词表。

证据：
- `segmentation.ts:86-93` 按 `Segmenter` 输出词。
- `segmentation.ts:105-115` 先 `indexTerms`，后逐词 `filter(!looksLikeSecretToken)`。
- `secret-like.ts:3` 的 `TOKEN` 允许 `-`、`.`、`/`、`+`、`=`，说明本来是想按整串检查；`:9` 的 `value.length >= 24` 也只有整串才生效。

状态：读代码证实。未实际运行分词器，但分隔符断开词边界是当前实现直接可推的结论。

建议：在切词之前先按空白/标点切出候选串，对整串跑 `looksLikeSecretToken`，命中的整段先剔除或替换再分词；补一条“无密码关键词、带连字符的 24+ 字符串不进词表”的测试。

### 中：反向测试与作者说明不一致，且“遮盖”这一层没有会失败的门槛

文件：`test/integration/memory-consolidation.test.ts:93,520`、`packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:121-126`、`docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:86`、`packages/sensitive-capture/src/redaction.ts:94,350-363`

问题：ADR 说 `x9Kq2mVb7Lp4Wz` 是“规则认不出的口令”，但两处测试正文分别是“医保卡备用口令 x9Kq2mVb7Lp4Wz”和“备用口令 x9Kq2mVb7Lp4Wz”，`口令` 本身就在 `PASSWORD_NON_ASCII_KEYWORDS` 里，`PASSWORD_BARE_VALUE` 会把它后面的值遮掉。也就是说这个用例实际测的是关键词遮盖，不是 `looksLikeSecretToken` 兜底。

更严重的是：把 `indexableTerms` 里的 `maskSensitiveText` 去掉、只保留 `looksLikeSecretToken` 过滤，现有测试仍然全过。因为 `Abc12345xyz`（长度 11、数字 5）、`x9Kq2mVb7Lp4Wz`（长度 14、数字 4）、`13800138000`（纯数字）都满足兜底规则，而测试里的 `hunter22` 这种只能靠遮盖拦下的值没有出现。即第二层有门槛，第一层没有。

证据：
- `redaction.ts:94,350-363` 的 `PASSWORD_BARE_VALUE` 分支。
- `packages/sensitive-capture/test/redaction.unit.test.ts:31,45` 已证明“口令：…”和“密码 …”都会遮。
- `hybrid-memory-provider.unit.test.ts:121-126` 的断言只检查这三个值不在词表；这三个值同时也能被兜底规则拦下。
- `docs/adr/0196...md:86` 的“规则认不出的口令 x9…”与上述代码矛盾。

状态：读代码证实测试内容与规则；未运行测试。

建议：加“密码是 hunter22”这种只能由遮盖拦下的用例；加重复出现的用例；把 x9 前面去掉“口令”，改成真正无关键词的长串；这样删掉任一层都会红灯。

### 中：清空索引后的自动重建依赖 `embedder`，没有嵌入模型的配置不会重建

文件：`apps/agent-service/src/service-main.ts:1184-1199`、`apps/agent-service/src/production-memory-composition.ts:46-49`、`apps/agent-service/src/service-main.ts:795-805`、`apps/admin-cli/src/memory-command.ts:58-70`

问题：启动时的 `listUnindexed + requeueProjection` 整段在 `while (embedder)` 里。`createProductionMemoryCompositionFromConfiguration` 在没有 embedding descriptor 时直接抛 `MEMORY_EMBEDDING_DESCRIPTOR_MISSING`；`isDeterministicOnly` 配置则根本不创建 `memoryComposition`。而 `memory reindex` 只要配置能加载、有 stateRoot 就会清空 `memory_search_index`，并不检查是否存在 embedding descriptor。这样的配置执行后索引被清空，服务启动也不会重建。生产配置有 Qwen 嵌入模型，所以现网风险低，但用户要求的“没有嵌入模型的配置”不成立。

证据：
- `service-main.ts:1184-1186`：`const embedder = memoryComposition.projection.embedder; ... while (embedder) {`
- `production-memory-composition.ts:46-49`：找不到 embedding descriptor 就 throw。
- `service-main.ts:795-805`：`if (!isDeterministicOnly(configuration)) { ... memoryComposition = ... }`
- `memory-command.ts:58-70`：未检查 `modelDescriptors` 的 embedding 项。

状态：读代码证实。

建议：在维护命令里拒绝“没有 embedding descriptor/确定性模式”的配置，或把启动重建改成即使没有 embedder 也重建词表；补一个无嵌入模型配置的启动重建测试。

### 低中：重跑 `memory reindex` 会再次清空健康索引并触发全量重算向量

文件：`packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:70-73`、`apps/admin-cli/src/memory-command.ts:58-70`、`docs/adr/0196...md:61,89`

问题：命令无论 `idleArchivesToRestore` 是否为 0，都执行 `DELETE FROM memory_search_index`。ADR 说“第二次恢复 0 条，索引再清一次再建一次”是安全的；数据上确实可重跑，但第二次会把已经建好的索引删掉，服务启动后为全部 active 记忆重新算向量，产生额外嵌入费用并在一段时间内减少检索结果。作者把“可重跑”写成“安全”，没有提这个代价。

证据：
- `sqlite-memory-maintenance.ts:70-73`：无条件 `DELETE FROM memory_search_index ...`
- `memory-command.ts:58-70`：plan 里的 `indexedMemories` 只用于输出，不参与是否清空的判断。

状态：读代码证实。

建议：当 `plan.idleArchivesToRestore === 0` 且索引已是最新时跳过清空；或者把“清索引重建”拆成单独显式开关，并先报告将重算向量的记忆条数。

### 低：实体只在记忆提取入口过滤，SQLite 存储层只校验长度

文件：`apps/agent-service/src/production-memory-capture.ts:366-376`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:811-816,622-625`

问题：`isSafeToIndex` 只加在 `parseMemoryCandidates`。`memory_entities` 表是明文的，`upsert/revise` 时对 model-visible 记忆直接写 `attributes.entities`，校验只有归一化后长度 1–64（sqlite-memory-operations.ts:622-625），不会再检查像密钥。当前其他写入者传的都是空实体（`production-memory-control.ts:745`、`production-reminder-writer.ts:229`、`consolidation.ts:542`），所以没有现成绕过路径；旧库里的实体也按作者说法不处理。但这是单端校验，未来新增写入者或导入路径时容易漏。

状态：当前写入者已核对；未来绕过属推测。

建议：把“像密钥”的纯函数放到 persistence-sqlite 能加载的叶子模块，保存时再兜一层；或至少在 ADR/测试里明确所有实体来源必须经过 capture。

### 低：旧敏感事件段仍无法补算向量，维护命令不处理

文件：`packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:70-75`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1397-1398`、`docs/adr/0196...md:79`

问题：维护命令只清 `memory_search_index`，不重建 `memory_episode_terms`。`listUnembedded` 仍 `JOIN memory_episode_terms`，所以此前第一次嵌入失败、又没有词表条目的旧敏感事件段，升级后依旧补不上。ADR 已明说“旧的敏感事件段同理，没有词表条目，不补”，与代码一致；但作者“问题 1”描述的正是这个现象，需要在上线报告里明确这是已知不修项。

状态：读代码证实；是否接受取决于 Andy 对旧数据的口径。

### 低：文档一致性

文件：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:26`

问题：0194 仍写记忆整理包括“归档闲置”，没有标注该行为已被 0196 停掉；`docs/engineering-casebook.md:175` 已更新。历史 ADR 可以不改，但至少应加交叉引用，避免后续按 0194 认为还会闲置归档。

---

## 侧重检查

- 错误路径：嵌入失败时 `hybrid-memory-provider.ts:104-110` 会先写词表再抛错，词表不会丢；episode 侧 `episodes.ts:337-347` 失败后仍写 `terms`，因此新敏感事件段可补向量。分页/限流：`indexableTerms` 上限 512 项、单项 64 字符，SQLite 端 `json`/长度校验能接受（`sqlite-memory-operations.ts:976-978,1207-1208`）。
- 不可信输入：模型给的 `text`/`entities` 都会进 `maskSensitiveText`/`isSafeToIndex`；但实体只在 capture 端过滤（见上）；索引本身是明文，因此重点查了遮盖路径，发现两处漏（高、中高发现）。
- 安全：restricted 不索引已核对（`isModelVisible` 只含 public/private/sensitive；SQLite 集合也一致）。敏感正文加密、词表明文是设计取舍；但明文词表里出现重复密码/带分隔符秘密是实际漏洞。
- 资源与不可逆操作：维护命令要求 state root 独占锁、`--confirm REINDEX_MEMORY_<agentId>`，事务内恢复+清索引，失败会回滚；参数解析与 operator 校验沿用 thread-command 模式。重跑会重复清空索引、重复付嵌入费用（见低中）。
- 维护数据状态：`IDLE_ARCHIVES` 只选 `action='archive'`、`undone_at IS NULL`、`m.status='archived'`、`m.revision = c.after_revision`；当前只有旧的 `#decay` 会写 `action='archive'`，合并写 `action='merge'`（`consolidation.ts:352`），因此“合并归档保留”成立。测试也覆盖了 merge、改过版本、已撤销和 active 四种不恢复的情况；但“已撤销但仍是 archived”的组合没真正覆盖。
- 规则文件：本次 diff 未改 `packages/prompt-catalog`、`packages/runtime-pi`、请求组装代码；索引只影响检索命中，不改变系统提示/工具定义/历史字节。
- 文档：README/ADR 与代码的主要出入是 0196 对 x9 用例的描述和 0194 的“归档闲置”。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只改服务端索引、实体表和一次性恢复/清索引命令；diff 中没有系统提示、工具定义、历史消息或遮盖实现的变化。检索结果仍按现有规则进入本轮的最后输出（记忆召回结果/末条消息），不进入系统提示或历史开头。依据：[发给模型的内容只追加](.claude/rules/prompt-prefix.md#rules)。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会，就请求内容而言没有变化。索引侧 `maskSensitiveText` 只接收文本本身，不传 `known`/`tag`/`trusted`，所以输出只取决于这段文本；`memoryFromRow` 的实体是 `ORDER BY name`，词表顺序也由 `indexTerms` 固定。它可能改变“哪几条记忆被召回”，但那属于本轮末尾的检索结果，不是请求开头。唯一未核实的是实际分词器对个别字符的输出，但它对同一输入仍是确定的。

3. **有没有自动检查，反向用例真的会失败？** 有一半。分级三档、停掉闲置归档、事件段词表、实体过滤、维护命令的 action/revision 过滤都有对应断言；去掉这些修复会失败。但：
   - 第一层 `maskSensitiveText` 没有门槛：去掉它后现有测试仍会通过（秘密同时被 `looksLikeSecretToken` 兜住）。
   - ADR 声称的“规则认不出的 x9”其实被“口令”规则遮掉，这个用例不测兜底。
   - 启动重建只测了 `listUnindexed`，没有测“服务启动后真的 requeue/重建”，也没有测无嵌入模型配置。
   - 维护测试没有覆盖“已撤销且仍是 archived”的记录。
   因此“反向用例真的会失败”不能完全成立。

4. **改动产生/修改的每个值，所有使用方都能接受吗？**
   - 词表项：`indexableTerms` 产出 → `upsertIndex` 校验项数/长度后写 FTS（`sqlite-memory-operations.ts:976-978,1020-1026`），两端一致。
   - 分级集合：`MODEL_VISIBLE_CLASSIFICATIONS` → 实体/记忆词表/事件段词表三处；读回搜索由 `DurableMemoryService.search` 的 `allowedClassifications` 和 `production-memory-recall.ts:219` 的 `isModelVisible` 再过滤，未发现泄露给不允许的调用方。注意它和 application 的 `MODEL_VISIBLE` 是重复定义，未来改一处会漂移。
   - 实体名：capture 端限制 1–64，SQLite 端 `CHECK length(name) BETWEEN 1 AND 64` 能接受；但 SQLite 端不复查“像密钥”，见低发现。
   - 维护命令：新命令、错误码、`REINDEX_MEMORY_<agentId>` 确认串、`memory.reindex` 诊断名都只在 admin-cli 内部消费，没有发现外部契约不匹配；`--operator` 正则沿用 thread-command。
   - 依赖/边界：`memory-engine` 新增 `@himawari-agent/sensitive-capture`，`package.json`、`package-lock.json`、`scripts/boundary-policy.mjs` 已同步；`sensitive-capture` 无依赖，未形成环。
   - 文档：0196 与代码大体一致，但 x9 用例描述与代码不符；0194 仍写“归档闲置”。
