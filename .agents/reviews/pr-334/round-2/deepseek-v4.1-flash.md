# PR 334 第 2 轮复核结论

改动集中在 `maskForIndex` 的去值与整串兜底、实体过滤 `isSafeToIndex`、敏感三档进词表、以及停止闲置归档和一次性 reindex 命令。总体上改动方向与 ADR 0196 一致，但去值步骤有一个会导致**秘密仍以明文写进全文词表**的缺口，另有过删和文档不一致。以下按严重度排列。

## 问题列表

### 1. 中高：`maskForIndex` 的去值步骤会漏掉“带标点/带相邻文字”的同一个值，纯字母密码仍会进明文词表

**文件：** `packages/sensitive-capture/src/secret-like.ts:17-27`，配合 `packages/sensitive-capture/src/redaction.ts:77-82,99,345-363`

**问题：** ADR 决定 2（`docs/adr/0196-...md:55`）说“规则认出的值（`findSensitiveValues`），在同一段文字里再出现时也去掉”。但 `findSensitiveValues` 返回的 `value` 常常带着识别时的上下文：

- 严格密码规则 `PASSWORD_ASSIGNMENT` 的值是 `[^\s,，;；]+`（`redaction.ts:77`），所以“密码是sunflower。客人来了……”里，第一次命中的值是 `sunflower。客人来了就告诉他`（一直抓到空格），或至少是 `sunflower。`。
- 只有宽松密码形式才会在 `redaction.ts:359` 用 `PASSWORD_TRAILING_PUNCTUATION`（`redaction.ts:99`，只去 `.:)'"`）去掉尾部标点；严格形式（`redaction.ts:345-349`）不去。
- 机器密钥的 `observe` 传的是整个匹配（`machine-secrets.ts:69`），`credential-assignment` 的值包含 `password=` 这样的关键字前缀，后面单独出现的裸值不会命中。
- `maskForIndex` 拿到的是这些带上下文的字符串，用 `masked.split(value).join(" ")`（`secret-like.ts:26`）去删，自然删不到后面单独出现的裸值。
- 剩下那个裸值若是纯字母（如 `sunflower`）或 4–5 位数字（如验证码 `4829`），`looksLikeSecretToken` 也兜不住（`secret-like.ts:12-14`：纯数字要 6 位以上；字母数字混排要 8 位以上且有字母和数字）。

**证据（亲自读到）：**

```ts
// secret-like.ts:18-27
const values = [...new Set(findSensitiveValues(text)...)].sort(...);
let masked = maskSensitiveText(text);
for (const value of values) masked = masked.split(value).join(" ");
return masked.replace(TOKEN_RUN, ...);
```

```ts
// redaction.ts:77
const PASSWORD_VALUE = "[^\\s,，;；]";
// redaction.ts:99
const PASSWORD_TRAILING_PUNCTUATION = /[.:)'"]+$/u;
// redaction.ts:359（只对宽松形式）
const value = raw.replace(PASSWORD_TRAILING_PUNCTUATION, "");
```

**影响：** 这正是本 PR 声称要修的“同一个密码重复出现”那类场景：一旦第一次出现紧贴句号/感叹号/引号/中文后半句（中间没有空格或中文逗号），第二次出现的纯字母密码或 4–5 位验证码会被拆成词，堂而皇之地进入 `memory_search_terms`（明文 FTS）。这与 ADR 的动机（词表是明文）直接冲突，属于安全回退（不过需要“重复出现且无关键词”的组合，故定中高）。

**建议：** 收集到的 `value` 先按与宽松形式相同的规则去掉首尾标点（至少补上 `。！？、；：` 与弯引号），并且不要拿“带关键字前缀/整段邻接中文”的机器密钥匹配串去删裸值；最好复用出口遮盖在 `redaction.ts:411-424` 的 `named-earlier` 边界正则（前后不紧挨字母/数字/下划线/汉字）做去值。补一条“密码是sunflower。…… sunflower”和“验证码是4829。…… 4829”的反向用例。

