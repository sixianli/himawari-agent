## 侧重检查

- **不可信/不合规输入**：新测试直接解析仓库内的 `package-lock.json` 和 `ci/toolchain-lock.json`；没有用 `entry.path` 拼文件路径，只把它当对象键（`test/tooling/toolchain-install-scripts-lock.test.mjs:12,20`）。JSON 损坏或字段缺失会让测试抛错，不会执行外部代码。结论：可接受。
- **错误路径**：审阅记录指向不存在的包时 `expect(locked,...).toBeTruthy()` 会失败（同文件 `:13`）；`nativeDependencies` 缺失会直接抛 TypeError，仍是失败，只是提示不友好。
- **安全/供应链**：CI 安装用 `npm ci --ignore-scripts`（`scripts/ci/install-dependencies.mjs:345`），只对 `better-sqlite3` 显式运行 node-gyp（`:352-353`），所以 `@google/genai` 的 `preinstall` 实际不会执行。发布包 2.21.0 的真实 manifest 内容离线无法核对，标「未核实」。
- **资源耗尽**：只读取两份 JSON，开销可忽略。
- **不可撤销操作**：无写文件、无删除；只改锁文件、文档和新增测试，均可用 git 恢复。删除的两条记录已确认在 `package-lock.json` 中没有对应包。
- **规则/文档与代码一致**：发现门槛没有进入必过的本地检查，详见下面第 1 条。

---

## 发现

### 1. 中：新门槛没有接入 `npm run check`，同类事故仍可能先合入 main 才暴露

- 文件:行：`package.json:26-27`、`.agents/instructions/delivery-mode.md:15,25`、`docs/incidents-and-gates.md:124`
- 问题：I-91 自己写的根因是「本地 `npm run check` 不核对这两份锁文件」，但新增测试只挂在 `npm test` 的 tooling/coverage 项目下，`check:steps` 里没有对应步骤。当前仓库 `DELIVERY_MODE` 是 `fast`，快速模式明确规定「不跑第 3 层（完整的 `npm test`）」，必过本地检查只有定向测试 + `npm run check` + `npm run build`。因此下一次依赖升级时，只按快速模式要求做本地检查的人仍然不会运行这条测试；CI 的安装步骤又会先于 policy/coverage 测试失败，事故会重复成「合并后才发现」。
- 证据（读代码证实）：
  - `package.json:26` `"check": "node scripts/run-all-checks.mjs"`，`:27` 的 `check:steps` 列表里没有任何 toolchain-lock 检查。
  - `.agents/instructions/delivery-mode.md:25`：「不跑第 2 层……不跑第 3 层（完整的 `npm test`）」。
  - `docs/incidents-and-gates.md:124` 的根因句仍然成立，但门槛描述只写「随 `npm test` 运行」，没有说明快速模式不跑它。
- 建议：把这项交叉校验做成 `npm run check` 的一步，例如新增 `check:toolchain-lock` 加入 `check:steps`；更自然的位置是 `scripts/ci/check-policy.mjs` 的 `validateToolchain`，它已经在 `check:ci-policy` 里运行并读取 toolchain 锁，只需再读 `package-lock.json` 做同样的断言。测试可以保留，但不能是唯一入口。

### 2. 中：新测试只比较版本和 `hasInstallScript`，没有比较 `scripts`/`reviewedFiles`，也不能代表隐式构建

- 文件:行：`test/tooling/toolchain-install-scripts-lock.test.mjs:10-24`、`scripts/ci/install-dependencies.mjs:201-212`
- 问题：
  1. 真正的安装审计判断条件包含 `expected.hasInstallScript || Object.keys(scripts).length || implicitBuild`，其中 `scripts` 是与真实 manifest 逐项比较，`implicitBuild` 是 `binding.gyp`；新测试两项都不覆盖。因此如果有人把某包的 `scripts` 内容写错但版本保持不变，新测试仍然通过，只在 `npm ci` 后的安装审计里才失败，正好回到这次事故的发现路径。
  2. 测试把 `hasInstallScript === true` 当作「有安装脚本」的唯一代理，并强制要求所有审阅记录满足它。若将来出现只有 `binding.gyp`、没有 lifecycle 脚本的包，真实审计会要求审阅记录，而新测试会反过来判这条合法记录失败，形成误报。
