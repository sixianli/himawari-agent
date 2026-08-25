---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0008: 通过受治理的能力注册表扩展 Agent

## Context

通用 Agent 需要接入 Skills、MCP Server、Pi Extension、本地程序和第三方 API。这些机制具有不同加载方式和权限模型；若由模型直接下载或执行，外部内容可能把不受信任代码带入高权限进程。

## Decision

所有可执行或外部能力统一登记在产品自有的能力注册表中。Agent 可以发现并推荐能力，但安装、首次授权、来源变化、权限扩大和新增可执行代码必须经过所有者批准。

每项能力记录来源、固定版本、完整性、权限声明、网络和文件访问范围、凭证需求、隔离方式、安装者、批准记录、停用和卸载机制。Pi Extension、MCP 和普通 API 只是不同适配器，不是产品权限边界。

## Options Considered

### 模型直接安装和执行

- Benefits: 自主性最强，扩展速度快。
- Costs: 供应链、提示注入和权限扩大无法控制。

### 仅允许编译期内置能力

- Benefits: 边界最静态、最容易审查。
- Costs: 无法满足通用 Agent 的开放扩展目标。

### 受治理的动态能力注册表

- Benefits: 保留动态扩展，同时建立可撤销和可验证边界。
- Costs: 需要清单格式、隔离执行、版本和审批管理。

## Consequences

- Positive: 所有能力获得统一的发现、授权、审计和停用语义。
- Negative: 第三方生态适配器必须转换成产品权限声明。
- Follow-up: Spec 必须定义能力生命周期、完整性校验和执行隔离接口。

## Links

- [SOURCE: docs/prd-v0.1.md#agent-topology-and-capabilities]
