## 结论

本轮增量（`65b2d9f0..d81aef90`，代码提交 `40ff38f4`）没有改动任何发往模型的内容，`jsonEmbedded` 对真实 `JSON.stringify` 产物做解码在正常边界内是可逆的；但**新机制假设“表里存的一定是一段完整的 JSON 字符串内容”，这个假设在密码正好位于 JSON 字符串末尾时不成立**，会导致解码失败、存库多出 `"` / `"}`。这是本轮声称的“逐字节存下”仍然覆盖不到的场景（缺陷本身在基提交里已存在，不是本轮新引入）。另外有一个线程标题方向的反向用例缺口和文档/代码不一致。

---

## 读代码证实的问题（按严重度）

### 1. 中：密码位于 JSON 字符串末尾时，正则把 JSON 结尾的 `"`/`}` 一起吞进值，`jsonEmbedded` 解码失败，还原结果多出定界符

- 位置：`packages/sensitive-capture/src/redaction.ts:69`、`apps/agent-service/src/production-memory-capture.ts:175-191`、`packages/sensitive-capture/src/restoration.ts:14-21`
- 证据：
  - 密码规则的值部分不排除引号和右花括号：
    ```ts
    const PASSWORD_ASSIGNMENT =
      /((?:密码|...)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu;
    ```
  - 记忆提示把 `ownerMessage` 放在 JSON 对象的最后一个键：
    ```ts
    return [
      MEMORY_CAPTURE.text,
      JSON.stringify({
        ...
        ownerTimeZone: timeZone ?? "UTC",
        ownerMessage: message.slice(0, MAXIMUM_SOURCE_CHARACTERS),
      }),
    ].join("\n");
    ```
  - 解码失败时原样返回：
    ```ts
    function decodedJsonString(value: string): string {
      try {
        const decoded: unknown = JSON.parse(`"${value}"`);
        return typeof decoded === "string" ? decoded : value;
      } catch {
        return value;
      }
    }
    ```
- 具体反例：`message = "我的密码是 hunter2abc"`（消息以密码结尾）时，提示末尾是
  `..."ownerMessage":"我的密码是 hunter2abc"}`
  正则捕获到的是 `hunter2abc"}`，不是 `hunter2abc`。`JSON.parse('"hunter2abc"}"')` 抛错，表里保存的仍是 `hunter2abc"}`；模型回抄占位符后，存库/展示会变成 `主人的密码是 hunter2abc"}`。
  - 若密码出现在 `existingMemories[].text` 中间，捕获到的是 `hunter2abc"`（后面的逗号阻止继续吞），存库会多一个 `"`。
  - 含转义字符时更糟：值本身是 `ab"c\d` 且位于末尾时，捕获的是 `ab\"c\\d"}`，解码失败，还原出来仍是转义形式再加 `"}`，既不是原文，也不是原始转义。
- 现有测试为什么没抓到：新单测和集成测试都在密码后留了内容（分别是 ` 好` 和 ` 这件事。`），见 `packages/sensitive-capture/test/restoration.unit.test.ts:46` 和 `test/integration/production-memory-capture.test.ts:653`。如果改成消息以密码结尾，用例就会暴露。
- 补充：这不是 `40ff38f4` 引入的，基提交的 `placeholderTable` 也存同样的值；但本轮的 `jsonEmbedded` 目标正是修字节级还原，当前实现没有覆盖这个常见句式（“我的密码是 xxx”），所以仍应作为遗留缺陷记录。
- 建议：
  - 增加“密码正好在消息/JSON 末尾”的还原用例（普通密码、含引号和反斜杠的密码各一条），并让它先在当前代码上失败。
  - 修法二选一：(a) 让密码规则在 JSON 结构字符处停下（至少不吞 `"`、`}`、`]`，同时考虑 `。！？` 等句末标点）；(b) 对 JSON 嵌入场景不要用整段 prompt 的正则截取，而是解析 JSON 块、对字段值单独做遮盖，标签仍用 `JSON.stringify(原始值)` 算，这样标签与出口遮盖一致且值不会越界。注意 (a) 会改变出口遮盖对旧历史重新遮出的字节，需要评估一次缓存失效。

