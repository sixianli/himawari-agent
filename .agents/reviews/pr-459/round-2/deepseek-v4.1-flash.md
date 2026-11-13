## 结论

未发现高严重度问题；下面按严重度列出读代码证实的问题，另列推测/未核实项。

## 读代码证实的

### 1. 中等：linux-x64 的 wheel 规则仍会放行 macOS x86_64 wheel

- 文件:行：`scripts/ci/install-tools.mjs:98`
- 问题：linux-x64 的 Semgrep wheel 只按文件名后缀判断，`_x86_64.whl$` 同样匹配 `macosx_11_0_x86_64.whl`。把 macOS Intel wheel 放进 `tools.semgrep.wheels["linux-x64"]` 时，锁文件校验会通过。
- 证据：

```js
"linux-x64": Object.freeze({
  // ...
  wheel: () => /(?:_x86_64|-none-any)\.whl$/,
}),
```

```js
platformFilename(platform, "wheel", wheel.version, wheel.filename);
```

- 影响：当前锁里没有 macOS x86_64 wheel（我用 `macosx...x86_64` 搜过 `ci/toolchain-lock.json`，无匹配），所以不影响现状；属于规则仍放行的错误锁文件。后续 `pip` 通常会因平台标签不兼容而失败，因此不会静默装错，但本应在锁校验阶段拒绝。
- 建议：把 linux-x64 规则限定到 Linux 平台标签，例如只允许 `manylinux*_x86_64`、`musllinux*_x86_64`、`-none-any`，不要用宽泛的 `_x86_64` 结尾；补一条“macOS x86_64 wheel 放进 linux-x64 必须失败”的反向用例。

### 2. 低到中等：wheel 的 `version` 字段与文件名没有互相校验，作者说的“版本对不上”反向用例不含 wheel

- 文件:行：`scripts/ci/install-tools.mjs:106`、`scripts/ci/install-tools.mjs:214`、`test/tooling/toolchain-platforms.test.mjs:102-118`
- 问题：`platformFilename(platform, "wheel", wheel.version, wheel.filename)` 把 `wheel.version` 传进去，但三个 wheel 规则都写成 `wheel: () => /.../`，完全忽略 `version`。所以除 Semgrep 本体那一条外，其他 wheel 的 `version` 字段可以和文件名里的版本不一致而通过校验。
- 证据：

```js
wheel: () => /(?:-macosx_\d+_\d+_(?:arm64|universal2)|-none-any)\.whl$/,
```

```js
platformFilename(platform, "wheel", wheel.version, wheel.filename);
```

```js
for (const [kind, select] of Object.entries(swaps))
  for (const platform of supportedPlatforms()) {
    // ...
    expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 ${kind} 下载物文件名`);
  }
```

`swaps` 只包含 `node`、`python`、`actionlint`、`gitleaks`，不含 wheel。
- 影响：版本不一致的 wheel 锁文件不会在 `validateToolchainLock` 阶段被拒绝；`requirements.txt` 用 `wheel.version`，下载/安装用 `wheel.filename`，通常会在 `pip install --require-hashes` 时失败，属于晚失败而不是静默装错。
- 建议：对非 `-none-any` 的 wheel，至少校验文件名以规范化的 `name-version-` 开头；或把“版本对不上”反向用例扩展到每个平台的至少一个 wheel。

### 3. 低：只有 `local.mjs` 是“一开始拒绝”，直接跑 `run.mjs/build.mjs/browser.mjs/test.mjs` 会先做大量工作再抛错

- 文件:行：`scripts/ci/local.mjs:30`、`scripts/ci/run.mjs:284`、`scripts/ci/run.mjs:478`、`scripts/ci/build.mjs:134`、`scripts/ci/browser.mjs:129`、`scripts/ci/test.mjs:152`
- 问题：`local.mjs` 在入口先调用 `artifactPlatformKey()`，但被改的四个模块都是在产生/读取产物的较后步骤才调用。
- 证据：

```js
if (!check || check === "build" || check === "coverage") artifactPlatformKey();
```

```js
await verifyExtractedArtifact(payload, { root, context });
checks.push("complete-content-verification");
const platform = artifactPlatformKey();
```

```js
result.artifacts.push({
  role: checkId === "build" ? "produced" : "consumed",
  platform: artifactPlatformKey(),
  // ...
});
```

- 影响：从 `local.mjs` 入口进来时确实“一开始”就拒绝；但直接调用 `buildMain`、`browserMain`、`testMain`，或在 ARM 上直接调 `runCheck`，会在完成构建/浏览器/测试或复制产物之后才报 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`，浪费资源并留下中间输出。当前工作流不会这样调用，所以是低严重度。
- 建议：若想真正 fail-fast，在 `buildMain`、`browserMain`、`testMain` 以及 `runCheck` 处理 build/browser/coverage 的分支入口先调 `artifactPlatformKey()`，不要等到记录结果时。

