我先查看两轮增量的 diff。
本轮范围：`git diff d4dd818..6ccf14b` 只有 ADR 0269、ADR 0107 的 `amended_by` 和复核记录；我另外回头核了这些 ADR/规则直接依赖的 `scripts/check-incident-gates.mjs`、`test/tooling/incident-gates.test.mjs`、`package.json`、`.claude/rules/incident-gates.md`、`AGENTS.md`、`.agents/instructions/prompt-prefix.md`、`model-review.md` 以及改动过的 docs 链接。未运行任何检查（环境只允许读文件和 git 只读命令），以下结论均为静态核对；`.agents/reviews` 被环境拒绝读取，且当前是稀疏检出，相关记录标“未核实”。

### 1【低】`--open` 的未知参数被静默忽略，打错一个字母就会只打印 `INCIDENT_GATES passed` 并以 0 退出
文件：`scripts/check-incident-gates.mjs:95-108`
问题：脚本不校验参数，任何不等于 `--open` 的参数都走“非 open 模式”分支，只打印 `INCIDENT_GATES passed incidents=… errors=0`，不打印 `INCIDENT_OPEN`。ADR 0269 与 `.claude/rules/incident-gates.md` 把这条命令定为每个线程开工的入口，但没有规定“输出里没有 `INCIDENT_OPEN` 时怎么办”；打错成 `--open=1`、`--Open` 或漏掉 `--` 时，线程可能把“没有 open 列表”当成“没有未结条目”。
证据（读代码证实）：
```js
if (process.argv.includes("--open") && errors.length > 0) {
  process.stdout.write(`INCIDENT_OPEN unavailable errors=${errors.length}\n`);
} else if (process.argv.includes("--open")) {
  ...
}
process.stdout.write(`INCIDENT_GATES ...`);
process.exitCode = errors.length === 0 ? 0 : 1;
```
建议：严格解析参数，只接受零个参数或 `--open`；其它参数以退出码 2 打印 `INCIDENT_ARGS_INVALID <参数>`。对应加一条反向测试。后果部分是推断：是否真有线程会因此漏看，取决于它是否检查 `INCIDENT_OPEN` 行。

### 2【低】`--open` 的“任何失败都打印 unavailable”没有覆盖读取异常，文件不可读或是目录时会直接抛栈
文件：`scripts/check-incident-gates.mjs:42-46`、`:95-108`
问题：`existsSync` 只处理“不存在”。如果 `docs/incidents-and-gates.md` 是目录、或存在但不可读，`readFileSync` 抛出的异常没有被捕获，CLI 只输出 Node 栈，既不打印 `INCIDENT_OPEN unavailable`，也不打印 `INCIDENT_GATES`。这与 ADR 0269 “清单有任何一处通不过检查时……用一行 `INCIDENT_OPEN unavailable errors=…` 代替”的说法不完全一致。
证据（读代码证实，EISDIR/EACCES 的行为是 Node 标准语义，未实际运行）：
```js
const file = path.join(root, INCIDENT_LIST);
if (!existsSync(file))
  return { incidents: [], errors: [`INCIDENT_LIST_MISSING ${INCIDENT_LIST}`] };
const { incidents, errors } = readIncidents(readFileSync(file, "utf8"));
```
建议：把 `readFileSync` 包进 try/catch，失败返回 `INCIDENT_LIST_UNREADABLE <code>` 一类错误；加一条“路径是目录”或“权限 000”的反向用例。缺失文件和没有表格这两种情况已有测试覆盖，这个缺口不在其中。

### 3【低】ADR 0269 一边说“这里不重复”token 估算，一边又重复了“约少 6 万 token”
文件：`docs/adr/0269-load-instructions-on-demand-at-thread-start.md:47`、`:88`
问题：同一份 ADR 内部矛盾。背景说 token 数和提交统计“没有用分词器实测，这里不重复”，后果又给出具体数字“每个线程开局约少 6 万 token”。读者无法判断这个数字是 ADR 自己的结论，还是只是转述 PR 说明；而且它没有像背景承诺的那样“不重复”。
证据（读文件证实）：
- 第 47 行：“按字数估算的 token 数和提交统计写在 PR 495 的说明里，没有用分词器实测，这里不重复。”
- 第 88 行：“……省下的上下文之后每一轮都不用再带（PR 495 说明里按字数估算，每个线程开局约少 6 万 token）。”
建议：二选一——删掉第 88 行的数字，或把第 47 行改成“这里只转述 PR 说明里的估算”。若保留数字，明确标注“按字数估算，未用分词器实测”。

