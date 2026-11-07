## 结论（按严重度从高到低）

未发现高、中严重度会直接导致运行错误的问题。以下问题均以我在代码中读到的事实为准；无法执行的部分单独标注「未核实」。

### 1）低 —— README 的说明与代码不一致：`npm run check` 现在会跑 tooling 测试

- 文件：`README.md:55`、`package.json:27`、`package.json:37`
- 问题：README 断言“`npm run check` 不包含 tooling 测试”，但本 PR 把 `test/tooling/probe-sources.test.mjs` 接进了 `check:probe-sources`，而该步骤已加入 `check:steps`。
- 证据：
  - `README.md:55`：“`npm run check` 不包含 tooling 测试，不能替代它”
  - `package.json:37`：`"check:probe-sources": "node scripts/check-probe-sources.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/probe-sources.test.mjs"`
  - `package.json:27` 的 `check:steps` 中含 `npm run check:probe-sources`
- 建议：把 README 改成“`npm run check` 只跑 `probe-sources.test.mjs` 这一个 tooling 文件；完整的 tooling 测试仍要跑 `npm run test:tooling`”，或者不要在该步骤里跑 tooling 测试。

### 2）低 —— 同时从 bootstrap 和记录里删掉一项时，门禁静默放行，探针覆盖缩小

- 文件：`scripts/check-probe-sources.mjs:34-50`、`scripts/check-probe-sources.mjs:103-105`、`scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`
- 问题：检查只要求 `record.files` 非空；`PROBE_SOURCE_UNLISTED` 只覆盖“bootstrap 有、记录没有”，反方向会报 `PROBE_BUILT_DIGEST_MISMATCH`。如果同时把 `sandbox-sdk-worker.js` 从 bootstrap 的 `originals` 和 `probe-sources.json` 里删掉，两边仍然一致，检查完全通过；`check-packet-consistency.py` 也从 bootstrap 现取 `originals`，同样不会报。结果是探针悄悄地不再测量/校验这个文件，而这正是 I-79 想防的那类失效。
- 证据：
  - `scripts/check-probe-sources.mjs:34-35`：`if (!Array.isArray(record.files) || record.files.length === 0) return [...]`
  - `scripts/check-probe-sources.mjs:103-105`：只遍历 `recorded.keys()`，没有反向的“期望集合”校验
  - `check-packet-consistency.py:98`：`originals = dict(re.findall(...))`，清单完全由 bootstrap 当前内容决定
- 建议：在检查里固定期望的三个文件名（或把期望集合写进记录并校验），少一项就报错；补一条“bootstrap 和记录同时删掉一项必须失败”的反向用例。

### 3）低（推测）—— 只解析 `originals` 的字面量；动态加入的文件既不会被记录，也不会被包检查发现

- 文件：`scripts/check-probe-sources.mjs:54-75`、`scripts/check-probe-sources.mjs:98-105`、`check-packet-consistency.py:98`
- 问题：检查只读 `const originals = { ... }` 中符合 `"name": "64位小写十六进制",` 的行。若将来有人用 `originals["sandbox-sdk-extra.js"] = "<digest>"` 或在块内 `...extra` 展开新增条目，探针运行时会认这个文件，但本检查和上线包检查都看不到它；该文件的摘要过期只会在 S6 验收时以 `PROBE_ORIGINAL_RUNTIME_CHANGED` 形式暴露，而不是在 PR/出包阶段。
- 证据：
  - `scripts/check-probe-sources.mjs:57-58`：`const start = lines.indexOf("const originals = {")`，`const end = ... lines.indexOf("};" ...)`
  - `scripts/check-probe-sources.mjs:62`：只收集 `PACKET_CHECK_ENTRY` 匹配的字面量行
  - `check-packet-consistency.py:98`：同样的字面量文本正则
- 建议：至少额外拒绝 `originals[`、`Object.assign(originals`、块内 `...` 展开等动态写法；最好用 AST/JSON 解析替代文本正则。当前 bootstrap 没有这种写法，所以是残留风险，不是现状缺陷。

### 4）低（推测）—— 源码摘要按原始字节算，CRLF 工作区可能误报

- 文件：`scripts/check-probe-sources.mjs:55`、`scripts/check-probe-sources.mjs:111-124`（仓库根没有 `.gitattributes`）
- 问题：bootstrap 文本做了 `\r\n` → `\n` 归一化，但源码是用 `readFileSync` 的原始字节算 SHA-256。若 Windows 开发者检出时 `core.autocrlf=true`，源码变成 CRLF，`PROBE_SOURCE_CHANGED` 会误报。仓库没有 `.gitattributes` 固定 LF。
- 证据：`check-probe-sources.mjs:55` 只归一化 bootstrap；`:120` `const actual = sha256(source.bytes);`
- 建议：加 `.gitattributes`（如 `* text=auto eol=lf`），或明确不支持这类检出并在文档写明。当前 README 的目标环境是 Mac/Linux/Hermes，所以影响低。

## 侧重检查

我按「错误路径、不合规范或不可信输入、安全、资源耗尽、不可撤销的操作、规则/文档与代码一致性」逐项查了：

