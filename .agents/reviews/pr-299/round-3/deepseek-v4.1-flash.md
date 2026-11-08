## 读代码证实的发现（按严重度）

### 中（遗留问题，非第 3 轮引入）：密码含空白/逗号时仍会静默截断，`jsonStringContent` 修不到
- 位置：`packages/sensitive-capture/src/redaction.ts:68-69`，`packages/sensitive-capture/src/restoration.ts:14-23`
- 问题：密码规则的取值是 `([^\s,，;；]+)`，值在空白、逗号、分号处就停了。之后 `jsonStringContent` 只处理 JSON 结尾字符，无法把被正则提前截掉的真实字符找回来。
- 证据：
  ```ts
  69: /((?:密码|...)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu;
  ```
  消息 `记住我的密码是 abc def` 在 JSON 里是 `...密码是 abc def"}`，捕获值是 `abc`；解码后仍是 `abc`，表里存的、还原出的都是 `abc`，` def` 丢失。逗号/分号同理。
- 影响：记忆文本会静默存成截断值；`quoteFromOwnerMessage` 用 `[\s\p{P}]` 去掉空白和标点后，截断后的 quote 仍可能是原消息的子串（例如 `我的密码是abc` 是 `记住我的密码是abcdef` 的子串），所以证据校验不一定拦得住。标题路径也会写入截断值。
- 建议：至少为“值含空白/逗号”补测试并决定语义；若要保持原值，需要让密码规则按引号/JSON 边界取值，或对 JSON 内嵌值使用专门的提取方式，而不是复用按空白截断的关键词规则。此问题不是本轮 `jsonStringContent` 引入的，但本轮材料里“值不含空白和逗号”的说法只对截出的片段成立，对真实秘密不成立。

### 低：新测试没有覆盖作者点名要核查的边界
- 位置：`packages/sensitive-capture/test/restoration.unit.test.ts:64-84`
- 问题：新增用例只覆盖普通密码、含引号/反斜杠/换行的末尾值、后面跟另一个字段的值；没有覆盖“值以单个 `\` 结尾”“连续反斜杠 `\\`”“`\uXXXX` 序列”“空值”。其中空值实际不可达（密码规则 `+` 至少 1 字符），但其余三种是可构造的。
- 证据：`it.each` 的两组值只有 `"hunter2abc"` 和 `'a"b\\c\nd'`。
- 建议：加 `it.each`：`String.raw` 的尾反斜杠、双反斜杠、`\u0000`/`\ud800` 等，锁定扫描器的行为。

### 低：标题测试对第 2、3 个用例的“不泄露”断言是空转
- 位置：`apps/agent-service/test/production-thread-titles.unit.test.ts:265`
- 问题：三个参数化用例都断言 `expect(masked).not.toContain("hunter2abc")`，但第 2、3 个用例的秘密分别是 `hunter2abc` 之外的字符串（第 3 个是 `ab"c\d`），该断言恒真，测不到实际秘密是否被遮。
- 证据：
  ```ts
  229: ["inside the message", "我的密码: hunter2abc 帮我记一下", "hunter2abc"],
  230: ["at the end of the message", "帮我记一下，我的密码是 hunter2abc", "hunter2abc"],
  231: ["with quote and backslash at the end", '帮我记一下，我的密码是 ab"c\\d', 'ab"c\\d'],
  ...
  265:      expect(masked).not.toContain("hunter2abc");
  ```
- 建议：断言 `expect(masked).not.toContain(secret)`，并断言 `masked` 中出现 `[密码#...]`。

### 低：集成测试的占位符由“重建 prompt”算出，不是实际发送的 prompt
- 位置：`test/integration/production-memory-capture.test.ts:52-65`
- 问题：`placeholderOf` 固定用 `memoryCapturePrompt(message, [], null, T0, ...)` 重建，而生产代码用真实的 `existing`、`previousAssistantMessage`。当前这些用例里二者恰好一致，但以后提示词拼装或上下文变化时，这个 helper 会悄悄算错占位符，测试可能误报/漏报。
- 证据：
  ```ts
  52: function placeholderOf(message: string): string {
  53:   const prompt = memoryCapturePrompt(message, [], null, T0, "Asia/Shanghai", {
  ```
  同一测试的 `setup` 已经收集了 `prompts`（`prompts.push(prompt)`），可以直接用真实 prompt。
- 建议：从 `context.prompts` 取实际 prompt 计算占位符，或至少断言重建 prompt 与 `context.prompts.at(-1)` 相等。

## 推测
- `jsonStringContent` 的正确性依赖“输入一定是 `JSON.stringify` 产生的字符串内容片段”。当前两个调用点都满足（`production-memory-capture.ts:813-830`、`production-thread-titles.ts:80-92`）。如果未来把 `placeholderTable(..., { jsonEmbedded: true })` 用在非 JSON 段落，函数会把用户内容里真实出现的、未转义的 `"` 及其后内容截掉。建议在函数上写明这个前提，或改名为 `jsonStringContent` 之外更明确的私有名。
- 如果模型密钥版本在 `generate` 与 `placeholderTable` 之间轮换，`externalTag()` 与出口实际使用的 tag 可能不一致，导致占位符无法还原（只会保留占位符，不会泄露）。正常路径下两处都用同一个 `ModelEgress` 派生 key（`model-egress.ts:524-525`、`production-model-egress.ts:76-88`），未发现实例不一致的具体路径。

