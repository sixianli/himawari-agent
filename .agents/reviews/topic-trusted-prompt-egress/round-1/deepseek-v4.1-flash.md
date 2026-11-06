## 一、方案依赖的前提

1. **固定指令和动态数据现在是拼成同一个字符串送进出口遮盖的。**
   来源：`apps/agent-service/src/production-memory-capture.ts:132-148`，原话是 `return [ MEMORY_CAPTURE.text, JSON.stringify({ ... ownerMessage: ... }) ].join("\n");`。所以遮盖器只看到一段混合文本，无法从结构上知道哪一段是 Himawari 自己写的。

2. **出口遮盖是对最终请求体里的每个字符串无来源信息地调用 `redactForEgress`。**
   来源：`packages/application/src/services/model-egress.ts:189-219`，原话是 `const result = redactForEgress(value, { tag: ..., known: this.#known, table: this.table, ... })`；`maskTree` 在 `:396-400` 对字符串直接调用 `text(value, inherited)`。目前没有“这段来自提示词目录”的参数。

3. **误遮的直接规则是 4–8 位数字加 40 字符关键词窗口。**
   来源：`packages/sensitive-capture/src/redaction.ts:65-68`，原话是 `const VERIFICATION_CODE_KEYWORD = /(?:验证码|驗證碼|校验码|...)/iu; const CODE_WINDOW = 40; const DIGIT_RUN = /(?<![\d])\d{4,8}(?![\d])/gu;`；命中后 `:256-266` 执行 `mask("verification-code", ...)`。`1000` 正好是 4 位，且同一行有“验证码”。

4. **已认出的密码或验证码会在同一请求里按 `known` 再遮一次。**
   来源：`packages/sensitive-capture/src/redaction.ts:268-282`，原话是 `for (const [value, placeholder] of known) { if (!text.includes(value)) continue; ... }`。所以修复时不能让固定指令里的值进入 `known`。

5. **追加和字节确定性是硬约束。**
   来源：`.claude/rules/prompt-prefix.md:35`，原话是“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”；`:36` 原话是“存历史时存实际发出去的那一条……出口遮盖是唯一的例外：历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖。”；`:51-53` 原话是“同样的内容，每次都要序列化成同样的字节”“一条消息遮成什么样，只能取决于它自己和它前面的内容”。`:83` 原话是“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。”

6. **后台调用要求固定的在前、会变的在后。**
   来源：`.claude/rules/prompt-prefix.md:66`，原话是“后台调用也是固定的在前、会变的在后。整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”

7. **提示词目录已经区分固定文字和槽位。**
   来源：`packages/prompt-catalog/src/entry.ts:10-22` 定义 `PromptSegment = { kind: "text"; text } | { kind: "slot"; name }`；`:24-38` 的 `fixedPrompt` 和 `templatePrompt` 都保留 `segments`；`:40-57` 的 `renderPrompt` 只负责拼接。材料已核对约 115 个条目、144 个文字片段，逐条单独跑 `findSensitiveValues` 只有 `memory.capture` 命中，命中的值是 `1000`（来源：`packages/prompt-catalog/src/memory.ts:16-17`，上一行末尾是“……密码和验证码用 restricted。”，下一行是“confidence 是 0 到 1000 的整数……”）。

8. **现有测试只覆盖了“用足够长的固定结尾把关键词和数字隔开”，不是根因修复。**
   来源：`packages/application/test/egress-himawari-text.unit.test.ts:11-51`，它把 `CHAT_RUNTIME_ENVIRONMENT_FOOTER` 塞在关键词和 `5120` 之间，并断言 `footer.length >= 40`、`footer` 不含数字。这正好说明当前做法依赖措辞和距离。

