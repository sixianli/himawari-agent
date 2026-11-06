## 读代码证实的发现（按严重度）

### 中：已有 `override` 记录被认可时不再核对“至少三轮”，也能盖过 `main-not-merged`

文件：`scripts/model-review/opencode-review.mjs:842-855`

问题：`--accept-unreviewed` **创建**例外时要求 `reviewRounds >= 3`（:840、:855），但**识别**一条已存在的 override 记录时只看“是 override、有 head、head 是祖先、之后只改了记录目录”，既不要求 `reviewRounds`，也不要求 `acceptUnreviewed`：

```js
const recorded =
  problems.length > 0 && records
    ? records
        .filter((record) => record.mode === "override" && record.head)
        .reverse()
        .find(
          (record) =>
            gitStatus(["merge-base", "--is-ancestor", record.head, head], repo).status === 0 &&
            changedOutside(repo, record.head, head, ledgerPath).length === 0,
        )
    : undefined;
let overridden = Boolean(recorded);
if (recorded) lines.push(`REVIEW_OVERRIDE quote=${recorded.quote} recorded=${recorded.head}`);
```

后果：只要账本里（被手工编辑、合并冲突解决、或从别处复制）出现一条 override 记录，即使账本只有 0 轮或 1 轮代码复核，`--assert-reviewed` 也会以 0 退出。另外，`problems` 里包含 `main-not-merged` / `main-ref-missing` 时同样可以写 override 并被认可，等于用例外绕开 Andy 2026-11-05 定的“合并前 main 必须已经在分支里”。

建议：识别 `recorded` 时也要求 `reviewRounds >= OVERRIDE_MIN_ROUNDS`，并只允许 override 覆盖 `unreviewed ...` 这一类问题；对 `main-ref-missing` / `main-not-merged` 明确是否允许 Andy 豁免（若允许，写进规则）。

### 中：账本字段没有换行校验，`REVIEW_OVERRIDE` / `REVIEW_RESULT` 可被伪造固定行

文件：`scripts/model-review/opencode-review.mjs:780-782`、`:842-854`、`:928-932`

问题：CLI 一侧对 `--accept-unreviewed`、`--andy-quote` 拒绝了 `\r\n`（:1608-1616），但账本里的 `quote`、`model`、`outcome` 等字段只校验“非空字符串”，打印时直接插值：

```js
// :854
if (recorded) lines.push(`REVIEW_OVERRIDE quote=${recorded.quote} recorded=${recorded.head}`);

// :781
return `REVIEW_RESULT round=${record.round} ${record.model} outcome=${record.outcome} ...`;

// :928-932
const fieldsValid =
  !MODES.includes(record?.mode) ||
  ["head", "model", "outcome"].every(
    (field) => typeof record[field] === "string" && record[field] !== "",
  );
```

证据：`parseUsage` 原样返回记录，`assertReviewed` / `reviewReport` 原样打印；`resultLine` 还直接打印 `wrapUp`、`wrapUpSkipped` 等账本值。合并冲突或手工编辑账本时，字段里带 `\n` 就能伪造出 `REVIEW_CURRENT` / `REVIEW_OVERRIDE` / `REVIEW_SPENT_TOTAL` 等固定行。作者说“含换行时拒绝，防止在输出里伪造固定行”，这个修复只覆盖了命令行参数这一路，没覆盖账本这一路。

建议：在 `parseUsage` 里拒绝或转义 `quote`、`model`、`outcome`、`wrapUp`、`wrapUpSkipped` 中的 `\r\n`；对 `head` 校验为十六进制提交号（不要直接把任意字符串传给 `merge-base`）；override 记录还要求 `quote` 是非空字符串。

### 低-中：原始事件/思考落在可预测、默认权限的临时目录，且不清理

文件：`scripts/model-review/opencode-review.mjs:1544-1547`、`:1768-1771`、`:1789-1793`

问题：`rawDir` 返回 `tmpdir()/himawari-review-raw/<仓库路径摘要>/<记录目录>/round-<序号>`，`mkdirSync`、`writeFileSync` 都没有指定权限，结束时只删 `workRoot`，不删这个目录：

```js
return join(tmpdir(), "himawari-review-raw", repoId, reviewKey(options), `round-${round}`);
...
mkdirSync(roundRawDir, { recursive: true });
...
writeFileSync(join(roundRawDir, `${name}.jsonl`), review.stdout);
...
writeFileSync(join(roundRawDir, `${name}.thinking.md`), `${summary.thinking}\n`);
```

