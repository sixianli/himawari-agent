# 复核结论（PR #418 第 2 轮增量 `9b9d0da..07f5a93`）

结论先说：本增量只有测试改动，没有生产代码改动，因此不会影响模型请求的字节或 KV 缓存前缀。作者两条说法大部分成立，但有两处需要指出：v0.2 测试的期望值现在和检查脚本“同源同算法”，无法独立发现两边一起算错；另外，作者说已删除的 `setRuntimeApiKey` / `removeRuntimeApiKey` 仍残留在另一个测试里，并且相关断言仍是永真。

## 读代码证实的问题

### [中] v0.2 覆盖测试照抄检查脚本的算法，脚本自身算错时测试仍会通过

- 文件：`test/integration/v0.2-coverage.test.ts:53`、`scripts/check-v0.2-coverage.mjs:330`
- 问题：测试不再核对“81”这个事实，而是从同一份 manifest 重新算出脚本即将输出的数字。两边使用同一数据源和等价算法，检查脚本若把计数逻辑写错，测试会一起错、仍然通过。
- 证据：

```ts
// test/integration/v0.2-coverage.test.ts:53-63
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableCoverageManifest;
const acceptanceIds = new Set(
  manifest.specifications.flatMap((specification) =>
    specification.acceptances.map((acceptance) => acceptance.id),
  ),
);
...
`v0.2 coverage check passed for ${manifest.requirements.length} requirements, ${acceptanceIds.size} acceptance IDs, and ${manifest.specifications.length} Specs/Plans.`,
```

```js
// scripts/check-v0.2-coverage.mjs:330-335
return {
  acceptanceCount: acceptanceIds.size,
  errors,
  requirementCount: manifest.requirements.length,
  specificationCount: specificationCodes.size,
};
```

```js
// scripts/check-v0.2-coverage.mjs:348-350
console.log(
  `v0.2 coverage check passed for ${result.requirementCount} requirements, ${result.acceptanceCount} acceptance IDs, and ${result.specificationCount} Specs/Plans.`,
);
```

补充核对：当前数据本身是对的。`test/fixtures/v0.2/coverage-manifest.json:10-335` 的 `requirements` 确实是 81 项；`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:76-166` 的覆盖矩阵我也数了，正好 81 行。问题不在当前数据，而在测试失去独立性。

另外有一个小差异：测试用 `manifest.specifications.length`，脚本用 `specificationCodes.size`。只有存在重复 `code` 时两者不同，而重复会让脚本报错、`status` 不为 0，所以成功路径下不会误判；但测试并没有直接验证这个不变量。

- 建议：至少增加反向用例，例如在临时 manifest 里删掉一个 requirement，断言脚本报 `coverage manifest is missing V02-…`；或改掉一个 acceptance id，断言脚本报 id 不一致。这样 81 这个数字才真正锚定在 S0 覆盖矩阵这个独立来源上，而不是测试和脚本互相对照。

### [低] 声称删除的死方法仍留在 `configured-model-binding.compat.test.ts`，且断言永真

- 文件：`packages/runtime-pi/test/configured-model-binding.compat.test.ts:57`、`:83`、`:258`、`:261`
- 问题：作者说删掉产品代码不再调用的 `setRuntimeApiKey` / `removeRuntimeApiKey`。生产代码确实不再调用（全仓搜索只命中这个测试文件），但假运行时和两条断言还留着。由于生产代码不会调用这些方法，`expect(runtime.apiKeys).toEqual([])` 和 `expect(runtime.removedProviders).toEqual([])` 永远为真。
- 证据：

```ts
// packages/runtime-pi/test/configured-model-binding.compat.test.ts:57-58
readonly apiKeys: { readonly providerId: string; readonly value: string }[] = [];
readonly removedProviders: string[] = [];

// :83-91
async refresh(): Promise<void> {}
async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
  this.apiKeys.push({ providerId, value: apiKey });
}
async removeRuntimeApiKey(providerId: string): Promise<void> {
  this.removedProviders.push(providerId);
}

// :258, :261
expect(runtime.apiKeys).toEqual([]);
...
expect(runtime.removedProviders).toEqual([]);
```

- 建议：和另外两个测试一样删掉这些方法、数组和断言；如果要保留，就应该在生产代码里真的调用它们，或者改成断言 `refresh` 的实参。否则“已清理”的说法不完整。

### [提示] refresh 断言实际记录的是初始化时那一次调用，不是 close 的行为

- 文件：`apps/agent-service/test/production-model-composition.unit.test.ts:240`
- 证据：

```ts
// :240-241
await composition.close();
expect(runtime.refreshes).toEqual([{ allowNetwork: false }]);
```

而生产代码的 refresh 在初始化阶段：

```ts
// packages/runtime-pi/src/configured-model-binding.ts:403
await runtime.refresh({ allowNetwork: false });
```

- 说明：断言本身是有效的。如果生产代码不调用 refresh、传 `allowNetwork: true` 或传别的参数，测试会失败；如果 close 额外触发一次 refresh，数量变成 2 也会失败。但断言写在 `close()` 之后容易让人误以为它在验证 close。建议把它移到 `resolve()` 之后，或明确写成“初始化一次、close 后仍只有一次”，以便读代码的人知道它守的是什么。

## 推测 / 未核实

