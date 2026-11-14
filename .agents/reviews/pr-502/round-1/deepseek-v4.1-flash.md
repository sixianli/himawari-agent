### 1. 中 — `git diff` 列文件失败时静默当作“已不在 head”，会放行未核对的旧代码说法

- 文件:行：`scripts/model-review/plan-claims.mjs:215-224`，`scripts/model-review/plan-claims.mjs:26-27`
- 问题：`quoteInChangedFiles` 在 `git diff` 失败、单个 blob 读不出、被当成二进制跳过、或超过 400 个文件被 `slice` 掉时，全部返回 `false`。调用方只把 `false` 理解为“这些文件里没有这段原文”，于是 `claimEvidenceProblem` 返回 `null`，旧提交引用通过。这正是“没核对却放行”，和作者“不放行没核对的说法”的约束相反。
- 证据：
  ```js
  const git = (repo, args, encoding = "utf8") =>
    spawnSync("git", args, { cwd: repo, encoding, maxBuffer: 1 << 28 });
  ...
  const listed = git(repo, ["diff", "--name-only", "-z", "--diff-filter=AMR", commit, head]);
  if (listed.status !== 0) return false;
  ...
  const paths = ... .slice(0, MAX_MOVED_FILES);
  return paths.some((path) => {
    const blob = blobAt(repo, head, path);
    return blob !== null && !blob.includes(0) && quoteInText(quote, blob.toString("utf8"));
  });
  ```
- 触发方式：PR 改动超过 400 个文件、`git diff` 输出超过 256 MB、某个 blob 读不出来，或 blob 含 NUL 被跳过；只要被挪走的原文位于被截掉/读失败的文件里，检查就静默失效。
- 建议：把“无法完成检查”和“确认不在 head”区分开，例如返回 `commit-quote-check-failed` 或抛错，而不是返回 `false`；对超过 400 个文件的情况至少打印/记录被跳过的数量，或改用按路径分批扫描并保证覆盖。另可先用 `git diff --numstat`/`git cat-file -s` 控制大小，再决定是否读取 blob。
- 判断：读代码证实。实际触发需要大 diff 或读取失败；一旦触发就是静默放行，属于合并前检查被绕过。

### 2. 中 — 扫描所有新增/改动/改名文件，会把 ADR 或文档里的引文当成“代码还在 head”

- 文件:行：`scripts/model-review/plan-claims.mjs:215-224`、`scripts/model-review/plan-claims.mjs:256-260`、`scripts/model-review/plan-claims.mjs:150-176`
- 问题：`quoteInChangedFiles` 不区分代码文件和文档，也不排除本次新增的 claims 文件本身（ADR）。ADR 常常会在正文或代码围栏里引用旧代码；只要它引用的片段和 `claim.code` 相同，`git diff commit head` 会把新增的 ADR 列出来，随后报 `commit-quote-still-in-head`，把一条本来正确的“旧代码已删除”说法拒掉。`quoteInText` 又会折叠空白、接受省略片段，误报概率比同文件检查更高。
- 证据：
  ```js
  const paths = listed.stdout
    .split("\0")
    .filter((path) => path && validEvidencePath(path) && !skipPaths.has(path))
    .slice(0, MAX_MOVED_FILES);
  ...
  if (quoteInText(quote, blob.toString("utf8")))
  ```
  `validEvidencePath` 只排除绝对路径、`-` 开头、`..`、空段和 `.agents/reviews/`，没有排除 `docs/adr/*.md` 或其他文档。
- 触发方式：ADR 方案正文里包含旧代码片段（例如说明“原来是这样的”），`plan-claims` 又对同一段代码写了 `文件:行@旧提交`。此时 gate 会误报 `commit-quote-still-in-head`。
- 建议：至少把 claims 文件本身排除；更稳妥的是只扫描代码类文件（或排除 `docs/`、`.agents/`、测试 fixture 等纯文档路径），或对文档改用更严格的整段匹配。如果确实要保留“任何文件都算”，应在测试里加一条“ADR 引用旧代码”的反例并明确这是可接受代价。
- 判断：读代码证实扫描范围包含 ADR 和文档；“正常 ADR 是否真的会引用同一段旧代码”需要具体 PR 才能确认，属推测。

### 3. 低 — 每个旧提交引用都会重跑 diff 并最多读取 400 个完整 blob，没有大小和缓存上限

- 文件:行：`scripts/model-review/plan-claims.mjs:213-224`、`scripts/model-review/plan-claims.mjs:448-453`
- 问题：`quoteInChangedFiles` 对每个 claim 的每个旧提交都重新执行 `git diff`，然后对最多 400 个文件逐个 `git show` 读取完整内容。没有跨 claim 的 diff/blob 缓存，也没有单文件大小上限；一个很大的文件会被整体 `toString("utf8")` 后再做 `quoteInText`。在旧提交引用较多或改动文件较大时，gate 的耗时和内存会明显上升。
- 证据：
  ```js
  const paths = ... .slice(0, MAX_MOVED_FILES);
  return paths.some((path) => {
    const blob = blobAt(repo, head, path);
    return blob !== null && !blob.includes(0) && quoteInText(quote, blob.toString("utf8"));
  });
  ```
  `MAX_MOVED_FILES` 只限制文件数量，没有限制每个 blob 的字节数。
