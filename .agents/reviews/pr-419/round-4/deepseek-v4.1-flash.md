# PR 419 第 4 轮复核结论

**范围核对**：`git diff 08e88a95..9d4fbcea -- docs/adr/0245-*.md` 只有 3 行变化（背景段 2 行、决定第 3 条 1 行）；`git diff --stat 08e88a95..9d4fbcea -- packages apps` 无输出。合并 main 带来的 `scripts/model-review/plan-claims.mjs`、`test/tooling/plan-claims-gate.test.mjs`、`.agents/instructions/model-review.md` 等，相对 PR 基准 `e711fad4` 不在 PR diff 内。

**总体判断**：第 4 轮没有改产品代码，ADR 0245 背景段改成过去时后与当前代码一致；未发现会改变模型已见请求开头、或让重发字节变化的新问题。发现 3 个低严重度文档/说明问题。

---

## 发现（按严重度）

### 1. 低 — `amends` 只写了一端，ADR 0198 缺少 `amended_by`

- **文件:行**：`docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md:7`；`docs/adr/0198-upgrade-pi-to-1-5-0.md:1-8`
- **问题**：ADR 0245 声明 `amends: "docs/adr/0198-upgrade-pi-to-1-5-0.md"`，但被修改的 ADR 0198 frontmatter 只有 `supersedes: ""`、`superseded_by: ""`，没有 `amended_by`。仓库既有做法是双向记录；这不是运行时代码问题，但属于问题 4 要求核对的“产生方/使用方两端”。
- **证据**：
  - `docs/adr/0245-...md:7`：`amends: "docs/adr/0198-upgrade-pi-to-1-5-0.md"`
  - `docs/adr/0198-...md:5-6`：`supersedes: ""` / `superseded_by: ""`，frontmatter 到第 8 行结束，没有 `amended_by`。
  - `docs/adr/0031-isolated-tool-execution.md:139`：`采用双向 amends / amended_by 元数据及正文范围链接`。
  - 既有例子：`docs/adr/0177-gitleaks-exact-value-allowlist.md:8` 有 `amended_by: "docs/adr/0190-..."`；`docs/adr/0176-ci-on-ovh-vps.md:9` 有 `amended_by: "docs/adr/0241-..."`。
- **建议**：在 ADR 0198 frontmatter 加 `amended_by: "docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md"`。`scripts/check-adr-numbers.mjs` 不检查 `amends`/`amended_by`，目前没有自动检查会发现这个缺口。

### 2. 低 — ADR 0198 决定 7 的原句仍与代码相反

- **文件:行**：`docs/adr/0198-upgrade-pi-to-1-5-0.md:55`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1171-1172`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1188-1196`
- **问题**：原句仍写“模型返回 503 时，同一轮不会再发第二次请求”，但当前请求层会对 503 重发同一份请求，测试也明确按 3 次尝试（首次 + 2 次重发）设计。虽然括号里已注明“这一句已被 ADR 0245 修订”，字面句子仍会误导读者。
- **证据**：
  - `docs/adr/0198-...md:55`：`模型返回 503 时，同一轮不会再发第二次请求，下一轮请求仍以第一轮请求开头。`
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1171-1172`：`maxRetries: MODEL_REQUEST_MAX_RETRIES,` / `maxRetryDelayMs: MODEL_REQUEST_MAX_RETRY_DELAY_MS,`；常量在 `:443-444` 为 `2` 和 `10_000`。
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts:1190`：`index >= 1 && index <= 3 ? { status: 503, retryAfter: "0" } : ...`；`:1194` 期望 `server.bodies` 长度为 5（第 2 轮共 3 次尝试）。
- **建议**：把原句改成“请求层会重发同一份请求，最多 2 次；下一轮请求仍以第一轮请求开头”，或把旧句放进明确的历史说明块，避免和现行决定同时按字面生效。

### 3. 低 — 背景句“本 ADR 把它改成 2 次”没有限定范围

- **文件:行**：`docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md:30`；同文件 `:54`；`packages/runtime-pi/src/pi-model-transport.ts:376`
- **问题**：背景段说“发出 HTTP 请求那一层的重试……本 ADR 把它改成 2 次”，但没有限定“聊天和压缩摘要请求”。代码里后台调用（标题、邮件判断、记忆整理）仍走 `pi-model-transport.ts`，`maxRetries: 0`。ADR 决定第 7 条已经写明范围，但背景段单独读会被误解为所有请求层调用都改成 2 次。
- **证据**：
  - `docs/adr/0245-...md:30`：`以及发出 HTTP 请求那一层的重试，这一层原来的次数也是 0，本 ADR 把它改成 2 次。`
  - `docs/adr/0245-...md:54`：`范围：只覆盖聊天请求和压缩摘要请求。标题、邮件判断、记忆整理等后台调用走 ... 仍然 maxRetries: 0`
  - `packages/runtime-pi/src/pi-model-transport.ts:376`：`maxRetries: 0,`
- **建议**：在背景句加“聊天和压缩摘要请求的”限定，例如“聊天和压缩摘要请求在发出 HTTP 请求那一层的重试，原来的次数也是 0……”。

