## 结论

我没有修改任何文件，也没有运行除 git 之外的命令；PR 声称的测试执行结果（OVH VPS 上 26 例/40 步）我无法复现，标为「未核实」。下面先按严重度列问题，再分「读代码证实／推测」，最后逐条回答必答问题。

---

### 问题清单（按严重度）

#### 1. 中 — 第一个用例改为读工作区后，验证对象从「提交的 HEAD」漂移成「未提交的工作区」，可被本地改动掩盖

- 文件：`test/tooling/security-review.test.mjs:306-310`、`:324`、`:348-352`
- 代码证实：
  ```js
  const manifestBytes = readFileSync(join(root, ".github/security-review-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const { commentId } = JSON.parse(
    readFileSync(join(root, ".github/security-review-comment.json"), "utf8"),
  );
  ...
  manifestSha256: digest(manifestBytes),
  ...
  const { options, run } = committedReview(resolve("."));   // 第一个用例
  const result = loadReviewedExceptions(options);
  const committed = JSON.parse(run("show", "HEAD:ci/security-exceptions.json")).exceptions;
  ```
- 问题与对你特别提问的回答：主检出里 `.github/security-review-manifest.json` 有未提交改动时，摘要按工作区字节算，`loadOwnerReview` 也读工作区字节（`scripts/ci/security-owner-review.mjs:124-126` `const bytes = readFileSync(path)`），两端一致，**不会再出现第 2 轮那种 `SECURITY_REVIEW_SCOPE_MISMATCH` 的误报**；同时 `committedReview` 的 `context` 不含 `event`（`:331`），`loadOwnerReview` 的 PR 事件分支（`security-owner-review.mjs:153-159`）不会进入，所以脏清单不会导致失败。结果是：只要脏清单本身 schema 合法、没引入重复，第一个用例照常通过，但它断言的是**工作区**而不是 HEAD 的复核清单；若有人把某条从工作区清单里删掉，HEAD 里真实存在的「例外清单与复核清单重复」可以被这个用例掩盖。
- 缓解：第二个用例确实先做了一次干净加载（`:364-365`，克隆后 `checkout HEAD -- ci .github` 再 `committedReview`），因此「重复检测逻辑」本身仍有反向覆盖；但第一次加载用的是克隆得到的 HEAD，是否为待测分支 HEAD 见问题 2。
- 建议：第一个用例要么像第二个用例一样先从 `git show`/临时检出取得干净的 HEAD 字节再构造审批，要么在读工作区字节时额外断言工作区清单与 HEAD blob 相同（不一致就跳过或明确标注「按工作区验证」）。至少应在测试名或断言里说明它验证的是工作区状态。

#### 2. 中（条件性，推测）— 在 `.agents/local/worktrees/` 的 linked worktree 里运行新步骤时，`git clone resolve(".")` 的行为未核实

- 文件：`test/tooling/security-review.test.mjs:356-364`
- 代码证实：
  ```js
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", resolve("."), root], {
    env: isolatedGit,
  });
  ...
  run("read-tree", "HEAD");
  run("checkout", "HEAD", "--", "ci", ".github");
  const { options } = committedReview(root);
  ```
- 问题：工作目录就是 linked worktree 时，`resolve(".")` 根目录下 `.git` 是文件而非目录。`git clone` 能否从 linked worktree 克隆、以及克隆后的 `HEAD` 究竟是该 worktree 的分支还是主仓库的 `HEAD`，我无法在只读工具限制下运行验证。若克隆失败，新接入的 `npm run check` 会在所有 `.agents/local/worktrees/` 场景下直接红；若克隆到的是主仓库 `HEAD`，则第二个用例在注入前的干净加载（`:365`）校验的是主分支而不是待测分支，覆盖会出现缺口。
- 建议（未核实前）：把克隆来源改成明确的 `git -C <root> rev-parse --git-common-dir` 对应的仓库，或用 `git clone <common-dir 的父目录>`；或在测试里断言克隆后的 `HEAD` 等于 `resolve(".")` 的 `rev-parse HEAD`，明确覆盖到当前工作副本。该条依赖实机执行确认。

#### 3. 低 — 文件接进 `npm run check` 后，旧的 `fixture()` git 命令仍读本机全局/系统配置

- 文件：`test/tooling/security-review.test.mjs:21-28`
- 代码证实：
  ```js
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic Fixture");
  ...
  git("commit", "-qm", "synthetic accepted policy");
  ```
- 问题：作者说的是「新测试里所有 git 命令」带隔离，新增的 describe 块确实满足（`:292-300` 的 `gitIn` 与 `:358-360` 的 clone 都带）；但这次把整个文件接进了 `npm run check`，文件前半部分既有的 `fixture()` 仍不带 `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`。若开发者全局配置了 `commit.gpgsign=true` 或强制模板等，`git commit` 会失败，新步骤照样会红。第 2 轮「临时 git 命令会读本机全局配置」的动机在文件层面只修了一半。
- 建议：让 `fixture()` 也复用同一个 `isolatedGit`（以及 clone 用的隔离 env），或在文件顶部统一一个带隔离的 `git` 工厂。

