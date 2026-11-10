# PR 334 第 3 轮复核

## 一、读代码证实的发现（按严重度）

### 1. 高：任意普通方括号都被当成“遮盖占位”，括号里的秘密整段跳过

- 文件：`packages/sensitive-capture/src/secret-like.ts:18`、`:41-47`、`:51-53`
- 问题：判断占位用的正则是 `/(\[[^[\]]*\])/u`，它匹配的是**任意** ASCII 方括号对，而不是 `maskSensitiveText` 产出的占位。`split` 后奇数段原样返回（`:44`），因此括号内的内容既不过 `patterns`，也不过 `TOKEN_RUN` 兜底。
- 证据：

```ts
const PLACEHOLDER = /(\[[^[\]]*\])/u;            // :18
...
.split(PLACEHOLDER)
.map((part, index) => {
  if (index % 2 === 1) return part;              // :43-44 奇数段直接返回
  const cleared = patterns.reduce(...)           // :45
  return cleared.replace(TOKEN_RUN, ...)         // :46
})
```

后果（由代码逻辑直接推出）：
  - `maskForIndex("备注 [x9Kq2mVb7Lp4Wz]")` 中 `x9Kq2mVb7Lp4Wz` 规则认不出（`machine-secrets.ts` 的规则都不匹配它），本该靠 `TOKEN_RUN` 兜底删掉，但它在方括号段里，原样进入明文词表。
  - 重复值同样中招：`Wi-Fi 密码：sunflower，备注[写 sunflower 的纸]`，第一次出现的 `sunflower` 被 `maskSensitiveText` 遮住，方括号里那次因跳过而留存。
  - 因为 `[^[\]]*` 允许换行，正文里一个落单的 `[` 和后面较远的 `]` 会把中间一大段都排除在遮盖和兜底之外。
  - `isSafeToIndex` 就是 `maskForIndex(text) === text`（`:51-53`），所以 `isSafeToIndex("[hunter2x]")` 会返回 `true`，`production-memory-capture.ts:369-374` 的实体过滤会把 `[hunter2x]` 放进明文的 `memory_entities`。
- 文档不一致：ADR `docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:55` 写的是“遮盖留下的方括号占位（例如“[银行卡 尾号1111]”）里面不动”，但代码实际豁免所有方括号，不只是遮盖占位。
- 建议：按真实占位切分，例如 `\[(?:密码|验证码|证件号|银行卡 尾号\d{4})(?:#[a-z]{8})?\]|\[密钥\]`；或者括号内容也照常过 `TOKEN_RUN`，只对 `尾号\d{4}` 这种明确情形做保留。补反向用例：普通方括号里的 `x9Kq2mVb7Lp4Wz`、方括号里的重复 `sunflower`、以及 `isSafeToIndex("[hunter2x]") === false`。

### 2. 中：切段只取首段和末段，中间段仍会漏

- 文件：`packages/sensitive-capture/src/secret-like.ts:21-24`
- 问题：`bareForms` 只返回原值、第一段、最后一段；中间段不参与删除。
- 证据：

```ts
function bareForms(value: string): readonly string[] {
  const pieces = value.split(VALUE_SEPARATOR).filter((piece) => piece.length > 0);
  return [value, pieces[0] ?? "", pieces.at(-1) ?? ""];   // :23 只取首末
}
```

构造例（按代码推演）：`密码是aaa。sunflower。bbb，后面单独写 sunflower` 里 `findSensitiveValues` 给出的值是 `aaa。sunflower。bbb`，`bareForms` 得到 `[整段, "aaa", "bbb"]`，中间的 `sunflower` 不在 `patterns` 里；后面单独的 `sunflower` 是纯字母，`TOKEN_RUN` 也兜不住，于是留在词表里。这直接回答了作者的问题：会漏掉值中间段。
- 建议：把所有长度达标的段都纳入（至少所有含字母/数字的段），并补“秘密在值中间”的用例。

### 3. 中：分隔符集合不全，“中英文标点”的说法与实现不符，省略号等粘连时仍漏

- 文件：`packages/sensitive-capture/src/secret-like.ts:17`；ADR 同句在 `:55`
- 证据：

```ts
const VALUE_SEPARATOR = /[\s=:：＝,，;；.。!！?？、"'“”‘’()（）【】「」]+/u;   // :17
```

