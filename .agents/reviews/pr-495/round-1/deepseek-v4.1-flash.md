## 复核意见

### 1、中：AGENTS.md 与移动后的规则文件对“是否必须先读”给出相反指令，可能让代理跳过整条只追加规则
- 文件:行：`AGENTS.md:43`；`.agents/instructions/prompt-prefix.md:4`
- 问题：入口文件先说“设计或修改……之前，先读”，紧接着又说“那份规则不在开局自动载入，所以动手前先问自己这几个问题，只要有一个答‘会’或‘不确定’，就先去读它”。后一句可被读成“五问都为‘不会’就不用读”，与规则文件本身“凡是组装或修改发给模型的内容，都要先读它”不一致。这是本 PR 的核心规则，若代理按宽松读法执行，等于把规则从“自动载入”降成“自评后才读”。
- 证据：
  - `AGENTS.md:43`：“设计或修改任何发给模型的上下文……之前，先读 [.agents/instructions/prompt-prefix.md]：……那份规则不在开局自动载入，所以动手前先问自己这几个问题，只要有一个答“会”或“不确定”，就先去读它”
  - `.agents/instructions/prompt-prefix.md:4`：“凡是组装或修改发给模型的内容，都要先读它。”
- 建议：统一成一种约束。若要保持原约束力，写成“先读规则，再用五问自检”；若确实要改成条件加载，就同时改规则文件第 4 句，并说明 AGENTS.md 摘要也承担约束，避免两处文字互相拆台。
- 读代码证实。

### 2、中：`--open` 把 `仓库外` 排除在“未结”之外，I-09（次数 7）不再出现在开工视图
- 文件:行：`scripts/check-incident-gates.mjs:10`；`.claude/rules/incident-gates.md:9`；`docs/incidents-and-gates.md:18,26-27,48`
- 问题：新规则让线程只运行 `--open` 看未结条目，而脚本只认 `缺门槛`、`等 Andy`。`仓库外` 的 I-09 次数已达 7，且正好讲的是云端/Mac 授权问题，却不会被打印；作者材料里“96 条里 5 条未关闭”也把这 1 条算成了已关闭。这与“不改变任何规则约束力”的目标有张力：以前开工时通读整份清单会看到它。
- 证据：
  - `scripts/check-incident-gates.mjs:10`：`const OPEN_STATES = new Set(["缺门槛", "等 Andy"]);`
  - `docs/incidents-and-gates.md:27`：`| 仓库外 | 原因在仓库管不到的地方（例如 Claude Code 自己的权限检查），写明替代做法 |`
  - `docs/incidents-and-gates.md:48`：I-09 行，次数 `7`，状态 `仓库外`。
- 建议：把 `OPEN_STATES` 改成“除 `已落门槛` 外的所有状态”，或单独输出 `仓库外` 条目并标明“仓库外/替代做法”；同时在文案里写清 `仓库外` 是否算“未结”，不要一边说“未结条目”一边静默省略次数最高的未解决事故。
- 读代码证实（状态集合与 I-09 事实）；对“影响线程行为”的判断属推断。

### 3、低：清单缺失或解析失败时，`--open` 仍打印 `count=0 total=0`，容易被读成“没有未结条目”
- 文件:行：`scripts/check-incident-gates.mjs:26-27,42-45,98-101`
- 问题：`checkIncidentGates()` 在清单文件不存在或表头缺失时返回空 `incidents` 并带错误；CLI 仍走 `--open` 分支，输出 `INCIDENT_OPEN count=0 total=0`，只是后面再输出失败行。按新规则“运行 --open 看未结条目”的代理如果只抓取 `INCIDENT_OPEN` 这一行，会把读取失败误当成“没有未结条目”。
- 证据：
  - `:27`：`if (header < 0) return { incidents: [], errors: ["INCIDENT_TABLE_MISSING"] };`
  - `:44-45`：`if (!existsSync(file)) return { incidents: [], errors: [\`INCIDENT_LIST_MISSING ${INCIDENT_LIST}\`] };`
  - `:99-101`：无论是否有 `errors`，都执行 `const lines = openIncidentLines(incidents); ... INCIDENT_OPEN count=${lines.length} total=${incidents.length}`。
