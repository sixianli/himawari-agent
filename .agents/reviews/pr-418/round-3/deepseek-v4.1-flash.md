## 结论

本轮增量 `07f5a935..63f4b5ef` 只修改了两个测试文件和复核记录，没有修改生产源码。未发现中、高严重度问题。作者关于“新增 missing 反向用例”和“refresh 断言移到 close 之前”的两条说法，均与代码一致；第 2 轮意见原文因 `.agents/reviews` 被工具屏蔽，未能核实。

## 发现（按严重度）

### 低（可以更好）— refresh 断言移到 close 之前后，不再验证 close 不触发 refresh

- 文件：`apps/agent-service/test/production-model-composition.unit.test.ts:240-241`
- 问题：现在只断言初始化阶段 refresh 一次，close 之后再没有任何与 refresh 相关的断言。如果以后 `close()` 误触发一次 refresh 或网络刷新，这条用例不会失败；而增量前（`07f5`）同一断言是在 `await composition.close()` 之后执行的，正好能覆盖这种情况。
- 证据（当前代码）：

```ts
    expect(runtime.refreshes).toEqual([{ allowNetwork: false }]);
    await composition.close();
```

增量 diff 显示：

```diff
-    await composition.close();
     expect(runtime.refreshes).toEqual([{ allowNetwork: false }]);
+    await composition.close();
```

`close()` 的实现目前只清空 runtime 引用，不刷新：

```ts
  async close(): Promise<void> {
    await this.#initialization?.catch(() => undefined);
    this.#runtime = undefined;
    this.#initialization = undefined;
  }
```

见 `packages/runtime-pi/src/configured-model-binding.ts:362-366`。另有一个相关用例在 `packages/runtime-pi/test/configured-model-binding.compat.test.ts:260-261` 仍检查 close 后 `removedProviders` 为空，但也没有检查 refresh。

- 建议：如果“close 不触发 refresh”是要求，保留 close 前的断言，并在 close 后再断言一次 `runtime.refreshes` 不变；同时用 `try/finally` 包住 `close()`，避免断言失败时跳过关闭。

### 低（可以更好）— 反向用例只做了 `toContain`，没有限定为唯一错误

- 文件：`test/integration/v0.2-coverage.test.ts:79-91`
- 问题：本用例只断言退出码为 1，且 stderr 包含 `coverage manifest is missing <dropped>`，没有断言“只缺失这一条”或“没有其他 requirement 错误”。如果检查器退化成把所有需求都报告为缺失，这条用例仍会通过；不过现有的 pass 用例（有效清单必须退出 0）会在这种情况下失败，所以组合上仍能拦住大多数回归。该用例不是永真断言，也不依赖检查器的需求计数。
- 证据：

```ts
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`coverage manifest is missing ${dropped}`);
```

`dropped` 来自清单最后一项：

```ts
      const requirement = manifest.requirements.pop();
      if (!requirement) throw new Error("fixture has no requirements");
      dropped = requirement.id;
```

- 建议：可以断言 stderr 中 missing 的集合恰好是 `{dropped}`，或至少断言其他需求的 ID 不出现在 missing 消息里。若希望失败信息更直观，也可以在测试中显式使用已知的 `V02-ACC-12`，并确认它确实在 S0 覆盖矩阵中。

## 读代码证实的 vs 推测

**读代码证实的：**

- 本轮增量只涉及两个测试文件：`production-model-composition.unit.test.ts` 和 `v0.2-coverage.test.ts`；`1a68..63f4` 全量 diff 也没有生产源码改动。
- `V02-ACC-12` 同时存在于清单末尾（`test/fixtures/v0.2/coverage-manifest.json:332`）和 S0 覆盖矩阵（`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:166`），owner 都是 `S9`，满足 `coverageRows` 的正则。
- 检查器的 missing 错误来自 S0 的 `sourceMap` 与清单的 `manifestMap` 对比，而不是数量对比：

```js
  for (const [id, owner] of sourceMap) {
    if (!manifestMap.has(id)) errors.push(`coverage manifest is missing ${id}`);
```

见 `scripts/check-v0.2-coverage.mjs:137-145`；调用点在 `:255`。

