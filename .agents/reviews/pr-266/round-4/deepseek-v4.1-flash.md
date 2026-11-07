## 结论

本增量没有发现高严重度问题。改动只涉及工具脚本、测试、`package.json`、发布预检脚本和文档，没有触及模型请求组装路径。逐条核对作者说明：D1、D4、D5、D7 与代码一致；D2 的文档描述基本一致；D3 是已知遗留。下面几处仍有偏差或不完整。

### 已读代码证实的问题

**1. 中 — 新增的 `SOURCE_TREE_EMPTY` 分支没有任何自动门禁运行**
- 文件:行：`scripts/delivery-mode/hermes/run-release-walkthrough.sh:23`、`scripts/delivery-mode/test_make_packet.py:783`、`package.json:27`、`package.json:54`
- 问题：新增预检的唯一测试在 pytest 文件里，而 `npm run check` 只跑 vitest；仓库里能看到的 npm/CI 配置也没有运行 `test_make_packet.py`。删掉或改坏第 23 行，CI 不会失败。
- 证据：`package.json:27` 的 `check:steps` 全是 `npm run <script>`；`:54` 的 `check:release-walkthrough` 是 `vitest run ... apps/control-center/test/release-walkthrough.unit.test.ts test/tooling/release-walkthrough-locators.test.mjs test/tooling/release-walkthrough-coverage.test.mjs`；全仓搜索 `test_make_packet` 只出现在文档中。
- 建议：把该用例接进某个 CI 步骤，或把“复制 `run-release-walkthrough.sh` 到临时目录、删掉 `package.json`、断言退出码 3”的用例改写成 `test/tooling/` 下的 shell/vitest 测试。若按作者说的另开任务，应在 I-79 的“未覆盖”里明确写“没有自动门禁”。

**2. 低 — 记录路径的校验用 `path.resolve`，实际读取用 `path.join`，两者语义不一致**
- 文件:行：`scripts/check-probe-sources.mjs:33`、`scripts/check-probe-sources.mjs:21`、`scripts/check-probe-sources.mjs:101`
- 问题：`source` 为绝对路径且位于 `packages/runtime-sandbox/src/` 下时，`insideSourceDirectory` 用 `path.resolve(root, source)` 判定为合法；随后 `readPlainFile` 用 `path.join(root, source)`，会把根目录再拼一次，读的是另一个路径，最终报 `PROBE_SOURCE_MISSING` 而不是 `PROBE_SOURCES_RECORD_INVALID`。校验检查的路径和真正读取的路径不是同一个。
- 证据：第 33 行 `const relative = path.relative(path.join(root, SOURCE_DIRECTORY), path.resolve(root, source));`；第 21 行 `const full = path.join(root, relative);`；第 101 行 `const source = readPlainFile(root, file.source);`。
- 建议：在 `recordProblems` 里显式拒绝 `path.isAbsolute(file.source)`，或让读取也统一用 `path.resolve(root, ...)`；并补一个绝对路径的反向用例。

**3. 低 — “与上线包检查读法一致”只在行格式层面成立，解析范围不同**
- 文件:行：`scripts/check-probe-sources.mjs:58`、`scripts/check-probe-sources.mjs:62`、`scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`、`test/tooling/probe-sources.test.mjs:105`
- 问题：PR 检查只在 `const originals = { ... };` 块内解析；上线包检查是对整个 `bootstrap.mjs` 文本做 `re.findall`。如果在块外出现一行**符合**上线包检查格式的 `  "x.js": "<64位摘要>",`，上线包检查会把它当成真实条目，PR 检查却看不到，失败仍被推迟到出包时。作者说的“读法一致”严格说只对块内的行格式成立。
- 证据：第 58 行 `const block = text.match(/^const originals = \{\n([\s\S]*?)^\};$/m);`；第 62 行按行遍历 `block[1]`；上线包检查第 98 行 `originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))`。另外，测试第 105–110 行的“块外字符串”写法是 `const other = { "job-host-main.js": "..." };`，上线包正则也不会匹配它，因此这个用例并没有证明两者在块外一致。
- 建议：两边采用同一范围（要么 PR 检查也扫全文件，要么上线包检查也限定在 `originals` 块），并加一个“块外、但符合上线包格式的条目”用例来固定预期。

**4. 低（文档）— I-79 对“这次由哪两项拦下”的表述与脚本执行顺序不完全一致**
- 文件:行：`docs/incidents-and-gates.md:117`、`scripts/delivery-mode/hermes/run-release-walkthrough.sh:20`
- 问题：文档写“整个目录缺失时由原有的 `fd` 和源码检出两项拦下”。实际顺序是先查 `fd`（第 20 行），整个目录都没了时 `fd` 会先失败并 `exit 5`，后面的源码检出和新增的 `package.json` 检查根本不会执行。表述容易让人以为两个检查都实际跑过。
- 证据：第 20 行 `[[ -x "$toolbin/fd" ]] || fail "PI_TOOL_MISSING $toolbin/fd" 5`；第 22–23 行才是源码检出和 `package.json`。
- 建议：改成“这次由 `fd` 先拦下；若 `fd` 还在而源码缺失，则由源码检出/`package.json` 拦下”。

### 推测（行为可读代码确认，影响未验证）

