## 结论（按严重度）

### 1. 高：新增的 `package.json` 预检会让现有 `ReleaseWalkthroughTest` 必定失败，且新条件本身没有测试
- 位置：`scripts/delivery-mode/hermes/run-release-walkthrough.sh:23`
- 问题：预检在 `--preflight` 分支之前新增了 `[[ -f "$source/package.json" ]]`。现有测试夹具的 `source` 是一个刚 `git init`、只有空提交的目录，没有 `package.json`，因此所有走预检的用例都会在到达被测逻辑前以 3 退出。
- 证据（亲自读到）：
  - `run-release-walkthrough.sh:22-23`
    ```bash
    git -C "$source" rev-parse HEAD > /dev/null 2>&1 || fail "SOURCE_MISSING $source" 3
    [[ -f "$source/package.json" ]] || fail "SOURCE_TREE_EMPTY $source" 3
    ```
  - `scripts/delivery-mode/test_make_packet.py:740-743`
    ```python
    source = root / 'source'
    source.mkdir()
    subprocess.run(['git', 'init', '-q', str(source)], check=True)
    subprocess.run(['git', '-C', str(source), ... 'commit', '-q', '--allow-empty', '-m', 'x'], check=True)
    ```
  - `test_make_packet.py:764-766` 期望 `walk-1` 返回 0；`:772-778` 期望预检输出 `HERMES_WALKTHROUGH_PREFLIGHT_OK`。
- 建议：在夹具里创建 `package.json`；新增反向用例：删掉 `package.json` 后 `--preflight` 和正式运行都必须以 3 退出并报 `SOURCE_TREE_EMPTY`。现有两个用例也要同步更新，否则本 PR 会让 `test_make_packet.py` 变红。

### 2. 中：宽松正则没有限定在 `originals` 对象内，bootstrap 里任何 `"键": "<64位hex>"` 都会被当成指纹
- 位置：`scripts/check-probe-sources.mjs:49-53`
- 问题：当前 `bootstrap.mjs` 全文只有 `originals` 里的三处 64 位 hex（我读了全部 75 行），所以**当前不会误匹配**。但正则扫描整个文件、不限定 `const originals = {...}` 块，也不跳过注释或第二个对象。以后增加一条注释、测试数据或另一张摘要表，它就会进入 `recorded`。
  - 由于 `Map` 后写覆盖前写，若同一 `built` 名称在 `originals` 之后又出现一次，后出现的值会覆盖真实指纹：可能误报失败，也可能用后出现的“正确”值掩盖前面真正被运行时使用的旧指纹。
- 证据（亲自读到）：
  ```js
  const recorded = new Map(
    [...readFileSync(bootstrapPath, "utf8").matchAll(/"([^"\n]+)"\s*:\s*"([0-9a-f]{64})"/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  ```
  而 `bootstrap.mjs:10-14` 的真实结构是：
  ```js
  const originals = {
    "job-host-main.js": "8e3a...",
    "sandbox-sdk.js": "bc9b...",
    "sandbox-sdk-worker.js": "42d5...",
  };
  ```
- 建议：先截取 `const originals = { ... }` 块再解析，或显式拒绝重复名称；新增用例：在 `originals` 前后各放一个无关的 `"x": "<64hex>"`，要求不会误收、也不会覆盖真实指纹。

### 3. 中：仓库检查接受任意 `built` 名字，但下游上线包检查和 `read-driver.mjs` 不接受
- 位置：`scripts/check-probe-sources.mjs:20-33`、`:49-58`
- 问题：`recordProblems` 只要求 `file.built` 是字符串，正则也允许任意不含引号/换行的键名；但最终上线包检查仍用旧格式。
- 证据（亲自读到）：
  - `check-probe-sources.mjs:26-30` 只校验 `typeof file?.built === "string"`，不限制为三个已知文件名。
  - `scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`
    ```python
    originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))
    ```
    它只认小写、连字符和 `.js`，还要求尾逗号。
  - `scripts/delivery-mode/packet-template/measurement/probe/read-driver.mjs:25` 仍写死三个名字。
  - 新测试 `test/tooling/probe-sources.test.mjs:85-88` 明确把 `"Sandbox_SDK2.js"` 这种名字当成可识别对象。
