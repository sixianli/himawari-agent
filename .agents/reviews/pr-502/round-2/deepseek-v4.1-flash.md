**结论摘要**

这一轮只看了 `349e738e…` 到 `4b4e7259…` 的增量，并顺着增量追到相关的旧代码。增量本身没有发现会让“发给模型的内容”变化的问题；`selfCheckSteps` 的四组条件与旧实现逐项一致。主要问题集中在 `plan-claims.mjs` 新增的缓存与 ADR 跳过范围，以及测试缺口。

### 1. 中｜新缓存没有上限，模型答案可以累积保留大量路径列表和文件全文

文件：`scripts/model-review/plan-claims.mjs:215-239`

问题：`changedFileCache` 和 `headBlobCache` 是模块级的 `Map`，没有淘汰或字节上限。`headBlobCache` 的每个值是被扫描文件的完整文本；`changedFileCache` 的每个值是一次 `git diff --name-only` 的全部路径。模型答案里每条 CLAIM 最多可带 8 个地点（`MAX_EVIDENCE_PLACES`），每个地点可带不同的 `@提交`，而 CLAIM 条数没有上限。旧实现逐个调用 `blobAt` 后即释放，新缓存会在整个进程内保留所有被引用提交的路径列表和所有命中文件的全文。

证据：

```js
215: const changedFileCache = new Map();
216: const headBlobCache = new Map();
...
225:       ? listed.stdout.split("\0").filter((path) => path && validEvidencePath(path))
...
236:     headBlobCache.set(key, blob === null || blob.includes(0) ? null : blob.toString("utf8"));
```

建议：给两个缓存设总条目或总字节上限（LRU），或只缓存当前 `claimsProblems` 调用内的数据并在结束时清空；至少不要把每个文件的全文无上限地留住。若只是为了避免同一文件被反复读取，可按 `head+path` 做短生命周期缓存。

### 2. 中偏低｜`isAdrPath` 跳过整个 `docs/adr/`，而不是只跳过 ADR 文件，可能少报“旧代码仍在”

文件：`scripts/model-review/plan-claims.mjs:241-247`

问题：规则文字只说“不看 `docs/adr/` 下的 ADR”（`.agents/instructions/model-review.md:44`），但代码用 `startsWith("docs/adr/")`，会跳过该目录下所有文件，包括不是 ADR 的文件。如果被引旧代码被挪进 `docs/adr/` 下的非 ADR 文本文件（例如 `docs/adr/tools/old.ts`、`docs/adr/notes.txt`），`commit-quote-still-in-head` 就不会报，和“只会多拒绝”的约束不一致。

证据：

```js
241: const isAdrPath = (path) => path.startsWith("docs/adr/");
...
246:   const paths = listed.filter((path) => !skipPaths.has(path) && !isAdrPath(path));
```

仓库已有更精确的 ADR 定义：

```js
8: export const ADR_PATH_PATTERN = /^docs\/adr\/\d{4}-[^/]+\.md$/;
```

建议：把 `isAdrPath` 改成 `ADR_PATH_PATTERN.test(path)`，或复用 `addedAdrs` 的同一判定，只跳过真正的 ADR Markdown；补一条 `docs/adr/` 下非 ADR 文本文件包含旧代码时仍应报 `commit-quote-still-in-head` 的用例。

### 3. 低｜新行为的主要反向用例有，但失败路径和“真正的改名”没有覆盖

文件：`test/tooling/plan-claims-gate.test.mjs:584-625`

问题：ADR 跳过和“超过 400 个文件报 incomplete”都有正反断言，反向用例是真的会失败。但缺少：

- `git diff` 失败返回 `commit-quote-check-incomplete` 的用例（代码在 `plan-claims.mjs:245`）；
- 真正的 `git mv`/重命名用例。现有“code the PR moved”用例是“修改原文件 + 新增文件”，不是 rename；虽然我用仓库历史验证了 `git diff --name-only` 对 rename 输出的是目标路径（见下），但没有测试锁住这个行为；
- 恰好 400 个和 401 个的边界；
- `docs/adr/` 下非 ADR 文件包含旧代码时仍应命中的用例（对应意见 2）。

建议：补一个用 `git mv` 的夹具、一个 `git diff` 失败（可用坏仓库或不可读对象模拟）的夹具，以及 400/401 边界用例。

