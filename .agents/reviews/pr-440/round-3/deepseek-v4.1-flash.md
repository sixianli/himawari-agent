## 读代码证实的发现

### 1. 中 — ADR 对“固定主机名”的定义与检查实现不一致：用变量保存固定主机名、再与本机主机名比较的代码没有被清点

- 文件:行：`scripts/check-platform-assumptions.mjs:58-59`、`scripts/operations/ci-runner/runners.sh:2,33`、`scripts/operations/ci-runner/prepare-vps.sh:5-6,18-19`、`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:63`
- 问题：ADR 第 63 行把“固定主机名”定义为“拿本机主机名和一个固定名字比较的代码”。但 `fixed-hostname` 正则只认 `hostname()` / `...hostname()` 这种函数调用写法，不认 shell 的 `"$(hostname)"`。而这些文件正是拿本机主机名和固定值比较，既没进清单，也不属于作者所说的“配置值”例外。
- 证据：
  - `scripts/check-platform-assumptions.mjs:58-59`：
    ```js
    "fixed-hostname":
      /hostname\(\)\s*[!=]==?\s*["'](?!__PKT_)[^"'\n]+["']|[eE]qual\(\s*(?:[\w.]*\.)?(?:get)?hostname\(\)\s*,\s*["'](?!__PKT_)[^"'\n]+["']/g,
    ```
  - `scripts/operations/ci-runner/runners.sh:2`：`RUNNER_HOST=ci-vps`
  - `scripts/operations/ci-runner/runners.sh:33`：
    ```sh
    [ "$(hostname)" = "$RUNNER_HOST" ] || { echo "this script only runs on $RUNNER_HOST, not $(hostname)" >&2; exit 68; }
    ```
  - `scripts/operations/ci-runner/prepare-vps.sh:18-19`：
    ```sh
    current_hostname=$(hostname)
    [ "$current_hostname" = "$CI_HOSTNAME" ] || [ "$current_hostname" = "$ORIGINAL_HOSTNAME" ] || fail "only runs on $CI_HOSTNAME" 68
    ```
  - 清单 `fixed-hostname` 段里没有任何 `scripts/operations/ci-runner/` 条目（读清单确认）。
- 建议：要么把 `$(hostname)`/`"$(hostname)"` 与变量或字面量的比较纳入 `fixed-hostname` 类别（不需要写死具体主机名，按比较结构即可），要么把 ADR 的定义改成“只清点字面量主机名比较”，并明确这些脚本不在清点范围内。作者“要认出它们只能把具体机器名写进检查”的说法不成立。

### 2. 中 — ADR 说扫 `test` 等六个目录，但所有名为 `evidence` 的子目录被静默跳过，导致其中的固定主机名未清点

- 文件:行：`scripts/check-platform-assumptions.mjs:23-31,70-77`、`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:63`、`test/qualification/evidence/runtime-history/hermes-history-rehearsal.py:32`
- 问题：`SKIPPED_DIRECTORIES` 含 `"evidence"`，而 `test/qualification/evidence/` 下是已提交的源码脚本，里面有固定主机名比较。这与 ADR“清单按文件扩展名扫 … `test` …”的说法不一致，也让这些位置永远进不了清单。
- 证据：
  - `scripts/check-platform-assumptions.mjs:23-31`：
    ```js
    const SKIPPED_DIRECTORIES = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
      "evidence",
      ".ci-output",
    ]);
    ```
  - `scripts/check-platform-assumptions.mjs:72-73`：
    ```js
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) scannedFiles(root, child, files);
    ```
  - `test/qualification/evidence/runtime-history/hermes-history-rehearsal.py:32`：
    ```python
    assert len(sys.argv)==1 and os.geteuid()==0 and socket.gethostname()=='hermes-home'
    ```
  - 清单里没有 `test/qualification/evidence/` 下的任何条目（读清单确认）。
- 建议：把跳过目录按精确相对路径限定（例如只跳过仓库根或产物目录下的 `evidence`），或把 `test/qualification/evidence` 这类源码目录排除在跳过规则之外；并在 ADR 写明实际跳过的目录。

### 3. 低 — `--root` 缺参数时会抛未捕获异常，或把下一个选项当成路径