### 2. 低：去值是裸 `split`，会误删正常文字，也会吃掉卡号占位里的尾号

**文件：** `packages/sensitive-capture/src/secret-like.ts:26`，`packages/sensitive-capture/src/redaction.ts:65`

**问题：** `masked.split(value).join(" ")` 按子串删除，没有词边界。像 `密码是test` 识别出的 `test` 会把后面的 `contest` 删成 `con `；识别出的 4 位验证码 `2024` 会把 `2024-11-09` 里的年份删掉。更直接的是占位文字：卡号占位是 `[银行卡 尾号1111]`（`redaction.ts:65`），如果同一段文字里还有被识别为验证码/密码的值 `1111`，`split("1111")` 会把占位里的 `1111` 一起删掉，和 ADR 说的“卡号只留尾号”不一致。

**证据（亲自读到）：**

```ts
// redaction.ts:65
export const EGRESS_PLACEHOLDER_PATTERN = /\[(密码|验证码|证件号|银行卡 尾号\d{4})#([a-z]{8})\]/gu;
// secret-like.ts:26
for (const value of values) masked = masked.split(value).join(" ");
```

**影响：** 不泄露秘密，但会降低词表质量、丢失日期等正常词；与“误删正常文字”的问题直接相关。现有测试只覆盖了 `2026-11-09`、`去医院` 这种不碰撞的例子（`secret-like.unit.test.ts:34-47`），没有覆盖短值碰撞和占位文字。

**建议：** 用有边界的正则替换（同问题 1），或至少跳过“删除后落在 `[...]` 占位文字内部”的命中；补一条“验证码是1111，卡号 4111 1111 1111 1111”的用例，断言 `尾号1111` 还在。

### 3. 低：文档/作者说法与代码不一致（日期时间、`findSensitiveValues` 的普适性、行号）

**文件：** `docs/adr/0196-...md:55,57,64`，`packages/sensitive-capture/src/secret-like.ts:4,12-14`

- 作者把“日期时间被误伤”判为不成立，理由是“无字母时只认纯数字”。这只对不含字母的日期时间成立：`2026-11-09`、`14:30:00` 确实不受影响；但 `2026-11-09T02:30:00.000Z` 这类 ISO 时间含 `T/Z`，长度 ≥24，会直接命中 `secret-like.ts:13` 被当密钥删掉；`2026-11-09T10:00` 也会命中“8 位以上且有字母和数字”（`secret-like.ts:14`）。ADR 第 57 行自己写了“（不含字母）”，但作者总结里的“不成立”说得过宽。
- ADR 第 55 行“规则认出的值……再出现时也去掉”是普遍说法，但如上，机器密钥的 `value` 含关键字、严格密码的 `value` 含尾随标点，实际并不成立。
- ADR 第 64 行引用 `strict-configuration.ts:1279`，当前“exactly one embedding”检查在 `1281`（轻微行号漂移）。

**影响：** 文档读者会以为 ISO 时间戳和所有规则识别的值重复都已被处理，实际不是。属文档与代码不一致，低。

**建议：** 把“日期时间不受影响”限定为“不含 ASCII 字母的日期时间”，并在 ADR 写明去值只对“能干净剥离上下文的值”有效；同时更新行号。

### 4. 低：reindex 直接改 `undone_at`，绕过了正常撤销对 `decision_ledger` 的同步

**文件：** `packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:55-78`，`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:345-357`

**问题：** 正常撤销 `markUndone` 同时做两件事：`memory_consolidation_changes.undone_at` 和 `decision_ledger.owner_rating='unneeded'`。reindex 的维护函数只更新前者。ADR 明确“恢复不写‘主人评价不需要’”（第 66 行），这是有意取舍；但结果是 `decision_ledger` 里仍留着 outcome=`archive` 的决策（没有 owner_rating），而记忆已 active、`readBasisChain` 又因 `undone_at IS NOT NULL` 不再展示这条 archive 变更。审计账本和变更表会出现“决策账本说归档、记忆实际在用、依据链看不到这条变更”的三方不一致。

**证据（亲自读到）：**