### 4. 低：`run.mjs --input` 会在不知道检查类型前就调用 `artifactPlatformKey()`

- 文件:行：`scripts/ci/run.mjs:559-569`
- 问题：任何带 `--input` 的调用都会先算主机 artifact 平台。linux-arm64 上即使要跑的是不碰产物的 `policy/static/security`，也会被拒绝。
- 证据：

```js
if (args["--input"]) {
  if (artifact) throw new Error("CI_ARTIFACT_INPUT_AMBIGUOUS");
  const producer = validateRecord("CheckResult", readJson(args["--input"]));
  const platform = artifactPlatformKey();
  // ...
}
```

- 影响：目前 `ci/policy.json` 和 `local.mjs` 的 policy/static/security 都不使用 `--input`，属于潜在误拒，不是当前路径。
- 建议：把 `--input` 的平台限制移到确认 `checkId` 是 build/browser/coverage 之后再执行。

### 5. 低：`test/tooling/toolchain.test.mjs:80` 的用例标题仍写“双方平台”

- 文件:行：`test/tooling/toolchain.test.mjs:80`
- 问题：用例名是“锁定双方平台”，但现在 `supportedPlatforms()` 和锁都已经是三个平台。
- 证据：

```js
it("锁定双方平台、完整 Action SHA、扫描工具和 wheel 闭包", () => {
```

- 影响：只是测试名称陈旧，不影响断言。与本次“文档/说明和代码一致”的侧重有关，建议顺手改掉。

## 推测与未核实

- 未运行测试：所有“反向用例会失败”的判断来自读代码，不是实际执行结果。
- 新增的 linux-arm64 下载摘要无法离线核对（`node-v22.22.3-linux-arm64.tar.gz`、Python aarch64 包、actionlint/gitleaks arm64 包、Semgrep aarch64 wheel）。URL 主机和文件名形式与官方发布命名一致，但 SHA-256 的真实性未核实。
- 未核实 ARM 机器上 `static` 实际依赖的浏览器（`check:layout`）是否已单独安装；这不属于本次 diff，但会影响“ARM 只跑三项检查”的实际可运行性。
- 未核实未来是否会让 policy/static/security 使用 `--input`；若使用，会触发上面第 4 条。

## 侧重检查

