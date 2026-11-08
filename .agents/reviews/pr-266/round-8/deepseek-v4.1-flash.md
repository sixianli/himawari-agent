# PR 266 第 8 轮复核

先说明：我不能运行 Node/Python，也没有 `sha256` 工具，所以“记录里的摘要和当前文件一致”“全量 `npm run check` 在最终提交上通过”这类结论只能按代码和作者陈述判断，标为未核实。

## 一、作者说法逐条核对

| 说法 | 结论 | 依据 |
|---|---|---|
| 合并只在 `package.json` 的 `check:steps` 和 `run-all-checks.test.mjs` 冲突，两边新步骤都保留，共 36 步 | 基本正确 | 最终 `check:steps` 同时含 `check:probe-sources`、`check:delivery-packet`、`check:check-runner`，我逐项数过是 36 步；测试里 `boundaries` + 三条新增 `toContain` 共四条都在（`test/tooling/run-all-checks.test.mjs:52-56`）。`test_make_packet.py` 也有自动合并进来的 main 侧改动。 |
| 测试里“三条 `toContain` 都保留” | 正确（指三条新增） | 新增的是 `check:probe-sources`、`check:delivery-packet`、`check:check-runner`，`boundaries` 是原有的。 |
| 模仿 `check-packet-consistency.py` 第 98 行，`\s+` 可跨空行，按条目名所在行判断块内外（D1） | 对 ASCII 文件成立 | Python 第 98 行确实是那条 `re.findall(..., re.M)`（我已在该文件第 98 行读到）；JS 的 `(?<=^|\n)\s+…(?=\n|$)`（`scripts/check-probe-sources.mjs:11`）在只有 `\n` 的文本上与 Python 的 `^`/`$`+`\s+` 等价。 |
| 两个摘要字段必须是字符串（D2），新增“摘要数组”用例 | 正确 | `scripts/check-probe-sources.mjs:40,42` 有 `typeof … === "string"`；`test/tooling/probe-sources.test.mjs:236` 是数组用例。 |
| 共 34 个用例 | 正确 | 17 个普通 `it` + 7 个记录路径 `it.each` + 1 + 6 个坏记录 `it.each` + 3 个其它 = 34。 |
| 换回上一轮脚本时“跨空行”和“摘要数组”两个用例失败 | 成立 | 旧脚本是逐行 `^\s+"…"`，无缩进的空行后条目不会匹配；旧脚本对 `[BUILT]` 的 `DIGEST.test` 会强制转型通过，后续报的是 `BUILT_DIGEST_MISMATCH` 而不是测试期望的 `RECORD_INVALID`，所以断言仍失败。 |
| 合并后 36 步全过（改动 2 之前） | 未核实（未运行） | 只能确认步骤集合完整。 |
| 改动 2 之后 `check:layout`、`check:admin-schema-range` 超时 | 未核实 | 与本次改动的两个文件没有直接关系。 |

## 二、发现的问题（按严重度）

### 1. 低｜文档与代码不一致：I-79 说 `test_make_packet.py` 不在 `npm run check`，合并后已经不成立

- 位置：`docs/incidents-and-gates.md:117`（I-79）、`package.json:27,42`
- 读到的证据：
  - I-79 原文：“它的用例在 `scripts/delivery-mode/test_make_packet.py`，这个文件目前不在 `npm run check` 里。”
  - `package.json:42`：`"check:delivery-packet": "python3 -I scripts/delivery-mode/test_make_packet.py"`
  - `package.json:27` 的 `check:steps` 末尾已经包含 `npm run check:delivery-packet && npm run check:check-runner`。
- 问题：这是本次合并（main 的 PR #269）直接造成的状态变化。作者把合并说成“只保留了两边的步骤”，但同一 PR 早前写下的 I-79 因此变成错误描述，会让人误判 I-79 的 `package.json` 恢复检查没有自动门槛。
- 建议：把 I-79 的这句改成“合并 main 后该测试已由 `npm run check:delivery-packet` 在 `npm run check` 中运行”，或明确写出新增的命令 `npm run check:delivery-packet`。

### 2. 低｜PR 检查比它声称模仿的 Python 检查更严：块外条目 Python 会采用，JS 会判失败

