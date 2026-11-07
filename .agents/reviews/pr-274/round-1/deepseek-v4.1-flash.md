# 复核结论

## 一、读代码证实的问题（按严重度）

### 【高】以 `data:` 开头的文字整体绕过出口遮盖
- 文件：`packages/application/src/services/model-egress.ts:415-418`
- 问题：出口遮盖对任何“整个字符串值”以 `data:` 开头的内容直接返回原文。这个 PR 又把网页结果、工具结果的前置拦截删掉了，所以这类文字现在可以不经任何遮盖直接发给模型（含残缺私钥）。
- 证据：
  ```ts
  if (typeof value === "string") {
    if (value.startsWith("data:")) return value;
    const result = text(value, inherited);
  ```
- 影响：主人消息、纯文本工具结果、附件文字只要整段以 `data:` 开头，`redactForEgress` 根本不会被调用；`data:` 后面跟 `sk-...`、`password=...`、残缺私钥都原样发出。作者重点问的“被当作 `data:` 跳过”确实存在。
- 建议：把跳过条件收紧成真正的媒体 data URI（例如 `^data:[a-z]+/[a-z0-9.+-]+(;[^,]*,|;base64,)`），并且只对 image/audio 等已知字段生效；或对 `data:` 前缀后面的正文继续跑遮盖。补一条“`data:` 前缀 + 密钥”的模型出口反向用例。
- 说明：该跳过不是本 PR 新增的，但本 PR 移除了原来“命中密钥就整段拦下”的兜底，使这条路径变成真实泄露路径。

### 【中】完整输出在写入历史前就被遮，内部存储不再是原文，`digest`/`byteLength` 语义被改写
- 文件：`packages/platform-node/src/files/pi-output-export.ts:41-50`、`:56-63`
- 问题：`redactForEgress` 在 `exportPiOutputFile` 里先把文字遮掉，再把遮后的字节 base64 放进工具结果；`digest` 和 `byteLength` 也按遮后字节计算。这个工具结果会进入历史。也就是说，内部存下来的 fullOutput 已经是遮过的版本，原始字节只存在于临时文件里，之后无法再核对“这份输出是否等于原文件”。
- 证据：
  ```ts
  const masked = redactForEgress(text).text;
  return masked === text
    ? exportedOutput(bytes, false)
    : exportedOutput(Buffer.from(masked), true);
  ...
  digest: createHash("sha256").update(bytes).digest("hex"),
  ```
- 影响：与作者自己写的“内部存储和显示一律原文”原则不一致；目前没有消费者使用 `digest`，但以后任何“拿摘要核对原文件”的用途都会直接失效。
- 建议：完整原文按原字节存进受保护载荷；只在“准备发往模型的那一份表示”上做遮值（可以在 fullOutput 里同时保留 `digest`（原文）和 `redactedData`/`redacted`），或明确在 ADR 里把“fullOutput 只存遮后版本”写成决定并补消费方说明。

### 【中】NUL/非法 UTF-8 的完整输出只检查机器密钥，其它敏感类别原样 base64 发出
- 文件：`packages/platform-node/src/files/pi-output-export.ts:42-45`
- 问题：二进制/NUL 分支只调用 `containsToolOutputSecret`（机器密钥 + BEGIN/END 标记），不检查密码、验证码、银行卡、证件号。出口遮盖看不到 base64 内部，因此这些类别会原样发给模型。
- 证据：
  ```ts
  if (text === null || text.includes("\0")) {
    if (containsToolOutputSecret(bytes.toString("utf8")))
      throw new Error("PI_OUTPUT_FILE_REJECTED");
    return exportedOutput(bytes, false);
  }
  ```
- 影响：这是本 PR 之前就存在的缺口，但本 PR 声称“完整输出先遮文字再编码”，实际只对合法 UTF-8 且无 NUL 的文本成立。含 NUL 的文件只要不含机器密钥就完全不过 `redactForEgress`。
- 建议：对可解码的 UTF-8（即使含 NUL）也先跑 `redactForEgress` 再编码；真正不可解码的二进制则明确只做机器密钥检查并在文档里写明“二进制文件不保证遮其它敏感类别”，或直接拒绝。

