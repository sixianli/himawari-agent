# 出口遮盖误遮固定指令的根因修复——方案

## 一、方案依赖的前提（读代码/来源证实的）

1. **误遮机制**：验证码规则是“4–8 位数字 + 前后 40 字符窗口内出现关键词”就遮（`packages/sensitive-capture/src/redaction.ts:65-68`，`:68` `DIGIT_RUN = /(?<![\d])\d{4,8}(?![\d])/gu`；命中后 `:256-266` `mask("verification-code", …)`）。窗口在同一条字符串内计算（`:258` `whole.slice(offset - CODE_WINDOW, end + CODE_WINDOW)`），跨消息不生效——`maskTree` 对每个字符串单独调 `redactForEgress`（`packages/application/src/services/model-egress.ts:189-219`）。
2. **触发点是一次性拼串**：整理记忆把固定指令和数据拼成一条 user 消息：`memoryCapturePrompt` 用 `[…MEMORY_CAPTURE.text, JSON.stringify({…ownerMessage…})].join("\n")`（`apps/agent-service/src/production-memory-capture.ts:131-148`），`backgroundModelContext` 把它放进唯一一条 user 消息（`packages/runtime-pi/src/egress-context.ts:23-28`）。固定文字里“……密码和验证码用 restricted。”下一行是“confidence 是 0 到 1000 的整数”（`packages/prompt-catalog/src/memory.ts:16-17`），“1000”落入窗口被迫遮。
3. **同构拼串不止一处**：起标题 `THREAD_TITLE.text \n JSON`（`apps/agent-service/src/production-thread-titles.ts:76`）、邮件判断交错多段（`packages/application/src/services/proactive-mail-check-service.ts:264-270`，含 `MAIL_JUDGMENT_NOW` 时间模板在最后）、合并记忆交错（`packages/memory-engine/src/consolidation.ts:119-135`，FORMAT 固定段在数据之后）。
4. **出处分类按 role 判**：`partOf` 把所有 user 消息记成 `owner_message`（`model-egress.ts:293-302`），所以后台调用误拦截显示成“你的话”；拦截记录的 `purpose` 已存库且参与去重（`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts` 去重键、`packages/application/src/ports/sensitive-interceptions.ts:44-59`），页面只对非对话记录显示 purpose（`apps/control-center/src/components/sensitive-interceptions.tsx:99-116`）。`memory_source`、`mail` 等 part 在三处都已注册：迁移 CHECK（`packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:13`）、后端枚举（`ports/sensitive-interceptions.ts:12-25`）、i18n（`zh-CN.ts:1199-1208`）、网关合约（`packages/gateway-contracts/src/contracts-v2.ts:693-694`）。
5. **业界做法是“结构承载信任边界”**：Anthropic 工程文档：“Put untrusted content only in tool results…JSON-encode untrusted content. …JSON escaping provides unambiguous delimiters between the untrusted payload and the surrounding structure, so an attacker cannot close a quote or tag to 'break out' into an instruction context．”（https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks ）；OWASP："Keep trusted instructions separate from untrusted data, but do not treat text labels or prompt wording as an enforcement boundary."（https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html ）。排除误报的通行做法（关键词排除表）是材料已给的 Google/Presidio 引用（见其链接）。
6. **项目已有门槛基建**：`npm run check` 里已有 `check:egress-redaction`（登记所有出口，`scripts/check-egress-redaction.mjs`）和 `check:prompt-catalog`（逐条目清单+manifest，`apps/agent-service/test/prompt-catalog.unit.test.ts`，含 REVERSE 用例模式）；事故清单每条必须配自动门槛（`docs/incidents-and-gates.md:14-20`，I-73 行即范例）。

## 二、方案本身

核心判断：**信任边界要放在请求结构里（消息 role / 字段划分），不要放在文本标记、排除表或措辞里。** 分四层：

**1. 出口遮盖规则修正（根因第一层，`packages/application/src/services/model-egress.ts`）**
- `Exchange#prepare` 把 `this.#context` 传进 redactor；`partOf` 扩展：`source === "background"` 时，user 消息的 part 按 purpose 映射：`memory-capture / memory-consolidation / memory-episode → "memory_source"`，`mail-judgment → "mail"`，其余（thread-title 等）→ `"owner_message"`（数据里本来就是主人的原话或其 JSON）。
- `maskTree`：part 为 `"system"`（role system/developer 的消息内容）的字符串**整体跳过**——不脱敏、不进 `known`、不贡献关键词窗口、不产生拦截记录。聊天请求的 system 就是冻结的固定指令+占位图例（`packages/runtime-pi/src/egress-context.ts:15-21`），同样适用；聊天行为其余不变，规则第 11 条的 named-earlier 例外不受影响（运行环境说明在最后一条 user 消息里，不在 system）。

