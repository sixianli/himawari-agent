## 结论

未发现高严重度缺陷。本次增量（`3f32cb87..e43c1cd9`）确实只把导入行的敏感判断从“或”扩展到 `classificationWithIdentifiers`，不会让原来敏感的行变得不敏感。发现 1 个需要产品确认的中等问题，以及若干低严重度问题。没有运行测试、typecheck 或 lint（当前只能使用 git/read/grep 类工具），以下结论均为静态阅读。

## 发现（按严重度从高到低）

### 1. 中（读代码证实；是否可接受需产品确认）：被新规则标成 sensitive 的导入项不会进入模型召回

- 文件:行：`packages/memory-engine/src/hybrid-memory-provider.ts:18,85-97`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:146,1008-1014`、`packages/application/src/services/owner-profile-service.ts:17,162-168`、`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107`
- 问题：`pwd:`、`PIN码是……` 这类行现在会被标成 `sensitive`，默认不勾选；主人勾选并导入后，后端确实以 `sensitive` 存储。但在当前生产配置下，`sensitive` 记忆不会进入全文/实体索引，嵌入模板也只允许 `public/private`，档案块同样只取 `public/private`。因此“记住了”只是在记忆页里保存和展示，模型在对话里检索不到它。
- 证据：
  - `hybrid-memory-provider.ts:18`：`const LEXICAL_CLASSIFICATIONS = new Set<DataClassification>(["public", "private"]);`
  - `hybrid-memory-provider.ts:85-87`：只有 `LEXICAL_CLASSIFICATIONS.has(...)` 才生成 `terms`。
  - `hybrid-memory-provider.ts:97`：只有 `this.#embeddable.has(memory.dataClassification)` 才生成 embedding。
  - `owner-profile-service.ts:17`：`const PROFILE_CLASSIFICATIONS = new Set<DataClassification>(["public", "private"]);`
  - `production-shape-config-template.json:104-107`：生产模板的 embedding `allowedDataClassifications` 只有 `public/private`。
  - 设计规格 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md` 也写明 `sensitive` 以上不进全文和实体索引，以避免明文关键词落盘，所以这很可能是既有隐私设计，而不是本增量引入的代码错误。
- 建议：如果产品只要求“记忆页可看、推送不露”，请在 ADR 0185 的后果里写清“导入的密码不会进入对话召回”；如果希望模型能在对话里用上，需要另做经过主人确认的敏感记忆读取路径，不能简单把它们加进通用索引。

### 2. 低（推测，基于正则阅读，未执行）：导入侧可能误标普通行

- 文件:行：`packages/sensitive-capture/src/redaction.ts:68-69,71-74,347-357`、`apps/control-center/src/memory-import.ts:91-94`
- 问题：`PASSWORD_ASSIGNMENT` 只要求“关键词 + 是/为/冒号 + 任意非空白串”，验证码规则只要求“关键词 40 字内有 4 到 8 位数字”。因此类似 `PIN码是多少`、`验证码服务在 8080 端口` 这样的普通行会被标成敏感并默认不勾。方向是保守的（不会漏标），但会增加误标。
- 证据：
  - `redaction.ts:69`：`/...|PIN\s?码|...\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu`
  - `redaction.ts:71-74`：`VERIFICATION_CODE_KEYWORD`、`CODE_WINDOW = 40`、`DIGIT_RUN`
  - `redaction.ts:347-357`：只要窗口内有关键词且数字是 4 到 8 位，就记 `verification-code`。
- 建议：如果希望减少误标，可以在 `是/为` 后要求值至少有长度或字符集特征，或者至少补上 `PIN码是多少`、`验证码服务在 8080 端口` 这类近义反向用例；如果接受保守策略，则在文档里说明。

### 3. 低（读代码证实的测试缺口）：导入交互测试没有覆盖本次新增分支

- 文件:行：`apps/control-center/test/memory-interactions.unit.test.ts:1087,1111-1112`、`packages/sensitive-capture/src/identifiers.ts:30-35`、`apps/control-center/test/memory-interactions.unit.test.ts:1266-1275`
- 问题：作者说“导入交互里勾选密码行再导入，断言 `protectText` 收到 `sensitive`”。该测试使用的文本是 `我的密码是 hunter2`，而 `mentionsSensitiveMaterial` 本来就匹配 `密码`，所以这个交互测试在本次增量之前也会通过，不能防止新增 `pwd`/`PIN码` 分支回归。真正覆盖新分支的是解析单测里的 `pwd: hunter2abc` 和 `PIN码是 1234`。
- 证据：
  - `identifiers.ts:30-31`：`SENSITIVE_MENTION = /密码|口令|password|passwd|token|secret|.../i`
  - `memory-interactions.unit.test.ts:1087`：`"- 我的密码是 hunter2"`
  - 同文件 `1266-1275` 的新解析用例才使用 `pwd:`、`PIN码是`。
- 建议：把交互测试改成勾选 `pwd: ...` 或 `PIN码是 ...` 行，并补一条“密码管理器/`PIN码是多少` 仍为普通行”的解析反向用例。

### 4. 低（读代码证实的测试缺口）：没有导入 sensitive 的端到端测试

- 文件:行：`test/integration/production-memory-capture.test.ts:1907-1908`、`apps/control-center/src/memory.ts:184-186`、`apps/agent-service/src/production-memory-control.ts:634-663`
- 问题：现有导入集成测试的两个 payload 都用默认 `private`；新增的模型整理测试覆盖了 sensitive 记忆，但没有覆盖“导入项以 `sensitive` 载荷提交、后端保存后 `dataClassification` 为 sensitive”这条路径。静态核对显示两端是接受的：`protectText` 接受 `sensitive`，`memory.import.commit` 的 item schema 校验 `contentRef/category/subCategory`，后端 `#createMemory` 只拒绝 `restricted`，并从 payload 读取分类。
- 证据：
  - `production-memory-capture.test.ts:1907-1908`：`await context.protect("payload-import-1", "回答一律用简体中文");`（未传 `sensitive`）
  - `memory.ts:184-186`：`item.sensitive ? "sensitive" : "private"`
  - `production-memory-control.ts:550-562`：`if (payload.dataClassification === "restricted") ...`，否则 `dataClassification: payload.dataClassification`。
