# PR 321 第 3 轮增量复核

复核范围：`git diff c93d8de5..4f44143c`（增量）并对照 `6cb8405b..4f44143c`（整 PR）。仓库为 sparse checkout，第 1、2 轮材料（`.agents/reviews/pr-321/round-{1,2}/*`）未在工作区，`git show` 读取记录路径被策略拒绝，**这两轮材料未核实**；以下结论均来自代码与测试文件。

## 读代码证实的发现（按严重度）

### 1）低：资源占用被放大，且大文件会退回全量比较
文件:行：`scripts/model-review/opencode-review.mjs:1279-1301`（调用点 `:1149`、`:1372`、`:1405`）

问题：`ownChangePrints` 对**每个文件**单独跑一次 `git diff --binary`，`maxBuffer` 为 `1 << 28`（256MB）；拿到 Buffer 后又 `toString("latin1")` → `split("\n")` → `filter` → `join("\n")` → `Buffer.from(...)`，同一份数据在内存里复制多份。`unreviewedFiles` 还会在 override 记录的 `.find`（`:1405`）和每个 low-fix 点（`:1325`）里重复调用，最坏是「记录数 × 文件数」次子进程。文件超过 256MB 时 `status !== 0` 直接 `return null`，整体退回 `changedOutside`，把 main 带进来的文件也报 `unreviewed`，**干净的 main 合并会被误挡**。

证据：
```js
1279:    const diff = spawnSync(
...
1293:      { cwd: repo, maxBuffer: 1 << 28 },
...
1295:    if (diff.status !== 0 || diff.stdout.length === 0) return null;
1296:    const stable = diff.stdout
1297:      .toString("latin1")
1298:      .split("\n")
...
1301:    prints.set(file, createHash("sha256").update(Buffer.from(stable, "latin1")).digest("hex"));
```
建议：只对 `outside`（`from..to` 真正变化过的文件）计算指纹；按字节扫描 Buffer 过滤行，避免 `latin1` 字符串和多次拷贝；必要时用 `spawn` 流式喂给哈希、并对单个文件设更小上限。

### 2）低：`unreviewedFiles` 丢弃了 `outside`，保留「main 已先含相同改动时多报一次」
文件:行：`scripts/model-review/opencode-review.mjs:1306-1314`

问题：`outside` 只用于提前返回，真正参与判断的是两侧 `ownChangePrints` 的全集并集。若 PR 在复审后又改过某文件、而 main 恰好也加入了**相同内容**（`from` 与 `to` 里该文件内容相同、不在 `outside`），两侧指纹会出现「一侧有、一侧无」而被报 `unreviewed`。规则 `model-review.md:44` 已把它写成已知盲区，但这与本 PR「干净合入 main 不用再复核」的目标相冲突，且是全量计算的主要原因。

证据：
```js
1307:  const outside = changedOutside(repo, from, to, ledgerPath);
1308:  if (!mainRef || outside.length === 0) return outside;
...
1312:  const files = new Set([...reviewed.keys(), ...current.keys()]);
1313:  return [...files].filter((file) => reviewed.get(file) !== current.get(file)).sort();
```
建议：只对 `outside` 中的文件比较两侧指纹（未出现在 `name-only` 里即视为「该侧无此改动」）。这样既省掉大部分子进程，也能消掉上面的误报；同步删改规则里的「多报一次」说明。

### 3）低：规则承诺的两条退回路径没有自动检查
文件:行：`.agents/instructions/model-review.md:44`；`scripts/model-review/opencode-review.mjs:1278`、`:1295`；测试 `test/tooling/opencode-review.test.mjs:2852-2864`

问题：规则写明「某个文件的 diff 失败或为空、文件名含无效 UTF-8 时退回比较两个提交的全部文件差异」。代码确有 `file.includes("\uFFFD")` 与 `stdout.length === 0` 两个 `return null` 分支，但本次增量只加了「非法 UTF-8 **内容**」一条测试（`:2852`），`\uFFFD` **文件名**和**空 diff** 的退回路径没有任何用例。问句 3 要求的「反向用例真的会失败」只对内容字节这一条成立。

