## 一、增量与作者说法核对（先看 git）

- `git diff --name-status 831db506..b7491e32` 只有 `.agents/reviews/pr-271/round-2/*` 和 `usage.jsonl`，作者说“b7491e32 只加复核记录”成立。
- `git show --pretty=raw 8a888223`：父提交是 `b7491e32` 和 `27e1d332`；`27e1d332` 是 PR 268 的合并提交。`git diff --name-status b7491e32..8a888223` 确实是 PR 268 的代码/文档/复核记录，没有夹带别的 main 改动。
- `package.json` HEAD 同时包含两边的改动：第 27 行 `check:steps` 有 5 个交付/声明步骤，第 41–45 行有对应脚本，第 50 行 `check:prompt-catalog` 包含 PR 268 的三个测试文件。没有同一行被覆盖。
- PR 268 新增/修改的三个测试文件都已接进某个 `check:*`：
  - `apps/agent-service/test/trusted-prompt-egress.unit.test.ts`
  - `packages/sensitive-capture/test/trusted-text.unit.test.ts`
  - `apps/control-center/test/sensitive-interceptions.unit.test.ts`
  都在 `package.json:50` 的 `check:prompt-catalog` 中，而 `check:prompt-catalog` 在 `check:steps` 中（`package.json:27`）。三个测试对应的 vitest project 也确实包含它们（`ci/policy.json:196` 的 `unit`、`vitest.workspace.ts:66` 的 `browser`、`vitest.workspace.ts:81` 的 `node-services`）。
- `test/tooling/run-all-checks.test.mjs:54-65` 只断言 5 个交付步骤的存在与精确命令；它不检查 `check:prompt-catalog` 的内容，所以 PR 268 改那一行不会和这个断言冲突。`check:steps` 顺序也没有交叉依赖：交付步骤都在 `check:check-runner` 之前。
- “第 2 轮 judgments 没有会出错意见”**未核实**：`.agents/reviews/pr-271/round-2/judgments.md` 在工作树读不到，`git show` 也被规则拒绝（`REVIEW_GIT_REFUSED records-path`）。

## 二、侧重检查

- **错误路径**：读了 `model-egress.ts:476-485`、`redaction.ts:227-236`。修复路径里 `redactForEgress` 现在可能抛 `EgressRedactionError`，生产路径会转成 `refuse("trusted text could not be restored")`，即拒绝发送。该分支没有测试覆盖。
- **不合规范/不可信输入**：检查了固定文字扫描、填充字符选择、点名值（`known`）与固定文字的交叉、部分重叠、全部 34 个填充字符、攻击者重复固定文字等情况。没有发现能直接读出未知秘密的新路径；但固定文字里的关键词不再作为上下文（这是 I-78 的设计取舍），因此数据里“看似验证码但自己没有关键词”的数字会比修复前少遮。
- **安全**：固定文字来自代码里的提示词目录，是公开文字，不是用户秘密；没有新增日志输出秘密；工具定义仍被 `DEFINITION_KEYS` 跳过（既有行为）。
- **资源耗尽**：新扫描会为每个文本片段对所有 trusted 字符串做 `indexOf`，并对重叠出现逐个入数组；含 trusted 文字时整套规则会跑两遍（rehearsal + 实际）。没有输入上限或规模测试。
- **不可撤销操作**：PR 271 的交付测试只在 `TemporaryDirectory` 里生成 packet、SQLite、临时 HTTP 服务；`test_rollback.py` 不执行真实回退。合并进来的代码只改出口遮盖，没有新的不可撤销生产操作。
- **规则/文档/代码一致**：规则第 53 行、I-78 行、`check-incident-gates`、`check-instruction-links` 的路径/锚点都核对过。`docs/incidents-and-gates.md:32` 有 `incidents` 锚点，I-78 行中反引号路径都实际存在。发现的规则冲突和常量重复见下。

## 三、读代码证实的问题（按严重度）

### 1. 中：固定文字清单按“当前构建”生成，目录更新后老对话开头可能被重遮
- 文件：`.claude/rules/prompt-prefix.md:53`、`packages/prompt-catalog/src/trusted.ts:10-14`、`packages/application/src/services/model-egress.ts:198`
- 证据：
  - `trusted.ts:10`：`export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts([background, chat, mail, memory, review, runtime, tools].flatMap(...))`
  - `model-egress.ts:198`：`trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS,`
  - 规则自己写明：`以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；旧文字里如果有会被认成敏感信息的数字，那个对话的请求开头会变一次。`
