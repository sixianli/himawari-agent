---
status: active
document_type: adr
decision_status: accepted
supersedes: docs/adr/0020-public-web-identity-gateway.md
superseded_by: ""
date: "2026-09-10"
---

# ADR 0027：内置账号与共享产品会话

## 背景

真实本机控制中心验收因缺少外部身份网关而无法登录。用户明确否决“仅限本机”的登录方案，随后选择 Himawari 内置账号登录。该决定要求账号可用于本机和服务器部署、电脑和手机访问，不继续把外部身份服务作为唯一前提。

## 决策

Himawari 提供单一 Owner 的内置账号：密码与 TOTP 验证器，验证器不可用时以一次性恢复码完成第二因素。账号由活动主机上的受保护停机管理命令创建和恢复，不开放公众注册或团队权限。公网继续要求 HTTPS 和 MFA；明确配置的 loopback HTTP 使用相同的账号、会话、CSRF、近期认证与工具授权规则。

内置与 Cloudflare 登录是配置中明确区分的身份适配器，共用已有 Owner/Device/ProductSession 与 GatewayAuthenticationContext。原有配置不声明 kind 时保持 Cloudflare 语义；已有外部 Owner 不自动迁移到内置账号。内置账号验证记录新增来源 `built_in_mfa`，不冒充外部提供商证明，不以普通页面刷新产生新的近期认证时间。

密码使用 Node 自带 scrypt，固定 N=131072、r=8、p=1，逐账号随机盐；OTPAuth 9.5.2 负责标准 TOTP。Himawari 持久化加密第二因素、密码摘要、恢复码摘要、限流、验证请求与审计；验证码或恢复码消费与会话创建/轮换使用单个 SQLite 事务。恢复账号撤销全部旧会话、设备和未完成验证请求。

浏览器仅持有 HttpOnly、SameSite=Strict 会话 Cookie；公网使用 Secure。登录入口严格检查 Host/Origin，同源业务写操作继续校验会话绑定的 CSRF。设备撤销、空闲/绝对到期和凭据重置均阻止后续请求及已打开流的继续披露。身份登录不是执行授权，不新增模型工具接口，也不改变 Pi、Worker、预算或数据披露职责。

## 备选方案与取舍

- 仅限本机的登录令牌：用户已明确否决，不能满足服务器和手机的通用账号需求。
- 统一登录 OIDC：可复用外部身份体系，但用户本轮选择内置账号；本轮不新增第二套联合身份接线。
- 继续只支持外部网关：保留为已有部署适配器，不能作为新本机版本的唯一登录前提。
- 内置账号：减少外部部署依赖，同时由项目承担密码存储、第二因素、限流、会话与账号恢复的长期维护责任。恢复入口保持在受保护主机管理范围，不引入邮件服务或未经确认的自助找回语义。

## 影响与验证

增加配置分支、凭据与会话事务、登录/再次认证/设备页面及管理命令；第 31 个迁移只新增三个表，不改写既有迁移历史。真实部署须配置 TLS 反向代理，账号完成本机验证不等于公网或 Worker 资格验收通过。产品目标与执行记录分别见以下文档。

- [SOURCE: docs/prd-v0.2.md]
- [SOURCE: docs/architecture-v0.1.md]
- [SOURCE: docs/archive/specs/2026-09-10-built-in-account-authentication-design.md]
- [SOURCE: docs/archive/plans/2026-09-10-built-in-account-authentication-plan.md]
