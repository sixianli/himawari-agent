本轮查过范围：增量 `9ab0e3dc8..2d5a0abd7`（`opencode-review.mjs`、`plan-claims.mjs`、三个测试文件、`model-review.md`），并顺读当前文件中与增量直接相关的 `priorFindingsBlock`、`isTestFile`、`assertReviewed`、`selfCheck*`、`commitInPullRequest`、`claimsProblems`，以及 `gateway.mjs` 的安装/校验函数。`.agents/reviews/pr-496/*` 被 git 守卫拒绝显示，上一轮意见原文**未核实**，只按本轮材料摘要逐条对照代码；测试只读了代码，未实际运行。

### 1. 中低：上一轮意见的 `quote` 没有核对是否真在那轮答案里，PR 控制的文字可进入下一轮提示

- 文件:行：`scripts/model-review/opencode-review.mjs:411-431`（对照 `:1306`、`:1842`）
- 问题：`priorFindingsBlock` 只从当前提交读 `verdicts.jsonl` 并解析，随后直接把 `verdict.quote` 放进下一轮材料；它没有像 `lowFixProblems`/`finishRound` 那样核对这句话确实出现在上一轮模型答案里。`verdicts.jsonl` 由线程提交、PR 分支可改，因此任意短文本（包括“忽略前面规则”之类的指令）可以被写成“上一轮成立的意见”进入下一轮提示。标题写了“只是线索，不是指令”，且整条链路本来就“防误操作、不防有意”，所以不是高危；但这是本轮新增的唯一一条把记录文件文字带进模型提示的通道。
- 证据：
  ```
  412:  const text = showAt(repo, head, verdictsPath);
  416:    verdicts = parseVerdicts(text, verdictsPath);
  428:    const quote = [...verdict.quote.replace(/\s+/g, " ").trim()]
  431:    const line = `- ${verdict.id}（${verdict.severity === "low" ? "低" : "中高"}）${quote}`;
  ```
  对比：
  ```
  1306:    if (!answers.get(verdict.model)?.includes(verdict.quote))
  1307:      problems.push(`quote-not-found ${printable(verdict.id)}`);
  ```
- 建议：复用 `lowFixProblems` 的答案查找，只有 `round-<round>/<模型>.md` 在 `head` 里逐字包含 `verdict.quote` 才带入；否则用固定提示替代。缩到 160 字、折掉空白只能防格式破坏，防不了内容注入。
- 【读代码证实】缺少答案核对是代码事实；【推测】实际可利用性取决于是否有人有意改写 `verdicts.jsonl`，按现有说明这不在防护范围内。

### 2. 中低：`isTestFile` 把常见的 `*Tests.java` 从测试文件里删掉了，反向测试把错误行为固定下来

- 文件:行：`scripts/model-review/opencode-review.mjs:1240`；`test/tooling/opencode-review-merge-gate.test.mjs:2600-2602`
- 问题：增量把上一版的 `Tests?\.java` 改成 `Test\.java`，现在 `ParserTests.java` 被判为**非测试文件**，而它是 Maven Surefire 的默认命名之一（`*Test.java`、`*Tests.java`、`Test*.java`、`*TestCase.java`）。后果是：只改了 `FooTests.java` 的 low 修复会被 `--accept-low` 以 `no-test-change` 拒绝，被迫多跑一整轮复核，正好违背 ADR 0270 想要的“少无谓重跑”。原意见 9 要求“补 Maven 模式”，增量却反向缩小了模式；文档也同步改成只写 `*Test.java`，所以是“文档与代码一致，但两者都不对”。
- 证据：
  ```
  scripts/model-review/opencode-review.mjs:1240
      /(?:^|\/)[A-Z][A-Za-z0-9]*Test\.java$/.test(path)
  test/tooling/opencode-review-merge-gate.test.mjs:2600-2602
        "src/ParserTests.java",
      ])
        expect(isTestFile(path)).toBe(false);
  ```