**2. 后台提示词结构化（根因第二层，固定/数据分离到不同消息）**
- prompt-catalog 新增一个信封生成器：`backgroundPrompt({ fixed: readonly string[], data: string }) → JSON.stringify({ himawariBackgroundPrompt: 1, fixed, data })`，键序固定、逐字节确定。不在文本里放哨兵符。
- 四个拼串点改为信封：`memoryCapturePrompt`（fixed=[MEMORY_CAPTURE.text]，data=JSON）、`production-thread-titles.ts:76`、`consolidationPrompt`（fixed=[MEMORY_CONSOLIDATION.text]，data=组行+新记忆+FORMAT 尾行，保留原布局）、`proactivePrompt`（fixed=[MAIL_JUDGMENT.text、两个 header 定语段]，data=记忆 JSON+邮件 JSON+NOW 行）。
- `backgroundModelContext` 解析信封：`systemPrompt = [占位图例, fixed.join("\n")].join("\n")`，`messages = [{ role: "user", content: data, timestamp }]`；解析失败回退现状（整串当数据）——兼容暂停/恢复夹缝里的旧 payload。`MAIL_JUDGMENT_NOW` 仍在最后一条（也是唯一一条）消息末尾，“当前时间”类会变值仍在最后（规则 15-17 满足）。

**3. 界面（目标 3）**
- `sensitive-interceptions.tsx` 的 `where()`：属于对话的记录也显示用途，即 `对话「标题」· 用途 · 出处`（`message("sensitive.purpose.*")` 已存在，复用即可，去重沿用 background 分支的 `[...new Set]`）。part 改用第二层映射后，后台隐性固定指令不再产生记录；对话里真实命中的记录显示“用途”。
- 改的是 `partOf`（数据端）+页面（显示端）两端，不是只改页面：因为只改页面时主人原话之外的 stored 记忆/邮件照旧记成“你的话”。

**4. 自动门槛 + 事故行**
- 新测试 `apps/agent-service/test/background-fixed-prompt-egress.test.ts`（走真的 PiModelTransport+真 ModelEgress+回环服务，仿该文件现有 `[SI-2]` 模式）：
  - 主用例 A：`memoryCapturePrompt` 真发，断言上游 body 里“confidence 是 0 到 1000 的整数”逐字节仍在，无 `[验证码#…]`，report 未收到相关 sighting；
  - 主用例 B：遍历提示词目录每个 `fixedPrompt`/text 片段，按其 `usedBy` 组成真实后台请求发出，断言每段固定文字原样不变（与 manifest 对齐，新增条目自动覆盖）；
  - REVERSE-1（撤结构修复必挂）：改为 legacy 拼接固定+数据同串发送，memory.capture 的 `1000` 必然被遮，主断言失败；
  - REVERSE-2（防过度跳过）：数据 JSON 自带“验证码 654321”时仍必须遮，且 part 为 `memory_source`；固定文字紧邻处 data 区开头数字不算该关键词（边界守恒）；
  - REVERSE-3：目录-wide 静态检查补一条——任何 catalog 固定文字若出现 `findSensitiveValues` 命中即失败（给 embedding 指令这类无法结构分离的场景兜底）。
- 把该测试挂进 `check:prompt-catalog` 的 vitest 命令（仿 `check:model-ref-contract` 的挂法，`package.json:46`），事故表加一行（编号取清单当前最大值+1，正文提到过 I-76，须实读后定）：门槛写该测试文件，`npm run check:incident-gates` 校验。`check:egress-redaction.mjs` 可加一条“后台组装必须走信封”。

## 三、考虑过但不选的做法

1. **关键词排除表 / allow list（Presidio、Google 排除规则路线）**：只能点名豁免已知条目，目录 115 个条目、144 个片段，任何新写法都可能再撞；无法保证“每段固定指令原样不变”这个可反证的目标。保留为“规则升级另做”的补充。
2. **文本内哨兵/包裹标记，遮盖端拆段**：数据来自外部（`ownerMessage` 是外人可控内容），可在数据里伪造哨兵翻转信任区，把真数据段声明成“固定”从而漏遮；Anthropic/OWASP 一手来源都明确结构（JSON 转义）优于文本标记。
3. **source=background 的请求整体不扫**：数据区有邮件正文、主人原话、已存记忆，必须照扫。排除。
4. **只缩窗口/加边界白名单**：方向是削弱拦截，误遮会换形态回来。排除。
5. **改提示词措辞（把 1000 换掉）**：Andy 已否。
6. **只在页面把误拦截藏掉/只改 partOf 不动结构**：记录照样产生、固定文字照样被改字节，不是根因修复。

## 四、风险与反例

