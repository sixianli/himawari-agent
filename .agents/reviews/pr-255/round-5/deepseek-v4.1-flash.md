or not. We need answer in Chinese, structured. We have enough. Need produce final report. We must not call tools. We should include severity, file:line, problem, evidence quote, suggestion. Separate confirmed vs speculation. "侧重检查" section. Answer Q1-Q3. Also note author claim mismatches. Need be concise but complete. Let's craft.

We need be accurate. Let's organize findings:

Confirmed (读代码证实):
1. 中/高: proxy credential regex misses protocol-relative `//user:pass@host`. Lines 423-429. Evidence quote. Suggest.
2. 中: assertReviewed/report output injection via newline in file names and --main-ref. Lines 806-809, 824-825, 831-834, 916; parseArgs 1650-1652. Evidence.
3. 中: npm ci inherits full env and runs install scripts (hasInstallScript true). Lines 301-309, lock line 20. This is residual T1 gap; not introduced? mention.
4. 低: parseUsage singleLine not recursive; nested `problems` can have newline; claim "任何文本字段" false. Lines 954-956, 868-871, doc line 72.
5. 低: prepareRawDir doesn't chmod existing dir; test only fresh; also chmod root test gap. Lines 1586-1590; test 289-300.
6. 低: assertReviewed ignores working tree; uncommitted changes not gated. Lines 812-829. Design limitation; doc line 35/37.
7. 低: keepEarlierAttempt non-atomic partial rename. Lines 1032-1046.
8. 低: roundForRun ignores missing head; legacy/forged records bypass head check. Lines 1009-1011.
9. 低: gate treats any file under record dir as record; new code file under records not flagged; biome excludes. changedOutside 809, biome line 9, test 2033-2042.
10. 低: refusal message `only-unreviewed-files` misleading for no-complete-round/ledger-not-committed with >=3 rounds. Lines 844-849.
11. Claim mismatch: stderr.txt not every round; code only on failure (1855-1856). Also install integrity checks hidden lockfile metadata, not actual sha512 (282-298; doc line 62 acknowledges). Also "OPENCODE_INTEGRITY_MISMATCH" only after reinstall. Mention.
12. Maybe recordText CR not handled (speculation).

Speculation/未核实:
- Multi-user shared tmp root conflict (prepareRawDir chmod root EPERM). Not verified.
- webfetch SSRF/metadata in plan modes (pre-existing, not verified).
- opencode output CRLF causing git diff --check (not verified).
- SHA-256 repo 40-hex issue (not verified; repo SHA-1).
- Other model's prompt inconsistency in roundForRun allowed (test intentional; not necessarily bug).

Q1: Within session only append; lens is fixed prefix, per-model constant; per-round values in prompt last user message; wrap-up appends. Tool defs unchanged; permission changes only. New lens changes prefix vs old script, but new sessions; no existing session prefix changed. Caveat: if lens changes mid-PR, new session; cache not shared. Answer yes compliant for sessions.

Q2: No same text different bytes across requests for a given model/session; lens constant; brief normalized recordText; questions from commit; no timestamp in prompt; ledger `at` not sent. But two models get different prompts by design. Potential nondeterminism: recordText doesn't normalize CR; same file same bytes. No redaction. So no.

Q3: Many tests. Reverse cases: some gaps. Specifically:
- proxy `//` not tested and code misses.
- prepareRawDir existing dir/root chmod not tested; removing chmod root may still pass fresh test.
- nested newline not tested.
- output injection newline filename not tested.
- committed override + non-unreviewed problem combination not directly tested; code uses same overridable guard.
- npm env not tested.
- keepEarlierAttempt partial failure not tested.
Thus Q3: not fully satisfied for those.

Need mention "作者说法核对" maybe integrated:
- T1 env whitelist matches, canary and /proc probe present.
- T7 lock/npm ci/digest dir matches; integrity check is metadata not recompute; mismatch on reuse triggers reinstall first.
- T8 round checks present before spend; attempt rename; caveats.
- T3 records dirs, --out restriction, sparse, attributes, guard bans match; stderr only on failure; known object-id limitation acknowledged.
- T2 gate matches; override only unreviewed; three rounds; committed override recognized; working tree not checked.
- T6 report matches; same-round attempts listed.
- T5 lens and Q4, questions-ref match.
- Constraint about time-limit test: diff range includes #256 change from main, not this PR's own commit; "本 PR 没碰它" is true for branch commits but diff range does include it. Could mention.