### 2. 低：`jsonEmbedded` 对整张表无差别解码，当前两个调用点安全，但共享函数以后被非 JSON 场景误用会静默改字节

- 位置：`packages/sensitive-capture/src/restoration.ts:35-36`
- 证据：
  ```ts
  if (options.jsonEmbedded !== true) return table;
  return new Map([...table].map(([placeholder, value]) => [placeholder, decodedJsonString(value)]));
  ```
  该函数只看“值”本身，没有校验这个值是否真的来自 JSON 字符串内容；`placeholderTable` 是导出的公共函数。
- 当前两个生产调用点都把整个动态内容放进了 `JSON.stringify`，所以**当前是安全的**（见 `production-memory-capture.ts:175-191`、`production-thread-titles.ts:80`）。这是设计/健壮性风险，不是当前可见缺陷。
- 建议：解码前加守卫，例如 `JSON.stringify(decoded) === value` 才采用解码结果，否则保留原值；或把解码放进一个明确的“解析 JSON 字段”函数，而不是对所有表项统一解码。

### 3. 低：线程标题的 `jsonEmbedded` / `trusted` 装配没有反向用例，删掉该行不会让现有测试失败

- 位置：`apps/agent-service/src/production-thread-titles.ts:89-92`、`apps/agent-service/test/production-thread-titles.unit.test.ts:227-259`
- 证据：标题的还原路径是
  ```ts
  const restored = restorePlaceholders(
    generated,
    placeholderTable(prompt, tag, { trusted: TRUSTED_PROMPT_TEXTS, jsonEmbedded: true }),
  );
  ```
  但标题单测里的秘密是 `"我的密码: hunter2abc 帮我记一下"`，`hunter2abc` 不含 JSON 转义，`jsonEmbedded` 开或关结果都一样；也没有标题专用 `trusted` 反向用例。记忆整理方向有集成测试覆盖（`test/integration/production-memory-capture.test.ts:653` 一带），标题方向没有。
- 影响：如果以后有人只删掉标题这行的 `jsonEmbedded: true` 或 `trusted`，现有测试仍会通过，标题里的转义密码会退化成存转义串。
- 建议：给 `ProductionThreadTitles` 加一条“消息里的密码含引号/反斜杠、模型回抄占位符、标题还原为原文”的用例，并保留一条去掉 `jsonEmbedded` 后必须失败的反向断言。

### 4. 低：文档仍写着“后台辅助调用的输出不还原”，与现在的记忆整理/标题还原不一致

- 位置：`docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:44`
- 证据：
  ```
  6. **还原只在主对话的显示端**。...后台辅助调用的输出不还原。...
  ```
  而当前代码对记忆整理和对话标题这两个后台辅助调用都做了占位符还原，并把还原后的原文存库（`production-memory-capture.ts:827-844`、`production-thread-titles.ts:89-92`）。
- 说明：这是基提交 `ce21ff75` 的行为变化，不是本轮 `40ff38f4` 引入；本轮也没有补文档。如果第 1 轮已经提过，可忽略，但代码与当前有效 ADR 0148 确实不一致。
- 建议：更新 ADR 0148（或新增 ADR）说明“哪些后台调用需要还原、还原后的原文如何存储”，避免后续维护者按文档误删还原逻辑。

---

## 推测 / 未核实

