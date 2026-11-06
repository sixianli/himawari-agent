已核对 `8e378395`（重点看 `bb057722..8e378395` 增量，并对照 `bd0859a..8e378395` 整体改动）。下面先列读代码能证实的问题，再列作者说法核对、侧重检查和必答问题。**我没有运行测试**，测试结论来自读测试代码和实现。

## 一、问题（按严重度）

### 1.【高】`--accept-unreviewed` 只数轮次，不要求“连续三轮没过”，三轮全 ok 也能绕过合并前核对

- 文件:行：`scripts/model-review/opencode-review.mjs:824-832`、`:866-875`；测试 `test/tooling/opencode-review.test.mjs:2016-2027`、`:2106-2117`
- 问题：规则第 6 步的例外只能是“按第 4 步连续三轮没过、Andy 仍说合并”。代码只统计账本里出现过几个不同的代码复核轮次，完全不检查这些轮次是否失败、是否连续。于是任何一个有过三轮记录（哪怕三轮两个模型都 `ok`）的 PR，只要最后有一处未复核改动，就能用 `--accept-unreviewed` 记一条 override 放行。`--report --stop three-rounds` 同样只检查轮次数，可能把“三轮都通过”写成“连续三轮没过”。
- 证据：
```js
const reviewRounds = new Set(
  (records ?? []).filter((record) => record.mode === "code-review")
    .map((record) => record.round ?? 1),
).size;
...
const overridden =
  problems.length > 0 && Boolean(acceptUnreviewed) && reviewRounds >= OVERRIDE_MIN_ROUNDS;
```
```js
const consistent = {
  "no-error": latestComplete && gate.problems.length === 0,
  "three-rounds": rounds.length >= 3,
  ...
}[stop];
```
测试甚至明确用三轮 `ok` 证明 override 可用：
```js
f.writeLedger([
  ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm),
  ok(2, f.reviewed, deepseek), ok(2, f.reviewed, glm),
  ok(3, f.reviewed, deepseek), ok(3, f.reviewed, glm),
]);
const result = f.check({ acceptUnreviewed: "合并" });
expect(result.overridden).toBe(true);
```
- 建议：把“这一轮没过”这一线程判断写进账本（例如每轮一条 `verdict` 记录），`assertReviewed` 和 `reviewReport` 检查最后连续三轮都是失败轮；或者要求 `--accept-unreviewed` 必须引用一个已提交的判断文件并核对摘要。至少在代码和输出里不要把“至少三轮”称为“连续三轮没过”。

### 2.【中高】白名单里的代理变量仍能用同一条 `git log $HTTPS_PROXY` 泄露；自检只验了不在白名单的变量

- 文件:行：`scripts/model-review/opencode-review.mjs:398-421`、`:533-545`、`:1047`、`:1256-1257`
- 问题：`OPENCODE_KEPT_ENV` 确实去掉了 `GITHUB_TOKEN` 等令牌，但保留了 `HTTPS_PROXY`、`HTTP_PROXY`、小写版本等。模型仍然可以在受限 bash 里执行 `git log $HTTPS_PROXY`，shell 会先把变量展开成参数，git 报错再把值打印出来。云容器如果使用带用户名/密码的代理 URL，这就是和 T1 原漏洞同一类的泄露。当前自检只把 `REVIEW_PARENT_CANARY` 放在脚本进程环境里，而它不在白名单，所以“白名单里的变量是否含秘密”没有被检查。
- 证据：
```js
"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
"NO_PROXY", "no_proxy",
...
env: { ...opencodeEnv(process.env), ... }
```
```js
bash(`git log $${REVIEW_PARENT_CANARY_ENV}`),
```
- 建议：传给 opencode 前去掉代理 URL 的 userinfo，或改用受权限保护的代理配置文件；同时对每个可能含秘密的白名单变量做显式校验/告警。至少要在规则里写明“白名单内的值模型也能读到”。
- 推测：我没有读到云容器的真实代理 URL，是否真的带凭据未核实；但代码确实把这类变量原样传给了模型可用的 shell。