- 文件:行：`scripts/check-platform-assumptions.mjs:193-198`
- 问题：`--root` 位于参数末尾时 `process.argv[rootFlag + 1]` 是 `undefined`，`path.resolve(undefined)` 会抛 `TypeError`（栈直接打出，而不是受控的用法错误）。`--root --write` 也会把 `--write` 当目录。
- 证据：
  ```js
  const rootFlag = process.argv.indexOf("--root");
  process.exitCode = runPlatformAssumptionsCheck({
    root: rootFlag > 0 ? path.resolve(process.argv[rootFlag + 1]) : repositoryRoot,
    write: process.argv.includes("--write"),
  });
  ```
- 建议：校验 `rootFlag + 1 < process.argv.length` 且下一项不以 `-` 开头，否则打印用法错误并返回非零。

### 4. 低 — 未知类别判定用了 `in`，会放过来自原型链的类别名

- 文件:行：`scripts/check-platform-assumptions.mjs:111-113,143-150`
- 问题：`PLATFORM_ASSUMPTIONS` 是普通对象，`name in PLATFORM_ASSUMPTIONS` 对 `"toString"`、`"constructor"`、`"__proto__"` 等也为真。配合新的“形状合法”校验，`{"toString":{"a.mjs":1}}` 这种清单会被视为形状合法、且不会报 `PLATFORM_ASSUMPTIONS_UNKNOWN`，检查还能返回 0；`--write` 时会静默丢掉它。
- 证据：
  ```js
  for (const name of Object.keys(recorded))
    if (!(name in PLATFORM_ASSUMPTIONS))
      problems.push({ kind: "unknown", name, file: "", expected: 0, actual: 0 });
  ```
  以及 `readInventory` 只校验值形状，不校验类别名：
  ```js
  isPlainObject(recorded) &&
    Object.values(recorded).every(...)
  ```
- 建议：改用 `Object.hasOwn(PLATFORM_ASSUMPTIONS, name)`，并把 `readInventory` 的类别名校验与 `compare` 的未知类别判定统一。该 `in` 写法在本轮之前就存在，但本轮的“清单形状校验”没有顺手堵住它。

### 5. 低 — 新 arch-x64 规则的测试只覆盖了连字符，未覆盖作者声称的数字/字母/下划线

- 文件:行：`scripts/check-platform-assumptions.mjs:55`、`test/tooling/platform-assumptions.test.mjs:50-51`
- 问题：作者说“x64 后面不能接字母、数字、下划线或连字符”，但测试里只有 `arch: x64-musl` 一个反例。`x64_foo`、`x64foo`、`x641` 都没有用例；另外 `\w` 只认 ASCII，`arch: x64架构` 会被误判为命中（推测，未在仓库出现）。
- 证据：
  ```js
  "arch-x64": /\barch\s*(?:[!=]==?|:)\s*["']?x64(?![\w-])/g,
  ```
  ```js
  "      - key: linux-x64\n        arch: x64\n        arch: x64-musl\n",
  ```
- 建议：补 `x64_foo`、`x64foo`、`x641` 三个反向用例；如果要按 Unicode 字母排除，使用 `\p{L}` 或明确文档只保证 ASCII。

### 6. 低 — `--write` 的临时文件没有异常清理，失败或崩溃会留下 `.pid.tmp`

- 文件:行：`scripts/check-platform-assumptions.mjs:171-173`
- 问题：同目录 `rename` 的原子替换本身没问题，但 `writeFileSync` 或 `renameSync` 抛错、或进程在两者之间被杀时，临时文件会留在 `scripts/` 下，且没有 `try/finally` 清理；也没有 `fsync`，断电持久性不保证。
- 证据：
  ```js
  const temporary = `${inventory}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(observed, null, 2)}\n`);
  renameSync(temporary, inventory);
  ```
- 建议：用 `try/finally` 在失败时 `rmSync(temporary, { force: true })`；若要强调持久性再考虑 `fsync`。

## 侧重检查

- **错误路径**：`readInventory` 的 `ENOENT` 与其它读错误（其它错误原样抛出）符合作者说法；非法 JSON、`null`、数组、标量、字符串/0/负数次数的形状校验已确认；`--write` 对缺失/非法清单返回 0 并先打印 INVALID，符合作者说法。发现 `--root` 缺参数异常（第 3 条）。
- **不合规范/不可信的输入**：JSON 清单的形状校验基本成立，但原型链类别名绕过 `UNKNOWN`（第 4 条）；类别名、文件路径本身没有白名单校验，属于“允许未知类别再由 compare 报错”的设计，但 `in` 破坏了这一点。
- **安全**：脚本只在本地读写仓库，`INVENTORY_PATH` 固定、`path.join(root, …)` 不能逃出 `--root`；`--write` 会覆盖指定 root 下的清单，这是测试用途的有意设计。未发现命令注入或秘密泄漏。
- **资源耗尽**：扫描会把每个命中扩展名的文件整体读入内存（含较大的 `scripts/model-review/opencode-lock/package-lock.json`），但这是仓库内本地检查，输入规模有限，未发现需要处理的耗尽路径。
- **不可撤销操作**：`--write` 覆盖清单是唯一的销毁性操作，使用同目录 rename 替换；失败时旧文件保留，残留临时文件（第 6 条）。清单在版本控制中，可恢复。
- **规则/文档/代码一致性**：发现两处实质不一致：`evidence` 目录跳过 vs ADR“扫 test”（第 2 条）；`fixed-hostname` 的定义 vs 正则只认函数调用写法（第 1 条）。

