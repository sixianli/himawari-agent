# 复核结论

未发现会导致功能错误的高/中严重度问题。改动范围与作者描述基本一致；下面按严重度列出我读代码确认的问题，全部是测试质量或说法准确性问题。

## 一、读代码证实的问题

### 1. [低] 新增的“四个调用方都用新函数”用例只做源码字符串匹配，无法防止调用方保留旧的 `realpath` 路径
文件：`packages/testing/test/read-only-toolchain.unit.test.ts:105`

证据：
```ts
const source = await readFile(path.resolve(import.meta.dirname, "../../..", caller), "utf8");
expect(source, caller).toContain("@himawari-agent/testing/read-only-toolchain");
expect(source, caller).toContain("resolveReadOnlyToolchainPaths(");
```

问题：一个调用方即使同时保留 `await Promise.all(list.map((entry) => realpath(entry)))`，只要文件里也有新函数的 import 和调用，这个用例仍然通过。它不能证明函数的返回值真的赋给了 `readOnlyToolchainPaths`。

另外，用例标题说“every fixture that builds a read-only toolchain list”，但 `test/qualification/sandbox-install-restart-model.mjs:410-426` 仍然直接 `.map((entry) => realpath(entry))`。该文件属于 ADR 明确留给 PR 3 的范围，不是本改动的缺陷，但标题“every fixture”与事实不符。

建议：对四个夹具的入口做行为断言（例如断言生成的 binding 中路径来自新函数），或至少断言源码里不再出现 `map((entry) => realpath`；同时把标题改成“the four changed fixtures”。

### 2. [低] 默认 `/lib64` 用例用 `realpath` 判断“是否存在”，与实现的 `lstat` 语义不一致，特殊宿主上会假失败
文件：`packages/testing/test/read-only-toolchain.unit.test.ts:96`

证据：
```ts
const expected = await realpath("/lib64").then(
  async (resolved) => [await realpath("/usr/lib"), resolved],
  async () => [await realpath("/usr/lib")],
);
const result = await resolveReadOnlyToolchainPaths(["/usr/lib", "/lib64"], { dedupe: false });
expect(result).toEqual(expected);
```

实现是先 `lstat` 再 `realpath`（`packages/testing/src/read-only-toolchain.mjs:10-22`）。如果 `/lib64` 是悬空符号链接，按 ADR 的要求实现应抛错（正确），但这里的 `expected` 会走 fallback，变成“应当返回”，于是用例在正确实现上失败。测试结果依赖宿主 `/lib64` 的具体状态。

建议：用 `lstat("/lib64")` 决定是否期望跳过（只有 ENOENT 才期望跳过），或把默认 optional 值做成可注入的，并单独用一个真实宿主用例验证 `/lib64`。

### 3. [信息] 作者说法“单元测试 8 个”与当前文件不符
文件：`packages/testing/test/read-only-toolchain.unit.test.ts`

当前有 9 个 `it`：第 26、30、42、60、67、76、90、96、105 行。第 2 轮新增了第 105 行的调用方源码用例，所以现在是 9 个。`scripts/platform-assumptions.json` 里的 `8` 是 `/lib64` 在该文件里的出现次数，不是测试数量。

建议：把说明更新为 9 个，或注明“8 个”指第 1 轮提交时的数量。

### 4. [信息] 已静态导入 `realpath`，测试里仍多次动态导入
文件：`packages/testing/test/read-only-toolchain.unit.test.ts:36`

证据：
```ts
await import("node:fs/promises").then((fs) => fs.realpath(at("usr/bin"))),
await import("node:fs/promises").then((fs) => fs.realpath(at("usr/lib"))),
```
而第 1 行已经有 `import { ..., realpath, ... } from "node:fs/promises"`。仅是冗余，不影响正确性。

建议：直接使用静态导入的 `realpath`。

## 二、推测 / 未核实

- “`npm run check` 51 步通过”：本次工具限制无法运行命令，未核实。
- “两个集成测试在 x86 云容器里改动前后同样有 31 个失败”：未运行，未核实。
- “第 1 轮 4 条意见的判断见 `.agents/reviews/pr-460/round-1/judgments.md`”：该文件在当前稀疏检出中不存在，未核实。
- “ARM Ubuntu 没有 `/lib64`”：来自任务描述和 ADR，未在本机验证。

## 三、侧重检查

