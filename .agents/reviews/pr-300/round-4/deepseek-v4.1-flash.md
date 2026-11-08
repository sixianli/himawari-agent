## 结论先行

本 PR 的隔离、路径和账本校验整体比较扎实；强推、改代码、改旧账本、符号链接、常见路径技巧都被拦住。但我确认了 **一个正常使用会触发的错误结果**：同一轮里补跑成功后，`check` 仍会报 `DELEGATION_RESULT_INCOMPLETE` 并以 4 退出。另有几处文档与代码不一致、以及若干低风险和已知局限。合并 main 的增量没有改到 `delegate.mjs` / `opencode-review.mjs` / `model-review.md` / `AGENTS.md` / `package.json`，未发现相互影响。

---

## 读代码证实的问题（按严重度）

### 1.【中】同一轮补跑成功后仍被报为 incomplete
- 文件:行：`scripts/model-review/delegate.mjs:329-335`（配合 `scripts/model-review/opencode-review.mjs:1621-1638,2964`）
- 问题：`notOk` 只把“替补记录”算作覆盖，不把“同一模型在同一轮补跑成功”算作覆盖。补跑会向账本**追加**一条新的 ok 记录，而旧的 timeout/no-text 记录仍在 `added` 里，于是模型被列为 not-ok。
- 证据：
  ```js
  const covered = (model) =>
    added.some(
      (record) => record.substitute && record.substituteFor === model && record.outcome === "ok",
    );
  const notOk = added
    .filter((record) => record.outcome !== "ok" && !covered(record.model))
    .map((record) => record.model);
  ```
  补跑确实会追加新记录、只把旧文件改名：
  ```js
  export const KEPT_FILE_SUFFIXES = [".prompt.md", ".md", ".stderr.txt"];
  ...
  appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
  ```
  这正是任务说明要求的补跑方式（`delegate.mjs:133,147`：“outcome 是 timeout 或 no-text … 用 `--round <那一轮的序号> --models <模型>` 补跑一次”）。
- 后果：`check --apply` 会先合并、再打印 `DELEGATION_RESULT_INCOMPLETE … not-ok=<模型>` 并以 4 退出（`delegate.mjs:487-490`）。Mac 线程会误以为补跑失败；若它再发起一次 Mac 侧补跑，会撞上：
  ```js
  if (inRound.some((record) => record.model === model && record.outcome === "ok"))
    throw new Error(`ROUND_ALREADY_HAS_RESULT ${requested} ${model}`);
  ```
  因为该轮已经有 ok 记录，补跑被拒绝，流程卡住。
- 测试缺口：`test/tooling/review-delegate.test.mjs:678` 的补跑用例用的是 `round: 1, models: [name]`，旧失败记录在 `tip`（`earlier`），**不在 `added`**；而且只断言 `status: "ok"`，不断言 `notOk`。唯一断言 `notOk` 的用例（447-449）只有一条 timeout。因此这条逻辑改坏后现有用例不会失败。
- 建议：把 `notOk` 改成按模型判断“`added` 里是否有 ok 记录”，并保留替补覆盖，例如 `ok = r.outcome === "ok" && (r.model === model || (r.substitute && r.substituteFor === model))`；对同一模型去重。补一个用例：第一次 timeout、同一次 `check` 窗口内补跑 ok，两者都在 `added`，断言 `notOk` 为空、CLI 退出 0。

### 2.【低】`check:gitleaks` 在本仓库不存在，文档说的“提交前扫描”永远不执行
- 文件:行：`scripts/model-review/delegate.mjs:151`、`.agents/instructions/model-review.md:138,141`
- 问题：任务说明和文档都引用 `package.json` 的 `check:gitleaks`，但 `git show eb341:package.json` 的 `scripts` 里没有这个脚本。实际相关的是 `check:secrets`、`check:security-review`，而 gitleaks 在 CI 的 security 检查里跑。
- 证据：
  ```
  1. 如果 package.json 里有 check:gitleaks 这个脚本，先运行 npm run check:gitleaks；失败就停下报告，不提交。
  ```
  文档还说“云端线程跑的 … package.json（包括 `check:gitleaks`）来自被复核的分支”。
