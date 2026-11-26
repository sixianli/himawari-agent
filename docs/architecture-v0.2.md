---
status: active
document_type: architecture
version: "0.2"
supersedes: ""
superseded_by: ""
date: "2026-11-26"
covers: "package.json, scripts/boundary-policy.mjs, scripts/check-boundaries.mjs, scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs, apps/agent-service/src/production-http-composition.ts, apps/agent-service/src/production-computer-tools.ts, apps/execution-worker/src/production-execution-worker.ts, apps/admin-cli/src/index.ts, packages/platform-node/src/device-api-routes.ts, packages/runtime-pi/package.json"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# Himawari Agent 架构 v0.2

本文只写 Himawari 现在是怎样搭起来的：有哪些程序、代码怎样分包、数据放在哪里、一条消息怎样走完。为什么这样做写在各份 ADR（架构决定记录）里，本文末尾按主题列出；产品要做什么以[产品愿景](product-vision.md)为准。本文取代 v0.1：v0.1 写于 2026-08，里面的 Mem0、OpenRouter、退租机器和已删规格都已不是现状，旧文见[删除前的版本](https://github.com/sixianli/himawari-agent/blob/7c8521fe5f55e7dd57c5bd52badd16eef647502e/docs/architecture-v0.1.md)。

<a id="contents"></a>

## 阅读导航

- [现在的系统](#current-system)
- [分包和依赖方向](#boundaries)
- [数据放在哪里](#data-model)
- [主要流程](#main-flows)
- [正在变的部分](#in-progress)
- [相关决定](#decision-links)

<a id="current-system"></a>

## 现在的系统

- **一个服务器，几种客户端。** 大脑只在服务器上：记忆、规则、决策记录、调用模型都在服务器做。iPhone、Apple Watch、Mac 的原生 App（代码在 `clients/apple/`）负责采集、显示和执行，经设备接口 `/api/device/v1/` 连服务器（[ADR 0229](adr/0229-native-apple-clients-and-device-api.md)）。网页（`apps/control-center`）还在，但已决定整体删除（[ADR 0309](adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md)）。别的 agent 经 MCP（模型上下文协议）入口 `/api/mcp/v1` 读写记忆（[ADR 0307](adr/0307-external-agents-and-the-memory-hub.md)）。
- **生产机。** 一台 Oracle 东京的 ARM 机（linux-arm64）。服务 `himawari-prod.service` 运行成对启动程序 `pair-supervisor.mjs`，它同时拉起两个进程，任一个退出就一起重启：
  - Agent 服务（`apps/agent-service`）：HTTP 网关、模型循环、授权、记忆、收件箱、提醒和系统主动提醒，以及对 SQLite 的全部写入。
  - 执行进程（`apps/execution-worker`）：在隔离环境里真正运行有副作用的工具（[ADR 0298](adr/0298-where-tools-run.md)）。
- **管理命令。** `apps/admin-cli` 编出 `himawari` 命令，做初始化、数据库升级（`himawari db migrate`）、同机恢复点（`himawari backup create/verify/restore`）、账号和沙箱预约处置等离线管理。
- **模型。** 模型循环和工具定义用 Pi（`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai`，版本固定在 `packages/runtime-pi/package.json`）。生产的主模型配置成 `provider: "magpie"`，请求发给本机的模型路由程序 Magpie，由它按路由组把请求交给 Andy 已付费套餐里的模型（[ADR 0297](adr/0297-how-model-calls-work.md)）。怎样在 Pi 上开发见 [Pi 二次开发规范](pi-development-guide.md)。
- **上线。** 合进 `main` 后由 GitHub 工作流出包、上线，失败自动退回上一版（[ADR 0293](adr/0293-how-production-deploys-work.md)）；CI 跑在 GitHub 的免费托管机器上（[ADR 0292](adr/0292-how-ci-runs-now.md)）。安装和启停见[生产机安装与启停 Runbook](runbooks/install-start-stop-runbook.md)，备份见[机外备份 Runbook](runbooks/production-offsite-backup-runbook.md)。
- **工具链。** Node.js `>=22.22.3`、npm `11.8.0`、TypeScript `5.9.3`（只用能直接擦除的语法）、Biome `2.3.5`、Vitest `4.1.9`，都写在根目录 `package.json`。

[返回目录](#contents)

<a id="boundaries"></a>

## 分包和依赖方向

仓库是 npm 工作区单仓：`apps/` 下 4 个可部署入口，`packages/` 下 15 个包。允许的内部依赖由 `scripts/boundary-policy.mjs` 定义，`scripts/check-boundaries.mjs` 在 `npm run check` 里检查方向、循环、未声明依赖和越界的相对导入。现行方向（省略 `@himawari-agent/` 前缀）：

```text
domain、calibration、prompt-catalog、sensitive-capture、gateway-contracts、execution-contracts → 不依赖内部包
application        → domain、gateway-contracts、execution-contracts、sensitive-capture、calibration、prompt-catalog
runtime-pi         → application、sensitive-capture、prompt-catalog
memory-engine      → application、domain、sensitive-capture、prompt-catalog
persistence-sqlite → application、domain、calibration、gateway-contracts、execution-contracts
platform-node      → application、domain、gateway-contracts、execution-contracts、sensitive-capture、prompt-catalog
runtime-sandbox    → execution-contracts
integration-github → application、domain、gateway-contracts、execution-contracts
integration-web    → application、domain、gateway-contracts、execution-contracts、sensitive-capture、testing
testing            → application、domain、gateway-contracts、execution-contracts
agent-service      → 组装上面大多数包
execution-worker   → application、execution-contracts、platform-node、runtime-sandbox、integration-web、testing
admin-cli          → application、persistence-sqlite、platform-node
control-center     → gateway-contracts、sensitive-capture
```

几条额外限制，同样由 `scripts/check-boundaries.mjs` 拦：`@earendil-works/pi-*` 只能出现在 `packages/runtime-pi`；沙箱运行库只能由 `packages/runtime-sandbox` 依赖；`domain`、各 contracts 包、`application` 和浏览器端的包不能导入 `node:` 模块。

各包做什么：

| 包 | 做什么 |
| --- | --- |
| `domain` | 身份、所有权、Run 状态机等纯规则，不碰数据库和 Node |
| `gateway-contracts` | 客户端和服务器之间的命令、查询、事件格式 |
| `execution-contracts` | Agent 服务和执行进程之间的协议 |
| `application` | 产品的端口（接口）和应用服务：上下文形成、授权、收件箱、记忆读写等 |
| `persistence-sqlite` | SQLite 上的全部存储、迁移、恢复点、导出 |
| `memory-engine` | 自研记忆引擎：写入校验、检索、整理 |
| `runtime-pi` | Pi 适配器：把产品状态拼成模型请求，把 Pi 事件映射回产品记录 |
| `runtime-sandbox` | 工具的隔离运行：SRT 模式的 Job Host、可选容器、每人一台电脑 |
| `platform-node` | HTTP 网关、设备接口、严格配置读取、能力部署检查 |
| `prompt-catalog` | 发给模型的固定文案和提示清单 |
| `sensitive-capture` | 密钥识别和遮盖 |
| `calibration` | 判断门槛和校准 |
| `integration-web` | 公开网页搜索和读取 |
| `integration-github` | GitHub 接入 |
| `testing` | 测试用的参考实现 |

[返回目录](#contents)

<a id="data-model"></a>

## 数据放在哪里

- **SQLite 是唯一的权威数据库**（[ADR 0296](adr/0296-foundational-architecture-principles.md) 决定第 6 条）。文件是 `<stateRoot>/data/product.sqlite`，`stateRoot` 写在 `/etc/himawari/config.json`，生产是 `/var/lib/himawari/state`。对话、消息、Run、授权、记忆、决策记录、收件箱事件都在这里；一个写连接加一个只读连接（[ADR 0306](adr/0306-database-access-and-concurrent-conversations.md)）。迁移的编号和合并规则见 [ADR 0265](adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md)。
- **正文加密存放。** 消息正文、附件等放在受保护的 Payload 里，附件密文在 `<stateRoot>/data/payload-ciphertext/`；数据库里只存引用。
- **密钥** 在 `<stateRoot>/secrets/`，不进同机恢复点，也不写进日志；机外备份会带上它（加密后上传）。
- **记忆** 全部在主库里，检索索引是派生数据，可以重建；嵌入默认用本机模型，不出机器（[ADR 0300](adr/0300-how-memory-works-now.md)、[ADR 0286](adr/0286-the-main-model-reads-and-writes-memory-itself.md)）。
- **备份** 两层：同机恢复点在 `<stateRoot>/recovery-points/`；整份状态每天加密传到 Oracle 对象存储（[机外备份 Runbook](runbooks/production-offsite-backup-runbook.md)）。

[返回目录](#contents)

<a id="main-flows"></a>

## 主要流程

1. **主人发一句话。** App 经设备接口把消息交给 Agent 服务；服务把消息、触发记录写进收件箱（[ADR 0285](adr/0285-one-main-thread-subthreads-and-one-inbox.md)），调度器取出后开一次 Run。同时执行的对话数由配置 `totalRuns` 定。
2. **拼上下文、调模型。** 固定内容在前、本轮会变的内容在后，按“只追加”规则拼请求（[ADR 0303](adr/0303-what-the-model-is-sent.md)、[KV 缓存规范](kv-cache-guide.md)）；经 Pi 发给 Magpie。主模型自己用记忆工具读写记忆。
3. **调工具。** 每次工具调用先由模型之外的授权判为 `ALLOW`、`ASK` 或 `DENY`（[ADR 0299](adr/0299-tool-calls-and-command-lifecycle.md)）。要问主人的，Run 停在 `awaiting_approval`，App 上出同意卡片；放行的，有副作用的工具交给执行进程在隔离环境里跑（[ADR 0298](adr/0298-where-tools-run.md)）。效果没确认的外部动作只对账，不自动重做。
4. **回答和推送。** 回答流式写回对话，Himawari 回主人的话推到 App；后台子线程、提醒和系统主动提醒也走同一个收件箱，由主模型决定要不要开口。
5. **外部 agent。** 别的 agent 经 `/api/mcp/v1` 搜记忆、推记忆或提议；接入由主人建，写入同样经过校验（[ADR 0307](adr/0307-external-agents-and-the-memory-hub.md)）。

[返回目录](#contents)

<a id="in-progress"></a>

## 正在变的部分

这些设计已经定了，代码还在写，以对应 ADR 为准：

- 去掉网页，App 用通行密钥直接登录，网页上的功能搬进 App（[ADR 0309](adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md)）。
- 每人一台用 gVisor 隔离的长期电脑，编码工具在里面跑（[ADR 0298 的“每人一台电脑”](adr/0298-where-tools-run.md#user-computers)，入口 `apps/agent-service/src/production-computer-tools.ts`）。
- 密码和密钥放进手机解锁的保险箱（[ADR 0288](adr/0288-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md)）。
- 苹果客户端各自发挥设备长处（[ADR 0247](adr/0247-apple-clients-are-fully-native-with-a-capability-table.md)、[ADR 0258](adr/0258-each-apple-device-plays-to-its-strength.md)），感知记录见 [ADR 0230](adr/0230-perception-records-and-memories-inferred-from-perception.md)。

[返回目录](#contents)

<a id="decision-links"></a>

## 相关决定

- 基础原则：[ADR 0296](adr/0296-foundational-architecture-principles.md)
- 在 Pi 上开发：[ADR 0294](adr/0294-building-on-pi.md)
- 模型调用：[ADR 0297](adr/0297-how-model-calls-work.md)；发给模型的内容：[ADR 0303](adr/0303-what-the-model-is-sent.md)
- 工具在哪跑：[ADR 0298](adr/0298-where-tools-run.md)；工具调用和命令生命周期：[ADR 0299](adr/0299-tool-calls-and-command-lifecycle.md)
- 主对话、子线程和收件箱：[ADR 0285](adr/0285-one-main-thread-subthreads-and-one-inbox.md)
- 记忆：[ADR 0300](adr/0300-how-memory-works-now.md)、[ADR 0286](adr/0286-the-main-model-reads-and-writes-memory-itself.md)
- 规则手册：[ADR 0301](adr/0301-the-owners-rule-book.md)；决策记录和校准：[ADR 0302](adr/0302-decision-records-and-calibration.md)
- 数据库读写和并发：[ADR 0306](adr/0306-database-access-and-concurrent-conversations.md)；导出：[ADR 0304](adr/0304-data-and-chat-export.md)；密钥识别：[ADR 0305](adr/0305-recognizing-and-masking-secrets.md)
- 外部 agent：[ADR 0307](adr/0307-external-agents-and-the-memory-hub.md)
- 客户端：[ADR 0229](adr/0229-native-apple-clients-and-device-api.md)、[ADR 0309](adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md)、[ADR 0295](adr/0295-web-chat-interface.md)（网页，待删）
- CI 和上线：[ADR 0292](adr/0292-how-ci-runs-now.md)、[ADR 0293](adr/0293-how-production-deploys-work.md)

[返回目录](#contents)
