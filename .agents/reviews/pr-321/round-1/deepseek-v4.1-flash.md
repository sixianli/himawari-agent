# 复核结论（PR 321，fe9eb82 对比 6cb8405）

## 读代码证实的问题（按严重度）

### 1. 中：`git patch-id --stable` 忽略空白，且行内移动/重排也会得到同一指纹——会出现漏报
- 文件：`scripts/model-review/opencode-review.mjs:1283`（以及 `:1289`）
- 问题：指纹用 `git patch-id --stable` 计算。patch-id 本身忽略行号、上下文和空白（git 另有 `--verbatim` 才保留空白，代码没加）。因此复核后如果只改了空白（例如 Python/YAML 缩进、Makefile 的 tab/空格）、或把 PR 新增/修改的那几行在同一个文件里挪到别处，指纹不变，会被判成“未变”。
- 证据：
  ```js
  const id = spawnSync("git", ["patch-id", "--stable"], { ... input: diff.stdout ... });
  const fingerprint = id.status === 0 ? id.stdout.split(/\s/)[0] : "";
  ```
  ```js
  // diff -U0，hunk 头里的行号被 patch-id 丢掉
  ["diff", "-U0", "--no-renames", baseCommit, commit, "--", `:(literal)${file}`],
  ```
  规则文字只写了“行号和上下文不参与”（`.agents/instructions/model-review.md:44`），没有写空白也不参与。
- 建议：若要保留空白差异，加 `--verbatim`（需确认部署的 git 版本支持）；若还要发现“行被挪走”，`--verbatim` 也不够（行号仍被忽略）。更稳的做法是自己把每文件的 diff 规范化后哈希：去掉 `@@ ... @@` 的数值、保留 `+`/`-` 行原文（含空白）；如果必须发现移动，则要保留少量上下文并明确会因 main 改动上下文而多报。至少应把这个已知盲区写进规则，并补一条反向用例（空白/移动必须 `unreviewed`）。

### 2. 中：文件权限位（mode）改动在“文件同时有内容改动”时不会被发现
- 文件：`scripts/model-review/opencode-review.mjs:1278-1294`
- 问题：`git diff -U0` 的 `old mode`/`new mode` 行不在 hunk 内，`patch-id` 只哈希 hunk 内容；只有 patch-id 为空（纯 mode 改动）时才退到 `tree:`，而 `tree:` 用的是 `ls-tree`（含 mode）。所以“PR 已有内容改动 + 复核后把该文件 chmod +x”这种组合指纹不变。反过来，纯 mode 改动能靠 `tree:` 发现。
- 证据：
  ```js
  const fingerprint = id.status === 0 ? id.stdout.split(/\s/)[0] : "";
  prints.set(file, fingerprint ||
    `tree:${gitStatus(["ls-tree", commit, "--", `:(literal)${file}`], repo).stdout.trim()}`,
  );
  ```
- 建议：无论 patch-id 是否为空，都把 `git diff --summary --no-renames base commit -- file` 里的 mode 变化（或直接比较两端 `ls-tree` 的 mode 字段）并入指纹；补 mode-only 与“内容+mode”两条测试。

### 3. 中：`--accept-low` 的规模核对用指纹判断“改没改”，可能漏算，从而绕过文件数/行数上限
- 文件：`scripts/model-review/opencode-review.mjs:1149-1155`
- 问题：`lowFixProblems` 先拿 `unreviewedFiles` 过滤 `git diff --numstat from..to`。如果低严重度修改是“把一段代码挪个位置/只改空白”，指纹与复核点相同，该文件会被 `continue` 掉，不计入 `too-many-files`/`too-many-lines`；只要另有一个真实的测试文件改动满足 `no-test-change`，一个实际很大的移动就可能被 `--accept-low` 接受。另外，对于 main 和低严重度修改都碰过的同一个文件，`numstat` 的行数仍包含 main 带进来的行，可能反过来造成 `too-many-lines` 误拒。
- 证据：
  ```js
  const ownFiles = mainRef ? new Set(unreviewedFiles(repo, from, to, ledgerPath, mainRef)) : null;
  ...
  if (ownFiles && !ownFiles.has(match[3])) continue;
  const lines = match[1] === "-" ? Infinity : Number(match[1]) + Number(match[2]);
  ```
