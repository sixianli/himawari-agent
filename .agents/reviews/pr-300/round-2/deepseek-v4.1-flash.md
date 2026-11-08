## 读代码证实的问题（按严重度）

### 1. 中：`check` 拒绝 `providers` 里的合法哨兵 `unknown`；不传 `--providers` 时又完全不校验服务方

- 文件：`scripts/model-review/delegate.mjs:266-268`；生产者 `scripts/model-review/gateway.mjs:448`、`scripts/model-review/opencode-review.mjs:2585-2596`；文档 `.agents/instructions/model-review.md:136`
- 问题：复核脚本会把 Magpie 用量里不认识的服务方记成保留值 `"unknown"`（`RESERVED_PROVIDER_IDS` 里有 `none` 和 `unknown`，见 `gateway.mjs:69`），并原样写进 `record.providers`。`check` 只豁免 `"none"`，因此在通常带 `--providers` 的委托里，这种真实产生的错误路径记录会被判成 `DELEGATION_RECORD_MISMATCH provider=unknown`。反过来，`task.providers` 未传时循环整个跳过，`record.providers` 里任意键都被接受，与文档“服务方在允许范围内”不符。
- 证据：
  ```js
  for (const provider of Object.keys(record.providers ?? {}))
    if (task.providers && !task.providers.includes(provider) && provider !== "none")
      problems.push(`provider=${provider}`);
  ```
  ```js
  const provider = known.has(line.provider) ? line.provider : line.provider ? "unknown" : "none";
  ```
- 建议：像 `none` 一样豁免 `unknown`，并把它算作“结果不完整/费用未知”而不是记录不匹配；`task.providers` 未传时用 `readGatewayConfig(...).providers` 的 id 做白名单校验。补一条记录 `providers: { unknown: {...} }` 的正向用例和一条任意假服务方的反向用例。

### 2. 中：`check` 算“预期轮次”只看看账本，生产者还会看磁盘上的 `round-N/` 目录

- 文件：`scripts/model-review/delegate.mjs:251`；生产者 `scripts/model-review/opencode-review.mjs:2826-2828`、`1562-1575`
- 问题：`check` 用 `nextRound(earlier)`，只看交出点账本；云端真正跑复核时 `roundForRun` 传的是 `rounds: roundsOnDisk(options.out)`，即账本轮次和磁盘上已有的 `round-N` 目录取最大。如果交出点的树里有一个没有对应账本记录的 `round-N/`（例如上次复核写了提示词/答案后在追加账本前被中断、或只提交了部分文件），云端会合法地写出 `round-(N+1)`，而 `check` 期待 `N`，以 `round=... expected=...` 拒绝。
- 证据：
  ```js
  const expectedRound = task.round ?? nextRound(earlier);
  ```
  ```js
  records,
  rounds: roundsOnDisk(options.out),
  ```
  ```js
  export function nextRound(records, rounds = []) {
    const recorded = records.filter(...).map((record) => record.round ?? 1);
    return Math.max(0, ...recorded, ...rounds) + 1;
  }
  ```
- 建议：`check` 也从交出点（不是远端）的树里读 `round-N` 目录，和账本轮次一起算预期值；或让两侧统一只认账本。补一条“交出点已有无账本的 round 目录”的正向用例。

### 3. 中低：从远端账本进入 Mac 终端/日志的字段没有转义，能注入换行和控制字符

- 文件：`scripts/model-review/delegate.mjs:256-268`；`scripts/model-review/opencode-review.mjs:1458-1462`、`1544`、`1028-1029`；文档 `.agents/instructions/model-review.md:92`
- 问题：`parseUsage` 的 `hasLineBreak` 只递归检查对象的值，不检查键；`check` 直接把 `record.base`、`record.previous`、`record.model`、`record.gateway` 和 `record.providers` 的键拼进 `DELEGATION_RECORD_MISMATCH ...`。因此远端可以写一个键为 `"\nDELEGATION_RESULT_OK ..."` 的 provider，或写含 ESC 的 `base`/`model`/`outcome`，在 Mac 的 `check` 输出里伪造整行或执行终端转义。文档第 92 行明确说账本“任何文本字段（包括列表里的）都不能带换行”，但键没有被检查。
- 证据：
  ```js
  function hasLineBreak(value) {
    if (typeof value === "string") return /[\r\n]/.test(value);
    if (value && typeof value === "object") return Object.values(value).some(hasLineBreak);
    return false;
  }
  ```
  ```js
  const singleLine = !hasLineBreak(record ?? {});
  ```
  ```js
  problems.push(`base=${record.base ?? null}`);
  ...
  problems.push(`provider=${provider}`);
  ```
  `resultLine` 同样原样拼接 `record.outcome`、`record.wrapUp`、`record.steps` 等字段。
