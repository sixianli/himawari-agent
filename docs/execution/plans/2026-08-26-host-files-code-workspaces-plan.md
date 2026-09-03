---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 主机文件与代码工作区 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]

**依赖 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-control-center-experience-plan.md]

**目标：** 实现绑定具体主机与目录的安全文件能力、可恢复 Trash、代码工作区改动归属、受控 CommandProfile 和逐次批准的本地 Git commit gate，并在 Mac/Hermes 保持相同产品语义且完全不提供 push。

**架构：** application 定义 HostDirectoryGrant、FileOperation、WorkspaceSnapshot、CommandProfile 和 CommitPreview；platform-node 使用 descriptor-relative 或平台等价机制执行路径/文件/Git/进程操作；SQLite 保存 Grant、prepare snapshot、task change set、execution/reconcile 和 audit；Worker 只使用短期 capability Handle。

---

## 执行依赖与停止点

- S1 必须提供 host/deployment identity、SQLite、Payload/secret、Worker、Trace、deletion/migration 和 authority fence；S4 提供 ActionIntent/Grant/Handle。
- 具体 Trash、安全路径 traversal、sandbox/process 和 Git library/CLI 实施在 Spec 中未选择，必须先做 APFS/macOS 与 Hermes 目标文件系统 qualification。
- 真实 Owner 目录、代码仓库、命令、依赖安装、系统权限、本地 commit 或永久删除均需要对应范围的独立授权；测试默认只使用临时 fixture。
- 用户已有修改默认归 Owner；任何重叠 hunk、无法隔离 stage、实际 formatter 范围扩大或 HEAD/index 变化都停止并 ASK。
- 产品的 commit capability 与实施本项目时的 Git 工作流是两个边界；产品验收只能在隔离 fixture 仓库执行，不能拿本 Plan 的文档 commit 充当证据。

## 文件边界

### 新建

- packages/application/src/ports/host-files.ts
- packages/application/src/ports/workspaces.ts
- packages/application/src/services/file-operation-service.ts
- packages/application/src/services/workspace-service.ts
- packages/application/src/services/command-profile-service.ts
- packages/application/src/services/commit-gate-service.ts
- packages/platform-node/src/files/
- packages/platform-node/src/workspaces/
- packages/platform-node/src/process/
- packages/persistence-sqlite/src/host-capabilities/
- packages/testing/src/conformance/host-file-suite.ts
- packages/testing/src/conformance/workspace-suite.ts
- test/fixtures/filesystems/
- test/fixtures/git-workspaces/
- test/integration/host-files.test.ts
- test/integration/workspace-ownership.test.ts
- test/integration/commit-gate-recovery.test.ts
- test/integration/security/path-confinement.test.ts

### 修改

- packages/domain/src/identifiers.ts：稳定 host/directory/file/workspace/operation identities。
- packages/application/src/ports/capabilities.ts、authorization.ts 与相关 services。
- packages/gateway-contracts/src/、packages/execution-contracts/src/：prepare/execute/verify、command 与 commit contracts。
- packages/persistence-sqlite/：migrations、Grant、snapshot/change set、operation/reconcile 和 Trash metadata。
- packages/platform-node/：Mac/Hermes adapters、secret-safe process/Git handling。
- packages/runtime-pi/：复用 Pi built-in coding ToolDefinition，并注入通过 HostDirectoryGrant/Workspace/Command governance 的 Operations；禁止另写 tool schema/protocol。
- packages/testing/、apps/agent-service、apps/execution-worker、apps/control-center：conformance、composition 和 UI。
- scripts/check-boundaries.mjs、manifests/lockfile：仅加入获批精确依赖。
- Architecture/README：实测后更新。

### 测试

- packages/application/test/
- packages/gateway-contracts/test/
- packages/execution-contracts/test/
- packages/persistence-sqlite/test/
- packages/platform-node/test/
- packages/testing/test/
- apps/execution-worker/test/
- apps/control-center/test/
- test/integration/
- test/integration/security/
- test/e2e/browser/

## 实施任务

### Task 1：建立 S6 acceptance 映射与当前边界基线

- [x] 将 S6-A01 目录文件访问、S6-A02 覆盖删除、S6-A03 代码工作区、S6-A04 命令本地 commit 绑定 tasks/evidence。
- [x] 盘点 S1/S4 host identity、secret、Worker、Grant、Trace、deletion 和 migration contracts。
- [x] 建立 path escape、TOCTOU、dirty state、untrusted command、hook 和 no-push threat matrix。
- [x] 保存现有 check/tests/strict validation baseline。

