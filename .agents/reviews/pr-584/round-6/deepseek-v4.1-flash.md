## 本轮查过的范围

本轮增量 7 个文件，加上它们的直接使用端：

- `scripts/model-review/opencode-review.mjs`：`buildPrompt` / 固定前缀（370-424）、`briefSha256` / `reusedBriefRecord`（426-440）、`parseUsage`（2250-2332）、`parseArgs`（3500-3678）、重用检查（3965-3976）、账本写入（4223-4259）、`SHADOW_FULL_SUGGESTED`（4344）、`NEXT`（2121）、工具白名单与副本目录（123-303、3274-3297）。
- `scripts/model-review/increment.mjs`：`shadowCommand`（330-344）。
- `scripts/model-review/delegate.mjs`：`briefPathFor` / `validateTask` / `reviewArgv`（44-128）、`parseTask`（457-499）、委托结果核对（296-339）。
- `test/tooling/review-increment.test.mjs`（299-369、590-611）、`test/tooling/review-round-tools.test.mjs`（232-240、267-278）。
- 文档：`.agents/instructions/model-review-card.md`（18、22、45）、`.agents/instructions/model-review.md`（165-176）、`.claude/agents/code-review-round.md`（13-19）、`docs/adr/0280...`（140-149）、`.agents/instructions/prompt-prefix.md`（第 4、6、86 条）。

上一轮材料写“没有成立的意见”，本轮没有可逐条复核的上一轮修复项。

## 侧重检查

- **错误路径**：`REVIEW_BRIEF_REUSED` 在自检、预算核对、`startLiveGateway` 和模型调用之前抛出（`opencode-review.mjs:3966` 早于 `4141`、`4163`），不会先花钱。`ARG_PR_BRIEF_*` 的三种组合都会拒绝；`--previous` 无效时更早在 `resolveCommits` 抛 `GIT_FAILED`。但 `--pr-brief` 只查 `existsSync`，不查是否普通文件、不查内容非空。
- **不可信输入**：`briefSha256` 是单向摘要，不进入提示；`REVIEW_BRIEF_REUSED` 只输出账本里已通过 `COMMIT_PATTERN` 校验的 `head` 和整数 `round`，没有新的注入面。`--pr-brief` 路径只做存在性检查，本进程不读取它，不会因此读入秘密。
- **安全**：`GIT_READ_COMMANDS` 不含 `git grep`（123 行），bash 默认 deny（254 行），副本 sparse-checkout 排除了 `.agents/reviews`（3279 行），所以新增的 `TOOL_USAGE_SENTENCE` 与实际限制一致；没有新增密钥落盘或日志。
- **资源耗尽**：`briefSha256` 只多一遍全文哈希，brief 本来就要整份读入；账本扫描是原有 `readUsage`，没有新增无界循环。
- **不可撤销操作**：新拒绝发生在花钱前，方向正确；问题在 `--pr-brief` 的传递和回退，见下面意见。
- **规则/文档与代码**：`prompt-prefix.md` 第 86 条要求改请求开头先出方案；ADR 0280 记录了 Andy 同意，固定前缀这次一次性变化有依据。但流程卡把 `--pr-brief` 说成“只在抽样时用到”，却由代码无条件要求存在；流程卡第 22 行仍把材料说成整个 PR 的“问题、目标、约束和作者的说法”；委托文档支持 `--previous`，但 `delegate.mjs` 不认 `--pr-brief`。

## 意见

### 1. 中 — 委托复核链路不认也不传 `--pr-brief`，增量轮的抽样全量复核会静默拿本轮材料当整份 PR 材料

文件:行：`scripts/model-review/delegate.mjs:457-499`、`:106-128`、`:100-104`；`scripts/model-review/opencode-review.mjs:4344`

问题：增量轮的 `NEXT` 和直接运行都带 `--pr-brief`，但 Mac 线程把复核交给云端线程时用的 `delegate.mjs` 没有这个参数；云端命令缺 `prBrief` 后，`SHADOW_FULL_SUGGESTED` 会回退到 `options.brief`（本轮材料），打印出的“整份全量复核”命令实际拿增量材料做全量复核。

读代码证实：

```js
// delegate.mjs:457-492
else if (key === "--previous") task.previous = take();
...
else fail(`DELEGATE_UNKNOWN ${key}`);
```

