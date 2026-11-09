## 发现的问题

### 中：方括号重认会把“密码关键词 + 分隔符 + 方括号注释”里的普通文字当成密码值，并从整条记忆的词表里全局删掉

**文件:行**：`packages/sensitive-capture/src/secret-like.ts:39-49`

**问题**：第二次识别把原文的 `[`、`]` 换成空格后，再跑一遍 `findSensitiveValues`。这确实能认出 `密码是[sunflower]`，但也会把“`密码：` + `[普通说明]`”误认成密码赋值：`maskSensitiveText` 因 `(?!\[)` 跳过它，第二次识别却把方括号里的第一个词当成值。随后 `wholeWordPattern` 在全文做全局替换，这个词在非方括号位置出现时也会被删掉。

**证据（读代码证实）**：

```ts
// secret-like.ts:39
[...findSensitiveValues(text), ...findSensitiveValues(text.replace(SQUARE_BRACKET, " "))]
// secret-like.ts:41
.filter((value) => value.length >= SHORTEST_REMEMBERED_VALUE),
// secret-like.ts:49
const cleared = patterns.reduce((current, pattern) => current.replace(pattern, " "), part);
```

`redaction.ts:77` 的密码值允许中文：

```ts
const PASSWORD_VALUE = "[^\\s,，;；]";
```

`redaction.ts:80` 的严格密码规则正好被紧跟的 `[` 挡住：

