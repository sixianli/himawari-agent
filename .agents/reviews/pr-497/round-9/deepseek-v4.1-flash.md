范围：本轮只复核 `git diff a79f8dbc..8fd309626` 的增量，即 `scripts/model-review/plan-claims.mjs`、`test/tooling/plan-claims-gate.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs` 和 round-8 记录。顺着调用关系看了 `opencode-review.mjs` 的 `claimsProblems`/`assertReviewed`/`lowFixProblems`、plan-claims 的提示词生成，以及 `.agents/instructions/model-review.md` 的规则说明；上一轮及更早的合并队列、CI 旧代码没有重读。

### 1、中：多位置引文把不同文件的内容拼进同一个 haystack，引文可以跨文件或跨位置拼出，伪造的并列仍能通过
文件：`scripts/model-review/plan-claims.mjs:186-196`、`scripts/model-review/plan-claims.mjs:161-163`；`scripts/model-review/plan-claims.mjs` 的 `collapse` 在 38 行
问题：每个位置只校验文件存在和行号范围，然后把这些文件的**全部内容**用 `"\n"` 连起来，再交给 `quoteInText`。于是引文不再要求出现在“被引用的那个文件”里：最后一行属于 A 文件、第一行属于 B 文件，拼成一句也能过；同一个 fragment 也能来自列表里任意一个文件。` / ` 切分本身不会误伤完全一致的除号引文（整段会先由 161-162 行命中），但整段找不到时，只要斜杠两边各是文件里真实存在的片段，拼接出来的假引文就会通过。测试 `plan-claims-gate.test.mjs:241` 正是在断言这种“片段按顺序拼接”算通过。
证据（读代码证实）：
```js
const text = [...texts.values()].join("\n");
if (claim.verdict !== "找不到" && !quoteInText(claim.code, text)) return "code-quote-not-in-file";
```
```js
const whole = collapse(stripQuoteMarks(quote));
if (whole.length >= 8 && haystack.includes(whole)) return true;
return fragmentsInOrder(quoteFragments(quote, LINE_JOINS), haystack);
```
规则文件此时仍写“出现在那个文件里”（`.agents/instructions/model-review.md:39`），和跨文件拼接不一致。
推测（未运行）：构造 `a.mjs:1,b.mjs:1`，引文写成 A 文件末行 + B 文件首行，会被判为存在，尽管两个文件都没有这一整句。单文件内用 `；`/`…` 拼接是文档已承认的旧局限；这次新增的是把范围扩到多文件，且 fragment 与具体位置没有任何绑定。
建议：不要先做全局拼接再验；按位置分别保存文本，要求整段引文至少完整出现在一个被引位置，或把每个 fragment 绑定到它所在的位置和行号附近。做不到绑定时，至少禁止跨文件边界的命中，并在文档里明确“多位置只证明各片段分别存在，不证明拼接后的句子存在”。

### 2、中：单个 CLAIM 的位置数量没有上限，每个新路径一次 `git show`，所有文件正文同时留在内存
文件：`scripts/model-review/plan-claims.mjs:185-195`、`scripts/model-review/plan-claims.mjs:25-30`
问题：`locationsOf` 接受任意多个逗号分隔的位置，`claimEvidenceProblem` 对每个新路径同步执行一次 `git show`，并把整份内容放进 `texts` Map，最后再 `join` 一份。改动前每个 CLAIM 只读一个文件；现在一条模型答案即可放大成大量子进程和大块内存。
证据（读代码证实）：
```js
for (const place of places) {
  if (!texts.has(place.path)) {
    const blob = blobAt(repo, head, place.path);
    ...
    texts.set(place.path, blob.toString("utf8"));
```
```js
spawnSync("git", args, { cwd: repo, encoding, maxBuffer: 1 << 28 });
```
推测（未运行）：一条 CLAIM 写几百个仓库内真实路径，就能让检查耗时和内存线性增长；`git show` 单次上限 256 MiB，Map 会同时保留所有文件。模型答案属于不可信输入（模型可能被仓库内容诱导），这里没有数量或字节上限。
建议：限制每个 CLAIM 的位置数（例如 8 个）和累计读取字节数，超限直接报 `claims-evidence ... too-many-places`；或者按需逐个读取、只保留当前文件，不把所有正文同时留在 Map 里。