- 建议：补一条导入集成用例，直接提交一个 `sensitive` payload，断言存储后的分类与撤销。

### 5. 低（作者说法不准确）：增量确实改了一处“发往模型”的内容，只是不在生产主链

- 文件:行：`scripts/evals/memory-capture-live.eval.ts:147`、`packages/prompt-catalog/src/memory.ts:13,16`、`packages/prompt-catalog/prompt-manifest.json:327-330`
- 问题：“本次增量不改任何发往模型的内容”对生产主链成立，但不完全准确：增量修改了 eval 脚本的 `memory_remember` 工具描述，这段文字在跑评测时会作为工具定义发给模型。它不是生产请求，也不是冻结的主对话前缀，因此不违反 KV 缓存规则，但作者的原话应加限定。另外，eval 的工具描述与正式提示词并不逐字一致（正式提示词还要求 topic 填 other），评测结果不能完全代表正式提示词。
- 证据：
  - `memory-capture-live.eval.ts:147` 的 description 在增量中被改为“证件号码、银行卡号、密码、密钥用 sensitive”。
  - `prompt-catalog/src/memory.ts:13,16` 同时要求“一次性验证码不记录”“证件号码、银行卡号、密码、密钥填 other”。
  - `prompt-manifest.json:327-330` 已登记 `changedIn: "ADR 0185"` 和新 hash。
- 建议：把说法改为“生产请求不变；eval 工具描述同步更新”；如果希望评测与正式提示词一致，考虑让 eval 复用同一份固定提示词或至少同步 topic 说明。

## 读代码证实的

- `memory-import.ts:91-94` 的敏感判断是纯“或”：`guess.sensitive || mentionsSensitiveMaterial(line) || classificationWithIdentifiers(...) === "sensitive"`，不会取消已有敏感标记。
- `identifiers.ts:10-27` 的 `containsCredential` 用 `redactForEgress` 的 findings 判断 `machine-secret/password/verification-code`，并和 `containsRestrictedIdentifier` 一起用于提升分类。
- `memory.ts:184-186` 对敏感导入项调用 `protectText(..., "sensitive")`；`gateway-client.ts:503-515` 接受 `sensitive`；`production-memory-control.ts:550-562` 只拒绝 `restricted`。
- `production-web-push.ts:486-499` 在 `dataClassification` 为 `sensitive` 或 `restricted` 时隐藏提醒正文。
- 新增解析用例 `pwd: hunter2abc`、`PIN码是 1234` 会走新分支；普通句 `我最喜欢的颜色是蓝色` 仍为普通行。
- 敏感记忆在默认/生产模板下没有全文、实体、档案索引信号（见发现 1）。

