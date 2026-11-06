## 复核结论

未发现高/中严重度缺陷。改动集中在 `ci/`、`scripts/ci/`、`test/tooling/` 和文档，没有进入模型请求构造路径。作者关于“30/7 只在基准旧策略上升级”“摘要仍按原始字节计算”的主要说法，读代码后基本成立；另发现 2 个低风险实现/测试问题和 1 个文档归因问题。

## 问题（读代码证实）

### 低 1：升级函数不区分“基准提交”和“初始化时的工作树策略”

- 文件：`scripts/ci/check-policy.mjs:989`
- 问题：`upgradeArtifactRetention` 被无条件套在 `bytes` 上，而 `bytes` 在 `hasPolicy === false` 时来自当前工作树，不是基准提交。也就是说，初始化场景下工作树里的 30/7 也会被升级放行，超出了作者说的“只升级从基准提交读到的已接受策略”。
- 证据：

```js
// check-policy.mjs:989-993
const bytes = hasPolicy
  ? git(["show", `${baseSha}:${policyPath}`])
  : readFileSync(path.join(root, policyPath), "utf8");
const policy = validatePolicy(
  upgradeArtifactRetention(upgradeHostedRunnerPolicy(JSON.parse(bytes))),
```

- 影响：当前仓库每个基准都有策略，且 `check-policy.main()` 会另外用严格 schema 校验工作树里的 `proposed`（`check-policy.mjs:1140`），所以本 PR 的 CI 不会被绕过。但只调用 `resolvePolicySource()` 的入口（`run.mjs`、`test.mjs`、`check-coverage.mjs` 等）在初始化场景下会接受 30/7。
- 建议：只在 `hasPolicy` 为真时升级，例如把 `upgradeArtifactRetention` 放进 `hasPolicy ? ... : ...` 的分支；并补一个“初始化 + 工作树 30/7”的测试。

### 低 2：新增测试只覆盖了 14/7 一种反向值，未固定其他边界

- 文件：`test/tooling/policy.test.mjs:697`
- 问题：正向 30/7 和反向 14/7 都有，但没有覆盖“30/7 加多余字段”“30/7 字段类型错误”和低 1 的初始化路径。当前代码用 `Object.keys(retention).length === 2` 防住了多余字段，这是对的；测试没有把这个边界固定下来。
- 证据：

```js
// policy.test.mjs:700-710
accepted.retentionDays = { reports: 30, diagnostics: 7 };
...
expect(resolvePolicySource({ root }).policy).toEqual(policy);
accepted.retentionDays = { reports: 14, diagnostics: 7 };
...
expect(() => resolvePolicySource({ root })).toThrow("retentionDays");
```

- 建议：补上 `{ reports: 30, diagnostics: 7, extra: 1 }`、`{ reports: "30", diagnostics: 7 }` 以及初始化路径的用例。反向的 14/7 在旧代码上也会抛错，所以它只能防止“升级条件被放宽”，真正证明修复生效的是正向 30/7 用例。

### 低 3：ADR 0174 把“CI 在自己的服务器上跑”归给了 ADR 0173

- 文件：`docs/adr/0174-no-github-cache-and-one-day-artifacts.md:88`
- 问题：ADR 0174 说“ADR 0173 定的‘CI 在自己的服务器上跑’不变”，但读 ADR 0173 的决定和后果（`docs/adr/0173-hermes-runs-only-ci.md:58-64`、`:89-94`），它只讲 Hermes 的资源分配和停服务；真正写“CI 改在 Hermes 自托管 runner 运行”的是 ADR 0160（`docs/adr/0160-self-hosted-runner-on-hermes.md:10`、决定第 1 条 `:64`）。
- 影响：不影响代码，属于文档归因不精确，会让读者找错依据。
- 建议：改成引用 ADR 0160，或改写为“ADR 0173 的 Hermes 资源决定不变；CI 仍按 ADR 0160 在自托管 runner 上跑”。

## 推测 / 未核实

- 作者说新增测试在 Hermes 上实跑并通过、旧代码上失败：我没有运行测试，**未核实实跑结果**；但按代码推演，正向 30/7 用例在旧代码上会被 `const: 1` 拒绝，确实会失败。
- ADR 0174 里“删除全部 801 个已存 artifact、失败 0 个”“三个工作流目前在 GitHub 上停用、等新 CI 服务器”属于 GitHub 外部状态，仓库代码无法证明，**未核实**。
- 用户引用的 `.claude/rules/prompt-prefix.md` 在仓库外，当前工具权限无法读取原文；我以 ADR 0149 决定第 3 条（`docs/adr/0149-append-only-model-requests.md:55`）和 ADR 0165 背景（`docs/adr/0165-freeze-the-request-head-per-conversation.md:29`）中复述的同一规则为依据。
- 我未运行测试或 lint，只做了静态核对。

## 侧重检查

