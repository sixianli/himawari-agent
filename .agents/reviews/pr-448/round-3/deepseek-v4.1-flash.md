## 侧重检查

我检查了这类路径，结论如下：

- **改号引用**：`AGENTS.md:49`、`.agents/instructions/model-review.md:4`、`docs/adr/0175-cheaper-code-review-rounds.md:8`、`docs/adr/0259-review-models-default-to-deepseek.md:11` 都已改成 0259；当前 `docs/` 和指令文件里没有残留的 0255（`docs/backlog` 里命中的只是 SHA-256 字符串，与 ADR 无关）。
- **合并门的 ADR/claims 路径**：`scripts/model-review/plan-claims.mjs` 的 `addedAdrs`/`claimsProblems` 和 `scripts/model-review/opencode-review.mjs` 的 `assertReviewed` 存在一个会挡住合并的问题，见下面第 1 条。
- **配置读取与校验**：`readReviewModels`/`reviewModelsProblems`/`parseArgs --models` 会拒绝空列表、重复、越界模型和非法格式，并在读不到配置时以 `REVIEW_MODELS_CONFIG_INVALID` 停下。
- **替补、预算和重试**：`substituteFor` 第一轮不再要求 `previous`，但仍要求代码复核、只跑一个模型、重跑后是 `api-error` 且可重试；`reserveModels` 第一轮也预留替补费用。路径本身没有发现新的资源耗尽或不可逆操作。
- **不可逆操作**：改号只改文件名、标题和引用；历史复核记录没有改写，这是对的，但正好导致第 1 条里的 claims 记录仍是旧路径。
- **规则与代码一致性**：ADR 0259 的决定 1–4 与 `parseArgs`、`substituteFor`、`coveragePoints`、`walkChain` 基本一致；唯一明显不一致的是 plan-claims 记录没有随改号更新。

## 结论

### 【中】改号后，现有 ADR 的 plan-claims 记录失效，`--assert-reviewed` 会被挡住

**文件:行**：`scripts/model-review/plan-claims.mjs:150-169`、`:210-227`；`scripts/model-review/opencode-review.mjs:1439-1446`、`:1506`；规则见 `.agents/instructions/model-review.md:34-35`

**问题**：改号不仅是文件名变了，ADR 标题那一行也变了；但 `.agents/reviews/topic-review-default-models/` 里的 plan-claims 记录是在改名前为 `docs/adr/0255-...` 写的，21c 没有更新这份账本，也没有补一轮新的 plan-claims。合并门会把 0259 当成“新增 ADR”，找不到路径和 SHA-256 都匹配的记录。

**证据（读代码证实的）**：

- `plan-claims.mjs:150-169` 用 `--no-renames --diff-filter=A` 找新增 ADR。实际运行 `git diff --no-renames --diff-filter=A cc510..21c -- docs/adr` 只输出：
  `docs/adr/0259-review-models-default-to-deepseek.md`
- `plan-claims.mjs:210-227`：
  ```js
  const sha = blobSha256(repo, head, adr);
  const own = records.filter((record) => record.claimsFile === adr);
  ...
  const matching = own.filter((record) => record.claimsSha256 === sha);
  if (matching.length === 0)
    problems.push(own.length > 0 ? `claims-stale ${label}` : `claims-unchecked ${label}`);
  ```
- `opencode-review.mjs:1439-1446` 在 `assertReviewed` 里调用 `claimsProblems`，`:1506` 把 `claims.problems` 加进合并检查结果。
- `.agents/instructions/model-review.md:35` 写明：“内容改过一个字节就不一致，报 `claims-stale`，必须对新内容重核；根本没有记录报 `claims-unchecked`。”
- `opencode-review.mjs:3181-3186`：plan-claims 运行要求 `--claims-file` 在当时的 `head` 存在，否则报 `CLAIMS_FILE_NOT_COMMITTED`。因此 21c 之前写下的记录不可能合法地写成 `docs/adr/0259-...`。
- `git show --stat 21c00a7e` 显示该提交只改了 5 个文件，没有改 `.agents/reviews/topic-review-default-models/usage.jsonl`；`b5dd0ed8`、`98bc3e7f` 才是在改名前增加该 topic 账本记录的提交。

**推测（未直接读到记录内容，工具以 `REVIEW_GIT_REFUSED records-path` 拒绝了 `.agents/reviews/**`）**：记录里的 `claimsFile` 仍是 `docs/adr/0255-...`，所以合并门会报 `claims-unchecked docs/adr/0259-review-models-default-to-deepseek.md`；即使记录里碰巧写成 0259，标题改动也会让 SHA-256 不匹配，报 `claims-stale`。两种情况都不能通过 `--assert-reviewed`。