Need keep within reasonable length. The user wants full report. Let's write in Chinese.

Use file:line references. Quotes concise.

Let's ensure no markdown table maybe fine. Use headings.

We should not claim we ran tests. State "我没有运行测试（工具限制），以下反向用例判断来自读代码/测试内容".

Let's produce.## 复核结论（增量 e6293956..c6d132f1，必要时对照整个 PR）

我没有运行测试，以下“反向用例是否会失败”的判断来自阅读测试和实现代码；未读到的部分标「未核实」。

### 读代码证实的

#### 1. 严重度：中高 — 代理凭据检查漏掉 `//user:pass@host`
- 文件:行：`scripts/model-review/opencode-review.mjs:423-429`
- 问题：`PROXY_ENV` 里的代理地址会原样进入 `OPENCODE_KEPT_ENV`，模型可以用 `git log $HTTPS_PROXY` 让 shell 先展开，再从 git 报错里读到值。`proxyCredentialProblems` 只匹配“可选 scheme + 第一个 `/?#` 之前出现 `@`”，协议相对写法 `//user:pass@host` 在可选 scheme 之后立刻遇到 `/`，`[^/?#]*` 只能匹配空串，正则不命中。
- 证据：
  ```js
  export const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
  export function proxyCredentialProblems(env) {
    return PROXY_ENV.filter((name) =>
      /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test((env[name] ?? "").trim()),
    );
  }
  ```
  测试 `test/tooling/opencode-review.test.mjs:2487-2504` 覆盖了 `http://u:p@...`、`u:p@...`、`https://token@...`，但没有 `//u:p@...`。
- 建议：用 URL 解析（给协议相对地址补一个 dummy base）或先去掉 `^[a-z][a-z0-9+.-]*:` 和 `^//` 再检查 userinfo；补 `//user:pass@host` 反向用例。

#### 2. 严重度：中 — 合并门禁和汇报会把不可信文件名/`--main-ref` 原样打印，能注入固定输出行
- 文件:行：`scripts/model-review/opencode-review.mjs:806-809`、`824-825`、`831-834`、`916`、`1650-1652`
- 问题：`git diff -z --name-only` 保留文件名里的换行；`changedOutside` 按 NUL 切分后把文件名直接拼进 `problems`，再原样逐行打印。`reviewReport` 又把 `gate.lines` 原样并入报告。一个换行文件名就能伪造额外的 `REVIEW_CURRENT` / `REVIEW_OVERRIDE` 行。`--main-ref` 只拒绝以 `-` 开头，带换行的值会进入 `main-ref-missing ${mainRef}` 的输出。
- 证据：
  ```js
  return git(["diff", "-z", "--no-renames", "--name-only", from, to], repo)
    .split("\0")
    .filter((file) => file && !file.startsWith(`${ledgerPath}/`));
  ...
  for (const file of changedOutside(repo, complete.head, head, ledgerPath))
    problems.push(`unreviewed ${file}`);
  ...
  [`REVIEW_NOT_CURRENT ${summary}`, ...problems.map((problem) => `  ${problem}`)];
  ```
  以及：
  ```js
  } else if (key === "--main-ref") {
    options.mainRef = take();
    if (options.mainRef.startsWith("-")) throw new Error("ARG_INVALID --main-ref");
  ```
- 建议：打印前对文件名、`mainRef`、`--repo`/`out` 做单行化（把 `\r`、`\n` 和其他控制字符转义，或统一 `JSON.stringify`）；`--main-ref` 也拒绝换行/控制字符；补“文件名含换行”的反向测试。

#### 3. 严重度：中 — `npm ci` 仍继承整份父环境，且锁文件里的包会执行安装脚本
- 文件:行：`scripts/model-review/opencode-review.mjs:301-309`；`scripts/model-review/opencode-lock/package-lock.json:20`
- 问题：T1 只给 opencode 做了环境白名单；`npmCi` 的 `spawnSync("npm", ...)` 没有传 `env`，Node 默认继承 `process.env`，所以 `GITHUB_TOKEN`、`AWS_SECRET_ACCESS_KEY` 等会进入 npm 及其生命周期脚本。锁文件里 `node_modules/opencode-ai` 明确有 `"hasInstallScript": true`。
- 证据：
  ```js
  const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: prefix,
    encoding: "utf8",
  });
  ```
  ```json
  "hasInstallScript": true,
  ```
