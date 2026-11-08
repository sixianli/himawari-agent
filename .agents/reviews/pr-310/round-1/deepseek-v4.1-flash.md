I'll use the dedicated read tool instead.
## 结论（按严重度）

### 1【中】导入路径仍用旧的 `mentionsSensitiveMaterial`，部分“密码”写法不会被标敏感，反而默认勾选、按 private 入库
**文件:行**：`apps/control-center/src/memory-import.ts:88`、`apps/control-center/src/memory.ts:184-187`、`packages/sensitive-capture/src/identifiers.ts:30-31`

**问题**：模型/手动添加/提醒都改走 `containsCredential`，但网页导入的分类判断仍只用 `mentionsSensitiveMaterial`。两者覆盖面不同：`mentionsSensitiveMaterial` 没有 `pwd`、`PIN码`、`安全码`、`授权码`、`パスワード`、`密钥`、`验证码`，而出口遮盖的密码规则有这些写法。于是像 `pwd: hunter2abc`、`PIN码是 1234`、`パスワード: hunter2abc` 这样的真实密码行会被算成 `sensitive=false`、`checked=true`，导入时以 `private` 存入。

**证据（亲自读到）**：
```
// identifiers.ts:30-31
const SENSITIVE_MENTION =
  /密码|口令|password|passwd|token|secret|api[ _-]?key|身份证|银行卡|卡号|ghp_|sk-|\d{15,19}/i;
```
```
// memory-import.ts:88
const sensitive = guess.sensitive || mentionsSensitiveMaterial(line);
```
```
// memory-import.ts:108
checked: !duplicate && !sensitive && !coding,
```
```
// memory.ts:184-187
contentRef: await client.protectText(
  item.text,
  item.sensitive ? "sensitive" : "private",
),
```
对照 `redaction.ts:69` 的密码规则：
```
/((?:密码|密碼|口令|PIN\s?码|...|パスワード|...|password|passwd|pwd)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu
```
因此 `pwd: hunter2abc` 能被出口遮盖认出，却不会被导入判成敏感。

**建议**：`parseMemoryText` 的 `sensitive` 改用与其余路径一致的判断，例如 `classificationWithIdentifiers(line, "private") === "sensitive"`（或显式并入 `containsCredential`/`containsRestrictedIdentifier`），并补 `pwd:`、`PIN码`、`验证码`、`密钥` 的导入测试。

---

### 2【中】导入写入路径没有反向测试，测试只验证了预览，不验证“敏感项导入时 dataClassification=sensitive”
**文件:行**：`apps/control-center/test/memory-interactions.unit.test.ts:1104-1112`

**问题**：现有导入交互测试只导入那条普通规则，密码/过敏两条敏感项一直保持未勾选，从未真正发送 `memory.import.commit`。如果 `memory.ts:186` 把 `sensitive` 写错成 `private`，这条测试不会失败。新增的 `production-memory-capture.test.ts` 只覆盖模型抽取路径，也没有覆盖网页导入写入。

**证据（亲自读到）**：
```
protectText.mockClear();
await click("#settings .memory-import", "导入勾选的 1 条");
expect(protectText).toHaveBeenCalledWith("回答不要用表情符号", "private");
expect(lastCommand()).toMatchObject({
  type: "memory.import.commit",
  payload: {
    source: "assistant",
    items: [{ contentRef: "payload-edit", category: "rule", subCategory: null }],
  },
});
```
预览里虽然有 `敏感，默认不导入`，但没有“勾选敏感项后导入”的断言。

**建议**：增加用例，勾选一条 `我的密码是 hunter2` 后导入，断言 `protectText` 收到 `"sensitive"`，并加一条集成测试断言写入后的记忆 `dataClassification === "sensitive"`。

---

### 3【低】`containsCredential` 会把普通句子误判成敏感
**文件:行**：`packages/sensitive-capture/src/identifiers.ts:16-17`、`packages/sensitive-capture/src/redaction.ts:68-74`、`packages/sensitive-capture/src/redaction.ts:347-357`

**问题**：`containsCredential` 直接复用出口遮盖的启发式。密码规则会把“密码”后面任意非空白短词当值，例如“密码是必要的”“改密码是每周一次”；验证码规则只看 40 字窗口内是否有关键词和 4-8 位数字，且 `looksLikeCalendarYear` 只认紧贴的“年/-”，`2026 年` 这种带空格的年份也可能被当成验证码。后果是普通记忆/提醒被标成 sensitive、进待批准、推送正文被隐藏。

