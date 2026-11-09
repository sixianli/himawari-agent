# PR 334 复核报告

## 侧重检查

我走的最普通流程：主人发消息 → `parseMemoryCandidates` 提取记忆（实体过滤）→ `DurableMemoryService` 保存 → 投影 `HybridMemoryProvider.upsert`（`indexableTerms` 建词表）→ SQLite 写 `memory_search_terms`/`memory_entities` → 之后的对话检索召回 → 上下文块进请求。

- 已覆盖：提取端实体过滤（production-memory-evidence.unit.test.ts:26）、词表建法（hybrid-memory-provider.unit.test.ts:110、memory-consolidation.test.ts:516）、敏感词召回（memory-engine-index.test.ts:300）、敏感事件段建词+补向量（memory-episodes.test.ts:240）、reindex CLI（memory-reindex-cli.unit.test.ts）。
- 未覆盖：**`memory_entities` 表对 sensitive 的插入和实体检索**（sqlite-memory-operations.ts:808-815）——consolidation 测试只读回 `attributes.entities`，没有用例断言敏感记忆的实体真的进了实体表并能被实体检索找到。
- 未覆盖：reindex 清空索引后「服务重启重建」只在 CLI 测试里用 `listUnindexed` 模拟（memory-reindex-cli.unit.test.ts 末段），没有端到端跑真实启动循环。
- 维护命令流程本身（锁定→报数→确认→事务→重跑）已覆盖。

## 发现（按严重度从高到低）

**1. 中 | packages/sensitive-capture/src/secret-like.ts:6-15、redaction.ts:542-544 | 索引端遮盖没有上下文，兜底规则漏短密码——秘密可进明文词表**
- 证据（读代码证实）：`maskSensitiveText(input)` 就是 `redactForEgress(input)`，不带 `known`（redaction.ts:542-544）；「named-earlier」只在传了 `known` 时生效（redaction.ts:411）。密码规则全要求**关键词在值前面**（redaction.ts:79-97 的三个正则）。`looksLikeSecretToken("hunter22")`：长度 8 <16、数字 2 <3 → false。
- 后果：记忆正文若写成「hunter22 是我的新密码」（关键词在后）或正文里只有裸值（主人早前点过名、出口遮盖靠 `known` 能遮），索引端既遮不掉也兜不住，`hunter22` 以明文进 `memory_search_terms`。记忆正文加密、词表明文，这是把秘密落盘成明文的真实路径，正是作者要求核对的方向。纯字母长密码（无数字）同样漏。
- 建议：索引端至少把「关键词在值后」的形态也遮掉，或对词表条目加一道更保守的字母数字混合阈值；长期应让索引端能拿到主人点过名的值。

**2. 低 | docs/adr/0196:86、test/integration/memory-consolidation.test.ts:516-523 | 「规则认不出的口令 x9Kq2mVb7Lp4Wz」说法与代码不符**
- 证据：测试正文是「医保卡备用口令 x9Kq2mVb7Lp4Wz」，`PASSWORD_BARE_VALUE`（redaction.ts:94-97，关键词「口令」+空格+含数字的 6+ 字符值）会把它遮掉——遮盖规则**认得出**它，不是「认不出」。
- 后果：这条集成测试去掉 `looksLikeSecretToken` 仍然通过，并不反向验证兜底层。真正单独验证兜底的是 hybrid 单元测试里的「手机号 13800138000」（遮盖规则不命中，11 位纯数字被拦，去掉兜底该用例失败）。结果（查不到）成立，但归因写错。
- 建议：改 ADR 措辞；若要端到端验证兜底，用例应放一个关键词和格式都不命中的值。

**3. 低 | packages/sensitive-capture/src/secret-like.ts:6-15 | 兜底规则误伤日期、时间类词**
- 证据：`"2026-11-09"`（长度 10、数字 8 ≥3）→ true；`"14:30:00"`（长度 8、数字 6 ≥3）→ true。英文正文里这类词会被拆成一个词并被丢掉。
- 后果：按词搜日期/时间失效，比 ADR 声明的代价（手机号、订单号）范围大。中文分词通常拆开，影响集中在英文。
- 建议：ADR 补记这条代价，或排除含 `-`/`:` 的日期时间形态。

**4. 低 | packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:56-70 | 直接 SQL 恢复绕过常规写路径；计划数可长期虚报**
- 证据：恢复是裸 `UPDATE memory_records SET status='active', revision=revision+1`，不写 history、决策账本或投影任务；而常规撤销/恢复路径都经 `saveWithProjection` 带 history。另外 `planMemoryReindex` 统计的是「change 未撤销且记忆仍 archived」——若某条曾被手工恢复又手工归档之外的情形（例如手工恢复后 change 的 `undone_at` 仍为 NULL），每次报数都会把它算进去而实际恢复跳过（`changes !== 1 → continue`）。
- 后果：审计只有 CLI 的一行 JSON；报数可能不准（无害但误导）。
- 建议：恢复时补一条 history note；接受虚报则文档记一句。

