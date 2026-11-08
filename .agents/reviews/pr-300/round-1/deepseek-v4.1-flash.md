## 侧重检查

我重点查了这些路径，结论如下：

- **不可信输入/注入**：`delegate.mjs` 的 `validateTask`/`reviewArgv` 对 `branch`、`tip`/`head`/`base`/`previous`（hex）、`topic`、`pr`、`mode`、`providers`、`models`、`replyTo` 都做了格式校验；生成的任务说明里这些值不会带换行或 shell 元字符，**没有发现可直接向任务说明注入额外指令的入口**。材料正文不进入任务说明，只以固定路径引用。
- **任务说明的间接注入**：任务说明让云端在被复核分支上读 `.agents/instructions/model-review.md`、跑分支里的 `npm run check:gitleaks` 和 `scripts/model-review/opencode-review.mjs`；这些文件都来自被复核分支（见下面第 6 条）。
- **错误路径**：`check` 的 `git fetch`/`rev-parse` 失败会退出 2；但 `wait` 会吞掉 `ls-remote` 失败；`merge-base` 失败被误报成 `DELEGATION_REWRITTEN`。
- **资源耗尽**：`wait --interval-seconds 0` 会无限轮询 `git ls-remote`。
- **不可撤销操作**：`--apply` 会快进合并；它只在 `check` 通过后执行，且 `applyResult` 复用同一次 `fetch` 的远端跟踪引用，没有二次拉取竞态；但 `check` 的校验范围有缺口（第 1、2 条）。
- **符号链接/路径技巧**：`--no-renames` 正确挡住了“把代码改名进记录目录”；但 `git diff --name-only` 不区分普通文件和符号链接，符号链接会通过存在性检查。
- **文档与代码一致性**：`--require-gateway` 的错误码/执行时机基本一致；`wait` 的“90 分钟”与实现不一致（实际约 88 分钟）；云端执行 gitleaks 的说明与“只读/不改代码”的总体约束有张力。

---

## 读代码证实的问题（按严重度）

### 高：`check` 只做目录前缀检查，且不校验文件类型，恶意云端可篡改记录目录内的既有文件或放符号链接

`scripts/model-review/delegate.mjs:190-195`

```js
const changed = git(["diff", "-z", "--no-renames", "--name-only", task.tip, remote], repo)
  .stdout.split("\0")
  .filter(Boolean);
const outside = changed.find((file) => !file.startsWith(`${REVIEWS_DIR}/${key}/`));
if (outside)
  return { status: "rejected", reason: `DELEGATION_OUTSIDE_RECORDS ${JSON.stringify(outside)}` };
```

`scripts/model-review/delegate.mjs:224-228`

```js
const round = record.round ?? 1;
const name = shortModel(record.model);
for (const file of [`${name}.md`, `${name}.prompt.md`])
  if (showFile(repo, remote, `${REVIEWS_DIR}/${key}/round-${round}/${file}`) === null)
    problems.push(`missing=round-${round}/${file}`);
```

问题：
1. 只要路径在 `.agents/reviews/<key>/` 下，**任何既有文件都可以被改写或删除**，包括 `verdicts.jsonl`、`judgments.md`、`briefs/*.md`、旧轮答案。任务说明第 2 步（`delegate.mjs:138`）甚至明确允许“新增或改动”记录目录下的文件；第 151 行“不要写 verdicts.jsonl 和 judgments.md”只是文字约束，`check` 不检查。
2. `git show` 对符号链接返回链接目标字符串而不是文件内容；因此把 `<model>.md` 做成指向 `~/.ssh/id_rsa` 或 `/etc/passwd` 的符号链接时，存在性检查照样通过。`--apply` 快进后符号链接会进入 Mac 工作区，Mac 线程后续读取答案文件就会跟随链接（读取仓库外文件；若后续写同名文件还可能写到链接目标）。
3. 与文档 `model-review.md:136` “交出点之后只改了这次的记录目录”一致，但和“云端推回来的东西不能直接信”（`model-review.md:141`）的目标不一致：`verdicts.jsonl`/`judgments.md` 正是合并前核对会读的内容。

建议：把允许变更的路径改成精确白名单（`<key>/usage.jsonl` 只允许追加；本次 `round-<预期轮次>/<预期模型>.md` 和 `.prompt.md`，必要时 `.stderr.txt`），其余既有文件一律拒绝；用 `git diff --raw`/`git ls-tree` 拒绝 `120000` 符号链接和非普通文件；在 `check` 里校验 `record.promptSha256` 与提交的 `.prompt.md` 一致。

---