**证据（亲自读到）**：
```
// redaction.ts:69
password... \s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)
// redaction.ts:73-74
const CODE_WINDOW = 40;
const DIGIT_RUN = /(?<![\d])\d{4,8}(?![\d])/gu;
// redaction.ts:347-357
const window = whole.slice(Math.max(0, offset - CODE_WINDOW), end + CODE_WINDOW);
if (!VERIFICATION_CODE_KEYWORD.test(window)) return match;
...
tally(counts, "verification-code");
```
这是保守方向的误报，不泄露数据，但会增加审批和隐藏推送；已有 ADR 也承认识别是启发式。

**建议**：至少按项目文档把已知误报写清楚；若希望减少误报，可要求密码值命中“无空格且长度≥6/含数字”等更窄条件，但不要为此放松真正的密钥格式。

---

### 4【低】“含密码时推送正文一定隐藏”并不绝对，作者摘要没有限定已知漏判
**文件:行**：`packages/sensitive-capture/src/redaction.ts:69`、`packages/sensitive-capture/src/identifiers.ts:24-25`、`apps/agent-service/src/production-web-push.ts:486-490`

**问题**：出口遮盖的密码规则要求“密码”和值之间有 `:`、`=`、`是`、`为` 等分隔符。`Wi-Fi 密码 abc12345`、英文 `password is abc12345` 这类写法不会被 `containsCredential` 命中；如果模型自己标 `private`，`classificationWithIdentifiers` 不会升到 sensitive，推送正文仍会显示。ADR 0185 的“已知缺口”确实写了这一点，但作者摘要“这样提醒里含密码时推送正文被隐藏”没有加限定。

**证据（亲自读到）**：
```
// redaction.ts:69 —— 值前必须有分隔符
(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)
```
```
// production-web-push.ts:486-490
const hidden =
  memory.dataClassification === "sensitive" || memory.dataClassification === "restricted";
const text = hidden
  ? undefined
  : (await this.#options.readMemoryText(memory))?.replace(/\s+/gu, " ").trim();
```
ADR 0185 自己也写了：“password is …”这类英文写法、关键词和值之间没有“是”“为”或冒号的写法认不出。

**建议**：把“推送隐藏”限定为“被检测命中的密码/密钥”；若要兑现绝对承诺，需要让推送正文一律不带记忆文字（ADR 里已列为放弃项），或在提示词之外补更强检测。至少修正作者摘要和 ADR 决定 2 的无条件表述。

---

### 5【低】文档和评测脚本仍写着“导入直接丢掉密码”和“密码用 restricted”
**文件:行**：`docs/engineering-casebook.md:1061`、`scripts/evals/memory-capture-live.eval.ts:146-147`

**问题**：`docs/engineering-casebook.md` 仍说“像密码、卡号的行直接丢掉”，与新的 `parseMemoryText` 行为相反；评测脚本 Arm B 的 `memory_remember` 工具描述仍要求“不要存密码密钥”“密码用 restricted”，与新的 Arm A（`memoryCapturePrompt` 已改）不一致，会让评测两种做法在提示词层面就不对等。

**证据（亲自读到）**：
```
// docs/engineering-casebook.md:1061
...健康、财务等敏感内容默认不勾，像密码、卡号的行直接丢掉。
```
```
// scripts/evals/memory-capture-live.eval.ts:147
"...不要存一次性的任务内容、提问、寒暄、Himawari 自己的话、密码密钥。...证件号、银行卡号、密码用 restricted；其余 private。..."
```
**建议**：更新 casebook 描述；如果还要继续用该评测，把 Arm B 的描述同步到新策略，或明确标注它是旧策略对照。

---

### 6【低】I-78 反向用例改用合成文字后，不再验证真实整理记忆提示词的反向行为
**文件:行**：`apps/agent-service/test/trusted-prompt-egress.unit.test.ts:99-110`

**问题**：原来的反向用例用 `memoryCapturePrompt("写一个小游戏", [])`，能证明真实提示词在没有固定文字清单时会把 `1000` 遮掉。现在换成合成字符串 `验证码说明：...1000...`，仍能验证“trusted 机制”，但不再覆盖真实提示词。更微妙的是，新提示词本身已经不再触发 `1000` 被遮（`验证码` 与 `1000` 相距超过 40 字），所以同文件 91 行的“原样不变、没有拦截记录”在 `MEMORY_CAPTURE` 被移出 `TRUSTED_PROMPT_TEXTS` 时也可能照样通过；目前只有 130 行的“包含该条目”断言兜底。

