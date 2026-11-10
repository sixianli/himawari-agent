## 结论（按严重度从高到低）

### 1. 中：ADR 0208 的前提和决定仍假设一个已被 D4 删除的 `sessionModelRuntime` 代理
- **文件:行**：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:43`（前提第 6 条）、`:53`（决定第 2 步）、`:57`（“保留的偏离”段）
- **问题**：ADR 写“Himawari 已有每次运行一个的 `sessionModelRuntime` 代理（`pi-runtime-adapter.ts`）”，并把第 2 步写成“搬到每次运行的 `sessionModelRuntime` 代理的 `streamSimple` 上”。但合入 D4 后，这个代理已经被删除，适配器直接使用共享的 `binding.modelRuntime`。
- **证据**：
  - ADR 0208 前提 6：“Himawari 已有每次运行一个的 `sessionModelRuntime` 代理（`pi-runtime-adapter.ts`）。”
  - 当前代码 `packages/runtime-pi/src/pi-runtime-adapter.ts:1538`：`modelRuntime: binding.modelRuntime,`
  - 同一文件里 `sessionModelRuntime` 函数已不存在（本次 diff 删除了 `function sessionModelRuntime(...)`）。
  - ADR 0208 后果第 3 条（约 `:79`）自己也写“D4 已……删掉了 `sessionModelRuntime` 那个 Proxy；第 2 步要自己重建每次运行专属的模型代理”。同一份 ADR 内部互相矛盾。
- **建议**：把前提 6 改成“D4 删除后当前没有每次运行的代理；第 2 步需要重建”，并同步改决定第 2 步和“保留的偏离”段的措辞，避免实施者以为现成代理还在。

### 2. 中：ADR 0204 的后果仍把 D6 列为“不得照抄”，与 D6 已删除、已改回官方相矛盾
- **文件:行**：`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:69`（“后果”第一条，行号按当前文件估算）
- **问题**：同一条 ADR 的“放弃的做法”已注明“D6 单独删除，见 ADR 0208”，`docs/pi-development-guide.md` 也写“D6 已改回官方”，但“后果”仍说 D6 不得照抄。
- **证据**：
  - ADR 0204“后果”：“D5 剩下的部分、D6、D7、D1 仍不得照抄；D4 已由 [ADR 0205] 关闭，现在可以照它的写法做。”
  - ADR 0204“放弃的做法”：“后续：2026-11-10 已查清，D6 单独删除，见 [ADR 0208]……”
  - `docs/pi-development-guide.md` 偏离表 D6 行：“D6 已改回官方（[ADR 0208]）”。
- **建议**：从“后果”中移除 D6，或改为“D6 已按 ADR 0208 删除”，与规范表和 ADR 0208 保持一致。

### 3. 中：新用例 `[ADR-0208]` 并不能验证 D6 删除，也不是反向用例
- **文件:行**：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:741-749`
- **问题**：该用例只断言第一条请求体包含 `Himawari`、不包含 `Current working directory`。即使把 `himawari-system-prompt` 扩展加回来，由于扩展返回的也是同一份 `systemPrompt`，且 `systemPromptOverride` 仍在，这个用例仍然会通过。它没有验证“删除前后请求字节不变”，也不是“加回就失败”的反向用例。
- **证据**：
  ```ts
  it("[ADR-0208] never lets Pi's own working-directory line into the request head", async () => {
    const { bodies } = await conversation(
      [{ prompt: "第一轮", blocks: [ownerProfile] }],
      (index) => ({ text: `回答${index}` }),
      () => undefined,
    );
    expect(bodies[0]).toContain("Himawari");
    expect(bodies[0]).not.toContain("Current working directory");
  });
  ```
  用例只读 `bodies[0]`，是单轮，也没有检查前缀追加或压缩路径。作者在 ADR 里也承认“没有‘加回就失败’的反向用例”。
- **建议**：把该用例改名成“cwd 行不会进入请求头”的普通防线用例，不要标成 ADR-0208 的 D6 证据；若要证明 D6，至少增加一个会因“恢复 `before_agent_start` 扩展”而失败的测试（例如直接构造/恢复该扩展并断言压缩请求的系统提示字节不变），或者明确把 D6 的逐字节对比登记为一次性手工证据。

