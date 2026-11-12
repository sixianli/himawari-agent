## 结论摘要

未发现阻断性或高严重度问题。改动范围是测试夹具、测试、`packages/testing` 新工具和 ADR；没有触碰请求组装、系统提示、工具定义或出口遮盖。发现的问题主要是低严重度的设计取舍、测试稳定性和文档一致性。

## 发现（按严重度）

### 1. 低 — `/lib64` 在所有平台上都变成“可选”，x64 上缺失时测试不再报错

- 文件: `packages/testing/src/read-only-toolchain.mjs:11-17`
- 问题: 判断可选只看 `optional.includes(entry)`，没有平台/架构条件。因此 x64 主机如果缺少 `/lib64`，四处夹具都会静默跳过；而生产出包路径 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:343` 仍然对 `/lib64` 做 `realpath`。测试环境与生产校验会出现分歧。
- 证据:
  ```js
  if (optional.includes(entry)) {
    try {
      await io.lstat(entry);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  ```
  `OPTIONAL_TOOLCHAIN_PATHS` 固定为 `["/lib64"]`（第 3 行），四处调用方都没有传平台条件。
- 建议: 让可选集合由调用方按平台传入（例如只有 Linux ARM 才把 `/lib64` 标为可选），或者保留 x64 上“必须存在”的断言；至少为 x64 加一条反向用例，证明缺 `/lib64` 仍会失败。

### 2. 低 — ADR 说“取真实路径之后按原顺序去重”，但 `mac-sandbox-deployment` 关掉了去重

- 文件: `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:64`，`test/fixtures/mac-sandbox-deployment.ts:159`
- 问题: ADR 对函数的描述没有提“可关闭去重”；实际调用传了 `{ dedupe: false }`。这不是代码错误（作者说明要用它保持旧清单），但文档和实现不完全一致，后续维护者可能按 ADR 误以为该调用点会去重。
- 证据:
  ```md
  取真实路径之后按原顺序去重。
  ```
  ```ts
  { dedupe: false },
  ```
- 建议: 在 ADR 的 PR 1 条目里补一句：函数默认去重，`mac-sandbox-deployment` 为保持原清单显式关闭去重。或者把“保持原清单”写进该调用点的理由。

### 3. 低 — 默认 `/lib64` 的单元测试依赖宿主机状态，异常宿主上会误判

- 文件: `packages/testing/test/read-only-toolchain.unit.test.ts:96-104`
- 问题: 测试用 `lstat("/lib64")` 成功来决定期望长度为 2，但 `lstat` 不跟随符号链接：如果 `/lib64` 是悬空链接，`hasLib64` 为 true，而函数会因 `realpath` 失败而抛错，测试失败；如果 `/lib64` 与 `/usr/lib` 解析到同一路径，去重后长度为 1，也会失败。该用例没有真正验证“存在时取的是它的真实路径”。
- 证据:
  ```ts
  const result = await resolveReadOnlyToolchainPaths(["/usr/lib", "/lib64"]);
  const hasLib64 = await import("node:fs/promises").then((fs) =>
    fs.lstat("/lib64").then(
      () => true,
      () => false,
    ),
  );
  expect(result.length).toBe(hasLib64 ? 2 : 1);
  ```
- 建议: 改用注入的 `io` 或临时目录构造“存在/不存在”两种确定场景；若一定要测真实 `/lib64`，用 `realpath` 的 try/catch 计算期望，并断言具体值而不只是长度。

### 4. 低 — 没有自动检查确保四处调用方真的使用了新函数

- 文件: `packages/testing/test/read-only-toolchain.unit.test.ts:25-105` 以及四处调用点
- 问题: 单元测试只测 helper 本身。x64 上把四个调用点改回原来的 `realpath(...)`，现有 x64 测试仍会通过；ARM 又不在必过 CI 里（`ci/policy.json` 的 build/unit 成员只有 linux-x64，macos-arm64 还是 paused）。因此这个修复的行为没有被自动检查守住。
- 证据: `resolveReadOnlyToolchainPaths` 的测试只从 `../src/read-only-toolchain.mjs` 导入；四个调用方没有对应的“使用 helper”断言。`ci/policy.json:144-148` 的 `unit` 只按 include 匹配测试文件，不检查调用方式。
- 建议: 加一个轻量的工具检查（例如静态断言四个文件导入了该子路径且不再直接对 `/lib64` 做 `realpath`），或在其中一个夹具测试里用可控的临时根模拟 `/lib64` 缺失，验证调用方确实走新逻辑。

## 读代码证实的 / 推测的

读代码证实：

- `resolveReadOnlyToolchainPaths` 对可选条目先 `lstat`，ENOENT 跳过，其他错误原样抛出；随后 `realpath`，默认 `Set` 去重（`packages/testing/src/read-only-toolchain.mjs:9-22`）。
- 四个调用方确实都已改为新函数：`test/fixtures/product-path-harness.ts:1594-1596`、`test/fixtures/mac-sandbox-deployment.ts:136-160`、`test/integration/prepared-file-runner.test.ts:266-286`、`test/integration/sandbox-preparation-control.test.ts:582-592`。
- `mac-sandbox-deployment` 的 `dedupe: false` 与旧行为一致：旧代码是 `.map(realpath)` 后没有 `Set`。
- x64 上 `/lib64` 存在时，四处调用的输出顺序、重复项和旧代码一致（`Promise.all` 保序，`Set` 保首次出现顺序）。
- 下游能接受输出：`sandboxHostBindingSchema` 只要求 `readOnlyToolchainPaths` 是路径数组（`packages/execution-contracts/src/sandbox-host-binding-v1.ts:92`）；`compileSandboxPolicy` 会再次 canonicalize、去重并排序（`packages/runtime-sandbox/src/policy.ts:114-116`）；host verifier 对每个路径做 `lstat`（`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:252-255`）。
- 新文件在平台假设清单里的计数与正则一致：`packages/testing/src/read-only-toolchain.mjs` 1 处、`packages/testing/test/read-only-toolchain.unit.test.ts` 8 处（`scripts/check-platform-assumptions.mjs:52-61`，清单第 15-16 行）。
- `ci/toolchain-lock.json` 当前没有 `linux-arm64` 键，只有 `darwin-arm64` 和 `linux-x64`；ADR 删除“ARM 上暂时不能跑完整 `npm run check`”这一当前限制，和 PR 1 后的仓库状态不一致。

推测 / 未运行验证：

- 作者说 `npm run check` 51 步通过、两个集成测试改动前后同样 31 个失败，我没有运行，无法核实。
- ARM 上 bwrap 探测退出码 0、真实 `/lib64` 缺失场景，未在本机核实。
- 上述单元测试在异常宿主机（悬空 `/lib64`、`/lib64` 与 `/usr/lib` 同目标）是否失败，是读代码推断，未实测。

## 侧重检查

- 可选路径缺失：代码在 `lstat` 返回 ENOENT 时跳过，符合 ADR。
- 必选路径缺失：不会进入 `lstat` 分支，`realpath` 抛 ENOENT，符合“必选缺失报错”。
- 悬空符号链接：`lstat` 成功、`realpath` 抛 ENOENT；`realpath` 不在 try 内，因此会抛出，符合 ADR；有对应用例（测试第 67-74 行）。
- 权限错误：`lstat` 的 EACCES 原样抛出（第 76-88 行有用例）；`realpath` 的 EACCES 也不被捕获（第 21 行），会抛出，但没有专门用例。
- 可选路径拼错：因为可选判断是精确字符串匹配，`/lib64` 写错成别的路径时会作为必选路径报错；如果改的是 `OPTIONAL_TOOLCHAIN_PATHS` 里的字面量，拼错会被当成“缺失”静默跳过，这是该机制固有的取舍。
- 不可信输入：helper 只接收测试夹具的固定列表和 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME` 环境值，不从外部请求解析输入；没有新增注入面。
- 安全：仍然会对可选路径做 `realpath`，如果 `/lib64` 被替换成指向别处的链接，行为和改动前一样；新逻辑只增加“缺失则跳过”，没有放宽权限边界。
- 资源耗尽：列表固定且很短，`Promise.all` 并发数与原代码相同；没有生产暴露。
- 不可撤销操作：只有 `lstat`/`realpath` 读取，没有写操作。
- 文档一致性：ADR 与代码基本一致，但去重例外未写明；ADR 移除的 ARM 限制在当前 `ci/toolchain-lock.json` 上仍未实现，见发现 2 和 Q4。
- 遗留的 `/lib64` 真实路径调用：`test/qualification/sandbox-install-restart-model.mjs:420` 和 `scripts/delivery-mode/packet-template/measurement/probe/read-driver.mjs:43` 仍然对 `/lib64` 做 `realpath`；它们属于作者说明里留给 PR 3 的探针/模板副本，不在本次 `npm test` 的四个夹具里。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动没有触及 `packages/prompt-catalog`、请求组装、系统提示、工具定义、历史或出口遮盖；新增值只是测试夹具写入 capability deployment 快照的沙箱只读路径列表（例如 `test/fixtures/product-path-harness.ts:1594-1596` 的 `readOnlyToolchainPaths`），不是发给模型的内容。没有新增每轮会变的值，因此“只在末尾追加”的规则不受影响。依据规则第 27-29、35 条。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。新代码没有时间、随机数或无序集合：输出按输入顺序（`Promise.all` 保序），去重用 `Set` 保首次出现顺序（`read-only-toolchain.mjs:21-22`）。结果依赖主机文件系统（某台机器上 `/lib64` 是否存在），但同一台机器、同一输入下是确定的；而且这些列表不进入模型请求。没有发现同一段模型可见文字在不同请求间变字节的路径。

3. **有没有对应的自动检查，反向用例是否会真的失败？**
   有：8 个单元测试，以及 `check:platform-assumptions` 的清单校验。按读代码判断，反向用例是有意义的：
   - 悬空链接用例（第 67-74 行）会让“把 `realpath` 的 ENOENT 也当成缺失跳过”的实现失败；
   - EACCES 用例（第 76-88 行）会让“吞掉所有错误”的实现失败；
   - 精确匹配用例（第 90-94 行）会让“按后缀/子串判断可选”的实现失败；
   - 必选缺失用例（第 60-65 行）确保 `optional: []` 时不会被跳过。

   但这些测试只覆盖 helper，不能保证四处调用方继续使用它；x64 上把调用方改回去仍会通过，ARM 又不在必过 CI 里。我没有实际运行，无法证实“真的会红”，只能确认用例逻辑能区分这些错误实现。另一个弱点是第 96-104 行依赖宿主机真实 `/lib64`。

4. **每个产生或修改的值，使用它的一端都能接受吗？**
   - `OPTIONAL_TOOLCHAIN_PATHS = ["/lib64"]`：产生于 `read-only-toolchain.mjs:3`，用于默认参数第 7 行和测试第 27 行；使用方式只是 `includes` 精确比较，不需要额外校验。
   - `optional` / `dedupe` / `io` 选项：产生于各调用方；`dedupe: false` 只由 `mac-sandbox-deployment.ts:159` 传入，helper 第 22 行按布尔值分支；下游 schema 没有“必须去重”的约束，`compileSandboxPolicy` 会再去重排序，所以两端兼容。
   - 路径数组：产生于四个调用方；使用方是 `sandboxHostBindingSchema`（`sandbox-host-binding-v1.ts:92`）、`sandbox-host-verifier.ts:252-255` 和 `compileSandboxPolicy`（`policy.ts:114-116`）。helper 返回的都是 `realpath` 后的绝对路径，下游都能接受。x64 输出与旧代码一致；ARM 少掉不存在的 `/lib64` 后，下游没有“必须包含 `/lib64`”的检查。
   - 包导出 `./read-only-toolchain`：产生于 `packages/testing/package.json:9-12`，使用方是四个 import；类型声明 `read-only-toolchain.d.mts` 与实现签名一致，typecheck 会覆盖。
   - 平台假设清单：产生于 `scripts/platform-assumptions.json:15-16`，使用方是 `check-platform-assumptions.mjs` 的 `lib64` 正则和计数比较；我按正则逐处数过，1 和 8 匹配。
   - ADR 里的工具链锁条目：ADR 第 97 行说 `ci/toolchain-lock.json` 会有 `linux-arm64` 键，但当前锁文件没有；这是 PR 2 的待产出值，不是本次代码产生/使用的值。ADR 删除当前“不能跑完整 check”的限制，会造成文档与现状不一致，建议在 PR 2 合并前保留或改写。

## 未核实

- 未运行 `npm run check`、`npm test`、单元测试或两个集成测试，无法核实“51 步通过”和“31 个失败”。
- 未在 aarch64 实机核实 `/lib64` 缺失、bwrap 探测、真实沙箱行为。
- 未读取 `.agents/reviews/pr-460/briefs/brief-round1.md`（检出中没有该文件，git 显示为二进制），不影响以上代码结论。