Task 1 的 fresh baseline、threat matrix 与 Pi reuse map 位于 `test/integration/qualification/evidence/s6-tasks1-12-host-workspace-local-implementation.json`。

### Task 2：完成 Mac/Hermes 文件与执行 qualification

- [x] 采纳 Mac 双层命令合同：只读关闭集合使用签名 App Sandbox/XPC helper，高风险与未知命令使用 Apple container；冻结 tier、只允许风险升级、禁止失败后降级。
- [ ] 在 APFS/macOS 与 Hermes 目标文件系统识别 filesystem identity、case、link、mount、atomic replace、Trash/recovery、permissions 和 disk-full 行为。
- [ ] 评估 descriptor-relative traversal、Trash、Git 和 process isolation 候选的官方文档、精确版本、许可证、维护、安全与 Node 支持。
- [ ] 用临时目录/fixture 仓库验证 symlink swap、hard link、mount/rename race、submodule/worktree、hook 和 cancellation。
- [ ] 展示 dependency/manifest/lockfile 影响并获批后安装；任何平台硬语义失败时阻止能力，不以字符串 prefix check 替代。

### Task 3：冻结 HostDirectoryGrant 与操作 contracts

- [x] 定义 host_id、canonical_root_id、display path、operations、classification/disclosure、expiry/revoke、path/mount policy 和 Approval/revision。
- [x] 定义 FileOperation prepare snapshot：目标 identity、旧/新 digest、diff/size、recovery strategy、expiry 和 canonical hash。
- [x] gateway/execution contracts 覆盖 read/create/update/move/trash/restore/permanent delete 与 stable errors。
- [x] 目录不存在时只允许从最近已批准祖先安全创建；中途 link/mount 变化 fail closed。
- [x] 所有跨 host、scope expansion、stale fence/handle 和未知字段测试拒绝。

### Task 4：实现安全路径解析与读能力

- [x] 将受治理 ReadOperations 注入 Pi `read` ToolDefinition；复用 Pi 参数与结果语义，不启用默认 local filesystem operations。
- [x] 授权时解析并保存真实 filesystem identity，执行时重新验证 opened resource identity。
- [ ] 使用 descriptor-relative 或平台等价 traversal，拒绝 ..、symlink/hard-link escape、mount change、case alias、rename race 和超深路径。
- [x] 未授权路径只返回不含私人正文的范围证据，不自动扩大到父目录/home。
- [x] 读取发送给模型/Worker/外部能力前执行 classification、最小披露、secret exclusion 和 protected ref。
- [x] 对 revoke、expiry、migration 后 blocked 和 concurrent replacement 运行 conformance。

### Task 5：实现 prepare→authorize→execute→verify 写入

- [x] 新建使用 exclusive create，不能静默覆盖；已有对象修改冻结旧 digest、候选 digest、diff 和恢复策略。
- [x] 重要文件先展示适用 diff 或创建经过验证的恢复版本；secret 原值不进入 diff。
- [x] execute 使用原子替换或明确 non-atomic plan，verify 回读最终 identity/digest。
- [x] 旧 digest、target identity 或 mount 变化使 Approval 失效并重新 prepare。
- [x] 在 prepare、write、fsync/rename、verify 各边界注入中断与空间不足。

### Task 6：实现 Trash、恢复与永久删除

- [x] 普通删除默认进入平台 Trash 或同文件系统受控隔离区，记录原 host/path/identity/digest/time/retention observation。
- [x] Trash 后立即退出正常访问/检索；恢复时原路径存在新对象则不覆盖。
- [x] 永久/绕过 Trash 删除冻结递归目标、对象 identities/count 和不可恢复范围，标记 CRITICAL 且逐次 recent re-auth。
- [x] 不把产品对象 7 天 Trash 自动套用主机文件；平台自动清理策略在删除前展示。
- [x] 磁盘不足停止高容量写入，保留只读/迁移/人工清理，绝不自动删 Owner 内容。

### Task 7：实现 Workspace 登记与稳定 Snapshot