- 问题：清单只在模块加载时按当前目录生成，没有任何按对话冻结的清单或版本绑定。发版改了目录文字后，老对话冻结的旧系统提示/历史中的旧文字不再命中 trusted，会按外来内容重遮。这与同一规则第 51–52 行的“每次同样字节、只依赖自己和前面内容”相冲突；也与本题第 1 问“只在末尾追加”不完全一致。
- 建议：在对话冻结系统提示时同时冻结当时的 trusted 清单或目录版本，发送时使用冻结清单；或把历史版本目录文字并入清单。若团队接受“目录更新时变一次”，应把第 10/11 条改成明确的例外并写审批依据；补一个“旧冻结文字不在当前清单”的回归测试。

### 2. 中：重叠出现枚举与双跑规则带来资源放大
- 文件：`packages/sensitive-capture/src/redaction.ts:186-203`、`210-236`
- 证据：
  - `redaction.ts:188-193`：`for (let position = input.indexOf(value); position >= 0; position = input.indexOf(value, position + 1)) found.push([position, position + value.length]);`
  - `redaction.ts:227-233`：先 `redactUntrusted(view, {...})` 做 rehearsal，再 `redactUntrusted(view, options)` 做实际遮盖。
- 问题：每个文本片段都要对全部 trusted 字符串做 `indexOf`，重叠出现逐个入数组并排序；含 trusted 文字时整套正则跑两遍。trusted 文字来自公开的提示词目录，攻击者可控的网页/工具结果可以重复这些公开字符串来放大 CPU/内存。代码里没有输入上限、出现次数上限或规模测试。
- 建议：给输入/出现次数设上限；用单次扫描或区间合并代替“每个 value 全量 indexOf + 大数组”；用一个可观察标记代替 rehearsal 的双跑；补大输入测试。
- 说明：算法本身已读代码证实；“实际能否被外部内容利用”属于推测，未运行验证。

### 3. 低：部分重叠的固定文字会有一部分漏保护
- 文件：`packages/sensitive-capture/src/redaction.ts:195-202`
- 证据：
  - `found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);`
  - `if (span[0] < cursor) continue; spans.push(span); cursor = span[1];`
- 问题：如果一个较长的 trusted 文字从较晚位置开始、与一个较早开始的较短 trusted 文字部分重叠，较长的会被跳过，尾部按外来内容检查。若尾部含数字/关键词，就可能把固定文字遮掉，重新出现 I-78 类问题。现有测试只覆盖“同一起点取最长”（`trusted-text.unit.test.ts:44-49`），没有覆盖部分重叠。
- 建议：对所有重叠区间求并集，而不是贪心丢弃；或在测试中断言目录文字两两之间不存在“部分重叠”，并补一个部分重叠用例。
- 说明：算法行为已读代码证实；“当前目录是否真的触发”未核实（未运行测试）。

### 4. 低：24 字下限在两个包各写一份，测试只校验其中一份
- 文件：`packages/prompt-catalog/src/entry.ts:59`、`packages/sensitive-capture/src/redaction.ts:172`、`packages/sensitive-capture/test/trusted-text.unit.test.ts:119`
- 证据：`export const TRUSTED_TEXT_MINIMUM_LENGTH = 24;` 与 `export const TRUSTED_TEXT_MINIMUM_CHARACTERS = 24;`；测试只写 `expect(TRUSTED_TEXT_MINIMUM_CHARACTERS).toBe(24);`
- 问题：`trusted.ts` 用前一个常量生成清单，`redactForEgress` 用后一个常量再次过滤；两边以后若只改一处，会出现“清单里有但被过滤掉”或反之，且现有测试不会发现。
- 建议：只保留一个共享常量，或加一条两边相等的断言。

### 5. 低：新增的 `EgressRedactionError` 拒绝分支没有测试
- 文件：`packages/sensitive-capture/src/redaction.ts:235`、`packages/application/src/services/model-egress.ts:476-485`
- 证据：`if (text === undefined) throw new EgressRedactionError();`；`catch (error) { if (error instanceof EgressRedactionError) refuse("trusted text could not be restored"); ... }`
- 问题：rehearsal 的目的是让这条实际运行分支不可达；一旦未来规则/标签变化导致可达，合法请求会被拒绝（可用性问题），而不是退回 `redactUntrusted`。现有 12 个 trusted 用例都没有覆盖这条分支。
- 建议：补一个强制 `restoredText` 失败的测试；或者恢复失败时退回 `redactUntrusted(input, options)`，与“规则碰到固定文字就整段按原方式检查”保持一致。

