下面按“侧重检查 → 读代码证实的发现 → 推测/未核实 → 必答问题”的顺序给出结论。未发现严重（高）问题；改动只涉及文档、`package.json` 的检查清单、一个只读检查脚本、一个记录文件和其测试，不触碰模型请求路径。

## 侧重检查

查过的路径与结论：

- **错误路径**：记录文件不存在、bootstrap 不存在时脚本早退并报 `PROBE_SOURCES_RECORD_MISSING` / `PROBE_BOOTSTRAP_MISSING`（`scripts/check-probe-sources.mjs:14,17`）；但 JSON 损坏、`files`/`bootstrap`/`source` 字段缺失会抛未捕获异常；`files: []` 会误判通过。见下面「中-3」。
- **不合规范/不可信输入**：bootstrap 摘要是用正则从源码文本里抠出来的，且与上线包检查各写一份同样的正则；不符合 `[a-z-]+\.js` 的新文件会被两边同时漏掉。见「中-2」。
- **安全**：脚本只读文件、只算 SHA-256，不写文件、不联网、不执行部署操作，无不可撤销操作；错误信息只打印摘要前 12 位，不泄露秘密。
- **资源耗尽**：`readFileSync` 把整个文件读入内存，`record.bootstrap` 和 `files[].source` 又来自记录文件、可用 `..` 逃出仓库根；记录文件在仓库里、受评审约束，风险低，但属于可加固点。见「低-2」。
- **规则/文档/代码一致**：`I-78`、`I-79` 两行的编号、日期、状态、次数能被 `scripts/check-incident-gates.mjs:46-70` 接受；门槛里反引号路径都真实存在；`check:probe-sources` 已进 `check:steps`，`run-all-checks.mjs` 的 `^npm run (\S+)$` 能解析；`.claude/rules/incident-gates.md:16` 要求“在事故复现上会失败、原因去除后通过”的证据写进提交说明，提交说明里有 Hermes 复现和 `npm run check` 结果。
- **I-79 的门槛**：读代码确认 `run-release-walkthrough.sh --preflight` 依次检查 Node、锁定 Python、浏览器、`$toolbin/fd`、`rg`、`git -C "$source" rev-parse HEAD`（`scripts/delivery-mode/hermes/run-release-walkthrough.sh:17-22`），而 `builder.json` 里 `source`、`piToolBin` 正是 `/home/andy/himawari-tests/r2-u1/...`；`make-packet.py` 在构建前调用它（`make-packet.py:862-865`，构建在 `:880`）。整目录被删时确实会被 `PI_TOOL_MISSING` 或 `SOURCE_MISSING` 拦下。注意它只查“存在/可用”，不查子树完整或提交号，这点和事故描述一致。
- **模型请求**：改动文件仅 `docs/incidents-and-gates.md`、`package.json`、`scripts/check-probe-sources.mjs`、`scripts/delivery-mode/probe-sources.json`、`test/tooling/probe-sources.test.mjs`（`git show --stat`），没有系统提示、工具定义、历史、遮盖相关代码。

## 读代码证实的问题（按严重度）

### 中-1：检查能被“只更新源码摘要”满足，构建摘要不刷新也能通过

- 文件:行：`scripts/check-probe-sources.mjs:27-41`，`scripts/delivery-mode/probe-sources.json:6-20`
- 问题：检查只做两组“相等”比较，不建立 `sourceSha256` 与 `builtSha256` 之间的任何关系。源码改动后，开发者只要把记录里的 `sourceSha256` 改成本地源码的摘要，`builtSha256`/bootstrap 保持旧值，检查就会通过；但真实构建产物已变，上线包仍会在 Hermes 上晚些时候报 `PROBE_DIGEST_STALE`。这正是 I-78 想提前发现的场景。
- 证据（亲自读到）：
  - `scripts/check-probe-sources.mjs:27-31`
    ```js
    for (const file of record.files) {
      if (recorded.get(file.built) !== file.builtSha256)
        problems.push(
          `PROBE_BUILT_DIGEST_MISMATCH ${file.built} bootstrap=${recorded.get(file.built) ?? "absent"} record=${file.builtSha256}`,
        );
    ```
  - `scripts/check-probe-sources.mjs:37-41`
    ```js
    const actual = sha256(readFileSync(sourcePath));
    if (actual !== file.sourceSha256)
      problems.push(`PROBE_SOURCE_CHANGED ... now=${actual.slice(0, 12)}`);
    ```
  - 两处比较互相独立，没有任何“源码变了则构建摘要也必须变”的判断。
