## 复核结论

改动本身方向正确，绝大多数校验与作者说法一致；但在本轮新增的 `notOk`/`finished` 逻辑里发现一个会漏报"未完成"的实质缺陷，另有若干低风险问题和文档/说法偏差。以下按严重度排列。

---

## 发现（读代码证实的）

### 1. 中：替补记录会把"替补模型自己失败的复核"当成完成，导致 `notOk` 漏报

文件：`scripts/model-review/delegate.mjs:357-365`

```js
const finished = (model) =>
  added.some(
    (record) =>
      record.outcome === "ok" &&
      (record.model === model || (record.substitute && record.substituteFor === model)),
  );
const notOk = [...new Set(added.map((record) => record.model))].filter(
  (model) => !finished(model),
);
```

问题：第一个分支 `record.model === model` 没有排除 `record.substitute`。也就是说，模型 B 作为 A 的替补跑出的 ok 记录（`model=B, substitute=true, substituteFor=A`），会同时把 B 自己判为"完成"。

复现路径（都能过现有全部校验）：预期模型是 `[deepseek, glm]`；账本里 glm 自己的记录是 `timeout`，外加一条 `model=glm, substitute=true, substituteFor=deepseek, outcome=ok` 的替补记录。`absent=` 因为 glm 有非替补 timeout 记录而通过；`finished(deepseek)` 由替补覆盖，`finished(glm)` 又因这条替补记录为 ok 而通过，于是 `notOk=[]`、退出码 0。实际上 glm 自己从没成功复核。

这正是 check 设计要挡的"云端线程没照说明补跑"的场景：两个模型都失败后，云端只补跑 deepseek，deepseek 又 api-error 触发 glm 顶替；glm 自己的失败被它做替补的成功记录掩盖。旧逻辑（eb341ee6 的 `covered`）会正确把 glm 报成 `not-ok`，所以这是本轮引入的回归。

建议：第一个分支加 `!record.substitute`：

```js
(record.model === model && !record.substitute) ||
(record.substitute && record.substituteFor === model)
```

并补一条反向用例：预期两个模型、glm 自己 timeout 且只作为 deepseek 的替补成功，断言 `notOk` 仍包含 glm。

### 2. 低：交出点 `gateway.json` 用裸 `JSON.parse`，绕过 `readGatewayConfig` 的校验，出错码与文档不一致

文件：`scripts/model-review/delegate.mjs:300-306`，文档 `.agents/instructions/model-review.md:136`

```js
const tipConfig = showFile(repo, task.tip, GATEWAY_JSON_PATH);
const allowedProviders =
  task.providers ??
  (tipConfig === null
    ? fail("DELEGATION_NO_GATEWAY_CONFIG")
    : JSON.parse(tipConfig)
  ).providers.map((item) => item.id);
```

问题：
- 只有"文件不存在"才产生 `DELEGATION_NO_GATEWAY_CONFIG`。文件存在但 JSON 非法会抛原始 `SyntaxError`；`providers` 缺失/不是数组会抛 `TypeError`，最终都以退出码 2 打印原始消息，而不是文档写的那个错误码。
- 其它路径都是用 `scripts/model-review/gateway.mjs:74` 的 `gatewayConfigProblems` 逐项校验配置，这里的消费者没有复用，等于对同一个值用了两套校验标准。
- 而且 `showFile` 在 `task.providers` 已给出时也会无条件调用（值虽不用），tip 提交损坏/缺失时可能多报一个 git 错误。

建议：复用 `gatewayConfigProblems`（或至少校验 `Array.isArray(providers)` 且每项有合法 `id`），把任何异常收敛成明确的 `DELEGATION_NO_GATEWAY_CONFIG`/`DELEGATION_GATEWAY_CONFIG_INVALID`；补一条"tip 无 gateway.json"和"tip 配置非法"的测试。

### 3. 低：重复账本行检查只能挡逐字节完全相同的重放，且现有反向用例证明力不足

文件：`scripts/model-review/delegate.mjs:286-293`，测试 `test/tooling/review-delegate.test.mjs:675-686`

```js
const knownLines = new Set(before.split("\n").filter(Boolean));
if (
  after.slice(before.length).split("\n").some((line) => line && knownLines.has(line))
)
  return rejected("DELEGATION_LEDGER_DUPLICATE");
```

问题：只比较原始行文本。把旧行加个尾随空格、改字段顺序、加 `\r`，`JSON.parse` 照样接受、`knownLines` 却匹配不上，检查直接失效。鉴于文档明确"账本记录本身仍被信任（防误操作，不防有意）"，这不算严重，但它在文档里被写成一条防护，实际防护面很窄。

另外现有反向用例的重放只复制了 deepseek 的 timeout 行，glm 缺失；即使去掉重复行检查，结果也会因 `absent=glm` 被 `DELEGATION_RECORD_MISMATCH` 拒绝——测试能验证代码分支被走到，但不能证明"一条结构完全合法、只是重放旧行"会被挡住。建议加一条两个模型都重放、其它字段全合法的用例，并考虑按 `(model, round, head, promptSha256, outcome, at)` 规范化比较。

