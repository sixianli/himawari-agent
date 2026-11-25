# Himawari

Himawari（向日葵）是 Andy 给自己做的个人 AI agent：一个长期记得他、会主动开口、替他办事前先问他的助手。它跑在 Andy 自己租的服务器上，数据只存在那台机器的数据库里，由 Andy 掌控（产品原则见[产品愿景](docs/product-vision.md)）。

- [现在能做什么](#features)
- [架构](#architecture)
- [代码结构](#layout)
- [本地开发](#development)
- [上线](#deploy)
- [文档在哪](#docs)

<a id="features"></a>
## 现在能做什么

下面每一项都已经在 `main` 的代码里，并有自动测试守着。

- **对话**：网页控制中心（`apps/control-center`）和 iPhone App（`clients/apple`）连同一个服务。回答边写边推给客户端；每轮的工具调用、用时、token 和 KV 缓存命中都记下来。
- **工具**：联网搜索和读网页；在沙箱里读写授权目录的文件、跑命令（长命令转后台）；设、查、取消提醒；查、立、撤长期规则；翻记忆。
- **长期记忆**：自研记忆引擎（`packages/memory-engine`），数据和索引都在 SQLite 主库里；检索是向量、全文、实体三路，用倒数排名融合（RRF，把几路排名合成一个排名的算法）合并，再按相关度门槛截断。每条记忆的每次变化都有历史，能恢复到任何一版，能跳回记下它的那句原话。
- **系统主动提醒**：只读检查 Gmail，带上相关记忆和同一件事的往来邮件，由模型判断要不要提醒；提醒经网页推送和 iPhone 推送送达，安静时段由规则管。
- **规则**：Andy 说一句“以后……”就变成一条长期规则，规则用 CEL 表达式（Google 的一种安全表达式语言）写成、由程序执行，每条有该命中和不该命中的回归例子。
- **办事先问**：所有有后果的工具调用走同一个授权出口。读过网页、邮件这类外来内容之后，改外面的东西、往外发、删东西都要 Andy 点头。
- **判断可解释**：每次模型替 Andy 做的判断（提醒不提醒、记不记）都写一条决策记录，能看到依据的全链条；每周出一份校准报告。
- **给别的 agent 用**：对外的 MCP 入口（`/api/mcp/v1`，经 Cloudflare Access 登录），别的 agent 能读 Himawari 的记忆、提议新记忆和规则。
- **数据带得走**：记忆、规则、决策记录、聊天记录都能导出成公开格式。

<a id="architecture"></a>
## 架构

```text
iPhone App / 网页控制中心
        │  HTTPS（Cloudflare Access 或内置账号登录）
        ▼
Agent Service ── 网关（HTTP 接口、事件流）
   │            运行调度：每轮对话一个 Run，可同时跑多个
   │            Pi agent 循环（packages/runtime-pi）
   │            记忆引擎、规则手册、授权出口、决策记录
   │            SQLite：唯一的产品状态库
   │
   ├──► 模型：经本机的 Magpie 路由，先用已付费套餐，再用低价按量模型
   │
   └──► Execution Worker ──► Job Host（每次调用一个，SRT 沙箱里执行命令和写文件）
```

几条贯穿全局的决定：

- **产品状态以 SQLite 为准**，Pi 的会话只是运行时的投影（[ADR 0296](docs/adr/0296-foundational-architecture-principles.md)、[ADR 0296](docs/adr/0296-foundational-architecture-principles.md)）。
- **授权在模型之外判断**，模型只能提出要做什么（[ADR 0296](docs/adr/0296-foundational-architecture-principles.md)、[ADR 0257](docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md)）。
- **会执行代码的工具不在主进程里跑**，由 Worker 起沙箱执行（[ADR 0298](docs/adr/0298-where-tools-run.md)、[ADR 0298](docs/adr/0298-where-tools-run.md)）。
- **发给模型的内容只追加**，固定内容在前、每轮会变的在最后，让 KV 缓存命中（[ADR 0149](docs/adr/0149-append-only-model-requests.md)、[KV 缓存规范](docs/kv-cache-guide.md)）。
- **需要理解意思的判断交给模型**，程序只做格式、出处、额度这类固定校验，不用关键词表猜意思（[ADR 0249](docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）。

正在按新设计改的两块：一个主对话加后台子线程、所有新事情走同一个收件箱（[ADR 0285](docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md)）；主模型自己读写记忆（[ADR 0286](docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md)）。

<a id="layout"></a>
## 代码结构

TypeScript monorepo（npm workspaces），Node.js `>=22.22.3`，Agent 循环用 Pi（`@earendil-works/pi-coding-agent`）`1.5.0`。

| 目录 | 放什么 |
| --- | --- |
| `apps/agent-service` | 主服务：网关、运行调度、把各个包组装起来 |
| `apps/execution-worker` | 执行工具的独立进程，管理沙箱 |
| `apps/admin-cli` | 管理命令：建库和迁移、备份恢复、换机器迁移、诊断 |
| `apps/control-center` | 网页控制中心（React + Vite） |
| `packages/domain` | 领域对象和不变量 |
| `packages/gateway-contracts`、`packages/execution-contracts` | 客户端协议和 Worker 协议 |
| `packages/application` | 产品端口和应用服务：运行、授权、记忆、提醒、规则、决策记录 |
| `packages/runtime-pi` | 对接 Pi 的适配层，全仓只有这里直接用 Pi |
| `packages/runtime-sandbox` | SRT 沙箱、Job Host、网络出口 |
| `packages/memory-engine` | 记忆引擎 |
| `packages/persistence-sqlite` | SQLite 存储和迁移 |
| `packages/platform-node` | Node.js 上的基础设施适配器：HTTP、模型请求、推送、联网搜索 |
| `packages/prompt-catalog` | 所有发给模型的提示词 |
| `packages/sensitive-capture` | 发给外部模型前遮盖密码、密钥、验证码 |
| `packages/calibration` | 决策记录的校准统计 |
| `packages/integration-github`、`packages/integration-web` | GitHub App 只读接入、网页出口的公网地址校验 |
| `packages/testing` | 测试用的确定性适配器和夹具 |
| `clients/apple` | iPhone App（SwiftUI），见[它的说明](clients/apple/README.md) |
| `scripts/delivery-mode` | 生成上线包、上线和回滚脚本 |
| `test` | 集成、端到端和工具脚本测试 |
| `evals` | 评测集：记忆检索、记忆抽取、Jarvis Test 等 |

包之间允许的依赖方向由 `npm run check:boundaries` 检查。

<a id="development"></a>
## 本地开发

```bash
npm ci
npm run build          # 构建全部包和网页
npm run check          # 格式、lint、类型和几十项仓库检查
npm test               # unit、contracts、integration、e2e、Pi 兼容测试
npm run test:tooling   # 脚本和 CI 工具的测试
```

单独跑某一类：`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、`npm run test:browser`（Playwright）。默认测试不联网、不调用付费模型、不用任何真实账号。

iPhone App 在 Mac 上用 Xcode 构建；`HimawariCore` 的单元测试在 Linux 上也能跑（见 [clients/apple/README.md](clients/apple/README.md)）。

CI 跑在 GitHub 的标准托管机器上（[ADR 0292](docs/adr/0292-how-ci-runs-now.md)），检查清单在 `ci/policy.json`。

<a id="deploy"></a>
## 上线

生产是一台 Linux 服务器。`scripts/delivery-mode/make-packet.py` 按参数生成上线包，`deploy.sh` 先做预检再上线，失败时按上线包的设置保留现场或回滚（[交付模式](.agents/instructions/delivery-mode.md#fast-mode)、[ADR 0293](docs/adr/0293-how-production-deploys-work.md)）。

<a id="docs"></a>
## 文档在哪

- [产品愿景](docs/product-vision.md)：最高层的产品原则。
- [PRD v0.2](docs/prd-v0.2.md)：当前版本的范围。
- `docs/adr/`：架构决策记录，只保留现行有效的；被取代或过期的已删除，历史在 git 里。
- `docs/execution/specs/`：还在做的设计规格。
- `docs/runbooks/`：要人判断的运维操作手册。
- [工程案例库](docs/engineering-casebook.md)：做这个项目时遇到的重要问题和决定。
- 给编码代理的规则：[AGENTS.md](AGENTS.md)。