### 3、低：`locationsOf` 只拒绝“第一个”坏位置，后面的非法位置被静默丢弃；逗号路径和 `validEvidencePath` 两端不一致
文件：`scripts/model-review/plan-claims.mjs:168-175`、`scripts/model-review/plan-claims.mjs:103-119`；测试 `test/tooling/plan-claims-gate.test.mjs:214-227`
问题：`return places.length > 0 ? places : []` 意味着第一个位置合法、后面出现 `/etc/passwd:1`、`../x:1`、空串时，非法部分被直接丢掉，既不报 `location-file-missing` 也不报 `location-missing`，只按前面的合法位置放行。测试名写“refuses a broken one”，但只测了“坏的第一个位置”。另一方面，`validEvidencePath` 允许逗号，`locationsOf` 却把逗号当分隔符：合法文件名 `foo,bar.mjs:3` 会被拆坏并报 `location-missing`；同一个值在 `claims-verdicts.jsonl` 的 `evidenceFile`（也用 `validEvidencePath`）能接受，在 `location` 里不能，符合 I-73 说的“两端校验不一致”。
证据（读代码证实）：
```js
const place = locationOf(part);
if (!place) return places.length > 0 ? places : [];
```
```js
!path.startsWith("/") && !path.startsWith("-") && ...
```
建议：任一部分解析失败就整体拒绝（`return []` 或返回一个明确的 `location-bad` 问题），并补上“合法位置在前、非法位置在后”的负用例；如果必须支持逗号路径，就把位置分隔改成不会与路径冲突的写法，或先判断整段是否是一个单一路径。

### 4、低：规则文档和模型提示词都没有写新的 ` / `、字面 `\n`、多位置，以及“至少一段 8 字符”的规则；代码里还硬编码 8 而不用 `EVIDENCE_MIN_CHARS`
文件：`.agents/instructions/model-review.md:39`、`scripts/model-review/opencode-review.mjs:330`、`scripts/model-review/plan-claims.mjs:143`、`scripts/model-review/plan-claims.mjs:162`、`scripts/model-review/plan-claims.mjs:11`
问题：文档第 39 行只说全角分号“；”可以拆分，并说“每个引文片段至少 4 个字符”；提示词只说 `<文件:行>` 单数、“逐字摘抄的一行或几行”。改动后的实际行为是：逗号分隔多位置、字面 `\n`、` / `、跨文件拼接，且要求至少一个片段不少于 8 个字符。写文档/读文档的人会按旧规则判断门槛行为。代码里 8 是字面量，而同一文件已有 `EVIDENCE_MIN_CHARS = 8`。
证据（读代码证实）：
```js
const tooShort = fragment.length < 4 && /[\p{L}\p{N}]/u.test(fragment);
...
return fragments.some((fragment) => fragment.length >= 8);
```
```js
export const EVIDENCE_MIN_CHARS = 8;
```
建议：同步更新 `model-review.md:39` 和 `opencode-review.mjs:330` 的格式说明，列出接受的分隔符、多位置、跨文件限制和 8 字符门槛；代码改用 `EVIDENCE_MIN_CHARS`，避免两处常量漂移。

### 5、低：新增“至少一段不少于 8 字符”的收紧会让原先合法的 4–7 字符多段引文失败，但没有对应测试和文档
文件：`scripts/model-review/plan-claims.mjs:143`（旧代码见 `git diff a79f8dbc..8fd309626` 中 `fragmentsInOrder` 的改动）
问题：旧代码只要求每个片段至少 4 个字符、且至少有一个片段；新代码额外要求至少一个片段不少于 8 个字符。于是 `foo();；bar();` 这种两段各 6 字符、都在文件里按顺序存在的引文，从“通过”变成“不通过”。作者的说法（第 3 条）承认这是有意的，但第 39 行文档的“每个引文片段至少 4 个字符”没有写这条额外要求，新增测试里也没有 4–7 字符的用例来锁住它。结果是合法引文会被报 `code-quote-not-in-file`，合并门槛要靠手写 `model-wrong` 才过。
证据（读代码证实）：
```js
return fragments.some((fragment) => fragment.length >= 8);
```
建议：如果这是需要的安全收紧，补一条 4–7 字符多段引文应失败的负用例并在文档里写明；如果不是，改成“至少有一个长度达到 `EVIDENCE_MIN_CHARS` 的片段，或总长度达到门槛”。

### 6、低：`claimEvidenceProblem` 的多位置主循环没有端到端测试，新增测试只覆盖了两个纯函数
文件：`scripts/model-review/plan-claims.mjs:181-198`；测试 `test/tooling/plan-claims-gate.test.mjs:214-251`
问题：新增用例只测 `locationsOf` 和 `quoteInText`，没有经过 `claimsProblems`/`claimEvidenceProblem` 跑一条多位置 CLAIM。因此“第二个文件不存在报 `location-file-missing`”“第二个位置行号越界报 `location-line-out-of-range`”“跨文件引文按什么规则处理”“尾部非法位置被丢弃”这些新行为都没有自动检查。
建议：在 gate 测试里加一个多位置 CLAIM 夹具：同文件 `a:1,a:5`、两文件 `a.mjs:1,b.mjs:1`（分别测正常、第二个文件缺失、第二个行号越界），以及合法位置后跟非法路径的负用例；这些用例一旦按上面的建议改 `locationsOf`，还要能证明旧行为会失败。

