## 结论

未发现高、中严重度的问题：这个 PR 只改了测试夹具、测试工具链和文档，没有碰系统提示、工具定义、历史消息、遮盖或生产沙箱脚本。下面是我读代码证实的低严重度问题，以及作者说明里与代码不一致的地方。

### 读代码证实的

1. **低｜`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:96`｜ADR 的“后果”仍写着 x64 沙箱运行时摘要和整个上线包哈希会变，但本 PR 没有改任何生产运行时文件**
   - 证据：ADR 原文“新函数是新代码，x64 上沙箱运行时的摘要和整个上线包的哈希会变”。实际 `scripts/package-node-runtime.mjs:13-30` 的 `internalRoots` 不含 `packages/testing`，`scripts/ci/verify-artifact.mjs:185-186` 还明确拒绝产物里出现 `runtime/node_modules/@himawari-agent/testing/`。`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:104` 的 `digestSandboxRuntime(root, ...)` 摘要对象是 runtime 目录，不是测试文件。本次 diff 里没有任何 runtime/生产沙箱文件。
   - 建议：把这句改成“x64 生产运行时摘要不变；只新增了测试包文件和测试夹具”，或删掉与本次范围不符的“上线包哈希会变”。

2. **低｜`test/tooling/prod-read.test.mjs:38-49`｜作者说“测试库改为不落盘”，代码里数据库仍然落盘**
   - 证据：
     ```js
     const file = path.join(directory, "product.sqlite");
     const database = new DatabaseSync(file);
     database.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY");
     ```
     `mkdtempSync` + `join(directory, "product.sqlite")` + `new DatabaseSync(file)` 仍然创建并写入磁盘文件；改成内存的只是回滚日志（`journal_mode = MEMORY`），另外关掉了 `synchronous`，再加一个事务。子进程通过同一文件路径读取，本来也不可能真正用 `:memory:`。
   - 建议：作者说明改成“日志放内存、关同步、批量插入一个事务”，不要写“不落盘”。

3. **低（可以更好）｜`packages/testing/test/read-only-toolchain.unit.test.ts:107-118`｜“四个调用方都用它”的检查只做字符串包含，不能发现参数用错**
   - 证据：
     ```js
     expect(source, caller).toContain("@himawari-agent/testing/read-only-toolchain");
     expect(source, caller).toContain("resolveReadOnlyToolchainPaths(");
     ```
     它不检查调用方是否误传 `optional: []`、或该用默认去重的地方传了 `dedupe: false`。当前四个调用方的参数我逐个读过，是对的；这只是自动检查的盲区。
   - 建议：让检查至少断言调用点附近没有 `optional:` 覆盖，或者改成导入夹具后做行为断言；不加也不影响当前正确性。

4. **低（可以更好，推测边界）｜`packages/testing/src/read-only-toolchain.mjs:11`｜可选路径按原始字符串精确匹配**
   - 证据：`if (optional.includes(entry))`。如果以后调用方传 `"/lib64/"` 或 `"/usr/lib64"` 这类等价写法，就会被当成必选，`realpath` 仍会在无 `/lib64` 的 ARM 上抛错。当前四个调用方都恰好传 `"/lib64"`，没有当前 bug。
   - 建议：在比较前做 `path.normalize`，或在 ADR/注释里明确“可选名单必须与条目逐字相同”。

### 推测（未完全核实）

- “整个上线包的哈希会变”取决于“上线包”是否还包含整棵源码树；我只核实了 Node runtime 产物明确排除 `packages/testing`，没有核实所有交付打包清单。
- 我无法运行测试，也不能确认 ARM 上完整 `npm test` 的结果；另外仓库工作树里没有 `.agents/reviews/pr-460/round-*/judgments.md`，用 `git show` 读这些记录也被拒绝，所以前几轮判过“可以更好”的具体条目我没核对到。

## 侧重检查