9. **拦截记录已经存了 `purpose`，但页面在“对话里的记录”分支不显示。**
   来源：`apps/control-center/src/components/sensitive-interceptions.tsx:99-116`，原话是 `if (item.threadId !== null) { ... return \`${title ? ... : ...} · ${part}\`; }`；`purpose` 只在线程为空的分支使用。`purpose` 的存储和去重见 `packages/application/src/ports/sensitive-interceptions.ts:49-59`、`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:61-73`。

10. **`purpose` 的生产者里有一个带动态后缀的值，页面现在的白名单接不住。**
    来源：`apps/agent-service/src/production-memory-episodes.ts:98` 原话是 `` `memory-episode-${index}` ``；页面消费者 `apps/control-center/src/components/sensitive-interceptions.tsx:242-251` 的 `MESSAGE_PURPOSES` 只有精确的 `"memory-episode"`，没有 `memory-episode-0`。三种语言的文案键存在：`apps/control-center/src/i18n/resources/zh-CN.ts:1201-1208`。这就是 I-73 那类“产生值的两端没对齐”的风险。

11. **`part`、`source`、`purpose` 都有跨层校验。**
    来源：数据库检查约束 `packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:6-14`；网关契约 `packages/gateway-contracts/src/contracts-v2.ts:665-707`；应用端口枚举 `packages/application/src/ports/sensitive-interceptions.ts:3-25`。`purpose` 在库里只要求 1–64 字符，在网关是 `machineString`（`packages/gateway-contracts/src/validation.ts:49-59`，允许字母数字和 `._:-`），所以 `memory-episode-0` 能通过存储和契约，但页面会显示成“其他”。

12. **业界对误报的通行做法是排除/允许清单，不是改原文措辞。**
    Google Sensitive Data Protection：“A `Dictionary` object, which contains a list of strings to exclude from the results.”
    https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-rules
    同页对 hotword 距离窗口的原话：“A regular expression that defines the *hotword*.” “A *proximity* value that defines how near the hotword must be to the finding.”
    Presidio Allow-lists：“To specify an allow list we just pass a list of values we want to keep as a parameter to call to `analyze`.”
    https://presidio.dataprivacystack.org/tutorial/13_allow_list/

13. **I-73 的教训是必须核对“产出值”和“使用端校验”。**
    来源：`docs/incidents-and-gates.md:112`，原话大意是“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。

---

## 二、方案本身

### 2.1 出口遮盖：把提示词目录的固定文字作为“受信区间”，只遮区间外

**推荐方案：目录受信区间 + 每次 exchange 显式传入，不做按 role 的粗放放行。**

1. 在 `packages/prompt-catalog` 增加一个稳定的导出，例如 `PROMPT_CATALOG_FIXED_TEXTS`：
   - 从目录所有 `PromptEntry.segments` 里取 `kind === "text"` 的文字，去重后按“长度降序、再按码点升序”冻结排序。
   - 不包含 `slot` 的值；槽位值始终按外来数据处理。
   - 这个列表只由目录产生，不来自数据库、时间或请求。

2. 给 `redactForEgress` 增加可选参数 `trustedTexts?: readonly string[]`。实现上按区间处理，不在发给模型的文本里插入任何哨兵：
   - 在输入串里按稳定顺序找出受信文字的非重叠区间；优先最长匹配，重叠时保留更长的。
   - 对受信区间**完全不执行**密码、验证码、银行卡、证件号、机器密钥、`known` 替换，也不让它们进入关键词窗口、`known`、`findings`、`observe`。
   - 对区间外的外部内容照旧执行现有规则。`known`、`table`、计数、`observe` 在同一个 exchange 内按原顺序共享。
   - 如果需要保持现有“点名后能替换同一消息前面出现值”的语义，可以在所有区间扫描完成后，再只对非受信区间跑一次 `known` 替换；受信区间永远不被替换。这样固定文字不变，动态值的行为仍确定。
   - 边界效果：固定指令以“验证码”结尾、紧挨 JSON 的 `{"n":1000}` 时，`1000` 在外部区间，关键词窗口里没有固定指令的“验证码”，所以不遮；外部区间自己写成 `"验证码 482910"` 时，关键词和数字都在同一外部区间，仍然遮。