### 4. 低 — 作者说明不完整

- **文件:行**：`docs/adr/0245-...md:50`；提交 `862436ba`；合并提交 `4e8e9147`
- **问题**：作者说第 3 轮后“只有背景段改成过去时”，但 `862436ba` 同时改了决定第 3 条的开头措辞（`原来只许每次调用发一次请求。改成：` → `单次请求规则放宽为：`）。语义没有变，但“只改背景段”的描述不完整。另外，合并 main 带来的 plan-claims 工具/测试是第 4 轮核对所用的检查，不完全是“无关文件”。
- **证据**：
  - `git show 862436ba` 显示 `@@ -47,7 +47,7 @@` 同时修改决定第 3 条。
  - `git diff --stat 08e88a95..9d4fbcea` 显示 `scripts/model-review/plan-claims.mjs`、`test/tooling/plan-claims-gate.test.mjs`、`.agents/instructions/model-review.md` 等由合并带入。
- **建议**：作者说明里补一句“决定第 3 条只改措辞、语义不变”，并说明合并带来的是方案说法门槛工具，避免复核者误以为不用看。

---

## 读代码证实的

- 旧代码确实两层重试都是 0：`git diff e711fad4..9d4fbcea -- packages/runtime-pi/src/pi-runtime-adapter.ts` 显示 `maxRetries: 0` → `MODEL_REQUEST_MAX_RETRIES`；当前 `:1491` 仍是 `retry: { enabled: false, maxRetries: 0 }`。
- 当前聊天/压缩摘要请求传 `maxRetries: 2`、`maxRetryDelayMs: 10_000`（`:443-444`、`:1171-1172`）；后台调用仍是 `maxRetries: 0`（`pi-model-transport.ts:376`）。
- 网关重发规则：`gateway-observation.ts:138-139` 定义 `RESENDABLE_STATUSES = new Set([408, 409, 429])`、`MAX_GATEWAY_RESENDS = 2`；`:169-176` 只在 408/409/429/5xx 时重置 `sent`，其他非 2xx 和成功响应后再发会抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；网络错误在 `:165-168` 保存并重抛原错误。
- 出口遮盖重发复用：`model-egress.ts:196-208` 在 href、method、body 都相同时复用上一次 `redacted` 请求体；`:203-204` 对已拒绝请求直接重抛同一个 `ModelEgressRefusalError`，不会重复上报。
- 拒绝日志：`provider-rejection-observation.ts:10-13` 将头部截到 128；`:42-49` 只取 `retry-after-ms`/`retry-after`、`x-should-retry` 和 `host`；`service-main.ts:2534-2542` 写 `model.request_rejected`，字段为 `runId`、`status`、`retryAfter`、`shouldRetry`、`host`；`service-runtime.ts:67-73` 的 `writeServiceDiagnostic` 接受这些类型并对整行做 `redactMachineSecrets`。
- 测试源码中反向用例存在，且按代码逻辑看能失败：
  - `gateway-observation.unit.test.ts:26、35、47、60` 覆盖成功后再发、网络错误、不可重试状态、重发次数耗尽。
  - `model-egress.unit.test.ts:583、610、680、708` 覆盖拒绝重发、不同请求体、自带请求体、遮盖字节相同。
  - `prompt-prefix.compat.test.ts:1188、1203、1224、1239` 覆盖 503 重发字节相同、429 重发、密码遮盖、长等待立刻失败。
- ADR 编号检查：`scripts/check-adr-numbers.mjs` 要求文件名“四位编号-小写短名”、标题编号一致、链接文件和锚点存在；ADR 0245 文件名、标题、`#decision` 锚点均满足。仓库内当前最大编号就是 0245。

## 推测 / 未核实

- **pi-ai 真实错误文本格式未核实**：`pi-runtime-adapter.ts:446-452` 的 `providerStatusOf` 假设错误以 `Server requested \d+s retry delay (max: \d+s). ` 开头，后面紧跟状态码。测试里的字符串是构造的；仓库里没有安装 `@earendil-works/pi-ai` 的 `dist/utils/provider-retry.js`，无法确认真实格式。如果真实文本没有状态码或格式不同，超时错误会被归为 `PI_MODEL_ERROR` 而不是 `PI_MODEL_RATE_LIMITED`，与 ADR 决定 5 不一致。
- **生产日志数字未核实**：`out.txt` 不在仓库，`00:13:42Z`、154 次操作、349 ms 等无法核对。
- **外部产品说法未核实**：OpenAI/Anthropic 官方 SDK 默认重试 2 次、Pi 的 0.5 秒指数退避等无法上网核对。
- **plan-claims 第 4 轮记录未核实**：`.agents/reviews/topic-pr419-adr0245/` 被本次复核规则禁止读取，无法确认“40 条全部一致”和 SHA 是否匹配；我只能独立核对 ADR 改动与代码。
- **未合并 PR 的 ADR 编号冲突未核实**：无法查看其他未合并 PR 是否也新增了 0245。
- **单轮总等待是否有运行级上限未核实**：ADR 说单次请求最多约 22 秒，但没有看到跨多次模型调用的总重试预算；是否有 run deadline 兜底未核实。

