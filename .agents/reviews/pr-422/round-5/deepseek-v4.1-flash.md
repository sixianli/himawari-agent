## 结论

这个提交没有触碰任何发给模型的内容，也没有发现会让本次 CI 放宽失效的高危缺陷。按代码核对，`@emnapi/*` 这条链能被正确跳过；`lockDependents` 的逐层解析对嵌套 `node_modules`、`packages/x`、带 scope 的包名和 `link` 条目都按 npm 的路径规则工作，循环也一定终止。发现的问题都是低严重度：一处新逻辑与旧的特例集合不一致，以及测试/门槛覆盖不足。作者的实证结论（改前复现、改后通过、`npm run check`）我无法运行，标为未核实。

## 侧重检查

- **错误路径 / 不可信输入**：`lockDependents` 对 `entry.dependencies` 等用 `group ?? {}`，对数组/字符串/`null` 条目不会抛异常；`lock.packages` 的空值已由前面的 `auditManifestDependencies` 断言。`resolve` 只用锁文件键做字符串拼接和 `lastIndexOf`，不碰文件系统，不会越界或原型污染。**未发现问题。**
- **解析规则**：对 `node_modules/a/node_modules/b`、`node_modules/@scope/a/node_modules/@scope/b`、`packages/x/node_modules/foo`、`packages/x/node_modules/a/node_modules/b` 逐段手算，`base = base.slice(0, lastIndexOf("node_modules/"))` 的结果与 Node 的逐级向上解析一致；`link: true` 条目没有 `dependencies`，跳过它不影响工作区真实条目 `packages/x` 的依赖边。**未发现问题。**
- **资源耗尽 / 终止性**：`skipped` 只增不减，每轮至少新增一个元素，最多 `|absentOptional|` 轮；不会死循环。`dependents.set(target, [...old, path])` 每次复制数组，最坏 O(E·k)，当前锁规模下不构成资源问题；真实锁里被很多包依赖的 `tslib` 只有几十个依赖者。
- **安全 / 漏检**：只有 `absentOptional` 中的路径能进入 `skipped`，任何已安装包（含工作区路径 `packages/x`、根 `""`）都不在 `skipped`，因此“被已安装包用到”的依赖不会被放宽跳过。`devDependencies` 边没有进入 `lockDependents`，但我核对后认为它**不构成漏检**：通过工作区非 optional 的 devDependency 非可选地可达的包，npm 不会把它的 `optional` 标成 `true`（真实锁里 `node_modules/tslib` 同时被 dev 和 prod 路径使用，就没有 `dev`/`optional` 标记，见 `package-lock.json:7864`），所以它不会进入 `absentOptional`；如果它只是已安装 devDependency 的 optional 子依赖，那个已安装条目自己的 `optionalDependencies` 边已经存在，仍会阻止跳过。**结论：没有新增漏检；该推断依赖 npm 对 `optional` 的“仅 optional 可达才为真”语义，未用 npm 实测。**
- **不可撤销操作**：本次只读锁文件和安装树，没有写入或删除。**无。**
- **文档 / 规则一致性**：没有找到描述“只允许其他平台 optional 缺席”的文档，因此没有陈旧说明；`test/qualification/evidence/**` 里旧摘要包含这两个文件的哈希，但那些是历史快照，`grep` 未发现代码把它们当门禁读回。**未发现问题。**
- **真实锁核对**：`@rolldown/binding-wasm32-wasi`（`cpu: wasm32`，`package-lock.json:2292-2301`）被嵌套的 `node_modules/vite/node_modules/rolldown` 通过 `optionalDependencies` 使用（`8455-8488`）；它的 `@emnapi/core`、`@emnapi/runtime`、`@napi-rs/wasm-runtime` 以及后者的 `@tybys/wasm-util`、`@emnapi/wasi-threads` 都是 `optional: true` 且没有 `os/cpu` 限制（`1214-1247`、`1942-1962`、`2459-2469`），静态推导可以被传播跳过。