- 建议：`errors.length > 0` 时不要输出成功式的计数行，改成 `INCIDENT_OPEN unavailable errors=N` 或直接跳过；补一条“清单缺失/表头缺失时不得打印 count=0”的反向测试。
- 读代码证实。

### 4、低：新增测试没有接进 `npm run check`，当前 fast 模式下合并前不会运行
- 文件:行：`package.json:27,30`；`test/tooling/incident-gates.test.mjs:106-131`
- 问题：`check:incident-gates` 只运行 `node scripts/check-incident-gates.mjs`，不运行 `test/tooling/incident-gates.test.mjs`；仓库当前 `DELIVERY_MODE=fast`，fast 模式不跑第 3 层测试。也就是说 `--open` 的筛选、截断和 CLI 输出在合并前没有任何门槛。CLI 用例本身也只校验编号集合和 `toContain(INCIDENT_OPEN...)`，没有断言退出码、行顺序，也没有覆盖错误路径。
- 证据：
  - `package.json:30`：`"check:incident-gates": "node scripts/check-incident-gates.mjs"`
  - `package.json:27` 的 `check:steps` 中只有该命令，没有 `vitest ... incident-gates.test.mjs`。
  - 测试 `:128-130`：`const rows = output.split("\n").filter((line) => /^I-\d/.test(line)); ... expect(output).toContain(\`INCIDENT_OPEN count=...\`)`。
- 建议：把该测试接到 `check:incident-gates`（`node ... && vitest run --project tooling test/tooling/incident-gates.test.mjs`），并补退出码、输出顺序和错误路径断言。
- 读代码证实。

### 5、低：作者说法“最后一行 INCIDENT_OPEN”与代码不符
- 文件:行：`scripts/check-incident-gates.mjs:98-105`
- 问题：`--open` 先打印各条目和 `INCIDENT_OPEN`，随后仍打印原有的 `INCIDENT_GATES ...`，所以最后一行不是 `INCIDENT_OPEN`。
- 证据：`:101` 写 `INCIDENT_OPEN ...`，`:103-105` 之后才写 `INCIDENT_GATES ...`。
- 建议：修正作者说明；若确实希望 `INCIDENT_OPEN` 是最后一行，把它移到 `INCIDENT_GATES` 之后，并在测试里断言顺序。
- 读代码证实。

