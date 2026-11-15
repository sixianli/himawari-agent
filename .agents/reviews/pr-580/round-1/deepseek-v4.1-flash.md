核对范围：`git show --stat 75340727843fe0e9cd1c55a2f9896ae7d40a6f8c` 显示 PR 580 实际只改了 `package.json` 和新增测试文件。材料给的基准 `ec350d9` 是 PR #561 的合并提交，与本次 head 同在 `a42387e69` 之后，因此 `ec350d9..753407278` 的 diff 包含 PR #561 的反向差异（删除 Tuning 页面等），不是 PR 580 的改动。

### 1. 中 — Swift 解析只认“单行、无注释、一个 case”，合法的多 case/注释/反引号写法会被漏掉，可能让漏配的图标通过
文件: `test/tooling/apple-icon-consistency.test.mjs:18-21`

问题：`swiftNames()` 用整行正则匹配 `case`，只接受 `case name` 或 `case name = "raw"` 独占一行。

读代码证实的证据：
```js
const body = source.slice(source.indexOf("enum IconName"), source.indexOf("public struct Icon"));
return [...body.matchAll(/^\s*case\s+(\w+)(?:\s*=\s*"([^"]+)")?\s*$/gmu)].map(
  (match) => match[2] ?? match[1],
);
```
当前 `Icon.swift:5-88` 恰好是一行一个 case、无行尾注释，所以按正则推断当前能通过。

推测（正则行为，未实际执行测试）：
- `case foo = "foo", bar = "bar"` 整行不会匹配；如果 `foo`、`bar` 是新增图标且没同步进 `icons.json` 和资源目录，`swiftNames()` 看不到它们，测试仍然通过，正好漏掉本 PR 要防的漏配。
- `case foo = "foo" // 说明` 整行不会匹配：若 `foo` 已在配置里，测试会误报失败；若是新增，则静默漏掉。
- ``case `default` = "default"`` 因 `\w+` 不匹配反引号，也会漏掉。

建议：把解析函数导出，并用固定字符串做反向自测，至少覆盖“一行多个 case”“行尾注释”“反引号标识符”“新增 case 未同步”四种；或改用能正确处理 Swift 语法的解析方式。最低成本是在解析前去掉行尾注释、支持逗号分隔，并在切片区间内确认没有未被解析的 `case` 记号。

### 2. 低 — 只比较 `.imageset` 目录名，不检查目录里的 SVG 和 Contents.json，资源残缺仍会通过
文件: `test/tooling/apple-icon-consistency.test.mjs:24-28`

问题：`catalogNames()` 只读目录名；只要目录名存在，即使目录里没有 SVG 或 `Contents.json`，测试也通过，图标在实际打包/运行时仍可能不可用。

读代码证实的证据：
```js
return readdirSync(new URL("Resources/Icons.xcassets/", design))
  .filter((entry) => entry.endsWith(".imageset"))
  .map((entry) => entry.slice(0, -".imageset".length));
```
而生成器确实依赖目录内文件，`clients/apple/scripts/make-icons.mjs:50-52` 写入的是：
```js
const set = join(catalog, `${name}.imageset`);
mkdirSync(set);
writeFileSync(join(set, `${name}.svg`), svg);
```
建议：对每个 `.imageset` 同时断言 `name.svg` 和 `Contents.json` 存在，必要时校验 `Contents.json` 里的 `filename` 与目录名一致。

### 3. 低 — 材料给的对比基准混入了 PR #561 的整体回退，容易被误当成 PR 580 的改动
文件: 提交 `753407278` / 基准 `ec350d9`

问题：若直接按 `ec350d9..753407278` 审查，会看到删除 `TuningModels.swift`、`TuningPages.swift`、`ci/operations-pending.json` 条目等大量内容，但这些不是 PR 580 的提交内容。

