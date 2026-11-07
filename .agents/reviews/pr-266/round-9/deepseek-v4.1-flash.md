## 结论

未发现高、中严重度问题。作者关于合并的三点说法，我都用代码和 diff 核对过，全部成立：

- 事故表两侧的行都在：`464a..382bc678` 里旧 I-78/I-79 被替换为主线的 I-78 加顺延的 I-79/I-80；`27e1d332..382bc678` 相对主线只多出 I-79、I-80 两行。行内文字与旧行一致，只是编号变了。
- 仓库里没有残留指向旧编号的引用。
- `check:steps` 合并后同时保留了分支的 `check:probe-sources` 和主线的 `check:prompt-catalog`，共 36 步。

下面按严重度列出发现，随后是「侧重检查」和必答问题。

---

## 发现

### 低 — 事故编号改号没有跨引用自动检查
- 文件:行：`scripts/check-incident-gates.mjs:45-70`、`docs/incidents-and-gates.md:116-118`
- 问题：门槛只查编号格式、重复、字段、状态和门槛文件是否存在，不检查代码/测试/规则里的 `[I-xx]` 引用是否指向对应事故。这次改号能安全落地，是因为人工 grep 过；以后再顺延编号，漏改一处引用不会被任何检查发现。
- 证据：
  ```js
  for (const incident of incidents) {
    const where = incident.id || "(no id)";
    if (!/^I-\d{2,}$/.test(incident.id)) errors.push(`INCIDENT_ID_INVALID ${where}`);
    if (seen.has(incident.id)) errors.push(`INCIDENT_ID_REPEATED ${where}`);
    seen.add(incident.id);
  ```
  以及后面只对门槛栏里的仓库路径做 `existsSync`（`scripts/check-incident-gates.mjs:65-70`）。反向用例也只覆盖重复编号：`test/tooling/incident-gates.test.mjs:61-68`。
- 建议：新增一条检查，扫描 `.claude/rules`、`.agents/instructions`、`docs` 和测试名里的 `I-\d{2,}` 引用，要求每个编号都能在事故表里找到；历史复核记录可加白名单。

### 低 — 探针解析器对「格式不对的摘要」会静默漏过
- 文件:行：`scripts/check-probe-sources.mjs:11`、`61-72`、`101-104`
- 问题：`originals` 块内某行的摘要不是恰好 64 位小写十六进制（例如少一位、全大写、用了模板字符串）时，既匹配不上 `PACKET_CHECK_ENTRY`，也不会被 malformed 检测命中（后者要求行内出现 `[0-9a-f]{64}`）。如果这个文件名同时不在 `probe-sources.json` 里，`PROBE_SOURCE_UNLISTED` 也不会报，因为未列清单只遍历已解析出的 `recorded` 名字。结果要等到 Hermes 上真正构建、探针运行抛 `PROBE_ORIGINAL_RUNTIME_CHANGED` 才发现。
- 证据：
  ```js
  const PACKET_CHECK_ENTRY = /(?<=^|\n)\s+"([a-z-]+\.js)": "([0-9a-f]{64})",(?=\n|$)/g;
  ...
  if (inside && !entryLines.has(index) && /[0-9a-f]{64}/.test(line))
    parsed.malformed.push(line.trim());
  ...
  for (const name of recorded.keys())
    if (!listed.has(name)) problems.push(`PROBE_SOURCE_UNLISTED ${name}`);
  ```
  现有用例只覆盖「名字非法但摘要是合法 64 位」（`test/tooling/probe-sources.test.mjs:86-91`）。
- 建议：对 `originals` 块内所有 `^\s*"[^"]+"\s*:` 形状的行都先登记，再判断是否匹配完整条目；不匹配就报 `PROBE_BOOTSTRAP_ENTRY_FORMAT`，不要依赖摘要格式来发现异常行。