- 建议：输出远端账本字段时统一用 `printable`/`JSON.stringify`；`parseUsage` 至少检查对象键，最好对新增记录的全部文本字段拒绝控制字符。补一条 provider 键含换行、一条字段含 ESC 的反向用例。

### 4. 中低：`showFile` 把任何 `git show` 失败都当成“文件不存在”，读出账本失败会被当成空账本

- 文件：`scripts/model-review/delegate.mjs:190-192`、`237-240`、`269-275`
- 问题：`showFile` 对非 0 退出码一律返回 `null`，调用方无法区分“提交里没有这个路径”和“git 自身失败”。`before = showFile(task.tip, ledgerPath) ?? ""` 在 git 失败时得到空串，`after.startsWith("")` 恒真，`added = records.slice(0)`，于是“只在末尾追加”的检查被跳过。读取远端账本、答案、提示词时的 git 失败也被报成 `DELEGATION_NO_LEDGER`/`missing=...`，而不是 `DELEGATE_GIT_FAILED`。第 2 轮只把 `merge-base` 的这种情况改对了，这里仍然是旧行为。
- 证据：
  ```js
  function showFile(repo, commit, path) {
    const result = git(["show", `${commit}:${path}`], repo, { allowFail: true });
    return result.status === 0 ? result.stdout : null;
  }
  ```
  ```js
  const before = showFile(repo, task.tip, ledgerPath) ?? "";
  ```
  ```js
  if (!after.startsWith(before)) return rejected("DELEGATION_LEDGER_REWRITTEN");
  ```
- 建议：先用 `git cat-file -e <commit>:<path>` 区分“路径不存在”（退出 1）与其它 git 错误；其它错误抛 `DELEGATE_GIT_FAILED`。`before` 不应默认为空串。补一条“git show 失败”的反向用例。

### 5. 低：合法补跑在“上次失败留下了 `.stderr.txt`”时会被 `check` 当作删文件拒绝

- 文件：`scripts/model-review/opencode-review.mjs:1624-1637`、`2972-2974`；`scripts/model-review/delegate.mjs:235`
- 问题：补跑时 `keepEarlierAttempt` 会把旧的 `<模型>.stderr.txt` 改名成 `<模型>.attempt-N.stderr.txt`；补跑成功（`outcome: ok`）时不会再写 `<模型>.stderr.txt`。如果补跑是从一个已经包含上次失败记录的 tip 开始的（例如 Mac 用 `delegate.mjs prompt --round N` 发起的补跑），相对交出点的最终 diff 里 `<模型>.stderr.txt` 是删除，`check` 对 `status === "D"` 一律拒绝 `DELEGATION_IRREGULAR_FILE`。云线程在自己提交前完成的补跑不受影响（相对 tip 都是新增），所以这是条件性问题。
- 证据：
  ```js
  const irregular = changes.find((change) => change.status === "D" || change.newMode !== "100644");
  ```
  ```js
  if (record.outcome !== "ok" && review.stderr.trim()) {
    writeFileSync(join(roundDir, `${name}.stderr.txt`), recordText(review.stderr));
  }
  ```
- 建议：只为“同一模型、同一轮、同时新增了对应 `.attempt-N.stderr.txt`”的 `.stderr.txt` 删除开一个窄例外；或让生产者在成功时也写一个空/新的 stderr 文件。补一条“先失败留下 stderr，再补跑成功”的 `check` 用例。

### 6. 低：`wait --interval-seconds` 大于总等待时间时立即报超时，不会等满 `--minutes`

- 文件：`scripts/model-review/delegate.mjs:318-331`
- 问题：`polls = ceil(minutes*60/interval)+1`。例如 `--minutes 90 --interval-seconds 10000`，`ceil(5400/10000)+1 = 1`，只查一次、不 sleep，直接返回 `moved:false`，打印 `DELEGATION_WAIT_TIMEOUT` 并以 3 结束，实际只过了 0 分钟。这与“90 分钟没变才超时”的语义不符；测试只覆盖了 120 秒间隔。
- 证据：
  ```js
  const polls = Math.ceil((minutes * 60) / intervalSeconds) + 1;
  ...
    if (attempt < polls - 1) await sleep(intervalSeconds * 1000);
  ...
  return { moved: false, sha: tip };
  ```