- 建议：把两个摘要绑定起来，例如检查脚本读取基线提交里的旧记录（`git show <base>:scripts/delivery-mode/probe-sources.json`），若当前 `sourceSha256` 与基线不同，则要求 `builtSha256` 以及 bootstrap 摘要也与基线不同；或在记录里加入 Hermes 构建的身份/产物摘要并要求随之变化。至少应在错误提示和文档中明确“只改 `sourceSha256` 会让门槛失效”。

### 中-2：摘要解析正则与文件集合在多处重复，不符合命名的新文件会被静默漏掉

- 文件:行：`scripts/check-probe-sources.mjs:20-26`，`scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98-100`，`scripts/delivery-mode/packet-template/measurement/probe/read-driver.mjs:25`
- 问题：三个消费者各自维护“哪三个文件”的集合；新检查用 `[a-z-]+\.js` 从 bootstrap 文本里抠条目。若以后探针多认一个名字带数字/大写/下划线/多个点的文件（例如 `sandbox-sdk2.js`、`foo_bar.js`），新检查的 `PROBE_SOURCE_UNLISTED` 不会触发，上线包检查的同一正则也不会认它，`read-driver.mjs` 的硬编码三文件列表也不会更新。作者宣称的“bootstrap 认的每个文件都有记录”因此不是全称保证。
- 证据（亲自读到）：
  - `scripts/check-probe-sources.mjs:20-26`
    ```js
    ...readFileSync(bootstrapPath, "utf8").matchAll(/^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$/gm),
    ```
    ```js
    const listed = new Set(record.files.map((file) => file.built));
    for (const name of recorded.keys())
      if (!listed.has(name)) problems.push(`PROBE_SOURCE_UNLISTED ${name}`);
    ```
  - `check-packet-consistency.py:98-100`
    ```python
    originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))
    if not originals:
        problems.append('PROBE_ORIGINALS_NOT_FOUND')
    ```
  - `read-driver.mjs:25` 仍然硬编码 `["job-host-main.js", "sandbox-sdk.js", "sandbox-sdk-worker.js"]`。
- 说明：对当前这三个文件名，正则都能匹配；如果只是把 bootstrap 的格式改成单引号、跨行、对象展开等，因记录里仍有这三项，`recorded.get(...)` 为 `undefined`，会报 `PROBE_BUILT_DIGEST_MISMATCH`，不会静默通过——所以风险集中在“新增文件名不符合正则”这种情况。
- 建议：让摘要表只有一个来源，例如把 digest 放进一个 JSON 文件，bootstrap 和两个检查脚本都读它；或至少放宽正则并在解析后断言“解析出的键集合等于记录中的 `built` 集合、且非空”，同时让 `read-driver.mjs` 也从同一来源取文件名。

### 中-3：记录损坏/字段缺失不是清楚的失败；空 `files` 会误判通过

- 文件:行：`scripts/check-probe-sources.mjs:15,16,24,32,40`
- 问题：
  - 记录 JSON 语法错误：`JSON.parse` 抛出未捕获 `SyntaxError`，只有堆栈，没有 `PROBE_*` 错误码。
  - `bootstrap` 缺失：`path.join(root, undefined)` 抛 `TypeError`。
  - `files` 缺失/不是数组：`record.files.map` 抛 `TypeError`。
  - `files[].source` 缺失：`path.join(root, undefined)` 抛 `TypeError`。
  - `files[].sourceSha256` 缺失且摘要不符：`.slice` 抛 `TypeError`。
  - `files: []`：不进入任何循环、`problems` 为空，检查直接 `PROBE_SOURCES passed`，这是真正的误判通过。
- 证据（亲自读到）：
  ```js
  15:   const record = JSON.parse(readFileSync(recordPath, "utf8"));
  16:   const bootstrapPath = path.join(root, record.bootstrap);
  24:   const listed = new Set(record.files.map((file) => file.built));
  32:     const sourcePath = path.join(root, file.source);
  40:         `PROBE_SOURCE_CHANGED ${file.source} recorded=${file.sourceSha256.slice(0, 12)} now=${actual.slice(0, 12)}`,
  ```
- 建议：加一个小校验器，明确要求 `bootstrap` 是非空字符串、`files` 是非空数组、每个条目的四个字段都是字符串、两个摘要满足 `^[0-9a-f]{64}$`，失败时输出 `PROBE_SOURCES_RECORD_INVALID <原因>` 并退出 1；同时保证 `probeSourceProblems` 不抛异常，全部转成问题列表。测试补上损坏 JSON、缺字段、空数组三个反向用例。

### 低-1：CLI 入口的 `file://${process.argv[1]}` 在路径含空格/非 ASCII 时不会执行