证据：
```js
1278:    if (file.includes("\uFFFD")) return null;
...
1295:    if (diff.status !== 0 || diff.stdout.length === 0) return null;
```
```js
2852:  it("[merge gate] a change between two invalid UTF-8 byte values is unreviewed", () => {
2853:    const f = fixture(lines(), Buffer.from([0x61, 0xff, 0x0a]));
...
2859:      f.commit({ "code.txt": Buffer.from([0x61, 0x80, 0x0a]) }, "other invalid byte");
```
建议：补「无效 UTF-8 文件名触发退回」和「构造空 diff/失败让 `ownChangePrints` 返回 null」的用例，断言退回后 main 带入的文件会被保守地列为 `unreviewed`。

### 4）低：`\uFFFD` 判定过宽，且行首过滤依赖 diff 格式约定
文件:行：`scripts/model-review/opencode-review.mjs:1278`、`:1296-1300`

问题一：U+FFFD 本身是合法文件名字符（UTF-8 字节 `EF BF BD`）。合法文件名只要含这个字符就会让整个比较退回全量，产生不必要的误报。应改为「原始字节按 UTF-8 解码再编码后是否等长/相等」来判定真正的非法 UTF-8。

问题二：过滤 `@@ ` / `index ` 依赖 diff 的输出约定。标准 diff 里内容行一定带 `+`/`-`/空格前缀、二进制 base85 数据行以长度字母开头，所以不会误伤；但 `-U0` 之外若仓库/用户配置了 `diff.interHunkContext`（命令 `--inter-hunk-context`）就会把「上下文行」也纳入哈希，与规则「上下文不参与」不符，邻近行被 main 改动时可能误报。此为环境相关行为，见下「推测」。

证据：
```js
1278:    if (file.includes("\uFFFD")) return null;
...
1296:    const stable = diff.stdout
1297:      .toString("latin1")
1298:      .split("\n")
1299:      .filter((line) => !line.startsWith("@@ ") && !line.startsWith("index "))
```
建议：加 `--inter-hunk-context=0`（并考虑显式 `-c diff.algorithm` 固定）；用字节往返判定非法文件名。

### 5）低/观察：合并 main 不再扫描其他 PR 记录目录里「纯 main 带入」的文件
文件:行：`scripts/model-review/opencode-review.mjs:1375`、`:2562-2570`

`recordSecretProblems({ otherFiles: outsideFiles })` 的 `outsideFiles` 现在来自 `unreviewedFiles`，纯 main 带入的其他 PR 记录不再进 `otherFiles`。这与新规则「只是合入 main 带进来的文件不算改动」一致，本 PR 自己目录仍由 `git ls-tree HEAD -- ledgerPath` 全量扫描；属于行为变化，需知悉：这类内容的密钥检测改由 main 的 gitleaks/CI 负责。

## 推测（未在本仓库核实）

- Git base85 数据行首字符一定是长度字母（`A-Z`/`a-z`），字母表不含空格，因此 `index ` 不可能出现在二进制补丁数据行；这一点来自 git 源码的常识，本仓库内未核实。
- `diff.interHunkContext`、`diff.algorithm`、git 版本（二进制补丁压缩）会改变 diff 字节；两侧在同一进程/配置下计算，判断本身稳定，但跨机器用不同 git 版本重核旧 low-fix 记录时，理论上可能出现 `files-differ`。`--no-ext-diff`/`--no-textconv` 已挡住外部 diff/textconv，这一点读代码可确认。
- latin1 往返：`Buffer.toString("latin1")` 把 0x00–0xFF 一一映射到 U+0000–U+00FF，`Buffer.from(s,"latin1")` 逆映射；`split("\n")`/`join("\n")` 是恒等变换（含 `\r`、末尾换行、空行），因此**作者所说「无损」成立**，新增测试也确实只在旧 utf8 实现下会失败（旧实现把 `0xff`、`0x80` 都折成 U+FFFD，两版本指纹相同）。

## 侧重检查