**侧重检查**

- 错误路径/不合规范输入：读代码确认 `locationsOf` 对空的、`-`、首个裸行号、绝对路径、`..`、`.agents/reviews/`、`-` 开头路径的拒绝；发现“合法位置后跟非法位置”被静默丢弃（意见 3）。`找不到` + 首个裸行号（如 `127,a.mjs:3`）现在按“没有位置”放行，旧代码会把它当成路径 `127,a.mjs` 去查，这也属于意见 3 的宽松面。
- 安全：`blobAt` 用 `spawnSync("git", [...])` 数组参数，不经过 shell；路径不允许绝对路径、`..`、空段、`-` 开头；没有读到仓库外文件。尾部非法位置虽然被丢弃，但没有发生仓库外读取，所以定为低。
- 资源耗尽：见意见 2；位置数、读取字节数都没有上限，且所有正文同时驻留。
- 不可撤销操作：本次改动没有新增写入或删除；`opencode-review.mjs` 的 `low-fix`/`override` 追加路径未被本轮改动，新增测试也没有写账本。
- 规则/文档与代码一致：见意见 4；`model-review.md:39`、`opencode-review.mjs:330` 都与新行为不一致；另外 `EVIDENCE_MIN_CHARS` 与硬编码 8 重复。
- 作者说法核对：第 1 条（坏 verdicts 仍报出来）与 `lowFixProblems` 的 catch 及新测试一致；第 2 条只是记录，因 sparse checkout 和记录路径限制未读到原文，标「未核实」，但不影响代码；第 3 条的实现描述与代码一致（含“第一个位置坏就整个拒绝”，但没有说尾部坏位置会被静默丢弃）；第 4 条的新增用例确实存在。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。本次改的是模型回答之后的证据检查（`claimEvidenceProblem`/`quoteInText`）和测试，不参与 `buildPrompt`，没有改系统提示、工具定义、历史消息或遮盖结果；发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里（`.claude/rules/prompt-prefix.md` 第 1、2、4 条）。plan-claims 的提示词本轮也没有改。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新逻辑只产生一个布尔结果和问题字符串，输入是模型答案和 HEAD 里的文件字节；没有时间字段、随机数、无序集合或依赖前后请求的状态。`texts` 的 Map 顺序由位置列表决定，`join` 也是确定的。同一个答案和同一个 HEAD 每次得到同一结果，但不会改变任何发给模型的字节。

3. **有没有自动检查，反向用例在旧代码上真的会失败吗？** 有新增检查，但要分开看：
   - `locationsOf` 在旧提交里不存在，新增用例在旧代码上会因导入失败而失败（形式上的“失败”）。
   - `quoteInText` 的两个新增正向用例（字面 `\n`、` / `）和多行代码用例在旧代码上确实失败：旧代码只按 `；` 拆，整段不匹配。
   - 反向用例（`MemoryMax...` 反序、`]), / ;`、`MemoryHigh...；20G` 等）在旧代码上也会通过，它们只防“新代码放得太宽”，不能证明旧 bug 存在。` / ` 与除号的误伤：完全一致的除号引文会先被整段检查命中，不会误伤；风险是整段不命中时把斜杠两侧的真实片段拼成假引文，这正是意见 1。
   - 低修复那条新测试（malformed verdicts）在旧代码上也会通过，因为 `lowFixProblems` 的 catch 在增量之前已存在；它补的是覆盖，不是会失败的回归测试。
   - 最重要的缺口：多位置主循环没有端到端用例，见意见 6。

4. **新值产生端和使用端都接受吗？** `locationsOf` 产生的 `{path,line}` 数组只有 `claimEvidenceProblem` 和测试在用，行号逐文件校验、`blobAt` 的路径校验都在使用端；这部分两端一致。不一致在位置字段的语法上：产生端（模型提示词）只写了单个 `<文件:行>`，没有说逗号多位置和 ` / `、`\n`；`validEvidencePath` 允许带逗号的路径，而 `locationsOf` 把逗号当分隔符，导致同一个路径在 `evidenceFile` 能接受、在 `location` 不能（意见 3）。`范围写法 a.mjs:9-12` 仍只取起始行 9，和旧行为一致，但新测试把它固化了，文档没有说明。