- 建议：给 npm 也传一份白名单环境（至少 `PATH`、`HOME`、`TMPDIR`、代理、证书变量）；如果不需要安装脚本，考虑 `--ignore-scripts` 并验证 opencode 二进制仍可用。补一个“父环境有秘密时 npm 子进程看不到”的测试。
- 说明：这不是本 PR 新引入的（旧代码也继承环境），但 T1 的目标是“令牌不进入子进程”，这里仍是缺口。

#### 4. 严重度：低 — `parseUsage` 的“任何文本字段不能带换行”只检查顶层字符串
- 文件:行：`scripts/model-review/opencode-review.mjs:954-956`；写例外记录处 `:868-871`
- 问题：`singleLine` 只遍历顶层值，数组/对象里的字符串不检查。例外记录的 `problems` 是字符串数组；上面第 2 条里的换行文件名会被 `JSON.stringify` 转义成 `\n`，所以 ledger 仍是单行，但 `problems` 里的字符串实际含换行，和“任何文本字段”的说法不符。当前 `problems` 没有被再次渲染，所以还不是直接注入，但这是一个防御缺口。
- 证据：
  ```js
  const singleLine = Object.values(record ?? {}).every(
    (value) => typeof value !== "string" || !/[\r\n]/.test(value),
  );
  ```
  ```js
  JSON.stringify({ at: new Date().toISOString(), mode: "override", cost: 0, head, quote: acceptUnreviewed, problems })
  ```
- 建议：递归检查所有字符串值，或明确只允许标量字段；补嵌套字符串带换行的反向用例。

#### 5. 严重度：低 — `prepareRawDir` 不会收紧已存在目录的权限，测试也只测新建目录
- 文件:行：`scripts/model-review/opencode-review.mjs:1586-1590`；测试 `test/tooling/opencode-review.test.mjs:289-300`
- 问题：只对 `root` 调用了 `chmodSync(root, 0o700)`；`mkdirSync(dir, { recursive: true, mode: 0o700 })` 对已存在的 `round-*` 目录不会改权限，中间目录（repo 摘要、`pr-*`）也不会。因此“原始事件目录权限 0700”只对新建目录成立。测试只新建目录并检查，不能发现“已存在 0777 目录”的情况；甚至去掉 `chmodSync(root, 0o700)`，新建目录仍会是 0700（受 umask 影响），测试也可能照样通过。
- 证据：
  ```js
  export function prepareRawDir(dir, root = join(tmpdir(), "himawari-review-raw")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  ```
- 建议：`mkdirSync` 后对 `dir` 也 `chmodSync(dir, 0o700)`；测试先创建 0777 的 root 和 round 目录，再调用并断言被收紧。

#### 6. 严重度：低 — 合并门禁只看已提交的 `HEAD`，不看工作区
- 文件:行：`scripts/model-review/opencode-review.mjs:812-829`
- 问题：`assertReviewed` 用 `git rev-parse HEAD` 和 `git diff complete.head HEAD`，不检查 `git status` / 工作区 diff。线程可以在有未提交代码改动时先跑出 `REVIEW_CURRENT`，之后再提交并合并，这些改动从未进入门禁比较。规则第 6 条确实写的是“从当前提交读账本”，所以这是设计局限，不是实现与说法不一致；但门禁的承诺容易被误读成“工作区也干净”。
- 证据：
  ```js
  const head = git(["rev-parse", "HEAD"], repo);
  ...
  for (const file of changedOutside(repo, complete.head, head, ledgerPath))
    problems.push(`unreviewed ${file}`);
  ```
- 建议：至少检查 `git status --porcelain` 并提示/拒绝；或在规则里明确“必须先提交所有代码改动，门禁只保证已提交状态”。

#### 7. 严重度：低 — `keepEarlierAttempt` 逐个改名，失败时会留下半套 attempt 文件
- 文件:行：`scripts/model-review/opencode-review.mjs:1032-1046`
- 问题：先找出存在的 suffix，再逐个 `renameSync`；如果第二个 rename 失败（权限、磁盘、路径被占用），第一个已经改走，原 round 目录处于半迁移状态，且这是不可撤销的改名。后续重跑或汇报可能看到不完整的一组文件。
- 证据：
  ```js
  for (const suffix of present)
    renameSync(
      join(roundDir, `${name}${suffix}`),
      join(roundDir, `${name}.attempt-${attempt}${suffix}`),
    );
  ```
