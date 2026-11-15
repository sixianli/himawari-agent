## 审查意见

### 1. 中：推送钩子扫的是当前工作区，不是本次要推送的提交，冲突标记可能漏拦
文件: `scripts/git-hooks/pre-push:24`、`scripts/check-conflict-markers.mjs:23-32`、`scripts/check-conflict-markers.mjs:40-42`

问题：新增的一步直接运行脚本，脚本用 `git ls-files` 取当前索引/工作区的文件，完全不看本次推送的 ref 和提交。只要工作区与要推送的提交不一致，闸门就会给出错误结论：

- 已提交带标记的坏文件，但在工作区改好而未提交，钩子读改好的内容，放过坏提交；
- 当前检出的是另一个干净分支，推送一个没检出的坏分支；
- 稀疏检出（本复核环境本身就是 56% 的稀疏检出），未落盘的文件被 `ENOENT` 跳过；
- 反之，工作区里有未完成合并的标记时，推送任何无关的干净提交都会被误拦。

对比同一钩子已有的第 0 层检查，它确实按推送内容检查：`pre-push:3` 调用 `check-layer0-tests.py pre-push`，后者读取 stdin、跳过删除分支（`ZERO`）并对每个待推送提交做 `rev-list`（`scripts/layer0-tests/check-layer0-tests.py:389-402`）。新步骤没有沿用这个能力。

证据（读代码证实）：
```
pre-push:24  node "$root/scripts/check-conflict-markers.mjs" >&2 || {
check-conflict-markers.mjs:24  const listed = execFileSync("git", ["ls-files", "-z"], {
check-conflict-markers.mjs:41    if (error.code === "ENOENT" || error.code === "EISDIR") continue;
```
推测部分：上述前三种情形会让闸门漏掉真正要推送的标记；这几种情形没有用例覆盖。

建议：在 shell 里先缓存 stdin（注意 python 已经消费它），或让 python 把 ref 传出来；对每个非零 `local_sha` 用 `git grep`/`git cat-file`/`git archive` 检查该提交的树，删除分支（`ZERO`）跳过。补“工作区干净但提交带标记”“推送未检出的分支”“删除分支”“首次推送新分支”用例。

### 2. 低：事故清单对覆盖范围的描述与代码不一致
文件: `docs/incidents-and-gates.md:141`、`scripts/check-conflict-markers.mjs:7`、`scripts/check-conflict-markers.mjs:31`、`test/tooling/conflict-markers.test.mjs:29`

问题：I-109 行写“扫描所有受版本控制的文本文件”，但代码明确排除 `.agents/reviews/`；该行又说测试覆盖“缩进”，实际用例要求带缩进的标记**不报**（`  <<<<<<< HEAD` 被断言为空结果）。这不是代码错误，但文档会让读者以为缩进标记也会被拦、且所有受控文件都扫。

证据（读代码证实）：
```
check-conflict-markers.mjs:7   const SKIPPED_PREFIXES = [".agents/reviews/"];
check-conflict-markers.mjs:31  .filter((path) => path !== "" && !SKIPPED_PREFIXES.some(...));
conflict-markers.test.mjs:29   expect(findConflictMarkers("  <<<<<<< HEAD\n  >>>>>>> x")).toEqual([]);
docs/incidents-and-gates.md:141  扫描所有受版本控制的文本文件，一对 `<<<<<<< ` 和 `>>>>>>> ` 行首标记就失败
```
建议：把该行改成“除 `.agents/reviews/` 外”，并写明“只认行首、带缩进的不算”。

### 3. 低：只匹配成对标记，留下半个冲突块不会被拦
文件: `scripts/check-conflict-markers.mjs:12-19`、`test/tooling/conflict-markers.test.mjs:27-31`

问题：开标记必须后接闭标记才计入；只剩 `<<<<<<< ` 没有 `>>>>>>> `、或只剩 `>>>>>>> ` 没有开标记时都返回空。手工解决冲突时删掉开始行、留下 `=======` 和 `>>>>>>>`，或删掉结束行留下开始行，代码仍是坏的，但这个闸门放过。