- 触发方式：PR 改动文件多、文件大，或同一声明里引用了多个旧提交；需要故意构造或较大的 PR 才明显触发。
- 建议：按 `(repo, commit, head)` 缓存 diff 列表，按 `(head, path)` 缓存 blob；先用 size 门限跳过超大文件并明确记录；只在一个文件确实可能承载代码时才读取全文。
- 判断：读代码证实的资源消耗机制；实际是否慢到影响使用属推测，需实测。

### 4. 低 — 测试覆盖了主路径和两个反向用例，但漏了作者点名的组合和若干边界

- 文件:行：`test/tooling/opencode-review.test.mjs:1420-1438`、`test/tooling/plan-claims-gate.test.mjs:554-596`
- 问题：
  - `selfCheckSteps` 测试覆盖了 `cached=true + gateway` 和 `cached=false + gateway=null`，但没有覆盖作者明确要求的 `cached=true + gateway=null`；也没有测试 `selfCheck` 真的按这些字段执行（只测了纯函数）。
  - 挪文件测试只有“代码被移到另一个文件 → 拒绝”和既有的“删除后同文件没有 → 通过”，没有覆盖大 diff/超过 400 文件、`git diff` 失败、二进制文件（含/不含 NUL）、纯重命名、以及 ADR 自身引用旧代码导致误报。
- 证据：
  ```js
  const hit = selfCheckSteps({ cached: true, gateway });
  ...
  const direct = selfCheckSteps({ cached: false, gateway: null });
  ```
  缺少 `selfCheckSteps({ cached: true, gateway: null })`；`plan-claims` 新测试只有 `moved/masking.ts` 这一条移动路径。
- 建议：补表驱动用例，至少包含 `cached=true, gateway=null`、带网关的 cached 安装检查、重命名、含 NUL 的二进制、超过 400 个改动文件、`git diff` 失败，以及“ADR 引用旧代码”的误报场景。前两个 `plan-claims` 新测试确实会在旧代码上失败，是有反向价值的。
- 判断：读代码证实测试缺口；测试是否实际运行未核实（本次不能运行测试）。

**侧重检查**

- 错误路径：`git diff` 失败、`blobAt` 返回 `null`、blob 含 NUL、超过 400 文件都会静默跳过，见意见 1。
- 不可信输入：新路径来自 `git diff -z`，在 `git show` 前经过 `validEvidencePath` 过滤；`commit` 在 `commitInPullRequest` 中已校验 `COMMIT_PATTERN` 和祖先关系。`spawnSync` 用参数数组，没有 shell 拼接；该函数只读，不写文件、不联网。未发现新的命令注入或仓库外读取路径。
- 资源耗尽：最多 400 个完整 blob、无单文件大小限制、无 diff/blob 缓存，见意见 3。
- 不可撤销操作：本改动没有写操作，没有不可撤销行为。
- 规则/文档一致性：`.agents/instructions/model-review.md:44` 已写明 `AMR`、最多 400 个文件、跳过复核记录目录，和代码一致；`docs/adr/0270-faster-review-rounds.md:57` 仍只写到“当前提交里已经没有这段原文”，没有提新增的改动文件扫描，但不与代码矛盾，只是细节未同步。
- 重命名：`--diff-filter=AMR` 包含 `R`，被引用的旧路径会因 `sameFiles` 跳过，改名目标会被检查；未发现明确错误，但没有对应测试。
- 复核记录目录：`validEvidencePath` 排除 `.agents/reviews/`；既有测试 432 若没有排除，会因答案文件里含 `CODE_LINE` 而失败，因此这一跳过实际有间接覆盖。

**必答问题**

1. 不会改变模型已经见过的请求开头。这个 diff 只改了 `selfCheck` 的探针选择和 `plan-claims` 的合并检查；没有改 `buildPrompt`、系统提示、工具定义、历史或遮盖逻辑。自检缓存命中时只是少跑探针，探针内容不变；正式复核请求仍然只在末尾追加，每轮会变的值仍只在最后一条消息里。依据和规则：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。

2. 不会让同一段文字在不同请求里变成不同字节。`selfCheckSteps` 是纯函数；`quoteInChangedFiles`、`carriedEvidenceHolds` 只读仓库并基于固定输入做确定性判断，没有时间、随机数、无序集合输出或依赖后文的遮盖。`git diff` 和 `git ls-tree` 的输出顺序由 git 固定。自检里的随机 marker 是原有逻辑，本改动没有触碰。

3. 有自动检查，但不是全覆盖。两个 `plan-claims` 新测试（`plan-claims-gate.test.mjs:554-596`）在旧代码上确实会失败，能反向验证新增行为；`selfCheckSteps` 的纯函数测试也能抓住映射错误。缺口是 `cached=true + gateway=null`、`selfCheck` 集成执行、以及大 diff/失败/二进制/重命名/400 文件上限这些边界没有用例。

4. 新产生/修改的值都能被使用端接受：`selfCheckSteps` 的 `models`、`guardProbe`、`passthroughProbe`、`failoverProbe`、`installCheck` 只被 `selfCheck` 和测试使用，类型分别是数组和布尔值；`commit-quote-still-in-head` 沿用既有问题字符串，最终只被拼接、打印和按 `claims-` 前缀处理，没有新增解析格式；`MAX_MOVED_FILES` 只在 `quoteInChangedFiles` 内使用。两端的校验也对得上：commit 在 diff 前已经过格式和祖先校验，路径在读取前经过 `validEvidencePath`，`evidenceFile` 在 `carriedEvidenceHolds` 中再次校验。未发现新值被使用端拒绝的问题。
