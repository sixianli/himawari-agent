## 侧重检查（错误路径、不合规/不可信输入、安全、资源耗尽、不可撤销、文档与代码一致性）

- **不可信/异常输入**：`mainRef` 只经 `parseArgs` 拒绝以 `-` 开头和控制字符（`opencode-review.mjs:2645-2648`），随后都以参数数组交给 git，不是拼 shell，未见命令注入。`--binary`/`--no-textconv`/`--no-ext-diff` 是脚本自己的 git 调用，不走复核模型那个禁用 `--binary` 的替身（替身只加在 opencode 子进程 PATH，`installGitGuard`/`opencodeChildEnv`），不冲突。
- **错误路径**：`ownChangePrints` 在 merge-base 失败、`--name-only` 失败、单个文件 diff 失败/为空时返回 null，`unreviewedFiles` 退回 `outside`（`opencode-review.mjs:1269-1311`）。这是“保守多报”，方向安全，但会把 main 带进来的文件也算未复核。
- **资源耗尽**：每个改动文件起一次 `git diff`，`unreviewedFiles` 调两次，merge gate 对每个 low-fix 点、每条 override 候选、以及 `--accept-low` 还会再调；单次 `maxBuffer` 是 256MiB（`:1251`）。大 PR/大文件会慢，`ENOBUFS` 时会整体退回全量比较。
- **不可撤销操作**：本改动没有新增。
- **文档/代码一致性**：第 6 步文字把 `--binary` 合成进指纹、并声明“二进制内容都参与比较”，但非 UTF-8 的“文本”内容会被有损解码（见下）；另外文档只写两种退回条件，代码有四种。
- **未核实**：第 1 轮判断（`round-1/judgments.md`）和材料被 git 以 `records-path` 拒绝、且不在 sparse checkout 里，未能读取；以下只看代码与增量。

## 问题（高→低）

### 1. 严重度：中
**文件:行**：`scripts/model-review/opencode-review.mjs:1250-1252、1278、1295-1299`（影响 `unreviewedFiles` 及 `lowFixProblems` 的 `ownFiles`）

**问题**：指纹是对 `git diff` 的 **UTF-8 解码后的字符串**求 SHA-256。含非法 UTF-8 字节、但不含 NUL 的文件，git 仍按“文本”处理，`--binary` 不会给它出 base85 补丁；不同原始字节（例如 `0xFF` 和 `0x80`）解码后都变成 U+FFFD，过滤 `@@`/`index` 后得到的字符串可能逐字节相同，SHA-256 相同，于是**复核后改的字节可能被判成“跟复核时一样”**——这是漏报（false pass），能绕过合并门。作者对**文件名**做了 `U+FFFD` 退回（`:1278`），却没有对**文件内容**做同样处理。

**证据（读代码证实）**：
```js
// 1250-1252
function gitStatus(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}
// 1278
if (file.includes("\uFFFD")) return null;
// 1295-1299
const stable = diff.stdout
  .split("\n")
  .filter((line) => !line.startsWith("@@ ") && !line.startsWith("index "))
  .join("\n");
prints.set(file, createHash("sha256").update(stable).digest("hex"));
```
`diff.stdout` 是字符串，哈希的是字符串重新编码的 UTF-8；原始非法字节已在此前丢失。这个漏报也会让 `lowFixProblems` 的 `ownFiles`（`:1149`、`:1153`）漏掉该文件，从而少算文件数/行数。

**推测（未实测）**：触发需要“无 NUL 且非法 UTF-8”的文本文件（如 GBK/Latin-1 源码、部分无 NUL 的二进制格式）；正常 UTF-8 或含 NUL 的二进制文件不受影响。按规则“能绕过合并前检查”属于中/高，我按触发条件不常见暂定中。

**建议**：用 `encoding: "buffer"`（或 `stdio` 拿 Buffer）对**原始字节**做过滤与哈希；过滤 `@@ `/`index ` 时也按字节匹配。若不改，至少在内容解码出现 U+FFFD 时返回 null 退回全量比较（与文件名一致）。更好的做法是：同时用 `git rev-parse <commit>:<path>` 得到新侧 blob OID 与 mode 做二次校验，diff 指纹只用于“同一文件里只属于 PR 的那部分”。

### 2. 严重度：低
**文件:行**：`scripts/model-review/opencode-review.mjs:1283-1299`

**问题**：`--binary` 的补丁体可能是 `delta`（相对旧 blob）而非 `literal`，同一新内容对不同基线可能编码成不同字节。若某种合并让同一二进制文件两侧都有改动却仍干净（自定义 merge driver、或冲突解决后选回 PR 版本），reviewed/current 指纹会不一致，产生**误报**；不会造成漏报（改内容必然改变 delta/literal 的可复原数据）。

