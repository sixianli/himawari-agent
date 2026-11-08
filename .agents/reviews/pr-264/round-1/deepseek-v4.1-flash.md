## 结论

改动没有触及模型请求的组装、系统提示、工具定义、历史或遮盖，因此不会改变模型已经见过的请求开头。真正的问题在 CI 策略迁移：`ci/policy.schema.json` 改成 `const: 1` 后，代码仍用“当前 schema”校验“基准提交里的旧策略”，而基准仍是 30/7。影响不只是 `check-policy` 报一次，而是本 PR 和合并后第一次 `main` 的所有 job 在创建 Context 时就失败。

## 问题（按严重度）

### 高：新 schema 会让本 PR 和合并后第一次 main 的所有 job 在创建 Context 时失败

**[读代码证实，未运行测试]**

- `ci/policy.schema.json:188-193`：

```json
"reports": {
  "const": 1
},
"diagnostics": {
  "const": 1
}
```

- 基准提交 `ba915c` 的 `ci/policy.json` 末段仍是：

```json
"retentionDays": {
  "reports": 30,
  "diagnostics": 7
}
```

- `scripts/ci/check-policy.mjs:981` 从基准提交读策略，然后调用 `validatePolicy`：

```js
const policy = validatePolicy(upgradeHostedRunnerPolicy(JSON.parse(bytes)), {
```

- `scripts/ci/check-policy.mjs:85` 和 `scripts/ci/contracts.mjs:25,28` 用当前工作树的 schema 校验：

```js
validateRecord("CheckPolicy", policy);
...
const policySchema = readJson(path.join(repositoryRoot, "ci/policy.schema.json"));
...
CheckPolicy: ajv.compile(policySchema),
```

- `scripts/ci/context.mjs:97-111` 在 PR 时取 merge commit 的第一父提交作为 `baseSha`，在 push 时取 `payload.before`：

```js
baseSha = parents[0];
...
baseSha = commit(/^0{40}$/u.test(payload.before ?? "") ? base : payload.before);
```

- `scripts/ci/context.mjs:130` 每个 job 创建 Context 时都会读基准策略：

```js
const source = resolvePolicySource({ root, base: baseSha });
```

- 不止 `check-policy`。`scripts/ci/run.mjs:86`、`scripts/ci/required.mjs:20`、`scripts/ci/aggregate.mjs:285`、`scripts/ci/security-exceptions.mjs:198`、`scripts/ci/check-coverage.mjs:523`、`scripts/ci/test.mjs:27` 都调用 `resolvePolicySource({ ..., base: context.baseSha })`。

因此：

- 本 PR 的 PR CI：`baseSha` 是改动前的 main，策略是 30/7，用新 schema 的 `const: 1` 校验，直接抛错。不是只失败 `policy` 一个 job，而是所有需要 Context 的 job 都失败。
- 合并后第一次 `main` 推送：`payload.before` 是旧的 main（30/7），同样所有 job 失败。之后 main 自身变成 1/1，后续推送才正常。
- 作者说“本 PR 的 CI 和合并后第一次 main 确认会被拒一次”，这个描述低估了影响：是整套 CI 无法创建 Context，不只是 `check-policy` 的一次拒绝。

建议：不要把它当作已知问题留在 PR 里。正确做法是在 `resolvePolicySource` 里用**基准提交自己的 `ci/policy.schema.json`** 校验基准策略，当前工作树的 schema 只校验 proposed 策略；初始化或基准没有 schema 时再回退当前 schema。这样以后任何 schema 迁移都不会用新规则拒绝已接受的旧基准。最小替代方案是仿照 `upgradeHostedRunnerPolicy` 增加一个显式的旧 retention 升级函数，并用“基准为 30/7、当前 schema 为 1”的测试固定住。无论哪种，都需要新增回归测试；现有 `test/tooling/policy.test.mjs:647-658` 的基准策略是用当前 `clone()`（已经是 1/1）写的，覆盖不到真实的 30/7 → 1/1 迁移。

### 中：`export-evidence` 的 1 天过期语义没有区分性测试

**[读代码证实，未运行测试]**

- `test/tooling/evidence.test.mjs:199`：

```js
expect(() => exportEvidence({ ...input, now: input.now + 31 * 86_400_000 })).toThrow("EXPIRED");
```

- `scripts/ci/export-evidence.mjs:110`：

```js
now - created >= policy.retentionDays.reports * 86_400_000
```

这条反向用例在旧值 30 天和新值 1 天下都会通过：31 天大于 30，也大于 1。也就是说，即使 `retentionDays` 仍留在 30，或者 `export-evidence` 没有真正读取新值，这条测试都不会失败。建议增加能区分 1 天和 30 天的用例，例如 `+2` 天必须过期、`+23` 小时必须仍有效，并断言 `expiresAt` 等于 `created + 1 天`。

