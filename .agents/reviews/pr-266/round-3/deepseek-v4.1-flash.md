总体：未发现高严重度问题。改动是只读的发布检查工具、测试和文档，不触碰产品请求构造；主要风险是本地探针检查与上线包检查的解析规则不一致，以及 I-79 的门槛/文档覆盖被说得比实际大。

## 发现（按严重度从高到低）

### 1. 中｜[读代码证实] 本地探针检查与上线包检查的解析规则不一致

- 文件:行：`scripts/check-probe-sources.mjs:49-51`；`scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`
- 问题：本地检查比上线包检查更宽松，也比它更严格，两个方向都可能让“本地通过、上线包检查看不到/反而失败”。
- 证据：
  - 本地只在 `const originals` 块内抓条目，且不要求行尾逗号：
    `scripts/check-probe-sources.mjs:49`：`const block = text.match(/^const originals = \{\n([\s\S]*?)^\};$/m);`
    `scripts/check-probe-sources.mjs:51`：`block[1].matchAll(/"([^"\n]+)"\s*:\s*"([0-9a-f]{64})"/g)`
  - 上线包检查扫描整个文件，且要求 `": "` 和行尾逗号：
    `check-packet-consistency.py:98`：`originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))`
  - 测试还明确把“没有行尾逗号”的条目当作可解析：`test/tooling/probe-sources.test.mjs:86-88`。
- 后果：例如把 `originals` 最后一项写成合法 JS 但没有行尾逗号，本地检查会认为它存在并通过；上线包检查不会解析这一项，于是构建指纹不会被核对，问题会推迟到 S6 运行时才以 `PROBE_ORIGINAL_RUNTIME_CHANGED` 暴露。反过来，块外一行符合上线包检查格式的摘要，本地会忽略，上线包检查却会抓进来。
- 建议：让两边共用同一个解析器；在 `check-packet-consistency.py` 不改的前提下，本地至少应使用与它完全相同的行正则，并且只扫描同一段 `originals` 块。补一条“记录中列出、但 bootstrap 条目没有行尾逗号”的反向用例。

### 2. 中｜[读代码证实] I-79 的新检查没有覆盖事故本身，文档把两件事混在一起

- 文件:行：`scripts/delivery-mode/hermes/run-release-walkthrough.sh:20-23`；`scripts/delivery-mode/test_make_packet.py:783-789`；`docs/incidents-and-gates.md:117`
- 问题：I-79 的实际事故是整个 `/home/andy/himawari-tests/r2-u1/` 消失；这本来就会被现有的 `fd`、`rg`、`git rev-parse` 检查拦下。新增的 `package.json` 检查只覆盖“目录和 `.git` 还在、工作树文件没了”的另一种情况，但文档写成“复现即这次”。
- 证据：
  - `run-release-walkthrough.sh:20-22` 已有 `PI_TOOL_MISSING`、`SOURCE_MISSING`；第 23 行才是新增的 `SOURCE_TREE_EMPTY`。
  - `test_make_packet.py:783-789` 只删除 `package.json`，没有删除目录或 `.git`。
  - `docs/incidents-and-gates.md:117` 写“复现即这次：目录缺失时拒绝”，读者会以为新检查覆盖了整目录缺失。
- 建议：在 I-79 行明确区分“整目录缺失（旧检查已覆盖）”和“空工作树（新检查覆盖）”；为真正的整目录缺失补一条反向用例（预期 `SOURCE_MISSING` 或 `PI_TOOL_MISSING`），或把检查改成能代表源码树的多个必需文件/目录，而不是只看 `package.json`。

### 3. 中低｜[读代码证实] `SOURCE_TREE_EMPTY` 的反向用例不在任何自动门槛里

