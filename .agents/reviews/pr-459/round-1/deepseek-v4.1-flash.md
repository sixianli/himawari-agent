## 结论摘要

- 目标用例（在 ARM 上只跑 `--check security/static/policy`）按代码看可以走通：工具链按 `linux-arm64` 下载、安装、校验，结果里不写 artifact 平台，能过 `CheckResult`。
- 但改动把 `linux-arm64` 也接进了 build/browser/coverage/test 的平台标签，而下游的 `result.schema.json`、`evidence.schema.json`、`ci/policy.json` 矩阵都没有接受这个值。这正是 I-73 那类“新产生的 id 能不能过后端校验”的问题。
- 新增的 linux-arm64 文件名校验有洞：actionlint 和 gitleaks 的规则完全相同，互换不会被发现；x64/darwin 仍然完全不检查。
- 下载主机和“URL 文件名 = filename”两项没有问题；ARM 各产物的真实 SHA-256 无法离线核实。

---

## 读代码证实的问题（按严重度）

### 1. 高：`linux-arm64` 这个平台标签过不了 `CheckResult`/证据 schema

- 文件:行：`ci/result.schema.json:232-233`、`scripts/ci/run.mjs:476-481,535`、`ci/evidence.schema.json:113-124`
- 问题：改动让 build/browser/coverage/test 把 `buildPlatformKey()` 的结果写进 `result.artifacts[].platform`，在 ARM 上是 `linux-arm64`；但结果 schema 的 platform 枚举仍然只有两个值，`runCheck` 在写结果前会做校验。证据 schema 的 `platforms` 还限制了 `maxItems: 2`。
- 证据（亲自读到）：
  - `ci/result.schema.json:232-233`：`"platform": { "enum": ["linux-x64", "macos-arm64"] }`
  - `scripts/ci/run.mjs:476-481`：`platform: buildPlatformKey(),` 被 push 进 `result.artifacts`
  - `scripts/ci/run.mjs:535`：`validateRecord("CheckResult", result);`
  - `ci/evidence.schema.json:113-124`：`"platforms": { "minItems": 1, "maxItems": 2, ... "enum": ["linux-x64", "macos-arm64"] }`
- 影响：在 ARM 上走 build/browser/coverage，或 `run.mjs --input` 消费 `linux-arm64` 的 build 结果，最终会因 schema 拒绝而失败。对本次作者声明的 security/static/policy 不触发，因为这三项不写 artifact。
- 建议：要么本 PR 不把 build/browser/coverage 的标签改成 `linux-arm64`（保持只做工具链安装），要么同步把 `result.schema.json`、`evidence.schema.json`（含 `maxItems`）以及 `aggregate.mjs`、`main-*` 的硬编码一起打通，并加一条“linux-arm64 的 CheckResult 能通过 validateRecord”的正向测试。

### 2. 中：ARM 上 `local` 的 build 会被 policy 矩阵拒绝，新增测试却用 mock 掩盖了这一点

- 文件:行：`scripts/ci/local.mjs:34,70`、`scripts/ci/run.mjs:44-48`、`ci/policy.json:39-58`、`test/tooling/quality-local.test.mjs:135-147,571-588`
- 问题：`local` 在 ARM 上用 `platform = "linux-arm64"` 去执行 build，而 policy 的 build 成员只有 `linux-x64` 和 `macos-arm64`，`selectCheck` 会直接抛 `CI_MATRIX_UNSUPPORTED`。新增测试把 `run.mjs` 整个 mock 掉，只断言传给 `runCheck` 的 `matrixKey`，所以测试通过但真实路径失败。
- 证据：
  - `scripts/ci/local.mjs:34`：`const platform = buildPlatformKey();`
  - `scripts/ci/local.mjs:70`：`const result = await execute("build", platform);`
  - `scripts/ci/run.mjs:47-48`：`const member = check.members.find((entry) => entry.key === (key ?? "default")); if (!member) throw new Error(\`CI_MATRIX_UNSUPPORTED:${id}/${key}\`);`
  - `ci/policy.json:42-58`：build 的 members 只有 `key: "linux-x64"` 和 `key: "macos-arm64"`
  - `test/tooling/quality-local.test.mjs:135-147`：`vi.mock("../../scripts/ci/run.mjs", () => ({ runCheck: async (options) => {...} }))`
  - `test/tooling/quality-local.test.mjs:577-583`：断言 `summary.platform` 和 build 的 `matrixKey` 都是 `linux-arm64`
