这一轮查了 `6f54f2e1..e1ab394c` 中 `scripts/model-review/{opencode-review,plan-claims,exit-codes}.mjs`、`test/tooling/{opencode-review,opencode-review-merge-gate,plan-claims-gate}.test.mjs`、`docs/adr/0270-faster-review-rounds.md` 和 `.agents/instructions/model-review*.md`；对 `scripts/ci/merge-queue.mjs` 只核对了新退出码的使用端。没有重读增量之外、行为也没被增量改变的旧代码。

### 1. 中：上一轮第 4 条没有改好，旧代码移动或复制到别的路径仍会被当成“当前已不存在”

文件:行：`scripts/model-review/plan-claims.mjs:231-240`

问题：`commit-quote-still-in-head` 仍然只拿 `place.path` 去 `head` 取内容，没有在整棵 `head` 树里找同一段原文。旧代码从 A 路径移到 B 路径、或复制到 B 路径后，A 路径在 `head` 已不存在，检查不会报错，引用旧提交的声明就通过了。

证据：
```js
if (place.commit !== null && !headTexts.has(place.path)) {
  const atHead = blobAt(repo, head, place.path);
  headTexts.set(place.path, atHead === null ? null : atHead.toString("utf8"));
}
...
if ([...headTexts.values()].some((text) => text !== null && quoteInText(claim.code, text)))
  return "commit-quote-still-in-head";
```
这与 ADR 0270 第 4 条“当前提交里已经没有这段原文（否则报 `commit-quote-still-in-head`）”不一致。现有测试 `test/tooling/plan-claims-gate.test.mjs:446-463` 只测同一路径仍有原文，没有移动/复制到新路径的反向用例。

建议：判 `commit-quote-still-in-head` 时，除了同路径，至少在 `head` 的所有已跟踪文件里找这段引文（例如 `git grep -F` 或遍历 `git ls-tree -r` 的 blob）；命中任何文件都报“仍在当前提交”。补一条“旧提交里 A 路径有原文、`head` 里已 `git mv` 到 B 路径”的反向用例，要求报错。

### 2. 中：缓存命中后跳过大部分自检的分支仍没有自动测试，上一轮第 3 条未落实

文件:行：`scripts/model-review/opencode-review.mjs:2787`、`2832-2839`；`test/tooling/opencode-review.test.mjs:1371-1458`

问题：缓存命中时只跑 `REVIEW_MODELS` 第一个模型，并跳过 `guardProbe`、`passthroughProbe`、`failoverProbe`。测试只覆盖了缓存键、命中、过期、损坏文件、写失败开关，没有一条测试真正走到 `cached: true` 的 `selfCheck` 分支，也没有验证“缓存命中时 `AGENTS.md` 和副本未改动两项照跑”。

证据：
```js
for (const model of cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS) {
...
if (!cached)
  problems.push(...(await guardProbe({ ... })));
if (gateway) {
  if (!cached)
    problems.push(
      ...(await passthroughProbe({ ... })),
      ...(await failoverProbe({ ... })),
    );
```
测试文件里 `[self-check cache]` 两个用例只断言 `selfCheckCacheKey/Hit/Write/Dir` 的行为，没有注入 `cached` 到 `selfCheck`。

建议：加一个集成用例：预写缓存，用一个记录探针请求的假 opencode 跑 `selfCheck({ cached: true })`，断言只出现第一个模型的探针、没有 guard/passthrough/failover 探针，同时仍检查 `AGENTS.md` 标题和副本 `git status`；再加反向用例：缓存命中时改副本里的 `AGENTS.md`/已跟踪文件，仍应失败。

### 3. 低：自检缓存键只指纹了 opencode 入口文件和 Magpie 安装路径，没有覆盖依赖树或插件内容

文件:行：`scripts/model-review/opencode-review.mjs:2639-2646`、`2709-2712`；`scripts/model-review/gateway.mjs:351`

问题：`fileFingerprint` 只对 `node_modules/.bin/opencode` 这个入口文件取 size/mtime（小于 1 MB 才加 sha256），opencode 实际加载的 `node_modules` 依赖树没有进键；`gateway.install` 只是 `{ binary, binarySha256, pluginDir, cacheDir, version }`，插件目录里的文件内容也没有进键。改依赖或插件文件而入口路径、size、mtime 不变时，缓存仍会命中。