### 中低：新缓存测试只匹配 `actions/cache@`，漏掉子 action

**[读代码证实，未运行测试]**

- `test/tooling/ci-optimization.test.mjs:80` 和 `:88`：

```js
expect(job.steps.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(false);
...
expect(steps.filter((s) => s.uses?.startsWith("actions/cache@"))).toEqual([]);
```

如果以后有人加回 `actions/cache/restore@<sha>` 或 `actions/cache/save@<sha>`，这个测试不会命中。`check-policy` 因为 `actions/cache` 已从 toolchain lock 删除，应该会以 `Action is not toolchain-locked` 拒绝，所以还有第二道防线；但这个新测试本身不完整。建议匹配 `actions/cache@` 和 `actions/cache/` 两种前缀。

### 中低：架构文档仍写 30/7 天

**[读代码证实]**

`docs/architecture-v0.1.md:639` 仍写：

> 公开报告与诊断分别按 30/7 天保留

这与新 ADR、`ci/policy.json`、`ci/quality-policy.json` 和工作流里的 1 天矛盾。作者只改了 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 的三段，没有同步这份架构摘要。建议改成 1/1 或直接引用 ADR 0174。

### 低：交接证据的过期时间按 CI run 创建时间算，可能早于 artifact 实际过期

**[代码行为证实；影响为推断]**

- `scripts/ci/export-evidence.mjs:106`：

```js
const created = Date.parse(metadata.created_at);
```

- `scripts/ci/export-evidence.mjs:110` 用这个 `created` 判断 1 天过期；`expiresAt` 也在 `:161` 用它计算。

GitHub artifact 的 1 天保留期大致从**上传时间**算，而这里从**run 创建时间**算。结果是：artifact 还没过期时，交接证据可能已经先报 `CI_HANDOFF_EVIDENCE_EXPIRED`。这是保守方向，不会接受已过期证据，但在 1 天窗口下会放大误拒绝。若要保持精确，应改用 artifact 的上传/创建时间，或明确留出运行时长余量。

另外，`quality.yml:296-307` 的两个 `actions/download-artifact` 步骤没有 `continue-on-error`；如果 CI run 的 artifact 已超过 1 天，job 会在下载步骤失败，而不是在 `export-evidence` 里给出更明确的 `CI_HANDOFF_EVIDENCE_EXPIRED`。这是错误路径可读性问题，不是安全漏洞。

## 核对结果：作者已知点

**1. `check-policy` 从基准读策略的推断：成立，而且影响更大。** 见上面的高严重度条目。不只是 `check-policy`，所有 job 的 Context 创建都会失败。是否在本 PR 处理：建议处理；最小方案是让基准策略用基准 schema 校验，或显式升级旧 retention。否则一旦重新启用 Actions，本 PR 无法通过 required check，合并后第一次 main 也会全红。

**2. `export-evidence` 读取 `retentionDays` 的地方：都能接受值 1。**
- `scripts/ci/quality-policy.mjs:154,161,210`：生成期望工作流时使用 1，当前 `quality.yml` 的所有上传步骤也是 1。
- `scripts/ci/export-evidence.mjs:110,161`：数值 1 没有最小值/枚举限制，能正常参与计算；行为是 1 天后过期。
- 测试 `quality-policy.test.mjs:262`、`runner.test.mjs:360`、`quality-local.test.mjs:289`：仍会拒绝非 1 值。
- 唯一不能接受旧值的地方是基准策略校验，见高严重度条目。

**3. 删除 `actions/cache` 后仓库里的其它引用：没有发现遗漏。** `grep` 只命中：
- `test/tooling/ci-optimization.test.mjs:80,88`（断言用）
- `docs/adr/0174-...md:30,35,63,65`（说明用）

没有脚本或工作流仍在使用 `actions/cache`。`ci/toolchain-lock.json` 现在是 5 个 action，`scripts/ci/install-tools.mjs:118-124` 的期望清单同步为 5 个，`test/tooling/toolchain.test.mjs:75` 也改成 5。`scripts/ci/main-workflow.mjs` 只需要 `actions/checkout` 和 `actions/download-artifact`，这两个仍在锁文件里。

## 侧重检查