- 建议：先把整组文件移到一个临时子目录再改名，或先做全部 rename 的可行性检查；失败时回滚已移动的文件。

#### 8. 严重度：低 — `roundForRun` 对缺少 `head` 的记录不做 head 校验
- 文件:行：`scripts/model-review/opencode-review.mjs:1009-1011`
- 问题：`filter(Boolean)` 会把没有 `head` 的 in-round 记录丢掉；如果这一轮只有这种旧记录/伪造记录，`--round` 可以在不同 `head` 上重跑，和“head 不同就拒绝”的说法不完全一致。脚本自己一直写 `head`，所以主要影响旧账本或被篡改的账本。
- 证据：
  ```js
  const heads = new Set(inRound.map((record) => record.head).filter(Boolean));
  if ([...heads].some((recorded) => recorded !== head))
    throw new Error(`ROUND_HEAD_MISMATCH ${requested} ${[...heads].join(",")} ${head}`);
  ```
- 建议：如果 in-round 记录存在但没有 `head`，直接 `ROUND_CANNOT_VERIFY` 或 `ROUND_HEAD_MISMATCH`，不要静默跳过。

#### 9. 严重度：低 — 门禁把记录目录下任意新文件都当成“记录”，`biome.json` 也整体排除
- 文件:行：`scripts/model-review/opencode-review.mjs:809`；`biome.json:9`
- 问题：`changedOutside` 只按 `${ledgerPath}/` 前缀过滤，记录目录下新增的任意文件都不算未复核；`biome.json` 又把整个 `.agents/reviews` 排除在 lint/format 之外。测试 `:2033-2042` 只覆盖“把代码文件改名进记录目录”，会因原文件删除而报 `unreviewed code.txt`，但“直接新增一个代码文件到记录目录”不会被发现。
- 证据：
  ```js
  .filter((file) => file && !file.startsWith(`${ledgerPath}/`));
  ```
  ```json
  "!!.agents/reviews",
  ```
- 建议：门禁只放行已知记录文件名/模式（`usage.jsonl`、`round-<n>/<model>.{prompt.md,md,stderr.txt,attempt-*.md}` 等），或至少对记录目录下的非记录扩展名报警；补“新增代码文件到记录目录”的反向用例。

#### 10. 严重度：低 — `REVIEW_OVERRIDE_REFUSED only-unreviewed-files` 在“没有完整轮次”等场景下会误导
- 文件:行：`scripts/model-review/opencode-review.mjs:844-849`
- 问题：只要 `reviewRounds >= 3` 且 `overridable` 为假，就统一打印 `only-unreviewed-files`。如果实际问题是 `no-complete-round` 或 `ledger-not-committed`，这个信息没有指出真正原因，线程可能误以为只是“有未复核文件”。
- 证据：
  ```js
  if (problems.length > 0 && acceptUnreviewed && !overridable)
    lines.push(
      reviewRounds < OVERRIDE_MIN_ROUNDS
        ? `REVIEW_OVERRIDE_REFUSED rounds=${reviewRounds} needs=${OVERRIDE_MIN_ROUNDS}`
        : "REVIEW_OVERRIDE_REFUSED only-unreviewed-files",
    );
  ```
- 建议：把 `problems` 一并打印，或按问题类型给不同 reason code。

#### 11. 作者说法与代码不一致的几处
- “每轮存 `<模型>.stderr.txt`”：代码只在 `record.outcome !== "ok" && review.stderr.trim()` 时写（`opencode-review.mjs:1855-1856`）；成功轮没有 `.stderr.txt`。规则文件 `model-review.md:72` 写的是“失败时的报错”，与代码一致，但任务里的说法不准确。
- “每次使用前再核对已装的每个包的 sha512”：代码比较的是 `node_modules/.package-lock.json` 里记录的 `integrity` 与提交锁文件的 `integrity`（`:282-298`），并不重新计算已装文件的 sha512。规则文件 `model-review.md:62` 已明确承认“不重新计算已装文件的摘要”，所以这是说法不精确，不是代码缺陷。
- “不一致报 `OPENCODE_INTEGRITY_MISMATCH`”：复用已有安装时若不一致，先打印 `OPENCODE_REINSTALL` 并重装一次，重装后仍不一致才报 `OPENCODE_INTEGRITY_MISMATCH`（`:324-331`）。规则文件也这样写，任务里的说法省略了重装步骤。
- “测试文件里 `stops reading near the time limit` 本 PR 没碰”：`git log` 显示该测试由 #256（`1b91bd38`）改过，而 #256 通过合并 main 进入了本次 `bd0859a..c6d132f1` 的 diff 范围；如果“本 PR”指分支自己的提交，这个说法成立，但按 diff 范围看它确实变了。