- 后果：如果有人真的把某个 `built` 改成怪名字并同步记录，仓库检查会通过；上线包检查的正则匹配不到这个名字，会**静默跳过**对它的摘要核对（只有三个都匹配不到时才报 `PROBE_ORIGINALS_NOT_FOUND`）。这正是 I-73 说的“生成端接受、消费端不接受”。
- 建议：要么在仓库检查里把 `built` 限制为三个固定名字；要么在同一改动里同步放宽 `check-packet-consistency.py` 和 `read-driver.mjs`。不能只放宽一端。

### 4. 低：记录里的 `bootstrap` 和 `source` 没有被钉死为规范路径，构造记录可以绕过
- 位置：`scripts/check-probe-sources.mjs:15-18`、`:20-22`、`:26-30`、`:47`
- 问题：`bootstrap` 来自记录本身，只校验“在仓库根目录内”；`source` 也只要在根目录内。把 `bootstrap` 指向另一个仓库内文件（甚至是记录的副本），或把 `source` 指向一份旧内容的副本，就可能通过检查，而真正的探针/源码没有被核对。
- 证据（亲自读到）：
  ```js
  function inside(root, relative) {
    const resolved = path.resolve(root, relative);
    return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
  }
  ...
  if (typeof record?.bootstrap !== "string" || !inside(root, record.bootstrap))
  ...
  const bootstrapPath = inside(root, record.bootstrap);
  ```
- 另外 `inside` 只是词法解析，不解析软链接；仓库内软链接可指向仓库外，`readFileSync` 仍会跟随。
- 建议：把 `bootstrap` 固定为 `scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs`；把三个 `source`/`built` 固定为白名单；对路径做 `realpath` 后再判包含，并拒绝软链接。至少应在 `recordProblems` 里拒绝重复或未知的 `built`。

### 5. 低：错误路径会用未捕获异常代替清楚的 `PROBE_*` 错误
- 位置：`scripts/check-probe-sources.mjs:47-50`、`:64-70`
- 问题：先 `existsSync` 再 `readFileSync`，但没有处理“存在但不可读/是目录/是特殊文件”的情况。记录把 `bootstrap` 或 `source` 指到目录时会抛 `EISDIR` 栈；指到 `/dev/zero` 一类软链接可能读不完，从而卡住检查。
- 证据（亲自读到）：
  ```js
  const bootstrapPath = inside(root, record.bootstrap);
  if (!existsSync(bootstrapPath)) return [`PROBE_BOOTSTRAP_MISSING ...`];
  const recorded = new Map([...readFileSync(bootstrapPath, "utf8").matchAll(...)]
  ...
  const sourcePath = inside(root, file.source);
  if (!existsSync(sourcePath)) { ... continue; }
  const actual = sha256(readFileSync(sourcePath));
  ```
- 建议：`try/catch` 包住读取并返回 `PROBE_BOOTSTRAP_UNREADABLE` / `PROBE_SOURCE_UNREADABLE`；用 `statSync().isFile()` 拒绝目录；必要时限制文件大小。脚本只读，不会造成不可逆操作。

### 6. 低：刷新提示只在失败时打印，恰好漏掉“只改 `sourceSha256`”这种会通过的场景
- 位置：`scripts/check-probe-sources.mjs:80-82`
- 问题：`REFRESH_HINT` 只有 `problems.length` 非零才输出。作者说提示写明了“只改源码指纹不构建会让上线包检查后失败”；但按现在的逻辑，只改 `sourceSha256` 且源码已改时检查会**通过**，提示根本不会出现。
- 证据（亲自读到）：
  ```js
  for (const problem of problems) console.log(problem);
  if (problems.length) console.log(REFRESH_HINT);
  console.log(`PROBE_SOURCES ${problems.length ? "failed" : "passed"}`);
  ```
- 建议：至少在记录里 `sourceSha256` 变化时无法直接判断，只能靠文档；若希望提示真正生效，可在成功输出里也附一句“构建指纹仍需 Hermes 构建后更新”，或把该风险写进检查成功摘要。

### 7. 低：I-79 的文档描述比实际检查更强，且没有对应测试
- 位置：`scripts/delivery-mode/hermes/run-release-walkthrough.sh:22-23`、`docs/incidents-and-gates.md:117`
- 问题：文档说“目录还在但文件被清空时报 `SOURCE_TREE_EMPTY`”，实际只检查 `package.json`。如果工作树被清空但保留了 `package.json`，或者 git 元数据还在而工作树几乎为空，`git rev-parse HEAD` 仍成功，检查会通过。
- 证据（亲自读到）：`run-release-walkthrough.sh:23` 只有 `[[ -f "$source/package.json" ]]`；`git -C "$source" rev-parse HEAD` 只读 HEAD，不检查工作树内容。
- 建议：核对几个构建必需文件（如 `package-lock.json`、`tsconfig.json`、`scripts/`），或检查 `git -C "$source" ls-files` 是否非空、工作树是否有相应文件；同时补测试。