### 4. 中（证据不足）：ADR 0208 关于“压缩系统提示是 Pi 自带的 `SUMMARIZATION_SYSTEM_PROMPT`”的核心论据，仓库内无法核实
- **文件:行**：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:41`（前提 4）、`:53`（决定第 1 步）；对应代码 `packages/runtime-pi/src/pi-runtime-adapter.ts:656-664`
- **问题**：代码只能证明 `himawariSummaryContext` 读取“Pi 传来的第一条 system 消息”作为摘要系统提示，不能证明这条消息就是 Pi 的 `SUMMARIZATION_SYSTEM_PROMPT`，而不是 `before_agent_start` 设进会话的系统提示。仓库里没有 `@earendil-works/pi-coding-agent` 的包源码（`node_modules` 不存在），无法核对前提 4 引用的 `dist/core/agent-session.js`、`dist/core/compaction/compaction.js`。
- **证据**：
  ```ts
  function himawariSummaryContext(requested: TranscriptContext): Context | undefined {
    if (getCurrentTools(requested.messages).length > 0) return undefined;
    const [first, ...rest] = requested.messages;
    if (first?.role !== "system" || typeof first.content !== "string") return undefined;
    return {
      systemPrompt: first.content,
      ...
    };
  }
  ```
  这段只说明“用第一条 system 消息”，没有说明它的来源。
- **建议**：在 ADR 里把 1.5.0 的具体行号和可复现的 `npm pack` 核对结果写得更具体，或在仓库里加一条真实压缩测试，断言摘要请求的第一条 system 消息等于 Pi 的摘要提示、且不受 `before_agent_start` 影响。否则 D6 删除的安全性核心仍依赖未入库的手工对比。

### 5. 低：D6 的“83 条请求逐字节相同”是一次性手工证据，合入 D4 后没有重新验证
- **文件:行**：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:53`、`:77`
- **问题**：ADR 说删除前后用 26 个多轮用例各抓一遍、83 条请求逐字节相同，但这是 D6 提交时的一次性手工对比，不是提交到仓库的自动检查。合入 D4 后，本次新增的自动检查只有上面的 cwd 用例；D4 留下的 `d4-golden-requests.json` 比较的是“旧 Proxy 写法 vs 新原生认证”，不是“有/无 `before_agent_start` 扩展”。因此“合入 D4 之后 D6 的删除仍不改变请求字节”目前是推理，不是证据。
- **证据**：ADR 0208 自己写“这是一次性的手工对比，不是提交到仓库的自动检查”；D4 fixture 的测试名是 `[D4] configured provider request bytes`，比较的是 provider 认证改写前后的请求。
- **建议**：在合入 D4 的当前提交上重跑同一组 26 个用例、记录 83 条请求的 `cmp` 结果并写进 ADR；或者把 D6 的请求头/摘要字节对比做成可重复的测试，避免以后合并其他改动后无法复查。

### 6. 低：ADR 0204 背景仍写“D6 没法离开 D1 单独改”，与后续“D6 单独删除”并读时容易误解
- **文件:行**：`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md`（“背景”段）
- **问题**：背景是历史叙述，可以保留，但没有标注“后来已推翻”，和“放弃的做法”里的后续说明并读时会产生前后矛盾。
- **证据**：“D6（系统提示设两次）的第二次就在 D1 替换的请求函数里，没法离开 D1 单独改”；后文又说“D6 单独删除”。
- **建议**：在背景句后加“（后来查清压缩路径后已推翻，见 ADR 0208）”，或明确标注该段是当时的判断。

---

## 读代码证实的

1. **D6 删除本身已在当前代码中生效。** `packages/runtime-pi/src/pi-runtime-adapter.ts` 的 `extensionFactories` 里只剩 `himawari-tool-outcomes` 和 `himawari-provider-observer`，`himawari-system-prompt` 扩展已删除。
2. **对话请求的替换函数不读 Pi 传来的系统开头。** `himawariRequestContext` 使用闭包里的 `systemPrompt` 参数，并过滤掉 `role === "system"` 的消息：
   ```ts
   return {
     systemPrompt,
     tools,
     messages: requested.messages.filter((message) => message.role !== "system"),
   };
   ```
   （`pi-runtime-adapter.ts:649-653`）