读代码证实的证据：
- `git log --oneline -4 ec350d9...`：`ec350d9 手机端：送达时机和“想一想”门槛的设置页 (#561)`，其父提交是 `a42387e69`。
- `git log --oneline -4 753407278...`：head 的父提交同样是 `a42387e69`。
- `git show --stat 753407278...` 只有 `package.json` 和 `test/tooling/apple-icon-consistency.test.mjs`。

建议：PR 580 的审查基准应取 `a42387e69..753407278` 或直接 `git show 753407278`；否则会把并行分支的差异误算到本 PR。

## 侧重检查

- 错误路径：`readFileSync`/`readdirSync` 在文件或目录缺失时直接抛错，测试会失败，方向正确。`source.indexOf(...)` 找不到标记时，`slice` 可能退化成空串或截到错误区间；由于还有 `config.length > 50`，通常仍会失败，但报错信息不会指出是标记缺失。读代码证实。
- 不合规范/不可信输入：输入只有仓库内的 `icons.json`、`Icon.swift`、资源目录名，没有网络或用户输入。`JSON.parse` 失败会让测试失败；`icons.json` 根不是对象时 `Object.keys` 行为异常，但最终与 Swift/资源数组比较会失败。读代码证实。
- 安全：没有 shell 调用、没有写文件、没有秘密外泄；新增 npm 参数是字面路径。`make-icons.mjs` 里的 `rmSync` 不会被测试触发。读代码证实。
- 资源耗尽：只读取一个小 Swift 文件和一次小目录列表，规模约 84 个图标，无循环放大。读代码证实。
- 不可撤销操作：测试本身只读；`check-design.mjs` 在它之前运行也只比较生成结果，不写文件。读代码证实。
- 规则/说明与代码一致性：`icons.json` 的 `x@variant` → `x-variant` 与 `make-icons.mjs:44-45` 一致；Swift 取 `rawValue` 与 `Icon.swift:101` 的 `Image(name.rawValue, ...)` 一致；当前三处按读到的内容都是 84 个名字。作者“只加测试和 package.json 一个文件名”的说法对提交 `753407278` 成立，但与材料给的基准 diff 不一致，原因见上。未运行测试和 Swift 编译，故“当前 main 通过”只做了静态核对。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。PR 580 的实际提交只增加测试和在 `package.json` 里把一个测试文件加入 `check:apple-design`，没有改系统提示、工具定义、历史消息、遮盖或请求组装代码。发给模型的内容仍由既有代码只在末尾追加，每轮变化的值仍只放在最后一条消息；依据是 `.agents/instructions/prompt-prefix.md` 第 3、4 条。读代码证实。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。该改动不参与请求序列化；测试只在构建期读静态文件，`sort()` 对同一输入结果确定，没有时间、随机数、无序集合或上下文相关遮盖。读代码证实。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：新测试已加入 `check:apple-design`，而 `check:apple-design` 在 `check:steps` 里，`npm run check` 会通过 `scripts/run-all-checks.mjs` 执行它。按代码推断，删除 `icons.json` 的 `upload` 会让 `swift` 比 `config` 多一个名字，`expect(swift).toEqual(config)` 失败；这一点未实际运行验证。不足是解析器存在上面的漏配写法，且仓库里没有针对解析器本身的负向用例。
4. **改动产生的每个值，使用它的地方都能接受吗？** 新增的脚本值是 `test/tooling/apple-icon-consistency.test.mjs`：产生于 `package.json:35`；`package.json:27` 的 `check:steps` 包含 `check:apple-design`，`scripts/run-all-checks.mjs:31-36` 读取并执行它；`ci/policy.json:233` 的 tooling 项目包含 `test/tooling/**/*.test.mjs`，文件真实存在，路径会被 vitest 接受。测试内部的名字映射也与 `make-icons.mjs:44-45`、`Icon.swift:101` 一致，当前 `icons.json`、Swift case、资源目录均为 84 个名字。未发现两端校验不接受的情况；唯一的缺口是测试不校验资源目录内部文件（见意见 2）以及 Swift 解析会漏掉部分合法写法（见意见 1）。读代码证实，未执行。
