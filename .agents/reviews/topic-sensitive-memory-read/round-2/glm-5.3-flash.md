我先读关键文件核对方案里的前提。
# 审核结论

## 证实的（按严重度从高到低）

**1.（高）「向量用遮盖文去嵌入」与现有代码门禁直接矛盾，方案第一步照字面实施不会产生向量。**
证据：`packages/memory-engine/src/hybrid-memory-provider.ts:96-97`：
```ts
let embedding = null;
if (embedder && this.#embeddable.has(memory.dataClassification)) {
```
`#embeddable` 来自 `apps/agent-service/src/production-memory-composition.ts:101` 的 `embeddableClassifications: embedding.allowedDataClassifications`，而生产配置模板里嵌入模型是 `"allowedDataClassifications": ["public","private"]`（`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107`）。sensitive 记忆今天根本不会被嵌入。方案一边说「向量用遮盖文去嵌入」，一边说「不需要改嵌入模型的 allowedDataClassifications」——要产出向量，要么改配置（那就推翻了「零确认、不改门槛、第一步不需要 Andy」），要么在代码里对「凭证型 + 遮盖文」开特例（方案没写这条改动）。字节层面特例确实成立（`redactEmbeddings` 对嵌入输入无条件遮盖、无分类门禁，`model-egress.ts:492-503`），但方案必须把这个特例改动明说。
同理，`hybrid-memory-provider.ts:18` 的 `LEXICAL_CLASSIFICATIONS = new Set(["public","private"])` 也不含 sensitive，词项索引同样需要显式改动，方案只说「全文词项用遮盖文分词」没点到这个常量。
建议：第一步明确增加两条代码改动（embeddable 特例 + 词项分类特例），并写明为什么不改配置也成立；或者干脆承认凭证型只靠词项检索（语境词足够），删掉向量那句。

**2.（高）凭证型包含 machine-secret，但 `[密钥]` 占位符无法还原——验收 1 对这一类必然失败，方案的承诺（「主人看到原值」）对机器密钥是假的。**
证据：`packages/sensitive-capture/src/redaction.ts:70`（`MACHINE_SECRET_PLACEHOLDER = "[密钥]"`）、`redaction.ts:317`（无 tag 时不进 `table`）、`redaction.ts:338`（机器密钥整段替换成 `[密钥]`，无编号）；ADR 0183 Andy 拍板原话：「机器密钥的占位符 `[密钥]` 没有编号、无法还原」。所以主人问「我的 GitHub token 是什么」，recall 返回原文，出口遮成 `[密钥]`，模型只能回答 `[密钥]`，显示端不还原——主人在对话里永远拿不回密钥。这和方案的目标「让模型能用上 sensitive 记忆」对机器密钥这一类不成立，且反向验收 1（抓请求体无原值、回复有原值）在这类记忆上自相矛盾。
建议：把 machine-secret 从凭证型里去掉（失败方向保守），或者保留但在方案里写明「机器密钥类记忆召回后主人拿不到值」，并把验收 1 的用例限定为密码/证件号/银行卡。

**3.（中）新增的判定函数要调用 `redactForEgress`，必须登记 `REDACTOR_ONLY_FILES`，方案没提这一步。**
证据：`scripts/check-egress-redaction.mjs:178`：`if (/\bredactForEgress\(/u.test(text) && !REDACTOR_ONLY_FILES.includes(relative))` 会让未登记文件直接失败（ADR 0185 决定 4 就是先例）。不登记的话 `npm run check` 必挂——这反过来回答必答问题 3：这道门槛会抓到遗漏。
建议：写进实施清单。

**4.（中）recall 放开的实现位置有一个顺序问题：过滤发生在读文本之前。**
证据：`production-memory-recall.ts:213-222`，`render()` 先用 record 字段（含 `allowed.includes(memory.dataClassification)`，217 行）筛，`readText` 在筛完之后才调。凭证型判定需要原文，所以 sensitive 命中要先读文本再判定；tentative 候选走同一条 `render`（237 行），「待批准的凭证型也不返回」要在这条路径上单独保证。另外每次 recall 要对最多 `limit*3` 条 sensitive 命中解密并跑检测，成本要在方案里认一下。
建议：把「凭证型判定在 render 内、readText 之后」写成明确的改动点，并给 tentative 列表单独的反向用例。

**5.（低）索引端裸占位符与出口端 HMAC 占位符不一致。**
证据：索引用不带 tag 的 `redactForEgress`，占位符是 `[密码]`（`redaction.ts:317`）；recall 的 query 嵌入走出口遮盖，占位符是 `[密码#xxxxxxxx]`（`model-egress.ts:121-126`，`letters(sign(key, kind\0value))`）。当模型把历史里的占位符抄进 query 时，词项和向量都对不上索引里的 `[密码]`。这不是安全或确定性错误（两端各自都确定），但方案宣称「同一个值每次遮成同一个占位符」只在出口端成立，索引端是另一种占位符。顺带：「不含由值算出的内容」也不完全准——银行卡裸占位符是 `[银行卡 尾号NNNN]`（`redaction.ts:385`）。
建议：要么索引端也用同一 HMAC tag（本地索引库里本来就有记忆明文，ADR 0183 已接受，没有额外泄露面），要么在方案里明确接受不一致并说明理由。