- 错误路径：`merge-base` 失败、`--name-only` 失败、`stdout` 为空、文件名含 U+FFFD 都 `return null`，最终退回 `changedOutside`（`1307-1311`），是**保守**方向（多报 `unreviewed`，不会漏报），安全。
- 不合规范/不可信输入：文件名统一用 `:(literal)` 转义，防止 pathspec magic；`--no-ext-diff`、`--no-textconv` 防止执行仓库配置的外部 diff/textconv；`spawnSync` 用 argv 数组，无 shell 注入面。`mainRef` 仍原样传给 `merge-base`（未校验、可被 `-` 开头的参数影响语义），属既有问题，不构成 RCE。
- 安全：过滤 `@@ `/`index ` 不会误伤标准 diff 的内容行；但本检查按规则「防手误不防有意」，无法阻止「整段改动原序搬家」等刻意规避，规则已写明。
- 资源耗尽：见发现 1，是本轮最值得改的点（子进程数与 `--binary` 体积/内存放大），但结果只会导致阻塞或失败，不会误报 `REVIEW_CURRENT`。
- 不可撤销操作：本轮没有新增删除/覆盖；`appendFileSync` 写账本只在成功路径，且新记录的 `files` 为 own-only，旧记录由 legacy 分支兼容（`1335-1343`），不会写坏已有记录。
- 规则与代码一致性：`model-review.md:44` 的「原始字节、去 `@@`/`index`、退回条件、low-fix 判法同第 6 步」与 `lowFixProblems`/`ownChangePrints`/`unreviewedFiles` 一致；`model-review.md:37` 的「行数按两个提交之间全部差异算，偏多不偏少」与 `lowFixProblems` 用 `from..to` 全量 numstat、只按 `ownFiles` 过滤文件名一致。唯一文字偏差是「上下文不参与」未防 `diff.interHunkContext`（发现 4）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本轮改动只在合并门的本地计算路径（`ownChangePrints`/`unreviewedFiles` 仅被 `lowFixProblems:1149`、`assertReviewed:1372/1405` 使用），没有改系统提示、工具定义、历史消息、遮盖；也没有改 `delegate.mjs`/prompt 组装。发给模型的内容仍只在末尾追加，每轮变化值仍在最后一条消息——本 PR 不触碰请求组装，结论为「无影响」而非「已验证追加」。
2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求：不会，本轮不产生模型可见文本。对本地指纹：latin1 往返无损、`split/join` 恒等，同一 git 输出每次哈希相同；但指纹取决于 `git diff` 输出，跨不同 git 配置/版本可能不同（两侧同一次调用内相减，判断稳定；旧 low-fix 记录跨环境重核存在理论风险，见「推测」）。
3. **有没有自动检查、反向用例真的会失败？** 有 `test/tooling/opencode-review.test.mjs:2852`，按代码推断在父提交 c93d8de5（utf8 解码）上会返回 `[]` 而失败，修复后通过；但规则承诺的「空 diff / 无效 UTF-8 文件名退回」**没有**反向用例（发现 3）。
4. **每个产生/修改的值，使用端都能接受吗？**
   - `ownChangePrints` 的哈希：仅内部使用，无外部校验。
   - `unreviewedFiles` 返回的文件名：`assertReviewed` 用 `printable`（`:1373`）、`recordSecretProblems` 用 `git show HEAD:<file>`（`:2551/2568`）；`lowFixProblems` 用 `ownFiles.has(match[3])`（`:1153`）与 numstat 文件名比较，两侧都来自同一套 utf8 解码的 git 路径，合法 UTF-8 时一致，非法时整体退回。
   - `lowFixProblems.files` 写入账本（`:1447`）后由 `parseUsage` 校验为「非空字符串数组」（`:1617-1627`），own-only 文件名满足；报告端 `printable`（`:1523/1529`）可用。
   - legacy 分支（`:1335-1343`）接受旧口径（含 main-only 文件）的记录，测试 `:3226-3247` 证明合法旧记录通过、伪造的 `bogus.txt` 被 `files-differ` 拒绝。
   结论：新增值都能通过下游校验；主要风险是「多报」而非「漏报」，且 legacy 兼容有测试。