- 后果：这条缓解措施在本仓库是空操作；模型写出像密钥的文字后，仍然要等 CI 的 gitleaks 报错。条件句“如果有”本身不算假，但“包括 check:gitleaks”的说法与代码不符。
- 建议：改成实际存在的检查（或明确写“本仓库没有预提交 gitleaks，交给 CI”），删掉“包括 `check:gitleaks`”，或真的补一个脚本并加测试。

### 3.【低】`check` 的文件允许范围比文档宽；补跑删除的放行条件与文档不一致
- 文件:行：`scripts/model-review/delegate.mjs:29,317-325,253-266`、`.agents/instructions/model-review.md:136`
- 问题：代码允许预期轮次下**任何**以新记录模型短名开头的 `.md` / `.stderr.txt`，例如 `<model>.notes.md`、`<model>.attempt-99.prompt.md`；文档却说“只能是答案、提示词和报错文件”。另外文档说补跑时“旧的答案、提示词、报错文件改名成 `.attempt-N.*`，旧名字被删除…允许”，但 `renamedAway` 只放行 `.stderr.txt` 的删除。
- 证据：
  ```js
  export const ROUND_FILE_PATTERN = /^round-(\d+)\/[a-z0-9][a-z0-9.-]*\.(?:md|stderr\.txt)$/;
  ...
  const ofAddedModel = added.some((record) => file.startsWith(`${shortModel(record.model)}.`));
  if (!match || Number(match[1]) !== expectedRound || !ofAddedModel)
  ```
  ```js
  const renamedAway = (change) =>
    /^(.*)\.stderr\.txt$/.test(change.path) && ...
  ```
  正常补跑里 `<model>.md` / `<model>.prompt.md` 是先改名再重新写出，最终 diff 是 M（或没变化），不是 D，所以目前不会误拒；但文档的“删除也允许”与代码的“只对 `.stderr.txt` 放行”不一致。
- 后果：额外文件会被提交，可能被人误当成复核记录的一部分；不是代码执行漏洞，但和“只提交记录”的说法有出入。
- 建议：把允许的文件名收紧到 `<model>.md`、`<model>.prompt.md`、`<model>.stderr.txt` 及对应的 `.attempt-<n>.*`；或者按代码修正文档，明确只有 `.stderr.txt` 的删除会被放行。

### 4.【低】`wait` / `check` 的 git 子进程没有超时，90 分钟保证可能失效
- 文件:行：`scripts/model-review/delegate.mjs:169-173,379-382,346-377`
- 问题：`spawnSync` 没传 `timeout`；`git ls-remote`/`git fetch` 如果挂住（网络黑洞），`waitForBranch` 不会抛错，也不会在 90 分钟返回，文档的“90 分钟没变以 3 结束”不成立。`waitForBranch` 只在 `lsRemote` 连续抛错 3 次时退出。
- 证据：
  ```js
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  ```
  ```js
  function remoteHead(repo, branch) {
    const result = git(["ls-remote", "origin", `refs/heads/${branch}`], repo);
  ```
- 建议：给 `spawnSync` 加合理的 `timeout`（或给 ls-remote/fetch 加 `-c http.lowSpeedLimit` 等网络超时）；超时按一次失败处理或直接以明确错误码退出，并在文档里补充“git 失败以 2 结束”。

