---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# ADR 0020: 公共 Web 访问必须经过外部身份网关

## 背景

v0.2 以 Web UI 为首个正式客户端，并要求从公共互联网访问。Agent 持有私人对话、长期记忆、GitHub 私有仓库信息、授权和工具能力；直接把本地 HTTP 服务暴露到公网，或在首版自行实现密码、找回、多因素认证和会话安全，会把身份系统变成新的高风险产品核心。

仅由反向代理添加一个用户名请求头也不构成可信身份，因为绕过代理的请求可以伪造该头。外部机器事件如 GitHub webhook 也不能使用浏览器身份 Cookie，需要独立的来源认证边界。

## 决策

Himawari Agent 的公共人类访问必须经过支持多因素认证的外部 identity-aware access gateway。网关负责公共 TLS、登录流程和访问策略；Agent Service 只绑定 loopback 或受控私网入口，并在 origin 再次验证网关签发断言的签名、issuer、audience、时效和稳定 subject，再把 subject 映射到唯一 Owner。

唯一 Owner 只能通过活动权威主机上的一次性本地初始化建立并绑定一个外部身份；绑定成功后初始化入口必须关闭。产品仍独立管理浏览器会话和设备，允许 Owner 查看与撤销，并要求关键操作近期重新认证。活动权威主机还必须提供独立、受审计的本地 break-glass 流程，用于修复身份映射、撤销会话或关闭公网入口。

缺失或无效断言、Owner 映射不匹配、来源绕过网关和未允许设备都在 Agent Gateway 进入 Control Plane 前 fail closed。浏览器使用同源 HTTP 命令/查询和服务端事件流；状态变更另有 Origin/CSRF、幂等和权限检查，不能把“已登录”当作行动授权。

第三方 webhook 使用独立且最小的公开路径。该路径只接受对应提供商的签名消息、执行重放/幂等检查并形成统一 Trigger，不能访问普通人类 API。liveness/readiness 和 Worker transport 不通过公共路由暴露详细内部状态。

具体身份网关和 tunnel 是可替换部署适配器。v0.2 Spec 可以选择第一个正式适配器，但产品 GatewayAuthenticationContext 和 Owner/Device 授权不依赖供应商专有类型。

## 备选方案

### 在 Himawari 内实现用户名和密码

- 优点：不依赖外部身份服务，界面完全可控。
- 代价：必须自行承担凭据存储、MFA、找回、防暴力破解、会话撤销和安全更新，不符合首版私人 Agent 的风险收益。

### 只通过 VPN 或私网访问

- 优点：origin 不公开，信任边界简单。
- 代价：不满足已确认的公共互联网、Web 优先和普通浏览器访问要求。

### 外部身份网关加 origin 断言验证

- 优点：复用成熟登录与访问策略，同时保留应用层 Owner、Device、授权和审计语义；origin 不需要开放入站端口时可配合 outbound tunnel。
- 代价：可用性依赖一个外部网关；部署、迁移和故障诊断必须包含 DNS、tunnel、身份策略和签名密钥轮换。

## 影响

- 正面影响：v0.2 可以在不自建完整身份系统的前提下安全提供公共 Web 入口。
- 正面影响：外部 subject 与产品 Owner 分离，未来可以替换网关而不改变 Agent 的长期身份。
- 负面影响：网关账户、域名、策略和 tunnel credential 成为生产运行依赖，但仍不是产品数据库的一部分。
- 负面影响：origin 必须实现并测试 JWT/JWKS 轮换、issuer/audience、时钟偏差、CSRF 和代理绕过防护，不能只依赖边缘配置。
- 后续工作：v0.2 Spec 选择首个网关适配器，定义初始化、MFA、设备、会话、break-glass、公开/内部路由和端到端安全验证；实现后创建接入、轮换和故障 Runbook。

## 关联文档

- [SOURCE: docs/prd-v0.2.md#web-控制中心身份与设备]
- [SOURCE: docs/adr/0002-headless-agent-gateway.md]
- [SOURCE: docs/adr/0004-deterministic-authorization.md]
- [SOURCE: docs/adr/0012-portable-local-first-deployment.md]