### 3.【中】提交后的 override 记录不会被后续 `assertReviewed`/CI 识别，等于只对当次运行有效

- 文件:行：`scripts/model-review/opencode-review.mjs:777`、`:801-803`、`:824-839`、`:869`
- 问题：`--accept-unreviewed` 写入的是 `mode: "override"`，但 `lastCompleteRound` 只看 `mode === "code-review"`，`assertReviewed` 也从不读取已有的 override 记录。规则要求“把这条记录随 PR 提交后再合并”，可提交后如果再跑一次 `--assert-reviewed`（或以后 CI 读账本），仍然输出 `REVIEW_NOT_CURRENT` 并以 5 退出。`--report` 的 gate 行同样会打印 `REVIEW_NOT_CURRENT`，和“Andy 已裁定合并”的结论矛盾。
- 证据：
```js
const complete = records ? lastCompleteRound(records) : null;
...
const reviews = records.filter((record) => record.mode === "code-review");
```
```js
appendFileSync(
  join(repo, ledgerPath, "usage.jsonl"),
  `${JSON.stringify({ at: new Date().toISOString(), mode: "override", ... })}\n`,
);
```
- 建议：`assertReviewed` 读取同一账本里的 override 记录，若其 `head` 等于当前 HEAD 且当前 `problems` 被该记录覆盖，则输出 `REVIEW_OVERRIDE` 而不是继续失败；`reviewReport` 也显示这条记录。否则应在文档里明确“override 只对当次运行有效，后续检查仍会失败”。

### 4.【中】override 读 `HEAD` 账本，却写工作区账本，二者不一致时可能丢记录或记录错误的问题列表

- 文件:行：`scripts/model-review/opencode-review.mjs:801-802`、`:833-838`
- 问题：检查用的是 `git show HEAD:.../usage.jsonl`，写回却直接 `appendFileSync` 到工作区文件，没有确认工作区文件存在、且和 `HEAD` 一致。若工作区因 sparse checkout 没有该文件，或账本有未提交改动/内容过期，`appendFileSync` 会新建或追加到另一份账本；随后提交可能只提交 override 记录，丢掉旧轮次，或让记录里的 `problems` 与最终账本不符。这是对记录文件的不可逆写入。
- 证据：
```js
const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
const records = shown.status === 0 ? parseUsage(shown.stdout, `HEAD:${ledgerPath}`) : null;
...
appendFileSync(
  join(repo, ledgerPath, "usage.jsonl"),
  `${JSON.stringify({ ... mode: "override", ... })}\n`,
);
```
- 建议：追加前校验工作区账本存在且内容等于 `HEAD`；不一致就拒绝并提示先提交/还原，或从 `HEAD` 读出的内容重建文件后再追加。

### 5.【中】`recordText` 只用于 `.md`，`.prompt.md` 和 `.stderr.txt` 仍可能带行尾空格；对应测试只测函数本身

- 文件:行：`scripts/model-review/opencode-review.mjs:1500-1502`、`:1723`、`:1736`、`:1758`；测试 `test/tooling/opencode-review.test.mjs:289`
- 问题：作者说去掉行尾空格是为了避免 `git diff --check` 拒收提交，但只有模型结论 `.md` 经过 `recordText`。提示词文件原样写 `prompt`，而 `brief.trim()` 只去整段首尾，不删中间行的行尾空格；失败时的 `.stderr.txt` 也原样写。这些文件都在记录目录里、要随 PR 提交，仍可能触发 `git diff --check`。测试只调用 `recordText` 函数，撤掉 `main` 里的实际调用不会让这条测试失败。
- 证据：
```js
writeFileSync(join(roundDir, promptFileName(model)), prompt);
...
writeFileSync(join(roundDir, `${name}.md`), recordText(summary.text));
...
writeFileSync(join(roundDir, `${name}.stderr.txt`), review.stderr);
```
```js
expect(recordText("a  \nb\t\n\nc ")).toBe("a\nb\n\nc\n");
```
- 建议：对全部写入仓库的文本记录使用同一个清洗函数（或先在 `brief` 源头去掉行尾空格），并让 `roundForRun` 的提示词比较使用同一规范；补一条走真实写入路径的集成测试，或直接断言记录目录里所有文本文件没有行尾空格。