证据（读代码证实）：
```
check-conflict-markers.mjs:14  if (lines[index].startsWith("<<<<<<< ")) open = index + 1;
check-conflict-markers.mjs:15  else if (lines[index].startsWith(">>>>>>> ") && open !== null) {
test:28  expect(findConflictMarkers("a\n=======\nb")).toEqual([]);
test:30  expect(findConflictMarkers("<<<<<<< HEAD\nonly the start")).toEqual([]);
```
建议：至少把孤立的 `>>>>>>> ` 当作失败（几乎不会出现在正常文本里）；`=======` 单独出现是 Markdown 标题下划线，不能无条件报，可按文件类型或上下文处理。补对应用例。

### 4. 低：每次推送全量读取所有受控文件，没有大小上限
文件: `scripts/check-conflict-markers.mjs:23-32`、`scripts/check-conflict-markers.mjs:34-45`

问题：每次推送（包括新分支首次推送、删除分支、只推 tag）都会 `git ls-files` 列出全部受控文件，再用 `readFileSync` 整个读进内存，读完才用 `includes(0)` 判断二进制；没有单文件大小上限，也不按推送范围裁剪。仓库文档 I-106 记录仓库本体约 0.5G，且历史上强制提交过截图/录屏，遇到大的受控二进制会增加每次推送的耗时和内存峰值。

证据（读代码证实）：
```
check-conflict-markers.mjs:39  content = read(path);
check-conflict-markers.mjs:44  if (content.includes(0)) continue;
```
未核实：实际增加多少秒没有测（本复核不能运行脚本）。

建议：按第 1 条改为只检查待推送提交，用 `git grep` 或流式读取；或对文件设大小上限、按扩展名/`.gitattributes` 先跳过明显的二进制。删除分支和新分支首个提交本身不需要特殊放行（`git ls-files` 为空时脚本返回 0，不会误拦），但也没必要为这类推送付全量扫描成本。

### 5. 低：新增测试只证明了失败/缺失路径，成功路径没有断言新步骤真的运行
文件: `test/tooling/layer0-hooks.test.mjs:159-169`、`test/tooling/layer0-hooks.test.mjs:171-179`、`test/tooling/layer0-hooks.test.mjs:240-263`

问题：成功推送的用例只断言 `BOUNDARY/FORMAT/LINT/SECRETS_STUB_RAN`，没有断言 `MARKERS_STUB_RAN`（也没有 `HYGIENE_STUB_RAN`），因此“推送通过时新步骤确实执行了”只能从失败用例间接推断。另外 `expect(scripts["check:conflict-markers"]).toContain(...)` 在基准提交里就已经为真（`package.json` 的该键在 PR 581 已存在），它不是本次钩子改动的反向用例。夹具补了 `check-repo-hygiene.mjs` 替身，但失败/缺失循环仍没有 repo hygiene 这一项（全仓库只有钩子引用 `PUSH_REPO_HYGIENE_FAILED`）。

证据（读代码证实）：
```
test:165-168  expect(pushed.stderr).toContain("BOUNDARY_STUB_RAN") ... "SECRETS_STUB_RAN"
test:178      expect(scripts["check:conflict-markers"]).toContain("node scripts/check-conflict-markers.mjs");
test:240-244  [format, lint, secrets, conflict-markers]  // 没有 check-repo-hygiene.mjs
```
补充：夹具补替身让原先会因缺少 `check-repo-hygiene.mjs` 而失败的“推送成功”路径恢复有意义，这一点是修复而不是削弱；但 repo hygiene 的失败/缺失路径仍无用例。

建议：成功用例加 `expect(pushed.stderr).toContain("MARKERS_STUB_RAN")`（以及 `HYGIENE_STUB_RAN`）；把 `check-repo-hygiene.mjs` 加入失败/缺失循环。反向用例本身是有效的：删掉 `pre-push:24-27` 后，`PUSH_CONFLICT_MARKERS_FAILED` 用例会失败。

## 侧重检查