- 建议：规模核对不要复用“指纹是否相同”作为“这个文件改了没”的判据。可以按 `changedOutside(from,to)` 列表逐个文件用 `numstat`，只排除“整文件差异都来自 main”的情况（例如该文件在 `from` 相对旧基线无 PR 改动、在 `to` 相对新 main 也无 PR 改动）；同时把行数按 PR 自己那一段计算，或至少在文档里说明行数包含合并进来的 main 行。

### 4. 中：旧账本里的 `low-fix` 记录可能被重新判成 `files-differ`
- 文件：`scripts/model-review/opencode-review.mjs:1407-1414`、`:1327-1328`、`:1119-1175`
- 问题：旧版 `lowFixProblems` 的 `files` 是 `from..to` 全部改动文件（含合并 main 带进来的文件）。现在重算时用 `unreviewedFiles` 把 main-only 文件过滤掉，旧的 `low-fix` 记录 `files` 会比新口径多，`sameList` 不等，直接报 `low-fix-invalid round=… files-differ`，进而 `chain-broken`，使 `--report`/`--assert-reviewed` 对历史 PR 失败。
- 证据：
  ```js
  const ownFiles = mainRef ? new Set(unreviewedFiles(repo, from, to, ledgerPath, mainRef)) : null;
  ...
  if (check.problems.length === 0 && !sameList(point.files, check.files.map(maskSecretLike)))
    problems.push("files-differ");
  ```
- 建议：过渡期接受旧口径的“超集”（即 `point.files` 包含重算结果且多出来的都是 main-only 文件时也放行），或在规则和 PR 描述里明确“旧 `low-fix` 记录会失效、需要重核”；补一条“旧口径记录 + 合入 main”的回归测试。

### 5. 低：`unreviewedFiles` 的返回值不是 `changedOutside` 的子集，可能报出 `from..to` 根本没差异的文件；文档说“合并 main 随时可以做”不成立
- 文件：`scripts/model-review/opencode-review.mjs:1299-1307`；文档 `.agents/instructions/model-review.md:44`、`:133`
- 问题：`outside` 只用于空列表早退；最终结果来自 `ownChangePrints(from)`/`ownChangePrints(to)` 的并集，所以当 PR 的某个改动被 main 以相同内容“吞掉”、且 PR 还有别的文件确实有差异时，那个文件 `from..to` 无差异却会被报 `unreviewed`。这是保守的（不是漏报），但与“只是合入 main 不用复核”的绝对说法冲突；交接文档 `:133` 写“合并 main 随时可以做，不会让已复核的结果失效”也过度承诺（重命名、main 已含相同改动等干净合并都会多报）。
- 证据：
  ```js
  const outside = changedOutside(repo, from, to, ledgerPath);
  if (!mainRef || outside.length === 0) return outside;
  ...
  const files = new Set([...reviewed.keys(), ...current.keys()]);
  return [...files].filter((file) => reviewed.get(file) !== current.get(file)).sort();
  ```
- 建议：明确这里是“按累计 PR 指纹比较”，不是“from..to 差异”；若不想误报被 main 吸收的改动，可以只在 `outside` 里判定（或对 `!outside.has(f) && reviewed.has(f) && !current.has(f)` 视为已吸收跳过），但要在注释里说明这会放过“合并时手工把 main 删掉的内容又加回来、且最终树与复核点相同”的情况；同时修正文档措辞并补测试。

