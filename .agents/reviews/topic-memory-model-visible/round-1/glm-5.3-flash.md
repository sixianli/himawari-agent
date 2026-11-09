我先明确要核对的问题，再定向读代码：

1. 记忆进入模型请求的位置（是否只在末尾）→ 读 `prompt-prefix.md` 规则、`context-formation-service.ts`、`production-run-memory.ts`。
2. 占位符稳定性（问题 2）→ 读 `redaction.ts`。
3. 新常量/静态检查的可行性 → 抽查方案引用的行号是否属实、grep 分级名单的分布。
4. 归档记忆的索引是否被删 → 读 sqlite 记忆操作。
规则和遮盖函数已读。关键点：占位符编号来自 `tag` 回调（redaction.ts:317），是否跨请求稳定取决于 `model-egress.ts` 怎么生成 tag。接下来读遮盖调用方、上下文拼装、记忆注入位置。
占位符 tag 是 `sign(key, kind+value)`（model-egress.ts:121-126），密钥不变则跨请求稳定。继续核对 recall 的分级过滤与 includeHistory、归档时索引是否删除、以及现有静态检查脚本。
`listUnindexed` 已证实（:1469 只扫 active），且全库没有删除索引行的语句。再看检索 SQL 是否按 status 过滤、归档记忆的索引行是否仍可命中。
记忆/档案块进最后一条消息、system 消息不含它们——已有测试断言（prompt-prefix.compat.test.ts:409-416）。再抽查方案引用的几处关键行号与提示词图例、整理/情景的白名单。
# 审核结论：存入记忆的内容必须能被模型看到（方案 v1）

## 侧重检查

我走的最普通流程：主人在聊天里说“家里 Wi-Fi 密码是 abc12345，记一下”→ 消息按 private 存（`apps/control-center/src/thread-control-center.tsx:1063`）→ 自动记忆候选分级（`packages/application/src/services/automatic-memory-service.ts:133`，restricted 丢弃）→ 敏感记忆逐项批准入库 → 投影进索引（`packages/memory-engine/src/hybrid-memory-provider.ts:78-110`）→ 三条读取路（recall 工具结果、自动上下文块、档案块）→ 出口遮盖（`model-egress.ts` 的 `exchange.wrapFetch`，`scripts/check-egress-redaction.mjs:8-16` 锚定了 chat 与 embeddings 两端）→ 显示还原（`model-egress.ts:156-163`）。

其中**没有现成测试覆盖**的代码路径：
- sensitive 记忆投影时产生遮盖词项（新逻辑，现在 sensitive 在 `hybrid-memory-provider.ts:85` 直接得空词项）；
- sensitive 分类的记忆块出现在最后一条用户消息（`packages/runtime-pi/test/prompt-prefix.compat.test.ts:340` 的夹具全部是 `dataClassification: "private"`，没有 sensitive 块用例）；
- 含密码的记忆经 recall 进入工具结果后，占位符还原到主人显示（`[PR-A]/[PR-B]` 测的是主人消息里的银行卡号，不是记忆内容里的密码）。

这三段正是方案 `[RULE-memory-visible]` 应该落的位置，方向对；但方案没列 prompt 金样文件的同步更新（见问题 6）。

---

## 证实的问题（按严重度从高到低）