## 推测 / 未核实

- 仓库是 67% 稀疏检出，`glob` 只能看到当前工作树。除已看到的两个 `Dockerfile` 外，是否存在未被检出的 `Dockerfile`/`Containerfile`/`Makefile` 未核实；清单 354 处是对现有清单逐项求和核实，不等于对完整仓库的独立重算。
- `arch: x64架构` 这类 Unicode 尾随字符会被误计，是读正则后的推断，仓库中未实际出现。
- 两个 `--write` 进程并发时最后一次 rename 生效、没有锁；对同一代码树是幂等的，因此未列为缺陷，但并发写入不同代码状态时可能丢更新，未实测。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只涉及仓库检查脚本、清单 JSON、测试、`package.json` 的检查命令和 ADR 文档，没有触碰系统提示、工具定义、历史消息、资料块或出口遮盖。没有新增任何发给模型的内容，也不存在“追加在末尾”的新字段；规则要求的只追加与“每轮变化值放最后一条消息”不受影响。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会。该改动不参与模型请求组装。检查器自身输出是确定的：`files.sort()` 固定文件顺序，类别按 `Object.keys(PLATFORM_ASSUMPTIONS)` 固定顺序初始化，`JSON.stringify(observed, null, 2)` 的键顺序由固定插入顺序决定，没有时间、随机数或无序集合。`--write` 的临时文件名带 `process.pid`，但不进入清单内容，也不进入任何发给模型的文本；测试也断言两次写出的字节相同。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`package.json` 新增 `check:platform-assumptions`，并加进 `check:steps`；`test/tooling/platform-assumptions.test.mjs` 覆盖扫描、比较、缺失/非法清单、`--write`、真实命令行退出码和两次字节一致。按旧实现推断，这些反向用例确实会失败：旧正则不认不带引号的 `arch: x64`；旧扫描不认 `Dockerfile`；旧代码对 `null` 会抛异常、对 `{ "lib64": 1 }` 会误判通过。缺口是：`x64` 后接字母/数字/下划线的反例未测；非 `ENOENT` 读错误未测；`--root` 缺参数未测；原子替换本身没有测试可以证明；原型链类别名未测。

**4. 改动产生或修改的每个值，产生处和使用处是否都能接受？**
- 类别名：由 `PLATFORM_ASSUMPTIONS` 的键和清单产生，`comparePlatformAssumptions`、`describeProblem`、`UNKNOWN` 判定使用；已知类别两端一致，但 `in` 让原型链类别名绕过校验（第 4 条）。
- 文件路径：由 `path.posix.join` 产生（正斜杠），`EXCLUDED_FILES`、清单键、`compare` 使用，方式一致；完整目录树未核实。
- 次数：由 `matchAll().length` 产生且只存正数，`readInventory` 要求正整数，`compare` 生成 `added/stale`，两端一致；0 由“删掉这一行”的约定处理。
- `INVENTORY_PATH`：脚本和测试共用同一个导出，一致。
- `--root` / `--write`：CLI 产生，`runPlatformAssumptionsCheck` 和 `spawnSync` 测试使用；正常路径一致，`--root` 缺参数有错误路径问题（第 3 条）。
- 错误码 `PLATFORM_ASSUMPTIONS_INVENTORY_INVALID` / `_MISSING` / `_ADDED` / `_STALE` / `_UNKNOWN`：脚本产生，测试用正则匹配，一致。
- `check:platform-assumptions` 脚本名：`package.json` 产生，`check:steps` 和 ADR 文档使用，一致。
- `.github/workflows/ci.yml` 的 `arch-x64` 次数 4：正则在第 126、180、186、192 行确实各命中一次，清单记 4，两端一致。
- 清单总数 354：对清单逐项求和得到 354，与作者说法一致（但不是对完整仓库独立重扫）。