- 建议：拒绝 `intervalSeconds > minutes*60`，或保证至少等到截止时间再判定超时。

### 7. 低：`--apply` 合并的是可变的远端跟踪引用，不是刚校验过的提交号

- 文件：`scripts/model-review/delegate.mjs:295-299`
- 问题：`checkResult` 校验的是 `remote` 这个 SHA，但 `applyResult` 合并 `refs/remotes/origin/<branch>`。如果 check 和 apply 之间有别的进程（例如手工 `git fetch`）更新了这个引用，apply 会合并一个没有经过本次校验的提交。
- 证据：
  ```js
  git(["merge", "--ff-only", `refs/remotes/origin/${task.branch}`], repo);
  ```
- 建议：把 `checkResult` 的 `result.remote` 传给 `applyResult`，合并这个 SHA，并在合并前再确认本地 `HEAD === task.tip` 且该 SHA 仍是远端分支头。

### 8. 低：`costUnknown` / `inFlight` 记录被当作 `OK`，`spent` 可能偏低

- 文件：`scripts/model-review/delegate.mjs:290-292`；对照 `scripts/model-review/opencode-review.mjs:1001-1009`、`2578`、`2590-2595`
- 问题：`check` 的 `spent` 只是把 `record.cost` 相加，`notOk` 只看 `outcome !== "ok"`。复核脚本自己的 `spentOf` 对 `costUnknown || inFlight` 会加预留（`WRAP_UP_RESERVE_USD`/`COST_LIMIT_PER_MODEL_USD`）。当 Magpie 用量读不出来时，记录可以有 `outcome: "ok"` 且 `costUnknown: true`，`check` 会打印 `DELEGATION_RESULT_OK` 和一个偏低的 `spent`，这与“账本不能削弱/花费以账本为准”的约束不一致。
- 证据：
  ```js
  const spent = added.reduce((total, record) => total + record.cost, 0);
  const notOk = added.filter((record) => record.outcome !== "ok").map((record) => record.model);
  ```
  ```js
  record.costUnknown || record.inFlight
    ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
    : record.cost,
  ```
- 建议：把 `costUnknown`/`inFlight` 纳入 `notOk` 或单独打印警告；`spent` 用与 `spentOf` 相同的口径。补一条 `costUnknown: true, outcome: "ok"` 的用例。

### 9. 低：合法的 substitute 记录永远无法满足 `check` 的 `absent=` 条件

- 文件：`scripts/model-review/delegate.mjs:277-279`；生产者 `scripts/model-review/opencode-review.mjs:856-864`、`3001-3005`；文档 `.agents/instructions/model-review.md:136`
- 问题：补跑单模型且带 `--previous` 时，复核脚本遇到可重试的 `api-error` 会用另一个模型替跑，并写 `substitute: true, substituteFor: <原模型>`。`check` 要求每个预期模型都有一条 **非 substitute** 记录，所以这种脚本自己产生的合法结果必然报 `absent=<原模型>`。文档只说“预期的模型每个都有记录”，没写“必须是替补”。
- 证据：
  ```js
  for (const model of expectedModels)
    if (!added.some((record) => record.model === model && !record.substitute))
      problems.push(`absent=${model}`);
  ```
  ```js
  return { model: replacement, for: models[0] };
  ```
- 建议：明确接受 `substituteFor === model` 的替补记录（并把它标成不完整/需 Mac 判断），或在文档和 CLI 里明确禁止补跑时替跑。补一条 substitute 记录的正向/反向用例。

---

## 推测或未核实

