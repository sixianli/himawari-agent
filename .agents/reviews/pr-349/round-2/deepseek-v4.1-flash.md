# 复核结论

## 一、读代码证实的问题（按严重度）

### 1. 中 — 新门槛已接入 `main`，但没有“接线”回归测试

- 文件: `scripts/ci/check-policy.mjs:1274`、`test/tooling/toolchain-install-scripts-lock.test.mjs:19`、`test/tooling/policy.test.mjs:58-84`
- 问题: 新函数本身有测试，但没有测试断言 `main` 真的调用了它。把 `check-policy.mjs:1274` 整行删掉，现有测试仍会全绿：`toolchain-install-scripts-lock.test.mjs` 直接调用函数，`policy.test.mjs` 只把真实 `package-lock.json` 拷进夹具，然后仍然期望质量工作流错误。
- 证据:
  - `check-policy.mjs:1274`：`validateInstallScriptReviews(lock, readJson(path.join(root, "package-lock.json")));`
  - `toolchain-install-scripts-lock.test.mjs:19-23` 只测函数：`validateInstallScriptReviews(read("ci/toolchain-lock.json"), read("package-lock.json"))`
  - `policy.test.mjs:83` 只断言 `CI_QUALITY_WORKFLOW_MISMATCH:jobs`，没有任何锁文件不一致的入口用例。
- 建议: 在 `policy.test.mjs` 加一条真正走 `policyMain(["--root", temp])` 的用例：临时仓库里复制一份锁文件、改掉某个审阅记录的版本，断言 `main` 抛 `Install-script review version differs`。这正好补上一轮“新门槛没接入”的同类风险。

### 2. 低 — I-91 的事故证据文字与旧锁文件的实际首错不符

- 文件: `docs/incidents-and-gates.md:124`、`scripts/ci/check-policy.mjs:1170-1176`
- 问题: 事故行说“修复前的 `ci/toolchain-lock.json` 在真实锁文件上报 `Install-script review version differs`”。但按代码的执行顺序，旧锁文件会先在“过期嵌套记录”上失败，报的是 `missing from package-lock`，不会先报版本不符。
- 证据:
  - 新函数先按 `for (const review of reviews)` 逐条检查 `packages[review.path]`（`check-policy.mjs:1170-1176`），发现包不在锁文件里就直接抛 `Install-script review for a package missing from package-lock`。
  - `git show a937a55:ci/toolchain-lock.json` 的第一条审阅记录就是 `node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai`（约 1105-1117 行），第二条是嵌套 `protobufjs`。
  - `git show a937a55:package-lock.json` 里没有这两个嵌套路径，只有顶层的 `node_modules/@google/genai`（1587 行）。
  - 所以旧锁 + 新函数的第一条错误应是 `missing from package-lock`，不是 `version differs`。
- 建议: 把证据改成实际的首错（过期记录/缺包），或者写明“删掉两条过期记录后、只保留版本不符时”才报 `version differs`。否则这条证据无法从提交里复现。

### 3. 低 — 本地门槛不核对 `review.name`，与 `auditInstalledDependencies` 的消费端校验不对齐

- 文件: `scripts/ci/check-policy.mjs:1167-1186`、`scripts/ci/install-dependencies.mjs:207-210`
- 问题: 新函数只使用 `review.path`、`review.version` 和 `locked.hasInstallScript`，完全不看 `review.name`。而 `auditInstalledDependencies` 在 `npm ci` 之后要求 `decision.name === manifest.name`。因此一条 path/version 正确但 `name` 写错的审阅记录能通过本地 `npm run check`，只在 CI 安装依赖后才失败。脚本内容只由 audit 核对是事故行里已写明的取舍，但 `name` 这个字段其实在本地就能核对。
- 证据:
  - `check-policy.mjs:1170-1180` 只比较 `locked.version` 与 `review.version`、`locked.hasInstallScript`。
  - `install-dependencies.mjs:207-210`：`decision.name === manifest.name && decision.version === manifest.version && sameRecord(...)`。