**证据（读代码证实）**：命令带 `--binary` 且去掉 `index`，其余保留：`:1283-1298`。
**推测（未实测）**：普通 git 对“同一二进制文件两侧都改”默认冲突，因此正常干净合并不触发；影响主要在冲突解决/自定义驱动。建议指纹改用新侧 blob OID + mode（基线无关），或至少补一条“main 也改同一二进制文件”的用例说明预期。

### 3. 严重度：低
**文件:行**：`.agents/instructions/model-review.md:44`、`:37`

**问题**：规则文字声称“二进制内容都参与比较”，但如上，无 NUL 的非法 UTF-8 文本不参与真实字节比较；文字只列“算不出合并基线、文件名含无效 UTF-8”两种退回条件，代码还有 `diff.status !== 0` 和 `diff.stdout === ""`（`:1294`）。这属于说明与代码不完全一致。

**建议**：补上“内容解码出现替换字符时也退回”，并把“二进制内容”限定为“含 NUL 的文件”。

### 4. 严重度：低
**文件:行**：`test/tooling/opencode-review.test.mjs:2819-2850、3198-3233`

**问题**：新增用例覆盖了空白、权限、二进制、`--accept-low` 夹 main、旧口径记录，但没有覆盖代码声称的退回路径（文件名含 U+FFFD、单文件 diff 为空、merge-base 失败），也没有用例能抓住上面的“非法 UTF-8 内容”漏报；submodule、符号链接也未见测试。

**证据（读代码证实）**：新增测试只有上述几类；`ownChangePrints` 的 `return null` 分支（`:1271、1274、1278、1294`）没有对应断言。反向用例本身是有效的（例如空白/二进制用例在旧 `patch-id` 实现下会得到相同指纹而失败）。

**建议**：补 1) 非法 UTF-8 文本在复核后被改、必须报 `unreviewed`；2) 名称含 U+FFFD 时退回全量比较；3) submodule/符号链接变更；4) 单文件 diff 为空的分支。

### 5. 严重度：低
**文件:行**：`scripts/model-review/opencode-review.mjs:1269-1302、1304-1312`

**问题**：`unreviewedFiles` 对每个文件起一个 git 进程，且被 merge gate、每个 low-fix 点、每条 override 候选、`--accept-low` 反复调用；大 PR 或大文件下慢，`ENOBUFS` 时退回 `outside`，会把 main-only 文件也报成未复核（误报）。

**建议**：一次 `git diff base commit -- <所有文件>` 批量取指纹并缓存（按 commit 缓存），或至少在退回时对 `outside` 再做一次 main-only 过滤。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？不会。**
模型可见的规则只有 `reviewQuestions` 从 `model-review.md` 的 `<a id="checklist">` 起的清单（`opencode-review.mjs:220-231`）；本次改的是第 3/6 步和交接段（`model-review.md:34-37、44、130+`），都不在清单区间（`:49-55`），所以复核提示词不变。指纹、`files`、`unreviewed` 等只在本地合并门里用，不写进 prompt/brief；没有新增“每轮会变”的值进入系统提示或历史，输出仍是追加。**未核实**：我读不到第 1 轮记录，无法确认之前是否有相关约定。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会新增这种问题：指纹对固定仓库状态是确定的，`unreviewedFiles` 结果还做了 `.sort()`；没有时间字段、随机数或无序集合进入模型可见内容。但存在反向问题——**不同的原始字节可能被算成同一指纹**（上面问题 1），这是字节保真丢失，不是“同一文字变不同字节”。

**3. 有没有自动检查，反向用例是否真会失败？** 有，且空白/二进制/low-fix-main 的反向用例在旧实现下会失败（旧 `patch-id` 忽略空白、对二进制只看到固定的“Binary files … differ”、旧 `lowFixProblems` 计入 main 文件）。但退回分支（U+FFFD 文件名、空 diff、merge-base 失败）和非 UTF-8 内容漏报**没有用例**，所以“退回全量比较”这条说法没有被测试证明。

**4. 产出的每个值，使用方都能接受吗？** `files` 的生产者是 `lowFixProblems`（`:1149/1175`），写入账本（`:1445`），`parseUsage` 只校验“非空字符串数组”（`:1615-1625`），随后 `coveragePoints`（`:1214`）→ `lowFixCheck` 用 `sameList` 精确比较并两侧都 `maskSecretLike`（`:1332-1341`），旧记录走 legacy 兜底；`reviewReport` 直接打印 `record.files`（`:1521/1527`），不校验存在性。两端口径一致，未发现放行错误；legacy 兜底确实可能让 `files` 里带上 main 带进来的文件（测试 `:3212-3233` 有意为之），这只会让报告/PR 描述高估低修范围，不会绕过 `from..to` 的范围校验和规模校验。唯一实质性缺口仍是问题 1：非法 UTF-8 内容会在生产端被漏掉，使用端自然也无从校验。
