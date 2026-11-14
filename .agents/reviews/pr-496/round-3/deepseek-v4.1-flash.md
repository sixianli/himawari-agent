## 范围与上一轮

- 这一轮先看 `git diff 7233dfda2..6f54f2e18`：增量只有 `test/tooling/environment.test.mjs` 的白名单和 `.agents/reviews/pr-496/usage.jsonl`，没有新的运行时代码。
- 为核对上一轮修复，读了 `2d5a0abd7`、`7233dfda2`、`6f54f2e18` 的 diff，以及 `scripts/model-review/opencode-review.mjs`、`scripts/model-review/plan-claims.mjs`、相关测试、ADR 0270 和 `.agents/instructions/model-review.md`；并用 `git show HEAD:.claude/rules/prompt-prefix.md` 读了前缀规则。
- 上一轮的判断原文（`.agents/reviews/pr-496/round-2/judgments.md`、`verdicts.jsonl`）在当前 sparse checkout 里不存在，`git show` 又被记录路径守卫拒绝（`REVIEW_GIT_REFUSED records-path`），因此**无法逐条读到上一轮意见原文**。能从提交 diff 核对的是：目录外导入文件已纳入缓存键并有“改文件换键”测试（`7233dfda2`）；`outsideImports`、旧基线 `runHead`、拒绝写入的 try/catch 已加上（`2d5a0abd7`）；本次增量测试放行了自检缓存环境键。这些修复在代码里确实存在。
- 受工具限制，**没有运行测试**；下面的反向用例判断来自读测试断言，不是执行结果。

---

### 1. 中：`commitInPullRequest` 信任账本里未校验的 `head`，可把任意旧 main 提交当作“运行基线”绕过 `commit-not-in-pr`

文件:行：`scripts/model-review/plan-claims.mjs:173-185`，调用处 `scripts/model-review/plan-claims.mjs:361`，账本校验 `scripts/model-review/opencode-review.mjs:2034-2037`。

问题：`record.head` 只被校验成 40/64 位十六进制，没有被校验成“这次 plan-claims 真正复核的提交”或“PR 自己的提交”。它随后作为 `runHead` 传进 `commitInPullRequest`，其中的 `commit === mergeBase(mainRef, runHead)` 分支会直接放行。

证据：

```js
export function commitInPullRequest(repo, commit, head, mainRef, runHead = head) {
  if (!COMMIT_PATTERN.test(commit)) return false;
  const baseCommit = mergeBase(repo, mainRef, head);
  if (baseCommit === null || !isAncestor(repo, commit, head)) return false;
  if (commit === baseCommit) return true;
  if (
    runHead !== head &&
    COMMIT_PATTERN.test(runHead ?? "") &&
    isAncestor(repo, runHead, head) &&
    commit === mergeBase(repo, mainRef, runHead)
  )
    return true;
  return !isAncestor(repo, commit, baseCommit);
}
```

构造方式：在某个 topic 的 `usage.jsonl` 里提交一条 `mode: "plan-claims"`、`outcome: "ok"`、`head: H` 的记录，其中 `H` 是任意旧 main 提交。此时 `mergeBase(origin/main, H) === H`，只要 `H` 是 `head` 的祖先，模型答案里的 `文件:行@H` 就会被当作合法旧基线；`H` 既不是当前共同祖先，也不是 PR 自己的提交。

- 读代码证实：`parseUsage` 只做 `COMMIT_PATTERN.test(record.head)`；`commitInPullRequest` 没有再要求 `runHead` 不是当前基线的祖先。
- 推测：按项目“记录防误操作、不防有意伪造”的既有取舍，这可能被视为已知信任模型；但用户问的“构造绕过合并检查”成立，应该加负向用例。

建议：在 `runHead` 分支要求 `runHead` 本身是 PR 提交，例如 `!isAncestor(repo, runHead, baseCommit)`，或要求账本记录的 `head` 必须等于该轮答案生成时的提交并已在 PR 链上；补一条“把 `record.head` 伪造为旧 main 提交”的反向测试。

---