- 证据（读代码证实）：
  - `scripts/ci/install-dependencies.mjs:201-212`：
    ```js
    const implicitBuild =
      existsSync(join(absolute, "binding.gyp")) && manifest.gypfile !== false && !scripts.install;
    if (expected.hasInstallScript || Object.keys(scripts).length || implicitBuild) {
    ...
    sameRecord(decision.scripts, scripts),
    assert(!implicitBuild, ...)
    ```
  - 新测试 `:15` 只断言 `expect(locked.hasInstallScript).toBe(true)`，`:22` 只按 `locked.hasInstallScript` 决定是否要求审阅记录，均不读取 `scripts` 或 `reviewedFiles`。
- 建议：把真实审计里的判定抽成纯函数，测试直接复用；或者至少把 `hasInstallScript` 只是「至少存在一个 lifecycle 脚本」写进注释/文档，承认 `scripts` 和 `reviewedFiles` 只能由 `npm ci` 后的审计验证。这样不会把「两份锁文件对得上」说成比实际更强。

### 3. 低：新门槛没有反向/夹具用例，证据只有手工运行

- 文件:行：`test/tooling/toolchain-install-scripts-lock.test.mjs:10-24`
- 问题：测试直接读真实仓库文件，无法注入「版本不符」「缺审阅记录」「stale entry」等夹具；I-91 里「修复前报 stale review entry」只是手工证据，没有提交成自动反向用例。其它事故条目（如 I-73、I-84）都有明确的反向用例。
- 证据（读代码证实）：测试没有可传入的临时目录或锁对象参数，`read` 固定指向仓库根目录的两份文件（`:4,7-8`）。
- 建议：抽出 `assertInstallScriptReviews({ packageLock, toolchainLock })`，用临时 JSON 夹具覆盖：版本不符、stale entry、缺审阅记录、`hasInstallScript` 为假但记录了审阅、以及正确输入通过。这样「反向用例会失败」可以被自动验证。

### 4. 低：I-91 的「发布包摘要与锁文件一致」说法不准确

- 文件:行：`docs/incidents-and-gates.md:124`、`ci/toolchain-lock.json:1105-1116`
- 问题：`ci/toolchain-lock.json` 的 `nativeDependencies` 记录没有 tarball 摘要字段，摘要只在 `package-lock.json` 的 `integrity` 里；I-91 写「发布包摘要与锁文件一致」，容易让人以为 toolchain 锁里有可核对的摘要。实际能核对的是 `package-lock.json:1588-1591` 的版本/integrity，以及安装审计对实际 manifest 的 `scripts` 比较。
- 证据（读代码证实）：`ci/toolchain-lock.json:1107-1115` 只有 path/name/version/scripts/decision/reviewedFiles/reason；`package-lock.json:1587-1591` 才有 `resolved` 和 `integrity`。
- 建议：把这句改成「`package-lock.json` 的 `@google/genai` 版本与 integrity 已核对；实际安装后由 `auditInstalledDependencies` 核对 manifest 的 scripts」，并注明发布包内容是在线读取、仓库内无法自动复核。

### 5. 低（既有问题，非本 PR 引入，被新测试掩盖）：fsevents 的 `scripts: {}` 与 `hasInstallScript: true` 矛盾

- 文件:行：`ci/toolchain-lock.json:1128-1145`、`package-lock.json:4784,7063`
- 问题：两个 fsevents 记录都写 `"scripts": {}`，理由说「发布 manifest 没有安装命令」，但 `package-lock.json` 对两者都标了 `hasInstallScript: true`。按 npm 的通常语义，这个标志表示存在 `preinstall`/`install`/`postinstall`，与「没有安装命令」矛盾。新测试只检查 `hasInstallScript` 为真，不比较 `scripts`，所以这种矛盾不会在本地暴露；真正在 Darwin 上安装时，`sameRecord(decision.scripts, scripts)` 可能失败。
- 证据（读代码证实）：`ci/toolchain-lock.json:1132` 与 `:1141` 均为 `"scripts": {}`；`package-lock.json:4784`、`:7063` 均为 `"hasInstallScript": true`。真实 fsevents manifest 的 scripts 内容未读取，具体哪一侧错标「未核实」。
- 建议：单独核对 fsevents 2.3.3 / 2.3.2 的 manifest；如果确有 install 脚本，修正审阅记录并在有 Darwin 条件时验证；如果确实没有，则应确认 npm 为何标 `hasInstallScript`，并让测试不要用这个标志作为唯一代理。

---

## 核对作者说法

**读代码证实的部分：**

