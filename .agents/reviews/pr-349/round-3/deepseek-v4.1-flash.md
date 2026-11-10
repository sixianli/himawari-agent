## 结论

未发现高或中严重度缺陷。作者本轮声称的 4 项改动都与代码一致：`review.name` 核对已接入 `check-policy` 入口，包名推导对当前 5 条真实记录（含 `@scope` 与嵌套路径）全部正确，夹具重构保持原语义，I-91 的“旧锁文件首错”证据也符合实际。下面只列低严重度问题和改进建议。

## 侧重检查

- **错误路径 / 非法输入**：核对了 `validateInstallScriptReviews` 对缺失包、版本不符、无安装脚本、多余记录、缺记录、包名不符的处理；确认当前仓库的 5 条真实记录全部通过路径包名推导。发现该函数不校验 `review.path` 是否以 `node_modules/` 开头、不校验路径重复、不校验 `name` 非空，见下面低 #2。
- **安全**：本次改动只增加只读校验、锁文件审阅数据和测试，没有新增网络请求、凭据读取或可执行代码路径。`ci/toolchain-lock.json` 中 `@google/genai` 2.21.0 的 `hasInstallScript` 与 `package-lock.json:1587-1591` 一致。复核记录目录未被读取（git 包装器拒绝访问 `.agents/reviews/`），因此未人工检查其中的敏感内容。
- **资源耗尽**：新增循环分别是 `nativeDependencies` 和 `package-lock.packages` 的线性遍历，没有递归或按输入大小反复拼接；测试夹具通过 `afterEach` 删除临时目录。
- **不可撤销操作**：没有。校验函数只读文件；测试只写临时目录。
- **规则 / 文档 / 代码一致性**：I-91 行可以正常通过事故表解析，引用的测试路径存在；但门槛描述漏写了新增的包名规则，见下面低 #3。

## 发现的问题（按严重度）

### 低 #1：包名推导逻辑重复且硬编码 13，容易与另一处消费者漂移

- 文件：`scripts/ci/check-policy.mjs:1181-1184`
- 问题：新增代码用硬编码 `13` 推导路径中的包名，而 `scripts/ci/install-dependencies.mjs:193-194` 用 `"node_modules/".length` 做同一件事。两处将来任何一处改动（例如改常量、改嵌套规则）都会导致本地检查和安装后审计对同一个记录给出不同结论。
- 证据（读代码证实）：

  `scripts/ci/check-policy.mjs:1181-1184`：
  ```js
  assert(
    review.name === review.path.slice(review.path.lastIndexOf("node_modules/") + 13),
    `Install-script review name differs from its path: ${review.path}`,
  );
  ```

  `scripts/ci/install-dependencies.mjs:193-194`：
  ```js
  const declaredName = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  assert(manifest.name === declaredName, `实际依赖名称不匹配: ${path}`);
  ```
- 建议：抽出共享函数（例如 `packageNameFromPath(path)`）放到公共模块，两处都调用；至少把 `13` 改成 `"node_modules/".length` 并注释其与安装后审计的关系。

### 低 #2：本地入口没有校验审阅记录路径的基本形状和唯一性

- 文件：`scripts/ci/check-policy.mjs:1170-1184`
- 问题：`validateInstallScriptReviews` 只按 `review.path` 去 `package-lock.packages` 查表，没有先断言路径以 `node_modules/` 开头、没有查重、没有断言 `review.name` 非空。`scripts/ci/install-tools.mjs:193-200` 有这些校验，但 `npm run check:ci-policy` 只调用 `check-policy.mjs`，不会调用 `install-tools.validateToolchainLock`。因此本地门槛对畸形输入的覆盖弱于 CI 安装步骤。
- 证据（读代码证实）：

  `scripts/ci/check-policy.mjs:1170-1172`：
  ```js
  for (const review of reviews) {
    const locked = packages[review.path];
    assert(locked, `Install-script review for a package missing from package-lock: ${review.path}`);
  ```

  `scripts/ci/install-tools.mjs:193-200`：
  ```js
  assert(
    entry.path.startsWith("node_modules/") &&
      !entry.path.split("/").includes("..") &&
      !nativePaths.has(entry.path),
    "原生依赖路径重复或非法",
  );
  nativePaths.add(entry.path);
  assert(/^\d+\.\d+\.\d+$/.test(entry.version) && entry.name.length > 0, "原生依赖版本不精确");
  ```
- 推测（未在现有仓库数据中复现）：如果将来 `package-lock.json` 的某个非 `node_modules/` 键（例如 workspace 键）带上 `hasInstallScript: true`，审阅记录的 `path` 也写成该键、`name` 写成空字符串，则 `slice(lastIndexOf("node_modules/") + 13)` 会得到空字符串，当前函数可能放行；只有 CI 安装阶段的 `validateToolchainLock` 才会拒绝。当前真实锁文件没有这种条目，因此不是现实缺陷。
- 建议：在 `validateInstallScriptReviews` 开头对 `review.path` 断言 `startsWith("node_modules/")`、无 `..`、非空 `name`，并检查路径唯一；或直接复用 `validateToolchainLock` 的相应校验。