**建议**：改号后对 `docs/adr/0259-review-models-default-to-deepseek.md` 重新跑一轮 `--mode plan-claims`，把新记录提交，再运行 `--assert-reviewed`。如果 Andy 明确接受跳过，再按规则用 `--accept-unreviewed`，不要只跑三个格式检查就认为可以合并。

### 【低】作者对“增量”和“除编号外没有别的改动”的说明不准确

**文件:行**：提交 `21c00a7e`、`f0a903e9`、`98bc3e7f`

**问题**：21c 还新增了 `.agents/reviews/pr-448/briefs/round-3.md`；而第 2 轮的代码修改是 `98bc3e7f`，在 603f9dce 之前。`git diff 603f9dce..21c00a7e` 里没有这次代码修改，只有 `f0a903e9` 的账本记账、合并提交 `a7c99484` 和改号提交。

**证据（读代码证实的）**：

- `git show --name-status 21c00a7e` 有 `A .agents/reviews/pr-448/briefs/round-3.md`。
- `git show --stat f0a903e9` 只改了 `.agents/reviews/pr-448/usage.jsonl`。
- `git show --stat 98bc3e7f` 才包含 `opencode-review.mjs`、测试和 ADR 0255 的代码修改。
- `git show --stat a7c99484` 显示合并提交还带进了 PR 441 和 CI 相关文件，不是这次改号产生的。

**建议**：汇报时把“本次改号”与“合并 main 带进来的改动”“第 2 轮代码修改”分开写，避免复核者按 603f9dce..21c00a7e 找不到作者说的代码修改。

### 未核实

- 没有运行 `npm run check:*`、`--assert-reviewed` 或 vitest；只读了代码和测试断言。
- 未能直接读 `.agents/reviews/**` 下的 claims 记录和 round-3 brief 内容，原因同上。
- 其他分支上 0255、0256–0258 是否确实被占用，离线无法核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。复核提示词只从 `.agents/instructions/model-review.md` 的 `<a id="checklist">` 段提取问题（`scripts/model-review/opencode-review.mjs:281-292`），改号改的是第 4 行，位于 checklist（第 73 行起）之前；而且 `questionsSource` 读的是基准提交（`:2573-2577`），本次复核基准是 cc510，改号不改变 checklist 内容。`buildPrompt` 先拼固定说明，再把 `head`/`base`/`previous`/`brief` 放在最后的材料段（`:345-375`），每轮变化的值仍在最后一条消息里。系统提示、工具定义、历史消息和遮盖都没有被这次改号改动。合入的配置改动只是改变“跑哪个模型”，没有改写已见前缀。
2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。0255→0259 是确定性的字面替换；没有引入时间字段、依赖前后文的遮盖或无序集合。`review-models.json` 的数组顺序固定，`JSON.parse` 后直接使用；`coveragePoints` 使用的轮次经过排序，记录顺序来自账本，不会把无序集合写进提示词。
3. **有没有对应的自动检查，反向用例真的会失败？**
   有，但这次改号漏掉了最关键的合并检查。`test/tooling/adr-numbers.test.mjs:30-42` 覆盖编号重复，`:81-89` 覆盖标题编号与文件名不符，`:91-123` 覆盖旧链接和缺失路径，`:147-149` 对当前仓库运行检查；`check:instruction-links` 覆盖 AGENTS.md 和 model-review.md 的链接。针对第 1 条，`test/tooling/plan-claims-gate.test.mjs:314-319` 明确断言“新增 ADR 但没有 claims 记录时 `--assert-reviewed` 不通过”，`:357-370` 断言“检查后修改 ADR 会变成 `claims-stale`，重核后才通过”。这次提交没有跑这一步，所以反向用例正好会命中。
4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   0259 的生产处和使用处基本一致：文件名 `docs/adr/0259-...`、标题 `# ADR 0259：...`、`AGENTS.md:49`、`.agents/instructions/model-review.md:4`、`docs/adr/0175:8` 的 `amended_by` 都是 0259；`check:adr-numbers` 校验标题/路径，`check:instruction-links` 校验两个链接。唯独 plan-claims 账本里的 `claimsFile`/`claimsSha256` 是使用 ADR 编号和内容的另一处，仍停留在改号前，因此不能通过合并门的校验（第 1 条）。配置键 `allowed`/`default`/`substitutes` 的使用端也能接受：`readReviewModels`、`reviewModelsProblems`、`SUBSTITUTES`、`delegate.mjs` 以及 `MODEL_LENSES`/`MODEL_OUTPUT_LIMITS`/`gateway.json` 的现有测试都对得上。