- 「三个测试文件 210 条、`npm run check` 通过、九处改坏都失败」未核实：本轮只用了 read/grep/glob 和 git diff/log/show/status，没有运行测试。测试代码本身看起来会真实断言错误码（例如 `review-delegate.test.mjs:224-234` 的强推、`330-456` 的符号链接/改代码/合并提交/轮次/哈希、`564-617` 的 git 失败），但上面第 1–9 条对应的场景没有测试。
- 第 3 条中“终端会执行 ESC/OSC”属于推测；代码证实的只是字段未经转义直接输出。
- 第 4 条中“git show 在正常仓库里何时失败”属于推测；代码证实的只是任何非 0 都被折叠成 `null`。
- 第 5 条依赖“交出点已经包含上次失败的 `.stderr.txt`”这一工作流；代码路径本身已证实。云线程在自己提交前补跑时不受影响。
- 第 2 条依赖交出点存在“有目录、无账本记录”的轮次；代码路径已证实，实际发生频率未核实。

---

## 侧重检查

- **错误路径**：`merge-base --is-ancestor` 已区分退出码 1（强推）与其它错误（`delegate.mjs:215-220`），测试覆盖；`git fetch` 失败、`rev-list`/`log`/`diff` 失败都会以 `DELEGATE_GIT_FAILED` 停下（`delegate.mjs:167-172`、`201-236`），测试覆盖。`showFile` 是例外，见第 4 条。`wait` 的 `remoteHead` 已改为失败即抛错，`waitForBranch` 连续 3 次才抛（`delegate.mjs:302-338`），测试覆盖；但分支被删除时 `git ls-remote` 退出 0、输出为空，`wait` 会静默等到超时，而不是报错（低，未单列）。`--minutes`/`--interval-seconds` 的有限性检查有，但“间隔大于总时长”仍会立即超时，见第 6 条。
- **不可信输入**：任务字段的注入面已核对：`branch`、`tip`、`head`、`base`、`previous`、`pr`、`topic`、`models`、`providers`、`approvedUsd`、`replyTo`、`brief` 都有格式校验，`brief` 还要求精确等于派生路径（`delegate.mjs:43-99`），`reviewArgv` 的每个值都来自这些校验（`101-122`），任务文本中的 `git fetch/checkout` 命令不会出现空格、分号、反引号或换行，因此没有找到向任务说明注入额外指令的路径。远端账本的字段/键转义、`unknown` 服务方、`substitute` 记录见第 1–3 条。
- **安全**：`--require-gateway` 的 `not-magpie` 在 `parseArgs`（`opencode-review.mjs:2540-2541`），`not-cloud`/`no-proxy` 在 `main` 读材料、读 gateway 配置、安装之前（`2788-2790`）；自检模式按代码跳过代理检查（`2424-2428`）；子命令因 `ASSERT_OPTIONS`/`REPORT_OPTIONS` 不含该参数而报 `ARG_NOT_FOR_SUBCOMMAND`，测试覆盖（`review-gateway.test.mjs:204-248`）。未发现常规绕过。强推、改代码、改旧账本、符号链接、路径前缀都有检查；恶意云端仍可**伪造账本与答案/提示词文件**，`check` 没有任何到 Magpie 实际用量的密码学锚点，这一点文档已承认（`.agents/instructions/model-review.md:141` 附近“防误操作，不防有意”），不应算实现缺陷，但“不能直接信”只能做到结构核对。云端强制推送会破坏远端分支，`check` 只能发现、不能恢复，Mac 本地仍有交出点，可重新推送。
- **资源耗尽**：`wait` 的分钟数上限 600、轮询次数有界；`check` 的 git 输出有 256MB `maxBuffer`；但 `showFile` 会为每条答案/提示词把整个 blob 读入内存，恶意的大文件/多条记录可造成较大内存占用（低）。`git fetch` 本身就受分支大小影响。
- **不可撤销操作**：`--apply` 只做本地 `--ff-only`，并要求本地 `HEAD === tip`，不会覆盖本地提交；云端任务说明要求普通推送、禁止强推，但这是提示词约束，云端不照做时只能靠 `check` 事后发现。`check` 通过时 `--apply` 会在输出 `DELEGATION_RESULT_INCOMPLETE` 之前执行合并（`delegate.mjs:439-446`），即“结果不完整也快进”，这是文档明确的设计（让 Mac 拿到记录后判断），但调用方必须看退出码 4，不能只看打印。
- **规则/文档一致性**：`model-review.md` 新增节、`AGENTS.md`、ADR 0178 后续与代码大体一致；发现的不一致是：文档“服务方在允许范围内”在未传 `--providers` 时没有执行；文档“预期的模型每个都有记录”未说明必须非 substitute；文档“任何文本字段（包括列表里的）不能带换行”没有覆盖对象键。第 1 轮明确不动的 D6（gitleaks 脚本来自被复核分支）和 G6（`none` 豁免）与代码/文档一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`buildPrompt`（`opencode-review.mjs:277-306`）不在本次改动里；本次对 `opencode-review.mjs` 只加了 `gatewayRequiredProblem`、`--require-gateway` 的解析和 `main` 里的提前检查，没有改系统提示、工具定义、历史、遮盖或材料顺序。复核请求仍是“固定说明 + 必答问题等固定前缀 + 最后的本轮材料”。`delegate.mjs:124-165` 生成的是交给**新开的**云端会话的任务文本，不是往已有模型对话里追加；按文档用 `start_session` 每次新开会话，因此不会改变任何已发出的请求开头。唯一的条件是“不复用云端会话”；若复用，任务文本中的 `tip/head/branch` 会处在文本中部，但这与当前文档的用法不符。