- 文件:行：`scripts/delivery-mode/test_make_packet.py:783`；`package.json:27`、`:37`
- 问题：新的预检行为只有 `test_make_packet.py` 里的反向用例，而这个文件不在 `npm run check`，也没有在任何 CI 步骤中被调用；作者也说明它整体在 main 上有 2 个既有失败。
- 证据：
  - `package.json:27` 的 `check:steps` 中没有 delivery-mode 的 Python 测试；`package.json:37` 的 `check:probe-sources` 只运行 JS 测试。
  - 新用例只在 `test_make_packet.py:783-789`。
- 后果：如果有人删掉 `run-release-walkthrough.sh:23` 或改坏退出码，`npm run check` 不会失败；只有手工运行 Python 测试才会发现。I-79 行却写成“已落门槛”。
- 建议：在 `test/tooling` 下加一个直接运行 `run-release-walkthrough.sh --preflight` 的临时夹具测试，断言退出码 3 和 `SOURCE_TREE_EMPTY`，并把它接进 `check:steps`；或者把 delivery-mode 的 Python 测试正式接入 `npm run check` 并修掉既有失败。

### 4. 低｜[读代码证实] 读取错误没有被统一捕获，记录文件不可读时错误会误导

- 文件:行：`scripts/check-probe-sources.mjs:19-24`、`:59-65`
- 问题：`readFileSync`/`lstatSync` 没有 try/catch；普通文件权限不足、I/O 错误或 `lstat` 后被删除会抛出未捕获异常，输出堆栈而不是 `PROBE_SOURCES_*` 错误。记录路径是目录或符号链接时，`readPlainFile` 返回 `unreadable`，但 `probeSourceProblems` 只检查 `missing`，最后落到 `JSON.parse(undefined)`，报 `PROBE_SOURCES_RECORD_INVALID json`。
- 证据：
  - `:24`：`return { bytes: readFileSync(full) };`
  - `:59-65`：只判断 `recordFile.missing`，随后直接 `JSON.parse(recordFile.bytes?.toString("utf8"))`。
- 建议：包住 `lstatSync`/`readFileSync`，分别返回 `PROBE_SOURCES_RECORD_UNREADABLE`、`PROBE_BOOTSTRAP_UNREADABLE`、`PROBE_SOURCE_UNREADABLE`；同时检查 `recordFile.unreadable`。

### 5. 低｜[读代码证实] `source` 的“在目录下、不含 ..”只是字符串检查

- 文件:行：`scripts/check-probe-sources.mjs:35-36`
- 问题：只检查正斜杠分段：
  `file.source.startsWith(SOURCE_DIRECTORY) && !file.source.split("/").includes("..")`
  在 Windows 上 `packages/runtime-sandbox/src/..\..\outside.ts` 不包含以 `/` 分隔的 `..`，但 `path.join` 会解析到目录外；在 POSIX 上，中间目录是符号链接时也可能逃出。记录由仓库控制，检查只读取和哈希、不打印内容，所以这不是数据泄露，但与“source 必须在 `packages/runtime-sandbox/src/` 下”的保证不一致。
- 建议：用 `path.resolve` + `path.relative` 判断最终路径仍在根目录下，并用 `realpathSync` 校验物理位置；同时拒绝反斜杠形式的 `..`。

### 6. 低｜[读代码证实 + 作者已承认] 只改 `sourceSha256` 也能让检查通过

- 文件:行：`scripts/check-probe-sources.mjs:80-99`；`docs/incidents-and-gates.md:116`
- 问题：检查只比较“记录 vs bootstrap 的 built 指纹”和“记录 vs 源码的 source 指纹”，不核对构建指纹是否由当前源码构建出来。开发者可以只把 `sourceSha256` 改成新值，不重新在 Hermes 上构建，检查仍然通过，而 built 指纹是旧的。
- 证据：`:80-99` 没有构建输入/构建指纹；I-78 行也写明“只把记录里的源码指纹改成新值、不在 Hermes 上构建并更新构建指纹，这道检查也会通过”。
- 建议：这是作者已知的残余风险，至少应在提示和文档里明确“本检查不能替代上线包检查”；更好的做法是记录构建指纹（TypeScript 版本/编译配置 + 源码摘要）或要求记录由构建步骤生成。

