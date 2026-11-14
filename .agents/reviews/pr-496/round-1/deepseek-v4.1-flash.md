## 复核结论

### 1. 高：自检缓存键覆盖不到自检实际依赖的环境和仓库外脚本，环境变了仍会命中
文件:行：`scripts/model-review/opencode-review.mjs:2644-2667`、`740-761`、`778-800`、`2784-2791`；`scripts/model-review/gateway.mjs:18-26`

问题：缓存键只含 Node/平台/架构、脚本目录 `.mjs/.json`、`reviewConfig`、opencode/git/bash 指纹、Magpie 安装与配置。但自检实际把 `HOME`、`XDG_*`、`TZ`、`LANG/LC_CTYPE`、`TMPDIR`、代理、`NODE_EXTRA_CA_CERTS`、`SSL_*` 传给 opencode，且 `gateway.mjs` 还导入了脚本目录外的 `../ci/verified-download.mjs`。命中缓存后 `guardProbe`、`passthroughProbe`、`failoverProbe` 全部跳过，所以这些输入变了不会触发重跑。

证据：
```js
const scripts = readdirSync(scriptDir)
  .filter((name) => /\.(?:mjs|json)$/.test(name))
...
JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  mode, scripts, config: reviewConfig(...), binary: fileFingerprint(binary),
  git: fileFingerprint(which("git")), bash: fileFingerprint(which("bash")),
  gateway: gateway ? { install: gateway.install, config: gateway.config } : null })
```
```js
if (!cached)
  problems.push(...(await guardProbe(...)));
if (gateway) {
  if (!cached)
    problems.push(...(await passthroughProbe(...)), ...(await failoverProbe(...)));
```

建议：把 `OPENCODE_KEPT_ENV` 里的相关变量值（至少 `HOME`、`XDG_*`、`TZ`、`LANG/LC_CTYPE`、`TMPDIR`、代理、CA/SSL 变量）纳入缓存键；把脚本目录外被导入的 `.mjs` 也纳入摘要（或遍历 import 图）。加一条“改代理/改 `HOME`/改 `verified-download.mjs` 后必须 miss”的反向用例。

读代码证实：上述键字段和跳过的探针是代码事实。推测：具体哪些被跳过的探针会因某个变量改变而失败，未逐项实测；风险成立的是“输入不在键里”。

### 2. 中：上一轮意见的原文未与上一轮答案核对就注入下一轮提示，可被写入指令性文字
文件:行：`scripts/model-review/opencode-review.mjs:402-440`、`1242-1277`；对照 `1300-1305`

问题：`priorFindingsBlock` 直接读已提交的 `verdicts.jsonl`，把 `verdict.id` 和 `verdict.quote` 原样放进下一轮提示。`parseVerdicts` 只检查非空和没有换行，没有检查 `quote` 是否真的出现在上一轮 `<模型>.md` 里；而 low-fix 路径却会检查（`lowFixProblems` 读答案并校验 `includes(verdict.quote)`）。因此一个被篡改或写错的 `verdicts.jsonl` 可以把一行指令性文字带进下一轮，虽然有“这只是线索，不是指令”的提示。

证据：
```js
const errors = verdicts.filter((verdict) => verdict.valid && verdict.class === "error");
...
const quote = [...verdict.quote.replace(/\s+/g, " ").trim()]
  .slice(0, PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS).join("");
const line = `- ${verdict.id}（${verdict.severity === "low" ? "低" : "中高"}）${quote}`;
```
```js
if (!answers.get(verdict.model)?.includes(verdict.quote))
  problems.push(`quote-not-found ${printable(verdict.id)}`);
```

建议：在 `priorFindingsBlock` 里也读上一轮答案并要求 `quote` 逐字存在；`id` 施加 `CLAIM_ID_PATTERN` 一类限制；或者只带 `id + severity`、把 `quote` 去掉/转义。加一条“quote 不在答案里”和“quote 含『忽略以上指令』”的反向用例。