```ts
// sqlite-memory-maintenance.ts:68-70
const undo = database.prepare(
  "UPDATE memory_consolidation_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
);
// sqlite-memory-consolidation-operations.ts:347-355（正常撤销还会更新 ledger）
UPDATE decision_ledger SET owner_rating = 'unneeded', rated_at = ? WHERE id = ? ...
```

**影响：** 不影响秘密安全，也不影响记忆可用性；但界面/审计可能展示一条“归档”决策却对应 active 记忆。属可解释性/审计一致性问题，低。

**建议：** 至少在本次恢复的 `decision_ledger` 上写一个“由维护命令恢复”的标记（或 `owner_rating` 保持 NULL 但 outcome 改成标志恢复的值），并在 ADR 写明账本与变更表的差异；或者复用/抽出 `markUndone` 的公共逻辑，只把“写 owner_rating”做成可选参数。

### 5. 低（范围/文档）：`people[].name` 不经过 `isSafeToIndex`，会明文进 `memory_people`

**文件：** `apps/agent-service/src/production-memory-capture.ts:386-411,606-612`，`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:338-352`

**问题：** ADR 第 59 行说“这是目前唯一写入非空实体的地方，其余写入者……都写空实体”，这只对 `attributes.entities` 成立。模型输出里的 `people[].name`/`aliases` 是另一条模型提供的名字路径，直接写入 `memory_people.name`（普通明文字段），没有过 `isSafeToIndex`，也不会进 FTS。若模型把密码/密钥误当人名，仍会以明文落库（不是本 PR 引入，但 ADR 的“唯一”表述不准确，且新过滤器的威胁模型没有覆盖这里）。

**证据（亲自读到）：**

```ts
// production-memory-capture.ts:393-401（name 只做 shortText，没有 isSafeToIndex）
const name = shortText(person["name"], 64);
...
// sqlite-memory-book-operations.ts:338-352
INSERT INTO memory_people (id, owner_id, ..., name, ...) VALUES (...)
```

**影响：** 推测（未追到 `memory_people` 是否被视为可接受明文）；但“唯一写入非空实体”的说法与代码存在字面不符。

**建议：** ADR 把“实体”限定为 `attributes.entities`，或给 `people[].name`/aliases 也加同类过滤；至少加一句“人物名不在此过滤器范围”。

## 读代码证实 vs 推测

**读代码证实的：**
- 问题 1：`PASSWORD_ASSIGNMENT` 的值包含标点/邻接中文；`PASSWORD_TRAILING_PUNCTUATION` 只用于宽松形式；`maskForIndex` 用 `split` 删值；`looksLikeSecretToken` 对纯字母/4–5 位数字返回 false。
- 问题 2：去值无词边界；卡号占位包含 `尾号\d{4}`；两者会相互影响。
- 问题 3：ISO 时间戳含 `T/Z` 会命中 `>=24` 或 `>=8 且字母+数字`；行号 1279→1281。
- 问题 4：维护函数只写 `undone_at`，正常撤销还写 `decision_ledger.owner_rating`。
- 问题 5：`people` 只经 `shortText`，`memory_people.name` 是明文插入，未过 `isSafeToIndex`。
- 实体过滤本身：`isSafeToIndex = maskForIndex(text) === text` 对 `entities` 是正确的（`小葵`/`Pixel 9` 通过，`密码：hunter22`/长卡号/`x9K…` 被拒）；我核对了 `production-memory-capture.ts:366-377` 与测试 `production-memory-evidence.unit.test.ts:26-84`。
- 三档词表/实体/事件段词表的写入条件在 `sqlite-memory-operations.ts:148,811,1022,1261` 与 `isModelVisible`（`model-visibility.ts:10-26`）一致。
- 事件段补向量 `listUnembedded` 仍 `JOIN memory_episode_terms`（`sqlite-memory-operations.ts:1397-1402`），和 ADR 前提 3 一致。
- `planMemoryReindex` 和 `restoreIdleArchivesAndClearMemoryIndex` 使用同一条 `IDLE_ARCHIVES` SQL，且 CLI 在同一个 `acquireStateRootLock` 内执行（`memory-command.ts:46-73`），作者“报数与恢复同一查询同一把锁”成立。
- ADR 前提 1/2/4 是“本决定之前的 main”的引用，代码已改，作为历史前提可以接受。

