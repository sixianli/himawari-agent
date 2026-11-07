## 发现（按严重度）

### 中 — D3 的理由与包检查的实际读法不符，回车检查是额外的过严要求
- 位置：`scripts/check-probe-sources.mjs:86`；测试 `test/tooling/probe-sources.test.mjs:141-148`；对照 `scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:97-98`
- 问题：作者说「JS 多行模式的 `$` 能停在回车前、Python `re.M` 不能」，所以 CRLF 会被两种检查读成不同。这个说法只在「直接拿原始字节跑正则」时成立。第 98 行确实用的是 `re.M`，但第 97 行是 `bootstrap = (packet / 'measurement/probe/bootstrap.mjs').read_text()`；Python 文本模式默认 `newline=None`，读入时就把 `\r\n`/`\r` 归一化成 `\n`。因此包检查在 CRLF 上仍会读到条目，并不会「读不同」。
- 证据（我读到的行）：
  - `check-packet-consistency.py:97`：`bootstrap = (packet / 'measurement/probe/bootstrap.mjs').read_text()`
  - `check-packet-consistency.py:98`：`originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))`
  - `check-probe-sources.mjs:86`：`if (text.includes("\r")) return [`PROBE_BOOTSTRAP_LINE_ENDINGS ${BOOTSTRAP}`];`