### 6.【低】`--round` 在提示词文件和账本摘要都缺失时不做比较；没有 `head` 的旧记录也会跳过提交比较

- 文件:行：`scripts/model-review/opencode-review.mjs:929-942`
- 问题：规则说“这一轮里这个模型的提示词不同就拒绝”。代码只有在磁盘提示词存在，或账本记录带 `promptSha256` 时才检查。两者都没有时直接放行，可能把不同提示词的重跑写进同一轮。提交比较也只取 `record.head` 为真的记录，旧记录没有 `head` 时不阻止。
- 证据：
```js
const recordedDigests = inRound
  .filter((record) => record.model === model && record.promptSha256)
  .map((record) => record.promptSha256);
...
if ((onDisk !== null && onDisk !== prompts[model]) ||
    recordedDigests.some((recorded) => recorded !== digest))
  throw new Error(`ROUND_PROMPT_MISMATCH ${requested} ${model}`);
```
- 建议：若既没有磁盘提示词也没有账本摘要，或本轮记录缺少 `head`，明确报错（例如 `ROUND_CANNOT_VERIFY`），不要静默放行；补对应反例测试。

### 7.【低】`roundForRun` 不按 `mode` 过滤记录，`plan` 与 `plan-review` 共用 topic 时可能误判

- 文件:行：`scripts/model-review/opencode-review.mjs:920-942`
- 问题：`plan` 和 `plan-review` 按规则共用同一个 `--topic` 记录目录。`inRound` 只按轮次过滤，不按 `mode` 过滤；如果同一轮里混有两种模式的记录，`ROUND_ALREADY_HAS_RESULT`、`ROUND_HEAD_MISMATCH`、`ROUND_PROMPT_MISMATCH` 都可能基于另一模式的记录误报。
- 证据：
```js
const inRound = records.filter((record) => (record.round ?? 1) === requested);
...
if (inRound.some((record) => record.model === model && record.outcome === "ok"))
  throw new Error(`ROUND_ALREADY_HAS_RESULT ${requested} ${model}`);
```
- 建议：把 `mode` 传进 `roundForRun`，先 `filter((record) => record.mode === mode)`；补一条同一轮同时有 `plan` 和 `plan-review` 记录的测试。可达性取决于实际用法，正常流程每种模式各占一轮时不会触发。

### 8.【低】规则文件里的原始事件路径漏了仓库路径摘要，和代码不一致

- 文件:行：`.agents/instructions/model-review.md:72` 与 `scripts/model-review/opencode-review.mjs:1495-1497`
- 问题：规则写的是 `himawari-review-raw/<记录目录名>/round-<序号>/`，代码实际是 `himawari-review-raw/<仓库路径摘要12位>/<记录目录名>/round-<序号>/`。按本项目“文档与代码不符算会出错”的标准，这是需要修的文字。
- 证据：
```js
const repoId = createHash("sha256").update(resolve(options.repo)).digest("hex").slice(0, 12);
return join(tmpdir(), "himawari-review-raw", repoId, reviewKey(options), `round-${round}`);
```
- 建议：更新规则文件的路径说明，或让测试字符串与文档使用同一个生成函数。

### 9.【低】`/proc/self/environ` 探针按平台条件添加，但测试仍无条件断言它存在，macOS 上会失败