- `ConfiguredPiModelBindingPort.initializeRuntime` 在初始化时调用 `runtime.refresh({ allowNetwork: false })`，见 `packages/runtime-pi/src/configured-model-binding.ts:403`；测试中的 fake 在 `:117-119` 记录该参数，断言在 `:240` 期望恰好一次，两端一致。
- 新增测试由 integration 项目运行（`ci/policy.json:158-159` 的 `test/integration/**/*.test.ts`）；`production-model-composition.unit.test.ts` 由 unit/node-services 项目覆盖（`vitest.workspace.ts:78-83`，以及 `ci/policy.json:146-150`）。

**推测或未运行：**

- “删掉 `compareRequirementMaps` 调用后反向用例会失败”是静态推断：删掉后清单少一条需求不会产生任何错误，退出码为 0，测试会在 `expect(result.status).toBe(1)` 失败。由于工具限制，未实际运行 vitest。
- “close 误触发 refresh 不会被发现”是测试覆盖层面的推断，不是已确认的产品缺陷；当前 `close()` 确实不刷新。
- 第 2 轮复核记录原文未核实；`.agents/reviews` 路径被工具拒绝读取。

## 侧重检查

- **错误路径**：新增反向用例覆盖了“清单缺少 S0 需求”这一错误路径，并同时检查退出码和错误文本；检查器对 manifest 结构缺字段、`prd` 缺失等错误仍可能以未捕获的 `TypeError` 退出，而不是明确报错。这是既有行为，不是本次增量引入。
- **不可信输入 / 安全**：测试通过 `spawnSync` 的参数数组调用检查器，`dropped` 只用于断言字符串，不经过 shell，没有命令注入面。检查器的 `repositoryPath` 对绝对路径原样接受（`scripts/check-v0.2-coverage.mjs:29-31`），manifest/spec/plan 路径没有限制在仓库内；这是既有代码，本次没有新增利用路径，风险低。
- **资源耗尽**：新增用例每次只 `spawnSync` 一次检查器，临时目录由 `afterEach` 清理，没有循环放大。唯一的小问题是 close 前断言失败会跳过 `close()`；本用例的 runtime 是 fake，没有实际资源泄漏。
- **不可撤销操作**：本次没有删除、迁移、写生产数据等不可逆操作。
- **规则 / 文档 / 代码一致性**：已核对 `.claude/rules/prompt-prefix.md:27-28,35` 和 `docs/incidents-and-gates.md` 的 I-73；本轮没有文档或提示词目录改动，提交说明与代码行为一致。第 2 轮复核记录未能读取。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮增量只改测试；`1a68..63f4` 也没有修改生产源码、系统提示、工具定义、历史组装或遮盖逻辑。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只在最后一条消息里。依据 `.claude/rules/prompt-prefix.md:27-28,35`。未实际抓取模型请求，但代码层面没有触碰这些路径。

2. **不会让同一段文字在不同请求里变成不同字节。** 没有生产序列化、遮盖或时间字段改动。新增的 `JSON.stringify(manifest, null, 2)` 只用于写临时清单给检查器，不进入模型请求；`dropped` 只是测试局部变量。

3. **有对应自动检查，反向用例在静态推理下确实会失败。** `test/integration/v0.2-coverage.test.ts` 属于 integration 测试项目；`production-model-composition.unit.test.ts` 属于 unit/node-services。反向用例不依赖检查器打印的需求数量，而是依赖 S0 需求集合对比：删掉 `compareRequirementMaps` 或把检查改成只比较数量时，stderr 不会出现 `coverage manifest is missing V02-ACC-12`，用例会失败。未发现永真断言；未实际运行测试。

4. **逐个核对了两端：**
   - `V02-ACC-12`：清单来源 `test/fixtures/v0.2/coverage-manifest.json:332`，S0 来源 `docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:166`；owner 都是 `S9`，检查器的 `coverageRows` 正则和 `compareRequirementMaps` 都能接受。
   - `{ allowNetwork: false }`：生产端产生于 `packages/runtime-pi/src/configured-model-binding.ts:403`；测试 fake 的 `refresh` 消费于 `apps/agent-service/test/production-model-composition.unit.test.ts:117-119`，断言在 `:240`，两端一致。
   - `requirements: Array<{ id: string }>`：只用于测试类型；检查器实际还消费 `owner`，fixture 里有该字段。类型里没写 `owner` 不影响运行时，只是以后改测试时类型检查会弱一些。
   - `registerNativeProvider` / `removedProviders` 的替换发生在第 2 轮之前的 `07f5`，不是本轮增量；实际 Pi runtime 接口与 fake 一致，close 不删 provider 的行为仍由 `packages/runtime-pi/test/configured-model-binding.compat.test.ts:260-261` 覆盖。