---

## 侧重检查

- **错误路径**：网关网络错误重抛原错误、非 2xx 不可重试、成功后再发禁止、重发次数耗尽，代码与 ADR 一致，反向用例齐全。出口遮盖拒绝路径会重抛同一个拒绝且不重复上报，代码与 ADR 一致。
- **不可信输入/安全**：`model.request_rejected` 只记录状态码、`retry-after`、`x-should-retry`、host；头部截到 128 字符，host 不含路径、密钥和内容，整行再经 `redactMachineSecrets`。未发现新增泄露路径。
- **资源耗尽**：重试上限是 2 次、等待上限 10 秒；单次请求约 22 秒。跨多次模型调用的总等待没有明显新上限，是否有运行级 deadline 兜底未核实。
- **不可撤销操作**：连接错误重试可能让服务方已处理的请求再次生成；ADR 后果段明确接受这个风险，代码没有增加幂等键，与 ADR 一致。
- **规则/文档一致**：`.claude/rules/prompt-prefix.md:74` 已更新为“请求层只重发字节完全相同的请求（最多 2 次）”，与代码和测试一致；`docs/pi-development-guide.md:326` 写 `maxRetries: 2`、`maxRetryDelayMs: 10000`，与代码一致。发现 ADR 0198 缺少 `amended_by`、决定 7 原句仍与代码相反两处文档问题。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**第 4 轮增量（只改 ADR 文档）不会。** 产品代码相对 PR 基准没有变。就整个 PR 的请求层重试改动而言：重试只重发同一份 HTTP 请求，不修改系统提示、工具定义或历史；Pi 的自动重试仍关着（`pi-runtime-adapter.ts:1491`），不会追加 `context_edit`。测试 `[ADR-0198]` 检查了持续 503 时下一轮请求仍以第一轮开头（`prompt-prefix.compat.test.ts:1188-1196`）。**发给模型的内容仍然只在末尾追加；每轮会变的值仍只在最后一条消息里，没有因这次改动挪到前面。**

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 重发路径复用第一次遮盖后的请求体：`model-egress.ts:196-208` 在地址、方法、请求体完全相同时直接返回上一次的 `redacted`；`model-egress.ts:203-204` 对已拒绝请求直接重抛同一个拒绝。测试 `model-egress.unit.test.ts:680` 断言第 2、3 次请求体与第 1 次完全相同。日志事件新增的 `timestamp` 是日志行的，不在模型请求内容里。**未发现新的时间字段、无序集合或依赖后文的遮盖。**

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有。** `check:prompt-prefix` 的 `[ADR-0198]`、`[RETRY-429]` 用例覆盖 503/429 重发、字节相同、无 `context_edit`、长等待立刻失败；`gateway-observation.unit.test.ts` 覆盖网关重发和四类反向路径；`model-egress.unit.test.ts` 覆盖遮盖复用和三类反向路径；`provider-rejection-observation.unit.test.ts` 覆盖日志字段和截断。按源码逐条核对，这些反向用例在对应行为回退时会失败（例如把网关重发次数改错、把遮盖记忆改成只按 URL 命中、把长等待改成继续重试）。**未运行测试**（本次工具限制只能读代码）。ADR 文档层面还有 plan-claims 门槛，但它只验证引文在 HEAD 中存在，验证不了“引文真的能证明这句话”；记录内容因路径限制未核实。

### 4. 每个新值的产生方和使用方都能接受吗？

逐个核对结果：

- `maxRetries: 2`、`maxRetryDelayMs: 10_000`：产生于 `pi-runtime-adapter.ts:443-444`，传给 Pi 模型层（`:1171-1172`）；`model-accounting.unit.test.ts` 断言了这两个参数。后台调用仍是 `maxRetries: 0`（`pi-model-transport.ts:376`），与 ADR 决定 7 一致。
- 网关 `MAX_GATEWAY_RESENDS = 2`、`RESENDABLE_STATUSES`：只在 `gateway-observation.ts` 内产生和使用，测试覆盖。
- `model.request_rejected` 及 `runId`、`status`、`retryAfter`、`shouldRetry`、`host`：产生于 `provider-rejection-observation.ts`，经 `service-main.ts:2534-2542` 交给 `writeServiceDiagnostic`；后者签名接受 `string | number | boolean | readonly string[]`（`service-runtime.ts:67-73`），字段类型都能通过，没有发现下游 schema 拒绝。日志整行还会再做一次机器密钥遮盖。
- `providerStatusOf` 的新错误前缀匹配：产生方是 pi-ai 的真实错误文本（未核实），使用方是 `modelFailureCode` / `loggableModelFailure`；测试只用了构造字符串，真实格式未核实。
- ADR 编号 0245：`check-adr-numbers` 的文件名、标题、链接锚点检查按源码看都能通过；仓库内没有第二个 0245，未合并 PR 的编号冲突未核实。
- `amends` 指向 ADR 0198：**另一端缺少 `amended_by`**，见发现 1；`check-adr-numbers` 不检查这个字段，所以没有自动检查兜底。
