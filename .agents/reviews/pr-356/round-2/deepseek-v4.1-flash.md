## 发现（按严重度）

### 1. 中：ADR 0204 仍写着 D4 不得照抄，与 ADR 0205 已关闭 D4 矛盾
- 文件:行：`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:72`
- 问题：两份 ADR 都是 `status: active`，0204 的“后果”仍把 D4 列为“不得照抄”，而 0205 已把 D4 改为“照官方写法”。后续 AI/人按 0204 执行会继续回避已批准的写法。
- 证据：0204 第 72 行：
  `- D5 剩下的部分、D6、D7、D1、D4 仍不得照抄。`
  0205 第 10 行标题与决定：
  `# ADR 0205：模型服务方用 Pi 的原生认证声明，删除改写 hasConfiguredAuth 的 Proxy`
  `1. ConfiguredPiModelBindingPort 用 createProvider 构造完整服务方，用 runtime.registerNativeProvider 注册……`
- 建议：把 0204:72 改为“D4 已由 [ADR 0205](0205-pi-native-provider-auth.md) 关闭，按 0205 写法”，并在 0205 的关联文档里回链 0204。

### 2. 低：ADR 0205 的“请求逐字节不变”比测试实际证明的更强
- 文件:行：`docs/adr/0205-pi-native-provider-auth.md:74`
- 问题：golden 测试会过滤 `host`、`content-length`、`user-agent`、`accept-encoding`、`accept-language`、`sec-fetch-mode`、`x-stainless-*`，并把 `authorization` 规范成占位符；因此严格说只证明了“请求体和非易变请求头”一致，不是整条 HTTP 请求逐字节一致。
- 证据：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2753-2754`
  `const VOLATILE_HEADER = /^(host|connection|content-length|user-agent|accept-encoding|accept-language|sec-fetch-mode|x-stainless-.*)$/u;`
  第 2769-2772 行跳过这些头并替换 `authorization`；第 2778 行才把 `body` 原样保存。
- 建议：把 ADR 措辞改为“请求体逐字节相同，非易变请求头一致”，或明确列出被排除的头。

### 3. 低：golden 测试可以在比较前改写自己的基准文件
- 文件:行：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2864-2878`
- 问题：设置 `D4_WRITE_GOLDEN=1` 时，测试先把 `actual` 写入 `d4-golden-requests.json`，随后立刻读回并比较，必然通过。这个基准本应代表“旧 Proxy 写法录下的请求”，一旦在带该环境变量的环境里跑，就会静默把旧证据换掉。
- 证据：
  `if (process.env["D4_WRITE_GOLDEN"] === "1") { ... await writeFile(goldenPath, ... [provider]: actual ...); }`
  `const golden = await readGolden();`
  `expect(actual).toEqual(golden[provider]);`
- 建议：把“更新基准”移出被 CI 执行的测试（单独脚本/手动流程），或至少让测试在检测到该变量时直接失败；并保留旧实现录制的提交记录。

### 4. 低：规范表 D4 行“对应的官方写法”写成了“同左”
- 文件:行：`docs/pi-development-guide.md:353`
- 问题：该列应写官方写法，“同左”指向前一列“做了什么”，语义不通；同一行的其他列又没有给出 `createProvider`/`registerNativeProvider`。
- 证据：`| D4 | ... | 已关闭：原来用 Proxy 改写 hasConfiguredAuth；现改为完整 Provider 的原生认证 ... | 同左 | — | 已改回官方写法 ... |`
- 建议：该格改为“完整 `Provider` 原生认证（`createProvider` + `registerNativeProvider`）”。

## 推测（未读代码证实）

### 低：`resolve` 不校验 credential 的类型/来源，只依赖凭据库为空
- 文件:行：`packages/runtime-pi/src/configured-model-binding.ts:262-266`
- 推测：`resolve` 对任何非空 `credential.key` 都原样返回。当前 `InMemoryCredentialStore` 是每次新建且私有、测试断言为空，所以现状安全；若将来有人把该 store 共享、允许写入，或 Pi 从别处塞入凭据，任意密钥都会被当作 Himawari 的密钥发出。
- 证据：
  `const key = credential?.key;`
  `return typeof key === "string" && key.length > 0 ? { auth: { apiKey: key }, source: HOST_SECRET_SOURCE } : undefined;`
- 建议：至少检查 `credential?.type === "api_key"`，并考虑把“库必须为空”做成显式启动断言（现在只有测试断言）。

## 侧重检查