3. 在 `ModelEgress.exchange` 增加显式选项，例如：
   ```ts
   exchange(context?, { trustedTexts?: readonly string[] })
   ```
   只在两类调用传目录文字：
   - 聊天：`packages/runtime-pi/src/pi-runtime-adapter.ts:999` 的 `egress.exchange(...)`，传 `PROMPT_CATALOG_FIXED_TEXTS`。系统提示、占位符说明、工具定义、最后一条消息里的固定标记都在目录里，因此都受保护。
   - 后台调用：`packages/runtime-pi/src/pi-model-transport.ts:313` 的 `egress.exchange(...)`，同样传目录文字。整理记忆、起标题、邮件判断、记忆合并等后台调用都走这里。
   - 向量检索 `packages/memory-engine/src/embedding.ts:193` **不传**。检索输入是外部查询，不应该享受提示词目录的放行。

4. 不改请求结构、不改消息顺序、不把固定文字搬到 system role、不新增会变的字段。模型看到的字符串只会在“原本会被误遮的固定文字”处发生变化。

### 2.2 界面：只改页面，不改 `partOf`，并修正 `purpose` 的消费端

**选择只改页面，不改出处分类 `partOf`。**

理由：
- 改 `partOf` 或增加新的 `part` 值，要同时改 `SENSITIVE_INTERCEPTION_PARTS`、SQLite `CHECK`、网关枚举、三种语言的 `sensitive.part.*`，还可能要给历史数据做迁移；这是 I-73 那类跨层不一致的高风险改动。
- 根因修复后，后台固定指令不再产生拦截记录，原来的“验证码 · 你的话”自然消失。
- 后台调用里真正来自动态数据的部分，仍然可能被标成 `owner_message`；用现有的 `item.source` 区分展示即可，不需要改存储。

页面 `where()` 建议改成：
- 线程记录：`对话「标题」· <非 chat 的 purpose> · <part>`；`purpose === "chat"` 时不重复显示“聊天”。
- 后台来源且 `part === "owner_message"`：不再显示“你的话”，显示 `后台 · <purpose>`。
- `purpose` 解析增加前缀规则：`memory-episode-` 开头的值映射到已有的 `sensitive.purpose.memory-episode`（“整理经历”），其余精确匹配现有白名单，未知值才落到 `other`。
- 对标签做去重，避免“自动整理记忆 · 自动整理记忆”。

这样“起对话标题”“自动整理记忆”等会显示在线程记录里，后台固定指令也不会再显示成“你的话”。

### 2.3 事故记录和自动门槛

1. 在 `docs/incidents-and-gates.md` 增加一行（按现有表格式，编号建议 I-78）：现象、根因、次数 1、门槛文件、状态“已落门槛”。