### 6. 低：反向测试覆盖不足，且一处测试标题已与断言矛盾
- 文件：`test/tooling/opencode-review.test.mjs:2790-2830`、`:2746`
- 问题：新增了 3 条用例（干净合并通过、手动改/合并后改动失败、冲突解决失败），这两条“应该失败”的用例在实现被放松时确实会红。但完全没有覆盖：指纹为空的 `tree:` 退路、二进制、权限位、普通重命名、删除、行内移动/空白、被 main 吞掉的相同改动、旧 `low-fix` 账本，以及“合入 main 后跑 `--accept-low`”。另外 `:2746` 的用例标题仍是 `"[merge gate] fails on any other change after the review, including a merge of main"`，但新断言已经把 merge of main 视为通过，标题与行为相反。
- 建议：按上面各条补反向用例（最好能先红后绿），并把标题改成“main 之外的改动才失败”。同时确认这些 tooling 测试确实在 `npm run check`/CI 中运行（本次未核实）。

### 7. 低：资源和可重复性——子进程数量随文件数和覆盖记录数线性增长
- 文件：`scripts/model-review/opencode-review.mjs:1269-1297`、`:1389`
- 问题：`ownChangePrints` 对每个文件跑 `diff --name-only`（一次）+ 每文件一次 `diff -U0` + 一次 `patch-id`（空指纹再 `ls-tree`）；`unreviewedFiles` 每次调用算两遍；`assertReviewed` 里对每条 `override` 记录还会再调用一次。大 PR 或很多覆盖记录时，git 子进程是 O(文件数 × 记录数)，每个 diff 上限 256MB，可能很慢或吃内存。
- 建议：缓存每个 commit 的 `ownChangePrints` 结果（Map<commit, Map<file, fingerprint>>），一次 `git diff --raw -z` 取文件清单，override 搜索复用缓存。

## 推测（需实测 git 行为，未能运行）

- **二进制文件**：`git diff` 默认只输出 `Binary files ... differ`，patch-id 通常为空，此时会退到 `ls-tree` 的 blob 哈希，能发现内容变化；但如果某个 git 版本对这类输出也产生了非空且相同的 patch-id，则会漏报。没有测试覆盖，建议显式用 `--binary` 或直接比 blob OID。
- **`git patch-id` 的 `--verbatim` 是否存在及部署版本**：不同 git 版本支持情况不同；需要在实际运行环境核实，否则建议不用 patch-id、自己规范化文本。
- **`ls-tree` 失败**：`ownChangePrints` 对 `ls-tree` 的 status 没有检查，失败时 `stdout` 为空，指纹会是 `tree:`；如果同一个文件在 `from`/`to` 两边都失败，就会被判成相同（漏报）。正常仓库下很难触发。
- **`git diff` 的 textconv/diff 驱动**：若用户全局配置了驱动且 PR 改了 `.gitattributes`，`git diff` 的输出可能依赖外部工具；这里没有 `--no-textconv`，理论上可影响指纹。PR 本身无法写 `.git/config`，风险低。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **错误路径**：`ownChangePrints` 在 `merge-base`/`diff` 非零退出时返回 `null`，`unreviewedFiles` 退回 `changedOutside`（多报，安全）；`ls-tree` 未查 status（见推测）。`lowFixProblems` 的 `git diff` 失败仍抛异常（原行为）。
- **不可信输入**：文件名统一用 `-z` 输出、逐文件用 `:(literal)${file}` pathspec，防路径魔法注入；`mainRef` 在 CLI 侧校验不以 `-` 开头、无控制字符（`parseArgs`），并以独立参数传给 git，无 shell 注入。未发现新引入的注入点。
- **安全/漏报**：见问题 1、2、3：空白/移动/权限位改动可能不被判为未复核；`--accept-unreviewed` 的 override 记录搜索也因此更宽松（旧改动里曾经会报的空白/移动现在可能被覆盖）。但规则本身声明“防手误，不防有意”，这两类属于“手误”也会漏。
- **不可逆操作**：`--accept-low` 会向 `usage.jsonl` 追加记录；规模核对被绕过（问题 3）会把不该放行的低严重度修改永久记入账本，后续靠账本判断。`--accept-unreviewed` 写入覆盖记录同理。建议在补上测试前把这两条视为已知风险。
- **资源耗尽**：问题 7；另外每个逐文件 `diff` 的 `maxBuffer` 是 256MB，超大文件可能占满内存（失败会退回全量比较，多报，安全但慢）。
- **规则/文档一致性**：`model-review.md:44` 与代码主体一致（合并基线、patch-id、记录目录排除、算不出基线回退），但没有写“空白也忽略”“移动/重排也忽略”“权限位在混合改动时不参与”；`:133` 的“合并 main 随时可以做，不会让已复核的结果失效”与问题 5 的误报、以及重命名/被 main 吞掉的情形不符。测试标题 `:2746` 与断言矛盾。

