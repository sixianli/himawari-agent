## 读代码证实的发现

### 1. 低｜`scripts/check-probe-sources.mjs:120-121`
**问题**：源码指纹按工作区原始字节计算，但 bootstrap 的解析前先做了换行归一化。仓库没有 `.gitattributes`，Windows 上 Git 默认 `core.autocrlf=true` 会把 `.ts` 检成 CRLF，于是同一条记录在 Windows 上会报 `PROBE_SOURCE_CHANGED`，而 Linux/macOS 通过。
**证据**：
- `scripts/check-probe-sources.mjs:55`：`const normalized = text.replace(/\r\n?/g, "\n");`
- `scripts/check-probe-sources.mjs:120-121`：`const actual = sha256(source.bytes); if (actual !== file.sourceSha256)`
- 仓库根目录没有 `.gitattributes`（glob 未找到）。
**建议**：给源码也按归一化文本计算，或加 `.gitattributes` 固定 `packages/runtime-sandbox/src/*.ts text eol=lf`；若只支持 Linux，则在记录旁写明。

### 2. 低（门槛完整性，可视为设计取舍）｜`scripts/check-probe-sources.mjs:34、103-105`
**问题**：受保护文件集合完全由 bootstrap 的 `originals` 和记录共同决定，记录只校验“非空”和双向一致。若有人同时从 bootstrap 和记录里删掉某个文件，检查会静默通过，不再保护该文件，也不会提示“原本有三个”。
**证据**：
- `:34`：`if (!Array.isArray(record.files) || record.files.length === 0) return [...]`
- `:103-105`：只在 bootstrap 里出现的名字才报 `PROBE_SOURCE_UNLISTED`。
**建议**：把期望的三个 `built` 名字或数量作为常量断言（例如固定 `["job-host-main.js","sandbox-sdk.js","sandbox-sdk-worker.js"]`），删除时强制要求显式改检查。

### 3. 信息（作者说法核对）｜`package.json:27、49`
**问题**：作者说“`check:steps` 里 `check:probe-sources` 和 #272 新加的步骤都在”。核对后：#272 **没有在 `check:steps` 新增步骤**，它只把已有的 `check:egress-redaction` 命令改成 `node ... && vitest ... test/tooling/egress-redaction-check.test.mjs`。合并后 `check:steps` 里 `check:probe-sources`、`check:egress-redaction` 各出现一次，无重复、无丢失，这一点是对的。
**证据**：
- `package.json:27` 的 `check:steps` 中同时含 `check:egress-redaction` 与 `check:probe-sources`。
- `git diff e733d692..cee6a781 -- package.json` 只显示 `check:egress-redaction` 一行被 #272 改。
**建议**：说明里把“新加的步骤”改成“修改了 `check:egress-redaction` 的命令”，避免误以为 `check:steps` 多了一行。

### 4. 信息（作者说法核对，非问题）
作者说增量只有两段：`e733d692` 只改复核记录、`cee6a781` 合并 #272。核对为真：
- `git diff 5f21139b..e733d692` 只动 `.agents/reviews/pr-266/round-12/` 和 `usage.jsonl`。
- `git diff 5f21139b..cee6a781` 的代码改动只有 #272 的 `check-egress-redaction.mjs`、其测试和 `package.json:49`。PR 266 的探针文件在 `5f21139b` 已存在。

## 推测（未能在本环境运行验证）

- **源码哈希记录的正确性**：不能运行 `sha256`，未独立复算记录中的 4 个 `sourceSha256`。但用 git 核对到：最后一次改动源码的提交是 `12c8bfb7`，记录由更晚的 `ea9f89ef` 引入，且 `git diff 269d4436..80eaff -- packages/runtime-sandbox/src .../bootstrap.mjs` 为空，因此记录与当前源码在历史上是配套的。**未核实**实际哈希值。
- **Hermes 上的 `npm run check` 结果**：本环境只允许 git/read/grep/glob，未运行，**未核实**。
- `OTHER_LINE_IN_ORIGINALS = /^\s*"[^"]*"\s*:|[0-9a-f]{64}/i`（`check-probe-sources.mjs:12`）带 `i`，会让 `originals` 块内任何含 64 位十六进制（含大写）的行被当成格式错误，而 Python 上线包检查会忽略注释行。方向是误报而不是漏报，影响很小。

## 侧重检查