- 文件:行：`test/tooling/opencode-review.test.mjs:435-441` 与 `scripts/model-review/opencode-review.mjs:1033-1035`
- 问题：第 2 轮把探针改成只在 Linux 上添加，但测试仍然无条件期望 `plan.probes` 包含 `/proc/self/environ`。在 macOS 上运行这份测试会失败。作者自己也说 Mac 未验证。
- 证据：
```js
...(process.platform === "linux"
  ? [{ tool: "read", args: { filePath: "/proc/self/environ" } }]
  : []),
```
```js
expect(plan.probes).toContainEqual(
  expect.objectContaining({ kind: "read", tool: "read", args: { filePath: "/proc/self/environ" } }),
);
```
- 建议：测试里按 `process.platform` 条件断言；若 CI 只在 Linux 跑，也建议写明这是 Linux-only。

## 二、作者说法核对

- **T1 环境变量**：白名单、`git log $REVIEW_PARENT_CANARY` 探针、Linux 上的 `/proc/self/environ` 拒绝都已实现。说“要求读 `/proc/self/environ` 被拒”在 Linux 成立；Mac 没有 `/proc`，代码按平台跳过。**遗漏**：白名单内的代理变量仍可用同一招读取（问题 2）。
- **T7 安装**：`npm ci`、锁文件、目录名带摘要前 12 位、`installed-lock-unreadable`、重装一次都实现了。但作者说法里的“核对已装的每个包的 sha512”不准确：代码比较的是 `node_modules/.package-lock.json` 里记录的 `integrity` 字符串，不重新计算已装文件摘要；规则文件第 62 行已按实际情况改写。**另一个限制**：只遍历安装记录里已有的包，不检查锁文件里是否少了某个包（`opencode-ai` 单独检查）。
- **T8 重跑**：轮次不存在、该模型已有 ok、head 不同、提示词不同的拒绝都在花钱前；attempt 改名也实现了。**差距**：提示词文件和账本摘要都缺失时不比较（问题 6）；不按 `mode` 过滤（问题 7）。
- **T3 记录进仓库**：固定目录、`--out` 限制、prompt/md/stderr、原始事件进临时目录、sparse checkout、`-diff`、git 替身拒绝都在。**差距**：原始目录路径文档未同步（问题 8）；`recordText` 覆盖不全（问题 5）。
- **T2 合并前核对**：`--no-renames`、最后完整轮次、祖先关系、只允许记录目录、`origin/main` 已合入都已实现。**差距**：override 的三轮判断太弱（问题 1）、提交后的 override 不被后续检查识别（问题 3）、写工作区账本不校验（问题 4）。
- **T6 汇报**：`--report` 固定行、`REVIEW_STOP_INCONSISTENT` 都实现了。但 `three-rounds` 只数轮次，不核对“没过”（问题 1）。
- **T5 各有侧重**：`MODEL_LENSES`、第 4 条必答问题、`--questions-ref` 都在；两个模型的提示词只在侧重一节不同，测试也验证了这一点。
- **测试**：新增或扩充的测试确实存在；env、`PROMPT_TOO_LARGE`、安装、重跑、子命令参数有真实入口或反向用例。但“行尾空格（review records）”只测了 `recordText` 函数，没有测真实写入路径（问题 5）。

## 三、侧重检查

