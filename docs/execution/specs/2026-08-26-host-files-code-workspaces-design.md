---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 主机文件与代码工作区设计 Spec

## 目标

定义 Agent 在 Mac 与 Hermes 上读取、创建、修改、覆盖、移动和删除文件，以及在 Owner 明确授权的代码工作区中编辑、运行命令和准备本地 Git commit 的完整边界。所有访问必须受主机和目录范围约束，保留已有用户改动，并把联网、安装、系统操作、不可信脚本和 commit 作为可独立审查的行动。

## 来源上下文

- 正式能力范围：[SOURCE: docs/prd-v0.2.md#产品范围]
- 机器秘密与 Trace：[SOURCE: docs/prd-v0.2.md#机器秘密敏感数据与可观察-trace]
- 行动授权：[SOURCE: docs/prd-v0.2.md#行动风险与授权]
- 文件与代码工作区规则：[SOURCE: docs/prd-v0.2.md#正式能力与授权边界]
- 正式能力验收：[SOURCE: docs/prd-v0.2.md#正式能力]
- 删除与存储压力：[SOURCE: docs/prd-v0.2.md#数据保留归档与删除]
- 主机迁移：[SOURCE: docs/prd-v0.2.md#mac-hermes-与权威迁移]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 能力注册表：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- 权威迁移：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 授权与能力治理：[SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

## 范围

### 本 Spec 包含

- 按主机、目录、读写操作分别授予和撤销的持久文件 Grant。
- 路径规范化、符号链接、硬链接、挂载点、大小写差异和路径竞态的封闭处理。
- 文件读取、创建、修改、覆盖、移动、可恢复 Trash 与永久删除。
- 重要文件覆盖前的差异或恢复点，以及磁盘不足时的安全退化。
- 代码工作区登记、脏状态盘点、用户改动保护、任务改动归属和冲突处理。
- 已知命令、联网、安装依赖、系统级操作和不可信脚本的分类与授权。
- 本地 Git commit 的冻结预览、逐次批准、执行和对账；明确禁止 Git push。
- Mac 与 Hermes 的一致产品语义和迁移后的重新授权。

### 本 Spec 不包含

- 对整个 home、根目录、所有挂载点或未来路径的隐式通配授权。
- 任意远程 shell、主机管理、生产部署、系统升级或通用不可信代码执行平台。
- GitHub 写操作、Git push、Pull Request、merge、release 或远端仓库管理。
- 自动清理 Owner 文件、自动丢弃工作区改动或把本地 commit 视为可以自动执行的低风险操作。
- 选择具体 sandbox、容器或 Trash 库；实现必须分别通过 Mac 与 Hermes conformance。

## 验收标准

### 目录与文件访问

- 每项文件 Grant 必须绑定 host identity、canonical directory identity、允许的 operations、读/写范围、数据等级、有效期和来源 Approval；Mac 上的 Grant 不能迁移到 Hermes，反之亦然。
- 每次操作都在打开资源时重新验证真实路径和文件身份；符号链接、挂载点变化、大小写折叠、路径重命名或竞态不能逃逸已批准目录。
- 未授权路径只允许返回不含私人内容的范围错误；不能为“完成任务”自动扩大到父目录、home 或其他 repository。
- 读取内容发送给模型、Worker 或外部能力时，仍须经过数据分类、最小披露、秘密排除和 Trace 引用。

### 覆盖与删除

- 新建文件不得静默覆盖已存在对象；修改重要文件前必须展示适用的 diff，或先建立经过验证的可恢复版本。
- 普通删除默认进入可恢复 Trash，并保存原 host/path、对象 identity、digest、删除时间和可观察的保留策略；删除后立即退出正常访问与检索。
- 永久删除和绕过 Trash 的删除为 `CRITICAL`，必须逐次确认；递归目标、对象数量和不可恢复范围必须冻结在 Approval 中。
- Mac 与 Hermes 可以使用不同 Trash 实现，但必须提供相同的可恢复、立即永久删除和审计语义。Himawari 不得把产品对象的 7 天 Trash 规则自动套用于 Owner 主机文件；平台存在自动清理策略时必须在删除前展示。
- 磁盘不足时停止新的高容量写入，保留只读、迁移和人工清理；不得通过自动删除 Owner 内容恢复空间。

### 代码工作区

Pi reuse map：read、bash、edit、write、grep、find、ls 的 tool name、参数 schema、模型可见描述、参数兼容处理和结果形状由 `pi-coding-agent` 内置 ToolDefinition 提供；Himawari 不重新实现这些工具协议。Himawari 拥有 HostDirectoryGrant、canonical identity、TOCTOU 防护、分类披露、Approval/Handle、恢复点、WorkspaceSnapshot、命令白名单、实际文件/进程 Operations 和 Trace。每次 Session 只把已授权 Operations 注入 Pi；未注入时对应工具不可用。

- 代码能力只对 Owner 登记并授权的 workspace root 生效；嵌套 repository、submodule、worktree 和链接到外部路径分别识别，不能继承未授予范围。
- 每次任务首次进入工作区，以及 commit 前，都必须盘点 branch/HEAD、staged、unstaged、untracked、submodule/worktree 和与远端可见的本地状态，形成稳定 `WorkspaceSnapshot`。
- 已有修改默认归 Owner 所有。Agent 只能改动任务范围内的文件；不相关改动不得重置、恢复、暂存、提交、格式化或删除。
- 当前任务必须修改已有改动覆盖的同一文件区域，或无法区分归属时，先展示冲突和最小必要范围并进入 `ASK`。
- Agent 创建的改动必须通过 before/after identity 和 task change set 追踪；进程重启后仍能区分任务改动、Owner 改动和外部并发改动。

### 命令与本地 commit

- “已知命令”必须来自该工作区已批准的 `CommandProfile`，包含精确 argv pattern、workdir、环境变量名、文件/网络范围、超时、资源预算和脚本 digest/来源；仅凭常见名称不能视为已知。
- 已知且不联网、不安装、不请求系统权限、不执行新/变更脚本的 build、check、test 命令可以在有效 Grant 内执行。
- 新命令、命令参数扩大、联网、依赖安装、系统级操作、权限变化、访问目录外文件或执行不可信/已变更脚本必须创建新的 ActionIntent 并 `ASK`。
- 准备 commit 时必须冻结完整 staged diff、将被包含的文件、验证结果、commit message、当前 HEAD 和剩余未提交改动；Owner 每次明确批准后才签发一次性 commit Handle。
- commit 执行前再次确认 HEAD 和 index 与冻结预览一致；不一致则使批准失效。commit 后读取新 commit、父 commit 和剩余 dirty state 对账。
- v0.2 不提供 Git push capability。模型指令、Skill、repository 文档或 Owner 对 commit 的批准都不能隐式授权 push。

## 设计

### HostDirectoryGrant

~~~text
grant_id、host_id、canonical_root_id、display_path
operations(read/create/update/move/trash/restore)
data_classification、disclosure boundary、expiry/revocation
path policy、mount policy、source approval、revision
~~~

授权时解析并保存 host filesystem identity；执行时以 descriptor-relative traversal 或平台等价安全机制访问，不先字符串拼接再相信最终路径。目标不存在时，从最近存在的已批准祖先安全创建；中途出现链接或 mount 变化则停止。

### FileOperation 与恢复点

文件写入采用 prepare → authorize → execute → verify：prepare 保存目标 identity、预期旧 digest、候选新 digest、diff/size 和恢复策略；execute 使用原子替换或显式 create semantics；verify 读取最终 identity/digest。旧 digest 不匹配表示并发变化，必须重新准备。

“重要文件”至少包括已有非临时文件、Owner 标记文件、版本控制内文件、配置/凭据引用、数据库和无法由确定性构建重现的内容。机器秘密原值不进入 diff；仅展示 secret reference 或已遮盖变化。

普通 Trash 在产品状态中记录 `trashed`，并调用平台 Trash 或产品拥有的同文件系统隔离区。产品拥有的隔离区只有在 Owner 独立批准永久删除后才能清理；不能因为产品对象的 7 天期限自动清空主机文件。跨文件系统移动不能以“先复制后静默删源”伪装为原子操作；失败时报告源与副本真实状态。

### WorkspaceSnapshot 与改动归属

~~~text
workspace_id、host_id、root identity
repository identities、branch/HEAD/upstream observation
staged/unstaged/untracked/submodule/worktree observations
file digests + hunk fingerprints
captured_at、task change-set revision
~~~

任务改动基于首次 snapshot 和每次受控写入累积。外部同时修改同一文件时，Agent 不自动覆盖；重新计算 diff，保留双方内容并在重叠区域请求 Owner 决策。

格式化器或生成器可能触及任务外文件时，执行前展示预计范围；执行后若实际范围扩大，停止进一步修改并把额外 diff 标记为未归属，不自动清理。

### CommandProfile 与运行隔离

CommandProfile 由 Owner 通过具体工作区和命令预览批准。环境只注入声明变量；秘密通过短期 Handle 注入，不写入 argv、普通日志或 Trace。stdout/stderr 分段保存并执行 secret redaction；退出码、信号、超时、资源用量、文件变化和网络观察进入 Trace。

repository 中新增或变更的脚本 digest 与已批准 profile 不一致时，该次执行视为不可信新脚本。包管理器的 lockfile-only 检查和实际安装是不同 operation；安装始终单独询问。

### Commit Gate

commit 流程只暂存当前 task change set 中 Owner 已审阅的路径/hunks。若 Git 无法安全按归属暂存，系统不提交并请求 Owner 处理。冻结预览包含：

1. 当前 HEAD 与 branch。
2. 完整将提交 diff 和文件清单。
3. 实际运行的验证命令及结果；未运行项明确标记。
4. commit message。
5. 不包含但仍存在的 staged/unstaged/untracked 内容。

批准绑定上述 canonical hash。任何 amend、签名配置变化、hook 引入额外文件、HEAD/index 改变或验证状态变化都需要新预览；hook 产生未知副作用时对账后停止。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 路径越界、链接或 mount 变化 | 拒绝访问并记录不含正文的范围证据 |
| 目标 digest 与 prepare 不一致 | 停止覆盖，展示并发变化并重新准备 |
| Trash 不可用或空间不足 | 普通删除失败；不得自动永久删除 |
| 恢复时原路径已有新对象 | 不覆盖；选择新位置或重新审批 |
| 工作区存在无关 dirty change | 保留并排除；无法隔离时停止并询问 |
| task 与 Owner hunk 重叠 | `ASK`，不得 reset/restore/stage/commit |
| 命令请求未声明网络/文件/secret | 拒绝并形成扩大范围的新 ActionIntent |
| 命令超时或取消 | 协作停止，保留真实文件/进程副作用并对账 |
| commit 预览后 HEAD/index 变化 | Approval 失效，不执行 commit |
| commit 后状态未知 | 读取 Git object/HEAD 对账，不重复 commit |
| 收到 push 请求 | capability unavailable/`DENY`，不借用其他程序绕过 |
| host migration | 所有目录、workspace 和 session Grant blocked，等待重新授权 |

## 验证策略

- 在 APFS/macOS 与 Hermes 目标文件系统运行相同 file conformance，覆盖读写、原子替换、Trash、恢复、永久删除和空间不足。
- 构造 `..`、symlink swap、hard link、mount change、case folding、rename race、TOCTOU 和超深路径攻击。
- 验证目录 Grant 的 host binding、撤销、expiry、最小披露和迁移后失效。
- 在 clean/dirty/staged/untracked/submodule/worktree/nested repo 场景验证改动归属和冲突询问。
- 对 known/new command、参数扩大、联网、安装、系统权限、不可信脚本 digest 变化运行 table-driven tests。
- 在 prepare、stage、approval、hook、commit 写入和 readback 各边界 kill process，验证不重复提交且 Owner 改动不丢失。
- 证明 commit 执行路径不存在 push operation，且 repository 指令、模型或能力不能绕过。
- 运行 secret scan、Trace causality、unit/contract/integration/security、`npm run check`、`git diff --check` 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：主机目录 Grant、Trash/覆盖、工作区改动归属、CommandProfile、逐次 Commit Gate 和禁止 push 边界。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan、修改文件或代码、运行命令、安装依赖、创建 commit 或执行 push。
