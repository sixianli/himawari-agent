# 复核结论（HEAD `15e247b8`，重点看 `65a0450e..HEAD`）

## 读代码证实的问题

### 1. 中：`--report` 用“轮次+提交”认链，重复的 low-fix 记录会被误认成链上，并可能直接崩溃

- 位置：`scripts/model-review/opencode-review.mjs:1263-1284`
- 问题：`onChain` 只比较 `round` 和 `head`，不比较 `from`、`files`、`findings`。两条同一轮、同一 `head` 的 `low-fix` 记录（手写或重复追加都行）都会被认为在链上。若第二条的 `findings` 指向 verdicts 里不存在的 id，`verdicts.find(...)` 返回 `undefined`，随后 `verdict.model` 抛未捕获的 `TypeError`。
- 证据：

```js
// 1263-1267
const onChain = (record) =>
  gate.accepted.some(
    (point) =>
      point.by === "low-fix" && point.round === record.round && point.head === record.head,
  );
// 1277-1282
const verdicts = parseVerdicts(text.stdout, path);
...
const verdict = verdicts.find((item) => item.id === id);
return `  ${printable(id)} ${verdict.model.split("/").pop()}：${printable(verdict.quote)}`;
```

  `walkChain` 只会把第一条合格记录放进 `gate.accepted`（第二条会 `chain-broken`/`second-low-fix`），但 `onChain` 仍然把第二条认成链上：

```js
// 1053-1056
if (point.by === "low-fix") {
  if (point.from !== covered || !isAncestor(covered, point.head)) problems.push("chain-broken");
  else if (accepted.at(-1).by === "low-fix") problems.push("second-low-fix");
```

  第四轮恰好删掉了原来的 `verdict-missing` 兜底（旧代码见 `git show 65a0450e:scripts/model-review/opencode-review.mjs` 的 `reviewReport`），所以作者说的“删掉走不到的 verdict-missing 分支”不成立：这个分支在重复记录下是可达的。
- 影响：`--stop andy-decision` / `--stop three-rounds` 时 `--report` 可能直接以未捕获异常退出；即使不崩，也会把第二条记录的 `from/files` 当成已放行内容打印，误导 Andy 抽查。
- 建议：`onChain` 同时比较 `from`、排序后的 `files` 和 `findings`（或直接由 `gate.accepted` 的 point 生成报告行，不再回头遍历原始记录）；`verdict` 找不到时保留安全的 `verdict-missing` 输出而不是解引用。补一个“同一轮、同一 head 的重复 low-fix 记录”反向用例。

### 2. 中：GLM 的固定侧重在 GLM 已经跑过第 1 轮之后才改，违反“同一模型每轮前缀逐字节相同”

- 位置：`scripts/model-review/opencode-review.mjs:179-184`
- 问题：本 PR 在 `65a0450e` 把 GLM 侧重里的“另一个复核者侧重别的方面”改成“有时另有一个复核者……有时只有你一个”。PR #263 的 GLM 第 1 轮提示词是在 `b454ed99` 生成的，当时脚本里的 GLM 侧重仍是旧文本（`git show b454ed99:scripts/model-review/opencode-review.mjs` 第 183 行仍是“另一个复核者侧重别的方面”）。如果 GLM 在本轮/后续轮替补，它的前缀会和它第 1 轮已经看到的不同。
- 证据：

```js
// 当前 HEAD 182-183
"glm-5.3-flash":
  "你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；……有时另有一个复核者侧重别的方面，有时只有你一个，……",
```

  `buildPrompt` 把 `lens` 放进 `fixed`，位于 `---- 本次材料 ----` 之前：

```js
// 198-208
const fixed = [
  text.role,
  ...
  ...(lens ? [lens] : []),
  text.output,
].join("\n");
const material = ["---- 本次材料 ----", ...]
```

- 影响：不是正确性错误，但直接命中材料里的硬约束“同一个模型每轮提示词在‘本次材料’之前必须逐字节相同”，并且会让 GLM 替补时失去前缀缓存。DeepSeek 的侧重是在 `947d8131` 改的，早于 PR #263 第 1 轮，所以 DeepSeek 第 1～3 轮是一致的；作者关于 DeepSeek 的说法成立，但没有覆盖 GLM。
- 建议：要么在开始复核前就冻结本轮所有模型的 lens 文本，要么明确接受一次 GLM 前缀变更并在 ADR/规则里写清代价；不能一边写“每轮逐字节相同”一边在中途改 GLM 的固定句。