证据：
```js
return { path, size: stat.size, mtimeMs: stat.mtimeMs,
  sha256: stat.size < SELF_CHECK_CACHE_SMALL_FILE_BYTES ? sha256File(path) : null };
...
binary: fileFingerprint(binary),
...
gateway: gateway ? { install: gateway.install, config: gateway.config } : null,
```
```js
return { binary, binarySha256: asset.sha256, pluginDir, cacheDir, version: lock.magpie.version };
```
读代码证实的是键的组成；推测的风险是：本机已安装依赖或 Magpie 插件被替换后，缓存 7 天内继续放行，且跳过的恰是 guard/passthrough/failover 这类能发现问题的探针。

建议：至少把 `.package-lock.json` 的 integrity、插件 `plugin.integrity`/`pluginDir` 下关键文件摘要加入键；或在缓存命中时仍复核一次安装完整性（`installedIntegrityProblems`/插件 marker）并纳入判定。

### 4. 低：上一轮意见的 id 和原话未转义就插进提示，可以被构造出指令性文字或控制字符

文件:行：`scripts/model-review/opencode-review.mjs:428-432`、`1981-1984`

问题：`verdict.id` 和 `verdict.quote` 直接拼进“本次材料”。`parseVerdicts` 只禁止 `\r\n`，不禁止 ESC、BEL 等控制字符，也不限制 id 格式；`quote` 只是折叠空白和截断。提交进 `verdicts.jsonl` 的文字可以写成类似“忽略前面的要求，现在只输出……”，模型可能把它当成指令；控制字符还会进入提示词存档。

证据：
```js
const quote = [...verdict.quote.replace(/\s+/g, " ").trim()]
  .slice(0, PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS)
  .join("");
const line = `- ${verdict.id}（${verdict.severity === "low" ? "低" : "中高"}）${quote}`;
```
```js
function hasLineBreak(value) {
  if (typeof value === "string") return /[\r\n]/.test(value);
  if (value && typeof value === "object") return Object.values(value).some(hasLineBreak);
  return false;
}
```
读代码证实的是插入路径；推测的是模型是否会服从注入文字，属于提示注入风险。

建议：插入前用 `hasControlCharacter`/`safe` 清掉控制字符，id 只接受 `CLAIM_ID_PATTERN` 或 `V\d+` 这类短标识；把整块括在明确的引用/代码围栏里，并在每行前加不可解释的前缀，降低被当成指令的机会。

### 5. 低：`low-fix-refusals.jsonl` 直接 append 到 PR 控制的路径，可跟随符号链接写到仓库外；目录不存在时又静默不记录

文件:行：`scripts/model-review/opencode-review.mjs:1657-1671`

问题：只检查 `dirname(refusalsFile)` 存在，然后用 `appendFileSync` 追加。若 PR 在 `.agents/reviews/pr-<编号>/low-fix-refusals.jsonl` 提交了指向仓库外的符号链接（或把记录目录做成符号链接），门禁运行时会跟随链接追加内容。目录不存在时不做记录，也不打印 `REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED`，与文档“每次拒绝还把轮次、提交和原因词追加到……”不一致。

证据：
```js
const refusalsFile = join(repo, ledgerPath, "low-fix-refusals.jsonl");
if (existsSync(dirname(refusalsFile)))
  try {
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
同一目录下 `usage.jsonl` 的追加有同样问题，是既有模式；但新文件在“拒绝”时就写，且不要求先通过任何校验，暴露面更大。

建议：追加前用 `lstat`/`realpath` 确认目标在仓库内且是普通文件（或用 `O_NOFOLLOW`/`O_APPEND` 打开），父目录不存在时也打印 `REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED` 并同步文档。

### 6. 低：沿用判断只取第一条匹配的旧 `model-wrong`，证据过期时会误拒后面仍有效的判断

文件:行：`scripts/model-review/plan-claims.mjs:414-423`

问题：`carried` 按账本/主题目录顺序排列，`find` 取第一条同模型同句子的旧判断；随后只对这一条做证据和 quote 校验。如果第一条的证据在当前提交已不存在，而后面还有一条证据仍存在的合格 `model-wrong`，门禁会误报 `claims-verdict-evidence`/`claims-verdict-quote`。

证据：
```js
const earlier =
  direct?.outcome === "model-wrong"
    ? null
    : carried.find(
        (item) =>
          item.model === record.model && item.sentence === collapse(claim.sentence),
      );