### 【中】残缺私钥规则有明显覆盖缺口，作者“只有标记、没有正文的不遮”的说法不准确
- 文件：`packages/sensitive-capture/src/machine-secrets.ts:80-81`、`:84-91`
- 问题：正文行要求至少 16 个 base64 字符：
  ```ts
  const KEY_LINE = `${KEY_LINE_PREFIX}[A-Za-z0-9+/=]{16,}${KEY_LINE_END}`;
  const KEY_LAST_LINE = `${KEY_LINE_PREFIX}[A-Za-z0-9+/=]+${KEY_LINE_END}`;
  ```
  因此 `-----BEGIN ... PRIVATE KEY-----` 后面只有 1–15 个正文字符（截断正好切在行首附近）时不会遮；BEGIN 与正文在同一行时也不会遮（BEGIN 规则要求紧跟换行）。作者说“只有标记、没有正文的不遮”，但实际是“正文不足 16 个字符也不遮”。
- 影响：原来 `containsToolOutputSecret` 只要看到 BEGIN/END 标记就会整段拦下，现在这些短残缺内容会被送到模型。
- 建议：BEGIN 后只要有任何非空正文就遮（或把 16 降到 1）；为“BEGIN + 短正文”“BEGIN 与正文同一行”补反向测试。

### 【中】历史前缀会因新增残缺私钥规则改变一次，仓库里没有对应的 ADR/记录
- 文件：`packages/sensitive-capture/src/redaction.ts:300`、`.claude/rules/prompt-prefix.md:35,52,84`
- 问题：`redactForEgress` 对每条历史消息都重新跑，新增的 `redactPrivateKeyFragments` 会让“已经发过的、含残缺私钥的历史”字节变化一次。作者说 Andy 已口头同意，代码层面这个代价确实只发生一次；但规则文件要求“会改变已发内容就停下来出方案、Andy 同意才动工”，仓库里没有 ADR/事故记录承载这次同意。
- 证据：
  ```ts
  text = redactMachineSecrets(redactPrivateKeyFragments(text, seeMachine), seeMachine);
  ```
- 建议：补一条 ADR/变更记录（或在 `docs/kv-cache-guide.md`/事故清单里记明这次一次性的前缀变化及范围），并在 `check:prompt-prefix` 的说明里注明“历史含残缺私钥时允许一次变化”。

### 【中】文档仍描述旧的“整段拦下”行为，与本提交代码不一致
- 文件：
  - `docs/architecture-v0.1.md:82`：仍写“输出含机器秘密（包括只剩开头行或结尾行的私钥片段）时只交出说明和真实退出码，不交正文”
  - `docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md:136`：仍写“前台 bash 命中机器秘密……只说明、不含正文；其他工具命中仍整次失败”
  - `docs/execution/specs/2026-09-07-srt-unified-execution-design.md:431`：仍写“正文检查机器秘密；完整字节及摘要放入同一受保护结果”
  - `docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:233`：仍写 write/edit “交出不含正文的固定说明”
- 问题：作者说文档在后面的 PR 改，但当前提交里这些说明已经和代码相反（现在交正文、fullOutput 存遮后字节）。复核要求核对规则/文档与代码是否一致，所以必须指出。
- 建议：要么本 PR 一起改这些段落，要么在交付说明里列出“故意留待后一 PR”的文档清单，并确保 `check:docs`/评审不会把它们当现状。

