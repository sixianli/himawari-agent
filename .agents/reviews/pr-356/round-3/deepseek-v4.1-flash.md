## 结论

- 未发现会改变模型已见请求开头、或引入新的正文随机性的**生产代码**问题；这次 D4 改写主要动的是认证声明，消息拼装没动。
- 主要问题集中在**文档与测试证据不一致**，以及测试替身对 secret 的覆盖变弱。
- 本环境没有 `node_modules`，也没有运行测试；`pi-ai` 的接口形状、`refresh({ allowNetwork: false })` 语义、测试是否真能通过，属于**未核实**。`.agents/reviews/pr-356/round-2/` 因工具拒绝 records-path、工作区又是稀疏检出，也**未能核验**。

---

## 发现

### 1. 低（文档/测试证据不一致，读代码证实）

**文件:行**：`docs/adr/0205-pi-native-provider-auth.md:74`、`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2871`

**问题**：ADR 说“故意改 `maxTokensField` 时比对失败”，但提交里唯一一条反向用例改的是 `maxTokens` 的数值，不是 `maxTokensField`。仓库历史里也没有任何测试改过 `maxTokensField`。

**证据**：

```text
docs/adr/0205-pi-native-provider-auth.md:74
...改写后测试逐字节比对通过；故意改 `maxTokensField` 时比对失败。

packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2871
it("fails the golden comparison when a model field that changes the request is altered", async () => {
  const golden = await readGolden();
  const altered = await captureConfiguredModelRequest({ provider: "magpie", maxTokens: 512 });
  expect(altered).not.toEqual(golden["magpie"]);
});

packages/runtime-pi/src/configured-model-binding.ts:289
maxTokensField: "max_tokens",
```

`git log -S maxTokensField --all -- packages/runtime-pi/test` 无结果，说明没有提交过改这个字段的用例。

**建议**：要么补一条真正修改 `compat.maxTokensField` 后 golden 比对失败的用例，要么把 ADR 改成“故意改 `maxTokens` 时比对失败”，不要把未提交的手工验证写成仓库里的自动反向证据。

---

### 2. 低（文档与代码边界不一致，读代码证实）

**文件:行**：`docs/pi-development-guide.md:353`、`docs/adr/0205-pi-native-provider-auth.md:48`、`packages/runtime-pi/src/configured-model-binding.ts:263`

**问题**：文档写 `resolve`“只收 Himawari 传入的密钥”，但代码只检查 `credential.type === "api_key"`；只要 Pi 将来传入任何 `api_key` 凭据，都会原样接受。真正的“来源唯一”保证是 ADR 第 50 行说的“凭据库为空”，不是 `resolve` 自己能分辨来源。

**证据**：

```text
packages/runtime-pi/src/configured-model-binding.ts:263
const key = credential?.type === "api_key" ? credential.key : undefined;

docs/adr/0205-pi-native-provider-auth.md:48
`resolve` 只在 Himawari 经 `apiKey` 选项传入密钥时原样返回...

docs/adr/0205-pi-native-provider-auth.md:50
Pi 的凭据库必须保持为空：`resolve` 分不出显式传入的密钥和凭据库里的密钥，所以靠“凭据库为空”保证来源只有一个
```

ADR 第 50 行已经说清楚了，第 48 行和规范表第 353 行的措辞过于绝对。

**建议**：把文档改成“`resolve` 只从 `credential` 取密钥；来源唯一性由空凭据库保证”。当前代码本身可以接受（`InMemoryCredentialStore` 是新建的，测试也断言 `listCredentials()` 为空），重点是别让后续维护者误以为代码里还有来源校验。

---

### 3. 低（测试覆盖变弱，读代码证实）

**文件:行**：`packages/runtime-pi/test/configured-model-binding.compat.test.ts:65`、`packages/runtime-pi/test/configured-model-binding.compat.test.ts:126`

**问题**：假 runtime 的 `registerNativeProvider` 现在只记录 `{ baseUrl, models }`，不再记录 `auth`。因此原来的断言“注册配置里不含 SECRET”不再覆盖认证对象；如果以后有人把密钥直接塞进 `createProvider({ auth: ... })`，这条假 runtime 用例抓不到。新的真实 runtime `[D4]` 用例能证明 `listCredentials()` 为空、主机来源未被读取，但没有检查 provider 的 auth 配置本身。

**证据**：

```text
packages/runtime-pi/test/configured-model-binding.compat.test.ts:70-74
const models = provider.getModels();
this.registered.push({
  providerId: provider.id,
  config: { baseUrl: provider.baseUrl, models },
});

packages/runtime-pi/test/configured-model-binding.compat.test.ts:126
expect(JSON.stringify(runtime.registered)).not.toContain(SECRET);
```

**建议**：在假 runtime 里记录 `provider` 或至少 `provider.auth` 的可枚举字段，并继续断言注册路径不受 SECRET 污染；或者把第 126 行改成明确检查真实 runtime 的 provider 配置/凭据存储。

---

## 作者说法的核对