### 4【低】ADR 0269 决定 4 说三节“只保留触发条件”，但 AGENTS.md 仍保留了多条实质规则
文件：`docs/adr/0269-load-instructions-on-demand-at-thread-start.md:66`；`AGENTS.md:7`、`:57`、`:110`
问题：ADR 说“交付模式”“和 OpenCode 协作”“Pi 优先与工作区”三节“只保留什么时候要读什么、读哪份文件”，但三节仍各有可执行的实质规则：
```text
AGENTS.md:7   合并前 PR 最新提交上的 `ci/required` 必须是成功……
AGENTS.md:57  默认只用 `opencode-go/deepseek-v4.1-flash`……只有 Andy 特别指明时才加上……
AGENTS.md:110 官方有写法就照官方写，偏离官方要先出方案经 Andy 同意……
```
这不是代码缺陷，但会让后来的人误以为这三节只是指针、可以继续删，或者以为这些规则只存在于链接文件里。
证据（读文件证实）：上述三行都在当前 `AGENTS.md` 中；ADR 第 66 行原文见上。
建议：把决定 4 改成“保留高频规则和触发条件”，或逐个列出保留下来的规则。

### 5【低】测试声称“不会把字符切成两半”，但 `Array.from` 只按码点切，组合字符/ZWJ 序列仍会被截断
文件：`test/tooling/incident-gates.test.mjs:123-133`；`scripts/check-incident-gates.mjs:78-84`
问题：实现用 `Array.from` 按 Unicode 码点计数，能避免截断 `😀` 这类单个代理对；但 `isWellFormed()` 只检查孤立代理项，不检查组合附加符或 ZWJ 表情序列。一个家庭 emoji 在 80 码点边界被切开时，结果仍是“well-formed”，只是显示成半个字符。测试名“without splitting a character in two”因此说得过满；ADR/作者说法里的“80 个 Unicode 字符”如果指码点是准确的，如果指用户看到的字符则不准确。
证据（读代码证实，截断序列的具体结果是按 JS 语义推断，未运行）：
```js
const characters = Array.from(end < 0 ? text : text.slice(0, end + 1));
return characters.length > SHORT_SYMPTOM_LENGTH
  ? `${characters.slice(0, SHORT_SYMPTOM_LENGTH).join("")}…`
  : characters.join("");
```
```js
expect(lines[1].isWellFormed()).toBe(true);
```
建议：如果只需保证 UTF-16 合法，把测试名和 ADR 措辞改成“80 个码点”；如果要保证显示完整，用 `Intl.Segmenter` 的 `granularity: "grapheme"` 切分并补一条组合字符/ZWJ 用例。

**侧重检查**

- 错误路径：缺失文件、没有表格、表格可读但某行校验失败这三条路径都按 ADR 预期输出 `INCIDENT_OPEN unavailable`、保留 `INCIDENT_GATES failed`、退出码 1；对应测试分别覆盖（`test/tooling/incident-gates.test.mjs:151-193`）。发现两处未覆盖：未知参数静默成功（意见 1）、不可读文件/目录直接抛栈（意见 2）。
- 不合规范或不可信的输入：`firstSentence` 对空值用 `?? ""` 兜底；`Array.from` 能安全处理代理对；组合字符/ZWJ 边界仍有意见 5 的问题。`readIncidents` 对表格行按 `|` 简单切分、多余列会被忽略，这是改动前就有的行为，本轮没有加重。
- 安全：`--open` 只把仓库里的清单文本打到标准输出，不拼接 shell、不访问网络、不新增凭据；测试用 `execFileSync`/`spawnSync` 的数组参数，没有 shell 注入面。
- 资源耗尽：命令只读约 184KB 的清单并映射 96 行，没有循环放大；测试只 spawn 一个子进程。
- 不可撤销操作：没有。脚本是只读的，ADR 只是文档。
- 规则、说明文档和代码一致性：ADR 0269 的前提 3-6、决定 1-3 与代码逐条对得上；决定 4 的措辞与 AGENTS.md 不一致（意见 4）；第 47/88 行自相矛盾（意见 3）；`.claude/rules/incident-gates.md`、`docs/incidents-and-gates.md` 与脚本的 open 状态集合、输出顺序、unavailable 条件一致。

**作者说法核对**