2. 新增自动检查，建议分成四层：
   - **遮盖器单元测试**：`packages/sensitive-capture/test/redaction.unit.test.ts` 增加边界用例：
     - 受信文字 `"验证码是"` + `"\n{\"n\":1000}"`：`1000` 不变；
     - 同一输入去掉 `trustedTexts`：`1000` 变成 `[验证码#...]`（反向）；
     - 外部内容自带 `"验证码 482910"`：仍遮；
     - 受信文字里的密码/验证码不产生 `findings`，不进入 `known`。
   - **目录全量 forward 测试**：新文件例如 `apps/agent-service/test/prompt-catalog-egress.unit.test.ts`，遍历 `PROMPT_CATALOG_FIXED_TEXTS`，把每段文字通过真实 `ModelEgress`（和聊天/后台相同的 `exchange(..., { trustedTexts })`）送出去，要求发出去的正文逐字节包含原文字、没有被替换成占位符。再把 `memoryCapturePrompt(...)` 组装成真实后台请求，断言固定指令里的 `1000` 原样、动态 `ownerMessage: "验证码 482910"` 被遮、动态自己的普通数字不因固定关键词被遮。
   - **真实调用链测试**：
     - 聊天：在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 增加一条，把含“验证码 … 1000”的目录文字作为系统提示/固定文字，经真实 Pi 适配器和真实出口遮盖，断言请求体里原样保留；再走后续轮次，断言 `findConversationBreak` 仍为 `null`。
     - 后台：在 `packages/runtime-pi/test/pi-model-transport.unit.test.ts` 增加一条，发送 `MEMORY_CAPTURE.text + "\n" + JSON`，断言固定部分不变、动态验证码仍遮、`reports` 里没有固定 `1000` 的记录。
   - **页面测试**：`apps/control-center/test/sensitive-interceptions.unit.test.ts` 增加：线程里的 `memory-capture` 显示“自动整理记忆”；后台 `owner_message` 不显示“你的话”；`memory-episode-0` 显示“整理经历”。
   - 把新测试加入 `npm run check`：可以挂到现有 `check:prompt-catalog`（`package.json:44`）或新增 `check:prompt-egress`，并确保 `check:prompt-prefix` 仍运行 `prompt-prefix.compat.test.ts` 和 `[SI-2]`。

3. **反向用例要真的能失败**：正向用例必须走生产路径（适配器/传输层传了 `trustedTexts`），不能只调用一个手动传参的 `redactForEgress`。这样一旦有人把 `trustedTexts` 从聊天或后台调用点删掉，正向用例就会看到 `1000` 被遮而失败；另加一条“不传 `trustedTexts` 时 `1000` 确实被遮”的测试，证明旧行为仍在。

---

## 三、考虑过但不选的做法及原因

1. **改写提示词，避开“验证码”和“1000”的距离。**
   不选。Andy 已明确否；而且这是措辞碰巧避开规则，换一段文字就会复发，和现有 `CHAT_RUNTIME_ENVIRONMENT_FOOTER` 的“凑 40 字”是同一类补丁。

2. **只给 `memory.capture` 加白名单。**
   不选。修不了邮件判断、记忆合并、工具说明、占位符说明等其他目录文字；而且未来新增固定指令还会复发。目录全量白名单 + 全量门槛才有系统性。

3. **按 role 直接放行整个 `system`，或把后台固定指令搬到 system 消息。**
   不选。`system` 里可能混有部署配置的 `policy.systemInstruction`（`apps/agent-service/src/production-run-policy.ts:102-117`），不是“提示词目录里的固定文字”；按 role 放行会把这一块也当成可信。搬消息还会改变模型看到的请求结构，可能影响输出，且解释不了聊天最后一条消息里的固定标记。

4. **在拼接前先本地遮盖外部数据，再拼固定文字，最后让出口完全跳过。**
   不选。出口遮盖是最后一道门，必须继续看到最终请求体；提前遮会让绕过出口或漏遮的风险变大。

5. **改 `partOf`，新增 `background_input` 等 part 值。**
   不选。需要同时改 SQLite `CHECK`、网关契约、应用端口、三种语言和可能的迁移；收益只是在页面上换个词。根因修复后固定指令不再产生记录，页面用 `source`/`purpose` 已足够表达。

6. **只改页面、不改出口。**
   不选。页面只能把误拦截说得好看，`1000` 仍然被遮、固定指令仍然被改，模型看到的内容仍然错。

---

## 四、风险和反例