### 4. 低｜作者对改动范围的说明与 HEAD 提交不一致，ADR 0270 也没有记录新增行为

文件：`docs/adr/0270-faster-review-rounds.md:57`；提交 `4b4e7259`

问题：作者说“这个 PR 是 PR 496 收尾，补三条”，但 `git log` 显示 `4b4e7259` 是“PR 502 第 1 轮复核意见”，并且增量新增了 `commit-quote-check-incomplete`、跳过 ADR、加缓存，这些不在作者列出的三条范围内。`model-review.md:44` 已更新，但 ADR 0270 第 4 点仍只写“当前提交里已经没有这段原文”，没有提到 `docs/adr/` 例外和 `commit-quote-check-incomplete`。

建议：复核材料按 `349e738e..4b4e7259` 的实际范围更新；如果 ADR 0270 仍是该机制的设计依据，补一句新增的失败码和 ADR 跳过规则，或明确以 `model-review.md` 为准。

**读代码证实的**

- `selfCheckSteps` 与旧实现逐项一致：旧代码 `cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS`、`if (!cached) guardProbe`、`if (gateway) { if (!cached) passthrough/failover; installCheck }`，新代码对应为 `models`、`guardProbe: !cached`、`passthroughProbe/failoverProbe: !cached && Boolean(gateway)`、`installCheck: Boolean(gateway)`。`opencode-review.mjs:2746-2753` 与 `:2798`、`:2843-2853` 的接线一致。
- `cached: true, gateway: null` 的新用例确实覆盖了“缓存命中但没有网关”的组合，断言 `installCheck === false`；`cached: true, gateway` 时 `installCheck === true`。
- `quoteInChangedFiles` 的三个返回值和唯一调用端匹配：`plan-claims.mjs:287-289` 分别处理 `"found"`、`"incomplete"`，其余为 `"none"`。
- `commit-quote-check-incomplete` 经 `plan-claims.mjs:456` 变成 `claims-evidence ...`，由 `assertReviewed` 的 `claims.problems` 输出；`OVERRIDABLE_PROBLEMS` 里有 `"claims-"` 前缀（`opencode-review.mjs:1456`），所以它和原有 `claims-*` 一样可被 Andy 显式盖过，没有漏接的消费端。
- `git diff --name-only --diff-filter=AMR` 对真实重命名提交输出的是目标路径。我用仓库里的 `8aada0114`、`4c7529098` 验证，输出包含新路径而不含旧路径；因此 `blobAt(head, path)` 能读到改名后的文件。
- 二进制文件由 `headTextOf` 的 `blob.includes(0)` 排除，不会把二进制里的字节误报成旧代码仍在。
- 复核记录目录 `.agents/reviews/` 和非法路径由 `validEvidencePath` 排除，新增的 401 个文件用例也实际依赖了这一点（答案文件本身含被引代码，若不排除记录目录会误报）。
- “同一句有多条旧判断时挑证据仍在的那条”实现为 `sameSentence.find((item) => carriedEvidenceHolds(...)) ?? sameSentence[0]`；证据都不在时仍会走后面的 `claims-verdict-evidence` 检查，不会直接放行。

**推测/未核实**

- 缓存的内存增长在真实大型 PR 上是否会达到不可接受的程度，未实测；机制上会随被引用提交数和被扫描文件数增长。
- `docs/adr/` 下是否有非 ADR 文本文件，当前仓库看起来主要是 Markdown；因此意见 2 的实际触发面可能很小，但代码与规则文字确实不一致。
- `blobAt` 对超过 `maxBuffer`（256MB）的文件会失败，`headTextOf` 会把它当成 `null`。这会让“旧代码仍在”漏报；但旧实现也是同样处理，不是这次增量引入的。未核实实际大文件触发的概率。
- 上一轮的判断记录没有带入；`git show` 读 `.agents/reviews/pr-502/briefs/...` 被 `REVIEW_GIT_REFUSED records-path` 拒绝，无法核对“上轮意见是否真的改好了”的逐条内容。

**侧重检查**