### 3. 低：low-fix 的“原话”在修好的提交上读取，修好的提交可以同时改写/伪造模型答案

- 位置：`scripts/model-review/opencode-review.mjs:945,959,974`
- 问题：`lowFixProblems` 在 `to`（即 low-fix 记录的 `head`）读取 `verdicts.jsonl` 和 `<模型>.md`；而 `git diff` 的规模统计又把整个 `${ledgerPath}/` 排除（`974` 行）。因此一个手写的 low-fix 记录只要在同一个提交里顺带写入伪造的 verdicts 和模型答案，就能通过“原话逐字出现”检查，且这些证据不计入文件数/行数上限。
- 证据：

```js
// 945
const text = showAt(repo, to, verdictsPath);
// 959
showAt(repo, to, `${ledgerPath}/round-${round}/${verdict.model.split("/").pop()}.md`),
// 974
if (!match || match[3].startsWith(`${ledgerPath}/`)) continue;
```

- 说明：读取位置本身是代码证实的；“能在同一提交伪造证据从而绕过”是对该读取位置的推理，未实际构造运行。现有测试 `test/tooling/opencode-review.test.mjs:2704-2750` 只覆盖“证据在修好之后才提交”，没有覆盖“证据和修好一起提交”。
- 建议：在复核记录里保存模型答案的哈希（例如 `answerSha256`），检查 `to` 的答案与复核时记录的一致；或当答案文件在 `from` 已存在时要求 `from`/`to` 内容相同。至少要把这一残留风险写进 ADR，别把“手写 low-fix 记录不能绕过”说成绝对。

## 推测 / 未完全核实

- `parseUsage` 允许同一轮、同一 `head` 的重复 low-fix 记录（只校验字段，不去重），这是问题 1 的前提；已读代码确认。
- 作者说“verdict-missing 分支走不到”不成立；但这是逻辑推理结论，不是运行复现。
- OpenCode 遇到 429 会自己按服务间隔连试 5 次，属于外部程序行为，仓库代码无法证实，未核实。
- PR #263 的实际提示词存档目录在当前工作区不存在（`.agents/reviews/pr-263` 不在检出内容里，`git show` 又被记录的 git 守卫拒绝），所以只能按提交顺序判断旧 GLM 文本，未能直接读存档的 round-1 GLM `prompt.md`。
- 测试“140 条全过”、`npm run check`、`npm run build` 通过：工具只允许 git 命令，无法运行，未核实。

## 侧重检查

查过并确认没有问题的错误路径/安全/资源相关点：

- `apiErrorOf`：控制字符替换、连续空格压缩、300 字截断；`retry-after` 为空串、`null`、纯空白、非数字都落到 `retryable:false`（`228-248`），反向测试覆盖（测试 `481-507`）。
- `retryAfterApiError`：只对可重试 `api-error` 重试；`costUnknown` 优先；余额 `<0.07` 记 `no-budget`，等待后剩余时间 `<60s` 记 `no-time`（`726-732`）；测试 `518-527`。
- `reviewModel`：只重跑一次；第二次 `startingUsd` 为第一次花费，`ownLimit = 0.2 - 第一次花费`；费用相加；不会无限重试（`734-770`）；测试 `1940-1985`。
- `substituteFor`：仅 `code-review`、有 `--previous`、单模型、DeepSeek 可重试 `api-error` 且确实重跑过才返回 GLM；替补前再次 `budgetCheck`（`716-724`、`2292-2319`）；测试 `537-559`。
- `parseUsage` 的 low-fix 校验：正整数轮次、`from` 提交格式、`cost===0`、非空 `files`/`findings`、无换行（`1344-1354`）。
- `lowFixProblems`：verdicts 未提交/格式错/原话缺失/非 low/无 low/无改动/文件过多/行数过多/文件名含换行/无测试新增行都拒绝；二进制 diff 记为无限行（`942-997`）。
- 不可撤销操作：`--accept-low` 和 `--accept-unreviewed` 都只追加账本，且先校验 `ledgerMatchesHead`；没有删除或覆盖仓库历史。
- 资源耗尽：`--report` 对链上 low-fix 会读取 `verdicts.jsonl` 并解析；由于记录目录不计入 low-fix 规模限制，理论上可在记录目录放超大文件耗尽内存，但这属于线程自伤，未列为独立问题。
- 规则/文档一致性：ADR 0068 的 `amended_by`、ADR 0175 标题、案例库、handoff 都已改为 0175；`grep` 未发现残留的 `0174-cheaper...` 链接；ADR 0174 是 main 上已有的 CI ADR，未冲突。`.md` 大小写处理在 `isTestFile` 和 `docsOnly` 两处一致（`892-896`、`989`）。

