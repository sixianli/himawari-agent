## 复核结论（PR 349，adae91b）

### 读代码证实的

**1.（中）`npm run check` 仍然不核对两份锁文件，事故根因只堵了一半**
- 文件:行：`package.json:27`、`docs/incidents-and-gates.md:124`
- 问题：事故行自己写明根因是「本地 `npm run check` 不核对这两份锁文件是否一致，所以合并后才发现」，但本次改动只是把检查放进 `npm test`（CI coverage 任务）；`check:steps` 的长串命令里没有任何锁文件一致性步骤。
- 证据：`package.json:27` 的 `check` 脚本列出的全部 `check:*` 步骤中没有 toolchain/lockfile 相关项；新测试只被 `ci/policy.json:194`（tooling project include）和 `ci/coverage-policy.json:8`（projects 含 `tooling`）引用，经由 `npm test`（`scripts/ci/local.mjs:76` → coverage 检查，`scripts/ci/check-coverage.mjs:399` 强制四个 project）执行。
- 建议：在 `check:steps` 里加一步（如 `check:toolchain-lock`）直接跑这个测试文件，使合并不等 CI（ADR 0176）的情况下本地必过门也拦得住同类错误。

**2.（低）新测试的判定条件与 `auditInstalledDependencies` 不完全一致，未来会出现「audit 要求条目、测试禁止条目」的矛盾**
- 文件:行：`test/tooling/toolchain-install-scripts-lock.test.mjs:15,22`、`scripts/ci/install-dependencies.mjs:201-205`
- 问题：audit 对 `implicitBuild`（有 `binding.gyp`、无 install 脚本、`hasInstallScript` 为假）的包也强制要求审阅条目（`install-dependencies.mjs:203-205`），但测试第二方向只看 `hasInstallScript`（第 22 行），第一方向又要求 `hasInstallScript === true`（第 15 行）。将来若出现这种包，按 audit 必须加条目，按测试加了就红。
- 建议：测试复刻 audit 的完整条件（`hasInstallScript || scripts || binding.gyp`），或直接复用 `auditInstalledDependencies` 的判定函数做静态断言。

**3.（低，未核实）2.21.0 发布包脚本内容的说法无法在本地核实**
- 我不能上网，无法读 npm tarball 验证「只有 `preinstall: echo no-op`、无 install/postinstall/binding.gyp」。但这声明实际由 CI 运行时强制：`install-dependencies.mjs:206-211` 用 `sameRecord(decision.scripts, scripts)` 对 npm ci 后的真实 manifest 逐字段比对，写错会在 `npm run ci:install` 失败，不会静默。风险已被现有门槛兜住。

**其余核对（全部成立）：**
- 两条被删记录在 `package-lock.json` 确实不存在：pi-coding-agent 嵌套包列表（`package-lock.json:1055-1151`）里无 `@google/genai`、无 `protobufjs`；全仓 grep 也无任何代码引用这两个嵌套路径。protobufjs 现只剩顶层 `node_modules/protobufjs` 7.6.6（`package-lock.json:7160-7164`，hasInstallScript true），且有对应审阅条目（`ci/toolchain-lock.json:1147-1158`）。
- 五个 hasInstallScript 包与五条审阅记录一一对应、版本一致：`@google/genai` 2.21.0（lock:1588/1591 ↔ toolchain-lock:1107-1109）、better-sqlite3 12.11.1、fsevents 2.3.3、playwright 嵌套 fsevents 2.3.2、protobufjs 7.6.6。
- 保留的 `@google/genai` 条目字段齐全（path/name/version/scripts/decision/reviewedFiles/reason），符合 `install-tools.mjs:187-202` 的 schema（decision ∈ {build, omit}、reason 非空）；`reviewedFiles: {}` 不触发文件摘要检查。
- 事故行格式符合 `scripts/check-incident-gates.mjs`：`I-91` 匹配 `/^I-\d{2,}$/`（:48）、日期、各列非空、次数 1、状态「已落门槛」∈ `INCIDENT_STATES`（:8）、门槛列含存在的仓库路径 `test/tooling/toolchain-install-scripts-lock.test.mjs`（:65-70 的存在性检查会通过）。
- 反向用例静态推演确实会失败：用修复前锁文件跑，第一条记录 `node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai` 在 lock 里找不到 → 第 13 行 `stale review entry` 失败；版本不符 → 第 14 行失败；hasInstallScript 包缺审阅 → 第 23 行 `unreviewed` 失败。作者声明的复现路径与代码一致。
- `test/tooling/security.test.mjs:287` 断言的是 package-lock 的枚举结果，嵌套包仍在，删除 toolchain-lock 条目不影响它。

### 推测（未核实）
- 事故行声称「`auditInstalledDependencies` 在 npm ci 后的真实 node_modules 上修复后通过」——我无法运行 CI 验证，只能确认代码逻辑上修复后所有断言可满足。

### 侧重检查

走了一条最普通流程：`npm run ci:install` → `installDependencies`（install-dependencies.mjs:273）→ 工具校验 → `auditManifestDependencies`（:334）→ `npm ci --ignore-scripts`（:342）→ `auditInstalledDependencies`（:351）→ 逐包比对，失败点在 ：208（版本不符，即本次事故）或 ：244（过期条目）。

覆盖情况：audit 的各分支已有 fixture 级测试（`test/tooling/toolchain.test.mjs:292-362`）；「真实仓库两份锁文件互相对得上」此前无任何覆盖，本次新测试补上（tooling project，coverage 检查强制执行）；「scripts 字段与真实发布包 manifest 一致」仍只有 CI 运行时 audit 覆盖，无静态测试（也难以离线测）。文档与代码一致（事故行描述的门槛与实际新增文件相符）。无测试覆盖的路径：`installDependencies` 主流程的本地全链路（依赖 .ci-output 工具目录，只有 CI/本地 ci 脚本跑）。

### 必答问题

1. **不会。**改动只涉及 `ci/toolchain-lock.json`、`docs/incidents-and-gates.md`、新增测试文件，不触碰系统提示、工具定义、历史消息、遮盖的任何代码或数据；发给模型的内容不受影响，也不存在每轮变化的值。
2. **不会。**新增内容全是静态 JSON/Markdown/测试代码，无时间戳、无前后文依赖的遮盖、无顺序敏感集合（nativeDependencies 只是删了数组前两条，未引入排序逻辑）。
3. **有检查，反向用例会失败**（见上「读代码证实的」）；但检查只在 `npm test`/CI coverage 任务里跑，`npm run check` 仍不含它——这是发现 1。事故行本身的格式由 `check:incident-gates` 覆盖。
4. **能接受。**「2.21.0」的产生处（toolchain-lock:1109）与两处使用（audit `install-dependencies.mjs:208` 对真实 manifest、测试 ：14 对 package-lock）双端一致；被删两条无任何使用方；保留字段通过 `install-tools.mjs:187-202` schema 校验和 audit 的逐字段比对；`security-exceptions.json` 引用的 `node_modules/@google/genai` 顶层路径与 2.21.0 tarball 与新值一致（ci/security-exceptions.json:1372-1374）。