- **错误路径：** 基准策略是旧 30/7、当前 schema 是 1，导致所有 job 在 `resolvePolicySource` 处失败。读代码证实。见高严重度条目。
- **错误路径：** `main.yml` 的 plan job 下载候选 PR artifact 时允许失败（`continue-on-error`），`scripts/ci/main-evidence.mjs:117` 过滤 `!a.expired`，`main()` 在失败时回退 `mode: "full"`（`:228-233`）。所以 artifact 过期不会伪造成功，只会多跑一次完整 CI。读代码证实。
- **错误路径：** `quality.yml` 的 handoff 下载步骤没有失败回退；artifact 过期时在下载步骤失败，错误信息不如 `CI_HANDOFF_EVIDENCE_EXPIRED` 明确。读代码证实。
- **不可信输入：** 本次没有新增解析外部输入的路径。`retention-days` 是工作流里的字面量，不是运行时输入；`retentionDays` 由 schema/常量校验。未发现新的注入或路径穿越问题。
- **供应链安全：** 去掉缓存降低了缓存投毒面；工具和 Action 仍按锁文件下载并校验摘要，Action SHA 仍锁定。未发现直接安全退化。测试对 `actions/cache/restore@` 的漏配见中低条目。
- **资源耗尽：** 去掉缓存后 9 个 job 都重新下载工具和依赖，网络、磁盘和总时长都会上升；ADR 已承认每 job 约多 40 秒，但没有代码层面的新限制。属于运行成本风险，不是正确性错误。
- **不可撤销操作：** artifact 1 天后自动删除，交接证据必须在 1 天内转存；这是不可逆的数据生命周期变化。ADR 声称已通过 GitHub 接口删除 801 个 artifact、失败 0 个，这一点无法从代码核实，标记为未核实。

## 必答问题

**1. 改动会不会改变模型已经见过的请求开头？**

不会。本 diff 只改 `ci/` 策略、toolchain lock、CI 测试和文档，没有改 `packages/runtime-pi`、系统提示、工具定义、历史消息或出口遮盖。`prompt-prefix.md` 要求这些内容只能追加、每轮变化的值只能放最后一条消息；本改动没有触碰这些路径。因此发给模型的内容仍然只在末尾追加，每轮变化的值仍然只在最后一条消息里。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。本次新增/修改的值都是静态常量（`1`、删除一个 lock 条目、文档文字），没有引入时间、随机数、无序集合或依赖前后文的遮盖。`expiresAt` 虽然带时间，但只写入 artifact 证据，不进入模型请求。工作流 YAML 的顺序也没有被重排。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，但不完整：
- `test/tooling/ci-optimization.test.mjs` 新测试检查三个工作流没有 `actions/cache@`、每个 upload 的 `retention-days` 是 1。静态判断：如果以后加回缓存或改成非 1，测试会失败。但它漏了 `actions/cache/restore@` / `save@`。
- `test/tooling/quality-policy.test.mjs:262` 把 diagnostics 改成 30 天，静态判断会失败；`runner.test.mjs:360`、`quality-local.test.mjs:289` 会拒绝非 1 的 quality policy。
- `test/tooling/toolchain.test.mjs:75` 把 action 数固定为 5，`validateToolchainLock` 还会校验精确清单。
- 缺口一：没有“基准策略是 30/7、当前 schema 是 1”的测试，所以本 PR 的迁移失败没有被捕获。
- 缺口二：`test/tooling/evidence.test.mjs:199` 的 +31 天反向用例无法区分 30 天和 1 天，不能证明新过期语义。

我没有运行测试，以上是读代码后的静态判断。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

- `ci/policy.json` 的 `retentionDays: 1/1`：当前 schema 接受；没有其它运行时消费者读取 `ci/policy.json` 的 retention。问题在别处：当前 schema 被用来校验旧基准，见高严重度条目。
- `ci/quality-policy.json` 的 `1/1`：`validateQualityPolicy` 的 `const` 接受；`quality-policy.mjs` 生成的期望工作流与 `quality.yml` 一致；`export-evidence` 接受并改为 1 天过期；相关测试接受。消费端本身能接受。
- `ci/policy.schema.json` 的 `const: 1`：proposed 策略能接受；但 `resolvePolicySource` 对基准策略也使用当前 schema，旧基准 30/7 不能接受，这是本次最严重的问题。
- `ci/toolchain-lock.json` 删除 `actions/cache`：`install-tools.mjs` 的期望清单已同步为 5 个；`check-policy` 只要求非空、唯一、SHA 合法；`main-workflow.mjs` 和 `quality-policy.mjs` 需要的 action 仍存在；测试数量已同步。消费端都能接受。
- 工作流里已有的 `retention-days: 1`：全部 32 个 upload 步骤都有 1，新测试的校验逻辑能接受。
- 文档：ADR 0174 和设计文档链接有效；`docs/architecture-v0.1.md:639` 的 30/7 说法没有同步，属于文档消费端不一致。