1. **内容匹配的可信区间可能被外部内容“冒充”。**
   这是本方案最大的风险。因为运行时给遮盖器的是一组目录文字，而不是随消息携带的来源标记；如果主人消息、网页、文件或工具结果里原样包含某段目录文字，这段文字会被当成受信区间跳过。极端反例：外部内容先原样贴一段含“验证码”的目录文字，再紧跟 `1234`；由于“验证码”在受信区间里，外部区间里的 `1234` 可能不再被这个关键词遮。
   缓解：只对聊天和后台 exchange 启用，向量检索不启用；目录文字是公开的 Himawari 指令，不含真实秘密；仍保留“外部区间自己带关键词和数字就遮”的规则。若 Andy 要求杜绝这种冒充，需要改成“构造时携带区间 + 历史里保存/重建区间”的结构化来源方案，工作量明显更大。

2. **已发历史中出现过目录文字并被遮过的消息，修复后字节会变。**
   材料只核对了“目录条目单独扫描只有 `memory.capture` 命中”，没有核对生产历史里是否有人原样粘贴过目录文字。若存在这种历史消息，修复后同一段原文不再被遮，下一次请求的已见过前缀会变，违反追加规则。这一项我必须标为**未核实**，见 Q1。

3. **固定指令里如果藏着真实秘密，将不再被遮。**
   这是“固定指令不检查”的直接代价。应默认目录文字里不允许放真实凭据；现有目录里没有这种值（材料核对的命中只有 `1000`）。如果担心，可以在目录维护门槛里增加“固定文字不得包含真实格式的卡号/证件号/密钥”的静态检查，但本次不扩大到规则升级。

4. **短目录片段作为受信文字可能打断外部内容的上下文。**
   如果白名单包含 `"命令："` 这类短片段，外部内容里出现它时会被当成受信区间，区间前后不再共享关键词窗口。当前含敏感关键词的目录条目都是整段固定指令，不是这种短片段；门槛测试会覆盖所有 `text` 片段。仍建议在实现时观察：若短片段导致外部验证码漏遮，就把受信列表收窄为“完整固定指令 + 带敏感关键词的模板文字片段”。

5. **`purpose` 消费端仍然可能显示“其他”。**
   如果不加 `memory-episode-` 前缀处理，线程里的 `memory-episode-0` 会显示“其他”。这是 I-73 类问题，已在方案 2.2 修正并加测试。

---

## 五、需要 Andy 拍板的取舍

1. **是否接受“目录受信区间按内容匹配”的冒充风险。**
   接受：改动小，能直接修好当前问题，门槛覆盖全目录。
   不接受：改走结构化来源方案——构造提示词时同时产出固定区间，历史消息保存/重建该区间；能杜绝外部内容冒充，但要动历史存储和聊天/后台传输接口，工作量大。

2. **是否接受修复上线时的一次性缓存变化。**
   按材料，只有 `memory.capture` 这个后台单次调用会从“`1000` 被遮”变成“`1000` 原样”。如果生产历史里有人粘贴过目录文字并被遮过，chat 前缀也可能变。需要 Andy 决定：
   - 直接上线，接受极少见历史消息的一次性缓存失效；或
   - 先上线前审计生产历史/先只修后台调用，聊天固定文字暂时继续按旧规则。

3. **页面是否显示 `purpose === "chat"` 的“聊天”。**
   建议线程里的普通聊天不重复显示“聊天”，只显示非 chat 的用途；如果 Andy 希望每条都写“聊天”，就统一显示并改现有测试。

4. **目录里是否允许出现像“1000”这种会被误判的固定数字。**
   本方案不禁止，因为固定指令已经不受检查；但如果未来要求固定指令也必须“看起来不像凭据”，就需要另加目录措辞规范，这属于另一个决定。

---

## 六、读代码/来源证实的，和推测/未核实的