3. **压缩请求确实会读第一条 system 消息**，但来源未核实（见上面第 4 条）。
4. **D4 已删除 `sessionModelRuntime` Proxy**，`createAgentSession` 现在直接传 `binding.modelRuntime`（`pi-runtime-adapter.ts:1538`）。
5. **ADR 0208、ADR 0204、`docs/pi-development-guide.md`、`docs/architecture-v0.1.md` 的主要链接和编号已同步**：
   - ADR 0204 链接指向 `0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md`；
   - 规范表 D1/D6 指向 ADR 0208；
   - 架构文档指向 ADR 0205；
   - ADR 0208 文件名和标题已从 0205 改为 0208。
6. **D4 的新测试和 fixture 已存在**，并且测试会比较 method/path/headers/body；反向用例通过改 `maxTokens` 使比较失败。
7. **`hostSecretAuth` 的 `check` 不读密钥、`resolve` 只接受 `api_key` 凭据**，测试断言 `listCredentials()` 为空、环境变量 `AI_GATEWAY_API_KEY` 不被使用，和 ADR 0205 的描述一致（`configured-model-binding.ts:256-268`、`configured-model-binding.test` 新用例）。

## 推测 / 未核实

- **压缩系统提示是否真的来自 Pi 的 `SUMMARIZATION_SYSTEM_PROMPT`**：未核实。仓库没有 Pi 源码，只有 ADR 引用。
- **26 个用例、83 条请求的具体数字和 `cmp` 结果**：未核实；这些证据没有提交到仓库。
- **仓库里是否还有其他地方引用旧文件名 `0205-adopt-pi-official-request-head-and-session-runtime-wrapper.md`**：未核实。我看到的 diff 只覆盖 ADR 0204、规范、架构文档；没有全仓搜索旧路径。
- **`himawari-system-prompt` 这个扩展名是否还有其他测试/文档引用**：未核实。
- **`.agents/reviews/pr-355/review-handling-round-1.md` 的内容**：未核实。该文件在当前稀疏检出中不存在，`git show` 对该路径返回 `REVIEW_GIT_REFUSED records-path ...`。
- **Pi 1.5.0/1.5.1 的 `registerNativeProvider`、`refresh({ allowNetwork: false })`、`createProvider` 的实际签名**：未核实。仓库没有 `node_modules`，只能看到调用方式；测试里的假 runtime 接受 `refresh()` 但不校验参数。

---

## 侧重检查

- **错误路径**：D4 的 `hostSecretAuth.resolve` 在没有 `api_key` 凭据时返回 `undefined`，不会自己抛异常；真正取不到密钥时由 `resolveSecret` 抛 `PI_PROVIDER_SECRET_UNAVAILABLE`，准入已经先执行，失败后释放预留，和 ADR 0205 描述一致。D6 删除不涉及新的运行时错误路径，但压缩路径的失败模式仍是 `himawariSummaryContext` 返回 `undefined` 后 `failedPiStream`，这一行为未见改动。
- **不可信输入**：`hostSecretAuth.resolve` 只接受 `credential.type === "api_key"` 且非空字符串，拒绝其他凭据类型；`check` 不读外部输入。未发现明显的新注入面。
- **安全**：新测试和 fixture 使用 `fixture-request-key` / `Bearer [fixture]`，没有把真实密钥写入仓库；测试断言 `listCredentials()` 为空、不读取 `AI_GATEWAY_API_KEY`。未发现密钥泄漏。
- **资源耗尽**：D4 的 `captureConfiguredModelRequest` 和 `prompt-prefix` 的 `loopback` 都会在 `finally` / `afterEach` 关闭 HTTP server；本次看到的路径没有明显连接泄漏。Pi 缓存预热仍因模型没有 `promptCache` 而不启用，和 ADR 0205/D7 的说法一致（代码只看到 `providerModel` 没有设置 `promptCache`）。
- **不可撤销操作**：本次改动是删除扩展和文档/测试更新，没有数据写入或迁移；没有发现新的不可撤销操作。
- **规则文件、说明文档和代码一致性**：主要发现是上面第 1、2、4、5、6 条；其中第 1、2 条是确凿的文档自相矛盾，第 4 条是文档引用仓库外事实、仓库内无法验证。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**对话请求：读代码判断不会。** 删除 `before_agent_start` 扩展后，对话请求仍由 `himawariRequestContext` 用闭包里的冻结 `systemPrompt` 和工具声明构造开头，并且过滤掉 Pi 传来的 system 消息；每轮变化的时间、资料、主人话语仍在 `turnPrompt` 生成的内容里，最终作为最后一条 user 消息发出。证据是 `pi-runtime-adapter.ts:644-653` 和 `:1601-1605`。