- 影响：ARM 上 `npm run ci:local`（不带 `--check`）或 `--check build` 不可用；新测试给了错误的信心。security/static/policy 不受影响。
- 建议：如果本 PR 只做第 1 步，就让 `local` 只在 ARM 上允许 `security/static/policy`，或对 build/coverage 明确保持 x64/macOS 拒绝；测试应至少调用真实的 `selectCheck`，而不是 mock 掉整个 runner。

### 3. 中：`actionlint` 与 `gitleaks` 的 linux-arm64 文件可以互换而不会被文件名规则发现

- 文件:行：`scripts/ci/install-tools.mjs:81-97`、`test/tooling/toolchain-platforms.test.mjs:55-61`
- 问题：两个工具的“架构”正则完全一样，`platformFilename` 只按平台取规则，不校验工具名前缀。把 gitleaks 的 linux-arm64 条目整块放进 actionlint 的 linux-arm64 槽位，校验会通过。
- 证据：
  - `scripts/ci/install-tools.mjs:85-86`：`actionlint: /_linux_arm64\.tar\.gz$/,` 与 `gitleaks: /_linux_arm64\.tar\.gz$/,`
  - `scripts/ci/install-tools.mjs:91-96`：`const expected = ARCHITECTURE_FILENAMES[platform]?.[kind]; assert(!expected || expected.test(filename), ...)`
  - 新增反向用例只测了“gitleaks 放进 node 槽位”：`test/tooling/toolchain-platforms.test.mjs:55-61`
- 影响：静态校验漏掉一种本应拒绝的锁文件；真装时通常会在执行 actionlint/gitleaks 版本检查时因可执行文件不存在而失败，但报错晚且不直观。
- 建议：规则里加入工具名前缀和版本，例如 actionlint 用 `/^actionlint_1\.7\.11_linux_arm64\.tar\.gz$/`，gitleaks 用 `/^gitleaks_8\.30\.0_linux_arm64\.tar\.gz$/`；并补 actionlint↔gitleaks 双向互换的反向测试。

### 4. 中低：文件名规则只覆盖 linux-arm64，x64/darwin 以及未来平台都是静默跳过

- 文件:行：`scripts/ci/install-tools.mjs:81-92`
- 问题：`ARCHITECTURE_FILENAMES` 只有 `linux-arm64`；`platformFilename` 在 `expected` 为 `undefined` 时直接放过。因此把 arm64 文件放进 `linux-x64` 或 `darwin-arm64` 槽位，锁文件校验不会报错。这是改动前就存在的缺口，但本次新表的写法让“只有一半平台被检查”更隐蔽。
- 证据：
  - `scripts/ci/install-tools.mjs:81-89` 只有 `"linux-arm64"` 一个键
  - `scripts/ci/install-tools.mjs:92`：`const expected = ARCHITECTURE_FILENAMES[platform]?.[kind];`
  - `scripts/ci/install-tools.mjs:94`：`!expected || expected.test(filename)`
- 影响：现在不会让 x64 CI 行为变化，但错误可以溜到安装阶段才暴露；将来在 `BUILD_PLATFORM_KEYS` 加平台时也会静默不检查。
- 建议：为三个平台都写明确的文件名规则；对“平台存在但没有对应规则”的情况直接失败，而不是 `!expected` 放过。

