抓取到的完整 Magpie 参考文档已保存至本地。我来从中搜索一下关于路由、会话亲和性以及配额的具体内容。
已读完仓库相关代码与 Magpie 一手文档，结论如下。

# 方案：方案讨论/代码复核经 Magpie 路由

## 一、方案依赖的前提

**读代码或 Andy 已核实事实证实的（文件:行 / 网址 + 原话）：**

1. 复核脚本把服务方写死、模型名固定为 `REVIEW_MODELS`，这两个字符串被账本校验、verdict 校验、侧重（lens）、`--models` 解析、替补逻辑共同消费：
   - `scripts/model-review/opencode-review.mjs:24`：`export const REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];`
   - `scripts/model-review/opencode-review.mjs:96`：`provider: { "opencode-go": provider }`（真实运行时 `provider = {}`，自检时才有 `options.baseURL`，见 `:92`）。
   - 消费点：verdict 校验 `REVIEW_MODELS.includes(verdict.model)`（`:919`）、侧重表键 `MODEL_LENSES[...]`（`:179-184`）、账本 `parseUsage`（`:1316`）、` покрытие coveragePoints`（`:999-1041`）、`--models` 短名匹配（`:2079-2081`）。→ **改这两个字符串会牵动全部五处，且旧 PR 的账本/verdict 是按旧字符串提交的，改了会炸旧账。**