### 7. 低｜[读代码证实] 没有测试保证 `check:probe-sources` 一直留在 `check:steps` 里

- 文件:行：`test/tooling/run-all-checks.test.mjs:52-56`；`package.json:27`
- 问题：`run-all-checks.test.mjs` 只断言 `check:boundaries` 在步骤清单里；如果以后有人从 `check:steps` 删掉 `npm run check:probe-sources`，没有任何测试会失败。`check-incident-gates.mjs` 也只检查 I-78 行里的路径存在，不检查命令是否真的在 `check:steps` 中。
- 建议：在 `run-all-checks.test.mjs` 增加 `expect(names).toContain("check:probe-sources")`，或让 incident-gate 检查 I-78 行点名的命令确实出现在 `check:steps` 里。

## 读代码证实的

- 改动文件范围：`git diff --stat` 只有 `docs/incidents-and-gates.md`、`package.json`、`scripts/check-probe-sources.mjs`、`scripts/delivery-mode/probe-sources.json`、`scripts/delivery-mode/hermes/run-release-walkthrough.sh`、`scripts/delivery-mode/test_make_packet.py`、`test/tooling/probe-sources.test.mjs` 以及 review 记录；没有 `packages/`/`apps/` 的提示构造、工具定义、历史序列化或遮盖代码。
- `probe-sources.json` 的三个 `built` 名称与 bootstrap 的 `originals` 键一致；三个 `builtSha256` 与 bootstrap 里的值逐字一致；三个 `source` 文件都存在；`bootstrap` 路径存在。
- `check:probe-sources` 在 `check:steps` 中，`stepNames` 的正则 `^npm run (\S+)$` 能接受它。
- `probe-sources.test.mjs` 共 20 个用例；按新旧脚本逐条推演，新增的 9 个在上一版脚本上会失败（没有实际运行）。
- `SOURCE_TREE_EMPTY` 的退出码 3 和消息格式与 `test_make_packet.py:783-789` 的断言一致。
- `run-release-walkthrough.sh` 的新检查在 `--preflight` 和正式运行之前都会执行。
- `test_make_packet.py` 没有被 `npm run check`、`test:tooling` 或 `scripts/ci` 调用（按 grep 结果）。

## 推测 / 未核实