### 5. 低：注释/测试名声称“与 linux-x64 同版本”，但只校验了 Semgrep wheel 的版本

- 文件:行：`test/tooling/toolchain-platforms.test.mjs:23-38`
- 问题：测试标题是“pins aarch64 downloads ... at the same versions as linux-x64”，但实际只对四个下载物断言文件名含 arm64/aarch64，版本一致性只比较了 `semgrep.wheels`。Node/Python/actionlint/gitleaks 的 arm64 版本与 x64 是否一致没有测试；生产校验也不检查文件名/URL 里的版本是否等于锁里的 `baseline/version`。
- 证据：
  - `test/tooling/toolchain-platforms.test.mjs:26-30`：只拿四个下载物
  - `test/tooling/toolchain-platforms.test.mjs:31`：`for (const download of downloads) expect(download.filename).toMatch(/arm64|aarch64/);`
  - `test/tooling/toolchain-platforms.test.mjs:32-35`：版本比较只作用于 `lock.tools.semgrep.wheels`
- 影响：如果以后把 arm64 下载物写成别的 Node/Python 版本，`--check` 仍可能通过，只在真正安装执行版本检查时失败。
- 建议：从 `lock.node.baseline`、`lock.python.version`、`lock.tools[name].version` 拼出期望 filename/URL 片段，对 x64 和 arm64 同时断言；并补一个“arm64 版本与 x64 不同应失败”的反向用例。

### 6. 低：`run.mjs` 给 consumed artifact 贴的是主机平台，而不是 artifact manifest 的平台

- 文件:行：`scripts/ci/run.mjs:282-287,476-481` 对比 `scripts/ci/browser.mjs:129`、`scripts/ci/test.mjs:152`
- 问题：browser/test 改成用 `verified.manifest.platform.os/arch` 推导平台，但 `run.mjs` 写 `result.artifacts` 时仍用主机的 `buildPlatformKey()`。在 x64/macOS 上两者一致；在 ARM 上如果消费一个 x64 manifest 的 artifact，会记成 `linux-arm64`。
- 证据：
  - `scripts/ci/run.mjs:284`：`platform: buildPlatformKey(),`
  - `scripts/ci/run.mjs:478`：`platform: buildPlatformKey(),`
  - `scripts/ci/browser.mjs:129`：`platform: buildPlatformKey(verified.manifest.platform.os, verified.manifest.platform.arch),`
- 影响：本次目标不消费 artifact，故不触发；但只要 ARM 开始 consume，就会产生标签错误，且会被第 1 条的 schema 一并拦住。
- 建议：consume 路径统一用 artifact manifest 的平台，或在使用 `--artifact` 时显式校验 manifest 平台等于期望平台。

---

## 推测 / 未核实

- 未核实：新增的 linux-arm64 Node/Python/actionlint/gitleaks 和每个 wheel 的真实 SHA-256 是否与官方发布一致。仓库里没有可离线比对的基准，我也没有网络。
- 未核实：在目标 Oracle Ubuntu 24.04 aarch64 上，整组 aarch64 wheel（尤其 `manylinux_2_34_aarch64`、`manylinux_2_28_aarch64`）能否全部安装成功。按文件名看与 Ubuntu 24.04 的 glibc 兼容，但没有实际安装证据。
- 未核实：`npm run check` 是否实际通过（受工具限制不能运行 node/vitest）。上述测试结论来自读代码和读测试源码。
- 推测成分：第 3、4 条说“安装阶段会失败”，取决于归档里的可执行文件位置；静态校验阶段确实不会报错。

---

## 侧重检查