- **未核实**：Pi SDK 的 `ModelRuntime.refresh` 是否真的接受 `{ allowNetwork?: boolean }`。当前 checkout 没有 `node_modules`，无法读 `@earendil-works/pi-coding-agent` 的类型；只能确认生产代码 `configured-model-binding.ts:403` 是按这个形状调用的。
- **未运行**：受工具限制不能跑测试。作者说 `npm run check`、4 个测试文件通过，我无法验证，只能做静态检查。
- **未核实**：`.agents/reviews/pr-418/round-1/*` 的内容。该路径被策略拒绝读取，无法核对第 1 轮意见原文；上述判断只基于当前代码和作者描述。
- **推测**：如果未来有人同时修改 `check-v0.2-coverage.mjs` 的计数逻辑和 `v0.2-coverage.test.ts` 的期望算法，而没有改 S0 覆盖矩阵，两个文件会一起通过；这正是上面第一条指出的风险。

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则与代码一致性”逐项看了相关路径：

- **错误路径**：`v0.2` 测试保留了 `rejects a stale PRD digest` 和 `rejects an acceptance without a verification entrypoint` 两条反向用例（`test/integration/v0.2-coverage.test.ts:67-92`），它们断言 `status === 1` 和具体错误文本，不是永真；但新增的计数断言没有对应的反向用例。ONNX 测试里原有的 `[P3-1] REVERSE` 错误路径未被改动。
- **不可信输入 / 命令执行**：`runChecker()` 使用 `spawnSync(process.execPath, [checkerPath, ...])`，参数数组、无 shell，路径是仓库内常量；`changedManifest()` 只在 `mkdtemp` 目录里写 JSON。ONNX 测试用 `python3 -I`（隔离环境）、显式 `run_name` 避免执行 `main()`，并加了 `timeout: 30_000`，比之前的无超时版本更安全。
- **安全**：`refresh({ allowNetwork: false })` 这条断言的语义是“注册模型时不联网刷新”，方向是对的；但它只覆盖被断言的 `piModels` 实例，`modelTransportFor()` 里还创建了另一个 `ConfiguredPiModelBindingPort`（`production-model-composition.ts:343`），该实例在当前测试里没被初始化，所以没有覆盖到，属于测试覆盖边界而非新增漏洞。
- **资源耗尽**：ONNX 子进程新增 30 秒超时，是改进。`spawnSync` 本身仍未设超时，但检查脚本只读本地文件，风险与本次改动无关。
- **不可撤销操作**：没有新增写仓库或生产状态的操作；临时目录由 `afterEach` 清理，Python 提取只读 `SOURCES`。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的“已发内容只追加”没有被本改动触碰；`docs/incidents-and-gates.md` 的 I-73 教训在 v0.2 测试上仍有残余风险——测试只校验 manifest 与脚本输出的一致性，没有独立校验 S0 覆盖矩阵这一端，虽然脚本本身做了这一端校验。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`git diff --name-only 1a68a5a..07f5a93` 列出的全部是 `.agents/reviews/pr-418/**`、`apps/agent-service/test/*.ts`、`packages/platform-node/test/*.ts`、`test/integration/v0.2-coverage.test.ts`，没有系统提示、工具定义、历史消息、遮盖或 prompt 组装代码。发给模型的内容仍然只由原生产代码决定，本改动只在测试进程里运行；没有改动“末尾追加”或“每轮变化值放最后一条消息”的行为。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。没有生产序列化、遮盖、排序或时间字段改动。新测试里的 `Set`、`Object.values`、`runpy` 输出只存在于测试进程，不进入模型请求。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有对应检查，但强度不一：
   - `production-model-composition` 的新断言可失败：不调用 refresh、参数不同、数量不是 1 都会失败。
   - ONNX 的新断言可失败：`files` 缺模型/外部数据文件、摘要不是 64 位小写十六进制都会失败；不过 `Object.values(files)` 只检查值格式，不核对摘要与实际文件内容。
   - `v0.2` 的新断言能失败于“脚本输出字符串和 manifest 数值不一致”，但如前所述，它和脚本同源，不能独立发现两边一起算错。现有反向用例（过期 digest、缺 verification entrypoint）仍然有效；本次没有为计数本身新增反例。**未运行测试**，以上均为静态判断。

4. **每个新值/修改值，产生它的地方和使用它的地方都能接受吗？**
   - `{ allowNetwork: false }`：生产端产生于 `packages/runtime-pi/src/configured-model-binding.ts:403`，测试 fake 在 `production-model-composition.unit.test.ts:117-118` 记录并断言。两端形状一致；Pi SDK 实际签名**未核实**。
   - `manifest.requirements.length` / `acceptanceIds.size` / `manifest.specifications.length`：产生于 fixture `coverage-manifest.json:10-335` 和测试自身：`check-v0.2-coverage.mjs:331-334` 使用同源数据。成功路径下一致；规格数在重复 code 时会与脚本的 Set 计数不同，但那种情况脚本已经 `status=1`。
   - `requirements` 数量 81：fixture 的 81 项与 S0 覆盖矩阵 81 行一致，我逐行核对过。验收编号 53 未独立逐个数，但脚本的 Set 与测试的 Set 在成功路径下等价。
   - Python `SOURCES[*].files` 的 key 和摘要：产生于 `scripts/embedding-models/build-artifact.py:21-29`、`:38-45`、`:54-62`，使用于 `local-onnx-embedding.unit.test.ts:339-343`。`files` 确实包含 `model` 和 `externalData` 的路径，摘要是 64 位十六进制；测试只做包含和格式检查，不检查多余 key 或摘要真实性。
   - `run_name='build_artifact_sources'` 与 `timeout: 30_000`：仅测试使用，Python `runpy.run_path` 和 Node `execFileSync` 都接受这种用法。
   - 被删除的 `setRuntimeApiKey` / `removeRuntimeApiKey`：生产端已无调用者，但 `configured-model-binding.compat.test.ts` 里仍保留，见上面的低严重度问题；这两个名字目前没有任何生产消费者。