**5. 信息 | 一致性核对全部通过（读代码证实）**
- 三处分级集合改三档且使用点一致：sqlite-memory-operations.ts:148、808、1019-1022、1258-1261。
- `#decay` 删除后 consolidation 只产生 merge/supersede（consolidation.ts:352、429）；用户手工归档（durable-memory-service.ts:520-549 `deactivate`）不写 consolidation change，所以 reindex 的 `action='archive'` 条件不会误恢复主人手工归档的记忆。
- 清索引会连带清词表：迁移 0052_memory_engine.sql:42-45 的触发器。
- 重建保证：`memoryComposition` 建立时嵌入描述符缺失直接抛错（production-memory-composition.ts:46-49），所以记忆功能开启必然有 embedder，service-main.ts:1186-1199 每次启动都会重排未索引记忆。作者说法成立。
- 依赖与边界：boundary-policy.mjs:41 放行 memory-engine→sensitive-capture，两处 package.json/package-lock 同步；persistence-sqlite 无新依赖，符合「独立线程加载不了」的约束。
- entities 唯一非空生产者是 `parseMemoryCandidates`（其余三处都写空数组；gateway 合约无 entities 字段），过滤加在唯一入口，与存储层校验（只查长度，sqlite-memory-operations.ts:622-625）两端配合可接受。
- 重跑 `--confirm` 在服务重建后再跑会再清一次索引、下次启动再建，ADR 已写明且有状态锁拦运行中的服务，可接受。
- i18n 文案、casebook、schema-catalog 描述与代码一致。

**未核实**：我无法运行测试，「去掉修复会失败」是按断言逐条推演的（见必答 3）；`npm run check` 里没有以 `RULE-memory-visible` 命名的专门阻断脚本，这些用例只随 vitest 项目（vitest.workspace.ts 各项目）在定向/全量测试时运行。

## 必答问题

**1. 是否只追加？** 是。本 PR 不触碰系统提示、工具定义、历史写入和出口遮盖；它只改变「哪些记忆能被检索到」。新增可见内容（敏感记忆词表/实体/事件段命中、恢复的归档记忆）只影响本轮上下文块，按既有机制附在最后一条用户消息里；prompt-prefix.compat.test.ts:431 的 `[RULE-memory-visible]` 追加-only 门继续覆盖（规则第 4 条的 ADR 0193 例外不涉及本 PR）。读代码证实：diff 无任何 prompt 组装文件。

**2. 同一段文字会不会变字节？** 不会。`indexableTerms`/`isSafeToIndex` 对同一输入确定：`maskSensitiveText` 无上下文参数、正则固定、`Intl.Segmenter` 顺序确定；没有时间戳、随机值或无序集合进入模型可见值。遮盖规则集将来升级只会改变词表内容（影响检索结果，即最后一条消息），不影响已发字节。

**3. 有自动检查吗？反向会失败吗？** 有测试、无专门 check:* 门槛。6 个测试文件带 `[RULE-memory-visible]`。反向推演：实体过滤——断言 entities 精确等于两项，去掉过滤即失败；停归档——断言无 archive 变更、onigiri 仍 active；词表——`'"青霉素"'` 必须命中、去掉三档改动即失败；兜底——`13800138000` 必须不在词表；CLI——不确认必拒、恢复集合精确、重跑 restored:0。注意发现 2：集成测试那条「认不出的口令」实际不隔离兜底层。均未实际运行。

**4. 每个新值两端都核对了吗？** 逐个：`indexableTerms`（segmentation.ts:114 → hybrid-memory-provider.ts:85、episodes.ts:365，两端都先 `isModelVisible`）✓；`looksLikeSecretToken`/`isSafeToIndex`（secret-like.ts → segmentation.ts:115、production-memory-capture.ts:371-373，存储层只查长度、唯一生产者已过滤）✓，但发现 1 说明兜底规则本身有漏；`MODEL_VISIBLE_CLASSIFICATIONS` 三处使用一致 ✓；`memory reindex` 命令（确认串 `REINDEX_MEMORY_<agentId>`、状态锁、`assertWritableSchema`、事务、JSON 输出）与 admin-cli 既有约定和测试一致 ✓；依赖放行（boundary-policy、package.json×2、package-lock）✓。唯一实质缺口是发现 1 的词表明文路径和发现 5 的 `memory_entities` 未测。