---

## 必答问题

1. **是否改变模型已经见过的请求开头？** 不会。这个 diff 只改 `--assert-reviewed`/`--report` 的本地判定、测试和规则文档，未触及 `buildPrompt`、`reviewConfig` 或消息装配；`--assert-reviewed` 不调用模型。因此不存在“只在末尾追加”“每轮变的值在最后一条消息”的问题。规则文件会被复核提示词读取，但它是每次复核新建会话的固定内容，不是产品对话历史。（未逐行读 `buildPrompt`，但 diff 未触及它，属“未核实细节”。）

2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求不会：本改动不进入请求内容，也没有时间字段进入请求。`unreviewed` 列表用 `.sort()` 固定顺序。唯一与顺序有关的是 `lowFixProblems` 写入账本的 `files` 来自 `git diff --numstat` 顺序，但后续 `sameList` 是按排序比较的，且这不是发给模型的字节。若 `--report` 的输出被视为给人看的文字，其顺序可能依赖 git 输出顺序，但不影响模型缓存。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增 3 条用例；其中“手动改/合并后改动”“冲突解决”在实现把真实改动当成一致时会失败，属于有效反向用例。但关键路径没有任何测试：空指纹 `tree:` 退路、二进制、权限位、普通重命名、删除、行内移动/空白、被 main 吞掉的相同改动、旧 `low-fix` 账本、合入 main 后的 `--accept-low`。并且 `:2746` 标题与断言不符。建议补齐后再合入。

4. **新产生/修改的每个值，所有使用处都能接受吗？**
   - `lowFixProblems(...).files`：产生于 `:1119-1175`（现在经 `unreviewedFiles` 过滤）；使用于 `sameList`（`:1327-1328`）、账本 `files`（`:1431`）、报告输出（`:1507`、`:1513`）、`parseUsage` 校验（`:1601-1611`，要求非空字符串数组）。写入口径与重算口径**不一致**（问题 4），旧记录会被判 `files-differ`。
   - `unreviewedFiles` 返回列表：使用于 `:1356-1357`（`unreviewed` 前缀，可被 override）、`:1359`（`recordSecretProblems` 的 `otherFiles`，要求 `REVIEWS_DIR/` 前缀且 `HEAD:file` 可读）、`:1389`（override 搜索）、`:1149`（`lowFix` 过滤）。使用处都能处理，但返回值可能包含 `from..to` 无差异的文件（问题 5）。
   - 指纹字符串（`hash` 或 `tree:...`）：只在 `ownChangePrints`/`unreviewedFiles` 内部使用，不写账本，无跨版本持久化问题；但 `tree:` 依赖 `ls-tree` 输出，且没有检查其 status。
   - 新增 `mainRef` 参数：`assertReviewed` 的两处调用都传了（`:1318-1325`、`:1407-1414`）；程序化调用不传时退回旧行为。CLI 侧 `--main-ref` 有“不以 `-` 开头、无控制字符”的校验。
   - 规则中的 `--accept-low` 新口径：文件级过滤与代码一致；但“每个文件增删合计”仍会把 main 带入的行算进去，文档未说明（问题 3）。
   - 按 I-73 的教训：值在“产生端”（`lowFixProblems`）和“使用端”（`lowFixCheck`/账本/报告）确实共用同一实现，但**旧账本是由旧实现写入的第三方数据**，重算口径一变就会过不了新校验——这正是“清单里的 id 能否通过后端校验”的同类问题，见问题 4。
