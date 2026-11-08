工作区就是目标提交，我直接读文件。
## 复核结论（PR 289：云端复核默认经 Magpie，加入 OpenDesign）

### 读代码证实的作者说法（先给核对结果）

1. **`parseArgs(argv, { defaultGateway })` 的说法属实。** opencode-review.mjs:2436-2441：没写 `--gateway` 且 `defaultGateway` 非空时才采用，非法值抛 `ARG_INVALID HIMAWARI_REVIEW_GATEWAY`；命令行校验在 :2415-2417（只认 `magpie|direct`，报 `ARG_INVALID --gateway`）；`direct` 在 :2441 被删掉（等于不走网关）；子命令在 :2425-2434 提前 return，环境变量对 `--assert-reviewed`、`--report` 无影响；main 在 :2611-2613 传 `process.env.HIMAWARI_REVIEW_GATEWAY`。
2. **vitest.workspace.ts 说法属实**（vitest.workspace.ts:13、:47，policy.json:243 确认 tooling 项目含 `test/tooling/**`）。而且实际隔离并不依赖这条配置：parseArgs 是纯函数不读 env（:2343）；脚本子进程测试要么走子命令（opencode-review.test.mjs:2768、:2897，parseArgs 提前返回）、要么用 `/nonexistent/opencode`（在 opencode-review.mjs:2668 `opencodeBinary()` 就先报错，到不了 :2669 的网关安装）、要么显式传 `--gateway magpie`（review-gateway.test.mjs:1009-1010）。所以就算不用 workspace 配置直接跑，测试结果也不受云端环境变量影响——比作者说的更稳。
3. **gateway.json 说法属实**：`opendesign` 为 `kind:"custom"`、带 `url` 和 `models`，成员顺序 workbuddy-ai → opendesign → opencode-go（scripts/model-review/gateway.json）；`routing=order`、`stays=session` 由测试断言（review-gateway.test.mjs:159-160）。记账按模型一份单价：`summarizeGatewayUsage` 对所有非积分服务方（含 opendesign）都用 `priceOf(config, model)` 即 Go 的单价折算美元（gateway.mjs:439-447），与文档声明的限制一致。
4. **文档基本一致**：`.agents/instructions/model-review.md:119-127` 和 ADR 0178:105-107 的优先级、错误码、成员顺序、“美元按每模型一份单价算”、“新增服务方不用改代码”（startGateway 有 custom 分支，gateway.mjs:628-640；台账 parseUsage 不限制服务方 id，opencode-review.mjs:1460-1462 只限 `gateway:"magpie"`）都与代码对得上。实测数字“41 条”：我数了 review-gateway.test.mjs 正好 41 个用例（含 it.each 2 条自检）；“npm run check 41 步通过”**未核实**（我不能跑命令）。

### 发现的问题（按严重度从高到低）

**1.（中）scripts/model-review/opencode-review.mjs:2612 — `main` 把环境变量接进 `parseArgs` 的这一行没有任何自动检查**
证据：全仓库 `HIMAWARI_REVIEW_GATEWAY` 只出现在 main:2612、parseArgs:2437-2438、vitest.workspace.ts:13 和文档。测试都是直接调 `parseArgs(argv, { defaultGateway: ... })`（review-gateway.test.mjs:137-146），没有一条从 `main` 入口带着这个环境变量走。若将来有人改掉 :2612（改名、删掉、读错变量），云端复核会**悄悄退回直连**——积分底线、failover 全部失效，而 `npm run check` 全绿。这正是 I-73 的模式：改了两端，接缝没测。
建议：加一条便宜的子进程测试：`HIMAWARI_REVIEW_GATEWAY=litellm` 加最小合法参数跑脚本，断言退出码 2、stderr 是 `ARG_INVALID HIMAWARI_REVIEW_GATEWAY`（parseArgs 在安装 opencode 之前就抛错，所以这条测试几乎零开销），再补一条 `HIMAWARI_REVIEW_GATEWAY=magpie` + `--gateway direct` 断言结果里无网关（可用 `--assert-reviewed` 之外的轻路径或直接测 `--self-check-only` 前的参数解析）。