**证据（亲自读到）**：
```
// trusted-prompt-egress.unit.test.ts:99-106
const fixed = "验证码说明：Himawari 自己写的固定文字，评分是 0 到 1000 的整数。";
const withList = await sent(background(fixed), { trusted: [fixed] });
...
const { messages, reports } = await sent(background(fixed), { trusted: [] });
expect(messages.at(-1)?.content).not.toContain("1000");
```
```
// trusted-prompt-egress.unit.test.ts:130
expect(TRUSTED_PROMPT_TEXTS).toContain(MEMORY_CAPTURE.text);
```
作者关于“新提示词里验证码离 1000 超过 40 字窗口”的说法我按文本估算成立（第 3 行到第 6 行之间隔着第 4、5 行），机制本身没变；但反向覆盖确实变弱。

**建议**：保留一条用真实 `MEMORY_CAPTURE.text` 的反向用例，或直接断言 `findSensitiveValues(MEMORY_CAPTURE.text)` 为空且 `findSensitiveValues` 对构造的旧文本非空；也可以给新提示词的固定文字加“不得含可被验证码/密码规则命中的数字”的检查。

---

## 读代码证实的 / 推测的

**读代码证实的**
- `containsCredential` 只看 `machine-secret`、`password`、`verification-code` 三类，private/public 命中即升 sensitive（`identifiers.ts:10-27`）。
- 推送正文确实按 `memory.dataClassification` 隐藏（`production-web-push.ts:486-498`）。
- 导入写入时分类来自客户端 `protectText(item.text, item.sensitive ? "sensitive" : "private")`（`memory.ts:184-187`）；后端记录分类直接取载荷分类（`production-memory-control.ts:562,577-578`），数据库强制两者一致（`sqlite-memory-operations.ts:693-694`），所以“分类一致”这条能过。
- 导入的分类判断只依赖 `mentionsSensitiveMaterial`（`memory-import.ts:88`），与 `containsCredential` 不同。
- `parseMemoryText` 不再丢行，`dropped` 字段与 `memory.page.importDropped` 已从所有引用处删除（全仓 grep 无残留）。
- `check-egress-redaction.mjs` 的 `REDACTOR_ONLY_FILES` 已加入 `identifiers.ts`，且该文件现在确实调用了 `redactForEgress`（`identifiers.ts:17`，脚本 22、177-180 行）。
- 后台整理记忆的提示词是拼在 user 消息最前面、动态数据 JSON 在后（`production-memory-capture.ts:176-192`）；调用时 `prompt` 写进 `inputRef`，系统提示走 `request.systemInstructionRef`（`production-model-composition.ts:597-606`）。

**推测/未能核实**
- 无法运行 `npm run check:prompt-catalog`，所以 `prompt-manifest.json:328` 的新 sha256 是否与 `MEMORY_CAPTURE.segments` 真正一致、金样是否通过，**未核实**；只能确认 golden 文本与源码文字一致。
- 无法运行测试，以上“反向用例会不会失败”是按断言和代码路径推断。
- “普通句子被误标 sensitive”的具体产品影响程度取决于真实消息分布，代码层面只能确认规则会命中。

---

## 侧重检查

