# 整合方案：复核模型调用经 Magpie 路由

这份方案由线程整合：线程自己的方案、GLM 第 1 轮的独立方案、GLM 第 2 轮的审核意见。DeepSeek 在 OpenCode Go 上两轮都没出结果（超时两次、服务错误两次），见同目录 `usage.jsonl`。逐条采纳与否的判断见同目录 `judgments.md`。

## 前提

| # | 前提 | 来源和原话 |
|---|---|---|
| P1 | 复核脚本把服务方写死为 OpenCode Go | `scripts/model-review/opencode-review.mjs:24` `REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"]`；`:96` `provider: { "opencode-go": provider }` |
| P2 | 模型全名是账本和逐条判断记录的身份，改名会让旧记录校验失败 | `opencode-review.mjs:918` `REVIEW_MODELS.includes(verdict.model)`；`:1007` `REVIEW_MODELS.every((model) => passed.some((record) => record.model === model))` |
| P3 | I-76 的门槛要求正式复核配置里不出现 `apiKey`、保留 `opencode-go` 条目 | `test/tooling/opencode-review.test.mjs:153-154` `expect(config.provider).toEqual({ "opencode-go": {} })`、`expect(JSON.stringify(config)).not.toContain("apiKey")` |
| P4 | 自检要求每个请求的 `max_tokens` 不低于 10 万，模型短名必须在上限表里 | `opencode-review.mjs:27` `MIN_OUTPUT_TOKENS = 100000`；`:1695` `PROBE_MODEL_UNKNOWN`；`:1696` `request.max_tokens >= MIN_OUTPUT_TOKENS` |
| P5 | 发给模型的内容只追加；同一对话送到同一个服务方 | `.claude/rules/prompt-prefix.md:35` 第 4 条“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；`:46` 第 9 条“同一对话的请求送到同一个服务方” |
| P6 | 云端不能换基础镜像；启动脚本跑完拍快照，快照不保存运行中的程序；启动脚本的请求拿不到网络密钥 | https://code.claude.com/docs/en/cloud-environments ：“Replacing the base image entirely isn't supported yet”“Anthropic snapshots the filesystem and reuses that snapshot”“loses anything that was only running”“Setup script requests: Claude Code connects to the agent proxy when it launches, after the setup script has run” |
| P7 | Magpie 路由组按顺序用第一个、失败换下一个；`stays=` 决定对话固定在哪个账号 | https://github.com/yetone/magpie/blob/main/docs/reference.md ：“`order` (the first model until it can't answer, then the next)”“`stays=` is how long a conversation stays with the key or account that answered it: `auto` (the default, while the vendor's cache of it is worth keeping), `session`, `turn`, `off` or `strict`” |
| P8 | Magpie 能查各账号剩余额度 | 同上：“`GET /v1/magpie/quotas` (and `magpie quota --json`, the same list)” |
| P9 | 经代理或隧道到达回环地址、带转发头的请求会被 Magpie 拒绝 | 同上：“A request that reaches loopback through a proxy or tunnel … carries a forwarding header … Without sharing it is refused” |
| P10 | CodeBuddy 插件在系统提示被拒（11128）时会改写系统提示 | `@magpie-community/opencode-workbuddy-auth@0.2.24` 的 `index.mjs:976-1008`（`systemAsUser`）；README：“sent once more … with the system prompt moved into the first user message” |
| P11 | 2026-11-07 实测（本线程）：假凭证加代理代填可以登录 CodeBuddy；Go 要用 `/inference/go/v1`；经 Magpie 的端到端复核正常跑完，单步最多 5,922 token，中途自动切到 Go 再回到 CodeBuddy；一次 DeepSeek 复核约 4.37 积分；GLM 单步最多 3,010 token | 本线程实测记录，见同目录 `round-1/` 和 `round-2/` 提示词里的“已核实的事实” |

## 方案

### 1. 不改模型身份，只改发往哪里

- `REVIEW_MODELS`、账本里的 `model`、提示词文件名、`--models`、`SUBSTITUTES` 一律不变（依据 P2）。
- 新增一个开关 `--gateway magpie`（默认关）。开着的时候，OpenCode 配置里多一个服务方 `magpie`（`@ai-sdk/openai-compatible`，`baseURL` 指向本次的 Magpie），并把 `opencode-go/deepseek-v4.1-flash` 映射成发往 Magpie 的 `group/deepseek-v4.1-flash`（OpenCode 配置的 `modelID` 字段）。关着时，配置和现在逐字节相同，测试锁死这一点。

### 2. 安装：锁版本，靠启动脚本的快照复用

- 仓库新增锁文件 `scripts/model-review/gateway-lock.json`：Magpie 命令行版的版本、下载地址、SHA-256；插件包名、版本、npm integrity。Bun 由 Magpie 按它自带的校验值下载，锁住 Magpie 版本即锁住 Bun 版本。
- 安装脚本按锁文件下载并校验，不符就删掉、报错。himawari-cloud 环境的启动脚本只调用这个安装脚本（只装不登录，依据 P6）；快照之后新会话不再下载。复核脚本发现没装时，自己调用同一个安装脚本（Mac 上也一样）。
- 每次运行前后都对 Magpie 程序算一次 SHA-256，和锁文件比对，不一致就停（`GATEWAY_BINARY_CHANGED`）。这样能防住自动更新：只核对版本号，挡不住同版本号下换了程序。程序副本设为只读。

### 3. 每次复核起一个全新的 Magpie，跑完关掉