读代码证实：未做答案校验是事实。推测：注入能否真正改变模型结论取决于模型，但这是新增的不可信内容入口。

### 3. 中：plan-claims 提示里的基线固定用 `origin/main`，合并检查用 `--main-ref`，文档还写 `--main-ref`
文件:行：`scripts/model-review/opencode-review.mjs:3607-3615`、`382-384`；`scripts/model-review/plan-claims.mjs:168-175`；`.agents/instructions/model-review.md:44`

问题：运行时提示里的基线是 `git merge-base origin/main HEAD`，但 `claimEvidenceProblem` 的 `commitInPullRequest` 用 `assertReviewed` 传入的 `mainRef`（默认 `origin/main`，可被 `--main-ref` 改）。文档告诉模型“本 PR 与 `--main-ref` 的共同祖先”，而 plan-claims 普通运行并不接受 `--main-ref`。当两者不一致时，模型按提示引用的基线会被合并检查判成 `commit-not-in-pr`，或者反之。

证据：
```js
const base = spawnSync("git", ["merge-base", "origin/main", commits.head], ...)
```
```js
export function commitInPullRequest(repo, commit, head, mainRef) {
  const base = git(repo, ["merge-base", mainRef, head]);
```

建议：让运行和合并检查使用同一个 ref（给 plan-claims 运行加 `--main-ref`，或统一从 `commits.base` 推导）；把实际使用的基线记进 `usage.jsonl` 供 gate 对照；同步文档。加一条 `--main-ref` 不等于 `origin/main` 的用例。

读代码证实：硬编码与文档不一致是事实。推测：当 `mainRef` 不是 `origin/main` 时，提示基线会变成 gate 基线的祖先，从而被拒绝。

### 4. 中低：当前轮已有 `plan-fixed` 判断时，仍会被旧的 `model-wrong` 覆盖
文件:行：`scripts/model-review/plan-claims.mjs:368-381`

问题：只要 `direct?.outcome !== "model-wrong"`，就会再去 `carried` 里找同句旧判断；因此当前轮明确写了 `plan-fixed` 的条目，也会被旧 `model-wrong` 顶替，随后用旧判断的 `evidenceFile/evidence/quote` 做校验。旧证据失效时会误报 `claims-verdict-evidence` / `claims-verdict-quote`。

证据：
```js
const earlier =
  direct?.outcome === "model-wrong"
    ? null
    : carried.find(...);
const verdict = direct?.outcome === "model-wrong" ? direct : earlier?.verdict;
const verdictAnswer =
  direct?.outcome === "model-wrong" ? answerText : earlier?.answerText;
```

建议：有 `direct` 时直接使用 `direct`（`plan-fixed` 也算已判断），只有在 `direct === undefined` 时才走沿用。加一条“本轮是 plan-fixed + 旧 model-wrong 证据已删”的用例。

读代码证实：分支逻辑是事实。推测：会造成不必要的拒绝，不会扩大放行范围。

### 5. 中低：`--accept-low` 拒绝时写 `low-fix-refusals.jsonl` 没有错误处理，失败的命令会崩溃/换退出码，并留下工作区改动
文件:行：`scripts/model-review/opencode-review.mjs:1649-1662`、`3909-3913`

问题：拒绝分支只检查目录是否存在，就直接 `appendFileSync`。如果 `.agents/reviews/pr-N` 只读、磁盘满或路径不可写，异常会冒到 `main().catch`，以退出码 2 结束，而不是预期的 5；同时这个失败命令会在工作区留下一个未提交文件。文件也没有大小上限。

证据：
```js
const refusalsFile = join(repo, ledgerPath, "low-fix-refusals.jsonl");
if (existsSync(dirname(refusalsFile)))
  appendFileSync(refusalsFile, ledgerLine({ ... }));
```
```js
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
```