**推测/未核实：**
- 问题 2 对 FTS 检索质量的实际下降幅度（取决于数据分布），未运行测试。
- 问题 4 对界面/审计展示的具体影响（未追 UI 读取 `decision_ledger` 的路径）。
- 问题 5 中 `memory_people` 是否被界面当作不必加密的元数据，未核实其安全定位。
- 所有测试**未实际运行**（复核工具限制），只能按代码推断反向用例会失败。

## 侧重检查

- **不可信输入：** 模型输出的 `entities` 已过 `isSafeToIndex`（`production-memory-capture.ts:372-374`），这是好的；但 `people[].name`/`aliases`、`personLinks` 不过（问题 5），且 `people` 会写明文表。
- **安全/秘密落盘：** 主要缺口是问题 1（重复的纯字母密码/4–5 位验证码仍可能进明文 FTS）。此外敏感实体名现在会进明文的 `memory_entities`/FTS（这是本 PR 有意扩大，ADR 只明确讨论 FTS 是明文，未说明 `memory_entities` 同为明文；实体已过滤，仍属设计取舍，未列为缺陷）。
- **错误路径：** `runMemoryCommand` 在 `acquireStateRootLock` 失败时统一报 `ADMIN_TARGET_NOT_STOPPED`（`memory-command.ts:46-48`），会掩盖权限/锁文件损坏等原因；与现有 `db.migrate` 的写法一致，属既有模式。
- **资源耗尽：** `restoreIdleArchivesAndClearMemoryIndex` 用 `.all()` 一次性把全部待恢复归档读进内存（`sqlite-memory-maintenance.ts:53-58`），个人规模没问题，但没有分页/上限；`maskForIndex` 对每个不同值做一次 `split/join`，内存正文很长且识别值很多时是 O(值数×文本长度)，当前没有上限。均为低。
- **不可撤销操作：** 清空 `memory_search_index` 可重建（触发器和启动重建逻辑都在，`0052_memory_engine.sql:42-45`、`service-main.ts:1183-1199`）；恢复归档不会改动内容，可人工重新归档；没有真正不可逆的危险操作。命令的 `--confirm` 需要精确输入 `REINDEX_MEMORY_<agentId>`，设计合理。
- **规则/文档一致：** `.claude/rules/prompt-prefix.md` 的规则 1–5 未被本改动破坏（见必答 1）；ADR 0196 与代码存在第 3 条的措辞偏差和第 4 条的账本差异。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本改动只改：全文索引内容（`indexableTerms`）、敏感记忆实体是否存储、以及一次性恢复归档/重建索引；没有改系统提示、工具定义、历史消息或出口遮盖的实现。检索到的记忆/实体是作为本轮的上下文块或工具结果**追加到最后一条消息**，符合规则 1–3（固定在前、会变的在后、只追加）；已有门槛 `packages/runtime-pi/test/prompt-prefix.compat.test.ts:431` 的 `[RULE-memory-visible]` 用例明确验证“敏感记忆和敏感检索结果在后续轮次只追加、不改已发内容”。本 diff 也没有触发 ADR 0193 的“老对话敏感历史一次性出现在历史中间”例外（这里恢复的是记忆记录，不是历史消息）。依据：`.claude/rules/prompt-prefix.md` 第 1–5 条。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**就本改动而言不会。** `maskForIndex` 只依赖传入的文本和固定的规则常量，`findSensitiveValues` 本次没有传 `known`/`trusted`，不依赖后续消息；值集合用 `Set` 后按长度降序排序，等长时依赖插入顺序（JavaScript 排序稳定，`findSensitiveValues` 的规则顺序固定），因此是确定的。没有时间字段、没有无序集合、没有跨消息上下文。唯一需要注意的是：`maskForIndex` 内部使用全局 `EGRESS_RULESET_CURRENT` 常量（`redaction.ts:54`）和 `Intl.Segmenter`（Node ICU 版本），跨安装包/运行时会不同；但那影响的是**重建后的索引**，且检索结果是追加在末尾，不会改写已发历史或系统提示。出口遮盖本身未被本改动触碰，历史里已存内容的遮盖字节不变。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？

