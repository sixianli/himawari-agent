---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# ADR 0018: 以 SQLite 作为单权威部署的产品状态库

## 背景

v0.2 必须在 Mac 与 Hermes 上支持持久对话、后台任务、恢复、备份和停机迁移，同时仍然保持一个 Agent 只有一个活动权威。当前内存参考适配器不能跨进程或重启保存状态。选择分布式数据库会扩大运维、备份和迁移面，而产品当前没有多写者或在线跨节点协调需求。

长期记忆供应商可能拥有自己的索引或数据库，但供应商状态不能取代产品拥有的身份、授权、来源、Trace、任务和生命周期真相。[SOURCE: docs/adr/0005-replaceable-memory-boundary.md] [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]

## 决策

Himawari Agent v0.2 使用 SQLite 作为产品业务状态的唯一权威数据库。Product State、幂等命令结果和 Reliable Event outbox 在同一个 SQLite transaction 中提交；Trace、Payload 元数据、授权、调度、Attention、Delivery、Memory 产品记录和外部集成游标也通过产品自有 repository 持久化。

生产适配器必须遵守以下边界：

- 数据库位于当前权威主机的本地持久磁盘，不从 Mac 与 Hermes 同时打开同一个网络文件。
- 开启 foreign key、明确 durability pragma、有限 busy timeout 和受控 WAL checkpoint；写入经过单一串行化边界。
- 使用不可变、带校验和的顺序 migration 和 schema ledger；服务只在 schema、integrity 和 authority 检查通过后进入 ready 状态。
- 使用已修复已知持久性问题的 SQLite build，并在启动、CI 和发布证据中记录、验证实际 `sqlite_version()`；具体最低版本由实施前重新核验的官方修复记录决定，不能只信任依赖包版本号。
- 第三方 Memory 的 SQLite 文件、向量索引或缓存属于适配器投影；产品数据库保存稳定记录和 provider mapping，并能驱动重建。
- 日常恢复点只保存在当前权威主机的同一存储边界内，并使用 SQLite 支持的一致性快照能力；它不承诺主机或存储完全损毁后的异机恢复。跨主机权威迁移只在所有连接关闭后导出。

数据库驱动、migration runner 和 schema 类型只能存在于基础设施适配器，不能泄漏到 domain、contracts 或 application 端口。

## 备选方案

### PostgreSQL 作为首个生产数据库

- 优点：成熟的多连接并发、远程管理、复制和未来多节点扩展能力。
- 代价：对当前单写者个人部署增加独立服务、凭据、备份、升级和 Mac/Hermes 迁移复杂度；不能直接改善已经排除的 active-active 场景。

### SQLite 作为产品权威库

- 优点：单文件事务、跨 Mac/Linux、低运维、适合单写者、恢复点与停机迁移边界清晰，同时保留以后通过 repository adapter 迁移数据库的可能。
- 代价：必须控制长事务、磁盘空间、WAL checkpoint 和写入串行化；不适合多个主机同时写入。

### 每个端口各自使用文件或供应商存储

- 优点：初始局部实现直接。
- 代价：无法维持跨端口 transaction/outbox、统一迁移和可验证恢复，会形成多个互相竞争的权威来源。

## 影响

- 正面影响：v0.2 可以用同一套数据与 migration 契约在 Mac 和 Hermes 运行，并形成可加密的同机恢复点和受控迁移包。
- 正面影响：当前 conformance suites 可以直接用于验证生产 SQLite adapters，而不改变应用层语义。
- 负面影响：需要对事件循环阻塞、单写者、WAL、磁盘满和数据库损坏建立专门测试与运行监控。
- 负面影响：如果未来正式需要多写者或在线高可用，必须新增数据库适配器和数据迁移 ADR，不能把 SQLite 文件放到共享网络盘规避设计边界。
- 后续工作：v0.2 Spec 定义 schema 分组、事务、migration、同机恢复点、完整性和 Mem0 投影恢复契约。

## 关联文档

- [SOURCE: docs/prd-v0.2.md#单一-agent-与活动权威]
- [SOURCE: docs/prd-v0.2.md#数据保留归档与删除]
- [SOURCE: docs/prd-v0.2.md#mac-hermes-与权威迁移]
- [SOURCE: docs/architecture-v0.1.md#known-limitations]
- [SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
