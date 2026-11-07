# PR 266 第 5 轮复核

结论先说：本轮增量（`41c1160..706e97f`）确实按作者说明改了 3 处代码/测试和 1 处文档，作者的大部分说法与代码一致；没有发现会改变模型请求内容的问题。发现 3 个偏低严重度的问题，其中第 1 个是相对上一轮的行为回退。

## 发现的问题（按严重度）

### 1. 中 — 不再要求 `const originals` 声明存在，可能漏掉“探针坏了但检查通过”

- 文件: `scripts/check-probe-sources.mjs:58-65`、`scripts/check-probe-sources.mjs:84`；相关测试 `test/tooling/probe-sources.test.mjs:126-130`
- 问题：上一轮 `bootstrapDigests` 找不到 `const originals = {` 时返回 `null`，会报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`。本轮改成先对整个文件做 `matchAll`，只要文件任意位置出现符合格式的条目就不再报“找不到”，于是“声明被改名/删除、但条目文本还在”的探针可以通过检查。探针运行时是依赖 `originals` 这个名字的：

  `scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs:36`
  ```js
  if (!url.includes("/runtime-sandbox/dist/") || !(basename in originals)) return result;
  ```

  而 `check-packet-consistency.py:98` 也只按整文件正则取条目，同样不会发现声明缺失，所以两个门槛会一起放过这种文件，直到 Hermes 验收时探针才崩。
- 证据：新代码
  ```js
  const entries = [...text.matchAll(PACKET_CHECK_ENTRIES)].map((match) => [match[1], match[2]]);
  const block = text.match(/^const originals = \{\n([\s\S]*?)^\};$/m);
  ...
  if (parsed.entries.length + parsed.malformed.length === 0)
  ```
  测试“fails when the bootstrap has no originals block”只用了单行对象：
  ```js
  writeFileSync(join(root, BOOTSTRAP), `const table = { "job-host-main.js": "${BUILT}" };\n`);
  ```
  因为条目不在行首，才落到 `DIGESTS_NOT_FOUND`；改成多行对象后，新代码会返回 `[]`（我已按代码逐行推演，未实跑）。此外 `test/tooling/probe-sources.test.mjs:105` 的“ignores … outside the originals block”与新用例 `:112` 的差别只在“条目是否在行首”，语义容易误导。
- 建议：保留“`originals` 块必须存在”的独立断言（可以报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND` 或新错误码），再按整文件正则比对条目；或至少加一条“多行且无 `const originals`”的反向测试，并在文档中写清这道检查不校验探针结构。

### 2. 低 — 记录没有校验 `built` 与 `source` 的对应关系

- 文件: `scripts/check-probe-sources.mjs:42-50`；记录 `scripts/delivery-mode/probe-sources.json:5-20`
- 问题：`recordProblems` 只逐字段校验 `built`、`source`、两个摘要的格式和 `source` 是否在源码目录内，没有校验 `built`（如 `job-host-main.js`）是否由 `source`（`job-host-main.ts`）构建而来。若记录把 `source` 指向另一个合法源码文件并同步填入该文件的 `sourceSha256`，检查仍会通过，但这道门从此监视的是错误的源码文件；真正的目标源码变化不会被发现。当前记录里的三个名字是对应的，但没有任何自动检查保证这一点。
- 证据：
  ```js
  BUILT_NAME.test(file.built) &&
  typeof file.source === "string" &&
  insideSourceDirectory(root, file.source) &&
  DIGEST.test(file.builtSha256) &&
  DIGEST.test(file.sourceSha256)
  ```
  没有类似 `basename(source, ".ts") === basename(built, ".js")` 的关系校验；`check-packet-consistency.py` 只核对 `built` 摘要，也补不上这一端。
- 建议：在 `recordProblems` 里加一条对应关系校验，并补一个 `source` 基名与 `built` 不一致时应报 `PROBE_SOURCES_RECORD_INVALID files[i]` 的用例。

### 3. 低（推测） — JS 与 Python 的“同一条正则”在 CRLF 下并不等价

- 文件: `scripts/check-probe-sources.mjs:12`；对照 `scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`
- 问题：两边都写了 `^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$`，JS 用 `gm`，Python 用 `re.M`。JS 多行模式下 `$` 可以匹配在 `\r` 之前，Python `re.M` 的 `$` 只匹配 `\n` 之前；若文件是 CRLF，JS 能读出条目而 Python 读不到（或行为相反），于是 `npm run check` 通过、上线包检查报 `PROBE_ORIGINALS_NOT_FOUND`。仓库没有 `.gitattributes`，但当前探针文件是 LF、Hermes 是 Linux，所以实际触发概率很低。
- 证据：`const PACKET_CHECK_ENTRIES = /^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$/gm;` 与 `originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))`。
- 建议：读文件后统一换行（或按 `\r?\n` 处理），或加一个 CRLF 用例固定预期。

## 侧重检查

