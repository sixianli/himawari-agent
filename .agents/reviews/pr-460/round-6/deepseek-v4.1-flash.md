复核范围：我读了 `git diff 0d31eb…9083a85` 的提交构成，以及 `4f032be…9083a85` 中与本 PR 文件相关的增量；逐行核对了 PR 自己产生的 12 个非合并提交（`64c4753`、`fe8658a`、`b658cd3`、`4456a13`、`d650021` 及 docs 提交）改到的代码。`4f032be…9083a85` 里另有 4 个 `origin/main` 合并，带进 2924 个文件、约 13.7 万行新增；这些不是本 PR 作者的改动，我没有逐行复核。上一轮 `.agents/reviews` 判断记录在本环境读不出来（`read` 不存在、`git diff` 对 records 路径被拒绝），因此按整份 PR 复核。没有运行测试、lint、typecheck，也没有运行脚本。

## 侧重检查

- **错误路径**：核对 `resolveReadOnlyToolchainPaths` 对 `lstat` 的 ENOENT、非 ENOENT、悬空符号链接、必选条目缺失、`realpath` 失败的处理，见 `packages/testing/src/read-only-toolchain.mjs:10-21`。结论：只有“可选条目自身不存在”被跳过，其他错误抛出；与 ADR 相符。**但“`realpath` 权限错误”没有反向用例**，见意见 4。
- **不可信/不规范输入**：入口只有测试夹具和测试，`entries` 是内部构造的字符串数组，`optional` 默认只有 `/lib64`；没有外部输入进入该函数。未发现安全问题。
- **安全**：该函数只用于生成测试夹具的 `readOnlyToolchainPaths`，不进产品包；`scripts/ci/verify-artifact.mjs:186` 明确拒绝产物中出现 `@himawari-agent/testing/`。跳过 `/lib64` 只在 `lstat` 返回 ENOENT 时发生，没有放宽 `policy.ts` 的严格校验。
- **资源耗尽**：`prod-read` 改成 `synchronous=OFF`、`journal_mode=MEMORY` 并把 501 次插入放进一个事务，降低 fsync 次数；列表长度固定且很小，`Promise.all` 没有资源风险。
- **不可撤销操作**：没有。改动只涉及临时目录、临时 SQLite 文件和测试进程。
- **规则/文档与代码一致性**：`scripts/platform-assumptions.json` 的 `lib64` 计数与代码一致（`read-only-toolchain.mjs` 1 处、单测 9 处、四个调用方各 1 处）；ADR 0253 的 `amended_by` 指向存在的 ADR 0266，0266 的 `amends` 也回指 0253。发现两处作者说法与代码/增量不符，见意见 2、3；另有一处资格探针残留，见意见 1。

## 意见

### 1. 低 — ARM 资格探针使用的 model 文件仍无条件 realpath `/lib64`，ADR 的推迟范围没有点名它

文件：`test/qualification/sandbox-install-restart-model.mjs:410-428`；`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:65`、`:69`。

问题：本 PR 修好了四个 npm test 调用方，但 `sandbox-install-restart-model.mjs` 仍保留原来的写法，在 ARM 上会继续报 `ENOENT ... realpath '/lib64'`。它被 `test/qualification/sandbox-install-restart-probe.mjs:30` 导入，而 `test/integration/product-path-browser.test.ts:1188` 在 `recoveryDescribe` 中执行该探针；`recoveryDescribe` 只有在 `HIMAWARI_PRODUCT_PATH_E2E=1` 且 `process.platform === "linux"` 时才运行，所以在 ARM 资格跑里会走到。ADR 第 65 行说探测脚本及上线包副本推迟到 PR 3，但没有点名这个被探针导入的 model 文件；第 69 行验收又写“ARM 上 npm test 通过且 `/lib64` 一类失败清零”。这属于范围/文档不一致，不一定是本 PR 的代码错误。

证据（我读到的代码）：

```js
// test/qualification/sandbox-install-restart-model.mjs
410:     readOnlyToolchainPaths: [
411:       ...new Set(
412:         await Promise.all(
...
420:             "/lib64",
...
425:           ].map((entry) => realpath(entry)),
```