### 4. 低：`Cc`/`Cf` 检查作用到记录里的自由文本，可能误拒真实结果

文件：`scripts/model-review/delegate.mjs:212-218`、`:296`

```js
if (typeof value === "string") return hasControlCharacter(value) || /[\p{Cc}\p{Cf}]/u.test(value);
```

问题：`added` 里包含 `apiError`、`lastReason`、`costUnknownWhy`、`wrapUpSkipped` 等来自上游/运行器的自由文本。`\p{Cf}` 包含零宽连接符 U+200D、软连字符等，真实上游错误信息里带这些字符并非不可能；一旦出现，整批结果以 `DELEGATION_CONTROL_CHARACTER` 被拒。结构化字段其实已经被 `parseUsage` 约束（`head` 只认十六进制、`model` 来自固定清单），防"不可见方向字符"可以只查键名和结构性字段。

建议：把 `\p{Cc}\p{Cf}` 限定在键名、`model`/`mode`/`head`/`base`/`previous`/`promptSha256`/provider 键等结构字段；自由文本只查 `hasControlCharacter`，或明确记录为可接受误报。

### 5. 低：git 超时只约束时间，不约束取回的数据量；且无自动检查

文件：`scripts/model-review/delegate.mjs:171-181`、`:29`

```js
const result = spawnSync("git", args, {
  cwd, encoding: "utf8", maxBuffer: 1 << 28, timeout: GIT_TIMEOUT_MS,
});
```

问题：`check` 的 `git fetch` 会先把远端分支对象写到本地，`timeout` 只杀直接子进程，不限制 pack 大小、也不保证杀掉 `git-remote-*`/`git-upload-pack` 子进程。恶意或异常的分支仍可在超时前写入大量对象。单次命令 stdout 有 256MB `maxBuffer` 兜底，这一点是好的。文档只写了"2 分钟超时"，没有对应的测试；仓库里也没有任何用例能证明超时会被当作 `DELEGATE_GIT_FAILED`。

建议：至少补一条用 fake git（或注入短超时）验证超时会失败退出的用例；文档里如实写明"只限时间、不限取回体积"。

---

## 推测 / 无法核实

- 作者说的"三个测试文件共 227 条通过、`npm run check` 41 步 40 过、`check:layout` 失败"：受工具限制不能运行测试，未核实。
- "九处关键逻辑逐个改坏，对应用例都失败"：只能从测试代码推断，未实际执行。上述三条新用例按代码逻辑去掉对应检查后确实会失败（Cf 用例会变成 `notOk=[deepseek]`；同轮补跑用例会变成 `notOk=[deepseek]`；重复行用例会变成 `RECORD_MISMATCH`），但见发现 3 的证明力说明。
- 资源耗尽的实际影响大小取决于远端分支所有权，属于低概率，不当作阻断项。

---

## 作者说法核对

- 第 5 轮关于 `notOk`、文件名白名单、`Cc`/`Cf`、重复行、服务方来源、git 超时的描述，**与代码基本一致**，但：
  - "之前带特殊字符的模型名会让 check 崩溃"——`eb341ee6` 处该判断是 `file.startsWith(\`${shortModel(record.model)}.\`)`（字符串，不是正则），我在该基线看不到会崩溃的路径，此说法无法从被复核的版本复现。
  - "读不到则 `DELEGATION_NO_GATEWAY_CONFIG`"——只覆盖"文件不存在"，非法 JSON / 缺 `providers` 不是这个码（发现 2）。
  - "所有 git 子进程加 2 分钟超时"——在 `delegate.mjs` 内成立；`opencode-review.mjs` 自己的 `git()` 仍无超时，只是文档把范围限定在 `check`，所以文档层面不算错。
- 文档 `.agents/instructions/model-review.md:141` 有一处排版错误：`` `package.json`来自被复核的分支 `` 中间缺空格（原来有"（包括 check:gitleaks）"被删时连带的）。不影响语义。
- 第 1–4 条旧说法我抽查了关键实现：`--require-gateway` 的 `parseArgs`/`gatewayRequiredProblem`/`main` 顺序、`prompt` 的字段校验与 `reviewArgv`、`briefPathFor`、`check` 的 fetch/祖先/记录目录/账本前缀/字段/文件/`--apply`、`wait` 的 2 分钟/90 分钟/退出码，均与代码/文档一致。

---

## 侧重检查