## 侧重检查
- **错误路径**：`decodedJsonString` 在 `JSON.parse` 失败时回退到截断后的 `content`（`restoration.ts:30-32`），不会抛异常；标题路径若还原出含换行的值，会走 `THREAD_TITLE_RESPONSE_INVALID` 分支回退到 `openingWords`（`production-thread-titles.ts:93-102`）；记忆候选在还原后仍做长度/分类/证据校验（`production-memory-capture.ts:303-349`）。未发现新的崩溃路径。
- **不合规范/不可信输入**：值来自 `JSON.stringify` 产物，引号必然转义；扫描器对 `\"`、`\\`、尾部偶数反斜杠、`\uXXXX` 的处理正确；尾部单个奇数反斜杠会让 `JSON.parse` 失败并原样返回，但正常 JSON.stringify 片段不会出现这种情况。密码含空白/逗号仍会丢失真实字符（见上）。
- **安全**：本轮不改变任何发往模型的字节；出口仍会遮机器密钥并在残留时拒绝（`model-egress.ts:230-243`）。还原值只进入内部存储/标题，符合“内部用原文”的设计。
- **资源耗尽**：`jsonStringContent` 是单次线性扫描，无递归、无无界分配；整表解码是 O(表项数 × 值长度)，输入受提示词长度约束。
- **不可撤销操作**：本轮没有新增删除、覆盖、外部发送等不可逆操作。
- **规则/文档一致性**：`prompt-prefix.md` 第 4、5、11 条与改动不冲突；`scripts/check-egress-redaction.mjs` 把 `restoration.ts` 加进 `REDACTOR_ONLY_FILES`（第 21 行），并删除了已不再调用整段拦截函数的 `SENSITIVE_GATE_CALLS` 条目；未发现文档与代码矛盾（本轮无文档改动）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会（第 3 轮增量）。本轮只改 `restoration.ts` 和测试：
- 记忆整理在 `production-memory-capture.ts:813-826` 先构造并发送 `prompt`，`placeholderTable` 在 `:827-830` 于 `generate` 之后才调用，只用于 `:844` 的还原；
- 标题在 `production-thread-titles.ts:80-87` 先发送 prompt，`:88-92` 才建表还原。

所以发给模型的内容仍只在末尾追加；记忆/标题这类后台调用的每次变化值都在这条唯一的用户消息里（`memoryCapturePrompt` 的 JSON、标题的 `JSON.stringify({userMessage})`），系统提示是固定字符串。整个 PR 的 `redactForEgress` 主逻辑没有改动（`redaction.ts` 只删了 `credentialFindings`），历史重新遮盖的字节不变。唯一的行为变化是以前被整段拦下的请求现在会发出去，这是新增的末尾调用，不是改写已发前缀。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
新增的 `jsonStringContent` 本身是纯函数，不依赖时间、遍历顺序或集合顺序；同一 prompt 每次得到同一张表。需要说明一点：占位符编号仍按**未截断的原始片段**算（`restoration.ts:41-48` 的 `tag` 在 `redactForEgress` 内被调用），所以同一个秘密出现在 JSON 字符串末尾（片段含 `"}`）和字符串中间（片段不含）会得到不同编号；这是作者声明的“和出口遮盖一致”的必要行为，且每个请求内自洽，不影响已发前缀。同一消息在同一序列化下每次字节相同（已有 `[I-78]` 的“同一内容遮成同样字节”测试）。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
有：
- 单测 `packages/sensitive-capture/test/restoration.unit.test.ts:64-84`（3 条）；
- 集成测试 `test/integration/production-memory-capture.test.ts:666-698`（3 个参数化用例）；
- 标题测试 `apps/agent-service/test/production-thread-titles.unit.test.ts:228-271`（3 个参数化用例）。

反向核对（按旧 `decodedJsonString` 直接 `JSON.parse(\`"${value}"\`)` 推演，未实际运行）：末尾普通密码和末尾含引号/反斜杠/换行的密码，旧代码会返回带 `"}` 的原值；后面跟另一字段的用例旧代码会返回带结尾 `"` 的值；因此这些断言都会失败。作者说“记忆 2、标题 2、单测 3 失败”与推演一致——中间的用例旧代码本来就能通过。覆盖缺口见上面“低”条目。

### 4. 每个新值两端都能接受吗？
逐项核对：
- **占位符 key/tag**：沙箱里测试 tag 返回 8 个小写字母；生产 `letters()` 返回 8 个小写字母（`model-egress.ts:112-125`），与 `EGRESS_PLACEHOLDER_PATTERN` 的 `[a-z]{8}`（`redaction.ts:61`）一致；`externalTag()` 与出口使用同一 key 派生（`model-egress.ts:524-525`）。
- **表值（解码后的秘密）**：只被 `restorePlaceholders` 使用（`production-memory-capture.ts:844`、`production-thread-titles.ts:89-92`）。记忆端接受任意非空字符串并做长度/分类/证据校验；标题端做 trim、去引号、长度 ≤120、拒绝换行，失败则回退。解码后值变短、去掉了 JSON 结构字符，两端都能接受，没有消费者依赖旧的结尾字符。
- **脚本登记**：`restoration.ts` 调用 `redactForEgress`，已登记进 `REDACTOR_ONLY_FILES`（`scripts/check-egress-redaction.mjs:18-24`）；删除的 `SENSITIVE_GATE_CALLS` 条目对应的文件确实已无整段拦截调用，反向检查（登记了但已无调用）不会误报。
- **测试 tag 改动**：`captureTag` 改为 SHA-256 取前 8 个十六进制位映射到 a–p，仍是 8 个小写字母，和模式匹配；只影响测试。

未发现“清单/标识能生成但后端校验不接受”的 I-73 式问题。
