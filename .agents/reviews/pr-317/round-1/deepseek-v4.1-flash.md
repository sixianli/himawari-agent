## 结论

按严重度排列。先说读代码能证实的事实，再单独标出推测。

---

### 中：拆分后两个测试文件会并发争用同一个 opencode 安装缓存（冷 HOME 下可能 flaky）

**文件：行**
- `test/tooling/opencode-review.fixtures.mjs:141`（`binary: opencodeBinary()`）、`:165`、`:237`
- `scripts/model-review/opencode-review.mjs:421-423`、`:439-443`、`:463-466`
- `scripts/ci/run.mjs:217-218`
- `scripts/ci/install-tools.mjs:294-301`
- `ci/policy.json:193-197`

**问题**
两个新测试文件都通过 fixtures 调 `opencodeBinary()`，它会装到 `~/.cache/himawari-opencode-...`（`opencode-review.mjs:460`）。`installOpencode` 在缓存不存在时先 `rmSync(prefix)` 再 `mkdirSync` 再 `npm ci`（`:421-423`），全程没有跨进程锁。`policy` 作业固定用 `--maxWorkers 2` 跑 tooling（`run.mjs:217-218`），而 tooling `fileParallelism: true`（`ci/policy.json:196`），所以两个文件会并行。CI 的 HOME 是本次作业新建的隔离目录（`install-tools.mjs:294-301`），即缓存每轮都是冷的。于是两个 worker 可能同时进入 `installOpencode`，一个 `rmSync` 掉另一个正在 `npm ci` 的目录，或一个复用未装完的二进制。拆分前 tooling 里只有 `opencode-review.test.mjs` 一家使用这个共享缓存，现在变成两家；这是拆分引入的新并发面。

**证据**
```js
// opencode-review.mjs:421-423
function npmCi(prefix, lockDir, binary) {
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
```
```js
// opencode-review.mjs:442-443
const reused = existsSync(binary);
if (!reused) npmCi(prefix, lockDir, binary);
```
```js
// install-tools.mjs:295,300
const home = join(directory, "home");
...
HOME: home,
```
```json
// ci/policy.json:193-197
"id": "tooling",
"include": ["test/tooling/**/*.test.ts", "test/tooling/**/*.test.mjs"],
"exclude": [],
"fileParallelism": true
```

**推测（未在 CI 复现）**：是否真的撞上取决于两个文件到达各自第一次 `opencodeBinary()` 的时间是否重叠。主文件第一次共享安装发生在第 46 个用例（`opencode-review.test.mjs:986` 的真实自检），新文件在更早的 wrap-up 用例（`opencode-review-merge-gate.test.mjs:264` 起）。作者在 Hermes 上 164/164 通过不能证伪：这只说明那次没重叠，是时序相关。建议用冷 HOME 跑一次 `policy` 复现。

**建议**：在 `installOpencode` 外加跨进程锁（`mkdir`/`flock` 均可），或在测试 globalSetup 里装一次并把 `HIMAWARI_OPENCODE_BIN` 传给 worker；至少不要让两个文件各自决定重装。

---

### 低：拆分后事故门槛/规则文档仍指向旧测试文件，部分门槛用例已搬走

**文件：行**
- `docs/incidents-and-gates.md:108`（I-76 说 4 条 `[OpenCode 401]` 在 `test/tooling/opencode-review.test.mjs`）
- `docs/incidents-and-gates.md:115`（I-77 说带 `[I-77]` 的用例在该文件）
- `docs/incidents-and-gates.md:125`（I-86 的遮盖用例在该文件）
- `.agents/instructions/model-review.md:99`（说门槛是 `test/tooling/opencode-review.test.mjs` 里带 `[I-77]` 的用例）

**问题**
实际拆分后：`[OpenCode 401]` 的 3 条真实调用用例、大部分 `[I-77]` 用例、全部记录遮盖用例都在新文件 `opencode-review-merge-gate.test.mjs`（例如 `:437`、`:108`、`:462`）。旧文件只留下少部分（例如 `opencode-review.test.mjs:106` 的配置检查、`1520/1545/1570` 的 3 条 `[I-77]`）。文档没有同步，读者按 I-86 去旧文件找不到遮盖门槛。