- 建议: 在 `validateInstallScriptReviews` 里从 path 推导包名（`path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)`）并与 `review.name` 比较；或者把锁文件层面的校验抽成 audit 和新门槛共用的一段，避免两端继续分叉。

### 4. 低（设计提醒）— 反向检查比 audit 更严：对所有平台的可选包都要求审阅

- 文件: `scripts/ci/check-policy.mjs:1182-1185`、`scripts/ci/install-dependencies.mjs:166-239`
- 问题: 新函数遍历 `package-lock.packages` 的全部条目，只要 `hasInstallScript === true` 就要求审阅，不考虑 `optional`/`os`/`cpu`；audit 只检查实际安装出来的路径，未安装的可选平台包不会强制审阅。当前锁文件不会误伤：5 个带标记的包都已有审阅记录（`@google/genai`、`better-sqlite3`、`fsevents` 2.3.3、`playwright` 下的 `fsevents` 2.3.2、`protobufjs`），真实锁文件的正向测试也通过。但以后只是更新锁文件、引入一个未安装平台的可选安装脚本包时，本地门槛会先失败，而 audit 本来会放行。
- 证据:
  - `check-policy.mjs:1183-1185` 对 `Object.entries(packages)` 全量检查。
  - `install-dependencies.mjs:166` 的 `paths` 来自实际安装目录，`install-dependencies.mjs:233-239` 才处理未安装的可选包。
- 建议: 明确取舍并写进事故行或测试注释。若想和 audit 完全一致，可跳过 `optional === true` 且平台不匹配、且未安装的包；若要保持“所有平台的安装脚本都要有人审阅”，就保留现状并说明这是有意更严。

---

## 二、推测 / 未核实

- 未核实：作者说已读 `@google/genai` 2.21.0 发布包、确认只有 `preinstall: echo 'preinstall: no-op'` 且摘要与 `package-lock.json` 的 `integrity` 一致。仓库内只能看到锁文件里的 `hasInstallScript: true` 和 `integrity`，无法离线验证 tarball 内容。
- 未核实：`scripts/model-review/opencode-lock/package-lock.json:20` 的 `opencode-ai` 也有 `hasInstallScript: true`，但它不在本次 `validateInstallScriptReviews` 的输入范围（只读根 `package-lock.json`）。本次事故行只声明根锁文件，所以不算这次改动的缺陷；该锁的安装脚本是否另有审阅/审计覆盖，我没有核实。
- 推测：如果旧锁的“修复前”验证用的是“已删掉两条嵌套记录、但还没升版本”的中间状态，那么文档里的 `version differs` 才能成立；但提交里没有记录这个中间状态，按提交直接复现不出来。

---

## 三、侧重检查

我检查了以下错误路径和不可信输入路径：

- **缺文件 / 畸形输入**: `main` 用 `readJson` 读 `package-lock.json`（`check-policy.mjs:1274`），文件缺失会直接抛错；`packageLock?.packages ?? {}` 在缺 `packages` 时会让带审阅记录的场景报“缺包”，失败关闭（fail closed）。`nativeDependencies` 不是数组时 `for...of`/`.map` 会抛错，也是失败关闭。
- **资源耗尽**: 新函数只做线性的 `reviews` 遍历和 `packages` 遍历，不递归、不写文件、不发网络请求；当前锁文件约 9 千行，开销可忽略。
- **不可撤销操作**: 没有。函数是纯读校验，错误通过 `main` 的 `catch` 写 stderr 并置 `process.exitCode = 1`（`check-policy.mjs:1314-1320`）。
- **安全 / 供应链**: 新门槛只验证版本和 `hasInstallScript` 标记，不验证脚本内容、`reviewedFiles` 摘要或 `name`；脚本内容和文件摘要仍依赖 `npm ci` 之后的 `auditInstalledDependencies`（`install-dependencies.mjs:203-217`）。另外 `install-dependencies.mjs:345` 明确用 `--ignore-scripts`，所以安装阶段不会执行未审阅脚本，这个设计是合理的。跨端字段 `name` 的缺口见问题 3。
- **规则 / 文档与代码一致性**: “属于 `npm run check`”是实的：`package.json:27` 的 `check:steps` 含 `check:ci-policy`，`scripts/run-all-checks.mjs:29-37` 按 `check:steps` 逐条执行。测试文件位于 `test/tooling/**/*.test.mjs`，会被 tooling 项目收集（`ci/policy.json:192-197`）。唯一不一致是问题 2 的证据措辞。
- **误伤现有合法锁文件**: 按当前仓库文件，不误伤；`toolchain-install-scripts-lock.test.mjs:19-23` 的正向测试就是对着真实锁文件跑的。未来可选平台包的严格性见问题 4。