```ts
`((?:${PASSWORD_KEYWORDS})\\s*(?:[:：=＝]|是|为|為|は)\\s*)(?!\\[)(${PASSWORD_VALUE}+)`
```

按代码推演：`maskForIndex("密码：[由系统自动生成]")` 第一次识别被 `(?!\[)` 挡住；第二次在 `"密码： 由系统自动生成 "` 上取到值 `"由系统自动生成"`（长度 7），再在原文中全局删掉。类似地，`"password: [reset required]"` 会把 `reset` 当成密码值并在全文删除 `reset`。这不是新泄漏，但会让正常词按词搜不到，且本轮没有负向用例覆盖。ADR 只写了“正文里普通的方括号照常检查”，没写“方括号里的普通词会被当成密码值并全局删除”。

**建议**：至少补一条负向用例（例如断言 `maskForIndex("密码：[由系统自动生成]")` 仍包含 `由系统自动生成`）；如果认为这是可接受代价，在 ADR 0196 明说“密码关键词后紧跟方括号时，方括号内第一个词会被当值并全局去掉”。

---

### 低：ADR 说“值里的中文后文不取”，但原值本身带着中文后文一起被全局删掉

**文件:行**：`docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:55`

**问题**：ADR 写“值里的中文后文不取，免得把正常的话从词表里删掉”，但代码既取“每一段”，也取完整原值：

```ts
// secret-like.ts:27
return [value, ...pieces];
```

`findSensitiveValues` 返回的原值可以带中文后文（ADR 同段自己也举例 `sunflower。客人来了`），这个完整原值长度够 4 就被 `secret-like.ts:41` 保留，并被 `:49` 当作全局删除模式。因此重复出现时，中文后文也会被删。

**证据（读代码证实）**：对 `密码是sunflower。客人来了 备注 sunflower。客人来了`：

1. 第一次识别值 `sunflower。客人来了`；
2. `maskSensitiveText` 把第一处换成 `[密码]`，剩下 ` 备注 sunflower。客人来了`；
3. 完整原值模式在剩余部分匹配 `sunflower。客人来了`，把第二处的中文 `客人来了` 一并删掉。

所以“中文后文不取”只对**额外取出的段**成立，对完整原值不成立。

**建议**：改成“从值里额外取出的段只取英文数字串，不含中文；但完整原值（可能含中文后文）重复出现时仍会整段去掉”，或者调整代码只保留纯 ASCII 原值并补测试说明取舍。

---

### 低：新增的“中文后文”用例不是本轮改动的回归用例，ADR 的反向用例清单也漏了本轮这一步

**文件:行**：`packages/sensitive-capture/test/secret-like.unit.test.ts:58`、`docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:91`

**问题**：

- 第 58 行输入 `密码是sunflower。客人来了 后来客人来了` 不含方括号，第二次识别与第一次完全相同，因此该用例在上一版 `925ada02`（没有第二次识别）上也会通过，不是本轮改动的回归用例；它也没有断言“值里的中文后文保留”，只断言了另一个更晚的句子 `后来客人来了` 还在。
- ADR 第 91 行列出的反向用例是“去掉遮盖、去掉重复值处理、去掉取段、去掉整词匹配、把占位放宽成任意方括号、去掉整串检查”，没有列出本轮新增的“去掉方括号重认”。提交说明里却声称“去掉方括号重认一步……有一条用例失败”。

**证据（读代码证实）**：`git show 925ada02be3c7e4940e8456cda1cd008f4b61df4:packages/sensitive-capture/src/secret-like.ts` 显示旧版没有 `SQUARE_BRACKET`，而第 58 行输入没有方括号，输出路径完全一致。第 80、81 行才真正依赖第二次识别：按代码推演，去掉第二次识别后 `sunflower` 不会被识别、`hunter2` 也不满足 `looksLikeSecretToken`（7 个字符、无 6 位纯数字），两条都会失败。

**建议**：把“去掉方括号重认”补进 ADR 第 91 行的反向清单；如确实想验证值内中文后文，补一条能区分完整原值与“取段”的断言，而不是只断言更晚的独立句子。

---

## 侧重检查

- **不合规范/不可信输入**：第二次识别只把 `[`、`]` 换成等长空格，不改变长度；`findSensitiveValues` 的观测值非空，`bareForms` 取段后还有 `length >= 4` 过滤，不会出现空字符串模式导致全文插空格。已确认 `isSafeToIndex` 的调用点在 `production-memory-capture.ts:373`，先判 `entity.length > 0 && <= 64` 再调用，不会把空串传进去。**读代码证实**。
- **安全**：本改动只让词表删得更多，不会让原本被遮的秘密重新进词表，出口遮盖 `redaction.ts` 在两次 diff 中均未改动。反向缺口是方括号内带空格或短于 4 字符的值仍不会被识别，例如 `密码是[sun flower]`、`密码是[abc]`；这是既有 4 字符下限和按空白切值的取舍，不是本轮新增泄漏。**读代码证实（行为），未运行验证**。
- **资源耗尽**：`maskForIndex` 对每段文本多跑一次完整出口遮盖；没有方括号时两次输入相同，属于纯重复计算。记忆建索引是后台每秒一条，文本长度没有放大，未发现无界增长，但长事件段会多一次正则扫描。**推测：实际耗时影响未测量**。
- **不可撤销操作**：`apps/admin-cli/src/memory-command.ts:48-49` 把获取锁的任何异常统一映射为 `ADMIN_TARGET_NOT_STOPPED`；用 `grep` 核对到 `thread-command.ts:69`、`sandbox-command.ts:92`、`index.ts:332` 也是同样写法，作者说法基本成立。`initialize-command.ts:46` 没有包一层，是例外。`finally` 里 `await lock.release()` 若失败会覆盖已成功的命令结果，操作员重跑会再清一次索引（多一次嵌入费用）；这是既有模式，本轮未改，**未核实实际触发条件**。
- **规则文件/文档一致性**：`prompt-prefix.md` 第 4、11 条和 `docs/kv-cache-guide.md` 未涉及词表索引；ADR 0196 的代码行为描述除上面两处外与代码一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本增量只改 `packages/sensitive-capture/src/secret-like.ts`、对应单测和 ADR；`maskForIndex` 只被 `segmentation.ts:115` 的 `indexableTerms` 使用，后者只进入记忆/事件段的词表（`hybrid-memory-provider.ts:86`、`episodes.ts:366`），不进入系统提示或工具定义。`isSafeToIndex` 只在记忆提取时过滤 `attributes.entities`（`production-memory-capture.ts:373`）。这些结果最多改变本轮检索到的记忆内容，而检索结果按规则应追加在最后一条用户消息里（`.claude/rules/prompt-prefix.md:27-36`）；没有改动系统提示、工具定义、历史消息或出口遮盖字节。**读代码证实**。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会因本轮改动而变。第二次识别只依赖当前文本（`text.replace(SQUARE_BRACKET, " ")`），`Set` 的插入顺序来自确定的正则匹配顺序，`sort` 只按长度且同长度值的相对顺序由确定的插入顺序决定；没有时间、随机数、数据库返回顺序或前后文参与。等长模式即使相互重叠，顺序在同一文本上也固定。**读代码证实**。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`secret-like.unit.test.ts:80-81` 直接覆盖本轮修复。按代码推演，去掉第二次 `findSensitiveValues` 后这两条都会失败（`sunflower` 不被识别、`hunter2` 不满足 `looksLikeSecretToken`）。但 `:58` 的新用例不是本轮回归用例（无方括号，旧代码同样通过），也没有针对“第二次识别误删普通方括号文字”的负向用例。ADR 第 91 行反向清单未列入方括号重认这一步。测试未实际运行（工具限制），以上为按代码推演。**读代码证实/未运行**。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   本增量产生的值只有 `maskForIndex` 内部的 `values`/`patterns` 和返回值，没有新增标识、配置键或序列化格式。返回值的使用方有两处：`indexableTerms` 的两个调用点都只接受 `string[]`；`isSafeToIndex` 只用于实体过滤，调用前已校验非空且不超过 64 字符，没有类似 I-73 的“清单 id 过不了后端校验”问题。ADR 第 91 行列出的测试名和 `[RULE-memory-visible]` 用例我都逐个找到对应文件；但反向用例的完整清单没有同步本轮新增步骤（见上），属于文档清单与代码测试的偏差，不是校验两端不兼容。**读代码证实**。

**未核实**：第 4 轮复核记录文件（`.agents/reviews/pr-334/round-4/*`）因仓库记录路径限制读不到，无法核对第 4 轮原文措辞；只核对了 `925ada02..6d8f7403` 的实际代码增量。