**5. 低 — 中间目录是符号链接时可绕过词法目录检查**
- 文件:行：`scripts/check-probe-sources.mjs:24`、`scripts/check-probe-sources.mjs:31`
- 说明：`insideSourceDirectory` 只做词法判断，`readPlainFile` 只在最终路径上 `lstat`。如果 `packages/runtime-sandbox/src/` 下的某个中间目录是符号链接，读取会跟随它到仓库外。由于脚本只打印摘要前缀、不打印文件内容，实际信息泄露风险很低；是否值得处理取决于对检查脚本的威胁模型。
- 建议：如果要收紧，用 `realpathSync` 把 `SOURCE_DIRECTORY` 和 `path.dirname(full)` 都解析后再比较前缀，并在测试里加软链目录用例。

## 侧重检查

- **错误路径**：读了 `PROBE_SOURCES_RECORD_MISSING/UNREADABLE/INVALID`、`PROBE_BOOTSTRAP_MISSING/UNREADABLE/DIGESTS_NOT_FOUND/DUPLICATE_NAME/ENTRY_FORMAT`、`PROBE_SOURCE_UNLISTED/MISSING/UNREADABLE/CHANGED` 的产生位置和 CLI 退出码。新增的 `RECORD_UNREADABLE`、`ENTRY_FORMAT` 有直接用例；但 `RECORD_MISSING`、`BOOTSTRAP_MISSING`、`BOOTSTRAP_UNREADABLE`、`SOURCE_MISSING` 仍没有测试。
- **不可信输入**：`record` 的 `built`、`source`、两个摘要和 `bootstrap` 都有校验；反斜杠被拒绝；`..` 越界被拒绝；目录本身被拒绝。绝对路径校验/读取不一致见问题 2。
- **安全**：脚本只读文件、不执行被检查内容、不联网；最终路径的目录/FIFO/软链会被 `lstat().isFile()` 拒绝，避免读到设备文件或阻塞。中间目录软链是残余风险（问题 5）。
- **资源耗尽**：`readFileSync` 会把整个文件读入内存，没有大小上限，但输入是仓库内受审的 JSON 和源码文件，风险低；目录/FIFO 已通过 `lstat` 拒绝，不会卡死。
- **不可撤销操作**：`check-probe-sources.mjs` 没有任何写操作；`run-release-walkthrough.sh` 新增的 `-f` 只做存在性检查，不修改文件。
- **规则/文档一致**：I-78、I-79 与代码基本一致；作者“`test_make_packet.py` 不在 `npm run check` 里”的说法已核实为真；I-79 的“两项拦下”措辞见问题 4。

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 本次 diff 只改了 `scripts/check-probe-sources.mjs`、测试、`docs/incidents-and-gates.md`、`package.json`、`scripts/delivery-mode/hermes/run-release-walkthrough.sh` 和新文件 `scripts/delivery-mode/probe-sources.json`。搜索结果显示这些探针文件只被检查脚本和测试引用，不在系统提示、工具定义、历史消息或遮盖路径上。没有触碰“只在末尾追加”和“每轮变化值放最后一条消息”的相关代码。

2. **会不会让同一段文字在不同请求里变成不同字节？不会。** 这些值不进入模型请求。就检查脚本本身而言，输出顺序由 `record.files` 数组顺序和 bootstrap 文件行顺序决定；`Set` 只用于成员判断和去重，不用于生成输出；没有时间戳、随机数或依赖环境的哈希盐。同一输入每次输出相同字节。

3. **有没有对应的自动检查？部分有。** `npm run check:probe-sources` 同时跑 `node scripts/check-probe-sources.mjs` 和 24 个 vitest 用例，`test/tooling/run-all-checks.test.mjs:54` 也确认它进了 `npm run check`。从上一版脚本对比看，新增/改写的 5 个用例（怪名字、无尾逗号、反斜杠、目录本身、记录不是普通文件）确实都会在旧代码上失败（我按代码推演，未实际执行）。但 `SOURCE_TREE_EMPTY` 的用例不在任何自动门禁里；另外 `RECORD_MISSING`、`BOOTSTRAP_MISSING`、`BOOTSTRAP_UNREADABLE`、`SOURCE_MISSING` 仍无测试；问题 3 的“块外格式一致”也没有被真正覆盖。

4. **每个新值/改动值的两端是否都能接受？基本可以，但有两处要修。**
   - `check:probe-sources` 脚本名：由 `check:steps` 调用，`run-all-checks.test.mjs` 也检查它是真实 npm script，正常。
   - `probe-sources.json` 的 `built`：`BUILT_NAME` 与上线包检查的 `[a-z-]+\.js` 一致，且由 `bootstrap.mjs` 使用，正常。
   - 两个摘要：均为小写 64 位十六进制，由同一正则校验，正常。
   - `source`：校验用 `path.resolve`、读取用 `path.join`，两端语义不一致（问题 2）。
   - 新错误码 `PROBE_SOURCES_RECORD_UNREADABLE`、`PROBE_BOOTSTRAP_ENTRY_FORMAT`：目前只有测试和文档消费，没有其他程序依赖其格式，正常。
   - `SOURCE_TREE_EMPTY` 和退出码 3：`make-packet.py` 只判断非零并把输出截断为 400 字符，不解析具体码；测试断言了码 3，正常。但它没有自动门禁（问题 1）。

## 未核实

- 记录里的 `sourceSha256` / `builtSha256` 是否真的对应当前三个源码文件和当前 bootstrap（不能运行 `sha256sum`/Node）。
- “Hermes 上 `npm run check` 34 步全过”“5 个用例在上一版脚本上失败”没有实际运行，仅按代码和测试内容推演。
- `.github/workflows` 在当前稀疏检出中不存在，无法确认仓库外是否还有别的 CI 会跑 `test_make_packet.py`；但本仓库能看到的 npm/CI 配置里没有。
