---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-09-29"
---

# ADR 0036：Agent Service 与 Execution Worker 必须成对重启

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 在一台机器上由两个常驻进程组成：Agent Service（下称 Agent，负责对话、权限和数据库）和 Execution Worker（下称 Worker，负责实际执行工具）。两者通过本机 UDS（Unix domain socket，同一台机器上进程之间传数据的通道）通信。

2026-09-28 的工具执行排查发现：Worker 单独退出、Agent 继续运行时，业务接口一律返回 `SERVICE_NOT_READY`，页面连“停止本轮”都点不了；工具结果如果还没来得及保存，就只能一直等下去（证据见 [stop-5](../../.ci-output/handoff/2026-09-28-codex-round2-stop-5.md)）。反过来，两个进程一起重启后，新的授权代次会让旧 Worker 失去提交权，恢复流程能明确地接着处理或结束原来的工具调用。

Hermes（局域网里运行 Himawari 的 Linux 服务器）上的启动脚本 `scripts/operations/hermes-ui-session-start.mjs` 已经这样做：任一子进程退出时，先停 Agent，再停仍在运行的 Worker，然后以非零状态退出，由 systemd（Linux 的服务管理程序）把整对进程重新拉起。Mac 上还没有常驻启动方式；[可移植耐久 Web Agent 计划](../execution/plans/2026-08-26-portable-durable-web-agent-plan.md)里规划了 launchd（macOS 负责开机启动和自动重启程序的服务管理机制）配置。这个规则要在做 Mac 启动方式之前定下来。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Agent 和 Worker 是一个重启单位。** 任何平台上的正式启动方式，包括 Hermes 的 systemd 和以后 Mac 的 launchd，都必须做到：两个进程中任意一个退出，就停掉另一个，再把两个一起重新启动。停止顺序沿用 Hermes 启动脚本的现有做法：先停 Agent，再停 Worker。
2. **“只剩一个进程在运行”不是受支持的工作状态。** 产品在这种状态下只保证结果安全：不交付未确认的结果，不重复执行工具。但不保证页面可用，也不为这种状态专门增加恢复能力。
3. 以后新增的执行后端或进程拆分，如果改变了这两个进程的关系，需要新的 ADR 取代本决定。

用户在 2026-09-29 确认采用本决定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：任意一个退出就成对重启（采用）

- 好处：与 Hermes 现有启动脚本一致；重启后新的授权代次使旧 Worker 失去提交权，已有的恢复流程可以直接处理，不需要新增状态。
- 代价：Worker 崩溃时 Agent 也会重启，页面会短暂断开几秒。

### 方案 B：两个进程各自独立重启，Agent 自行处理 Worker 掉线

- 好处：Worker 崩溃时对话服务不中断。
- 代价：Agent 要能在同一个运行周期内识别并放弃掉线 Worker 的执行权、处理停止请求、给出明确结局，需要额外设计和开发，也会增加要测试的状态组合。目前没有这个需求。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：恢复流程只需要面对“两个都在”和“两个都重启过”两种情况，工具结果不会因为只剩一个进程而长时间卡住。
- 代价：任一进程崩溃都会造成几秒的整体不可用。
- 后续：实现 Mac 的 launchd 配置时，必须按本决定配置成对重启，并在测试中验证“只杀 Worker”和“只杀 Agent”两种情况最后都是两个进程一起重新启动。Mac 主机名变化后旧锁可能让重启失败，见 [BL-20260929-002](../backlog/BL-20260929-002-mac-主-机-名-变-化-后-状.md)，它会直接影响成对重启能否成功。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 成对重启与离线就绪边界：[SOURCE: docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md#成对重启与离线就绪边界]
- Mac 与 Hermes 服务部署的设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 相关待办：[SOURCE: docs/backlog/BL-20260929-002-mac-主-机-名-变-化-后-状.md]