1. 基本正确：`OPEN_STATES` 是 `INCIDENT_STATES` 去掉 `已落门槛`，即 `缺门槛`、`等 Andy`、`仓库外`；输出格式是 `编号 | 状态 | 日期 | 第一句`，第一句超过 80 个码点加 `…`；有错误时打印 `INCIDENT_OPEN unavailable errors=K`，随后仍打印 `INCIDENT_GATES failed`，错误在 stderr，退出码 1；无错误时先列条目，再 `INCIDENT_OPEN count=N total=M`，再 `INCIDENT_GATES`。`.claude/rules/incident-gates.md` 写的是同一套条件（未提及 80 字截断，但不是必须）。两处例外见意见 1、2。
2. 正确：`.claude/rules/` 与 `.agents/instructions/` 都在仓库下两层，`../../docs/...` 在新位置仍指向 `docs/`；`AGENTS.md`、`docs/` 下多个 ADR/指南、`.agents/instructions/model-review.md`、`packages/sensitive-capture/README.md` 的引用都已改到新路径；两份 11-05 交接文件的 `../../.agents/instructions/prompt-prefix.md` 也正确；全仓库只剩 ADR 0269 自己在描述旧路径。`.agents/reviews` 的历史记录未改，符合说法；这些文件因稀疏检出/环境拒绝读取，未逐份核对。
3. 六项点名细节都在被链接文件里：CI 长期授权在 `.agents/instructions/delivery-mode.md:27`；复核分级、轮次、`accept-low`、`accept-unreviewed` 在 `model-review.md:64-73`；Mac 线程交接在 `model-review.md:163-174`；Pi 现有偏离不得照抄在 `docs/pi-development-guide.md:4`。我另查到删除的 `review-models.json`、主线程 `--assert-reviewed`、plan-claims 局限和费用门槛也都在 `model-review.md:4/25/46/66` 与 `model-review-card.md:25`，未发现规则丢失；“每一句删除都被覆盖”无法逐句证明，但点名的六项成立。
4. 对 Himawari 运行时正确：改动没有碰 `packages/`、提示词目录或运行时组装代码。一个需要说明的边界是 `.agents/instructions/model-review.md` 会被 `scripts/model-review/opencode-review.mjs:2772/286-295` 抽成复核模型的必答问题，因此该文件第 80 行改路径会改变未来复核会话的提示词文本；复核每次是新会话，没有跨运行的缓存前缀，也不是 Himawari 的请求。
5. ADR 0269 与 ADR 0107 的 `amended_by` 都在：`amends`/`amended_by` 的值都指向真实存在的 ADR；`check-adr-numbers` 会把正文和 frontmatter 里的 `docs/adr/…md` 路径当作路径提及来核对存在性，两处都能通过；当前树里 0269 唯一，标题编号 `ADR 0269` 也能过 `^ADR\s+(\d{4})`。`plan-claims` 记录在 `6ccf14b` 的提交统计里可见，但内容被环境拒绝读取（`REVIEW_GIT_REFUSED`），所以“第 3 次 11 句全部一致”未核实。

**必答问题**

1. **不会改变 Himawari 模型已经见过的请求开头。** 本次改动没有碰系统提示、工具定义、历史、遮盖或运行时请求组装；每轮会变的值仍在最后一条消息里。唯一“模型可见”的变化是编码代理新线程开局自动载入的指令集（这是本 PR 的目的），以及复核模型的必答问题文本（新会话，无跨运行缓存）。对 Himawari 而言，没有把任何东西挪到请求开头，也没有改写已发内容。
2. **不会让同一段运行时代码文字在不同请求里变成不同字节。** 没有新增依赖时间、随机数或无序集合的运行时字段；`--open` 的输出按清单文件顺序生成，`OPEN_STATES` 只做 `has` 判断，`firstSentence` 是确定性的。清单不变时输出字节相同；清单变了本来就是文档变更，不是运行时遮盖/序列化。
3. **对应检查是有的，反向用例也确实会失败。** `--open` 有单元测试和 CLI 测试，覆盖缺失文件、没有表格、表格校验失败时不列条目、长现象截断、代理对不被截断；`check:incident-gates` 已通过 `package.json` 把该测试文件接进 `npm run check`，反向用例在旧行为下会失败（读测试断言可确认）。路径移动由 `check-instruction-links`、`check-glossary`、`check-docs-links`、`check-adr-numbers` 间接覆盖，`check-prompt-prefix` 不受影响。未覆盖的是意见 1、2 的两个错误路径；另外我没有实际运行检查，以上是静态核对。
4. **逐项核对了两端，没有发现会拒绝新值的消费方。** `check:incident-gates` 仍是一个 npm script，`run-all-checks` 的 `stepNames` 只拆 `check:steps` 里的 `npm run …`，内层追加 `&& vitest` 与现有 `check:probe-sources` 同一模式；没有 Python/CI 调用方依赖它“只跑 node 脚本”。`--open`/`INCIDENT_OPEN` 只被新规则、文档和测试消费，没有旧解析器。`openIncidentLines` 只有测试使用。`amends`/`amended_by` 由 `check-adr-numbers` 的路径存在性检查兜底，两者都指向存在的文件。`.agents/instructions/prompt-prefix.md` 的所有现行引用都已改到新路径，`.claude/rules/prompt-prefix.md` 已不存在，`check-glossary`/`check-instruction-links` 同时扫描两个目录。`docs/incidents-and-gates.md:18` 与 `.claude/rules/incident-gates.md:9` 对开工命令的描述和脚本一致。唯一对不上的是 ADR 自己的措辞（意见 3、4），不是两端校验冲突。
