本轮查过的范围：先看了 `git diff 120fdd9..d35f8c4` 的完整改动，再重点看了 `git diff 8aada011..d35f8c4` 的增量；读了 `scripts/check-incident-gates.mjs`、`test/tooling/incident-gates.test.mjs`、`.claude/rules/incident-gates.md`、`docs/incidents-and-gates.md`、`AGENTS.md`、移动后的 `.agents/instructions/prompt-prefix.md`、`.agents/instructions/model-review.md`，以及 `package.json`、`ci/policy.json`、`scripts/ci/run.mjs` 和 `scripts/run-all-checks.mjs` 里的使用端。上一轮复核记录没有读到（当前环境的 git 替身拒绝带 `.agents/reviews` 的路径），所以只按增量 diff 和代码核对。测试没有实际运行（本轮只允许读代码和 git）。

### 1、中、`--open` 在任何校验错误时都隐藏未结清单，和规则写明的“清单读不出来才隐藏”不一致

**文件:行** `scripts/check-incident-gates.mjs:98-99`，`.claude/rules/incident-gates.md:9`

**问题** 代码只要 `errors.length > 0` 就打印 `INCIDENT_OPEN unavailable`，包括清单能正常读出的情况，例如某条已落门槛条目引用的门槛文件不存在（`INCIDENT_GATE_PATH_MISSING`）、次数达到 3 却没有硬门槛（`INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE`）。这时未结条目本来可以正常打印，却全部被隐藏。规则文件把这个信号解释为“清单本身格式坏了或找不到，读不出条目”，两者不一致；作者的说法“清单读不出来时只打印……”也不准确，因为出错时还会继续向 stderr 打印错误行、向 stdout 打印 `INCIDENT_GATES failed`。

**证据（读代码证实）**
```js
if (process.argv.includes("--open") && errors.length > 0) {
  process.stdout.write(`INCIDENT_OPEN unavailable errors=${errors.length}\n`);
```
```js
if (count >= 3 && !HARD_GATE_STATES.has(incident.state))
  errors.push(`INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE ${where} count=${count}`);
...
for (const relative of paths)
  if (!existsSync(path.join(root, relative)))
    errors.push(`INCIDENT_GATE_PATH_MISSING ${where} ${relative}`);
```
规则原文：“只有命令打印 `INCIDENT_OPEN unavailable`（清单本身格式坏了或找不到，读不出条目）时，才直接打开清单查看，并先修好清单。”

**建议** 二选一：
1. 只把“读不出/解析失败”类错误（`INCIDENT_LIST_MISSING`、`INCIDENT_TABLE_MISSING`、`INCIDENT_TABLE_COLUMNS_CHANGED`、`INCIDENT_TABLE_EMPTY`）当作 `unavailable`，其余校验错误照常打印未结清单并保留 `INCIDENT_GATES failed`；
2. 如果确实要保持“任何错误都不打印清单”，把规则和作者说法改成“清单有任何校验错误”，并补一条“清单可读但门槛文件缺失”的测试，锁住这个行为。

### 2、低、作者说 `.agents/handoffs` 有意不改，但本次改动实际改了两个 handoff 文件

**文件:行** `.agents/handoffs/2026-11-05-opencode-review-findings.md:215`、`.agents/handoffs/2026-11-05-opencode-review-plan-t2-t3-t5-t6.md:84`

**问题** 作者说法 2 明确写“`.agents/reviews` 和 `.agents/handoffs` 是历史记录，有意不改”，但 `git diff 120fdd9..d35f8c4` 显示这两个 handoff 文件的相对链接都从 `.claude/rules/prompt-prefix.md` 改成了 `.agents/instructions/prompt-prefix.md`。说法与代码不一致；如果这些文件按约定不能改，这就是一次未声明的历史记录改写；如果允许改，作者的说法应更正。

**证据（读 git diff 证实）**
```diff
-- 注意：...所以[只追加规则](../../.claude/rules/prompt-prefix.md)这里不构成障碍...
+- 注意：...所以[只追加规则](../../.agents/instructions/prompt-prefix.md)这里不构成障碍...
```
```diff
-- 缓存：... [只追加规则](../../.claude/rules/prompt-prefix.md#rules)不受影响。
+- 缓存：... [只追加规则](../../.agents/instructions/prompt-prefix.md#rules)不受影响。
```
链接本身的新路径是正确的；问题只在“有意不改”这句话不成立。

**建议** 更正作者说法，或恢复这两个 handoff 文件；如果 policy 是“历史记录不改”，后续不要用路径修复去改它们，改成在迁移说明里列出失效链接。