---

## 四、必答问题

1. **会改变模型已见过的请求开头吗？**
   不会。本次改动只涉及 `ci/toolchain-lock.json` 的审阅记录、`scripts/ci/check-policy.mjs`、CI 测试和事故文档，没有触碰系统提示、工具定义、历史消息、遮盖或请求组装代码。发给模型的内容仍应遵守“已经发出的内容只能在末尾追加”（`.claude/rules/prompt-prefix.md:34-35`），每轮变化的值仍只能放在最后一条用户消息里（同文件 27-28 行）；本次没有改变这些行为。另外，`@google/genai` 2.21.0 在基准提交 `a937a55` 的 `package-lock.json:1587` 就已经存在，本次 diff 也没有改 `package-lock.json`。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。新代码只读取两个 JSON 文件并返回 `true` 或抛错；`Set`/`Object.entries` 只用于内存中的校验，不会序列化进模型请求，也没有时间、随机数或依赖遍历顺序的输出。它不影响任何模型请求字节。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有，但只到函数级。`test/tooling/toolchain-install-scripts-lock.test.mjs:28-52` 的四个反向夹具分别覆盖：版本不符、包已离开锁文件、审阅了没有安装脚本的包、锁文件里有安装脚本但没有审阅记录。去掉新函数里对应的任一断言，这些用例会失败。真实锁文件的正向用例 `:19-23` 也会在现有锁文件漂移时失败。**缺口**是 `check-policy.mjs:1274` 的接线没有测试：删掉这行调用，所有现有测试仍会通过（见问题 1）。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   逐个核对如下：
   - `ci/toolchain-lock.json` 的 `nativeDependencies` 新增/修改的是 `@google/genai` 2.21.0，删除了两条嵌套记录。`scripts/ci/install-tools.mjs:187-214` 接受它：path 以 `node_modules/` 开头、版本满足 `^\d+\.\d+\.\d+$`、`scripts` 只有 `preinstall`、`decision` 是 `omit`、`reviewedFiles` 为空、`reason` 非空；`install-dependencies.mjs:207-217、240-246` 也接受：版本对得上、实际脚本对得上、锁文件里该 path 存在且 `hasInstallScript` 为真。
   - `package-lock.json` 的 `hasInstallScript` 共 5 处（1587、3458、4779、7058、7160 附近），与当前 5 条审阅记录一一对应（`ci/toolchain-lock.json:1105-1159`），新函数和 audit 都接受。
   - 新函数消费的 `review.path` / `review.version` / `locked.hasInstallScript` 三端一致；`review.name` 存在消费端（audit）校验但新函数不校验（问题 3）；脚本内容仍只在 audit 核对，事故行已明确说明。
   - 删除的两条嵌套记录在 `package-lock.json` 中已不存在，删除是正确的；若保留，新的反向检查会先报 `missing from package-lock`，audit 的过期条目检查也会报错。

**总体结论**：新函数的核心判定与事故描述基本一致，当前真实锁文件不会被误伤；需要补一条 `main` 接线级反向测试，并修正 I-91 中不可复现的错误信息证据。