- **错误路径**：读了 `read-only-toolchain.mjs:10-22` 和四个反向用例。只有 `lstat` 抛出 `ENOENT` 时跳过 optional 条目；`EACCES`、`ENOTDIR`、`ELOOP` 等直接抛出。必选条目不走 `lstat`，由 `realpath` 抛错；悬空链接 `lstat` 成功、`realpath` 失败，也会抛错。与 ADR 描述一致。
- **不可信输入**：`entries`、`optional` 都是代码内固定列表，没有外部解析或字符串拼接。`optional.includes(entry)` 是精确字符串匹配，不会把 `/foo/lib64` 误判成 `/lib64`，用例第 90-94 行覆盖了这一点。
- **安全**：本改动只在校验阶段**删除**一个不存在的只读挂载项，不会扩大可读范围。下游 `sandbox-host-verifier.ts:252-255` 会对每个 `readOnlyToolchainPaths` 做 `lstat` 并校验真实路径；ARM 上若不删除 `/lib64`，这里本来就会失败，删除是必要的。
- **资源耗尽**：`Promise.all` 只作用于约 10 个写死的路径；即使未来输入变大也没有并发上限，但当前不是用户可控输入，不存在实际风险。
- **不可撤销操作**：无写文件、删除、签名、发布等操作；只读取 `lstat/realpath`。
- **规则/文档一致性**：ADR 0253 的“默认去重、调用方可关闭”与代码 `dedupe = true`、`mac-sandbox-deployment.ts` 传 `{ dedupe: false }` 一致；`scripts/platform-assumptions.json:15-16` 的计数与 `check-platform-assumptions.mjs:52-61` 的正则匹配结果一致（我实际数到 1 处和 8 处）。`.claude/rules/prompt-prefix.md` 未被改动，也没有涉及它约束的请求组装代码。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会。改动只涉及测试夹具、`packages/testing` 下的测试辅助函数、单元测试、包导出、ADR 和平台假设清单。没有改动系统提示、工具定义、历史消息或出口遮盖相关代码。

四个调用方生成的都只是沙箱配置里的 `readOnlyToolchainPaths`，例如：
- `test/fixtures/mac-sandbox-deployment.ts:136-160`
- `test/fixtures/product-path-harness.ts:1594-1596`
- `test/integration/prepared-file-runner.test.ts:266-286`
- `test/integration/sandbox-preparation-control.test.ts:582-592`

这些值不进入模型请求，`packages/runtime-pi`、`packages/prompt-catalog` 和请求组装路径都没有引用它。因此“只追加、每轮变化值只在最后一条消息”这条规则仍然成立；更准确地说，这个值根本不发给模型。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
不会。helper 本身没有时间、随机数或依赖前后文的处理；`Promise.all` 保持输入顺序，`Set` 保持首次出现顺序，输出顺序确定。

它的结果依赖宿主文件系统（`/lib64` 是否存在、`realpath` 结果），因此**跨机器**可能不同，但同一台机器同一状态下稳定，而且这些值不进入提示文本。将来如果把这份清单写进提示或证据文本，才需要担心跨平台字节差异。

### 3. 有没有自动检查，反向用例真的会失败吗？
有，但不完整。

- helper 层面的反向用例有效：必选条目缺失、optional 悬空链接、optional `lstat` 返回 `EACCES`，分别对应第 60、67、76 行；如果实现错误地吞掉这些错误，用例会失败。
- 去重和存在性也有覆盖：第 30、42 行覆盖 optional 缺失跳过、存在保留、`dedupe: true/false` 的差异。
- 缺口：第 105 行的调用方检查只是源码字符串匹配，不能证明返回值被真正使用；也没有自动用例逐项断言 x64 上四个调用方的最终清单与改动前完全相同（ADR 验收要求的一部分）。建议补一个行为级断言。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？
逐项核对如下：

- **`resolveReadOnlyToolchainPaths` 返回的 `string[]`**：
  - `sandboxHostBindingSchema` / `sandboxRuntimeQualificationSchema`：`packages/execution-contracts/src/sandbox-host-binding-v1.ts:92` 要求 `readOnlyToolchainPaths` 是 `sandboxHostPathSchema` 数组，第 21-38 行只要求“规范化绝对路径”，不要求包含 `/lib64`，也不要求去重；第 121-123 行要求可执行文件落在 `runtimeRoot` 或某个只读路径下，现有列表都包含 `runtimeRoot`/`bin`/`execPath`，满足。
  - `compileSandboxPolicy`：`packages/runtime-sandbox/src/policy.ts:94-116` 会再次 `canonicalPath`、去重并排序，接受任意字符串数组。
  - `verifySandboxHostFiles`：`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:252-255` 对每个路径 `lstat` 并校验；ARM 上 `/lib64` 不存在时必须从清单里去掉，否则会失败。这说明删除是必需且被下游接受的。
  - `sandboxHostFileState` / `sandboxHostIdentity`：`sandbox-host-verifier.ts:293-350` 同样逐项 `lstat`；`dedupe: false` 产生的重复项只会让状态行重复，没有唯一性校验，能接受。
- **新增包导出 `./read-only-toolchain`**：`packages/testing/package.json:9-12`，被四个夹具和类型检查使用；与已有 `./temporary-root` 的导出方式相同，`.d.mts` 和 `.mjs` 成对存在。
- **`OPTIONAL_TOOLCHAIN_PATHS`、`dedupe`、`io`**：只被 helper 自身和单元测试使用，没有外部后端校验。
- **`scripts/platform-assumptions.json` 新增的两项**：消费者是 `scripts/check-platform-assumptions.mjs:83-114`，要求“类别 → 文件 → 正整数次数”；实际统计为 `packages/testing/src/read-only-toolchain.mjs` 1 处、`read-only-toolchain.unit.test.ts` 8 处，和清单一致。

结论：没有发现 I-73 那类“生产端能产生、消费端校验不接受”的字段或 id 不匹配问题。