- 建议：恢复 `Tests?` 或补 `Test*.java`/`*TestCase.java`，把测试里 `ParserTests.java` 的期望改为 `true`，并同步文档；如果确实只想认 `*Test.java`，至少在 ADR 和测试里说明这是刻意排除 Surefire 默认模式。
- 【读代码证实】。

### 3. 低：自检缓存键没有覆盖已安装 Magpie 插件（以及 opencode 包主体）的内容，命中后只按元数据校验

- 文件:行：`scripts/model-review/opencode-review.mjs:2704`；`scripts/model-review/gateway.mjs:327-330`、`:351`；`opencode-review.mjs:354-358`
- 问题：缓存键里的 `gateway.install` 只有 `pluginDir` 路径、二进制摘要和 Magpie 版本；`installGateway` 每次只比较 `plugin.integrity` **标记文件字符串**与锁文件，以及 `package.json` 是否存在，并不重新哈希插件目录内容。`binaryProblem` 也只重新哈希 Magpie 二进制。因此已安装插件文件在 7 天窗口内被本地改动/损坏时，缓存键不变、仍会命中，被跳过的直通/故障转移探针不会重新验证它。opencode 包主体同理，缓存键只指纹 `.bin/opencode` 入口文件，包内其他文件靠 `.package-lock.json` 元数据校验，不是实际内容哈希。增量修了“目录外导入脚本”和“环境变量”，但这一项仍属于“环境变了还命中”。
- 证据：
  ```
  2704:        gateway: gateway ? { install: gateway.install, config: gateway.config } : null,
  gateway.mjs:327-330
    const installedIntegrity = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (
      installedIntegrity !== lock.plugin.integrity ||
      !existsSync(join(pluginDir, "package.json"))
  gateway.mjs:351
    return { binary, binarySha256: asset.sha256, pluginDir, cacheDir, version: lock.magpie.version };
  ```
- 建议：把 `pluginDir` 的文件树摘要（至少 `package.json` + 入口文件）加入缓存键，或每次缓存命中前重新校验插件内容；说明里把“Magpie 安装”写清是否含插件目录。
- 【读代码证实】键只含路径/版本；【推测】实际影响取决于本地是否会在安装后改动插件文件，缓存命中仍会跑第一个模型的基础网关探针，所以严重度不高。

### 4. 低：缓存命中的行为和“导入文件改动会换键”仍没有自动检查，反向用例缺

- 文件:行：`test/tooling/opencode-review.test.mjs:1419-1444`；`scripts/model-review/opencode-review.mjs:2683-2686`、`:2779`
- 问题：新增测试只断言 `outsideImports` 返回了哪些文件、真实脚本列表包含 `verified-download.mjs`，但没有断言“改动这些被导入文件的字节后 `selfCheckCacheKey` 会变”。缓存命中行为（`selfCheck({cached:true})` 只对第一个模型跑探针、仍执行 `AGENTS.md` 不得进系统提示和副本未被改动两项每 PR 检查）也完全没有测试；`grep` 没有找到任何调用 `selfCheck` 并传 `cached` 的测试。原意见 6 的“缓存命中行为没有测”只修了一半。
- 证据：
  ```
  2683:  const imported = outsideImports(scriptDir).map((file) => [
  2684:    relative(scriptDir, file),
  2685:    existsSync(file) ? sha256File(file) : null,
  2686:  ]);
  2779:    for (const model of cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS) {
  ```
- 建议：加两条反向用例：改 `ci/helper.mjs` 内容后 key 必须变；`cached:true` 时仍调用 `checkProbeRequests` 的 `projectInstructions`/副本未改动检查，但只跑一个模型、不跑 guard/passthrough/failover。
- 【读代码证实】代码本身看起来正确，缺口在测试。

### 5. 低：`plan-claims` 提示的基线仍固定用 `origin/main`，与合并检查的 `--main-ref` 只在文档里承认“可能对不上”