### 中：`check` 不校验轮次、`outcome` 和应有的模型集合，失败的运行/没真正补跑也能显示 `DELEGATION_RESULT_OK`

`scripts/model-review/delegate.mjs:217-228`

```js
if (!REVIEW_MODELS.includes(record.model)) problems.push(`model=${record.model}`);
if (task.models && !record.substitute && !task.models.includes(shortModel(record.model)))
  problems.push(`model=${record.model}`);
...
const round = record.round ?? 1;
```

问题：
- 第一轮任务通常不传 `--models`（`task.models` 为 `undefined`），所以上面第二个 `if` 不执行；云端只写一个模型的记录（例如只有 DeepSeek）也能通过，Mac 会以为两个模型都跑过。
- `record.round` 只用来拼答案文件路径，**从不与 `task.round` 比较**；补跑任务可以追加一条 `round: 1` 的记录，复用交出点里已有的 `round-1/*.md`，`check` 仍通过。
- `outcome` 完全没检查；`outcome` 为 `api-error`、`timeout`、`no-text` 的记录也会打印 `DELEGATION_RESULT_OK`（`main` 只判断 `result.status === "ok"`，`delegate.mjs:323-326`）。
- 答案/提示词只检查“存在”，不检查是否为新文件；因此“补跑没真正跑、只追加记录”这种情况无法被发现。

建议：从交出点账本计算预期轮次和预期模型集合，要求新增记录恰好覆盖 `task.models ?? REVIEW_MODELS`（允许服务方故障导致的合法替补，但校验 `substituteFor`），并要求 `record.round === 预期轮次`、`record.outcome === "ok"`；对补跑要求本轮答案/提示词文件确实被修改（出现在 `changed` 中），或校验 `promptSha256`。

---

### 中：`--require-gateway` 只用“任意代理变量非空”判断环境，Mac 上有系统/公司代理时仍会在本机花钱

`scripts/model-review/opencode-review.mjs:2424-2426`

```js
export function gatewayRequiredProblem(options, env) {
  if (!options.requireGateway || options.selfCheckOnly) return null;
  return PROXY_ENV.some((name) => (env[name] ?? "").trim() !== "") ? null : "no-proxy";
}
```

`scripts/model-review/opencode-review.mjs:2787-2789`

```js
const missingProxy = gatewayRequiredProblem(options, process.env);
if (missingProxy) throw new Error(`GATEWAY_REQUIRED ${missingProxy}`);
const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
```

检查时机本身是对的：在 `resolveCommits`、读 `--brief`、`readGatewayConfig`、`installGateway` 之前（`opencode-review.mjs:2787` 早于 `:2795`、`:2797`、`:2838`），`parseArgs` 里的 `GATEWAY_REQUIRED not-magpie` 也在更早处。但“有代理”不等于“在 himawari-cloud 里”：Mac 上常见的 `HTTPS_PROXY`/`HTTP_PROXY`（公司代理、抓包工具）也会让检查通过，而 `model-review.md:83` 仍写着 Mac 上可以用 `opencode auth login` 留着的 OpenCode Go 凭据。这与约束“落在错的环境里不能花钱”不一致，`model-review.md:134` 说“落在 Default 会停下”也就过于绝对。

建议：`gatewayRequiredProblem` 同时要求 `HIMAWARI_REVIEW_GATEWAY === "magpie"`（云端环境已经设置）或专门的云端标记，代理只作为附加条件；失败方向保持 fail-closed。

---

### 中：`wait --interval-seconds 0`（或极小值）会无限轮询，参数没有校验

`scripts/model-review/delegate.mjs:251-256`

```js
const tries = Math.max(1, Math.ceil((minutes * 60) / intervalSeconds));
for (let attempt = 0; attempt < tries; attempt += 1) {
  const sha = lsRemote(branch);
  if (sha && sha !== tip) return { moved: true, sha };
  if (attempt < tries - 1) await sleep(intervalSeconds * 1000);
}
```

`scripts/model-review/delegate.mjs:295-296`

```js
else if (key === "--minutes") task.minutes = Number(take());
else if (key === "--interval-seconds") task.intervalSeconds = Number(take());
```

`--interval-seconds 0` 时 `tries = Infinity`，循环永不结束，并不断执行 `git ls-remote`；`--minutes abc` 时 `tries = NaN`，第一次都不检查就报超时。`validateTask` 不涉及这两个字段，`wait` 分支（`delegate.mjs:330-342`）也没有校验。

建议：`wait` 分支校验 `Number.isFinite(minutes)`、`minutes > 0`、`intervalSeconds >= 1`（或某个下限），并给 `tries` 设上限；非法值以 `DELEGATE_INVALID` 退出。