- 位置：`scripts/check-probe-sources.mjs:99`；`scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98-100`；`test/tooling/probe-sources.test.mjs:112`
- 读到的证据：
  - Python：`originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))`，随后只有 `if not originals: …PROBE_ORIGINALS_NOT_FOUND`，并不要求条目位于 `const originals` 块内；块外条目一样会进入 `originals` 并在 Hermes 上参与构建指纹核对。
  - JS：`...parsed.outside.map((name) => \`PROBE_BOOTSTRAP_ENTRY_OUTSIDE_ORIGINALS ${name}\`)`，块外条目直接作为失败项。
  - 测试名：“reads entries outside the originals block the way the packet check does”。
- 问题：两端的“接受范围”不一致。一个 Python 包检查能接受（块外条目对应文件确实在 dist 里且摘要一致）的 bootstrap，会被 PR 检查拒绝。方向上这是“多报”而不是“漏报”，不会放过过期指纹；但测试名和“模仿”说法不准确。
- 建议：要么在文档/测试名里写明“块外条目一律拒绝（比包检查更严）”，要么让两端采用同一规则（例如 Python 也只认块内条目）。如果 D1 就是要有意更严，请在提交说明或 I-78 里记下这个额外约束。

### 3. 低｜块定位要求整行精确匹配，重排模板会误报“找不到摘要”

- 位置：`scripts/check-probe-sources.mjs:56-57,94`
- 读到的证据：
  - `const start = lines.indexOf("const originals = {");`
  - `const end = start === -1 ? -1 : lines.indexOf("};", start + 1);`
  - `if (!parsed || parsed.entries.length + parsed.malformed.length === 0) return [\`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND ${BOOTSTRAP}\`];`
- 问题：只要 `const originals = {` 或行首 `};` 的写法变了（改名、行尾空格、缩进、换成 `const originals={`），JS 就从 `null` 直接报“摘要不存在”；而 Python 的 `re.findall` 完全不依赖块名，仍能读到条目。这会造成合法的模板整理被 PR 检查挡下。当前模板正好是这两行，所以现在不触发。
- 建议：块定位改用正则（允许空白差异）或干脆去掉“必须有块”的额外要求；若坚持要求块存在，至少加一条注释/用例说明这是有意的更严限制。

### 4. 低｜覆盖缺口：缺失文件分支、`sourceSha256` 非字符串没有用例

- 位置：`scripts/check-probe-sources.mjs:78-79,89-90`；`test/tooling/probe-sources.test.mjs:236`
- 读到的证据：
  - `if (recordFile.missing) return [\`PROBE_SOURCES_RECORD_MISSING …\`];`
  - `if (bootstrapFile.missing) return [\`PROBE_BOOTSTRAP_MISSING …\`];`
  - 数组用例只覆盖了 `builtSha256: [BUILT]`，没有 `sourceSha256` 非字符串。
- 问题：作者已把“缺失文件分支的用例”列为不做，属于已知缺口；`sourceSha256` 的类型检查没有独立反向用例（虽然代码是对称的）。这些分支一旦写错不会被测试发现。
- 建议：至少补 `sourceSha256` 数组一个用例；缺失文件分支可以低成本补两个临时目录用例。

## 三、侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆操作 / 文档一致性）

- **不可信记录输入**：`recordProblems` 对 `built` 用 `BUILT_NAME=/^[a-z-]+\.js$/`，对 `source` 要求严格等于 `packages/runtime-sandbox/src/<built>.ts`，`bootstrap` 要求等于常量，`files` 非空且元素逐字段校验。路径穿越（`..`、绝对路径、反斜杠、子目录）都有反向用例（`test/tooling/probe-sources.test.mjs:198-217`），我核对代码路径与用例一致。结论：路径注入面已被封住。
- **非字符串摘要**：本轮加了 `typeof`，数组会被判 `RECORD_INVALID`。注意即使没有 `typeof`，`recorded.get(...) !== file.builtSha256` 的严格不等也会让数组最终报 `BUILT_DIGEST_MISMATCH`，所以这更多是错误码准确性而非漏检。结论：不会漏。
- **文件类型/符号链接**：`readPlainFile` 先 `existsSync`，再 `lstatSync(...).isFile()`；目录、FIFO、设备、**终态**符号链接都会走 `unreadable`，不会卡在读 FIFO 上。中间目录是符号链接时会被跟随（`lstat` 不跟随中间路径），作者已列为“已知不做”。结论：终态不可信类型安全；中间目录符号链接是低风险已知缺口。
- **TOCTOU**：`existsSync`→`lstatSync`→`readFileSync` 之间文件可被替换；这是仓库内自检脚本，不是对外服务，风险低。
- **资源耗尽 / ReDoS**：`(?<=^|\n)\s+…` 没有嵌套量词，回溯有界；每个匹配用 `normalized.slice(0,nameAt).split("\n")` 是 O(n)，条目极多时是 O(n²)，但文件受仓库控制，实际只有 3 条。结论：不构成实际风险。
- **不可逆操作**：本改动只读文件、只打印；`check:delivery-packet` 跑 `test_make_packet.py`，我读到的测试都在 `tempfile`/`mkdtemp` 下建 git 仓库和渲染目录，没有看到读取之外的仓库写操作。结论：没有新增不可逆操作。
- **文档/规则一致性**：发现 I-79 的“这个文件目前不在 `npm run check` 里”与合并后的 `package.json` 冲突，见问题 1；其余 I-78 描述（`npm run check:probe-sources` 是 `npm run check` 的一步、记录字段、三个错误码）与代码一致。