- 错误路径：`git diff` 失败 → `changedFilesBetween` 返回 `null` → `quoteInChangedFiles` 返回 `"incomplete"` → `claimEvidenceProblem` 返回 `commit-quote-check-incomplete`，是拒绝而不是放行；`blobAt` 失败或二进制文件 → 视为不在 HEAD。前者比旧代码更严格，后者与旧代码相同。
- 不合规范/不可信输入：`@提交` 仍由 `COMMIT_PATTERN` 限制为 40/64 位十六进制，并经过 `commitInPullRequest` 的祖先/PR 范围检查；路径由 `locationOf` 和 `validEvidencePath` 校验；`git` 调用使用参数数组，没有 shell 拼接。
- 安全：本次只增加了只读的 `git diff`/`git show` 调用；没有写文件、删除或不可撤销操作。未发现新增的注入面。
- 资源耗尽：见意见 1；另外 `git diff --name-only` 仍然在判断 400 之前枚举全部路径，超大提交会先产生完整路径列表，这是旧代码已有的行为，但新缓存会保留它。
- 规则/文档一致性：`model-review.md:44` 与代码的“超过 400 或 `git diff` 失败报 incomplete”一致；`docs/adr/0270:57` 与新增行为不一致，见意见 4；作者的范围说明与 HEAD 提交不一致。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。这个增量只改了复核脚本、测试和复核说明；没有改系统提示、工具定义、历史消息或遮盖结果的组装。`selfCheck` 只是本地探针选择，探针结果不进入被复核模型的历史。`prompt-prefix.md` 第 4 条要求已发内容只能末尾追加；这里没有触碰任何已发内容，也没有在新的模型请求开头加入会变的值。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的缓存、错误码和路径过滤都只在本地复核门里使用，没有进入模型请求的序列化。`git diff` 对同一组 `commit/head` 输出顺序稳定，返回的 `"found"/"none"/"incomplete"` 也是确定值。
3. **有没有对应自动检查，反向用例真的会失败？** 有。`selfCheckSteps` 的四组 `cached × gateway` 组合都有断言；ADR 跳过和超过 400 个文件都有正反断言，按代码路径如果删掉 `isAdrPath` 或把 `> MAX_MOVED_FILES` 改回截断，对应用例会失败。缺口是 `git diff` 失败、真正的 rename、400/401 边界和 `docs/adr/` 非 ADR 文件没有用例，见意见 3。
4. **改动产生或修改的每个值，使用端都能接受吗？**

   - `selfCheckSteps` 返回的 `models/guardProbe/passthroughProbe/failoverProbe/installCheck`：生产端只有 `selfCheck`（`opencode-review.mjs:2766` 起），测试端 `opencode-review.test.mjs:1422-1443`；两端读取的键一致。
   - `commit-quote-check-incomplete`：产生于 `plan-claims.mjs:289`，经 `:456` 变成 `claims-evidence ...`，由 `assertReviewed` 的 `claims.problems`（`opencode-review.mjs:1587`）输出，并被 `OVERRIDABLE_PROBLEMS` 的 `"claims-"` 前缀覆盖（`:1456`）；测试 `plan-claims-gate.test.mjs:623` 也接受这个字符串。
   - `quoteInChangedFiles` 的 `"found" | "none" | "incomplete"`：唯一调用端 `plan-claims.mjs:287-289` 三个分支都处理。
   - `changedFilesBetween`、`headTextOf`、`isAdrPath`、`MAX_MOVED_FILES`：模块内部值，没有外部使用端。
   - 未发现新增的配置键、清单项或序列化格式。

**这一轮查过的范围**

`git diff 349e738e..4b4e7259`（`plan-claims.mjs`、两个测试、`model-review.md`、二进制 brief 被 git 拒绝读取）；`git diff 9f83b168..4b4e7259`（`opencode-review.mjs` 和 `selfCheckSteps` 相关测试）；`plan-claims.mjs` 1-508 行；`opencode-review.mjs` 1449-1610、2735-2860 行；`plan-claims-gate.test.mjs` 1-160、540-660 行；`opencode-review.test.mjs` 1370-1445 行；`prompt-prefix.md` 规则；`incidents-and-gates.md` 的 I-73；`docs/adr/0270-faster-review-rounds.md` 第 57 行；用 `git log --diff-filter=R` 和 `git diff --name-only` 在真实重命名提交上验证了 rename 输出。未运行测试（本轮工具不允许）。