```js
// delegate.mjs:106-124
"--brief",
task.brief,
"--gateway",
"magpie",
"--require-gateway",
```

```js
// opencode-review.mjs:4344
`SHADOW_FULL_SUGGESTED ${shadowCommand({ ..., brief: options.prBrief ?? options.brief, ... })}`
```

`model-review.md:176` 又明确支持委托增量轮（`[--previous …]`），所以这条路径可达。`delegate.mjs:100-104` 只允许 `task.brief === briefPathFor(task)`，任务结构里没有放第 1 轮材料的位置。

推测：实际是否每次委托增量轮都会跑抽样命令，取决于主线程/云端线程是否照 `SHADOW_FULL_SUGGESTED` 执行；但“参数根本传不进去、缺省时用错材料”是确定的。

建议：给 `delegate.mjs` 增加 `prBrief`（或在任务里显式给出第 1 轮材料路径），并在 `validateTask` / `reviewArgv` / `parseTask` 中校验和传递；同时让主线程在缺少 `prBrief` 时不要静默回退，至少打印警告或拒绝打印“全量”命令。补一条 `review-delegate` 的用例：带 `--previous` 的任务生成的命令必须包含第 1 轮材料。

### 2. 中 — `--pr-brief` 被每次增量轮无条件要求存在，但第 1 轮材料没有提交/保留保证，文档还说只在抽样时用

文件:行：`scripts/model-review/opencode-review.mjs:3651-3654`、`:2121`；`.agents/instructions/model-review-card.md:18`、`:45`

问题：`parseArgs` 对 `--pr-brief` 做 `existsSync` 硬校验，而流程卡说这个占位符“只在脚本建议抽样全量复核时用到”。如果第 1 轮材料只放在临时目录、或换了机器/工作区，正常的增量轮会先以 `ARG_PR_BRIEF_MISSING` 失败，哪怕这一轮根本不会跑抽样。

读代码证实：

```js
// opencode-review.mjs:3651-3654
if (options.prBrief !== undefined) {
  if (options.mode !== "code-review" || options.previous === undefined || options.shadow)
    throw new Error("ARG_PR_BRIEF_ONLY_WITH_PREVIOUS");
  if (!existsSync(options.prBrief)) throw new Error(`ARG_PR_BRIEF_MISSING ${options.prBrief}`);
}
```

```js
// opencode-review.mjs:2121
`NEXT fix-and-rereview ... --brief <本轮材料> --pr-brief <整份 PR 材料>${gateway}`
```

流程卡第 18 行写的是“`<整份 PR 材料>` 换成第 1 轮用的材料路径（只在脚本建议抽样全量复核时用到）”；第 45 行只要求把**之后**每轮的本轮材料写到 `.agents/reviews/.../briefs/` 并提交，没有要求提交第 1 轮材料。

未核实：现有 PR 的第 1 轮材料是否已经提交或仍可访问；按复核约定我没有读 `.agents/reviews/`。因此这里只确认“代码把它变成每次必填，流程没有保证它存在”。

建议：把存在性检查推迟到真正要打印 `SHADOW_FULL_SUGGESTED` 时；或者明确要求第 1 轮材料也提交到 `.agents/reviews/pr-<编号>/briefs/`，并在流程卡和 `model-review.md` 中写清。缺少时不要静默回退到本轮材料，至少打印 `SHADOW_FULL_SKIPPED pr-brief-missing`。

### 3. 低 — 新增 `--pr-brief` 的校验和 `REVIEW_BRIEF_REUSED` 的实际拒绝路径没有自动反向测试

文件:行：`test/tooling/review-increment.test.mjs:322-369`、`:590-611`；`scripts/model-review/opencode-review.mjs:3651-3654`、`:3966-3975`

问题：新增测试覆盖了 `buildPrompt` 的新句子、首轮不变、材料标题，以及 `reusedBriefRecord` 的几个纯函数反例；但没有测试 `--pr-brief` 与非 code-review、无 `--previous`、`--shadow`、文件不存在四种拒绝，也没有测试 `main` 里 `REVIEW_BRIEF_REUSED` 真的在花钱前抛出，或 `SHADOW_FULL_SUGGESTED` 优先使用 `prBrief`。

读代码证实：