## 侧重检查

- **错误路径**：见第 5 条，目录/不可读/特殊文件没有转换成固定错误码。
- **不合规范或不可信输入**：记录文件是唯一输入，`bootstrap`/`source` 路径未钉死、只做词法包含，见第 4 条。当前 bootstrap 内容本身没有异常字符串。
- **安全**：检查脚本只读，不修改仓库，也没有网络请求；风险主要是软链接越界读取和无限文件读取，属于低严重度。
- **资源耗尽**：`readFileSync` 没有大小上限，`spawnSync` 也没有超时；都是低风险，但可被恶意的软链接/超大文件拖住 CI。
- **不可撤销操作**：本次改动没有删除、覆盖或发布操作；`run-release-walkthrough.sh` 的预检也只读。
- **规则/文档与代码一致性**：I-78/I-79 的 id、日期、状态和路径能通过 `check-incident-gates` 的结构校验（路径都存在、id 不重复）；但 I-79 的“文件被清空”描述过强，且新条件没有测试；I-78 的刷新提示位置也有第 6 条的落差。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会。本 PR 只改了 `package.json` 的检查清单、`scripts/check-probe-sources.mjs`、交付预检脚本、事故文档、测试和复核记录；没有触碰系统提示、工具定义、历史消息、资料块或遮盖逻辑。发给模型的内容没有新增、重排或改写，因此不涉及“只追加”。依据：[prompt-prefix.md](.claude/rules/prompt-prefix.md#rules)。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
不会影响模型请求。检查脚本的输出取决于仓库文件内容和静态记录，没有时间、随机数或无序集合；它打印的摘要也没有进入模型请求。`Map` 的遍历顺序来自正则匹配到的文本顺序，是确定的。唯一的不确定性来自文件系统内容，但这只在工具诊断里，不在请求体里。

### 3. 有没有自动检查，反向用例是否真的会失败？
- I-78：有 `test/tooling/probe-sources.test.mjs`，包含源码改变、bootstrap 摘要不匹配、未记录条目、异常名字、坏记录和 CLI 退出码等反向用例。按代码推断，上一版脚本确实会失败（旧正则匹配不到异常名字、旧实现遇到坏记录会抛异常）；**我未实际运行测试**，本环境只能读文件和用 git。
- 缺口一：没有覆盖 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`。
- 缺口二：没有覆盖“bootstrap 里另一个无关 64 位 hex 字符串”的场景，也就是这次重点问的宽松正则风险。
- 缺口三：没有覆盖“怪名字被正式记录后，下游 `check-packet-consistency.py` 是否仍然核对它”。
- I-79：新增的 `package.json` 预检没有测试，而且会让现有 `ReleaseWalkthroughTest` 失败（见第 1 条）。
- 正例 `passes on the repository as committed` 依赖记录里的 `sourceSha256` 与当前源码一致；我无法在本次工具限制下计算 SHA-256，**未核实**这些摘要是否准确。

### 4. 每个产生的值，使用它的一端都能接受吗？
- `check:probe-sources`：在 `package.json` 定义，`check:steps` 引用，`scripts/run-all-checks.mjs` 能解析成普通 npm script，另一端接受，OK。
- 新测试文件：位于 `test/tooling/probe-sources.test.mjs`，`ci/policy.json` 的 tooling 项目包含 `test/tooling/**/*.test.mjs`，CI 的 policy 作业会跑到，OK。
- 记录键 `bootstrap/files/built/builtSha256/source/sourceSha256`：只有 `scripts/check-probe-sources.mjs` 消费，格式一致；但 `built` 名字还会被 `bootstrap.mjs` 运行时和 `check-packet-consistency.py`、`read-driver.mjs` 间接消费，而它们的格式要求比新检查窄，见第 3 条。
- bootstrap 里的三个摘要：运行时用 `basename in originals` 比较，摘要格式一致；上线包检查用旧正则读取，当前三个名字都能匹配，OK。
- `SOURCE_TREE_EMPTY`：只作为预检退出码 3 向上传给 `make-packet.py`，使用端能接受，但没有测试，见第 1、7 条。
- I-78/I-79 清单项：id 唯一、日期格式、状态和路径都能被 `scripts/check-incident-gates.mjs` 接受；路径均存在。文档描述与代码的差异见第 7 条。