- **错误路径**：记录缺失/不可读/非文件/JSON 坏、bootstrap 缺失/不可读、条目格式坏、重复名、未登记名、文件缺失/是目录，均有明确错误码与测试（`probe-sources.test.mjs:171-271`）；CLI 在记录坏时退出 1（`:273-283`）。失败方向都是 fail-closed。
- **不可信/不合规范输入**：`built` 限定 `^[a-z-]+\.js$`，`source` 必须严格等于 `packages/runtime-sandbox/src/<built换成.ts>`，因此无法用 `..`、绝对路径、反斜杠越出源码目录（`check-probe-sources.mjs:9、40`）；测试覆盖了 `../`、`..\\`、绝对路径、子目录等（`probe-sources.test.mjs:208-232`）。`readPlainFile` 用 `lstatSync().isFile()`，符号链接被视为不可读（`:24-26`）。
- **资源耗尽/不可撤销操作**：检查只读文件并打印，不写仓库；测试只在自己的 `mkdtempSync` 临时目录内写/递归删（`probe-sources.test.mjs:11-14、28-31`）。
- **规则/文档/代码一致**：
  - `docs/incidents-and-gates.md:117`（I-79）与 `scripts/check-probe-sources.mjs`、`package.json:37` 一致；`:118`（I-80）与 `run-release-walkthrough.sh:17-23`、`test_make_packet.py:787-793` 一致。
  - 两条新增事件行通过 `check-incident-gates` 的格式要求：ID 唯一、日期/次数/状态合法、`已落门槛` 下点名的路径都存在（`scripts/check-incident-gates.mjs:46-70`，我核对了 `:117-118` 里的路径）。
  - #272 的静态检查只扫 `packages`/`apps` 的 `src`，不扫 `scripts/`，与 `scripts/check-probe-sources.mjs` 无相互影响；两者都通过 `package.json` 的 npm script 串行执行，没有共享文件或状态。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。改动只涉及 `package.json` 的检查脚本、`scripts/check-probe-sources.mjs`、`probe-sources.json`、`test/tooling/*`、交付脚本和文档；没有碰系统提示、工具定义、历史消息、出口遮盖或运行时序列化。发给模型的内容仍然没有新增任何“固定前部”内容，也没有把每轮变化的值挪到前面；本改动与 `.claude/rules/prompt-prefix.md` 第二、三节的只追加/冻结规则无关，不构成对请求开头的改动。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。本改动不参与模型请求组装，也不改运行时的遮盖逻辑；#272 改的是静态审计脚本，不是 `redactForEgress` 的运行时行为。检查脚本内部输出的顺序也是确定的（`record.files` 数组 + `bootstrapDigests` 的顺序遍历），不依赖 Set/Map 遍历来生成文本。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有。`npm run check:probe-sources` = `node scripts/check-probe-sources.mjs && vitest ... test/tooling/probe-sources.test.mjs`（`package.json:37`），并且 `check:steps` 包含它（`:27`）。`test/tooling/run-all-checks.test.mjs:54-57` 断言步骤名和完整命令与 `package.json` 一致。反向用例覆盖：源码改动、只改 bootstrap、未登记文件、大小写/长度不对的摘要、缺尾逗号、重复名、空/坏记录、记录是目录、CLI 非零退出（`probe-sources.test.mjs:65-283`）。这些用例直接调用 `probeSourceProblems` 的失败分支，去掉对应判断就会失败。未覆盖：缺 bootstrap/缺记录的专门用例、源码变更时 CLI 退出的专门用例；但代码路径与已测的退出逻辑相同。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   - `check:probe-sources`：`run-all-checks.stepNames` 接受 `npm run <name>` 形式；测试逐字比对了命令（`run-all-checks.test.mjs:55-57`）。
   - 记录字段：`built`、`source`、`builtSha256`、`sourceSha256` 全部由 `recordProblems` 校验；三个 `source` 文件都存在；记录里的 `builtSha256` 与 `bootstrap.mjs:11-13` 的三个值逐字相同。
   - bootstrap 条目：`PACKET_CHECK_ENTRY` 与上线包 `check-packet-consistency.py:98` 的 Python 正则 `^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$`（`re.M`）在名字、摘要、逗号、行首行尾约束上一致，因此检查接受的条目上线包检查也能读。
   - `SOURCE_TREE_EMPTY`：由 `test_make_packet.py:787-793` 断言 rc=3 和消息内容，与 `run-release-walkthrough.sh:23` 一致。
   - 文档值：I-79/I-80 的编号、状态、路径都通过 `check-incident-gates` 的消费规则。
   - #272 的 `check:egress-redaction`：`test/tooling/egress-redaction-check.test.mjs` 存在，命令在 `package.json:49`，与本 PR 的探针检查没有交集。

**结论**：合并结果本身正确，`check:steps` 无重复/丢失，`run-all-checks.test.mjs` 的断言与 `package.json` 一致；未发现会出错的高/中严重度问题。仅有上面两条低严重度的加固建议，以及作者说明里“#272 新加步骤”的措辞需要修正。