- **`JSON.parse` 把值解码成“另一个合法字符串”**：对真正由 `JSON.stringify` 生成的完整内容，我没有找到这样的输入。JSON 的转义是逐字符、前缀可判定的；截断发生在转义序列中间时 `JSON.parse` 会抛错并保持原样。真正的问题不是“解出另一个合法字符串”，而是上面第 1 条的**边界越界**（值把 JSON 定界符吞进去）以及解码失败后保留越界原值。
- **未配对代理项 / 截断切在代理对中间**：`memoryCapturePrompt` 用 `message.slice(0, 6000)`（`production-memory-capture.ts:189`）按 UTF-16 code unit 截断，理论上可能切出孤立代理项；`JSON.stringify` 会把它转义成 `\udXXX`，解码后存库时 `TextEncoder` 会变成 U+FFFD。消息正常来自带 `fatal: true` 的 UTF-8 解码，生产上很难触发；未找到具体生产路径，标为未核实。
- **资源耗尽**：密码/验证码值来自被截断到 6000 字符的消息，解码是线性的；还原后 `text` 还会受 `MAXIMUM_MEMORY_CHARACTERS = 500`、`quote` 受 300 限制，未见新的放大风险。

---

## 侧重检查

- **错误路径**：
  - 记忆整理：`externalTag()` 在 `try` 内调用；失败会 `audit("extraction_failed")` 后重新抛出（`production-memory-capture.ts:821-849`）。
  - 对话标题：`externalTag()` 和还原都在 `try` 内；取 key 失败会走 `onFailure` 并回退 `openingWords(text)`（`production-thread-titles.ts:82-102`）。
  - 结论：没有发现新增的未捕获拒绝；生产 `egress` 是必填依赖（`production-run-composition.ts:72`），所以 `externalTag()` 在正常装配下存在。
- **不可信输入 / 模型输出**：`restorePlaceholders` 只替换表里存在的占位符，表外占位符原样保留（`restoration.ts:40-41`）；生产标签是 HMAC，模型无法伪造出表内标签。没有发现注入或越权读取秘密的新路径。
- **遮盖与还原两端一致性**：出口和 `placeholderTable` 使用同一 `TRUSTED_PROMPT_TEXTS`、同一 `redactForEgress`；`trusted` 和 filler 回退路径两边一致（`redaction.ts:211-241`、`restoration.ts:28-34`）。标签在 `redactForEgress` 内部按转义后的值计算，和出口对 prompt 字符串的遮盖一致（除非上面第 1 条的越界问题）。
- **资源 / 不可逆操作**：还原只影响存储和展示，不涉及删除、覆盖等不可逆操作；解码失败是回退而不是抛出，未见新的资源耗尽路径。
- **规则/文档一致性**：发现 ADR 0148 §6 与当前辅助调用还原不一致（见问题 4）。另，基提交移除了 `scanMachineSecrets` / `containsRestrictedIdentifier` 的整段拦截，这是 PR 标题“去掉整段拦下”的有意行为（测试也改成“模型判为 private 时照存”），本轮不再作为新问题提出。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮会变的值都在最后一条消息里？

**不会。** 本轮没有改 prompt 拼装、系统提示、工具定义、历史消息或出口遮盖：

- 记忆整理仍是“固定指令 + `JSON.stringify({...})`”，`ownerMessage`、`messageSentAt`、`ownerTimeZone`、`previousAssistantMessage` 全在同一个 JSON 块里，且该块是最后一段（`production-memory-capture.ts:175-191`）。
- 标题仍是固定标题指令 + `JSON.stringify({ userMessage })`（`production-thread-titles.ts:80`）。
- 后台调用的请求结构是一条系统消息（占位符说明）+ 一条用户消息（prompt），变化值都在用户消息里（`packages/runtime-pi/src/egress-context.ts:23-28`）。
- `placeholderTable` 是在 `generate` 之后、用**同一个 prompt 字符串**建表，只用于还原输出，不参与请求构造（`production-memory-capture.ts:822-844`、`production-thread-titles.ts:83-92`）。`externalTag()` 只是取 key，不改变请求字节。