---

### 中：`wait` 吞掉 git 失败，`check` 把 merge-base 错误误判为强推

`scripts/model-review/delegate.mjs:260-263`

```js
export function remoteHead(repo, branch) {
  const result = git(["ls-remote", "origin", `refs/heads/${branch}`], repo, { allowFail: true });
  return result.status === 0 ? (result.stdout.split("\t")[0] ?? "").trim() : "";
}
```

失败时返回空串，`waitForBranch` 把空串当作“分支没变”，于是 origin 不可达、认证失败、分支被删除都表现为空等 90 分钟（实际约 88 分钟）后 `DELEGATION_WAIT_TIMEOUT`。相反，`check` 的 `merge-base --is-ancestor` 只要返回非 0（包括 git 自身错误 128）就报 `DELEGATION_REWRITTEN`（`delegate.mjs:185-188`），把“git 坏了”误报成“云端强推”。

建议：`wait` 区分“命令失败”和“空结果”（例如连续失败 N 次后以 `DELEGATE_GIT_FAILED` 退出）；`merge-base` 用 `spawnSync` 区分 `status===1`（不是祖先）和 `status>1`/信号（git 错误）。

---

### 中：云端执行的 `npm run check:gitleaks` 来自被复核分支的 `package.json`

`scripts/model-review/delegate.mjs:126`

```js
2. 运行 git fetch origin ${task.branch} && git checkout -B ${task.branch} FETCH_HEAD，再运行 git rev-parse HEAD，结果必须正好是 ${task.tip}，否则停下。
```

`scripts/model-review/delegate.mjs:137`

```js
1. 如果 package.json 里有 check:gitleaks 这个脚本，先运行 npm run check:gitleaks；失败就停下报告，不提交。
```

云端先检出 `task.tip`（被复核分支），再从该分支的 `package.json` 读脚本执行。当前仓库的 `package.json` 没有 `check:gitleaks`，所以今天是空操作；但一旦某个被复核分支（或将来外部 PR）加入这个脚本，它就会在云端以代理/凭据所在环境执行任意命令。另外第 131 行执行的 `scripts/model-review/opencode-review.mjs` 也来自被复核分支。项目自己在 `model-review.md:77` 明确说“PR 都是本项目自己的线程写的……不防有人故意在 PR 里埋恶意代码”，所以这是已声明的威胁模型边界；但与本 PR 强调“云端线程不可信”放在一起容易让人误解。

建议：gitleaks 用固定的、已审阅的命令或从 base 提交取脚本；或在 `check` 里核对云端执行的脚本/`package.json` 与固定源一致；若继续依赖“PR 都是自己线程写的”，在 delegate 文档里明确写出这个前提。

---

### 低：文档说 `wait` “90 分钟没变”，实现约 88 分钟

`scripts/model-review/delegate.mjs:251-256` 用 `tries = ceil(minutes*60/intervalSeconds)`，默认 45 次轮询、44 次睡眠，总等待 `44 × 120s = 5280s = 88 分钟`。测试 `test/tooling/review-delegate.test.mjs:330-348` 也固化了这一点：`minutes: 10, intervalSeconds: 120` 只睡 4 次、轮询 5 次（8 分钟），却用来代表 10 分钟。文档 `model-review.md:135` 写 90 分钟。建议把 `tries` 改成 `ceil(...) + 1`（或最后一次检查后也睡），或者把文档改成 88 分钟。

---

### 低：只比较净树差异，云端可夹带“改了又还原”的提交

`scripts/model-review/delegate.mjs:190-195` 只比较 `task.tip..remote` 的最终树。云端可以在历史中加一个修改代码的提交、再加一个还原提交，最终净差异只有记录目录，`check` 会通过，`--apply` 会把这些提交快进进分支。净树是安全的，但历史里可能埋入 `.env` 一类文件，之后 `opencode-review` 的 `envFilesInHistory` 会以 `ENV_FILE_IN_HISTORY` 拒绝后续复核（可造成拒绝服务）。建议在 `check` 里逐提交检查 `tip..remote` 的路径，至少拒绝历史中出现 `.env` 类文件。

---

### 低：其它两端一致性/输入校验的小缺口