- **错误路径**：`upgradeArtifactRetention` 对 `null`、非对象、缺字段、额外字段都返回原对象，随后 `validatePolicy` 的 `validateRecord` 会用当前 schema 拒绝（`check-policy.mjs:96`，`contracts.mjs:34-44`）。没有新增未捕获的异常路径。
- **不合规范/不可信输入**：基准提交来自受保护的 `main`；升级只接受精确的 `reports: 30` + `diagnostics: 7`，并且只往更严格的值 1/1 走。没有新增路径拼接、命令执行或文件写入。
- **安全/供应链**：`actions/cache` 同时从 `ci/toolchain-lock.json` 和 `install-tools.mjs` 的期望清单移除；如果以后有人重新加回缓存步骤，`validateWorkflow` 的 action-lock 检查会因不在锁定清单而失败（`check-policy.mjs:371-374`、`install-tools.mjs:118-129`）。这是正向加强。
- **资源耗尽**：缓存移除会增加每次任务的下载量，但仍受锁定 URL、摘要校验和现有超时约束；artifact 保留期改为 1 天会减少 GitHub 存储占用。没有新增无界循环。
- **不可撤销操作**：代码改动本身没有新增删除类操作；ADR 中“删除 801 个 artifact”是外部已完成动作，未核实。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次改动的 13 个文件全部是 `ci/`、`scripts/ci/`、`test/tooling/` 和文档；`grep` 没有发现任何生产 TypeScript 代码引用 `check-policy`、`quality-policy`、`toolchain-lock` 这些模块。系统提示、工具定义、历史消息和遮盖结果都没有被改动，也没有任何“发给模型的内容”发生变化。因此“只在末尾追加、每轮变化值放最后一条消息”的不变量不受影响。依据：改动文件清单；`grep` 未发现 TS 引用；ADR 0149 决定第 3 条和 ADR 0165 背景复述的规则。

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会。本次改动不进入模型请求的序列化路径。CI 侧新增的升级是确定性的：只由基准提交的字节和固定值 `30/7` 决定，没有时间字段、随机数或无序集合。`policySha256` 仍然是对基准原始字节做 `sha256`（`check-policy.mjs:1026`），不是对升级后的对象重新序列化，所以也不会因为对象键顺序或浅拷贝产生不同摘要。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有。

- `test/tooling/policy.test.mjs:697-711`：基准 30/7 时升级后等于当前策略；基准 14/7 时抛错。正向用例在旧代码上会被当前 schema 的 `const: 1` 拒绝，确实会失败；14/7 是防止升级条件被放宽的反向用例。
- `test/tooling/ci-optimization.test.mjs:19,85-98`：`usesGitHubCache` 明确匹配 `actions/cache@`、`actions/cache/restore@`、`actions/cache/save@`，并验证 `actions/checkout@`、`actions/cachet@`、`undefined` 不匹配；三个工作流都用这个函数过滤。把 helper 换回旧的 `startsWith("actions/cache@")`，restore/save 两条正向断言会失败。
- 缺口：没有“初始化 + 30/7”和“30/7 + 额外字段”的用例，见低 2。

### 4. 每个改动值的产生方和使用方是否匹配？

逐个核对后，未发现消费方不接受的值：

- `ci/policy.json` 和 `ci/policy.schema.json` 的 `retentionDays 1`：`validateRecord` 加载当前 schema（`contracts.mjs:25`、`:34-44`），`validatePolicy` 会拒绝未升级的非 1 值；`resolvePolicySource` 在验证前升级旧基准（`check-policy.mjs:989-993`）。`vitest.workspace.ts` 虽然导入 `ci/policy.json`，但只使用 `testProjects`/`registeredTests`，不读 `retentionDays`。
- `ci/quality-policy.json` 和 `scripts/ci/quality-policy.mjs` 的 1/1：`validateQualityPolicy` 的 `constant({ reports: 1, diagnostics: 1 })`、`validateQualityWorkflow` 的 upload 期望、`export-evidence.mjs:104,110,161` 的过期判断都接受 1。
- `ci/toolchain-lock.json` 删除 `actions/cache`：`install-tools.mjs:118-129` 的期望集合是 5 个，`test/tooling/toolchain.test.mjs:75` 也改为 5；`validateWorkflow`、`main-workflow.mjs`、`quality-policy.mjs` 都只从锁定清单建 action map，当前三个工作流没有缓存步骤，因此都能接受。
- `policySha256`：`context.mjs:130-143`、`run.mjs:86`、`required.mjs:19-26`、`test.mjs:27`、`check-coverage.mjs:523-527`、`aggregate.mjs:285-290`、`export-evidence.mjs:113-119`、`security-exceptions.mjs:198-199` 都用同一个 `baseSha` 重新计算并比较，升级只改内存对象，不影响摘要，读下来是一致的。
- 一个隐含前提：`main-evidence.mjs:164,218` 不是用 `resolvePolicySource`，而是读当前检出的 `ci/policy.json` 与 `context.policySha256` 比较。对这个 PR 的合并推送，`pushIdentity` 会因为 `ci` 有 diff 先报 `MAIN_VALIDATION_CHANGED`（`main-evidence.mjs:59-71`）走 full 路径，所以不会实际触发不一致；但这是一个依赖“改策略必走 full”的前提，值得知道。