- **环境变量/令牌**：查了 `opencodeEnv`、`runOpencode`、`selfCheck`/`probePlan`。非白名单的 `GITHUB_TOKEN` 等确实不传；但白名单内的 `HTTPS_PROXY`/`HTTP_PROXY` 等仍能被模型用同一招读到，见问题 2。
- **安装/完整性/重装**：查了 `installedIntegrityProblems`、`npmCi`、`installOpencode`。没有发现任意路径写入；但重装是先 `rmSync(prefix, {recursive:true})` 再 `npm ci`，网络失败会连旧安装一起失去；另外只核对安装记录里已有的条目，不重算文件摘要。规则文件已承认后者。
- **记录写入/不可撤销操作**：查了 `keepEarlierAttempt`、`recordText`、`assertReviewed` 的 `appendFileSync`。override 写工作区账本、不校验与 `HEAD` 一致，见问题 4；`.prompt.md`/`.stderr.txt` 未去行尾空格，见问题 5。
- **不合规范/不可信输入**：`--pr`/`--round` 有整数校验，`--topic` 有正则和长度限制，`--out` 只在 self-check 允许，git 参数用数组传给 `spawnSync`，git 替身按解析后的参数拒绝。没有发现 shell 注入口。`--andy-quote` 原样进报告文本，换行会改变固定行格式，但这是用户提供的 Andy 原话，风险低，未单列为问题。
- **资源耗尽**：`--brief` 在 `PROMPT_TOO_LARGE` 检查前已经整份读入并参与构造提示词；超大文件仍可能先耗尽内存。原始事件和思考内容写到临时目录后不清理；`npm ci` 没有超时。这些多数是既有限制，不是本次新增的阻断问题。
- **只读边界**：sparse checkout、`-diff`、git 替身、受限 bash、外部路径拒绝探针都在；作者已写明的 `git show <对象编号>` 局限仍成立。

## 四、必答问题

1. **这个改动会不会改变模型已经见过的请求开头？**
   不会改变“已发内容”。本次改动没有改 `buildPrompt` 的固定部分、`reviewConfig` 的工具定义，也没有改历史消息或遮盖逻辑。提示词构造仍是“固定说明 + 本次材料”，材料里的 `head`、`base`、`previous`、`brief` 都在最后；测试 `opencode-review.test.mjs:183-208` 验证了不同材料下固定前缀逐字节相同。追问只在同一会话末尾追加 `WRAP_UP_PROMPT`，测试 `:1448` 也检查了只追加。两个模型的侧重 `MODEL_LENSES` 不同，但各自每次都是新会话，同一模型每轮侧重不变，所以不会命中“已见过前缀被改写”。**未核实**：opencode 自身系统提示是否含工作目录等每轮变化的值；这不在这份脚本的可控代码里。
2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会由本次改动引入。`buildPrompt` 是确定性的：没有时间、随机数、无序集合或依赖前后文的遮盖。`usage.jsonl` 里的时间戳只写账本，不发模型；`rawDir` 的仓库路径摘要只用于临时目录。唯一会把文本字节改掉的是 `recordText`（去掉行尾空格），但它只写 `.md` 存档，不参与后续请求；如果要求“存档也必须和模型原文逐字节一致”，那它是有意偏离，但不会影响模型请求。
3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有，但不完整。真实反向用例包括：env 白名单失效时 `$REVIEW_PARENT_CANARY` 探针失败（`opencode-review.test.mjs:505-519`、真实自检 `:849-882`）、把代码文件改名进记录目录被识别（`:1937-1947`）、安装记录读不出/摘要不符（`:718-776`）、`--round` 提示词摘要回退（`:2317-2334`）、子命令多余参数（`:297-308`）、`PROMPT_TOO_LARGE` 入口（`:2286-2315`）。**缺口**：`recordText` 只有函数单测，撤掉 `main` 里的调用测试仍会通过；override 测试用三轮 `ok` 证明可用，没有测“连续三轮失败”；代理变量泄露没有探针；提示词文件和账本摘要都缺失时的回退没有反向用例；macOS 上 `/proc` 测试与代码平台条件不一致（问题 9）。另外我没有实际运行测试，不能确认作者说的 111 通过 1 跳过。

## 五、未核实/推测

- 云容器实际使用的 `HTTPS_PROXY` 是否含用户名/密码：未核实；代码确实会把它传给模型可用的 shell。
- opencode 1.19.5 自身系统提示是否包含工作目录等每轮变化的值：未读其源码，未核实；本次改动未触及这部分。
- 测试实际运行结果：未运行，以上测试结论来自代码阅读。