### 【低】先截断后遮盖，非私钥类机器密钥可能被截一半而漏遮
- 文件：`packages/platform-node/src/files/pi-host-publication.ts:115`、`packages/runtime-pi/src/model-output-budget.ts:31-94`、`apps/agent-service/src/production-host-read.ts:42-56`
- 问题：旧代码在截断前用 `scanMachineSecrets(serialize(shown, null))` 扫完整正文；现在先 `fitBody` 截断，出口遮盖只看到截断后的文字。长 token 正好跨过截断边界时，剩下半截不再满足 `sk-...{16,}` 等规则，可能漏遮。
- 证据：`const bodyOnly = fitBody(serialize(content(FULL_OUTPUT_DROPPED), null));`，而 `fitPiResultOutput` 只截断 text 部分。
- 建议：对完整正文先做一次 egress 遮盖/扫描，再截断；或至少在被截断的正文上跑一次 `scanMachineSecrets`，命中就采用原来的“只丢正文/说明”路径。

## 二、推测/未核实

- **推测**：`fullOutput.data` 是普通字符串，出口遮盖仍会把它当文字扫描；base64 中若出现 `+AKIA...` 之类片段，可能被 AWS 密钥规则误遮，导致 base64 损坏、`digest`/`byteLength` 与 `data` 不一致。没有测试覆盖，未实测。
- **推测**：`data:` 绕过在实际产品路径中的可达性取决于工具结果是否被包成 JSON。多数工具结果（`pi-result.v1`、网页 JSON）外层以 `{` 开头，不会触发 `data:` 跳过；但主人消息、附件纯文本、以及任何以纯文本形式返回的工具结果仍可直接触发。
- **未核实**：作者“源代码里没有地方生成 `file`/`input_file`/`document` 类型块”只做了局部 grep，没有逐条追踪所有 provider 请求组装路径。
- **未实测**：两个新正则没有灾难性回溯的明显结构（每行匹配基本被行尾/引号约束，前缀惰性展开是线性的），但本 PR 没有长输入/性能测试，不能完全排除极端输入下的退化。

## 三、侧重检查

我重点查了以下路径：

- **出口绕过**：`ModelEgress.#redactorFor` 对非 `/chat/completions`、`/responses`、`/messages`、`/embeddings` 的请求直接 `refuse`，是失败关闭（`model-egress.ts:184`）；但 `data:` 前缀字符串会被整体跳过（`:415-418`）。
- **二进制/不可信输入**：`pi-output-export` 的 NUL/非法 UTF-8 分支只查机器密钥，密码/卡号等不受保护；含密钥时抛 `PI_OUTPUT_FILE_REJECTED`，调用方只丢 fullOutput，工具结果本身照常返回。
- **残缺私钥正则**：检查了 BEGIN/END、diff/grep 前缀、JSON 转义、短正文、同行正文、误遮普通文字；发现短正文和同行正文两个缺口；未发现明显灾难性回溯。
- **不可撤销/存储**：fullOutput 在写入历史前已被遮，原始 digest 丢失；这是不可逆的信息损失。
- **记录值两端校验**：`withheld` 从 `ModelEgressSighting` → `SensitiveInterceptionRecorder` → `SensitiveInterceptionObservation` → SQLite `oneOf(SENSITIVE_INTERCEPTION_OUTCOMES)` → gateway contracts，全部接受；`redacted` 字段没有消费者，现有 pi-result 校验只检查已知字段，额外字段被容忍。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 本身没有新增每轮变值；但多处历史文档仍写旧行为。

## 四、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

除残缺私钥规则外，本 PR 没有把新的每轮变化值放进请求开头：工具定义在 `DEFINITION_KEYS` 里被跳过（`model-egress.ts:387`、`:460-464`），系统提示里的固定文字由 trusted 机制还原，仍保持原字节。会改变的是：**历史消息里如果含残缺私钥（只剩 BEGIN 或只剩 END），这次会从原来的原文变成 `[密钥]`，该条历史字节变一次**。这正是作者说 Andy 已同意的代价；代码层面确认范围就是“含残缺私钥的字符串”，但仓库里没有 ADR/记录。除此之外没有发现新的每轮变化值被放到系统提示或历史头部。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