- [x] workspace 绑定 host/root identity，分别识别 nested repo、submodule、worktree 和外部 link。
- [x] 首次进入和 commit 前盘点 branch/HEAD、upstream observation、staged/unstaged/untracked、submodule/worktree 和 file/hunk fingerprints。
- [x] snapshot 持久保存 task change-set revision，进程重启后仍区分 Owner、task 和并发外部变化。
- [x] 本地状态观察与远端真实同步分开报告；clean tree 不代表 origin 同步。
- [x] 对 non-Git workspace、detached HEAD、unborn branch 和 inaccessible metadata 产生稳定结果。

### Task 8：实现改动归属与冲突保护

- [x] 初始已有改动全部标记 Owner-owned；task 只追踪受控写入产生的 path/hunk identities。
- [x] 无关改动不得 reset/restore/stage/format/delete/commit。
- [x] 重叠 hunk 或无法区分归属时展示最小冲突并 ASK，不能自动覆盖。
- [x] formatter/generator 执行前展示预计范围；实际扩大时停止并把额外 diff 标为 unowned。
- [x] 用 clean/dirty/staged/untracked/submodule/worktree/nested repo 与并发编辑 fixture 验证。

### Task 9：实现 CommandProfile 与受控执行

- [x] CommandProfile 冻结 workspace、argv pattern、workdir、env names、file/network scopes、timeout、resources 和 script digest/source。
- [x] 只有已知、不联网、不安装、不提权、不执行新/变更脚本的 build/check/test 可在有效 Grant 内执行。
- [x] 新命令/参数扩大、联网、安装、系统操作、目录外访问、secret 或 script digest 变化创建新 ActionIntent/ASK。
- [x] secret 通过短期 Handle，不进入 argv、普通日志或 Trace；stdout/stderr 分段 redaction。
- [x] 记录 exit/signal/timeout/resources/file/network observations；取消后对账真实进程与文件副作用。

### Task 10：实现冻结 CommitPreview 与一次性 commit

- [x] 只暂存 task change set 中可安全归属且 Owner 审阅的 paths/hunks。
- [x] Preview 冻结 HEAD/branch、完整 staged diff/files、验证命令/结果、message 和剩余 dirty state。
- [x] Approval 绑定 canonical hash，签发一次性 commit Handle。
- [x] 执行前重新验证 HEAD/index/preview；hook、配置、amend 或验证变化使批准失效。
- [x] commit 后读取新 commit、parent 与剩余 dirty state；unknown 先读 Git object/HEAD 对账，不重复 commit。

### Task 11：证明 push surface 不存在

- [x] capability manifests、gateway/execution schemas、Worker registry 和 UI 均不定义 push/PR/merge/release operation。
- [x] program runner 禁止通过未声明 git/gh/curl/SSH credential route 绕过。
- [x] repository 文档、Skill、模型输出或 commit Approval 不能扩大为 push。
- [x] 对 alias、hook、subprocess、remote helper、environment credential 和 renamed binary 做 negative tests。
- [x] 请求 push 时返回明确 unavailable/DENY 并保留 Trace。

Tasks 3–11 的本地核心实现 revision 为 `ca5942a`。`createGovernedPiCodingTools()` 继续复用 pinned Pi ToolDefinition，新增 bridge 只把已授权 product Operations 注入 Pi；HostDirectoryGrant、descriptor-equivalent path walk、exclusive create、原子替换/恢复副本、controlled Trash、WorkspaceSnapshot、ownership、CommandProfile、CommitPreview/Handle、Git readback 和 no-push 均由 Himawari 拥有。尚未完成的 gateway/execution wire contract、完整 hunk staging、process sandbox/分段日志、永久删除、控制中心和 Mac/Hermes 正式 conformance 保持后续门禁，不用本地 fixture 冒充。

S5/S6 收口阶段已补齐跨进程 `work.delegate` 委派协议：Agent Service 先在 SQLite 原子消费 durable Handle，再把权限衰减为本次 operation/input/context/secret refs、classification、deadline 和一次使用；Worker 只保存 boot-scoped 易失副本并二次消费，不直接打开 `product.sqlite`。本轮进一步接通正式 host operation/subtask adapters 与 Gateway/UI；双平台 qualification 仍是剩余硬门禁。

