## 结论

本次修复方向正确：只在 `main.yml` 的 `full` 调用方作业上补了权限，`ci.yml` 本身未改。**未发现会阻止合并的功能性错误**。下面按严重度列出发现；文末逐条回答必答问题。

---

## 问题

### 1. 中 — 现行设计文档仍写着“只有 required 有写权限 / 不配置 write”，与本次代码不一致（读代码证实）

- 文件:行：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:129`、`:274`；`docs/adr/0201-delete-run-reports-after-gate-passes.md:51`
- 问题：本次把 `actions: write` 加到了 `main.yml` 的 `full` 调用方作业；但现行设计规范仍写“只有该作业有 `actions: write` 权限”和“不配置 write”。这会让后续读者/代理误以为 `main.yml` 不应出现写权限，和刚修的启动失败原因正好相反。
- 证据：
  - `.github/workflows/main.yml:63-66` 新增：
    ```yaml
    permissions:
      contents: read
      actions: write
      pull-requests: read
    ```
  - 设计规范 `:129` 原文：“只有该作业有 `actions: write` 权限”。
  - 设计规范 `:274` 原文：“不配置 write、`id-token: write` 或生产 Secret。”
  - ADR 0201 `:51` 只说明 `ci.yml` 内 `required` 的权限，没有说明调用方 `main.yml` 的 `full` 必须授予同一上限。
- 建议：更新 `:129` 为“`ci.yml` 内只有 `required` 有 `actions: write`；`main.yml` 的调用方 `full` 必须授予同一权限，否则被调用工作流启动失败”，并在 `:274` 写清这个唯一例外；ADR 0201 补一句调用方权限要求。

### 2. 中低 — 新增的跨工作流权限覆盖检查不在本地必过门槛 `npm run check` 里（读代码证实）

- 文件:行：`test/tooling/ci-optimization.test.mjs:127-144`、`package.json:26-27`、`scripts/ci/run.mjs:235-242`、`.agents/instructions/delivery-mode.md:27`
- 问题：新增的 `[I-93]` 测试只属于 `tooling` 项目，由 CI 的 `policy` 作业运行；它没有被加入 `npm run check` 的 `check:steps`。仓库规则明确“合并进 main 不等待 `ci/required`，本地 `npm run check` 仍是必过门槛”。因此作者说法 2 中“以后 ci.yml 任何作业新增更高权限而 main.yml 没跟上，测试会失败”在**本地合并门槛**上并不成立，只在 CI 的 tooling 运行中成立。
- 证据：
  - `package.json:27` 的 `check:steps` 列出的步骤里没有运行 `test/tooling/ci-optimization.test.mjs`。
  - `ci/policy.json:193-197` 把 `test/tooling/**/*.test.mjs` 放进 `tooling` 项目。
  - `scripts/ci/run.mjs:235-242` 只在 CI 的 `policy` 检查里执行 `vitest(check.projects)`。
  - `.agents/instructions/delivery-mode.md:27`：“合并进 `main` 不等待 `ci/required`……上面的本地基本检查仍是必过的门槛”。
- 补充：本次具体回归本身仍会被本地 `npm run check:ci-policy` 拦住，因为 `validateMainWorkflow` 在 `scripts/ci/main-workflow.mjs:32-36` 精确要求 `full.permissions`；所以不是当前修复无效，而是**新增的“覆盖循环”**没有进入本地门槛。
- 建议：把“`ci.yml` 每个 job 请求的权限必须 ≤ `main.yml` `full` 授予”并入 `check-policy`（它已经同时读 `ci.yml` 和 `main.yml`），或在 `check:steps` 增加一个专门检查脚本。

### 3. 低 — 新测试只给 `validateMainWorkflow` 写了反向用例，权限覆盖循环没有自动反向夹具（读代码证实）

- 文件:行：`test/tooling/ci-optimization.test.mjs:127-143`
- 问题：测试前半段的覆盖循环（`requested` ≤ `granted`）没有任何失败路径用例；唯一的反向用例只验证把 `actions: write` 改成 `actions: read` 后 `validateMainWorkflow` 抛 `full-permissions`。如果循环本身写错（例如用错 `granted`、漏掉 ci 顶层权限、跳过某个 scope），现有自动测试不一定能发现。
- 证据：
  - `:132-138` 的循环只有 `expect(...).toBeGreaterThanOrEqual(...)`，没有反向输入。
  - `:141-143` 只调用：
    ```js
    validateMainWorkflow(text.replace("      actions: write\n", "      actions: read\n"), tools)
    ```
  - 作者说明中的“把 main.yml 退回修复前，用例失败”是人工证据，不是提交的自动夹具。
- 建议：把权限覆盖判断抽成纯函数，并增加一个“ci.yml 请求了 `actions: write`、main 只授予 `actions: read` 时必须抛错”的直接用例；或在内存中篡改解析后的 `ci` 对象来驱动循环失败。

### 4. 低 — `full.permissions` 用 `JSON.stringify` 精确比较，依赖 YAML 键顺序（读代码证实）

- 文件:行：`scripts/ci/main-workflow.mjs:32-36`
- 问题：权限对象的语义与键顺序无关，但当前写法要求键顺序也必须完全一致。以后只把 `contents`、`actions`、`pull-requests` 重排就会误报 `full-permissions`。
- 证据：
  ```js
  JSON.stringify(full.permissions) ===
    JSON.stringify({ contents: "read", actions: "write", "pull-requests": "read" })
  ```
- 建议：按键集合比较（排序键或逐项比较），同时保留“不得出现额外 scope / 额外 write”的显式断言。

### 5. 低（推测，依赖外部 GitHub 语义）— “其余作业只读”没有被仓库内测试证明

- 文件:行：`.github/workflows/main.yml:63-66`、`.github/workflows/ci.yml:21-23,379-386`、`test/tooling/ci-optimization.test.mjs:159-160`
- 问题：作者说法 1 的“只有 required 需要 `actions: write`，其余作业只读”依赖 GitHub 对可复用工作流的权限继承语义：调用方 `full` 的 `actions: write` 是上限，而 `ci.yml` 中未声明 `permissions` 的作业使用 `ci.yml` 顶层只读权限。仓库内没有运行时测试证明这一继承行为；现有测试只检查显式写在 job 上的 `permissions`，不能证明未声明的 job 实际拿到的是 `ci.yml` 顶层而不是调用方的写权限。
- 证据：
  - `ci.yml` 中只有 `required` 有 `job.permissions`，其余 job 依赖顶层 `permissions`。
  - `ci-optimization.test.mjs:159-160` 只遍历 `job.permissions`，未验证未声明权限的 job 的实际令牌权限。
- 建议：若要把“只有 required 有写权限”做成强保证，可以给 `ci.yml` 其余 job 也显式声明只读 `permissions`，或在文档中明确记录该继承依据。此条是安全保证层面的推测，不是已确认的漏洞。

---

## 读代码证实的

- 改动只涉及 `.github/workflows/main.yml`、`scripts/ci/main-workflow.mjs`、`test/tooling/ci-optimization.test.mjs`、`docs/incidents-and-gates.md`，没有改提示词、工具定义、历史消息或遮盖逻辑。
- `docs/incidents-and-gates.md` 只被 `scripts/check-incident-gates.mjs`、`scripts/check-agent-rulebook-inventory.mjs` 读取，不在模型请求组装路径。
- `main.yml` 新权限位于 `full` 作业；`plan`、`confirm` 仍没有 job 级 `permissions`，继续使用工作流级 `actions: read`。
- `ci.yml` 中只有 `required` 显式申请 `actions: write`；`check-policy` 的 `requireReadPermissions` 也只允许 `required` 带 `actions: write`。
- `validateMainWorkflow` 的新错误码是 `full-permissions`，只有 `main-workflow.mjs` 产生、`ci-optimization.test.mjs:143` 使用。
- `[I-93]` 事故行只用一次，未发现重复；ID 格式、日期、状态、次数、引用的 `test/tooling/ci-optimization.test.mjs` 和 `scripts/ci/main-workflow.mjs` 路径都存在，按 `check-incident-gates.mjs` 的规则可通过。
- `npm run check:ci-policy` 会调用 `validateMainWorkflow`，所以如果把 `main.yml` 的 `full.permissions` 退回修复前，本地 `npm run check` 也会失败。
- `npm run check:ci-policy` 的 `check:steps` 不运行 `test/tooling/ci-optimization.test.mjs`，所以该新测试的覆盖循环本身不是本地必过门槛。

## 推测 / 未核实

- GitHub 对可复用工作流中“未声明 `permissions` 的 job 继承哪个层级权限”的实际运行时行为：未在本地复现，依据 GitHub 文档语义推断；仓库内没有运行时验证。
- 修复后 `main.yml` 是否真正不再 `startup_failure`：无法调用 GitHub Actions，属于外部运行结果，未核实。
- I-93 事故行中的“30 多次合并完全没有跑 CI”“2026-11-10 16:11 起”属于 GitHub 运行记录，未在仓库内核实。
- `test/qualification/evidence/.../frozen-inputs.json` 和 `.agents/tasks/hermes-runner/evidence.jsonl` 里存在 `main.yml`、`main-workflow.mjs`、`ci-optimization.test.mjs` 的旧哈希；没有找到当前测试或脚本拿它们和当前工作树比较，但离线资格流程是否会读取这些历史证据，未进一步核实。

---

## 侧重检查

- **错误路径**：`validateMainWorkflow` 在权限缺失、权限被改成 `read` 时抛 `full-permissions`；测试覆盖了 `read` 反向；权限覆盖循环没有自动化反向夹具（见问题 3）。
- **不合规范 / 不可信输入**：`main-workflow.mjs` 用 `parseDocument(..., { uniqueKeys: true, maxAliasCount: 0 })`，拒绝重复键和别名膨胀；测试读的是仓库内受信任的 YAML，不处理外部输入。YAML 键顺序被 `JSON.stringify` 精确比较，存在误报风险（见问题 4）。
- **安全**：`actions: write` 是仓库级、不是单次运行级；现有删除脚本 `scripts/ci/delete-run-reports.mjs:10,19-32` 只删除 `report-<runId>-<attempt>-` 前缀的 artifact，`gate-` 和 `diagnostic-` 不受影响。权限范围扩大是 ADR 0201 已接受的代价；本次只是让 main 运行也能真正执行该流程。其余 job 是否实际保持只读依赖 GitHub 继承语义（见问题 5）。
- **资源耗尽**：没有新增循环或模型请求；测试循环只遍历有限个 YAML job。
- **不可撤销操作**：main 首次成功运行后会执行已有的 artifact 删除步骤；按前缀限制、汇总通过后才执行，属于 ADR 0201 的设计，不是本次新增的删除逻辑。
- **规则、说明文档和代码一致性**：`I-93` 行与代码基本一致；但现行设计文档和 ADR 0201 仍把写权限描述成只有 `required` 才出现，未说明调用方 `main.yml` 的 `full` 也必须带 `actions: write`（见问题 1）。

---

## 必答问题

1. **这个改动会不会改变模型已经见过的请求开头？**
   **不会。** 改动只涉及 CI 工作流、CI 校验脚本、tooling 测试和事故文档。它们不在系统提示、工具定义、历史消息或遮盖逻辑的组装路径上；`docs/incidents-and-gates.md` 只被 CI 检查脚本读取。没有任何“把会变的值从末尾挪到开头”或改写历史的行为。据此仍符合[只追加规则](../../.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   **不会。** 本次没有引入依赖前后文的遮盖、时间字段或无序集合序列化。新增的权限对象和错误码不进入模型请求；事故行里的日期是固定文本。测试中遍历 YAML job 的顺序来自文件顺序，只用于校验，不进入模型输入。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   **有，但不完整。** CI 的 `policy` 作业会通过 `tooling` 项目运行新测试；`validateMainWorkflow` 另有本地 `npm run check:ci-policy` 覆盖。`actions: write` 改成 `read` 时 `validateMainWorkflow` 会抛 `full-permissions`，这一点从代码路径上成立。但新测试的“权限覆盖循环”没有自动反向夹具，作者所说“退回修复前测试失败”只是人工证据；另外该测试本身不在 `npm run check` 的 `check:steps` 里。因工具限制未实际运行测试，以上来自代码阅读。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `main.yml` 新增的 `contents: read`、`actions: write`、`pull-requests: read`：GitHub Actions 工作流 schema 接受；与 `ci.yml` 顶层权限和 `required` 权限一致。
   - `full-permissions`：由 `scripts/ci/main-workflow.mjs:35` 产生，只由 `test/tooling/ci-optimization.test.mjs:143` 断言，未发现其他注册表或使用方。
   - `I-93` 和事故行：按 `check-incident-gates.mjs` 的规则，ID、日期、状态、次数、gate 路径均合法；引用的两个路径都存在；未发现重复 ID。
   - `test/tooling/ci-optimization.test.mjs`：文件存在，且被 `ci/policy.json` 的 `tooling` 项目匹配。
   - **不接受的只有文档侧**：现行设计规范仍写“只有该作业有 `actions: write`”和“不配置 write”，与 `main.yml` 新增的调用方写权限相反（见问题 1）。
   - 历史资格证据里的旧哈希未发现被当前检查消费，未进一步核实其离线用途。