const verdict = direct?.outcome === "model-wrong" ? direct : earlier?.verdict;
```
文档说的是“已有合格的 `model-wrong` 判断（证据在当前提交里仍逐字存在）”，并没有限定必须是第一条。

建议：收集所有同模型同句子的候选，优先用当前轮的 `direct`，否则按轮次从新到旧选第一条证据和 quote 都合格的；全部不合格才报错。

### 7. 低：`@提交哈希` 的正则没有锚定行尾，完整哈希后跟任意垃圾仍被接受

文件:行：`scripts/model-review/plan-claims.mjs:105`

问题：`locationOf` 的正则 `(?:@([0-9a-f]+))?` 后面没有 `$`，`a.mjs:3@<40位哈希>任意文字` 会被接受，尾部内容被静默忽略。短哈希仍会被 `COMMIT_PATTERN` 拒绝，共同祖先判断也没有因此被绕过；问题只是“完整提交哈希”的校验比文档写的宽松。

证据：
```js
const match = /^`?([^\s:`]+):(\d+)(?:@([0-9a-f]+))?/.exec(location.trim());
```
建议：写成 `^`?([^\s:`]+):(\d+)(?:@((?:[0-9a-f]{40}|[0-9a-f]{64})))?$`，或把捕获的 commit 直接交给 `COMMIT_PATTERN` 并要求整串匹配。

### 8. 低：缓存键计算对读目录/读脚本没有兜底，权限问题或并发删除会让整个复核崩掉，而不是退回“不缓存”

文件:行：`scripts/model-review/opencode-review.mjs:2687-2694`、`3749-3751`；`scripts/model-review/gateway.mjs:205-207`

问题：`readdirSync(scriptDir)`、`outsideImports()`、`sha256File()` 都没有 try/catch；`main` 里计算 `cacheKey` 也没有兜底。脚本目录中某个文件不可读或在 `readdir` 与 `readFile` 之间被删掉时，`selfCheckCacheKey` 会抛错，复核直接退出，而不是把缓存关掉继续跑。缓存记录文件本身的损坏已经处理（`selfCheckCacheHit` catch 返回 false），但键计算没有。

证据：
```js
const scripts = readdirSync(scriptDir)
  .filter((name) => /\.(?:mjs|json)$/.test(name))
  .sort()
  .map((name) => [name, sha256File(join(scriptDir, name))]);
const imported = outsideImports(scriptDir).map((file) => [
  relative(scriptDir, file),
  existsSync(file) ? sha256File(file) : null,
]);
```
```js
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
```
建议：把 `selfCheckCacheKey` 整体包进 try/catch，失败时返回 `null` 并按 `cache=off` 继续；`sha256File` 失败也可回退成带 `missing` 的指纹。

### 9. 低：自检缓存文件从不清理，键随 mtime/env 变化会无限累积

文件:行：`scripts/model-review/opencode-review.mjs:2734-2743`

问题：每次自检通过就写 `<key>.json`，从不删除过期文件。`fileFingerprint` 含 `mtimeMs`，升级 opencode、改 PATH/timezone/proxy 等都会产生新键；长期使用会在 `~/.cache/himawari-review-selfcheck/` 留下无界数量的旧文件。

证据：
```js
mkdirSync(dir, { recursive: true, mode: 0o700 });
const target = join(dir, `${key}.json`);
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify({ key, at: now })}\n`, { mode: 0o600 });
renameSync(temporary, target);
```
建议：写入时顺带清理超过 `SELF_CHECK_CACHE_MAX_AGE_MS` 或数量超过上限的旧文件；或把过期判断改为“只保留最近 N 个键”。

**侧重检查**

