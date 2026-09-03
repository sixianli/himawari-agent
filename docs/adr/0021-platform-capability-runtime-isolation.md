---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: docs/adr/0022-mac-tiered-command-sandbox.md
date: "2026-08-28"
---

# ADR 0021: 以平台资格门禁组合能力运行时隔离

## Context

S4 要求本地 program、stdio MCP、远程 API 和产品 adapter 共用同一 Manifest、授权、秘密、资源上限、撤销与 Trace 语义，但装载方式不同。当前 Execution Worker 已强制 wall time、输出和进度上限，却没有可用于任意本地程序的生产隔离 adapter。Spec 明确禁止以测试 adapter 代替生产隔离，也禁止在平台无法满足 Manifest 时把能力标记为 active。

官方资料显示，bubblewrap 是 Linux 上构造非特权 namespace 沙箱的低层工具，但不是预制安全策略；安全边界取决于调用方生成的参数。`0.11.2` 修复了影响 setuid 模式的 CVE-2026-41163，并建议关闭 setuid 支持。bubblewrap 能建立文件系统、PID、IPC、UTS、cgroup 与网络 namespace，但不提供域名级网络 allowlist，也不单独覆盖全部 CPU/内存资源上限，因此必须与 util-linux `prlimit`、Worker wall/output 上限和严格参数生成组合。

Apple 的公开稳定边界是经过签名与 entitlement 配置的 App Sandbox；子进程必须是嵌入式 helper 并继承沙箱，Apple 还建议用 XPC 做权限分离。当前 Node 服务既不是已签名 App Sandbox app，也没有受审查的 XPC/helper。系统仍提供的 `/usr/bin/sandbox-exec` 不是本项目可依赖的公开稳定产品接口，不能据此把任意 program 或 stdio MCP 声明为生产隔离。

MCP 不应由 Himawari 重新实现协议。官方 TypeScript SDK `2.0.0` 已于 2026-07-27 发布，要求 Node.js `>=20`、许可证为 MIT，并提供 Node-only `StdioClientTransport`、初始化握手、工具/资源/prompt API、缓冲限制和关闭时的进程终止语义；本仓库 Node.js `>=22.19.0` 满足其运行要求。

## Decision

1. Linux 本地 program 与 stdio MCP 只通过产品生成的固定 bubblewrap `>=0.11.2` 参数运行；拒绝 setuid binary，要求可用的非特权 user namespace，并用 `prlimit`、Worker ceiling、受控进程组与终止升级共同约束 CPU、地址空间、进程数、输出和 wall time。
2. bubblewrap 只批准无网络能力。任何非空网络 scope 都无法由该后端精确执行，必须阻止 active；后续若引入域名级 egress proxy 或其他可验证后端，需新 ADR 或修订本 ADR。
3. Mac 上的任意 program 与 stdio MCP 默认阻止 active。只有后续交付并验证签名的 App Sandbox/XPC helper、继承 entitlement、文件/网络范围和终止行为后，才能加入 production-suitable backend；`sandbox-exec` 只允许用于明确标注为非生产的隔离 spike。
4. MCP client 固定直接依赖官方 `@modelcontextprotocol/client` `2.0.0`，只允许 stdio transport 通过同一隔离启动描述符启动 server。远程 MCP 不在本 ADR 范围内，不做 SSE fallback。
5. artifact 使用 Node `crypto` 完成 SHA-256 与受信 signer 的签名验证；symlink、非普通文件、digest/signature mismatch 或不可验证 rollback artifact 一律阻止激活/更新。
6. 远程 API/adapter 使用产品绑定的精确 HTTPS endpoint identity、禁止 redirect、受保护 secret handle、请求 deadline 和响应字节上限；运行时不接收产品 store 写权限。
7. 每个平台在激活和版本切换前产生结构化 qualification。缺失 backend、版本不符、平台不支持、资源上限不完整或 isolation scope 无法机械执行时，Capability Lifecycle 必须 fail closed。
8. 本决定只授权仓库实现、依赖锁定和非生产 fixture 资格测试，不安装或启用任何真实 capability，不连接第三方 MCP/API，不修改 Hermes 软件包或生产状态。

## Options Considered

### 直接使用 Node `child_process`

- Benefits: 无外部平台依赖，跨平台一致。
- Costs: 只能限制继承环境、stdio、wall time 和输出，不能形成文件系统、网络、PID 或 syscall 隔离；拒绝。

### Mac/Linux 都使用 `sandbox-exec`/bubblewrap

- Benefits: 两个平台都能以命令行 wrapper 启动子进程。
- Costs: `sandbox-exec` 缺少本项目可依赖的公开稳定产品契约；bubblewrap 也只支持 Linux，且本身不是完整安全策略；拒绝伪造跨平台等价性。

### Linux bubblewrap 加严格门禁，Mac 等待签名 helper

- Benefits: Linux 可形成可审计的 namespace/filesystem/no-network 边界；Mac 明确阻止未满足的能力，不用测试证据冒充生产资格。
- Costs: Mac 本地 program/stdio MCP 暂时不可 active；Linux 仍需主机安装并通过版本、user namespace、`prlimit` 和参数 spike。

### 通用容器或虚拟机后端

- Benefits: 可以提供更完整的镜像、cgroup、网络与资源治理。
- Costs: 引入 daemon、镜像供应链、特权面和更大的运维契约；当前未完成版本匹配与平台验证，保留为后续候选。

## Consequences

- Positive: 无法满足 Manifest 的平台会机械阻止能力 active；MCP 复用官方协议实现；更新与回退可以复用相同 artifact/readiness 证据。
- Negative: Mac 的动态本地进程能力和带网络的 Linux program/MCP 暂时不可用；Hermes 必须在不改变主机状态的资格检查中证明精确工具版本后才可启用。
- Implementation: artifact verifier、platform qualifier、bubblewrap/prlimit launch builder、MCP/API/program adapters 与更新/回退服务已经实现并通过 fixture。Mac 非生产 spike 验证策略行为但仍不具生产资格；Hermes 只读探测确认缺少 `bwrap` 且 `prlimit 2.37.2` 低于门禁。若要安装 bubblewrap、签名 helper 或真实 capability，仍需独立 Owner 授权。

## Links

- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md#统一能力类型]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md#task-9资格验证并实现隔离与-runtime-adapters]
- [Bubblewrap 官方仓库与安全边界](https://github.com/containers/bubblewrap)
- [Bubblewrap 0.11.2 安全发布](https://github.com/containers/bubblewrap/releases/tag/v0.11.2)
- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Apple App Sandbox 继承](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP v2 stdio client](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md)