**6.（低）补投影判断除了「投影策略版本」还应包含遮盖 ruleset 版本。**
证据：`redaction.ts:53-54`（`EGRESS_RULESET_FIRST_LOOSE_PASSWORDS` / `EGRESS_RULESET_CURRENT`），遮盖规则升版会改变遮盖文，索引内容随之失效。方案风险 6 已承认要加列或一次性任务，补上 ruleset 这一项。

## 推测

- public 分级的运行是否也放开凭证型，方案只写了 private；遮盖后字节无害，但应写明边界，否则实现者会自行决定。
- 召回的工具结果若后来被压缩掉，压缩摘要里模型抄的占位符可能还原不了（ADR 0183 决定 3「还原不了的占位符原样保留」）——失败方向保守，可在验收 5 里补一条压缩场景。
- 文档一致性：我没找到任何设计规格条款把「recall 只返回不高于运行分级」写成产品承诺（未核实设计规格全文）；若存在这样的条款，第一步必须同步改文档，否则违反「文档和规则与代码一致」。

## 侧重检查

走的流程：主人说「记住家里 Wi-Fi 密码是 abc12345」→ `production-memory-capture.ts`（ADR 0185：sensitive、topic=other，`production-memory-capture.ts:465`）→ 批准/直存 → `hybrid-memory-provider.ts:78-115` upsert 投影 → 后续对话模型调 recall（`production-memory-recall.ts:130-272`）→ `embedWithin` 嵌入 query → `provider.search` → `state.readMany` → `readText` → 工具结果进历史 → 出口遮盖（`model-egress.ts` maskRequest）→ 模型回复占位符 → 显示端还原（`egress-context.ts:42-108`，只还原 text 块）。
结论：改动涉及的四段（upsert 遮盖分支、recall 过滤放开、补投影、判定函数）今天都没有测试覆盖；`packages/memory-engine/test/hybrid-memory-provider.unit.test.ts` 现有用例只测 embeddableClassifications 组合，`apps/agent-service/test/production-memory-recall.unit.test.ts` 只测现有过滤。方案的六条反向验收覆盖面是对的，但缺两条：machine-secret 类（对应证实问题 2）、`check:egress-redaction` 登记反向（少登记必须失败——这道门槛现成）。文档一致性未发现直接矛盾；ADR 0183「主人的数据库里会有明文拷贝」的既有取舍与方案一致。

## 如果由我来定

第一步保留骨架，但先修四处：① 把 embeddable/词项两个分类特例写成显式代码改动，删掉「不改任何东西」的暗示；② machine-secret 移出凭证型（或在方案里承认拿不回值）；③ 实施清单加 REDACTOR_ONLY_FILES 登记；④ 索引占位符与出口占位符统一（用同一 HMAC tag）。第二步维持「需 Andy 拍板」不变。

**必答问题：**

1. **请求开头**：不变。改动只让 recall 的工具结果在末尾追加内容；工具名和参数结构不变（`production-memory-recall.ts:29-48` 不动），不触发规则 6 的换新；系统提示、图例、已有历史逐字节不变；每轮会变的召回结果在当轮追加的工具结果里。前提 1-4 核对属实（`egress-context.ts:30-39`、`model-egress.ts:492-503`、`owner-profile-service.ts:17`、`production-run-memory.ts:357-363` 均如方案所述）。唯一要防的间接路径：别把召回统计之类每轮变化的值塞进系统提示。
2. **字节确定性**：出口占位符是 `letters(sign(key, kind+"\0"+value))`（`model-egress.ts:125`），同值同字节、与位置无关；遮盖只依赖消息自身和前面的内容（规则 11），历史重放重遮盖字节相同。索引端裸占位符也是确定的。发现的不一致是「两端占位符不同」（证实问题 5），不是「同一段文字变不同字节」。
3. **自动检查**：有。`check:prompt-prefix` 存在且自带反向用例（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`，规则文档 74 行），端到端抓原始请求体的 `[PR-A]/[PR-B]` 机制可承载验收 1；`check:egress-redaction` 会强制新判定函数登记（`check-egress-redaction.mjs:178`）。反向用例「去掉遮盖必须失败」设计合理，但我没有运行验证（未核实）。
4. **逐值核对**：凭证型判定函数（产生于 sensitive-capture，使用于 upsert 与 recall，共用一份保证一致，需登记）；遮盖文词项/向量（进本地 FTS/向量表，消费方是 recall 检索，无额外校验端，可接受）；放开的召回结果（消费方：模型——只见遮盖字节；历史库——明文，规则 5 的遮盖例外允许；显示端——password/证件号/银行卡可还原、`[密钥]` 不可，见证实问题 2；压缩、导出、推送——各自按既有 ADR 处理，不受影响）；投影策略版本列（可能加列，方案已列为风险 6，建议再纳入 ruleset 版本）。两端校验里唯一对不上的就是问题 1 的 embeddable 门禁。