- 未独立重算 `probe-sources.json` 里的三个 `sourceSha256`；如果记录与源文件不符，`check:probe-sources` 和“passes on the repository as committed”会失败。作者称 Hermes 上 34 步通过，我没有复跑。
- 未实际运行 `test_make_packet.py`，因此作者说的“去掉夹具 `package.json` 时 3 个失败、补上后 5 个全过”以及“main 上 2 个既有失败”未复核。
- 发现 1 中“构建指纹不会被上线包检查核对、推迟到 S6 运行时失败”是根据 `bootstrap.mjs` 的 `PROBE_ORIGINAL_RUNTIME_CHANGED` 和 `check-packet-consistency.py` 的解析逻辑推演，未实际构造该 bootstrap。
- 发现 5 的 Windows `..\` 路径行为是按 `path.join` 语义推演，当前环境是 darwin，未在 Windows 上实测。
- `.agents/reviews/pr-266/**` 在本检出中是二进制/稀疏缺失，未审阅其内容；它们不在产品请求路径上。

## 侧重检查

- **错误路径**：新脚本的错误分支大多有明确错误码；但 `readFileSync`/`lstatSync` 的 I/O 错误未捕获（发现 4），记录不可读时错误码误导。`run-release-walkthrough.sh` 的失败路径清晰，退出码 3 与测试一致。
- **不合规范/不可信输入**：记录是仓库内容，但仍做了 bootstrap 固定路径、built 名称、source 前缀、`..`、64 位十六进制、重复项校验。缺口是 Windows 反斜杠 `..`、中间符号链接、空字节等（发现 5）；以及本地解析器与上线包检查不一致（发现 1）。
- **安全**：检查是只读的，不写文件、不发网络请求、不打印文件内容，只打印哈希；没有发现密钥或敏感内容泄露。`source` 的包含关系是词法检查而非物理检查，属于加固项。
- **资源耗尽**：只读三个固定源文件、一个固定 bootstrap 和一个固定记录；正则和遍历都是线性规模，没有外部输入驱动的无限循环或网络等待。测试里的临时目录会清理。
- **不可撤销操作**：没有。`check-probe-sources` 和 `--preflight` 都不修改文件，也不启动构建。
- **规则/文档/代码一致性**：I-78 的“未覆盖”与代码一致；I-79 的“复现即这次”与测试实际删除的内容不一致（发现 2）；“已落门槛”与实际自动检查的覆盖不一致（发现 3）。`check-incident-gates.mjs` 只检查路径存在，不检查命令是否在 `check:steps` 里（发现 7）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及发布检查脚本、`package.json` 的检查步骤、测试和事故文档；没有改系统提示、工具定义、历史消息、遮盖或序列化代码。新脚本的输出只写到终端，不进入模型请求。发给模型的内容仍然只在末尾追加，每轮会变的值没有因此被放进请求开头。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。新检查是确定性的：固定路径、固定 JSON 记录、对文件字节做 SHA-256，没有时间戳、随机数或无序集合输出；`Set` 只用于成员判断，问题顺序按记录/bootstrap 顺序。它也不参与模型内容的遮盖或序列化。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   探针检查有：`check:probe-sources` 在 `check:steps` 中，运行脚本和 `test/tooling/probe-sources.test.mjs`；20 个用例中新增的 9 个按代码推演会在上一版脚本上失败。`SOURCE_TREE_EMPTY` 没有同等级的自动检查：唯一反向用例在 `test_make_packet.py`，该文件不在 `npm run check`，也没有 CI 调用。另有两个缺口：没有测试保证 `check:probe-sources` 一直留在 `check:steps`；没有“只更新 sourceSha256、不重建”的反向用例，而该场景会通过（作者已在 I-78 未覆盖里承认）。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `probe-sources.json` 的 `bootstrap`、`files`、`built`、`builtSha256`、`source`、`sourceSha256`：生产端是新记录，消费端是 `check-probe-sources.mjs`。固定 bootstrap 路径、`[a-z-]+\.js`、source 前缀/无 `..`、64 位小写十六进制、重复 built 都被校验；实际记录的名称、built 指纹与 bootstrap 一致，source 文件存在。`sourceSha256` 未独立重算。
   - `built` 名称还被 `bootstrap.mjs` 和 `check-packet-consistency.py` 使用。名称字符集一致，但上线包检查额外要求 `": "` 和行尾逗号，本地解析器更宽松（发现 1）；这是两端校验不完全一致的地方。
   - `check:probe-sources` 配置键：生产端 `package.json`，消费端 `run-all-checks.mjs` 的 `stepNames`，格式匹配，`npm run check:probe-sources` 存在。
   - `SOURCE_TREE_EMPTY` 和退出码 3：生产端 `run-release-walkthrough.sh:23`，消费端 `make-packet.py` 的 `preflight()`（原样带入 `PACKET_HERMES_PREFLIGHT_FAILED`）和测试；没有消费者要求不同的格式，测试断言一致。
   - 新增的 `PROBE_*` 错误码：生产端脚本，消费端测试；测试里的期望字符串与代码逐字一致。
   - 新记录不在 packet-template 里，也不在 `install_scripts()` 上传清单里；上线包检查读的是包内 bootstrap，不是这份记录，因此没有额外的清单/摘要需要同步。