- **错误路径**：记录缺失、不可读、不是普通文件、JSON 坏、`files` 为空、字段类型不对、`built` 重复都有固定错误码和测试（`scripts/check-probe-sources.mjs:38-56,68-85`；测试 `:169-198`）。未发现抛未捕获异常的正常输入路径。
- **不可信/不规范输入**：绝对路径、反斜杠、`..`、指向目录、末尾斜杠都被拒（`check-probe-sources.mjs:32-36`；测试 `:145-167`）。**中间目录是软链接的情况仍未处理**（作者已声明不做）：`insideSourceDirectory` 只做词法判断，`readPlainFile` 只对最后一级 `lstat`；若 `packages/runtime-sandbox/src/` 下有指向外部的目录软链接，记录可绕过目录限制读到外部文件。记录文件本身在仓库内、属可信输入，风险低，但应写清信任边界或改用 `realpath`。
- **安全**：脚本只读文件并计算 SHA-256，不写文件、不执行子进程、不发网络请求；没有不可撤销操作。
- **资源耗尽**：`readFileSync` 整文件读入且无大小上限，正则 `^\s+"…": "[0-9a-f]{64}",$` 没有明显灾难性回溯；在“记录和源码都可信”的前提下不构成实际问题。
- **规则/文档/代码一致性**：`I-78` 写的 `npm run check:probe-sources` 属于 `npm run check`，与 `package.json:27,37`、`scripts/run-all-checks.mjs:31-37`、`test/tooling/run-all-checks.test.mjs:54` 一致；`I-79` 写的“`fd` 先拦下”与 `run-release-walkthrough.sh:20-23` 的顺序一致。本轮没有改任何提示词、工具定义、历史或遮盖相关文件。

## 作者说法核对

| 作者说法 | 核对结果 |
|---|---|
| bootstrap 条目改为像 `check-packet-consistency.py:98` 那样按整文件多行正则读取 | 属实（`check-probe-sources.mjs:12,59`；正则文本与 py:98 相同） |
| `const originals = {` 块内含 64 位摘要但格式不符的行仍报 `PROBE_BOOTSTRAP_ENTRY_FORMAT` | 属实（`:61-64,88`） |
| `source` 为绝对路径时判记录无效 | 属实（`:33`，测试 `:160-167`） |
| 新增两个用例、共 26 个用例 | 用例数属实（26）；“换回上一轮脚本会失败”按旧代码推演成立，**未实跑** |
| `docs/incidents-and-gates.md` I-79 写了 `fd` 先拦下、脚本在此退出 | 属实（`run-release-walkthrough.sh:20-23`） |
| `.agents/reviews/pr-266/round-4/` 是第 4 轮判定 | **未核实**：稀疏检出未包含 `.agents`，`git show` 访问该路径被拒绝 |
| Hermes 上 `npm run check` 34 步全过 | 步数属实（`check:steps` 确为 34 步）；实际运行**未核实** |
| `test_make_packet.py` 不接进 `npm run check` | 属实（`check:steps` 中没有该文件相关步骤） |
| 中间目录是软链接不处理 | 属实（代码没有 `realpath` 校验） |
| `check-packet-consistency.py`、`read-driver.mjs` 不改 | 属实（`058293d..706e97f` 的 diff 未包含这两个文件） |

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 增量只改 `scripts/check-probe-sources.mjs`、`test/tooling/probe-sources.test.mjs`、`docs/incidents-and-gates.md` 等出货/检查工具，不进入提示词组装；`grep` 显示该脚本只被 `package.json` 和测试引用，没有被请求路径导入。发给模型的内容仍只在末尾追加，每轮变化的值没有新增到系统提示/工具定义/历史中。依据：[prompt-prefix.md 第 4 条](../../.claude/rules/prompt-prefix.md#append-only)。
2. **会不会让同一段文字在不同请求里变成不同字节？不会。** 本轮不产生任何发给模型的序列化内容；检查脚本内部只读文件、比较摘要，输出顺序由文件顺序和记录顺序决定，没有时间戳、随机数或无序集合参与模型请求。
3. **有没有自动检查、反向用例会不会失败？有。** `check:probe-sources` 已接入 `check:steps`，`run-all-checks.test.mjs` 也断言该步骤存在。反向用例覆盖：源码改动、只改探针、探针多认文件、格式异常、绝对路径、目录、坏 JSON、重复条目等；按旧版代码推演，新增的两个用例（`:112`、`:160`）在旧脚本上确实会失败，但**本次没有实际运行测试**。另外 CI 已停（README/ADR 0092），这道门只在有人执行 `npm run check` 时生效。
4. **每个新值/字段的两端都能接受吗？基本可以，但有一处缺口。**
   - `check:probe-sources` 键：`package.json:27,37` 产生，`scripts/run-all-checks.mjs:31-37` 用 `npm run <name>` 解析（冒号合法），`run-all-checks.test.mjs:54` 断言存在，测试命令 `vitest … --project tooling test/tooling/probe-sources.test.mjs` 与文件路径一致。
   - 记录字段 `bootstrap`：只在 `check-probe-sources.mjs:39` 使用，值等于常量路径，测试覆盖 `../outside.mjs`。
   - 记录字段 `built`/`builtSha256`：`check-probe-sources.mjs:90-97` 与探针比对；探针 `bootstrap.mjs:11-13` 的三个摘要与记录 `probe-sources.json:6,12,18` 逐字符一致；`check-packet-consistency.py:112-116` 再用 `built` 和摘要对候选包校验，两端格式一致。
   - 记录字段 `source`/`sourceSha256`：只在 `check-probe-sources.mjs:98-111` 使用，新增的绝对路径用例覆盖。缺口是第 2 条：`source` 与 `built` 的对应关系没有校验。
   - 错误码字符串：仅用于人读日志，没有下游解析器依赖，改名不会破坏其他消费者。

## 未核实

- `npm run check` / 新增 26 个用例的实际运行结果（受工具限制不能执行测试）。
- `probe-sources.json` 中三个 `sourceSha256` 是否与当前源码逐字节一致（不能运行 `sha256`；只能确认三个源码文件存在、`builtSha256` 与探针一致）。
- `.agents/reviews/pr-266/round-4/` 的判定内容（稀疏检出未包含该目录）。
- 作者所述 Hermes 上的 34 步全过。