### 6. 低：回退测试没有覆盖 `main()` 的执行顺序，且用的不是冻结 packet
- 文件：`scripts/delivery-mode/test_rollback.py:130-138`、`scripts/delivery-mode/rollback.py:83-84`、`scripts/delivery-mode/test_rollback.py:57-61`
- 证据：
  - 测试只比较 `self.plan['restoreAction']` / `controlAction` 与 `run-step.py` 的表：`self.assertIn(self.plan['restoreAction'], maintenance)`、`assertRegex(step_table, ...)`。
  - `rollback.py:83-84` 的实际执行顺序是 `step(packet, plan['restoreAction'])` 再 `step(packet, plan['controlAction'])`，测试没有断言这两行。
  - `packet_from_template` 只是把 template 的 `bindings.draft.json` 里的 `S0_DB:` 替换掉后写成 `bindings.json`，没有填 `PENDING:`、`status`、`approvals`。
- 问题：831db 的提交说明称“回退计划测试能发现恢复和控制动作写反”，但测试只能发现**常量/步骤表**写反；如果把 `main()` 里的两行调用顺序对调，测试仍会通过（真实运行中控制动作大概率会因缺少恢复报告而失败，但测试本身发现不了）。另外，`test_generated_approval_passes...` 用的是 draft 派生的非冻结 binding，只验证 `rollbackApprovalExpectation`，没有走完整冻结 packet 校验。
- 建议：用假 `step`/假 `remote` 对 `main()` 做顺序断言，或直接检查源码顺序；保留一个真实冻结 packet 的集成用例（例如继续支持 `ROLLBACK_TEST_PACKET`），合成模板用例作为快速检查。

## 四、推测 / 未核实

- **目录更新导致老对话开头变化**：具体某个对话是否会变，取决于它的冻结文字是否在被修改的目录文字里、以及是否含会被规则命中的数字。规则第 53 行自己承认会变一次；我未运行跨版本复现。
- **部分重叠是否在现目录触发**：未运行测试，未核实当前 catalog 是否有“较短文字先出现、较长文字后出现且部分重叠”的组合。
- **`EgressRedactionError` 是否可达**：未核实；按 rehearsal 设计应不可达，但没有测试/穷举证明。
- **资源放大在生产中的实际影响**：未做基准测试，未核实具体延迟/内存数值。
- **所有测试是否实际通过**：本次只能 read/grep/glob 和 git，未运行 `npm run check`、vitest 或 Python 测试；以上只确认了文件存在、命令字符串、project include 和两端字段/常量一致。
- **第 2 轮 judgments 内容**：路径被规则拒绝读取，未核实“没有会出错意见”的说法。
- **PR 268 合并冲突**：已确认是双亲合并且 `package.json` 两边内容共存；没有全仓扫描冲突标记。

## 五、必答问题逐条回答

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？
- **PR 271 自身（交付测试、check 接线、`test_rollback.py`）不改变模型请求**，因此不影响前缀。
- **合并进来的 PR 268 不往系统提示、工具定义或历史里加新的每轮变化值**；在同一个构建内，仍然是“固定前缀 + 变化的最后一条消息”。`TRUSTED_PROMPT_TEXTS` 是构建常量，不是每轮值；工具定义仍被 `model-egress.ts:447-449` 跳过。
- **但严格说“只追加”有例外**：目录文字改变后，老对话冻结的旧文字不在当前清单里，会按外来内容重新遮盖；规则第 53 行明确写“那个对话的请求开头会变一次”。因此回答是：**同一构建内基本只追加；跨目录版本会改已发过的开头**，不能无条件说“永远只追加”。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
- **同一构建、同一段文字、同一前缀/`known` 集合下：不会**。`TRUSTED_PROMPT_TEXTS` 排序并冻结（`trusted.ts:10-14`），filler 选择按固定顺序（`redaction.ts:215-217`），算法无时间字段、无无序集合；`trusted-prompt-egress.unit.test.ts:186-191` 也断言同一请求两次字节相同。
- **跨构建/目录版本：会**。同一段旧固定文字可能从 trusted 变成外来内容，遮法改变（规则第 53 行承认）。
- **既有例外仍在**：`known` 点名值、压缩会改变后续消息的遮法；filler 选择依赖 `known`，但只在“已知值包含候选填充字符”的碰撞场景才可能改变输出。这些不是本 PR 新引入的，但会影响“同一段文字”的字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
- 有：
  - `packages/sensitive-capture/test/trusted-text.unit.test.ts` 覆盖 trusted 正常路径、回退、点名值、filler 碰撞；第 10 行是明确的“无 trusted 时仍遮盖”反向用例。
  - `apps/agent-service/test/trusted-prompt-egress.unit.test.ts` 走 `createProductionModelEgress` 的真实链路；第 99–107 行是 `trusted: []` 的反向用例。
  - `apps/control-center/test/sensitive-interceptions.unit.test.ts:100` 是 chat 记录的 REVERSE 用例。
  - `test/tooling/run-all-checks.test.mjs:54-65` 断言 5 个交付步骤和精确命令；第 68–70 行是“步骤不是 npm 脚本就拒绝”的反向用例。
  - `test_rollback.py:135-138` 新增了恢复/控制动作与步骤表的断言。