- `delegate.mjs:71` 只按 `PROVIDER_PATTERN` 校验 `--providers`，不检查是否存在于 `gateway.json`；`prompt` 能生成一份云端必然以 `ARG_INVALID --providers` 失败的任务。建议在 `delegate` 侧也用 `gateway.json` 校验。
- `delegate.mjs:42-53` 要求 `--head/--base/--previous/--tip` 是完整 40/64 位哈希，而 `model-review.md` 的通用说明说“提交可以写分支名”；Mac 必须自己先 resolve，文档里的 `<提交>` 容易误解。
- `validateTask` 的 `task.models`/`task.providers` 对空数组会通过 `.every`，只是随后 `reviewArgv` 的 `parseArgs` 才报错，错误码与 `DELEGATE_INVALID` 不一致。
- `delegate.mjs:207` 的 `parseUsage(before, "before")` 没有包在 try/catch 里；交出点账本若被人工改坏，会以未捕获异常退出 2，而不是 `DELEGATION_*` 拒绝。
- `delegate.mjs:327` 在 `applyResult` 之前就打印 `DELEGATION_RESULT_OK`；若 `--apply` 失败，stdout 已出现 OK，只有 stderr 的 `DELEGATION_LOCAL_MOVED` 或其他错误。
- `--apply`、`--minutes` 等参数给错子命令时被静默忽略（例如 `prompt --apply`），不报 `DELEGATE_UNKNOWN`。

---

## 推测/未核实

- 作者说“三个测试文件共 210 条通过、`npm run check` 通过、九处关键逻辑改坏都会失败”：**未核实**，我按约束不能运行测试；仓库里没有提交“九处改坏”的变异实验记录。
- 云端环境是否真的设置了 `HTTPS_PROXY`/`HIMAWARI_REVIEW_GATEWAY=magpie`：**未核实**，取决于 himawari-cloud 的配置。
- `SESSION_PATTERN` 是否匹配桌面应用真实会话编号格式：**未核实**。
- “两个模型各自出方案和审核”的 `.agents/reviews/topic-review-delegation/` 内容：因仓库是 sparse checkout，读取被 git 守卫拒绝，**未核实**。

---

## 作者说法逐条核对

1. **基本成立，但 `no-proxy` 不足以保证“在云端”**：`parseArgs` 的 `GATEWAY_REQUIRED not-magpie` 在 `opencode-review.mjs:2539-2540`；`main` 的代理检查在 `:2787-2788`，确实早于读材料、读网关配置、安装；自检不查代理（`:2425`）；子命令会报 `ARG_NOT_FOR_SUBCOMMAND`（`:2522-2526`）。但“有任意代理”不等于“在 himawari-cloud”，见第 3 条。
2. **基本成立**：`delegationPrompt` 无时间字段，字段都经 `validateTask`/`parseArgs`；`briefPathFor` 正是 `.agents/reviews/<目录>/briefs/<前12位>-<模式>.md`；补跑文案由 `task.round === undefined` 决定（`delegate.mjs:117-120`）。例外：`--minutes/--interval-seconds` 未校验；空数组能绕到后面才报错。
3. **基本成立**：`git fetch` 到 `refs/remotes/origin/<分支>` 且不检出（`:171-184`）；祖先、目录、账本前缀、记录字段、答案/提示词存在性都检查了（`:185-231`）；`--apply` 要求本地 HEAD 等于交出点（`:236-240`）。但缺少轮次、`outcome`、模型集合、文件类型和记录目录内既有文件的校验，见第 1、2 条。
4. **方向正确，数字有偏差**：`wait` 默认每 2 分钟、90 分钟、exit 3 的参数对（`:20-21`、`:305-349`），但实际等待约 88 分钟；git 失败会被当成“没变化”而非报错。
5. **大体一致**：`model-review.md` 新节、两处旧说法、`AGENTS.md`、ADR 0178 都改了；与代码的偏差主要是“90 分钟”和“落在 Default 会停”两处措辞。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。复核模型的提示由 `buildPrompt` 只取 `mode/model/questions/head/base/previous/brief`（`opencode-review.mjs:277`）生成；新增的 `--require-gateway` 不进入 `buildPrompt`。必问问题只从 `checklist` 锚点到下一个锚点/`##` 之间抽取（`:220-230`），本 PR 新增的 `<a id="delegate">` 和改动都在该区间之外。任务说明是云端线程新会话的第一条消息，不是已有请求的续写；它不含时间，因此同一参数输出逐字节相同。结论：发给复核模型的内容仍然只在末尾追加，每轮变化的 `head/base/previous/brief` 在末尾材料块；未发现系统提示、工具定义或历史前缀被改动。

**2. 同一段文字会不会因请求不同变成不同字节？**