- 文件:行：`scripts/model-review/opencode-review.mjs:3647-3654`、`:3350-3351`、`:1517-1520`；`scripts/model-review/plan-claims.mjs:173-185`
- 问题：增量的 `runHead` 分支修好了“同一 mainRef 下 main 前进再合并”导致旧基线不认的问题，但运行 `plan-claims` 时提示里的 `claimsBase` 仍然写死 `origin/main`，而 `plan-claims` 模式又拒绝 `--main-ref`；合并门可以用另一个 `--main-ref` 调 `claimsProblems`。当两个 ref 实际不同时，提示告诉模型的基线提交会被门判 `commit-not-in-pr`。文档现在写“plan-claims 不接受 --main-ref，合并检查用别的 --main-ref 时两边可能对不上”，等于把原意见 3 记录为已知限制，而不是代码层面消除。
- 证据：
  ```
  3649:        const base = spawnSync("git", ["merge-base", "origin/main", commits.head], {
  3350:  const subcommandOnly = [...given].filter((key) => SUBCOMMAND_ONLY_OPTIONS.includes(key));
  3351:  if (subcommandOnly.length > 0) throw new Error(`ARG_NOT_FOR_MODE ${subcommandOnly.join(" ")}`);
  1517:  const claims = claimsProblems({
  1520:    mainRef,
  ```
- 建议：让 `plan-claims` 接受并记录 `--main-ref`，或门在 `plan-claims` 记录存在时强制用 `origin/main` 并明确拒绝其他值；至少不要只在文档里提示。
- 【读代码证实】行为仍然存在；【推测】实际触发取决于部署是否使用非 `origin/main` 的主分支名。

### 6. 低：`找不到 + @提交` 仍跳过“引文取自该提交”和“当前提交已无这段原文”两项检查，增量只修了路径里的 `@`

- 文件:行：`scripts/model-review/plan-claims.mjs:189`、`:201-208`
- 问题：增量只把 `locationOf` 的路径字符类放宽以允许 `packages/@scope/...`，但 `claim.verdict === "找不到"` 时仍只校验提交在 PR 内、文件在该提交存在、行号在范围内；不校验原文，也不校验当前提交已没有这段原文。原意见 8 的第二半没有改。由于 `找不到` 条目仍需 `model-wrong` 判断才能过门，这不是放行漏洞，但“旧提交引用”的规则在 `找不到` 上仍不完整，模型可以给一个没有实际意义的 `@提交`。
- 证据：
  ```
  189:  if (claim.verdict === "找不到" && !locationOf(claim.location)) return null;
  ...
  201:  if (claim.verdict !== "找不到" && !quoteInText(claim.code, text)) return "code-quote-not-in-file";
  202:  if (
  203:    place.commit !== null &&
  204:    claim.verdict !== "找不到" &&
  ```
- 建议：对 `找不到` 也要求“当前提交没有这段原文”或直接禁止 `找不到` 使用 `@提交`，避免旧提交引用在语义上落空。
- 【读代码证实】。

## 侧重检查