```ts
// test/integration/product-path-browser.test.ts
56: const recoveryDescribe = enabled && process.platform === "linux" ? describe : describe.skip;
...
1188:     const probe = path.join(repositoryRoot, "test/qualification/sandbox-install-restart-probe.mjs");
```

结论：**读代码证实**该文件仍无条件 realpath；**推测/未核实** ARM 资格跑当前是否真的会用 `HIMAWARI_PRODUCT_PATH_E2E=1` 执行到这条用例。

建议：在 ADR 0253 的推迟清单里明确写出 `test/qualification/sandbox-install-restart-model.mjs`（以及它会导致的上线包清单摘要变更），或者确认它属于 PR 3 并把验收标准中的“npm test”限定为默认 E2E 关闭的跑法。

### 2. 低 — 作者说 `prod-read` 的“测试库改为不落盘”，但代码仍然把数据库写到磁盘

文件：`test/tooling/prod-read.test.mjs:38-49`、`:235`。

问题：作者说明写“测试库改为不落盘、批量插入放一个事务”。代码实际是在临时目录创建 `product.sqlite` 文件，子进程还要读这个文件；改掉的只是 journal 和 fsync，不是磁盘写入。commit message 里的“`synchronous=OFF`、`journal_mode=MEMORY`”是准确的，作者摘要不准确。

证据：

```js
38: function migratedDatabase() {
39:   const directory = mkdtempSync(path.join(os.tmpdir(), "prod-read-db-"));
...
41:   const file = path.join(directory, "product.sqlite");
42:   const database = new DatabaseSync(file);
43:   database.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY");
...
49:   return { file, database };
```

```js
235:     const script = result.input.replace("/var/lib/himawari/state/data/product.sqlite", file);
236:     const child = spawnSync(process.execPath, ["--no-warnings", "-", "rule-memories"], {
```

结论：**读代码证实**。建议把说明改成“关闭 journal 落盘和 fsync，批量插入合并为一个事务”。

### 3. 低 — “其余改动与第 5 轮相同”与增量事实不符：增量里夹着大量 `origin/main` 合并

文件/提交：`9083a855b`、`74e72e87`、`aca21246`、`3691b6ca0`（merge commits）；`git diff --shortstat 4f032be..9083a85`。

问题：作者说第 6 轮只因解决 `sandbox-preparation-control.test.ts` 的导入冲突重新对齐。实际相对 `4f032be` 的增量是 2924 files changed、137068 insertions、3431 deletions，包含 4 个 `origin/main` 合并。这些不是本 PR 作者的改动，但“其余改动与第 5 轮相同”从 diff 层面不成立，会让复核者误以为增量很小。

证据：

```text
$ git diff --shortstat 4f032be..9083a85
 2924 files changed, 137068 insertions(+), 3431 deletions(-)

$ git log --oneline --graph 0d31eb..9083a85
* 9083a855b Merge remote-tracking branch 'origin/main' ...
* 74e72e872 merge: origin/main 合入 PR 460
* aca212461 Merge remote-tracking branch 'origin/main' ...
* 3691b6ca0 Merge remote-tracking branch 'origin/main' ...
```

结论：**读代码证实**（git 事实）。建议在复核材料里写清“增量包含 main 合并，本轮只复核 PR 自己的非合并提交与冲突解决文件”，或直接用 PR 自身的非合并提交范围做复核链。

### 4. 低 — `realpath` 权限错误没有反向用例，测试无法证明“其他错误照常抛出”覆盖到取真实路径阶段

文件：`packages/testing/test/read-only-toolchain.unit.test.ts:64-85`。

问题：ADR 第 65 行要求“路径存在但取真实路径失败（例如悬空的符号链接）、权限错误……都报错”。现在有悬空符号链接（`realpath` 返回 ENOENT）和 `lstat` 被拒绝（EACCES）的用例，但没有“`lstat` 成功、`realpath` 抛 EACCES”的用例。如果有人把 `realpath` 的异常也吞掉，现有 9 个用例里没有一条会失败。

证据：