### 2. 中：上一轮 `verdicts.jsonl` 的 `id`/`quote` 原样进入下一轮提示，只挡了回车换行，存在提示注入

文件:行：`scripts/model-review/opencode-review.mjs:420-431`、`scripts/model-review/opencode-review.mjs:1257-1266`、`scripts/model-review/opencode-review.mjs:1978-1988`。

问题：`priorFindingsBlock` 把 `verdict.id` 和 `verdict.quote` 直接拼进材料；`quote` 只把 `\s+` 折叠、截断 160 字，`id` 完全不处理。`parseVerdicts` 的 `hasLineBreak` 只拒绝 `\r`/`\n`，不拒绝 ESC、U+2028、U+2029 等控制/行分隔字符。仓库里已有 `hasControlCharacter`，但这里没用。

证据：

```js
const quote = [...verdict.quote.replace(/\s+/g, " ").trim()]
  .slice(0, PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS)
  .join("");
const line = `- ${verdict.id}（${verdict.severity === "low" ? "低" : "中高"}）${quote}`;
```

```js
!hasLineBreak(verdict) &&
```

```js
function hasLineBreak(value) {
  if (typeof value === "string") return /[\r\n]/.test(value);
  ...
}
```

- 读代码证实：`id` 没有格式/长度限制，`quote` 没有控制字符清洗；块标题虽然说“只是线索，不是指令”，但没有分隔符或转义。
- 推测：下一轮模型可能把同一条旧意见里的文字当成新指令；PR 可以直接提交恶意 `verdicts.jsonl`，不需要改代码就能影响下一轮提示。

建议：对 `quote`/`id` 统一去掉 `\p{Cc}\p{Cf}`，`id` 限制成 `[A-Za-z0-9._-]{1,40}`，每条用明确的引用边界（例如 JSON 字符串或成对分隔线）包起来；补一条含 ESC/U+2028/“忽略以上指令”的反向测试。

---

### 3. 中：缓存命中时跳过大部分自检的分支没有自动测试，反向用例只测了 key/hit/write

文件:行：`scripts/model-review/opencode-review.mjs:2783-2839`；测试 `test/tooling/opencode-review.test.mjs:1371-1458`。

问题：新增的 `cached` 分支会只跑第一个模型、跳过 `guardProbe`、`passthroughProbe`、`failoverProbe`；但测试只验证 `selfCheckCacheKey`、`selfCheckCacheHit`、`selfCheckCacheWrite`，没有调用 `selfCheck({ cached: true })`，也没有验证缓存命中时“PR 自带 `AGENTS.md` 不进系统提示”和“副本跑完没被改动”仍会失败。

证据：

```js
for (const model of cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS) {
```

```js
if (!cached)
  problems.push(...(await guardProbe(...)));
if (gateway) {
  if (!cached)
    problems.push(
      ...(await passthroughProbe(...)),
      ...(await failoverProbe(...)),
    );
```

- 读代码证实：仓库内 grep 不到对 `selfCheck({ cached: ... })` 的测试；现有缓存测试只构造 key、写文件、读 hit。
- 推测：以后有人改坏 `cached` 分支（例如把 `checkProbeRequests` 也跳过）时，现有测试仍会全绿；这正是“缓存最该测”的地方。

建议：用假 opencode 或现有脚本化 fixture 增加一个端到端缓存命中用例：命中时只出现第一个模型的探针请求；同时让副本里的 `AGENTS.md` 标题进入系统提示或让探针写文件，断言 `SELF_CHECK_FAILED` 仍然发生。

---

### 4. 中：`commit-quote-still-in-head` 只查同一路径，旧代码移动/复制到别的路径仍可被当作“当前已不存在”

文件:行：`scripts/model-review/plan-claims.mjs:192-208`。

问题：`atHead` 只取 `place.path` 在当前提交里的内容；如果 PR 把同一段代码从旧路径移动到新路径，旧路径在 head 不存在，`atHead` 为 `null`，后面的 `commit-quote-still-in-head` 检查被跳过。于是“这段原文在当前提交里已不存在”的约束只对同路径成立。