2. 费用拦截现在有两个层次：opencode 进程内插件每次发请求前拦（`scripts/model-review/spend-guard.mjs:85-101`，`chat.params` 里 `throw new Error(...)`），依据是步骤费用（`guardDecision`，`spend-guard.mjs:7-17`）；父脚本再按 `step_finish.cost` 记账（`opencode-review.mjs:630-641`，`validCost` 见 `:224`）。材料已核实：经 Magpie 后「OpenCode 每步报的费用是 0」→ `validCost(0)` 为真，**现有美元线对 Magpie 路径彻底失明，且不会触发 `cost-unknown` 停止**（0 是合法费用）。
3. 上限规则与门槛：`COST_LIMIT_PER_MODEL_USD = 0.2`（`:66`）、先问线 `ASK_FIRST_LINE_USD`（`:75`）、I-77 门槛在 `test/tooling/opencode-review.test.mjs` 名字带 `[I-77]` 的用例（`docs/incidents-and-gates.md:115`）、I-76 门槛是「名字带 [OpenCode 401] 的 4 条用例：正式复核配置里不得出现 apiKey，并且必须保留 opencode-go 条目」（`docs/incidents-and-gates.md:108`）。
4. 自检产出会逐项核对请求：工具表、`max_tokens`（`PROBE_OUTPUT_CAP`，`:1696-1697`：`≥ MIN_OUTPUT_TOKENS=100000` 且 `≤ MODEL_OUTPUT_LIMITS[短名]`，`MODEL_OUTPUT_LIMITS` 见 `:28`）、`reasoning_effort`（`PROBE_REASONING`，`:1698-1700`）、`request.model` 短名必须在 `MODEL_OUTPUT_LIMITS` 里（`PROBE_MODEL_UNKNOWN`，`:1694-1695`，短名取法是 `request.model.split("/").pop()`）。
5. 只追加规则：`.claude/rules/prompt-prefix.md:35`（第 4 条「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加」）、`:46`（第 9 条「同一对话的请求送到同一个服务方……路由要按对话保持同一个去向：Magpie 走会话亲和（同一会话尽量送到同一处）」）、`:28`（第 2 条「系统提示和工具定义里不得出现会变的值」）。
6. I-73 教训：`docs/incidents-and-gates.md:112`——「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」。
7. Magpie 一手文档（https://github.com/yetone/magpie/blob/main/docs/reference.md ，下称 [M]）关键条目：
   - 网关地址与端口：[M]「The gateway listens on `127.0.0.1:3425` (`MAGPIE_ADDR` changes it) and starts with the app; `magpie serve` runs it alone.」；`/v1/chat/completions` 等 OpenAI 兼容路由在网关端口上（[M] 暴露路由表）。
   - 回环放行 + 密钥照样计数：[M]「Loopback remains permissive: any token works…… a gateway key used from this computer is [limited]」。
   - **路由组**：[M]「`magpie group add "Opus anywhere" models=claude/...,copilot/... routing=order stays=session`」「`routing=` is …… `order` (the first model until it can't answer, then the next)」「`stays=` is how long a conversation stays with the key or account that answered it: `auto`…`session`, `turn`, `off` or `strict`」，组的寻址是 `group/<id>`。
   - **网关密钥自带限额，且在被转发前拦**：[M]「`magpie gateway-key limit <id> week --tokens 2m --cost 5`」「Once a key is spent, its requests are refused before any provider is asked, with a 429 in the API's own error shape」「A request in flight holds a reservation（body 大小 + 该键平均输出）, so requests sent at once overshoot by about one call」「Cost is an estimate at the Usage page's prices; a call with no known price adds none」——**最后一句是个坑：若 CodeBuddy 插件账号没有已知价格，`--cost` 限额对它永不触发，必须同时用 `--tokens`。**
   - 用量归因：[M]「the RSSOolog adds `provider_key_id` and `provider_key_name`」；Usage 页「By key groups them by the key each came with」；芯片数据目录：[M] Files 一节「`usage.jsonl` — one line per request」「`affinity.json` — which key or account answered each conversation」；「`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` are respected.」
   - 配额/积分：[M]「`magpie quota` # what is left of every subscription, plan and key balance」「`magpie quota refresh <provider>` reads that card again」卡片刷新至多 30 秒一次。
   - 自更新校验：[M]「Only two downloads are checked against a checksum that does not come from the mirror: Magpie's own update assets (their SHA-256 comes from the unmirrored update feed)」。
   - 每天 1 条 PostHog 事件（[M] Counting users 一节），未见开关（未核实）。
   - 进程行为：「`magpie serve` currently exits on SIGTERM without draining」→ 用完即杀无残留风险。
8. 材料里 Andy 已核实（第 3、4、5 条事实）：插件登录用隔离 HOME + 假桌面凭证文件可行、代理注入为出口侧补凭证、Magpie 启动插件自动带 `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`、Node 需要 `NODE_USE_ENV_PROXY=1`；Go 预设 URL 要改成 `https://opencode.ai/inference/go/v1`。
9. 材料事实 7：OpenCode 1.19.5「不读插件的实时模型清单，只认配置里声明的模型；声明模型时要写输出上限和推理强度档位（variants）」。
10. 云端环境（https://code.claude.com/docs/en/cloud-environments ，材料事实 1）：setup script 跑完拍快照、快照不保存运行中的程序、setup 期的请求拿不到网络密钥、可以 docker compose 旁路起镜像 → **Magpie 不能靠 setup script 拉起，必须由复核脚本自己在每次运行时拉起。**

**推测（需在方案实施的第一步核实，见第五节）：**

- OpenCode 自定义 `@ai-sdk/openai-compatible` 服务方与 `magpie group add` 的所有子命令在这些版本上的具体 JSON/输出格式（事实 8 证明该服务方形态可用，但模型声明字段、`magpie gateway-key add` 的输出原文未在材料里给出）。
- CodeBuddy 对 `max_tokens=200000/131072` 大值的接受程度（事实 8 只证明 DeepSeek 组跑通了一轮，没给抓包的 `max_tokens`）。

## 二、方案本身

### 0. 总原则：`REVIEW_MODELS` 的两个字符串一个都不动

这是整个方案的地基：`opencode-go/deepseek-v4.1-flash` 等字符串是账本、verdict 校验、lens、替补逻辑五处的共同标识（前提 1），旧 PR 账本也按它提交（I-73 的教训）。路由变化发生在它们的“下游”——OpenCode 怎么把请求发出去——而不发生在标识本身。只有这样，`--assert-reviewed` / `--report` 读任意新旧账本都不受影响（question 4 的两端核对，先从最容易被遗忘的一端守住）。

### 1. Magpie 怎么装

新文件 `scripts/model-review/magpie-router.mjs`，做法完全类比现有的 OpenCode 安装（`opencode-review.mjs:355-382`）：

- 装到 `~/.cache/himawari-magpie/<版本>/`；从材料已核实的 `https://usemagpie.ai/api/latest` 拿「下载地址 + SHA-256」，**下载后先算哈希比对再落盘**（该哈希来自 Magpie 官方未镜像 feed，[M] 原话见前提 7）；已存在安装时每轮重算磁盘文件的哈希，不符则删除重装（镜像 `installedIntegrityProblems` + `npmCi` 的模式）。版本记入当轮台账（`route.magpieVersion`）。
- 不信任 Magpie 的自更新承诺作为完整性来源——以我们自己记录的哈希为准；若 Magpie 运行中自更新了二进制，重算哈希不符会触发重装，行为收敛为「每轮用的都是 feed 校验过的版本」。

### 2. 怎么启动和停止

由 `opencode-review.mjs` 的 `main()` 在确定路由后管理（Magpie 是本轮的伴生进程，同进同出）：

1. **每轮新起、用完即停**：`spawn("magpie", ["serve"], { detached: true })` 进独立进程组，纳入 `activeChildren`，`finally`/SIGINT/SIGTERM 里 `killProcessGroup`（现有 `:384-393`、`:2201-2210` 的机制对 opencode 已如此，Magpie 挂进同一个清理路径）。文档明确 SIGTERM 不 drain（[M]），直接杀安全。
2. 不连 84.247.157.41；不写 setup script（前提 10：快照不保进程、setup 期拿不到网络密钥）。
3. `MAGPIE_ADDR=127.0.0.1:<随机空闲端口>`，避开固定 3425 与其他占用；对模型/网关密钥/lim 配置无影响（[M] `MAGPIE_ADDR` 就是这样用的）。
4. 环境变量：继承 `HTTPS_PROXY/HTTP_PROXY/NO_PROXY/NODE_EXTRA_CA_CERTS`（已在脚本环境白名单思想内），加 `NODE_USE_ENV_PROXY=1`（材料事实 4）；隔离 HOME 与 `XDG_CONFIG_HOME`（下一条）。

### 3. 配置和凭证放哪（每轮一次性的 Magpie home）

`XDG_CONFIG_HOME` 与 `HOME` 都指向 `$workRoot/magpie-home`（workRoot 是本轮已有的临时根，用完即删，`XDG_CONFIG_HOME`/`HOME` 被 Magpie 尊重，[M] Files 一节）。于是：

- Magpie 全部状态（`providers.json`、`caller-keys.json`、`usage.jsonl`、`affinity.json`、`quotas.json`）都在一次性目录里 → **“Go-only 降级路（见第 5 节）”就是这一轮更换组员即可，零残留**；
- 假桌面凭证文件写进 `$workRoot/magpie-home/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info`，内容正是材料核实过可行的假串 `proxy-injected`（材料事实 3）——容器里永远不落真凭证，真凭证由出口代理在请求离开容器后补（Andy 目标 5）；
- 每轮执行一次 `magpie plugin login workbuddy-ai "WorkBuddy AI desktop's sign-in"`（网络往返几秒，因为凭证是代理侧注入，容器重建也无状态问题）；
- `magpie provider set opencode-go url=https://opencode.ai/inference/go/v1`（材料事实 5）。

不选择把配置做成长期目录复用：轮次之间复用必然带出“上一轮的组员/密钥残留”，和“CodeBuddy 低于 20 就用 Go-only 组”这类按轮决策相冲突；一次性目录让所有断言都是“本轮刚写入的（无假设）”。

### 4. 路由组和模型名怎么定

命名规则由自检的约束反推出来（前提 4）：`PROBE_MODEL_UNKNOWN` 校验的是 `request.model.split("/").pop()` 必须落在 `MODEL_OUTPUT_LIMITS` 短名里。所以：

```
magpie group add deepseek-v4.1-flash \
  models=workbuddy-ai/deepseek-v4.1-flash-sg,opencode-go/deepseek-v4.1-flash \
  routing=order stays=session
magpie group add glm-5.3-flash \
  models=workbuddy-ai/glm-5.3-flash,opencode-go/glm-5.3-flash \
  routing=order stays=session
```

- **组 id 恰好等短名** `deepseek-v4.1-flash` / `glm-5.3-flash`：OpenCode 配置里声明的模型 id 写 `group/<组名>`，请求体 `model: "group/deepseek-v4.1-flash"`，`pop()` 仍是短名 → `PROBE_*` 全复用，`MODEL_OUTPUT_LIMITS`、lens、verdict、账本一个都不用改（question 4 的核心一致性）。
- **`stays=session`** 直接落实 prompt-prefix 第 9 条「路由要按对话保持同一个去向：Magpie 走会话亲和」（[M] 原话见前提 7）——追问步骤、`--session` 续聊、替补/重跑都各自是“同一对话”，固定在一个账号上；CodeBuddy 故障（材料事实 10）被迫转 Go 时丢一次缓存，属第 9 条允许的故障切换。
- **OpenCode 侧 provider id 换新**：经 Magpie 时使用事实 8 验证过的形态——配置新增完整 provider（如 id `magpie-review`，`npm: "@ai-sdk/openai-compatible"`，`options.baseURL: http://127.0.0.1:<port>/v1`，`options.apiKey: <网关密钥>`），按材料事实 7 声明两个模型（写输出上限与 `variants: {high}`）。真实 `-m` 参数从 `REVIEW_MODELS 条目`经常量映射表得到 `magpie-review/group/deepseek-v4.1-flash`；**台账 `model` 字段仍记 `REVIEW_MODELS` 原值**。
  考虑过“直接给内置 `opencode-go` 写 `options.baseURL`，让 `-m` 完全不变” czyn：更省，但材料只证明自定义 openai-compatible 服务方可用，内置 provider 是否接受 baseURL 覆盖未核实（OpenCode 源码 `provider/provider.ts` 是 I-76 时读过的，覆写行为未测）；列为可选简化，需先在假服务器上一轮验证再决定（见第五节核实清单第 1 条）。
- 回环请求带网关密钥是**故意**的：[M] 明确回环上“any token works”但“a gateway key used from this computer is [limited]”——密钥在这里只用于计数归因与限额，不是秘密（每个模型一把，见下一节）。

### 5. 费用和积分上限怎么在请求发出前拦住

双闸，各挡各的面：

**闸 A（真银流水的硬闸：Magpie 网关密钥限额，在转发上游之前拒）**。每个模型一把密钥（`magpie gateway-key add review-deepseek-v4-1-flash` / `review-glm-5-3-flash`，捕获 add 输出里的密钥原文），并设：

```
magpie gateway-key limit <id> 2h --tokens <T> --cost 0.20
```

- `--cost 0.20` 对应现有 `COST_LIMIT_PER_MODEL_USD`（约定“每个模型一次运行 0.2 美元”）；窗口用 N 小时式，“A request in flight holds a reservation”（[M]），拒绝发生在 provider 之前且带 429 → 满足 I-77 的本质要求（到线后的后续请求不再产生未入账的真实支出）。
- **必须同时设 `--tokens <T>`**，因为 [M]：“Cost is an estimate at the Usage page's prices; a call with no known price adds none”——CodeBuddy 插件账号若没有已知价格，cost 闸对它失明，TLSIN 闸是兜底。T 的取法（推测，需用第一轮真实 usage 数据校准）：以材料事实 8 的一轮实测（CodeBuddy 4.37 积分 + Go 0.029 美元 ≈ 38 步）为基准，取“历史最贵轮的 token 数 ×2 与 0.2 美元换算的最小值”。
- 429 的后果设计进脚本：OpenCode 会把它当 `api-error`（带 `Retry-After`，可重试）；`retryAfterApiError`（`opencode-review.mjs:726-732`）里的 `remainingUsd` 此时来自台账里刚记的 Magpie 归属费用，≥ 0.2 → `no-budget`，不再重跑、不进替补——正是“一轮里这个模型 0.2 美元封顶”的字面执行。

**闸 B（在 opencode 进程里，保留 I-77 插件，但换成 token 视角 + 时间视角）**。`spend-guard.mjs` 不动它的判定结构，`limits.json` 新增（仅在 Magpie 路由时）`totalTokens` 与 `wrapUpTokens`：插件在 `chat.params` 前按消息累计的 token 判线（字段名需按第五节核实清单第 6 条确认；确认前该字段缺席不得当作异常，行为退化为现状）；**时间线与收尾时间线原样保留**（超时、八成超时提前收尾都靠时间，不依赖费用）。原 `totalUsd` 对 Magpie 路径意味着“每步 cost=0 合法”→ 永不触发、也**不再**触发 `cost-unknown` ——这是行为变化，必须写明：真实支出会计已转移到 Magpie 台账（见下）。I-77 原门槛用例全部跑在“假服务器 + 真实 opencode”上，插件机制未被削弱，用例照旧通过（reverse 用例也照旧：拆掉插件，`GUARD_PROBE_REQUESTS` 必须失败）。

**台账与先问线（`usage.jsonl` 不弱化，反而更准）**：

- 每个模型运行结束（含被 429/超时收尾的），从本轮 Magpie 的 `magpie usage --csv` 按**网关密钥**过滤（两模型并行也各自归因，[M]：CSV “adds `provider_key_id` and `provider_key_name`”）：
  - `cost` = Go 侧 `cost_usd` 合计（口径与现在 OpenCode cost 相同量纲）；
  - 新字段 `credits` = CodeBuddy 侧 `credits` 合计；`route: "magpie"`；`magpieProvider`（每组实际用了哪家）；`magpieTries`；
  - CSV 读不出/缺行：`costUnknown: true`（沿用现有的保守公式 `spentOf`，`opencode-review.mjs:854-863`——账不偏低的原则不变，这是约束“账本不能被削弱”的落实）。
- `budgetCheck`（`:865-873`）改为：美元线照旧（spent 按 Go USD 累计 + 本轮 `COST_LIMIT_PER_MODEL_USD`×模型数）；**新增积分先问线**（如 `code-review 40 / plan 20`，数值待 Andy 定，见“需要拍板”）：本 topic/PR 累计 `credits` + 本轮预估将过线就 `BUDGET_NEEDS_APPROVAL`，同样可 `--approved-credits` 放行。旧账本记录没有 `credits` 字段 → 按 0 计，校验规则 `parseUsage` 放宽为“缺省合法、存在的必须是非负数”，反向用例：负数/非数字仍 `USAGE_LEDGER_INVALID`。

### 6. 积分底线 20 怎么执行

底线无法在 Magpie 现有限额语法里表达（限额是 token/美元，不是“剩余积分 ≥ 20”），所以采用**预检决策 + 单轮预留**：

1. 预检时 `magpie quota refresh workbuddy-ai` + `magpie quota --json` 拿当前剩余积分 R（材料事实 3 已证实积分查询走得通；卡片 30 秒内可重复刷新，[M]）。
2. 单轮预留 =（该 topic 历史单轮 `credits` 的最大值 + 5）× 本轮模型数，再设下限 10（材料事实 8 的 4.37 积分/轮是唯一 observed 值，本数字为推测初值，按台账滚动校准）。
3. **若 R < 20 + 预留 → 本轮 Magpie 的路由组只放 `opencode-go` 成员**（一次性配置目录的好处：零成本换组员），台账记 `route: "magpie"`、`routeReason: "credit-floor"`。不给 CodeBuddy 发任何请求，底线是构造性保证，不是事后补救。
4. 运行中不重复查询（Magpie 无法按“积分余额”在请求级拒），剩余风险是生产 Himawari 并发把积分用穿预留——见风险 R2 的对策（随机退避错峰 + 预留下限）。

### 7. 开跑前自检要改什么

- **保留全部现有探针**（只读限制、git 替身、受限 bash、GUARD 探针）：这些拦的是模型行为，与路由无关，自检继续连本机假服务器，不花钱。
- **新增“双路由提示词逐字节一致”探针**：探针服务器现在已捕获完整请求 JSON（`startProbeServer`，`:1570-1643`），新断言：direct 与 magpie 两种配置下，第一次主请求的 `messages`、`tools` 逐字节相同（`model` 字段除外）。这条同时回应必答问题 1/2，也堵住“OpenCode 系统提示里混入 provider 名/URL”这一最隐蔽的破坏（推测风险，需靠它兜住）。
- **新增 Magpie 预检（零模型花费，全部_local）**：`/v1/models` 经两把密钥各查一次，回答必须包含且仅包含本轮声明组（`group/<短名>` 各自可见）——失败 `MAGPIE_PREFLIGHT_FAILED`；`magpie groups` 输出必须含两个组、组员与顺序正确；`/v1/magpie/limit` 两把密钥各自可见限额（[M]：密钥可读自己的限额）→ 限额真的装上了；`magpie quota` 返回可解析的积分数字；代理环境无凭证（复用 `proxyCredentialProblems`，Magpie 子进程继承同一份白名单外环境）。
- **新增 I-76 的 Magpie 版规则**：`reviewConfig` 里 `options.apiKey` 只允许与 `http://127.0.0.1[:port]` / `http://localhost:...` 的 baseURL 搭配；direct 路由的配置对象**逐字段等于现状**（最强断言：直接 deep-equal）。反向用例：apiKey + 非回环 URL → 拒绝。

### 8. 怎么测试（每条给反向用例）

全部放 `test/tooling/opencode-review.test.mjs`（沿用现有假服务器/真实 opencode 的测试基建，`grep` 已确认该文件是 I-76/I-77 的家）：

1. `[Route direct config]`：direct 配置 = 现 config 逐字节（reverse：多出任何 options 字段即失败）——守住 I-76 的“必须保留 opencode-go 条目”。
2. `[Route magpie config]`：仅回环 baseURL 才可有 apiKey；模型声明含 `group/<短名>` 两个且带输出上限与 high 变体（reverse：非回环+apiKey、缺模型声明 → 两类反转都必须失败）。
3. `[Route prompt bytes]`：两路由首次请求 messages/tools 逐字节一致（reverse：任改配置中的一个字面值注入 prompt → 失败）。
4. `[Gateway limit refuses]`：本地假 "magpie 形" 服务器在 N 次后回 429——`runOpencode` 得 `api-error`，台账记 `route:"magpie"` 且 `retry:"no-budget"`（对齐 `retryAfterApiError` 的 `remainingUsd` 分支）（reverse：假服务器不限流 → 继续请求、台账计入实际行数）。
5. `[Magpie attribution]`：CSV 样本解析 → `cost/credits/magpieProvider` 落台账；reverse：截断/缺列 CSV → `costUnknown: true`，`spentOf` 走保守公式。
6. `[Credit floor]`：预检积分解析 < 20+预留 → 生成的组不含 `workbuddy-ai` 成员、`routeReason: "credit-floor"`（reverse：余额充足 → 组含两个成员）。
7. `[Preflight]`：组缺员、`/v1/magpie/limit` 拒答、quota 不可解析 → `MAGPIE_PREFLIGHT_FAILED`（reverse 各一）。
8. `[I-77]` 既有用例原样保留、原样通过（插件机制未被削弱的自证）。
9. 真实端到端（上线验收一次，花真钱）：两个模型各经 Magpie 跑一轮 code-review，验收：台账 `credits`、`cost`、`magpieProvider` 与 `magpie usage` 对得上；Prompt 文件与 direct 轮的同轮 `promptSha256` 相同。

### 9. 怎么在 Go 用完前后切换

- **现在（Go 未用完）**：默认路由 `direct`，全脚本行为与现状逐字节一致（第 8 节用例 1 是这与现状的契约）。路由由环境变量 `HIMAWARI_REVIEW_ROUTE=direct|magpie` 控制（与 `HIMAWARI_OPENCODE_BIN` 同一先例），写入 `.agents/instructions/model-review.md`。
- **新方案验收后（Andy 点头）**：默认改为 `magpie`；台账出现 `route` 字段，旧记录无该字段按 `direct` 解释（`parseUsage` 放宽，反向用例守住）。
- **Go 额度耗尽时**：路由组本来就 `CodeBuddy 在前、Go 在后`，无需另改；耗尽后每次请求都先撞 Go 一次再落到 CodeBuddy 会浪费一次往返，此时把 `opencode-go` 成员从组里摘掉（一次性配置目录，改的是生成组命令的常量，属同一处修改），文档同步记一句（该修改的时机由台账 `magpieProvider` 里 Go 的 401/429 频率提示，需 Andy 确认后改，属“会出错”级文档-代码一致性项）。

## 三、考虑过但不选的做法

1. **不走 Magpie，OpenCode 直接配 CodeBuddy**：违背 Andy 目标 1（“只关心用哪个模型、什么推理强度”），CodeBuddy 的凭证注入/账号切换/用量记账全都要自己再写一遍，且没有现成的请求级限额（I-77 教训要求发请求前拦）。
2. **自写一层轻量反代替代 Magpie**：无 `stays`/组/限额/用量/密钥管理，等于重写 Magpie；新轮子没有一手文档背书，I-73 式“两端校验”更难做。
3. **Magpie 由 setup script 拉起**：被已核实事实否决——快照不保进程、setup 期请求拿不到网络密钥（前提 10）；而且 review 的生命周期本就短于容器，不该常驻。
4. **复用 84.247.157.41 上的生产 Magpie**：目标 3 明令禁止，且生产在用，风险面完全不同。
5. **靠 Magpie CSV/`/v1/models` 给 OpenCode 动态声明模型**：材料事实 7 已核实 OpenCode“只认配置里声明的模型”，且动态清单会让请求页依赖运行时外部状态（违反 prompt-prefix 第 10 条精神——同一对话内稳定性）；声明是静态写进配置的。
6. **保留内置 `opencode-go` provider 只覆盖 `options.baseURL`（若可行 `-m` 都不用换）**：更小、更漂亮，但唯一证据（事实 8）是自定义服务方形态；内置 provider 的覆写行为未核实。列为第一步要验证的候选简化，通过后可替换第 4 节的 provider 声明方式（其余结构不变）。
7. **把积分换算成美元进同一条先问线**：CodeBuddy 的“积分倍率”没有官方美元价目；混在一起会让美元线口径变成猜测。分离报 `credits` 并单设积分先问线（数值待 Andy 定）。
8. **用 `magpie provider test` 做预检连通性**：它真的发一小请求（[M]："one tiny request per API"）——预检必须零花费，弃用。

## 四、风险和反例

- **R1（高、已对冲）**：[M] 明示 cost 限额只计“有 known 价格”的调用——若 CodeBuddy 账号无 known 价格，`--cost 0.2` 对它失明。对冲：预检后要求 `--tokens` 限额必配（第 5 节闸 A），首两轮人工核对台账 credits 与 Magpie 数。
- **R2（中）**：多个云线程容器各自预检，互不可见，可能同时付预留后的超用（三个容器同时判 “剩余足够”）。对冲：预留下限 + 0-120s 随机错峰；更彻底的做法（集中锁）需要外部状态柜，代价不值。
- **R3（中）**：预检与首轮请求之间的空窗，`magpie` 的密钥 add 输出解析、日志/CLI 文案升级都可能让断言失败——所有解析失败都收敛为 `MAGPIE_PREFLIGHT_FAILED`（不猜、不静默），并且假凭证/插件版本 pin 在 `@magpie-community/opencode-workbuddy-auth@0.2.24`（版本升级需要新的预检确认）。
- **R4（中）**：Magpie 在途请求被 SIGKILL 时“reservation”可能永久占位（[M] 只说 streamed 的 settled 时机）→ 台账上该轮按 `inFlight` 走保守公式；本轮 Magpie 进程随运行结束被杀，占位不跨轮残留。
- **R5（低）**：OpenCode Go URL 需每轮 `provider set`（材料事实 5）；若哪轮忘了 set → 预检上不了真实调用，那会以首次真实请求失败收场，台账 api-error；用预调查模型清单来防（预检断言组员可用，无法零成本断言 URL 对——列“未完全覆盖”，由首批真实轮验收）。
- **R6（低）**：Magpie 每日 1 条 PostHog 事件（[M]）与自更新而出容器出口——礼貌的遥测/更新，不影响生产；未核实可否 OFF（核实清单第 7 条）。
- **R7（低、但贵）**：OpenCode 经 Magpie 时若内置 opencode-go 兜底目录（300+ 规则的 `variants`/上限）与声明模型 cap 有差，可能出现截断 `lastReason=length`——这正是 if CodeBuddy 拒大 max_tokens 的情形（见核实清单第 2 条），发生时按“声明输出上限 CodeBuddy 值”退让，由 Andy 拍板是否接受（因为它动到“max_tokens 不能低于 10 万”这条写死的自检规则）。

## 五、指出不可靠/缺失、需要先核实（按优先级）

1. 内置 `opencode-go` provider 在 1.19.5 是否接受 `options.baseURL` 覆盖（决定 `-m` 是否可完全不变，即打开第三节 6 的简化）。
2. 事实 8 那轮 OpenCode→Magpie→CodeBuddy 请求的 `max_tokens`/`reasoning_effort` 实际值，与 CodeBuddy 对 200k/131k 的接受/截断行为（决定声明输出上限=384000/131072 还是 128000/32000，以及是否豁免“max_tokens≥10 万”自检条）。
3. `magpie usage --csv` 的列清单与 `provider_key_id` 语义（账号侧 `credits`/`cost_usd` 对插件账号是否如实——fact 8 已示 Go 有 0.029、CodeBuddy 4.37，但未验过列名/口径）。
4. `magpie gateway-key add`/`limit` 输出原文（如何在脚本里拿密钥与 id 版本稳定；版本升级时这里是崩点）。
5. `magpie quota refresh workbuddy-ai` 在云端容器到底拿不拿到实时余额（fact 3 的“积分查询”具体用了哪条命令/哪个 API，30 秒缓存行为对预检的影响）。
6. opencode 1.19.5 插件 `chat.params` 能否拿到每步 token（决定 spend-guard 的 `wrapUpTokens` 能否实现；拿不到则时间线收尾仅靠 `wrap-up-time`，诚实写明弱化了“按钱收尾”。
7. Magpie 有没有关闭 PostHog 事件与自更新的开关。
8. 云端出口代理对 `workbuddy.ai` 域名的注入规则的持久性（fact 3 是某一天的验证；预检失败时收敛报错，不静默绕过）。
9. 直连路径对 Magpie 的二进制完整性：自带 “every build updates itself” 与我们 hash pin 共存时的实际行为（自更新后磁盘哈希不符 → 触发重装循环？需实验）。

## 六、逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只动三处：请求的目的地（OpenCode 配置 `options.baseURL`/网关密钥，不是 prompt 字节）、`-m` 传给 opencode 的模型串、外围绕行进程（Magpie）。系统提示、工具定义、历史消息全部由 OpenCode 原样组装；追问（wrap-up）的 `--session` 续聊与「只在末尾追加」机制（`opencode-review.mjs:827-839`，`WRAP_UP_PROMPT` 在对话末尾追加）一字未动；复核机制本来就不走遮盖，遮盖结果不变。新的「仅组名/模型 id 只出现在请求元数据 `model` 字段，不进 prompt 字节。落实动作：自检新增“双路由 messages/tools 逐字节一致”探针（第 8 节用例 3），反向用例注入即失败；风险唯一残留是 OpenCode 1.19.5 若把 provider/model 名写进系统提示则一致性探针会当场抓出来（属于“未核实但被测试兜底”）。每轮会变的值（提交哈希、材料、`--previous`）本就都在最后一条消息里，此次不碰。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。路由相关的新值（组 id、网关密钥、`-m` 值、provider 声明）全是常量或由固定连接条件生成； inconvenience 真实路径里没有遮盖、没有带时间字段进 prompt、没有无序集合（组员顺序由 `magpie group add` 的 `models=..., ...` 显式列表定序）。台账/CSV 里的时间戳不回流进请求字节。`stays=session` 改变的是请求去向，不是字节。
3. **有没有对应的自动检查、反向用例会不会真失败？** 有，见第 8 节 9 组用例，每条给反转条件（含 direct 配置逐字节等于现状、网关 429 后 `retry:"no-budget"`、CSV 缺列 → `costUnknown`、低额 → 组员剔除、I-77 保留用例）。其中必须诚实承认：“Magpie 限额真的在转发前拒” 这一条在仓库测试里用假 magpie 形服务器替代，只在云端真跑时最终验证一次（核实清单第 3、4 条）。
4. **每个值的产生处与使用处是否两端都能接受？** 逐个核（I-73 式）：
   - `-m` 值↔OpenCode 配置 models 键↔Magpie 组 id↔`checkProbeRequests` 的 `pop()` 短名字典（自检端）——四端靠“组 id=短名+`group/` 前缀”这—定式锁死（第 4 节）。
   - 台账新字段 `route/credits/magpieProvider/routeReason`：产生于 `runOne`；消费于 `parseUsage`（放宽为缺省合法）、`budgetCheck/`spentOf`（保守公式补齐）、`assertReviewed/--report`（无需改动）、`.agents/instructions/model-review.md` 文档（会随 PR 更新）。
   - 网关密钥：产生于预检；消费于 OpenCode 配置（仅回环）、Magpie 限额、CSV 归因。I-76 的“ apiKey 不得出现”守则同步改为“仅回环允许”（反向用例）。
   - 假凭证文件：产生于脚本；消费于插件 `readDesktop`（材料事实 3 实测格式）；接受端是代理注入。
   - `REVIEW_MODELS` 等旧标识：不改任何一处，旧账本/verdict/lens 全兼容（这是第 0 节的结论）。
   - `CREDIT_ASK_FIRST_LINE`（新增先问线常量）：产生于脚本；消费于 `budgetCheck` —— **数值需 Andy 拍板**，代码合入前定为占位并默认放行？不行——那会静默放宽，反过来：数值未定前该检查按“报数不拦”打日志模式，Andy 定数后再启用拦截。

## 七、需要人拍板的取舍

1. 切换默认路由（直连 Go → Magpie）的时机，基于首轮真实验收数据（时长、积分数、美元数对照 direct）。
2. 新增的「积分先问线」数值（本 PR/topic 按 40/20 积分，还是并进美元线用某一固定换算——前者为准否）。
3. 若 CodeBuddy 拒收大 `max_tokens` → 是否接受“声明 output 上限 128000/32000”并豁免“max_tokens ≥ 10 万”这条自检门槛（它在 CodeBuddy 结构上不可能满足）。
4. 首批真实轮验收时，接受多少“台账 credits 与 Magpie 手动对账必须一致”的容差（建议 0，出现即返工）。
5. R6：是否接受 Magpie 每日 1 条 PostHog 事件与自更新（若核实出开关则无此项）。

（把“Andy 定”的数值先做占位常量集中放一个文件段、加 todo 标记的检查项（`npm run` 级 grep 是否还有未定占位），确保不是悄悄带上线。）