**1（高）静态检查 `check:memory-visible` 按方案描述抓不到主要通道，反向用例不会失败。**
证据：三条主通道根本没有字面的 `["public","private"]` 名单——recall 用 `CLASSIFICATIONS.slice(0, CLASSIFICATIONS.indexOf(invocation.dataClassification) + 1)`（`apps/agent-service/src/production-memory-recall.ts:160-163`），自动上下文用 `all.indexOf(request.dataClassification)` 过滤全列表（`apps/agent-service/src/production-run-memory.ts:357-363`），上下文拼装用 `CLASSIFICATION_RANK` 比较（`packages/application/src/services/context-formation-service.ts:279-286`）。字面名单反而大量存在于不该动的合法位置（如 `packages/application/src/services/owner-profile-service.ts:17`、嵌入模型配置模板 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107`）。
建议：照 I-73 的门槛模式改成**行为检查**——喂数据过通道断言非空（参考 `check:model-ref-contract` 用真实校验而非扫描的做法，见 `docs/incidents-and-gates.md:112`）；静态扫描只对将被删除的四个字面常量做文件锚定（`hybrid-memory-provider.ts:18`、`sqlite-memory-operations.ts:146`、`consolidation.ts:35`、`episodes.ts:19`）。

**2（高）「已归档记忆可被 recall 找到」的改动面被低估，现状在两层都挡死。**
证据：检索 SQL 的共享作用域硬编码 `m.status = 'active'`（`sqlite-memory-operations.ts:240` `indexScope`），`includeHistory` 现在只放开 `valid_to` 过期（`:244`），不放开 status；recall 渲染层再挡一次 `memory.status !== "active"`（`production-memory-recall.ts:215`）。方案 §3 说“includeHistory 参数（已有，不改参数结构）放开后同时返回已归档”——参数确实不用改，但要动被所有检索共用的 `indexScope`，并保证自动上下文路径（不带 includeHistory）不受影响。另外补索引 `listUnindexed` 只扫 active（`:1469`），归档记忆的索引行不会被删也没有再投影路径。
建议：把 §3 拆成独立卡（过期/被更正的“历史”已经能用 `includeHistory` 拿到，工具描述 `packages/prompt-catalog/src/tools.ts:36` 已写“已失效的标为历史”；归档另做），先兑现主人最关心的“有效记忆可见”。

**3（中）§5「规则集 1 的对话 recall 只返回遮盖后文字」没有定义遮盖输出形态，还原链路会断。**
证据：出口还原只认带编号占位符且只在当次请求遮盖时填表（`redaction.ts:65` `EGRESS_PLACEHOLDER_PATTERN`、`model-egress.ts:129,156-159` 的 `table` 在遮盖时填充）；recall 侧预遮盖产生的占位符不在表里，主人会看到裸的 `[密码#xxxxxxxx]`。且 recall 需要知道对话的 ruleset，`invocation` 上目前只有 `dataClassification`。
建议：优先加速“老对话升级规则集 2”那张卡，而不是加这层预遮盖；若保留，明确用无编号 `[密码]` 并写明“此路径不可还原”，ruleset 通过内部选项传入（非工具参数，不触发对话换新，规则第 6 条只看工具名与参数结构）。

**4（中）「启动校验 maxMemoryClassification 低于 sensitive 拒绝启动」不可行，且该配置不只管记忆。**
证据：模板与全部测试/生产配置都是 private（`production-shape-config-template.json:16`），file-summary 场景是 public（`test/integration/fixtures/file-summary/configuration.json:89`）；同一配置还过滤线程历史与摘要（`context-formation-service.ts:151,183,197,427`）。拒绝启动会让现网和 file-summary 起不来；只摘掉记忆语义会留下“一个配置两个字段含义”。
建议：只记日志；配置语义拆分写进 ADR；`docs/runbooks/install-start-stop-runbook.md:466` 的说明同步修订。

**5（中）遗漏场景：派生物会把 sensitive 降级。**
每日整理（合并、冲突处理）和情景摘要放开 sensitive 后，会产生含 sensitive 内容的合并记忆和 day/episode 摘要；若派生物按现有规则标 private 或更低，等于绕过分级把健康正文送进按 private 显示的载体。方案“不做的事”只考虑了“改老标签”（`payload-protector` AAD、锁屏推送 `production-web-push.ts:486-498`），没考虑“新派生怎么标”。
建议：加一条规则——派生物 classification = max(来源)，并纳入 `[RULE-memory-visible]` 反向用例。

**6（中，文档/测试一致性）提示词图例修正有连锁，方案没列。**
证据：`packages/prompt-catalog/src/chat.ts:255,267` 确实把 `[密钥]` 列进“会还原”的图例，而 `[密钥]` 无编号不可还原（`redaction.ts:70`；`model-egress.ts:157` 的 restore 只匹配带 `#` 的模式）——方案的前提 8 成立。但这段文字被 `check:prompt-catalog` 的金样测试断言（`apps/agent-service/test/__prompt_gold__/`、prompt-rendering-golden、prompt-wording），改动要同步再生金样。

**7（低）索引侧遮盖必须连 entities 一起遮。**
`hybrid-memory-provider.ts:86` 把 `memory.attributes?.entities` 和正文一起分词，实体抽取自原文，可能含凭证值；方案只写了“先遮盖再分词”的正文。

**8（低）行号小漂移，不影响结论**：嵌入判断在 `hybrid-memory-provider.ts:97`（方案写 :96）；聊天存 private 在 `thread-control-center.tsx:1063`。

## 推测（未完全核实）

- **推测**：档案块内存平局时排序可能依赖底层返回顺序（`owner-profile-service.ts:111-113` 的 `ownerFirst` 只比 pinned 和重要度；`byImportance` 未读）。若平局顺序不稳，违反规则 10。建议核实并补次级排序键（如 id）。
- **推测**：嵌入名单加 sensitive 后，qualification probe 与 `check:product-path-configuration` 可能断言模板形状（`test/qualification/sandbox-install-restart-probe.mjs:850` 一带），需实跑一遍 check。
- **未核实**：ADR 0183/0185/0188/0112/0158 原文、设计规格 67/70/162 行、PRD v0.2 136-139 行、`payload-protector.ts:193-200`、`episodes.ts:19,236`、`consolidation.ts:352,437` 归档路径、`production-proactive-memory.ts:51`、`sqlite-capability-invocation-operations.ts:1721`。

## 如果由我来定

保留核心规则（记忆读取上限固定到 sensitive，运行分级不动——工具授权上限在 `sqlite-capability-invocation-operations.ts:1606-1607` 确实会牵连，方案的取舍正确）。改动：
1. §3（归档可见）拆出去，第二期做；第一期只交付“有效 sensitive 记忆可见 + 凭证占位符 + 图例修正”。
2. 静态检查改为 I-73 式行为门槛 + 四个字面常量的文件锚定扫描；`[RULE-memory-visible]` 补上 prompt-prefix 的 sensitive 块夹具和“记忆里的密码还原到主人显示”端到端用例。
3. 新增“派生物 classification = max(来源)”规则。
4. 启动校验只记日志；同步修订 runbook 和金样文件。

## 必答问题

1. **不会改变已见过的请求开头。** 记忆/档案/日程块本来就渲染在最后一条用户消息（`prompt-prefix.compat.test.ts:409-416` 断言 system 消息不含块内容、块逐轮变化不破坏追加），工具结果只追加；本方案不动的系统提示与工具定义不变，图例文字修改只对新对话生效（规则第 6 条）。每轮会变的值（选中记忆、时间）都在最后一条消息。§3 若实施，只影响新产生的工具结果，合规。
2. **基本不会。** 占位符编号是 `sign(key, kind+value)`（`model-egress.ts:121-126`），密钥不变则同值同字节，与规则第 5 条一致；记忆选择排序确定（`context-formation-service.ts:258-259`，score 降序 + id）。风险点是 §5 的 recall 预遮盖形态未定义（问题 3）和档案块平局排序（推测），需在方案里补“遮盖输出只依赖自身与密钥、列表排序含次级键”的约束。
3. **测试方向对，静态检查的反向用例现在不成立。** `[RULE-memory-visible]` 的端到端用例可以真实失败；但 `check:memory-visible` 按方案描述扫描“只含 public/private 的名单”，对 slice/rank 写法的三条主通道不触发（问题 1），必须重新设计后反向用例才真实失败。
4. **逐值核对见上文各条**：新常量的消费方中 Gmail 通道未核实；`maxMemoryClassification` 在历史/摘要过滤仍在使用、启动拒绝会打碎 file-summary；嵌入名单牵连 composition、listUnindexed、模板校验与 probe；`includeHistory` 的“已归档”语义需要动共享 `indexScope` 与渲染层；索引遮盖要覆盖 entities；图例修正牵连金样测试。I-73 的教训（两端都要看校验）在嵌入名单和 maxMemoryClassification 两处直接适用。