后果：在 Linux 上目录通常是 0755、文件 0644，多用户机器上其他用户能读到模型的完整工具输出和思考内容；每次重跑还会用 `.attempt-n` 继续累积，长期运行会占满 `/tmp`。云端一次性容器问题较小，Mac 本机多用户时是实际的泄露面。

建议：`mkdirSync(..., { mode: 0o700 })`、写入后 `chmod`，并给这个目录一个保留期限或清理逻辑；至少不要把完整工具输出放在全局可读的 `/tmp`。

### 低：`parseUsage` 对未知/缺失 `mode` 放行，但这些记录仍会被 `nextRound` / `spentOf` 计入

文件：`scripts/model-review/opencode-review.mjs:926-934`

```js
const fieldsValid =
  !MODES.includes(record?.mode) ||
  ["head", "model", "outcome"].every(...);
```

只要 `mode` 不是 `code-review` / `plan` / `plan-review`（包括拼写错误、缺失、任意字符串），就不要求 `head`/`model`/`outcome`。这与“复核记录必须有 head、model、outcome，否则 `USAGE_LEDGER_INVALID`”的说法不完全一致；而且 `nextRound` 只排除 `override`，这些记录仍会推高轮次号，`spentOf` 也照常算钱。

建议：只对明确的 `override` 豁免字段校验，其他 `mode` 必须在 `MODES` 里，或直接拒绝未知 mode。

### 低：文档与代码不一致（`--assert-reviewed` 的“只读”、短选项 `-a`、`--text`/`--binary`）

文件：`.agents/instructions/model-review.md:35`、`:36`、`:54-55`、`:82`

证据：

- 第 35 行写 `--assert-reviewed` “只读、不花钱”，但带 `--accept-unreviewed` 时 `:860-863` 会 `appendFileSync` 写账本；第 36 行才描述写账本，前后容易让人以为普通检查也永远只读。
- 第 55 行列举短参数连写时只说“藏着 `-o`、`-O`”，而代码 `:361-368` 现在也拒绝 `-a`；第 82 行才提到 `-a`。
- 第 54 行列举禁用参数时没有 `--text`、`--binary`，第 82 行才提到。

建议：把“只读”限定为不带 `--accept-unreviewed`；把 `-a`、`--text`、`--binary` 在禁用语列表里一次写全，避免读者按第 55 行理解漏掉。

### 低：`--report` 会把同一轮同一模型的失败重跑和成功都打印出来

文件：`scripts/model-review/opencode-review.mjs:904-907`

```js
return [
  `REVIEW_REPORT pr=${pr}`,
  ...reviews.map(resultLine),
  ...
```

`reviews` 是账本里全部 `code-review` 记录；同一轮同一模型先失败、再用 `--round` 重跑成功后，账本里有两行，报告里就会有两个 `REVIEW_RESULT` 行。规则说“每轮每个模型的 `REVIEW_RESULT`”，这里更像是“每条记录一行”。

建议：按 `(round, model)` 取最后一次 attempt，或明确文档说报告会列全部尝试。

### 低：`--main-ref` / `--questions-ref` 直接放在 git 选项位置

文件：`scripts/model-review/opencode-review.mjs:826-829`、`:1477-1482`

