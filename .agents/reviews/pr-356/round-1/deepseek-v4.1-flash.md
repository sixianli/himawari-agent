## 读代码证实的问题

### 1. 高：分支未合入基准，ADR 0204 与已合并 PR 撞号；按给定 diff 落地会回退 PR 354
- 文件：`docs/adr/0204-pi-native-provider-auth.md:10`、`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md`（基准 6557219）:10、`docs/pi-development-guide.md:352-355`
- 问题：基准 6557219 已经有 `# ADR 0204：Pi 偏离 D2、D3 保留，D5 读历史改照官方`；本分支又新增 `# ADR 0204：模型服务方用 Pi 的原生认证声明…`。同时 `git log` 显示 d76066f1 的两个提交并不包含基准侧的 PR 354，所以 `6557219..d76066f1` 的 diff 把 PR 354 的 D5 改法、旧 ADR 0204 和 D2/D3 批准状态都显示成“被删除/回退”。
- 证据：
  - 基准文件标题：`# ADR 0204：Pi 偏离 D2、D3 保留，D5 读历史改照官方`
  - 新文件标题：`# ADR 0204：模型服务方用 Pi 的原生认证声明，删除改写 hasConfiguredAuth 的 Proxy`
  - `git log --oneline 6557219 --not d76066f1` 列出 `7c72e8b7 refactor(runtime-pi): 读历史和工具改走 Pi 会话接口，D2、D3 批准保留（ADR 0204）` 等 PR 354 提交；反向的 `git log d76066f1 --not 6557219` 只有 `e934cd2f`、`d76066f1` 两个提交。
  - `docs/lessons.md:731`：“ADR 编号是全项目引用决定的唯一名字；撞号之后，引用会指错文档”；`docs/lessons.md:733`：`check:adr-numbers` 会报 `ADR_NUMBER_DUPLICATE`；`docs/lessons.md:736`：两个撞号 PR 各自单独跑都会通过，合并进同一棵树后才失败。
- 建议：先把基准合并/rebase 到分支；新 ADR 改号（当前应为 0205），同步更新 `architecture-v0.1.md:647`、`pi-development-guide.md:75/245/353` 三处链接；按最新 main 保留 D2/D3 批准、D5 使用 `session.messages` 的结论，再重跑 `npm run check`（含 `check:adr-numbers`）。

### 2. 中：`resolve` 没有校验密钥来源，作者“只在经 apiKey 选项传入时返回”的说法过宽
- 文件：`packages/runtime-pi/src/configured-model-binding.ts:262-266`
- 问题：实现是“只要 `credential.key` 是非空字符串就原样返回”，并不区分这个 credential 来自 Himawari 显式传入的 `apiKey`，还是来自 Pi 的凭据库/其他来源。当前安全边界依赖“Pi 凭据库始终为空”这个未被运行时强制的不变量。
- 证据：
  ```ts
  resolve: async ({ credential }) => {
    const key = credential?.key;
    return typeof key === "string" && key.length > 0
      ? { auth: { apiKey: key }, source: HOST_SECRET_SOURCE }
      : undefined;
  },
  ```
  当前测试证明的是“此刻”安全：`configured-model-binding.compat.test.ts:367-370` 断言无 override 时 `getAuth` 为 `undefined`、`listCredentials()` 为空、`reads` 为空；`pi-runtime-adapter.compat.test.ts:2711-2712` 在准入回调里断言 `secretReads` 仍为空。但这些都不是对 `resolve` 来源的校验。
- 建议：如果 Pi 接口能区分显式 override 与存储凭据，在 `resolve` 里只接受显式 override；否则在初始化后主动校验/清空凭据库，并加一条测试覆盖“若有人调用 `setRuntimeApiKey`，必须在准入前被发现/拒绝”，把这个不变量变成代码约束而不是文档假设。