### 5.【低】控制字符过滤只挡 ASCII C0/DEL，bidi 等格式字符可进终端输出
- 文件:行：`scripts/model-review/opencode-review.mjs:1464-1469`、`scripts/model-review/delegate.mjs:281,485`
- 问题：`hasControlCharacter` 只判断 `code < 32 || code === 127`；U+202E 等 bidi/格式字符不在内。`check` 用 `resultLine` 原样打印 `outcome`、`wrapUp`、`base`、`previous`、provider 键等，拒绝原因也会原样打印这些字段（`model` 已被限制在 `REVIEW_MODELS`，但其他字符串没有限制）。
- 证据：
  ```js
  return code < 32 || code === 127;
  ```
- 后果：恶意/出错的云端线程可以用 bidi 字符在 Mac 终端里重排显示，造成误读。不是代码执行，属显示欺骗。
- 建议：至少过滤 Unicode `Cc`/`Cf`，或输出统一用 `JSON.stringify` / `printable`；文档里注明“控制字符”具体指哪些。

### 6.【低】“只追加”只校验前缀，重复追加旧账本也会被当成新记录
- 文件:行：`scripts/model-review/delegate.mjs:267-280`
- 问题：`after.startsWith(before)` + `records.slice(earlier.length)` 只保证旧内容在前，不保证追加部分是新记录。把 `before` 整段再追加一次，就能让旧记录进入 `added`。
- 证据：
  ```js
  if (!after.startsWith(before)) return rejected("DELEGATION_LEDGER_REWRITTEN");
  ...
  const added = records.slice(earlier.length);
  ```
  对同一轮的旧失败记录（`task.round` 指定时），重复行会再次触发第 1 条的 `notOk` 误报；对全 ok 的旧行则会重复计入 `spent` 和 `REVIEW_RESULT`。
- 建议：除前缀外，要求追加部分不包含 `before` 中已有的完整行（记录有 `at` 时间戳，字节级去重可行），或按 `(round, model, attempt)` 拒绝重复。

### 7.【低/已知局限】预算校验依赖云端自律；`check` 的配置来源是 Mac 工作树
- 文件:行：`scripts/model-review/delegate.mjs:286`、`scripts/model-review/gateway.mjs:19-21,164-168`
- 问题一：`check` 的允许服务方默认从 Mac **当前工作树**的 `scripts/model-review/gateway.json` 读，而不是 `task.tip` 的版本。Mac 在等待期间切到别的分支或改了工作树，校验结果可能漂移；`--apply` 要求 HEAD 等于 tip，会挡住合并，但不带 `--apply` 的 `check` 仍可能给出不同结论。
- 问题二：任务说明里的 `--approved-usd` 只是文本，云端可以自行加/改；`check` 按账本算 `spent`，无法核对 Mac 到底批了多少。云端也可以先删本地账本、跑很多轮再恢复/重写后推送，`check` 只看最终账本。文档“账本记录本身仍被信任（防误操作，不防有意）”承认了这一点，但与“花钱上限不能削弱”有张力。
- 证据：
  ```js
  task.providers ?? readGatewayConfig(undefined, REVIEW_MODELS).providers.map((item) => item.id);
  ```
  ```js
  export const GATEWAY_CONFIG_PATH = join(GATEWAY_DIR, "gateway.json");
  ```
- 建议：从 `task.tip` 读 `gateway.json`（`git show tip:scripts/model-review/gateway.json`），或要求工作树在 tip；文档里把“账本被信任”的边界写得更明确。

---

## 推测 / 未核实