- `grep` 在 `test/` 下找不到 `--pr-brief` / `ARG_PR_BRIEF` / `REVIEW_BRIEF_REUSED` 的实际调用测试；`review-increment.test.mjs:590-611` 只直接调 `shadowCommand`，不经过 `main` 的 `options.prBrief ?? options.brief`。
- `review-increment.test.mjs:355-369` 只验证 helper：

```js
expect(reusedBriefRecord({ records, head: "a1", sha })).toBeNull();
expect(reusedBriefRecord({ records, head: "d4", sha: briefSha256("影子") })).toBeNull();
```

这不能证明实际运行时“复用旧材料会拒绝且不花钱”。

建议：补 `parseArgs` 的四条反向用例；补一个不启动真实模型的 `main` 级测试（或提取一个纯函数）验证复用材料时抛出 `REVIEW_BRIEF_REUSED` 且没有调用 `reviewModel`；再补一条 `options.prBrief` 存在时 `SHADOW_FULL_SUGGESTED` 的 `--brief` 等于第 1 轮材料。

### 4. 低 — 流程卡第 22 行仍把材料说成整个 PR 的“问题、目标、约束和作者的说法”，与增量轮材料不符

文件:行：`.agents/instructions/model-review-card.md:22`、`:45`；`scripts/model-review/opencode-review.mjs:184-185`、`:417`

问题：增量轮的材料现在是“本轮改了什么、为什么改、只针对本轮增量的作者说法”，提示里标题也换成了 `ROUND_MATERIAL_TITLE`；但主线程给子代理的提示模板仍固定写“材料文件：<brief 路径>（问题、目标、约束和作者的说法）”。子代理会按错误的材料结构去理解。

读代码证实：

```md
<!-- model-review-card.md:22 -->
PR <编号>，仓库 <路径>，分支 <分支>。材料文件：<brief 路径>（问题、目标、约束和作者的说法）。对比基准：<base 提交>。
```

```js
// opencode-review.mjs:184-185
export const ROUND_MATERIAL_TITLE =
  "本轮材料（本轮改了什么、为什么改、只针对本轮增量的作者说法，可能有错，请核对）：";
```

建议：把第 22 行的材料说明改成“材料文件：<brief 路径>（第 1 轮为整个 PR 的材料；带 `--previous` 的轮次为本轮材料，内容见 `ROUND_MATERIAL_TITLE`）”，或让主线程按轮次选择不同模板。

### 5. 低 — `briefSha256` 未纳入账本字段校验，坏记录会静默绕过重用检查

文件:行：`scripts/model-review/opencode-review.mjs:2268-2272`、`:2296-2302`、`:2311-2314`、`:430-438`

问题：`claimsSha256` 有 `/^[0-9a-f]{64}$/` 校验，但新增的 `briefSha256` 在 `parseUsage` 里完全没校验。若账本中某条 code-review 记录的 `briefSha256` 不是 64 位十六进制（例如被写坏、被云端线程改坏），`parseUsage` 仍然接受，而 `reusedBriefRecord` 的严格相等只会静默跳过这条记录，重用检查失效。

读代码证实：

```js
const claimsValid =
  record?.mode !== "plan-claims" ||
  (validClaimsFile(record.claimsFile) &&
    /^[0-9a-f]{64}$/.test(record.claimsSha256 ?? "") && ...);
```

```js
// reusedBriefRecord 只做严格比较
record.briefSha256 === sha,
```

没有对 `record.briefSha256` 做 `undefined || /^[0-9a-f]{64}$/.test(...)` 这样的校验。

建议：在 `parseUsage` 中对 `record.briefSha256` 增加“存在时必须是 64 位小写十六进制”的校验；旧记录没有该字段仍接受（保持兼容）。

### 6. 低 — `REVIEW_BRIEF_REUSED` 在 `REVIEW_INCREMENT_EMPTY` 之前判定，空增量且材料重用时错误码误导

文件:行：`scripts/model-review/opencode-review.mjs:3966-3975`、`:4042-4044`

问题：如果这一轮 PR 自己没有任何树变化（例如空提交或只改了被排除的复核记录），正确结果应该是 `REVIEW_INCREMENT_EMPTY`、不花钱直接收尾；但只要本轮材料与别的提交用过的材料相同，会先抛 `REVIEW_BRIEF_REUSED`，让主线程以为需要换材料，而不是“没有增量”。