### 3、低、新加的反向用例不在本地 `npm run check` 门槛里，只在 CI 的 tooling 项目里

**文件:行** `package.json:27`、`package.json:30`、`ci/policy.json:196-200`、`scripts/ci/run.mjs:240-247`

**问题** 新增的 `test/tooling/incident-gates.test.mjs` 覆盖了本次行为，但 `npm run check` 的 `check:incident-gates` 只运行脚本本身，不运行这个测试文件。`npm run check` 的步骤清单里也没有一个通用的 tooling 测试步骤。测试实际由 CI 的 `policy` 作业运行：`ci/policy.json` 的 `policy.projects` 是 `["tooling"]`，`scripts/ci/run.mjs` 在 `checkId === "policy"` 时执行 `vitest(check.projects)`，而 `test/tooling/**/*.test.mjs` 属于 tooling 项目。因此 PR 上测试会跑，但快速模式下若按长期授权不等 CI 合并，本地门槛不会运行这些测试。

**证据（读代码证实）**
```json
"check:incident-gates": "node scripts/check-incident-gates.mjs",
```
```json
{ "id": "policy", "projects": ["tooling"] }
```
```js
} else if (checkId === "policy") {
  ...
  await vitest(check.projects);
}
```
```json
"include": ["test/tooling/**/*.test.ts", "test/tooling/**/*.test.mjs"]
```

**建议** 如果希望本地 `npm run check` 也守住这次改动，把该测试加入一个明确的本地检查步骤（例如单独的 `check:incident-gates-tests`，或并入现有 tooling 测试步骤）；如果接受只在 CI 跑，应在规则或说明里写明这个限制。

### 4、低（推测）、截断按 Unicode 码点而不是字素簇，仍可能截开 ZWJ/组合字符序列

**文件:行** `scripts/check-incident-gates.mjs:80-83`、`test/tooling/incident-gates.test.mjs:123-133`

**问题** `Array.from` 按码点切分，能避免把代理对切成半个，但不会保护由多个码点组成的字素簇（例如家庭 emoji、带肤色的 emoji、组合重音）。如果第 80 个码点落在这类序列中间，输出仍可能是半个字形。测试只覆盖了单个码点 emoji，`isWellFormed()` 只检查代理对，不检查字素簇是否完整。

**证据（读代码证实）**
```js
const characters = Array.from(end < 0 ? text : text.slice(0, end + 1));
return characters.length > SHORT_SYMPTOM_LENGTH
  ? `${characters.slice(0, SHORT_SYMPTOM_LENGTH).join("")}…`
  : characters.join("");
```
```js
const emojiAtTheCut = `${"字".repeat(79)}😀😀尾巴`;
...
expect(lines[1].isWellFormed()).toBe(true);
```

**推测部分** 这是否算问题取决于“Unicode 字符”的定义。如果只要求不产生孤立代理项，现在的实现已经足够；如果要求不切开用户看到的字符，应改用 `Intl.Segmenter` 按字素簇计数，并补一个 ZWJ 序列的用例。

**侧重检查**

- 错误路径：检查了清单缺失、无表格、行格式错误、门槛文件缺失、次数达到 3 但无硬门槛等错误来源。缺失/无表格有测试；`--open` 对“可读但校验失败”的清单会隐藏未结条目（见意见 1），且没有对应测试。
- 不合规范或不可信输入：`firstSentence` 对 emoji/代理对的处理已从 UTF-16 切片改为码点切片，单个 emoji 不再产生孤立代理项；字素簇仍可能被切开（见意见 4）。清单内容来自仓库文件，不是外部网络输入；`readIncidents` 的 `|` 分列是既有解析方式，本次未改变。
- 安全：脚本只读 `docs/incidents-and-gates.md` 并写 stdout/stderr，不联网、不执行外部命令、不写文件；新增输出只是仓库内事故文本，和改动前同类，没有引入新的秘密泄露或注入面。
- 资源耗尽：只读一个约 184KB 的清单；`Array.from` 会为每条现象创建一个码点数组，但清单规模很小，没有新的无界循环或大内存分配。
- 不可撤销操作：脚本没有写操作；“先修好清单”是让代理修改仓库文档，不是生产或不可撤销操作。
- 规则、说明文档和代码一致性：移动后的 `prompt-prefix.md` 仍在仓库下两层，`../../docs/...` 链接有效；`check-instruction-links.mjs` 的根包含 `.claude/rules` 和 `.agents/instructions`，`check-docs-links.mjs` 覆盖 `docs/` 里的新链接；`#rules`、`#plan-discussion`、`#code-review`、`#owner-control`、`#delegate`、`#fast-mode` 等锚点都存在。发现的不一致是意见 1 的 `--open` 触发条件和意见 2 的 handoff 说法。`.agents/instructions/model-review.md` 被 `scripts/model-review/opencode-review.mjs` 的 `QUESTIONS_PATH` 读取，改链接会改变未来复核提示词中的这一行，但复核每次是新会话，不涉及跨轮只追加。