## 推测（未执行验证）

- 发现 2 的具体误标例子是根据正则推导的，没有实际运行 `parseMemoryText` 验证。
- 每行多调用一次 `redactForEgress` 会增加解析成本；单行被截到 500 字，未发现新的指数级回溯，但整个粘贴文件没有总行数上限，超大文件会更慢。这是性能风险，不是当前已证实的问题。
- 未核实 `npm run check:prompt-catalog`、`npm run check:egress-redaction`、相关 vitest 是否实际通过；只核对了 manifest/golden 的静态一致性。

## 侧重检查

- **错误路径/不可信输入**：`parseMemoryText` 处理任意粘贴文本；新逻辑把每行送入 `redactForEgress`，没有 `trusted`/`known`，不会抛出 `EgressRedactionError`；正则均为有界或线性，单行 500 字。未发现新的崩溃路径。
- **安全**：敏感行默认不勾选；用户主动勾选后才以 `sensitive` 存储；推送正文对敏感提醒隐藏。存储明文是 ADR 0183/0185 已接受的产品取舍。下游召回不可见的问题见发现 1。
- **资源耗尽**：未发现无界循环或指数级正则；每行新增一次分类计算，超大文件有额外 CPU 成本（推测，未测）。
- **不可撤销操作**：导入仍以 `memory.import.commit` 成批写入并提供 `memory.import.undo`，没有新增不可撤销操作。
- **规则/文档/代码一致性**：ADR 0185 决定 2、3 与代码一致；案例库、README、eval 已同步。ADR 0183 仍保留“网页导入仍整行丢弃”的旧原句，但后面已加“由 ADR 0185 关闭”的指向，属于历史 ADR 的保留写法。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 本次增量对生产主链：不会。增量只改控制中心解析、测试、文档和 eval 工具描述，没有改生产请求组装、系统提示、工具定义或历史序列化。
   - 整个 PR 对生产：改动了 `packages/prompt-catalog/src/memory.ts` 的固定整理记忆提示词（`memory.ts:13,16`），并同步了 manifest 和 golden。它是独立的后台调用，每次独立组装，不改变主对话已冻结的前缀；改的是固定文字，不是每轮变化的值。manifest 已登记 `ADR 0185` 和新 hash（`prompt-manifest.json:327-330`）。
   - 新增的敏感分类可能改变未来“末尾追加”的记忆内容，或使某些敏感记忆不再被召回，但不会改写已经发出的请求开头。
   - 唯一与“不改任何发往模型内容”不符的是 eval 工具描述（发现 5）。
2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会由本次增量引入。新逻辑只用 `redactForEgress(text)` 的 findings 做布尔判断，没有 `known`、`trusted`、时间或无序集合；同一行文本每次得到同样的分类。增量没有改写要发送的文本，也没有新增占位符或序列化格式。
3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：解析单测的正向 `pwd`/`PIN码` 用例如果移除新增分支会失败；`identifiers.unit.test.ts:91-95` 的 `密码管理器` 反向用例会拦住“看到密码关键词就敏感”的过度匹配。
   - 但导入交互测试没有覆盖新增分支（发现 3）；解析层反向用例只是普通句，不是 `PIN码是多少`、`验证码服务在 8080 端口` 这类近义反例；没有导入 sensitive 的端到端用例（发现 4）。这些是覆盖缺口，不是已证实的失败。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `ImportCandidate.sensitive`：控制中心用于默认勾选和标记；`memory.ts:184-186` 用它选择 `protectText` 分类 `sensitive`；接口接受 `sensitive`。
   - `contentRef/category/subCategory`：`memory.import.commit` schema 要求三者都在，`category` 来自 `MEMORY_CATEGORY_NAMES`；后端 `#createMemory` 接受 `sensitive`，只拒绝 `restricted`。
   - `containsCredential`：只被 `identifiers.ts` 和测试使用，已由 `src/index.ts` 的 `export *` 暴露。
   - `prompt-manifest.json` 的 `changedIn: "ADR 0185"` 和 eval 工具描述：都是字符串/枚举可接受的值；ADR 文件存在。
   - 唯一“使用方不能接受”的是下游语义：sensitive 记忆不会进入检索/档案索引，见发现 1。代码层面的存储和协议校验没有发现问题。