**已读代码或来源证实：**
- `memory.capture` 的固定文字和 JSON 现在拼成一个字符串：`production-memory-capture.ts:132-148`。
- 出口遮盖逐字符串调用 `redactForEgress`，没有来源信息：`model-egress.ts:189-219`、`:390-432`。
- 验证码规则、40 字符窗口、`known` 二次遮盖：`redaction.ts:65-68`、`:256-282`。
- 追加、确定性和后台顺序规则：`.claude/rules/prompt-prefix.md:35-36`、`:51-53`、`:66`、`:83`。
- 目录用 `segments` 区分 text/slot：`entry.ts:10-57`。
- 拦截记录已有 `purpose`，线程分支不显示：`sensitive-interceptions.tsx:99-116`；`purpose` 存储和去重：`sensitive-interceptions.ts:49-59`、`sqlite-sensitive-interception-operations.ts:61-73`。
- `memory-episode-${index}` 生产端和页面白名单不一致：`production-memory-episodes.ts:98`、`sensitive-interceptions.tsx:242-251`。
- 数据库/网关/端口对 `part`、`source`、`purpose` 的约束：迁移 `0078:6-14`、契约 `contracts-v2.ts:665-707`、端口 `sensitive-interceptions.ts:3-25`。
- 现有测试只验证了“长 footer 隔开关键词和数字”：`egress-himawari-text.unit.test.ts:11-51`。
- 业界排除清单做法：Google DLP 官方文档和 Presidio 官方 Allow-lists（网址见前提 12）。

**推测或未核实：**
- 生产历史里是否有人原样粘贴过提示词目录文字并被遮过——**未核实**，只核对了目录条目本身。
- 实际生产请求中是否还有目录之外的自写固定文字（例如 `policy.systemInstruction`）被误遮——**未核实**；本方案只保证目录文字。
- 把目录全量文字作为受信列表后，短片段对真实外部内容的影响——**推测**，当前含敏感关键词的都是完整固定指令，但需要新测试覆盖。
- 1 次线上部署后缓存命中率的具体变化——**推测**，只能确定 `memory.capture` 这个后台单次调用的字节会变；chat 前缀按材料应不变。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

- **不改变请求结构，不重排，不新增会变字段。** 聊天仍然按“工具定义 → 系统提示 → 历史 → 最后一条用户消息”排列；后台调用仍然按“固定指令 → 数据 → 时间”排列。每轮会变的时间、运行环境、记忆等仍然只在最后一条用户消息或后台数据的动态部分里。
- **模型可见的变化只发生在“原本会被误遮的目录固定文字”上。** 按材料，目录条目单独扫描只有 `memory.capture` 的 `1000` 命中；`memory.capture` 是后台单次调用，不是聊天历史，所以按这个核对，聊天的系统提示、历史、最后一条消息前缀都不变。
- **但有一个未核实点必须说清：** 如果生产历史里主人原样粘贴过某段目录文字、并且那段文字当时被遮过，本次“内容匹配受信区间”会让它不再被遮，从而改变一条已经见过的历史消息字节。这违反追加规则。代码读不出生产历史，我没有核实。若 Andy 要求严格保证零前缀变化，应改走“构造时携带区间并随历史保存/重建”的结构化方案，而不是内容匹配。
- **结论：** 在材料核对成立的范围内，chat 只在末尾追加，不改变已见开头；唯一确定会变的是后台 `memory.capture` 调用的固定指令部分（`1000` 从占位符恢复原文），需要在方案评审时明确告诉 Andy。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

- **不会引入时间、随机数、无序集合或依赖后续内容的遮盖。** 受信列表来自静态提示词目录，按固定规则排序；受信区间只由“输入串 + 目录文字”决定；`known`/`table`/占位符签名仍按请求内固定顺序传递。
- 同一段外部文字在同一个 `known` 前缀下，遮出的字节相同；固定文字永远原样输出。
- 唯一会让同一段文字在不同时间遮法变化的是：提示词目录代码变了（属于版本变化，manifest 会记录）、遮盖密钥轮换了（现有行为）、或它前面出现了新的 `known` 值（规则 11 允许的“点名后影响后面”）。这些都不是本次新增的不确定性。
- 页面 `purpose` 展示不影响模型字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，方案 2.3 列了四层：
- `packages/sensitive-capture/test/redaction.unit.test.ts`：受信区间单元测试 + 去掉 `trustedTexts` 后 `1000` 被遮的反向用例。
- `apps/agent-service/test/prompt-catalog-egress.unit.test.ts`：遍历目录全部固定文字，用真实 `ModelEgress` 发出，要求逐字节不变；再用 `memoryCapturePrompt` 测固定/动态边界。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 和 `pi-model-transport.unit.test.ts`：真实聊天适配器和真实后台传输层，确保生产调用点真的传了受信列表；删掉调用点的 `trustedTexts` 时正向用例会失败。
- `apps/control-center/test/sensitive-interceptions.unit.test.ts`：线程用途、后台不显示“你的话”、`memory-episode-0` 显示“整理经历”。