- 影响：`PROBE_BOOTSTRAP_LINE_ENDINGS` 会让 PR 检查拒绝一个包检查能接受的 bootstrap（假失败）。另外，本轮同时恢复了 `bootstrap.mjs:60` 的块正则 `\{\n`，CRLF 本来就会因为匹配不到 `{\r\n` 而落到 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`；也就是说在当前实现里，第 86 行主要只是把错误码从 `NOT_FOUND` 换成 `LINE_ENDINGS`，并不改变通过/失败。测试名 “the packet check reads differently” 也不准确。
- 建议：要真正对齐 Python，应在解析前把 `\r\n`/`\r` 归一化成 `\n`（或把块正则写成 `\{\r?\n`），这样 CRLF 会像包检查一样被接受；如果团队确实要求仓库里只能 LF，就把这写成明确要求并改测试名/说明，不要归因于 Python 的读法。

### 低 — originals 块只验存在、不验内容，空块 + 块外条目能通过
- 位置：`scripts/check-probe-sources.mjs:59-62`；`scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs:10,36`
- 问题：`bootstrapDigests` 只要求能匹配到一个 `const originals = { ... };` 块，然后从**整个文件**读条目。下面的文件块存在但为空，条目在块外，检查会通过：
  ```
  const originals = {
  };
    "job-host-main.js": "<64位摘要>",
  ```
  但探针只使用块里的 `originals`：`bootstrap.mjs:36` 是 `if (!url.includes("/runtime-sandbox/dist/") || !(basename in originals)) return result;`。空对象意味着它不会插桩，测量会缺失；包检查也按文本读，同样发现不了。D1 想挡「声明被改名但条目还在」，但没挡「声明还在、内容被搬空」。
- 证据（我读到的行）：
  - `check-probe-sources.mjs:60-62`：块匹配后 `if (!block) return null;`，随后 `const entries = [...text.matchAll(PACKET_CHECK_ENTRIES)]...`
  - `bootstrap.mjs:36` 上面的 `basename in originals`。
- 建议：要求 `block[1]` 里能匹配到每个记录的 `built`，或要求「块内条目集合」与「整文件读到的条目集合」一致。

### 低 — basename 检查不锁定确切源码路径
- 位置：`scripts/check-probe-sources.mjs:46-47`、`32-36`
- 问题：`insideSourceDirectory` 允许 `packages/runtime-sandbox/src/` 下的子目录，`path.posix.basename(file.source)` 只比文件名。因此 `packages/runtime-sandbox/src/sub/job-host-main.ts` 也能通过（只要 `sourceSha256` 记的是它的摘要）。检查就可能监视错误的文件，真正的 `src/job-host-main.ts` 改动不再被发现。这正是 I-73 那类「值能过校验，但不指向真实对象」的问题。
- 证据（我读到的行）：
  - `check-probe-sources.mjs:34-35`：`const relative = path.relative(path.join(root, SOURCE_DIRECTORY), path.resolve(root, source)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);`
  - `check-probe-sources.mjs:47`：`path.posix.basename(file.source) === file.built.replace(/\.js$/, ".ts") &&`
- 建议：在记录里放确切的三个相对路径并逐一比较，或要求源码必须直接位于 `src/` 下（不允许子目录）。

### 低 — I-79 的反向用例不在 `npm run check` 里
- 位置：`package.json:27,37`；`docs/incidents-and-gates.md:117`；`scripts/delivery-mode/test_make_packet.py:783-789`
- 问题：`SOURCE_TREE_EMPTY` 的测试只在 `test_make_packet.py`，该文件没有对应的 npm 脚本，也不在 `check:steps`。作者已在说明和 I-79 里承认（另开 PR #269）。所以这道改动的自动检查在开发期 CI 里不会执行；回归时只有 Hermes 出包时 `run-release-walkthrough.sh` 会拦。
- 证据：`package.json:27` 的 `check:steps` 列表里没有 `test_make_packet.py`；`package.json:37` 的 `check:probe-sources` 只跑 `probe-sources.test.mjs`；I-79 原文写「这个文件目前不在 `npm run check` 里」。
- 建议：按计划把 `test_make_packet.py` 接进 `npm run check`（或至少接进一个会跑的检查），否则 I-79 的「已落门槛」依赖的是出包路径，而不是开发期检查。

### 信息 — 文档未列新错误码；U+2028/U+2029 仍与 Python 不一致
- I-78 只举了 `PROBE_SOURCE_CHANGED`、`PROBE_BUILT_DIGEST_MISMATCH`、`PROBE_SOURCE_UNLISTED`，没写 `PROBE_BOOTSTRAP_LINE_ENDINGS`、`PROBE_BOOTSTRAP_ENTRY_FORMAT`、`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`。I-78 的描述不是穷举，所以不算硬错误，但读者会以为只有这三个错误码。
- `text.includes("\r")` 只挡 CR；JS `m` 的 `^` 还把 U+2028/U+2029 当作行首，而 Python `re.M` 只认 `\n`。理论上可以构造「JS 读到条目、Python 读不到」的 bootstrap（例如在非空白字符后放 U+2028 再放条目），让 PR 检查放行而包检查报 `PROBE_ORIGINALS_NOT_FOUND`。这是理论边界，概率极低（推测）。

## 侧重检查

- **错误路径**：缺记录/缺 bootstrap/缺源码、记录不是普通文件、JSON 坏、记录字段非法、bootstrap 条目格式坏、重复名、没有 originals 块、空块+块外条目、CRLF，都有对应分支或测试。结论：大部分覆盖；空块+块外条目是残留缺口（见上），CRLF 是过严（见上）。
- **不合规范或不可信的输入**：`source` 拒绝反斜杠、绝对路径、`..` 逃逸；`bootstrap` 必须等于常量；名字限定 `[a-z-]+\.js`；摘要限定 64 位十六进制。残留：`src/` 下的同名子目录文件也能通过（见上）；U+2028/U+2029 未处理（理论）。
- **安全**：检查是只读的，不写文件、不联网、不执行被检查内容；无不可逆操作。`run-release-walkthrough.sh` 只新增一个文件存在性检查，不改权限或删除。
- **资源耗尽**：只读固定仓库里的几个小文件；`readFileSync` 全量读入，但输入大小有界；没有来自网络或用户的不受限输入。
- **规则/说明与代码一致性**：I-78/I-79 的行格式、状态、门槛路径能被 `scripts/check-incident-gates.mjs` 接受（路径都存在）；I-79 对「测试不在 `npm run check`」的说明属实；「34 步」与 `package.json` 的 `check:steps` 条数一致；「3 个新用例、共 29 个」与测试文件一致。唯一明确不一致的是 D3 的理由（见第一条）。

## 读代码证实的 / 推测与未核实

**读代码证实：**
- 增量 `706e97f..b3c34fe` 只改了 `scripts/check-probe-sources.mjs`（12 行）和 `test/tooling/probe-sources.test.mjs`（19 行），没有碰请求组装代码。
- 第 6 脚本确实在 `const originals = {` 块找不到时返回 `null` 并报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`；找到后条目仍从整个文件读（`check-probe-sources.mjs:60-62`）。
- 记录里 `source` 的文件名被要求等于 `built` 的 `.js` 换成 `.ts`（`check-probe-sources.mjs:47`）；真实记录的三个 `built` 与 bootstrap 的键完全一致，三个源码文件存在且 basename 对应（`job-host-main.ts`、`sandbox-sdk.ts`、`sandbox-sdk-worker.ts`）。
- 真实记录里的 `builtSha256` 与 bootstrap 的三条摘要逐字相同（我对照了 `probe-sources.json:6,12,18` 与 `bootstrap.mjs:11-13`）。
- 测试文件当前共 29 个用例（含两个 `it.each` 展开：6 + 5）。
- 我按第 5 轮脚本（`706e97f`）逐条推演：三个新用例都会失败——CRLF 用例旧脚本返回 `[]`，多行条目但声明缺失用例旧脚本返回 `[]`，basename 不匹配用例旧脚本返回 `PROBE_SOURCE_MISSING`。
- `package.json` 的 `check:steps` 现在有 34 个步骤，且包含 `check:probe-sources`；`test/tooling/run-all-checks.test.mjs:54` 断言了它。
- `test_make_packet.py` 没有对应的 npm 脚本，不在 `check:steps`。

**推测或未核实：**
- `probe-sources.json` 三个 `sourceSha256` 是否真等于当前源码字节：受工具限制（只能读文件，不能算哈希），未核实；但 `test/tooling/probe-sources.test.mjs:57-59` 的「仓库原样通过」用例会覆盖，作者称 Hermes 上通过。
- 作者称「Hermes 上 `npm run check` 34 步全过」：未执行，未核实；步骤数本身已核对为 34。
- 「`.agents/reviews/pr-266/round-5/`：第 5 轮判定」：工作区里没有这些文件，`git show` 对 records 路径返回 `REVIEW_GIT_REFUSED records-path`，未核实其内容。
- 空块+块外条目、CRLF、U+2028 这些边界在实际仓库里发生的概率：推测，极低。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动只涉及 `scripts/check-probe-sources.mjs`、`test/tooling/probe-sources.test.mjs`、`scripts/delivery-mode/probe-sources.json`、`package.json`、`scripts/delivery-mode/hermes/run-release-walkthrough.sh` 和文档/复核记录，均不在系统提示、工具定义、历史消息、遮盖结果的组装路径上。发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息里（依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)）。我未审计与本次 diff 无关的请求组装代码。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。模型请求没有被这个改动触碰。新增的序列化只有手写的 `probe-sources.json`（固定内容、无时间字段）；检查脚本的输出顺序来自记录数组，`Set` 只用于成员判断，不决定输出顺序。没有依赖前后文的遮盖、时间字段或无序遍历进入请求字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   第 6 轮的 D1/D2/D3 有：`test/tooling/probe-sources.test.mjs` 的 29 个用例由 `npm run check:probe-sources` 执行，且该步骤已在 `check:steps` 里；`run-all-checks.test.mjs` 验证它被接上。按两个版本代码推演，3 个新用例在第 5 轮脚本上都会失败，所以反向用例是真实的（我没有实际运行，受工具限制）。但 I-79 的 `SOURCE_TREE_EMPTY` 反向用例只在 `test_make_packet.py`，不在 `npm run check`，这部分没有 CI 自动执行。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `probe-sources.json` 的 `bootstrap`、`files[].built`、`builtSha256`、`source`、`sourceSha256`：唯一消费者是 `scripts/check-probe-sources.mjs` 和对应测试（我 grep 过，没有别的引用）。脚本校验类型、名字正则、目录归属、basename、摘要格式；真实记录的 3 条 `built` 与 bootstrap 的 3 条键一致，`builtSha256` 逐字相同，`bootstrap` 等于常量。**但** `source` 只校验到「在 `src/` 内 + basename 匹配」，不锁定确切路径（见上）。
   - `check:probe-sources`：`run-all-checks.mjs` 解析 `check:steps` 时接受；`run-all-checks.test.mjs` 接受并断言；文档 I-78 引用它。均一致。
   - `PROBE_BOOTSTRAP_LINE_ENDINGS`、`PROBE_BOOTSTRAP_ENTRY_FORMAT`、`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`：只被测试断言，没有外部校验契约；未写进 I-78，属文档不穷举。
   - `SOURCE_TREE_EMPTY`：`run-release-walkthrough.sh:23` 产生（退出码 3）；`make-packet.py:574-577` 只判非零并转发 stderr 尾部，接受；`test_make_packet.py:783-789` 期望退出码 3 和该字符串，接受。退出码 3 与既有 `SOURCE_MISSING` 一致。
   - 结论：链路两端基本能对上；需要补的是 `source` 的确切路径约束（以及 `test_make_packet.py` 的 CI 接入）。