### 低 — I-55 门槛描述里的步数已过期
- 文件:行：`docs/incidents-and-gates.md:92`
- 问题：该行仍写「按 `package.json` 里 `check:steps` 的清单把 21 步全跑完」，合并后的 `check:steps` 实际是 36 步（本 PR 又加了一步）。这句如果是历史记录可以保留，但作为仍在生效的门槛描述会误导。
- 证据：`package.json:27` 的 `check:steps` 共 36 个 `npm run <name>`；同一行原文为「把 21 步全跑完」。
- 建议：改成「按清单把所有步骤跑完」，或更新为当前数量。

---

## 侧重检查

- **错误路径**：逐条读了 `probeSourceProblems` 的失败分支——记录缺失/不可读/JSON 坏/字段非法/重复 built（`scripts/check-probe-sources.mjs:78-87`、`31-51`）；探针文件缺失/不可读/无 `originals` 块/条目在块外/重复名/格式错（`88-104`）；源码缺失/不可读/摘要变化（`110-124`）。这些都有对应用例，且 CLI 非零退出有独立用例（`test/tooling/probe-sources.test.mjs:259-269`）。
- **不可信输入**：记录里的 `source` 被强制等于 `packages/runtime-sandbox/src/<built 去 .js>.ts`（`scripts/check-probe-sources.mjs:39`），`built` 还必须匹配 `^[a-z-]+\.js$`，因此不能借 `probe-sources.json` 做路径穿越；`readPlainFile` 用 `lstatSync(...).isFile()` 拒绝符号链接、FIFO 和目录（`20-29`）。
- **安全**：新增检查全程只读，没有删除或写入；`run-release-walkthrough.sh` 的 `--preflight` 也只在 `17-27` 行做存在性/版本核对。合并进来的 #268 里，可信文字只收集 `segment.kind === "text"` 的固定文本（`packages/prompt-catalog/src/entry.ts:67-69`），模板槽里的用户数据不会被当成可信；恢复失败会抛 `EgressRedactionError`，出口侧拒绝发送（`packages/sensitive-capture/src/redaction.ts:231-235`、`packages/application/src/services/model-egress.ts:217-221`、`476-486`），属于失败即关闭。
- **资源耗尽**：检查只读几个固定的仓库文件；`bootstrapDigests` 对每个匹配做一次字符串切片，最坏是 O(行数×匹配数)，探针文件很小，不构成实际问题。测试里的临时目录在 `afterEach` 清理（`test/tooling/probe-sources.test.mjs:12-14`）。
- **不可撤销操作**：本增量没有。
- **规则/文档与代码一致性**：`.claude/rules/prompt-prefix.md:53` 的 24 字符、34 个填充字符、两种退回条件、可信文字不遮点名值，均能在 `packages/prompt-catalog/src/trusted.ts:10-14`、`src/entry.ts:59-75`、`packages/sensitive-capture/src/redaction.ts:172-236` 找到对应实现；I-79 描述与 `scripts/check-probe-sources.mjs` 一致；I-80 描述的检查顺序与 `scripts/delivery-mode/hermes/run-release-walkthrough.sh:17-23` 一致。作者说 #268 已复核、本轮不用看，我仍然对照了其规则与代码，未发现不一致。
- **观察**：`TRUSTED_TEXT_MINIMUM_LENGTH`（`entry.ts:59`）和 `TRUSTED_TEXT_MINIMUM_CHARACTERS`（`redaction.ts:172`）各自写死 24，当前一致，但以后可能漂移；不是本次改动的缺陷。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会（就 PR 266 的净改动而言）。** `git diff --stat 27e1d332..382bc678` 里没有任何 `apps/`、`packages/` 文件，只有 `scripts/check-probe-sources.mjs`、探针记录/测试、`docs/incidents-and-gates.md`、`package.json`、Hermes 预检脚本和测试；这些都不参与提示词拼装或出口遮盖。因此系统提示、工具定义、历史消息、遮盖结果都不变，仍然只在末尾追加。
需要区分的是：`464a..382bc678` 的合并增量确实带进了 #268 的出口遮盖代码，但 #268 已经在对比基准 `27e1d332` 里，不属于 PR 266 相对主线的净改动。若单独看 #268，它会让此前被误遮的可信固定文字恢复原样（这是一次性的、有意的字节变化），规则文件也写明了改提示词文字会让老对话「请求开头变一次」。[读代码证实，#268 的字节变化范围为推测性描述，未实际跑请求对比]

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**PR 266 的净改动不会。** 它不触碰序列化或遮盖。合并进来的 #268 我也核对了确定性：可信文字清单在 `trustedPromptTexts` 里用 `Set` 去重并显式排序（`entry.ts:62-75`），可信片段命中后按起点、再按长度排序（`redaction.ts:195`），34 个填充字符按固定顺序取第一个可用的（`redaction.ts:174-178`、`215-217`），没有依赖对象遍历顺序或数据库顺序。已知会改变字节的情况只有规则文件已写明的「提示词目录文字变化」和 #268 的点名值例外，均取决于该消息自身及其前面的内容，不取决于后面的内容。

