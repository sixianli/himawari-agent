---
status: active
document_type: adr
decision_status: accepted
supersedes: docs/adr/0021-platform-capability-runtime-isolation.md
superseded_by: ""
date: "2026-08-29"
---

# ADR 0022: Mac 命令采用 Seatbelt 与 Apple container 双层沙箱

## Context

ADR 0021 在缺少受支持 Mac 隔离后端时阻止任意 program 与 stdio MCP，并把签名的 App Sandbox/XPC helper 和通用容器保留为后续候选。S6 现在需要把低风险本机观察与可能执行代码、写文件或接触秘密的命令分开：前者需要低启动开销和精确只读文件范围，后者需要独立 Linux VM 形成更强的宿主隔离。

Apple 的正式产品边界是签名并带 entitlement 的 App Sandbox；Seatbelt 是其底层策略机制，不代表可以把未公开稳定的 `/usr/bin/sandbox-exec` 当作产品接口。Apple `container 1.2.0` 为每个容器提供轻量 Linux VM，并支持无网络、只读 root、资源上限和显式 bind mount，但仍必须验证安装包签名、精确版本、镜像 digest 和真实隔离行为。

## Decision

1. Mac `Himawari Command Sandbox` 使用两个不可互相替代的执行层：`native-low-risk` 进入签名的 App Sandbox/XPC helper；`isolated-high-risk` 进入 Apple `container 1.2.0`。
2. `native-low-risk` 是关闭集合，只允许无网络、无 secret、无脚本、无写入的只读 Git 观察命令。当前集合仅包含 `git diff`、`git log`、`git rev-parse`、`git show` 和 `git status`；helper 只接收类型化请求和只读 workspace 授权，不暴露通用任意 argv 接口。
3. `node`、`npm`、任何脚本、任何 secret、写入操作以及不能机械证明为低风险的命令全部属于 `isolated-high-risk`。未知状态按高风险处理；不得由模型或调用方临时降低风险等级。
4. CommandProfile 在授权时冻结 `sandboxTier` 与 `sandboxRuntimeIdentity`。执行路由只按冻结值选择后端；目标后端缺失、版本不符或 qualification 失败时 fail closed，禁止从 Apple container 回退到 Seatbelt。
5. Apple container 后端必须固定 `1.2.0` 与不可变 image digest，使用 `--network none`、`--no-dns`、`--home-mount none`、`--read-only`、单一 workspace bind、guest `prlimit`、Worker wall/output ceiling 和进程组终止。资格探针必须证明 guest 只有 loopback、不存在 raw-IP 默认路由、宿主 `/Users` 不可见且 root 不可写，不能只验证 DNS 失败。
6. `Seatbelt` 在本决定中专指正式签名的 App Sandbox/XPC helper。直接调用 `/usr/bin/sandbox-exec` 仍只允许非生产 spike，不构成 `native-low-risk` production qualification。
7. Linux 保留非 setuid `bubblewrap 0.11.2 + prlimit >=2.38` 的隔离后端；Linux 可以把低风险命令提升到该更强后端，不要求实现 Seatbelt 等价层。
8. 本决定授权仓库内合同、路由、helper/容器 adapter、测试和 governed 文档变更；安装 Apple container、创建或使用签名身份、修改 Hermes 软件包及启用真实 capability 仍分别需要对应授权和 live qualification。

## Options Considered

### 全部命令使用 Apple container

- Benefits: 单一强隔离边界，分类错误面较小。
- Costs: 所有只读观察都承担 VM 启动与镜像依赖；Apple container 不可用时连低风险本机观察也完全丢失。

### 全部命令使用 Seatbelt

- Benefits: 启动快，容易接入本机文件授权。
- Costs: 任意代码、构建工具和 secret 处理与低风险观察共用较弱边界；无法满足高风险命令的独立 VM 要求。

### 根据冻结风险等级使用双层后端

- Benefits: 低风险路径保持本机体验，高风险路径获得独立 VM；关闭集合、无回退和资格门禁可以机械限制误分类。
- Costs: 需要维护签名 helper 与容器镜像两套供应链，并对两层分别做 live qualification。

## Consequences

- Positive: Mac 命令路由、风险升级和失败语义成为显式合同；高风险命令不会因容器故障静默降级。
- Negative: 在签名 helper 和 Apple container 都未通过 live qualification 前，两层都只能保持 fail closed；仓库内 fixture 不能替代生产证据。
- Implementation: `CommandProfile` 已冻结 `sandboxTier`，`CommandProfileService` 已机械限制 native 关闭集合，`MacCommandSandboxRouter` 已实现无回退路由。签名 App Sandbox/XPC helper、官方签名安装成功的 Apple container 和同一 revision 的 live probe 仍是 Task 2 的未完成资格项。

## Links

- [SOURCE: docs/execution/plans/2026-08-26-host-files-code-workspaces-plan.md#task-2完成-machermes-文件与执行-qualification]
- [SOURCE: docs/architecture-v0.1.md#capability-registry-and-execution-boundary]
- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Apple container releases](https://github.com/apple/container/releases)
- [Apple container command reference](https://github.com/apple/container/blob/main/docs/command-reference.md)