```js
gitStatus(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`], repo)
...
git(["rev-parse", "--verify", "--quiet", `${questionsRef}^{commit}`], repo)
```

这些参数来自线程而不是模型；但以 `-` 开头的值会被 git 当选项解析（例如 `--help`），不是严格的“提交号”输入。建议先做提交号/引用名校验，或在使用处加 `--` 边界（`git rev-parse` 的 `--verify` 之后仍需注意选项位置）。

## 推测 / 未核实

- **Mac 上环境白名单是否够用**：代码里保留了 `PATH`、`HOME`、`TMPDIR`、语言/时区、XDG 目录和证书/代理；opencode 的 auth 在 `$HOME/.local/share/opencode` 或 `XDG_DATA_HOME` 下，理论上够，但未在 Mac 上实际验证。**未核实。**
- **`HOME` 下的 `auth.json`**：`read` 配置只对 `*.env` 做名字拒绝，真正阻止读仓库外文件的是 `external_directory: deny`；自检没有专门探测 `$HOME/.local/share/opencode/auth.json`，只探测了 `workRoot` 外文件和 `/proc/self/environ`。按同一机制推测会被拒绝，但**未核实**。
- **`git show <blob>` 绕过 `-diff`**：作者已写明这个局限；我确认 `git log --raw` 不被禁止，`git show <对象编号>` 也不含 `agents/reviews`，所以理论上能读旧记录。**确认是已知局限，不是新发现。**
- **`.agents/./reviews` / `.agents//reviews` 之类的路径规范化绕过**：`checkGitArgs` 只做字符串 `includes("agents/reviews")`，这些写法不命中；git 是否接受这种 tree path、pathspec 是否能匹配，我没有实际运行验证。**推测，且属于“故意绕过”范畴，未核实。**
- **`npm ci` 生成的 `node_modules/.package-lock.json` 是否包含根 `""` 项**：若包含且没有 integrity，`installedIntegrityProblems` 会把 `"" no-integrity` 当问题，导致每次安装都报 `OPENCODE_INTEGRITY_MISMATCH`。本副本没有 `node_modules`，无法运行 npm 验证；作者的集成测试应能覆盖，**未核实**。
- **测试是否真的按作者说的“逐个撤掉修复就失败”**：我没有运行测试的权限，只能读代码推断；见下面第 3 条。
- **合并提交**：`changedOutside` 用两棵树的 `git diff`，不是只看合并提交的第一父；因此“复核后合并 main”会被准确标成 unreviewed，而“复核提交本身就是包含 main 的合并提交”能通过。逻辑上是对的，但**未实际跑过合并提交用例**。
- **#256 与本 PR 测试的冲突**：我确认 `startScriptedModel(reply, record = ...)`、时间线用例只记 `{wrapUp}` 是提交 `1b91bd38`（#256）引入的；本 PR 的 `6a3b29a2` 只加了新的 merge-gate/parseUsage/proxy 测试，没有改这条时间线用例。最终合并后二者不冲突；本 PR 新增测试也不依赖该 helper 保存完整请求体。**读 diff 证实。**

## 侧重检查

我按“错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销操作”先查了这些路径：

- **参数错误路径**：`parseArgs` 对 `--pr`、`--topic`、`--round`、`--approved-usd`、`--accept-unreviewed`、`--andy-quote` 都有校验；`--assert-reviewed`/`--report` 只接受各自参数，非法组合会被 `ARG_NOT_FOR_SUBCOMMAND` 拒绝。**结论：正常错误路径做得比较完整。**
- **不可信账本**：`parseUsage` 校验 cost/round/部分字段，但 `quote`、`model`、`outcome` 只做非空检查，`head` 直接传给 git；这是上面“账本输出注入 / override 识别”两个问题的根因。**结论：账本被当作可信输入，超出了“只防误操作”的边界时会有 gate 绕过。**
- **安全（环境）**：`runOpencode` 已从 `...process.env` 改为 `opencodeEnv(process.env)`，`OPENCODE_KEPT_ENV` 不含 `GITHUB_TOKEN`/`AWS_*`/`OPENCODE_API_KEY`；`selfCheck` 用 `REVIEW_PARENT_CANARY` 做探针，Linux 上加了 `/proc/self/environ` 读取探针。读代码与测试都支持这个修复。**结论：主路径已修好。**
- **安全（代理）**：`proxyCredentialProblems` 现在 `trim()` 后匹配，支持有无协议头，`u:p@host`、`token@host` 都会拒绝；`http://proxy/a@b` 不会误报。**结论：与作者说法一致。**
- **安全（git 替身）**：`checkGitArgs` 拒绝含 `agents/reviews` 的参数、`-a`、`--text`、`--binary`；`shortOptionProblem` 对短参数簇里的 `a` 也拒绝。**结论：代码与规则一致；已知的 `git show <blob>` 局限仍在。**
- **安全（副本隐藏）**：`prepareCopy` 先 `sparse-checkout set --no-cone "/*" "!/.agents/reviews/"`，再写 `.git/info/attributes` 的 `/.agents/reviews/** -diff`；测试确认副本里没有 `.agents/reviews`，`git diff` 只显示 `Binary files`。**结论：机制成立；但提交信息、文件名、对象编号仍可能泄露，属于已知局限。**
- **资源耗尽**：`npmCi` 用 `spawnSync` 且无 timeout，npm 卡住时整个脚本会一直等；`rawDir` 不清理、不限制大小；`keepEarlierAttempt` 的 `while` 理论上会随 `.attempt-n` 文件数线性增长。**结论：没有发现新的无限循环，但安装无超时和 raw 目录累积是实际的资源风险（低）。**
- **不可撤销操作**：`npmCi` 先 `rmSync(prefix, {recursive:true})` 再重装，复用安装不一致时也会先删缓存目录；下载失败会丢掉原本可用的缓存。它只是缓存，不是用户数据，**结论：影响有限，但“重装失败就失去旧安装”值得在规则里说明。**
- **`--assert-reviewed`/`--report` 的只读性**：不带 `--accept-unreviewed` 时确实只读；带时写工作区账本（见上面的文档不一致）。**结论：按参数区分，不能笼统说“只读”。**

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

