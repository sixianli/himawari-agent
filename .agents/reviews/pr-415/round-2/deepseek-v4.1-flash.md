已达本次执行步骤上限，以下是不再调用工具直接给出的复核结论。

# 复核结论（b12771 增量，对比 2267d02）

## 一、读代码证实的

### 严重度：中 — 文档仍称所有模式都注入“项目指令第 16 条原话”，但 plan-claims 已不注入
- 文件：`.agents/instructions/model-review.md:157`；`scripts/model-review/opencode-review.mjs:309`
- 问题：这次为 plan-claims 删掉了第 16 条那句，但说明文档仍把它写成“各模式的固定说明”的一部分。
- 证据：文档 `脚本会在前面加上各模式的固定说明（上面的必问问题、项目指令第 16 条原话、该模式的任务和输出格式）`；代码 `...(mode === "plan-claims" ? [] : [RULE_16_SENTENCE]),`。同文件 `:29` 也明确 plan-claims“提示里不放代码复核的必答问题”。
- 建议：在 `:157` 写明 plan-claims 不加第 16 条、也不加必答问题，或改成“除 plan-claims 外”。

### 严重度：中 — “格式坏了的行一定报错”与解析器不一致
- 文件：`.agents/instructions/model-review.md:31`；`scripts/model-review/plan-claims.mjs:44-56`
- 问题：文档这次新增“有格式坏了的行，打印 `CLAIMS_PARSE_FAILED`”，但解析器只检查以 `CLAIM|` 开头的行；写成 `CLAIM 1 | …`、`` `CLAIM|…` ``、`CLAIM：…` 这类变体会被静默跳过，只要还有别的合法行，门槛就可能通过，而且漏掉的“说法”不会被计入。
- 证据：`if (!line.startsWith("CLAIM|")) continue;`（:46），只有进入该分支后才做 `parts.length < 6 …` 判为 malformed。
- 建议：对“看起来像 CLAIM 但不以 `CLAIM|` 开头”的行也判 malformed（例如 `/^\s*(?:[-*>]\s+)?[`*]*CLAIM\b/` 但不匹配 `CLAIM|`），并补一条反向测试；测试里现有的坏行用例（test:475）仍以 `CLAIM|` 开头，覆盖不到这个洞。

### 严重度：中 — 禁用 plan-claims 委派后，文档自相矛盾，Mac 线程实际上无法跑这一步
- 文件：`.agents/instructions/model-review.md:42`；`scripts/model-review/delegate.mjs:57`；同文档 `:160-177`
- 问题：新增句写“这一步只能在云端线程或本机直接跑：`delegate.mjs` 不支持把它交给云端线程”。但同文档又说 Mac 线程没有模型凭证、不在本机跑复核、一律交给云端线程。两句话合起来等于 plan-claims 从 Mac 线程无法执行；而委派机制里缺少的只是一个 `--claims-file` 字段，并非无法支持（`reviewArgv` 已有 `--head`，再加一个受 `validClaimsFile` 校验的 `claimsFile` 即可）。
- 证据：`requireValue(MODES.includes(task.mode) && task.mode !== "plan-claims", "DELEGATE_INVALID mode");`；`:177` “Mac 线程不在本机跑复核，交给云端线程…”。
- 建议：把 `claimsFile` 加进 delegate 任务（校验 `validClaimsFile`）与 `reviewArgv`，而不是直接禁掉；若坚持禁用，把 `:42` 改成“只能在本机有凭证时直接跑，或由云端线程按原始命令直接执行，不能经 delegate 交接”。

### 严重度：低 — `CLAIMS_FLAGGED` 的位置字段仍可能带不可见/控制字符
- 文件：`scripts/model-review/opencode-review.mjs:1640-1642`、`:3366`；对比 `scripts/model-review/plan-claims.mjs:9`
- 问题：问题串改用了 `safe()`（覆盖 `\p{Cc}` 与 U+2028/2029），但 `CLAIMS_FLAGGED ... ${printable(claim.location)}` 用的 `printable` 只认 `< 32` 和 `127`，不认 C1 控制字符（如 U+009B）与 U+2028/U+2029。`claim.location` 是模型输出（不可信），可经 `.md` 存档原样进入这条日志，可能破坏行结构或注入终端控制序列。
- 证据：`hasControlCharacter` 为 `code < 32 || code === 127`；而 `safe` 为 `replace(/[\p{Cc}\u2028\u2029]/gu, "?")`。
- 建议：`printable` 改成与 `safe` 同集合，或该处直接用 `safe`/`JSON.stringify`；补一条带 U+009B 的反向测试。

### 严重度：低 — `safe()` 与行号/Unicode 相关加固没有自动检查
- 文件：`test/tooling/plan-claims-gate.test.mjs`（新增 10 条）
- 问题：`safe()` 对问题串的清洗、`printable(claim.location)`、以及 `claims-name-unsupported` 对控制字符文件名（只测了空格）都没有用例；若把 `safe` 去掉，现有测试不会失败。
- 证据：新增用例中 `claims-name-unsupported` 只用 `0301-has space.md`（:498），没有任何控制字符路径。
- 建议：加一条含制表符/换行（git 允许）的 ADR 文件名用例，断言消息单行且为 `claims-name-unsupported …?…`。

### 严重度：低 — 文档仍说账本 `mode` 只有“三种模式”
- 文件：`.agents/instructions/model-review.md:116`
- 问题：`MODES` 已是四种（含 plan-claims），同文档 `:155` 也已改成“四种模式”，但 `:116` 仍写“`mode` 只能是三种模式、`override` 或 `low-fix`”。
- 证据：`export const MODES = ["code-review", "plan", "plan-review", "plan-claims"];`
- 建议：改成“四种复核模式”。

### 严重度：低 — `claims-name-unsupported` 的触发面比文档写得宽
- 文件：`.agents/instructions/model-review.md:41`；`scripts/model-review/plan-claims.mjs:7`
- 问题：文档说“文件名里有空格或控制字符”会触发，实际 `CLAIMS_FILE_PATTERN` 只允许 Unicode 字母/数字加 `._/-`，全角冒号、引号、括号、emoji 等同样会触发。
- 建议：文档改为“文件名含有 `--claims-file` 不接受、且 `delegate`/CLI 无法传递的字符（目前是字母/数字/`._/-` 以外的字符）”。

## 二、推测（未完全核实）

- `at` 只要求 `Date.parse` 可解析（`opencode-review.mjs:1711`），因此没有时区的字符串会按本机时区解释，可能影响“最晚一轮”的选择。真实记录由脚本写成带 `Z` 的 ISO，故生产上一般无影响；若线程手写账本则可被利用。建议收紧成严格 ISO-8601 UTC。此点未用现有真实账本验证。
- `claimsProblems` 把 stale 记录的轮次目录并入 `files` 后，可由线程在该目录下放任意文件从而不算“未复核改动”。这些路径被限制在 `.agents/reviews/topic-*/round-N/` 且仍做密钥扫描，影响有限；未找到可借此隐藏源码改动的路径。

## 三、逐条回答必答问题

1. **会不会改变模型已见过的请求开头？**
   - 对 Himawari：不会。改动只涉及 `scripts/model-review/`、`.agents/instructions/model-review.md`、测试和复核记录，没有碰 `packages/`、`prompt-catalog` 或运行时提示组装。作者这句“不改变发给 Himawari 模型的任何内容”经文件范围核对成立。
   - 对复核模型：会，但仅限 plan-claims 模式。`buildPrompt` 对 plan-claims 删掉了 `RULE_16_SENTENCE` 并改了输出格式措辞（`opencode-review.mjs:279,309`）。这是对固定前缀的一次性修改；每轮变化的值（`head`/`base`/`previous`/ADR 全文）仍都在最后的 material 段（`:316-328`），追加式结构未被破坏。唯一实际后果：改动前已存在的 plan-claims 轮次若再用 `--round` 补跑，会因 `ROUND_PROMPT_MISMATCH`（`:1799`）失败，必须新开一轮——这属于有意的提示词版本变更，不是 append-only 违规（复核是单轮新会话，非同一对话续写）。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会因本改动新增不确定性。`safe` 是纯函数、`addedAdrs` 排序、模型/`at` 校验都是确定性的；`at`/模型属于账本而非提示词，不进模型输入。`files` 的集合顺序虽依赖账本顺序，但不进入任何模型请求。唯一与“时间”相关的是 `Date.parse(record.at)` 选最晚轮次（见“推测”第二点）。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   - 有：行号 0、坏答案行/坏 verdicts/坏账本、非法 ADR 名、Unicode ADR 名、stale 记录不算未复核、非法 model/at、双模型、delegate 拒绝、提示词移除第 16 条且要求全角竖线，共 10 条。按代码推理这些反向用例在修复前都会失败（例如行号 0 在旧逻辑 `0 > length` 为假会通过；stale 用例旧逻辑会把记录文件报成 `unreviewed`）。
   - 缺口：`safe()`/`printable()` 的控制字符处理、“看起来像 CLAIM 但格式不对”的行、`claims-name-unsupported` 的控制字符文件名，都没有用例（见上文）。

4. **新增/修改的每个值，两端都接受吗？**
   - `claims-name-unsupported`：产生于 `plan-claims.mjs:203`，消费方是 `OVERRIDABLE_PROBLEMS` 的 `"claims-"` 前缀（`opencode-review.mjs:1309`），可被 `--accept-unreviewed` 覆盖；文档 `:41` 也写了。一致。
   - `CLAIMS_FILE_PATTERN` 加 Unicode：`validClaimsFile` 同时用于 `parseArgs`（`:2762`）、`parseUsage`（`:1708`）、`claimsProblems`（`:202`），三处共用同一函数，且 CLI 产出的 `claimsFile` 由同一校验把关；新增 ADR 由更宽的 `ADR_PATH_PATTERN` 产生、再用 `validClaimsFile` 拦截，`claims-name-unsupported` 正好补上两端差集。一致（这正是 I-73 那类“清单值能否过后端校验”的检查）。
   - `plan-claims` 记录要求 `at` 可解析、`model∈REVIEW_MODELS`：产生端 `runOne` 写的是 `new Date().toISOString()` 和 `REVIEW_MODELS` 里的全名（`:3267-3270`），消费端 `parseUsage`（`:1706-1712`）与 `delegate.mjs:320` 期望一致；`claimsProblems` 用 `model.split("/").pop()` 找答案文件名，也与运行端 `model.split("/").pop()` 命名一致。一致。
   - `safe()` 只用于问题串；`CLAIMS_FLAGGED` 用的是 `printable`，两者覆盖面不一致（见上文低危项）。

## 四、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性）

- 不可信输入：模型产出的 `location` 经 `printable` 后仍有 C1/U+2028 注入面（低危，见上）；`claim.id`/`verdict` 有白名单，`code`/`sentence` 不进日志。`safe` 覆盖了账本路径、ADR 名、模型短名、verdict 错误信息。
- 错误路径：坏账本、坏 verdict 文件、缺答案、零 CLAIM、缺失位置、越界行号、非法文件名均有明确问题串；`claims-name-unsupported` 不会静默放过。
- 资源耗尽：本增量没有新增无界循环或外部进程；`git show` 的 256MB `maxBuffer` 与逐轮 `ls-tree` 是既有行为，未见新风险。
- 不可撤销操作：本增量只读 git 与打印日志，`--assert-reviewed` 只在 `--apply`/override 路径写账本，未因本次改动扩大写入面。
- 文档一致性：发现三处（`:157` 第 16 条、`:116` 三种模式、`:42` 云端线程/委派矛盾），另 `:31` “格式坏了的行”与解析器不符。

## 五、附：作者说法核对
- “只改增量、不改变发给 Himawari 的内容”：属实（文件范围可证）。
- “delegate 拒绝 plan-claims、文档写明”：代码属实；但文档 `:42` 表述矛盾（见上）。
- “parseUsage 要求 at 可解析、model 属于两个复核模型”：属实。
- “stale 记录目录也算记录文件”：属实（`plan-claims.mjs:207-220` 在 `matching` 判断之前收集）。
- “claims 问题串过 `safe()`”：问题串基本属实；`CLAIMS_FLAGGED` 的 location 仍走 `printable`，不算完全覆盖。
- “新增 claims-name-unsupported、CLAIMS_FILE_PATTERN 允许 Unicode”：属实。
- “行号 >=1、提示去第 16 条、竖线换全角”：属实。
- “文档改成弱保证/写明不防有意/引文遮盖报 claims-evidence/序号只要求不重复”：逐条核对属实（引文最短 4 字符、`EVIDENCE_MIN_CHARS=8` 也与文档一致）。
- “未改：错误说法判一致且引无关真实代码不拦”：属实，属于已声明的局限。
- “新增测试 10 条”：属实，但覆盖缺口见 Q3。