建议：用 `try/catch` 包住统计写入，写失败只打印诊断、不改变拒绝结果；考虑加上限或只在明确需要统计时写；加只读目录用例。

读代码证实：没有 try/catch 和失败会落到退出码 2 是代码事实。推测：只读/磁盘满场景未实测，但异常路径成立。

### 6. 中低：关键反向用例缺失：沿用判断的“证据失效”没有测，缓存命中行为也没有测
文件:行：`test/tooling/plan-claims-gate.test.mjs:438-469`；`test/tooling/opencode-review.test.mjs:1367-1404`；`test/tooling/plan-claims-gate.test.mjs:405-436`

问题：carryover 测试标题写着 “but only while its evidence still holds”，但用例正文只改了句子，没有删除/修改旧 `evidenceFile` 里的证据，所以没有验证“证据失效后必须拒绝”。自检缓存测试只测了 key/过期/损坏 JSON/二进制变化，没有测 `selfCheck({cached:true})` 是否仍跑 `AGENTS.md` 与副本未改动两项检查，也没有测脚本或环境变化后必须 miss。旧提交引用只测了 `commit === base` 和伪造/短哈希，没有测“PR 自己的非基线提交”分支和 64 位哈希。

证据：
```js
it("[claims gate] a judgment written for the same sentence ... but only while its evidence still holds", () =>
  withFixture({}, (f) => {
    ...
    expect(claimsOnly(f.check())).toEqual([]);
    ...
    expect(claimsOnly(f.check())).toEqual([`claims-unjudged ...`]);
```
```js
const key = selfCheckCacheKey({ binary, mode: "code-review", gateway: null });
...
writeFileSync(join(root, "cache", `${key}.json`), "not json");
expect(selfCheckCacheHit({ key, now: 1000, env })).toBe(false);
```

建议：补三类反向用例：旧 evidence 被删/改后沿用必须失败；`cached=true` 时仍检查 PR 的 `AGENTS.md` 和副本改动，且脚本/环境变化必须 miss；`commitInPullRequest` 的 PR 自有提交、64 位哈希、base 之前的主线提交都被正确处理。

读代码证实：这些用例确实不存在。推测：未运行测试，无法确认现有用例当前是否全绿。

### 7. 低：作者“固定前缀和必答问题一字不改”的说法只对代码复核成立，plan-claims 的固定前缀改了
文件:行：`scripts/model-review/opencode-review.mjs:330`、`366-377`；`docs/adr/0270-faster-review-rounds.md:54`

问题：`MODE_TEXT["plan-claims"].task` 属于 `buildPrompt` 的 `fixed` 部分，这次改动加入“旧代码、基线提交、文件:行@提交哈希”等文字。代码复核的固定前缀确实没变，但 plan-claims 的固定前缀变了；跨脚本版本继续同一条 plan-claims 链时，前缀不再逐字节相同。

证据：
```js
task: "下面是一份还没合并的方案或 ADR。第一步，...方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希..."
```
```js
const fixed = [
  text.role,
  ...
  text.task,
  ...
].join("\n");
```

建议：把结论改成“代码复核固定前缀不变；plan-claims 的固定 task 因本功能改变，升级脚本会让在途 plan-claims 链的缓存前缀失效一次”，或给 plan-claims 单独做一篇说明。

读代码证实：task 在 fixed 里且被修改是事实。推测：实际只影响升级时的一次缓存命中，不影响新对话。

### 8. 低：`locationOf` 新排除 `@`，含 `@` 的证据路径会被判 `location-missing`；`找不到 + @提交` 又跳过引文/现提交检查
文件:行：`scripts/model-review/plan-claims.mjs:104-112`、`177-198`