读代码后的结论：**不会改写已发出的内容，结构上仍然是“固定前缀 + 末尾材料”。**

- `buildPrompt` 的固定部分在 `:198-208`，顺序是角色、工具、任务、FOCUS、RULE_16、必答问题、模型侧重、输出格式；`MODEL_LENSES` 是静态常量（`:178-191`），同一模型在同一版本下每轮字节一致。
- 会变的值都在 `material`（`:209-221`）：`head`、`base`、`previous`、`brief`，它们拼在 `---- 本次材料 ----` 之后，也就是整段提示词的最后。
- 每次运行是新的 opencode 会话；追问走 `--session` 并在末尾追加 `WRAP_UP_PROMPT`（`:726-738`），没有改写历史。
- 现有测试 `puts fixed instructions before the per-review material`（`test/tooling/opencode-review.test.mjs:184-209`）和新增的模型侧重测试（`:217-247`）都检查了“固定前缀不随 head/base/previous/brief 改变”“侧重在材料之前”“同一模型重复构造字节相同”。

注意：这个改动本身会让**升级脚本前后的首轮固定前缀**发生变化（新增了侧重段），但这是版本升级，不是同一会话内的改写；约束里也说明“复核每次运行都是新会话”。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

读代码后的结论：**模型请求路径没有新增依赖时间、随机数或无序集合的字段。**

- `buildPrompt` 的输入是静态文本、`--base` 读出的问题、commit hash 和 `recordText` 规范化后的 brief；`recordText`（`:1549-1551`）是纯字符串处理，确定性的。
- `usage.jsonl` 里的 `at: new Date().toISOString()`（`:1795`）只写账本，不进模型提示词；`assertReviewed` 写 override 时的 `at`（`:862`）也只进账本。
- `rawDir` 的 hash、`installedIntegrityProblems` 的遍历、`changedOutside` 的 diff 顺序都不进模型请求。
- 唯一的“随机”是自检里的 `marker`（`:1026`），只发给本机假服务器，不发给真实模型。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

读代码后的结论：**主要修复都有对应测试，反向用例在代码逻辑上确实会失败；但我没有运行测试，实际执行结果未核实。**

- 代理空白：`HTTP_PROXY: " http://u:p@proxy:3128"` 在去掉 `.trim()` 后不会命中（`[^/?#]*` 被 `/` 挡住，见 `:425-429`），测试会失败（测试 `:2431` 附近）。
- 账本末尾补换行：没有补换行时，`lines` 不会是 7 行，测试 `:1944-1969` 会失败。
- `nextRound` 排除 override：没有过滤时返回 2 而不是 1，测试同一处会失败。
- `git diff -z`：没有 `-z` 时非 ASCII 路径被引号包住，`changedOutside` 不会把它当成记录目录，测试 `:1944` 的 `problems` 不会是 `[]`，会失败。
- 原话换行：没有 `[\r\n]` 检查时 `parseArgs` 不会抛错，测试 `:307` 附近会失败。
- `parseUsage` 字段：没有 `fieldsValid` 时缺 `head`/空 `model` 的坏行不会抛 `USAGE_LEDGER_INVALID`，测试 `:2251` 附近会失败。
- 环境白名单：`opencodeEnv` 单测会失败；真实自检里的 `REVIEW_PARENT_CANARY` 探针在 `runOpencode` 退回 `...process.env` 时会把标记带进 `git log` 输出，`checkProbeRequests` 会报 `PROBE_READ_OUTSIDE`（测试 `:509` 附近）。
- 安装完整性：`installedIntegrityProblems` 的 tamper 用例和 `installOpencode` 的坏锁用例（`:705-790`）覆盖了不一致路径。
- `assertReviewed` / `reviewReport`：`:1858-2160` 一带覆盖了通过、未复核、重命名、非 ASCII、override 换行、报告不一致等路径。

**测试覆盖的缺口（读代码可见，未运行）：**
- 没有测“账本里已有 override 但代码复核少于三轮时会被接受”的反向用例（对应上面的中危）。
- 没有测账本 `quote`/`model`/`outcome` 带换行时 `REVIEW_RESULT` / `REVIEW_OVERRIDE` 的输出注入。
- 没有测 `main-not-merged` 时 override 是否会绕过 main 要求。
- 没有测 raw 临时目录的权限和清理。
- #256 的时间线用例最终版本只记录 `{wrapUp}`，与本 PR 新增测试不冲突；本 PR 的 `6a3b29a2` 确实没有改这条测试。