## 发现的问题（按严重度）

### 1. 低：传播逻辑没有把“允许缺席的可选对等依赖”当作已缺席集合，逻辑两端不一致

**文件:行**：`scripts/ci/install-dependencies.mjs:262-266`、`268-277` 与 `278-281`

**问题**：最终判定允许两种缺席：`skipped` 里的，以及 `optional && peer` 的（第 280 行 `continue`）。但传播的种子 `skipped` 只包含“平台不匹配的没装 optional 包”，没有包含第 280 行那类被允许缺席的可选对等依赖。因此：一个平台匹配的 `optional && peer` 包 P 没装时，P 自己可以通过第 280 行；但如果 P 还有自己的依赖 X（X 因此也没装、且被标为 optional），X 的 `requiredBy` 是 `[P]`，P 不在 `skipped`，X 就进不了 `skipped`，最后第 281 行会报“锁文件依赖没有安装: X”。这与“允许缺席的包的依赖也可以缺席”的意图不一致，属于过严的误报，不是漏放；旧代码同样会报 X，所以不是本次引入的回归，但本改动本可以顺手统一。

**证据**：

```js
262:  const skipped = new Set(
263:    absentOptional
264:      .filter(([, entry]) => !platformMatches(entry, platform, arch))
265:      .map(([path]) => path),
266:  );
...
271:      const requiredBy = dependents.get(path) ?? [];
272:      if (skipped.has(path) || requiredBy.length === 0) continue;
273:      if (!requiredBy.every((dependent) => skipped.has(dependent))) continue;
...
280:    if (entry.optional === true && entry.peer === true) continue;
281:    assert(skipped.has(path), `锁文件依赖没有安装: ${path}`);
```

当前真实锁里没有 `"peer": true` 字段（`grep` 无结果），所以没有触发实例。

**建议**：把“允许缺席”的定义收敛成一处：要么在初始化 `skipped` 时也加入平台匹配的 `optional && peer` 条目，要么让传播和最终判定共用一个 `allowedAbsent(path)` 谓词。并补一条用例：可选对等依赖 P 未安装、P 的 optional 依赖 X 也未安装时，两者都应被接受。

### 2. 低：新测试不在 `npm run check` 的步骤里，且三条反向断言只有第一条能区分新旧实现

**文件:行**：`test/tooling/toolchain.test.mjs:377-415`；`package.json:27`；`ci/policy.json:19`、`193-195`

**问题**：
- 新用例所在的 `test/tooling/toolchain.test.mjs` 属于 Vitest 的 `tooling` 项目，CI 的 `policy`/`coverage` 作业会跑（`ci/policy.json:19` 的 `"projects": ["tooling"]`，以及 `193-195` 的 include）；但 `npm run check` 的 `check:steps` 只运行列出的具体脚本（`package.json:27`），没有任何一步运行整个 `tooling` 项目，也没有单独点名 `toolchain.test.mjs`。因此“`npm run check 50 步通过`”不能证明新用例跑过；本地门槛不覆盖这段新逻辑，只有 CI 会覆盖。
- 三条反向断言中，按旧代码（父提交 `assert(entry.optional === true && !platformMatches(...))`）推导：
  - 第一条（给已安装的 `@earendil-works/pi-ai` 加 `nested-helper` 依赖）在改前会先报 `node_modules/only-for-other-platform`，与期望的 `nested-helper` 不同，所以能区分新旧，是有效的；
  - 第二条（去掉 `only-for-other-platform.optional`）和第三条（把 `other-platform.cpu` 改成当前架构）在改前也会抛出包含期望字串的错误，**改前同样通过**，只是防止以后放宽，不构成“改前必失败”的判别用例。

**证据**：`package.json:27` 的 `check:steps` 没有 `test:tooling` 或整项目 `--project tooling`；`ci/policy.json` 的 tooling 项目 include 了 `test/tooling/**/*.test.mjs`。