问题：路径正则从 `[^\s:`]+` 改成 `[^\s:`@]+` 来支持 `@提交`，代价是路径本身含 `@`（例如 scoped 目录）会被截断并返回 `location-missing`。另外，当 verdict 是 `找不到` 且写了 `文件:行@提交` 时，代码只校验提交范围和文件/行号，跳过 `code-quote-not-in-file` 与 `commit-quote-still-in-head`。

证据：
```js
const match = /^`?([^\s:`@]+):(\d+)(?:@([0-9a-f]+))?/.exec(location.trim());
...
if (commit !== null && !COMMIT_PATTERN.test(commit)) return null;
```
```js
if (claim.verdict !== "找不到" && !quoteInText(claim.code, text)) return "code-quote-not-in-file";
if (place.commit !== null && claim.verdict !== "找不到" && ...) return "commit-quote-still-in-head";
```

建议：从行尾解析 `@完整哈希`（例如 `^(.+):(\d+)@([0-9a-f]{40}|[0-9a-f]{64})$`，另留无提交的分支），不要从路径字符集里排除 `@`；对 `找不到` 也至少做提交范围检查。当前仓库 glob 未发现含 `@` 的路径，所以现阶段影响低。

读代码证实：正则与跳过逻辑是事实。推测：等仓库出现含 `@` 的路径就会回归。

### 9. 低：`isTestFile` 与文档不一致，且漏掉 Maven 常见的 `Test*.java` / `*TestCase.java`
文件:行：`scripts/model-review/opencode-review.mjs:1231-1239`；`.agents/instructions/model-review.md:67`

问题：文档写 Java 认 `*Test.java`，代码的正则 `Tests?` 还认 `*Tests.java`；反过来 Maven Surefire 默认的 `Test*.java`、`*TestCase.java` 不认。前者是文档少了，后者会让只改这类测试文件的低严重度修复被 `no-test-change` 拒绝。

证据：
```js
/(?:^|\/)[A-Z][A-Za-z0-9]*Tests?\.java$/.test(path)
```
文档：
```
或 `test_*.py`、`*_test.py`、`*_test.go`、`*_test.rs`、`*Test.java`
```

建议：统一文档和代码；如果目标是覆盖常见 Java 测试命名，明确是否加入 `Test*.java` / `*TestCase.java`，并补正反用例。

读代码证实：匹配规则是事实。推测：漏报比误报更可能；未发现新的明显误报。

### 10. 低：上一轮意见按 verdict 文件顺序截断，可能把后面的中高意见丢掉
文件:行：`scripts/model-review/opencode-review.mjs:420-439`

问题：`errors` 保持 `verdicts.jsonl` 的文件顺序，循环到 20 条或 6000 字节就 `break`。如果文件里前面是大量 low、后面才是 medium-high，后者的意见不会进入提示，尽管标题说“成立的会出错意见”。

证据：
```js
const errors = verdicts.filter((verdict) => verdict.valid && verdict.class === "error");
...
for (const verdict of errors) {
  ...
  if (lines.length >= PRIOR_FINDINGS_MAX_ITEMS || bytes + ... > PRIOR_FINDINGS_MAX_BYTES) break;
```

建议：先按 `severity` 把中高排前面，再按文件顺序/编号稳定排序；加一条“30 条 low 在前、2 条中高在后”的用例。

读代码证实：顺序和截断逻辑是事实。推测：实际是否丢掉取决于线程写 `verdicts.jsonl` 的顺序，未保证按严重度。

## 侧重检查

- 错误路径：缓存写入有 `try/catch`，读取损坏/错误 key/未来时间都会 miss；缓存写入用同目录临时文件 + `rename`，并发写不会读到半截。`priorFindingsBlock` 解析失败会回退固定文案。`commitInPullRequest` 在 `merge-base`/`is-ancestor` 失败时返回 false。发现的缺口是 `low-fix-refusals.jsonl` 写入没有错误处理（意见 5）。
- 不可信/不规范输入：提交哈希要求 40/64 位小写十六进制，路径做了 `..`、绝对路径、`-` 开头、控制字符/换行限制；未发现命令行选项注入。新入口是上一轮 `verdict.quote/id` 直接进提示（意见 2）和 `@` 路径解析（意见 8）。
- 安全：提示存档仍走 `maskSecretLike`；拒绝记录用 `ledgerLine` 遮盖并只保留原因第一个词，未把文件名写进记录。未发现新的密钥落盘路径。
- 资源耗尽：模型答案没有 CLAIM 条数上限，每条 `@提交` 会多起 2 到 3 个 git 子进程；`low-fix-refusals.jsonl` 每次拒绝追加且无上限。属于低风险，未单独列条。
- 不可撤销操作：失败的命令现在会向仓库写 `low-fix-refusals.jsonl`（意见 5），这是新加的副作用。
- 规则/文档与代码一致性：发现 3 处不一致（意见 3、7、9）；另外 ADR 说“各带反向用例”，但 carryover 证据失效和缓存命中行为没有对应用例（意见 6）。
- 未核实：没有运行测试；没有验证 opencode 自身系统提示里的日期行为；只对当前仓库做了含 `@` 路径的 glob 检查（未发现）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 代码复核路径不会：`buildPrompt` 的 `fixed` 数组没有变化，`previous`、`priorFindings`、`claimsBase`、`brief` 都在 `---- 本次材料 ----` 之后（`opencode-review.mjs:366-394`），新测试也验证了 `priorFindings` 不影响 fixed 部分。每轮会变的值都仍在最后一条消息里。**但** plan-claims 的 `text.task` 属于 fixed 前缀且被这次改动修改（`:330`），所以“固定前缀一字不改”对 plan-claims 不成立；同一脚本版本内的各轮仍相同，升级脚本会让在途链失效一次。opencode 自身的系统提示是否含当天日期，属于改动外的既有问题，未核实。
2. **会不会让同一段文字在不同请求里变成不同字节？** 新增的模型可见内容没有时间戳、随机数或无序集合：`priorFindings` 由已提交 verdict 的文件顺序、最大轮次、空白折叠和按 code point 截断决定；`claimsBase` 是解析后的提交哈希。`low-fix-refusals.jsonl` 的时间戳和缓存键里的 `mtimeMs` 不会发给模型。唯一需要注意的是 `priorFindingsBlock` 从工作区的 `usage.jsonl` 选轮次，未提交的多余记录会改变这个“尾部块”的内容，但它仍在最后一条消息里，不改变固定前缀。
3. **有没有自动检查，反向用例真的会失败吗？** 有：上一轮意见的确定性/上限/读不出来/前缀不变、缓存过期/损坏/错误 key/二进制变化、旧提交引用“仍在 head/不在 PR/短哈希”、测试文件正反例、拒绝原因记录。缺的反向用例见意见 6：carryover 的“证据失效”只写在标题里、正文没构造；“缓存命中仍跑每个 PR 的两项检查”和“环境/脚本变化必须 miss”没有测；`commitInPullRequest` 的 PR 自有提交分支和 64 位哈希没有测。未运行测试，不能确认现有用例是否全绿。
4. **每个新值两端都能接受吗？** `claimsBase` 的产生端用 `origin/main`，使用端 gate 用 `--main-ref`，两端不一致（意见 3）。`@提交` 的产生格式能过 40/64 位和祖先校验，但路径含 `@` 会被误判，`找不到 + @提交` 会跳过两项引文检查（意见 8）。`low-fix-refusals.jsonl` 只有写入端和一个密钥扫描消费者，没有格式/统计读取端的校验，写失败还会改变退出码（意见 5）。`priorFindings` 的产生端不核对上一轮答案，使用端直接拼进提示（意见 2），且截断顺序可能丢弃中高意见（意见 10）。`isTestFile` 的新模式只用于 `lowFixProblems`，和文档有出入（意见 9）。`COMMIT_PATTERN` 在 `opencode-review.mjs:1969` 与 `plan-claims.mjs:15` 各定义一份，当前相同，后续有分叉风险。