### 推测/未核实
- **共享临时目录的多用户冲突（未核实）**：`prepareRawDir` 对固定的 `tmpdir()/himawari-review-raw` 调 `chmodSync(root, 0o700)`。如果另一个用户先创建了这个 root，当前用户 chmod 可能 `EPERM`，脚本会在开跑前失败。云端容器通常单用户，Mac 上也通常单用户，所以未验证。
- **`recordText` 不处理 `\r`（未核实）**：`recordText` 只去掉行尾空格/制表符（`:1582-1584`），不处理 CRLF。如果模型输出 `\r\n`，`.md` 里会留下 `\r`，可能触发 `git diff --check`。没有实际模型输出来验证。
- **方案模式的 webfetch SSRF/云元数据（未核实，且不是本 PR 新引入）**：`plan`/`plan-review` 允许 webfetch/websearch（`:103-104`），环境白名单不阻止网络访问。网页内容可能诱导模型读取云元数据地址；这超出本 PR 的“环境变量”修复范围，但属于残留安全风险。
- **SHA-256 仓库（未核实）**：`COMMIT_PATTERN` 固定 40 位十六进制（`:922`），若仓库使用 SHA-256，脚本自己写的 `head` 会被 `parseUsage` 拒绝。本仓库目前是 SHA-1，未验证其他仓库。
- **`roundForRun` 只校验本次选中的模型提示词（测试有意允许）**：`test/tooling/opencode-review.test.mjs:2377` 明确允许“另一个模型的 prompt 变了”仍重跑当前模型。若记录目录里另一个模型的 prompt 文件被篡改，本轮不会被发现；是否算问题取决于“一轮只要求当前模型提示词一致”的设计。

### 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可逆操作）
- **环境变量泄露**：`runOpencode` 使用 `opencodeEnv(process.env)` 白名单（`:431-435`、`:538-556`）；自检有 `REVIEW_PARENT_CANARY` 探针（`:1129`）和 `/proc/self/environ` 读取探针（`:1115-1117`）。结论：opencode 侧的白名单和探针逻辑成立；`npm ci` 仍继承环境，见上面第 3 条。
- **代理凭据**：检查了 `proxyCredentialProblems` 和测试；发现 `//user:pass@host` 漏检，见第 1 条。
- **不可信文件名**：检查了 `git diff -z`、`changedOutside`、`problems` 输出、`reviewReport`；发现换行注入，见第 2 条；嵌套换行未被 ledger 校验，见第 4 条。
- **记录目录隐藏**：`prepareCopy` 用 sparse checkout 去掉 `.agents/reviews` 并写 `.git/info/attributes`（`:1544-1546`）；git 替身拒绝含 `agents/reviews` 的参数及 `-a`/`--text`/`--binary`（`:359`、`:371-386`、`:45-63`）。结论：diff/show 路径的隐藏成立；`git log --raw` + `git show <blob>` 的已知局限作者已承认，未再发现新的直接读文件绕过（`HEAD:./.agents/reviews/...` 这类路径我实测 git 不接受中间的 `./`，但未穷举）。
- **资源耗尽**：`assertReviewed` 用 `maxBuffer: 1 << 28` 读 ledger/diff（`:800-801`）；超大 ledger 可能让 `git show` 返回非零，从而被误报成 `ledger-not-committed`，而不是明确错误。`parseUsage`/`readUsage` 没有大小上限；这是低风险，未构造极端输入。
- **不可逆操作**：`npmCi` 会先 `rmSync(prefix, { recursive: true, force: true })`（`:301-303`）；`keepEarlierAttempt` 逐个 rename（`:1032-1046`）。前者是设计上的“删掉重装”，后者失败时会半迁移，见第 7 条。
- **合并门禁绕过**：检查了 `assertReviewed` 的 override 范围、轮数、祖先、main 合并、记录目录过滤；`overridable` 确实只允许 `unreviewed ` 前缀的问题（`:840-843`），已提交的 override 也走同一条件（`:850-860`）。未发现“main 未合进分支仍被 override 放过”的代码路径；测试 `:1992-2031` 覆盖了写入路径和已提交路径，但“已提交 override + main 未合并”这个组合没有直接测试（代码看起来仍会拒绝）。
- **工作区状态**：门禁只看 HEAD，见第 6 条。