**压缩请求：未核实。** `himawariSummaryContext` 取的是 Pi 传来的第一条 system 消息（`:656-664`）。如果那条消息确实如 ADR 所说来自 Pi 的 `SUMMARIZATION_SYSTEM_PROMPT`，删除 `before_agent_start` 不会改变它；如果它实际是会话系统提示，则可能改变压缩请求开头。仓库内没有 Pi 源码，无法确认；作者也承认 83 条请求的对比是手工证据。

**结论**：对普通对话，改动只影响 Pi 会话内部记录的系统提示，不影响实际发给模型的请求开头；对压缩，不能仅凭仓库代码下结论，需要补充证据或测试。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（依赖前后文的遮盖、带时间的字段、无序的集合）？

**读代码未发现本次改动引入这类问题。** D6 删除的是固定的 `before_agent_start` 回调，不引入时间字段、随机值或无序集合；对话请求仍使用冻结的 `systemPrompt`。D4 的 `HOST_SECRET_SOURCE` 是固定字符串，`check`/`resolve` 的返回结构固定。新 fixture 也是静态 JSON。**推测风险**仍在压缩路径：如果第一条 system 消息的来源会随会话状态变化，同一段摘要文本可能在不同请求里带上不同的系统提示；这属于上面“未核实”的部分。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**D4 有自动检查，反向用例会失败。** `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 的 `[D4] configured provider request bytes` 会比较 method/path/headers/body；反向用例把 `maxTokens` 改成 512，断言结果与 golden 不相等，这个反向用例是有意义的。

**D6 没有有效的自动反向用例。** 新加的 `[ADR-0208]` 用例只检查 cwd 行不进入请求头，不是 D6 的反向用例；把 `himawari-system-prompt` 扩展加回来它仍会通过。作者也明确写了“没有‘加回就失败’的反向用例”。因此对 D6 删除本身，自动检查不足。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**已核对且一致的：**
- `HOST_SECRET_SOURCE = "himawari-host-secret"` 在 `check` 和 `resolve` 两处产生，测试断言 `checkAuth` 返回同一个 `source`；两端一致。
- `providerModel` 新加的 `provider: descriptor.provider` 与 `runtime.getModel(descriptor.provider, descriptor.model)`、测试里的 `primary.model.provider` 一致；D4 fixture 也按 provider 分组。
- ADR 0205/0208 的编号和链接在 ADR 0204、规范、架构文档中已同步。

**未核实或不一致的：**
- ADR 0208 里的 `sessionModelRuntime` 在 D4 后已不存在，属于“值/名称已失效但文档仍在使用”（见第 1 条）。
- ADR 0204 的 D6 状态与规范表、ADR 0208 不一致（见第 2 条）。
- 旧 ADR 文件名 `0205-adopt-pi-official-request-head-and-session-runtime-wrapper.md` 是否还有残留引用，未做全仓搜索。
- `himawari-system-prompt` 扩展名是否还有测试/文档引用，未核实。
- Pi 原生 provider 的 `createProvider` / `registerNativeProvider` / `refresh` 参数是否完全符合锁定版本，未核实（仓库无 Pi 源码）。

---

## 总体判断

这次增量在代码层面把 D6 删干净了，普通对话请求头的构造也确实不依赖被删掉的扩展；D4 的 fixture 和测试对 provider 认证改写有实际约束。主要问题不在实现，而在**文档和验证**：ADR 0208 还假设已被 D4 删除的代理存在，ADR 0204 的 D6 状态前后矛盾，新用例也不能证明 D6 删除不改变请求字节。压缩路径是唯一可能让 D6 改变请求开头的地方，而它恰恰只有仓库外的手工证据。建议先修正这两处文档矛盾，并补一个覆盖压缩请求系统提示来源的自动测试，再合入。