本轮继续完成 Gateway v2、Execution Worker、Control Center 与 durable recovery：文件 read/create/update/move/Trash/restore/permanent delete、workspace snapshot/ownership、CommandProfile/observation 和 CommitPreview/commit 都已接入；执行 receipt 在物理效果后丢失 acknowledgement 时会按稳定 operation identity 对账，不重复写、移动、删除或 commit。Git 暂存不再运行 `git add`，而使用 `hash-object --no-filters` 与独立 index；可执行 filter/textconv/merge driver/include/fsmonitor 配置在读取状态前 fail closed，hooks 被机械禁用，Owner 原有暂存条目保持不变；任务提交通过标准 index 锁和持久 journal 协调任务条目随 HEAD 前进。Apple container 1.2.0 与 Linux bubblewrap 0.11.2 provider 都要求精确 runtime/image identity、无网络、只读 runtime root、单一 workspace scope 和资源 ceiling；但真实 runtime 仍缺失，因此这些实现只构成 fail-closed candidate，不能把 fixture 计为 Task 2/12 双平台 qualification。

### 2026-09-03 审查修复

- 首次 Owner dirty 基线与受控写入前后摘要分别保存；路径范围不能替代来源证明。混合文件无法安全分离时拒绝提交，干净状态同时核对 HEAD/index blob 与实际字节/模式。
- CommitPreview 增加真实 Owner index 摘要；Git 事务覆盖 preparing、commit object、ref 发布和 index 安装。真实锁只在持久化所属身份后取得，重启仅处理自身锁，Owner 后续暂存变化会使恢复停止。
- 永久删除比较对象类型、identity 和 digest；同 inode 内容变化及部分删除后的剩余对象变化都会阻止扩大已批准的删除范围。
- 定向证据来自 `git-workspace-adapter.unit.test.ts` 与 `constrained-file-system.unit.test.ts`，包括真实临时 Git 仓库及子进程 SIGKILL。原有 qualification JSON 是历史本地记录，不据此扩大双平台资格。

### Task 12：完成恢复、双平台与 UI 验证

- [ ] 在 prepare/stage/approval/hook/commit write/readback 各边界 kill/restart，验证 Owner 改动不丢失且无重复 commit。
- [ ] Mac/Hermes 运行同一 file/workspace/command/commit conformance 与 migration blocked tests。
- [x] 控制中心展示 directory Grant、diff/recovery、workspace snapshot/ownership、command scope/output 和 CommitPreview。
- [x] 运行 secret、path、process、Git 和 no-push security suites。
- [ ] 映射 S6-A01–S6-A04，与 S0 J06/J09/J14、Architecture/README 对账后收口。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S6-A01 | 目录与文件访问 | Tasks 2–4、12 | APFS/Hermes、path attacks、Grant/revoke | contract/Pi bridge/Gateway/read model/path/link/revoke/recovery 本地完成；descriptor-relative 等价边界与双平台 qualification 待 Tasks 2、4、12 |
| S6-A02 | 覆盖与删除 | Tasks 5–6、12 | digest/atomicity、Trash/recovery、disk pressure | create/update/move/Trash/restore/permanent delete、disk reserve 与 crash recovery 本地完成；双平台 conformance 待 Task 12 |
| S6-A03 | 代码工作区 | Tasks 7–8、12 | dirty matrix、ownership/conflict、restart | snapshot/ownership/formatter expansion/nested repo/alternate index/commit recovery 本地完成；双平台 conformance 待 Task 12 |
| S6-A04 | 命令与本地 commit | Tasks 9–12 | CommandProfile、frozen preview、reconcile、no push | sandbox providers、secret/output、preview/one-shot commit/no-push、Worker/Gateway/UI 本地完成；真实 runtime 与双平台待 Tasks 2、12 |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- 本 Plan 新增的 file/workspace/process/Git/security/platform 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实主机目录、仓库、命令、安装、系统操作、commit 和删除必须分别授权；产品 conformance 使用隔离 fixture，不能操作未置于明确测试范围的 Owner 数据。

## 收口清单

- [ ] S6-A01–S6-A04 全部有 fresh Mac/Hermes evidence。
- [ ] 路径、链接、挂载和竞态不能逃逸授权目录。
- [ ] Owner 既有改动、task 改动和并发改动可恢复地区分，冲突不自动覆盖。
- [ ] commit 逐次冻结审批并 readback，任何执行路径都不存在 push。
- [ ] S0 journeys、S4 conformance、Architecture 和 README 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