### 3. 低：提交里真正的反向用例只改了 `maxTokens`；“改 maxTokensField / check / resolve 会失败”不是自动可复现的
- 文件：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2880-2884`、`:2861-2875`
- 问题：作者说“变异验证（check 返回 undefined、resolve 凭空给密钥、改 maxTokensField）测试都会失败”。其中 check/resolve 变异只是人工操作；提交里的负向用例只把 `maxTokens` 从 1024 改成 512。`maxTokensField` 的变异没有被提交成测试。golden 的写入分支还会在 `D4_WRITE_GOLDEN=1` 时先覆盖 fixture 再比较，等于自更新后必然通过。
- 证据：
  ```ts
  const altered = await captureConfiguredModelRequest({ provider: "magpie", maxTokens: 512 });
  expect(altered).not.toEqual(golden["magpie"]);
  ```
  ```ts
  if (process.env["D4_WRITE_GOLDEN"] === "1") { ... await writeFile(goldenPath, ...) }
  const golden = await readGolden();
  expect(actual).toEqual(golden[provider]);
  ```
- 建议：把 golden 写入放到单独的维护脚本或 CI 明确禁止的开关；提交一条真正改 `maxTokensField` 的反向用例，并考虑为 `check`/`resolve` 的契约断言明确标注为反向覆盖。

### 4. 低：规范表格仍把 `registerProvider` 写成“官方写法”，与新增的原生 Provider 段落不一致
- 文件：`docs/pi-development-guide.md:75`、`:245`
- 问题：表格第 75 行“接模型服务方”的官方写法列仍是 `registerProvider`，第 245 行却说 Himawari 现在用 `createProvider` + `registerNativeProvider`。对需要自定义取密钥的接入来说，两者都是官方路径，但表格读起来会让人以为原生 Provider 不是官方写法。
- 证据：
  ```
  | [接模型服务方](#pattern-provider) | `registerProvider`，协议相同就复用 Pi 的流式实现 | 照官方；认证声明见 [ADR 0204]... |
  ```
  ```
  Himawari 的写法...用 `createProvider`...再 `registerNativeProvider`...
  ```
- 建议：在表格的官方写法列补一句“自定义认证时用完整 `Provider` 的原生认证”，或把两种官方路径并列。

## 推测 / 未核实

### 低（推测）：golden 测试的请求头过滤依赖运行环境
- 文件：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2750-2751`、`:2824`
- 说明：`VOLATILE_HEADER` 只过滤固定名单；`accept` 未过滤，Node/undici 版本变化可能改变默认请求头；测试还依赖 `process.cwd()`。当前 fixture 里的 `session_id`、`x-client-request-id`、`x-session-affinity` 是固定会话哈希，时间字段也由 `now: () => NOW` 固定，所以我没有找到当前会不稳定证据，但跨机器失败风险仍在。建议只比较业务头白名单或断言为子集，并断言捕获请求数恰好为 1。

### 未核实：Pi 内部语义（本环境没有 `node_modules`，无法直接读 Pi 源码）
- `check`/`resolve` 返回的 `source: "himawari-host-secret"` 在 Pi 内部是否只作展示、是否有其他用途，未核实。
- 原生 Provider 是否完全替换内置 `vercel-ai-gateway`、`refresh({ allowNetwork: false })` 是否可能重新覆盖自定义 Provider，未核实；目前只能依赖 `[D4]`/golden 测试通过这一说法。
- 内置 gateway 从 `AI_GATEWAY_API_KEY` 取密钥的兜底被移除后，仓库内 `src` 没有发现依赖它的调用；`admitPiStream` 和 `pi-model-transport` 都显式传 `apiKey`。但 Pi 内部是否还有别的路径依赖该兜底，未核实。

## 侧重检查

- **错误路径**：`admitPiStream` 在 `resolveSecret` 抛错或取消时走 `catch`，`started=false` 时调用 `releaseBeforeStart()` 释放预留（`pi-runtime-adapter.ts:1116-1124`）；准入发生在取密钥之前（`:1005` 对比 `:1057`），[R2-L5] 测试也在准入回调断言 `secretReads` 为空。未见新增的泄漏或预留不释放路径。
- **不可信输入**：本次新增的值基本是常量或由已校验的 descriptor 派生；唯一外部输入是 `credential.key`，只校验了“非空字符串”，没有校验来源。descriptor 原有校验未变。
- **安全**：没有发现密钥进入 Pi 凭据库或 golden 文件；golden 的 `authorization` 已替换为 `Bearer [fixture]`。残留风险是上面第 2 条的“凭据库为空”只靠测试和文档保证。
- **资源耗尽**：`check` 恒为已配置，会让 Pi 内部认为该 Provider 随时可用，但当前 `promptCache` 未填、缓存预热不跑；压缩请求经 `streamFunction` 仍走 `admitPiStream`。未发现新增无界重试或循环。
- **规则/文档一致性**：发现 ADR 撞号、分支落后导致 diff 回退 PR 354、规范表格与新写法不一致；`D7` 行补充的缓存预热绕过准入事实与代码一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   就 d76066f1 的代码改动本身：没有改系统提示、工具定义、历史组装或遮盖逻辑，只改了 Provider 注册和请求序列化。golden 测试比较的就是改写前后同一请求的 method/path/headers/raw body（`pi-runtime-adapter.compat.test.ts:2775`、`:2875`），作者称通过；`prompt-prefix.compat.test.ts:315-338` 还用真实 `ConfiguredPiModelBindingPort` 跑多轮 magpie 会话，覆盖 `[I-66]` 只追加检查。因此在这两个路径上，发给模型的内容仍只在末尾追加。golden body 里每轮变化的请求时间位于最后一条 user 消息，系统提示在最前。注意：按给出的 `base..HEAD` diff，D5 读历史被显示回退，但 `git log` 证明这是分支未合入基准造成的，不是两个提交的实际改动；合并前必须 rebase，否则会回退 PR 354。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本次没有引入时间字段、随机值或无序遍历。`HOST_SECRET_SOURCE` 是常量，Model 字段和 compat 字段来自固定 descriptor，`providerOptions.gateway.order` 是固定数组；golden 里的会话头是固定 session 的确定性哈希，时间是固定的 `NOW`。没有发现该改动本身引入的非确定性。剩余风险只在 golden 测试的头过滤和跨 Node 版本差异（见“推测”）。

3. **有没有自动检查，反向用例真的会失败吗？**
   有：`configured-model-binding.compat.test.ts` 的 `[D4]` 契约测试、`pi-runtime-adapter.compat.test.ts` 的 `[R2-L5]`、golden 逐字节比对，以及现有 `check:prompt-prefix` 多轮检查。`check` 返回 `undefined` 时，`hasConfiguredAuth(...).toBe(true)` 会失败；`resolve` 凭空给密钥时，`getAuth(model)` 为 `undefined` 的断言会失败。`maxTokensField` 变异理论上会被全 body 比较捕获，但提交里没有对应反向测试；实际反向用例只改了 `maxTokens`。我没有运行这些测试，无法独立验证。

4. **改动产生的每个值，使用它的地方都能接受吗？**
   - `provider`（新增 Model 字段）：产生于 `providerModel()`，被 `getModel`、`model-presentation.ts`、适配器和 `pi-model-transport` 使用，均与 `descriptor.provider` 一致，没发现问题。
   - `createProvider.id`：来自已校验的 `first.provider`，使用方是 `registerNativeProvider`/`getModel`，一致。
   - `HOST_SECRET_SOURCE`：只在 `check`/`resolve` 和测试/文档中出现；仓库内没有校验它的使用方，Pi 内部语义未核实。
   - `refresh({ allowNetwork: false })`：使用的键与锁定 Pi 版本接口一致，由真实运行时测试覆盖（作者称通过）。
   - **ADR 编号 0204**：这是本次唯一明确“产生方和使用方对不上”的标识——基准已有 0204，合并后 `check:adr-numbers` 会报重复，引用也会指向两份不同 ADR；必须先改号并更新三处链接。
