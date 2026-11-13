# 复核结论

改动范围经 `git diff --name-status` 核实只有 3 个文件，全部是测试：`apps/agent-service/test/production-model-composition.unit.test.ts`、`apps/agent-service/test/model-payload-cleanup.unit.test.ts`、`packages/platform-node/test/local-onnx-embedding.unit.test.ts`。没有产品代码改动。未发现会改变生产请求或阻断合并的问题；下面几条是测试保真度和验证证据方面的问题，按严重度排列。

## 发现（按严重度从高到低）

### 低 1：ONNX 测试从静态解析改为执行整个构建脚本，当前虽无副作用，但把未来的顶层副作用引入单测
- 文件:行：`packages/platform-node/test/local-onnx-embedding.unit.test.ts:303`
- 问题：新写法执行整个 `build-artifact.py`，而不再只做静态解析。当前确实不会下载：`main()` 只在 `__main__` 下调用，所有网络/写文件路径都在 `main → build → obtain/download` 之后。但以后脚本只要出现任何模块级副作用（下载、写文件、启动进程），这个单测都会跟着执行；`execFileSync` 也没有超时。
- 证据（亲自读到）：
  ```ts
  "import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])['SOURCES']))",
  ```
  ```py
  if __name__ == "__main__":
      main()
  ```
  `build-artifact.py:8` 只导入 `urllib.request`，没有模块级网络调用；`:175-181` 的 `main()` 才进入 `build()`。
- 建议：短期在 `execFileSync` 上加 `timeout`，并给 `runpy.run_path` 传一个显式 `run_name`（如 `"build_artifact_probe"`）表明不执行主程序；更稳妥的是把 `SOURCES` 拆成纯数据模块或 JSON，让测试仍能静态读取，避免执行代码。

### 低 2：两个假运行时的 `refresh` 是空实现，不能证明真实注册后的刷新语义
- 文件:行：`apps/agent-service/test/production-model-composition.unit.test.ts:105-117`、`apps/agent-service/test/model-payload-cleanup.unit.test.ts:44-48`
- 问题：假运行时在 `registerNativeProvider` 里立刻把模型放进 `models`，`refresh()` 什么也不做。产品代码是“注册 → `refresh({allowNetwork:false})` → 检查 `getModel`”（`configured-model-binding.ts:393-408`）。因此这些测试对“provider.id / model.id 的映射”仍是有意义的，但无法发现产品代码删掉 `refresh`，也不复刻真实 Pi 运行时在刷新后才可用的认证/baseUrl 注册行为。若产品回退到旧的 `registerProvider`，假运行时会因缺少该方法而失败，这一点反向覆盖是有效的。
- 证据（亲自读到）：
  ```ts
  for (const model of provider.getModels()) {
    ...
    this.models.set(`${providerId}:${id}`, model);
  }
  async refresh(): Promise<void> {}
  ```
  ```ts
  await runtime.refresh({ allowNetwork: false });
  for (const descriptor of this.#descriptors) {
    if (runtime.getModel(descriptor.provider, descriptor.model) === undefined) {
  ```
- 建议：让假运行时记录 `refresh` 的调用参数并断言 `{ allowNetwork: false }`；如果希望更贴近真实行为，可让 `getModel` 在 `refresh` 前返回 `undefined`。真实 Pi 路径已有 `packages/runtime-pi/test/configured-model-binding.compat.test.ts` 的真实运行时用例兜底，因此这不是阻断问题。

### 低 3：测试现在执行了 `files` 字典推导式，却仍然从不校验 `files` 的内容
- 文件:行：`packages/platform-node/test/local-onnx-embedding.unit.test.ts:292-338`
- 问题：测试名说“pins the same upstream files”，但断言只比较 `repository`、`revision`、`dimensions`、`model`、`externalData`、`quantization`（`local-onnx-embedding.unit.test.ts:319-338`），完全不看 `SOURCES[].files`。本次被迫改用 `runpy` 的原因正是 `files` 里的字典推导式；如果推导式把文件名和摘要写反、漏文件或写错文件集，测试仍会通过。脚本自己的消费者是 `for relative, expected in sorted(source["files"].items())`（`build-artifact.py:131`），它要求的是“相对路径 → 摘要”。
- 证据（亲自读到）：
  ```py
  "files": {
      name: digest
      for digest, name in (
          ("463f...", "onnx/model.onnx"),
  ```
  ```ts
  expect({
    repository: source?.repository,
    revision: source?.revision,
    ...
  }).toEqual({ ... });
  ```
- 建议：至少断言每个 profile 的 `files` 键集合等于 `{model, ...externalData, tokenizer.json, tokenizer_config.json}`，每个值都是 64 位十六进制摘要；这样 `runpy` 取出的推导式结果才真正被验证。

### 信息：`npm run check` 的 50 步不包含这三个 unit 测试，不能作为“三个文件全部通过”的证据
- 文件:行：`package.json:26-27`、`ci/policy.json:146-147`
- 问题：`check` 只执行 `check:steps`，其中没有任何一步运行 `--project unit` 的全量单测；这三个文件属于 unit project（`ci/policy.json:147` 的 `apps/**/*.unit.test.ts`、`packages/**/*.unit.test.ts`）。因此“npm run check 50 步全过”与“三个文件通过”是两件事，提交说明把它们并列时需要分开看。
- 证据（亲自读到）：`"check": "node scripts/run-all-checks.mjs"`，`check:steps` 的 50 个 `npm run ...` 中没有 `test:unit`。
- 建议：验证时明确运行 `npm run test:unit`，或直接运行这三个路径的 vitest；若要让修复长期有门槛，可考虑把这类回归纳入现有检查。