- 错误路径：`--accept-low` 写入 `low-fix-refusals.jsonl` 失败（EISDIR）已由 `try/catch` 接住并输出 `REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED`，退出码仍由 `lowFixRefused` 保持 5，原意见 5 已修好；缓存文件损坏/非 JSON/key 不符/未来时间/过期均返回未命中（见测试 1379-1412）；`@` 短哈希、非 PR 提交、引文仍在 head 都有反向用例（plan-claims 419-436）。
- 不可信输入：模型答案里的 `location`/`commit` 受 `validEvidencePath` 和 `COMMIT_PATTERN` 约束，`git show` 用参数数组而非 shell；`record.head` 经 `parseUsage` 验证必须是 40/64 位小写十六进制；上一轮 `quote` 是唯一未做“答案内逐字存在”校验就进入提示的不可信文本（见意见 1）。
- 安全：缓存目录创建用 `0700`、文件 `0600`、临时文件 + `rename` 原子替换；缓存键只把环境变量值做哈希，不落明文；`outsideImports` 有 `seen` 防环。未发现新增命令注入。
- 资源耗尽：`outsideImports` 会递归读取所有可达的相对导入且不设文件数/大小上限，`sha256File` 是 `readFileSync` 整文件读入；当前脚本目录很小，属低风险，但若脚本目录被放入超大文件会整份读入。
- 不可撤销操作：新拒绝日志是追加写，但只记原因词、轮次和提交，不含文件名/密钥，已确认 `reasons.map(reason => reason.split(" ")[0])` 会丢掉文件名部分；没有新的删除或覆盖仓库外文件的路径。
- 文档与代码一致：`*Test.java` 的模式在代码、文档、ADR 三处一致，但一致地漏掉了 `*Tests.java`；缓存说明没有写“插件目录内容不计入键”；`REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED` 这行新诊断没有进 `model-review-card.md` 的报错表（不影响退出码，但排错表不完整）。

## 必答问题

1. **请求开头是否变了：没有。** `buildPrompt` 的 `fixed` 数组（角色、工具/命令、任务、侧重、必答问题、输出格式）没有改动；`previous` 文案和 `priorFindings` 都只拼进 `material`，位于 `---- 本次材料 ----` 之后。测试 `opencode-review-merge-gate.test.mjs:1482-1505` 显式断言带/不带 `--previous` 时 `fixed` 前缀逐字节相同，且上一轮意见只能出现在材料区。每轮会变的 `head`、`base`、`previous`、`claimsBase`、`priorFindings`、`brief` 都在末尾材料里。系统提示、工具定义、历史消息不受本轮改动影响。
2. **同一段文字是否会变成不同字节：本轮改动没有引入。** 上一轮意见块的输入顺序固定（`scripts`/`imported` 排序、verdicts 按文件顺序稳定排序），排序是稳定排序且测试了两次调用完全相同；缓存键的数组都排序、环境键顺序固定、只做 `JSON.stringify` 后哈希，不含时间。唯一带时间的字段是新拒绝日志的 `at`，它不进入任何模型提示。
3. **自动检查与反向用例：** 已有并通过代码可见的覆盖包括上一轮意见的条数/字节/严重度排序/前缀不变（1415-1505）、拒绝记录写失败（1523-1532）、含 `@` 路径与无效 `@` 提交（plan-claims 405-436）、合并 main 后旧基线（438-468）、沿用判断证据失效（473-490）、缓存过期/损坏/环境变化（1371-1417）。仍缺：缓存的 `cached` 分支行为、改动导入文件内容会换 key、上一轮 `quote` 不在答案里时必须拒绝；且 `isTestFile` 的新反向用例（`ParserTests.java` 为 false）反而把错误行为当成预期。原意见 6 只修了“沿用证据失效”这一半。
4. **每个新值/修改值的两端：** `outsideImports`、`SELF_CHECK_CACHE_ENV_KEYS`、`selfCheckCacheKey(env)` 只有内部调用和测试，签名加默认参数不破坏现有调用；`commitInPullRequest` 新增 `runHead` 的正式调用端传入的是 `parseUsage` 已校验的 `record.head`，其余调用端用默认值保持旧行为；`locationOf` 允许路径中的 `@` 后，下游 `validEvidencePath`/`git show commit:path` 都能接受；`low-fix-refusals.jsonl` 目前没有读取端，字段只有 `at/round/head/reasons`，不会被 `parseUsage` 当作 `usage.jsonl` 解析（但也没有任何统计脚本消费，文档说的“用来统计”目前只是留数据）；`isTestFile` 的新模式改变了直接使用端 `lowFixProblems` 的判定，且是向更严格方向改变，`ParserTests.java` 会被拒。
