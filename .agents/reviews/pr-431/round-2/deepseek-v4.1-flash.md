## 发现的问题（按严重度）

### 1. 高：删掉台账条目的 PR 会在本 PR 和合并提交的 main 上都判红，作者“合并后 main 上一致”的说法不成立 【读代码证实】

`file:line`：`scripts/ci/security-exceptions.mjs:226-234`、`scripts/ci/security-published-fixtures.mjs:27-30,61-67`、`scripts/ci/context.mjs:109-111`、`scripts/ci/main-confirm.mjs:35,58-61`

问题：只要 base 分支存在台账，就用 `git show baseSha:` 的旧台账；本 PR 删掉的 5 条在 base 里仍然存在，扫描产物时这些成员命中为 0，于是 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。作者只承认“PR 自己的 CI 仍会报错”，但合并提交的 push 也一样：`push` 的 base 是 `payload.before`，即合并前的旧 main；`main.yml` 的 light 路径（`main-confirm.mjs:35` 调用 `createContext` 时没有传 base）和 full 路径都会用旧 main 的台账跑 `security` 检查。

证据：
```js
// security-exceptions.mjs:226-233
const available =
  git(root, ["ls-tree", "-r", "--name-only", context.baseSha, "--", exceptionPath]).trim() ===
  exceptionPath;
...
const bytes = available ? git(root, ["show", `${context.baseSha}:${exceptionPath}`]) : candidate;
```
```js
// security-published-fixtures.mjs:27-29
const entries = reviewed.exceptions.filter(
  (entry) => entry.kind === "published-synthetic-fixture",
);
```
```js
// security-published-fixtures.mjs:61-67
assert(
  actual.size === entry.findings.length &&
    entry.findings.every(
      (finding) => actual.get(`${finding.rule}:${finding.digest}`) === finding.count,
    ),
  "PUBLIC_FIXTURE_FINDINGS_CHANGED",
);
```
```js
// context.mjs:109-111（push）
} else if (event === "push") {
  if (payload.after !== testedSha) throw new Error("CI_PUSH_AFTER_MISMATCH");
  baseSha = commit(/^0{40}$/u.test(payload.before ?? "") ? base : payload.before);
```
```js
// main-confirm.mjs:35,58-61
const context = createContext({ root, base });   // CLI 调用时 base 为 undefined
...
for (const [checkId, matrixKey] of [
  ["build", "linux-x64"],
  ["security", "default"],
]) {
```

因此：在 `ci/required` 生效时这个 PR 无法正常合并；即使绕过合并，合并提交的 main 确认仍会红一次，下一次 push 才会恢复。这比作者写的“合并后 main 上一致”更严重。

建议：不要用“忽略删除”的方式绕过，而是把“候选删除”变成受校验的安全操作。`createPublishedFixtureReview` 里把发布类例外集合改成：
- base 中的条目默认仍然有效；
- 只有“候选台账里该 `path` 完全消失”的 base 条目才从期望集合中移除；
- 候选对同一 `path` 的修改忽略（以 base 为准）；候选新增的条目忽略（仍只能靠 Owner 审阅清单加入）。

这样删除是安全的：被删的成员仍会进入 `inspect`，若它还有任何命中，就不是 expected 成员，会触发 `PUBLIC_ARTIFACT_CONTAINS_SECRET`；若它确实干净，就自然通过。它满足“例外只能来自 base”，还能让 PR 和合并提交的 main 变绿。实现上可让 `loadReviewedExceptions` 额外返回 base 路径集合或 `baseExceptions`，或在 `security-published-fixtures.mjs` 内读取候选台账并计算删除集。另建议给这条规则补反向用例：删除一个仍有命中的条目必须失败。

---

### 2. 中：新的“真实台账”测试没有验证“删除是否正确”，也没有检查未登记但仍有命中的文件 【读代码证实】

`file:line`：`test/tooling/security-published.test.mjs:389-391,404-419`

证据：
```js
const entries = ledger.exceptions.filter(
  (entry) => entry.kind === "published-synthetic-fixture",
);
...
for (const entry of entries) {
  const bytes = readFileSync(join(repository, entry.path.replace(/^runtime\//, "")));
  ...
}
```

问题：测试只遍历候选台账里“剩下”的条目。它能在删除前发现那 5 条是 stale，但删除之后完全不检查那 5 个文件是否真的干净、摘要是否仍是原来的。若删错（文件仍有命中），这个测试仍然绿；只能等合并后下一轮实际产物扫描报 `PUBLIC_ARTIFACT_CONTAINS_SECRET`。它也不能发现“某个不在台账里的文件被新规则扫出命中”的情况（那由 security 的产物扫描兜底，但不在这个测试里）。