### 低 #3：I-91 门槛描述没有写新增的包名核对规则

- 文件：`docs/incidents-and-gates.md:124`
- 问题：事故行把门槛描述为“版本相同、带安装脚本标记”，只字未提 `review.name` 必须等于路径推导的包名；测试清单里却写了“包名不符”。读者只看门槛描述不会知道新增规则。
- 证据（读代码证实）：文档原文是“审阅记录必须指向 `package-lock.json` 里版本相同、带安装脚本标记的包，带安装脚本标记的包必须有审阅记录”；代码在 `scripts/ci/check-policy.mjs:1181-1184` 另加了 `review.name` 与路径包名核对的断言。
- 建议：在门槛描述里补一句“审阅记录里的 `name` 必须等于由路径推导出的包名”，并说明这条规则的目的（与安装后 `auditInstalledDependencies` 的 `decision.name === manifest.name` 对齐）。

### 低 #4（测试健壮性）：新增 policy 用例依赖 `main` 的校验顺序

- 文件：`test/tooling/policy.test.mjs:91-100`、`scripts/ci/check-policy.mjs:1278-1287`
- 问题：新增 `[I-91]` 用例使用的夹具没有 `.github/workflows/quality.yml`，它能通过是因为 `validateInstallScriptReviews` 在读取 `quality.yml` 之前执行。若将来重排 `main` 的校验顺序，测试会因 `ENOENT` 失败而不是命中断言，虽然仍是“红”，但诊断信息会误导。
- 证据（读代码证实）：

  `scripts/ci/check-policy.mjs:1278-1287`：
  ```js
  validateInstallScriptReviews(lock, readJson(path.join(root, "package-lock.json")));
  const workflow = path.resolve(root, args["--workflow"] ?? ".github/workflows/ci.yml");
  validateWorkflow(...);
  validateMainWorkflow(...);
  validateQualityWorkflow(
    readJson(path.join(root, "ci/quality-policy.json")),
    readFileSync(path.join(root, ".github/workflows/quality.yml"), "utf8"),
    lock,
  );
  ```

  新用例只改了 `ci/toolchain-lock.json`，没有创建 `quality.yml`（`test/tooling/policy.test.mjs:92-99`）。
- 建议：在 `policyFixtureRoot` 里一并复制 `ci/quality-policy.json` 和 `.github/workflows/quality.yml`（和第一个用例一致），或让新用例明确依赖并断言当前错误信息。这样测试不依赖校验函数的相对顺序。

## 作者说法逐条核对

- **“`policy.test.mjs` 新增 `[I-91]` 接线用例（走 `policyMain` 入口，改坏审阅记录版本必须报错）”**：属实。`test/tooling/policy.test.mjs:91-100` 导入 `main as policyMain`，把 `nativeDependencies[0].version` 改成 `"0.0.1"`，并断言抛出 `Install-script review version differs from package-lock`。该错误字符串只存在于 `validateInstallScriptReviews`（`scripts/ci/check-policy.mjs:1175`），因此确实验证了接线。
- **“夹具抽成 `policyFixtureRoot`”**：属实。`test/tooling/policy.test.mjs:58-79` 是原用例的建目录、`git init/config/commit`、复制文件逻辑；原用例在 `81-89` 行改为调用它，原断言行未变。
- **“`validateInstallScriptReviews` 增加 `review.name` 与路径包名核对（含夹具用例）”**：属实。`scripts/ci/check-policy.mjs:1181-1184` 新增断言；`test/tooling/toolchain-install-scripts-lock.test.mjs:37-41` 有“名称与路径不符必须失败”的反向用例。
- **“事故行 I-91 证据改为旧锁文件实际首错”**：属实。旧 `ci/toolchain-lock.json` 的 `nativeDependencies` 第一项是已从 `package-lock.json` 消失的 `node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai`（见 `git diff a937a55..2437f6b -- ci/toolchain-lock.json`），当前 `validateInstallScriptReviews` 会先命中 `Install-script review for a package missing from package-lock`。当前 `package-lock.json` 中已无该嵌套路径（grep 只匹配到其他 pi 嵌套包）。
- **“slice 偏移 13 = `node_modules/`.length”**：属实，`"node_modules/"` 正好 13 个字符；当前 5 条真实记录全部推导正确，见必答问题 4 的表。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。改动只涉及 `ci/toolchain-lock.json`、`scripts/ci/check-policy.mjs`、`docs/incidents-and-gates.md` 和 `test/tooling/` 下的测试/夹具，没有修改系统提示、工具定义、历史消息、资料块或遮盖逻辑；也没有新增任何模型的请求组装代码。因此不存在“请求开头变化”或“每轮变化值放错位置”的问题，`prompt-prefix` 规则不适用于本次改动。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