**必答问题**

1. **会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**
   对 Himawari 运行时：不会。本次没有改任何运行时组装请求的代码，改的是指令文档、开发用检查脚本和测试；Himawari 发给模型的系统提示、工具定义、历史和最后一条消息都不受影响。
   对云端编码线程：`CLAUDE.md`/`AGENTS.md` 和 `.claude/rules/` 是在线程开局读取的，本次改动会让**新线程**的系统提示内容变化（AGENTS.md 文字变化、prompt-prefix.md 不再自动载入、incident-gates 规则变化），但不会改动已经在进行的线程已经发出去的内容；这符合 `prompt-prefix.md` 第 43 行“改了提示词文字，只对新对话生效”。
   对复核模型：`scripts/model-review/opencode-review.mjs` 的 `QUESTIONS_PATH` 会从 `.agents/instructions/model-review.md` 读必问问题，本次改了两个链接路径，所以未来复核提示词会变；但每次复核都是新会话，没有跨轮缓存/只追加问题，`--questions-ref` 也能固定旧版本。
   结论：没有把每轮变化的值放进系统提示或工具定义；Himawari 的请求仍然只在末尾追加，每轮变化的值仍然只能在最后一条用户消息里。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。脚本输出不含时间戳、随机数、哈希或环境信息；`firstSentence` 是纯函数；`OPEN_STATES` 只用于过滤，不参与序列化顺序；输出只取决于仓库里的清单内容。清单内容变化时输出变化是预期行为，不是同一段文字在请求间变成不同字节。复核提示词的变化是路径文字的一次性变化，且复核每次是新会话，不涉及跨请求的同一对话前缀。

3. **改动有没有对应的自动检查，反向用例是不是真的会失败？**
   有，`test/tooling/incident-gates.test.mjs`。按代码推断（本轮未执行测试）：
   - 把 `OPEN_STATES` 恢复成只含 `缺门槛`、`等 Andy`，`lists every incident that is not closed by a gate` 会失败，因为它要求 `仓库外` 行存在且共有 3 行；
   - 把 `firstSentence` 恢复成按 UTF-16 长度切片，`cuts a long symptom after 80 characters without splitting a character in two` 会失败，因为会在 emoji 代理对中间切断，输出不等于预期，`isWellFormed()` 也会是 `false`；
   - 把 CLI 恢复成出错时也打印 `INCIDENT_OPEN count=0`，`says the open list is unavailable instead of printing a zero count ...` 会失败，因为它断言出现 `unavailable` 且不出现 `count=0`。
   但测试只在 CI 的 tooling 项目里运行，不在本地 `npm run check` 的 `check:incident-gates` 步骤里（见意见 3）。

4. **改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
   - `OPEN_STATES` 现在包含 `缺门槛`、`等 Andy`、`仓库外`。使用端是 `.claude/rules/incident-gates.md:9`、`docs/incidents-and-gates.md:18` 和测试；三处都要求列出 `仓库外`，一致。
   - `INCIDENT_OPEN unavailable`：代码精确输出该子串，规则引用该子串，测试断言该子串；一致。但规则把触发条件解释成“清单读不出来”，而代码对任何校验错误都触发（意见 1）。
   - `INCIDENT_OPEN count=N total=M`：代码输出，测试用最后两行核对；没有其他脚本解析，格式未被破坏。
   - `firstSentence` 的输出：只用于 CLI 显示，没有下游解析器；截断行为本身是本次要改的值，使用端接受。
   - 移动后的 `.agents/instructions/prompt-prefix.md`：所有仓库内引用都已改到新路径；`check-instruction-links` 的根包含 `.agents/instructions`，`docs` 链接检查覆盖 docs 下的新路径；`#rules` 等锚点存在。I-66 的门槛列也改为新路径，`check-incident-gates` 的路径存在性校验能通过（文件存在）。
   - `AGENTS.md` 的新链接：`#plan-discussion`、`#code-review`、`#owner-control`、`#delegate`、`delivery-mode.md#fast-mode` 都存在；`pi-development-guide.md:341` 的 `#current-deviations` 也存在。
   - `.agents/handoffs` 的引用：新路径本身正确，但作者说法说“有意不改”，与实际改动不符（意见 2）。