**有，且反向用例按代码推断会失败（未实际运行）。**
- `packages/sensitive-capture/test/secret-like.unit.test.ts:34-47`：直接断言重复密码（`sunflower`）、`hunter22`、带分隔符长串、卡号尾号。去掉重复值处理 → `sunflower` 断言失败；去掉整串检查 → `abcd/uvwx` 断言失败；去掉遮盖 → 卡号/`hunter22` 相关断言失败。
- `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:110-137`：词表里不得出现 `sunflower|hunter|…|13800138000`，同时要保留 `青霉素/过敏/纸条/2026`。
- `test/integration/memory-consolidation.test.ts:516-525`：敏感记忆按词 `青霉素` 可查、`x9Kq2mVb7Lp4Wz` 不可查、实体可读回；`apps/agent-service/test/production-memory-evidence.unit.test.ts:26-84`：实体过滤的成功/失败两侧。
- `apps/admin-cli/test/memory-reindex-cli.unit.test.ts:203` 及新增的 `memory-undone-archived-again`：先报数、不确认不改、只恢复未被改过且未撤销的闲置归档、不动 merge、清空索引、重跑恢复 0 条。

**缺口：** 现有用例没有覆盖本报告的问题 1（第一次命中的值带 `。`/引号/邻接中文导致第二次裸值漏删）、问题 2（短值误删正常词、占位文字尾号被吃）和 ISO 时间戳。也就是说“反向用例会失败”对作者声称的三条成立，但对我发现的这两个边界不成立。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对结果：
- `looksLikeSecretToken(word): boolean` → `maskForIndex`（`secret-like.ts:27`）和 `indexableTerms` 的 `.filter`（`segmentation.ts:115`），两处只当布尔用，接受。
- `maskForIndex(text): string` → `indexableTerms`（`segmentation.ts:115` 再交给 `indexTerms`）和 `isSafeToIndex`（`secret-like.ts:31`），接受。
- `indexableTerms(text): string[]` → `HybridMemoryProvider.upsert` 的 `terms`（`hybrid-memory-provider.ts:86`）和 `MemoryEpisodeService.#record` 的 `terms`（`episodes.ts:366`）；存储层校验 `terms.length <= 512` 且每项长度 ≤64（`sqlite-memory-operations.ts:1207-1208`），`indexTerms` 的 `slice(0,512)` 和 `segmentWords` 的 64 长度上限能保证，接受。
- `isSafeToIndex(entity): boolean` → 实体过滤（`production-memory-capture.ts:373`），接受。
- `MODEL_VISIBLE_CLASSIFICATIONS = {public,private,sensitive}` → `sqlite-memory-operations.ts:811,1022,1261` 三处，值都在 `CLASSIFICATIONS` 内，接受。
- reindex 的 `MemoryReindexPlan`/`MemoryReindexResult` 字段 → `apps/admin-cli/src/memory-command.ts:58-77` 只读并输出，字段名和 `planMemoryReindex`/`restoreIdleArchivesAndClearMemoryIndex` 一致，接受；输出没有额外的契约校验，`runAdminCli` 只做 `JSON.stringify`。
- 新增依赖 `memory-engine → sensitive-capture` 已同时写进 `packages/memory-engine/package.json`、`package-lock.json` 和 `scripts/boundary-policy.mjs:41`，与包边界检查一致（未运行构建验证）。
- 唯一“两端不完全一致”的是问题 4：`memory_consolidation_changes.undone_at` 的生产者（维护命令）与正常消费者 `markUndone` 的语义不完全相同（少了 `decision_ledger` 更新），但这是 ADR 明示的取舍，需要文档写清。