- **错误路径**：`read-only-toolchain.mjs:10-22` 只对可选条目的 `lstat` `ENOENT` 跳过，`EACCES` 等直接 `throw`；可选条目若是悬空符号链接，`lstat` 成功、`realpath` 抛 `ENOENT`，也会报错。对应测试在 `read-only-toolchain.unit.test.ts:57-91`，反向用例会失败。
- **不合规范/不可信输入**：所有调用方传的都是静态路径列表，没有外部输入；`optional`/`dedupe`/`io` 由调用方控制。没有发现注入或路径穿越被放宽。
- **安全边界**：跳过只发生在“生成清单”这一层。消费端 `packages/runtime-sandbox/src/policy.ts:114-116` 仍对每个条目做 `canonicalPath`（`realpath` 必须等于自身、`stat` 必须是目录或文件），`packages/execution-contracts/src/sandbox-host-binding-v1.ts:92` 也仍要求规范绝对路径。权限校验没有被放宽。
- **资源耗尽/不可逆操作**：单次最多处理十几个路径，`Promise.all` 并发量与改动前相同；没有删除、覆盖等不可逆操作。
- **规则/文档和代码一致性**：ADR 的四处调用方与实际 import 一致；`scripts/platform-assumptions.json` 的 `1`/`9` 我按检查脚本的 `/(?:\/|["'])lib64(?![\w-])/g` 逐行核对过，确为 1 和 9。唯一不一致是上面第 1 条的 ADR 后果句。
- **其他 `/lib64` 调用方**：`cloud-seal.mjs`、探测脚本、`scripts/operations/` 封装脚本仍对 `/lib64` 直接 `realpath`，但 `docs/backlog/BL-20261004-001...md:22` 记录这些脚本当前不被测试/CI 调用，ADR 也把它们留给 PR 3，与本 PR 的范围说明一致。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动没有触碰任何请求组装代码：变的是 `packages/testing` 的测试辅助、根目录测试夹具/集成测试、`test/tooling` 用例和 ADR/平台假设清单。发给模型的内容仍然只追加，每轮会变的值仍然只能在最后一条消息里；`check:prompt-prefix` 所检查的路径不受影响。这一点依据代码里没有任何 prompt/request 组装文件出现在 diff 中。
2. **不会让同一段文字在不同请求里变成不同字节。** 本改动产生的唯一序列化相关值是沙箱只读路径列表，不是模型文本。函数内部顺序确定：循环按输入顺序、`Promise.all` 保序、`Set` 保插入顺序；没有时间、随机数或无序集合。`/lib64` 是否存在只随主机变化，同一主机每次结果相同；而且下游 `compileSandboxPolicy` 还会再 `sort` + 去重。
3. **有自动检查，反向用例确实会失败。** 新单元测试共 9 条，位于 `packages/testing/test/read-only-toolchain.unit.test.ts`，被 `ci/policy.json:147` 的 `packages/**/*.unit.test.ts` 收进 unit 项目。反向用例覆盖：必选路径缺失、可选条目悬空链接、可选条目 `lstat` 被拒（`EACCES`）、“拼成像可选的必选路径”不会被跳过（`57-91` 行）。平台假设门禁也覆盖了清单计数。弱点是上面第 3 条：四个调用方的检查只是字符串匹配。
4. **每个新值都有使用方且两端校验可接受。**
   - 新导出 `./read-only-toolchain`（`packages/testing/package.json:9-12`）→ 四个 import 点存在，写法与既有 `./temporary-root` 一致。
   - `resolveReadOnlyToolchainPaths` 返回的字符串数组 → `compileSandboxPolicy` 的 `canonicalPath`（要求 `realpath` 后与自身相等且存在）能接受；`sandboxHostBindingSchema` 要求规范绝对路径，也能接受。
   - `scripts/platform-assumptions.json` 新增的两个清单项 → 检查脚本按类别/文件计数，实测与源码匹配（`read-only-toolchain.mjs` 1 处，unit test 9 处）。
   - `dedupe` 两种取值 → 四个调用方分别保持原有语义：三个原来用 `Set` 的走默认去重，`mac-sandbox-deployment.ts` 原来不去重所以显式 `dedupe: false`；下游策略编译仍会再去重排序，不会因重复条目改变权限行为。