- 我没有运行测试（只允许 git/read/grep/glob），所以作者说的“三个测试文件共 210 条通过”“九处关键逻辑逐个改坏，对应用例都失败”“`npm run check` 通过”都未核实。
- 作者说“含 13 条新的 delegate 测试”，但 `test/tooling/review-delegate.test.mjs` 里有 **27** 个 `it(`（按源码 grep 计数）。数字与文件不符，可能是早期版本的说法。
- `showFile` 对目录路径会返回 tree listing（我用 `git show eb341:scripts/model-review` 证实 `git show <commit>:<目录>` 输出列表），所以理论上把 `<model>.md` 做成目录会让“文件存在”通过；但目录里的内容会作为额外路径被 `ROUND_FILE_PATTERN` 拒绝，我没有找到可实际利用的完整绕过。
- 恶意云端可以伪造记录、答案和提示词哈希；这是文档承认的“账本被信任，不防有意”，不是本 PR 新引入的漏洞。`check` 能证明一致性，不能证明模型真的跑过。
- 合并核对：`git show --no-patch --format='%H %P' eb341` 显示父提交是 `ad0f950`（PR）和 `ab4421`（main）；`git diff eb341^1..eb341 -- scripts/model-review test/tooling .agents/instructions AGENTS.md package.json` 只有新增的 `docs/adr/0182` 和 `test/tooling/sandbox-memory-manifest.test.mjs`，**没有**改到 `delegate.mjs`、`opencode-review.mjs`、`model-review.md`、`AGENTS.md`、`package.json`。`ci/policy.json` 的 tooling 项目仍包含 `test/tooling/**/*.test.mjs`，新测试会被 CI 的 policy/tooling 跑。未发现合并交互问题。

---

## 侧重检查

- **强推**：`merge-base --is-ancestor` 只在 status 1 时算 `DELEGATION_REWRITTEN`，其他非 0 当 git 错误（`delegate.mjs:233-238`）；tip 仍是祖先的 force-push 被允许，但它改不了 tip 之前的内容，未找到借此改代码的路径。
- **改代码 / 改旧账本**：每个提交用 `git log --name-only` 检查、最终差异用 `git diff --raw --no-renames` 检查；改名、删除、符号链接、非 `100644` 都有拦截；`usage.jsonl` 用前缀 + `parseUsage` + 逐字段核对。未找到改写旧账本仍能通过的方法（重复追加除外，见第 6 条）。
- **伪造记录**：能伪造（含答案/提示词哈希），文档已承认“账本被信任”，不是新漏洞。
- **符号链接 / 路径技巧**：新增/修改要求 `100644`；删除只放行 `.stderr.txt` 的补跑改名；`ROUND_FILE_PATTERN` 不允许子目录、反斜杠、`..`、换行；`roundFiles` 会拒绝所有未预期的路径。未找到能写出记录目录外代码的路径。
- **prompt 注入**：`branch`/`tip`/`head`/`base`/`previous`/`models`/`providers`/`topic`/`replyTo`/`approvedUsd` 都有固定格式校验，`brief` 必须精确等于计算出的路径；插入任务说明的字段都无法带空格、换行或 shell 元字符；git 子进程用数组参数、无 shell。未找到注入额外指令的入口。
- **`--require-gateway` 绕过**：`--gateway direct` / 无 gateway 在 `parseArgs` 报 `GATEWAY_REQUIRED not-magpie`（2540-2541）；main 在 `readGatewayConfig`、`resolveCommits`、读 brief、`proxyCredentialProblems`、`readUsage`、`opencodeBinary`/`installGateway` 之前检查 `not-cloud`/`no-proxy`（2788-2790）；`--report`/`--assert-reviewed` 带它报 `ARG_NOT_FOR_SUBCOMMAND`（2523-2527）；`--self-check-only` 跳过代理检查（2425）。设置 `HIMAWARI_REVIEW_GATEWAY=magpie` + 任意代理变量可以满足它，但这是选网关的环境信号，不是代码绕过。
- **`wait`/`check` 的 git 失败**：fetch/rev-parse/ls-tree/show/log/diff 失败会抛 `DELEGATE_GIT_FAILED`（退出 2），不会误判为 rewritten；`ls-remote` 连续 3 次失败才抛；但都没有超时，见第 4 条。
- **不可撤销操作**：`--apply` 是 `merge --ff-only`，要求本地 HEAD 等于交出点；pending/rejected 不合并；不删除远端；普通 push。未发现新的不可逆操作。
- **文档与代码**：发现第 1、2、3 条不一致；第 1 条同时是行为错误。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。`buildPrompt` 未改，仍由固定说明 + 从 `--base`/`--head` 读出的 checklist 问题 + 最后的 material 组成（`opencode-review.mjs:220-231,277-306,2317-2324`）。本 PR 对 `.agents/instructions/model-review.md` 的改动在 checklist 之后（新 `#delegate` 节和“怎么跑”里的句子），checklist 文本未变，`reviewQuestions` 的提取结果逐字节相同。`--require-gateway` 只改了 `main` 的前置检查，没有改 prompt。每轮变化的 `head`/`base`/`previous`/`brief` 仍在 material 末尾；追问只在对话末尾追加。`delegationPrompt` 是一次性任务说明，不含时间，同样参数输出逐字节相同。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会（就本改动而言）。`delegationPrompt` 没有 `Date`、随机数或无序集合；`providers`/`models` 按命令行顺序 `join`；未改遮盖逻辑。账本里的 `at` 时间戳会变，但只进账本/报告，不进模型请求。`usage.jsonl` 的 `at` 也是第 6 条建议做重复检测的依据，不影响请求前缀。