### 3. 有没有对应自动检查，反向用例是否真的会失败？
- 探针门槛：`check:probe-sources` 有真实反向用例，例如源码摘要变化必须报 `PROBE_SOURCE_CHANGED`（`test/tooling/probe-sources.test.mjs:65-72`）、记录与探针不一致必须报 `PROBE_BUILT_DIGEST_MISMATCH`（`74-79`）、探针多认文件必须报 `PROBE_SOURCE_UNLISTED`（`81-84`）、记录/探针格式错和 CLI 非零退出（`194-269`）。去掉检查逻辑这些用例会失败，用例本身是有效的。
- 改号：重复编号有反向用例（`test/tooling/incident-gates.test.mjs:61-68`），`npm run check:incident-gates` 会跑真实仓库（同文件 `101-103`）。但「旧引用指向错编号」没有自动检查，见上面第一条低严重度发现。
- 本次改动作者声称在 Hermes 上 36 步全过；我没有运行，属于未核实。

### 4. 新产生/修改的值，使用它的地方都能接受吗？
逐个核对过：
- `I-79`、`I-80`：唯一机器消费者是 `scripts/check-incident-gates.mjs`，要求 `^I-\d{2,}$` 且不重复，两者都通过；人工消费者是文档/测试里的 `[I-xx]` 引用，已 grep 全部仓库（`docs`、`.claude`、`apps`、`scripts`、`.agents/instructions`、`.agents/handoffs`、`.agents/tasks`），没有旧编号残留。
- `check:probe-sources`：`scripts/run-all-checks.mjs:7-11` 用 `^npm run (\S+)$` 解析，带冒号的脚本名可接受；`test/tooling/run-all-checks.test.mjs:52-56` 断言它存在且对应脚本是字符串；`ci/policy.json:243` 的 tooling 项目包含 `test/tooling/**/*.test.mjs`，新测试有归属。
- `scripts/delivery-mode/probe-sources.json` 的 `bootstrap`、`built`、`source`、`builtSha256`、`sourceSha256`：生产端 `recordProblems` 对字段类型、路径推导、64 位小写摘要逐项校验；消费端 `probeSourceProblems` 再把 `builtSha256` 与探针里的 `originals` 对比、把 `sourceSha256` 与实际源码对比。两端规则一致。
- 唯一注意点：`builtSha256` 只与探针里的值互相核对，不校验真实构建产物，这一点 I-79 已明确写成「未覆盖」。

---

## 未核实

- 没有运行 `npm run check`，因此「Hermes 上 36 步全过」只核对了步数与脚本存在性，未复现。
- 没有计算 `probe-sources.json` 里 6 个 SHA-256 是否与当前源码字节一致（不能运行 sha256 工具）；但确认了这三个源码文件和 `bootstrap.mjs` 在 `464a`、`27e1d332`、`382bc678` 三个提交间没有变化，所以只要第 8 轮时检查通过，合并后仍然通过。
- `builtSha256` 是否等于真实 `runtime-sandbox/dist` 的字节，按设计只能由 Hermes 上的出包检查发现，本次未核实。
