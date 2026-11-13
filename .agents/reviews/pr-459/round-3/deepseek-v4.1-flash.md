# 复核结论

## 一、按严重度排列的问题

### 1. 高：linux-arm64 的 `local --check policy` 实际会失败，新增测试把 `runCheck` mock 掉掩盖了这一点

**文件:行**：`scripts/ci/local.mjs:26-30`、`scripts/ci/run.mjs:87`、`scripts/ci/run.mjs:237-244`、`test/tooling/pipeline.test.mjs:100,176-198`、`test/tooling/runner.test.mjs:256`、`test/tooling/test-timeout-entry.test.mjs:127`

**问题**：arm64 上 `local` 允许跑 `policy/static/security`，而 `policy` 会执行整个 `tooling` 测试项目。该测试项目里有多个用例直接调用新增了平台拒绝逻辑的 `build()`/`runBrowser()`/`runTests()`/`runCheck()`，在 linux-arm64 上必然抛 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`。新增的 arm64 测试因为把 `runCheck` 整个 mock 掉，所以没有暴露。

**证据（亲自读到）**：
- `scripts/ci/local.mjs:26-30`
  ```js
  if (!supportedPlatforms().includes(hostPlatform()))
    throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");
  ...
  if (!check || check === "build" || check === "coverage") artifactPlatformKey();
  ```
  从 `scripts/ci/platforms.mjs:20-25` 可见 `linux-arm64` 在 `BUILD_PLATFORM_KEYS` 里，因此 `policy/static/security` 会继续往下执行。
- `scripts/ci/run.mjs:244`：`policy` 分支执行 `await vitest(check.projects);`；`ci/policy.json:193-196` 的 `tooling` 项目 include 是 `test/tooling/**/*.test.ts` 和 `test/tooling/**/*.test.mjs`。
- `scripts/ci/build.mjs:134`：`const platform = artifactPlatformKey();`；`artifactPlatformKey()` 在 `scripts/ci/platforms.mjs:13-18` 对 `linux-arm64` 明确抛错。
- `test/tooling/pipeline.test.mjs:198` 直接 `const result = await build(options);`；`pipeline.test.mjs:176-191` 还直接调用 `testMain`/`browserMain`，对应 `scripts/ci/test.mjs:152` 与 `scripts/ci/browser.mjs:129-132` 的 `artifactPlatformKey(...)`。
- `test/tooling/pipeline.test.mjs:100` 的 mock 只给了 `os`：
  ```js
  return { sha256, manifest: { platform: { os: process.platform } } };
  ```
  在 arm64 上 `arch` 取默认值 `process.arch`，因此浏览器/测试路径同样会抛 `CI_ARTIFACT_PLATFORM_UNSUPPORTED: linux-arm64`。
- `test/tooling/runner.test.mjs:256` 期望 `CI_ARTIFACT_REQUIRED`，但 arm64 上会先命中 `run.mjs:87` 的平台门禁，错误码不同。
- `test/tooling/test-timeout-entry.test.mjs:127` 同样通过 `runCheck` 跑 coverage，也会先命中该门禁。
- 新增测试 `test/tooling/quality-local.test.mjs:575` 声称验证了 arm64 的三种检查，但 `quality-local.test.mjs:135-147` 把 `runCheck` 整体 mock 掉，所以并未验证真实的 policy 执行链。

**建议**：让这些 tooling 用例显式处理“本平台不能产出/消费构建产物”的情况（例如在 `artifactPlatformKey` 不支持的平台跳过或改断言），或者在 arm64 上不要用整个 tooling 项目来跑 `policy`；更根本的是补一个不 mock `runCheck` 的 linux-arm64 `policy` 端到端用例。

---

### 2. 低：security 诊断行对 `security-exceptions` 分支直接输出原始 `error.message`

**文件:行**：`scripts/ci/run.mjs:271-277`；`scripts/ci/check-security.mjs:706-715`、`scripts/ci/check-security.mjs:769-777`

**问题**：扫描器的错误被收敛成固定错误码或 `SECURITY_SCANNER_FAILED`，但 `security-exceptions` 分支直接保存 `error.message`。新增诊断行会把它写入作业日志。当前代码路径我未找到会把原始秘密放进这些消息的证据（`verifySyntheticProvenance` 的断言基本是固定码，`JSON.parse` 只解析基线 JSON），且外层有 `redactText` 兜底；但这是一个没有结构性约束的出口，且新增测试只 mock 了固定错误码，没有覆盖这条分支。

**证据**：
```js
// runSecurityChecks 的 perform 分支
error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED",
```
```js
// security-exceptions 分支
checks.push({
  id: "security-exceptions",
  status: "infrastructure_failed",
  ...
  error: error.message,
});
```
```js
// run.mjs 新诊断行
`security scan ${entry.id}: ${entry.status}${entry.error ? ` ${entry.error}` : ""}\n`
```

**建议**：把 `security-exceptions` 的 `error` 也收敛为错误码（或至少只允许 `^[A-Z_]+(?::[A-Za-z0-9_.-]+)?$`），并补一个带“像秘密的 error.message”的反向测试，确认输出会被遮盖。

---

### 3. 低/未核实：新增的 `.agents/reviews/pr-459/*` 复核记录没有加入 gitleaks 白名单

**文件:行**：`ci/rules/gitleaks.toml:78-148`（只有 pr-273、pr-274、pr-312、pr-316、pr-319 的记录白名单）

**问题**：本 PR 新增了多份 `.agents/reviews/pr-459/...` 记录文件；按 I-90 的历史，复核记录原样引用测试假令牌或私钥开头标记时，gitleaks 会让 security 变红。当前白名单没有 `pr-459`。我无法读取这些记录内容（评审工具对 records-path 有访问限制），因此无法确认它们是否含会被规则命中的文字。

**建议**：在合并前对着该提交跑 `npm run check:gitleaks` / security；若命中，按 ADR 0177 给具体文件加精确白名单，或修改记录中的引用写法。

---

### 4. 低/稳健性：wheel 文件名校验假设“第一个连字符前是包名、第二个之前是版本”

**文件:行**：`scripts/ci/install-tools.mjs:215-220`

**证据**：
```js
const [distribution, version] = wheel.filename.split("-");
assert(
  distribution.toLowerCase().replace(/[-_.]+/g, "-") ===
    wheel.name.toLowerCase().replace(/[-_.]+/g, "-") && version === wheel.version,
  ...
);
```

**结论**：当前 `ci/toolchain-lock.json` 里所有 wheel 都能通过（包括 `ruamel.yaml.clib`、`Pygments`、`PyJWT`，见下方必答问题 4），这不是现网问题。但 `split("-")` 对“分发名本身包含连字符”的非标准 wheel 会误判；另外 linux 平台的 wheel 正则 `-manylinux[\w.]*_x86_64` 也允许 `manylinux..._x86_64.macosx..._x86_64` 这类混合标签结尾。建议后续换用严格的 wheel 文件名解析（或把 distribution 段锚定到 `^[^-]+` 之外再校验），不是本轮阻塞项。

---

## 二、读代码证实与推测的区分

**读代码证实的**：第 1、2、4 条的具体调用链和代码行；wheel 名称/版本检查对现有锁文件全部可行；linux-x64 与 macOS（arm64）上新增的 `artifactPlatformKey()` 正常返回原值；`node_modules/typescript/bin/tsc` 由根 `devDependencies` 的 `typescript: 5.9.3` 和 `package-lock.json:8557` 保证存在；`quality.mjs` 的 `--max-old-space-size=4096` 位于脚本路径之前是正确的 Node 参数位置。

**推测/未核实**：第 3 条中 `.agents/reviews/pr-459/*` 的实际内容；现有 lock 里的 SHA/URL 是否真的对应官方产物（未联网，无法核对）；`4 GB` 堆上限在当前 18 GB 共享 runner 上的实际余量（只根据作者描述，未实测）。

---

## 三、侧重检查

- **错误路径**：新增的 `runCheck` 早退在 `outputPath`/`mkdirSync` 之前（`run.mjs:87` 对比 `run.mjs:88,97`），不会留下半成品目录；`local` 也在写输出前拒绝（`local.mjs:30` 对比 `:36-38`）。但 arm64 上的错误优先级与现有测试断言冲突，见问题 1。
- **不合规范/不可信输入**：`validateToolchainLock` 对 filename、URL、SHA、host、平台标签、wheel 名称/版本都做了校验；`exactly()` 正确转义版本里的 `.`、`+`。wheel 解析仍有问题 4 的假设。
- **安全**：新增 stdout 行的 `entry.error` 取值来自 `check-security.mjs`；扫描器分支是固定码，`security-exceptions` 分支是原始 `error.message`，当前路径未发现可直接把原始秘密写入的路径，但缺少反向测试；复核记录未加入 gitleaks 白名单（问题 3）。
- **资源耗尽**：`--max-old-space-size=4096` 是上限不是预分配，两个 runner 各自跑 tsc 时理论上可控制在 18 GB 内；早退逻辑也避免了在 arm64 上启动构建/浏览器/覆盖率。
- **不可撤销操作**：本 PR 没有新增删除、覆盖或不可回滚操作；新增门禁反而减少了在错误平台创建输出目录/启动子进程的机会。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 已读，本 PR 没有改模型请求组装；`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 仍只描述托管 Linux x64 / macOS arm64，和“工作流和策略不动”一致；`ci/quality-policy.json` 仍只有两个 node observation 平台，本 PR 未声称 arm64 质量检查可用。未发现文档与代码的直接冲突。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次 diff 只涉及 `scripts/ci/*`、`package.json` 的脚本字符串、`ci/toolchain-lock.json`、测试和 `.agents` 复核记录；没有修改系统提示、工具定义、历史消息、出口遮盖或请求序列化代码。按 `.claude/rules/prompt-prefix.md` 的要求，模型请求仍是“固定部分在前、只在末尾追加”，本 PR 没有往请求开头新增任何每轮变化的值。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**不会（就模型可见内容而言）。** 新增值都是 CI 侧数据：锁文件里的平台键、wheel 正则、作业日志行；没有进入模型请求。`install-tools.mjs` 里原有的 `verifiedAt: new Date().toISOString()` 仍然是 CI 证据时间戳，不是模型可见字段。新增的 security 日志行会随失败状态变化，但它是作业日志，不是模型请求内容。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，且反向用例基本有效：
- wheel 平台/名称/版本：`test/tooling/toolchain-platforms.test.mjs` 覆盖了 macOS wheel 混入 Linux、包名不符、版本不符、跨平台互换、工具文件放错平台等；其中“macOS x86_64 换成 Linux x64”用例在旧正则下会被接受，因此确实是有效的反向用例。正常锁文件仍由 `test/tooling/toolchain.test.mjs` 的 `validateToolchainLock(lock)` 正向验证。
- `runCheck` 早期拒绝：`test/tooling/runner-orchestration.test.mjs:376-388` 覆盖 build/browser/coverage 在 arm64 上不创建输出；旧代码下 browser 会先报 `CI_ARTIFACT_REQUIRED`，因此该用例确实依赖新门禁。
- typecheck：`test/tooling/run-all-checks.test.mjs` 和 `quality-local.test.mjs` 覆盖了命令行形状和 `args[0]` 标记；但前者只是字符串正则，不实际执行 `npm run typecheck`，也没有验证 `tsc` 路径一定存在。
- security 诊断行：`runner-orchestration.test.mjs:751` 覆盖了输出格式；但它 mock 了 `runSecurityChecks`，没有覆盖 `security-exceptions` 的任意 `error.message` 和实际遮盖。
- **缺口**：新增的 arm64 local 测试 mock 了 `runCheck`，没有覆盖问题 1 的真实失败；建议如上补真实链路测试。

### 4. 每个新值/新字段的所有使用方都能接受吗？

逐一核对如下：
- `platforms.mjs` 的 `"darwin-arm64" / "linux-x64" / "linux-arm64"`：`install-tools.mjs` 的 `fields(..., platforms)` 与锁文件完全匹配；`installTools`/`verifyInstalledTools` 用 `${process.platform}-${process.arch}` 取值，arm64 三个下载物都存在；`local.mjs` 用 `supportedPlatforms()` 白名单放行 arm64。
- `buildPlatformKey()` 的返回值：`macos-arm64`、`linux-x64`、`linux-arm64`。`linux-arm64` 只进入 `local` 的 `summary.platform`（`local-summary.json` 没有 JSON Schema 校验），以及 arm64 上本应被拒绝的 build 路径；`ci/result.schema.json` 的 `artifacts[].platform` 只接受 `linux-x64`/`macos-arm64`，而 arm64 不会产出 artifact，因此不会撞枚举。
- `artifactPlatformKey()` 的返回值：只有 `macos-arm64`/`linux-x64`，与 `ci/result.schema.json:232-234` 的枚举一致；build/browser/coverage 的 `result.artifacts`、`run.mjs` 的 `--input` 生产者校验都能接受。
- `ci/toolchain-lock.json` 新增的 linux-arm64 下载项：`install-tools.mjs` 的 `platformFilename` 对 node/python/actionlint/gitleaks 的文件名规则均能接受；`verifyInstalledTools` 的成员路径 `node-v${version}-${platform}/bin/node`、`python/bin/python3` 等与安装目录结构一致。锁文件的其他消费者（`check-policy.mjs`、`install-dependencies.mjs`、`context.mjs`、`export-evidence.mjs`）只读 Node/npm/Action/原生依赖字段，不受新增平台影响。
- `package.json` 的 `node_modules/typescript/bin/tsc`：根目录 `devDependencies` 固定 `typescript: 5.9.3`，`package-lock.json` 有 `node_modules/typescript`，npm workspaces 默认提升到根目录，因此正常安装布局下存在；该路径在 `quality.mjs` 中是相对 `cwd: root` 使用，也正确。
- 新增错误码 `CI_ARTIFACT_PLATFORM_UNSUPPORTED` / `CI_PLATFORM_UNSUPPORTED`：没有 schema 枚举限制，只经 `redactText`/stderr 输出，使用方都能接受；但 arm64 上它们会改变现有 tooling 测试预期的错误码（见问题 1）。
- `security.checks[].error`：扫描器分支是固定码，`security-exceptions` 分支是任意消息；新诊断行用 `redactText` 输出，当前没有确认的秘密泄漏，但这是唯一没有结构约束的出口（见问题 2）。

**结论**：从“清单里的 id 能通过后端校验吗”这个角度看，新增的 linux-arm64 下载项和平台键本身都能被安装/校验端接受；真正的问题不是值对不上，而是 arm64 上测试和 `local --check policy` 的执行链没有接受“build/browser/coverage 被拒绝”这一新语义。