新增的 `redactPrivateKeyFragments` 是纯函数、无跨调用状态，同一段文字在同一版本下每次结果相同；没有引入时间字段或无序集合。`pi-output-export` 的遮后字节也在工具生成时固定，后续重发不变。既有的 `known`/trusted 机制允许“取决于它自己及前面的消息”，这是规则第 11 条允许的；没有发现本 PR 新增的不确定性。唯一变化是第 1 条说的“历史里残缺私钥一次性改变”。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有：
- `packages/sensitive-capture/test/private-key-fragments.unit.test.ts` 覆盖 BEGIN/END 残缺、diff/grep 前缀、JSON、误遮、上报。
- `packages/application/test/model-egress.unit.test.ts` 新增“遮残缺私钥并记录”和“自检拒发时记 withheld”。
- `production-host-read`、`production-foreground-result`、`sandboxed-coding-operations`、`workspace-copy`、Exa/DeepSeek/web-provider-chain 的测试都改成“返回原文、由出口遮盖”并断言模型实际收到的内容不含密钥。
- `scripts/check-egress-redaction.mjs` + `test/tooling/egress-redaction-check.test.mjs` 会核对登记表调用数；我核对到 Exa=`scanMachineSecrets:2`、DeepSeek=`1`、`pi-output-export containsToolOutputSecret:1`，与登记一致。

反向用例确实会失败：如果去掉 `redactPrivateKeyFragments`，`model-egress` 的“masks and records part of a private key”以及多个 production 用例会失败；如果新增未登记的整段拦下调用，`check:egress-redaction` 会拒绝。

缺口：没有 `data:` 前缀泄漏的反向用例；没有长输入/ReDoS 测试；没有文档一致性检查；也没有测试 `redacted` 字段/摘要语义的文档化。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

逐个核对结果：
- `ModelEgressSighting.outcome: "withheld"`：`Exchange` 产生 → `SensitiveInterceptionRecorder.reportEgress` 用 `sighting.outcome ?? "masked"` → `SensitiveInterceptionObservation.outcome` 类型（`ports/sensitive-interceptions.ts:35,57`）→ SQLite `oneOf(SENSITIVE_INTERCEPTION_OUTCOMES)` → gateway contracts 枚举，全部接受。
- `fullOutput.redacted: true`：只在 `pi-output-export` 产生并写入工具结果；`pi-write-evidence.ts`、`pi-runtime-adapter.ts`、`production-sandbox-tool-result.ts` 的校验只检查已知字段，不拒绝额外字段；目前没有消费者读取它，属于“可接受但未使用”。
- `fullOutput.byteLength`/`digest`：语义改成“遮后字节”；现有唯一消费方（测试）按遮后字节断言，代码里没有用它们核对原文件，因此不会立即出错，但语义变更需要文档化。
- 删除 `WebProviderFailureCode = "OUTPUT_REDACTED"`：全仓已无 `OUTPUT_REDACTED`/`WEB_SEARCH_OUTPUT_REJECTED`/`WEB_FETCH_OUTPUT_REJECTED` 残留引用，`searchReports`/`fetchReports` 的 `Record<WebProviderFailureCode, ...>` 仍完整。
- 新增的 `ruleId: "private-key-block"`：本来就在 `MACHINE_SECRET_RULE_IDS`/`EGRESS_REDACTION_RULE_IDS` 里，recorder 映射到 `machine-secret`，SQLite 的 `rule_id` 只要求 1–128 字符，接受。
- `SENSITIVE_GATE_CALLS`：删掉的 10 个文件已确认没有残留调用；保留的 Exa/DeepSeek/`pi-output-export` 计数与代码一致，`egress-redaction-check.test.mjs` 的“passes on this repository”会在线校验。

**总体判断**：这个 PR 的方向（不在工具/网页路径整段拦下、交给出口遮盖）是合理的，残缺私钥规则也基本覆盖常见格式；主要风险集中在“出口遮盖并非覆盖所有字符串”（`data:` 跳过）、二进制 fullOutput 只查机器密钥、以及 fullOutput 在存储前就被不可逆地遮掉。前两项属于安全边界，建议合入前处理或至少补反向测试；文档不一致可以按作者计划后移，但应在交付说明里明确列出。