- `package-lock.json` 的 `@google/genai` 是 2.21.0（`package-lock.json:1588`），且是 `@earendil-works/pi-ai` 的直接依赖（`:956`）。
- 删除的两条路径 `node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai` 和 `.../protobufjs` 确实不在 `package-lock.json` 中；当前 Pi 嵌套包只有 photon-node、highlight.js、hosted-git-info、ignore、jiti、minimatch、proper-lockfile/retry、signal-exit、undici、yaml（`:1055-1151`）。删除正确。
- 新条目的字段能通过 `scripts/ci/install-tools.mjs` 的 `validateToolchainLock`：`version` 满足 `^\d+\.\d+\.\d+$`，`scripts` 的键属于三种 lifecycle，`reviewedFiles` 为空合法，`decision: "omit"` 合法。
- 当前 `package-lock.json` 中 `hasInstallScript: true` 的包正好是 @google/genai、better-sqlite3、两个 fsevents、protobufjs 共 5 个（`:1591,3462,4784,7063,7164`），`nativeDependencies` 也正好这 5 条，所以新测试在修复后能通过。
- I-91 事故行格式符合 `scripts/check-incident-gates.mjs`：7 列、编号 `I-91` 合法、日期合法、`count=1`、状态 `已落门槛`、门槛里有反引号路径且该文件存在（`check-incident-gates.mjs:8,11,48,61,65-70`）。
- 新测试会被 tooling 项目收集（`ci/policy.json:193-194` 的 `test/tooling/**/*.test.mjs`），且 `npm test` 的 coverage 项目包含 tooling（`ci/policy.json:96` 附近）。

**未核实的部分：**

- `@google/genai` 2.21.0 发布包的真实 `scripts`、是否存在 `install`/`postinstall`/`binding.gyp`，以及其 tarball 摘要；没有网络，无法读取。
- 作者所说的 CI 失败日志和修复前/后的实际运行结果；只能从代码推断新测试在旧 `ci/toolchain-lock.json` 上会因版本不符和 stale entry 失败。
- `docs/` 改动的严格文档校验结果。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只改 `ci/toolchain-lock.json`、`docs/incidents-and-gates.md` 和新增测试，没有任何 `apps/`、`packages/` 下组装提示词、工具定义、历史或遮盖的代码。发给模型的内容仍然只在末尾追加，每轮会变的值也没有被搬到前面；[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#append-only) 的约束未被触碰。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。改动只影响 CI 依赖审阅记录、文档和测试，不参与模型请求序列化；没有依赖前后文的遮盖、时间字段或无序集合进入请求。锁文件 JSON 的键顺序是否变化与模型请求无关。

3. **有没有对应的自动检查？反向用例是否会失败？** 有自动检查：新增 `test/tooling/toolchain-install-scripts-lock.test.mjs`，会检查「审阅记录版本与锁文件一致」和「带安装脚本的包必须有审阅记录」。旧锁文件确实会让它失败（版本 1.52.0 对 2.21.0，以及两条 stale entry）。但有两个缺口：没有夹具式反向用例证明各失败分支都真的会红；而且它没有接入 `npm run check`，快速模式下不会运行。因此「挡住同类错误」只部分成立。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `@google/genai` 的 `version: "2.21.0"`：`validateToolchainLock` 接受；`auditInstalledDependencies` 会拿它与安装后 manifest 比较；新测试与 `package-lock.json:1588` 比较。两端都能接受。
   - `scripts.preinstall`、`decision: "omit"`、`reviewedFiles: {}`：`validateToolchainLock` 接受字段和键；`auditInstalledDependencies` 会与真实 manifest 的 `scripts` 逐项比较，并检查 `implicitBuild`。本地测试没有覆盖这部分，只有安装审计覆盖。
   - 删除的两条嵌套记录：没有其它消费者引用这两个路径（全仓搜索只在新测试和安装脚本里出现 `nativeDependencies`），删除后 `auditInstalledDependencies` 的「过期条目」检查也不会再命中它们。
   - I-91 行：`check-incident-gates.mjs` 接受格式，门槛路径存在。
   - 新测试文件：被 tooling 项目收集，且能通过 `check-policy` 的测试清单/测试语法检查。
   - 结论：本次改动的值本身都能被现有消费者接受，没有出现 I-73 那种「清单里的 id 过不了后端校验」的问题；问题在于本地门槛没有接上，以及测试覆盖不到 `scripts`/`reviewedFiles`。
