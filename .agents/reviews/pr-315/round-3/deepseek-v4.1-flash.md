## 复核结论（PR 315 第 3 轮）

### 高｜已发历史会被重新遮盖，请求开头会变一次

- 文件:行：`packages/sensitive-capture/src/redaction.ts:339-353`；`packages/application/src/services/model-egress.ts:219-226`、`:129`；`.claude/rules/prompt-prefix.md:35`、`:84`；`docs/adr/0188-recognize-passwords-without-a-separator.md:54`
- 问题：新规则不是只作用于新消息。出口遮盖每次请求都会对**整段历史**重新跑 `redactForEgress`，所以升级后，凡是历史里“刚好符合新写法”的文字，第一次重发时会被遮成和以前不同的字节，请求开头改变、缓存整段重算。ADR 0188 已如实写明这一点，但规则第 4 条要求“已经发给过模型的内容不得改动”，第 8 条要求“会变就停下来出方案，Andy 同意才动工”。材料里只看到 ADR 记录，没有看到 Andy 对这次缓存失效的同意记录。
- 证据：
  - `redaction.ts:339-353` 的新规则在每次 `redactForEgress` 调用里无条件执行；
  - `model-egress.ts:219-226` 对每个字符串重新调用 `redactedOrRefused(value, {...known...})`；
  - `prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；
  - `prompt-prefix.md:84`：“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工”；
  - `0188:54`：“已经发出过的历史里，如果有刚好符合新写法的文字，这些文字从此会被遮盖，所以这样的对话请求开头会变一次（缓存整段重算一次）”。
- 建议：把这次“一次性缓存失效”的批准记录补进 ADR/PR；如果尚未批准，应停下等待确认。另注意：同一个值如果以前被识别成验证码、现在先被密码规则命中，占位符的 kind 也会变（`[验证码#…]` → `[密码#…]`），这同样会改字节，ADR 只写了“这些文字会被遮盖”，没有覆盖这种“已遮但改类”的情况。

### 中｜混合值只遮 ASCII 前缀，后半段原样外发（ADR 已披露）

- 文件:行：`packages/sensitive-capture/src/redaction.ts:80`、`:348-352`；`docs/adr/0188-recognize-passwords-without-a-separator.md:46`
- 问题：`PASSWORD_LOOSE_VALUE` 是 `[^\s,;\[\]\u0080-\u{10FFFF}]`，遇到第一个非 ASCII 字符就停止。`密码设为 abc12345中文DEF456` 会变成 `密码设为 [密码]中文DEF456`，后面仍可能是口令的一部分。作者说法与 ADR 一致，代码确实如此；但这是实际外发风险。
- 证据：
  - `redaction.ts:80`：`const PASSWORD_LOOSE_VALUE = "[^\\s,;\\[\\]\\u0080-\\u{10FFFF}]";`
  - `redaction.ts:348-352`：`const value = raw.replace(PASSWORD_TRAILING_PUNCTUATION, ""); ... maskPassword(lead, value)`
  - `0188:46`：“只遮到第一个非 ASCII 字符之前……后面的部分会原样外发”
- 建议：既然值已经和中文紧贴、中间没有分隔符，可以按真正的分隔符（空白、逗号、分号）截断，而不是按第一个非 ASCII 字符截断；至少补一个测试，明确 `密码设为 abc12345中文DEF456` 的期望，避免以后误以为后缀也会被遮。

### 中｜前导引号回溯进值里，短值被误遮且与 ADR 不符

- 文件:行：`packages/sensitive-capture/src/redaction.ts:82`、`:85-92`、`:348-352`；`docs/adr/0188-recognize-passwords-without-a-separator.md:34-37`
- 问题：`PASSWORD_VALUE_OPENING = ["'(]*` 在词法规则里是可回溯的。当前导引号让值达到正则的 `{4,}`/`{6,}`、但去掉引号后不够长时，正则会把引号退回到值分组里，随后 `PASSWORD_TRAILING_PUNCTUATION` 只剥尾部标点、不剥头部，于是引号被计入长度并被一起遮掉。举例：`password is "a12`（没有右引号）会被遮成 `password is [密码]`，实际值 `a12` 只有 3 个字符，按 ADR“去掉前后标点后再数、带词规则 4”不该遮；同时前导引号没有“归入前导文字原样保留”。裸规则同理：`密码 'abc12` 会把 5 字符的 `abc12` 当成 6 字符遮掉。
- 证据：
  - `redaction.ts:82`：`const PASSWORD_VALUE_OPENING = `["'(]*`;`
  - `redaction.ts:85-92`：`...${PASSWORD_VALUE_OPENING})(?=...)(...)`，`PASSWORD_VALUE_OPENING` 在捕获组内、后接可回溯的 lookahead 和值分组；
  - `redaction.ts:349-351`：`const value = raw.replace(PASSWORD_TRAILING_PUNCTUATION, ""); if (value.length < minimumLength ...) return match;`
  - `0188:34-37`：“值前面的引号、左括号……都不算在值里”“去掉前后标点后再数”。
- 建议：在长度判断前，把值开头的 `["'(]+` 也剥掉（并相应把它并回 `lead`），或者在正则里用原子组/前瞻阻止回溯进 `PASSWORD_VALUE_OPENING`；补反向用例 `password is "a12`、`密码 'abc12`，期望原样不动。

### 低｜重定向排除 `\d*[<>]\S*` 范围过宽，可能放过真实值

- 文件:行：`packages/sensitive-capture/src/redaction.ts:97`
- 问题：`\d*[<>]\S*` 不只匹配 `2>/dev/null`，也匹配任何“开头是若干数字、后面含 `<` 或 `>`”的值。例如 `password is 12<34`、`2<secret9` 都会被当成重定向而不遮。虽然罕见，但这是安全方向的假阴性。
- 证据：`redaction.ts:97`：`...|\/\S*|\d*[<>]\S*)$/iu`
- 建议：把重定向限定为真正的 shell 形式（例如 `^[0-9]?[<>]`、`^2>&`、`^<`），不要用“数字后任意位置出现 `<`/`>`”概括；补一个“像重定向的密码仍要遮”的正向/反向用例。

### 低｜新反向用例有两条并不是真的反向

- 文件:行：`packages/sensitive-capture/test/redaction.unit.test.ts:327-333`、`:100`、`:90`
- 问题：
  1. “keeps the bytes of earlier text when a later message is added”追加的第三条 `"好的，谢谢"` 不含任何密码或值；而且它把三条消息拼成一个字符串调用一次。即使实现真的会向后看，只要后文没有值，这个测试也会通过。它验证不了它名字里的“追加新消息不改变旧消息”。
  2. `"pwd\n/home/user1/project"` 即使允许跨行匹配，值 `/home/user1/project` 也会因为 `/\S*` 路径排除而不遮，所以这条测试验证不了“不跨行”。
  3. `"密码管理器 1Password 很好用"` 即使去掉 ASCII 边界，`1Password` 后面的值也是非 ASCII（很好用），不会命中；真正测边界的是 `"1Password hunter22abc"` 和 `"notpassword abc12345"`。
- 证据：
  - `test:327-333`：`const lines = ["我们聊聊家里的网络", "Wi-Fi 密码 abc12345", "好的，谢谢"]; ... expect(all.startsWith(earlier)).toBe(true);`
  - `test:100`：`"pwd\n/home/user1/project"`
  - `test:90`：`"密码管理器 1Password 很好用"`
- 建议：追加一条真的重复前面已点名值的消息，并按生产路径“每条消息一次、共享 `known`”调用；跨行用例改成 `pwd\nabc12345`（不触发路径排除）；边界用 `1Password hunter22abc`/`notpassword abc12345` 已足够，可删除无效的那条。

### 低｜ADR 的“字母”边界与代码的 ASCII 边界不一致

- 文件:行：`packages/sensitive-capture/src/redaction.ts:68-71`、`:81`；`docs/adr/0188-recognize-passwords-without-a-separator.md:32`
- 问题：ADR 说英文关键词“前面不能紧挨字母、数字或下划线”，代码只排除了 `[A-Za-z0-9_]`。因此 `网络password abc12345`、`αpassword abc12345` 这类“非 ASCII 字母 + 英文关键词”仍会命中。方向上只是多遮，不是漏遮，但文档与代码不一致。
- 证据：
  - `redaction.ts:81`：`(?<![A-Za-z0-9_])(?:${PASSWORD_ASCII_KEYWORDS})`
  - `0188:32`：“英文关键词……前面不能紧挨字母、数字或下划线”
- 建议：要么把 lookbehind 改为 `(?<![\p{L}\p{N}_])`（中日韩关键词走另一分支，不受影响），要么把 ADR 改成“ASCII 字母、数字或下划线”。

---

## 侧重检查

- **错误路径/不可信输入**：新正则都由常量拼接，模块加载时编译；值字符类限定 ASCII 且排除 `[`/`]`，已有的 `[密码#…]` 占位符不会被当作值吞掉（`redaction.ts:80-92`）。即使日志/邮件正文被投毒，规则没有新增抛错路径；`observe` 抛错仍被 `try/catch` 吞掉（`redaction.ts:295-302`）。
- **资源耗尽**：检查了新增的两条全局正则。`PASSWORD_LOOSE_VALUE*` 的 lookahead 是单字符类线性回溯，后面 `{4,}`/`{6,}` 也是线性；没有发现嵌套量词造成的灾难性回溯。未运行压力测试，标记为“读代码判断”。
- **安全**：新规则只做遮盖，不改内部存储、不做不可撤销操作。已确认混合值后缀、无数字值、`<>` 过度排除三处假阴性；其中前两处 ADR 已写明，第三处未写明。
- **占位符保护**：确认 `PASSWORD_VALUE_OPENING` 不含 `[`，`PASSWORD_LOOSE_VALUE` 排除 `[`/`]`；关键词即使匹配到占位符里的“密码”，后面紧跟 `#`/`]`，不满足空白/连接词，不会再匹配。
- **跨边界消费（I-73 视角）**：没有新增标识、字段、配置键或清单项；仍复用 `password-keyword` rule id 和 `password` kind。`ruleId` 落库时只要求 `boundedText(item.ruleId, 128)`（`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:52`），`category` 已有 password，i18n 也已有 `sensitive.category.password`；占位符格式 `[密码#…]` 未变；`restorePlaceholders`/`placeholderTable`、`ModelEgress.restore`、`external.ts` 都把值当不透明字符串处理，没有发现“产生端/使用端校验不一致”。唯一值得注意的值形态变化是密码值可能内部带引号/反斜杠，JSON 嵌入路径由 `jsonEmbedded` 处理，未发现致命问题。
- **规则文件/文档一致性**：ADR 0188 的“混合值只遮 ASCII 前缀”“关键词表不变”“引号/括号处理”与代码基本一致；不一致见上面“回溯短值”和“字母边界”两条。ADR 0166/0185 指向 0188 的补充说明准确。
- **未核实**：无法运行 vitest/CI（工具限制）；`.agents/reviews/pr-315` 在稀疏检出中不可读；无法确认 Andy 是否已同意“一次性缓存失效”；正则回溯结论是按 ECMAScript 语义读代码推演，未实际执行。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- **系统提示/工具定义**：新规则本身没有往系统提示或工具定义里加任何逐轮变化的值；工具定义在 `model-egress.ts:394`、`:470-477` 被 `DEFINITION_KEYS` 整体跳过，字节不受新规则影响。Himawari 自己的固定提示文字在 `TRUSTED_PROMPT_TEXTS` 里被排除；只有老对话里不在固定清单、又刚好符合新写法的系统提示文字才会被新遮。
- **历史消息**：会。历史里存的是遮盖前原文（`prompt-prefix.md:36`），每次发送重新遮盖；新规则上线后，含新写法文字的旧历史第一次重发时会被遮成不同字节，请求开头变一次。已遮内容也可能因为“先密码后验证码”的顺序变化而换 kind/占位符。
- **最后一条消息/逐轮变化值**：新改动没有新增逐轮变化值；当前仍由最后一条消息承载时间、记忆、运行环境等。就“新追加的消息”而言，处理是前向的（`#known` 只累积、不向后看），所以同一套规则下继续追加不会改旧消息。
- **结论**：就代码逻辑本身是“只在末尾追加、每轮变化值在最后一条消息”；但跨越本次规则升级，对含新匹配文字的旧对话**不是严格追加**，会一次性改开头。ADR 0188:54 已承认这一点，需要按规则第 8 条确认批准。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- **不会引入新的时间/随机/无序来源**。关键词表是固定字符串，规则顺序固定；`known` 是 `Map`，按消息处理顺序插入，顺序确定；新正则只依赖本段文字和已累积的 `known`。
- **但有两个限定**：
  1. 跨本次部署，同一段旧历史会因为规则变化而遮出不同字节（一次性）。
  2. 在**单次 `redactForEgress` 调用**里，`known` 循环是在整个字符串扫描完后执行的（`redaction.ts:401-415`），所以同一字符串里后文点名一个值，可以回头遮掉前文同值。生产的 `model-egress` 是逐条消息、按顺序调用（`model-egress.ts:219-226` 配合 `maskTree` 的数组顺序），因此旧消息不受后加消息影响；新测试把三条消息 join 成一个字符串，实际上不是在验证生产路径。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

- 有单元测试；新增的正向覆盖了 `wifi密码`、引号值、Korean `은`、4 字符带词值等，反向覆盖了日期/版本/URL/路径/重定向/最小长度/ASCII 边界。
- 真正会失败的反向用例：`password is "https://example.com"`、`password is "/home/user1"`、`password is (2026-11-08)`（验证引号/括号先剥再判断）、`pwd 2>/dev/null`（验证重定向排除）、`password is 123.` / `密码 12345.`（验证剥尾后再数长度）、`1Password hunter22abc` / `notpassword abc12345`（验证 ASCII 边界）。
- 不是真反向：`pwd\n/home/user1/project`（路径排除独立生效）、`密码管理器 1Password 很好用`（值是非 ASCII，边界不是决定因素）；新的“追加消息”测试也没有让后文包含密码值，验证不到 `known` 的前向/后向问题。
- 缺少用例：短值 + 前导引号的回溯场景（`password is "a12`）、JSON 转义引号场景，以及用真实逐消息/共享 `known` 路径验证“旧消息字节不变”的测试。我没有运行 vitest，以上为静态核对。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

- 没有新增标识、字段、配置键、清单项或序列化格式；新增的只是正则分支和 `password-keyword` 命中的值集合。逐项核对了：
  - `model-egress`：值只用于哈希指纹、`known`/`table` 和占位符，接受任意字符串；
  - `identifiers.ts`：只用 `findings` 的 kind，password 已在 `CREDENTIAL_KINDS`；
  - 落库 `sensitive_interceptions`：`ruleId` 只需 128 字以内文本，`category` 已有 password；
  - 控制中心 i18n：已有 `sensitive.category.password`；
  - `external.ts`、`proactive-mail-check`、`gmail-body`、`pi-output-export`：把遮盖结果当不透明文本/占位符，格式未变；
  - `restoration.ts`：表里存原始值，普通路径可存引号/反斜杠；JSON 嵌入路径依赖 `jsonEmbedded` 解码，但只对 JSON 字符串有效。
- 未发现 I-73 那种“清单里的 id 过不了后端校验”的问题。唯一的使用端风险是上面“中｜回溯短值”和“JSON 转义引号”导致值的形态/长度与 ADR 不一致，以及混合值后缀外发。

---

## 说法核对

- “英文关键词前面不能紧挨字母、数字、下划线；中日韩关键词前面可以紧挨任何字符”——ASCII 部分基本对，但代码只排除 `[A-Za-z0-9_]`，非 ASCII 字母开头仍会命中，见“低｜字母边界”。
- “值前面的引号、左括号归入前导文字原样保留；值后面的 `. : ) ' \"` 剥掉再遮、再补回；剥完再数最小长度”——前导引号处理是新增的，尾部 `PASSWORD_TRAILING_PUNCTUATION` 和“剥掉再补回”在 `002c7b11` 已经存在（`git show 002c7b11:...redaction.ts` 可见），本轮新增的是“剥完再数最小长度”；回溯会让前导引号计入长度，见“中｜回溯短值”。
- “`NOT_A_PASSWORD_VALUE` 增加以 `<`、`>` 或 `2>` 开头的重定向写法”——代码 `\d*[<>]\S*` 确实覆盖，但比说的更宽，见“低｜重定向范围过宽”。
- “ADR 0188 如实写明混合值只遮到第一个非 ASCII 字符之前”——核对属实（`0188:46`，代码 `redaction.ts:80`）。
- “遮盖仍只取决于这段文字和它前面已点名的值”——生产逐消息路径成立；单次 join 字符串不成立（同串后文可经 `known` 回头遮前文），新测试没有覆盖这一区别。
