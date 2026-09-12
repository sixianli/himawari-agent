---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-09-11"
---

# ADR 0029：受保护的原生运行历史

## 背景

只把用户消息与助手最终正文还原给模型，会丢失跨 Run 的工具调用、拒绝结果和取消过程。用户确认采用参考项目 Cindy 的原生会话机制，同时保留 Himawari 的身份、加密与授权边界。

Cindy 的 Pi 适配器通过 RPC 使用原生会话文件；Himawari 固定 Pi 0.84.2，通过 `SessionManager`、`convertToLlm()` 和原生 Agent Loop 处理运行消息。Cindy 当前参考版本为 `3d05156612d526a718c8ae00a0247be4e8e07653`，固定 Pi 0.84.4；没有把两者当作同一版本执行证据。

## 决策

Pi 负责原生消息、模型转换、压缩和工具循环。Himawari 提供运行历史的受保护持久化：原生消息作为不可变 Payload，快照保存有序引用及已覆盖 Run 身份。上下文创建固定所选快照；Fork 固定创建时的源快照。展示 Trace 与规范运行历史分别保存。

运行器在模型调用、工具执行和停止确认前等待所需历史保存。保存失败终止继续执行。审批 suspension 的本地退出信号不写成工具实际失败；同 Run 的审批恢复继续复用已有 continuation。

## 备选方案

- 仅增加取消提示：无法补回丢失的结构化工具历史，不作为此次修复的主要机制。
- 共享明文 Pi JSONL：简单，但绕过现有 Owner/Agent、分类和受保护 Payload 边界。
- 重放全部 Trace：观察日志包含重复片段、脱敏和缺失终态，不能直接用作规范上下文。

## 影响

跨 Run 保存工具调用/结果与来源元数据，继续复用 Pi。每次消息结束增加加密及数据库写入；消息 Payload 可复用，快照清单仍随有效上下文长度增长。真实机械盘性能须单独测量，不能由本地通过推断。

旧会话仍须核验恢复，缺失、脱敏或无归属记录不能伪造成原生历史。历史引用受到原 Payload 删除规则约束，删除后的缺失引用失败关闭。Schema 32 升级必须走现有已核验备份流程，旧二进制不得直接打开升级后的数据库。

## 引用

- [SOURCE: docs/architecture-v0.1.md]
- [SOURCE: docs/execution/specs/2026-09-11-native-runtime-history-design.md]
- [Codex 原生中断持久化实现](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/core/src/tasks/mod.rs)
