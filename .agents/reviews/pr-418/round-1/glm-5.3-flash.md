现在我来检查一下 composition code 在 runtime 上具体调用了什么，以及 requests prefix 的 rules 文件。
## 复核结论

### 发现（按严重度从高到低）

**1. 低 — `apps/agent-service/test/production-model-composition.unit.test.ts:117-123`：假运行时保留了产品代码已不再调用的 `setRuntimeApiKey`/`removeRuntimeApiKey`，close 后的 `removedProviders` 断言变成永真**
- 读代码证实：产品代码里对 Pi runtime 的调用只有 `getModel`、`registerNativeProvider`、`refresh`、`stream`（`packages/runtime-pi/src/configured-model-binding.ts:341,393,403`；`packages/runtime-pi/src/pi-model-transport.ts:359`）；`packages/runtime-pi/src` 全目录 grep `removeRuntimeApiKey|setRuntimeApiKey` 无任何产品代码命中。测试里 `removeRuntimeApiKey` 只在两个假运行时里出现（本文件 121 行、model-payload-cleanup.unit.test.ts:50）。因此 `production-model-composition.unit.test.ts:245` 的 `expect(runtime.removedProviders).toEqual([])` 现在是空洞断言，不再守护任何行为。
- 属于本 diff 之前就存在的状态（`d76066f1b` 已删掉调用点），本次只是顺带延续，不构成阻塞。建议：删掉两个死方法和该断言，或在断言旁注明它为何仍保留。

**2. 低（未来风险，当前无 bug）— `packages/platform-node/test/local-onnx-embedding.unit.test.ts:303`：runpy 会执行整个脚本，`__main__` 保护只挡住 `main()`，挡不住将来新加的模块级副作用**
- 读代码证实：`scripts/embedding-models/build-artifact.py:1-64` 的模块级代码只有 stdlib 导入和常量定义（含 `SOURCES`），没有网络或文件副作用；`main()` 只在 `if __name__ == "__main__":`（184-185 行）里调用。
- 读代码证实 + 标准库行为：`runpy.run_path` 默认 `run_name="<run_path>"`，执行期间 `__name__` 根本不等于 `"__main__"`，所以即使没有保护块 `main()` 也不会跑——作者说「脚本有 `__main__` 保护，执行时不会下载」结论正确，且实际有双重保险。风险在将来：如果有人在 `SOURCES` 之后加了模块级代码（例如启动时联网校验），会被这个测试执行。建议：保持脚本「模块级零副作用」为约定即可，不必改。

**3. 信息 — `packages/platform-node/test/local-onnx-embedding.unit.test.ts:323-337`：测试比对 SOURCES 与 EMBEDDING_PROFILES 时不比对 `files` 摘要表**
- 读代码证实：比对字段是 repository/revision/dimensions/file/externalData/quantization；`build-artifact.py:21-29` 里的 `files`（SHA-256 摘要）不在比对范围。`packages/application/src/embedding-profiles.ts:24-30` 的 `EmbeddingArtifactSource` 本来就不含摘要，所以不是断言放宽，是旧状（本次 diff 只改了 303 行的取值方式，比对逻辑没动）。摘要的真实校验在 `build()` 的 `obtain`→`download`（103-104 行）运行时做。

### 作者说法逐条核对

- 「d76066f1b 把注册改成 `registerNativeProvider(createProvider(...))` 并在之后调用 `refresh({ allowNetwork: false })`」：证实。`git show d76066f1b --stat` 确认该提交改了 `configured-model-binding.ts`；现状代码 `packages/runtime-pi/src/configured-model-binding.ts:393-403` 正是这两个调用。
- 「测试里的假运行时还只实现旧的 `registerProvider(providerId, config)`，没有 refresh」：证实。diff 删除行里两个假运行时都是旧签名。
- 「literal_eval 读 SOURCES 失败」：证实。`build-artifact.py:21-29` 的 `files` 现在是字典推导式，`ast.literal_eval` 无法求值推导式。
- 「假运行时现在实现 registerNativeProvider 读取 provider.id 和 getModels()，并加空的 refresh」：证实（两个测试文件 44-48 行、105-117 行）。
- 「onnx 测试改用 runpy.run_path 取 SOURCES」：证实（303 行）。
- 「修改后 3 个文件全部通过，npm run check 50 步全过」：**未核实**——我没有运行测试的权限（工具限制），只能确认改动在逻辑上自洽：产品代码调用的方法集合（create/registerNativeProvider/refresh/getModel/stream）假运行时都实现了。
- 「Pi 真实 ModelRuntime.registerNativeProvider 的行为」：**未核实到源码级**——`@earendil-works/pi-coding-agent` 不在仓库里（node_modules 无此包，sparse checkout）。可用的旁证：ADR 0205 前提 5 引用 1.5.0 `dist/core/model-runtime.d.ts` 第 110 行公开该 API；且 `packages/runtime-pi/test/configured-model-binding.compat.test.ts:350-363`（真实 SDK 无磁盘发现）和 364-394（[D4] 真实 runtime 认证契约）是用真实 Pi 运行时跑的测试，能兜住假运行时与真实行为的偏差。假运行时忽略 `auth`/`baseUrl`/`api` 字段、refresh 是空操作，这些差异由 runtime-pi 的真实 SDK 测试补偿，agent-service 假运行时只需要满足「按 id+getModels 注册、getModel 能查到」，断言仍然有意义。