#### 4. 低（信息）— `isolatedGit` 复制了整个 `process.env`，仍可能继承 `GIT_DIR` 等注入

- 文件：`test/tooling/security-review.test.mjs:292`
- 代码证实：`const isolatedGit = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };`
- 问题：它只覆盖 system/global 配置，仍会继承 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_KEY_*` 等。生产代码 `scripts/ci/security-exceptions.mjs:24-29` 的 `git()` 用的是白名单式 env（只留 `PATH` 等），更彻底。作者声明的「带这两个变量」成立，但「不读本机全局配置」并不等于完全隔离。
- 建议：与生产 `git()` 保持一致，用固定 env 而不是 `...process.env`。

#### 5. 低（信息）— 本地浅克隆会因历史依赖失败；CI 已 `fetch-depth: 0`，不构成阻断

- 文件：`scripts/ci/security-owner-review.mjs:204-209`（`merge-base --is-ancestor`）、`test/tooling/security-review.test.mjs:313`（`git log`）
- 代码证实：`.github/workflows/ci.yml` 各 job 的 checkout 都是 `fetch-depth: 0`。
- 问题：新步骤依赖 `manifest.sourceHead` 在当前历史中可达（`merge-base --is-ancestor`）。CI 全历史没问题；但若在浅克隆里跑本地 `npm run check`，会报 `SECURITY_REVIEW_SOURCE_UNRELATED`。这不是本次 diff 引入的代码逻辑，而是把它接进本地检查后新增的运行前提。
- 建议：如需支持浅克隆，测试里先 `git fetch --unshallow` 或明确说明本地检查需要完整历史；否则在文档/`AGENTS.md` 里记一句运行前提即可（不阻断）。

#### 6. 说明 — 作者说法 4 无法核对

- 「26 个用例全过 / 旧 main 27e1d332 报 `SECURITY_EXCEPTION_DUPLICATE` / 40 步全过」：只能确认静态事实——`check:steps` 现为 40 步（逐项数过，新增 `check:security-review` 后由 39 变 40），且反向用例逻辑成立（见问题清单末尾与必答问题 3）。实际运行结果：**未核实**。

---

### 读代码证实的 / 推测的分界

读代码证实：

- 增量 diff 只有三个文件：`package.json`、`test/tooling/run-all-checks.test.mjs`、`test/tooling/security-review.test.mjs`（`git diff b0210b63..82e3616d --stat`）。
- 新脚本内容与 `check:check-runner` 同构，仅换测试文件；`check:steps` 里位置正确（`package.json:27`、`:41`）。
- `run-all-checks.test.mjs:65-68` 同时断言「在 `check:steps` 里」和「脚本内容逐字不变」。
- 新 describe 块的 `gitIn` 与 clone 都带 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（`:292-300`、`:358-360`）。
- 复核清单与评论编号改读工作区文件，摘要按工作区原始字节算（`:306-310`、`:324`）。
- 第二个用例确实先 `read-tree` + `checkout HEAD -- ci .github` 再构造审批（`:362-364`）。
- `npm run check` 的 runner 用 `stepNames` 正则 `^npm run (\S+)$`，`check:security-review` 能通过（`scripts/run-all-checks.mjs:7-11`）。
- `loadReviewedExceptions` 同时读取工作区候选文件和 baseSha 的 blob（`security-exceptions.mjs:204-209`），最后合并 owner review 并再次校验（`:216-222`），重复 identity 在 `:184` 抛 `SECURITY_EXCEPTION_DUPLICATE`。
- 第二个用例注入的是 owner review 生成的 `synthetic-secret` 条目，其字段满足 `ci/security-exceptions.schema.json` 的 required/additionalProperties（含 `provenance.current/history`），能写入例外清单。

推测（未核实）：

- linked worktree 里 `git clone` 是否成功、克隆的 `HEAD` 是哪个分支（问题 2）。
- OVH VPS 上的实际通过数和旧 main 的失败（作者说法 4）。
- 生产代码 `loadOwnerReview` 的 `acceptedBytes`（`security-owner-review.mjs:138-147`）仍未隔离全局配置，但本改动没有触碰它；它是否会被本机配置影响，未核实。

---

### 侧重检查

- **错误路径**：第二个用例如果在 `clone`/`checkout`/`commit` 任一步失败，`afterEach` 仍会清理（`roots.push(root)` 在克隆之前，`:356-357`），不会残留临时目录。`committedReview` 读不到 `.github/security-review-manifest.json` 或 comment 文件时会在 `readFileSync` 直接抛错，测试失败——在标准 checkout 里文件是受跟踪的，正常存在；稀疏检出未核实。
- **不可信输入**：测试的 `readReviewComment` 是本地桩函数，不联网；manifest/comment 来自仓库文件，属受控输入。没有引入网络依赖，符合作者「测试不得联网」的约束。
- **安全**：没有把清单内容、token 或评论正文写入日志；摘要比较仍是字节级 `sha256`。`GIT_CONFIG_GLOBAL=/dev/null` 在 POSIX 上成立，Windows 上不成立，但仓库既有代码已用同样写法（`security-exceptions.mjs:27`），不是本次新问题。
- **资源耗尽**：每次 `npm run check` 多一次 `git clone --shared`（不复制对象库）和一次临时提交，`afterEach` 删除临时目录；开销可接受。`git log`/`git show` 有 `maxBuffer`（生产 `git()` 设了 16 MiB），测试内的 `gitIn` 没有设 `maxBuffer`，在本仓库规模下不构成问题，但属于潜在上限差异。
- **不可撤销操作**：只对临时目录和临时克隆做写操作，不改工作区受跟踪文件；无不可撤销行为。
- **规则/文档一致性**：`check:security-review` 只出现在 `package.json` 和 `run-all-checks.test.mjs`，没有需要同步维护的清单文档；`docs/incidents-and-gates.md` 里对 `check:steps` 的描述是历史记录，不要求随步数更新，未发现文档与代码不一致。I-73 的教训（新 id 要能过消费端校验）在新步骤上成立：`stepNames` 接受 `check:security-review`，runner 与测试两端一致。

---

### 逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头（系统提示、工具定义、历史、遮盖结果）？**
不会。本次 diff 只改 `package.json` 的检查步骤和 `test/tooling/*.test.mjs`，没有任何系统提示、工具定义、历史组装、出口遮盖或压缩代码。发给模型的内容没有新增、重排或改写，仍只在末尾追加、每轮变化值仍在最后一条消息——这一点由现有 `check:prompt-prefix` 继续保证，本改动不触碰。依据 `.claude/rules/prompt-prefix.md` 第 4、10 条。

**2. 会不会让同一段文字在不同请求里变成不同的字节（依赖前后文的遮盖、带时间的字段、无序集合）？**
不会。改动不涉及模型请求的序列化。测试自身的确定性也成立：`reviewedAt` 优先取已提交的 `proposal.proposedAt`（`security-review.test.mjs:311-314`），不读系统时钟；`approval` 用 `JSON.stringify` 生成、摘要用原始字节；临时提交的时间戳只进入一次性仓库，不参与断言。唯一与「不同字节」相关的是摘要来源从 HEAD blob 改成了工作区字节，但这只影响测试，不影响发给模型的任何内容。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，且接到了本地门禁：
- `run-all-checks.test.mjs:65-68` 断言 `check:security-review` 在 `check:steps` 中且脚本内容逐字等于预期，删掉或改掉都会失败。
- 新增文件本身现在会被 `npm run check` 执行；其第二个用例就是反向用例：把复核清单已覆盖的条目再写进例外清单并提交，要求抛 `SECURITY_EXCEPTION_DUPLICATE`（`:355-386`）。如果把 `security-exceptions.mjs:184` 的重复断言删掉，这条会失败。
- 作者说「放到旧 main 27e1d332 上会报 `SECURITY_EXCEPTION_DUPLICATE`」是一次性人工验证，不是常驻反向用例，且我无法运行，**未核实**。
- 小缺口：`run-all-checks.test.mjs` 只断言「包含」，不断言顺序（作者也只声称「在 `check:steps` 里、内容不变」，未超出）；顺序本身不影响正确性。

**4. 改动产生或修改的每个值，使用方都能接受吗？**
逐个核对过：
- 新配置键 `check:security-review`：产生于 `package.json:41`；使用方一是 `check:steps`→`scripts/run-all-checks.mjs:6-11` 的 `stepNames`（正则接受冒号，接受）；二是 `test/tooling/run-all-checks.test.mjs:65-68`（断言字符串完全一致，接受）。两端一致。
- `check:steps` 新增项：`stepNames` 接受，runner 会按序执行；40 步与作者说法一致。
- 复核清单/评论的读取来源改为工作区：`loadOwnerReview` 本来就读工作区（`security-owner-review.mjs:120-126`），所以摘要一致性反而变好；代价见问题 1（不再验证 HEAD）。
- 摘要字节来源：`digest(manifestBytes)` 与 `loadOwnerReview` 的 `sha256(readFileSync(path))` 对齐，接受。
- 第二个用例写入例外清单的条目：满足 schema 的 required 与 `additionalProperties: false`（已核对 `ci/security-exceptions.schema.json`），`provenance` 的 `current/history` 计数与 `count` 一致，能通过 `validateSecurityExceptions`。
- 唯一需要留意的是问题 1 的「工作区 vs HEAD」两端不是同一个来源；它不是校验不通过，而是覆盖面漂移。