建议：至少对“被删除的路径”做显式断言：成员存在、`fileSha256` 等于 base 条目、当前扫描命中为空；或者按第 1 条改成由 `createPublishedFixtureReview` 统一校验删除，并补一条“删除仍有命中的条目 → 失败”的反向测试。

---

### 3. 中低：测试直接用台账里的 `path` 拼仓库根，绕过了 `safeRelativePath`/`exactPath` 校验 【读代码证实】

`file:line`：`test/tooling/security-published.test.mjs:405`、`ci/security-exceptions.schema.json:206-209`、`scripts/ci/security-exceptions.mjs:45-53,135`

证据：
```js
// security-published.test.mjs:405
const bytes = readFileSync(join(repository, entry.path.replace(/^runtime\//, "")));
```
```json
// security-exceptions.schema.json:206-209
"path": {
  "type": "string",
  "minLength": 1
},
```
```js
// security-exceptions.mjs:135
assert(exactPath(entry.path), "SECURITY_EXCEPTION_PATH_NOT_EXACT");
```

问题：schema 对 `path` 没有路径约束，`exactPath`/`safeRelativePath` 只在 `validateSecurityExceptions` 里执行。这个新测试不调用校验，直接 `join(repository, ...)`；`runtime/../../...` 这样的路径会被 `join` 归一化成仓库外路径，导致测试进程读取任意可读文件（只读、测试环境，风险有限，但属于不受信输入路径）。

建议：读文件前用 `safeRelativePath`/`exactPath` 校验，并核对映射关系 `entry.path === "runtime/" + entry.packageLockPath + "/" + entry.archiveMember.slice(8)`；或者复用 `validateSecurityExceptions` 后再读取。

---

### 4. 低：新正则仍会放过“全大写、无数字”的真实字面量，同时会误报含数字的合法环境变量名 【读代码证实 + 推测】

`file:line`：`scripts/ci/security-source.mjs:7,73-78`

证据：
```js
const environmentReference = /^\$(?:[A-Z_]+|\{[A-Z_]+\})$/;
...
if (credentialName.test(key))
  for (const value of values)
    if (value.length >= 12 && !environmentReference.test(value))
      add("credential-literal", value, line);
```

问题：
- 收紧只去掉了数字。`$THISISAREALSECRET` 这类“全大写、无数字、≥12 字符”的值仍然整段放行；如果它恰好写在 `password`/`apiKey` 等键上，会被当作环境变量引用。
- 反向影响是：`$API_KEY_2024` 这类合法环境变量名现在会被当成凭据，可能在依赖文件里产生新的误报。作者说这与 gitleaks 全局 allowlist 的大写部分一致，但本项目该规则是对所有 `credentialName` 赋值无差别放行，语义比 gitleaks 的“命中值放行”更宽。

建议：如果接受这个取舍，至少在注释/测试里写明剩余风险，并补一个“全大写无数字但看起来像真实密钥”的用例做决策；若想更稳，可要求环境变量引用同时具备更明确的标识符形状（例如至少包含下划线、且不是常见的全大写英文单词），或只在源码/dotenv 的确定位置放行。

---

### 5. 信息：作者把“5 条归零”归因于第 2 轮的正则收紧，时间线上不准确；delete 本身在逻辑上仍是正确的 【读代码证实（时间线）/ 未核实（文件内容）】

- `616f77439` 已经引入“整值是环境变量引用就放行”，`c44f4c7ba` 才把正则从允许数字改成只允许大写和下划线，并删除 5 条。
- 被删的 5 条 reason 里列出的都是 `$ACME_API_KEY`、`$GITLAB_TOKEN`、`${TOOLS_KEY}`、`${EXAMPLE_SECRET}` 这类无数字引用；它们在**收紧前**的旧正则 `^\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})$` 下就已经命中为 0。因此删除是必要的，但原因不是第 2 轮的数字收紧，新加的三条反向用例也不覆盖这 5 条。
- 本 checkout 没有 `node_modules`，无法独立核对这 5 个文件的实际字节和当前扫描结果；“剩余条目命中不变”也只能标“未核实”。新测试若在装有依赖的 CI 上通过，能证明剩余条目，但不能证明被删条目。

---

## 侧重检查