所以对本轮改动而言，答案是“不改变”；主对话的追加/冻结规则没有受到影响。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- **本轮本身不引入新的跨请求差异**：标签仍是 HMAC(kind, 值)，同一 prompt 输入下确定；`jsonEmbedded` 只做 `JSON.parse`，不依赖时间、环境、Map 遍历顺序（`restoration.ts:14-36`）。
- **但有一个既有的、与本轮直接相关的注意事项**：密码值的边界由它后面的字符决定。消息以密码结尾时值会带上 `"}`，后面有空格/逗号时不会（见问题 1）。也就是说，同一个密码在不同句子/不同请求里，标签和还原结果可能不同。这不是 `40ff38f4` 新增的，但本轮 `jsonEmbedded` 让“解码成功还是失败”直接取决于值后面是什么，应该一并修掉，否则“同一段文字不同字节”的担心在这个边界上是成立的。
- 另外，`jsonEmbedded` 对整张表统一解码（问题 2）本身是确定性的，不会造成随机差异。

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

**有，但不完整；以下均为按代码推导，工具限制下没有实际运行测试。**

- `restoration.unit.test.ts:44-54`：JSON 转义还原用例。如果关掉 `jsonEmbedded`，`plain` 表还原出的是转义串，`expect(restorePlaceholders(placeholder, decoded)).toBe(password)` 会失败——反向成立。
- `restoration.unit.test.ts:56-61`：`trusted` 用例。去掉 `trusted`，表中会多出 `"1000"`，`toEqual(["482910"])` 会失败——反向成立。
- `test/integration/production-memory-capture.test.ts:653` 一带：含引号和反斜杠的密码逐字节存下。如果从 `production-memory-capture.ts:827-830` 删掉 `jsonEmbedded: true`，存库会是 `ab\"c\\d` 而不是 `ab"c\d`，用例失败——反向成立。
- `externalTag` 改成必填：类型在 `production-memory-capture.ts:630` 和 `production-thread-titles.ts:27` 都是必填，删掉装配里的 `externalTag` 行会触发 TypeScript 错误；`production-run-composition.ts:450,498` 和测试里的所有构造点都已补齐——反向成立。
- **缺口**：对话标题的 `jsonEmbedded` / `trusted` 没有反向用例（问题 3）；记忆整理方向也没有一个“去掉 `trusted` 就必须失败”的生产路径用例，不过 `trusted` 在当前模板下实际影响很小（`1000` 只有 4 位，不会被 `known` 记住）。
- 目前这些测试在 `unit` / `integration` 项目里，`npm run check:prompt-catalog` 不包含 `restoration.unit.test.ts`，但 `npm run test` / CI 测试层会跑到；如果要求“阻断检查”也覆盖，需要把它挂进门槛脚本。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对结果：

- **`jsonEmbedded` / `trusted` 选项**：只由 `production-memory-capture.ts:827-830` 和 `production-thread-titles.ts:91` 两个生产点产生，消费方是 `placeholderTable` 和测试；没有外部 schema、持久化键或清单项，类型也匹配。两端可接受。
- **`externalTag` 必填**：生产构造点 `production-run-composition.ts:450,498`、单测/集成测试构造点都已传；类型返回值与 `ModelEgress.externalTag()` 一致。没有找到遗漏的 `new ProductionMemoryCapture` / `new ProductionThreadTitles` 调用点。两端可接受。
- **还原后的文本值**：
  - `parseMemoryCandidates` 只对 `text`/`quote` 做还原，随后 `text.length > 500`、`quote.slice(0, 300)` 等校验能接受任意字符串（`production-memory-capture.ts:303,313,335,452`）。
  - `quoteFromOwnerMessage` 用 NFKC + 去空白/标点后与原始 `ownerMessage` 比对，解码后的原文能匹配；这一点是本轮修复的目标，代码上成立（`production-memory-capture.ts:119-133`）。
  - 存库走 payload protector / `JSON.stringify`，任意 Unicode 文本（包括引号、反斜杠、换行）都能安全序列化。
  - 标题侧 `trim`、去首尾引号、`length > 120`、拒换行（`production-thread-titles.ts:93-98`）能接受任意字符串；解码后如果秘密含换行，标题会按规则回退到 `openingWords`，属于可接受的行为。
- **唯一对不上的地方**：问题 1 里还原值本身可能带 `"}` / `"`。消费方不会报错，但存下来的内容已经不是原文——这正是需要修的两端不一致。