**建议**：把该测试接入一个 `npm run check` 步骤（或按仓库惯例新增 `check:*`），否则本地必过门槛不覆盖本次修法；同时补上真正会区分新旧的反向用例：已安装包通过 `optionalDependencies` 使用缺失包、嵌套 `node_modules` 解析、工作区 `packages/x` 路径，以及可选对等依赖的传播。

## 已证实与推测

**读代码证实的**：
- `lockDependents` 的依赖边包含 `dependencies`、`optionalDependencies`、`peerDependencies`，跳过 `link` 条目（`149-172`）。
- 传播是单调不动点，必然终止；已安装包永不会被加入 `skipped`（`258-277`）。
- 最终判定允许 `optional && peer` 无条件缺席（`280`），与传播的种子集合不一致（发现 1）。
- `@emnapi/*` 链在真实锁里符合“只有平台不匹配的 wasm 绑定及其可选子树缺席”的形态，静态上会被跳过（`package-lock.json:1214-1247`、`1942-1962`、`2292-2310`、`2459-2469`、`8455-8488`）。
- 新测试不在 `npm run check` 的执行范围内；反向断言 2、3 在旧实现下也会通过。

**推测 / 未核实**：
- 作者所说“改前本地对真实锁文件和安装树复现同一错误、改后通过”“新用例改前失败、改后通过”“`npm run check` 50 步通过”：本次环境不能运行 node/npm，未核实。
- `devDependencies` 边缺失不构成漏检，依赖 npm 对 `optional` 字段的“仅 optional 可达才为真”语义；我用 `tslib` 同时被 dev/prod 使用却无 `dev`/`optional` 标记作为旁证，但没有用 npm 实测生成锁。
- 可选对等依赖的传播缺口在当前锁文件中没有实例（没有 `"peer": true`），是否会在未来真实锁中触发未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `scripts/ci/install-dependencies.mjs` 和 `test/tooling/toolchain.test.mjs`，没有改系统提示、工具定义、历史消息或遮盖逻辑；这些文件只被 CI/测试脚本引用，不在模型请求组装路径上。发给模型的内容仍然只在末尾追加，每轮会变的值也不受影响。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。这个改动不参与任何模型内容序列化；`skipped` 是 `package-lock.json` 上的不动点集合，最终结果与遍历顺序无关（顺序只影响中间状态和报错时首先命中的路径），没有时间、哈希或无序集合被写进请求。

3. **有没有对应的自动检查，反向用例会不会真的失败？** 有 `test/tooling/toolchain.test.mjs:377-415`，由 CI 的 `tooling` 项目运行；整个用例在改前会因为第一条正向断言（`only-for-other-platform` 没装且平台匹配）而失败，所以“改前失败、改后通过”成立。但三条反向断言里只有第一条能区分新旧；第二条、第三条在旧实现下也会抛错并通过。另一个问题是该测试不在 `npm run check` 的步骤里，本地必过检查覆盖不到它。

4. **每个值的使用两端都能接受吗？** 本次没有新增导出字段、配置键或序列化格式；新增的 `dependents`、`absentOptional`、`skipped` 都是函数内部值。键空间一致：`resolve()` 返回的是含 `node_modules/` 的锁文件路径，`skipped` 和最终 `assert` 消费的也是同一批锁文件键；`auditInstalledDependencies` 的返回结构没有变化。真正不一致的是“允许缺席”的定义有两处：最终判定包含 `optional && peer`（第 280 行），传播种子不包含（第 262-266 行），见发现 1。测试 fixture 里新加的锁条目没有 `resolved`/`integrity`，但它们在测试中始终被视为“未安装”，不会进入已安装包的身份/摘要校验；如果将来把它们做成已安装目录，既有检查会按外部依赖完整性要求失败，这是测试夹具的预期约束，不是本次改动引入的产品问题。