- **不受信输入/路径**：发现 `security-published.test.mjs` 直接使用台账 `path` 读文件，绕过 `safeRelativePath`（见问题 3）。`findBuildSecrets` 本身对二进制按 UTF-8 处理，不会执行内容，风险可控。
- **错误路径**：`readFileSync` 失败时 ENOENT 会带绝对路径；命中不匹配时 `expect` 的 `path` 字段能指出条目。但 `entry.findings` 缺失/不是数组时抛的是普通 TypeError，不带台账路径；`findBuildSecrets` 抛 `PUBLIC_SOURCE_PARSE_FAILED` 时也不指出是哪个条目。建议逐条包一层错误信息。
- **资源耗尽**：新测试会在 policy job 中同步读取并扫描全部已发布文件，其中包含 `libonnxruntime.so.1`（ledger `ci/security-exceptions.json:2134`）。产物扫描本来也会扫它，但这里额外重复一次；内存/时间可能上升，未实测（推测）。CI Linux 上 tarball 自带 linux/x64 CPU 二进制，`npm ci --ignore-scripts` 也会解出该文件（`ci/toolchain-lock.json:1118-1126`、`scripts/ci/install-dependencies.mjs:310,346`），因此 Linux 机器上路径存在；macOS 本地跑 tooling 测试时依赖 tarball 是否包含 linux 路径，未实测。
- **不可逆操作**：本改动只改 CI 扫描、台账和测试，没有生产写操作、删除或迁移；无不可逆风险。
- **规则/文档一致性**：`scripts/ci/security-source.mjs` 已无注释，符合作者引用的“不写注释”规则；仓库里没有其他地方描述旧正则需要同步。`ci/security-exceptions.json:7` 的 reviewEvidence 已更新。与代码不一致的是作者关于“合并后 main 一致”的结论（见问题 1）。
- **安全约束**：现有设计确实坚持“例外只来自 base”，防守方向正确；问题在于删除操作没有对应的安全通道，导致合法清理也被 base 挡住，且新增测试没有覆盖删除本身。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动只在 `scripts/ci/security-source.mjs`、`ci/security-exceptions.json` 和 `test/tooling/*` 中；`findBuildSecrets` 只被 `scripts/ci/security-redaction.mjs` 和测试使用，用于公开产物/日志扫描，不参与 `packages/runtime-pi`、`apps/agent-service` 的请求组装、系统提示、工具定义、历史或出口遮盖（全仓库 grep 未发现 runtime 引用）。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍然在最后一条消息里，系统提示/工具定义/历史不变。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 正则判断是纯函数，只依赖当前值本身；新测试的排序和去重都是确定的，不依赖时间或无序集合。测试读取的依赖文件由 `package-lock.json` 的版本和 integrity 固定。台账里的日期只出现在 `reviewEvidence` 文本，不进入请求。唯一的环境差异是已安装依赖的字节，但那是 CI 扫描输入，不是模型请求内容。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，但覆盖不完整。**
- `test/tooling/security.test.mjs:230-247` 的三条反向用例（`$ABCDEFGHIJKL1234` 写在文档、`.env`、源码字符串拼接）在旧正则下会被当作环境变量放行，断言会失败，因此确实能抓住回退。
- 新增的“真实台账”测试能抓住“候选台账里仍登记着已归零条目”的情况（删除前），但删除后不再检查这些条目，也没有“删除仍有命中必须失败”的反向用例（见问题 2）。
- 它也没有覆盖 base 台账与候选台账的差异，而这正是本 PR 当前 CI 红灯的直接原因（见问题 1）。

### 4. 每个改动产生的值，每个使用它的地方都能接受吗？

- `environmentReference`（`security-source.mjs:7`）只在该文件第 76 行使用，没有其他消费者，安全。
- 被删除的 5 条台账条目：使用台账的 `loadReviewedExceptions`、`validateSecurityExceptions`、`createPublishedFixtureReview`、`gitleaksGateExceptions` 都按 kind 过滤，删除后不会留下悬空引用；但 `createPublishedFixtureReview` 的“base 优先”策略不接受候选删除，见问题 1。
- `reviewEvidence` 只受 schema `minLength: 20` 约束，是展示字段，无其他校验，追加文字安全。
- 新测试新增的“消费者”是它自己：路径没有经过 `safeRelativePath`/`exactPath`（问题 3）；同时它假设根目录 `node_modules` 与 runtime 产物逐字节相同、且平台二进制存在，这一点在 Linux CI 上有 `ignore-scripts` + 官方 tarball 的支持（`ci/toolchain-lock.json:1118-1126`），但未在本次无依赖的 checkout 中实测。
- 作者“删掉的 5 条正好是命中为 0 的那些”：从 diff 看确实只删了 5 条 published-synthetic-fixture，JSON 其余内容只有 `reviewEvidence` 变化，没有误删其他条目；但这 5 条在旧正则下就已经是 0，实际文件字节无法在本环境核实（未核实）。