- 错误路径：`local.mjs` 对不带参数、build、coverage 的早拒绝成立；直接 CLI 入口的晚拒绝见第 3 条；`artifactPlatformKey` 的 `CI_PLATFORM_UNSUPPORTED` 与 `CI_ARTIFACT_PLATFORM_UNSUPPORTED` 两级错误清晰。
- 不合规范/不可信输入：`fields()` 限定平台键集合；`artifact()` 限制文件名字符、URL 主机和 URL 文件名一致；node/python/actionlint/gitleaks 的 `exactly()` 对版本做了正则转义，没有注入风险。wheel 的平台/版本校验缺口见第 1、2 条。
- 安全：新增下载仍走固定官方主机并沿用 SHA-256 校验，没有新增网络源或执行路径；`Object.hasOwn` 避免了原型链上的规则查找。
- 资源耗尽：第 3 条是唯一新增的资源浪费路径；锁校验本身只是遍历有限条目，无放大。
- 不可撤销操作：没有新增删除、覆盖或远程写操作；安装目录非空/符号链接检查沿用原逻辑。
- 规则/文档一致性：本次没有改 `.claude/rules/prompt-prefix.md`、模型请求组装、系统提示或工具定义；`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 仍写构建只有 linux-x64/macos-arm64，与“ARM 不构建”一致。陈旧处只有测试标题“双方平台”。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动只在 `scripts/ci/*.mjs`、`ci/toolchain-lock.json`、测试和复核材料里；没有触碰系统提示、工具定义、历史消息、遮盖或任何 prompt 组装代码。没有新增每轮变化的值进入模型请求，仍然只在末尾追加；符合 `prompt-prefix.md` 第 2、4 条（固定在前、只追加）和第 10 条（字节确定）。

2. **不会让模型请求里的同一段文字在不同请求里变成不同字节。** 新规则依赖的是锁文件里的固定版本字符串，`supportedPlatforms()` 的顺序由冻结对象字面量固定；没有时间字段、上下文相关遮盖或无序集合进入模型请求。CI 结果里确实有随主机变化的 `platform` 和原有的 `new Date().toISOString()`，但它们不是发给模型的内容。

3. **有自动检查，覆盖到的反向用例会失败；但 wheel 的反向覆盖不完整。** `test/tooling/toolchain-platforms.test.mjs:27-34` 覆盖 `artifactPlatformKey`；`:53-60` 覆盖缺平台；`:68-100` 覆盖平台间互放；`:102-118` 覆盖 node/python/actionlint/gitleaks 版本不符；`:120-134` 覆盖 wheel 跨平台。`test/tooling/quality-local.test.mjs:571-591` 覆盖 linux-arm64 三项检查和 build/coverage/全量拒绝。若删掉对应校验，这些用例会失败。缺口是：wheel 的版本不符没有反向用例，macOS x86_64 wheel 放进 linux-x64 也没有反向用例。

4. **逐个核对使用点：**
   - `artifactPlatformKey` 返回 `macos-arm64`/`linux-x64`，被 `result.artifacts[].platform` 使用；`ci/result.schema.json:232-233` 的枚举正好接受这两个值，`aggregate.mjs:184` 用 `member.key` 比对也一致。x64/macOS 上返回值与 `buildPlatformKey` 相同，行为不变。
   - `linux-arm64` 由 `buildPlatformKey` 产生，被 `local-summary.platform`、`local.mjs` 的 build 目录名和安装脚本使用；`result.schema.json` 的 `artifact.platform` 不接受它，所以 build/browser/coverage 必须拒绝，`run.mjs` 用 `artifactPlatformKey` 是正确的。`local.mjs` 对 policy/static/security 不调它，不会误拒。
   - 新的确切文件名规则已逐项对照当前锁：node、python、actionlint、gitleaks 的 linux-x64/macos-arm64/linux-arm64 条目都能通过；Semgrep 的 linux-x64 和 macOS wheel 也能通过。没有发现现有合法条目被误拒。
   - `run.mjs` 的 producer 校验：`producer.matrixKey !== platform` 确实阻止跨主机复用（`run.mjs:562-569`），第 6 条“不成立”的判断成立；不过它没有直接比对 `producer.artifacts[0].platform`，靠 schema 枚举和后续 `verifyArtifact` 的 os/arch 检查兜底，属于可加固但不构成当前漏洞。
   - 仍会放行的错误锁文件：见第 1 条（macOS x86_64 wheel 进 linux-x64）和第 2 条（wheel 的 `name/version` 与文件名不一致）。