## 仅推测 / 未核实

- **真实 `createProvider()` 返回对象的 `id` 与 `getModels()` 形状**：当前检出没有 `node_modules`，无法直接读 `@earendil-works/pi-ai@1.5.0` 的类型。产品代码确实以 `createProvider({ id, models, ... })` 注册（`configured-model-binding.ts:393-402`），且 `packages/runtime-pi/test/configured-model-binding.compat.test.ts` 里早已用同样形状的假运行时，并有真实 `ModelRuntime` 的用例；但“真实 Provider 一定有这两个成员”只能算高度可信的推测。
- **三个文件实际通过、27 个用例、`npm run check` 50 步**：本环境不能运行测试，未核实执行结果。`package.json` 的 `check:steps` 确实是 50 步，这一点已核对。
- **`runpy.run_path` 默认 `__name__ = "<run_path>"`、因此不会进入 `main()`**：依据 Python `runpy` 的默认 `run_name` 语义；本环境未实际执行 Python。脚本里 `main()` 之外没有网络或写文件路径已读代码确认。
- **历史资格验证冻结清单里的文件哈希**：`test/qualification/evidence/.../input-freeze.json:87` 等文件仍记录 `production-model-composition.unit.test.ts` 的旧哈希 `57db7ade...`。我搜了 `scripts/` 和 `test/tooling/`，没有发现实时校验这些历史清单的脚本；它们应作为历史快照保留，本次不应更新。是否有资格验证流程另行要求重冻结，未核实。

## 侧重检查

- **错误路径**：`production-model-composition` 的假运行时仍拒绝 `null`、数组、缺少字符串 `id` 的模型（`production-model-composition.unit.test.ts:108-113`）；`model-payload-cleanup` 没有这层显式校验，但与改动前的行为一致（旧代码也只按 `id` 建键）。ONNX 测试若 `SOURCES` 不存在会以 `KeyError` 失败，不会静默通过。
- **不可信输入 / 安全**：`runpy` 执行的是仓库内固定路径脚本，不是用户输入；`python3 -I` 隔离了用户 site 和环境变量。当前脚本顶层只导入标准库、构造固定字典，无网络、无写文件。风险是未来顶层代码变化，已列为低 1。
- **资源耗尽**：被执行代码只有 3 个固定 profile 的字典推导和函数定义，无循环放大；`execFileSync` 无超时是既有风险，建议补。
- **不可撤销操作**：下载和产物目录写入只在 `main → build → obtain/download` 链路，`__main__` 保护当前有效，所以测试不会下载或写产物。若将来 `main()` 被顶层调用，会造成真实下载和不可撤销的外部副作用，这是低 1 的核心风险。
- **规则/文档一致性**：本次只改测试，未触碰提示词、工具定义、历史或遮盖；`docs/adr/0205` 与 `docs/pi-development-guide.md` 对“`createProvider` + `registerNativeProvider` + `refresh`”的描述与产品代码一致。旧提交说明中的“ADR 0204”是当时编号，当前树已改为 0205，属历史编号迁移，不影响本次改动。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。`git diff --name-status` 只有三个测试文件，没有改系统提示、工具定义、历史消息、遮盖或请求组装代码；生产发给模型的内容仍只在末尾追加。引用规则：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules) 第 4 条。假运行时的 `registerNativeProvider`/`refresh` 只影响测试里的模型查找，不参与真实请求字节的生成。测试里的 `Date.now()` 仍在原有假响应里，不是生产请求头。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。生产路径未改。新引入的序列化只有测试子进程里的 `json.dumps(runpy.run_path(...)['SOURCES'])`：结果是固定源码顺序的字典，没有时间、随机数或无序集合，测试也按值比较；假运行时的 key 只由固定的 provider/model `id` 组成。没有依赖后文或时间的遮盖。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：这三个文件属于 unit project（`ci/policy.json:147`），CI 的 unit 测试会运行；反向覆盖上，若产品回退到 `registerProvider`，两个假运行时已没有该方法，会直接失败；若 `SOURCES` 的仓库/版本/维度等漂移，ONNX 测试会失败。缺口是 `refresh` 被删不会失败（低 2），`files` 推导式写错也不会失败（低 3）；另外 `npm run check` 本身不运行 unit project，不能用它代替这三个文件的测试结果（信息条）。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**
- `provider.id` / `model.id`：产生于 `createProvider` 的 provider 和 `providerModel`（`configured-model-binding.ts:395-399`）；消费者是假运行时的 `getModel(providerId, modelId)` 和产品自己的 `runtime.getModel(descriptor.provider, descriptor.model)`（`:341`、`:405`）。两端都用同一对 `descriptor.provider` / `descriptor.model`，且这两个值在 `validateDescriptor` 里已被要求非空（`configured-model-binding.ts` 的 `ref/model/... must be non-empty`），一致。
- `SOURCES`：生产者是 `build-artifact.py:13-...`（含 `files` 字典推导式）；消费者是脚本的 `sorted(source["files"].items())`（`:131`）和 manifest 的 `"files": source["files"]`（`:160`），都接受“路径 → 摘要”的 dict；测试只消费元数据字段。注意测试没有消费/校验 `files`，见低 3。
- 文件哈希清单：历史资格验证冻结文件里的旧哈希与新文件内容已不一致，但未发现实时校验器；按历史快照处理即可，本次不需要也不应该改它们。
- 假运行时的 `refresh`：产品只 `await` 它，空实现可接受，但它让测试失去对刷新行为的约束（低 2）。