复核提示不会：`buildPrompt` 的固定部分来自常量，`MODEL_LENSES` 每轮相同，问题来自固定 base/head 的 `model-review.md`，材料按原样拼接；`delegationPrompt` 没有 `Date`、随机数或无序集合遍历，`--models/--providers` 保序。账本里的 `at` 时间戳和模型输出本身带时间/随机性，但它们是记录，不会作为请求前缀重新发送。因此没有发现本改动引入“依赖前后文/时间字段/无序集合”的请求字节漂移。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有。`review-gateway.test.mjs` 覆盖 `--require-gateway` 的解析、`direct` 拒绝、子命令拒绝、无代理时真实子进程退出 2，以及 `gatewayRequiredProblem` 对空/空白代理、小写代理、自检模式的处理。`review-delegate.test.mjs` 13 条覆盖：任务说明逐字节稳定、字段注入拒绝、读同一字段、pending、正常接受并 `--apply`、本地移动拒绝、强推拒绝、改代码拒绝、旧账本改写拒绝、记录字段不匹配拒绝、缺答案/无新记录拒绝、`wait` 分支移动与超时。

反向用例确实断言了失败（`DELEGATION_REWRITTEN`、`DELEGATION_OUTSIDE_RECORDS`、`DELEGATION_LEDGER_REWRITTEN`、`DELEGATION_RECORD_MISMATCH`、`DELEGATION_LOCAL_MOVED`、`missing=round-1/`、`DELEGATION_NO_LEDGER`）。**缺口**：没有覆盖记录目录内既有文件被改（verdicts/judgments/brief）、符号链接、第一轮少一个模型、`record.round` 与 `task.round` 不一致、`outcome` 非 ok、`wait` 的 git 失败、`--interval-seconds 0`。另外 `wait` 测试本身把 10 分钟实现成 8 分钟，无法发现文档的 90/88 偏差。作者说的“210 条通过、九处改坏都失败”**未核实**（不能运行测试）。

**4. 改动产生/修改的每个值，使用它的人都能接受吗？**

逐项核对如下：
- **模型名**：账本写完整 `REVIEW_MODELS`（`opencode-review.mjs:2935`），`check` 用 `REVIEW_MODELS.includes`（`delegate.mjs:217`）；`delegate` 的 `--models` 用短名，`parseArgs` 用 `model.endsWith('/'+name)` 解析（`opencode-review.mjs:2484-2497`），两端一致。
- **`gateway`**：`gatewayRecordFields` 写 `"magpie"`（`:2595`），`check` 要求 `"magpie"`（`delegate.mjs:220`），一致。
- **服务方 id**：`gateway.json` 的 `workbuddy-ai/opendesign/opencode-go` 与测试、`PROVIDER_PATTERN`、`main` 的 `gatewayConfig.providers` 校验一致；`check` 还允许 `none`（`:221-223`），与 `gateway.mjs:448` 的 `"none"` 一致。但 `gateway.mjs:448` 也会产生 `"unknown"`，而 `check` 在 `task.providers` 存在时不豁免 `"unknown"`——如果这是异常状态，拒绝是合理的；若要允许“服务方未知但仍算一次运行”，需要显式处理。
- **`round`**：账本写数字（`:2933`），`parseUsage` 校验正整数；`check` 只用来拼路径（`delegate.mjs:224`），**没有和 `task.round` 对比**，这是两端不一致的地方。
- **`outcome`**：账本写 `review.outcome`（`:2940`），`check` 完全不读；失败的运行也能得到 `DELEGATION_RESULT_OK`。
- **`head/base/previous`**：账本写 `resolveCommits` 得到的完整 SHA（`:2936-2938`），`check` 做严格相等；`delegate` 只接受完整 SHA，而 `opencode-review` 接受分支名，因此 Mac 必须先 resolve，文档里的 `<提交>` 需要明确这一点。
- **`--require-gateway`**：`reviewArgv` 生成（`delegate.mjs:102-104`），`parseArgs` 接受并校验（`opencode-review.mjs:2461/2539`），`gatewayRequiredProblem` 消费；一致，但环境判断过弱（第 3 条）。
- **`--minutes/--interval-seconds`**：`parseTask` 生成（`:295-296`），`waitForBranch` 消费（`:251`），没有校验，`0` 会无限循环。
- **退出码/状态**：`check` 的 `pending=3`、`rejected=5`、正常=0（`:311-328`）与文档一致；git 失败是未文档化的 2；`wait` 超时 3（`:344-346`）。与文档 `model-review.md:135-136` 基本一致，除 90/88 分钟。

总体建议：优先把 `check` 改成“精确路径白名单 + 文件类型校验 + 轮次/模型集合/outcome/提示词哈希校验”，再把 `--require-gateway` 改成“云端标记 + 代理”双条件，并补上符号链接、记录篡改、`wait` 参数与 git 失败的失败用例。