**证据**
```md
docs/incidents-and-gates.md:125
...；`test/tooling/opencode-review.test.mjs`（逐条规则遮盖、普通文字不动、两边规则同步、...）
```
```md
.agents/instructions/model-review.md:99
门槛是 `test/tooling/opencode-review.test.mjs` 里名字带 `[I-77]` 的用例
```

**为什么自动检查没拦住**：`scripts/check-incident-gates.mjs` 只校验引用路径“存在”，旧文件仍存在，因此通过；`check:adr-numbers` 只管 ADR。见下面问题 3。

**建议**：把 `docs/incidents-and-gates.md` 中这些引用改为“两个文件”或按用例名定位。`.agents/instructions/model-review.md` 属会进入复核材料的规则文件，改它会改变模型可见内容，需按 prompt-prefix 规则单独评估，不宜顺手改。

---

### 低：作者“把 ADR 0181 改为 0189”的说法，在基准到 HEAD 的净 diff 里看不到

**文件：行**
- `git diff --name-status 8b16d69..07d0bf7` 只有 4 个测试文件
- `8b16d69:README.md` 已经写着 `ADR 0189`，`8b16d69:docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md` 已存在

**问题**
`git log` 里确实有 `deedc73 docs(adr): ... 0181 改为 0189`，但该内容在基准提交里已经存在，所以本 PR 相对基准没有文档改动。作者材料把这项列为改动之一，与实际 diff 不符。当前状态本身是对的（`0189` 文件存在、README 与 CI 设计文档链接都指向它、`0181` 只剩下载缓存那份），只是“本次改动”的说法不准确。

**证据**
```
$ git diff --name-status 8b16d69..07d0bf7
A  test/tooling/opencode-review-merge-gate.test.mjs
A  test/tooling/opencode-review.fixtures.mjs
M  test/tooling/opencode-review.test.mjs
M  test/tooling/review-delegate.test.mjs
```
**建议**：在 PR 描述里改成“ADR 072? 已在基准包含，本 PR 不再改文档”，避免复核者按 diff 找不到对应改动。

---

### 信息：拆分的“未丢用例”只有人工核对，没有会失败的反向检查

**问题**
仓库没有“测试名称集合/数量必须保持”的自动检查。若拆分时漏掉一个用例，CI 只会少跑，仍然全绿。我按文件数到：`opencode-review.test.mjs` 76 个 `it(` + `opencode-review-merge-gate.test.mjs` 88 个 = 164，与作者所说 164 一致；且 `git diff` 结构显示主文件被整段截尾、新文件是新增的对应尾部（主文件保留到基准第 1788 行，新文件从 `killedWithMarker` 起，紧随基准第 1790 行），未发现断档。但我没有运行测试（工具限制），也没有逐条比对全部 88 个尾部用例名；这一项只能算“数量与结构对得上”，不是“名字集合已证同”。

**建议**：合并前用一次冷 HOME 的 `npm run test:tooling` 留 164/164 证据；长期可加一个只读脚本比对 `it(` 名称集合，或至少在 PR 记录里贴出拆分前后的名单 diff。

---

## 侧重检查