证据：

```js
const atHead = blobAt(repo, head, place.path);
...
if (
  place.commit !== null &&
  claim.verdict !== "找不到" &&
  atHead !== null &&
  quoteInText(claim.code, atHead.toString("utf8"))
)
  return "commit-quote-still-in-head";
```

- 读代码证实：检查范围只有 `place.path`；测试 `test/tooling/plan-claims-gate.test.mjs:405-417` 只覆盖同路径删除，没有覆盖重命名/复制。
- 推测：PR 可以把仍在使用的代码从 `a.ts` 移到 `b.ts`，然后对 `a.ts` 用旧提交引用，声称“原来”的代码已删除，实际同一原文仍在 head 的 `b.ts`。

建议：对 `@提交` 的引用，至少用 `git grep -F`/`git grep -z` 在当前提交里搜整段原文，或同时检查重命名后的路径；补一条“代码移动后旧路径不存在、但新路径仍有原文”的反向测试。

---

### 5. 低：自检缓存键对大文件只记大小和 mtime，且不覆盖 Magpie 插件文件内容

文件:行：`scripts/model-review/opencode-review.mjs:2636-2648`、`scripts/model-review/opencode-review.mjs:2695-2710`；`scripts/model-review/gateway.mjs:296-357`。

问题：`fileFingerprint` 对 `<1MB` 的文件算 sha256，对 `>=1MB` 的文件只记 `size`/`mtimeMs`。缓存键里 `gateway.install` 只有 `binary`、`binarySha256`、`pluginDir`、`cacheDir`、`version` 等路径/元数据；`binaryProblem` 只核对 `magpie` 二进制，不核对插件文件内容。

证据：

```js
return {
  path,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  sha256: stat.size < SELF_CHECK_CACHE_SMALL_FILE_BYTES ? sha256File(path) : null,
};
```

```js
gateway: gateway ? { install: gateway.install, config: gateway.config } : null,
```

- 读代码证实：大文件内容不在摘要里；`binaryProblem(gateway.install)` 只对 `install.binary` 算 sha256。
- 推测：opencode 平台二进制大于 1MB 时，替换成同大小、同 mtime 的文件不会换 key；Magpie 插件文件被改也不会换 key，缓存命中会跳过 passthrough/failover 探针，最多 7 天不发现。是否可实际利用取决于文件大小和攻击面，但“环境变了还放行”的窗口确实存在。

建议：对 `binary`、`git`、`bash`、`process.execPath` 和 Magpie 插件关键文件使用内容摘要，或在缓存命中时仍核对插件目录摘要/完整性标记；至少不要只依赖 size+mtime。

---

### 6. 低：`priorFindingsBlock` 从工作区 `usage.jsonl` 取轮次，而 verdicts 从 HEAD 取，同一 head/previous 可能产生不同材料

文件:行：`scripts/model-review/opencode-review.mjs:3661-3670`、`scripts/model-review/opencode-review.mjs:1216-1220`、`scripts/model-review/opencode-review.mjs:412`。

问题：文档/作者说法是“上一轮已提交的 `verdicts.jsonl`”，但记录列表来自 `readUsage(options.out)`，读的是工作区文件；只有 verdicts 用 `showAt(repo, head, ...)` 从当前提交读。工作区里未提交、被手工改过的 ledger 会改变选中的轮次，甚至选中一个 HEAD 里没有对应记录的轮次。

证据：

```js
? priorFindingsBlock({
    repo: options.repo,
    ledgerPath: `${REVIEWS_DIR}/${reviewKey(options)}`,
    records: readUsage(options.out),
    previous: commits.previous,
    head: commits.head,
  })
```

```js
export function readUsage(out) {
  const path = join(out, "usage.jsonl");
  if (!existsSync(path)) return [];
  return parseUsage(readFileSync(path, "utf8"), path);
}
```

- 读代码证实：记录来自文件系统工作区，不是 `git show HEAD:...`。
- 推测：同一 `head`/`previous` 在两台机器或一次未提交账本改动后会带入不同的上一轮意见；虽然仍在“本次材料”里，不破坏固定前缀，但不符合“已提交”的可复现语义。