## 四、必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。`058293d1..3e600f6b` 里没有任何组装系统提示、工具定义、历史、资料块或出口遮盖的代码；新增的是仓库自检脚本、测试、`probe-sources.json`、`package.json` 检查步骤和文档。`measurement/probe/bootstrap.mjs` 在本区间**没有改动**（不在 diff 里）。因此发给模型的内容仍只在末尾追加，本改动没有把每轮会变的值塞进请求头。依据：`.claude/rules/prompt-prefix.md:27-29,35`；本区间 diff 的文件清单。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。本改动不涉及请求序列化；检查脚本本身没有时间戳、随机数、哈希盐或依赖上下文的遮盖，`Map`/`Set` 的遍历顺序是插入顺序（`recorded.keys()` 按扫描顺序），输出确定。`probe-sources.json`/`bootstrap.mjs` 里只有固定 SHA-256。依据：`scripts/check-probe-sources.mjs:61-70,101-105`。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   有：`check:probe-sources` 同时跑 CLI 和 `test/tooling/probe-sources.test.mjs`（34 例），`check:check-runner` 跑 `test/tooling/run-all-checks.test.mjs`（5 例，其中含三条新增步骤的 `toContain`）。本轮两个关键反向用例按旧脚本确实会失败：空行后无缩进条目旧逐行正则匹配不到；摘要数组旧代码不会落到 `RECORD_INVALID`。但两点未核实：最终提交上完整的 `npm run check` 没有跑完（作者说两个无关步骤超时）；我无法执行 vitest 亲自确认 39 例通过。缺失文件分支和 `sourceSha256` 非字符串仍是覆盖缺口（作者已承认前者）。

4. **改动产生/修改的每个值，生产方和使用方两端都能接受吗？**
   - `check:steps` 的三个新键：生产方是 `package.json`；使用方是 `scripts/run-all-checks.mjs` 的 `stepNames`（要求每段严格是 `npm run <name>`，已满足）和 `run-all-checks.test.mjs` 的 `toContain`/脚本存在断言。两端接受。
   - `probe-sources.json` 的 `built`/`builtSha256`/`source`/`sourceSha256`/`bootstrap`：生产方是人工维护的记录；使用方是 `recordProblems`/`probeSourceProblems`（严格校验）和 `bootstrap.mjs` 的 `originals`（摘要逐个比对）。我比对了两文件里的三个名字和三个摘要，完全一致；`source` 对应的三个 `.ts` 文件也都存在。
   - `INTENDED_CHANGES` 新增的 `measurement/probe/bootstrap.mjs`：使用方是 `test_twelfth_parameters_rebuild_the_frozen_twelfth_packet_except_intended_changes`；我确认该路径在 `twelfth-frozen-sha256.json:109` 中存在且不在 `ADDED_FILES` 里，结构上两端接受（“是否真的与冻结版不同”需运行才能确认）。
   - 新错误码（`PROBE_BOOTSTRAP_ENTRY_OUTSIDE_ORIGINALS`、`PROBE_BOOTSTRAP_DUPLICATE_NAME` 等）：只在 `scripts/check-probe-sources.mjs` 产生、在其测试里消费，仓库中没有别的使用方。`SOURCE_TREE_EMPTY` 由 `run-release-walkthrough.sh:23` 产生，由 `test_make_packet.py:792` 与 I-79 消费，一致。

**推测/未核实**：我无法计算 SHA-256，因而“`probe-sources.json` 记录与当前三个源码文件逐字节一致”只按“作者说 39 例通过 + `test/tooling/probe-sources.test.mjs` 里确有 `passes on the repository as committed`”判断；JS 与 Python 的 `\s` 在 `\u0085`、`\x1c-\x1f`、`\uFEFF` 上的字符集差异属于理论边角，当前 ASCII bootstrap 不受影响，但未实测。