```ts
64:   it("fails on an optional entry that is a dangling symlink", async () => {
...
68:     await expect(resolveReadOnlyToolchainPaths([link], { optional: [link] })).rejects.toMatchObject(
69:       { code: "ENOENT" },
70:     );
71:   });
72:
73:   it("fails on an optional entry whose lstat is refused instead of skipping it", async () => {
74:     const denied = Object.assign(new Error("denied"), { code: "EACCES" });
75:     await expect(
76:       resolveReadOnlyToolchainPaths(["/lib64"], {
77:         io: {
78:           lstat: async () => {
79:             throw denied;
80:           },
81:           realpath: async (value: string) => value,
```

结论：**读代码证实**。建议加一条用例：`io.lstat` 正常返回，`io.realpath` 抛 `EACCES`，断言 rejects 为同一个错误。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本 PR 自己的改动只在测试夹具、测试、ADR 和平台假设清单里；没有改系统提示、工具定义、历史消息或遮盖结果，也没有把每轮变化的值挪到最后一条消息之外。发给模型的内容仍然只在末尾追加。合并进 `origin/main` 的 `prompt-catalog` 等改动不是本 PR 作者改动，我没有逐行复核（未核实）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。新函数只返回按输入顺序、按首次出现去重的 realpath 列表；没有时间字段、无序集合或依赖前后文的遮盖。同一主机同一输入结果稳定；不同主机结果不同是本 PR 有意为之（ARM 没有 `/lib64`）。`review-gateway` 测试里手写的 `install` 对象只服务于测试进程，不进入模型请求。

3. **有没有对应的自动检查，反向用例是否会真的失败？** 有：`read-only-toolchain.unit.test.ts` 9 个用例，其中“必选条目缺失须报错”“`lstat` 非 ENOENT 须抛出”“悬空链接须抛出”“拼写相似的必选条目不得被当作可选”“`dedupe:false` 保留重复”都是反向用例，改坏实现会失败；`platform-assumptions` 检查按次数严格比较，新增/减少任一处都会失败；静态用例检查四个夹具确实导入并调用了新函数。缺口是 `realpath` 的 EACCES 没有反向用例（意见 4）。`prod-read` / `review-gateway` 的性能改动没有新增专门断言，原有行为断言不变；作者给的毫秒数无法在当前环境验证（未核实）。

4. **每个产生或修改的值，使用端都能接受吗？**
   - `resolveReadOnlyToolchainPaths`、`OPTIONAL_TOOLCHAIN_PATHS`：由四个夹具和单测消费；`grep` 到 4 个调用点，签名与 `.d.mts` 一致。
   - `package.json` 的 `./read-only-toolchain` 导出：四个调用方都通过该子路径导入；仓库已有 `./temporary-root` 同样写法，可接受。
   - `platform-assumptions.json` 的 `lib64` 计数：检查器 `scripts/check-platform-assumptions.mjs:52-61,99-114` 读取并严格比较；我核对当前代码为 `read-only-toolchain.mjs` 1 处、单测 9 处、四个调用方各 1 处，与清单一致。
   - `review-gateway` 测试手写的 `install`：`startGateway` 只消费 `binary`、`pluginDir`、`cacheDir`、`version`，这四个都提供了；该路径不调用 `binaryProblem`，所以缺 `binarySha256` 不影响。
   - `migratedDatabase()` 返回的 `{ file, database }`：两个调用点分别使用 `file` 替换脚本路径、`database.prepare/exec/close`，两端匹配。
   - `sandbox-preparation-control.test.ts` 的合并结果：`resolveReadOnlyToolchainPaths` 在 `:88` 导入、`:690` 使用；合并后删掉的 `lstat` 在该文件已无引用，`claimJobHostLaunch` 也无残留引用，未发现重复或未使用导入。
   - ADR 0253 的 `amended_by` 指向存在的 ADR 0266，0266 的 `amends` 回指 0253，两端一致。

**未核实**：测试/lint/typecheck 未运行；上一轮复核判断记录读不出来；`4f032be..9083a85` 中 `origin/main` 合并带来的 2924 个文件没有逐行复核；作者给出的 x64 耗时改善数字没有实测。