- **反例（未核实，靠门槛兜底）**：consolidation 的组行模板片段（“组 g1（日期）”、“主人当时的原话：”）、FORMAT 尾行留在 data 区，会被当数据扫描。我读过这些片段，无关键词+数字组合，不会误遮；但目录-wide 用例 B 保证未来任何此类片段都会被抓。
- **模型行为**：后台请求的固定指令从 user 挪到 system，提示词逐字未改，但位置语义变了；整理记忆/邮件判断输出质量可能波动。用 automation golden（`automatic-memory-golden.test.ts`）和 `prompt-output-contracts` 回归把关。
- **跳过 system 的边界**：若未来有人把会含敏感值的东西放进后台 system 段会漏遮；REVERSE-3 和“系统消息里出现敏感即失败”的断言顺序可以拦住 catalog 来源；非 catalog 来源理论上仍是盲区（接受：system 按定义是固定指令）。
- **兼容**：payload 存量里的旧格式整串 prompt 靠 fallback 照旧扫描（旧行为=旧误遮，不会漏遮）。

## 五、需要人拍板的取舍

1. 后台调用的请求结构变化（fixed 进 system、user 只剩数据）——虽然不涉及“已见过的会话开头”，仍按规则第八节精神请 Andy 确认。
2. part 映射表（尤其 `thread-title` 数据仍记 `owner_message`、`action-review` 用途的 part 归属）。
3. `MEMORY_CONSOLIDATION_FORMAT` 留在数据尾部（保留“数据之后给格式”的布局）还是并入 system。
4. embedding 查询指令（`MEMORY_EMBEDDING_QUERY_INSTRUCTION` + 查询串同一条字符串，embeddings 接口没有 system 位置）只做门槛覆盖不做结构分离，是否接受。

## 六、证实 vs 推测

**读代码证实**：前提 1–6 所引各文件行；`[SI-2]`/`[I-66]` 已有门槛与 REVERSE 模式；i18n/合约/枚举三端已含 `memory_source`。
**推测（未核实）**：除四个已列拼串点外不存在第五处“固定+动态同串”的后台组装（门槛用例 B 是兜底）；除 `backgroundModelContext` 外没有其他消费后台 prompt payload 的读取方（比如崩溃恢复或诊断），实施方案时要 grep 全部 `payloads.readText` 调用点核对；I-76 之后事故表的下一个编号；partOf 跳过 system 不会破坏 `packages/application/test/model-egress.unit.test.ts` 里现有断言（实施时需先跑）。

## 七、必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 对话主链路（系统提示、工具、历史、遮盖、存储）一行不改，逐字节不变，仍然只追加、每轮会变的值都在最后一条消息里；`npm run check:prompt-prefix` 继续 pass。会变的是**后台一次性调用**的请求内部结构（新增 system 段、user 消息变纯数据）：这些请求每次都是新请求、无已见前缀可保护，规则 15-17（固定的在前、数据在后、时间类值在最后一条消息末尾）仍然满足——但这仍属“发给模型的内容布局变化”，按第八节精神已列入“需要 Andy 拍板”。
2. **同一段文字会不会在不同请求里变不同字节？** 不会。遮盖函数本身不改，同输入同输出；跳过 system 的判定只取决于消息 role 与 purpose（纯函数）；信封用 `JSON.stringify` 固定键序拼装，逐字节确定；无时间戳进 fixed；`known` 沿消息线性积累与现状一致（既有的、规则第 11 条已豁免的行为）。
3. **有没有自动检查、反向用例会不会真的失败？** 有。门槛 = 目录全覆盖真发用例（B）+真组装用例（A），REVERSE-1 把组装退回单串拼接，`"1000"` 会被 `[验证码#…]` 替换，主断言失败；REVERSE-2 拦“过度跳过”；每条都仿现有 `[I-66]`/REVERSE 模式写成会被 `npm run check` 自动运行的项目，事故行经 `check:incident-gates` 反验（门槛文件不存在即失败）。
4. **每个新值的产生端/使用端核对**：信封格式——产生于 prompt-catalog 信封器，消费于 `backgroundModelContext`（唯一解析点，fallback 兜旧格式），其他 Payload 读取点标注未核实、需实施时 grep；part 值 `memory_source`/`mail`——产生于 `partOf`，消费链 assembly→`SensitiveInterceptionRecorder.reportEgress`→SQLite record（枚举/CHECK 已含，0078:13）→去重键（含 part，向后端校验过：非法 part 的 record 被拒，见 `sensitive-interceptions.test.ts:267-286`）→**UI i18n 三语已存在**→网关合约已含（contracts-v2.ts:693-694）——两端校验齐；purpose 用既有值，无新增；页面用 `sensitive.purpose.*`/`sensitive.part.*` 既有 message-id（`message-ids.ts:1100-1122`），无新键。无数据库迁移。