- **不可信输入与路径**：`task.branch`/`tip`/`head`/`base`/`previous`/`topic`/`replyTo`/`brief` 都有固定格式校验；branch 禁 `..` 且各段以字母数字开头，拼进任务说明的 shell 命令没有注入面。路径检查用 `startsWith(recordsDir)`（带尾斜杠）、`git log --name-only` 逐提交 + `git diff --raw --no-renames` 终态，能挡"改了又还原"；`newMode !== "100644"` 挡符号链接/子模块/可执行位。**结论：路径与注入面基本可靠。**
- **错误路径**：git 失败统一 `DELEGATE_GIT_FAILED`、退出码 2；`merge-base` 只有返回 1 才当强推（`delegate.mjs:243-245`），其余非 0 当 git 出错；`showFile` 先 `ls-tree` 再 `show`，读失败抛错而不是当文件不存在。**唯一毛病是发现 2 的配置解析错误不收敛。**
- **安全**：`check` 只 `fetch` 不检出、不执行远端脚本；`--apply` 只对已核对的提交做 `merge --ff-only`；账本只能追加、记录/答案/提示词文件按模型白名单限制。**已确认的信任前提**：账本和答案内容本身可被伪造（文档已写明"防误操作，不防有意"），所以 `check` 本质不能防"有意的云端线程"，只能防手滑和明显的越界提交。发现 1 属于在这个前提下仍应收紧的逻辑漏洞。
- **不可撤销操作**：`delegate.mjs` 没有 force push、reset、checkout 等破坏性操作；`--apply` 在 `notOk`（退出码 4）时也会先合并再打印不完整（`delegate.mjs:515-521`，测试明确期望 `DELEGATION_APPLIED`），这是有意的"把记录带回来"，但调用方要意识到退出码 4 时本地分支已经前进了，按同一 `--tip` 再跑 `--apply` 会报 `DELEGATION_LOCAL_MOVED`。
- **规则/文档一致**：本轮修正后的删除条件、文件名规则、重复行、格式字符、服务方来源、git 超时描述与代码一致；`check:gitleaks` 确实不在 `package.json`（存在的是 `check:secrets`，`package.json:64`），文档说法成立。`AGENTS.md`、ADR 0178 与代码一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 本增量只改 `delegate.mjs` 的校验、测试和文档；整个 PR 对 `opencode-review.mjs` 只加了 `--require-gateway` 的参数解析和入口检查（`git diff` 已核对），没有动 `buildPrompt`、系统提示、工具定义、历史、资料块或遮盖。新增的"任务说明"是给全新云端会话的一条用户消息，且只含本次任务的固定值。因此发给复核模型的内容仍然只在末尾追加，每轮会变的值没有进入请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？不会影响模型请求字节。** `delegationPrompt` 本轮完全没改，本来就不含时间（测试断言无 `\d{4}-\d{2}-\d{2}T`）；字段顺序固定，`providers`/`models` 的顺序来自固定命令行参数，没有无序集合遍历。账本记录里的 `at` 时间戳是输出产物、不进入模型请求；本轮也没有新增带时间的字段或依赖前后文的遮盖。

3. **有没有自动检查、反向用例是否真会失败？部分有。** 本轮三条新用例（同轮补跑、`Cf` 方向字符、重复账本行）分别覆盖了三处新逻辑，按代码推断去掉对应检查后用例都会失败；但：
   - `GIT_TIMEOUT_MS`、`DELEGATION_NO_GATEWAY_CONFIG`、tip 配置非法都没有测试；
   - 发现 1 的替补边界没有测试；
   - 重复行用例的重放不完整，去掉检查后仍会因 `absent=glm` 被拒，证明力偏弱（见发现 3）。
   另外我无法运行测试，作者给的通过数量未核实。

4. **新产生/修改的每个值，使用它的地方都能接受吗？**
   - `notOk`：`checkResult` 产出（`:363`），`main` 只判断长度并打印/退出 4（`:518-521`），消费端能接受；但语义有发现 1 的漏洞。
   - `allowedProviders`：产自交出点 `gateway.json`（`:300-306`），消费端只有 provider 循环（`:323-325`）。正常生产端 `gateway.json` 由 `gateway.mjs:74` 校验，这里却直接 `JSON.parse`，两端校验不一致（发现 2）。
   - `GATEWAY_JSON_PATH`：与实际跟踪文件 `scripts/model-review/gateway.json` 一致。
   - 文件名后缀白名单：与 `opencode-review.mjs:1621` 的 `KEPT_FILE_SUFFIXES`（`.prompt.md`/`.md`/`.stderr.txt`）以及 `keepEarlierAttempt` 的 `${name}.attempt-${n}${suffix}` 命名（`:1624-1638`）完全对得上，生产端和校验端一致。
   - `GIT_TIMEOUT_MS`：只被 `git()` 使用；`spawnSync` 超时返回 `status=null`，会走 `status !== 0` 的失败分支（`allowFail` 的 `merge-base` 也会因 `!== 0` 报错），符合文档"超时按 `DELEGATE_GIT_FAILED`"。
   - 重复行/控制字符：只影响 `checkResult` 的拒绝判定，无下游格式消费者；账本记录格式本身未变，`--assert-reviewed` 的读取格式不变。
