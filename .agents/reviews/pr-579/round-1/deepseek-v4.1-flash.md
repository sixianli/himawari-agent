结论：改动本身正确，五个键与 `IconName` 及已提交图片集两端对得上；没有发现高严重度问题。主要问题是缺少自动检查，以及生成脚本本身“先删后建”的既有风险。

### 1. 中 — 没有自动检查，删掉新增的任何一行都不会让检查失败
**文件：行** `package.json:35`、`clients/apple/scripts/check-design.mjs:95-123`、`clients/apple/scripts/icons.json:8,30,34,71,84`
**问题** 这次修的是“配置漏项导致重新生成时删资源”，但仓库仍没有任何检查保证 `icons.json` 与 `IconName`、已提交图片集一致。同类漏项以后还会发生，本次修复也无法用反向用例证明。
**证据（读代码证实）** 全仓库引用 `icons.json` 的只有 `clients/apple/scripts/make-icons.mjs:12` 和 `clients/apple/README.md:79-85`；`test/tooling` 下没有图标相关测试。`check:apple-design` 执行的 `checkDesign` 只扫描页面颜色/尺寸和 tokens 是否最新（`check-design.mjs:95-123`），完全不读 `icons.json`。因此删掉 `"bolt": 1.6` 这一行，现有检查不会失败。
**推测** 作者所说的“`npm run check` 与干净 main 同样 10 步环境性失败”无法离线复现；即使属实，也不包含本改动的针对性检查。
**建议** 加一个轻量 tooling 测试：解析 `Icon.swift` 的 `IconName` rawValue 与 `icons.json`（含 `@` 到 `-` 的命名规则和 `custom`），断言双向一一对应；再断言每个名字都有 `.imageset/Contents.json` 和 SVG。这个测试在修复前会失败、修复后通过。另可在 CI 用锁定的 3.35.0 运行生成器并断言 `git diff` 为空。

### 2. 中 — 生成脚本先删整个 Icons.xcassets，再校验源图标；任一新项不匹配会留下残缺目录
**文件：行** `clients/apple/scripts/make-icons.mjs:14-27`
**问题** 本 PR 的正确性依赖五个名字在 `@tabler/icons@3.35.0` 里真实存在且格式符合脚本要求，但脚本在读取任何源 SVG 之前就把整个资源目录删掉；一旦新名字写错或包版本不符，进程抛错时已提交的图标已被删除，只剩部分重建结果。这是不可撤销操作，且本 PR 没有消除。
**证据（读代码证实）**
```js
14: rmSync(catalog, { recursive: true, force: true });
15: mkdirSync(catalog, { recursive: true });
...
24: const source = readFileSync(join(packageDir, "icons", "outline", `${sourceName}.svg`), "utf8");
25: if (!source.includes('stroke-width="2"') || !source.includes('stroke="currentColor"')) {
26:   throw new Error(`unexpected outline icon format: ${name}`);
```
循环从 `make-icons.mjs:43` 才开始，删除发生在循环和任何校验之前。
**推测** 五个名字若与 3.35.0 实际文件名有一个不符，就会触发上述路径；作者只做了手工验证，没有自动保障。
**建议** 先把所有源图标读入内存并完成格式校验，再删除目录写入；或生成到临时目录，全部成功后再原子替换。配合第 1 条的重生成 diff 检查，可以同时防漏项和防包版本漂移。