### 6、低：两处历史交接文件仍链接旧路径，链接已经断掉
- 文件:行：`.agents/handoffs/2026-11-05-opencode-review-findings.md:215`；`.agents/handoffs/2026-11-05-opencode-review-plan-t2-t3-t5-t6.md:84`
- 问题：文件已从 `.claude/rules/prompt-prefix.md` 移到 `.agents/instructions/prompt-prefix.md`，这两处仍指向旧路径。作者说“有意不改历史记录”，但本次约束写的是“文档里的相对链接必须仍然有效”；`check:instruction-links` 只扫描 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`，不会发现这两条。
- 证据：
  - `...findings.md:215`：`[只追加规则](../../.claude/rules/prompt-prefix.md)`
  - `...plan-t2-t3-t5-t6.md:84`：`[只追加规则](../../.claude/rules/prompt-prefix.md#rules)`
- 建议：更新这两处路径，或把历史文件显式排除并加一条说明；否则“链接都有效”的说法不成立。
- 读代码证实。

### 7、低：`firstSentence` 按 UTF-16 代码单元截断，可能切裂代理对
- 文件:行：`scripts/check-incident-gates.mjs:78-84`
- 问题：`sentence.length` 和 `sentence.slice(0, SHORT_SYMPTOM_LENGTH)` 操作的是 UTF-16 代码单元，不是 Unicode 字符；现象里若有 emoji 等增补平面字符，截断点可能落在代理对中间，输出半个字符。测试也没有覆盖 80/81 边界和增补平面字符。
- 证据：`:81-83`：`return sentence.length > SHORT_SYMPTOM_LENGTH ? \`${sentence.slice(0, SHORT_SYMPTOM_LENGTH)}…\` : sentence;`
- 建议：用 `Array.from(sentence).slice(0, SHORT_SYMPTOM_LENGTH).join("")` 按码点截断，并补边界与 emoji 用例。
- 读代码证实。

### 8、低：改写 36 份已接受 ADR 正文，与 `docs/glossary.md` 的“历史记录不重写”有张力
- 文件:行：`docs/glossary.md:63`
- 问题：本次为保持路径有效改写了大量已接受 ADR（`git diff --name-status` 里 36 个 `docs/adr/*.md`）。`docs/glossary.md:63` 写明“已经通过的 ADR 正文和归档文档：历史记录不重写”。虽然不改这些链接 `check:docs-links` 会失败，实际取舍是必要的，但这是一次未记录在案的惯例例外。
- 证据：`docs/glossary.md:63`：“已经通过的 ADR 正文和归档文档：历史记录不重写，在这里记‘旧叫法 → 新叫法’即可。”；`git diff --name-status` 显示 `M docs/adr/...` 共 36 份。
- 建议：在 glossary 或本 PR 说明里记明“移动规则文件导致的路径更新例外”，或统一采用固定旧路径重定向；不要留下“以后到底改不改历史 ADR”的模糊状态。
- 读代码证实的只是事实与规则并存；是否必须改属项目裁定，暂列为推测性风险。

## 侧重检查

- **错误路径**：查了清单文件缺失、表头缺失、行格式错误三条路径。行格式错误仍由原有 `checkIncidentGates` 报错并退出 1；但清单缺失/表头缺失时 `--open` 仍输出 `count=0`（意见 3）。
- **不合规范/不可信输入**：`openIncidentLines` 只读仓库内 Markdown 表格字段，不执行、不写文件；`symptom` 用 `?? ""` 兜底。表格单元格里的原始 `|` 会被现有 `cells()` 先切坏列，这不是本 PR 新增的问题，但说明 `--open` 的输出格式继承了解析器的这一限制。
- **安全**：脚本只读 `docs/incidents-and-gates.md` 并写 stdout，没有网络、密钥、文件写入或命令执行；症状文本进入代理上下文，但旧流程本来就会通读同一文件，攻击面没有变大。
- **资源耗尽**：线性扫描 96 行、每行最多约 80 字符，没有循环放大或外部调用，无明显风险。
- **不可撤销操作**：本 PR 没有删除、覆盖或生产操作；`--open` 是只读。
- **规则、文档、代码一致性**：
  - 规则文件内容逐字节未变（`git diff` 显示 `R100`），`../../` 相对链接深度未变，已核对。
  - `AGENTS.md` 引用的 `#fast-mode`、`#plan-discussion`、`#plan-claims`、`#code-review`、`#owner-control`、`#delegate`、`#checklist` 锚点均存在。
  - 作者说法 3 列出的细节已逐项找到：`delivery-mode.md#fast-mode` 有 CI 长期授权、草稿 PR、CI VPS；`model-review.md#code-review` 有分级、轮次、`--accept-low`、`--accept-unreviewed`；`#delegate` 有 Mac 交接；`pi-development-guide.md` 第 4 条有“现有偏离不是范本”。
  - 作者说法 1 的“最后一行 INCIDENT_OPEN”不准确（意见 5）。
  - 作者说法 2 的“引用都已改路径”对扫描范围成立，但 `.agents/handoffs` 两处旧链接已断（意见 6）。
  - 作者说法 4 成立：本 PR 未改 `packages/prompt-catalog` 或任何 Himawari 运行时请求组装代码。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会改变 Himawari 发给模型的请求内容。改动只涉及编码代理的指令文档、开发用检查脚本和测试；`packages/prompt-catalog`、`packages/runtime-pi` 等运行时路径均未改动。移动的 `prompt-prefix.md` 是给编码代理的规则文件，不是 Himawari 的系统提示或工具定义。对云端编码线程而言，每个线程是新会话，不存在“已经见过的前缀”；同一线程中途读取文件也属于在末尾追加。因此“只在末尾追加、每轮变化的值都在最后一条消息里”这条运行时约束没有被这次改动破坏。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新脚本输出只依赖清单文件的固定顺序和文件内状态/日期/现象，`filter` 保留原数组顺序，不遍历无序集合，不含时间、随机数或哈希；`firstSentence` 是纯函数。移动后的规则文件是 100% 相似重命名，内容字节完全不变。遮盖逻辑没有改动。

**3. 有没有对应的自动检查，反向用例真的会失败？**
部分有：`test/tooling/incident-gates.test.mjs` 新增了“只列缺门槛/等 Andy”“截断到 80 字”“CLI 输出编号与 `INCIDENT_OPEN` 计数”的用例，状态筛选或截断被改坏时这些用例会失败；移动文件涉及的 `check:instruction-links`、`check:docs-links` 仍会检查扫描范围内的链接。但缺口也很明确：
- 这些测试没有接进 `npm run check`，当前 fast 模式下合并前不跑（意见 4）。
- 没有覆盖清单缺失/表头缺失时不得输出 `count=0` 的反向用例（意见 3）。
- 没有覆盖 `仓库外` 是否应显示的用例（意见 2）。
- `.agents/handoffs` 不在链接检查范围，旧链接断了也不会失败（意见 6）。
- CLI 用例没有断言退出码和行顺序（意见 4、5）。

**4. 新增/修改的每个值，生产方和使用方两端都能接受吗？**
逐个核对如下：
- `--open`：脚本用 `process.argv.includes("--open")` 识别；使用方 `.claude/rules/incident-gates.md:9` 和 `docs/incidents-and-gates.md:18` 的命令拼写一致，能接受。
- `INCIDENT_OPEN count=N total=M`：只有测试使用，`toContain` 的模板与代码一致。
- 行格式 `编号 | 状态 | 日期 | 现象`：测试按 `line.split(" | ")[0]` 取编号，状态值来自现有 `INCIDENT_STATES`，能接受。
- 导出函数 `openIncidentLines`：只有 CLI 和测试使用，签名一致。
- 新路径 `.agents/instructions/prompt-prefix.md`：`AGENTS.md`、`docs/`、`model-review.md`、`packages/sensitive-capture/README.md` 的扫描内引用都已更新；锚点 `#rules`、`#order`、`#append-only`、`#deterministic`、`#compaction`、`#before-you-change` 均存在；`docs/adr/0232` 的 `:67` 行号、`docs/adr/0262` 的第 43/53 行号也仍正确（文件内容字节未变）。**不通过的两端**是 `.agents/handoffs` 的两处旧路径链接（意见 6），以及 `仓库外` 状态在“未结”定义上的不一致（意见 2）。
- `OPEN_STATES` 与 `INCIDENT_STATES` 当前一致（前者是后者的真子集）；将来若新增状态，`--open` 会静默漏掉，建议改为从状态表推导。

**作者说法核对结论**：说法 1 基本成立，但“最后一行 INCIDENT_OPEN”不成立（意见 5），且“5 条未关闭”忽略了 `仓库外` 的 I-09（意见 2）；说法 2 对已扫描文件成立，但 `.agents/handoffs` 两处引用已断（意见 6）；说法 3 列出的细节确实都在被链接文件里；说法 4 成立。