- **密钥读取时机**：注册、`check`、`refresh` 都不触碰 `secretSource`；`[R2-L5]` 在准入回调里断言 `secretReads` 为空（`pi-runtime-adapter.compat.test.ts:2715`），运行后断言恰好读一次（:2730）；配置绑定测试也断言检查阶段不读（`configured-model-binding.compat.test.ts:370`）。结论：未见提前读密钥。
- **环境变量兜底**：`AI_GATEWAY_API_KEY` 被 stub 后仍取不到密钥（`configured-model-binding.compat.test.ts:355,367`），与 ADR 0205 说法一致。
- **凭据库**：使用私有 `InMemoryCredentialStore`，`listCredentials()` 为空有断言（`pi-runtime-adapter.compat.test.ts:2735`）。
- **错误路径**：无 credential 时 `resolve` 返回 `undefined`（`:262-266`）；主机密钥缺失在准入之后由 `admitPiStream` 的 `resolveSecret` 抛错并释放预留（`pi-runtime-adapter.ts:1057-1124`）。未发现新引入的不可撤销操作。
- **资源/网络**：`runtime.refresh({ allowNetwork: false })`（`configured-model-binding.ts:403`），注册阶段不联网。失败时 `initializeRuntime` 抛错后未关闭已创建 runtime，重复失败会重复创建；这是既有模式，非本次引入，但新加的 `refresh` 增加了一个失败点。
- **不可信输入**：descriptor、baseUrl、routing 的校验逻辑未被本次改动修改；magpie 仍只允许 loopback HTTP，vercel 仍禁止带凭据 URL。
- **规则/文档一致性**：架构文档、规范主体、ADR 0205 与代码一致；唯一实质矛盾是上面的 ADR 0204:72。未发现遗漏的 `0204-pi-native-provider-auth` 链接。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。依据代码，改动只删除 `sessionModelRuntime` Proxy 并把 `modelRuntime` 直接传入，以及改注册方式；`gatewayPayload`、历史消息、系统提示、工具、遮盖都未动。golden 请求体的 `messages` 与旧写法录制的 `d4-golden-requests.json` 完全一致；`prompt-prefix.compat.test.ts` 也使用真实的 `ConfiguredPiModelBindingPort` 做多轮比对。发给模型的内容仍是只在末尾追加，每轮变化的时间仍在最后一条用户消息的 `<himawari-context>` 里（golden body 可见）。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会因本改动产生新的不确定性。`check` 返回常量；`resolve` 只取决于本次传入的 `credential`；模型和描述符顺序来自冻结的 `#descriptors`；`refresh` 禁止联网；`new Set(getActiveToolNames())` 只做成员判断。授权头会随密钥值变化，但不在提示前缀里。golden 中固定的 `session_id` 和请求头也保持稳定。

**3. 有没有对应的自动检查，反向用例是否真会失败？**
有：`[D4]` golden（两 provider 正向 + 改 `maxTokens` 的反向）、`[D4] declares host-managed auth...`、更新后的 `[R2-L5]` 顺序断言、使用真实绑定的 `[I-66]` 多轮前缀检查，以及 `check:adr-numbers`。反向用例确实能失败：若忽略 `maxTokens`，`altered` 会等于 golden，`not.toEqual` 失败；若改 `maxTokensField`，golden 正文里的 `"max_tokens":1024` 比对失败；若 `check` 返回 undefined 或 `resolve` 凭空给密钥，精确断言失败。作者说“变异验证是手工做的”是准确的，但对应行为已被正向断言锁住。测试执行本身我未能运行（工具受限），只能核对测试写法。

**4. 改动产生/修改的每个值，使用方都能接受吗？**
逐项核对：
- `himawari-host-secret`：产生于 `configured-model-binding.ts:256,261,265`；只被 Pi 的 `checkAuth/getAuth` 消费，仓库内无其他校验者，测试断言了精确值（`configured-model-binding.compat.test.ts:362-365`、`pi-runtime-adapter.compat.test.ts:2695-2698`）。取值本身是自由字符串，SDK 是否限制字面量 **未核实**（本地没有 `node_modules`）。
- `model.provider`：产生于 `providerModel`（:280）；被 `runtime.getModel(descriptor.provider, ...)`（:341,405）、适配器 `binding.model.provider`（`pi-runtime-adapter.ts:988,991`）、后台传输的绑定一致性检查（`pi-model-transport.ts:305`）消费；构造器已强制所有 descriptor 同一 provider/同一 baseUrl，[D4] 测试也断言了 `primary.model.provider`。
- `auth.apiKey` 的 `check`/`resolve` 返回形状：由 Pi 的认证层消费；真实 Pi 运行时的 `[D4]` 用例用 `checkAuth`、`getAuth`、`listCredentials` 覆盖，未发现 Himawari 侧的其他消费者。
- `compat.maxTokensField` 等：由 `openAICompletionsApi()` 消费；golden 正文断言 `max_tokens:1024`，请求头也锁定。
- `refresh({allowNetwork:false})`：无返回值，只影响初始化；但单元测试的假 `refresh()` 不记录参数（`configured-model-binding.compat.test.ts:82`），若参数被误删，单测不会发现，只有真实运行时用例可能暴露。

**作者说法核对**：`D4` 代码自上一轮未变——`git diff d76066f1..90da794f` 对 `configured-model-binding.ts`、fixture 无改动，`2c9c7b70..90da794f` 只有 7 个复核记录文件；以 `65572198` 作为 main 尖端时，`65572198..90da794f` 是 7 个复核材料加 D4 的 8 个文件，与作者所述一致；ADR 0205 标题/编号/链接手动核对一致。第 1 轮 `judgments.md` 在当前稀疏检出中不可读，**未核实**。