- 新分支首次推送、删除分支：钩子不读 stdin，脚本仍扫工作区；`git ls-files` 为空时返回 0（`scan([])` → 无失败），不会因“没有可推送对象”误拦。删除分支时若有未解决的合并状态，可能被工作区标记误拦。未找到覆盖这些路径的测试。
- 错误路径：缺失脚本 → node 非零 → `PUSH_CONFLICT_MARKERS_FAILED`（测试覆盖）；`ENOENT/EISDIR` 跳过；`EACCES` 等抛出 → 钩子失败，方向是 fail-closed，可接受。
- 不可信输入/安全：文件内容按行检查，二进制按 NUL 跳过；路径由 Node 读取、shell 里 `"$root"` 有引号，无命令注入。失败时把 git 路径原样打到终端，恶意文件名可能带终端控制序列，但只在本机失败时出现，影响低。
- 资源耗尽：见第 4 条，全量读取且无单文件上限；`git ls-files` 的 `maxBuffer` 是 64MB。
- 不可撤销操作：本改动只增加推送前检查，不执行删除、覆盖或远端写操作。
- 规则/文档/代码一致：钩子写法与前几步完全同构（`node ... >&2 || { echo ...; exit 1; }`），POSIX sh 一致；I-109 行“所有文件”“缩进”与代码不符（第 2 条），其余“失败打印 `PUSH_CONFLICT_MARKERS_FAILED`”“失败或缺失都拦下”与代码和测试一致。
- 副作用：`docs/lessons.md:672` 记录的 `pre-push` SHA-256 已因本改动再次过期；该值在本次改动前就因 hook 多次修改而过期，不是本 PR 引入，未找到校验它的检查。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只有 `docs/incidents-and-gates.md`、`scripts/git-hooks/pre-push`、`test/tooling/layer0-hooks.test.mjs` 三个文件，没有任何组装、序列化、遮盖或发送模型请求的代码。发给模型的内容仍然只在末尾追加，本次也没有新增任何“每轮会变的值”；第 1 个必答问题在这里是“不涉及”，并未被违反。[prompt-prefix.md#rules](../../.agents/instructions/prompt-prefix.md#rules)
2. **不会。** 改动不涉及遮盖、时间字段、集合顺序、JSON/序列化；新增的错误码只是推送到 stderr 的固定文字，不进入模型请求。没有依赖前后文的处理。
3. **有自动检查，反向用例是真的会失败。** `test/tooling/layer0-hooks.test.mjs:240-263` 对 `scripts/check-conflict-markers.mjs` 的“失败”和“缺失”两种情况都要求推送被拒并出现 `PUSH_CONFLICT_MARKERS_FAILED`；删掉钩子新增的 `pre-push:24-27` 后这两条会失败。该测试位于 `tooling` 项目（`ci/policy.json:233`），CI 会运行。不足：`package.json` 的断言在改动前已成立，不算反向用例；成功路径没有断言新步骤真的执行；没有覆盖“工作区与待推送提交不一致”“删除分支/首次推送”。另外本地 `npm run check` 的 `check:layer0-hooks` 只安装钩子、不跑这个测试，本地检查抓不到钩子回归。
4. **逐个核对的结果：一致，除了文档覆盖范围。**
   - `PUSH_CONFLICT_MARKERS_FAILED`：产生于 `pre-push:25`；使用于 `test/tooling/layer0-hooks.test.mjs:244` 和 `docs/incidents-and-gates.md:141`；三处一致。
   - `scripts/check-conflict-markers.mjs`：产生/使用于 `pre-push:24`、`package.json:32`、`test:178`、`docs:141`；文件实际存在，路径可执行方式一致。
   - `check:conflict-markers`：`package.json:27` 的 `check:steps`、`package.json:32` 定义、钩子提示文字和文档都引用它，键存在。注意钩子只运行 `node scripts/check-conflict-markers.mjs`，而 `npm run check:conflict-markers` 还会跑 vitest；提示文字沿用了其它步骤的写法，功能上无误，但“npm run ...”并不等于钩子实际执行的整条命令。
   - 测试夹具新增的 `check-repo-hygiene.mjs`、`check-conflict-markers.mjs` 替身只在测试内使用，没有生产端消费者；它们让成功路径能走完整条钩子。
   - 事故清单行：`docs:141` 的“扫描所有受版本控制的文本文件”与代码的 `.agents/reviews/` 排除不一致（见意见 2）；其余“失败打印 `PUSH_CONFLICT_MARKERS_FAILED`”“脚本失败或缺失都拦下”与代码和测试相符。
   - 没有新增配置键、清单项或序列化格式。