2. **同一段文字在不同请求里会不会变成不同字节？**
   复核提示词不会：`delegationPrompt` 没有时间字段，`reviewArgv` 的参数顺序固定，`RETRYABLE_OUTCOMES` 是固定数组，`brief` 路径由 `head.slice(0,12)` 和固定 `mode` 派生；相同参数输出逐字节相同（测试 `review-delegate.test.mjs:119-130` 断言了两次输出相同、没有 ISO 时间）。`opencode-review.mjs` 侧 `buildPrompt` 的输入仍是 `mode/model/questions/head/base/previous/brief`，不依赖轮次或 `models` 列表，因此补跑同一模型的提示词字节也不变（这也正是 `promptSha256` 在校验补跑时仍能对上的原因）。账本里的 `at` 时间字段不是发给模型的内容。没有发现依赖前后文的遮盖或无序集合进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有测试：`review-delegate.test.mjs` 覆盖强推、改代码、改旧账本、符号链接/删除/旧文件、合并提交、轮次、模型缺失、提示词哈希、`notOk` 退出码、`--apply` 本地移动、git 失败；`review-gateway.test.mjs:204-248` 覆盖 `--require-gateway` 的 `not-magpie`/`not-cloud`/`no-proxy`、子命令拒绝、以及 `main` 在读材料/安装前停下；`wait` 有移动、超时、非法间隔、瞬时/持续 git 失败用例。按读到的断言，这些反向用例在去掉对应逻辑后应会失败（例如 `330-456` 的符号链接和“改了又还原”用例）。
   但**本轮没有运行测试**，作者“210 条通过、npm run check 通过、九处改坏都失败”未核实。更重要的是，上面第 1–9 条对应的场景没有用例：`providers: {unknown: ...}`、交出点已有无账本 `round-N`、`showFile` 的 git 失败、补跑成功删旧 stderr、`interval > 总时长`、`costUnknown`、substitute 记录。因此“有检查”成立，但“这些反向路径都被覆盖”不成立。

4. **改动产生或修改的每个值，两端都能接受吗？**
   能对上的：模型短名（`validateTask` 与 `parseArgs` 的映射一致）、`brief` 路径（12 位 head 前缀 + 固定 mode，`validateTask` 要求精确相等）、轮次文件名（`.md`/`.prompt.md`/`.stderr.txt`/`.attempt-N.*` 都能被 `ROUND_FILE_PATTERN` 接受，`briefs/`、`verdicts.jsonl`、`judgments.md` 会被拒）、`promptSha256`（生产者和 `check` 都用 UTF-8 字符串 sha256）、新增的 `notOk` 字段（由 `checkResult` 产生、由 `main` 消费）、`--require-gateway`（`parseArgs` 接受、子命令拒绝）。
   对不上的：`providers` 的 `unknown` 哨兵（生产者会写、`check` 拒绝；第 1 条）；substitute 记录（生产者会写、`check` 的 `absent=` 不认；第 9 条）；预期轮次的算法（生产者看磁盘目录，`check` 只看账本；第 2 条）；补跑成功时旧 `.stderr.txt` 的删除（生产者会做、`check` 拒绝；第 5 条）；`costUnknown`/`inFlight`（生产者会写、`check` 不报不完整；第 8 条）。此外，文档“服务方在允许范围内”在未传 `--providers` 时并未执行，文档“任何文本字段（包括列表里的）不能带换行”没有检查对象键。