建议：从 `showAt(repo, head, `${ledgerPath}/usage.jsonl`)` 解析记录，或至少只接受已提交且在 HEAD 里的 ledger 内容。

---

### 7. 低：`low-fix-refusals.jsonl` 追加没有补换行，已有文件缺尾换行时会写出非法 JSONL

文件:行：`scripts/model-review/opencode-review.mjs:1654-1665`；对比同一函数里的 ledger 写入 `:1670-1672`。

问题：正常账本写入会检查 `shown.stdout.endsWith("\n")`，新的拒绝记录直接 `appendFileSync`。如果 `low-fix-refusals.jsonl` 是手工创建/上次写入中断且没有末尾换行，下一次会拼成 `...}{...}` 同一行，后续统计无法按行解析。

证据：

```js
appendFileSync(
  refusalsFile,
  ledgerLine({
    at: new Date().toISOString(),
    round: acceptLow,
    head,
    reasons: reasons.map((reason) => reason.split(" ")[0]),
  }),
);
```

```js
appendFileSync(
  ledgerFile,
  `${shown.stdout && !shown.stdout.endsWith("\n") ? "\n" : ""}${ledgerLine({...})}`,
);
```

- 读代码证实：拒绝文件没有换行保护，也没有 `existsSync(refusalsFile)` 的空文件/尾换行判断。
- 推测：统计端按行读取时会漏掉或报错；目录不存在时（`if (existsSync(dirname(refusalsFile)))`）则完全静默不记，和文档“每次拒绝都追加”不一致。

建议：仿照 ledger 写入补前导换行，或在目录不存在时创建目录并记录失败原因；补“已有文件无尾换行”的测试。

---

### 8. 低：拒绝记录路径可被仓库里的符号链接指向仓库外，`appendFileSync` 会跟随写入

文件:行：`scripts/model-review/opencode-review.mjs:1654-1665`。

问题：`refusalsFile` 在 PR 可控制的 `.agents/reviews/pr-<编号>/` 下。如果 PR 提交一个符号链接 `low-fix-refusals.jsonl -> 仓库外文件`，`existsSync(dirname(...))` 为真，`appendFileSync` 会跟随符号链接，把 JSON 行写到目标文件。代码没有 `lstat`/`O_NOFOLLOW` 检查。

证据：

```js
const refusalsFile = join(repo, ledgerPath, "low-fix-refusals.jsonl");
if (existsSync(dirname(refusalsFile)))
  try {
    appendFileSync(refusalsFile, ledgerLine({...}));
```

- 读代码证实：没有检查 `refusalsFile` 是否为普通文件；`appendFileSync` 默认跟随符号链接。
- 推测：这是新的、由不可信仓库内容触发的越界写路径；内容只是受控 JSON，但足以破坏目标文件。属于低到中等的安全面，取决于 CI 工作目录权限。

建议：写入前 `lstatSync` 拒绝符号链接/非普通文件，或使用 `O_NOFOLLOW` 打开；也可以把统计写到仓库外由调用方指定的位置。

---

### 9. 低：`locationOf` 正则未锚定结尾，`文件:行@` 或合法哈希后带垃圾会被接受

文件:行：`scripts/model-review/plan-claims.mjs:104-112`。

问题：正则 `^` 开头但没有 `$`，`([0-9a-f]+)` 贪婪但后面允许任意字符。`file:10@` 会匹配成 `commit = null`，被当成当前提交位置；`file:10@<40位hex>垃圾` 会截取前 40 位并通过。格式不严格，模型输出里的错误不容易暴露。

证据：