### 3. 低 — 三个新增项的生成结果与已提交 SVG 字节不同，下一次重生成会产生计划外改动
**文件：行** `clients/apple/scripts/icons.json:30,34,71`；已提交的 `device-laptop.svg`、`device-watch.svg`、`qrcode-off.svg`
**问题** 作者自述 `bolt`、`upload` 与已提交文件逐字相同，另外三个只是路径写法不同。若属实，任何人按 README 重新生成时都会改写这三个已提交 SVG，虽然图形可能等价，但违反“重新生成是无操作”的直觉，也说明仓库里的 SVG 不是当前脚本/版本的真实输出。
**证据（读代码证实）** 已提交 `device-laptop.svg:14` 使用 `...l0 -8` 这类路径写法；`bolt.svg`、`upload.svg`、`device-watch.svg`、`qrcode-off.svg` 的 `stroke-width` 都是 `1.6`。作者关于“图形等价”的说法我无法离线验证，因为容器里没有 `@tabler/icons` 包，不能运行生成器。
**推测** 另外三个文件可能来自不同 Tabler 版本或人工调整；重生成后视觉一致的概率高，但没有证据。
**建议** 合并后在 Mac/有网络环境用 3.35.0 重新生成一次，确认三个文件的实际变化并提交真实输出；或至少在文档中写明这三个会发生变化，并让 CI 的生成 diff 检查来锁住后续一致性。

## 侧重检查

- **错误路径**：检查了 `make-icons.mjs:14-27`，删除发生在读取和格式校验之前，见意见 2。
- **不合规范/不可信输入**：`icons.json` 是仓库内受控文件；键被直接拼进 `${sourceName}.svg`，若将来允许外部输入会有路径穿越风险，当前不构成攻击面。
- **安全**：改动不联网、不读密钥、不接触模型数据或运行时请求；无新增安全问题。
- **资源耗尽**：生成 84 个小 SVG，规模固定且有界；未发现无界循环或大内存分配。
- **不可撤销操作**：`rmSync(catalog, { recursive: true, force: true })` 是唯一不可撤销点，见意见 2。
- **规则/文档一致性**：`README.md:79-88` 的流程（先改 `icons.json`、再改 `IconName`、用 3.35.0 生成）与代码一致；`Licenses/tabler-icons.version` 也是 `3.35.0`。本 PR 只改 JSON，符合其“不动 SVG 和 Swift”的约束。
- **集合完整性（读代码证实）**：PR 后 `icons.json` 的 84 个键生成的名称与仓库中的 84 个 `.imageset` 一一对应；新增的五个正是此前缺少的五个，不会再有图片集被生成脚本丢掉。

## 必答问题

1. **不会改变模型已经见过的请求开头。** `icons.json` 是离线资源生成清单，不进入模型请求组装：全仓库只有 `make-icons.mjs:12` 和 README 引用它。它不涉及系统提示、工具定义、历史消息、遮盖结果或消息追加顺序，因此不存在“只在末尾追加”的问题，也没有把每轮变化的值放进开头。
2. **不会让同一段文字在不同请求里变成不同字节。** 该文件不参与任何请求序列化；它是静态 JSON，没有时间、随机数或依赖前后文的字段。生成器按 `Object.entries` 的文件插入顺序逐项写独立文件，结果确定；新增条目也不会改变已有条目的字节。三个图标与生成器输出的差异是构建产物一致性问题，不是不同请求间的字节漂移。
3. **没有对应的自动检查，反向用例不会失败。** 删掉任意一个新增键，`check:apple-design` 和其他现有检查都不会报错，因为没有检查读取 `icons.json`；`test/tooling` 下也没有图标测试。详见意见 1。建议补一个双向一致性测试，并让它在修复前失败。
4. **逐个核对，新增值的使用方都能接受。** 产生端 `icons.json` 的五个键生成名称 `bolt`、`device-laptop`、`device-watch`、`qrcode-off`、`upload`；使用端 `Icon.swift:11,30,32,68,81` 的 rawValue 与之逐字相同；仓库中五个 `.imageset/Contents.json` 和 SVG 均存在；实际使用处 `DevicePages.swift:18-19,252` 和 `SettingsRootView.swift:72,79` 都通过 `IconName` 最终调用 `Image(name.rawValue, bundle: .module)`。两端字符串一致，没有发现不接受的地方。**未核实**：五个键在 `@tabler/icons@3.35.0` 的 outline 源文件是否全部存在且包含脚本要求的 `stroke-width="2"`、`stroke="currentColor"`，以及作者“五个都生成、bolt/upload 逐字相同”的说法；容器无该包且不能运行脚本。这里正是 I-73 类风险的下游校验点，应由第 1 条建议的自动检查或 CI 生成来保证。
