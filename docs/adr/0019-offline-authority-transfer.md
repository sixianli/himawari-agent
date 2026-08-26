---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# ADR 0019: 通过停机加密导出/导入迁移 Agent 权威

## 背景

同一个 Agent 必须能够在 Mac 或 Hermes 运行，但任意时刻只能有一个逻辑权威。v0.2 不要求 active-active、在线复制或自动故障切换。直接复制正在运行的 SQLite 文件会遗漏 WAL、在途 Run、Memory 投影或 Payload，并可能让源和目标同时继续执行外部行动。

机器秘密还具有主机绑定属性：macOS Keychain、Linux service credential、GitHub App 私钥、模型 API Key 和公网 tunnel credential 不能被当作普通产品数据搬运。

## 决策

跨机器迁移采用显式的停机 authority transfer：源部署进入 draining，停止新 Trigger 和调度，持久化或结束在途 Run，关闭 Agent Service、Worker 和所有 SQLite/Memory 连接，然后由受控 CLI 创建加密、带版本 manifest 和完整性校验的导出包。目标只在停止且为空的部署目录中导入；所有验证通过后才写入新的 active deployment identity 和 authority epoch。

迁移包包含继续同一 Agent 所需的产品数据库、不可重建 Payload、Memory 产品记录和适配器投影、非秘密配置元数据、schema/adapter 版本、transfer identity 与 digest。源主机 master key、模型/GitHub/网关凭据、Cookie、访问令牌、私钥和 Worker service token 不进入包。

Payload 数据密钥不能以源主机明文 master key 形式迁移。导出流程将所需数据密钥重新包装给加密包的接收方；导入成功后再由目标主机的新 master key 重新包装。包的 passphrase 或 recipient private key 只从交互式输入或目标秘密来源取得，不能出现在命令行参数、普通日志或 Trace 中。

导出后源 deployment 进入 `retired_pending_transfer` 并拒绝普通启动。目标激活后，源 deployment 进入 `retired`，保持不可启动，并保留加密副本 7 天；到期删除。回到源机器必须从目标执行新的反向 transfer，不得直接启动旧副本。目标激活前的放弃操作必须显式执行并警告销毁未使用导出包，因为没有外部共识服务时系统不能阻止所有者故意复制并同时启动两个完整副本。

迁移包只服务于活动权威迁移，不提供人类可读或通用机器可读导出，也不构成主机或存储完全损毁后的异机灾难恢复、RPO 或 RTO 保证。

## 备选方案

### 两台机器持续双向同步

- 优点：切换快，源和目标都有最新数据。
- 代价：实质引入多主冲突、秘密同步、外部副作用去重和分布式共识，违背已确认的单权威与 v0.2 范围。

### 停机后直接复制目录

- 优点：操作直观，代码少。
- 代价：缺少 schema/adapter manifest、完整性验证、加密、机器秘密排除、authority epoch 和失败原子性，容易产生不可诊断的半迁移。

### 受控加密导出/导入

- 优点：权威边界明确，可验证覆盖内容、兼容性、完整性和秘密排除，并能为 Mac/Hermes 提供同一 Runbook。
- 代价：迁移存在停机时间，需要显式配置目标主机秘密和公网入口切换。

## 影响

- 正面影响：用户可以携带同一个 Owner/Agent/Thread/Run 身份在 Mac 与 Hermes 间迁移，而不引入双写语义。
- 正面影响：导出 manifest 可以成为版本兼容、迁移覆盖和完整性的机器可验证证据。
- 负面影响：v0.2 不提供零停机迁移或自动 failover；迁移期间服务不可用。
- 负面影响：没有外部仲裁时，无法防御持有完整旧数据与秘密的操作者故意绕过 retired 状态启动克隆；Runbook 和公网入口只能防止正常操作误双活。
- 后续工作：实施后创建 transfer、同机 backup/restore 和 rollback Runbook，并分别在 Mac→Hermes、Hermes→Mac 验证。

## 关联文档

- [SOURCE: docs/prd-v0.2.md#mac-hermes-与权威迁移]
- [SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- [SOURCE: docs/adr/0012-portable-local-first-deployment.md]
- [SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