- 错误路径：检查了 `buildPlatformKey` 的不支持平台抛错、`selectCheck` 未知矩阵键、`fields` 缺平台条目、`platformFilename` 的 `undefined` 分支、`validateRecord` 的 schema 失败路径。发现第 1、2、4 条问题。
- 不可信输入：`artifact()` 会限制 filename 字符集、必须 HTTPS、主机必须在 `downloadHosts`、URL basename 必须等于 filename、sha256 必须是 64 位十六进制（`install-tools.mjs:60-72`）。新增 URL 的主机分别落在 `nodejs.org`、`github.com`、`files.pythonhosted.org`，都在允许列表内。
- 资源耗尽：新增内容只是同一套下载/解包流程多了一个平台；wheel 数量与 x64 同量级，未发现新增的无界循环、递归或重复下载。未发现新的不可撤销操作。
- 规则/文档一致性：本改动不碰提示词组装，`prompt-prefix` 规则不受影响；但代码新增的 `linux-arm64` 与 `result.schema.json`、`evidence.schema.json`、`ci/policy.json` 的平台清单不一致。
- 反向用例：新增的“缺 linux-arm64 条目”“x64 文件放进 arm64 槽”“node 槽放 gitleaks”“arm64 wheels 放 x64/darwin wheels”按正则会失败；但 actionlint↔gitleaks 互换、x64/darwin 槽位放错架构不会失败，且没有真实 `runCheck` 的 linux-arm64 正向测试。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动全部在 `scripts/ci/*`、`ci/toolchain-lock.json` 和测试里，没有碰系统提示、工具定义、历史消息或遮盖的组装代码。因此发给模型的内容仍然只会在末尾追加，改动也没有把任何每轮变化的值放进开头或最后一条消息。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。改动没有引入时间、随机数或无序遍历序列化；`supportedPlatforms()` 的顺序来自固定对象插入顺序，`fields()` 还会排序键，锁文件内容也是确定的。唯一相关的 `verifiedAt: new Date().toISOString()` 是既有代码，不在本次改动内，也不参与模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，但不全。按代码推断，新增的 `toolchain-platforms.test.mjs` 中“缺条目、x64 文件放 arm64、node 放 gitleaks、wheel 放错平台”确实会失败；`buildPlatformKey` 的非法平台用例也会失败。缺口是：
   - actionlint↔gitleaks 互换不会失败；
   - x64/darwin 槽位放错架构不会失败；
   - 新增的 `quality-local.test.mjs` 把 `runCheck` mock 掉，无法证明真实的 policy/schema 接受 `linux-arm64`（实际 build 会被 policy 拒绝）；
   - 没有测试保证 `linux-arm64` 的 `CheckResult` 能过 `result.schema.json`（实际过不了）。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `buildPlatformKey` 的 `"linux-x64"` / `"macos-arm64"`：x64/macOS 的 build、browser、test、local、`--input` 行为不变，下游 schema/policy 都接受。
   - `"linux-arm64"`：锁文件 `artifacts`/`wheels` 使用原生键，安装和 `verifyInstalledTools` 能接受；但作为 `result.artifacts[].platform` 被 `ci/result.schema.json:233` 拒绝，作为 build `matrixKey` 被 `ci/policy.json:42-58` 和 `check-policy.mjs:323-335` 拒绝，作为 evidence platform 被 `ci/evidence.schema.json:123` 及 `maxItems: 2` 拒绝。ARM 拿来跑 security/static/policy 时，结果里不写这些值，所以能通过。
   - linux-arm64 的新下载物：`artifact()` 的 URL 主机、文件名、摘要校验都能接受；`platformFilename` 的 linux-arm64 规则能接受，但 actionlint/gitleaks 规则不能区分工具，x64/darwin 则没有规则。
   - x64/macOS 的产物名和平台判断：`platforms.mjs:1-5` 的映射在 linux-x64/darwin-arm64 上与改动前一致，未发现行为变化。

整体上，作者“x64 和 macOS 入口不变”这一条成立；“只做工具链安装的第 1 步”这一条与实际改动范围不完全一致，因为 `local`、`build`、`browser`、`test` 已经把 `linux-arm64` 接进了尚未准备好接收它的下游。