不会。本次没有改动发给模型的序列化内容。新增的校验是对仓库文件的确定性检查；`Object.entries(packages)` 的遍历顺序只影响“先报哪一条错误”，不影响模型请求字节。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有：

- `test/tooling/toolchain-install-scripts-lock.test.mjs`：真实锁文件必须通过；版本不符、包名不符、过期记录、无安装脚本记录、缺记录五个反向夹具必须抛错。
- `test/tooling/policy.test.mjs:91-100`：`check-policy` 入口确实调用了 `validateInstallScriptReviews`。

按代码推断：删除 `scripts/ci/check-policy.mjs:1181-1184` 的包名断言，`rejects a review whose package name differs from its path` 会失败；删除 `scripts/ci/check-policy.mjs:1278` 的接线，`[I-91]` policy 用例会失败。反向用例的方向是对的。限制：本次没有运行测试或 `npm ci`（工具限制），以上是读代码推断，不是执行结果。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对如下（读代码证实）：

| 值 | 产生/修改处 | 使用处 | 结论 |
|---|---|---|---|
| `ci/toolchain-lock.json` 的 `nativeDependencies` 版本 `2.21.0` | `ci/toolchain-lock.json:1107-1115` | `check-policy.mjs:1170-1189`、`install-dependencies.mjs:157,203-211,240-246`、`install-tools.mjs:187-219` | 通过。`package-lock.json:1587-1591` 版本为 `2.21.0` 且 `hasInstallScript: true`。 |
| `node_modules/@google/genai` 的 `name: "@google/genai"` | `ci/toolchain-lock.json:1108` | 同上；安装后审计比较 `decision.name === manifest.name` | 通过。路径推导为 `@google/genai`。 |
| `node_modules/better-sqlite3` 12.11.1 | `ci/toolchain-lock.json:1118-1126` | 同上；另有 build 决策检查 `entry.name === "better-sqlite3"`（`install-tools.mjs:217-220`） | 通过。`package-lock.json:3458-3462` 版本 12.11.1、`hasInstallScript: true`。 |
| `node_modules/fsevents` 2.3.3 | `ci/toolchain-lock.json:1129-1136` | 同上 | 通过。`package-lock.json:4779-4784` 版本 2.3.3、`hasInstallScript: true`。 |
| `node_modules/playwright/node_modules/fsevents` 2.3.2 | `ci/toolchain-lock.json:1138-1145` | 同上 | 通过。嵌套路径 `lastIndexOf("node_modules/")` 取最后一段，推导为 `fsevents`；`package-lock.json:7058-7063` 版本 2.3.2、`hasInstallScript: true`。 |
| `node_modules/protobufjs` 7.6.6 | `ci/toolchain-lock.json:1147-1156` | 同上 | 通过。`package-lock.json:7160-7164` 版本 7.6.6、`hasInstallScript: true`。 |
| 删除的两条嵌套记录（Pi 下 `@google/genai` 1.52.0、`protobufjs` 7.6.5） | `ci/toolchain-lock.json` 删除项 | `install-dependencies.mjs:240-246` 的过期决策检查 | 正确删除：当前 `package-lock.json` 已无这两个路径，若保留会被判为过期记录。 |
| 新增 `review.name === 路径推导名` 规则 | `check-policy.mjs:1181-1184` | 只在本函数；与 `install-dependencies.mjs:193-194` 的安装后审计一致 | 当前全部真实记录通过；建议按低 #1 抽共享函数。 |
| I-91 文档行 | `docs/incidents-and-gates.md:124` | `scripts/check-incident-gates.mjs` 的 7 列表格解析和路径存在性检查 | 格式通过；引用的 `test/tooling/policy.test.mjs`、`test/tooling/toolchain-install-scripts-lock.test.mjs` 都存在。 |
| 新增测试文件 | `test/tooling/toolchain-install-scripts-lock.test.mjs` | `ci/policy.json` 的 tooling include：`test/tooling/**/*.test.mjs` | 归属正确，会被 tooling 项目收集。 |

## 未核实 / 限制

- 未运行测试、`npm ci` 或 `install-dependencies`；测试失败/通过结论来自代码阅读。
- 未读取 `.agents/reviews/pr-349/` 下的复核记录：当前环境对 `git show`/读取这些路径返回 `REVIEW_GIT_REFUSED records-path`，因此无法核对复核记录内容本身。
- 未联网核对 `@google/genai` 2.21.0 发布包内容；本报告只核对仓库内锁文件与门槛代码的一致性。