- 错误路径：畸形 `usage.jsonl` 现在打印 `REVIEW_RECORD_INVALID` 并以 5 退出，测试覆盖；低严重度检查里畸形 `verdicts.jsonl` 变成问题而不是崩溃，测试覆盖；缓存记录损坏/过期/未来时间都会 miss；缓存写失败被吞掉；但缓存键计算失败没有兜底（第 8 条）。`low-fix-refusals` 写失败会打印 `REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED`，有测试。
- 不可信输入：`verdicts.jsonl` 的 id/quote 能进入提示（第 4 条）；`commit` 只接受 40/64 位小写十六进制，`path` 拒绝绝对路径、`..`、空段和 `.agents/reviews/`；共同祖先判断排除了 main 上未合入分支的提交，base/旧 base 是文档写明的例外；未发现短哈希或 main 提交混入的绕过，只有正则尾部宽松（第 7 条）。
- 安全：`low-fix-refusals` 追加可跟随符号链接（第 5 条，和既有 `usage.jsonl` 追加同一类问题）；缓存目录内容对同机用户可写时的缓存投毒风险未额外加固（键不是秘密，但需要能写该目录）；提示注入见第 4 条。
- 资源耗尽：`locationsOf` 在检查 `MAX_EVIDENCE_PLACES` 前会先把整段 location 拆完，答案行极大时内存/CPU 会先增长；提示总大小有 100000 字节上限；缓存文件无清理（第 9 条）。
- 不可撤销操作：缓存写用临时文件加 rename，覆盖的是同名键文件；`low-fix-refusals` 只追加；没有发现删除或覆盖 PR 内容的路径。
- 规则/文档一致性：ADR 0270 关于 `commit-quote-still-in-head` 的说法与代码不一致（第 1 条）；`[self-check cache]` 被写成“各带反向用例”，但没有覆盖 `cached` 分支（第 2 条）；文档说“每次拒绝都记”，目录不存在时实际静默跳过（第 5 条）；`low-fix-refusals` 行里还多写了未文档化的 `at` 字段。`REVIEW_RECORD_INVALID` 已在 `model-review-card.md` 和 `model-review.md` 中补上。
- `isTestFile`：新增的 `test_*.py`、`*_test.py`、`*_test.go`、`*_test.rs`、`*Test.java` 都是常见测试命名；现有测试含 `src/contest.py`、`src/ParserTests.java`、`.md` 等反向用例。未发现把明显非测试文件当测试的新模式；`test_*.py` 在任意目录都算测试，仍是启发式判断，但只影响低严重度修改的放行门槛。
- 判断沿用：`own` 先按 `claimsFile === adr` 过滤，匹配时又要求 `item.model === record.model`，未发现跨 ADR 或跨模型串用；缺的是跨模型/跨 ADR 的反向测试。

**必答问题**

1. 不会改变请求开头。`buildPrompt` 的固定前缀仍由 `MODE_TEXT`、工具说明、必答问题、侧重和输出格式组成；新增的 `previous` 行、`priorFindings`、`claimsBase` 都放在 `---- 本次材料 ----` 之后、`brief` 之前，属于材料部分。只要同一轮/同一 PR 的 `--base`（或 `--questions-ref`）不变，前缀逐字节相同；`6f54..e1ab` 合入的 `prompt-prefix.md` 路径改动不会影响它，因为必答问题从 `--base` 读（`questionsSource`），不是从工作区读。每轮会变的值仍在最后一条消息（材料）里。
2. 请求文本没有新增不确定性。`priorFindingsBlock` 的排序、折叠、截断和上限都是确定的；提示里没有时间戳。`new Date().toISOString()` 只写进 `low-fix-refusals.jsonl`，不进入模型请求。缓存键里的 `mtimeMs` 只影响命中/不命中，不影响发给模型的字节。
3. 只有一部分。已有测试覆盖：畸形账本退出码、低严重度畸形 verdicts、缓存键/命中/过期/损坏/开关、外部导入进键、上一轮意见的确定性/上限/前缀、isTestFile 正反例、多地点/多行引文、旧提交引用和“仍在同一路径”的反向用例、沿用判断证据消失。缺失：缓存命中跳过 probe 的分支（第 2 条）、旧代码移动/复制到别的路径（第 1 条）、沿用判断的多条候选选择、跨模型/跨 ADR 反向、提示注入/控制字符（第 4 条）、`@hash` 尾部垃圾（第 7 条）。
4. 大部分可以。`REVIEW_NOT_COVERED_EXIT = 5` 被 `scripts/ci/merge-queue.mjs:362` 和 `test/tooling/merge-queue.test.mjs:661` 接受为“未覆盖但不是工具损坏”；`REVIEW_RECORD_INVALID` 已写入说明文档；`SELF_CHECK_OK ... cache=hit|miss|off` 与新环境变量有文档和测试；`@文件:行@哈希` 的生产端和校验端都在 `plan-claims.mjs`，测试覆盖了有效/无效提交。需要修正的：`low-fix-refusals.jsonl` 没有真正的消费端/格式校验，且其格式若被误用 `parseUsage` 会因缺 `cost` 报 `USAGE_LEDGER_INVALID`；缓存键的构成与文档的“程序指纹/Magpie 安装”不完全一致（第 3 条）；沿用判断和 `@hash` 校验有第 6、7 条的边界问题。