- 在本次的临时工作目录里放一个便携 Magpie：隔离的 HOME 和 `data/`，监听 `127.0.0.1` 的空闲端口。脚本结束或收到中断信号时，和 OpenCode 一起停掉。
- 按仓库里的 `scripts/model-review/gateway.json`（不含密钥）生成配置：两个服务方（`workbuddy-ai` 用插件的桌面登录文件方式，文件里只有 `proxy-injected`；`opencode-go` 的地址改为 `https://opencode.ai/inference/go/v1`），两个路由组（CodeBuddy 在前，Go 在后，`routing=order`）。
- 环境分两份：Magpie 进程带代理设置；OpenCode 进程显式设 `NO_PROXY=127.0.0.1,localhost`，保证它直连 Magpie，不经过代理（依据 P9）。

### 4. 花费上限

- **美元上限照旧在请求发出前拦。** OpenCode 的模型配置里写保守单价（按 Go 同一模型的价格），OpenCode 每步算出的费用不再是 0，现有的 `spend-guard.mjs`、每模型 0.2 美元、先问线都不用改。和 ADR 0117 第 3 条“按保守单价记账”是同一个做法。
- **真实花费另记。** 跑完、清理临时目录之前，读本次 Magpie 的用量记录，按服务方汇总，写进 `usage.jsonl`。经 Magpie 的记录多带两个字段：`gateway: "magpie"` 和 `providers`（CodeBuddy 记积分，Go 记美元）。校验规则只对带 `gateway` 的行要求 `providers`，旧账本照常能读。读不到用量记录时记为未知，按现有的保守公式记账。
- **积分底线 20。** 开跑前经本次 Magpie 查剩余积分（`magpie quota --json`，依据 P8）。剩余减去预计用量（取账本里同类运行的最大实际积分，乘以 3；没有历史时 DeepSeek 按 13、GLM 按 6）低于 20，就把 `workbuddy-ai` 从本次的路由组里去掉，只走 Go，并打印 `GATEWAY_CREDIT_FLOOR`。查不到积分时同样去掉，不猜。
- 要写明的局限：积分底线只在开跑前判断一次，运行中不再拦。一次复核最多多用的积分，受 0.2 美元保守单价换算出的 token 上限约束。

### 5. 和发给模型内容的规则

- **路由组用 `stays=session`**：同一次复核（包括收尾追问）固定在同一个账号。只有出故障时才换服务方，换过去以后不再切回来（依据 P5 第 9 条、P7）。代价：CodeBuddy 中途故障后，这次剩下的部分都用 Go。
- **插件改写系统提示（P10）是规则第 4 条的例外，要在 ADR 里写明并由你批准。** 只在 CodeBuddy 拒绝这段系统提示时才发生。自检加一条透传探针：OpenCode 经 Magpie 发到本机假上游，逐字节比对 Magpie 进出的 `messages`，正常情况下必须完全相同。

### 6. 自检

- 现有探针全部保留，请求改为经本次的 Magpie 发到本机假服务器（Magpie 里加一个指向假服务器的服务方）。新增：透传探针（第 5 条）；故障转移探针（假服务器先返回 500，检查 Magpie 换到第二个成员）；程序摘要检查。
- `MIN_OUTPUT_TOKENS` 改为按模型：DeepSeek 不低于 10 万，GLM 不低于 3.2 万（CodeBuddy 上的 GLM 最多只能输出 3.2 万，P11）。自检核对假服务器看到的 `model` 等于映射后的值。
- 联网预检（自检之后、花钱之前）：两个服务方的模型清单里有这两个模型、输出上限不低于声明值、积分能查到。失败就以 `GATEWAY_PREFLIGHT_FAILED` 停下。

### 7. 测试（每条带反向用例）

`test/tooling/opencode-review.test.mjs` 增加：开关关闭时配置和现在逐字节相同；I-76 门槛改写为“`apiKey` 只允许和回环地址一起出现”，非回环地址加 `apiKey` 必须失败；旧账本加新代码，`--assert-reviewed` 照常通过；带 `gateway` 却缺 `providers` 的行必须报错；积分剩余 25、19、查不到三种情况；锁文件摘要不符时拒绝；去掉 `NO_PROXY` 后透传探针必须失败；用真 Magpie 和本机假服务器跑故障转移，并验证费用插件经 Magpie 仍能拦住第 4 次请求。

### 8. 切换

- 现在：开关默认关，复核继续直连 Go。
- 你验收后：开关默认开，路由组 CodeBuddy 在前、Go 在后。Go 用完时，它在组里只是备用，不影响正常使用。直连方式保留一个版本作为退路，之后删除。
- 文档：改 `.agents/instructions/model-review.md`（“怎么跑”一节和第 70 行的密钥说明）、`docs/incidents-and-gates.md` 里 I-76 那一行的门槛描述；新增 ADR；按规则判断工程案例库要不要加一个案例。

## 需要你拍板

1. **插件改写系统提示的例外**（第 5 条）：同意作为“只追加”规则的受控例外写进 ADR 吗？不同意的话，就不能用 CodeBuddy 插件，等于放弃 CodeBuddy。
2. **`stays=session` 还是 `auto`**：`session` 更符合缓存规则，但出过一次故障后，这次剩下的部分都走 Go（更贵，Go 用完后就没有了）；`auto` 会切回 CodeBuddy，但每次切换都要整段重算。我建议 `session`。
3. **积分底线的估算**：按“历史最大值乘以 3”预留，是否接受？