- **错误路径**：`parseMemoryExport` 的无效 JSON 仍抛 `MEMORY_EXPORT_INVALID`，上层 `read().catch` 转成界面错误；`containsCredential` 不传 `trusted`，走 `redactUntrusted`，不会抛 `EgressRedactionError`；`importCommit` 缺载荷会报 `MEMORY_PAYLOAD_MISSING`，restricted 会被 `MEMORY_TEXT_REFUSED` 拒绝。未发现新增崩溃路径。
- **不合规范/不可信输入**：网页导入的文本来自其他 AI，属于不可信输入。现在不再过滤，凭据会进入长期记忆；这在 ADR 0183/0185 的产品取舍之内。但分类完全由客户端决定，后端只校验“记录分类=载荷分类”，不重新识别凭据；若客户端漏判（见问题 1）或恶意伪造分类，后端不会纠正。
- **安全/隐私**：推送正文对 sensitive/restricted 隐藏已核实；模型出口仍会遮盖凭据。主要剩余风险是问题 1 的导入漏标和问题 4 的检测盲区。
- **资源耗尽**：导入上限 500 条、单文件 200KB、单条 500 字（`memory-page.tsx:62-63,1799`），`redactForEgress` 处理的记忆/引文长度有上限（`MAXIMUM_MEMORY_CHARACTERS=500`、`MAXIMUM_QUOTE_CHARACTERS=300`），未发现新增无界开销。
- **不可撤销操作**：导入仍支持整批 `memory.import.undo`；撤销后分类为 sensitive 的记忆也不会被删除历史（ADR 0183 的既定设计），没有新增不可撤销路径。
- **规则/文档一致性**：ADR 0185 与代码总体一致；但 `engineering-casebook.md:1061` 和评测脚本 `memory-capture-live.eval.ts:147` 仍是旧行为描述（问题 5）；`packages/sensitive-capture/README.md:13` 也没列 `containsCredential`，属轻微文档遗漏。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只在记忆整理这条后台提示词（`production-memory-capture.ts:176-192` 把 `MEMORY_CAPTURE.text` 放在 user 消息开头，`existingMemories`、`ownerMessage`、`sentAt`、`timeZone` 等每轮会变的值都在同一个 JSON 末尾）。后台调用是每次独立组装的，不进入主对话历史；主对话的 system/tool 定义和历史没动。唯一一次变化是后台调用自己的固定前缀变了，导致这类后台请求缓存失效一次，ADR 0185 已写明。`TRUSTED_PROMPT_TEXTS` 变更也不会改主对话内容，因为旧整理提示词不出现在主对话已存历史里（只存在于后台 `inputRef`，用后释放）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会因本改动新增这种问题。`containsCredential` 只对传入文本调用 `redactForEgress(text)`，没有传 `known`、`trusted`、`tag`，不依赖前后文；也不引入时间字段或无序集合。提示词是固定文字。分类结果可能影响未来是否把这段记忆召回/放行，但对同一文本、同一配置是确定的。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
- `identifiers.unit.test.ts`：新增正例和 `REVERSE` 普通文字用例。若 `classificationWithIdentifiers` 没接上 `containsCredential`，正例会失败；若检测过宽，`REVERSE` 会失败。**是真正的反向用例。**
- `production-memory-capture.test.ts`：新增提示词断言、“明说要记住则存 sensitive”、“模型标 private 但没明说则进待批准”。第三条在改动前会因 private 且 confidence 900 自动提交而失败，是有效反向用例；第二条验证了存储原文和分类。
- `memory-interactions.unit.test.ts`：只改了预览断言（4 条、1 条勾选、无“已直接丢掉”），**没有覆盖敏感项真正导入**（见问题 2），是覆盖缺口。
- `trusted-prompt-egress.unit.test.ts`：新反向用例仍能验证 trusted 机制，但不再覆盖真实整理提示词（见问题 6）。
- 实际执行结果**未核实**（不能运行测试）。

**4. 每个新值两端都能接受吗？**
- `ImportParse.dropped` 删除：生产/消费端（`memory-import.ts`、`memory-page.tsx`、测试）全部改完，全仓无残留。
- `memory.page.importDropped`：`MESSAGE_IDS`、样例值、en/ja/zh 三语资源都删了，无其他引用。
- `containsCredential`：经 `src/index.ts` 的 `export *` 导出，测试和 `identifiers.ts` 内部使用，类型和命名都通过。
- `ImportCandidate.sensitive`：生产端 `parseMemoryText` 设置，消费端预览标签/default checked/`importCommit` 都接受 boolean。
- 导入分类：客户端经 `protectText` 写入载荷分类；服务端 `#createMemory` 用载荷分类建记录，数据库强制一致；`sensitive` 可接受，`restricted` 才拒绝；分类名都在 `MEMORY_CATEGORY_NAMES` 内，`sensitiveTopicFor` 对非 health/finance 落 `other`。**能通过后端校验。**
- `REDACTOR_ONLY_FILES` 新增项：`identifiers.ts` 确实调用了 `redactForEgress`，登记位置正确。
- `prompt-manifest.json` 的 `memory.capture` 项和 golden：键存在、文本同步更新，但 sha256 是否匹配**未核实**。

**ADR 0185 事实核对**
- “提示词原让模型标 restricted，restricted 候选被丢弃”属实（旧文本 + `automatic-memory-service.ts:133-137`）。
- “密码、密钥不会升 sensitive，推送会显示正文”属实在改动前；推送逻辑 `production-web-push.ts:486-490` 属实。
- “网页导入整行丢弃”属实在改动前；`memory-import.ts` 旧 `dropped` 逻辑与 ADR 0183 记录一致。
- “自动整理、模型提醒、网页手动添加和提醒都走 `classificationWithIdentifiers`”属实（`production-memory-capture.ts:329-337`、`production-reminder-writer.ts:205`、`apps/control-center/src/memory.ts:158-167`、`memory-page.tsx:2051-2055`）。
- “restricted 候选仍被丢弃”“导入不再丢行、命中 `mentionsSensitiveMaterial` 标 sensitive、默认不勾选”“登记 `identifiers.ts`”都与代码一致。
- “密码规则取值到空白/逗号/分号为止、password is… 认不出”属实（`redaction.ts:69`）。
- 唯一需要收紧表述的是“含密码/密钥的提醒推送正文自动隐藏”是“被检测命中的才隐藏”，不是所有写法。