- **错误路径**：记录缺失/不可读/非法 JSON/空 `files`/字段缺失或类型错/重复 `built`，都有明确错误码；bootstrap 缺失/不可读/找不到 `originals` 块/块内格式错/块外条目/重复名，也都有明确错误码；源码缺失/不可读/目录，都有 `PROBE_SOURCE_MISSING`/`PROBE_SOURCE_UNREADABLE`；CLI 以 `process.exitCode = 1` 失败。`scripts/check-probe-sources.mjs:77-135`。
- **不可信输入 / 路径安全**：记录里的 `source` 被强制为 `packages/runtime-sandbox/src/<built>.ts`，`built` 受 `^[a-z-]+\.js$` 限制，`../`、反斜杠、绝对路径、子目录、错误文件名都会被 `recordProblems` 拒绝；测试覆盖了这些用例（`test/tooling/probe-sources.test.mjs:203-231`）。脚本只读取和哈希文件，不执行记录里的内容。
- **资源耗尽**：只读取记录、bootstrap 和三个源码文件，循环规模由仓库内记录的 `files` 数组决定；没有网络、没有递归目录遍历、没有不受限的进程创建（测试只 spawn 两次自己）。
- **不可撤销操作**：本改动全部是只读检查、文档、测试和 `package.json` 接线；`run-release-walkthrough.sh` 新增的 `[[ -f ... ]]` 也只读，不删除、不改动远端状态。
- **文档/代码一致性**：I-79、I-80 两行的 7 列、状态、日期、被反引号引用的仓库路径都能通过 `check-incident-gates.mjs`：路径确实存在（`docs/incidents-and-gates.md:117-118`）。`make-packet.py:863-882` 确实先在 `hermes.preflight()` 之后才 `hermes.build()`，与作者“构建之前先跑预检”一致。唯一发现的不一致是上面的 README:55。
- **作者自述的取舍**：`check-probe-sources.mjs:106-125` 只把源码与记录里的 `sourceSha256` 比较，不与实际构建产物绑定；因此“只更新记录里的源码指纹、不重新构建”确实能让检查通过，与 I-79 的“未覆盖”描述一致，不是声明与代码不符。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 PR 改动的 8 个文件全是本地脚本、测试、文档和 `package.json`；没有任何系统提示、工具定义、历史消息或出口遮盖的生成/修改路径。发给模型的内容仍然只在末尾追加，本改动没有新增任何每轮变化的值。依据 `prompt-prefix` 规则第 2、4 条。

2. **不会让同一段文字在不同请求里变成不同字节。** 新检查只读取文件并输出确定性的错误信息（文件名、摘要前缀），没有时间、随机数或无序集合进入模型请求；记录是固定顺序的 JSON 数组。该改动与模型通信完全无关。

3. **有对应的自动检查，反向用例设计基本成立。** `probe-sources.test.mjs:57-59` 验证当前仓库通过；`:65-72` 的 `[probe-digest-stale]` 断言源码变化报 `PROBE_SOURCE_CHANGED`；记录损坏、bootstrap 条目格式、重复、块外、摘要不一致等都有精确断言；`run-all-checks.test.mjs:54-57` 断言完整命令；`test_make_packet.py:787-793` 删掉 `package.json` 后断言 `SOURCE_TREE_EMPTY` 和 exit 3。按代码推断，删掉对应的比较或检查逻辑后这些断言会失败。**未核实**：我没有运行测试，无法确认实际执行结果。补强点：没有“源码文件缺失”的反向用例，也没有“bootstrap 和记录同时删一项”的反向用例（见问题 2）。

4. **逐个值的生产端/消费端核对结果：**
   - `probe-sources.json` 的 `bootstrap`/`files` 结构：由人工维护，`recordProblems`（`check-probe-sources.mjs:32-52`）严格校验；测试 fixture 写同一结构；两端一致。
   - `builtSha256`/`sourceSha256`：检查要求小写 64 位十六进制；bootstrap 的 `originals` 是同样格式；`check-packet-consistency.py:98` 的正则也只认小写 64 位；一致。
   - `built` → `source` 映射：检查强制 `<built>.ts` 位于 `packages/runtime-sandbox/src/`；实际构建 `scripts/ci/build.mjs:47-53` 用 `tsc -p tsconfig.node-build.json` 按文件输出，三个 `.ts` 源文件都存在，映射成立。
   - `check:probe-sources` 键与命令：`package.json:27/37` 与 `test/tooling/run-all-checks.test.mjs:54-57` 完全一致，`stepNames` 的 `^npm run (\S+)$` 能解析。
   - `SOURCE_TREE_EMPTY` 和退出码 3：由 `run-release-walkthrough.sh:23` 产生；`make-packet.py:574-577` 只判断非零；`test_make_packet.py:787-793` 期望 3 和对应消息；一致。
   - I-79/I-80 清单行：`check-incident-gates.mjs` 要求的列数、状态、日期、被引用仓库路径均通过（`docs/incidents-and-gates.md:117-118`）。
   - 唯一跨端不一致：`README.md:55` 的“`npm run check` 不含 tooling 测试”已与代码冲突（问题 1）。
   - `builtSha256` 与实际构建产物之间没有可计算的绑定，只能等 Hermes 的上线包检查；作者在 I-79 的“未覆盖”中已写明，代码与声明一致。

**未核实**：记录里 `sourceSha256` 与当前源码的真实 SHA-256 是否逐字节匹配（我没有权限运行哈希）；作者所述 Hermes 上 `npm run check` 40 步全过及手动复现结果（无法执行）。