**3. 有没有自动检查；反向用例真的会失败吗？**
有：`test/tooling/review-delegate.test.mjs` 覆盖 pending/applied/rejected/force-push/merge/code-touch/ledger rewrite/symlink/deletion/control chars/providers/round/prompt hash/wait 参数/连续失败；CI 的 tooling 项目会跑（`ci/policy.json` 的 include 含 `test/tooling/**/*.test.mjs`）。**但第 1 条没有反向用例**：`lets a re-run...` 用例把旧失败记录放在 `tip`（`round:1, models:[name]`），同一 `added` 里没有“先失败后补跑成功”，且只断言 `status:"ok"`，不断言 `notOk`；唯一断言 `notOk` 的用例只有单条 timeout。把 `notOk` 的补跑覆盖逻辑改坏，现有用例不会失败。另外“13 条新 delegate 测试”与实际 27 个 `it(` 不符。

**4. 每个产生的值，使用它的地方都能接受吗？**
- `--require-gateway`：`reviewArgv` 产生（`delegate.mjs:103-124`）→ `parseArgs` 消费（`opencode-review.mjs:2462,2540-2541`）→ `gatewayRequiredProblem` 消费（2424-2428,2788-2789）；`REPORT_OPTIONS`/`ASSERT_OPTIONS` 不含它，子命令报 `ARG_NOT_FOR_SUBCOMMAND`。两端一致。
- `promptSha256`：`opencode-review.mjs:2940` 产生，`delegate.mjs:311-312` 和 git blob 的 prompt 文件比对；一致。
- `round/mode/head/base/previous/model/gateway/providers/outcome/cost`：`opencode-review` 产生；`parseUsage` 先校验类型/必填/`gateway` 枚举/`providers` 形状/`cost`，`delegate.mjs:288-316` 再逐项核对；能接上。
- `--providers`/`--models`/`--round`/`--approved-usd`：delegate 和 opencode-review 各自校验；providers 两边都对照 `gateway.json`；一致。
- `brief`：delegate 计算并强制等于 `briefs/<head12>-<mode>.md`（`delegate.mjs:41-43,97-100`），opencode-review 读同一路径；一致。
- `none`/`unknown`：delegate 允许（303-305），`parseUsage` 的 `providersValid` 接受任意键，`gateway.mjs:69` 也将两者列为保留 id；一致。
- **需要注意**：`check` 的默认服务方列表来自 Mac 当前工作树的 `gateway.json`（`delegate.mjs:286`、`gateway.mjs:19-21`），不是 `task.tip` 的版本；`--approved-usd` 没有可验证的批准凭据。前者建议从 tip 读，后者是文档已承认的“账本被信任”局限。