- `docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:72` D4 已由 ADR 0205 关闭：**正确**。
- ADR 0205 的关联文档回链 0204：**正确**（`docs/adr/0205-pi-native-provider-auth.md:84`）。
- ADR 0205 的“逐字节”改为“请求体逐字节不变、非易变请求头一致”：**基本正确**，但同一条后半句仍保留了未被自动用例覆盖的 `maxTokensField` 说法，见发现 1。
- `docs/pi-development-guide.md` D4 行“同左”改为完整 Provider 原生认证：**正确**。
- 删除 `D4_WRITE_GOLDEN` 分支：**正确**；全仓 grep 已无残留引用。
- `configured-model-binding.ts` 的 `resolve` 只在 `credential?.type === "api_key"` 时取 key：**正确**。
- `.agents/reviews/pr-356/round-2/` 复核记录：**未核实**（工具拒绝 records-path，稀疏检出也未包含）。

---

## 侧重检查

- **错误路径 / 预留释放**：`resolveSecret()` 在准入之后调用（`pi-runtime-adapter.ts:1057`），取密钥失败时进入 `catch`；`started` 仍为假，会走 `releaseBeforeStart()` 释放预留（`pi-runtime-adapter.ts:1116-1124`）。ADR 第 51 行“取不到密钥时失败发生在准入之后，预留会释放”**与代码一致**。
- **不可信输入**：`descriptor` 的 `provider`、`api`、`baseUrl`、`maxTokens` 等校验没有放松；新增的 `HOST_SECRET_SOURCE` 和 auth `name` 是常量，不来自用户输入。未发现新的注入面。
- **安全 / 密钥**：`check` 不读密钥、不碰网络；`resolve` 不读主机 Secret；凭据库是新建的 `InMemoryCredentialStore`（`configured-model-binding.ts:386`）；golden 测试把 Authorization 值归一化为 `Bearer [fixture]`（`pi-runtime-adapter.compat.test.ts:2771-2772`），没有把测试密钥写进 fixture。未发现新的密钥落地或日志泄漏路径。
- **资源耗尽 / 不可撤销操作**：新增测试会起本机回环 HTTP 服务并按请求累积 body，但只作用于测试进程，大小由固定 fixture 控制；没有新增生产侧不可撤销操作。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的要求没有被这次认证改动违反；ADR 0204/0205 与规范表互相链接存在，ADR 编号无冲突。发现 1、2 的措辞不一致仍需修正。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
**不会（读代码证实）。** 生产代码只改了 provider 注册和认证解析，`himawariRequestContext`、系统提示冻结、工具定义、历史保存、遮盖逻辑都没有动。更强的证据是 golden fixture：它在重构前提交 `e934cd2f`，之后 fixture 的 `body` 完全没有变化，`git diff e934cd2f..HEAD` 只把 `authorization` 的两行改成了占位。时间和本轮资料仍只出现在最后一条 `<himawari-context>` 用户消息里（fixture body 可见），系统提示和工具在它前面。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
**不会引入新的正文不确定性（读代码证实）**。会话相关请求头由固定元组的 SHA-256 生成（`pi-runtime-adapter.ts:667-678`），同一会话稳定；没有新增依赖前后文的遮盖或无序集合。唯一可能逐请求变化的是 `Authorization` 头里的密钥值，它不属于提示正文，也不参与提示缓存；测试已把它归一化。每轮变化的请求时间仍只在最后一条消息里，属于既有设计。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
**有正向自动检查；反向证据不完整。** golden 正向用例在 `pi-compat` 项目里，`ci/policy.json:108,187` 把 `pi-compat` 放进 coverage 门槛，属于会阻断的检查。若请求体或非易变头变化，`expect(actual).toEqual(golden[provider])` 会失败。提交的反向用例改的是 `maxTokens`，不是 ADR 说的 `maxTokensField`；它能证明“改 `maxTokens` 会让比对不等”，但没有覆盖 ADR 声称的字段。测试是否实际执行通过，本环境**未核实**。

**4. 每个新增/修改的值，两端都能接受吗？**
逐个核对如下：
- `HOST_SECRET_SOURCE = "himawari-host-secret"`：只用于 `check`/`resolve` 返回值和测试断言；仓库内没有后端 schema 校验它。Pi 侧是否把 `source` 当自由字符串，**未核实**（本环境无 `pi-ai` 源码/类型）。
- provider id `magpie` / `vercel-ai-gateway`：仍来自既有联合类型和 `validateDescriptor`，`createProvider` 的 `id` 与 `model.provider` 同值。
- model 的 `provider` 字段：新增后与 `createProvider({ id })`、`runtime.getModel(descriptor.provider, ...)` 两端一致；真实 runtime 用例覆盖了注册和 `getModel`。
- `api: "openai-completions"`：descriptor 校验仍只允许该值，`createProvider` 使用官方 `openAICompletionsApi()`。
- 删除 `authHeader: true`：golden 用例仍看到 `authorization: Bearer [fixture]`，说明请求头没有丢；未实际跑测试，仍需 CI 复核。
- `runtime.refresh({ allowNetwork: false })`：只在这一处产生，由 Pi runtime 消费；其参数语义和是否真的不联网**未核实**。
- 测试 fixture 的 `authorization`/`session_id` 等值：只被测试读取，没有产品侧校验。

未发现 I-73 那种“清单里的 id 过不了后端校验”的两端错配；但 `source` 在 Pi 侧的校验范围、以及 `refresh` 选项语义，因依赖不可读只能标为**未核实**。