反向用例真正会失败的前提是：正向用例走生产路径，而不是手动给 `redactForEgress` 传参。只要生产调用点撤掉受信列表，`memory.capture` 的 `1000` 就会重新变成 `[验证码#...]`，正向测试必须报错。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对：

| 值 | 产生它的地方 | 使用它的地方 | 两端的校验/结论 |
| --- | --- | --- | --- |
| `PROMPT_CATALOG_FIXED_TEXTS` / `trustedTexts` | 新导出，来自 `packages/prompt-catalog/src/entry.ts` 的 `segments` | `redactForEgress`、`ModelEgress.exchange` | 不持久化、不发给模型；只影响遮盖。全目录门槛测试覆盖。 |
| `EgressRedactionOptions.trustedTexts` | `model-egress.ts` 传入 | `sensitive-capture` | 可选参数，默认无行为变化；`credentialFindings`、`findSensitiveValues`、`locateMaskedValues`、邮件正文等不传，保持旧行为。 |
| `purpose = "chat"` | `pi-runtime-adapter.ts:999` | 页面 `MESSAGE_PURPOSES`/i18n | 已存在。 |
| `purpose = "thread-title"` | `production-model-composition.ts:647` | 页面/i18n | 已存在。 |
| `purpose = "memory-capture"` | `production-run-composition.ts:497`、`service-main.ts:1919` | 页面/i18n | 已存在。 |
| `purpose = "memory-episode-${index}"` | `production-memory-episodes.ts:98` | 页面 `MESSAGE_PURPOSES` | **当前对不上**：页面白名单没有带后缀的值，会显示“其他”。方案加前缀映射到已有 `memory-episode` 文案。 |
| `purpose = "memory-consolidation"` | `production-memory-consolidation.ts:115` | 页面/i18n | 已存在。 |
| `purpose = "mail-judgment"` | `production-model-composition.ts:508`、`service-main.ts:1554` | 页面/i18n | 已存在。 |
| `purpose = "action-review"` | `production-model-composition.ts:335` | 页面/i18n | 已存在。 |
| `source` 值 | 聊天/后台/向量/邮件等现有调用 | 数据库 `CHECK`、网关枚举、页面 | 不修改，不新增；现有集合一致（`sensitive-interceptions.ts:3-25`、迁移 `0078:6-14`、契约 `contracts-v2.ts:673-680`）。 |
| `part` 值 | `partOf` 现有逻辑 | 数据库 `CHECK`、网关枚举、三语 `sensitive.part.*` | 不修改、不新增。方案选择只改页面，避免新增枚举带来迁移和三种语言不一致。 |
| 事故记录里的门槛文件路径 | 新测试文件 | `scripts/check-incident-gates.mjs` | 必须写真实存在的文件路径，否则 `npm run check` 会拒绝。 |

需要特别说明：方案没有新增 `purpose` 值、`part` 值或数据库字段，因此不会触发 SQLite `CHECK`、网关 `machineString`、三种语言缺项这类后端校验问题；唯一发现的跨层问题是已有的 `memory-episode-${index}`，方案要求在页面消费端补前缀映射。