### 侧重检查（测试覆盖 / 文档一致性 / 一条普通流程）

我走的流程：**线程标题（generateTitle）从入口到结束**——
`composition.generateTitle` → 准入 gate → `piModels.resolve(ref)` → `ConfiguredPiModelBindingPort.resolve`（`configured-model-binding.ts:337-360`）→ 首次 resolve 触发 `initializeRuntime`（create → registerNativeProvider → refresh → 逐 descriptor `getModel` 检查，381-413 行）→ `pi-model-transport.ts:359` `modelRuntime.stream` → 流结束后的 payload 清理。
覆盖情况：
- 注册路径：`production-model-composition.unit.test.ts:221-246` 用假运行时覆盖（断言 `binding.model` 就是假运行时注册的那个对象，且未取密钥）。
- 清理路径：`model-payload-cleanup.unit.test.ts:150-226` 覆盖 generateTitle/generateText/proactive 成功与失败。
- 真实 SDK 联动：只由 runtime-pi 的 compat 测试覆盖（`configured-model-binding.compat.test.ts:350-394`）；agent-service 这一层没有任何测试用默认工厂跑真实 Pi runtime——这是本次 diff 之前就有的分层设计，不是缺口，但意味着「假运行时和真实 registerNativeProvider 一致性」完全押在 runtime-pi 那组真实 SDK 测试继续存在于 `npm run check` 里。
- 未覆盖：`refresh({ allowNetwork: false })` 在 agent-service 层无任何行为断言（空方法），真实行为未核实。
文档一致性：ADR 0205 第 47 行写的「createProvider + registerNativeProvider + refresh({allowNetwork:false})」与代码 393-403 行一致；`docs/incidents-and-gates.md:112` 的 I-73 教训（清单 id 要过使用端校验）在本次改动里不适用——本次没有产生新的对外值。`.claude/rules/prompt-prefix.md` 在 sparse checkout 里不存在，**未核实**该规则原文。

### 必答问题

1. **不会改变模型已见过的请求开头。** 读代码证实：`git diff --stat` 显示本次只改 3 个测试文件，产品代码零改动；发给模型的内容构造路径（系统提示、工具定义、历史消息、遮盖）完全没碰。「只追加、每轮变化值在最后一条消息」的规则不受影响。
2. **不会产生同文异字节。** 读代码证实：没有改任何序列化或遮盖逻辑。runpy 取出的 `SOURCES` 是测试内部的比对输入，测试自身按键排序比较（320 行），不依赖插入顺序；这个值不会进入发给模型的任何内容。
3. **有自动检查，反向会失败。** 读代码证实：三个文件都在 vitest 工作区里（`vitest.workspace.ts:79` 包含 `apps/agent-service/**/*.unit.test.ts`）。反向验证：若假运行时退回旧 `registerProvider`，产品代码调 `registerNativeProvider` 会抛 TypeError、被 `initializeRuntime` 捕获转成 `PI_MODEL_RUNTIME_CONFIGURATION_FAILED`，测试失败；若 SOURCES 与 EMBEDDING_PROFILES 内容分叉，320-337 行断言失败；若 runpy 取值方式坏掉，`execFileSync` 抛错。真实 SDK 层的反向由 [D4] 契约测试守住（提交说明称变异验证过）。
4. **改动产生的值两端可接受。** 读代码证实：本次没有产生任何新的对外标识/字段/配置键/清单项/序列化格式——假运行时是测试私有对象，产品端调用的方法名和签名与 `PiModelRuntime`（= `ModelRuntime`）一致到类型转换层（`as unknown as PiModelRuntime`），唯一实质契约「resolve 后 `getModel(provider, model)` 非空」由产品代码自身在 404-408 行兜底，假运行时满足它。I-73 的教训（新值只在一端认）在此不适用。