- **错误路径/不可信输入**：`review-delegate.test.mjs:401` 的修复正确。`f.run` 是 `execFileSync("git", args, ...)`（`:24-25`），所以实际命令是 `git -c user.name=t -c user.email=t@t revert --no-edit HEAD`，`-c` 必须在子命令前，符合 git 语法。同文件其它会产生提交的操作（`:37` 的 `commit`、`:416-428` 的 `merge`）本来就有身份，没有遗漏。`revert` 在临时 clone 里执行，不触碰真实仓库。
- **安全**：拆出的假密钥样例保持拆开写法（`opencode-review-merge-gate.test.mjs:514` 的 `["-----BEGIN","PRIVATE KEY-----"].join(" ")`，与基准 `:2299` 相同），没有因为搬文件而重新引入会被 gitleaks 命中的字面量；合并提交 `3d97bbf` 正是把 main 的这处拆写带回新文件。`fakeOpenAiKey` 仍是 `["sk", ...].join("-")`。未发现新增密钥或日志泄露。
- **资源耗尽**：拆分让 `policy` 作业并行跑两个真实 opencode 文件，峰值进程/内存上升，但受 `--maxWorkers 2` 限制；真正的问题是上面的共享安装缓存竞争，不是单纯 CPU。
- **不可撤销操作**：测试只在 `mkdtempSync` 目录里 clone/commit/revert/rm，未发现对工作仓库的破坏性命令。
- **规则/文档与代码一致**：ADR 编号与格式由 `check:adr-numbers` 覆盖（见下）；门槛文档仍指向旧文件（低危）；作者对 ADR 改动的描述与净 diff 不一致（低危）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。`git diff --name-status` 只有 4 个 `test/` 文件，没有产品代码；`buildPrompt`、工具定义、系统提示、`.agents/instructions/model-review.md` 都未改。发给模型的内容仍只在末尾追加，每轮会变的值仍在最后一条消息：测试 `[review chain] gives DeepSeek the same fixed prompt with or without a previous round` 仍存在（`opencode-review-merge-gate.test.mjs:2060`）并在比较固定前缀。结论与依据 `prompt-prefix.md` 一致。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会。改动全在测试/文档；没有新增依赖时间、无序集合或前后文遮盖的序列化。唯一被改写的测试字符串是私钥字面量拆成 `join(" ")`，运行时拼出的字节与原字符串完全相同（`opencode-review-merge-gate.test.mjs:514`）。`git revert` 新增的身份只影响临时仓库的提交元数据，测试不断言它，也不进入发给模型的内容。

**3. 有没有对应的自动检查，反向用例会真的失败吗？**
- ADR 编号：有。`npm run check:adr-numbers`（`package.json` 的 `check:steps` 内）会跑 `scripts/check-adr-numbers.mjs` 和 `test/tooling/adr-numbers.test.mjs`；后者有重复编号、命名格式、空目录等反向用例（`:29-41` 等），会真的失败。ADR 链接“是否指向存在的文件”没有 CI 检查，`document-governance` 是外部手动校验（提交说明还带 11 条既有错误），不是干净门槛；不过本次两条链接我核对都存在。
- `review-delegate` 的 `-c` 修复：没有新增专用反向用例。它只能在“没有全局 git 身份”的环境（CI 的隔离 HOME）体现；开发者本机有身份时，把 `-c` 去掉该用例仍会通过。因此反向验证依赖 CI 环境，不是本地可复现的断言。
- 测试拆分：没有自动检查保证 164 个用例没丢；漏一个不会让任何检查失败。我只核到 76+88=164 且 diff 结构是整段搬移，未运行测试。

**4. 改动产生的每个值，使用它的地方都接受吗？**
- ADR `0189-drop-node-floor-and-fold-test-into-coverage.md`：文件名符合 `check-adr-numbers` 的四位编号+小写短名规则，编号唯一（glob 只有这一个 0189）；`README.md:21,67` 的 `docs/adr/0189-...` 和设计文档 `../../adr/0189-...` 都解析到存在的文件；`0181` 只剩下载缓存 ADR，未被误改。
- `test/tooling/opencode-review.fixtures.mjs`：tooling 的 include 是 `**/*.test.mjs`（`ci/policy.json:194`），该名不被收为测试；两个测试文件都按 `./opencode-review.fixtures.mjs` 导入，文件存在，`passWithNoTests:false` 不会因此报错。
- `test/tooling/opencode-review-merge-gate.test.mjs`：匹配 `**/*.test.mjs`，会被 policy project 收集；没有需要改的 policy/清单文件。
- `git -c user.name=t -c user.email=t@t`：`f.run` 前置的是 `git`，选项位置合法；同文件既有提交已用同样写法。
- 唯一“使用方不接受”的地方是文档引用：`docs/incidents-and-gates.md` 与 `model-review.md:99` 仍把门槛用例指向旧文件，而部分用例已在新文件（见低危条）。