- 文件:行：`scripts/check-probe-sources.mjs:46`
- 问题：`import.meta.url` 是经过百分号编码的 file URL，而 `process.argv[1]` 是原始路径。仓库路径含空格或中文时两者不相等，脚本主流程不执行、打印为空、退出 0。直接运行 `node scripts/check-probe-sources.mjs` 会静默什么都不做。好在 `npm run check:probe-sources` 后面还接了 vitest，`test/tooling/probe-sources.test.mjs:55-57` 的仓库自检仍会跑，所以不会造成整体静默通过；但这是可避免的故障排查噪音。
- 证据：
  ```js
  46: if (import.meta.url === `file://${process.argv[1]}`) {
  ```
  同仓库更稳的写法见 `scripts/run-all-checks.mjs:40`：
  ```js
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ```
- 建议：改用 `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`。

### 低-2：记录里的路径未限制在仓库内，且整文件读入内存

- 文件:行：`scripts/check-probe-sources.mjs:15,16,32,37`
- 问题：`record.bootstrap`、`files[].source` 来自仓库内 JSON，`path.join(root, value)` 不阻止 `../`，可以读到仓库外的文件；`readFileSync` 无大小上限，恶意/误写的记录可指向巨大文件或设备文件导致内存/CPU 消耗。由于记录文件本身受评审、脚本只读不算敏感信息，这是加固项而非现实攻击面。
- 证据：
  ```js
  16:   const bootstrapPath = path.join(root, record.bootstrap);
  32:     const sourcePath = path.join(root, file.source);
  37:     const actual = sha256(readFileSync(sourcePath));
  ```
- 建议：用 `path.resolve(root, value)` 并校验 `resolved.startsWith(path.resolve(root) + path.sep)`；用流式 `createHash` 读取，顺便避免大文件整读。

### 低-3：测试覆盖了三个错误码，但没覆盖损坏记录和全部三个源码文件

- 文件:行：`test/tooling/probe-sources.test.mjs:63-82`
- 问题：`[probe-digest-stale]` 只对 `job-host-main.ts` 做源码变化用例；另外两个源码文件依赖同一循环，逻辑上会一起报错，但没有参数化验证。没有损坏 JSON、字段缺失、`files` 为空、`source` 文件不存在、非规范文件名等用例。与「中-3」「中-2」的缺口对应。
- 证据：
  ```js
  63:   it("[probe-digest-stale] fails when a sandbox source changes after the digests were recorded", () => {
  64:     const root = fixture({ recordedSource: digest("export const host = 0;\n") });
  ...
  79:   it("fails when the bootstrap instruments a file the record does not list", () => {
  80:     const root = fixture({ extraBootstrap: `  "sandbox-sdk.js": "${"c".repeat(64)}",\n` });
  ```
- 建议：把源码变化、bootstrap 摘要变化、缺失源码、损坏/缺字段记录做成表驱动用例；`UNLISTED` 用例再补一个名字不符合正则的探针条目（用于暴露当前盲区）。

## 推测 / 未核实

- **源码摘要值未直接核实**：我无法运行 SHA-256（工具只允许读、查和指定 git 命令）。`probe-sources.json` 里的 `sourceSha256` 是否等于当前三个 `.ts` 文件的真实摘要，只能靠 `test/tooling/probe-sources.test.mjs:55-57` 的“仓库自检”用例保证；提交说明称该测试在 Hermes 上通过，但本次未运行。
- **`43423b9e` 的 ancestry 未核实**：`git show -s` 显示它是 PR #213 的合并提交；#234（`12c8bfb7`）的直接父提交是 `f2d91e6f`（#236），不是 `43423b9e`。它在时间上可能早于 #234，但“#234 之前”需要 `merge-base` 才能确认，我没运行。
- **tsc 逐文件输出（推测，依据较足）**：`package.json:20` 的 `build:node` 用 `tsc -p tsconfig.node-build.json`，仓库证据里能看到独立的 `dist/job-command.js`、`dist/network-egress.js`、`dist/policy.js`，所以我判断当前构建不是 bundle，三个入口 `.ts` 各自对应一个 `.js`，只哈希这三个源码文件对这三个产物是够的。若构建方式改成打包（bundler 内联依赖），该检查会漏掉被内联依赖的变化。
- **I-78 文档措辞（推测为可接受）**：“源码一改指纹就报 `PROBE_SOURCE_CHANGED`”严格说只对记录里的三个源码文件成立；修改 `packages/runtime-sandbox/src/` 下其它文件不会触发。结合当前 tsc 逐文件构建，这是合理的，但文档最好写成“这三个源码文件之一改动”。
- **`npm run check` 全量结果未核实**：未运行（工具限制）。提交说明称 34 步全过、5 个用例通过。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。`git show --stat` 显示本次只改 5 个文件：`docs/incidents-and-gates.md`、`package.json`、`scripts/check-probe-sources.mjs`、`scripts/delivery-mode/probe-sources.json`、`test/tooling/probe-sources.test.mjs`。这些都不在系统提示、工具定义、历史消息、资料块、遮盖或压缩的组装路径上。发给模型的内容仍然只追加；每轮会变的值仍只应放在最后一条消息里，本次没有新增进入请求头的值。依据 `.claude/rules/prompt-prefix.md:27-35`，本次改动不触发其中任何一条。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。改动只对仓库里的静态文件算 SHA-256 并构造静态记录；没有时间字段、随机数、依赖前后文的遮盖，也没有把无序集合写进请求。`record.files` 是数组、`Map` 只用于生成诊断信息顺序；这些顺序不进入模型请求。脚本里唯一“可变”的是文件内容，而文件内容本身不由本改动生成。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有。`package.json:27` 把 `check:probe-sources` 加进 `check:steps`，`package.json:37` 让它先跑脚本再跑 `test/tooling/probe-sources.test.mjs`；`run-all-checks.mjs` 会按清单执行。
反向用例按代码逻辑确实会失败：
- `test/tooling/probe-sources.test.mjs:63-70`：记录的源码摘要与当前源码不同 → `actual !== file.sourceSha256` → `PROBE_SOURCE_CHANGED`。
- `:72-77`：bootstrap 摘要改成 `b`、记录仍是 `a` → `recorded.get(...) !== file.builtSha256` → `PROBE_BUILT_DIGEST_MISMATCH`。
- `:79-82`：bootstrap 多出未记录的 `sandbox-sdk.js` → `listed` 不含它 → `PROBE_SOURCE_UNLISTED`。

不足：没有覆盖损坏记录、空 `files`、非规范文件名（见「中-2」「中-3」）；`[probe-digest-stale]` 只测了一个源码文件。测试未在本机运行，以上是按代码路径推演。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐个核对如下（均读代码确认）：

- `probe-sources.json` 的 `bootstrap` 路径：生产方是记录文件，消费方是 `check-probe-sources.mjs:16`。路径存在，且指向真实 `bootstrap.mjs`；但消费方不做“字段存在/是字符串”的校验（见「中-3」）。
- `files[].built` / `builtSha256`：生产方是记录文件，消费方是 `check-probe-sources.mjs:24-31`（与 bootstrap 摘要比对）和 bootstrap 自身的 `originals`（`bootstrap.mjs:10-14`）。当前三项名字和摘要完全一致：`job-host-main.js`、`sandbox-sdk.js`、`sandbox-sdk-worker.js`，bootstrap 的摘要与记录逐字相同。
- `files[].source` / `sourceSha256`：生产方是记录文件，消费方是 `check-probe-sources.mjs:32-41`。两端的路径/摘要格式一致；摘要值本身未直接验证，由测试的仓库自检兜底。记录里的 `source` 是仓库相对路径，`path.join(root, ...)` 能解析到真实文件。
- `check:probe-sources` 脚本键：消费方是 `run-all-checks.mjs:6-11` 的 `^npm run (\S+)$` 和 `package.json` 的 scripts 查表。名字合法、值是字符串，`check` 能解析执行。
- `check:steps` 新增项：消费方同上；`npm run check:probe-sources` 不含额外 `&&`，不会被错误拆分。
- 三个 `PROBE_SOURCE_*` 错误码：消费方是测试的 `stringMatching`（`test/tooling/probe-sources.test.mjs:65-81`）和人工排错，当前两边一致。
- `I-78` / `I-79` 编号、状态、门槛路径：消费方是 `scripts/check-incident-gates.mjs:46-70`。编号格式、日期、次数（1）、状态（`已落门槛`）、反引号里的真实文件均满足；门槛路径都能被 `existsSync` 找到。`REPOSITORY_PATH` 只要求至少一个真实路径，I-78 有多个、I-79 有 `run-release-walkthrough.sh`，满足。
- 同一组“三个文件名”还被 `check-packet-consistency.py:98-113` 和 `read-driver.mjs:25` 使用；它们与新增记录没有被自动交叉校验，新增第四个文件时需要人工同步，见「中-2」。

未发现“生产者/消费者两端校验不一致”的硬错误；主要缺口是记录字段缺少 schema 校验（中-3）和构建摘要未被强制刷新（中-1）。对作者重点问的三点：正则确实能漏掉不符合 `[a-z-]+\.js` 的新文件；记录损坏多数会失败但不是清楚失败，空 `files` 会误判通过；I-79 的 `--preflight` 对“整个 `r2-u1` 目录被删”确实能拦下。