缺 `…`、`/`、`\`、`|`、`《》`、`〈〉`、`…`、`#&*+@%$^~` 等。构造例：`密码是sunflower…后来单独写 sunflower` 中，`PASSWORD_ASSIGNMENT` 的值是 `sunflower…后来单独写`（`…` 不在分隔符里），`bareForms` 只有整段一个 pattern，匹配不到后面单独的 `sunflower`；纯字母密码 `TOKEN_RUN` 也兜不住。
- 建议：补齐常用中文标点（至少 `…`、`《》`），或按 Unicode 标点类别处理，但要避开 `-`/`_` 这类密钥内部字符并补测试。

### 4. 低：末段常常是正常后文，会被全局删掉，影响按词检索

- 文件：`packages/sensitive-capture/src/secret-like.ts:21-24`、`:45`
- 证据：本轮新用例自己的输入就是例子：`packages/sensitive-capture/test/secret-like.unit.test.ts:50`
  `"Wi-Fi 密码是sunflower。客人来了就告诉他 sunflower"`。规则给出的值是 `sunflower。客人来了就告诉他`，末段 `客人来了就告诉他` 有 8 个字符，会被当成待删值，从全文任何出现处删掉。中文常常没有空格，末段可能是一大段正常后文，导致词表召回明显变差。用例只断言 `not.toContain("sunflower")`，没有断言正常后文保留。
- 建议：给裸值加长度上限，或只删除“看起来仍像凭据”的段（含数字/字母混排、或以分隔符结尾的短段）；补一条“后文正常词仍可检索”的用例。

### 5. 低：新增的安全边界没有对应自动检查

- 文件：`packages/sensitive-capture/test/secret-like.unit.test.ts:49-62`
- 问题：新用例只覆盖真实占位 `[验证码]`/`[银行卡 尾号1111]`，没有覆盖正文普通方括号、值中间段、`…` 粘连这几条路径；因此上面的问题 1、2、3 都不会被现有门槛拦下。ADR `:91` 声称“去掉切段、去掉整词匹配、去掉占位跳过，各自至少有一条新用例失败”，这只对作者列出的三种机制成立，未覆盖“把占位正则收窄成真实占位”这一反向。
- 建议：按上面各条补反向用例。

## 二、推测（未运行测试，仅按代码推演）

- 作者声称的反向用例（去掉切段/整词匹配/占位跳过各自失败）从逻辑上看成立：`test:50` 依赖切段，`test:60` 依赖整词，`test:57` 依赖占位跳过。但本轮没有实际执行 `vitest`，标为推测。
- 作者声称的 fast-mode 17 文件 288 条通过、typecheck、biome、docs 校验，未核实。

## 三、侧重检查

- **不可信输入/安全**：记忆正文和模型返回的 `entities` 都可能不可信。前者经 `maskForIndex` 进明文 FTS，后者经 `isSafeToIndex` 进明文 `memory_entities`。重点发现是方括号绕过（问题 1），会把规则认不出、本应由 `TOKEN_RUN` 兜底的秘密写进明文表；重复值删除也受同一处影响。
- **错误路径**：`apps/admin-cli/src/memory-command.ts` 的 `acquireStateRootLock(...).catch(() => throw TARGET_NOT_STOPPED)` 把所有加锁错误都报成“服务未停止”，路径错误、权限错误也会误导运维；只是提示不准确，无数据风险。
- **不可撤销操作**：`memory reindex` 在 `--confirm` 前只做 `planMemoryReindex`（纯 SELECT），确认后才在事务里恢复归档并清空可重建的索引；有 lock、有版本号守卫（`sqlite-memory-maintenance.ts` 的 `WHERE ... revision = ? AND status = 'archived'`），没有发现不可逆破坏。
- **资源耗尽**：`wholeWordPattern` 用转义后的字面量拼正则，没有回溯放大；`patterns.reduce` 对每段文本线性扫描，长度有界，未发现 ReDoS 或明显资源问题。
- **文档/代码一致性**：
  - ADR `:55` 的“只豁免遮盖占位”与代码“豁免所有方括号”不一致（问题 1）。
  - ADR `:59` 的实体范围（只指 `attributes.entities`，人物名进 `memory_people`）与代码一致；`production-memory-control.ts:745`、`production-reminder-writer.ts:229`、`consolidation.ts:542` 确实都写空实体。
  - ADR `:64` 的 `strict-configuration.ts:1281` 已核对，确为“必须且只有一个 embedding”的抛错行。
  - ADR `:66` 的“恢复不写主人评价”与代码一致：`sqlite-memory-maintenance.ts` 只更新 `memory_consolidation_changes.undone_at`，不像正常撤销路径 `sqlite-memory-consolidation-operations.ts:344-350` 那样写 `decision_ledger.owner_rating='unneeded'`；但该关系没有测试断言。