```js
const match = /^`?([^\s:`]+):(\d+)(?:@([0-9a-f]+))?/.exec(location.trim());
...
const commit = match[3] ?? null;
if (commit !== null && !COMMIT_PATTERN.test(commit)) return null;
```

- 读代码证实：没有结尾锚点；`@` 后无哈希时不会报错。
- 推测：不影响正常路径，但会让“完整提交哈希”的格式约束名不副实，也可能让手工构造的畸形输入悄悄降级成当前提交。

建议：改为 `^...:(\d+)(?:@([0-9a-f]{40}|[0-9a-f]{64}))?$`，或显式拒绝“出现 @ 但后面不是完整哈希”的情况；补 `file:10@`、尾部垃圾的负向用例。

---

### 10. 低：环境边界测试只放行新环境键，没有断言它的值仍是 `off`

文件:行：`test/tooling/environment.test.mjs:45-52`、`vitest.workspace.ts:14`。

问题：测试只检查 `Object.keys(tooling.env)` 里允许出现 `HIMAWARI_REVIEW_SELFCHECK_CACHE`，不检查它的值。把 `vitest.workspace.ts` 里的 `"off"` 误改成 `""` 或某个真实目录时，这个测试仍通过，工具测试会开始读写宿主真实自检缓存。

证据：

```js
Object.keys(tooling.env).every(
  (name) =>
    name.startsWith("GITHUB_") ||
    name === "HIMAWARI_REVIEW_GATEWAY" ||
    name === "HIMAWARI_REVIEW_SELFCHECK_CACHE",
)
```

```ts
HIMAWARI_REVIEW_SELFCHECK_CACHE: "off",
```

- 读代码证实：测试没有值断言。
- 推测：这是本次增量唯一改动的测试，正是最该把“off”钉住的地方。

建议：在 `expect(tooling.env).toMatchObject({...})` 里加 `HIMAWARI_REVIEW_SELFCHECK_CACHE: "off"`，或单独断言该值。

---

### 11. 低：作者说“固定前缀不变”，但 plan-claims 的 `task`/`output` 属于固定前缀，本次确实改了

文件:行：`scripts/model-review/opencode-review.mjs:327-331`、`scripts/model-review/opencode-review.mjs:366-377`、`scripts/model-review/plan-claims.mjs:13-15`。

问题：`buildPrompt` 的 `fixed` 数组包含 `text.task` 和 `text.output`；本次给 plan-claims 的 `task` 增加了 `@完整提交哈希` 的说明，`output` 又通过 `CLAIMS_LINE_FORMAT` 改了格式。作者说法里“固定前缀和必答问题不变”按字面不成立；代码复核模式（A）的固定前缀确实未变，但 plan-claims 的固定前缀变了。

证据：

```js
task: "下面是一份还没合并的方案或 ADR。... 证据位置写成 文件:行@完整提交哈希，...",
output: `输出格式：...\n${CLAIMS_LINE_FORMAT}\n...`,
```

```js
const fixed = [
  text.role,
  ...,
  text.task,
  ...,
  text.output,
].join("\n");
```

- 读代码证实：`task`/`output` 在固定前缀里；本次 diff 改了它们和 `CLAIMS_LINE_FORMAT`。
- 推测：同一版本内各 plan-claims 轮次仍然一致，不会破坏同一对话的 KV 缓存；但跨版本继续同一 ADR 的核对时，前缀会变一次。是否算违规取决于“所有轮次”是否跨代码版本理解。

建议：把说法收窄为“代码复核模式固定前缀不变”，或在 ADR/说明里明确 plan-claims 这次是一次性的前缀变更及其缓存影响。

---

## 侧重检查

- **错误路径/不可信输入**：查了上一轮 verdict 文本注入（发现 2）、`@提交哈希` 与账本 `head` 的信任边界（发现 1）、`locationOf` 的格式边界（发现 9）、拒绝记录写入（发现 7/8）、缓存损坏/过期/未来时间戳（`selfCheckCacheHit` 对 JSON 损坏、key 不匹配、`at` 非有限、未来 `at`、过期都返回 `false`）。
- **安全**：查了提示注入、符号链接追加写、缓存投毒（缓存目录可写者伪造 `{key, at}` 即可命中；目录是用户目录，风险取决于共享方式）、大二进制/插件内容不进摘要（发现 5）。
- **资源耗尽**：`priorFindingsBlock`/`parseVerdicts` 会把整份 `verdicts.jsonl` 读入内存并 `sort`，`showAt` 的 `maxBuffer` 是 256MB；缓存文件只增不清理；拒绝记录只追加不轮转。没有发现新的无限循环，但这些都是可被大文件放大的点。
- **不可撤销操作**：`assertReviewed` 会向工作区追加 `usage.jsonl` 或 `low-fix-refusals.jsonl`，没有事务/回滚；符号链接会放大为仓库外写入（发现 8）；重复运行会重复追加拒绝记录（文档说“每次”，可接受但会放大统计）。
- **缓存目录并发/损坏**：写入是“临时文件 + rename”，同一 key 的并发写不会读到半截文件；损坏 JSON、错 key、过期、未来时间戳都按 miss 处理；`off` 时不写不读。残留问题是临时文件只按 pid 命名、不清理、不检查 `lstat`，以及缓存文件没有大小上限/目录权限已存在时不 `chmod`。
- **规则、说明文档与代码一致性**：`model-review.md` 对 `@提交` 的说明基本覆盖了代码里的旧基线分支；ADR 0270 第 57 行只写“当前基线或 PR 提交”，没有写“运行记录的 `head` 的共同祖先”这一分支，比代码窄。低严重度测试文件模式与文档一致；`.md` 排除、`test_*.py`/`*_test.*`/`*Test.java` 与代码一致。拒绝记录“每次拒绝都追加”与目录不存在时静默不记不完全一致（发现 7）。
- **上一轮意见**：原文读不到；按提交 diff 看，上一轮指出的目录外导入缓存键、旧基线引用、拒绝写入异常处理都已落地，未发现增量引入的新运行时代码错误。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

- 代码复核模式：不会。`buildPrompt` 的 `fixed` 仍由静态 `MODE_TEXT`、`FOCUS_SENTENCE`、`RULE_16_SENTENCE`、必答问题、模型侧重和输出格式组成；`head`、`base`、`previous`、`priorFindings`、`claimsBase`、`brief` 全在 `---- 本次材料 ----` 之后。新增的上一轮意见块和 `claimsBase` 都只进材料，属于最后一条用户消息；工具定义和系统提示没有变。代码复核的上一轮统计、收窄指令在材料里，不在固定前缀。
- plan-claims：**固定前缀变了**。`text.task` 和 `text.output` 是固定前缀的一部分，本次给它们加了 `@完整提交哈希` 说明并改了 `CLAIMS_LINE_FORMAT`，所以与旧版本 plan-claims 请求的开头不再逐字节相同。若“所有轮次”只指同一版本的各轮，则内部一致；若要求跨版本也不变，则不符合（发现 11）。
- 每轮会变的值是否都在最后一条消息：是。`priorFindings`、`claimsBase`、`head`、`base`、`previous`、`brief` 都在材料段；没有发现把轮次、报价、哈希写进系统提示或工具定义。`priorFindingsBlock` 从工作区 ledger 取记录，可能让同一 `head` 的材料不同，但仍在最后一条消息里（发现 6）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- 固定前缀和工具定义：代码复核模式是确定的；plan-claims 因本次改文字，跨版本不同。
- 上一轮意见块：排序按严重度用稳定排序，输入相同则输出相同；脚本摘要、目录外导入、环境键列表都有固定排序/固定键顺序；缓存键无时间字段；提示里没有新增时间字段。`low-fix-refusals` 有 `at`，但不进提示和缓存键。
- 例外是发现 6：`readUsage(options.out)` 读工作区，同一 `head`/`previous` 可能因未提交 ledger 而带入不同意见；这是材料内的变化，不是固定前缀变化。
- 遮盖：提示写入仓库时仍走 `maskSecretLike`；同一组登记测试值下是确定的。`priorFindingsBlock` 的文本不参与发送前的遮盖，只影响模型输入，不改变“遮出的字节”规则。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

- 有：缓存 key 的目录外导入、环境变量、二进制变化、过期/损坏文件；上一轮意见的排序、上限、固定前缀位置；`isTestFile` 的新模式正反列表；`@提交` 的旧基线、外部提交、短哈希、同路径仍在 head；判断沿用的证据消失/不同句子；拒绝记录的原因和写入失败；环境边界白名单。
- 反向用例从断言看是有力的：目录外 import 改变应换 key（去掉 `7233dfda2` 的修复会失败）；前缀测试要求 `later.slice(0, fixedEnd) === first.slice(0, fixedEnd)`（把 priorFindings 放进固定前缀会失败）；`isTestFile` 有 `ParserTests.java`、`test_README.md` 等负例；`@提交` 有 stranger/short/still-in-head；沿用在证据删除后期望报错。
- 缺口：`selfCheck({ cached: true })` 的端到端行为没有测试（发现 3）；缓存键没有覆盖 >1MB 同大小同 mtime 的变化（发现 5）；没有控制字符/注入的修订测试（发现 2）；没有 64 位哈希、代码移动、`locationOf` 尾部垃圾、伪造 `record.head` 的负例；环境测试没有断言值是 `off`（发现 10）；新的 Python/Go/Rust/Java 模式只测了 `isTestFile` 单元，没有走 `--accept-low` 的 `no-test-change` 集成路径。**未实际运行测试**，以上是按测试断言推断。

**4. 每个新产生的值，使用端都能接受吗？**

- `HIMAWARI_REVIEW_SELFCHECK_CACHE`：`selfCheckCacheDir`、`vitest.workspace.ts`、`environment.test.mjs` 三处名字一致；值是字符串或 `off`；但测试只接受键名、不校验 `off`（发现 10）。
- 缓存 key：`selfCheckCacheKey` 产出 64 位 sha256，`selfCheckCacheHit/Write` 拿它拼 `${key}.json`；hit 会复核 `record.key === key`，接受。格式本身安全。
- `priorFindingsBlock` 输出：`buildPrompt` 直接拼接，接受任意字符串；没有转义/控制字符校验（发现 2）；6000 字节上限只约束条目行，标题和“另有”行另算，测试允许到 6600。
- `claimsBase`：由 `main` 的 `git merge-base origin/main <head>` 产出，进材料；哈希格式安全。与合并检查的 `--main-ref` 可能不同，文档已注明。
- `文件:行@完整提交哈希`：`locationOf` 产出 `{path,line,commit}`，`claimEvidenceProblem` 消费；两端都用了 `COMMIT_PATTERN`（`plan-claims.mjs` 与 `opencode-review.mjs` 各有一份，目前相同）。未锚定结尾（发现 9）；移动代码检查不足（发现 4）；`record.head` 作为 `runHead` 未校验（发现 1）。
- `record.head` 作为 `runHead`：`parseUsage` 只校验 40/64 位格式，`commitInPullRequest` 接受任意祖先；可以构造（发现 1）。
- `carried` 的键：`collapse(claim.sentence)` 生产、`collapse(claim.sentence)` 消费，折叠规则一致；但 `parseClaims` 允许空 `sentence`，空句子会与另一条空句子碰撞，建议在解析时拒绝空句子。
- `isTestFile` 新模式：被 `lowFixProblems` 的 `changes.some((change) => isTestFile(change.file) && change.added > 0)` 消费；正例覆盖 `test_*.py`、`*_test.py/go/rs`、`*Test.java`，负例覆盖 `contest.py`、`test_helper.ts`、`README.md`；没有发现把明显非测试文件当测试的模式。`*Tests.java` 被刻意判为非测试，和文档一致，但可能是实际漏判，不属于安全问题。
- `low-fix-refusals.jsonl`：生产者是 `assertReviewed`，仓库里没有代码读取端（文档说用于统计）；因此没有“读取端校验”可核对。格式由 `ledgerLine` 生成，内容只有轮次、提交、原因词；缺尾换行（发现 7）和符号链接（发现 8）是新问题。
- `CLAIMS_LINE_FORMAT`：prompt 和测试消费，已同步；但它属于 plan-claims 固定前缀，造成跨版本前缀变化（发现 11）。