## 作者说法核对

- `summarizeEvents` / `apiErrorOf` / `isRetryable`：与代码一致；“去掉控制字符”实际是替换成空格，表述略宽。
- `reviewModel` 等 60 秒、只重跑一次、费用相加、第二次上限、`0.07`/时间门槛、记 `retry` 原因：与代码一致。
- `substituteFor`：与代码一致，且额外要求 `retry === "retried"`，这正符合“没重跑的不算替补”。
- `parseArgs`：`code-review` 无 `--previous` 且无 `--round` 时必须两个模型；有 `--previous` 且未写 `--models` 时只跑 DeepSeek，均一致（`2121-2126`）。
- `coveragePoints 从 lastCompleteRound 起`：**表述与代码不一致**。`lastCompleteRound` 已在 `65a0450e` 删除；`coveragePoints` 现在枚举所有轮次（`999-1039`），真正的“从最后一个双模型无 `--previous` 轮重新起头”由 `walkChain` 的 reset 完成（`1045-1048`）。行为基本等价，但不是函数描述的事实。
- `assertReviewed` / `lowFixProblems` / `parseUsage` / `nextRound` / `roundForRun` / `--report`：主体与描述一致；`verdict-missing` 并非完全走不到（见问题 1）。
- 测试数量与 `npm run check`/`npm run build`：未能运行，未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   第四轮的增量本身没有改 `buildPrompt`：固定段仍是 `198-208`，`head`、`base`、`previous`、`brief` 都在“本次材料”之后（`209-221`），每轮变化的值仍在末尾材料里；重跑也是重发同一份 prompt，测试 `test/tooling/opencode-review.test.mjs:1955` 明确断言重跑请求的 `messages` 与第一次相同。
   但整个 PR 里 `MODEL_LENSES` 的 GLM 文本在 GLM 第 1 轮之后被改过，因此 GLM 若再跑，前缀不再与第 1 轮逐字节相同（见问题 2）。DeepSeek 的 lens 改动早于 PR #263 第 1 轮，DeepSeek 第 1～3 轮前缀一致。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   提示词里没有时间字段；`at` 只写进账本，不进提示词；`questions` 来自固定规则的顺序匹配，`lens` 是常量，`material` 拼接顺序固定。`apiError`、verdicts、low-fix 记录都不进提示词。因此除了一次性的 lens 文本变更外，没有依赖前后文或无序集合导致的字节漂移。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有较完整的自动检查：`api-error` 解析、重试条件、替补条件、low-fix 接受/拒绝、链式合并门槛、报告读取各记录自己的提交都有测试（例如 `464-559`、`1940-1985`、`2472-2801`）。
   缺口：问题 1 的“同轮同 `head` 重复 low-fix”没有反向用例，当前测试不会失败；`.MD` 只有 `isTestFile` 返回 `false` 的断言（`3472-3475`），没有“只有 `.MD` 文档时免测试”的接受用例。测试是否真的 140 条全过无法运行验证。

4. **每个新值，产生端和使用端都能接受吗？**
   - `low-fix` 记录的 `round/head/from/cost/files/findings`：`acceptLow` 产生（`1191-1203`），`parseUsage`、`coveragePoints`、`walkChain`、`lowFixProblems`、`--report` 都能接受；唯一两端不一致的是报告侧 `onChain` 只用 `round+head` 认记录，未消费 `from/files/findings`，导致问题 1。
   - `substitute` / `substituteFor`：`runOne` 写入（`2313-2316`），`coveragePoints` 只认 `substituteFor === REVIEW_MODELS[0]` 且模型为替补模型，两端一致。
   - `retry` / `retriedAfter` / `apiError`：写入账本；`substituteFor` 只消费 `retry === "retried"`，与文档“没重跑的不算”一致。
   - `--accept-low`：只在 `--assert-reviewed` 下允许，`--report` 会以 `ARG_NOT_FOR_SUBCOMMAND` 拒绝（`2005-2020`、`2103-2109`）。
   - ADR 编号：0175 的 `amends`、0068 的 `amended_by`、案例库、handoff 全部一致，未发现遗留 0174 复核 ADR 链接。
   - `.md` 判定：`isTestFile` 与 `docsOnly` 都改成大小写不敏感，使用端一致。