## 四、必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改了 `packages/sensitive-capture/src/secret-like.ts`（只在建索引时调用）、`secret-like.unit.test.ts` 和 ADR。`maskForIndex` 的调用方是 `packages/memory-engine/src/segmentation.ts:114-116`（索引词）与 `production-memory-capture.ts:373`（写入 `attributes.entities` 前的过滤），都不在系统提示、工具定义、历史消息或出口遮盖的组装路径上。因此发给模型的内容仍只在末尾追加，会变的本轮记忆仍应走最后一条消息（该注入机制本次未被改动，标未核实其实现细节）。唯一间接影响是 sensitive 记忆变得可检索，但那是追加的检索上下文，不是请求开头。

2. **对同一输入是确定的，但 `maskForIndex` 本身依赖整段文本。** `new Set(...)` 去重、只按长度排序（ES2019 起稳定排序），没有时间字段或无序集合影响结果；同一段记忆内容每次重算字节相同。需要注意的是：同一段裸文字放进不同文档时，是否被遮取决于该文档里有没有关键词/前后文（`findSensitiveValues` 是按整段文本收集值），这属于“上下文相关遮盖”。但它只作用于索引，不进入模型请求，所以不会造成“同一对话请求开头字节漂移”。

3. **有自动检查，但覆盖不全。** 有 `secret-like.unit.test.ts`、`hybrid-memory-provider.unit.test.ts`、`production-memory-evidence.unit.test.ts` 及若干集成测试；作者所述三个反向机制按逻辑应失败（推测，未运行）。但普通方括号绕过、值中间段、`…` 粘连没有用例，问题 1 这条高危路径不会被门槛拦住；`memory reindex` 的“恢复后账本无评价”也没有断言。测试未实际运行，标未核实。

4. **逐个核对产生/使用两端：**
   - `maskForIndex` → `indexableTerms` → `memory_search_terms` / `memory_episode_terms`：后端 `sqlite-memory-operations.ts:977,1207` 校验词数 ≤512、词长由 `segmentation.ts:84,91` 限 64；分类门槛已改为 `MODEL_VISIBLE_CLASSIFICATIONS`（含 sensitive），两端一致，能接受。
   - `isSafeToIndex` → `production-memory-capture.ts:369-374` 实体过滤：后端 `assertMemoryShape`（`sqlite-memory-operations.ts:617-625`）只校验 NFKC 后长度 1–64，不重做安全校验；长度两端一致，但方括号绕过让安全这一端的校验实际失效（问题 1）。
   - `MODEL_VISIBLE_CLASSIFICATIONS`（`sqlite-memory-operations.ts:148`）与 `application/services/model-visibility.ts:24` 的 `isModelVisible` 当前取值一致，但存了两份定义，后续有漂移风险（低）。
   - `REINDEX_MEMORY_<agentId>` 确认串只在 `memory-command.ts` 内产生和比较，值来自配置 `agentId`；`--operator` 有正则约束，CLI 测试覆盖确认/拒绝两条路径，能接受。
   - ADR 的行号/实体范围/账本描述已逐条核对：`:64` 正确，`:59` 正确，`:66` 与代码一致但未被测试覆盖；`:55` 的占位描述与代码不一致（问题 1）。
   - i18n 键 `memory.page.archivedNote` 未改名、只改中文文案，与“停掉闲置归档”一致；英/日文案仍为通用“整理时归档”，不算冲突。

**结论**：本轮修掉了“带后文的值删不到”“contest 误删”“卡号占位尾号误删”三个问题，但引入了一个更严重的安全回归——把任意普通方括号当成占位，使规则认不出的秘密可以整段避开 `TOKEN_RUN` 兜底进入明文词表/实体表。建议至少先修问题 1（收窄占位正则并补反向用例），再处理中间段与分隔符漏删。