### 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 对同一个模型的一次会话：不会。新增的 `MODEL_LENSES` 被插在固定提示词里（`buildPrompt` 的 `fixed` 数组，`:198-208`），对同一个模型是常量；它放在“本次材料”之前，但同一模型每轮相同。真正的每轮变化值（`head`、`base`、`previous`、`brief`、`questions`）都在 `material`/用户提示词里；`WRAP_UP_PROMPT` 通过 `--session` 追加在末尾（`reviewModel` 的第二次 `runOpencode`，`:726-738`）。
- 工具定义没有因为 lens 改变；追问配置只改权限和 `steps`（`reviewConfig({ wrapUp: true })`，`:114-119`），没有改工具 schema。自检的 `expectAppendedTo` 也覆盖了追问只追加。
- 但要注意：lens 是**按模型不同**的，两个模型的提示词前缀不同；这不是“同一段已发内容被改写”，因为每个模型是独立会话。相对旧版脚本，lens 会让新会话的开头变化一次；按规则这是新会话，不会让进行中的会话缓存失效，但如果同一个模型在 PR 中途升级脚本，它的下一轮会换前缀（新会话，可以接受）。
- 结论：满足“只追加”和“变化值在最后一条消息”的规则；没有发现把时间、本轮记忆等变化值放进系统提示/工具定义的做法。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？**

- 没有发现。提示词由固定文本、lens、从提交里读出的 questions、`head/base/previous` 和 `recordText` 处理后的 brief 组成；同一模型、同一输入下是确定的。`recordText` 只按行去尾部空格/制表符并补一个换行（`:1582-1584`），不依赖前后文。
- ledger 里的 `at: new Date().toISOString()` 会每次变化，但它只写进 `usage.jsonl`，不发给模型；`promptSha256` 也是派生的，不发给模型。
- 两个模型因为 lens 不同会收到不同字节，这是按模型固定的差异，不是同一段文字在不同请求里随机变化。
- 结论：对同一模型/同一轮，未发现同一段文字变成不同字节的路径；没有遮盖逻辑参与提示词。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 有大量自动检查：`test/tooling/opencode-review.test.mjs` 覆盖了环境白名单（`:849-908`）、`REVIEW_PARENT_CANARY` 探针（`:531-545`）、`/proc/self/environ` 探针（`:461-467`）、安装/摘要（`:744-802`）、`--round` 各拒绝条件（`:2347-2397`、`:2567-2611`）、attempt 改名（`:2539-2565`）、记录目录隐藏（`:1075-1114`）、合并门禁（`:1922-2148`）、override 范围/轮数（`:1992-2031`、`:2104-2148`）、ledger 字段校验（`:2307-2333`）、汇报一致性（`:2182-2263`）、代理凭据（`:2487-2537`）、原始目录权限（`:289-300`）等。
- 但从读代码看，反向用例有这些缺口：
  - 代理凭据没有 `//user:pass@host` 用例，而代码确实漏检（第 1 条）。
  - `prepareRawDir` 只测新建目录；把 root 预先建成 0777、把 round 目录预先建成 0777 的用例没有，且去掉 `chmodSync(root, 0o700)` 这个新建用例也可能照样通过（第 5 条）。
  - `parseUsage` 只测顶层 `outcome` 带换行；嵌套 `problems` 带换行的用例没有，代码也不拒绝（第 4 条）。
  - 合并门禁输出没有“文件名含换行/控制字符”的用例（第 2 条）。
  - “已提交 override + main 未合并”没有直接组合用例；代码共用 `overridable` 看起来会拒绝，但反向验证没有直接覆盖。
  - `npm ci` 的环境继承没有测试（第 3 条）。
  - `keepEarlierAttempt` 中途 rename 失败没有测试（第 7 条）。
  - `roundForRun` 记录缺少 `head` 的情况没有测试（第 8 条）。
- 结论：主要声称的反向用例（例外范围、已提交例外的轮数、单行字段、提交哈希、mode 校验、目录权限的新建场景、ref 以 `-` 开头）有对应测试；但上述缺口意味着“反向用例真的会失败”只对这些已覆盖项成立，不能覆盖全部声称的行为。