读代码证实：

```js
if (options.mode === "code-review" && commits.previous && !options.selfCheckOnly) {
  const reused = reusedBriefRecord({ ... });
  if (reused) throw new Error(`REVIEW_BRIEF_REUSED ...`);
}
...
if (planned?.empty) {
  console.log(`REVIEW_INCREMENT_EMPTY ${commits.previous}..${commits.head}`);
  return;
}
```

推测：需要“新提交但没有实际树变化”的少见场景；正常修代码后提交不会触发。但错误码确实会误导主线程。

建议：先算增量、在确认非空后再做材料重用检查；或在抛出 `REVIEW_BRIEF_REUSED` 前先判断 `planned?.empty`。

## 必答问题

1. **涉及。** 这个改动确实改变了模型已经见过的请求开头：`TOOL_USAGE_SENTENCE` 被插入所有模式的 `fixed` 前缀（`opencode-review.mjs:390`），所以和改动前相比，所有模式的请求开头都变了**一次**；ADR 0280 记录了 Andy 的同意（“固定前缀只在这次变一次”）。改动后，同一模式的固定部分仍然逐字相同：`fixed` 只含 role、工具说明、`TOOL_USAGE_SENTENCE`、task、`FOCUS_SENTENCE`、第 16 条、必答问题、侧重、输出格式；`head`、`previous`、上一轮意见、brief、增量都在 `material` 段，增量追加在最后（`:400-423`）。`ROUND_MATERIAL_TITLE` 和 `SCOPE_SENTENCE` 也在 `material` 段，不在固定前缀。没有修改历史消息（每轮是独立的单条提示）。需要说明的是：`head` / `previous` 位于材料段靠前，缓存会从那里断开，这是 ADR 0280 已有的行为，不是本次新增；本次没有把新的每轮变化值放进固定前缀。

2. **不涉及。** 新增进请求的 `TOOL_USAGE_SENTENCE`、`SCOPE_SENTENCE`、`ROUND_MATERIAL_TITLE` 都是常量；`briefSha256` 只写入账本，不进入提示；`NEXT` 和 `shadowCommand` 的字段顺序固定，`shellQuote` 是确定的；没有时间字段、随机值或无序集合。唯一一次字节变化是固定前缀的新句子，对所有请求一致。遮盖方面，新句子不含会被遮盖的内容，`briefSha256` 在遮盖前计算，但只是账本摘要，不改变发送给模型的遮盖结果。

3. **部分有，关键反向用例缺失。** 已覆盖：所有模式固定部分包含 `TOOL_USAGE_SENTENCE`、两处增量说明使用 `SCOPE_SENTENCE`、首轮保留旧材料标题（负例）、`reusedBriefRecord` 的同提交/新摘要/shadow/旧记录无字段反例、`NEXT` 占位符清单。没有覆盖：`--pr-brief` 与非 code-review、无 `--previous`、`--shadow`、文件不存在；`main` 中 `REVIEW_BRIEF_REUSED` 真正拒绝且不花钱；`SHADOW_FULL_SUGGESTED` 优先使用 `prBrief`。因此不能证明实际拒绝路径会按预期失败。

4. **部分使用端不能接受。** `briefSha256`：`parseUsage` 接受未知字段、`reusedBriefRecord` 读取、`review-speed-report` / `delegate check` / 报表都忽略，能接受；但缺少 64 位十六进制校验，坏记录会静默绕过。`--pr-brief`：`parseArgs` 接受并校验，`finishRound` 产出占位符，`shadowCommand` 消费；但 `delegate.mjs` 的 `parseTask` 会以 `DELEGATE_UNKNOWN --pr-brief` 拒绝，`reviewArgv` / `validateTask` 也不包含它，委托链路会丢掉这个值，导致 `SHADOW_FULL_SUGGESTED` 回退到本轮材料。`ROUND_MATERIAL_TITLE`、`SCOPE_SENTENCE`、`TOOL_USAGE_SENTENCE` 只有 `buildPrompt` 和测试使用，正常。`NEXT` 占位符在流程卡和子代理定义中都写明了替换方式，测试也同步；但流程卡第 22 行对材料内容的描述仍与增量轮不符。