- 反向用例按代码逻辑**会失败**：去掉 trusted 后 `MEMORY_CAPTURE` 的 `1000` 会被识别成验证码（测试第 10、99 行都依赖这一点）；但**我没有运行测试**，所以“实际通过”未核实。
- 缺口：无跨目录更新（旧冻结文字）测试；无部分重叠测试；无 `EgressRedactionError` 分支测试；`test_rollback` 不测 `main()` 执行顺序。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？
逐项核对结果：
- **`check:delivery-packet` / `check:delivery-deploy` / `check:delivery-rollback` / `check:delivery-cleanup` / `check:untested-claims`**：产生于 `package.json:41-45`；被 `check:steps:27` 引用；被 `scripts/run-all-checks.mjs:6-12` 解析为“必须是 `npm run <name>`”；被 `test/tooling/run-all-checks.test.mjs:54-65` 断言精确命令。两端一致。
- **PR 268 三个测试文件路径**：`package.json:50` 引用；文件存在；`node-services`、`unit`、`browser` 三个 project 的 include 都能接受（`vitest.workspace.ts:66,81`、`ci/policy.json:196`）。
- **`trusted` 选项**：`model-egress.ts:198` 传入 `readonly string[]`；`redaction.ts:53,210-212` 按 `readonly string[]` 使用并过滤长度。两端一致。
- **`TRUSTED_PROMPT_TEXTS`**：`trusted.ts:10-14` 生成并 `Object.freeze`；`model-egress.ts:198` 作为默认值；测试 `trusted-prompt-egress.unit.test.ts:127,145` 断言包含 `MEMORY_CAPTURE.text` 且每项 >=24。两端一致。
- **I-78**：`docs/incidents-and-gates.md:116` 生成表格行；`.claude/rules/prompt-prefix.md:53` 链接到 `#incidents`；`docs/incidents-and-gates.md:32` 有锚点；`check-incident-gates.mjs:65-70` 会检查反引号路径存在。行内列出的 `trusted.ts`、`redaction.ts`、三个测试文件都存在，日期/次数/状态也符合校验。
- **`EgressRedactionError`**：`redaction.ts:513` 定义并导出；`packages/sensitive-capture/src/index.ts:3` 通过 `export * from "./redaction.js"` 导出；`model-egress.ts:7,483` 导入并捕获。两端一致。
- **24 字下限**：`entry.ts:59` 与 `redaction.ts:172` 都是 24，当前一致；但重复定义，见问题 4。
- **回退测试的值**：`test_rollback.py:31-44` 的 `S0_READBACK` 覆盖了 `bindings.draft.json` 中全部 `S0_DB:` 键（`bindings.draft.json:97-144`）；`CURRENT_SCHEMA` 来自 `fixtures/twelfth-parameters.json:14`；`test_rollback.py:135-138` 的 `MAINTENANCE_ACTIONS` / 控制动作映射与 `run-step.py:19,36` 一致。两端一致。

**总体结论**：作者对增量和接线的描述与代码一致；合并没有改变 PR 271 的交付步骤，PR 268 的三个测试都已接进 `check:prompt-catalog`。没有发现会阻断合并的新问题，主要风险是跨目录版本的请求前缀变化、可能的资源放大、部分重叠的固定文字漏保护，以及几个测试/常量维护点。