**2.（低）三成员真实顺序 CodeBuddy → OpenDesign → Go 没有自动化端到端用例**
证据：自动化的 failover 探针只用了两个成员：opencode-review.mjs:1826 `members: { [model]: ["probe-down/…", "probe/…"] }`；live 测试也是两成员（review-gateway.test.mjs:896-899）。提交的三成员顺序只有单元级断言（:162-164 的 `models=opendesign/glm-5.3-flash,opencode-go/glm-5.3-flash`）和配置校验（:488）。作者声称的“去掉 CodeBuddy 后都由 OpenDesign 回答”是手工实测，仓库里无法复核。风险有限（顺序由 groupArgs 单测钉住，preflight 会逐成员探测，缺模型会 `GATEWAY_PREFLIGHT_FAILED`，见 :930-948 的反向用例）。
建议：可接受现状；若要补，把 live 测试的 probe 成员扩成三个并断言命中顺序即可。

**3.（低）vitest.workspace.ts:6-14、:35-44 — 顺带删掉了两条与本次改动无关的注释**（GITHUB_ 环境清理的理由、integration 超时的理由）。功能无损，但这是与本 PR 无关的文档删减，混在功能提交里。建议还原或在提交说明里写明理由。

**4.（未核实项，非缺陷）**：himawari-cloud 是否真的把这个变量设成 `magpie`、OpenDesign 包月单价与 Andy 的确认、Andy 原话，都在仓库之外，无法核对。仓库内能查的部分（错误码、优先级、成员顺序、记账方式）全部一致。

### 侧重检查

走的最普通流程：云端跑一次代码复核（不带 `--gateway`）。入口 `main`（:2611）→ parseArgs 用 env 默认 magpie（:2436-2441）→ budgetCheck 台账校验（:2640-2648，既有测试覆盖）→ `readGatewayConfig` 校验含 opendesign 的新配置（gateway.mjs:74-146，review-gateway.test.mjs:488 反向用例覆盖）→ 装网关+摘要核对（lock 测试 ：391-463 覆盖）→ selfCheck 经 Magpie（真实自检测试 ：985-1022 覆盖）→ startLiveGateway 积分底线/降级（:2523-2588，:892-928 覆盖，custom 分支 ：628-640 被该测试实际执行）→ 路由组 `routing=order` 发请求 → `summarizeGatewayUsage` 按服务方记账、opendesign 按 Go 单价折美元（:411-454，:213-255 覆盖）→ `withProviderMoney` 取较大值入台账（:2494-2498，:603-621 覆盖）→ usage.jsonl 追加（parseUsage :1417-1479 覆盖）。**无覆盖的路径**：问题 1 的 main 接线；问题 2 的三成员真实顺序。文档（model-review.md、ADR 0178）与代码一致，唯上述两处缺口。

### 必答问题

1. **不会改变已见过的请求开头。** 本 PR 没碰提示词组装、工具定义、遮盖；直连配置逐字节冻结有哈希测试钉着（review-gateway.test.mjs:467-485），经网关时只把系统消息里的模型名归一、用户消息逐字节比较（:829-851）。每轮变化的值（prompt、台账）仍在最后一条消息；改动只影响路由目的地，不影响发出内容。`stays=session` 符合规则第 9 条（换服务方只付一次整段重算，不逐轮切）。
2. **不会。** members 数组顺序固定、`groupArgs` 按序 join（gateway.mjs:331-339）；本 PR 未引入时间戳、无序集合到发给模型的内容里。台账记录里有时间戳和 `Object.entries` 求和顺序，但那只是落盘产物，不发模型。
3. **部分有。** parseArgs 四条新断言、成员顺序两条、配置校验反向用例都在，且反向用例真的会失败（若 `direct` 不删、若 env 覆盖 CLI、若子命令被污染，:137-146 会挂）。缺口：main 的 env 接线（问题 1）和三成员顺序（问题 2）无自动检查。
4. **逐个核过，都能接受**：`GATEWAY_CHOICES`（:2417、:2437 两处校验一致）；`"direct"`（:2441 删除后走 :2669 的 falsy 分支=直连，台账无 gateway 字段，parseUsage 兼容）；`opendesign` id（正则 ：91 通过、非保留字 ：92、成员引用校验 ：121-127、summarizeGatewayUsage 的 known 集合来自同一 config :412、台账不限制 id、记账 ：439-447）；`kind:"custom"`（PROVIDER_KINDS :68、url+models 强制 ：101-105、startGateway :628-640 实际接线、live 测试执行过该分支）；`models` 键名未变，`readGatewayConfig(undefined, REVIEW_MODELS)`（:2670）仍按旧键校验。唯一没核的两端接缝是问题 1 所指的 main 接线——这正是 I-73 要防的那种缝。
